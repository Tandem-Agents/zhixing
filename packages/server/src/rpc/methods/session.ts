/**
 * session.* RPC 方法
 *
 * - session.send：发送用户消息，立即返回 conversationId，后台异步推送 delta/complete
 * - session.list：列出所有活跃运行时元信息
 * - session.history：返回指定运行时的消息历史
 * - session.abort：中止指定运行时当前执行
 * - session.delete：删除运行时
 *
 * 推送事件：
 * - session.delta { conversationId, delta: AgentYield }
 * - session.complete { conversationId, result: AgentResult }
 */

import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { RpcConnection } from "../connection.js";
import type { ServerContext } from "../../context.js";
import type { ConversationManager, ManagedSession } from "../../runtime/conversation-manager.js";

// ─── session.send ───

interface SessionSendParams {
  text?: string;
  conversationId?: string;
  /** @deprecated 使用 conversationId */
  sessionId?: string;
}

interface SessionSendResult {
  conversationId: string;
  /** @deprecated 使用 conversationId */
  sessionId: string;
}

export function buildSessionSendMethod(): MethodEntry {
  return {
    name: "session.send",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionSendResult> {
      const params = (rawParams ?? {}) as SessionSendParams;
      if (typeof params.text !== "string" || params.text.length === 0) {
        throw RpcErrors.invalidParams("session.send requires non-empty 'text'");
      }

      const manager = requireConversations(ctx.server);
      const id = params.conversationId ?? params.sessionId;

      const managed = await manager.getOrCreate(id);
      const connectionId = String(ctx.connection.id);

      manager.addObserver(managed.conversationId, connectionId);
      manager.setBusy(managed.conversationId, true);

      void runManagedTurn(managed, params.text, ctx.connection, manager);

      return {
        conversationId: managed.conversationId,
        sessionId: managed.conversationId,
      };
    },
  };
}

/**
 * 消费 runtime.run 的 AsyncGenerator，推送事件到发起连接。
 * 永不抛出（错误已包装为 complete 事件）。
 */
async function runManagedTurn(
  managed: ManagedSession,
  text: string,
  connection: RpcConnection,
  manager: ConversationManager,
): Promise<void> {
  const conversationId = managed.conversationId;

  try {
    const gen = managed.runtime.run(text);
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        connection.notify("session.complete", { conversationId, sessionId: conversationId, result: value });
        return;
      }
      connection.notify("session.delta", { conversationId, sessionId: conversationId, delta: value });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    connection.notify("session.complete", {
      conversationId,
      sessionId: conversationId,
      result: {
        reason: "error",
        error: { name: "RuntimeError", message },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  } finally {
    manager.setBusy(conversationId, false);
    if (connection.closed) {
      manager.removeObserver(conversationId, String(connection.id));
    }
  }
}

// ─── session.list ───

export function buildSessionListMethod(): MethodEntry {
  return {
    name: "session.list",
    requiresAuth: true,
    handler(_params, ctx) {
      const manager = requireConversations(ctx.server);
      return manager.list();
    },
  };
}

// ─── session.history ───

interface SessionHistoryParams {
  conversationId?: string;
  /** @deprecated */
  sessionId?: string;
  limit?: number;
}

export function buildSessionHistoryMethod(): MethodEntry {
  return {
    name: "session.history",
    requiresAuth: true,
    handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as SessionHistoryParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams("session.history requires 'conversationId'");
      }
      const manager = requireConversations(ctx.server);
      const runtime = manager.get(id);
      if (!runtime) {
        throw RpcErrors.notFound(`Session not found: ${id}`);
      }
      return runtime.getHistory(params.limit);
    },
  };
}

// ─── session.abort ───

interface SessionAbortParams {
  conversationId?: string;
  /** @deprecated */
  sessionId?: string;
}

export function buildSessionAbortMethod(): MethodEntry {
  return {
    name: "session.abort",
    requiresAuth: true,
    handler(rawParams, ctx): void {
      const params = (rawParams ?? {}) as SessionAbortParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams("session.abort requires 'conversationId'");
      }
      const manager = requireConversations(ctx.server);
      if (!manager.abort(id)) {
        throw RpcErrors.notFound(`Session not found: ${id}`);
      }
    },
  };
}

// ─── session.delete ───

interface SessionDeleteParams {
  conversationId?: string;
  /** @deprecated */
  sessionId?: string;
}

export function buildSessionDeleteMethod(): MethodEntry {
  return {
    name: "session.delete",
    requiresAuth: true,
    handler(rawParams, ctx): void {
      const params = (rawParams ?? {}) as SessionDeleteParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams("session.delete requires 'conversationId'");
      }
      const manager = requireConversations(ctx.server);
      if (!manager.delete(id)) {
        throw RpcErrors.notFound(`Session not found: ${id}`);
      }
    },
  };
}

// ─── 工具 ───

function requireConversations(server: ServerContext): ConversationManager {
  if (!server.conversations) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "ConversationManager not configured on server",
    );
  }
  return server.conversations;
}
