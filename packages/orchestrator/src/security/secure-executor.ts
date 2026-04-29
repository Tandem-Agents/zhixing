/**
 * 安全执行包装器
 *
 * 把 SecurityPipeline 接到 agent loop 的 executeTool 注入点。每次工具调用先
 * 走 `pipeline.evaluate()`,根据结果决定:
 *
 *   1. block → 通知 onBlocked,抛 SecurityBlockError
 *   2. requiresConfirmation → 走 broker:构造 ConfirmationRequest →
 *      broker.requestConfirmation → 翻译 decision
 *   3. allow → 调用原始 executeTool(应用 pipeline 计算的执行约束)
 *
 * UI 渲染通过可选回调注入(onBlocked / onUserDenied)——主 agent 路径(cli)
 * 注入终端渲染器;子 agent 路径不传,自动静默(子 agent 输出对用户不可见,
 * 失败信息由 tool_result 回流给父 LLM 处理)。
 */

import {
  PermissionStore,
  truncateOutput,
  wrapWithConstraints,
  buildConfirmationRequest,
  type ConfirmationDecision,
  type ConfirmationFallbackStrategy,
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
  type TurnContext,
} from "@zhixing/core";

// ─── 错误类型 ───

/**
 * 安全拦截错误 —— 用户拒绝、策略阻止、确认超时等场景都抛这个。
 *
 * 实现 `UserFacingError` 契约:`userFacing = true` 告知 core 的 tool-executor
 * 本错误的 `message` 已经是 user/model-friendly 的文本,不要再加
 * `"Tool execution failed: "` 前缀 —— 让用户的拒绝反馈原样回流到模型。
 *
 * 拒绝不是终点,是一次纠错。
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

// ─── UI 通知回调(渲染层注入,runtime 层不知 UI) ───

/**
 * 工具被 SecurityPipeline 阻止时的通知钩子。
 * cli 路径注入终端渲染器;子 agent 路径不传,静默处理。
 */
export type OnBlockedFn = (
  toolName: string,
  input: Record<string, unknown>,
  result: SecurityMiddlewareResult,
) => void;

/**
 * 用户在 confirmation 面板选择拒绝时的通知钩子。
 * cli 路径注入终端渲染器(显示"用户拒绝");子 agent 路径不传。
 */
export type OnUserDeniedFn = (
  toolName: string,
  input: Record<string, unknown>,
  reason: string | undefined,
) => void;

// ─── 构造器 ───

export interface SecureExecuteToolOptions {
  pipeline: SecurityPipeline;
  /** 原始 executeTool 实现(通常是 (tool, input, ctx) => tool.call(input, ctx)) */
  originalExecute: ExecuteToolFn;
  /**
   * Confirmation broker —— 必填。
   * 由 createAgentRuntime 构造并持久化于整个会话;主路径渲染器在 REPL 侧 attach,
   * 子 agent 路径用独立 broker(默认 failToDenyResolver,无 listener 自动 deny)。
   */
  broker: IConfirmationBroker;
  /**
   * 会话类型 —— 传入 ConfirmationRequest.sessionType。
   * 默认根据 stdin.isTTY 推断(ci / interactive)。
   */
  sessionType?: SessionType;
  /**
   * 确认请求超时后的降级策略。
   * - `deny`(默认):按拒绝处理
   * - `auto-approve-safe`:observe / internal 放行,external / critical 拒绝
   */
  confirmationFallback?: ConfirmationFallbackStrategy;
  /**
   * 当前 turn 的上下文 —— 由调用方从 RunParams.turnContext 透传。
   *
   * 包装函数入口会把其中的 `turnId` / `emissionTarget` / `commitToUser` /
   * `turnOrigin` 一次性展开到 ToolExecutionContext,保证:
   *   1. `pipeline.evaluate` 能感知 turn 层元信息
   *   2. `handleBrokerPath` 把 `turnOrigin` 填入 ConfirmationRequest
   *      (远程确认的回程地址由此打通)
   *   3. `tool.call` 也能读到这些字段(commitToUser 等)
   *
   * REPL / 一次性命令下为 undefined —— 所有字段退化为 undefined。
   */
  turnContext?: TurnContext;
  /** 工具被策略阻止时的 UI 通知;不传则静默 */
  onBlocked?: OnBlockedFn;
  /** 用户在 confirmation 面板选择拒绝时的 UI 通知;不传则静默 */
  onUserDenied?: OnUserDeniedFn;
}

export function createSecureExecuteTool(
  opts: SecureExecuteToolOptions,
): ExecuteToolFn {
  const { pipeline, originalExecute, broker, turnContext, onBlocked, onUserDenied } = opts;
  const sessionType: SessionType =
    opts.sessionType ?? (process.stdin.isTTY ? "interactive" : "ci");
  const fallbackStrategy: ConfirmationFallbackStrategy =
    opts.confirmationFallback ?? "deny";

  return async (tool, input, context) => {
    // ── 入口就把 turn-level 字段展开到 context ──
    //
    // 为什么在这里展开而不是在 originalExecute 里:
    //   handleBrokerPath 在 originalExecute 之前触发;pipeline.evaluate 也早于它。
    //   如果只在 originalExecute 里展开,`context.turnOrigin` 在 handleBrokerPath
    //   看来是 undefined → ConfirmationRequest.turnOrigin 缺失 → 远程确认消息
    //   找不到 target。
    // 统一在入口展开后,pipeline.evaluate / handleBrokerPath / 工具调用 三者
    // 共享同一增强 context,turnOrigin 透传路径贯通。
    //
    // 设计意图(forward-compat):`...context` spread 是有意的"包装器透传" ——
    // 把所有上游字段(含未来可能新增的 ctx.llm / ctx.tools 等)原样保留下去,
    // 仅显式覆盖 turn-level 字段。如果改成显式列字段,每加一个新 ToolExecutionContext
    // 字段都需要在此处补一行透传,极易遗漏导致工具收到的 ctx 字段悄悄丢失。
    const augmentedContext: ToolExecutionContext = {
      ...context,
      turnId: turnContext?.turnId ?? context.turnId,
      emissionTarget: turnContext?.emissionTarget ?? context.emissionTarget,
      commitToUser: turnContext?.commitToUser
        ? (content) => turnContext.commitToUser!(content, { toolName: tool.name })
        : context.commitToUser,
      turnOrigin: turnContext?.turnOrigin ?? context.turnOrigin,
    };

    const result = await pipeline.evaluate(
      tool.name,
      input,
      augmentedContext.workingDirectory,
    );

    // 1. block → 通知 UI 并抛错
    if (!result.allowed) {
      onBlocked?.(tool.name, input, result);
      throw new SecurityBlockError(
        `操作被阻止:${result.reason ?? "安全策略拦截"}`,
        tool.name,
        result.reason ?? "",
      );
    }

    // 2. 需要确认 —— 走 broker
    if (result.requiresConfirmation) {
      await handleBrokerPath({
        broker,
        pipeline,
        toolName: tool.name,
        input,
        context: augmentedContext,
        result,
        sessionType,
        fallbackStrategy,
        onUserDenied,
      });
    }

    // 3. 执行实际工具 —— 应用 pipeline 计算的执行约束
    return runWithConstraints({
      tool,
      input,
      context: augmentedContext,
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
  fallbackStrategy: ConfirmationFallbackStrategy;
  onUserDenied?: OnUserDeniedFn;
}): Promise<void> {
  const {
    broker,
    pipeline,
    toolName,
    input,
    context,
    result,
    sessionType,
    fallbackStrategy,
    onUserDenied,
  } = params;

  const request = buildConfirmationRequest({
    toolName,
    input,
    workingDirectory: context.workingDirectory,
    result,
    workspaceId: pipeline.getWorkspaceId(),
    sessionType,
    // 远程确认回程地址透传:AgentRuntime → ToolExecutionContext.turnOrigin
    //   → ConfirmationRequest.turnOrigin → Hub / Renderer / Bridge
    turnOrigin: context.turnOrigin,
  });

  const decision = await broker.requestConfirmation(request);

  switch (decision.kind) {
    case "deny": {
      // `reason` 可选:
      //   - 有 reason → 自由文本拒绝(来自远程通道 / terminal 的"拒绝并说明原因"选项)
      //   - 无 reason → 结构化拒绝(词集匹配到拒绝词 / 用户直接点"拒绝")
      // 两种都把 reason 原样作为 tool_result.content 回流到 LLM —— 让模型理解"为什么被拒绝"。
      const reason = decision.reason;
      const reasonText = reason
        ? `用户拒绝了这次工具调用。用户的反馈:${reason}。请根据该反馈调整方案。`
        : `用户拒绝了这次工具调用。`;
      // 通知 UI(主路径触发终端"用户拒绝"渲染;子 agent 路径不传 callback)
      onUserDenied?.(toolName, input, reason);
      throw new SecurityBlockError(
        reasonText,
        toolName,
        reason ?? "user declined",
      );
    }

    case "cancelled": {
      const label = cancelLabel(decision.cause);
      throw new SecurityBlockError(
        `确认${label}(${decision.cause})`,
        toolName,
        decision.cause,
      );
    }

    case "expired":
      // 超时降级:
      //   - deny(默认):严格拒绝
      //   - auto-approve-safe:observe / internal 放行(低风险工具);
      //                       external / critical 仍然拒绝
      if (fallbackStrategy === "auto-approve-safe") {
        const opClass = result.operationClass;
        if (opClass === "observe" || opClass === "internal") {
          return; // 放行,调用方继续执行工具
        }
      }
      throw new SecurityBlockError(
        `确认超时:${toolName}`,
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

  // 用 wrapWithConstraints 应用 timeout(即使工具不配合 abort 也能强制超时)
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
 * 合并多个 AbortSignal —— 任一触发则结果信号触发。
 * Node 20.3+ 有原生 AbortSignal.any,此处兼容旧 Node。
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

  // fallback:手动转发
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

// ─── Broker decision 的副作用 ───

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
      // 当前按 allow-once 兜底(track 到累计器,不创建规则)
      tracker.record(request, riskLevel);
      return;
  }
}
