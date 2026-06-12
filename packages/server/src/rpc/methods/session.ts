/**
 * session.* RPC 方法
 *
 * - session.send：发送用户消息，立即返回 conversationId，后台异步推送 delta/complete
 * - session.list：列出所有活跃运行时元信息
 * - session.history：返回指定运行时的消息历史
 * - session.abort：中止指定运行时当前执行
 * - session.list：盘上全量对话清单叠加活跃态(/resume 候选源)
 * - session.history：倒读落盘事实流(分页,不要求会话活跃)
 * - session.rename：对话改名(组播 changed)
 * - session.delete：活跃运行时释放 + 落盘数据删除
 * - session.subscribe / unsubscribe：observer 登记(订阅即进组播名册)
 *
 * 推送事件(经 observer 名册组播,见 session-broadcast)：
 * - session.delta { conversationId, delta: AgentYield } —— 主通道(turn 产出流)
 * - session.complete { conversationId, result: AgentResult }
 * - session.event { ...SessionEventEnvelope } —— 带外通道(见 session-events)
 * - session.changed { conversationId, change } —— 会话级变更(run 外发生)
 *
 * 定向推送(仅发起连接,不组播)：
 * - session.modeSwitchIntent { conversationId, intent } —— 可执行控制意图,
 *   跟随权归发起接入面由结构保证(旁观端物理不可达)
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
import type { SessionBroadcast } from "../session-broadcast.js";
import type { ConversationDirectory } from "../../runtime/conversation-directory.js";
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

      const broadcast = ctx.server.sessionBroadcast;
      const status = manager.enqueue(conversationId, {
        execute: () =>
          runManagedTurn(managed, text, ctx.connection, manager, broadcast),
        // 取消通知是排队发起者的私人回执,不组播——其他端没见过这条排队项
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
        void runManagedTurn(managed, text, ctx.connection, manager, broadcast);
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
 * 消费 runtime.run 的 AsyncGenerator，推送事件给会话的全部 observer。
 * 永不抛出（错误已包装为 complete 事件）。
 *
 * 推送形态:有组播(broadcast,startServer 回填)时 delta / complete 发给
 * observer 名册全员——多端同看一个流式 turn;未回填(最小测试 ctx)退化为
 * 发起连接单播。发起连接必在名册内(send 入口已 addObserver)。
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
  broadcast?: SessionBroadcast,
): Promise<void> {
  const conversationId = managed.conversationId;
  const push = (method: string, params: unknown): void => {
    if (broadcast) broadcast(conversationId, method, params);
    else connection.notify(method, params);
  };
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
        // 模式切换意图是可执行的控制字段,只定向发起连接——跟随权归发起
        // 接入面由结构保证(旁观端物理收不到),不靠客户端自律。先于 complete
        // 发送(同连接有序):客户端收意图暂存,收 complete(turn 落定)即消费,
        // 与 REPL 的 turn 边界消费语义对齐。
        if (runResult.pendingModeSwitch) {
          connection.notify("session.modeSwitchIntent", {
            conversationId,
            intent: runResult.pendingModeSwitch,
          });
        }
        // session.complete 的 result 保持 AgentResult 契约（终止原因 + usage +
        // error，不带 runRecord/windowCompact——那是持久化事项）,纯结果可组播。
        push("session.complete", {
          conversationId,
          sessionId: conversationId,
          result: runResult.agentResult,
        });
        break;
      }
      push("session.delta", { conversationId, sessionId: conversationId, delta: iter.value });
    }

    // turnStartedAt 不用作 run record 的 timestamp（buildRunRecord 已精确设定）——
    // 保留变量避免未来诊断字段需要 turn 入口时间时重新加逻辑。
    void turnStartedAt;
  } catch (err) {
    if (abortController.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    push("session.complete", {
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

/**
 * 对话列表 = 盘上全量(可恢复的事实)叠加活跃态。纯内存 ephemeral 会话不在
 * 列表内——没落盘即无可恢复,与 /resume 候选语义一致。
 */
export function buildSessionListMethod(): MethodEntry {
  return {
    name: "session.list",
    requiresAuth: true,
    async handler(_params, ctx) {
      const manager = requireConversations(ctx.server);
      const directory = requireDirectory(ctx.server);
      const conversations = await directory.list();
      return {
        conversations: conversations.map((c) => {
          const active = manager.getSession(c.id);
          return {
            conversationId: c.id,
            name: c.name,
            createdAt: c.createdAt,
            lastActiveAt: active?.lastActiveAt ?? c.lastActiveAt,
            active: !!active,
            busy: active?.busy ?? false,
            observerCount: active?.observers.size ?? 0,
            pendingCount: manager.pendingCount(c.id),
          };
        }),
      };
    },
  };
}

// ─── session.history ───

interface SessionHistoryParams {
  conversationId?: string;
  /** @deprecated */
  sessionId?: string;
  /** 单页 run 数上限,默认 20 */
  limit?: number;
  /** 倒读分页游标——续读上一页末条之前的内容 */
  before?: { shardId: string; runIndex: number };
}

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 200;

/**
 * 倒读落盘事实流(新→旧分页),不要求会话活跃——历史是持久层投影,
 * 注意力窗口(LLM 视图)不经此暴露。
 */
export function buildSessionHistoryMethod(): MethodEntry {
  return {
    name: "session.history",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as SessionHistoryParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams("session.history requires 'conversationId'");
      }
      // limit / before 严格校验——坏 limit(字符串 / 非正数)会让分页判定
      // 失真甚至退化为无界读取;接入面统一后 RPC 契约必须 fail-fast。
      if (params.limit !== undefined) {
        if (
          typeof params.limit !== "number" ||
          !Number.isInteger(params.limit) ||
          params.limit < 1
        ) {
          throw RpcErrors.invalidParams(
            "session.history 'limit' must be a positive integer",
          );
        }
      }
      if (params.before !== undefined) {
        if (
          typeof params.before !== "object" ||
          params.before === null ||
          typeof params.before.shardId !== "string" ||
          typeof params.before.runIndex !== "number"
        ) {
          throw RpcErrors.invalidParams(
            "session.history 'before' must be { shardId: string, runIndex: number }",
          );
        }
      }
      const directory = requireDirectory(ctx.server);
      return directory.readRunsReverse(id, {
        limit: Math.min(params.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
        before: params.before,
      });
    },
  };
}

// ─── session.rename ───

interface SessionRenameParams {
  conversationId?: string;
  name?: string;
}

export function buildSessionRenameMethod(): MethodEntry {
  return {
    name: "session.rename",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as SessionRenameParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams("session.rename requires 'conversationId'");
      }
      if (typeof params.name !== "string" || params.name.trim().length === 0) {
        throw RpcErrors.invalidParams("session.rename requires non-empty 'name'");
      }
      const directory = requireDirectory(ctx.server);
      const renamed = await directory.rename(
        params.conversationId,
        params.name.trim(),
      );
      if (!renamed) {
        throw RpcErrors.notFound(`Session not found: ${params.conversationId}`);
      }
      // 会话级变更组播——活跃会话的在场 observer 据此刷新标题;不活跃对话
      // 名册为空、通知自然无人收(列表视图的跨端刷新策略归接入面接入时定)
      ctx.server.sessionBroadcast?.(params.conversationId, "session.changed", {
        conversationId: params.conversationId,
        change: "renamed",
        name: renamed.name,
      });
      // 返回入参全域键——目录契约返回库内身份(场景对话是 localId),
      // 全域键(ws: 前缀)由 RPC 层保持,断键即断静态归属路由
      return { conversationId: params.conversationId, name: renamed.name };
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
      const directory = ctx.server.conversationDirectory;
      // 会话级变更通知:删除发生在 run 外,双通道(以 run 为边界)覆盖不到——
      // 旁观端无此信号会盯着已删对话继续操作。删除前组播(名册删除后即空)。
      ctx.server.sessionBroadcast?.(id, "session.changed", {
        conversationId: id,
        change: "deleted",
      });
      // 删除 = 活跃运行时释放 + 落盘数据删除;任一存在即为有效删除
      const releasedActive = await manager.delete(id);
      const removedDisk = (await directory?.remove(id)) ?? false;
      if (!releasedActive && !removedDisk) {
        throw RpcErrors.notFound(`Session not found: ${id}`);
      }
    },
  };
}

// ─── session.subscribe / unsubscribe ───

interface SessionSubscribeParams {
  conversationId?: string;
}

/**
 * 订阅即 observer 登记——同一名册承担 grace 管理与事件分发(delta / complete /
 * session.event / session.changed 全部按名册组播)。中途加入不回放:订阅起只收
 * 后续增量,turn 完成后经落盘事实流补全视图。
 */
export function buildSessionSubscribeMethod(): MethodEntry {
  return {
    name: "session.subscribe",
    requiresAuth: true,
    handler(rawParams, ctx): { subscribed: boolean } {
      const params = (rawParams ?? {}) as SessionSubscribeParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams(
          "session.subscribe requires 'conversationId'",
        );
      }
      const manager = requireConversations(ctx.server);
      // 仅对活跃会话登记(false = 会话不在场);激活会话走 send / resume 路径
      const subscribed = manager.addObserver(
        params.conversationId,
        String(ctx.connection.id),
      );
      return { subscribed };
    },
  };
}

export function buildSessionUnsubscribeMethod(): MethodEntry {
  return {
    name: "session.unsubscribe",
    requiresAuth: true,
    handler(rawParams, ctx): { unsubscribed: boolean } {
      const params = (rawParams ?? {}) as SessionSubscribeParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams(
          "session.unsubscribe requires 'conversationId'",
        );
      }
      const manager = requireConversations(ctx.server);
      manager.removeObserver(params.conversationId, String(ctx.connection.id));
      return { unsubscribed: true };
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

function requireDirectory(server: ServerContext): ConversationDirectory {
  if (!server.conversationDirectory) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "ConversationDirectory not configured on server",
    );
  }
  return server.conversationDirectory;
}
