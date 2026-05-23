/**
 * 映射层 —— 把已发现的 MCP 工具物化成知行 ToolDefinition。
 *
 * 这是 MCP 接入知行的集成层核心：MCP 工具经此映射后，与内置工具走完全相同的装配
 * （extraTools → baseTools）、安全（boundaries → SecurityPipeline）、执行（tool-executor）
 * 路径，而非平行的第二套系统。
 *
 * 纯函数：调用通道（McpCallFn）由 hub 注入，映射层不依赖任何连接 / SDK，可独立单测。
 * 命名规则（消毒 / 长度 / 去重）委托 naming 模块，本层只做字段映射。
 */

import type { JsonSchema, ToolDefinition, ToolResult } from "@zhixing/core";
import { makeUniqueToolName } from "./naming.js";
import type { McpCallFn, McpServerContext, McpToolDescriptor } from "./types.js";

/** MCP server 巨结果上限 —— 防撑爆上下文（tool-executor 会据此自动截断）。 */
const MAX_RESULT_CHARS = 100_000;
/** 工具描述上限 —— 防巨描述灌爆 system prompt。 */
const MAX_DESCRIPTION_CHARS = 2048;

/**
 * 把一个 server 的工具描述列表映射成 ToolDefinition[]。
 *
 * server 级信息（id / transport）由 `server` 一次性提供，工具描述只含工具自身属性 ——
 * 故同批必属同一 server，不存在跨 server 混入。工具名的消毒、长度约束、同 server
 * 去重全部由 makeUniqueToolName 保证。
 */
export function mapServerTools(
  server: McpServerContext,
  descriptors: readonly McpToolDescriptor[],
  callTool: McpCallFn,
): ToolDefinition[] {
  const usedNames = new Set<string>();
  const tools: ToolDefinition[] = [];

  for (const descriptor of descriptors) {
    const toolName = makeUniqueToolName(
      server.serverId,
      descriptor.name,
      usedNames,
    );
    tools.push(mapOne(server, descriptor, toolName, callTool));
  }

  return tools;
}

function mapOne(
  server: McpServerContext,
  descriptor: McpToolDescriptor,
  toolName: string,
  callTool: McpCallFn,
): ToolDefinition {
  const readOnly = descriptor.readOnlyHint === true;

  return {
    name: toolName,
    description: truncate(descriptor.description ?? "", MAX_DESCRIPTION_CHARS),
    inputSchema: normalizeSchema(descriptor.inputSchema),
    // 只读工具不改外部状态：可并发、经 boundary 分类自动放行。
    // fail-closed：缺 readOnlyHint 视为有副作用、不可并发。
    isReadOnly: readOnly,
    isParallelSafe: readOnly,
    needsPermission: true,
    // MCP 在知行里属"外部服务"类。读类 access 经分类器归 observe 放行，
    // 非只读归 external 触发用户确认 —— 与内置工具同一条安全管线。
    boundaries: [
      {
        boundaryType: "external-service",
        access: readOnly ? "query" : "invoke",
        dynamic: false,
      },
    ],
    maxResultChars: MAX_RESULT_CHARS,
    // stdio server 持有子进程，中断需优雅停止；http 直接取消请求即可。
    interruptBehavior: server.transport === "stdio" ? "grace" : "cancel",

    async call(input, context): Promise<ToolResult> {
      try {
        // 转发用 MCP 原始工具名（descriptor.name），而非消毒后的知行名。
        return await callTool(server.serverId, descriptor.name, input, {
          signal: context.abortSignal,
        });
      } catch (err) {
        // abort 不是工具错误：让它冒泡，由 tool-executor 的 cleanup 注入与内置工具
        // 一致的中断 placeholder，而非吞成 isError 让 LLM 误读为"工具失败"。
        if (context.abortSignal?.aborted) throw err;
        // 其余意外异常作防御性兜底（hub 约定不抛），转 isError 不污染主 loop。
        const reason = err instanceof Error ? err.message : String(err);
        return { content: `${toolName} failed: ${reason}`, isError: true };
      }
    },
  };
}

/** 透传合规的 MCP inputSchema；顶层非 object 的异常 server 兜底为空 object schema。 */
function normalizeSchema(raw: unknown): JsonSchema {
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { type?: unknown }).type === "object"
  ) {
    return raw as JsonSchema;
  }
  return { type: "object" };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
