/**
 * 核心调度循环
 *
 * 职责：
 * - 维护 setTimeout 调度链（不用 setInterval——间隔需要动态计算）
 * - 每次 tick：找出所有到期任务，按优先级排序，交给 onTick 回调
 * - 计算下次 tick 时间：取最近的 nextRunAt，clamp 到 [minInterval, maxInterval]
 *
 * 设计要点：
 * - 单线程安全：Node.js 事件循环保证 tick 不会并发
 * - 与 readline 共存：setTimeout 不阻塞 readline.question()
 * - 可测试：注入 now() 函数，测试中用假时钟
 */

import type { ScheduledTask, TimerLoop as ITimerLoop } from "./types.js";
import type { SchedulerConfig } from "./config.js";
import { PRIORITY_WEIGHT } from "./types.js";

export interface TimerLoopDeps {
  /** 获取当前所有启用的任务 */
  getEnabledTasks: () => ScheduledTask[];
  /** tick 回调：执行到期任务 */
  onTick: (dueTasks: ScheduledTask[]) => Promise<void>;
  /** 时钟注入（测试用） */
  now: () => Date;
  config: SchedulerConfig;
}

export class TimerLoop implements ITimerLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly deps: TimerLoopDeps;

  constructor(deps: TimerLoopDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 手动触发一次 tick（用于测试和即时执行场景）
   */
  async tick(): Promise<void> {
    await this.doTick();
  }

  /**
   * 取消当前定时器并根据最新任务列表重新调度。
   * 用于新任务创建或任务调度变更后立即生效。
   */
  rearm(): void {
    if (!this.running) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.arm();
  }

  // ─── 内部 ───

  private arm(): void {
    if (!this.running) return;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const delay = this.computeDelay();
    this.timer = setTimeout(() => {
      this.doTick().then(() => this.arm());
    }, delay);

    // 让 timer 不阻止进程退出（CLI 场景重要）
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private async doTick(): Promise<void> {
    const now = this.deps.now();
    const tasks = this.deps.getEnabledTasks();

    // 找出所有到期任务
    const dueTasks = tasks.filter((task) => {
      if (!task.state.nextRunAt) return false;
      return new Date(task.state.nextRunAt) <= now;
    });

    if (dueTasks.length === 0) return;

    // 按优先级降序排序（urgent > high > normal > low）
    dueTasks.sort(
      (a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority],
    );

    await this.deps.onTick(dueTasks);
  }

  /**
   * 计算下次 tick 的延迟（毫秒）
   *
   * 策略：取最近的 nextRunAt 与 now 的差值，clamp 到 [min, max]
   * 无任务时使用 maxInterval（空转节能）
   */
  private computeDelay(): number {
    const { minTickIntervalMs, maxTickIntervalMs } = this.deps.config;
    const now = this.deps.now();
    const tasks = this.deps.getEnabledTasks();

    let nearestMs = maxTickIntervalMs;

    for (const task of tasks) {
      if (!task.state.nextRunAt) continue;
      const diff = new Date(task.state.nextRunAt).getTime() - now.getTime();
      if (diff < nearestMs) {
        nearestMs = diff;
      }
    }

    // Clamp
    return Math.max(minTickIntervalMs, Math.min(nearestMs, maxTickIntervalMs));
  }
}
