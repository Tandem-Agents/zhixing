/** Fixed executor-domain projection definition, without starting an executor. */
export { registerExecutorJobRecoveryProjection } from "./assignment-ledger.js";
export { dataPlaneTicketProjectionId, registerDataPlaneTicketProjection } from "./data-plane-ticket-registry.js";
export { leaseClockProjectionId, registerLeaseClockProjection } from "./assignment-lease-clock.js";
export { ASSIGNMENT_LEDGER_INDEX_ID, registerAssignmentLedgerIndex } from "./assignment-ledger-index.js";
