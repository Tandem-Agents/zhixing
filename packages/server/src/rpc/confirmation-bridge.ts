/**
 * ConfirmationBridge —— ConfirmationHub 事件 → RPC notification 单一出口
 *
 * 定位（[remote-confirmation-execution.md §3.9]）：
 *   订阅 hub.onEvent → 按 conversation observer 过滤 → 推给 RPC 连接。
 *   **同时处理 request 和 resolved 两个事件**——分层职责：
 *     - TextConfirmationRenderer：处理 request → 发通道消息，不感知 RPC
 *     - ConfirmationBridge：推 RPC 通知，不感知通道
 *   这种职责分离避免"Renderer + Bridge 同时订阅 resolved 导致重复推送"的歧义。
 *
 * 推送粒度（observer-scoped）：
 *   - 有 conversationId：按 `ConversationManager.getObserverConnectionIds` 定向
 *     推给当前 observer 连接。隐私安全：多客户端共享 server 时，B 的观察不会
 *     看到 A 的 confirmation 请求细节。
 *   - 无 conversationId（scheduler ephemeral 兜底）：admin-scoped——MVP 先广播给
 *     所有 authenticated 连接；多租户时应加 role 过滤。
 *
 * 推送 schema（参见 spec §3.9）：
 *   - `confirmation.pending`：新 pending 到达 → tool / operationDetail / riskLevel / stewardReason / expiresAt / turnOrigin
 *   - `confirmation.resolved`：请求被解决 → requestId / decision.kind / resolvedAt（**不暴露** reason / note）
 */

import type { DisplayBody } from "@zhixing/core";
import type { ConfirmationHub, HubEntry, HubEvent } from "../confirmation/hub.js";
import type { ConversationManager } from "../runtime/conversation-manager.js";
import type { RpcConnection } from "./connection.js";

/** 确认域推送通知的方法名——发射端(本 Bridge)与接入面订阅端共用 */
export const CONFIRMATION_NOTIFICATIONS = {
  pending: "confirmation.pending",
  resolved: "confirmation.resolved",
} as const;

export interface ConfirmationBridgeDeps {
  /** 当前活跃的 RPC 连接集合（server.ts 内部维护，通过 ZhixingServerInstance.connections 暴露） */
  connections: ReadonlySet<RpcConnection>;
  /** 确认聚合层——订阅其事件 */
  hub: ConfirmationHub;
  /** 会话管理器——按 conversationId 反查 observer connectionIds */
  conversations: ConversationManager;
}

export interface ConfirmationBridge {
  /** 取消订阅（Server 关闭时调用） */
  dispose(): void;
}

/**
 * 创建 Bridge 并立即订阅 hub 事件。
 */
export function createConfirmationBridge(
  deps: ConfirmationBridgeDeps,
): ConfirmationBridge {
  const { connections, hub, conversations } = deps;

  /** 推送到指定连接集合（过滤未认证 / 已关闭连接） */
  const notifyTargets = (
    targets: Iterable<RpcConnection>,
    method: string,
    params: unknown,
  ): void => {
    for (const conn of targets) {
      if (conn.authenticated && !conn.closed) {
        conn.notify(method, params);
      }
    }
  };

  /** 按 conversationId 解析推送目标（observer-scoped 或 admin-scoped 兜底） */
  const resolveTargets = (conversationId?: string): RpcConnection[] => {
    if (conversationId) {
      const observerIds = conversations.getObserverConnectionIds(conversationId);
      return [...connections].filter(
        (c) => c.authenticated && !c.closed && observerIds.has(String(c.id)),
      );
    }
    // 无 conversationId（scheduler ephemeral 兜底）→ admin-scoped
    // MVP：广播到所有 authenticated；多租户时加 role 过滤
    return [...connections].filter((c) => c.authenticated && !c.closed);
  };

  const unsubHub = hub.onEvent((event: HubEvent) => {
    if (event.type === "request") {
      const targets = resolveTargets(event.entry.conversationId);
      const base = buildPendingPayload(event.entry);
      // 摘要按 observer 推送；完整 request 是可操作控制面 payload，只给
      // 发起本 turn 的可信 RPC 连接。该边界与 confirmation.resolve 的应答权
      // 同源，避免旁观本机 observer 收到可点击面板却无权应答。
      for (const conn of targets) {
        if (!conn.authenticated || conn.closed) continue;
        const payload = canReceiveFullRequest(event.entry, conn)
          ? { ...base, request: event.entry.request }
          : base;
        conn.notify(CONFIRMATION_NOTIFICATIONS.pending, payload);
      }
    } else {
      const targets = resolveTargets(event.conversationId);
      notifyTargets(targets, CONFIRMATION_NOTIFICATIONS.resolved, {
        requestId: event.requestId,
        conversationId: event.conversationId,
        decision: event.decision.kind, // 不暴露 reason / note
        resolvedAt: Date.now(),
      });
    }
  });

  return {
    dispose() {
      unsubHub();
    },
  };
}

// ─── 内部工具 ───

function canReceiveFullRequest(entry: HubEntry, conn: RpcConnection): boolean {
  const origin = entry.request.turnOrigin;
  return (
    conn.authenticated &&
    !conn.closed &&
    conn.loopback === true &&
    origin?.channel === "rpc" &&
    origin.triggeredBy === String(conn.id)
  );
}

function buildPendingPayload(entry: HubEntry): {
  requestId: string;
  conversationId?: string;
  tool: string;
  operationSummary: string;
  operationDetail: string;
  riskLevel?: string;
  stewardReason?: string;
  expiresAt: number;
  turnOrigin?: unknown;
} {
  const req = entry.request;
  return {
    requestId: req.id,
    conversationId: entry.conversationId,
    tool: req.tool,
    operationSummary: req.display.title,
    operationDetail: flattenDisplayBody(req.display.body),
    riskLevel: req.decision?.riskLevel,
    // 安全管家研判理由——与本地/远程文本渲染同源（display.stewardReason），让 RPC 客户端也能展示
    stewardReason: req.display.stewardReason,
    expiresAt: req.expiresAt,
    turnOrigin: req.turnOrigin,
  };
}

function flattenDisplayBody(body: DisplayBody): string {
  switch (body.kind) {
    case "bash":
      return body.commandPreview;
    case "file-write":
      return body.path + (body.preview ? ` — ${body.preview.slice(0, 100)}` : "");
    case "file-edit":
      return body.path;
    case "file-read":
      return body.path;
    case "network":
      return `${body.direction === "outbound" ? "→" : "←"} ${body.host}`;
    case "messaging":
      return `${body.recipient}: ${body.content.slice(0, 100)}`;
    case "calendar":
      return `${body.title} (${body.invitees.length})`;
    case "generic":
      return body.summary;
  }
}
