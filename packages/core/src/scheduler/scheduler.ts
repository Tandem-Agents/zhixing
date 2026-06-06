/**
 * Scheduler — 调度器主类
 *
 * 职责：
 * - 管理任务生命周期（CRUD）
 * - 协调 TimerLoop + TaskExecutor + ErrorPolicy + TaskStore
 * - 并发控制（maxConcurrent）
 * - Missed 分流（以本次上线时刻为锚：离线期间错过的记录不补，在线到点的正常执行）
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
import { isInternal } from "./status-summary.js";
import type {
  AgentTurnParams,
  AgentTurnResult,
  ScheduledTask,
  SchedulerLogger,
  SystemHandler,
  TaskPriority,
  TaskSchedule,
  TaskStore,
} from "./types.js";
import type { SchedulerEventMap } from "./events.js";
import type { IDeliveryPipeline } from "../delivery/types.js";
import { DEFAULT_SLOT_TTL_MS } from "../delivery/outbox-types.js";

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

  /**
   * 本次上线时刻（epoch ms）—— start 时置、stop 不清、下次 start 重置。
   * 「错过」判定以它为锚（非 now）：应触发于「上线 - 容差」之前 = 宿主离线期间错过、
   * 之后 = 在线到点。锚在固定值、不随 now 漂移，故在线并发延迟无论多久都不被误判。
   * per-instance 运行时状态、不持久化——每次拉起重新计「本次在线」（与按需起落一致）。
   */
  private onlineSince: number | null = null;

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
   * 启动调度器：加载任务 → 记本次上线时刻 → 启动 timer（过期任务交首次 tick 到点分流）
   */
  async start(): Promise<void> {
    await this.store.load();
    this.shutdownController = new AbortController();
    // 记本次上线时刻——「错过」以它为锚（见 handleDueTasks / isMissedWhileOffline）。
    // 过期任务不在启动时补执行：应触发于上线之前的（离线期间错过）记错过、不补；
    // 之后到点的正常执行。
    this.onlineSince = this.now().getTime();

    this.timerLoop.start();
    this.logger.info("Scheduler started", {
      taskCount: this.getEnabledTasks().length,
    });
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
    if (params.schedule.kind === "interval" && params.schedule.everyMs < 60_000) {
      throw new Error(`Interval too short: ${params.schedule.everyMs}ms (minimum 60000ms)`);
    }
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
    this.timerLoop.rearm();
    return task;
  }

  /**
   * 确保系统内置任务存在（seed-if-absent，幂等）。固定 id 用于判存在性——
   * 绕过 createTask 的 generateId，直接以给定 id 落库（system:true 不可删）。
   * 已存在则不动（schedule 变更的迁移留待未来 reconcile）。
   */
  async ensureSystemTask(spec: {
    id: string;
    name: string;
    handler: string;
    schedule: TaskSchedule;
    priority?: TaskPriority;
    description?: string;
  }): Promise<void> {
    if (this.store.getTask(spec.id)) return;

    const now = this.now();
    const task: ScheduledTask = {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      enabled: true,
      priority: spec.priority ?? "low",
      schedule: spec.schedule,
      action: { kind: "system", handler: spec.handler },
      state: {
        consecutiveErrors: 0,
        runCount: 0,
        nextRunAt: this.computeNextRunAt(spec.schedule, now),
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      system: true,
    };
    await this.store.addTask(task);
    this.logger.info(`System task seeded: ${task.name}`, {
      id: task.id,
      nextRunAt: task.state.nextRunAt,
    });
    this.timerLoop.rearm();
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<ScheduledTask, "name" | "description" | "enabled" | "priority" | "schedule" | "action" | "delivery">>,
  ): Promise<ScheduledTask> {
    const existing = this.store.getTask(id);
    if (!existing) throw new Error(`Task not found: ${id}`);
    // 内部维护任务不可改（对齐 deleteTask 的拒删）——显式守卫，不靠「可见性过滤让外部
    // 拿不到 id」间接兜底。系统任务执行后的 state 更新走 store.updateTask（内部直写）、
    // 不经此入口，故不受影响。
    if (existing.system) {
      throw new Error(`Cannot modify system task: ${existing.name}`);
    }

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

    if (patch.schedule || patch.enabled !== undefined) {
      this.timerLoop.rearm();
    }

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
    return this.store.list();
  }

  private async handleDueTasks(dueTasks: ScheduledTask[]): Promise<void> {
    const now = this.now();

    // 到点分流（以本次上线时刻为锚，见 isMissedWhileOffline）：应触发于「上线 - 容差」
    // 之前的，是宿主离线期间真正错过的触发——记「错过」、不补、推进 nextRunAt（once 即
    // 终止）；其余是在线到点（含被并发推迟很久的），进 ontime 受并发上限执行、未轮到则
    // 保持 due 等待，绝不因等待时长被误判错过。错过的不占并发额度。
    const ontime: ScheduledTask[] = [];
    for (const task of dueTasks) {
      const scheduledFor = task.state.nextRunAt;
      if (!scheduledFor) continue;
      if (this.isMissedWhileOffline(scheduledFor)) {
        await this.markMissed(task, scheduledFor, now);
      } else {
        ontime.push(task);
      }
    }

    // 准时任务受并发上限约束执行
    const available = this.config.maxConcurrent - this.activeTasks.size;
    if (available <= 0) return;
    const toExecute = ontime
      .filter((t) => !this.activeTasks.has(t.id))
      .slice(0, available);
    await Promise.allSettled(toExecute.map((task) => this.executeSingleTask(task)));
  }

  /**
   * 「错过」判定 —— 以本次上线时刻 onlineSince 为锚、而非 now：任务应触发时刻早于
   * 「上线 - 容差」即宿主离线期间错过的触发；之后（含在线被并发推迟很久）都是在线到点、
   * 该执行不该误判。判据锚在固定的 onlineSince、不随 now 漂移，是「在线并发延迟不被
   * 误判错过」的关键（once 任务因此不会被并发饿死后误判 terminal）。容差只吸收上线
   * 边界附近的短暂离线（如重启间隙）。onlineSince 未设（未 start）时兜底当作在线。
   */
  private isMissedWhileOffline(scheduledFor: string): boolean {
    if (this.onlineSince === null) return false;
    return (
      new Date(scheduledFor).getTime() <
      this.onlineSince - this.config.graceWindowMs
    );
  }

  /**
   * 记录一次「错过」：不执行，只把错过的事实写入 state.lastMissed，并推进 nextRunAt
   * 到下一个未来时刻（once 错过则终止：disable + 清 nextRunAt）。供使用侧未来查询。
   */
  private async markMissed(
    task: ScheduledTask,
    scheduledFor: string,
    detectedAt: Date,
  ): Promise<void> {
    task.state.lastMissed = {
      scheduledFor,
      detectedAt: detectedAt.toISOString(),
    };
    if (task.schedule.kind === "once") {
      task.enabled = false;
      task.state.nextRunAt = undefined;
    } else {
      task.state.nextRunAt = this.computeNextRunAt(task.schedule, detectedAt);
    }
    await this.store.updateTask(task.id, {
      enabled: task.enabled,
      state: task.state,
    });
    this.logger.info(`[错过] "${task.name}" 应触发于 ${scheduledFor}，超容差不补`, {
      id: task.id,
    });
  }

  private async executeSingleTask(task: ScheduledTask): Promise<AgentTurnResult> {
    // 同 task 并发守卫：撞上正在跑的同一 task 即拒绝。runTask（RPC schedule.run / 工具）
    // 与 handleDueTasks 都经此唯一入口，保证「同 task 同时只一个 run」——taskId 与
    // in-flight run 因此一一对应，RunRegistry 以 taskId 为 key 才安全。
    if (this.activeTasks.has(task.id)) {
      return {
        status: "error",
        error: `Task "${task.name}" is already running`,
        durationMs: 0,
      };
    }
    this.activeTasks.add(task.id);
    this.logger.info(`[执行] "${task.name}" id=${task.id} kind=${task.action.kind}`);

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
    // 内部维护任务静默：结果不触达用户（不投递 channel）——与事件广播边界对内部
    // 任务的处理一致，由同一 isInternal 谓词推导，不靠「内部任务碰巧没配 delivery」兜底。
    if (isInternal(task)) {
      task.state.lastDeliveryStatus = "skipped";
      return;
    }

    if (!this.delivery) {
      task.state.lastDeliveryStatus = "skipped";
      return;
    }

    const output = result.output ?? "";
    if (!output) {
      task.state.lastDeliveryStatus = "skipped";
      return;
    }

    // 1. 显式配置 → 用它
    let target: { channelId: string; to: string } | null = null;
    if (task.delivery?.kind === "channel") {
      target = { channelId: task.delivery.channel, to: task.delivery.to };
    }

    // 2. 任务创建时捕获的 origin → 自动回复到来源会话
    if (!target && task.origin) {
      target = task.origin;
    }

    // 3. 无法解析 → 跳过
    if (!target) {
      this.logger.info(`[投递] 跳过 "${task.name}" — 无 origin 无显式配置`);
      task.state.lastDeliveryStatus = "skipped";
      return;
    }

    this.logger.info(`[投递] "${task.name}" → ${target.channelId}:${target.to} len=${output.length} text="${output}"`);
    try {
      await this.delivery.enqueue({
        target,
        content: {
          text: output,
          markdown: output,
        },
        source: {
          kind: "scheduler",
          taskId: task.id,
          taskName: task.name,
          // createdInTurn 只在三条件都满足时透传：
          //
          // 1) task.createdInTurn 存在（非 channel 创建的任务如 API/CLI 不带）
          // 2) 是 `once` 任务——周期任务（interval/cron）每次 fire 时，
          //    创建它的 turn 早已结束，对应 slot 必然 expired 或 orphan，
          //    带 afterSlot 只会每次 fire 都触发 causal-broken 告警噪音
          // 3) 创建至今 < SLOT_TTL——对于"明天 9 点"这种远期 once 任务，
          //    fire 时对应 slot 必已 expired/reaped，透传也是噪音
          //
          // 典型受益场景："5 秒后提醒我"——近期创建 + once + slot pending/filled，
          // afterSlot 真正实现 Phase 3 因果保证（回复先于 task fire）。
          ...(task.createdInTurn !== undefined &&
            task.schedule.kind === "once" &&
            Date.now() - new Date(task.createdAt).getTime() <
              DEFAULT_SLOT_TTL_MS && {
              createdInTurn: task.createdInTurn,
            }),
        },
      });
      await this.delivery.flush();
      task.state.lastDeliveryStatus = "sent";
    } catch (err) {
      task.state.lastDeliveryStatus = "failed";
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
