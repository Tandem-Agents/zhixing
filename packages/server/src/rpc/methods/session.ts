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

import {
  abortWithReason,
  generateTurnId,
  type RunResult,
  type TurnContext,
} from "@zhixing/core";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { RpcConnection } from "../connection.js";
import type { ServerContext } from "../../context.js";
import type { ConversationManager, ManagedSession } from "../../runtime/conversation-manager.js";
import { runTurnWithCommit } from "../../runtime/run-turn.js";

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
      const text = params.text;

      const manager = requireConversations(ctx.server);
      const id = params.conversationId ?? params.sessionId;

      const managed = await manager.getOrCreate(id);
      const conversationId = managed.conversationId;
      const connectionId = String(ctx.connection.id);

      manager.addObserver(conversationId, connectionId);

      const status = manager.enqueue(conversationId, {
        execute: () => runManagedTurn(managed, text, ctx.connection, manager),
        cancel: () => {
          ctx.connection.notify("session.complete", {
            conversationId,
            sessionId: conversationId,
            result: {
              reason: "error",
              error: { name: "Cancelled", message: "Pending turn cancelled" },
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          });
        },
      });

      if (status === "full") {
        throw new RpcAppError(RPC_ERROR_CODES.BUSY, "Too many pending messages for this conversation");
      }

      if (status === "immediate") {
        manager.setBusy(conversationId, true);
        void runManagedTurn(managed, text, ctx.connection, manager);
      }
      // status === "queued": dequeueNext will call execute() when current turn completes

      return {
        conversationId,
        sessionId: conversationId,
      };
    },
  };
}

/**
 * 消费 runtime.run 的 AsyncGenerator，推送事件到发起连接。
 * 永不抛出（错误已包装为 complete 事件）。
 *
 * AbortSignal 生命周期：
 * - 创建 AbortController，连接断开时自动 abort
 * - signal 传入 runtime.run()，由 runtime 实现决定如何响应
 * - 中止的 turn 不推送 complete（连接已断），不持久化
 */
async function runManagedTurn(
  managed: ManagedSession,
  text: string,
  connection: RpcConnection,
  manager: ConversationManager,
): Promise<void> {
  const conversationId = managed.conversationId;
  const abortController = new AbortController();
  // typed reason 让 channel 渲染层能识别"是连接断了"(详见 abort-formatter-zh /
  // abort-serializer 对 external{ origin: rpc-connection-close } 的处理)
  const unsubClose = connection.onClose(() =>
    abortWithReason(abortController, {
      kind: "external",
      origin: "rpc-connection-close",
    }),
  );
  const turnStartedAt = new Date().toISOString();

  try {
    // 远程确认回程地址（remote-confirmation-execution.md §3.3）：
    //   RPC 入口（Web UI / IDE）触发的 turn——无通道 target，仅走 RPC Bridge 定向推送。
    //   Bridge 用 triggeredBy=connectionId 过滤，只推给发起连接 + 同会话 observer。
    const turnContext: TurnContext = {
      turnId: generateTurnId(),
      turnOrigin: {
        channel: "rpc",
        triggeredBy: String(connection.id),
      },
    };
    // 走 runTurnWithCommit helper —— run + 按结果 recordTurn（先持久化、后入窗）：
    //   · non-completed / 持久化 throw / runtime throw 三条异常路径下窗口都
    //     停在 run 前基底，避免 orphan userMsg 污染下一轮 LLM 输入
    //   · 持久化失败通过 onCommitFailure hook 通知（此处暂未接 logger；
    //     未来需要 observability 时在 hook 里补 logger.warn / metrics）
    const gen = runTurnWithCommit(
      manager,
      conversationId,
      text,
      {
        abortSignal: abortController.signal,
        turnContext,
        turnIndex: managed.turnCount,
        source: "channel",
      },
    );
    let runResult: RunResult | undefined;

    while (true) {
      const iter = await gen.next();
      if (iter.done) {
        runResult = iter.value;
        // session.complete 事件的契约保持 AgentResult（向后兼容）—— 客户端
        // 只关心终止原因 + usage + error，不需要 runRecord/windowCompact（那是持久化事项）
        connection.notify("session.complete", {
          conversationId,
          sessionId: conversationId,
          result: runResult.agentResult,
        });
        break;
      }
      connection.notify("session.delta", { conversationId, sessionId: conversationId, delta: iter.value });
    }

    // turnStartedAt 不用作 run record 的 timestamp（buildRunRecord 已精确设定）——
    // 保留变量避免未来诊断字段需要 turn 入口时间时重新加逻辑。
    void turnStartedAt;
  } catch (err) {
    if (abortController.signal.aborted) return;
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
    unsubClose();
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
      const result = manager.abort(id, {
        kind: "user-cancel",
        source: "rpc",
        pressedAt: Date.now(),
      });
      // RPC client 视角:in-flight 和 pending 都没动 = 没有可取消的对象 → notFound。
      // 任一维度动了 = 取消生效;细分计数 client 当前不消费(IDE 同步场景 pending 通常为 0),
      // 不暴露在 RPC schema 中,留作后续若需要时扩。
      if (!result.abortedInFlight && result.cancelledPending === 0) {
        throw RpcErrors.notFound(
          `Session not found or no in-flight turn / pending message: ${id}`,
        );
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
    async handler(rawParams, ctx): Promise<void> {
      const params = (rawParams ?? {}) as SessionDeleteParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams("session.delete requires 'conversationId'");
      }
      const manager = requireConversations(ctx.server);
      if (!(await manager.delete(id))) {
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
