/**
 * 安全执行包装器 — Phase 2 Step 8
 *
 * 把 SecurityPipeline 接到 agent loop 的 executeTool 注入点。
 * 每次 run() 调用时用当前的 prompt 函数构造一个新的 wrapper，
 * 它会：
 *   1. 对每次工具调用先走 pipeline.evaluate()
 *   2. block → 抛 SecurityBlockError
 *   3. confirm + interactive → 弹对话框；根据用户选择创建权限规则或 record 到 tracker
 *   4. confirm + 无 prompt → 抛 SecurityBlockError（非交互环境无法确认）
 *   5. allow → 调用原始 executeTool
 */

import {
  PermissionStore,
  truncateOutput,
  wrapWithConstraints,
  type ExecutionConstraints,
  type IConfirmationTracker,
  type IPermissionStore,
  type SecurityPipeline,
  type SecurityRequest,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "@zhixing/core";
import {
  renderBlockedMessage,
  showConfirmationDialog,
  type PromptFn,
} from "./confirmation-ui.js";

// ─── 错误类型 ───

export class SecurityBlockError extends Error {
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

export interface SecureExecuteToolOptions {
  pipeline: SecurityPipeline;
  /** 原始 executeTool 实现（通常是 (tool, input, ctx) => tool.call(input, ctx)） */
  originalExecute: ExecuteToolFn;
  /**
   * 用户输入提示器。REPL 传 rl.question；非交互环境传 undefined，
   * 此时任何 requiresConfirmation 都会被视为 block。
   */
  prompt?: PromptFn;
}

export function createSecureExecuteTool(
  opts: SecureExecuteToolOptions,
): ExecuteToolFn {
  const { pipeline, originalExecute, prompt } = opts;

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
      if (!prompt) {
        throw new SecurityBlockError(
          `操作需要用户确认但当前环境非交互式：${result.reason ?? ""}`,
          tool.name,
          result.reason ?? "",
        );
      }

      const choice = await showConfirmationDialog({
        toolName: tool.name,
        toolInput: input,
        result,
        prompt,
      });

      if (choice.kind === "deny") {
        throw new SecurityBlockError(
          `用户拒绝了操作：${tool.name}`,
          tool.name,
          "user declined",
        );
      }

      await applyUserChoice({
        choice,
        pipeline,
        toolName: tool.name,
        input,
        workingDirectory: context.workingDirectory,
        riskLevel: result.decision?.riskLevel ?? "medium",
      });
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
