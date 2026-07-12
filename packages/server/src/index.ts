/**
 * @zhixing/server — 知行常驻服务网关
 *
 * 对外兼容入口；网关装配、RPC 投影与 owner 内核在内部保持单向依赖。
 */

export * from "./rpc/protocol.js";
export * from "./rpc/connection.js";
export * from "./rpc/dispatcher.js";
export * from "./rpc/handlers.js";
export * from "./rpc/methods/index.js";
export {
  CONFIRMATION_NOTIFICATIONS,
  SESSION_NOTIFICATIONS,
  createActivityBroadcast,
  createConfirmationBridge,
  createControlSessionEventEnvelope,
  createEventBridge,
  createObserverBroadcast,
  createRunEventForwarder,
  toWireAgentResult,
  type ConfirmationBridge,
  type ConfirmationBridgeDeps,
  type ControlSessionEventInput,
  type DisposeBridge,
  type EventBridgeDeps,
  type RunEventSource,
  type SessionAcceptedSendResult,
  type SessionActivityBroadcast,
  type SessionActivityPayload,
  type SessionAdvancementCancelResult,
  type SessionAdvancementConfirmResult,
  type SessionAdvancementDetailResult,
  type SessionAdvancementReviseResult,
  type SessionAdvancementStateSnapshot,
  type SessionAwaitingRubricResult,
  type SessionBroadcast,
  type SessionCancelledRubricResult,
  type SessionChangedPayload,
  type SessionClearResult,
  type SessionCompactResult,
  type SessionCompletePayload,
  type SessionContextBudgetResult,
  type SessionContractFailedResult,
  type SessionConversationEntry,
  type SessionDeltaPayload,
  type SessionEventBroadcast,
  type SessionEventEnvelope,
  type SessionEventLifecycle,
  type SessionEventScope,
  type SessionListResult,
  type SessionNewResult,
  type SessionPostTurnControlIntentPayload,
  type SessionRenameResult,
  type SessionResumeResult,
  type SessionRubricPersistenceChoice,
  type SessionSecurityResult,
  type SessionSendEngage,
  type SessionSendResult,
  type SessionSubscribeResult,
  type SessionTaskListAction,
  type SessionTaskListResult,
  type SessionTaskListUpdateResult,
  type SessionUnsubscribeResult,
  type SessionUsageResult,
  type WireAgentError,
  type WireAgentResult,
  type WorksceneEnterResult,
  type WorksceneListResult,
  type WorksceneSummary,
} from "@zhixing/rpc/server-compat";
export * from "./runtime/index.js";
export * from "./system-handlers.js";
export * from "./paths.js";
export * from "./server-log.js";
export * from "./server-log-activation.js";
export * from "./server-log-lifecycle.js";
export * from "./process-lock.js";
export * from "./server-state.js";
export * from "./cleanup-registry.js";
export * from "./lifecycle.js";
export * from "./client/index.js";
export * from "./types.js";
export * from "./context.js";
export * from "./server.js";
export * from "./channels/index.js";
export * from "./confirmation/index.js";
export * from "./advancement/index.js";
export * from "./perspectives/index.js";
export * from "./intent/index.js";
