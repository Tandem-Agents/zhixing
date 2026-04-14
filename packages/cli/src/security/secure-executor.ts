/**
 * 安全执行包装器
 *
 * 把 SecurityPipeline 接到 agent loop 的 executeTool 注入点。每次工具调用先
 * 走 `pipeline.evaluate()`，根据结果决定：
 *
 *   1. block → 抛 SecurityBlockError
 *   2. confirm → 走两条路径之一
 *      - broker 路径（Step 3+）：构造 ConfirmationRequest → broker.requestConfirmation → 翻译 decision
 *      - legacy 路径：调 showConfirmationDialog 用 readline question
 *      优先级：env `ZHIXING_CONFIRMATION_RENDERER=legacy` 强制 legacy；
 *             否则 broker 存在就走 broker；都没有就当非交互直接 block
 *   3. allow → 调用原始 executeTool
 */

import {
  PermissionStore,
  truncateOutput,
  wrapWithConstraints,
  type ConfirmationDecision,
  type ExecutionConstraints,
  type IConfirmationBroker,
  type IConfirmationTracker,
  type IPermissionStore,
  type SecurityMiddlewareResult,
  type SecurityPipeline,
  type SecurityRequest,
  type SessionType,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "@zhixing/core";
import {
  renderBlockedMessage,
  showConfirmationDialog,
  type PromptFn,
} from "./confirmation-ui.js";
import { buildConfirmationRequest } from "./request-builder.js";

// ─── 错误类型 ───

/**
 * 安全拦截错误——用户拒绝、策略阻止、确认超时等场景都抛这个。
 *
 * 实现 `UserFacingError` 契约：`userFacing = true` 告知 core 的 tool-executor
 * 本错误的 `message` 已经是 user/model-friendly 的文本，不要再加
 * `"Tool execution failed: "` 前缀——让用户的拒绝反馈原样回流到模型。
 *
 * 这是 Phase 1 差异化的关键：拒绝不是终点，是一次纠错。
 */
export class SecurityBlockError extends Error {
  readonly userFacing = true as const;

  constructor(
    message: string,
    public readonly toolName: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "SecurityBlockError";
  }
}

// ─── Executor type ───

type ExecuteToolFn = (
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

// ─── 构造器 ───

/**
 * Feature flag 解析——决定用 broker 还是 legacy prompt 路径。
 * 默认 broker；`ZHIXING_CONFIRMATION_RENDERER=legacy` 强制老路径。
 */
type ConfirmationPath = "broker" | "legacy" | "none";

function pickPath(
  broker: IConfirmationBroker | undefined,
  prompt: PromptFn | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ConfirmationPath {
  const forced = env["ZHIXING_CONFIRMATION_RENDERER"]?.toLowerCase();
  if (forced === "legacy") {
    return prompt ? "legacy" : "none";
  }
  if (broker) return "broker";
  if (prompt) return "legacy";
  return "none";
}

export interface SecureExecuteToolOptions {
  pipeline: SecurityPipeline;
  /** 原始 executeTool 实现（通常是 (tool, input, ctx) => tool.call(input, ctx)） */
  originalExecute: ExecuteToolFn;
  /**
   * 用户输入提示器——legacy 路径。
   * 保留用于 `ZHIXING_CONFIRMATION_RENDERER=legacy` 或 broker 未提供时的回退。
   */
  prompt?: PromptFn;
  /**
   * Confirmation broker——broker 路径（默认）。
   * 由 createSession 构造并持久化于整个会话；渲染器在 REPL 侧 attach。
   */
  broker?: IConfirmationBroker;
  /**
   * 会话类型——传入 ConfirmationRequest.sessionType。
   * 默认根据 stdin.isTTY 推断（ci / interactive）。
   */
  sessionType?: SessionType;
  /** 覆盖 env（测试用） */
  env?: NodeJS.ProcessEnv;
}

export function createSecureExecuteTool(
  opts: SecureExecuteToolOptions,
): ExecuteToolFn {
  const { pipeline, originalExecute, prompt, broker } = opts;
  const env = opts.env ?? process.env;
  const sessionType: SessionType =
    opts.sessionType ?? (process.stdin.isTTY ? "interactive" : "ci");
  const path = pickPath(broker, prompt, env);

  return async (tool, input, context) => {
    const result = await pipeline.evaluate(
      tool.name,
      input,
      context.workingDirectory,
    );

    // 1. block → 渲染并抛错
    if (!result.allowed) {
      renderBlockedMessage(tool.name, input, result);
      throw new SecurityBlockError(
        `操作被阻止：${result.reason ?? "安全策略拦截"}`,
        tool.name,
        result.reason ?? "",
      );
    }

    // 2. 需要确认
    if (result.requiresConfirmation) {
      if (path === "none") {
        throw new SecurityBlockError(
          `操作需要用户确认但当前环境非交互式：${result.reason ?? ""}`,
          tool.name,
          result.reason ?? "",
        );
      }

      if (path === "broker") {
        await handleBrokerPath({
          broker: broker!,
          pipeline,
          toolName: tool.name,
          input,
          context,
          result,
          sessionType,
        });
      } else {
        await handleLegacyPath({
          prompt: prompt!,
          pipeline,
          toolName: tool.name,
          input,
          context,
          result,
        });
      }
    }

    // 3. 执行实际工具——应用 pipeline 计算的执行约束
    return runWithConstraints({
      tool,
      input,
      context,
      constraints: result.executionConstraints,
      originalExecute,
    });
  };
}

// ─── Broker 路径 ───

async function handleBrokerPath(params: {
  broker: IConfirmationBroker;
  pipeline: SecurityPipeline;
  toolName: string;
  input: Record<string, unknown>;
  context: ToolExecutionContext;
  result: SecurityMiddlewareResult;
  sessionType: SessionType;
}): Promise<void> {
  const { broker, pipeline, toolName, input, context, result, sessionType } =
    params;

  const request = buildConfirmationRequest({
    toolName,
    input,
    workingDirectory: context.workingDirectory,
    result,
    workspaceId: pipeline.getWorkspaceId(),
    sessionType,
  });

  const decision = await broker.requestConfirmation(request);

  switch (decision.kind) {
    case "deny": {
      // 构造 model-friendly 的拒绝文本——这段会原样作为 tool_result.content
      // 回流到 LLM，让模型理解"为什么被拒绝"并据此调整下一步动作。
      const reasonText = decision.reason
        ? `用户拒绝了这次工具调用。用户的反馈：${decision.reason}。请根据该反馈调整方案。`
        : `用户拒绝了这次工具调用。`;
      renderBlockedMessage(toolName, input, result);
      throw new SecurityBlockError(
        reasonText,
        toolName,
        decision.reason ?? "user declined",
      );
    }

    case "cancelled": {
      const label = cancelLabel(decision.cause);
      throw new SecurityBlockError(
        `确认${label}（${decision.cause}）`,
        toolName,
        decision.cause,
      );
    }

    case "expired":
      throw new SecurityBlockError(
        `确认超时：${toolName}`,
        toolName,
        "expired",
      );

    case "allow-once":
    case "allow-session":
    case "allow-workspace":
    case "allow-global":
    case "always-ask":
      await applyBrokerDecision({
        decision,
        pipeline,
        toolName,
        input,
        workingDirectory: context.workingDirectory,
        riskLevel: result.decision?.riskLevel ?? "medium",
      });
      return;

    case "edit-then-allow":
      // Step 8 feature——当前直接按 deny 处理
      throw new SecurityBlockError(
        `edit-then-allow 尚未实现`,
        toolName,
        "not-implemented",
      );
  }
}

function cancelLabel(cause: string): string {
  switch (cause) {
    case "user-ctrl-c":
      return "被用户中断";
    case "user-ctrl-d":
      return "被用户退出";
    case "session-end":
      return "因会话结束被清场";
    case "renderer-detached":
      return "因渲染器断开被取消";
    case "aborted":
      return "被外部 abort";
    case "backpressure":
      return "因队列过载被拒绝";
    default:
      return "被取消";
  }
}

// ─── Legacy 路径 ───

async function handleLegacyPath(params: {
  prompt: PromptFn;
  pipeline: SecurityPipeline;
  toolName: string;
  input: Record<string, unknown>;
  context: ToolExecutionContext;
  result: SecurityMiddlewareResult;
}): Promise<void> {
  const { prompt, pipeline, toolName, input, context, result } = params;

  const choice = await showConfirmationDialog({
    toolName,
    toolInput: input,
    result,
    prompt,
  });

  if (choice.kind === "deny") {
    throw new SecurityBlockError(
      `用户拒绝了操作：${toolName}`,
      toolName,
      "user declined",
    );
  }

  await applyUserChoice({
    choice,
    pipeline,
    toolName,
    input,
    workingDirectory: context.workingDirectory,
    riskLevel: result.decision?.riskLevel ?? "medium",
  });
}

// ─── 应用执行约束 ───

interface RunWithConstraintsParams {
  tool: ToolDefinition;
  input: Record<string, unknown>;
  context: ToolExecutionContext;
  constraints?: ExecutionConstraints;
  originalExecute: ExecuteToolFn;
}

async function runWithConstraints(
  params: RunWithConstraintsParams,
): Promise<ToolResult> {
  const { tool, input, context, constraints, originalExecute } = params;

  if (!constraints) {
    return originalExecute(tool, input, context);
  }

  // 用 wrapWithConstraints 应用 timeout（即使工具不配合 abort 也能强制超时）
  // 同时合并 pipeline 的 abort signal 与调用方已有的 signal
  const rawResult = await wrapWithConstraints(async (pipelineSignal) => {
    const combinedSignal = combineSignals(pipelineSignal, context.abortSignal);
    return originalExecute(tool, input, {
      ...context,
      abortSignal: combinedSignal,
    });
  }, constraints);

  // 输出超出限制时截断 + 追加提示
  if (typeof rawResult.content === "string") {
    const truncated = truncateOutput(rawResult.content, constraints.maxOutputBytes);
    if (truncated.truncated) {
      return {
        ...rawResult,
        content:
          truncated.content +
          `\n\n[输出被截断: 原始 ${formatBytes(truncated.originalBytes)}, 截断到 ${formatBytes(constraints.maxOutputBytes)}]`,
      };
    }
  }

  return rawResult;
}

/**
 * 合并多个 AbortSignal——任一触发则结果信号触发。
 * Node 20.3+ 有原生 AbortSignal.any，此处兼容旧 Node。
 */
function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => s !== undefined);
  if (valid.length === 0) return new AbortController().signal;
  if (valid.length === 1) return valid[0]!;

  // 优先使用原生实现
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native(valid);

  // fallback：手动转发
  const controller = new AbortController();
  for (const sig of valid) {
    if (sig.aborted) {
      controller.abort();
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── 用户选择的副作用 ───

async function applyUserChoice(params: {
  choice: Exclude<
    Awaited<ReturnType<typeof showConfirmationDialog>>,
    { kind: "deny" }
  >;
  pipeline: SecurityPipeline;
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}): Promise<void> {
  const { choice, pipeline, toolName, input, workingDirectory, riskLevel } =
    params;

  const store: IPermissionStore = pipeline.getPermissionStore();
  const tracker: IConfirmationTracker = pipeline.getConfirmationTracker();
  const workspaceId = pipeline.getWorkspaceId();

  // 构造 SecurityRequest 用于 tracker.record
  const request: SecurityRequest = {
    tool: toolName,
    arguments: input,
    context: {
      cwd: workingDirectory,
      workspace: workingDirectory,
      sessionType: "interactive",
    },
  };

  switch (choice.kind) {
    case "allow-once":
      // 一次性允许 → 累计到追踪器以便未来建议创建规则
      tracker.record(request, riskLevel);
      return;

    case "allow-session":
      store.create(
        workspaceId,
        PermissionStore.createRule({
          pattern: choice.pattern.pattern,
          decision: "allow",
          scope: "session",
        }),
      );
      return;

    case "allow-workspace": {
      if (!workspaceId) {
        // 无工作区上下文时 fallback 到 global
        store.create(
          null,
          PermissionStore.createRule({
            pattern: choice.pattern.pattern,
            decision: "allow",
            scope: "global",
          }),
        );
        return;
      }
      store.create(
        workspaceId,
        PermissionStore.createRule({
          pattern: choice.pattern.pattern,
          decision: "allow",
          scope: "workspace",
          workspace: workingDirectory,
        }),
      );
      return;
    }

    case "allow-global":
      store.create(
        null,
        PermissionStore.createRule({
          pattern: choice.pattern.pattern,
          decision: "allow",
          scope: "global",
        }),
      );
      return;
  }
}

// ─── Broker decision 的副作用 ───
//
// 和 applyUserChoice 类似，但消费 ConfirmationDecision 而不是 ConfirmationChoice。
// 两条路径保持独立避免互相污染——legacy 路径迟早会被砍掉，保留分离让移除干净。

async function applyBrokerDecision(params: {
  decision: Extract<
    ConfirmationDecision,
    {
      kind:
        | "allow-once"
        | "allow-session"
        | "allow-workspace"
        | "allow-global"
        | "always-ask";
    }
  >;
  pipeline: SecurityPipeline;
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}): Promise<void> {
  const {
    decision,
    pipeline,
    toolName,
    input,
    workingDirectory,
    riskLevel,
  } = params;

  const store: IPermissionStore = pipeline.getPermissionStore();
  const tracker: IConfirmationTracker = pipeline.getConfirmationTracker();
  const workspaceId = pipeline.getWorkspaceId();

  const request: SecurityRequest = {
    tool: toolName,
    arguments: input,
    context: {
      cwd: workingDirectory,
      workspace: workingDirectory,
      sessionType: "interactive",
    },
  };

  switch (decision.kind) {
    case "allow-once":
      // 一次性允许 → 累计到追踪器以便未来建议创建规则
      tracker.record(request, riskLevel);
      return;

    case "allow-session":
      store.create(
        workspaceId,
        PermissionStore.createRule({
          pattern: decision.pattern.pattern,
          decision: "allow",
          scope: "session",
        }),
      );
      return;

    case "allow-workspace": {
      if (!workspaceId) {
        // 无工作区上下文时 fallback 到 global
        store.create(
          null,
          PermissionStore.createRule({
            pattern: decision.pattern.pattern,
            decision: "allow",
            scope: "global",
          }),
        );
        return;
      }
      store.create(
        workspaceId,
        PermissionStore.createRule({
          pattern: decision.pattern.pattern,
          decision: "allow",
          scope: "workspace",
          workspace: workingDirectory,
        }),
      );
      return;
    }

    case "allow-global":
      store.create(
        null,
        PermissionStore.createRule({
          pattern: decision.pattern.pattern,
          decision: "allow",
          scope: "global",
        }),
      );
      return;

    case "always-ask":
      // Step 7 feature——当前按 allow-once 兜底（track 到累计器，不创建规则）
      tracker.record(request, riskLevel);
      return;
  }
}
