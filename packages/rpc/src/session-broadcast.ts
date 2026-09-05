/**
 * 会话域组播 —— 把通知发给一个会话的全部 observer 连接。
 *
 * observer 名册由会话 owner 投影,grace 管理与事件分发共用同一名册。
 * 即推送目标:多接入面同看一个对话时,流式 turn(delta / complete)、带外
 * 事件(session.event)与会话级变更(session.changed)对全部在场端一致投影。
 * 确认请求不经此组播——确认按发起接入面定向(Bridge 的 triggeredBy 过滤)。
 */

import type { RpcNotificationConnection } from "./connection.js";
import {
  SESSION_NOTIFICATIONS,
  type SessionActivityPayload,
} from "./session-wire.js";

/** 组播一条通知给会话的全部 observer 连接 */
export type SessionBroadcast = (
  conversationId: string,
  method: string,
  params: unknown,
) => void;

/** 工作台类接入面的非当前会话活动提示组播。 */
export type SessionActivityBroadcast = (
  payload: SessionActivityPayload,
) => void;

/**
 * The finite broadcast transport owned by one prepared Server generation.
 *
 * Consumers must not manufacture this shape from callbacks: the factory below
 * binds both functions to the same connection set and observer directory, and
 * the Host lifecycle verifies that provenance before activation.
 */
export interface SessionBroadcastTransport {
  readonly session: SessionBroadcast;
  readonly activity: SessionActivityBroadcast;
}

const SESSION_BROADCAST_TRANSPORTS = new WeakSet<object>();

export function createSessionBroadcastTransport(deps: {
  connections: ReadonlySet<RpcNotificationConnection>;
  observerConnectionIds(conversationId: string): ReadonlySet<string>;
}): SessionBroadcastTransport {
  const transport = Object.freeze({
    session: createObserverBroadcast(deps),
    activity: createActivityBroadcast(deps),
  });
  SESSION_BROADCAST_TRANSPORTS.add(transport);
  return transport;
}

export function assertSessionBroadcastTransport(
  value: unknown,
): asserts value is SessionBroadcastTransport {
  if (
    typeof value !== "object" ||
    value === null ||
    !SESSION_BROADCAST_TRANSPORTS.has(value)
  ) {
    throw new TypeError("Session broadcast transport has no Server provenance");
  }
}

export function createObserverBroadcast(deps: {
  connections: ReadonlySet<RpcNotificationConnection>;
  observerConnectionIds(conversationId: string): ReadonlySet<string>;
}): SessionBroadcast {
  return (conversationId, method, params) => {
    const observerIds = deps.observerConnectionIds(conversationId);
    if (observerIds.size === 0) return;
    for (const conn of deps.connections) {
      if (
        conn.authenticated &&
        !conn.closed &&
        observerIds.has(String(conn.id))
      ) {
        conn.notify(method, params);
      }
    }
  };
}

export function createActivityBroadcast(deps: {
  connections: ReadonlySet<RpcNotificationConnection>;
  observerConnectionIds(conversationId: string): ReadonlySet<string>;
}): SessionActivityBroadcast {
  return (payload) => {
    const currentObservers = deps.observerConnectionIds(
      payload.conversationId,
    );
    for (const conn of deps.connections) {
      if (!conn.authenticated || conn.closed) continue;
      if (currentObservers.has(String(conn.id))) continue;
      conn.notify(SESSION_NOTIFICATIONS.activity, payload);
    }
  };
}
