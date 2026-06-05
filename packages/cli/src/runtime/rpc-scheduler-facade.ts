/**
 * RpcSchedulerFacade —— cli 经 RPC 接入核心宿主的 SchedulerFacade 实现。
 *
 * 读写分离：
 * - 写 / 执行（create / update / delete / run）经连接发 RPC（按需 ensure 宿主）。
 * - list 直接读 scheduler.json 从属投影，不拉宿主（磁盘是宿主单写者的只读投影）。
 * - onEvent 经 RPC notification 订阅，被动——不为订阅而拉宿主。
 */

import {
  getSchedulerStorePath,
  type SchedulerFacade,
  type TaskSpec,
  type TaskPatch,
  type TaskView,
  type AgentTurnResult,
  type SchedulerFacadeEvent,
  type SchedulerFacadeEventHandler,
} from "@zhixing/core";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
  type CoreHostConnectionDeps,
} from "./core-host-connection.js";
import { readSchedulerTasksSync } from "./scheduler-projection.js";

export interface RpcSchedulerFacadeOptions {
  /** 连接依赖注入（测试用）；默认走真实 discover / spawn / createClient。 */
  connectionDeps?: CoreHostConnectionDeps;
  /** scheduler.json 路径（读投影用）；默认 getSchedulerStorePath()。 */
  storePath?: string;
}

export class RpcSchedulerFacade implements SchedulerFacade {
  private readonly conn: CoreHostConnection;
  private readonly storePath: string;

  constructor(opts: RpcSchedulerFacadeOptions = {}) {
    this.conn = new CoreHostConnection(
      opts.connectionDeps ?? defaultCoreHostConnectionDeps(),
    );
    this.storePath = opts.storePath ?? getSchedulerStorePath();
  }

  async create(spec: TaskSpec): Promise<TaskView> {
    const client = await this.conn.getClient();
    return client.request<TaskView>("schedule.create", spec);
  }

  // 读投影：直接读 scheduler.json（宿主单写者的只读投影），不拉宿主。损坏即空，
  // 与 turn-context 的 sync 投影同降级语义（不向消费者抛原始 JSON 解析错误）。
  async list(): Promise<TaskView[]> {
    return readSchedulerTasksSync(this.storePath);
  }

  async update(id: string, patch: TaskPatch): Promise<TaskView> {
    const client = await this.conn.getClient();
    return client.request<TaskView>("schedule.update", { id, patch });
  }

  async delete(id: string): Promise<void> {
    const client = await this.conn.getClient();
    await client.request("schedule.delete", { id });
  }

  async run(id: string): Promise<AgentTurnResult> {
    const client = await this.conn.getClient();
    return client.request<AgentTurnResult>("schedule.run", { id });
  }

  onEvent(handler: SchedulerFacadeEventHandler): () => void {
    const offs = [
      this.conn.onNotification("schedule.started", (p) => handler(toStarted(p))),
      this.conn.onNotification("schedule.completed", (p) => handler(toCompleted(p))),
      this.conn.onNotification("schedule.disabled", (p) => handler(toDisabled(p))),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  /** 主动接入核心宿主（不在则拉起）—— cli 启动轻检查命中时调，防系统维护饿死。 */
  async ensureHost(): Promise<void> {
    await this.conn.getClient();
  }

  /** cli 退出时关闭连接 + 清订阅。 */
  async dispose(): Promise<void> {
    await this.conn.dispose();
  }
}

// ─── RPC notification payload → 统一门面事件 ───
// event-bridge 推送的 payload 形状已含这些字段（task-failed 已并入 completed{status:error}）。

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
