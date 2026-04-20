/**
 * Scheduler — 调度器主类
 *
 * 职责：
 * - 管理任务生命周期（CRUD）
 * - 协调 TimerLoop + TaskExecutor + ErrorPolicy + TaskStore
 * - 并发控制（maxConcurrent）
 * - Missed task 追赶（重启后补执行）
 * - EventBus 事件通知
 * - 下次执行时间计算（cron / interval / once）
 *
 * 依赖注入：
 * - runAgentTurn：由 CLI/Server 注入，Scheduler 不依赖具体 Agent 实现
 * - systemHandlers：内置任务处理器（如 __journal-gc）
 * - eventBus：事件通知（REPL 订阅渲染）
 */

import { CronExpressionParser } from "cron-parser";
import { type IEventBus } from "../events/index.js";
import type { SchedulerConfig } from "./config.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./config.js";
import { applyErrorPolicy, resetErrorState } from "./error-policy.js";
import { executeTask, type TaskExecutorDeps } from "./task-executor.js";
import { TimerLoop } from "./timer-loop.js";
import type {
  AgentTurnParams,
  AgentTurnResult,
  ScheduledTask,
  SchedulerLogger,
  SystemHandler,
  TaskStore,
} from "./types.js";
import type { SchedulerEventMap } from "./events.js";
import type { IDeliveryPipeline } from "../delivery/types.js";

// ─── Scheduler 依赖注入 ───

export interface SchedulerDeps {
  now?: () => Date;
  config?: Partial<SchedulerConfig>;
  store: TaskStore;
  runAgentTurn: (params: AgentTurnParams) => Promise<AgentTurnResult>;
  systemHandlers?: Map<string, SystemHandler>;
  eventBus: IEventBus<SchedulerEventMap>;
  logger?: SchedulerLogger;
  delivery?: IDeliveryPipeline;
}

// ─── Scheduler ───

export class Scheduler {
  private readonly config: SchedulerConfig;
  private readonly store: TaskStore;
  private readonly runAgentTurn: (params: AgentTurnParams) => Promise<AgentTurnResult>;
  private readonly systemHandlers: Map<string, SystemHandler>;
  private readonly eventBus: IEventBus<SchedulerEventMap>;
  private readonly logger: SchedulerLogger;
  private readonly now: () => Date;
  private readonly timerLoop: TimerLoop;
  private readonly delivery?: IDeliveryPipeline;

  /** 当前正在执行的任务 ID 集合 */
  private readonly activeTasks = new Set<string>();

  /** 优雅停机用的 AbortController */
  private shutdownController: AbortController | null = null;

  constructor(deps: SchedulerDeps) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config };
    this.store = deps.store;
    this.runAgentTurn = deps.runAgentTurn;
    this.systemHandlers = deps.systemHandlers ?? new Map();
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? createDefaultLogger();
    this.delivery = deps.delivery;

    this.timerLoop = new TimerLoop({
      getEnabledTasks: () => this.getEnabledTasks(),
      onTick: (dueTasks) => this.handleDueTasks(dueTasks),
      now: this.now,
      config: this.config,
    });
  }

  // ─── 生命周期 ───

  /**
   * 启动调度器：加载任务 → 检查 missed → 启动 timer
   */
  async start(): Promise<void> {
    await this.store.load();
    this.shutdownController = new AbortController();

    // 检查 missed tasks（重启补执行）
    const now = this.now();
    const tasks = this.getEnabledTasks();
    let missedCount = 0;

    for (const task of tasks) {
      if (task.state.nextRunAt && new Date(task.state.nextRunAt) < now) {
        missedCount++;
      }
    }

    if (missedCount > 0) {
      this.logger.info(`Found ${missedCount} missed task(s), will catch up on next tick`);
    }

    this.timerLoop.start();
    this.logger.info("Scheduler started", { taskCount: tasks.length, missedCount });
  }

  /**
   * 停止调度器：停止 timer → 等待活跃任务 → 保存
   */
  async stop(): Promise<void> {
    this.timerLoop.stop();

    // 发送 abort 信号给正在执行的任务
    this.shutdownController?.abort();

    // 等待活跃任务完成（最多 shutdownTimeoutMs）
    if (this.activeTasks.size > 0) {
      this.logger.info(`Waiting for ${this.activeTasks.size} active task(s) to complete...`);
      const deadline = Date.now() + this.config.shutdownTimeoutMs;

      while (this.activeTasks.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }

      if (this.activeTasks.size > 0) {
        this.logger.warn(`Shutdown timeout: ${this.activeTasks.size} task(s) still active`);
      }
    }

    await this.store.save();
    this.logger.info("Scheduler stopped");
  }

  // ─── 任务 CRUD ───

  async createTask(
    params: Omit<ScheduledTask, "id" | "state" | "createdAt" | "updatedAt">,
  ): Promise<ScheduledTask> {
    const now = this.now();
    const task: ScheduledTask = {
      ...params,
      id: generateId(),
      state: {
        consecutiveErrors: 0,
        runCount: 0,
        nextRunAt: this.computeNextRunAt(params.schedule, now),
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.store.addTask(task);

    await this.eventBus.emit("scheduler:task-created", {
      taskId: task.id,
      name: task.name,
      schedule: task.schedule,
      nextRunAt: task.state.nextRunAt,
    });

    this.logger.info(`Task created: ${task.name}`, { id: task.id, nextRunAt: task.state.nextRunAt });
    return task;
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<ScheduledTask, "name" | "description" | "enabled" | "priority" | "schedule" | "action" | "delivery">>,
  ): Promise<ScheduledTask> {
    const existing = this.store.getTask(id);
    if (!existing) throw new Error(`Task not found: ${id}`);

    // 如果 schedule 变了，重新计算 nextRunAt
    const updatedPatch: Partial<ScheduledTask> = { ...patch };
    if (patch.schedule) {
      const nextRunAt = this.computeNextRunAt(patch.schedule, this.now());
      updatedPatch.state = { ...existing.state, nextRunAt };
    }

    await this.store.updateTask(id, updatedPatch);
    const updated = this.store.getTask(id)!;

    await this.eventBus.emit("scheduler:task-updated", {
      taskId: id,
      name: updated.name,
    });

    return updated;
  }

  async deleteTask(id: string): Promise<void> {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.system) throw new Error(`Cannot delete system task: ${task.name}`);

    await this.store.removeTask(id);

    await this.eventBus.emit("scheduler:task-deleted", {
      taskId: id,
      name: task.name,
    });
  }

  /**
   * 手动立即执行任务（不等待调度）
   */
  async runTask(id: string): Promise<AgentTurnResult> {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return this.executeSingleTask(task);
  }

  listTasks(): ScheduledTask[] {
    const tasks: ScheduledTask[] = [];
    // 通过 store 的 load 结果获取——store 在 start() 时已加载到内存
    // 遍历所有已知 ID
    for (const task of this.getAllTasks()) {
      tasks.push(task);
    }
    return tasks;
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.store.getTask(id);
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  // ─── 内部方法 ───

  private getEnabledTasks(): ScheduledTask[] {
    return this.getAllTasks().filter((t) => t.enabled);
  }

  private getAllTasks(): ScheduledTask[] {
    // JsonTaskStore 的内部 Map 不直接暴露，
    // 但 load() 后可通过遍历 getTask 获取。
    // 这里通过 store.load() 返回的快照来实现。
    // 实际上我们需要一个 list 方法——用 save() 传空即可触发返回。
    // 更好的方案：让 store 暴露 list 方法。
    // 临时方案：记住上次 load 的结果。
    // 实际 JsonTaskStore.load() 已经返回了所有任务，
    // 且 addTask/updateTask/removeTask 也维护了内存状态。
    // 解决：在 TaskStore 接口加 list() 或让 load() 可重复调用。
    // 这里直接同步调用 load()—— 但 load 是 async。
    // 最佳方案：给 TaskStore 加同步的 list() 方法。
    // 我们先扩展调用方式。

    // 实际上 JsonTaskStore 的 getTask 需要知道 ID，
    // 但我们可以从上一次 load 获取。
    // 更实际的做法：让 Scheduler 自己维护一份引用。
    // 但 store 已经维护了——只是接口不暴露 list。
    // 最简方案：在构造时 load 后缓存任务列表引用。

    // 重构：直接让 Scheduler 维护 tasks 数组
    // 但这会与 store 双重维护。
    // 最终决策：给 store 加 list() 方法。
    // 见 task-store.ts 的修改。
    return this.store.list();
  }

  private async handleDueTasks(dueTasks: ScheduledTask[]): Promise<void> {
    // 并发控制：只取 maxConcurrent - activeTasks.size 个
    const available = this.config.maxConcurrent - this.activeTasks.size;
    if (available <= 0) return;

    const toExecute = dueTasks
      .filter((t) => !this.activeTasks.has(t.id))
      .slice(0, available);

    // 并发启动（不 await 每个——让它们并行执行）
    const promises = toExecute.map((task) => this.executeSingleTask(task));
    await Promise.allSettled(promises);
  }

  private async executeSingleTask(task: ScheduledTask): Promise<AgentTurnResult> {
    this.activeTasks.add(task.id);

    await this.eventBus.emit("scheduler:task-started", {
      taskId: task.id,
      name: task.name,
      actionKind: task.action.kind,
    });

    const executorDeps: TaskExecutorDeps = {
      runAgentTurn: this.runAgentTurn,
      systemHandlers: this.systemHandlers,
      config: this.config,
    };

    try {
      const result = await executeTask(task, executorDeps, this.shutdownController?.signal);
      const finishTime = this.now();

      // 更新任务状态
      task.state.lastRunAt = finishTime.toISOString();
      task.state.lastDurationMs = result.durationMs;
      task.state.runCount += 1;
      task.state.lastSummary = result.output?.slice(0, 500);

      if (result.status === "ok") {
        resetErrorState(task);
        task.state.nextRunAt = this.computeNextRunAt(task.schedule, finishTime);

        await this.eventBus.emit("scheduler:task-completed", {
          taskId: task.id,
          name: task.name,
          durationMs: result.durationMs,
          summary: result.output?.slice(0, 200),
        });

        await this.enqueueDelivery(task, result);
      } else {
        const errorResult = applyErrorPolicy(task, result.error ?? "Unknown error", this.config, finishTime);

        if (errorResult.shouldDisable) {
          task.enabled = false;
          task.state.nextRunAt = undefined;

          await this.eventBus.emit("scheduler:task-disabled", {
            taskId: task.id,
            name: task.name,
            reason: `${this.config.maxConsecutiveErrors} consecutive errors`,
            lastError: task.state.lastError,
          });

          this.logger.warn(`Task auto-disabled: ${task.name}`, {
            id: task.id,
            consecutiveErrors: task.state.consecutiveErrors,
          });
        } else {
          task.state.nextRunAt = errorResult.nextRunAt;
        }

        await this.eventBus.emit("scheduler:task-failed", {
          taskId: task.id,
          name: task.name,
          error: result.error ?? "Unknown error",
          consecutiveErrors: task.state.consecutiveErrors,
          nextRunAt: task.state.nextRunAt,
        });
      }

      // 一次性任务成功后 disable
      if (task.schedule.kind === "once" && result.status === "ok") {
        task.enabled = false;
        task.state.nextRunAt = undefined;
      }

      // 持久化
      await this.store.updateTask(task.id, {
        enabled: task.enabled,
        state: task.state,
      });

      return result;
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  private async enqueueDelivery(
    task: ScheduledTask,
    result: AgentTurnResult,
  ): Promise<void> {
    if (!this.delivery || task.delivery?.kind !== "channel") return;

    const output = result.output ?? "";
    if (!output) return;

    try {
      await this.delivery.enqueue({
        target: {
          channelId: task.delivery.channel,
          to: task.delivery.to,
        },
        content: {
          text: output,
          markdown: output,
        },
        source: {
          kind: "scheduler",
          taskId: task.id,
          taskName: task.name,
        },
      });
    } catch (err) {
      this.logger.warn(`Delivery enqueue failed for task ${task.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 根据调度策略计算下次执行时间
   */
  private computeNextRunAt(
    schedule: ScheduledTask["schedule"],
    from: Date,
  ): string | undefined {
    switch (schedule.kind) {
      case "once":
        return schedule.at;

      case "interval":
        return new Date(from.getTime() + schedule.everyMs).toISOString();

      case "cron": {
        try {
          const interval = CronExpressionParser.parse(schedule.expr, {
            currentDate: from,
            tz: schedule.tz,
          });
          return interval.next().toISOString() ?? undefined;
        } catch {
          this.logger.error(`Invalid cron expression: ${schedule.expr}`);
          return undefined;
        }
      }

      default:
        return undefined;
    }
  }
}

// ─── 工具函数 ───

function generateId(): string {
  // 时间戳前缀 + 随机后缀，保证有序且唯一
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `task_${ts}_${rand}`;
}

function createDefaultLogger(): SchedulerLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}
