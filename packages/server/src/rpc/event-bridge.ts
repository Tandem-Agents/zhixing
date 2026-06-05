/**
 * EventBus → RPC Notification 桥接
 *
 * 把 Scheduler/未来其他模块的 EventBus 事件转成 JSON-RPC notification，
 * 推送给所有已认证的连接。
 *
 * 设计要点：
 * - 仅推给 authenticated 连接（未认证客户端不应收到内部事件）
 * - 事件名映射：scheduler:task-completed → schedule.completed（per server-gateway.md §5.4）
 * - 返回 dispose 函数，用于 Server 关闭时取消订阅
 * - 跨多种 EventBus 都用同一个 broadcast helper
 */

import type { IEventBus, SchedulerEventMap } from "@zhixing/core";
import type { RpcConnection } from "./connection.js";

export interface EventBridgeDeps {
  /** 当前活跃的 RPC 连接集合 */
  connections: ReadonlySet<RpcConnection>;
  schedulerEventBus?: IEventBus<SchedulerEventMap>;
  /**
   * 内部任务谓词 —— 命中则不向 client 广播该任务的运行事件（结果触达：内部维护静默）。
   * 注入式，桥本身不懂 scheduler 领域；不传则不过滤（向后兼容）。
   */
  isInternalTask?: (taskId: string) => boolean;
}

export type DisposeBridge = () => void;

/**
 * 创建 EventBus 桥接。返回 dispose 函数清理订阅。
 */
export function createEventBridge(deps: EventBridgeDeps): DisposeBridge {
  const disposers: Array<() => void> = [];

  if (deps.schedulerEventBus) {
    disposers.push(
      ...wireScheduler(
        deps.schedulerEventBus,
        deps.connections,
        deps.isInternalTask,
      ),
    );
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
  };
}

function wireScheduler(
  bus: IEventBus<SchedulerEventMap>,
  connections: ReadonlySet<RpcConnection>,
  isInternalTask?: (taskId: string) => boolean,
): Array<() => void> {
  const broadcast = (method: string, params: unknown) => {
    for (const conn of connections) {
      if (conn.authenticated && !conn.closed) {
        conn.notify(method, params);
      }
    }
  };

  // 内部维护任务的运行结果不触达 client —— 与 channel 投递、facade.onEvent 两个
  // 触达边界一致，统一由注入的 isInternal 谓词推导。
  const isInternal = (taskId: string): boolean => isInternalTask?.(taskId) ?? false;

  const subs: Array<() => void> = [];

  subs.push(
    bus.on("scheduler:task-started", (e) => {
      if (isInternal(e.taskId)) return;
      broadcast("schedule.started", { taskId: e.taskId, name: e.name });
    }),
  );

  subs.push(
    bus.on("scheduler:task-completed", (e) => {
      if (isInternal(e.taskId)) return;
      broadcast("schedule.completed", {
        taskId: e.taskId,
        name: e.name,
        status: "ok" as const,
        durationMs: e.durationMs,
        summary: e.summary,
      });
    }),
  );

  subs.push(
    bus.on("scheduler:task-failed", (e) => {
      if (isInternal(e.taskId)) return;
      broadcast("schedule.completed", {
        taskId: e.taskId,
        name: e.name,
        status: "error" as const,
        error: e.error,
        consecutiveErrors: e.consecutiveErrors,
        nextRunAt: e.nextRunAt,
      });
    }),
  );

  subs.push(
    bus.on("scheduler:task-disabled", (e) => {
      if (isInternal(e.taskId)) return;
      broadcast("schedule.disabled", {
        taskId: e.taskId,
        name: e.name,
        reason: e.reason,
        lastError: e.lastError,
      });
    }),
  );

  return subs;
}
