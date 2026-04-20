/**
 * 任务执行器
 *
 * 职责：
 * - 根据 TaskAction 类型分发执行（agent-turn / system）
 * - 超时保护（AbortController）
 * - 结果标准化为 AgentTurnResult
 * - 不处理错误退避（由 Scheduler 调用 ErrorPolicy）
 */

import type {
  ScheduledTask,
  AgentTurnParams,
  AgentTurnResult,
  SystemHandler,
} from "./types.js";
import type { SchedulerConfig } from "./config.js";

export interface TaskExecutorDeps {
  runAgentTurn: (params: AgentTurnParams) => Promise<AgentTurnResult>;
  systemHandlers: Map<string, SystemHandler>;
  config: SchedulerConfig;
}

/**
 * 执行单个调度任务，返回标准化结果
 */
export async function executeTask(
  task: ScheduledTask,
  deps: TaskExecutorDeps,
  parentSignal?: AbortSignal,
): Promise<AgentTurnResult> {
  const startTime = Date.now();

  // 超时保护：取 config.taskTimeoutMs 和 parentSignal 的交集
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), deps.config.taskTimeoutMs);

  // 如果父 signal 已中止，直接中止
  if (parentSignal?.aborted) {
    clearTimeout(timeout);
    return {
      status: "error",
      error: "Aborted before execution",
      durationMs: 0,
    };
  }

  // 监听父 signal 中止
  const onParentAbort = () => timeoutController.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    if (task.action.kind === "agent-turn") {
      return await deps.runAgentTurn({
        prompt: task.action.prompt,
        model: task.action.model,
        tools: task.action.tools,
        abortSignal: timeoutController.signal,
        context: "scheduled-task",
      });
    }

    if (task.action.kind === "system") {
      const handler = deps.systemHandlers.get(task.action.handler);
      if (!handler) {
        return {
          status: "error",
          error: `System handler not found: ${task.action.handler}`,
          durationMs: Date.now() - startTime,
        };
      }

      const result = await handler(task.action.params);
      return {
        status: result.status,
        output: result.summary,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      status: "error",
      error: `Unknown action kind: ${(task.action as { kind: string }).kind}`,
      durationMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof DOMException && err.name === "AbortError";

    return {
      status: "error",
      error: isTimeout ? `Task timed out after ${deps.config.taskTimeoutMs}ms` : message,
      durationMs: Date.now() - startTime,
    };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
