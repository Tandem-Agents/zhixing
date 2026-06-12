/**
 * 会话域组播 —— 把通知发给一个会话的全部 observer 连接。
 *
 * observer 名册(ConversationManager 维护,grace 管理与事件分发共用同一名册)
 * 即推送目标:多接入面同看一个对话时,流式 turn(delta / complete)、带外
 * 事件(session.event)与会话级变更(session.changed)对全部在场端一致投影。
 * 确认请求不经此组播——确认按发起接入面定向(Bridge 的 triggeredBy 过滤)。
 */

import type { RpcConnection } from "./connection.js";
import type { ConversationManager } from "../runtime/conversation-manager.js";

/** 组播一条通知给会话的全部 observer 连接 */
export type SessionBroadcast = (
  conversationId: string,
  method: string,
  params: unknown,
) => void;

export function createObserverBroadcast(deps: {
  connections: ReadonlySet<RpcConnection>;
  manager: ConversationManager;
}): SessionBroadcast {
  return (conversationId, method, params) => {
    const observerIds = deps.manager.getObserverConnectionIds(conversationId);
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
