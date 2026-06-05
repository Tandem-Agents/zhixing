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
  /**
   * 上线边界容差窗口（毫秒）。默认 90_000。
   * 「错过」以本次上线时刻为锚（非任务迟到时长）：应触发于「上线时刻 - 此窗口」之前 =
   * 宿主离线期间真正错过的触发——不补执行、记 state.lastMissed、推进 nextRunAt；之后
   * （含在线被并发推迟）都是在线到点、正常执行。此窗口只吸收上线边界附近的短暂离线
   * （如重启间隙），不随任务迟到时长漂移——故在线并发延迟无论多久都不会被误判错过。
   */
  graceWindowMs: number;
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
  graceWindowMs: 90_000,
};
