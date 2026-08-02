/**
 * SchedulerFacade —— 消费者与「宿主本地权威 vs 经 RPC 接入宿主」之间的解耦缝。
 *
 * 所有调度消费者（schedule 工具、turn-context、cli 命令）只依赖此接口，不直接 new Scheduler、
 * 也不直接碰 RPC：
 * - LocalSchedulerFacade —— 直调本进程 SchedulerBackend（核心宿主内部用）。
 * - RpcSchedulerFacade —— 经 RPC 接入核心宿主（cli 用，在 cli 包实现，叠加 ensure）。
 */

import type { IEventBus } from "../events/index.js";
import type { SchedulerEventMap } from "./events.js";
import { isInternal } from "./status-summary.js";
import type { AgentTurnResult, ScheduledTask, TaskAction } from "./types.js";
import type { ScheduleWriteMutation } from "../contracts/state.js";
import type { IngressContext } from "../contracts/protocol.js";

/** 任务视图 —— 当前等于完整 ScheduledTask；保留为命名缝，未来可换投影类型而不动消费者签名。 */
export type TaskView = ScheduledTask;

/** 创建任务的入参（id / state / 时间戳由内核生成）。 */
export type TaskSpec = Omit<
  ScheduledTask,
  | "id"
  | "taskRevision"
  | "state"
  | "createdAt"
  | "updatedAt"
  | "origin"
  | "createdInTurn"
  | "action"
> & {
  readonly action: Extract<TaskAction, { readonly kind: "agent-turn" }>;
};

/** Authenticated source for a direct scheduler control request. */
export interface SchedulerControlSource {
  readonly ingress: IngressContext;
  readonly connectionId: string;
}

/** 调度任务定义在运行时合同中的唯一别名。 */
export type ScheduleTaskSpec = TaskSpec;

/** 更新任务的补丁 —— 只允许改这些字段（与 Scheduler.updateTask 对齐）。 */
export type TaskPatch = Partial<
  Pick<
    TaskSpec,
    "name" | "description" | "enabled" | "priority" | "schedule" | "action" | "delivery"
  >
>;

/**
 * 调度运行事件 —— 统一 Local（订阅内核 EventBus）与 Rpc（订阅 RPC notification）两侧的事件契约。
 * completed 合并成功/失败（status 区分），与 RPC 事件桥的语义一致，便于消费者一处处理。
 */
export type SchedulerFacadeEvent =
  | { kind: "accepted"; taskId: string; jobRunId: string; name: string }
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

/** Stable identity of one schedule tool mutation inside a durable execution. */
export interface ScheduleMutationContext {
  readonly operationId?: string;
  /** Revision observed by the caller from a prior authority read. */
  readonly taskRevision?: number;
}

/** Assignment-scoped append-only mutation port inherited by nested tool calls. */
export type ScheduleMutationStager = (input: {
  readonly mutation: ScheduleWriteMutation;
  readonly operationId?: string;
}) => Promise<{ readonly seq: number; readonly taskId?: string }>;

/**
 * Host-owned scheduler product port.
 *
 * The legacy in-process Scheduler and the durable anchor scheduler both
 * implement this surface. Consumers must not depend on either implementation
 * class, otherwise replacing the legacy direct-execution path would require a
 * second facade and create two scheduler owners.
 */
export interface SchedulerBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  createTask(
    spec: TaskSpec,
    requestId?: string,
    source?: SchedulerControlSource,
  ): Promise<TaskView>;
  listTasks(): TaskView[];
  updateTask(
    id: string,
    patch: TaskPatch,
    requestId?: string,
    taskRevision?: number,
    source?: SchedulerControlSource,
  ): Promise<TaskView>;
  deleteTask(
    id: string,
    requestId?: string,
    taskRevision?: number,
    source?: SchedulerControlSource,
  ): Promise<void>;
  runTask(
    id: string,
    requestId?: string,
    source?: SchedulerControlSource,
  ): Promise<AgentTurnResult>;
  getTask(id: string): TaskView | undefined;
  abortRun?(
    runId: string,
    requestId?: string,
    source?: SchedulerControlSource,
  ): Promise<boolean> | boolean;
  readonly activeTaskCount?: number;
}

export interface SchedulerFacade {
  /** 创建任务，返回创建后的任务视图（含内核算出的 nextRunAt）。 */
  create(spec: TaskSpec, context?: ScheduleMutationContext): Promise<TaskView>;
  /** 列出任务（纯读）。 */
  list(): Promise<TaskView[]>;
  /** 更新任务，返回更新后的任务视图。 */
  update(id: string, patch: TaskPatch, context?: ScheduleMutationContext): Promise<TaskView>;
  /** 删除任务。 */
  delete(id: string, context?: ScheduleMutationContext): Promise<void>;
  /** 立即运行任务一次。 */
  run(id: string, context?: ScheduleMutationContext): Promise<AgentTurnResult>;
  /** 订阅运行事件，返回取消订阅函数。 */
  onEvent(handler: SchedulerFacadeEventHandler): () => void;
  /** 释放底层资源（如断开 RPC 连接 / 清订阅）。可选——本地实现通常无需。 */
  dispose?(): Promise<void>;
}

/** 直调本进程 scheduler 权威后端的门面实现（核心宿主内部用）。 */
export class LocalSchedulerFacade implements SchedulerFacade {
  readonly #observedRevisions = new Map<string, number>();
  constructor(
    private readonly scheduler: SchedulerBackend,
    private readonly eventBus: IEventBus<SchedulerEventMap>,
  ) {}

  async create(spec: TaskSpec, context?: ScheduleMutationContext): Promise<TaskView> {
    const task = await this.scheduler.createTask(
      spec,
      requireOperationId(context, "Schedule creation"),
    );
    this.#observe(task);
    return task;
  }

  async list(): Promise<TaskView[]> {
    const tasks = this.scheduler.listTasks();
    for (const task of tasks) this.#observe(task);
    return tasks;
  }

  async update(
    id: string,
    patch: TaskPatch,
    context?: ScheduleMutationContext,
  ): Promise<TaskView> {
    const revision = context?.taskRevision ?? this.#observedRevisions.get(id);
    const task = await this.scheduler.updateTask(
      id,
      patch,
      requireOperationId(context, "Schedule update"),
      revision,
    );
    this.#observe(task);
    return task;
  }

  async delete(id: string, context?: ScheduleMutationContext): Promise<void> {
    const revision = context?.taskRevision ?? this.#observedRevisions.get(id);
    await this.scheduler.deleteTask(
      id,
      requireOperationId(context, "Schedule deletion"),
      revision,
    );
    this.#observedRevisions.delete(id);
  }

  async run(id: string, context?: ScheduleMutationContext): Promise<AgentTurnResult> {
    return this.scheduler.runTask(
      id,
      requireOperationId(context, "Schedule run"),
    );
  }

  #observe(task: TaskView): void {
    if (Number.isSafeInteger(task.taskRevision) && task.taskRevision! > 0) {
      this.#observedRevisions.set(task.id, task.taskRevision!);
    }
  }

  onEvent(handler: SchedulerFacadeEventHandler): () => void {
    // 内部维护任务静默：不向消费者派发其运行事件——与 RPC 事件广播 / channel 投递
    // 两个触达边界一致，统一由 isInternal 谓词推导（task 已删则按外部放行，安全侧）。
    const visible = (taskId: string): boolean => {
      const t = this.scheduler.getTask(taskId);
      return !t || !isInternal(t);
    };
    const offs = [
      this.eventBus.on("scheduler:task-accepted", (e) => {
        if (visible(e.taskId)) handler({ kind: "accepted", ...e });
      }),
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

function requireOperationId(
  context: ScheduleMutationContext | undefined,
  label: string,
): string {
  const operationId = context?.operationId;
  if (!operationId) {
    throw new Error(`${label} requires a stable operation id`);
  }
  return operationId;
}
