/**
 * SchedulerFacade —— 消费者与「本地 Scheduler 实例 vs 经 RPC 接入宿主」之间的解耦缝。
 *
 * 所有调度消费者（schedule 工具、turn-context、cli 命令）只依赖此接口，不直接 new Scheduler、
 * 也不直接碰 RPC：
 * - LocalSchedulerFacade —— 直调本进程 Scheduler（核心宿主内部用）。
 * - RpcSchedulerFacade —— 经 RPC 接入核心宿主（cli 用，在 cli 包实现，叠加 ensure）。
 */

import type { IEventBus } from "../events/index.js";
import type { SchedulerEventMap } from "./events.js";
import type { Scheduler } from "./scheduler.js";
import { isInternal } from "./status-summary.js";
import type { AgentTurnResult, ScheduledTask } from "./types.js";

/** 任务视图 —— 当前等于完整 ScheduledTask；保留为命名缝，未来可换投影类型而不动消费者签名。 */
export type TaskView = ScheduledTask;

/** 创建任务的入参（id / state / 时间戳由内核生成）。 */
export type TaskSpec = Omit<ScheduledTask, "id" | "state" | "createdAt" | "updatedAt">;

/** 更新任务的补丁 —— 只允许改这些字段（与 Scheduler.updateTask 对齐）。 */
export type TaskPatch = Partial<
  Pick<
    ScheduledTask,
    "name" | "description" | "enabled" | "priority" | "schedule" | "action" | "delivery"
  >
>;

/**
 * 调度运行事件 —— 统一 Local（订阅内核 EventBus）与 Rpc（订阅 RPC notification）两侧的事件契约。
 * completed 合并成功/失败（status 区分），与 RPC 事件桥的语义一致，便于消费者一处处理。
 */
export type SchedulerFacadeEvent =
  | { kind: "started"; taskId: string; name: string }
  | {
      kind: "completed";
      taskId: string;
      name: string;
      status: "ok" | "error";
      durationMs?: number;
      summary?: string;
      error?: string;
      /** 仅 status==="error" 时有意义：连续失败次数 + 下次重试时刻。 */
      consecutiveErrors?: number;
      nextRunAt?: string;
    }
  | { kind: "disabled"; taskId: string; name: string; reason?: string; lastError?: string };

export type SchedulerFacadeEventHandler = (event: SchedulerFacadeEvent) => void;

export interface SchedulerFacade {
  /** 创建任务，返回创建后的任务视图（含内核算出的 nextRunAt）。 */
  create(spec: TaskSpec): Promise<TaskView>;
  /** 列出任务（纯读）。 */
  list(): Promise<TaskView[]>;
  /** 更新任务，返回更新后的任务视图。 */
  update(id: string, patch: TaskPatch): Promise<TaskView>;
  /** 删除任务。 */
  delete(id: string): Promise<void>;
  /** 立即运行任务一次。 */
  run(id: string): Promise<AgentTurnResult>;
  /** 订阅运行事件，返回取消订阅函数。 */
  onEvent(handler: SchedulerFacadeEventHandler): () => void;
  /** 释放底层资源（如断开 RPC 连接 / 清订阅）。可选——本地实现通常无需。 */
  dispose?(): Promise<void>;
}

/** 直调本进程 Scheduler 的门面实现（核心宿主内部用）。 */
export class LocalSchedulerFacade implements SchedulerFacade {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly eventBus: IEventBus<SchedulerEventMap>,
  ) {}

  async create(spec: TaskSpec): Promise<TaskView> {
    return this.scheduler.createTask(spec);
  }

  async list(): Promise<TaskView[]> {
    return this.scheduler.listTasks();
  }

  async update(id: string, patch: TaskPatch): Promise<TaskView> {
    return this.scheduler.updateTask(id, patch);
  }

  async delete(id: string): Promise<void> {
    await this.scheduler.deleteTask(id);
  }

  async run(id: string): Promise<AgentTurnResult> {
    return this.scheduler.runTask(id);
  }

  onEvent(handler: SchedulerFacadeEventHandler): () => void {
    // 内部维护任务静默：不向消费者派发其运行事件——与 RPC 事件广播 / channel 投递
    // 两个触达边界一致，统一由 isInternal 谓词推导（task 已删则按外部放行，安全侧）。
    const visible = (taskId: string): boolean => {
      const t = this.scheduler.getTask(taskId);
      return !t || !isInternal(t);
    };
    const offs = [
      this.eventBus.on("scheduler:task-started", (e) => {
        if (visible(e.taskId))
          handler({ kind: "started", taskId: e.taskId, name: e.name });
      }),
      this.eventBus.on("scheduler:task-completed", (e) => {
        if (visible(e.taskId))
          handler({
            kind: "completed",
            taskId: e.taskId,
            name: e.name,
            status: "ok",
            durationMs: e.durationMs,
            summary: e.summary,
          });
      }),
      this.eventBus.on("scheduler:task-failed", (e) => {
        if (visible(e.taskId))
          handler({
            kind: "completed",
            taskId: e.taskId,
            name: e.name,
            status: "error",
            error: e.error,
            consecutiveErrors: e.consecutiveErrors,
            nextRunAt: e.nextRunAt,
          });
      }),
      this.eventBus.on("scheduler:task-disabled", (e) => {
        if (visible(e.taskId))
          handler({
            kind: "disabled",
            taskId: e.taskId,
            name: e.name,
            reason: e.reason,
            lastError: e.lastError,
          });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }
}
