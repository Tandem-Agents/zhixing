/**
 * 任务错误策略
 *
 * 职责：
 * - 计算失败退避延迟（指数退避 + 抖动）
 * - 判断任务是否应被自动 disable
 * - 计算退避后的下次执行时间
 *
 * 复用 resilience/backoff.ts 的 computeBackoffDelay 算法，
 * 但参数不同（任务级退避比 LLM 重试退避间隔更长）。
 */

import type { SchedulerConfig } from "./config.js";
import type { ScheduledTask } from "./types.js";

/**
 * 判断任务是否应被自动 disable（连续错误次数达到阈值）
 */
export function shouldDisableTask(
  task: ScheduledTask,
  config: SchedulerConfig,
): boolean {
  return task.state.consecutiveErrors >= config.maxConsecutiveErrors;
}

/**
 * 计算失败退避延迟（毫秒）
 *
 * 算法：delay = min(base × 2^(consecutiveErrors - 1), max)
 * 抖动：Full Jitter — delay = random(0, computed)
 *
 * consecutiveErrors = 1 → ~1 min
 * consecutiveErrors = 2 → ~2 min
 * consecutiveErrors = 3 → ~4 min
 * consecutiveErrors = 4 → ~8 min
 * consecutiveErrors = 5 → auto-disable
 */
export function computeErrorBackoff(
  consecutiveErrors: number,
  config: SchedulerConfig,
): number {
  if (consecutiveErrors <= 0) return 0;

  const exponential = config.errorBackoffBaseMs * Math.pow(2, consecutiveErrors - 1);
  const capped = Math.min(exponential, config.errorBackoffMaxMs);

  // Full Jitter
  return Math.floor(Math.random() * (capped + 1));
}

/**
 * 任务失败后更新状态并返回是否应 disable
 */
export function applyErrorPolicy(
  task: ScheduledTask,
  error: string,
  config: SchedulerConfig,
  now: Date,
): { shouldDisable: boolean; nextRunAt?: string } {
  task.state.consecutiveErrors += 1;
  task.state.lastStatus = "error";
  task.state.lastError = error;

  if (shouldDisableTask(task, config)) {
    return { shouldDisable: true };
  }

  const backoffMs = computeErrorBackoff(task.state.consecutiveErrors, config);
  const nextRunAt = new Date(now.getTime() + backoffMs).toISOString();

  return { shouldDisable: false, nextRunAt };
}

/**
 * 任务成功后重置错误计数
 */
export function resetErrorState(task: ScheduledTask): void {
  task.state.consecutiveErrors = 0;
  task.state.lastStatus = "ok";
  task.state.lastError = undefined;
}
