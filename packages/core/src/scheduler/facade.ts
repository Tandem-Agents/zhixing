/**
 * SchedulerFacade —— 消费者与「宿主本地权威 vs 经 RPC 接入宿主」之间的解耦缝。
 *
 * 所有调度消费者（schedule 工具、turn-context、cli 命令）只依赖此接口，不直接 new Scheduler、
 * 也不直接碰 RPC：
 * - LocalSchedulerFacade —— 经同一 Schedule application 调用本机权威。
 * - RpcSchedulerFacade —— 经 RPC 接入核心宿主（cli 用，在 cli 包实现，叠加 ensure）。
 */

import type { AgentTurnResult, ScheduledTask, TaskAction } from "./types.js";
import type { ScheduleWriteMutation } from "../contracts/state.js";
import type { IngressContext } from "../contracts/protocol.js";
import type {
  ScheduleManagementApplication,
  ScheduleRuntimeApplication,
  ScheduleRuntimeEvent,
  ScheduleTaskDraft,
} from "./application.js";

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
export type SchedulerFacadeEvent = ScheduleRuntimeEvent;

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

export interface SchedulerFacade {
  /** 创建任务，返回创建后的任务视图（含内核算出的 nextRunAt）。 */
  create(spec: ScheduleTaskDraft, context?: ScheduleMutationContext): Promise<TaskView>;
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

/** 领域管理应用 + 本机运行桥的 facade（核心宿主内部用）。 */
export class LocalSchedulerFacade implements SchedulerFacade {
  readonly #observedRevisions = new Map<string, number>();
  constructor(
    private readonly management: ScheduleManagementApplication,
    private readonly runtime: ScheduleRuntimeApplication,
  ) {}

  async create(spec: ScheduleTaskDraft, context?: ScheduleMutationContext): Promise<TaskView> {
    const result = await this.management.execute({
      kind: "create",
      draft: spec,
      operation: { operationId: requireOperationId(context, "Schedule creation") },
    });
    if (result.kind !== "created") throw new TypeError("Schedule create returned wrong result");
    const task = result.task;
    this.#observe(task);
    return task;
  }

  async list(): Promise<TaskView[]> {
    const tasks = [...(await this.management.query({ kind: "list" })).tasks];
    for (const task of tasks) this.#observe(task);
    return tasks;
  }

  async update(
    id: string,
    patch: TaskPatch,
    context?: ScheduleMutationContext,
  ): Promise<TaskView> {
    const revision = context?.taskRevision ?? this.#observedRevisions.get(id);
    const result = await this.management.execute({
      kind: "update",
      taskId: id,
      patch,
      operation: {
        operationId: requireOperationId(context, "Schedule update"),
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
      },
    });
    if (result.kind !== "updated") throw new TypeError("Schedule update returned wrong result");
    const task = result.task;
    this.#observe(task);
    return task;
  }

  async delete(id: string, context?: ScheduleMutationContext): Promise<void> {
    const revision = context?.taskRevision ?? this.#observedRevisions.get(id);
    const result = await this.management.execute({
      kind: "delete",
      taskId: id,
      operation: {
        operationId: requireOperationId(context, "Schedule deletion"),
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
      },
    });
    if (result.kind !== "deleted") throw new TypeError("Schedule delete returned wrong result");
    this.#observedRevisions.delete(id);
  }

  async run(id: string, context?: ScheduleMutationContext): Promise<AgentTurnResult> {
    const result = await this.management.execute({
      kind: "run",
      taskId: id,
      operation: { operationId: requireOperationId(context, "Schedule run") },
    });
    if (result.kind !== "ran") throw new TypeError("Schedule run returned wrong result");
    return result.result;
  }

  #observe(task: TaskView): void {
    if (Number.isSafeInteger(task.taskRevision) && task.taskRevision! > 0) {
      this.#observedRevisions.set(task.id, task.taskRevision!);
    }
  }

  onEvent(handler: SchedulerFacadeEventHandler): () => void {
    return this.runtime.onEvent(handler);
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
