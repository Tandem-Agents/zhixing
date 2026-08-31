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
 * - session.postTurnControlIntent { conversationId, turnId, intent } —— 可执行 turn 边界控制意图,
 *   跟随权归发起接入面由结构保证(旁观端物理不可达)
 */

import {
  abortWithReason,
  assistantMessage,
  emptyUsage,
  isNonEmptyUserTurnInput,
  type AgentEventMap,
  type AgentYield,
  type AdvancementSession,
  type RubricContractDraftSnapshot,
  type TurnContext,
  type UserTurnInput,
  userTurnInputFromText,
} from "@zhixing/core";
import type { ExplicitEnvironmentSelection } from "@zhixing/core/contracts";
import {
  CONVERSATION_CREATE_COMMAND,
  CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
  CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
  CONVERSATION_ABORT_COMMAND,
  CONVERSATION_CLEAR_COMMAND,
  CONVERSATION_COMPACT_COMMAND,
  CONVERSATION_CONTEXT_BUDGET_QUERY,
  CONVERSATION_DELETE_COMMAND,
  CONVERSATION_HISTORY_QUERY,
  CONVERSATION_IDENTITY_EXISTS_QUERY,
  CONVERSATION_LIST_QUERY,
  CONVERSATION_ENSURE_SHELL_COMMAND,
  CONVERSATION_RENAME_COMMAND,
  CONVERSATION_RESUME_COMMAND,
  CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
  CONVERSATION_SECURITY_QUERY,
  CONVERSATION_TASK_LIST_QUERY,
  CONVERSATION_UPDATE_TASK_LIST_COMMAND,
  CONVERSATION_USAGE_QUERY,
  ConversationApplicationError,
  type ConversationDirectoryEntry,
  type ConversationPreparedAgentTurnIdentity,
} from "@zhixing/core/conversation/application";
import {
  ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
  ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
  ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
  ADVANCEMENT_DETAIL_QUERY,
  ADVANCEMENT_REVISE_RUBRIC_COMMAND,
  AdvancementApplicationError,
  type AdvancementContractConfirmedFact,
  type AdvancementContractCancelledFact,
  type AdvancementDetailProjection,
  type AdvancementOriginalTaskSurfacePort,
  type AdvancementRubricCancellationResult,
} from "@zhixing/core/advancement/application";
import type { ProductApiOperationDescriptor } from "@zhixing/core/product-api";
import { validateExplicitEnvironmentSelection } from "@zhixing/core/protocol";
import type { MethodEntry } from "../handlers.js";
import { RpcAppError, RpcErrors } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { RpcConnection } from "../connection.js";
import { requireRpcSurfacePrincipal } from "../surface-identity.js";
import type { ServerContext } from "../../context.js";
import type { SessionBroadcast } from "@zhixing/rpc/session-broadcast";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";
import {
  SESSION_NOTIFICATIONS,
  type SessionChangedPayload,
  type SessionClearResult,
  type SessionCompactResult,
  type SessionContextBudgetResult,
  type SessionCompletePayload,
  type SessionDeltaPayload,
  type SessionAdvancementCancelResult,
  type SessionAdvancementConfirmResult,
  type SessionAdvancementDetailResult,
  type SessionAdvancementReviseResult,
  type SessionRubricPersistenceChoice,
  type SessionAdvancementStateSnapshot,
  type SessionConversationEntry,
  type SessionAwaitingRubricResult,
  type SessionContractFailedResult,
  type SessionListResult,
  type SessionPostTurnControlIntentPayload,
  type SessionNewResult,
  type SessionRenameResult,
  type SessionResumeResult,
  type SessionSendEngage,
  type SessionSendResult,
  type SessionSecurityResult,
  type SessionUsageResult,
  type SessionSubscribeResult,
  type SessionTaskListAction,
  type SessionTaskListResult,
  type SessionTaskListUpdateResult,
  type SessionUnsubscribeResult,
} from "@zhixing/rpc/session-wire";
import { createControlSessionEventEnvelope } from "@zhixing/rpc/session-events";
import type { AdvancementPrepareResult } from "@zhixing/owner-services";
import {
  generateConversationId,
  WorksceneBusyError,
  type ConversationManager,
  type ManagedSession,
} from "@zhixing/owner-kernel/conversation-manager";
import type { PerspectivesTurnResult } from "../../perspectives/index.js";
import { isProtocolIdentifier } from "@zhixing/core/protocol";
// ─── session.send ───

interface SessionSendParams extends ConversationIdParams {
  text?: unknown;
  input?: unknown;
  engage?: unknown;
  surfaceCapabilities?: unknown;
  environment?: unknown;
  /** 发起端可预分配 turnId,用于避免 loopback 下 complete 先于 send 响应的竞态 */
  turnId?: unknown;
}

interface SessionSurfaceCapabilities {
  readonly postTurnControl: boolean;
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
      const engage = normalizeSessionEngage(params.engage);
      const environment = normalizeSessionEnvironment(params.environment);
      if (engage && environment) {
        throw RpcErrors.invalidParams(
          "session.send environment selection is only supported for agent turns",
        );
      }
      const surfaceCapabilities = normalizeSurfaceCapabilities(
        params.surfaceCapabilities,
      );

      const id = optionalConversationId(params, "session.send");
      const turnIdentity = await prepareSessionSendTurnIdentity(
        ctx.server,
        ctx.connection,
        params.turnId,
      );
      const { turnId } = turnIdentity;
      const manager = requireConversations(ctx.server);
      const connectionId = String(ctx.connection.id);
      const broadcast = ctx.server.sessionBroadcast;
      const advancement = ctx.server.advancement;

      if (advancement) {
        const activePrepared = id
          ? await prepareActiveAdvancementUserTurn({
              manager,
              advancement,
              conversationId: id,
              turnId,
              input,
            })
          : null;

        if (activePrepared?.kind === "active-session-taken-over") {
          manager.addObserver(
            activePrepared.session.conversationId,
            connectionId,
            { allowInactive: true },
          );
          notifyAdvancementEvent({
            conversationId: activePrepared.session.conversationId,
            turnId,
            seq: 0,
            event: "advancement:exited",
            payload: {
              advancementSessionId: activePrepared.session.id,
              exit: activePrepared.exit,
              admission: activePrepared.admission,
              closure: activePrepared.closure,
            },
            connection: ctx.connection,
            broadcast,
          });
        }

        if (activePrepared?.kind === "rubric-regenerated") {
          return respondRubricRegenerated({
            prepared: activePrepared,
            turnId,
            connectionId,
            connection: ctx.connection,
            broadcast,
            manager,
          });
        }

        if (activePrepared?.kind === "contract-failed") {
          manager.addObserver(activePrepared.conversationId, connectionId, {
            allowInactive: true,
          });
          notifyAdvancementEvent({
            conversationId: activePrepared.conversationId,
            turnId: activePrepared.originalTurnId,
            seq: 0,
            event: "advancement:contract_failed",
            payload: {
              originalTurnId: activePrepared.originalTurnId,
              error: activePrepared.error,
            },
            connection: ctx.connection,
            broadcast,
          });
          // 修订失败没有改变旧契约，但代理 run 已为处理用户输入被中断——
          // 用户此刻在场，立即重接被中断的推进，不停摆到下一个触发点。
          try {
            await ctx.server.advancementRecovery?.recoverConversation(
              activePrepared.conversationId,
            );
          } catch {
            // 重接失败交给下一个恢复触发点收敛，不影响受控失败响应。
          }
          return contractFailedResult(
            activePrepared.conversationId,
            turnId,
            activePrepared.error,
          );
        }

        if (activePrepared?.kind === "active-user-turn") {
          const accepted = await sendUserTurn({
            manager,
            conversationId: id,
            input,
            engage,
            turnId,
            turnIdentity,
            connectionId,
            connection: ctx.connection,
            broadcast,
            server: ctx.server,
            surfaceCapabilities,
            ...(environment ? { environment } : {}),
          });
          // 中途插话可见性：输入被分类为同一目标的补充继续——发起端据此
          // 告知用户，含是否为处理输入而中止了在跑的推进代理。
          return {
            ...accepted,
            advancementContinuation: {
              interruptedProxy: activePrepared.interruptedProxy,
            },
          };
        }

        if (id) {
          const productApi = requireAdvancementProductApi(
            ctx.server,
            ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
          );
          const controlled = await (async () => {
            try {
              return await productApi.command(
                ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
                {
                  conversationId: id,
                  userInput: input,
                  fact: {
                    publish: (fact) => {
                      if (!fact.executeOriginal) {
                        manager.addObserver(fact.conversationId, connectionId, {
                          allowInactive: true,
                        });
                      }
                      publishAdvancementCancellationFact(
                        fact,
                        ctx.connection,
                        broadcast,
                      );
                    },
                  },
                  surface: createAdvancementOriginalTaskSurface({
                    manager,
                    connection: ctx.connection,
                    broadcast,
                  }),
                },
              );
            } catch (error) {
              throw mapAdvancementRubricCancellationError(
                error,
                id,
                id,
              );
            }
          })();
          if (controlled.result.kind === "keep-awaiting") {
            manager.addObserver(controlled.result.conversationId, connectionId, {
              allowInactive: true,
            });
            return awaitingRubricResult(
              controlled.result.conversationId,
              controlled.result.advancementSessionId,
              controlled.result.rubricDraft,
            );
          }
          if (controlled.result.kind === "direct-original-task") {
            return {
              conversationId: controlled.result.conversationId,
              sessionId: controlled.result.conversationId,
              turnId: controlled.result.turnId,
            };
          }
          if (controlled.result.kind === "cancelled") {
            return {
              conversationId: controlled.result.conversationId,
              sessionId: controlled.result.conversationId,
              turnId,
              status: "cancelled",
              advancementSessionId:
                controlled.result.advancementSessionId,
            };
          }
        }

        if (engage) {
          return await sendUserTurn({
            manager,
            conversationId: id,
            input,
            engage,
            turnId,
            turnIdentity,
            connectionId,
            connection: ctx.connection,
            broadcast,
            server: ctx.server,
            surfaceCapabilities,
            ...(environment ? { environment } : {}),
          });
        }

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
          return await sendUserTurn({
            manager,
            conversationId: id,
            preallocatedConversationId: id ? undefined : preparedId,
            input,
            engage,
            turnId,
            turnIdentity,
            connectionId,
            connection: ctx.connection,
            broadcast,
            server: ctx.server,
            surfaceCapabilities,
            ...(environment ? { environment } : {}),
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

        if (prepared.kind === "rubric-regenerated") {
          return respondRubricRegenerated({
            prepared,
            turnId,
            connectionId,
            connection: ctx.connection,
            broadcast,
            manager,
          });
        }

        if (prepared.kind === "active-session-taken-over") {
          manager.addObserver(prepared.session.conversationId, connectionId, {
            allowInactive: true,
          });
          notifyAdvancementEvent({
            conversationId: prepared.session.conversationId,
            turnId,
            seq: 0,
            event: "advancement:exited",
            payload: {
              advancementSessionId: prepared.session.id,
              exit: prepared.exit,
              admission: prepared.admission,
              closure: prepared.closure,
            },
            connection: ctx.connection,
            broadcast,
          });
        }

        const fallthroughAccepted = await sendUserTurn({
          manager,
          conversationId: id,
          preallocatedConversationId: id ? undefined : preparedId,
          input,
          engage,
          turnId,
          turnIdentity,
          connectionId,
          connection: ctx.connection,
          broadcast,
          server: ctx.server,
          surfaceCapabilities,
          ...(environment ? { environment } : {}),
        });
        // active 会话无 outstanding 且不 busy 时（proxy 结算后的间隙 /
        // 验收挂起期），continue-active 走本 fall-through——插话告知与
        // helper 路径保持一致，不让知情看运气走哪条路径。
        if (prepared.kind === "active-user-turn") {
          return {
            ...fallthroughAccepted,
            advancementContinuation: { interruptedProxy: false },
          };
        }
        return fallthroughAccepted;
      }

      return await sendUserTurn({
        manager,
        conversationId: id,
        input,
        engage,
        turnId,
        turnIdentity,
        connectionId,
        connection: ctx.connection,
        broadcast,
        server: ctx.server,
        surfaceCapabilities,
        ...(environment ? { environment } : {}),
      });
    },
  };
}

// ─── session.advancementConfirm / session.advancementCancel ───

interface SessionAdvancementActionParams extends ConversationIdParams {
  advancementSessionId?: unknown;
  /** 发起端所见草案版本——confirm 据此拒绝「确认到没看过的修订」。 */
  rubricDraftId?: unknown;
  /** generated 草案确认时的沉淀选择；缺省为另存新条。 */
  rubricPersistence?: unknown;
}

interface SessionAdvancementCancelParams
  extends SessionAdvancementActionParams {
  executeOriginal?: unknown;
}

interface SessionAdvancementReviseParams
  extends SessionAdvancementActionParams {
  userFeedback?: unknown;
}

export function buildSessionAdvancementConfirmMethod(): MethodEntry {
  return {
    name: "session.advancementConfirm",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionAdvancementConfirmResult> {
      const params = (rawParams ?? {}) as SessionAdvancementActionParams;
      const conversationId = requireConversationId(
        params,
        "session.advancementConfirm",
      );
      const advancementSessionId = requireAdvancementSessionId(
        params,
        "session.advancementConfirm",
      );
      const rubricDraftId = requireRubricDraftId(
        params,
        "session.advancementConfirm",
      );
      const persistence = parseRubricPersistence(
        params,
        "session.advancementConfirm",
      );
      const manager = requireConversations(ctx.server);
      const productApi = requireAdvancementProductApi(
        ctx.server,
        ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
      );
      try {
        const confirmed = await productApi.command(
          ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
          {
            conversationId,
            advancementSessionId,
            expectedRubricDraftId: rubricDraftId,
            ...(persistence ? { persistence } : {}),
            originalTaskTurnOrigin: {
              channel: "rpc",
              triggeredBy: rpcSurfacePrincipal(ctx.connection),
            },
            fact: {
              publish: (fact) =>
                publishAdvancementRubricConfirmationFact(
                  fact,
                  ctx.connection,
                  ctx.server.sessionBroadcast,
                ),
            },
            surface: createAdvancementOriginalTaskSurface({
              manager,
              connection: ctx.connection,
              broadcast: ctx.server.sessionBroadcast,
            }),
          },
        );
        return {
          conversationId: confirmed.result.conversationId,
          sessionId: confirmed.result.conversationId,
          turnId: confirmed.result.turnId,
          ...(confirmed.result.runId
            ? { runId: confirmed.result.runId }
            : {}),
          status: "confirmed",
          advancementSessionId: confirmed.result.advancementSessionId,
          runStatus: confirmed.result.runStatus,
          ...(confirmed.result.rubricPublicationMessage
            ? {
                rubricPublicationMessage:
                  confirmed.result.rubricPublicationMessage,
              }
            : {}),
        };
      } catch (error) {
        throw mapAdvancementRubricConfirmationError(
          error,
          conversationId,
          advancementSessionId,
        );
      }
    },
  };
}

export function buildSessionAdvancementReviseMethod(): MethodEntry {
  return {
    name: "session.advancementRevise",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionAdvancementReviseResult> {
      const params = (rawParams ?? {}) as SessionAdvancementReviseParams;
      const conversationId = requireConversationId(
        params,
        "session.advancementRevise",
      );
      const advancementSessionId = requireAdvancementSessionId(
        params,
        "session.advancementRevise",
      );
      const userFeedback = requireUserFeedback(
        params,
        "session.advancementRevise",
      );
      const productApi = requireAdvancementProductApi(
        ctx.server,
        ADVANCEMENT_REVISE_RUBRIC_COMMAND,
      );
      const revised = await (async () => {
        try {
          return await productApi.command(
            ADVANCEMENT_REVISE_RUBRIC_COMMAND,
            { conversationId, advancementSessionId, userFeedback },
          );
        } catch (error) {
          throw mapAdvancementRubricRevisionError(
            error,
            conversationId,
            advancementSessionId,
          );
        }
      })();
      const fact = revised.facts[0];
      if (!fact) {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "Advancement rubric revision emitted no contract-draft fact",
        );
      }

      notifyAdvancementEvent({
        conversationId,
        turnId: fact.originalTurnId,
        seq: fact.rubricDraftVersion,
        event: "advancement:contract_draft",
        payload: {
          advancementSessionId: fact.advancementSessionId,
          rubricDraftId: fact.rubricDraftId,
          rubricDraft: fact.rubricDraft,
          revised: fact.revised,
        },
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });

      return {
        conversationId,
        sessionId: conversationId,
        status: "revised",
        advancementSessionId: revised.result.advancementSessionId,
        rubricDraftId: revised.result.rubricDraftId,
        rubricDraft: revised.result.rubricDraft,
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
      const manager = requireConversations(ctx.server);
      const productApi = requireAdvancementProductApi(
        ctx.server,
        ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
      );
      try {
        const cancelled = await productApi.command(
          ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
          {
            conversationId,
            advancementSessionId,
            executeOriginal,
            fact: {
              publish: (fact) =>
                publishAdvancementCancellationFact(
                  fact,
                  ctx.connection,
                  ctx.server.sessionBroadcast,
                ),
            },
            surface: createAdvancementOriginalTaskSurface({
              manager,
              connection: ctx.connection,
              broadcast: ctx.server.sessionBroadcast,
            }),
          },
        );
        return projectAdvancementRubricCancellationResult(cancelled.result);
      } catch (error) {
        throw mapAdvancementRubricCancellationError(
          error,
          conversationId,
          advancementSessionId,
        );
      }
    },
  };
}

function createAdvancementOriginalTaskSurface(input: Readonly<{
  manager: ConversationManager;
  connection: RpcConnection;
  broadcast: SessionBroadcast;
}>): AdvancementOriginalTaskSurfacePort {
  return Object.freeze({
    caller: Object.freeze({
      surfacePrincipal: rpcSurfacePrincipal(input.connection),
      connectionId: String(input.connection.id),
    }),
    turnOrigin: Object.freeze({
      channel: "rpc" as const,
      triggeredBy: String(input.connection.id),
    }),
    execute: async (turn) => {
      const managed = input.manager.getSession(turn.conversationId);
      if (!managed) {
        throw new Error(
          `Admitted Conversation runtime is missing: ${turn.conversationId}`,
        );
      }
      await runManagedTurn(
        managed,
        turn.originalUserTask,
        turn.turnId,
        input.connection,
        input.manager,
        input.broadcast,
        { postTurnControl: false },
      );
    },
    cancelPending: ({ conversationId, turnId }) => {
      input.connection.notify(SESSION_NOTIFICATIONS.complete, {
        conversationId,
        sessionId: conversationId,
        turnId,
        result: {
          reason: "error",
          error: { name: "Cancelled", message: "Pending turn cancelled" },
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      } satisfies SessionCompletePayload);
    },
    onAdmitted: ({ conversationId, runId, turnId }) => {
      notifyLifecycleDiagnostics({
        manager: input.manager,
        conversationId,
        runId: runId ?? turnId,
        connection: input.connection,
        broadcast: input.broadcast,
      });
    },
  });
}

function publishAdvancementCancellationFact(
  fact: AdvancementContractCancelledFact,
  connection: RpcConnection,
  broadcast: SessionBroadcast,
): void {
  notifyAdvancementEvent({
    conversationId: fact.conversationId,
    turnId: fact.originalTurnId,
    seq: fact.controlSeq,
    event: "advancement:contract_cancelled",
    payload: {
      advancementSessionId: fact.advancementSessionId,
      executeOriginal: fact.executeOriginal,
      ...(fact.reason ? { reason: fact.reason } : {}),
    },
    connection,
    broadcast,
  });
}

function publishAdvancementRubricConfirmationFact(
  fact: AdvancementContractConfirmedFact | AdvancementContractCancelledFact,
  connection: RpcConnection,
  broadcast: SessionBroadcast,
): void {
  if (fact.kind === "advancement-contract-cancelled") {
    publishAdvancementCancellationFact(fact, connection, broadcast);
    return;
  }
  notifyAdvancementEvent({
    conversationId: fact.conversationId,
    turnId: fact.originalTurnId,
    seq: fact.controlSeq,
    event: "advancement:contract_confirmed",
    payload: {
      advancementSessionId: fact.advancementSessionId,
      ...(fact.rubricId ? { rubricId: fact.rubricId } : {}),
    },
    connection,
    broadcast,
  });
}

function projectAdvancementRubricCancellationResult(
  result: AdvancementRubricCancellationResult,
): SessionAdvancementCancelResult {
  if (result.kind === "cancelled") {
    return {
      conversationId: result.conversationId,
      sessionId: result.conversationId,
      status: "cancelled",
      advancementSessionId: result.advancementSessionId,
    };
  }
  return {
    conversationId: result.conversationId,
    sessionId: result.conversationId,
    turnId: result.turnId,
    ...(result.runId ? { runId: result.runId } : {}),
    status: "direct-execution",
    advancementSessionId: result.advancementSessionId,
    runStatus: result.runStatus,
  };
}

type AdvancementPrepareOwnerResult =
  | AdvancementPrepareResult
  | { readonly kind: "owner-busy" };

async function prepareActiveAdvancementUserTurn(input: {
  readonly manager: ConversationManager;
  readonly advancement: NonNullable<ServerContext["advancement"]>;
  readonly conversationId: string;
  readonly turnId: string;
  readonly input: UserTurnInput;
}): Promise<
  | (Extract<
      AdvancementPrepareResult,
      { readonly kind: "active-user-turn" }
    > & {
      /** 为处理本次输入中止了正在执行的推进代理——发起端告知素材。 */
      readonly interruptedProxy: boolean;
    })
  | Extract<
      AdvancementPrepareResult,
      {
        readonly kind:
          | "active-session-taken-over"
          | "rubric-regenerated"
          | "contract-failed";
      }
    >
  | null
> {
  const active = await input.advancement.loadActiveSession(
    input.conversationId,
  );
  if (active?.status !== "active") return null;

  // active 会话的用户输入一律先过准入分类——排队与分类正交：对话正忙于
  // 普通 turn 时输入照样可能是接管 / 修正标准意图，跳过分类会让意图静默
  // 丢进闭环按旧契约续推。中断只对推进代理（outstanding / advancement
  // 在跑）执行，为用户让路；普通 turn 不受影响，消息按既有队列语义排队。
  const advancementEngaged =
    Boolean(active.outstandingProxyMessageId) ||
    input.manager.getBusySource(input.conversationId) === "advancement";
  const interruption = advancementEngaged
    ? await interruptAdvancementProxy({
        manager: input.manager,
        conversationId: input.conversationId,
        outstandingProxyMessageId: active.outstandingProxyMessageId,
      })
    : {};

  const prepared = await input.advancement.prepareUserTurn({
    conversationId: input.conversationId,
    turnId: input.turnId,
    userInput: input.input,
  });

  if (prepared.kind === "active-user-turn") {
    if (interruption.proxyMessageId) {
      await input.advancement.settleProxyMessage({
        conversationId: input.conversationId,
        advancementSessionId: active.id,
        proxyMessageId: interruption.proxyMessageId,
      });
    }
    return {
      ...prepared,
      interruptedProxy: interruption.proxyMessageId !== undefined,
    };
  }

  if (prepared.kind === "active-session-taken-over") return prepared;
  // 契约再生：旧会话已 exited（折叠即清 outstanding），新 awaiting 已建——
  // 必须放行给上层发事件与确认面，不得回落到重新分类。
  if (prepared.kind === "rubric-regenerated") return prepared;
  // 再生修订失败：旧契约保持 active，但代理已为处理用户输入被中断——
  // 必须放行给上层受控失败 + 重接，不得回落引发二次分类与二次修订。
  if (prepared.kind === "contract-failed") return prepared;
  return null;
}

async function interruptAdvancementProxy(input: {
  readonly manager: ConversationManager;
  readonly conversationId: string;
  readonly outstandingProxyMessageId?: string;
}): Promise<{ readonly proxyMessageId?: string }> {
  const cancelledPending = await input.manager.cancelPendingBySource(
    input.conversationId,
    "advancement",
  );
  const abortedInFlight =
    input.manager.getBusySource(input.conversationId) === "advancement" &&
    input.manager.abortInFlight(input.conversationId, {
      kind: "user-cancel",
      source: "rpc",
      pressedAt: Date.now(),
    });
  return cancelledPending > 0 || abortedInFlight
    ? { proxyMessageId: input.outstandingProxyMessageId }
    : {};
}

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
        : () =>
            ensureConversationShell(input.server, input.preparedConversationId),
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
  readonly turnIdentity: ConversationPreparedAgentTurnIdentity;
  readonly connectionId: string;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
  readonly server: ServerContext;
  readonly surfaceCapabilities: SessionSurfaceCapabilities;
  readonly environment?: ExplicitEnvironmentSelection;
}

async function prepareSessionSendTurnIdentity(
  server: ServerContext,
  connection: RpcConnection,
  rawTurnId: unknown,
): Promise<ConversationPreparedAgentTurnIdentity> {
  try {
    return await prepareConversationAgentTurnIdentity(
      server,
      connection,
      rawTurnId,
      rawTurnId === undefined ? "legacy-generated" : "provided",
    );
  } catch (error) {
    const mapped = sessionTurnIdentityRpcError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

async function prepareConversationAgentTurnIdentity(
  server: ServerContext,
  connection: RpcConnection,
  turnId: unknown,
  identitySource: "provided" | "legacy-generated",
): Promise<ConversationPreparedAgentTurnIdentity> {
  const productApi = requireConversationProductApi(
    server,
    CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
  );
  const dispatch = await productApi.command(
    CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
    {
      kind: "prepare-agent-turn-identity",
      ...(turnId !== undefined ? { turnId } : {}),
      identitySource,
      caller: {
        kind: "surface",
        surfacePrincipal: rpcSurfacePrincipal(connection),
        connectionId: String(connection.id),
      },
    },
  );
  return dispatch.result;
}

function sessionTurnIdentityRpcError(error: unknown): RpcAppError | undefined {
  if (!(error instanceof ConversationApplicationError)) return undefined;
  if (error.reason === "turn-identity-required") {
    return RpcErrors.invalidParams(
      "session.send requires a stable 'turnId' while durable execution is enabled",
    );
  }
  if (error.reason === "turn-identity-invalid") {
    return RpcErrors.invalidParams(
      "session.send 'turnId' must be a non-empty bounded identifier",
    );
  }
  return undefined;
}

function sessionAgentTurnAdmissionRpcError(
  error: unknown,
  conversationId: string,
): RpcAppError | undefined {
  const identityError = sessionTurnIdentityRpcError(error);
  if (identityError) return identityError;
  if (!(error instanceof ConversationApplicationError)) return undefined;
  if (error.reason === "turn-conversation-not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.reason === "turn-queue-full") {
    return new RpcAppError(
      RPC_ERROR_CODES.BUSY,
      "Too many pending messages for this conversation",
    );
  }
  if (error.reason === "turn-lifecycle-busy") {
    return RpcErrors.busy("场景正在切换或目录变更，请稍后重试。");
  }
  return undefined;
}

interface SendUserTurnInput extends SendDirectTurnInput {
  readonly engage?: SessionSendEngage;
}

async function sendUserTurn(
  input: SendUserTurnInput,
): Promise<SessionSendResult> {
  if (input.engage?.kind === "perspectives") {
    return sendPerspectiveTurn({ ...input, engage: input.engage });
  }
  return sendDirectTurn(input);
}

async function sendDirectTurn(
  input: SendDirectTurnInput,
): Promise<SessionSendResult> {
  const admitted = await admitAndMaybeStartTurn({
    server: input.server,
    manager: input.manager,
    conversationId: input.conversationId,
    preallocatedConversationId: input.preallocatedConversationId,
    connectionId: input.connectionId,
    input: input.input,
    turnIdentity: input.turnIdentity,
    connection: input.connection,
    broadcast: input.broadcast,
    surfaceCapabilities: input.surfaceCapabilities,
    ...(input.environment
      ? { environment: structuredClone(input.environment) }
      : {}),
  });
  return {
    conversationId: admitted.conversationId,
    sessionId: admitted.conversationId,
    turnId: admitted.turnId,
    ...(admitted.runId ? { runId: admitted.runId } : {}),
  };
}

async function sendPerspectiveTurn(
  input: SendDirectTurnInput & { readonly engage: SessionSendEngage },
): Promise<SessionSendResult> {
  const perspectives = input.server.perspectives;
  if (!perspectives) {
    throw RpcErrors.internal("Perspective engagement is not available.");
  }

  const admitted = await admitAndMaybeStartPerspectiveTurn({
    ...input,
    question: input.engage.question,
    perspectives,
  });
  return {
    conversationId: admitted.conversationId,
    sessionId: admitted.conversationId,
    turnId: admitted.turnId,
    ...(admitted.runId ? { runId: admitted.runId } : {}),
  };
}

interface AdmitAndMaybeStartTurnInput {
  readonly server: ServerContext;
  readonly manager: ConversationManager;
  readonly conversationId?: string;
  readonly preallocatedConversationId?: string;
  readonly connectionId: string;
  readonly input: UserTurnInput;
  readonly turnIdentity: ConversationPreparedAgentTurnIdentity;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
  readonly surfaceCapabilities: SessionSurfaceCapabilities;
  readonly environment?: ExplicitEnvironmentSelection;
  readonly admissionIdentity?: {
    readonly surfacePrincipal: string;
    readonly turnOrigin: TurnContext["turnOrigin"];
  };
}

interface AdmitAndMaybeStartPerspectiveTurnInput extends SendDirectTurnInput {
  readonly perspectives: NonNullable<ServerContext["perspectives"]>;
  readonly question: string;
}

async function admitAndMaybeStartPerspectiveTurn(
  input: AdmitAndMaybeStartPerspectiveTurnInput,
): Promise<{
  conversationId: string;
  turnId: string;
  runId?: string;
  runStatus: "immediate" | "queued";
}> {
  let admission: Awaited<ReturnType<ConversationManager["admitTurn"]>>;
  try {
    admission = await input.manager.admitTurn({
      conversationId: input.conversationId,
      createConversation: createConversationCallback(
        input.server,
        input.preallocatedConversationId,
      ),
      exists: existingConversationCheck(input.server, input.conversationId),
      connectionId: input.connectionId,
      source: "channel",
      beforeEnqueue: (managed) =>
        input.manager.admitDurableTurn({
          conversationId: managed.conversationId,
          input: input.input,
          invocation: {
            kind: "perspectives",
            source: "channel",
            question: input.question,
          },
          options: {
            turnContext: perspectiveTurnContext(input.turnId, input.connection),
            source: "channel",
            surfacePrincipal: rpcSurfacePrincipal(input.connection),
          },
          surfacePrincipal: rpcSurfacePrincipal(input.connection),
        }),
      makeTask: (managed) => {
        const task = input.perspectives.createPendingTask({
          manager: input.manager,
          managed,
          originalInput: input.input,
          question: input.question,
          turnContext: perspectiveTurnContext(input.turnId, input.connection),
          surfacePrincipal: rpcSurfacePrincipal(input.connection),
          source: "channel",
          onResult: (result) =>
            notifyPerspectiveTurnResult({
              result,
              conversationId: managed.conversationId,
              turnId: input.turnId,
              turnCount: managed.turnCount,
              connection: input.connection,
              broadcast: input.broadcast,
            }),
        });
        return {
          ...task,
          cancel: () => {
            task.cancel();
            notifyCancelledPerspectiveTurn({
              conversationId: managed.conversationId,
              turnId: input.turnId,
              connection: input.connection,
            });
          },
        };
      },
    });
  } catch (err) {
    throwWorksceneBusyAsRpc(err);
  }

  if (admission.status === "not-found") {
    throw RpcErrors.notFound(`Session not found: ${admission.conversationId}`);
  }
  if (admission.status === "full") {
    throw new RpcAppError(
      RPC_ERROR_CODES.BUSY,
      "Too many pending messages for this conversation",
    );
  }

  notifyLifecycleDiagnostics({
    manager: input.manager,
    conversationId: admission.conversationId,
    runId: admission.runId ?? input.turnId,
    connection: input.connection,
    broadcast: input.broadcast,
  });

  if (admission.status === "immediate") {
    void admission.task.execute();
  }

  return {
    conversationId: admission.conversationId,
    turnId: input.turnId,
    ...(admission.runId ? { runId: admission.runId } : {}),
    runStatus: admission.status === "replayed" ? "queued" : admission.status,
  };
}

async function admitAndMaybeStartTurn(
  input: AdmitAndMaybeStartTurnInput,
): Promise<{
  conversationId: string;
  turnId: string;
  runId?: string;
  runStatus: "immediate" | "queued";
}> {
  try {
    const productApi = requireConversationProductApi(
      input.server,
      CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
    );
    const { turnId } = input.turnIdentity;
    const turnOrigin = input.admissionIdentity?.turnOrigin ??
      rpcTurnContext(
        turnId,
        input.connection,
        input.surfaceCapabilities,
      ).turnOrigin;
    const dispatch = await productApi.command(
      CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
      {
        kind: "admit-agent-turn",
      conversationId: input.conversationId,
        ...(input.preallocatedConversationId
          ? { preallocatedConversationId: input.preallocatedConversationId }
          : {}),
        input: input.input,
        turnIdentity: input.turnIdentity,
        caller: {
          kind: "surface",
          surfacePrincipal:
            input.admissionIdentity?.surfacePrincipal ??
            rpcSurfacePrincipal(input.connection),
          connectionId: input.connectionId,
        },
        ...(turnOrigin ? { turnOrigin } : {}),
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
        execution: {
          execute: async ({ conversationId, turnId }) => {
            const managed = input.manager.getSession(conversationId);
            if (!managed) {
              throw new Error(
                `Admitted Conversation runtime is missing: ${conversationId}`,
              );
            }
            await runManagedTurn(
              managed,
              input.input,
              turnId,
              input.connection,
              input.manager,
              input.broadcast,
              input.surfaceCapabilities,
              input.environment,
            );
          },
          // 取消通知是排队发起者的私人回执,不组播——其他端没见过这条排队项
          cancelPending: ({ conversationId, turnId }) => {
          input.connection.notify(SESSION_NOTIFICATIONS.complete, {
              conversationId,
              sessionId: conversationId,
              turnId,
            result: {
              reason: "error",
              error: { name: "Cancelled", message: "Pending turn cancelled" },
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          } satisfies SessionCompletePayload);
          },
          onAdmitted: ({ conversationId, runId, turnId }) => {
            notifyLifecycleDiagnostics({
              manager: input.manager,
              conversationId,
              runId: runId ?? turnId,
              connection: input.connection,
              broadcast: input.broadcast,
            });
          },
        },
      },
    );
    const admission = dispatch.result;
    return {
      conversationId: admission.conversationId,
      turnId: admission.turnId,
      ...(admission.runId ? { runId: admission.runId } : {}),
      runStatus:
        admission.status === "replayed" ? "queued" : admission.status,
    };
  } catch (err) {
    const mapped = sessionAgentTurnAdmissionRpcError(
      err,
      input.conversationId ?? input.preallocatedConversationId ?? "unknown",
    );
    if (mapped) throw mapped;
    throw err;
  }
}

function throwWorksceneBusyAsRpc(err: unknown): never {
  if (
    err instanceof WorksceneBusyError ||
    (err instanceof Error &&
      "code" in err &&
      (err as Error & { code?: unknown }).code === "WORKSCENE_BUSY")
  ) {
    throw RpcErrors.busy("场景正在切换或目录变更，请稍后重试。");
  }
  throw err;
}

/**
 * 契约再生的统一响应：旧会话 exited（带收场）+ 新草案确认面，一回合完成。
 */
function respondRubricRegenerated(input: {
  readonly prepared: Extract<
    AdvancementPrepareResult,
    { readonly kind: "rubric-regenerated" }
  >;
  readonly turnId: string;
  readonly connectionId: string;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
  readonly manager: ConversationManager;
}): SessionAwaitingRubricResult {
  const { prepared } = input;
  input.manager.addObserver(
    prepared.session.conversationId,
    input.connectionId,
    {
      allowInactive: true,
    },
  );
  notifyAdvancementEvent({
    conversationId: prepared.exitedSession.conversationId,
    turnId: input.turnId,
    seq: 0,
    event: "advancement:exited",
    payload: {
      advancementSessionId: prepared.exitedSession.id,
      exit: prepared.exit,
      admission: prepared.admission,
      closure: prepared.closure,
    },
    connection: input.connection,
    broadcast: input.broadcast,
  });
  notifyAdvancementEvent({
    conversationId: prepared.session.conversationId,
    turnId: input.turnId,
    seq: 1,
    event: "advancement:contract_draft",
    payload: {
      advancementSessionId: prepared.session.id,
      rubricDraftId: prepared.draft.draftId,
      rubricDraft: prepared.draft,
      admission: prepared.admission,
    },
    connection: input.connection,
    broadcast: input.broadcast,
  });
  return awaitingRubricResult(
    prepared.session.conversationId,
    prepared.session.id,
    prepared.draft,
  );
}

/**
 * awaiting 结果的 turnId 单源：恒取草案的 originalTurnId——它是确认后
 * 真正执行的 turn 身份，confirm / direct / revise 的校验链都锚定它。
 * 不接受调用方传 turnId：await-existing（二次 send 命中已有草案）场景下
 * 本次 send 的 turnId 与原始 turnId 不同，取错会让确认链在客户端断裂。
 */
function awaitingRubricResult(
  conversationId: string,
  advancementSessionId: string,
  rubricDraft: RubricContractDraftSnapshot,
): SessionAwaitingRubricResult {
  return {
    conversationId,
    sessionId: conversationId,
    turnId: rubricDraft.originalTurnId,
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
  if (preallocatedConversationId) {
    return async () => {
      await ensureConversationShell(server, preallocatedConversationId);
      return preallocatedConversationId;
    };
  }
  if (!server.productApi?.supports(CONVERSATION_CREATE_COMMAND)) {
    return undefined;
  }
  return async () =>
    (
      await server.productApi!.command(CONVERSATION_CREATE_COMMAND, {
        kind: "create",
      })
    ).result.conversationId;
}

async function ensureConversationShell(
  server: ServerContext,
  conversationId: string,
): Promise<void> {
  if (!server.productApi?.supports(CONVERSATION_ENSURE_SHELL_COMMAND)) return;
  await server.productApi.command(CONVERSATION_ENSURE_SHELL_COMMAND, {
    kind: "ensure-shell",
    conversationId,
  });
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
  const envelope = createControlSessionEventEnvelope({
    conversationId: input.conversationId,
    runId: input.turnId,
    seq: input.seq ?? 0,
    event: input.event,
    payload: input.payload,
  });
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

function notifyLifecycleDiagnostics(input: {
  readonly manager: ConversationManager;
  readonly conversationId: string;
  readonly runId?: string;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
}): void {
  const diagnostics = input.manager.drainLifecycleDiagnostics(
    input.conversationId,
  );
  diagnostics.forEach((payload, seq) => {
    notifyLifecycleWarningEvent({
      conversationId: input.conversationId,
      runId: input.runId ?? "",
      seq,
      payload,
      connection: input.connection,
      broadcast: input.broadcast,
    });
  });
}

function notifyLifecycleWarningEvent(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly seq: number;
  readonly payload: AgentEventMap["lifecycle:warning"];
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
}): void {
  const envelope = createControlSessionEventEnvelope({
    conversationId: input.conversationId,
    runId: input.runId,
    seq: input.seq,
    event: "lifecycle:warning",
    payload: input.payload,
  });
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
 * 连接只拥有在线观察能力。耐久运行不随连接断开而取消；非耐久兼容
 * 路径仍沿用连接生命周期，显式取消统一由 session.abort 提交。
 */
async function runManagedTurn(
  managed: ManagedSession,
  input: UserTurnInput,
  turnId: string,
  connection: RpcConnection,
  manager: ConversationManager,
  broadcast?: SessionBroadcast,
  surfaceCapabilities: SessionSurfaceCapabilities = {
    postTurnControl: false,
  },
  environment?: ExplicitEnvironmentSelection,
): Promise<void> {
  const conversationId = managed.conversationId;
  const push = (method: string, params: unknown): void => {
    if (broadcast) broadcast(conversationId, method, params);
    else connection.notify(method, params);
  };
  const abortController = new AbortController();
  const unsubClose = manager.usesDurableTurnProtocol()
    ? () => {}
    : connection.onClose(() =>
        abortWithReason(abortController, {
          kind: "external",
          origin: "rpc-connection-close",
        }),
      );
  const turnStartedAt = new Date().toISOString();

  try {
    // RPC 入口触发的 turn 无通道 target，确认请求按连接身份定向回发起端。
    // post-turn 控制能力必须由发起端声明；RPC 本身不代表有 consumer。
    const turnContext = rpcTurnContext(
      turnId,
      connection,
      connection.closed ? { postTurnControl: false } : surfaceCapabilities,
    );
    await projectSessionTurn({
      manager,
      managed,
      input,
      turnId,
      runOptions: {
        abortSignal: abortController.signal,
        turnContext,
        surfacePrincipal: rpcSurfacePrincipal(connection),
        turnIndex: managed.turnCount,
        source: "interactive",
      },
      notify: push,
      ...(environment ? { environment } : {}),
      abortSignal: abortController.signal,
      onPostTurnControlIntent: (control) => {
        // turn 边界控制意图是可执行的控制字段,只定向发起连接——跟随权归发起
        // 接入面由结构保证(旁观端物理收不到),不靠客户端自律。先于 complete
        // 发送(同连接有序):客户端收意图暂存,收 complete(turn 落定)即消费,
        // 与 REPL 的 turn 边界消费语义对齐。
        connection.notify(SESSION_NOTIFICATIONS.postTurnControlIntent, {
          conversationId,
          turnId,
          intent: control.intent,
          ...(control.conflict ? { conflict: control.conflict } : {}),
        } satisfies SessionPostTurnControlIntentPayload);
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

function normalizeSessionEnvironment(
  value: unknown,
): ExplicitEnvironmentSelection | undefined {
  if (value === undefined) return undefined;
  try {
    return validateExplicitEnvironmentSelection(value);
  } catch (error) {
    throw RpcErrors.invalidParams(
      error instanceof Error
        ? `session.send environment is invalid: ${error.message}`
        : "session.send environment is invalid",
    );
  }
}

function perspectiveTurnContext(
  turnId: string,
  connection: RpcConnection,
): TurnContext {
  return {
    turnId,
    turnOrigin: {
      channel: "rpc",
      triggeredBy: requireRpcSurfacePrincipal(connection),
    },
  };
}

function rpcTurnContext(
  turnId: string,
  connection: RpcConnection,
  surfaceCapabilities: SessionSurfaceCapabilities,
): TurnContext {
  return {
    turnId,
    turnOrigin: {
      channel: "rpc",
      triggeredBy: String(connection.id),
      ...(surfaceCapabilities.postTurnControl
        ? {
            surface: {
              capabilities: { postTurnControl: true },
            },
          }
        : {}),
    },
  };
}

function rpcSurfacePrincipal(connection: RpcConnection): string {
  return requireRpcSurfacePrincipal(connection);
}

function notifyPerspectiveTurnResult(input: {
  readonly result: PerspectivesTurnResult;
  readonly conversationId: string;
  readonly turnId: string;
  readonly turnCount: number;
  readonly connection: RpcConnection;
  readonly broadcast?: SessionBroadcast;
}): void {
  if (input.result.status === "completed") {
    notifyPerspectiveDelta(input, {
      type: "text_delta",
      text: input.result.finalText,
    });
    notifyPerspectiveDelta(input, {
      type: "assistant_message",
      message: assistantMessage(input.result.finalText),
    });
    notifyPerspectiveDelta(input, {
      type: "turn_complete",
      turnCount: input.turnCount,
      usage: input.result.usage,
    });
    notifyPerspectiveComplete(input, {
      reason: "completed",
      message: assistantMessage(input.result.finalText),
      usage: input.result.usage,
    });
    return;
  }

  if (input.result.status === "aborted") {
    notifyPerspectiveComplete(input, {
      reason: "aborted",
      usage: input.result.usage ?? emptyUsage(),
    });
    return;
  }

  notifyPerspectiveComplete(input, {
    reason: "error",
    error: {
      name: "PerspectiveError",
      message: formatPerspectiveFailure(input.result),
    },
    usage: input.result.usage ?? emptyUsage(),
  });
}

function notifyCancelledPerspectiveTurn(input: {
  readonly conversationId: string;
  readonly turnId: string;
  readonly connection: RpcConnection;
}): void {
  input.connection.notify(SESSION_NOTIFICATIONS.complete, {
    conversationId: input.conversationId,
    sessionId: input.conversationId,
    turnId: input.turnId,
    result: {
      reason: "error",
      error: {
        name: "Cancelled",
        message: "Pending perspective turn cancelled",
      },
      usage: emptyUsage(),
    },
  } satisfies SessionCompletePayload);
}

function notifyPerspectiveDelta(
  input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly connection: RpcConnection;
    readonly broadcast?: SessionBroadcast;
  },
  delta: AgentYield,
): void {
  const payload = {
    conversationId: input.conversationId,
    sessionId: input.conversationId,
    turnId: input.turnId,
    delta,
  } satisfies SessionDeltaPayload;
  if (input.broadcast) {
    input.broadcast(input.conversationId, SESSION_NOTIFICATIONS.delta, payload);
  } else {
    input.connection.notify(SESSION_NOTIFICATIONS.delta, payload);
  }
}

function notifyPerspectiveComplete(
  input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly connection: RpcConnection;
    readonly broadcast?: SessionBroadcast;
  },
  result: SessionCompletePayload["result"],
): void {
  const payload = {
    conversationId: input.conversationId,
    sessionId: input.conversationId,
    turnId: input.turnId,
    result,
  } satisfies SessionCompletePayload;
  if (input.broadcast) {
    input.broadcast(
      input.conversationId,
      SESSION_NOTIFICATIONS.complete,
      payload,
    );
  } else {
    input.connection.notify(SESSION_NOTIFICATIONS.complete, payload);
  }
}

function formatPerspectiveFailure(
  result: Extract<PerspectivesTurnResult, { readonly status: "failed" }>,
): string {
  return `多视角评议失败（${formatPerspectiveStage(result.stage)}）：${result.message}`;
}

function formatPerspectiveStage(stage: string): string {
  switch (stage) {
    case "snapshot":
      return "上下文快照";
    case "allocation":
      return "视角分配";
    case "template":
      return "编排模板";
    case "orchestration":
      return "编排执行";
    case "convergence":
      return "最终收敛";
    case "commit":
      return "结果提交";
    default:
      return stage;
  }
}

function normalizeSessionInput(
  params: SessionSendParams,
): UserTurnInput | null {
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

function normalizeSessionEngage(value: unknown): SessionSendEngage | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams("session.send 'engage' must be an object");
  }
  const engage = value as { kind?: unknown; question?: unknown };
  if (engage.kind !== "perspectives") {
    throw RpcErrors.invalidParams(
      "session.send 'engage.kind' is not supported",
    );
  }
  if (typeof engage.question !== "string") {
    throw RpcErrors.invalidParams(
      "session.send 'engage.question' must be a string",
    );
  }
  const question = engage.question.trim();
  if (question.length === 0) {
    throw RpcErrors.invalidParams(
      "session.send 'engage.question' must not be empty",
    );
  }
  return { kind: "perspectives", question };
}

function normalizeSurfaceCapabilities(
  value: unknown,
): SessionSurfaceCapabilities {
  if (value === undefined) return { postTurnControl: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RpcErrors.invalidParams(
      "session.send 'surfaceCapabilities' must be an object",
    );
  }
  return {
    postTurnControl:
      (value as { postTurnControl?: unknown }).postTurnControl === true,
  };
}

function hasProvidedSessionInput(
  params: SessionSendParams,
  key: "text" | "input",
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(params, key) &&
    params[key] !== undefined
  );
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_LIST_QUERY,
      );
      const view = await productApi.query(CONVERSATION_LIST_QUERY, {
        kind: "list",
      });
      return {
        conversations: view.conversations.map(projectConversationEntry),
        ...(view.availability ? { availability: view.availability } : {}),
      };
    },
  };
}

// ─── session.advancementDetail ───

/**
 * 推进详情查询——归因块「可展开」的数据面。open 会话给当前状态与最近
 * 一轮验收全量；无 open 给最新终态会话（收场回看）；领域应用从
 * Advancement owner 的已持久化投影随查形成 closure facts。
 */
export function buildSessionAdvancementDetailMethod(): MethodEntry {
  return {
    name: "session.advancementDetail",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionAdvancementDetailResult> {
      const params = (rawParams ?? {}) as ConversationIdParams;
      const conversationId = validateConversationId(
        params.conversationId ?? params.sessionId,
        "session.advancementDetail",
      );
      const productApi = ctx.server.productApi;
      if (!productApi?.supports(ADVANCEMENT_DETAIL_QUERY)) {
        return { conversationId, detail: null };
      }
      const detail = await productApi.query(ADVANCEMENT_DETAIL_QUERY, {
        conversationId,
      });
      return {
        conversationId,
        detail: projectAdvancementDetail(detail),
      };
    },
  };
}

function projectAdvancementDetail(
  detail: AdvancementDetailProjection | null,
): SessionAdvancementDetailResult["detail"] {
  if (!detail) return null;
  return {
    advancementSessionId: detail.advancementSessionId,
    status: detail.status,
    rubricTitle: detail.rubricTitle,
    exit: detail.exit,
    facts: detail.facts,
    ...(detail.lastReview ? { lastReview: detail.lastReview } : {}),
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
        throw RpcErrors.invalidParams(
          "session.history requires 'conversationId'",
        );
      }
      if (params.limit !== undefined) {
        if (typeof params.limit !== "number") {
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_HISTORY_QUERY,
      );
      try {
        return await productApi.query(CONVERSATION_HISTORY_QUERY, {
          kind: "history",
          conversationId: id,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.before ? { before: params.before } : {}),
        });
      } catch (error) {
        throw mapConversationApplicationError(error, "history", id);
      }
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
        throw RpcErrors.invalidParams(
          "session.rename requires 'conversationId'",
        );
      }
      if (typeof params.name !== "string") {
        throw RpcErrors.invalidParams(
          "session.rename requires non-empty 'name'",
        );
      }
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_RENAME_COMMAND,
      );
      let dispatch;
      try {
        dispatch = await productApi.command(CONVERSATION_RENAME_COMMAND, {
          kind: "rename",
          conversationId: params.conversationId,
          name: params.name,
        });
      } catch (error) {
        throw mapConversationApplicationError(
          error,
          "rename",
          params.conversationId,
        );
      }
      const renamed = dispatch.result;
      // 会话级变更组播——observer 名册在 conversation 身份层,因此已落盘但
      // 未激活 runtime 的当前对话也能收到 run 外变更。
      ctx.server.sessionBroadcast?.(
        params.conversationId,
        SESSION_NOTIFICATIONS.changed,
        {
          conversationId: renamed.fact.conversationId,
          change: "renamed",
          name: renamed.fact.name,
        } satisfies SessionChangedPayload,
      );
      // 返回入参全域键——目录契约返回库内身份(场景对话是 localId),
      // 全域键(ws: 前缀)由 RPC 层保持,断键即断静态归属路由
      return {
        conversationId: renamed.conversationId,
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
  requestId?: unknown;
  runId?: unknown;
}

export function buildSessionAbortMethod(): MethodEntry {
  return {
    name: "session.abort",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<void> {
      const params = (rawParams ?? {}) as SessionAbortParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams(
          "session.abort requires 'conversationId'",
        );
      }
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_ABORT_COMMAND,
      );
      try {
        await productApi.command(CONVERSATION_ABORT_COMMAND, {
          kind: "abort",
          conversationId: id,
          ...(params.requestId !== undefined
            ? { operationId: params.requestId as string }
            : {}),
          ...(params.runId !== undefined
            ? { runId: params.runId as string }
            : {}),
          caller: conversationControlCaller(ctx),
        });
      } catch (error) {
        throw mapConversationRunControlError(error, "abort", id);
      }
    },
  };
}

interface SessionResolveParams {
  requestId: unknown;
  conversationId: unknown;
  runId: unknown;
  ownerEpoch: unknown;
  openFactDigest: unknown;
  decision: unknown;
}

export function buildSessionResolveMethod(): MethodEntry {
  return {
    name: "session.resolve",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = parseSessionResolveParams(rawParams);
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
      );
      try {
        const dispatch = await productApi.command(
          CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
          {
            kind: "resolve-uncertain",
            conversationId: params.conversationId,
            runId: params.runId,
            operationId: params.requestId,
            ownerEpoch: params.ownerEpoch,
            openFactDigest: params.openFactDigest,
            decision: params.decision,
            caller: conversationControlCaller(ctx),
          },
        );
        return dispatch.result;
      } catch (error) {
        throw mapConversationRunControlError(
          error,
          "resolve",
          params.conversationId,
        );
      }
    },
  };
}

function parseSessionResolveParams(raw: unknown): {
  requestId: string;
  conversationId: string;
  runId: string;
  ownerEpoch: number;
  openFactDigest: string;
  decision:
    | "user-verified-side-effects"
    | "user-abandoned"
    | "user-retry-acknowledged";
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw RpcErrors.invalidParams("session.resolve params must be an object");
  }
  const value = raw as unknown as SessionResolveParams &
    Record<string, unknown>;
  const fields = [
    "requestId",
    "conversationId",
    "runId",
    "ownerEpoch",
    "openFactDigest",
    "decision",
  ];
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in value)) ||
    !isProtocolIdentifier(value.requestId) ||
    !isProtocolIdentifier(value.conversationId) ||
    !isProtocolIdentifier(value.runId) ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    (value.ownerEpoch as number) < 0 ||
    typeof value.openFactDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.openFactDigest) ||
    !new Set([
      "user-verified-side-effects",
      "user-abandoned",
      "user-retry-acknowledged",
    ]).has(String(value.decision))
  ) {
    throw RpcErrors.invalidParams("session.resolve params are invalid");
  }
  return value as ReturnType<typeof parseSessionResolveParams>;
}

function conversationControlCaller(
  ctx: Parameters<MethodEntry["handler"]>[1],
) {
  const surfacePrincipal = rpcSurfacePrincipal(ctx.connection);
  const connectionId = String(ctx.connection.id);
  if (
    !isProtocolIdentifier(surfacePrincipal) ||
    !isProtocolIdentifier(connectionId)
  ) {
    throw RpcErrors.invalidParams(
      "authenticated conversation identity is invalid",
    );
  }
  return {
    kind: "surface" as const,
    surfacePrincipal,
    connectionId,
  };
}

// ─── session.delete ───

interface SessionDeleteParams {
  conversationId?: string;
  /** @deprecated */
  sessionId?: string;
  requestId?: unknown;
}

export function buildSessionDeleteMethod(): MethodEntry {
  return {
    name: "session.delete",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<void> {
      const params = (rawParams ?? {}) as SessionDeleteParams;
      const id = params.conversationId ?? params.sessionId;
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams(
          "session.delete requires 'conversationId'",
        );
      }
      if (
        params.requestId !== undefined &&
        (!isProtocolIdentifier(params.requestId) ||
          params.requestId.trim().length === 0)
      ) {
        throw RpcErrors.invalidParams("session.delete request identity is invalid");
      }
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_DELETE_COMMAND,
      );
      try {
        await productApi.command(CONVERSATION_DELETE_COMMAND, {
          kind: "delete",
          conversationId: id,
          ...(params.requestId !== undefined
            ? { operationId: params.requestId }
            : {}),
          caller: {
            kind: "surface",
            surfacePrincipal: rpcSurfacePrincipal(ctx.connection),
            connectionId: String(ctx.connection.id),
          },
        });
      } catch (error) {
        throw mapConversationDeleteApplicationError(error, id);
      }
    },
  };
}

// ─── session.subscribe / unsubscribe ───

interface SessionSubscribeParams {
  conversationId?: string;
  afterCommitRevision?: number;
}

/**
 * 订阅即 observer 登记——同一名册承担 grace 管理与事件分发(delta / complete /
 * session.event / session.changed 全部按名册组播)。中途加入不回放流式增量；
 * 已提交 final 及其逐项 publish 结果按 owner revision 从耐久事实补读。
 */
export function buildSessionSubscribeMethod(): MethodEntry {
  return {
    name: "session.subscribe",
    requiresAuth: true,
    async handler(rawParams, ctx): Promise<SessionSubscribeResult> {
      const params = (rawParams ?? {}) as SessionSubscribeParams;
      if (
        typeof params.conversationId !== "string" ||
        Object.keys(params).some(
          (key) => key !== "conversationId" && key !== "afterCommitRevision",
        ) ||
        (params.afterCommitRevision !== undefined &&
          (!Number.isSafeInteger(params.afterCommitRevision) ||
            params.afterCommitRevision < 0))
      ) {
        throw RpcErrors.invalidParams(
          "session.subscribe requires a conversationId and optional non-negative revision",
        );
      }
      const manager = requireConversations(ctx.server);
      const active = manager.has(params.conversationId);
      const exists =
        active ||
        (await queryConversationIdentityExists(
          ctx.server,
          params.conversationId,
        ));
      if (!exists) return { subscribed: false };

      // observer 是 conversation 身份层名册;已落盘但未激活 runtime 的当前对话
      // 也必须能收到 rename/delete/clear 这类 run 外变更。
      const subscribed = manager.addObserver(
        params.conversationId,
        String(ctx.connection.id),
        { allowInactive: true },
      );
      if (subscribed) {
        const history = await ctx.server.runtimeControl?.conversationFinalHistory?.(
          params.conversationId,
          params.afterCommitRevision ?? 0,
        ) ?? [];
        for (const item of history) {
          ctx.connection.notify(SESSION_NOTIFICATIONS.final, item.frame);
          for (const notice of item.publishResults) {
            ctx.connection.notify(
              SESSION_NOTIFICATIONS.event,
              createControlSessionEventEnvelope({
                conversationId: notice.conversationId,
                runId: notice.runId,
                seq: notice.seq,
                event: "publish:result",
                payload: notice,
              }),
            );
          }
        }
      }
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
  requestId?: unknown;
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
        throw RpcErrors.invalidParams(
          "session.clear requires 'conversationId'",
        );
      }
      const id = params.conversationId;
      const manager = requireConversations(ctx.server);
      if (
        params.requestId !== undefined &&
        (!isProtocolIdentifier(params.requestId) ||
          params.requestId.trim().length === 0)
      ) {
        throw RpcErrors.invalidParams("session.clear request identity is invalid");
      }
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_CLEAR_COMMAND,
      );
      try {
        await productApi.command(CONVERSATION_CLEAR_COMMAND, {
          kind: "clear",
          conversationId: id,
          ...(params.requestId !== undefined
            ? { operationId: params.requestId }
            : {}),
          caller: {
            kind: "surface",
            surfacePrincipal: rpcSurfacePrincipal(ctx.connection),
            connectionId: String(ctx.connection.id),
          },
        });
      } catch (error) {
        throw mapConversationClearApplicationError(error, id);
      }

      notifyLifecycleDiagnostics({
        manager,
        conversationId: id,
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_COMPACT_COMMAND,
      );
      let result: SessionCompactResult;
      try {
        const dispatch = await productApi.command(
          CONVERSATION_COMPACT_COMMAND,
          { kind: "compact", conversationId },
        );
        result = dispatch.result;
      } catch (error) {
        throw mapConversationCompactApplicationError(error, conversationId);
      }
      const manager = requireConversations(ctx.server);
      notifyLifecycleDiagnostics({
        manager,
        conversationId,
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });
      return result;
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_CONTEXT_BUDGET_QUERY,
      );
      let result: SessionContextBudgetResult;
      try {
        result = await productApi.query(
          CONVERSATION_CONTEXT_BUDGET_QUERY,
          { kind: "context-budget", conversationId },
        );
      } catch (error) {
        throw mapConversationUsageApplicationError(
          error,
          "context-budget",
          conversationId,
        );
      }
      const manager = requireConversations(ctx.server);
      notifyLifecycleDiagnostics({
        manager,
        conversationId,
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });
      return result;
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_USAGE_QUERY,
      );
      let result: SessionUsageResult;
      try {
        result = await productApi.query(CONVERSATION_USAGE_QUERY, {
          kind: "usage",
          conversationId,
        });
      } catch (error) {
        throw mapConversationUsageApplicationError(
          error,
          "usage",
          conversationId,
        );
      }
      const manager = requireConversations(ctx.server);
      notifyLifecycleDiagnostics({
        manager,
        conversationId,
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });
      return result;
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_SECURITY_QUERY,
      );
      let result: SessionSecurityResult;
      try {
        result = await productApi.query(CONVERSATION_SECURITY_QUERY, {
          kind: "security",
          conversationId,
        });
      } catch (error) {
        throw mapConversationSecurityApplicationError(error, conversationId);
      }
      const manager = requireConversations(ctx.server);
      notifyLifecycleDiagnostics({
        manager,
        conversationId,
        connection: ctx.connection,
        broadcast: ctx.server.sessionBroadcast,
      });
      return result;
    },
  };
}

// ─── session.taskListUpdate ───

interface SessionTaskListUpdateParams {
  conversationId?: string;
  action?: SessionTaskListAction;
}

/** /task new·done wire binding; Conversation owns the application decision. */
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_UPDATE_TASK_LIST_COMMAND,
      );
      try {
        const dispatch = await productApi.command(
          CONVERSATION_UPDATE_TASK_LIST_COMMAND,
          {
            kind: "update-task-list",
            conversationId,
            action,
          },
        );
        const fact = dispatch.facts[0];
        if (fact) {
          ctx.server.sessionBroadcast?.(
            conversationId,
            SESSION_NOTIFICATIONS.changed,
            {
              conversationId: fact.conversationId,
              change: "taskList",
              taskList: fact.taskList,
            } satisfies SessionChangedPayload,
          );
        }
        return dispatch.result;
      } catch (error) {
        throw mapConversationTaskListApplicationError(error, conversationId);
      }
    },
  };
}

// ─── session.taskList ───

interface SessionTaskListParams {
  conversationId?: string;
}

/** task_list wire query; Conversation owns the authoritative projection. */
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_TASK_LIST_QUERY,
      );
      try {
        return await productApi.query(CONVERSATION_TASK_LIST_QUERY, {
          kind: "task-list",
          conversationId: params.conversationId,
        });
      } catch (error) {
        throw mapConversationTaskListApplicationError(
          error,
          params.conversationId,
        );
      }
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
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_CREATE_COMMAND,
      );
      const created = await productApi.command(CONVERSATION_CREATE_COMMAND, {
        kind: "create",
      });
      return created.result;
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
        throw RpcErrors.invalidParams(
          "session.resume requires 'conversationId'",
        );
      }
      const manager = requireConversations(ctx.server);
      // 先入组播名册再恢复——恢复期的推进事件（proxy_recovered /
      // recovery_failed / 补审结果）必须对触发 resume 的这个用户可见；
      // 订阅若留给客户端事后补做，事件恒早于订阅、知情面必然丢失。
      const connectionId = String(ctx.connection.id);
      const alreadyObserved = manager
        .getObserverConnectionIds(params.conversationId)
        .has(connectionId);
      const observerAdded = manager.addObserver(
        params.conversationId,
        connectionId,
        { allowInactive: true },
      );
      const productApi = requireConversationProductApi(
        ctx.server,
        CONVERSATION_RESUME_COMMAND,
      );
      try {
        const dispatch = await productApi.command(CONVERSATION_RESUME_COMMAND, {
          kind: "resume",
          conversationId: params.conversationId,
          caller: {
            kind: "surface",
            surfacePrincipal: rpcSurfacePrincipal(ctx.connection),
            connectionId,
          },
        });
        const resumed = dispatch.result;
        return {
          conversationId: resumed.conversationId,
          name: resumed.name,
          active: resumed.active,
          busy: resumed.busy,
          ...(resumed.advancement
            ? { advancement: resumed.advancement }
            : {}),
          ...(resumed.adoptionReview
            ? { adoptionReview: resumed.adoptionReview }
            : {}),
        } satisfies SessionResumeResult;
      } catch (error) {
        if (
          error instanceof ConversationApplicationError &&
          error.code === "not-found" &&
          observerAdded &&
          !alreadyObserved
        ) {
          manager.removeObserver(params.conversationId, connectionId);
        }
        throw mapConversationResumeApplicationError(
          error,
          params.conversationId,
        );
      }
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

/** 「确认你所见」协议边界：confirm 必须携带发起端所见草案版本。 */
function requireRubricDraftId(
  params: SessionAdvancementActionParams,
  method: string,
): string {
  if (
    typeof params.rubricDraftId !== "string" ||
    params.rubricDraftId.trim().length === 0
  ) {
    throw RpcErrors.invalidParams(
      `${method} requires non-empty 'rubricDraftId'`,
    );
  }
  return params.rubricDraftId;
}

function parseRubricPersistence(
  params: SessionAdvancementActionParams,
  method: string,
): SessionRubricPersistenceChoice | undefined {
  const raw = params.rubricPersistence;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw RpcErrors.invalidParams(`${method} has invalid 'rubricPersistence'`);
  }
  const value = raw as Record<string, unknown>;
  if (value.kind === "save-new") {
    return { kind: "save-new" };
  }
  if (value.kind === "update-existing") {
    if (typeof value.rubricId !== "string" || !value.rubricId.trim()) {
      throw RpcErrors.invalidParams(
        `${method} requires non-empty 'rubricPersistence.rubricId'`,
      );
    }
    return { kind: "update-existing", rubricId: value.rubricId };
  }
  throw RpcErrors.invalidParams(
    `${method} has invalid 'rubricPersistence.kind'`,
  );
}

export async function loadAdvancementState(
  server: ServerContext,
  conversationId: string,
): Promise<SessionAdvancementStateSnapshot | undefined> {
  const session = await server.advancement?.loadActiveSession(conversationId);
  if (!session) return undefined;
  return projectAdvancementState(session);
}

function projectAdvancementState(
  session: AdvancementSession,
): SessionAdvancementStateSnapshot | undefined {
  if (
    session.status !== "awaiting-rubric-confirmation" &&
    session.status !== "active"
  ) {
    return undefined;
  }
  const lastReview = session.runs[session.runs.length - 1];
  return {
    advancementSessionId: session.id,
    status: session.status,
    rubricTitle:
      session.confirmedRubric?.title ?? session.pendingRubricDraft?.title,
    rubricDraftId: session.pendingRubricDraft?.draftId,
    // awaiting 的接入面半边靠它重建确认面——持久化不等于可见性，
    // 快照必须携带草案全文，接入面才能主动浮现待确认任务。
    ...(session.status === "awaiting-rubric-confirmation" &&
    session.pendingRubricDraft
      ? { pendingRubricDraft: session.pendingRubricDraft }
      : {}),
    outstandingProxyMessageId: session.outstandingProxyMessageId,
    ...(lastReview
      ? {
          lastReview: {
            id: lastReview.id,
            runIndex: lastReview.runIndex,
            round: session.runs.length,
            decision: lastReview.decision,
            reviewedAt: lastReview.reviewedAt,
          },
        }
      : {}),
  };
}

function requireUserFeedback(
  params: SessionAdvancementReviseParams,
  method: string,
): string {
  if (
    typeof params.userFeedback !== "string" ||
    params.userFeedback.trim().length === 0
  ) {
    throw RpcErrors.invalidParams(
      `${method} requires non-empty 'userFeedback'`,
    );
  }
  return params.userFeedback.trim();
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
  if (!server.productApi?.supports(CONVERSATION_IDENTITY_EXISTS_QUERY)) {
    return undefined;
  }
  return () => queryConversationIdentityExists(server, conversationId);
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

function requireConversationProductApi(
  server: ServerContext,
  descriptor: ProductApiOperationDescriptor,
): NonNullable<ServerContext["productApi"]> {
  if (!server.productApi?.supports(descriptor)) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "ConversationDirectory not configured on server",
    );
  }
  return server.productApi;
}

function requireAdvancementProductApi(
  server: ServerContext,
  descriptor: ProductApiOperationDescriptor,
): NonNullable<ServerContext["productApi"]> {
  if (!server.productApi?.supports(descriptor)) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "AdvancementController not configured on server",
    );
  }
  return server.productApi;
}

function mapAdvancementRubricRevisionError(
  error: unknown,
  conversationId: string,
  advancementSessionId: string,
): unknown {
  if (!(error instanceof AdvancementApplicationError)) return error;
  if (error.code === "conversation-not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "conversation-busy") {
    return RpcErrors.busy(
      "Conversation is busy; revise the Rubric after the current turn completes",
    );
  }
  const sessionId = error.advancementSessionId ?? advancementSessionId;
  if (error.code === "advancement-session-not-found") {
    return new Error(`AdvancementController: session "${sessionId}" not found`);
  }
  if (error.code === "not-awaiting-rubric-confirmation") {
    return new Error(
      `AdvancementController: session "${sessionId}" is not awaiting rubric confirmation`,
    );
  }
  if (error.code === "pending-rubric-draft-missing") {
    return new Error(
      `AdvancementController: session "${sessionId}" has no pending rubric draft`,
    );
  }
  return new Error(error.message);
}

function mapAdvancementRubricConfirmationError(
  error: unknown,
  conversationId: string,
  advancementSessionId: string,
): unknown {
  const admissionError = sessionAgentTurnAdmissionRpcError(
    error,
    conversationId,
  );
  if (admissionError) return admissionError;
  if (!(error instanceof AdvancementApplicationError)) return error;
  if (error.code === "conversation-not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "conversation-busy") {
    return RpcErrors.busy(
      "Conversation is busy; confirm the Rubric after the current turn completes",
    );
  }
  const sessionId = error.advancementSessionId ?? advancementSessionId;
  if (error.code === "advancement-session-not-found") {
    return new Error(`AdvancementController: session "${sessionId}" not found`);
  }
  if (error.code === "not-awaiting-rubric-confirmation") {
    return new Error(
      `AdvancementController: session "${sessionId}" is not awaiting rubric confirmation`,
    );
  }
  if (error.code === "pending-rubric-draft-missing") {
    return new Error(
      `AdvancementController: session "${sessionId}" has no pending rubric draft`,
    );
  }
  return new Error(error.message);
}

function mapAdvancementRubricCancellationError(
  error: unknown,
  conversationId: string,
  advancementSessionId: string,
): unknown {
  const admissionError = sessionAgentTurnAdmissionRpcError(
    error,
    conversationId,
  );
  if (admissionError) return admissionError;
  if (!(error instanceof AdvancementApplicationError)) return error;
  if (error.code === "conversation-not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "conversation-busy") {
    return RpcErrors.busy(
      "Conversation is busy; cancel the Rubric after the current turn completes",
    );
  }
  const sessionId = error.advancementSessionId ?? advancementSessionId;
  if (error.code === "advancement-session-not-found") {
    return new Error(`AdvancementController: session "${sessionId}" not found`);
  }
  if (error.code === "not-awaiting-rubric-confirmation") {
    return new Error(
      `AdvancementController: session "${sessionId}" is not awaiting rubric confirmation`,
    );
  }
  return new Error(error.message);
}

async function queryConversationIdentityExists(
  server: ServerContext,
  conversationId: string,
): Promise<boolean> {
  if (!server.productApi?.supports(CONVERSATION_IDENTITY_EXISTS_QUERY)) {
    return false;
  }
  return (
    await server.productApi.query(CONVERSATION_IDENTITY_EXISTS_QUERY, {
      kind: "identity-exists",
      conversationId,
    })
  ).exists;
}

function projectConversationEntry(
  entry: ConversationDirectoryEntry,
): SessionConversationEntry {
  return {
    conversationId: entry.conversationId,
    name: entry.name,
    createdAt: entry.createdAt,
    lastActiveAt: entry.lastActiveAt,
    active: entry.active,
    busy: entry.busy,
    observerCount: entry.observerCount,
    pendingCount: entry.pendingCount,
    ...(entry.advancement ? { advancement: entry.advancement } : {}),
  };
}

function mapConversationApplicationError(
  error: unknown,
  operation: "history" | "rename",
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (operation === "rename") {
    return RpcErrors.invalidParams(
      "session.rename requires non-empty 'name'",
    );
  }
  if (error.message.includes("cursor")) {
    return RpcErrors.invalidParams(
      "session.history 'before' must be { shardId: string, runIndex: number }",
    );
  }
  return RpcErrors.invalidParams(
    "session.history 'limit' must be a positive integer",
  );
}

function mapConversationTaskListApplicationError(
  error: unknown,
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "busy") {
    return new RpcAppError(
      RPC_ERROR_CODES.BUSY,
      "Conversation has an in-flight turn or maintenance operation; update tasks after it completes",
    );
  }
  return RpcErrors.invalidParams(
    "session.taskListUpdate requires 'action' of kind add{content} or done{token}",
  );
}

function mapConversationCompactApplicationError(
  error: unknown,
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "busy") {
    return new RpcAppError(
      RPC_ERROR_CODES.BUSY,
      "Conversation has an in-flight turn; compact after it completes",
    );
  }
  if (error.code === "unsupported") {
    return new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Runtime does not support manual compaction",
    );
  }
  return RpcErrors.invalidParams("session.compact requires 'conversationId'");
}

function mapConversationUsageApplicationError(
  error: unknown,
  operation: "context-budget" | "usage",
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "unsupported") {
    return new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      operation === "context-budget"
        ? "Runtime does not support context budget inspection"
        : "Runtime does not support usage inspection",
    );
  }
  return RpcErrors.invalidParams(
    operation === "context-budget"
      ? "session.contextBudget requires 'conversationId'"
      : "session.usage requires 'conversationId'",
  );
}

function mapConversationSecurityApplicationError(
  error: unknown,
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "unsupported") {
    return new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "Runtime does not support security inspection",
    );
  }
  return RpcErrors.invalidParams(
    "session.security requires 'conversationId'",
  );
}

function mapConversationRunControlError(
  error: unknown,
  operation: "abort" | "resolve",
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (operation === "abort") {
    if (error.code === "not-found") {
      return RpcErrors.notFound(
        `Session not found or no in-flight turn / pending message: ${conversationId}`,
      );
    }
    switch (error.reason) {
      case "abort-run-without-operation":
        return RpcErrors.invalidParams(
          "session.abort requires 'requestId' when 'runId' is present",
        );
      case "abort-operation-required":
        return RpcErrors.invalidParams(
          "session.abort requires a stable 'requestId' while durable execution is enabled",
        );
      case "abort-run-required":
        return RpcErrors.invalidParams(
          "session.abort requires an authoritative 'runId' while durable execution is enabled",
        );
      case "control-identity-invalid":
      case "surface-caller-invalid":
        return RpcErrors.invalidParams(
          "session.abort control identity is invalid",
        );
      default:
        return RpcErrors.invalidParams(error.message);
    }
  }
  return RpcErrors.invalidParams("session.resolve params are invalid");
}

function mapConversationResumeApplicationError(
  error: unknown,
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  return RpcErrors.invalidParams(
    "session.resume requires non-empty 'conversationId'",
  );
}

function mapConversationClearApplicationError(
  error: unknown,
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "busy") {
    return new RpcAppError(RPC_ERROR_CODES.BUSY, error.message);
  }
  return RpcErrors.invalidParams(
    error.message.includes("stable operation")
      ? "session.clear requires a stable 'requestId' while durable execution is enabled"
      : "session.clear request identity is invalid",
  );
}

function mapConversationDeleteApplicationError(
  error: unknown,
  conversationId: string,
): unknown {
  if (!(error instanceof ConversationApplicationError)) return error;
  if (error.code === "not-found") {
    return RpcErrors.notFound(`Session not found: ${conversationId}`);
  }
  if (error.code === "busy") {
    return new RpcAppError(RPC_ERROR_CODES.BUSY, error.message);
  }
  return RpcErrors.invalidParams(
    error.message.includes("stable operation")
      ? "session.delete requires a stable 'requestId' while durable execution is enabled"
      : "session.delete request identity is invalid",
  );
}
