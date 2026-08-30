/**
 * Product event → RPC Notification 桥接
 *
 * 把领域应用已裁决的产品事件转成 JSON-RPC notification，
 * 推送给所有已认证的连接。
 *
 * 设计要点：
 * - 仅推给 authenticated 连接（未认证客户端不应收到内部事件）
 * - scheduler 领域事件统一映射为稳定的 schedule 通知名
 * - 返回 dispose 函数，用于宿主关闭时取消订阅
 * - 传输层不读取原始 Scheduler EventBus，也不重复可见性或失败折叠规则
 */

import type {
  ScheduleRuntimeApplication,
  ScheduleRuntimeEvent,
} from "@zhixing/core/scheduler/application";
import type { RpcNotificationConnection } from "./connection.js";

export interface EventBridgeDeps {
  /** 当前活跃的 RPC 连接集合 */
  connections: ReadonlySet<RpcNotificationConnection>;
  scheduleRuntimeEvents?: Pick<ScheduleRuntimeApplication, "onEvent">;
}

export type DisposeBridge = () => void;

/**
 * 创建产品事件桥接。返回 dispose 函数清理订阅。
 */
export function createEventBridge(deps: EventBridgeDeps): DisposeBridge {
  const disposers: Array<() => void> = [];

  if (deps.scheduleRuntimeEvents) {
    disposers.push(wireScheduleEvents(deps.scheduleRuntimeEvents, deps.connections));
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

function wireScheduleEvents(
  events: Pick<ScheduleRuntimeApplication, "onEvent">,
  connections: ReadonlySet<RpcNotificationConnection>,
): () => void {
  const broadcast = (method: string, params: unknown) => {
    for (const conn of connections) {
      if (conn.authenticated && !conn.closed) {
        conn.notify(method, params);
      }
    }
  };

  return events.onEvent((event) => {
    const [method, params] = scheduleNotification(event);
    broadcast(method, params);
  });
}

function scheduleNotification(event: ScheduleRuntimeEvent): readonly [string, unknown] {
  switch (event.kind) {
    case "accepted":
      return ["schedule.accepted", {
        taskId: event.taskId,
        jobRunId: event.jobRunId,
        name: event.name,
      }];
    case "started":
      return ["schedule.started", { taskId: event.taskId, name: event.name }];
    case "completed":
      return event.status === "ok"
        ? ["schedule.completed", {
            taskId: event.taskId,
            name: event.name,
            status: event.status,
            durationMs: event.durationMs,
            ...(event.summary ? { summary: event.summary } : {}),
          }]
        : ["schedule.completed", {
            taskId: event.taskId,
            name: event.name,
            status: event.status,
            error: event.error,
            consecutiveErrors: event.consecutiveErrors,
            ...(event.nextRunAt ? { nextRunAt: event.nextRunAt } : {}),
          }];
    case "disabled":
      return ["schedule.disabled", {
        taskId: event.taskId,
        name: event.name,
        reason: event.reason,
        ...(event.lastError ? { lastError: event.lastError } : {}),
      }];
  }
}
