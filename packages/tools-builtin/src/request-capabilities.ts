/**
 * request_capabilities 元工具 —— 强模型批量预热路径
 *
 * 设计动机：
 *   capability 系统下大多数工具默认 discoverable，LLM 在 system prompt 中知道
 *   存在 + 怎么用，但 API tools[] 不含完整 schema。多步任务中如果 LLM 想一次性
 *   规划好"接下来要 read + grep + edit"，可调本元工具批量激活，下一次 LLM call
 *   即可看到这几个工具的完整 schema —— 减少自动升级路径的轮次成本。
 *
 *   弱模型不会主动用此工具 —— 它们直接发 tool_use(X) 让自动升级中间件接管，
 *   行为同样正确。本工具是强模型的优化路径，不是必需路径。
 *
 * 依赖注入：
 *   工具不直接持有 CapabilityState 引用 —— 通过 RequestCapabilitiesDeps.promote
 *   桥接，让 tools-builtin 包不依赖 orchestrator 装配细节。
 *   装配方（runtime）实现 promote 函数，转发到 CapabilityState.promoteToHot 并
 *   返回结果，本工具按结果分类输出报告。
 */

import type { ToolDefinition, ToolResult } from "@zhixing/core";

/**
 * 单个工具的升级结果 —— 镜像 capability state 的真实行为而非业务化分类。
 *
 * - layer: 升级动作之后该工具的当前层（"unknown" 表示未注册）
 * - promoted: 是否真发生 discoverable → hot 跃迁（false 含 already always / 已 hot / cold-blocked / unknown）
 */
export interface RequestCapabilitiesPromoteResult {
  readonly layer: "always" | "hot" | "discoverable" | "cold" | "unknown";
  readonly promoted: boolean;
}

export interface RequestCapabilitiesDeps {
  /**
   * 升级单个工具。装配方按 CapabilityState 当前形态返回结果。
   *
   * 不要求是纯函数 —— 调用即触发实际状态变更（与 promoteToHot 一致）。
   */
  promote(toolName: string): RequestCapabilitiesPromoteResult;
}

const MAX_RESULT_CHARS = 4_000;

export function createRequestCapabilitiesTool(
  deps: RequestCapabilitiesDeps,
): ToolDefinition {
  return {
    name: "request_capabilities",
    description:
      "Activate tools described in the system prompt that aren't currently in your tools[] array. " +
      "Pass the tool names you plan to use; their full schemas will appear in the next response, " +
      "ready to invoke with standard tool_use protocol.",
    inputSchema: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool names to activate. Each name should match a tool described in the " +
            "system prompt's tool usage section.",
        },
      },
      required: ["tools"],
    },

    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    // sub-agent 路径不接 capabilityState（与 ToolResultAnchorStage 决议同步），
    // 此工具在 sub-agent 中无意义；子 agent 工具集自动按 subAgentSafe 过滤。
    subAgentSafe: false,
    maxResultChars: MAX_RESULT_CHARS,

    async call(input): Promise<ToolResult> {
      const parsed = parseInput(input as Record<string, unknown>);
      if (parsed.kind === "error") {
        return { content: parsed.message, isError: true };
      }

      const activated: string[] = [];
      const alreadyActive: string[] = [];
      const unknown: string[] = [];
      const blocked: string[] = [];

      for (const toolName of parsed.tools) {
        const result = deps.promote(toolName);
        if (result.layer === "unknown") {
          unknown.push(toolName);
        } else if (result.layer === "cold") {
          blocked.push(toolName);
        } else if (result.promoted) {
          activated.push(toolName);
        } else {
          alreadyActive.push(toolName);
        }
      }

      const lines: string[] = [];
      if (activated.length > 0) {
        lines.push(`Activated: ${activated.join(", ")}`);
      }
      if (alreadyActive.length > 0) {
        lines.push(`Already active: ${alreadyActive.join(", ")}`);
      }
      if (unknown.length > 0) {
        lines.push(`Unknown (not registered): ${unknown.join(", ")}`);
      }
      if (blocked.length > 0) {
        lines.push(`Blocked (disabled or unavailable): ${blocked.join(", ")}`);
      }

      const allUnknownOrBlocked =
        activated.length === 0 &&
        alreadyActive.length === 0 &&
        (unknown.length > 0 || blocked.length > 0);

      const content = lines.join("\n") || "No tools requested.";
      // 仅在 error 路径设 isError 字段；成功路径让字段缺省以匹配
      // ToolResult 通用语义（多数消费方按 `isError === true` 严格判定）。
      return allUnknownOrBlocked ? { content, isError: true } : { content };
    },
  };
}

// ─── 输入解析 ───

type ParsedInput =
  | { kind: "error"; message: string }
  | { kind: "ok"; tools: string[] };

function parseInput(input: Record<string, unknown>): ParsedInput {
  const tools = input.tools;
  if (!Array.isArray(tools)) {
    return {
      kind: "error",
      message: "request_capabilities requires `tools` field as an array of tool names.",
    };
  }
  if (tools.length === 0) {
    return {
      kind: "error",
      message: "`tools` array must not be empty.",
    };
  }
  const names: string[] = [];
  for (const item of tools) {
    if (typeof item !== "string" || item.length === 0) {
      return {
        kind: "error",
        message: "Each entry in `tools` must be a non-empty string (tool name).",
      };
    }
    names.push(item);
  }
  return { kind: "ok", tools: names };
}
