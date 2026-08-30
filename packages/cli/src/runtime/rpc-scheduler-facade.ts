/**
 * RpcSchedulerFacade —— cli 经 RPC 接入核心宿主的 SchedulerFacade 实现。
 *
 * facade 是方法域封装、不持连接:连接是进程级共享的 CoreHostRpcLink(调度 /
 * 会话 / 确认域共用一条已认证连接),建立 / 重连 / 释放归连接持有者。
 *
 * 全部读写都经过当前宿主的 scheduler authority。客户端不读取本地兼容
 * JSON，也不维持第二份任务事实；事件仍经既有 RPC notification 被动订阅。
 */

import {
  type SchedulerFacade,
  type TaskPatch,
  type TaskView,
  type AgentTurnResult,
  type SchedulerFacadeEvent,
  type SchedulerFacadeEventHandler,
  type ScheduleMutationContext,
} from "@zhixing/core";
import type { ScheduleTaskDraft } from "@zhixing/core/scheduler/application";
import type { CoreHostRpcLink } from "./core-host-connection.js";

export interface RpcSchedulerFacadeOptions {
  /** 进程级共享的核心宿主连接。 */
  connection: CoreHostRpcLink;
}

export class RpcSchedulerFacade implements SchedulerFacade {
  private readonly link: CoreHostRpcLink;
  private readonly observedRevisions = new Map<string, number>();

  constructor(opts: RpcSchedulerFacadeOptions) {
    this.link = opts.connection;
  }

  async create(spec: ScheduleTaskDraft, context?: ScheduleMutationContext): Promise<TaskView> {
    const client = await this.link.getClient();
    const task = await client.request<TaskView>("schedule.create", {
      ...spec,
      requestId: requireOperationId(context, "Schedule creation"),
    });
    this.observe(task);
    return task;
  }

  async list(): Promise<TaskView[]> {
    const client = await this.link.getClient();
    const tasks = await client.request<TaskView[]>("schedule.list");
    for (const task of tasks) this.observe(task);
    return tasks;
  }

  async update(id: string, patch: TaskPatch, context?: ScheduleMutationContext): Promise<TaskView> {
    const client = await this.link.getClient();
    const taskRevision = context?.taskRevision ?? this.observedRevisions.get(id);
    if (!taskRevision) throw new Error("Schedule update requires an observed task revision");
    const task = await client.request<TaskView>("schedule.update", {
      id,
      patch,
      taskRevision,
      requestId: requireOperationId(context, "Schedule update"),
    });
    this.observe(task);
    return task;
  }

  async delete(id: string, context?: ScheduleMutationContext): Promise<void> {
    const client = await this.link.getClient();
    const taskRevision = context?.taskRevision ?? this.observedRevisions.get(id);
    if (!taskRevision) throw new Error("Schedule deletion requires an observed task revision");
    await client.request("schedule.delete", {
      id,
      taskRevision,
      requestId: requireOperationId(context, "Schedule deletion"),
    });
    this.observedRevisions.delete(id);
  }

  async run(id: string, context?: ScheduleMutationContext): Promise<AgentTurnResult> {
    const client = await this.link.getClient();
    return client.request<AgentTurnResult>("schedule.run", {
      id,
      requestId: requireOperationId(context, "Schedule run"),
    });
  }

  private observe(task: TaskView): void {
    if (Number.isSafeInteger(task.taskRevision) && task.taskRevision! > 0) {
      this.observedRevisions.set(task.id, task.taskRevision!);
    }
  }

  onEvent(handler: SchedulerFacadeEventHandler): () => void {
    const offs = [
      this.link.onNotification("schedule.accepted", (p) => handler(toAccepted(p))),
      this.link.onNotification("schedule.started", (p) => handler(toStarted(p))),
      this.link.onNotification("schedule.completed", (p) => handler(toCompleted(p))),
      this.link.onNotification("schedule.disabled", (p) => handler(toDisabled(p))),
    ];
    return () => {
      for (const off of offs) off();
    };
  }
}

// ─── RPC notification payload → 统一门面事件 ───
// event-bridge 推送的 payload 形状已含这些字段（task-failed 已并入 completed{status:error}）。

function toAccepted(payload: unknown): SchedulerFacadeEvent {
  const p = payload as { taskId: string; jobRunId: string; name: string };
  return {
    kind: "accepted",
    taskId: p.taskId,
    jobRunId: p.jobRunId,
    name: p.name,
  };
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

function toStarted(payload: unknown): SchedulerFacadeEvent {
  const p = payload as { taskId: string; name: string };
  return { kind: "started", taskId: p.taskId, name: p.name };
}

function toCompleted(payload: unknown): SchedulerFacadeEvent {
  const p = payload as {
    taskId: string;
    name: string;
    status: "ok" | "error";
    durationMs?: number;
    summary?: string;
    error?: string;
    consecutiveErrors?: number;
    nextRunAt?: string;
  };
  return {
    kind: "completed",
    taskId: p.taskId,
    name: p.name,
    status: p.status,
    durationMs: p.durationMs,
    summary: p.summary,
    error: p.error,
    consecutiveErrors: p.consecutiveErrors,
    nextRunAt: p.nextRunAt,
  };
}

function toDisabled(payload: unknown): SchedulerFacadeEvent {
  const p = payload as {
    taskId: string;
    name: string;
    reason?: string;
    lastError?: string;
  };
  return {
    kind: "disabled",
    taskId: p.taskId,
    name: p.name,
    reason: p.reason,
    lastError: p.lastError,
  };
}
