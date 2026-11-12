/**
 * Product event → RPC Notification 桥接
 *
 * 把领域应用已裁决的产品事件转成 JSON-RPC notification，
 * 推送给所有已认证的连接。
 *
 * 设计要点：
 * - 仅推给 authenticated 连接（未认证客户端不应收到内部事件）
 * - scheduler 领域事件统一映射为稳定的 schedule 通知名
 * - 技能目录拥有者确认的结构变化映射为 skill.changed，供各表面重查目录
 * - 返回 dispose 函数，用于宿主关闭时取消订阅
 * - 传输层不读取原始 Scheduler EventBus，也不重复可见性或失败折叠规则
 */

import type {
  ScheduleRuntimeApplication,
  ScheduleRuntimeEvent,
} from "@zhixing-ai/core/scheduler/application";
import type { SkillCatalogChangedFact } from "@zhixing-ai/core/skills/catalog";
import type { RpcNotificationConnection } from "./connection.js";

export interface EventBridgeDeps {
  /** 当前活跃的 RPC 连接集合 */
  connections: ReadonlySet<RpcNotificationConnection>;
  scheduleRuntimeEvents?: Pick<ScheduleRuntimeApplication, "onEvent">;
  /** 技能目录拥有者在确认提交后发出的结构变化（宿主级中继） */
  skillCatalogEvents?: {
    onChanged(listener: (fact: SkillCatalogChangedFact) => void): () => void;
  };
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
  if (deps.skillCatalogEvents) {
    disposers.push(wireSkillCatalogEvents(deps.skillCatalogEvents, deps.connections));
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

function wireSkillCatalogEvents(
  events: NonNullable<EventBridgeDeps["skillCatalogEvents"]>,
  connections: ReadonlySet<RpcNotificationConnection>,
): () => void {
  return events.onChanged((fact) => {
    for (const conn of connections) {
      if (!conn.authenticated || conn.closed) continue;
      // 单个连接的异常不能挡住其他连接；发送失败本身已由连接层吞掉并视为断开
      try {
        conn.notify("skill.changed", { structuralVersion: fact.catalogRevision });
      } catch {
        // 连接层之外的异常同样只影响这一个连接
      }
    }
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
