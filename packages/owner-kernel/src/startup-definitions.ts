/** Fixed owner-domain projection definitions, without constructing a runtime. */
export { registerControlAdmissionProjection, registerConversationIdentityProjection } from "./control-admission.js";
export { registerScheduleAuthorityProjection, SCHEDULE_AUTHORITY_PROJECTION_ID } from "./global-mutation-commit-coordinator.js";
export { registerJobPublishPendingProjection } from "./scheduler-job-commit.js";
export { registerDeferredIntentProjection } from "./deferred-global-intents.js";
export { registerConversationReadProjection } from "./conversation-read-index.js";
export { registerConversationRecoveryProjection } from "./conversation-recovery-index.js";
export { registerConversationRunProjection } from "./conversation-run-state-index.js";
export { registerConversationTransferProjection } from "./conversation-transfer.js";
