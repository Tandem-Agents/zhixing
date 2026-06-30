import type { RunRecordRef } from "../transcript/shard/types.js";
export type { RunRecordAdvancementMetadata } from "../transcript/types.js";
import type { UserTurnInput } from "../types/user-input.js";

export type AdvancementSessionStatus =
  | "awaiting-rubric-confirmation"
  | "active"
  | "completed"
  | "exited"
  | "cancelled";

export type ObjectiveSignalKind =
  | "file-diff"
  | "test-result"
  | "build-result"
  | "log"
  | "artifact"
  | "conversation-fact"
  | "none";

export interface EvidenceRequirementSpec {
  readonly id: string;
  readonly kind: ObjectiveSignalKind;
  readonly description: string;
  readonly required?: boolean;
}

export interface FailureHandlingSpec {
  readonly id: string;
  readonly scenario: string;
  readonly reply: string;
}

export interface RubricContractContentSnapshot {
  readonly passCriteria: readonly string[];
  readonly evidenceRequirements?: readonly EvidenceRequirementSpec[];
  readonly failureHandling: readonly FailureHandlingSpec[];
}

export type RubricContractSource = "matched" | "generated";

export interface RubricContractDraftSnapshot {
  readonly draftId: string;
  readonly originalTurnId: string;
  readonly source: RubricContractSource;
  readonly candidateRubricIds: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly content: RubricContractContentSnapshot;
  readonly createdAt: string;
}

export interface ConfirmedRubricSnapshot {
  readonly rubricId: string;
  readonly rubricVersion: string;
  readonly title: string;
  readonly description: string;
  readonly content: RubricContractContentSnapshot;
  readonly confirmedAt: string;
  readonly confirmedBy: "user";
}

export type AdvancementReviewDecision = "passed" | "failed" | "exit";

export interface ReviewEvidence {
  readonly id: string;
  readonly kind: ObjectiveSignalKind;
  readonly summary: string;
  readonly requirementId?: string;
  readonly source?: "independent" | "execution-report" | "user";
  readonly passed?: boolean;
  readonly refs?: readonly string[];
}

export type AdvancementExitReason =
  | "passed"
  | "dead-end"
  | "user-cancelled"
  | "user-took-over"
  | "superseded"
  | "system-error";

export interface AdvancementExit {
  readonly reason: AdvancementExitReason;
  readonly message: string;
  readonly occurredAt: string;
}

export interface AdvancementRunReview {
  readonly id: string;
  readonly runIndex: number;
  readonly runRecordRef?: RunRecordRef;
  readonly reviewedAt: string;
  readonly decision: AdvancementReviewDecision;
  readonly evidence: readonly ReviewEvidence[];
  readonly unmetCriteria: readonly string[];
  readonly selectedFailureHandlingId?: string;
  readonly proxyMessageId?: string;
  readonly exitReason?: AdvancementExitReason;
}

export interface AdvancementProxyMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly reviewId: string;
  readonly content: UserTurnInput;
  readonly rubricFailureHandlingId: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface AdvancementSession {
  readonly id: string;
  readonly conversationId: string;
  readonly status: AdvancementSessionStatus;
  readonly originalUserTask: UserTurnInput;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rubricDraftVersion: number;
  readonly pendingRubricDraft?: RubricContractDraftSnapshot;
  readonly confirmedRubric?: ConfirmedRubricSnapshot;
  readonly runs: readonly AdvancementRunReview[];
  readonly proxyMessages: readonly AdvancementProxyMessage[];
  readonly outstandingProxyMessageId?: string;
  readonly exit?: AdvancementExit;
}

export interface CreateAdvancementSessionInput {
  readonly id: string;
  readonly conversationId: string;
  readonly originalUserTask: UserTurnInput;
  readonly pendingRubricDraft: RubricContractDraftSnapshot;
  readonly createdAt?: string;
}

export type AdvancementStoreEvent =
  | AdvancementSessionCreatedEvent
  | AdvancementRubricDraftRevisedEvent
  | AdvancementRubricConfirmedEvent
  | AdvancementRunReviewedEvent
  | AdvancementProxyEnqueuedEvent
  | AdvancementProxySettledEvent
  | AdvancementCompletedEvent
  | AdvancementExitedEvent
  | AdvancementCancelledEvent;

export interface AdvancementSessionCreatedEvent {
  readonly type: "session_created";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly originalUserTask: UserTurnInput;
  readonly pendingRubricDraft: RubricContractDraftSnapshot;
}

export interface AdvancementRubricDraftRevisedEvent {
  readonly type: "rubric_draft_revised";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly pendingRubricDraft: RubricContractDraftSnapshot;
}

export interface AdvancementRubricConfirmedEvent {
  readonly type: "rubric_confirmed";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly confirmedRubric: ConfirmedRubricSnapshot;
}

export interface AdvancementRunReviewedEvent {
  readonly type: "run_reviewed";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly review: AdvancementRunReview;
}

export interface AdvancementProxyEnqueuedEvent {
  readonly type: "proxy_enqueued";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly proxyMessage: AdvancementProxyMessage;
}

export interface AdvancementProxySettledEvent {
  readonly type: "proxy_settled";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly proxyMessageId: string;
}

export interface AdvancementCompletedEvent {
  readonly type: "completed";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly exit: AdvancementExit;
}

export interface AdvancementExitedEvent {
  readonly type: "exited";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly exit: AdvancementExit;
}

export interface AdvancementCancelledEvent {
  readonly type: "cancelled";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly exit?: AdvancementExit;
}
