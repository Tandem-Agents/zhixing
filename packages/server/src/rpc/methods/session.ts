/**
 * session.* RPC 方法
 *
 * - session.send：发送用户消息，立即返回 sessionId，后台异步推送 delta/complete
 * - session.list：列出所有运行时元信息
 * - session.history：返回指定运行时的消息历史
 * - session.abort：中止指定运行时当前执行
 * - session.delete：删除运行时
 *
 * 推送事件：
 * - session.delta { sessionId, delta: AgentYield }
 * - session.complete { sessionId, result: AgentResult }
 */

import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { RpcConnection } from "../connection.js";
import type { ServerContext } from "../../context.js";
import type { SessionRuntime, RuntimeInfo } from "../../runtime/types.js";

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

      const runtimes = requireRuntimes(ctx.server);
      const runtime = await runtimes.getOrCreate(params.sessionId);

      // 标记 busy 并启动后台 runner
      runtimes.setBusy(runtime.sessionId, true);
      void runSessionTurn(runtime, params.text, ctx.connection, ctx.server);

      return { sessionId: runtime.sessionId };
    },
  };
}

/**
 * 后台 runner：消费 runtime.run 的 AsyncGenerator，推送事件到发起连接。
 * 永不抛出（错误已包装为 complete 事件）。
 */
async function runSessionTurn(
  runtime: SessionRuntime,
  text: string,
  connection: RpcConnection,
  server: ServerContext,
): Promise<void> {
  const sessionId = runtime.sessionId;
  const runtimes = server.sessions;

  try {
    const gen = runtime.run(text);
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        connection.notify("session.complete", { sessionId, result: value });
        return;
      }
      connection.notify("session.delta", { sessionId, delta: value });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    connection.notify("session.complete", {
      sessionId,
      result: {
        reason: "error",
        error: { name: "RuntimeError", message },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  } finally {
    runtimes?.setBusy(sessionId, false);
  }
}

// ─── session.list ───

export function buildSessionListMethod(): MethodEntry {
  return {
    name: "session.list",
    requiresAuth: true,
    handler(_params, ctx): RuntimeInfo[] {
      const runtimes = requireRuntimes(ctx.server);
      return runtimes.list();
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
      const runtimes = requireRuntimes(ctx.server);
      const runtime = runtimes.get(params.sessionId);
      if (!runtime) {
        throw RpcErrors.notFound(`Session not found: ${params.sessionId}`);
      }
      return runtime.getHistory(params.limit);
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
      const runtimes = requireRuntimes(ctx.server);
      if (!runtimes.abort(params.sessionId)) {
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
      const runtimes = requireRuntimes(ctx.server);
      if (!runtimes.delete(params.sessionId)) {
        throw RpcErrors.notFound(`Session not found: ${params.sessionId}`);
      }
    },
  };
}

// ─── 工具 ───

function requireRuntimes(server: ServerContext) {
  if (!server.sessions) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Runtime registry not configured on server",
    );
  }
  return server.sessions;
}
