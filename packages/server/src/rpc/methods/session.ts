/**
 * session.* RPC 方法
 *
 * - session.send：发送用户消息，立即返回 sessionId，后台异步推送 delta/complete
 * - session.list：列出所有会话元信息
 * - session.history：返回指定会话的消息历史
 * - session.abort：中止指定会话当前执行
 * - session.delete：删除会话
 *
 * 推送事件（参见 server-gateway.md §5.4）：
 * - session.delta { sessionId, delta: AgentYield }
 * - session.complete { sessionId, result: AgentResult }
 *
 * 设计要点：
 * - session.send 立即响应（非阻塞），LLM 调用在 background runner 里
 * - 事件只推给发起 session.send 的连接（多通道订阅是 S5）
 * - 连接断开 → notify 静默失败 → runner 继续完成（保留服务端状态）
 * - sessions registry 缺失时返回 INTERNAL_ERROR（配置错误，不该发生）
 */

import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { RpcConnection } from "../connection.js";
import type { ServerContext } from "../../context.js";
import type { ServerSession, SessionInfo } from "../../session/types.js";

// ─── session.send ───

interface SessionSendParams {
  text?: string;
  sessionId?: string;
}

interface SessionSendResult {
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

      const sessions = requireSessions(ctx.server);
      const session = await sessions.getOrCreate(params.sessionId);

      // 标记 busy 并启动后台 runner
      sessions.setBusy(session.sessionId, true);
      void runSessionTurn(session, params.text, ctx.connection, ctx.server);

      return { sessionId: session.sessionId };
    },
  };
}

/**
 * 后台 runner：消费 session.run 的 AsyncGenerator，推送事件到发起连接。
 * 永不抛出（错误已包装为 complete 事件）。
 */
async function runSessionTurn(
  session: ServerSession,
  text: string,
  connection: RpcConnection,
  server: ServerContext,
): Promise<void> {
  const sessionId = session.sessionId;
  const sessions = server.sessions;

  try {
    const gen = session.run(text);
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        connection.notify("session.complete", { sessionId, result: value });
        return;
      }
      connection.notify("session.delta", { sessionId, delta: value });
    }
  } catch (err) {
    // 把异常包装为 complete + error 状态推回（比留 dangling 更好）
    const message = err instanceof Error ? err.message : String(err);
    connection.notify("session.complete", {
      sessionId,
      result: {
        reason: "error",
        error: { name: "ServerSessionError", message },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  } finally {
    sessions?.setBusy(sessionId, false);
  }
}

// ─── session.list ───

export function buildSessionListMethod(): MethodEntry {
  return {
    name: "session.list",
    requiresAuth: true,
    handler(_params, ctx): SessionInfo[] {
      const sessions = requireSessions(ctx.server);
      return sessions.list();
    },
  };
}

// ─── session.history ───

interface SessionHistoryParams {
  sessionId?: string;
  limit?: number;
}

export function buildSessionHistoryMethod(): MethodEntry {
  return {
    name: "session.history",
    requiresAuth: true,
    handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as SessionHistoryParams;
      if (typeof params.sessionId !== "string") {
        throw RpcErrors.invalidParams("session.history requires 'sessionId'");
      }
      const sessions = requireSessions(ctx.server);
      const session = sessions.get(params.sessionId);
      if (!session) {
        throw RpcErrors.notFound(`Session not found: ${params.sessionId}`);
      }
      return session.getHistory(params.limit);
    },
  };
}

// ─── session.abort ───

interface SessionAbortParams {
  sessionId?: string;
}

export function buildSessionAbortMethod(): MethodEntry {
  return {
    name: "session.abort",
    requiresAuth: true,
    handler(rawParams, ctx): void {
      const params = (rawParams ?? {}) as SessionAbortParams;
      if (typeof params.sessionId !== "string") {
        throw RpcErrors.invalidParams("session.abort requires 'sessionId'");
      }
      const sessions = requireSessions(ctx.server);
      if (!sessions.abort(params.sessionId)) {
        throw RpcErrors.notFound(`Session not found: ${params.sessionId}`);
      }
    },
  };
}

// ─── session.delete ───

interface SessionDeleteParams {
  sessionId?: string;
}

export function buildSessionDeleteMethod(): MethodEntry {
  return {
    name: "session.delete",
    requiresAuth: true,
    handler(rawParams, ctx): void {
      const params = (rawParams ?? {}) as SessionDeleteParams;
      if (typeof params.sessionId !== "string") {
        throw RpcErrors.invalidParams("session.delete requires 'sessionId'");
      }
      const sessions = requireSessions(ctx.server);
      if (!sessions.delete(params.sessionId)) {
        throw RpcErrors.notFound(`Session not found: ${params.sessionId}`);
      }
    },
  };
}

// ─── 工具 ───

function requireSessions(server: ServerContext) {
  if (!server.sessions) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Session registry not configured on server",
    );
  }
  return server.sessions;
}
