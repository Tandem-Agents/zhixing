/**
 * Scheduler 配置与默认值
 */

export interface SchedulerConfig {
  /** 最大并发执行任务数。默认 3 */
  maxConcurrent: number;
  /** 单个任务的执行超时（毫秒）。默认 300_000 (5 min) */
  taskTimeoutMs: number;
  /** TimerLoop 最小 tick 间隔（毫秒）。默认 2_000 */
  minTickIntervalMs: number;
  /** TimerLoop 最大 tick 间隔（毫秒）。默认 60_000 */
  maxTickIntervalMs: number;
  /** 连续失败多少次后自动 disable 任务。默认 5 */
  maxConsecutiveErrors: number;
  /** 退避基础延迟（毫秒）。默认 60_000 (1 min) */
  errorBackoffBaseMs: number;
  /** 退避最大延迟（毫秒）。默认 3_600_000 (1 hour) */
  errorBackoffMaxMs: number;
  /** 优雅停机等待活跃任务的超时（毫秒）。默认 10_000 */
  shutdownTimeoutMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrent: 3,
  taskTimeoutMs: 300_000,
  minTickIntervalMs: 2_000,
  maxTickIntervalMs: 60_000,
  maxConsecutiveErrors: 5,
  errorBackoffBaseMs: 60_000,
  errorBackoffMaxMs: 3_600_000,
  shutdownTimeoutMs: 10_000,
};
