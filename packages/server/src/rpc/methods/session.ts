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
 * - session.delta { conversationId, turnId, delta: AgentYield } —— 主通道(turn 产出流)
 * - session.complete { conversationId, turnId, result: AgentResult }
 * - session.event { ...SessionEventEnvelope } —— 带外通道(见 session-events)
 * - session.changed { conversationId, change } —— 会话级变更(run 外发生)
 *
 * 定向推送(仅发起连接,不组播)：
 * - session.modeSwitchIntent { conversationId, turnId, intent } —— 可执行控制意图,
 *   跟随权归发起接入面由结构保证(旁观端物理不可达)
 */

import {
  abortWithReason,
  generateTurnId,
  isNonEmptyUserTurnInput,
  type RubricContractDraftSnapshot,
  type TurnContext,
  type UserTurnInput,
  userTurnInputFromText,
} from "@zhixing/core";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { RpcConnection } from "../connection.js";
import type { ServerContext } from "../../context.js";
import type { SessionBroadcast } from "../session-broadcast.js";
import type { ConversationDirectory } from "../../runtime/conversation-directory.js";
import { projectSessionTurn } from "../session-turn-stream.js";
import {
  SESSION_NOTIFICATIONS,
  type SessionChangedPayload,
  type SessionClearResult,
  type SessionCompactResult,
  type SessionContextBudgetResult,
  type SessionCompletePayload,
  type SessionAdvancementCancelResult,
  type SessionAdvancementConfirmResult,
  type SessionConversationEntry,
  type SessionAwaitingRubricResult,
  type SessionContractFailedResult,
  type SessionListResult,
  type SessionModeSwitchIntentPayload,
  type SessionNewResult,
  type SessionRenameResult,
  type SessionResumeResult,
  type SessionSendResult,
  type SessionSecurityResult,
  type SessionUsageResult,
  type SessionSubscribeResult,
  type SessionTaskListAction,
  type SessionTaskListResult,
  type SessionTaskListUpdateResult,
  type SessionUnsubscribeResult,
} from "../session-wire.js";
import type { SessionEventEnvelope } from "../session-events.js";
import type { AdvancementPrepareResult } from "../../advancement/index.js";
import {
  generateConversationId,
  type ConversationManager,
  type ManagedSession,
} from "../../runtime/conversation-manager.js";
// ─── session.send ───

interface SessionSendParams extends ConversationIdParams {
  text?: unknown;
  input?: unknown;
  /** 发起端可预分配 turnId,用于避免 loopback 下 complete 先于 send 响应的竞态 */
  turnId?: unknown;
}

export function buildSessionSendMethod(): MethodEntry {
  return {
    name: "session.send",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionSendResult> {
      const params = (rawParams ?? {}) as SessionSendParams;
      const input = normalizeSessionInput(params);
      if (!input) {
        throw RpcErrors.invalidParams(
          "session.send requires non-empty 'text' or 'input'",
        );
      }

      const manager = requireConversations(ctx.server);
      const id = optionalConversationId(params, "session.send");
      const turnId =
        params.turnId !== undefined
          ? validateTurnId(params.turnId)
          : generateTurnId();
      const connectionId = String(ctx.connection.id);
      const broadcast = ctx.server.sessionBroadcast;
      const advancement = ctx.server.advancement;

      if (advancement) {
        const preparedId = id ?? generateConversationId();
        const prepared = await prepareAdvancementUserTurn({
          manager,
          server: ctx.server,
          advancement,
          conversationId: id,
          preparedConversationId: preparedId,
          turnId,
          input,
        });

        if (prepared.kind === "owner-busy") {
          return await sendDirectTurn({
            manager,
            conversationId: id,
            preallocatedConversationId: id ? undefined : preparedId,
            input,
            turnId,
            connectionId,
            connection: ctx.connection,
            broadcast,
            server: ctx.server,
          });
        }

        if (prepared.kind === "awaiting-rubric-confirmation") {
          manager.addObserver(prepared.session.conversationId, connectionId, {
            allowInactive: true,
          });
          notifyAdvancementEvent({
            conversationId: prepared.session.conversationId,
            turnId,
            seq: 0,
            event: "advancement:contract_draft",
            payload: {
              advancementSessionId: prepared.session.id,
              rubricDraftId: prepared.draft.draftId,
              rubricDraft: prepared.draft,
              admission: prepared.admission,
            },
            connection: ctx.connection,
            broadcast,
          });
          return awaitingRubricResult(
            prepared.session.conversationId,
            turnId,
            prepared.session.id,
            prepared.draft,
          );
        }

        if (prepared.kind === "contract-failed") {
          manager.addObserver(prepared.conversationId, connectionId, {
            allowInactive: true,
          });
          notifyAdvancementEvent({
            conversationId: prepared.conversationId,
            turnId: prepared.originalTurnId,
            seq: 0,
            event: "advancement:contract_failed",
            payload: {
              originalTurnId: prepared.originalTurnId,
              error: prepared.error,
            },
            connection: ctx.connection,
            broadcast,
          });
          return contractFailedResult(
            prepared.conversationId,
            turnId,
            prepared.error,
          );
        }

        if (prepared.kind === "await-existing-confirmation") {
          manager.addObserver(prepared.session.conversationId, connectionId, {
            allowInactive: true,
          });
          return awaitingRubricResult(
            prepared.session.conversationId,
            turnId,
            prepared.session.id,
            prepared.draft,
          );
        }

        if (prepared.kind === "direct-original-task") {
          notifyAdvancementEvent({
            conversationId: prepared.session.conversationId,
            turnId: prepared.originalTurnId,
            seq: 1,
            event: "advancement:contract_cancelled",
            payload: {
              advancementSessionId: prepared.session.id,
              executeOriginal: true,
            },
            connection: ctx.connection,
            broadcast,
          });
          const admitted = await admitAndMaybeStartTurn({
            manager,
            conversationId: prepared.session.conversationId,
            exists: existingConversationCheck(
              ctx.server,
              prepared.session.conversationId,
            ),
            connectionId,
            input: prepared.originalUserTask,
            turnId: prepared.originalTurnId,
            connection: ctx.connection,
            broadcast,
          });
          return {
            conversationId: admitted.conversationId,
            sessionId: admitted.conversationId,
            turnId: admitted.turnId,
          };
        }

        if (prepared.kind === "cancelled-pending-task") {
          manager.addObserver(prepared.session.conversationId, connectionId, {
            allowInactive: true,
          });
          notifyAdvancementEvent({
            conversationId: prepared.session.conversationId,
            turnId: prepared.originalTurnId,
            seq: 1,
            event: "advancement:contract_cancelled",
            payload: {
              advancementSessionId: prepared.session.id,
              executeOriginal: false,
              reason: "user-cancelled",
            },
            connection: ctx.connection,
            broadcast,
          });
          return {
            conversationId: prepared.session.conversationId,
            sessionId: prepared.session.conversationId,
            turnId,
            status: "cancelled",
            advancementSessionId: prepared.session.id,
          };
        }

        return await sendDirectTurn({
          manager,
          conversationId: id,
          preallocatedConversationId: id ? undefined : preparedId,
          input,
          turnId,
          connectionId,
          connection: ctx.connection,
          broadcast,
          server: ctx.server,
        });
      }

      return await sendDirectTurn({
        manager,
        conversationId: id,
        input,
        turnId,
        connectionId,
        connection: ctx.connection,
        broadcast,
        server: ctx.server,
      });
    },
  };
}

// ─── session.advancementConfirm / session.advancementCancel ───

interface SessionAdvancementActionParams extends ConversationIdParams {
  advancementSessionId?: unknown;
}

interface SessionAdvancementCancelParams extends SessionAdvancementActionParams {
  executeOriginal?: unknown;
}

export function buildSessionAdvancementConfirmMethod(): MethodEntry {
  return {
    name: "session.advancementConfirm",
    requiresAuth: true,
    async handler(
      rawParams,
      ctx,
    ): Promise<SessionAdvancementConfirmResult> {
      const params = (rawParams ?? {}) as SessionAdvancementActionParams;
      const conversationId = requireConversationId(
        params,
        "session.advancementConfirm",
      );
      const advancementSessionId = requireAdvancementSessionId(
        params,
        "session.advancementConfirm",
      );
      const advancement = requireAdvancement(ctx.server);
      const manager = requireConversations(ctx.server);
      let confirmed: Awaited<ReturnType<typeof advancement.confirmRubric>>;
      try {
        confirmed = await runAdvancementMaintenance({
          manager,
          server: ctx.server,
          conversationId,
          busyMessage:
            "Conversation is busy; confirm the Rubric after the current turn completes",
          fn: () =>
            advancement.confirmRubric({
              conversationId,
              advancementSessionId,
            }),
        });
      } catch (err) {
        if (err instanceof RpcAppError && err.code === RPC_ERROR_CODES.NOT_FOUND) {
          await advancement
            .cancelOpenSession({
              conversationId,
              advancementSessionId,
              reason: "system-error",
              message:
                "原始对话已不存在，推进会话已取消以避免悬空状态。",
            })
            .catch(() => null);
        }
        throw err;
      }
      notifyAdvancementEvent({
        conversationId,
        turnId: confirmed.originalTurnId,
        seq: 1,
        event: "advancement:contract_confirmed",
        payload: {
          advancementSessionId: confirmed.session.id,
          rubricId: confirmed.session.confirmedRubric?.rubricId,
        },
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });

      let admitted: Awaited<ReturnType<typeof admitAndMaybeStartTurn>>;
      try {
        admitted = await admitAndMaybeStartTurn({
          manager,
          conversationId,
          exists: existingConversationCheck(ctx.server, conversationId),
          connectionId: String(ctx.connection.id),
          input: confirmed.originalUserTask,
          turnId: confirmed.originalTurnId,
          connection: ctx.connection,
          broadcast: ctx.server.sessionBroadcast,
        });
      } catch (err) {
        const cancelled = await advancement
          .cancelOpenSession({
            conversationId,
            advancementSessionId,
            reason: "system-error",
            message:
              "原始任务未能进入执行队列，推进会话已取消以避免悬空状态。",
          })
          .catch(() => null);
        if (cancelled) {
          notifyAdvancementEvent({
            conversationId,
            turnId: confirmed.originalTurnId,
            seq: 2,
            event: "advancement:contract_cancelled",
            payload: {
              advancementSessionId: cancelled.id,
              executeOriginal: false,
              reason: "original-task-admission-failed",
            },
            connection: ctx.connection,
            broadcast: ctx.server.sessionBroadcast,
          });
        }
        throw err;
      }

      return {
        conversationId: admitted.conversationId,
        sessionId: admitted.conversationId,
        turnId: admitted.turnId,
        status: "confirmed",
        advancementSessionId: confirmed.session.id,
        runStatus: admitted.runStatus,
      };
    },
  };
}

export function buildSessionAdvancementCancelMethod(): MethodEntry {
  return {
    name: "session.advancementCancel",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionAdvancementCancelResult> {
      const params = (rawParams ?? {}) as SessionAdvancementCancelParams;
      const conversationId = requireConversationId(
        params,
        "session.advancementCancel",
      );
      const advancementSessionId = requireAdvancementSessionId(
        params,
        "session.advancementCancel",
      );
      const executeOriginal = params.executeOriginal === true;
      const advancement = requireAdvancement(ctx.server);
      const manager = requireConversations(ctx.server);
      const cancelled = await runAdvancementMaintenance({
        manager,
        server: ctx.server,
        conversationId,
        busyMessage:
          "Conversation is busy; cancel the Rubric after the current turn completes",
        fn: () =>
          advancement.cancelRubric({
            conversationId,
            advancementSessionId,
            executeOriginal,
          }),
      });

      notifyAdvancementEvent({
        conversationId,
        turnId:
          cancelled.kind === "direct-original-task"
            ? cancelled.originalTurnId
            : (cancelled.originalTurnId ?? cancelled.session.id),
        seq: 1,
        event: "advancement:contract_cancelled",
        payload: {
          advancementSessionId: cancelled.session.id,
          executeOriginal: cancelled.kind === "direct-original-task",
        },
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });

      if (cancelled.kind === "cancelled") {
        return {
          conversationId,
          sessionId: conversationId,
          status: "cancelled",
          advancementSessionId: cancelled.session.id,
        };
      }

      const admitted = await admitAndMaybeStartTurn({
        manager,
        conversationId,
        exists: existingConversationCheck(ctx.server, conversationId),
        connectionId: String(ctx.connection.id),
        input: cancelled.originalUserTask,
        turnId: cancelled.originalTurnId,
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });

      return {
        conversationId: admitted.conversationId,
        sessionId: admitted.conversationId,
        turnId: admitted.turnId,
        status: "direct-execution",
        advancementSessionId: cancelled.session.id,
        runStatus: admitted.runStatus,
      };
    },
  };
}

type AdvancementPrepareOwnerResult =
  | AdvancementPrepareResult
  | { readonly kind: "owner-busy" };

async function prepareAdvancementUserTurn(input: {
  readonly manager: ConversationManager;
  readonly server: ServerContext;
  readonly advancement: NonNullable<ServerContext["advancement"]>;
  readonly conversationId?: string;
  readonly preparedConversationId: string;
  readonly turnId: string;
  readonly input: UserTurnInput;
}): Promise<AdvancementPrepareOwnerResult> {
  const run = () =>
    input.advancement.prepareUserTurn({
      conversationId: input.preparedConversationId,
      turnId: input.turnId,
      userInput: input.input,
      beforeCreateSession: input.conversationId
        ? undefined
        : () => ensureConversationShell(input.server, input.preparedConversationId),
    });

  if (!input.conversationId) {
    const result = await input.manager.runMaintenance(
      input.preparedConversationId,
      run,
    );
    return result.status === "busy" ? { kind: "owner-busy" } : result.value;
  }

  const result = await input.manager.runMaintenanceExisting(
    input.conversationId,
    existingConversationCheck(input.server, input.conversationId),
    run,
  );
  if (result.status === "not-found") {
    throw RpcErrors.notFound(`Session not found: ${input.conversationId}`);
  }
  return result.status === "busy" ? { kind: "owner-busy" } : result.value;
}

async function runAdvancementMaintenance<T>(input: {
  readonly manager: ConversationManager;
  readonly server: ServerContext;
  readonly conversationId: string;
  readonly busyMessage: string;
  readonly fn: () => Promise<T>;
}): Promise<T> {
  const result = await input.manager.runMaintenanceExisting(
    input.conversationId,
    existingConversationCheck(input.server, input.conversationId),
    input.fn,
  );
  if (result.status === "not-found") {
    throw RpcErrors.notFound(`Session not found: ${input.conversationId}`);
  }
  if (result.status === "busy") {
    throw RpcErrors.busy(input.busyMessage);
  }
  return result.value;
}

interface SendDirectTurnInput {
  readonly manager: ConversationManager;
  readonly conversationId?: string;
  readonly preallocatedConversationId?: string;
  readonly input: UserTurnInput;
  readonly turnId: string;
  readonly connectionId: string;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
  readonly server: ServerContext;
}

async function sendDirectTurn(
  input: SendDirectTurnInput,
): Promise<SessionSendResult> {
  const admitted = await admitAndMaybeStartTurn({
    manager: input.manager,
    conversationId: input.conversationId,
    createConversation: createConversationCallback(
      input.server,
      input.preallocatedConversationId,
    ),
    exists: existingConversationCheck(input.server, input.conversationId),
    connectionId: input.connectionId,
    input: input.input,
    turnId: input.turnId,
    connection: input.connection,
    broadcast: input.broadcast,
  });
  return {
    conversationId: admitted.conversationId,
    sessionId: admitted.conversationId,
    turnId: admitted.turnId,
  };
}

interface AdmitAndMaybeStartTurnInput {
  readonly manager: ConversationManager;
  readonly conversationId?: string;
  readonly createConversation?: () => Promise<string>;
  readonly exists?: () => Promise<boolean>;
  readonly connectionId: string;
  readonly input: UserTurnInput;
  readonly turnId: string;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
}

async function admitAndMaybeStartTurn(
  input: AdmitAndMaybeStartTurnInput,
): Promise<{
  conversationId: string;
  turnId: string;
  runStatus: "immediate" | "queued";
}> {
  const admission = await input.manager.admitTurn({
    conversationId: input.conversationId,
    createConversation: input.createConversation,
    exists: input.exists,
    connectionId: input.connectionId,
    makeTask: (managed) => ({
      execute: () =>
        runManagedTurn(
          managed,
          input.input,
          input.turnId,
          input.connection,
          input.manager,
          input.broadcast,
        ),
      // 取消通知是排队发起者的私人回执,不组播——其他端没见过这条排队项
      cancel: () => {
        input.connection.notify(SESSION_NOTIFICATIONS.complete, {
          conversationId: managed.conversationId,
          sessionId: managed.conversationId,
          turnId: input.turnId,
          result: {
            reason: "error",
            error: { name: "Cancelled", message: "Pending turn cancelled" },
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        } satisfies SessionCompletePayload);
      },
    }),
  });

  if (admission.status === "not-found") {
    throw RpcErrors.notFound(`Session not found: ${admission.conversationId}`);
  }
  if (admission.status === "full") {
    throw new RpcAppError(
      RPC_ERROR_CODES.BUSY,
      "Too many pending messages for this conversation",
    );
  }

  if (admission.status === "immediate") {
    void admission.task.execute();
  }

  return {
    conversationId: admission.conversationId,
    turnId: input.turnId,
    runStatus: admission.status,
  };
}

function awaitingRubricResult(
  conversationId: string,
  turnId: string,
  advancementSessionId: string,
  rubricDraft: RubricContractDraftSnapshot,
): SessionAwaitingRubricResult {
  return {
    conversationId,
    sessionId: conversationId,
    turnId,
    status: "awaiting-rubric-confirmation",
    advancementSessionId,
    rubricDraftId: rubricDraft.draftId,
    rubricDraft,
  };
}

function contractFailedResult(
  conversationId: string,
  turnId: string,
  error: { readonly message: string },
): SessionContractFailedResult {
  return {
    conversationId,
    sessionId: conversationId,
    turnId,
    status: "contract-failed",
    error: { message: error.message },
  };
}

function createConversationCallback(
  server: ServerContext,
  preallocatedConversationId?: string,
): (() => Promise<string>) | undefined {
  const directory = server.conversationDirectory;
  if (preallocatedConversationId) {
    return async () => {
      await directory?.ensure(preallocatedConversationId);
      return preallocatedConversationId;
    };
  }
  return directory ? async () => (await directory.create()).id : undefined;
}

async function ensureConversationShell(
  server: ServerContext,
  conversationId: string,
): Promise<void> {
  await server.conversationDirectory?.ensure(conversationId);
}

function notifyAdvancementEvent(input: {
  readonly conversationId: string;
  readonly turnId: string;
  readonly seq?: number;
  readonly event: string;
  readonly payload: unknown;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
}): void {
  const envelope: SessionEventEnvelope = {
    conversationId: input.conversationId,
    scope: "control",
    runId: input.turnId,
    seq: input.seq ?? 0,
    event: input.event,
    payload: input.payload,
    meta: {},
  };
  if (input.broadcast) {
    input.broadcast(
      input.conversationId,
      SESSION_NOTIFICATIONS.event,
      envelope,
    );
  } else {
    input.connection.notify(SESSION_NOTIFICATIONS.event, envelope);
  }
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
  input: UserTurnInput,
  turnId: string,
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
    // RPC 入口触发的 turn 无通道 target，确认请求按连接身份定向回发起端。
    const turnContext: TurnContext = {
      turnId,
      turnOrigin: {
        channel: "rpc",
        triggeredBy: String(connection.id),
      },
    };
    await projectSessionTurn({
      manager,
      managed,
      input,
      turnId,
      runOptions: {
        abortSignal: abortController.signal,
        turnContext,
        turnIndex: managed.turnCount,
        source: "channel",
      },
      notify: push,
      abortSignal: abortController.signal,
      onModeSwitchIntent: (intent) => {
        // 模式切换意图是可执行的控制字段,只定向发起连接——跟随权归发起
        // 接入面由结构保证(旁观端物理收不到),不靠客户端自律。先于 complete
        // 发送(同连接有序):客户端收意图暂存,收 complete(turn 落定)即消费,
        // 与 REPL 的 turn 边界消费语义对齐。
        connection.notify(SESSION_NOTIFICATIONS.modeSwitchIntent, {
          conversationId,
          turnId,
          intent,
        } satisfies SessionModeSwitchIntentPayload);
      },
    });

    // turnStartedAt 不用作 run record 的 timestamp（buildRunRecord 已精确设定）——
    // 保留变量避免未来诊断字段需要 turn 入口时间时重新加逻辑。
    void turnStartedAt;
  } finally {
    unsubClose();
    manager.setBusy(conversationId, false);
    if (connection.closed) {
      manager.removeObserver(conversationId, String(connection.id));
    }
  }
}

function normalizeSessionInput(params: SessionSendParams): UserTurnInput | null {
  const hasText = hasProvidedSessionInput(params, "text");
  const hasInput = hasProvidedSessionInput(params, "input");

  if (hasText && hasInput) {
    throw RpcErrors.invalidParams(
      "session.send accepts either 'text' or 'input', not both",
    );
  }

  if (hasInput) {
    if (!isNonEmptyUserTurnInput(params.input)) return null;
    return params.input;
  }

  if (typeof params.text === "string" && params.text.length > 0) {
    return userTurnInputFromText(params.text);
  }

  return null;
}

function hasProvidedSessionInput(
  params: SessionSendParams,
  key: "text" | "input",
): boolean {
  return Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined;
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
    async handler(_params, ctx): Promise<SessionListResult> {
      const manager = requireConversations(ctx.server);
      const directory = requireDirectory(ctx.server);
      const conversations = await directory.list();
      return {
        conversations: conversations.map((c): SessionConversationEntry => {
          const active = manager.getSession(c.id);
          return {
            conversationId: c.id,
            name: c.name,
            createdAt: c.createdAt,
            lastActiveAt: active?.lastActiveAt ?? c.lastActiveAt,
            active: !!active,
            busy: active?.busy ?? false,
            observerCount: manager.getObserverCount(c.id),
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
      // 会话级变更组播——observer 名册在 conversation 身份层,因此已落盘但
      // 未激活 runtime 的当前对话也能收到 run 外变更。
      ctx.server.sessionBroadcast?.(params.conversationId, SESSION_NOTIFICATIONS.changed, {
        conversationId: params.conversationId,
        change: "renamed",
        name: renamed.name,
      } satisfies SessionChangedPayload);
      // 返回入参全域键——目录契约返回库内身份(场景对话是 localId),
      // 全域键(ws: 前缀)由 RPC 层保持,断键即断静态归属路由
      return {
        conversationId: params.conversationId,
        name: renamed.name,
      } satisfies SessionRenameResult;
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
      // 删除 = 活跃运行时释放 + 落盘数据删除,在 manager 的 id 排他门内原子
      // 完成(盘删与并发激活串行,busy 拒绝路径下盘不被动)。deleted 只在
      // 删除成功后、名册清理前组播,旁观端据此停止盯已删对话。
      const result = await manager.delete(id, {
        removeDisk: async () => (directory ? directory.remove(id) : false),
        onDeleted: () => {
          ctx.server.sessionBroadcast?.(id, SESSION_NOTIFICATIONS.changed, {
            conversationId: id,
            change: "deleted",
          } satisfies SessionChangedPayload);
        },
      });
      if (result === "busy") {
        throw new RpcAppError(
          RPC_ERROR_CODES.BUSY,
          "Conversation has an in-flight turn; abort it before deleting",
        );
      }
      if (!result) {
        throw RpcErrors.notFound(`Session not found: ${id}`);
      }
      try {
        await ctx.server.advancement?.cancelOpenConversationSession({
          conversationId: id,
          reason: "user-cancelled",
          message: "原始对话已删除，推进会话已取消。",
        });
      } catch (err) {
        console.error("[session.delete] advancement cleanup failed:", err);
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
    async handler(rawParams, ctx): Promise<SessionSubscribeResult> {
      const params = (rawParams ?? {}) as SessionSubscribeParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams(
          "session.subscribe requires 'conversationId'",
        );
      }
      const manager = requireConversations(ctx.server);
      const active = manager.has(params.conversationId);
      const exists =
        active ||
        (await ctx.server.conversationDirectory?.exists(params.conversationId));
      if (!exists) return { subscribed: false };

      // observer 是 conversation 身份层名册;已落盘但未激活 runtime 的当前对话
      // 也必须能收到 rename/delete/clear 这类 run 外变更。
      const subscribed = manager.addObserver(
        params.conversationId,
        String(ctx.connection.id),
        { allowInactive: true },
      );
      return { subscribed };
    },
  };
}

export function buildSessionUnsubscribeMethod(): MethodEntry {
  return {
    name: "session.unsubscribe",
    requiresAuth: true,
    handler(rawParams, ctx): SessionUnsubscribeResult {
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

// ─── session.clear ───

interface SessionClearParams {
  conversationId?: string;
}

/**
 * 清空对话——持久层清空(transcript clear 事件 + meta 视图层清理)与活跃会话
 * 内存窗口重置在 ConversationManager 的**单 conversation 排他临界区**内原子
 * 完成:维护操作同步占用串行点,并发 send 期间排队、清空后在空窗口上 dequeue,
 * 杜绝"盘已清却被旧窗 turn 写新流"的污染。busy 时拒绝且盘绝不被动。
 * 经组播名册发 session.changed cleared——旁观端据此刷新视图。
 */
export function buildSessionClearMethod(): MethodEntry {
  return {
    name: "session.clear",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionClearResult> {
      const params = (rawParams ?? {}) as SessionClearParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams("session.clear requires 'conversationId'");
      }
      const id = params.conversationId;
      const manager = requireConversations(ctx.server);
      const directory = requireDirectory(ctx.server);

      // 持久层清空收进 manager 的排他临界区(注入 persistClear 回调)——占用
      // 串行点后才写盘,busy 拒绝路径下盘不被动,原子性由结构保证而非纪律。
      const outcome = await manager.clear(id, () => directory.clear(id));
      if (outcome === "busy") {
        throw new RpcAppError(
          RPC_ERROR_CODES.BUSY,
          "Conversation has an in-flight turn; abort it before clearing",
        );
      }
      if (outcome === "not-found") {
        throw RpcErrors.notFound(`Session not found: ${id}`);
      }

      ctx.server.sessionBroadcast?.(id, SESSION_NOTIFICATIONS.changed, {
        conversationId: id,
        change: "cleared",
      } satisfies SessionChangedPayload);
      return { cleared: true };
    },
  };
}

// ─── session.compact ───

interface SessionCompactParams {
  conversationId?: string;
}

/**
 * 手动压缩注意力窗口——激活会话(非活跃经启动装填重建窗口)后由运行体产出
 * 折叠指令,manager 应用折叠并写派生快照。压缩是窗口的视图操作,不动落盘原文。
 */
export function buildSessionCompactMethod(): MethodEntry {
  return {
    name: "session.compact",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionCompactResult> {
      const params = (rawParams ?? {}) as SessionCompactParams;
      const conversationId = requireConversationId(params, "session.compact");
      const manager = requireConversations(ctx.server);
      const result = await manager.compactExisting(
        conversationId,
        requiredExistingConversationCheck(ctx.server, conversationId),
      );

      if (result.status === "busy") {
        throw new RpcAppError(
          RPC_ERROR_CODES.BUSY,
          "Conversation has an in-flight turn; compact after it completes",
        );
      }
      if (result.status === "not-found") {
        throw RpcErrors.notFound(
          `Session not found: ${conversationId}`,
        );
      }
      if (result.status === "unsupported") {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Runtime does not support manual compaction",
        );
      }

      const { outcome } = result;
      return {
        modified: outcome.modified && !!outcome.windowCompact,
        tokensBefore: outcome.windowCompact?.tokensBefore,
        tokensAfter: outcome.windowCompact?.tokensAfter,
        emergencyFloor: outcome.emergencyFloor,
      };
    },
  };
}

// ─── session.contextBudget ───

interface SessionContextBudgetParams {
  conversationId?: string;
}

/**
 * 当前注意力窗口的上下文预算——接入面 /usage /context 的数据面。激活会话
 * (非活跃经启动装填重建窗口)后由运行体估算。
 */
export function buildSessionContextBudgetMethod(): MethodEntry {
  return {
    name: "session.contextBudget",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionContextBudgetResult> {
      const params = (rawParams ?? {}) as SessionContextBudgetParams;
      const conversationId = requireConversationId(
        params,
        "session.contextBudget",
      );
      const manager = requireConversations(ctx.server);
      const result = await manager.inspectContextBudgetExisting(
        conversationId,
        requiredExistingConversationCheck(ctx.server, conversationId),
      );
      if (result.status === "not-found") {
        throw RpcErrors.notFound(`Session not found: ${conversationId}`);
      }
      if (result.status === "unsupported") {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Runtime does not support context budget inspection",
        );
      }
      return {
        budget: result.budget,
        turnCount: result.turnCount,
        calibrationFactor: result.calibrationFactor,
      };
    },
  };
}

// ─── session.usage ───

interface SessionUsageParams {
  conversationId?: string;
}

/**
 * /usage 的完整宿主数据面。上下文预算与子 agent/Task 用量拆分来自同一
 * 当前注意力窗口快照；Task trailer 的解析归运行体实现方，server 只组合结构。
 */
export function buildSessionUsageMethod(): MethodEntry {
  return {
    name: "session.usage",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionUsageResult> {
      const params = (rawParams ?? {}) as SessionUsageParams;
      const conversationId = requireConversationId(params, "session.usage");
      const manager = requireConversations(ctx.server);
      const result = await manager.inspectUsageExisting(
        conversationId,
        requiredExistingConversationCheck(ctx.server, conversationId),
      );
      if (result.status === "not-found") {
        throw RpcErrors.notFound(`Session not found: ${conversationId}`);
      }
      if (result.status === "unsupported") {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Runtime does not support usage inspection",
        );
      }
      return {
        budget: result.budget,
        turnCount: result.turnCount,
        calibrationFactor: result.calibrationFactor,
        subUsages: result.subUsages,
      };
    },
  };
}

// ─── session.security ───

interface SessionSecurityParams {
  conversationId?: string;
}

/**
 * 当前运行体的安全状态快照——接入面 /security 的数据面。会话不存在不激活
 * runtime;存在但未活跃时按启动装填激活后读取,与 /usage /context 同纪律。
 */
export function buildSessionSecurityMethod(): MethodEntry {
  return {
    name: "session.security",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionSecurityResult> {
      const params = (rawParams ?? {}) as SessionSecurityParams;
      const conversationId = requireConversationId(params, "session.security");
      const manager = requireConversations(ctx.server);
      const result = await manager.inspectSecurityExisting(
        conversationId,
        requiredExistingConversationCheck(ctx.server, conversationId),
      );
      if (result.status === "not-found") {
        throw RpcErrors.notFound(`Session not found: ${conversationId}`);
      }
      if (result.status === "unsupported") {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Runtime does not support security inspection",
        );
      }
      return result.snapshot;
    },
  };
}

// ─── session.taskListUpdate ───

interface SessionTaskListUpdateParams {
  conversationId?: string;
  action?: SessionTaskListAction;
}

/** /task new·done 的宿主执行体——写单点在宿主 task_list 服务。 */
export function buildSessionTaskListUpdateMethod(): MethodEntry {
  return {
    name: "session.taskListUpdate",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionTaskListUpdateResult> {
      const params = (rawParams ?? {}) as SessionTaskListUpdateParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams(
          "session.taskListUpdate requires 'conversationId'",
        );
      }
      const action = params.action;
      const validAction =
        !!action &&
        ((action.kind === "add" && typeof action.content === "string") ||
          (action.kind === "done" && typeof action.token === "string"));
      if (!validAction) {
        throw RpcErrors.invalidParams(
          "session.taskListUpdate requires 'action' of kind add{content} or done{token}",
        );
      }
      const conversationId = params.conversationId;
      const update = ctx.server.taskListUpdate;
      if (!update) {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Task list update executor not configured on server",
        );
      }
      const manager = requireConversations(ctx.server);
      const result = await manager.runMaintenanceExisting(
        conversationId,
        existingConversationCheck(ctx.server, conversationId),
        () => update(conversationId, action),
      );
      if (result.status === "busy") {
        throw new RpcAppError(
          RPC_ERROR_CODES.BUSY,
          "Conversation has an in-flight turn or maintenance operation; update tasks after it completes",
        );
      }
      if (result.status === "not-found") {
        throw RpcErrors.notFound(`Session not found: ${conversationId}`);
      }
      return result.value;
    },
  };
}

// ─── session.taskList ───

interface SessionTaskListParams {
  conversationId?: string;
}

/** task_list 权威读模型——发起端启动 / 切换 / 清空后同步只读视图。 */
export function buildSessionTaskListMethod(): MethodEntry {
  return {
    name: "session.taskList",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionTaskListResult> {
      const params = (rawParams ?? {}) as SessionTaskListParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams(
          "session.taskList requires 'conversationId'",
        );
      }
      const snapshot = ctx.server.taskListSnapshot;
      if (!snapshot) {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Task list snapshot reader not configured on server",
        );
      }
      return { taskList: await snapshot(params.conversationId) };
    },
  };
}

// ─── session.new ───

/** 建一个 user 域新对话(meta + transcript 壳),返回身份供接入面切指针。 */
export function buildSessionNewMethod(): MethodEntry {
  return {
    name: "session.new",
    requiresAuth: true,
    async handler(_params, ctx): Promise<SessionNewResult> {
      const directory = requireDirectory(ctx.server);
      const created = await directory.create();
      return { conversationId: created.id, name: created.name };
    },
  };
}

// ─── session.resume ───

interface SessionResumeParams {
  conversationId?: string;
}

/**
 * 切换到既有对话——touch 最近活跃 + 返回身份与活跃态。接入面据此切指针、
 * 拉历史尾巴、决定是否 subscribe 旁观进行中的流;窗口装填推迟到首次 send
 * (getOrCreate 的启动装填),resume 本身不激活运行体。
 */
export function buildSessionResumeMethod(): MethodEntry {
  return {
    name: "session.resume",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionResumeResult> {
      const params = (rawParams ?? {}) as SessionResumeParams;
      if (typeof params.conversationId !== "string") {
        throw RpcErrors.invalidParams("session.resume requires 'conversationId'");
      }
      const directory = requireDirectory(ctx.server);
      const touched = await directory.touch(params.conversationId);
      if (!touched) {
        throw RpcErrors.notFound(`Session not found: ${params.conversationId}`);
      }
      const manager = requireConversations(ctx.server);
      const active = manager.getSession(params.conversationId);
      return {
        // 返回入参全域键——与 rename 同纪律,目录契约返回库内身份
        conversationId: params.conversationId,
        name: touched.name,
        active: !!active,
        busy: active?.busy ?? false,
      };
    },
  };
}

// ─── 工具 ───

interface ConversationIdParams {
  conversationId?: unknown;
  sessionId?: unknown;
}

function validateConversationId(value: unknown, method: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw RpcErrors.invalidParams(
      `${method} requires non-empty 'conversationId'`,
    );
  }
  return value;
}

function validateTurnId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw RpcErrors.invalidParams(
      "session.send 'turnId' must be a non-empty string",
    );
  }
  return value;
}

function requireAdvancementSessionId(
  params: SessionAdvancementActionParams,
  method: string,
): string {
  if (
    typeof params.advancementSessionId !== "string" ||
    params.advancementSessionId.trim().length === 0
  ) {
    throw RpcErrors.invalidParams(
      `${method} requires non-empty 'advancementSessionId'`,
    );
  }
  return params.advancementSessionId;
}

function optionalConversationId(
  params: ConversationIdParams,
  method: string,
): string | undefined {
  if (params.conversationId !== undefined) {
    return validateConversationId(params.conversationId, method);
  }
  if (params.sessionId !== undefined) {
    return validateConversationId(params.sessionId, method);
  }
  return undefined;
}

function requireConversationId(
  params: ConversationIdParams,
  method: string,
): string {
  return validateConversationId(params.conversationId, method);
}

function existingConversationCheck(
  server: ServerContext,
  conversationId: string | undefined,
): (() => Promise<boolean>) | undefined {
  if (!conversationId) return undefined;
  const directory = server.conversationDirectory;
  return directory ? () => directory.exists(conversationId) : undefined;
}

function requiredExistingConversationCheck(
  server: ServerContext,
  conversationId: string,
): () => Promise<boolean> {
  const directory = requireDirectory(server);
  return () => directory.exists(conversationId);
}

function requireConversations(server: ServerContext): ConversationManager {
  if (!server.conversations) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "ConversationManager not configured on server",
    );
  }
  return server.conversations;
}

function requireAdvancement(server: ServerContext) {
  if (!server.advancement) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "AdvancementController not configured on server",
    );
  }
  return server.advancement;
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
