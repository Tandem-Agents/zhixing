import { Buffer } from "node:buffer";
import {
  defineDurableRuntimeContract,
  publishTerminalPerformanceObservation,
} from "@zhixing/core/contracts";
import {
  AuthorityStorageError,
  collectArtifactRefs,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveDispatchArtifactClosure,
  resolveSealedBundleArtifactClosure,
  type ArtifactStore,
  type AuthorityCommitLog,
  type AuthorityLogSnapshot,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentTerminationProof,
  AssignmentActivationProof,
  AuthorityCallContext,
  AuthorityError,
  ConversationUncertainClosure,
  ConversationRunState,
  ConversationStatusNotice,
  ConversationInvocation,
  ConversationChannelChallengeToken,
  ContentAssetRef,
  DataPlaneTicket,
  ControlResult,
  ControlResultBody,
  FinalFrame,
  FinalOutboxRecord,
  GlobalStagedMutation,
  GovernorRecord,
  DispatchResult,
  DispatchConflictProof,
  DispatchRejectionProof,
  ExplicitEnvironmentSelection,
  IngressContext,
  IsoTime,
  LedgerSnapshot,
  LedgerEvidencePage,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  PublishConflictNotice,
  SealedBundle,
  StreamFrame,
  SupersedeProof,
  CancelProofBody,
  SessionInternalRecord,
  SessionStagedMutation,
  TranscriptRunRecord,
  UserTurnInput,
  UncertainResolutionFact,
} from "@zhixing/core/contracts";
import {
  applyValidatedAssignmentEntry,
  assertDataPlaneTicketTtlMs,
  assertActivatedAssignmentCapability,
  assertQueuedTerminalDequeue,
  buildConversationActivationPayload,
  buildConversationActivationPayloadFromBinding,
  assignmentActivationDigest,
  byteDigest,
  canonicalize,
  assertChannelChallengeActiveAt,
  controlLeaseBindsDispatchEnvelope,
  createAssignmentLedgerValidationState,
  createSignedDataPlaneTicket,
  createSignedChannelChallengeToken,
  createSignedConversationEnvelope,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  interactionMirrorBatchDigest,
  interactionMirrorSeed,
  interactionDisplayDigest,
  permissionSnapshotLeaseDigest,
  protocolDigest,
  queuedTerminalDequeueRecord,
  requiresFormalResourceCoordination,
  sealedBundleArtifact,
  signConversationActivation,
  validateConversationActivation,
  validateChannelChallengeToken,
  validateConversationEnvelope,
  validateCancelProof,
  validateConversationSealedBundle,
  validateConversationInteractionMirrorEntry,
  validateConversationInteractionMirrorBatch,
  validateConversationInvocation,
  validateContentAssetRefs,
  validateDispatchConflictProof,
  validateDispatchRejectionProof,
  validateDispatchResult,
  validateExplicitEnvironmentSelection,
  validateDataPlaneTicket,
  validateAssignmentEntry,
  validateLedgerEvidencePage,
  validateLedgerSnapshot,
  validateIngressContext,
  validateMutationBatch,
  validateNonEmptyUserTurnInput,
  validateSupersedeProof,
  validateStreamFrame,
  validateTranscriptRunRecord,
  validateAuthorityError as validateAuthorityErrorContract,
  validatePublishDecisionRecord,
  type ConversationInteractionMirrorBatch,
  type DataPlaneTicketKind,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import {
  compileDeliveryContent,
  DeliveryContentValidationError,
  parseConversationId,
  type CompiledDeliveryContent,
} from "@zhixing/core";
import type {
  ControlAdmissionJournal,
  ControlAdmissionOutcome,
  ConversationControlEnvelope,
  InitialControlEnvelope,
  TrustedControlSource,
} from "./control-admission.js";
import {
  assertAdmissionReplayContract,
  assertCancelFenceReplayContract,
  assertCancelProofAcceptedReplayContract,
  assertArtifactReference,
  assertConversationResolutionBinding,
  assertConversationRunInternalRecord,
  assertConversationRunRecord,
  assertAssignmentReplayContract,
  assertAssignmentSupersededReplayContract,
  assertCapabilityRevocationReplayContract,
  assertCommittedReplayContract,
  assertDigest,
  assertDispatchAcknowledgementReplayContract,
  assertDispatchConflictHandlingReplayContract,
  assertDispatchConflictReplayContract,
  assertExactRecordKeys,
  assertHistoricalBundleFence,
  assertIdentifier,
  assertNonNegativeSafeInteger,
  assertPlainRecord,
  assertPositiveSafeInteger,
  assertResolutionClosureReplayContract,
  assertResolutionCloseAtomicReplayContract,
  assertResolutionOpenReplayContract,
  assertStateAtomicReplayContract,
  assertStateReplayContract,
  assertSupersedeRequestReplayContract,
  assertSupersedeStartedObservationReplayContract,
  bundleAcknowledgementBindsCommitted,
  isOpenResolutionFact,
  assignmentTerminationProofKind,
  corruptRunJournal,
  historicalBundleFenceMatches,
  nextActiveRunIdForReplay,
  conversationUncertainClosure,
  projectUncertainStatusTransition,
  resolutionFactDigest,
  resolutionTargetState,
  terminationProofBindsDurableSource,
  type AssignmentTerminationProofKind,
  type ConversationRunInternalRecord,
  type ConversationRunJournalRecord,
  type DurableSourceBoundProof,
  type Stored,
} from "./conversation-run-contracts.js";
import { abortTicketProofBindsOwnerHistory } from "./data-plane-ticket-proof.js";
import {
  dataPlaneTicketIssueMatches,
  nextDataPlaneTicketSyncFrontier,
  ticketPrecedesSyncFrontier,
} from "./data-plane-ticket-lifecycle.js";
import type {
  ConversationControlResponseInput,
  ConversationDeliveryCommitInput,
  ConversationDeliveryParticipant,
  ConversationStatusDeliveryInput,
} from "./delivery-participant.js";
import type { AssignmentResourceCoordinator } from "./resource-governor.js";
import type { PendingChannelChallenge } from "./channel-challenge-outbox.js";
import {
  advanceChannelInteractionJournal,
  createChannelInteractionJournalState,
  validateConversationChannelChallengeRecord,
  type ConversationChannelChallengePreparedRecord,
  type ConversationChannelChallengeRecord,
  type ChannelInteractionJournalState,
} from "./channel-interaction-records.js";

export type { ConversationRunJournalRecord } from "./conversation-run-contracts.js";
type ConversationUncertainResolutionFact = Extract<
  UncertainResolutionFact,
  { subject: { execution: "conversation" } }
>;

type ConversationCommitLogRecord =
  | ConversationRunJournalRecord
  | ConversationRunInternalRecord
  | GovernorRecord
  | PublishRecord
  | FinalOutboxRecord;

type ConversationProjectionRecord = Extract<
  ConversationRunInternalRecord,
  { kind: "conversation-commit-projection" }
>;

interface PublishProjection {
  readonly decisions: Map<
    string,
    Extract<PublishRecord, { t: "publish-decision" }>
  >;
  readonly batches: Map<string, MutationBatch>;
  readonly commitRevisions: Map<string, number>;
  readonly progress: Map<
    string,
    Extract<PublishRecord, { t: "publish-progress" }>
  >;
  readonly domainPlans: Map<string, PublishDomainPlan>;
  readonly conversationByAssignment: Map<string, string>;
  readonly pendingAssignmentsByConversation: Map<string, Set<string>>;
  readonly completedAssignments: Set<string>;
  readonly conflictsByAssignment: Map<
    string,
    PublishConflictNotice["conflicts"]
  >;
}

interface PublishDomainPlan {
  readonly grantedSeqs: number[];
  readonly grantedIndexBySeq: Map<number, number>;
  readonly terminalSeq: number;
}

interface FinalOutboxProjectionEntry {
  readonly record: FinalOutboxRecord;
  readonly at: IsoTime;
}

interface FinalOutboxProjection {
  readonly entries: Map<string, FinalOutboxProjectionEntry>;
  readonly activeKeyByConversationRevision: Map<string, string>;
  readonly pendingByConversation: Map<string, Map<string, FinalOutboxProjectionEntry>>;
  readonly publishedByConversation: Map<string, Map<string, FinalOutboxProjectionEntry>>;
  readonly lastPendingRevisionByConversation: Map<string, number>;
}

type StatusHistoryEntry = {
  readonly state: ConversationRunState;
  readonly statusRevision: number;
  readonly at: IsoTime;
  readonly reason?: string;
} & (
  | { readonly uncertainTransition?: undefined }
  | { readonly uncertainTransition: "opened"; readonly openFactDigest: string }
  | ({ readonly uncertainTransition: "closed"; readonly openFactDigest: string } &
      ConversationUncertainClosure)
);

const FINAL_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type AssignmentSubmissionMethod =
  | "submission.reportStarted"
  | "submission.mirrorInteractions"
  | "submission.completeInteractionSettlement"
  | "submission.submitBundle"
  | "submission.submitCancelProof";

export interface AssignmentSubmissionIdentity {
  readonly method: AssignmentSubmissionMethod;
  readonly assignmentId: string;
}

export type AssignmentBundleSubmissionResult =
  | { readonly committed: true; readonly commitRevision: number }
  | { readonly committed: false; readonly error: AuthorityError };

export type AssignmentSubmissionPreflightResult =
  | { readonly kind: "continue" }
  | { readonly kind: "return"; readonly result: AssignmentBundleSubmissionResult };

export type AssignmentSubmissionAuthorization =
  | {
      readonly mode: "active";
      readonly method: AssignmentSubmissionMethod;
      readonly assignmentId: string;
    }
  | {
      /** A validated terminal payload may only narrow the current attempt. */
      readonly mode: "settlement";
      readonly method:
        | "submission.mirrorInteractions"
        | "submission.completeInteractionSettlement"
        | "submission.submitBundle"
        | "submission.submitCancelProof";
      readonly assignmentId: string;
    }
  | {
      /** The request is already subsumed by durable authority state and will append nothing. */
      readonly mode: "durable-replay";
      readonly method:
      | "submission.reportStarted"
      | "submission.mirrorInteractions"
      | "submission.completeInteractionSettlement"
      | "submission.submitBundle"
        | "submission.submitCancelProof";
      readonly assignmentId: string;
    }
  | {
      /** A durable fence determines a zero-write rejection before payload processing. */
      readonly mode: "durable-rejection";
      readonly method: "submission.submitBundle";
      readonly assignmentId: string;
    };

export interface AssignmentSubmissionAuthorizer {
  authenticate(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void;
  authorize(
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void;
}

export interface AssignmentSubmissionPreflightPort {
  preflightSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<AssignmentSubmissionPreflightResult>;
}

export interface ConversationRunJournalOptions {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly submission: AssignmentSubmissionAuthorizer;
  readonly authority: ConversationCommitAuthority;
  readonly projection: ConversationCommitProjection;
  readonly publisher?: ConversationMutationPublisher;
  readonly delivery: ConversationDeliveryParticipant;
  readonly resources?: AssignmentResourceCoordinator;
  readonly clock?: () => string;
  readonly legacyAbortTickets?: ConversationAbortTicketAuthorizer;
}

export interface ConversationAbortTicketAuthorizer {
  authorize(input: {
    readonly assignmentId: string;
    readonly executorId: string;
    readonly ticketDigest: string;
    readonly surfacePrincipal: string;
  }): void;
}

export interface ConversationCommitDecisionInput {
  readonly assignmentId: string;
  readonly authorityPrefixLsn: number;
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly baseRevision: number;
  readonly runRecord: TranscriptRunRecord;
  readonly sessionMutations: ReadonlyArray<{
    readonly seq: number;
    readonly mutation: SessionStagedMutation;
    readonly requestId: string;
  }>;
}

export interface ConversationCommitAuthority {
  /**
   * 在同一 AuthorityCommitLog 前缀上裁决当前 epoch、revision、transcript 序号
   * 与 session staged 写，并为本次提交保留唯一 commitRevision。
   */
  decideAtPrefix(
    input: ConversationCommitDecisionInput,
  ):
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: import("@zhixing/core/contracts").AuthorityError;
      };
}

export interface ConversationCommitProjectionInput {
  readonly assignmentId: string;
  readonly conversationId: string;
  readonly commitRevision: number;
  readonly digest: string;
  readonly runRecord: TranscriptRunRecord;
  readonly windowCompact?: import("@zhixing/core/contracts").WindowCompactInstruction;
  readonly contentAssets: readonly import("@zhixing/core/contracts").ContentAssetRef[];
}

export interface ConversationCommitProjection {
  /** 幂等物化权威提交；重复调用必须返回成功且不得产生第二份派生事实。 */
  project(input: ConversationCommitProjectionInput): Promise<void>;
}

export interface ConversationLifecycleProjectionInput {
  readonly conversationId: string;
  readonly mutation: "clear" | "delete";
  readonly domainRevision: number;
  readonly requestId: string;
}

export type ConversationLifecycleProjection = (
  input: ConversationLifecycleProjectionInput,
) => Promise<void>;

export interface ConversationMutationPublisher {
  /**
   * Pure batch decision over this AuthorityCommitLog projected through authorityPrefixLsn.
   * The projection must include prior granted publish decisions so revisions are reserved at
   * the same serialization point as the conversation commit.
   */
  decideGlobalBatchAtPrefix(input: {
    readonly assignmentId: string;
    readonly authorityPrefixLsn: number;
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly mutation: GlobalStagedMutation;
      readonly requestId: string;
      readonly expected: { readonly anchorEpoch: number };
    }>;
  }): ReadonlyArray<{
    readonly seq: number;
    readonly outcome:
      | { readonly t: "granted"; readonly targetRevision: number }
      | {
          readonly t: "conflicted";
          readonly error: import("@zhixing/core/contracts").AuthorityError;
        };
  }>;
  /** Granted decisions are final; replaying the same assignment/seq must not duplicate effects. */
  apply(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly domain: "session" | "global";
    readonly mutation: SessionStagedMutation | GlobalStagedMutation;
    readonly requestId: string;
    readonly targetRevision: number;
  }): Promise<void>;
}

export interface CommittedConversationResult {
  readonly frame: FinalFrame;
  readonly bundle: SealedBundle & { readonly body: { readonly t: "conversation" } };
}

export interface PendingConversationDispatch {
  readonly assignmentId: string;
  readonly envelope: Extract<
    import("@zhixing/core/contracts").DispatchEnvelope,
    { execution: "conversation" }
  >;
  readonly activation: AssignmentActivationProof<"conversation">;
}

export interface PendingConversationInput {
  readonly runId: string;
  readonly input: UserTurnInput;
  readonly attachments: readonly ContentAssetRef[];
  readonly ingress: IngressContext;
  readonly invocation: ConversationInvocation;
  readonly environment?: ExplicitEnvironmentSelection;
  readonly queuedPosition: number;
}

export interface ConversationRunControlDescriptor {
  readonly runId: string;
  readonly state: ConversationRunState;
  readonly source: ConversationInvocation["source"];
  /** Stable ingress identity used to bind source-specific projections. */
  readonly ingressId: string;
}

export interface PendingConversationFence {
  readonly assignmentId: string;
  readonly fence: { readonly fenceSeq: number; readonly requestId: string };
}

export interface ConversationDispatchPort {
  dispatch(
    envelope: PendingConversationDispatch["envelope"],
    activation: AssignmentActivationProof<"conversation">,
    ctx: AuthorityCallContext,
  ): Promise<DispatchResult>;
  queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<import("@zhixing/core/contracts").LedgerSnapshot | import("@zhixing/core/contracts").LedgerEvidencePage>;
  cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void>;
  supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<SupersedeProof>;
}

interface AdmittedProjection {
  readonly record: Extract<ConversationRunJournalRecord, { t: "admitted" }>;
  readonly input: UserTurnInput;
}

interface AssignedProjection {
  readonly record: Extract<ConversationRunJournalRecord, { t: "assigned" }>;
  readonly envelope: PendingConversationDispatch["envelope"];
  readonly commit: { readonly lsn: number; readonly envelopeDigest: string; readonly at: string };
  acked: boolean;
}

export const SESSION_ACTIVITY_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "session-activity",
  producer: "ConversationRunJournal",
  recoveryOwner: "anchor-workscene-owner",
  resourceIdentity: "session-activity:<conversationId>",
  recoveryClass: "authority-replay",
  cases: [
    ...["upsert", "delete"].map((key) => ({ kind: "variant" as const, key, reasonCode: `SESSION_ACTIVITY_${key.toUpperCase()}` })),
    ...["conversation-scene-mismatch", "non-monotonic-revision", "external-construction"].map((key) => ({ kind: "rejection" as const, key, reasonCode: `SESSION_ACTIVITY_${key.replaceAll("-", "_").toUpperCase()}` })),
    ...["wrong-stream", "invalid-time", "identity-rebinding"].map((key) => ({ kind: "corruption" as const, key, reasonCode: `SESSION_ACTIVITY_${key.replaceAll("-", "_").toUpperCase()}` })),
  ],
} as const);

interface PendingLifecycleProjection {
  readonly mutation: "clear" | "delete";
  readonly domainRevision: number;
  readonly requestId: string;
}

interface RunProjection {
  readonly conversationId: string;
  domainRevision: number;
  deleted: boolean;
  sessionMeta?: Extract<
    ConversationRunJournalRecord,
    { t: "session-meta" }
  >;
  readonly sessionMetaByRequest: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "session-meta" }>
  >;
  readonly lifecycleByRequest: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "session-lifecycle" }>
  >;
  readonly pendingLifecycleProjections: Map<
    number,
    PendingLifecycleProjection
  >;
  readonly projectedLifecycleRevisions: Set<number>;
  readonly admittedByRun: Map<string, AdmittedProjection>;
  readonly runByIngress: Map<string, string>;
  readonly assignedById: Map<string, AssignedProjection>;
  readonly assignmentByRun: Map<string, string>;
  readonly stateByRun: Map<
    string,
    { readonly state: ConversationRunState; readonly statusRevision: number }
  >;
  readonly queuedRunByPosition: Map<number, string>;
  readonly queuedPositionHeap: number[];
  readonly queuedPositionHeapIndex: Map<number, number>;
  activeRunId?: string;
  readonly mirrorStateByAssignment: Map<
    string,
    {
      ordinal: number;
      mirrorDigest: string;
      mirroredUpTo: number;
      readonly requestIds: Set<string>;
    }
  >;
  readonly mirrorBatches: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "interaction-mirror" }>
  >;
  readonly committedByAssignment: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
  readonly bundleAcknowledgements: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>
  >;
  readonly recoveryAssignments: Set<string>;
  readonly bundleAcknowledgementOutbox: Set<string>;
  readonly commits: Array<Extract<ConversationRunJournalRecord, { t: "committed" }>>;
  readonly assignmentByCommitRevision: Map<number, string>;
  readonly contentByRevision: Map<number, readonly import("@zhixing/core/contracts").ContentAssetRef[]>;
  readonly projectedByAssignment: Map<string, ConversationProjectionRecord>;
  readonly pendingCommitProjections: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
  readonly conflicts: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "dispatch-conflict" }>
  >;
  readonly conflictByAssignment: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "dispatch-conflict" }>
  >;
  readonly containedFacts: Set<string>;
  readonly containmentByAssignment: Map<
    string,
    | Extract<ConversationRunJournalRecord, { t: "dispatch-conflict-contained" }>
    | Extract<ConversationRunJournalRecord, { t: "cancel-contained" }>
  >;
  readonly superseded: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "assignment-superseded" }>
  >;
  readonly supersedeRequests: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "supersede-requested" }>
  >;
  readonly supersedeStartedObservations: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "supersede-started-observed" }>
  >;
  readonly cancelFences: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "cancel-fence" }>
  >;
  readonly cancelOrigins: Map<string, "dispatched" | "running">;
  readonly acceptedCancellations: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "cancel-proof-accepted" }>
  >;
  readonly rejectedNotStarted: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "not-started-rejected" }>
  >;
  readonly uncertainOrigins: Map<
    string,
    "dispatched" | "running" | "cancel-requested"
  >;
  readonly revokedCapabilities: Set<string>;
  readonly ticketsById: Map<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: Map<string, Set<string>>;
  readonly ticketReplacementsById: Map<string, string>;
  readonly revokedTickets: Set<string>;
  ticketSyncFrontier: string | undefined;
  readonly resolutionsByRun: Map<string, ConversationUncertainResolutionFact>;
  readonly statusHistoryByRun: Map<string, StatusHistoryEntry[]>;
  readonly closedAssignments: Set<string>;
  channelInteractions: ChannelInteractionJournalState;
}

interface SubmissionGuardProjection {
  readonly admittedByRun: Map<
    string,
    {
      readonly ingressKey: string;
      readonly queuedPosition: number;
      readonly ingress: IngressContext;
    }
  >;
  readonly runByIngress: Map<string, string>;
  readonly queuedRunByPosition: Map<number, string>;
  readonly queuedPositionHeap: number[];
  readonly queuedPositionHeapIndex: Map<number, number>;
  readonly assignedById: Map<
    string,
    {
      readonly record: Extract<ConversationRunJournalRecord, { t: "assigned" }>;
      readonly commit: {
        readonly lsn: number;
        readonly envelopeDigest: string;
        readonly at: string;
      };
      readonly capIds: ReadonlySet<string>;
      acked: boolean;
    }
  >;
  readonly assignmentByRun: Map<string, string>;
  readonly stateByRun: Map<
    string,
    { readonly state: ConversationRunState; readonly statusRevision: number }
  >;
  readonly conflictAssignments: Set<string>;
  readonly openConflictAssignments: Set<string>;
  readonly supersedeRequests: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "supersede-requested" }>
  >;
  readonly supersedeStartedAssignments: Set<string>;
  readonly cancelFences: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "cancel-fence" }>
  >;
  readonly acceptedCancellations: Set<string>;
  readonly durableStartedAssignments: Set<string>;
  readonly resolutionsByRun: Map<string, ConversationUncertainResolutionFact>;
  readonly committedByAssignment: Map<
    string,
    {
      readonly bundle: { readonly ref: ArtifactRef };
      readonly commitRevision: number;
      readonly sidecars: SubmissionCommitSidecars;
    }
  >;
  readonly bundleAcknowledgements: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>
  >;
  readonly closedAssignments: Set<string>;
  readonly revokedCapabilities: Set<string>;
  readonly ticketsById: Map<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: Map<string, Set<string>>;
  readonly ticketReplacementsById: Map<string, string>;
  readonly revokedTickets: Set<string>;
  ticketSyncFrontier: string | undefined;
  activeRunId: string | undefined;
}

interface SubmissionCommitSidecars {
  readonly contentAssetsDigest: string;
  readonly finalDigest: string;
  readonly publish?: {
    readonly batch: { readonly ref: ArtifactRef };
    readonly sessionCount: number;
    readonly globalCount: number;
    readonly pendingDomains: ReadonlySet<"session" | "global">;
  };
}

interface PreparedStored<T> {
  readonly stored: Stored<T>;
  readonly references: readonly ArtifactRef[];
}

interface AssignDecision {
  readonly assignmentId: string;
}

export interface InProcessDispatchContextFactory {
  create(
    assignmentId: string,
    method:
      | "executor.dispatch"
      | "executor.cancel"
      | "executor.supersede"
      | "executor.queryLedger",
    request: {
      readonly requestId: string;
      readonly body: unknown;
    },
  ): AuthorityCallContext;
}

interface InProcessConversationDispatcherBaseOptions {
  readonly journal: ConversationRunJournal;
  readonly executor: ConversationDispatchPort;
  readonly contexts: InProcessDispatchContextFactory;
}

export interface InProcessCancellationSubmission {
  submitCancellation(assignmentId: string): Promise<boolean>;
}

export interface InProcessBundleSubmission {
  submitSealedBundle(assignmentId: string): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  >;
}

export type InProcessConversationDispatcherOptions =
  InProcessConversationDispatcherBaseOptions &
    (
      | {
          readonly enabled: false;
          readonly cancellationSubmission?: InProcessCancellationSubmission;
          readonly bundleSubmission?: InProcessBundleSubmission;
        }
      | {
          readonly enabled: true;
          readonly cancellationSubmission: InProcessCancellationSubmission;
          readonly bundleSubmission: InProcessBundleSubmission;
        }
    );

export interface ConversationCancelRequest {
  readonly runId: string;
  readonly requestId: string;
}

export interface DataPlaneTicketIssueRequest {
  readonly ticketId: string;
  readonly assignmentId: string;
  readonly surfacePrincipal: string;
  readonly kind: DataPlaneTicketKind;
  readonly ttlMs: number;
  readonly replacesTicketId?: string;
}

export interface DataPlaneTicketFacts {
  readonly issued: readonly DataPlaneTicket[];
  readonly revokedTicketIds: readonly string[];
}

export type ConversationCancelResult =
  | { readonly state: "cancelled"; readonly assignmentId?: string }
  | {
      readonly state: "cancel-requested";
      readonly assignmentId: string;
      readonly fence: { readonly fenceSeq: number; readonly requestId: string };
    }
  | { readonly state: Exclude<ConversationRunState, "cancelled" | "cancel-requested"> };

export interface ConversationChannelFrameAdoption {
  readonly prepared?: ConversationChannelChallengePreparedRecord;
  readonly closed?: Extract<
    ConversationChannelChallengeRecord,
    { readonly t: "channel-challenge-closed" }
  >;
}

/** Owner-side durable run facts and deterministic dispatch outbox for one conversation. */
export class ConversationRunJournal implements AssignmentSubmissionPreflightPort {
  readonly #conversationId: string;
  readonly #ownerEpoch: number;
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #submission: AssignmentSubmissionAuthorizer;
  readonly #authority: ConversationCommitAuthority;
  readonly #projection: ConversationCommitProjection;
  readonly #publisher: ConversationMutationPublisher | undefined;
  readonly #delivery: ConversationDeliveryParticipant;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #clock: () => string;
  readonly #legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly #operations = new SerialTaskQueue();
  readonly #statusListeners = new Set<
    (notice: ConversationStatusNotice) => void | Promise<void>
  >();
  #runProjection:
    | { readonly state: RunProjection; readonly cursor: ProjectionCursor }
    | undefined;
  #submissionGuardProjection:
    | { readonly state: SubmissionGuardProjection; readonly cursor: ProjectionCursor }
    | undefined;
  #publishProjection:
    | { readonly state: PublishProjection; readonly cursor: ProjectionCursor }
    | undefined;
  #finalProjection:
    | { readonly state: FinalOutboxProjection; readonly cursor: ProjectionCursor }
    | undefined;

  constructor(options: ConversationRunJournalOptions) {
    assertIdentifier(options.conversationId, "Conversation id");
    assertPositiveSafeInteger(options.ownerEpoch, "Owner epoch");
    this.#conversationId = options.conversationId;
    this.#ownerEpoch = options.ownerEpoch;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#submission = options.submission;
    this.#authority = options.authority;
    this.#projection = options.projection;
    this.#publisher = options.publisher;
    this.#delivery = options.delivery;
    this.#resources = options.resources;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#legacyAbortTickets = options.legacyAbortTickets;
  }

  async pendingChannelChallenges(): Promise<readonly PendingChannelChallenge[]> {
    return this.#select((state) =>
      [...state.channelInteractions.preparedByChallenge.values()]
        .filter(
          (prepared): prepared is ConversationChannelChallengePreparedRecord =>
            prepared.ref.execution === "conversation" &&
            !state.channelInteractions.closedByChallenge.has(
              prepared.token.challengeId,
            ),
        )
        .map((prepared) => {
          const delivered =
            state.channelInteractions.deliveredByChallenge.get(
              prepared.token.challengeId,
            );
          return {
            prepared: structuredClone(prepared),
            ...(delivered ? { delivered: structuredClone(delivered) } : {}),
          };
        }),
    );
  }

  async recordChannelChallengeDelivered(input: {
    readonly challengeId: string;
    readonly receipt: {
      readonly acceptedAt: string;
      readonly platformMessage?: import("@zhixing/core/contracts").ChannelMessageRef;
    };
  }): Promise<void> {
    const record = validateConversationChannelChallengeRecord(
      {
        t: "channel-challenge-delivered",
        challengeId: input.challengeId,
        receipt: input.receipt,
      },
      this.#verifier,
    );
    await this.#transact<void>((state) => {
      const current =
        state.channelInteractions.deliveredByChallenge.get(input.challengeId);
      if (current && canonicalize(current) === canonicalize(record)) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [runRecord(this.#conversationId, record)],
        value: undefined,
      };
    });
  }

  async closeChannelChallenge(input: {
    readonly challengeId: string;
    readonly outcome: "cancelled" | "expired";
    readonly at: string;
  }): Promise<void> {
    const record = validateConversationChannelChallengeRecord(
      {
        t: "channel-challenge-closed",
        challengeId: input.challengeId,
        outcome: input.outcome,
        at: input.at,
      },
      this.#verifier,
    );
    await this.#transact<void>((state) => {
      const current =
        state.channelInteractions.closedByChallenge.get(input.challengeId);
      if (current && canonicalize(current) === canonicalize(record)) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [runRecord(this.#conversationId, record)],
        value: undefined,
      };
    });
  }

  async adoptConversationChannelFrame(
    frameInput: StreamFrame,
  ): Promise<ConversationChannelFrameAdoption> {
    const frame = validateStreamFrame(frameInput);
    const ref = frame.ref;
    if (
      ref.execution !== "conversation" ||
      ref.conversationId !== this.#conversationId ||
      ref.ownerEpoch !== this.#ownerEpoch
    ) {
      throw new TypeError(
        "Conversation channel frame belongs to a different authority",
      );
    }
    const payload = frame.payload;
    if (payload.kind !== "interaction") return {};

    const transaction = await this.#transact<ConversationChannelFrameAdoption>(
      (state, context) => {
        const assigned = state.assignedById.get(frame.assignmentId);
        if (
          !assigned ||
          assigned.record.runId !== ref.runId ||
          assigned.record.ownerEpoch !== ref.ownerEpoch
        ) {
          throw new TypeError(
            "Conversation channel frame does not bind the current assignment",
          );
        }
        const admitted = state.admittedByRun.get(ref.runId);
        if (!admitted || admitted.record.ingress.kind !== "channel") {
          throw new TypeError(
            "Conversation channel confirmation requires channel ingress",
          );
        }
        if (payload.event.t === "requested") {
          const event = payload.event;
          const interactionKey =
            `${frame.assignmentId}\u0000${event.requestId}`;
          const existingChallengeId =
            state.channelInteractions.challengeByInteraction.get(interactionKey);
          if (existingChallengeId) {
            const existing =
              state.channelInteractions.preparedByChallenge.get(
                existingChallengeId,
              );
            if (!existing || existing.ref.execution !== "conversation") {
              throw new TypeError(
                "Conversation channel request conflicts with its prepared challenge",
              );
            }
            const conversationPrepared =
              existing as ConversationChannelChallengePreparedRecord;
            if (
              conversationPrepared.frameSeq !== frame.seq ||
              conversationPrepared.toolName !== event.toolName ||
              canonicalize(conversationPrepared.display) !==
                canonicalize(event.display)
            ) {
              throw new TypeError(
                "Conversation channel request conflicts with its prepared challenge",
              );
            }
            return {
              kind: "return",
              value: { prepared: structuredClone(conversationPrepared) },
            };
          }
          const challengeId = protocolDigest("ChannelChallengeIdentity", 1, {
            ref,
            assignmentId: frame.assignmentId,
            interactionRequestId: event.requestId,
          });
          const token = createSignedChannelChallengeToken(
            {
              v: 1,
              challengeId,
              ref,
              assignmentId: frame.assignmentId,
              interactionRequestId: event.requestId,
              route: admitted.record.ingress.replyTarget,
              displayDigest: interactionDisplayDigest(
                event.toolName,
                event.display,
              ),
              issuedAt: event.issuedAt,
              expiry: event.expiresAt,
            },
            this.#signer,
          );
          const prepared = validateConversationChannelChallengeRecord(
            {
              t: "channel-challenge-prepared",
              ref,
              assignmentId: frame.assignmentId,
              frameSeq: frame.seq,
              token,
              responder: admitted.record.ingress.responder,
              toolName: event.toolName,
              display: event.display,
            },
            this.#verifier,
          ) as ConversationChannelChallengePreparedRecord;
          return {
            kind: "append",
            entries: [runRecord(this.#conversationId, prepared)],
            value: { prepared },
          };
        }

        const challengeId =
          state.channelInteractions.challengeByInteraction.get(
            `${frame.assignmentId}\u0000${payload.event.requestId}`,
          );
        if (!challengeId) {
          throw new TypeError(
            "Conversation channel completion has no prepared challenge",
          );
        }
        const current =
          state.channelInteractions.closedByChallenge.get(challengeId);
        const closed = validateConversationChannelChallengeRecord(
          {
            t: "channel-challenge-closed",
            challengeId,
            outcome: payload.event.outcome,
            at: context.at,
          },
          this.#verifier,
        ) as Extract<
          ConversationChannelChallengeRecord,
          { readonly t: "channel-challenge-closed" }
        >;
        if (current) {
          if (canonicalize(current) !== canonicalize(closed)) {
            throw new TypeError(
              "Conversation channel completion conflicts with its terminal record",
            );
          }
          return {
            kind: "return",
            value: { closed: structuredClone(current) },
          };
        }
        return {
          kind: "append",
          entries: [runRecord(this.#conversationId, closed)],
          value: { closed },
        };
      },
    );
    return transaction.value;
  }

  async authorizeConversationChannelCallback(input: {
    readonly token: ConversationChannelChallengeToken;
    readonly responder: import("@zhixing/core/contracts").ChannelResponderRef;
    readonly at?: string;
  }): Promise<{
    readonly assignmentId: string;
    readonly interactionRequestId: string;
  }> {
    const token = validateChannelChallengeToken(input.token, this.#verifier);
    if (token.ref.execution !== "conversation") {
      throw new TypeError(
        "Conversation channel callback requires a conversation token",
      );
    }
    return this.#select((state) => {
      const prepared =
        state.channelInteractions.preparedByChallenge.get(token.challengeId);
      if (
        !prepared ||
        prepared.ref.execution !== "conversation" ||
        canonicalize(prepared.token) !== canonicalize(token) ||
        canonicalize(prepared.responder) !== canonicalize(input.responder) ||
        state.channelInteractions.closedByChallenge.has(token.challengeId)
      ) {
        throw new TypeError(
          "Conversation channel callback does not bind a pending challenge",
        );
      }
      assertChannelChallengeActiveAt(
        prepared.token,
        input.at ?? this.#clock(),
      );
      return {
        assignmentId: prepared.assignmentId,
        interactionRequestId: prepared.token.interactionRequestId,
      };
    });
  }

  async primeRecoverySnapshot(
    snapshot: AuthorityLogSnapshot<unknown>,
  ): Promise<void> {
    await this.#operations.run(async () => {
      let run = emptyProjection(this.#conversationId);
      let submission = emptySubmissionGuardProjection();
      let publish = emptyPublishProjection();
      let final = emptyFinalProjection();
      const assignments = new Set<string>();
      for (const envelope of snapshot.commits) {
        for (const record of envelope.entries) {
          if (record.stream === runStream(this.#conversationId)) {
            run = await this.#reduce(run, record, envelope);
            const assignmentId = (
              record.body && typeof record.body === "object" && !Array.isArray(record.body)
                ? (record.body as { assignmentId?: unknown }).assignmentId
                : undefined
            );
            if (typeof assignmentId === "string") assignments.add(assignmentId);
            submission = await this.#reduceSubmissionGuard(
              submission,
              record as LogicalRecord<ConversationCommitLogRecord>,
              envelope as import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
            );
          } else if (
            record.stream === "publish" &&
            record.body &&
            typeof record.body === "object" &&
            !Array.isArray(record.body) &&
            typeof (record.body as { assignmentId?: unknown }).assignmentId === "string" &&
            assignments.has((record.body as { assignmentId: string }).assignmentId)
          ) {
            publish = await reducePublishRecord(
              publish,
              record as LogicalRecord<PublishRecord>,
              envelope as import("@zhixing/core/contracts").CommitEnvelope<PublishRecord>,
              this.#artifacts,
            );
          } else if (
            record.stream === "final-outbox" &&
            record.body &&
            typeof record.body === "object" &&
            !Array.isArray(record.body) &&
            (record.body as { conversationId?: unknown }).conversationId ===
              this.#conversationId
          ) {
            await applyFinalRecord(
              final,
              record.body as FinalOutboxRecord,
              envelope.at,
              envelope as import("@zhixing/core/contracts").CommitEnvelope<FinalOutboxRecord>,
              this.#artifacts,
            );
          }
        }
      }
      this.#runProjection = { state: run, cursor: snapshot.cursor };
      this.#submissionGuardProjection = {
        state: submission,
        cursor: snapshot.cursor,
      };
      this.#publishProjection = { state: publish, cursor: snapshot.cursor };
      this.#finalProjection = { state: final, cursor: snapshot.cursor };
    });
  }

  async authorityState(): Promise<{
    readonly domainRevision: number;
    readonly commitRevision: number;
    readonly deleted: boolean;
    readonly hasDurableIdentity: boolean;
    readonly pendingLifecycleProjections: number;
  }> {
    return this.#select((state) => ({
      domainRevision: state.domainRevision,
      commitRevision: state.commits.at(-1)?.commitRevision ?? 0,
      deleted: state.deleted,
      hasDurableIdentity:
        state.sessionMeta !== undefined ||
        state.admittedByRun.size > 0 ||
        state.lifecycleByRequest.size > 0,
      pendingLifecycleProjections: state.pendingLifecycleProjections.size,
    }));
  }

  async touchWorksceneSession(input: {
    readonly requestId: string;
    readonly sceneId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string }> {
    assertPlainRecord(input, "Session activity input");
    assertExactRecordKeys(
      input,
      ["at", "requestId", "sceneId"],
      "Session activity input",
    );
    assertIdentifier(input.requestId, "Session activity request id");
    assertIdentifier(input.sceneId, "Session activity scene id");
    assertCanonicalActivityTime(input.at);
    assertWorksceneIdentity(
      this.#conversationId,
      input.sceneId,
    );
    const transaction = await this.#transact<{
      readonly revision: number;
      readonly at: string;
    }>((state) => {
      const replay = state.sessionMetaByRequest.get(input.requestId);
      if (replay) {
        if (
          replay.sceneId !== input.sceneId ||
          replay.operation === "delete"
        ) {
          throw corruptRunJournal(
            "Session activity request is already bound to another mutation",
          );
        }
        return {
          kind: "return",
          value: {
            revision: replay.domainRevision,
            at: replay.lastActiveAt,
          },
        };
      }
      if (state.deleted) {
        throw corruptRunJournal(
          "Deleted workscene conversation cannot be touched",
        );
      }
      const domainRevision = state.domainRevision + 1;
      const operation = state.sessionMeta ? "touch" : "create";
      const meta: Extract<
        ConversationRunJournalRecord,
        { t: "session-meta" }
      > = {
        t: "session-meta",
        operation,
        domainRevision,
        requestId: input.requestId,
        sceneId: input.sceneId,
        lastActiveAt: input.at,
      };
      return {
        kind: "append",
        entries: worksceneSessionMetaEntries(this.#conversationId, meta),
        value: { revision: domainRevision, at: input.at },
      };
    });
    return transaction.value;
  }

  async deleteWorksceneSession(input: {
    readonly requestId: string;
    readonly sceneId: string;
    readonly at: string;
  }): Promise<
    { readonly revision: number; readonly at: string } | undefined
  > {
    assertPlainRecord(input, "Session deletion input");
    assertExactRecordKeys(
      input,
      ["at", "requestId", "sceneId"],
      "Session deletion input",
    );
    assertIdentifier(input.requestId, "Session deletion request id");
    assertIdentifier(input.sceneId, "Session deletion scene id");
    assertCanonicalActivityTime(input.at);
    assertWorksceneIdentity(
      this.#conversationId,
      input.sceneId,
    );
    const transaction = await this.#transact<
      { readonly revision: number; readonly at: string } | undefined
    >((state) => {
      const replay = state.sessionMetaByRequest.get(input.requestId);
      if (replay) {
        if (
          replay.operation !== "delete" ||
          replay.sceneId !== input.sceneId
        ) {
          throw corruptRunJournal(
            "Session deletion request is already bound to another mutation",
          );
        }
        return {
          kind: "return",
          value: {
            revision: replay.domainRevision,
            at: replay.lastActiveAt,
          },
        };
      }
      if (!state.sessionMeta) {
        return { kind: "return", value: undefined };
      }
      if (state.deleted) {
        return {
          kind: "return",
          value: {
            revision: state.sessionMeta.domainRevision,
            at: state.sessionMeta.lastActiveAt,
          },
        };
      }
      const domainRevision = state.domainRevision + 1;
      const meta: Extract<
        ConversationRunJournalRecord,
        { t: "session-meta" }
      > = {
        t: "session-meta",
        operation: "delete",
        domainRevision,
        requestId: input.requestId,
        sceneId: input.sceneId,
        lastActiveAt: input.at,
      };
      return {
        kind: "append",
        entries: worksceneSessionMetaEntries(this.#conversationId, meta),
        value: { revision: domainRevision, at: input.at },
      };
    });
    return transaction.value;
  }

  async lifecycleRequest(
    requestId: string,
  ): Promise<ConversationLifecycleProjectionInput | undefined> {
    assertIdentifier(requestId, "Session lifecycle request id");
    return this.#select((state) => {
      const lifecycle = state.lifecycleByRequest.get(requestId);
      const sessionMeta = state.sessionMetaByRequest.get(requestId);
      const record: PendingLifecycleProjection | undefined =
        lifecycle ??
        (sessionMeta?.operation === "delete"
          ? {
              mutation: "delete",
              domainRevision: sessionMeta.domainRevision,
              requestId: sessionMeta.requestId,
            }
          : undefined);
      return record
        ? {
            conversationId: this.#conversationId,
            mutation: record.mutation,
            domainRevision: record.domainRevision,
            requestId: record.requestId,
          }
        : undefined;
    });
  }

  async completeLifecycleProjection(
    input: Omit<ConversationLifecycleProjectionInput, "conversationId">,
  ): Promise<boolean> {
    assertIdentifier(input.requestId, "Session lifecycle request id");
    const transaction = await this.#transact<boolean>((state) => {
      const pending = state.pendingLifecycleProjections.get(input.domainRevision);
      if (!pending) {
        const lifecycle = state.lifecycleByRequest.get(input.requestId);
        const sessionMeta = state.sessionMetaByRequest.get(input.requestId);
        const durable: PendingLifecycleProjection | undefined =
          lifecycle ??
          (sessionMeta?.operation === "delete"
            ? {
                mutation: "delete",
                domainRevision: sessionMeta.domainRevision,
                requestId: sessionMeta.requestId,
              }
            : undefined);
        if (
          durable?.domainRevision === input.domainRevision &&
          durable.mutation === input.mutation &&
          state.projectedLifecycleRevisions.has(input.domainRevision)
        ) {
          return { kind: "return", value: false };
        }
        throw corruptRunJournal("Lifecycle projection acknowledgement is not pending");
      }
      if (pending.requestId !== input.requestId || pending.mutation !== input.mutation) {
        throw corruptRunJournal("Lifecycle projection acknowledgement does not bind its fact");
      }
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, {
            kind: "conversation-lifecycle-projection",
            mutation: input.mutation,
            domainRevision: input.domainRevision,
            requestId: input.requestId,
          }),
        ],
        value: true,
      };
    });
    return transaction.value;
  }

  async resumeLifecycleProjections(
    project: ConversationLifecycleProjection,
  ): Promise<number> {
    const pending = await this.#select((state) =>
      [...state.pendingLifecycleProjections.values()]
        .sort((left, right) => left.domainRevision - right.domainRevision)
        .map((record) => snapshot(record, "Pending lifecycle projection")),
    );
    let projected = 0;
    for (const record of pending) {
      const input = {
        conversationId: this.#conversationId,
        mutation: record.mutation,
        domainRevision: record.domainRevision,
        requestId: record.requestId,
      } as const;
      await project(input);
      if (await this.completeLifecycleProjection(input)) projected += 1;
    }
    return projected;
  }

  onStatus(
    listener: (notice: ConversationStatusNotice) => void | Promise<void>,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async admit(input: {
    readonly ingressKey: string;
    readonly runId: string;
    readonly userInput: UserTurnInput;
    readonly attachments?: readonly ContentAssetRef[];
    readonly ingress: IngressContext;
    readonly invocation: ConversationInvocation;
    readonly environment?: ExplicitEnvironmentSelection;
    readonly queuedPosition: number;
  }): Promise<void> {
    assertIdentifier(input.ingressKey, "Ingress key");
    assertIdentifier(input.runId, "Run id");
    validateNonEmptyUserTurnInput(input.userInput);
    if (!Number.isSafeInteger(input.queuedPosition) || input.queuedPosition < 0) {
      throw new TypeError("Queued position must be a non-negative safe integer");
    }
    const userInput = snapshot(input.userInput, "Run input");
    const ingress = validateIngressContext(input.ingress);
    const invocation = validateConversationInvocation(input.invocation);
    const environment = input.environment === undefined
      ? undefined
      : validateExplicitEnvironmentSelection(input.environment);
    if (environment && ingress.kind !== "first-party") {
      throw new TypeError(
        "Only first-party admission may carry an environment selection",
      );
    }
    const attachments = validateContentAssetRefs(input.attachments ?? [], {
      allowEmpty: true,
      label: "Run admission attachments",
    });
    const prepared = await prepareStored(userInput, this.#artifacts);
    const admitted: Extract<ConversationRunJournalRecord, { t: "admitted" }> = {
      t: "admitted",
      ingressKey: input.ingressKey,
      runId: input.runId,
      input: prepared.stored,
      ...(attachments.length > 0 ? { attachments } : {}),
      ingress,
      invocation,
      ...(environment ? { environment } : {}),
      queuedPosition: input.queuedPosition,
    };

    await this.#transact<void>(
      (state) => {
        const byRun = state.admittedByRun.get(input.runId);
        const ingressRun = state.runByIngress.get(input.ingressKey);
        if (byRun || ingressRun) {
          if (
            !byRun ||
            ingressRun !== input.runId ||
            canonicalize(byRun.record.ingress) !== canonicalize(ingress) ||
            canonicalize(byRun.input) !== canonicalize(userInput) ||
            canonicalize(byRun.record.attachments ?? []) !==
              canonicalize(attachments) ||
            canonicalize(byRun.record.invocation) !== canonicalize(invocation) ||
            canonicalize(byRun.record.environment ?? null) !==
              canonicalize(environment ?? null) ||
            byRun.record.queuedPosition !== input.queuedPosition
          ) {
            throw new Error("Run admission identity has conflicting durable payloads");
          }
          return { kind: "return", value: undefined };
        }
        if (state.queuedRunByPosition.has(input.queuedPosition)) {
          throw new Error("Queued position already belongs to an active run");
        }
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, admitted),
            runRecord(this.#conversationId, {
              t: "state",
              runId: input.runId,
              state: "queued",
              statusRevision: 1,
            }),
          ],
          value: undefined,
        };
      },
      collectArtifactRefs([prepared.references, attachments]),
    );
  }

  /** Atomically admits an input control request and creates its queued run. */
  async applyInputControl(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: InitialControlEnvelope;
    readonly source: TrustedControlSource;
    readonly runId: string;
  }): Promise<ControlAdmissionOutcome> {
    assertIdentifier(input.runId, "Run id");
    const body = input.envelope.body;
    if (body.t !== "input") {
      throw new TypeError("Conversation input admission requires an input request");
    }
    validateNonEmptyUserTurnInput(body.input);
    const userInput = snapshot(body.input, "Run input");
    const invocation = validateConversationInvocation(body.invocation);
    const environment = body.environment === undefined
      ? undefined
      : validateExplicitEnvironmentSelection(body.environment);
    const attachments = validateContentAssetRefs(body.attachments ?? [], {
      allowEmpty: true,
      label: "Control input attachments",
    });
    const prepared = await prepareStored(userInput, this.#artifacts);
    return this.#delivery.coordinate(() => input.admission.applyAuthority<
      RunProjection,
      InitialControlEnvelope
    >({
      envelope: input.envelope,
      source: input.source,
      stream: runStream(this.#conversationId),
      initial: emptyProjection(this.#conversationId),
      reducer: (state, record, commit) =>
        this.#reduce(
          state,
          record as LogicalRecord<ConversationCommitLogRecord>,
          commit as import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
        ),
      candidateReferences: prepared.references,
      companionStreams: ["delivery"],
      prepareCompanions: (state, context, plan) => {
        const statuses = conversationStatusDeliveryInputs(
          this.#conversationId,
          state,
          plan.authorityEntries ?? [],
          context.authorityPrefix.at,
        );
        const delivery = this.#delivery.prepareConversationStatuses(statuses);
        if (!delivery.accepted) throw corruptRunJournal(delivery.error.message);
        return delivery.records;
      },
      onCommitted: (state, commit) => {
        this.#publishStatusNotices(
          conversationStatusNoticesForCommit(
            state,
            commit,
            this.#conversationId,
            this.#ownerEpoch,
          ),
        );
      },
      decide: (state, context) => {
        const request = context.envelope.body;
        if (request.t !== "input") {
          return {
            result: rejectedControl(
              "invalid",
              "Conversation input admission requires an input request",
            ),
          };
        }
        if (state.deleted) {
          return {
            result: rejectedControl(
              "fence-rejected",
              "Conversation has been durably deleted",
            ),
          };
        }
        const ingress = context.ingress;
        if (
          request.conversationId !== this.#conversationId ||
          request.ownerEpoch !== this.#ownerEpoch ||
          !ingress ||
          request.ingress.ingressId !== ingress.ingressId ||
          request.ingress.source !== ingress.kind
        ) {
          return {
            result: rejectedControl(
              "epoch-stale",
              "Input request does not bind the current conversation owner and ingress",
            ),
          };
        }
        const ingressKey = `${ingress.surfacePrincipal}/${ingress.ingressId}`;
        const existingRunId = state.runByIngress.get(ingressKey);
        if (existingRunId) {
          const existing = state.admittedByRun.get(existingRunId);
          if (
            existingRunId !== input.runId ||
            !existing ||
            canonicalize(existing.input) !== canonicalize(userInput) ||
            canonicalize(existing.record.attachments ?? []) !==
              canonicalize(attachments) ||
            canonicalize(existing.record.ingress) !== canonicalize(ingress) ||
            canonicalize(existing.record.invocation) !== canonicalize(invocation)
            ||
            canonicalize(existing.record.environment ?? null) !==
              canonicalize(environment ?? null)
          ) {
            return {
              result: rejectedControl(
                "idempotency-conflict",
                "Ingress already belongs to a different run payload",
              ),
            };
          }
          return {
            result: {
              v: 1,
              status: "ok",
              body: {
                t: "input",
                runId: existingRunId,
                queuedPosition: existing.record.queuedPosition,
              },
            },
          };
        }
        if (state.pendingLifecycleProjections.size > 0) {
          return {
            result: rejectedControl(
              "fence-rejected",
              "Conversation lifecycle projection must finish before new input",
            ),
          };
        }
        const queuedPosition = context.authorityPrefix.nextLsn;
        if (state.admittedByRun.has(input.runId)) {
          return {
            result: rejectedControl(
              "idempotency-conflict",
              "Run id already belongs to a different ingress",
            ),
          };
        }
        const admitted: Extract<ConversationRunJournalRecord, { t: "admitted" }> = {
          t: "admitted",
          ingressKey,
          runId: input.runId,
          input: prepared.stored,
          ...(attachments.length > 0 ? { attachments } : {}),
          ingress,
          invocation,
          ...(environment ? { environment } : {}),
          queuedPosition,
        };
        return {
          result: {
            v: 1,
            status: "ok",
            body: { t: "input", runId: input.runId, queuedPosition },
          },
          authorityEntries: [
            runRecord(this.#conversationId, admitted),
            runRecord(this.#conversationId, {
              t: "state",
              runId: input.runId,
              state: "queued",
              statusRevision: 1,
            }),
          ],
        };
      },
    }));
  }

  async assign(
    unsignedEnvelope: UnsignedConversationEnvelope,
  ): Promise<PendingConversationDispatch> {
    if (unsignedEnvelope.work.conversationId !== this.#conversationId) {
      throw new TypeError("Dispatch belongs to a different conversation journal");
    }
    if (unsignedEnvelope.work.ownerEpoch !== this.#ownerEpoch) {
      throw new TypeError("Dispatch belongs to a different owner epoch");
    }
    const envelope = createSignedConversationEnvelope(
      unsignedEnvelope,
      this.#signer,
      this.#verifier,
    );
    const existingState = await this.#select((state) => {
      const currentAssignmentId = state.assignmentByRun.get(envelope.work.runId);
      const currentAssignment = currentAssignmentId
        ? state.assignedById.get(currentAssignmentId)
        : undefined;
      return {
        currentAssignment: currentAssignment
          ? snapshot(currentAssignment, "Current assignment")
          : undefined,
        assignmentIdInUse: state.assignedById.has(envelope.assignmentId),
      };
    });
    const currentAssignment = existingState.currentAssignment;
    if (currentAssignment) {
      if (
        currentAssignment.record.assignmentId !== envelope.assignmentId ||
        canonicalize(withoutSignature(currentAssignment.envelope)) !==
          canonicalize(withoutSignature(envelope))
      ) {
        throw new Error("Run already has a different durable assignment");
      }
      return this.#materializeDispatch(currentAssignment);
    }
    if (existingState.assignmentIdInUse) {
      throw new Error("Assignment id already belongs to a different run");
    }
    const envelopeReferences = [
      ...(await resolveDispatchArtifactClosure(envelope, this.#artifacts)).transfer,
    ];
    const artifact = dispatchEnvelopeArtifact(envelope);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Dispatch artifact store returned a different reference");
    }
    const transaction = await this.#transact<AssignDecision>(
      (state) => {
        const admitted = state.admittedByRun.get(envelope.work.runId);
        if (!admitted) throw new Error("Run must be durably admitted before assignment");
        if (canonicalize(admitted.record.ingress) !== canonicalize(envelope.work.ingress)) {
          throw new Error("Dispatch ingress does not match the admitted run");
        }
        const existingId = state.assignmentByRun.get(envelope.work.runId);
        const existing = existingId ? state.assignedById.get(existingId) : undefined;
        if (existing) {
          if (
            existing.record.assignmentId !== envelope.assignmentId ||
            canonicalize(withoutSignature(existing.envelope)) !==
              canonicalize(withoutSignature(envelope))
          ) {
            throw new Error("Run already has a different durable assignment");
          }
          return {
            kind: "return",
            value: { assignmentId: existing.record.assignmentId },
          };
        }
        if (state.assignedById.has(envelope.assignmentId)) {
          throw new Error("Assignment id already belongs to a different run");
        }
        const current = state.stateByRun.get(envelope.work.runId);
        if (current?.state !== "queued") {
          throw new Error("Only the current queued run can be assigned");
        }
        if (state.activeRunId !== undefined && state.activeRunId !== envelope.work.runId) {
          throw new Error("Conversation already has an active assignment");
        }
        if (state.queuedPositionHeap[0] !== admitted.record.queuedPosition) {
          throw new Error("Only the earliest queued run can be assigned");
        }
        const assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }> = {
          t: "assigned",
          runId: envelope.work.runId,
          assignmentId: envelope.assignmentId,
          executorId: envelope.executorId,
          ownerEpoch: envelope.work.ownerEpoch,
          baseRevision: envelope.work.baseRevision,
          dispatchDigest: dispatchEnvelopeDigest(envelope),
          manifestDigest: envelope.manifest.digest,
          dispatchRef: artifact.ref,
          permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
          capIds: envelope.capabilities.map((capability) => capability.capId),
          reservation: {
            reservationId: envelope.resourceLease.reservationId,
            attempt: envelope.resourceLease.workload.attempt,
          },
        };
        const governed = requiresFormalResourceCoordination(envelope.resourceLease);
        const resourceRecords = governed && this.#resources
          ? this.#resources.prepareActivation(envelope.resourceLease)
          : [];
        if (governed && !this.#resources) {
          throw new Error("Anchor resource coordination is not configured");
        }
        return {
          kind: "append",
          entries: [
            ...resourceRecords,
            runRecord(this.#conversationId, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: envelope.work.runId,
              assignmentId: envelope.assignmentId,
              state: "dispatched",
              statusRevision: (current?.statusRevision ?? 0) + 1,
            }),
          ],
          value: { assignmentId: envelope.assignmentId },
        };
      },
      [artifact.ref, ...envelopeReferences],
    );
    const assigned = transaction.state.assignedById.get(transaction.value.assignmentId);
    if (!assigned) throw new Error("Assigned commit did not rebuild its outbox fact");
    return this.#materializeDispatch(
      snapshot(assigned, "Assigned outbox projection"),
    );
  }

  async pendingDispatches(): Promise<PendingConversationDispatch[]> {
    const assigned = await this.#select((state) =>
      selectActiveAssignment(state, (candidate, current) =>
        current === "dispatched" &&
        !candidate.acked &&
        !state.superseded.has(candidate.record.assignmentId) &&
        !state.closedAssignments.has(candidate.record.assignmentId)
          ? snapshot(candidate, "Pending dispatch")
          : undefined,
      ),
    );
    return assigned ? [await this.#materializeDispatch(assigned)] : [];
  }

  /**
   * Returns the executor that completed the most recent committed run.
   * This is the owner-authoritative affinity input for the next assignment;
   * failed or merely attempted assignments never become routing preference.
   */
  async recentExecutorAffinity(): Promise<string | undefined> {
    return this.#select((state) => {
      const committed = state.commits.at(-1);
      if (!committed) return undefined;
      const assigned = state.assignedById.get(committed.assignmentId);
      if (!assigned) {
        throw corruptRunJournal(
          "Committed conversation run has no durable assignment",
        );
      }
      return assigned.record.executorId;
    });
  }

  /** Inputs that are durably admitted but have no active assignment, in FIFO order. */
  async pendingInputs(): Promise<PendingConversationInput[]> {
    return this.#select((state) =>
      state.queuedPositionHeap.map((queuedPosition) => {
        const runId = state.queuedRunByPosition.get(queuedPosition);
        const admitted = runId ? state.admittedByRun.get(runId) : undefined;
        const current = runId ? state.stateByRun.get(runId) : undefined;
        if (
          !runId ||
          !admitted ||
          current?.state !== "queued" ||
          state.assignmentByRun.has(runId) ||
          admitted.record.queuedPosition !== queuedPosition
        ) {
          throw corruptRunJournal("Queued input projection is inconsistent");
        }
        return {
          runId,
          input: snapshot(admitted.input, "Pending conversation input"),
          attachments: snapshot(
            admitted.record.attachments ?? [],
            "Pending conversation attachments",
          ),
          ingress: snapshot(admitted.record.ingress, "Pending conversation ingress"),
          invocation: snapshot(
            admitted.record.invocation,
            "Pending conversation invocation",
          ),
          ...(admitted.record.environment
            ? {
                environment: snapshot(
                  admitted.record.environment,
                  "Pending conversation environment",
                ),
              }
            : {}),
          queuedPosition,
        };
      }),
    );
  }

  /** Runs accepted by the user cancellation control plane, in scheduler order. */
  async cancellableRunIds(): Promise<string[]> {
    return (await this.cancellableRuns()).map((run) => run.runId);
  }

  /** Exact durable identity and source for each currently cancellable run. */
  async cancellableRuns(): Promise<ConversationRunControlDescriptor[]> {
    return this.#select((state) => cancellableRunDescriptors(state));
  }

  async runControlDescriptor(
    runId: string,
  ): Promise<ConversationRunControlDescriptor | undefined> {
    assertIdentifier(runId, "Run id");
    return this.#select((state) => {
      const current = state.stateByRun.get(runId)?.state;
      const admitted = state.admittedByRun.get(runId);
      return current && admitted
          ? {
              runId,
              state: current,
              source: admitted.record.invocation.source,
              ingressId: admitted.record.ingress.ingressId,
            }
        : undefined;
    });
  }

  /**
   * 已终结交互的耐久 outcome——单源自权威日志的 interaction mirror 投影,
   * 供 surface 对写后丢响应/重启后的同请求重试回放原结果。耐久 resolve
   * 成功恒先于 mirror 落盘,故"查得到"与"resolve 曾成功返回"一致。
   */
  async interactionOutcome(
    requestId: string,
  ): Promise<{ t: "answered"; decisionDigest: string } | { t: "closed" } | undefined> {
    assertIdentifier(requestId, "Interaction request id");
    return this.#select((state) => {
      for (const batch of state.mirrorBatches.values()) {
        for (const entry of batch.batch.entries) {
          if (entry.requestId !== requestId) continue;
          return entry.outcome.t === "answered"
            ? { t: "answered" as const, decisionDigest: entry.outcome.decisionDigest }
            : { t: "closed" as const };
        }
      }
      return undefined;
    });
  }

  async runByIngress(
    ingressId: string,
    source: ConversationInvocation["source"],
  ): Promise<{ readonly runId: string; readonly state: ConversationRunState } | undefined> {
    assertIdentifier(ingressId, "Ingress id");
    return this.#select((state) => {
      let match:
        | { readonly runId: string; readonly state: ConversationRunState }
        | undefined;
      for (const [runId, admitted] of state.admittedByRun) {
        if (
          admitted.record.ingress.ingressId !== ingressId ||
          admitted.record.invocation.source !== source
        ) {
          continue;
        }
        const current = state.stateByRun.get(runId)?.state;
        if (!current) {
          throw corruptRunJournal("Ingress-bound run has no durable state");
        }
        if (match && match.runId !== runId) {
          throw corruptRunJournal("Ingress identity is bound to multiple durable runs");
        }
        match = { runId, state: current };
      }
      return match;
    });
  }

  async nextAssignmentAttempt(runId: string): Promise<number> {
    assertIdentifier(runId, "Run id");
    return this.#select((state) => nextConversationAssignmentAttempt(state, runId));
  }

  async dispatchesAwaitingStarted(): Promise<PendingConversationDispatch[]> {
    const assigned = await this.#select((state) =>
      selectActiveAssignment(state, (candidate, current) =>
        current === "dispatched" &&
        !state.superseded.has(candidate.record.assignmentId) &&
        !state.closedAssignments.has(candidate.record.assignmentId)
          ? snapshot(candidate, "Dispatch awaiting started")
          : undefined,
      ),
    );
    return assigned ? [await this.#materializeDispatch(assigned)] : [];
  }

  async acknowledgeDispatch(assignmentId: string): Promise<void> {
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Cannot acknowledge an unknown assignment");
      if (assigned.acked) return { kind: "return", value: undefined };
      if (state.assignmentByRun.get(assigned.record.runId) !== assignmentId) {
        throw new Error("Cannot acknowledge a historical assignment");
      }
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, { t: "dispatch-acked", assignmentId }),
        ],
        value: undefined,
      };
    });
  }

  async issueDataPlaneTicket(
    input: DataPlaneTicketIssueRequest,
  ): Promise<DataPlaneTicket> {
    validateTicketIssueRequest(input);
    const transaction = await this.#transact<DataPlaneTicket>(
      (state, authorityPrefix) => {
        const existing = state.ticketsById.get(input.ticketId);
        if (existing) {
          if (
            !dataPlaneTicketIssueMatches(
              existing,
              state.ticketReplacementsById.get(input.ticketId),
              input,
            )
          ) {
            throw new Error("Ticket id already belongs to a different grant");
          }
          return {
            kind: "return",
            value: snapshot(existing, "Issued data-plane ticket"),
          };
        }
        const assigned = state.assignedById.get(input.assignmentId);
        const runState = assigned
          ? state.stateByRun.get(assigned.record.runId)?.state
          : undefined;
        if (
          !assigned ||
          !assigned.acked ||
          state.assignmentByRun.get(assigned.record.runId) !== input.assignmentId ||
          state.closedAssignments.has(input.assignmentId) ||
          (runState !== "dispatched" && runState !== "running") ||
          state.cancelFences.has(input.assignmentId)
        ) {
          throw new Error("Ticket requires a current acknowledged assignment");
        }
        const admitted = state.admittedByRun.get(assigned.record.runId);
        if (!admitted) throw corruptRunJournal("Ticket assignment has no admission");
        if (
          input.kind !== "run-observe" &&
          input.surfacePrincipal !== admitted.record.ingress.surfacePrincipal
        ) {
          throw new Error("Interactive tickets are restricted to the original surface");
        }
        const replaced = input.replacesTicketId
          ? state.ticketsById.get(input.replacesTicketId)
          : undefined;
        if (input.kind === "abort" && input.replacesTicketId !== undefined) {
          throw new Error("Abort tickets are not renewable");
        }
        if (
          input.replacesTicketId !== undefined &&
          (!replaced ||
            state.revokedTickets.has(input.replacesTicketId) ||
            !replaced.renewable ||
            replaced.assignmentId !== input.assignmentId ||
            replaced.surfacePrincipal !== input.surfacePrincipal ||
            replaced.kind !== input.kind)
        ) {
          throw new Error("Ticket renewal does not continue an active renewable grant");
        }
        const issuedAt = authorityPrefix.at;
        const ticket = createSignedDataPlaneTicket(
          {
            v: 1,
            ticketId: input.ticketId,
            ref: {
              execution: "conversation",
              runId: assigned.record.runId,
              conversationId: this.#conversationId,
              ownerEpoch: assigned.record.ownerEpoch,
            },
            assignmentId: input.assignmentId,
            surfacePrincipal: input.surfacePrincipal,
            executorId: assigned.record.executorId,
            issuedAt,
            expiry: new Date(Date.parse(issuedAt) + input.ttlMs).toISOString(),
            kind: input.kind,
            renewable: input.kind !== "abort",
          } as Parameters<typeof createSignedDataPlaneTicket>[0],
          this.#signer,
        );
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, {
              t: "ticket-issued",
              ticket,
              ...(input.replacesTicketId === undefined
                ? {}
                : { replacesTicketId: input.replacesTicketId }),
            }),
            ...(input.replacesTicketId === undefined
              ? []
              : [
                  runRecord(this.#conversationId, {
                    t: "ticket-revoked" as const,
                    ticketId: input.replacesTicketId,
                  }),
                ]),
          ],
          value: ticket,
        };
      },
    );
    return transaction.value;
  }

  async revokeDataPlaneTicket(ticketId: string): Promise<boolean> {
    assertIdentifier(ticketId, "Revoked ticket id");
    const transaction = await this.#transact<boolean>((state) => {
      if (!state.ticketsById.has(ticketId)) {
        throw new Error("Cannot revoke an unknown data-plane ticket");
      }
      if (state.revokedTickets.has(ticketId)) {
        return { kind: "return", value: false };
      }
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, { t: "ticket-revoked", ticketId }),
        ],
        value: true,
      };
    });
    return transaction.value;
  }

  async dataPlaneTicketFacts(): Promise<DataPlaneTicketFacts> {
    const transaction = await this.#transact<DataPlaneTicketFacts>(
      (state, authorityPrefix) => {
        const nextFrontier = nextDataPlaneTicketSyncFrontier(
          state.ticketsById.values(),
          state.ticketSyncFrontier,
          authorityPrefix.at,
        );
        const frontier = nextFrontier ?? state.ticketSyncFrontier;
        const issued = [...state.ticketsById.values()]
          .filter((ticket) => !ticketPrecedesSyncFrontier(ticket, frontier))
          .sort((left, right) => left.ticketId.localeCompare(right.ticketId))
          .map((ticket) => snapshot(ticket, "Issued data-plane ticket"));
        const retainedIds = new Set(issued.map((ticket) => ticket.ticketId));
        const value = {
          issued,
          revokedTicketIds: [...state.revokedTickets]
            .filter((ticketId) => retainedIds.has(ticketId))
            .sort(),
        };
        return nextFrontier === undefined
          ? { kind: "return", value }
          : {
              kind: "append",
              entries: [
                runRecord(this.#conversationId, {
                  t: "ticket-sync-frontier",
                  expiresThrough: nextFrontier,
                }),
              ],
              value,
            };
      },
    );
    return transaction.value;
  }

  async requestSupersede(
    assignmentId: string,
    requestId: string,
  ): Promise<PendingConversationFence["fence"]> {
    assertIdentifier(assignmentId, "Superseded assignment id");
    assertIdentifier(requestId, "Supersede request id");
    const transaction = await this.#transact<PendingConversationFence["fence"]>(
      (state, authorityPrefix) => {
        const assigned = state.assignedById.get(assignmentId);
        const existing = state.supersedeRequests.get(assignmentId);
        if (existing) {
          if (existing.requestId !== requestId) {
            throw new Error("Assignment already has a different supersede request");
          }
          return {
            kind: "return",
            value: { fenceSeq: existing.fenceSeq, requestId: existing.requestId },
          };
        }
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        if (
          !assigned ||
          !current ||
          current.state !== "dispatched" ||
          state.assignmentByRun.get(assigned.record.runId) !== assignmentId
        ) {
          throw new Error("Only a dispatched assignment can be superseded");
        }
        const fence = { fenceSeq: authorityPrefix.nextLsn, requestId };
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, {
              t: "supersede-requested",
              assignmentId,
              ...fence,
            }),
          ],
          value: fence,
        };
      },
    );
    return transaction.value;
  }

  async pendingSupersedes(): Promise<PendingConversationFence[]> {
    const pending = await this.#select((state) =>
      selectActiveAssignment(state, (assigned, current) => {
        const request = state.supersedeRequests.get(assigned.record.assignmentId);
        return request &&
          (current === "dispatched" || current === "cancel-requested" || current === "uncertain") &&
          !state.superseded.has(request.assignmentId) &&
          !state.closedAssignments.has(request.assignmentId) &&
          !state.supersedeStartedObservations.has(request.assignmentId) &&
          !hasRejectedNotStarted(state, request.assignmentId, "supersede")
          ? {
              assignmentId: request.assignmentId,
              fence: { fenceSeq: request.fenceSeq, requestId: request.requestId },
            }
          : undefined;
      }),
    );
    return pending ? [pending] : [];
  }

  async pendingCancellations(): Promise<PendingConversationFence[]> {
    const pending = await this.#select((state) =>
      selectActiveAssignment(state, (assigned, current) => {
        const fence = state.cancelFences.get(assigned.record.assignmentId);
        if (
          !fence ||
          state.superseded.has(fence.assignmentId) ||
          hasRejectedNotStarted(state, fence.assignmentId, "cancel")
        ) {
          return undefined;
        }
        const open = state.resolutionsByRun.get(assigned.record.runId);
        return (current === "cancel-requested" || current === "uncertain") &&
          !(open && state.containedFacts.has(open.openFactDigest))
          ? {
              assignmentId: fence.assignmentId,
              fence: { fenceSeq: fence.fenceSeq, requestId: fence.requestId },
            }
          : undefined;
      }),
    );
    return pending ? [pending] : [];
  }

  async cancelRun(input: ConversationCancelRequest): Promise<ConversationCancelResult> {
    assertIdentifier(input.runId, "Cancelled run id");
    assertIdentifier(input.requestId, "Cancellation request id");
    const transaction = await this.#transact<ConversationCancelResult>(
      (state, authorityPrefix) => {
        const resourceRecords = state.stateByRun.get(input.runId)?.state === "queued"
          ? prepareRunQueuedTerminal(this.#resources, state, input.runId, "cancelled")
          : [];
        return decideConversationCancel(
          this.#conversationId,
          state,
          input,
          authorityPrefix.nextLsn,
          resourceRecords,
        );
      },
    );
    return transaction.value;
  }

  async applyControl(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: ConversationControlEnvelope;
    readonly source: TrustedControlSource;
  }): Promise<ControlAdmissionOutcome> {
    const apply = () => this.#delivery.coordinate(() => input.admission.applyAuthority<
      RunProjection,
      ConversationControlEnvelope
    >({
      envelope: input.envelope,
      source: input.source,
      stream: runStream(this.#conversationId),
      initial: emptyProjection(this.#conversationId),
      reducer: (state, record, commit) =>
        this.#reduce(
          state,
          record as LogicalRecord<ConversationCommitLogRecord>,
          commit as import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
        ),
      companionStreams: ["delivery", "governor"],
      prepareCompanions: (state, context, plan) => {
        const statuses = conversationStatusDeliveryInputs(
          this.#conversationId,
          state,
          plan.authorityEntries ?? [],
          context.authorityPrefix.at,
        );
        const prepared = this.#delivery.prepareConversationStatuses(statuses);
        if (!prepared.accepted) throw corruptRunJournal(prepared.error.message);
        const controlResponses = conversationControlResponseDeliveryInputs(
          this.#conversationId,
          context.envelope,
          plan,
          context.canonicalRequestId,
          context.authorityPrefix.at,
        );
        const resourceRecords = this.#prepareResourceTerminalRecords(
          state,
          plan.authorityEntries ?? [],
        );
        if (controlResponses.length === 0) {
          return [...resourceRecords, ...prepared.records];
        }
        const preparedResponses =
          this.#delivery.prepareConversationControlResponses(controlResponses);
        if (!preparedResponses.accepted) {
          throw corruptRunJournal(preparedResponses.error.message);
        }
        return [...resourceRecords, ...prepared.records, ...preparedResponses.records];
      },
      onCommitted: (state, commit) => {
        this.#publishStatusNotices(
          conversationStatusNoticesForCommit(
            state,
            commit,
            this.#conversationId,
            this.#ownerEpoch,
          ),
        );
      },
      decide: (state, context) => {
        const body = context.envelope.body;
        if (body.t === "session-write") {
          if (
            body.conversationId !== this.#conversationId ||
            body.ownerEpoch !== this.#ownerEpoch
          ) {
            return {
              result: rejectedControl(
                "epoch-stale",
                "Session write does not bind the current conversation owner",
              ),
            };
          }
          if (body.domainRevision !== state.domainRevision) {
            return {
              result: rejectedControl(
                "revision-conflict",
                "Session write domain revision is stale",
              ),
            };
          }
          if (state.deleted) {
            return {
              result: rejectedControl(
                "not-found",
                "Conversation has been durably deleted",
              ),
            };
          }
          if (state.pendingLifecycleProjections.size > 0) {
            return {
              result: rejectedControl(
                "busy",
                "A prior session lifecycle projection is still pending",
              ),
            };
          }
          const mutation =
            body.mutation.kind === "window-op" && body.mutation.op === "clear"
              ? "clear"
              : body.mutation.kind === "conversation-delete"
                ? "delete"
                : undefined;
          if (!mutation) {
            return {
              result: rejectedControl(
                "invalid",
                "Session write mutation is not implemented by this owner",
              ),
            };
          }
          const hasOpenRun = [...state.stateByRun.values()].some(({ state: runState }) =>
            runState === "queued" ||
            runState === "dispatched" ||
            runState === "running" ||
            runState === "cancel-requested" ||
            runState === "uncertain"
          );
          if (hasOpenRun) {
            return {
              result: rejectedControl(
                "busy",
                "Session write requires a quiescent conversation",
              ),
            };
          }
          const revision = state.domainRevision + 1;
          const scope = parseConversationId(this.#conversationId).scope;
          const authorityEntries =
            mutation === "delete" && scope.kind === "workscene"
              ? worksceneSessionMetaEntries(this.#conversationId, {
                  t: "session-meta",
                  operation: "delete",
                  domainRevision: revision,
                  requestId: context.canonicalRequestId,
                  sceneId: scope.sceneId,
                  lastActiveAt: context.authorityPrefix.at,
                })
              : [
                  runRecord(this.#conversationId, {
                    t: "session-lifecycle",
                    mutation,
                    domainRevision: revision,
                    requestId: context.canonicalRequestId,
                  }),
                ];
          return {
            result: {
              v: 1,
              status: "ok",
              body: { t: "session-write", revision },
            },
            authorityEntries,
          };
        }
        if (body.t === "cancel") {
          if (
            body.conversationId !== this.#conversationId ||
            body.ownerEpoch !== this.#ownerEpoch
          ) {
            return {
              result: rejectedControl(
                "epoch-stale",
                "Cancel request does not bind the current conversation owner",
              ),
            };
          }
          const current = state.stateByRun.get(body.runId);
          if (
            !current ||
            (current.state !== "queued" &&
              current.state !== "dispatched" &&
              current.state !== "running")
          ) {
            return {
              result: rejectedControl(
                "fence-rejected",
                "Cancel request targets a closed or non-cancellable run",
              ),
            };
          }
          const decision = decideConversationCancel(
            this.#conversationId,
            state,
            { runId: body.runId, requestId: context.canonicalRequestId },
            context.authorityPrefix.nextLsn,
            current.state === "queued"
              ? prepareRunQueuedTerminal(this.#resources, state, body.runId, "cancelled")
              : [],
          );
          if (decision.kind !== "append") {
            throw corruptRunJournal("Fresh cancel control did not produce an authority change");
          }
          return {
            result: {
              v: 1,
              status: "ok",
              body: { t: "cancel", runState: decision.value.state },
            },
            authorityEntries: decision.entries,
          };
        }
        if (body.t === "cancel-batch") {
          if (
            body.conversationId !== this.#conversationId ||
            body.ownerEpoch !== this.#ownerEpoch
          ) {
            return {
              result: rejectedControl(
                "epoch-stale",
                "Batch cancel request does not bind the current conversation owner",
              ),
            };
          }
          // 候选集在本线性化点内以单源谓词冻结;逐 run 决定与聚合结果同属
          // 这一个权威决定,重放消费 applied 结果、零重新枚举。
          const candidates = cancellableRunDescriptors(state);
          const entries: LogicalRecord<ConversationCommitLogRecord>[] = [];
          const runs: Extract<
            ControlResultBody,
            { t: "cancel-batch" }
          >["runs"] = [];
          for (const candidate of candidates) {
            const decision = decideConversationCancel(
              this.#conversationId,
              state,
              { runId: candidate.runId, requestId: context.canonicalRequestId },
              context.authorityPrefix.nextLsn + entries.length,
              candidate.state === "queued"
                  ? prepareRunQueuedTerminal(
                    this.#resources,
                    state,
                    candidate.runId,
                    "cancelled",
                  )
                : [],
            );
            if (decision.kind === "append") entries.push(...decision.entries);
            runs.push({
              runId: candidate.runId,
              runState: decision.value.state,
              source: candidate.source,
              ingressId: candidate.ingressId,
            });
          }
          return {
            result: {
              v: 1,
              status: "ok",
              body: { t: "cancel-batch", conversationId: this.#conversationId, runs },
            },
            authorityEntries: entries,
          };
        }

        if (
          body.ref.execution !== "conversation" ||
          body.ref.conversationId !== this.#conversationId ||
          body.ref.ownerEpoch !== this.#ownerEpoch
        ) {
          return {
            result: rejectedControl(
              "epoch-stale",
              "Uncertain resolution does not bind the current conversation owner",
            ),
          };
        }
        const current = state.stateByRun.get(body.ref.runId);
        const open = state.resolutionsByRun.get(body.ref.runId);
        const assignmentId = open?.subject.assignmentId;
        const assigned = assignmentId
          ? state.assignedById.get(assignmentId)
          : undefined;
        if (
          !current ||
          current.state !== "uncertain" ||
          !open ||
          open.resolution !== undefined ||
          open.openFactDigest !== body.openFactDigest ||
          !assigned ||
          assigned.record.runId !== body.ref.runId
        ) {
          return {
            result: rejectedControl(
              "fence-rejected",
              "Uncertain resolution targets a closed or different fact",
            ),
          };
        }
        const nextState =
          body.decision === "user-verified-side-effects"
            ? "failed"
            : body.decision === "user-abandoned"
              ? "cancelled"
              : "queued";
        const fact = closeResolution(
          open,
          body.decision,
          context.envelope.principal.surfacePrincipal,
          context.envelope.at,
        );
        return {
          result: {
            v: 1,
            status: "ok",
            body: {
              t: "uncertain-resolve",
              state: nextState,
              factDigest: fact.resolution!.factDigest,
            },
          },
          authorityEntries: [
            runRecord(this.#conversationId, {
              t: "resolution",
              runId: body.ref.runId,
              fact,
            }),
            ...capabilityRevocations(this.#conversationId, state, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: body.ref.runId,
              assignmentId,
              state: nextState,
              statusRevision: current.statusRevision + 1,
            }),
          ],
        };
      },
    }));
    return this.#resources ? this.#resources.coordinate(apply) : apply();
  }

  async closeQueuedRun(
    runId: string,
    outcome: "failed" | "expired",
  ): Promise<void> {
    assertIdentifier(runId, "Queued run id");
    if (outcome !== "failed" && outcome !== "expired") {
      throw new TypeError("Queued run outcome is invalid");
    }
    await this.#transact<void>((state) => {
      const current = state.stateByRun.get(runId);
      if (current?.state === outcome) return { kind: "return", value: undefined };
      if (current?.state !== "queued" || state.assignmentByRun.has(runId)) {
        throw new Error("Only an unassigned queued run can be closed");
      }
      return {
        kind: "append",
        entries: [
          ...prepareRunQueuedTerminal(this.#resources, state, runId, outcome),
          runRecord(this.#conversationId, {
            t: "state",
            runId,
            state: outcome,
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  async failAssignedRun(
    runId: string,
    assignmentId: string,
    reason?: string,
    usageFinal?: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): Promise<void> {
    assertIdentifier(runId, "Failed run id");
    assertIdentifier(assignmentId, "Failed assignment id");
    const boundedReason = reason === undefined
      ? undefined
      : truncateUtf8(reason, 512);
    await this.#transact<void>((state) => {
      const current = state.stateByRun.get(runId);
      if (current?.state === "failed") return { kind: "return", value: undefined };
      const assigned = state.assignedById.get(assignmentId);
      if (
        !assigned ||
        assigned.record.runId !== runId ||
        state.assignmentByRun.get(runId) !== assignmentId ||
        (current?.state !== "dispatched" && current?.state !== "running")
      ) {
        throw new Error("Only the current active assignment may report execution failure");
      }
      return {
        kind: "append",
        entries: [
          ...capabilityRevocations(this.#conversationId, state, assigned),
          runRecord(this.#conversationId, {
            t: "state",
            runId,
            assignmentId,
            state: "failed",
            statusRevision: current.statusRevision + 1,
            ...(boundedReason ? { reason: boundedReason } : {}),
            ...(usageFinal
              ? { usageFinal: snapshot(usageFinal, "Failed run final usage") }
              : {}),
          }),
        ],
        value: undefined,
      };
    });
  }

  async assignmentsAwaitingRecovery(): Promise<
    Array<{
      readonly assignmentId: string;
      readonly state:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain"
        | "committed";
      readonly dispatch: PendingConversationDispatch;
    }>
  > {
    type RecoveryCandidate = {
      readonly assignmentId: string;
      readonly state:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain"
        | "committed";
      readonly assigned: AssignedProjection;
    };
    const candidates = await this.#select((state): RecoveryCandidate[] =>
      [...new Set([
        ...state.recoveryAssignments,
        ...state.bundleAcknowledgementOutbox,
      ])].flatMap<RecoveryCandidate>((assignmentId) => {
        const assigned = state.assignedById.get(assignmentId);
        if (!assigned) {
          throw corruptRunJournal("Recovery outbox names an unknown assignment");
        }
        const current = state.stateByRun.get(assigned.record.runId)?.state;
        const committed = state.committedByAssignment.get(assignmentId);
        if (state.bundleAcknowledgementOutbox.has(assignmentId)) {
          if (
            current !== "committed" ||
            committed?.runId !== assigned.record.runId ||
            state.bundleAcknowledgements.has(assignmentId)
          ) {
            throw corruptRunJournal(
              "Bundle acknowledgement outbox does not bind one pending committed assignment",
            );
          }
          return [{
            assignmentId,
            state: current,
            assigned: snapshot(assigned, "Recoverable committed assignment"),
          }];
        }
        const isCurrent = state.assignmentByRun.get(assigned.record.runId) === assignmentId;
        if (
          !isCurrent ||
          state.superseded.has(assignmentId) ||
          state.closedAssignments.has(assignmentId) ||
          hasRejectedNotStarted(state, assignmentId, "cancel") ||
          hasRejectedNotStarted(state, assignmentId, "dispatch-rejection") ||
          (current !== "dispatched" &&
            current !== "running" &&
            current !== "cancel-requested" &&
            current !== "uncertain")
        ) {
          return [];
        }
        const open = state.resolutionsByRun.get(assigned.record.runId);
        if (open && state.containedFacts.has(open.openFactDigest)) return [];
        return [{
          assignmentId,
          state: current,
          assigned: snapshot(assigned, "Recoverable assignment"),
        }];
      }),
    );
    return Promise.all(
      candidates.map(async ({ assigned, ...candidate }) => ({
        ...candidate,
        dispatch: await this.#materializeDispatch(assigned),
      })),
    );
  }

  async observeBundleAcknowledgement(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const ledger = validateLedgerSnapshot(rawSnapshot, this.#verifier);
    if (
      ledger.assignmentId !== assignmentId ||
      ledger.phase !== "acked" ||
      ledger.sealedBundleRef === undefined ||
      ledger.acknowledgedCommitRevision === undefined
    ) {
      throw new TypeError(
        "Ledger snapshot does not prove acknowledgement of the committed conversation bundle",
      );
    }
    const preflight = await this.#select((state) => {
      const committed = state.committedByAssignment.get(assignmentId);
      if (!committed) {
        throw new Error("Bundle acknowledgement names an uncommitted conversation assignment");
      }
      return {
        expected: conversationBundleAcknowledgementRecord(assignmentId, committed),
        existing: state.bundleAcknowledgements.get(assignmentId),
      };
    });
    assertLedgerAcknowledgesCommittedConversationBundle(ledger, preflight.expected);
    if (preflight.existing) {
      if (canonicalize(preflight.existing) !== canonicalize(preflight.expected)) {
        throw corruptRunJournal("Bundle acknowledgement observation is inconsistent");
      }
      return;
    }
    await this.#transact<void>((state) => {
      const committed = state.committedByAssignment.get(assignmentId);
      const existing = state.bundleAcknowledgements.get(assignmentId);
      if (!committed) {
        throw new Error("Bundle acknowledgement names an uncommitted conversation assignment");
      }
      const expected = conversationBundleAcknowledgementRecord(
        assignmentId,
        committed,
      );
      if (canonicalize(expected) !== canonicalize(preflight.expected)) {
        throw corruptRunJournal("Committed bundle acknowledgement binding changed");
      }
      assertLedgerAcknowledgesCommittedConversationBundle(ledger, expected);
      if (existing) {
        if (canonicalize(existing) !== canonicalize(expected)) {
          throw corruptRunJournal("Bundle acknowledgement observation is inconsistent");
        }
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [runRecord(this.#conversationId, expected)],
        value: undefined,
      };
    }, [preflight.expected.bundleRef]);
  }

  async markAssignmentUncertain(
    assignmentId: string,
    cause: "ledger-unknown" | "cancel-unproven",
  ): Promise<UncertainResolutionFact> {
    assertIdentifier(assignmentId, "Uncertain assignment id");
    const openedAt = this.#clock();
    const transaction = await this.#transact<UncertainResolutionFact>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Cannot mark an unknown assignment uncertain");
      const current = state.stateByRun.get(assigned.record.runId);
      if (!current) throw corruptRunJournal("Assigned run has no state");
      if (state.assignmentByRun.get(assigned.record.runId) !== assignmentId) {
        throw new Error("Cannot reopen uncertainty for a historical assignment");
      }
      const existing = state.resolutionsByRun.get(assigned.record.runId);
      if (current.state === "uncertain" && isOpenResolutionFact(existing)) {
        return { kind: "return", value: existing };
      }
      if (
        current.state !== "dispatched" &&
        current.state !== "running" &&
        current.state !== "cancel-requested"
      ) {
        throw new Error("Run state cannot enter uncertain");
      }
      const fact = createOpenResolutionFact(assigned, cause, openedAt);
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, {
            t: "resolution",
            runId: assigned.record.runId,
            fact,
          }),
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            assignmentId,
            state: "uncertain",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: fact,
      };
    });
    return transaction.value;
  }

  validateExecutorDispatchResult(input: unknown): DispatchResult {
    return validateDispatchResult(input, this.#verifier);
  }

  validateExecutorLedgerSnapshot(input: unknown): LedgerSnapshot {
    return validateLedgerSnapshot(input, this.#verifier);
  }

  async reconcileCancellationEvidence(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
    pages: AsyncIterable<LedgerEvidencePage>,
  ): Promise<boolean> {
    assertIdentifier(assignmentId, "Recovered assignment id");
    const snapshotValue = validateLedgerSnapshot(rawSnapshot, this.#verifier);
    if (
      snapshotValue.assignmentId !== assignmentId ||
      snapshotValue.lastSeq <= 0 ||
      snapshotValue.cancelProof !== undefined ||
      snapshotValue.sealedBundleRef !== undefined ||
      snapshotValue.phase === "halted" ||
      snapshotValue.phase === "failed" ||
      snapshotValue.phase === "sealed" ||
      snapshotValue.phase === "acked"
    ) {
      throw new TypeError("Ledger snapshot is not an unresolved cancellation prefix");
    }

    const current = await this.#select((state) => {
      const assigned = state.assignedById.get(assignmentId);
      return assigned
        ? {
            assigned: snapshot(assigned, "Ledger evidence assignment"),
            runState: state.stateByRun.get(assigned.record.runId)?.state,
            isCurrent:
              state.assignmentByRun.get(assigned.record.runId) === assignmentId,
          }
        : undefined;
    });
    if (!current) throw new Error("Ledger evidence names an unknown assignment");
    const { assigned, runState, isCurrent } = current;
    if (!isCurrent) throw new Error("Ledger evidence belongs to a historical assignment");
    if (runState === "uncertain") return false;
    if (
      runState !== "dispatched" &&
      runState !== "running" &&
      runState !== "cancel-requested"
    ) {
      throw new Error("Ledger evidence is late for the current run state");
    }

    let expectedSeq = 1;
    const validation = createAssignmentLedgerValidationState(assignmentId);
    for await (const rawPage of pages) {
      const page = validateLedgerEvidencePage(rawPage, this.#verifier);
      if (
        page.assignmentId !== assignmentId ||
        page.executorId !== assigned.record.executorId ||
        page.fromSeq !== expectedSeq ||
        page.toSeq > snapshotValue.lastSeq
      ) {
        throw new TypeError("Ledger evidence page does not bind the frozen assignment prefix");
      }
      for (const rawEntry of page.entries) {
        let body: AssignmentRecord;
        if ("ref" in rawEntry.body) {
          const bytes = await this.#artifacts.get(rawEntry.body.ref);
          const text = Buffer.from(bytes).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            throw new TypeError("Ledger evidence artifact is not valid JSON", { cause: error });
          }
          if (canonicalize(parsed) !== text) {
            throw new TypeError("Ledger evidence artifact is not canonical");
          }
          body = validateAssignmentEntry(
            { recordSeq: rawEntry.recordSeq, body: parsed },
            this.#verifier,
          ).body;
        } else {
          body = validateAssignmentEntry(rawEntry, this.#verifier).body;
        }
        const entry: AssignmentEntry = { recordSeq: rawEntry.recordSeq, body };
        if (
          body.t === "control-lease-renewed" &&
          !controlLeaseBindsDispatchEnvelope(body.lease, assigned.envelope)
        ) {
          throw new TypeError(
            "Control lease evidence does not bind the durable assignment",
          );
        }
        switch (body.t) {
          case "received": {
            const activation = validateConversationActivation({
              envelope: assigned.envelope,
              activation: body.activation as AssignmentActivationProof<"conversation">,
              dispatchRef: assigned.record.dispatchRef,
              verifier: this.#verifier,
            });
            const expectedActivation = buildConversationActivationPayload({
              envelope: assigned.envelope,
              dispatchRef: assigned.record.dispatchRef,
              commit: {
                lsn: assigned.commit.lsn,
                envelopeDigest: assigned.commit.envelopeDigest,
              },
              issuedAt: assigned.commit.at,
            });
            if (
              canonicalize(body.envelope.ref) !== canonicalize(assigned.record.dispatchRef) ||
              canonicalize(activation) !== canonicalize(expectedActivation)
            ) {
              throw new TypeError("Received ledger evidence does not bind the durable assignment");
            }
            break;
          }
        }
        applyValidatedAssignmentEntry(validation, entry);
        expectedSeq += 1;
      }
      if (page.chainDigest !== validation.chainDigest) {
        throw new TypeError("Ledger evidence page chain digest is invalid");
      }
    }
    if (
      expectedSeq !== snapshotValue.lastSeq + 1 ||
      validation.lastSeq !== snapshotValue.lastSeq ||
      validation.phase !== snapshotValue.phase
    ) {
      throw new TypeError("Ledger evidence does not close the frozen snapshot prefix");
    }
    if (validation.aborts.size === 0) return false;
    await this.markAssignmentUncertain(assignmentId, "cancel-unproven");
    return true;
  }

  async recordDispatchConflict(
    sent: PendingConversationDispatch,
    result: Extract<DispatchResult, { accepted: false; outcome: "conflicting-redelivery" }>,
  ): Promise<"acked-original" | "opened-uncertain"> {
    const validatedResult = validateDispatchResult(result, this.#verifier);
    if (validatedResult.accepted || validatedResult.outcome !== "conflicting-redelivery") {
      throw new TypeError("Expected a conflicting dispatch result");
    }
    const proof = validateDispatchConflictProof(validatedResult.proof, this.#verifier);
    const sentDispatchRef = dispatchEnvelopeArtifact(sent.envelope).ref;
    const sentActivationDigest = assignmentActivationDigest(withoutSignature(sent.activation));
    if (
      proof.assignmentId !== sent.assignmentId ||
      canonicalize(proof.conflictingDispatchRef) !== canonicalize(sentDispatchRef) ||
      proof.conflictingActivationDigest !== sentActivationDigest
    ) {
      throw new TypeError("Dispatch conflict proof does not bind the attempted dispatch");
    }
    const expectedAssigned = await this.#select((state) => {
      const assigned = state.assignedById.get(sent.assignmentId);
      return assigned ? snapshot(assigned, "Expected assigned dispatch") : undefined;
    });
    if (!expectedAssigned) throw new Error("Dispatch conflict names an unknown assignment");
    const expected = await this.#materializeDispatch(expectedAssigned);
    const expectedDispatchRef = dispatchEnvelopeArtifact(expected.envelope).ref;
    const expectedActivationDigest = assignmentActivationDigest(
      withoutSignature(expected.activation),
    );
    const acceptedMatches =
      canonicalize(proof.acceptedDispatchRef) === canonicalize(expectedDispatchRef) &&
      proof.acceptedActivationDigest === expectedActivationDigest;
    const openedAt = this.#clock();
    const transaction = await this.#transact<"acked-original" | "opened-uncertain">(
      (state, authorityPrefix) => {
        const assigned = state.assignedById.get(sent.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const key = dispatchConflictKey(proof);
        const existing = state.conflicts.get(key);
        if (existing) {
          if (
            canonicalize(withoutSignature(existing.proof)) !==
            canonicalize(withoutSignature(proof))
          ) {
            throw new Error("Dispatch conflict identity has conflicting payloads");
          }
          return { kind: "return", value: existing.handling };
        }
        if (!assigned || !current || current.state !== "dispatched" || assigned.acked) {
          throw new Error("Dispatch conflict is late for the current assignment");
        }
        if (state.assignmentByRun.get(assigned.record.runId) !== sent.assignmentId) {
          throw new Error("Dispatch conflict belongs to a historical assignment");
        }
        if (acceptedMatches) {
          return {
            kind: "append",
            entries: [
              runRecord(this.#conversationId, {
                t: "dispatch-conflict",
                assignmentId: sent.assignmentId,
                proof,
                handling: "acked-original",
              }),
              runRecord(this.#conversationId, {
                t: "dispatch-acked",
                assignmentId: sent.assignmentId,
              }),
            ],
            value: "acked-original",
          };
        }
        const fact = createOpenResolutionFact(assigned, "dispatch-conflict", openedAt);
        const fence = {
          fenceSeq: authorityPrefix.nextLsn,
          requestId: `dispatch-conflict:${proof.conflictingActivationDigest}`,
        };
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, {
              t: "dispatch-conflict",
              assignmentId: sent.assignmentId,
              proof,
              handling: "opened-uncertain",
            }),
            runRecord(this.#conversationId, {
              t: "resolution",
              runId: assigned.record.runId,
              fact,
            }),
            runRecord(this.#conversationId, {
              t: "cancel-fence",
              assignmentId: sent.assignmentId,
              ...fence,
            }),
            ...capabilityRevocations(this.#conversationId, state, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: assigned.record.runId,
              assignmentId: sent.assignmentId,
              state: "uncertain",
              statusRevision: current.statusRevision + 1,
            }),
          ],
          value: "opened-uncertain",
        };
      },
      [proof.acceptedDispatchRef, proof.conflictingDispatchRef],
    );
    return transaction.value;
  }

  async acceptDispatchRejection(
    response: Extract<DispatchResult, { accepted: false; outcome: "rejected-before-received" }>,
  ): Promise<void> {
    const validatedResult = validateDispatchResult(response, this.#verifier);
    if (validatedResult.accepted || validatedResult.outcome !== "rejected-before-received") {
      throw new TypeError("Expected a rejected-before-received dispatch result");
    }
    const proof = validateDispatchRejectionProof(validatedResult.proof, this.#verifier);
    await this.#acceptNotStartedTermination(proof);
  }

  async acceptSupersedeProof(rawProof: SupersedeProof): Promise<void> {
    const proof = validateSupersedeProof(rawProof, this.#verifier);
    // Durable-source binding is judged once inside each transaction by the shared
    // predicate; this entry point only routes on the signed decision.
    if (proof.decision === "not-started-fenced") {
      await this.#acceptNotStartedTermination(proof);
      return;
    }
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(proof.assignmentId);
      if (
        !assigned ||
        !proofBindsConversationSource(
          state,
          assigned,
          proof,
          this.#conversationId,
          this.#legacyAbortTickets,
        )
      ) {
        throw new Error("Supersede proof does not bind a durable assignment");
      }
      const observed = state.supersedeStartedObservations.get(proof.assignmentId);
      if (observed) {
        if (
          canonicalize(withoutSignature(observed.proof)) !==
          canonicalize(withoutSignature(proof))
        ) {
          throw new Error("Supersede already-started observation has conflicting payloads");
        }
        return { kind: "return", value: undefined };
      }
      const current = state.stateByRun.get(assigned.record.runId);
      if (!current) throw corruptRunJournal("Assigned run has no state");
      if (state.assignmentByRun.get(assigned.record.runId) !== proof.assignmentId) {
        throw new Error("Supersede proof belongs to a historical assignment");
      }
      if (
        current.state === "running" ||
        current.state === "committed" ||
        current.state === "cancelled"
      ) {
        return { kind: "return", value: undefined };
      }
      if (current.state === "uncertain" || current.state === "cancel-requested") {
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, {
              t: "supersede-started-observed",
              assignmentId: proof.assignmentId,
              proof,
            }),
          ],
          value: undefined,
        };
      }
      if (current.state !== "dispatched") {
        throw new Error("Already-started proof is late for the current run state");
      }
      return {
        kind: "append",
        entries: [
          ...(!assigned.acked
            ? [
                runRecord(this.#conversationId, {
                  t: "dispatch-acked" as const,
                  assignmentId: proof.assignmentId,
                }),
              ]
            : []),
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            assignmentId: proof.assignmentId,
            state: "running",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  /** Runs the submission guard before a remote adapter dereferences request assets. */
  async preflightSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<AssignmentSubmissionPreflightResult> {
    this.#authenticateSubmission(context, identity);
    const guard = await this.#loadSubmissionGuard(context, identity);
    if (identity.method !== "submission.submitBundle") {
      return { kind: "continue" };
    }
    const assigned = guard.assignedById.get(identity.assignmentId);
    if (!assigned) {
      throw new Error("Bundle capability is not activated by a durable assignment");
    }
    if (!guard.admittedByRun.get(assigned.record.runId)?.ingress) {
      throw new Error("Bundle assignment has no durable ingress");
    }
    if (guard.committedByAssignment.has(identity.assignmentId)) {
      return { kind: "continue" };
    }
    const rejectionMessage = this.#submissionBundleRejection(
      guard,
      context,
      identity.assignmentId,
      assigned.record.runId,
    );
    if (!rejectionMessage) return { kind: "continue" };
    this.#authorizeGuardSubmission(guard, context, {
      mode: "durable-rejection",
      method: "submission.submitBundle",
      assignmentId: identity.assignmentId,
    });
    return {
      kind: "return",
      result: rejected("fence-rejected", rejectionMessage, false),
    };
  }

  async reportStarted(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<void> {
    this.#authenticateSubmission(ctx, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#loadSubmissionGuard(ctx, {
      method: "submission.reportStarted",
      assignmentId,
    });
    await this.#transact<void>((state) => {
      this.#assertActivatedSubmissionCapability(state, ctx, {
        method: "submission.reportStarted",
        assignmentId,
      });
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Started report names an unknown assignment");
      const current = state.stateByRun.get(assigned.record.runId);
      if (
        (state.assignmentByRun.get(assigned.record.runId) === assignmentId &&
          (current?.state === "running" || current?.state === "committed")) ||
        hasDurableStartedObservation(state, assignmentId)
      ) {
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-replay",
          method: "submission.reportStarted",
          assignmentId,
        });
        return { kind: "return", value: undefined };
      }
      if (
        current?.state !== "dispatched" ||
        state.assignmentByRun.get(assigned.record.runId) !== assignmentId
      ) {
        throw new Error("Started report is invalid for the current run state");
      }
      this.#authorizeSubmission(state, ctx, {
        mode: "active",
        method: "submission.reportStarted",
        assignmentId,
      });
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            assignmentId,
            state: "running",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  async reconcileStarted(
    assignmentId: string,
    rawSnapshot: LedgerSnapshot,
  ): Promise<void> {
    const snapshot = validateLedgerSnapshot(rawSnapshot, this.#verifier);
    if (
      snapshot.assignmentId !== assignmentId ||
      (snapshot.phase !== "started" &&
        snapshot.phase !== "sealed" &&
        snapshot.phase !== "acked")
    ) {
      throw new TypeError("Ledger snapshot does not prove that the assignment started");
    }
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Ledger snapshot names an unknown assignment");
      const current = state.stateByRun.get(assigned.record.runId);
      if (
        (state.assignmentByRun.get(assigned.record.runId) === assignmentId &&
          (current?.state === "running" || current?.state === "committed")) ||
        hasDurableStartedObservation(state, assignmentId)
      ) {
        return { kind: "return", value: undefined };
      }
      if (
        current?.state !== "dispatched" ||
        state.assignmentByRun.get(assigned.record.runId) !== assignmentId
      ) {
        throw new Error("Ledger snapshot is invalid for the current run state");
      }
      return {
        kind: "append",
        entries: [
          ...(!assigned.acked
            ? [
                runRecord(this.#conversationId, {
                  t: "dispatch-acked" as const,
                  assignmentId,
                }),
              ]
            : []),
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            assignmentId,
            state: "running",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  async mirrorInteractions(
    assignmentId: string,
    rawBatch: ConversationInteractionMirrorBatch,
    ctx: AuthorityCallContext,
  ): Promise<{
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }> {
    this.#authenticateSubmission(ctx, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    await this.#loadSubmissionGuard(ctx, {
      method: "submission.mirrorInteractions",
      assignmentId,
    });
    if (
      Buffer.byteLength(
        canonicalize({ t: "interaction-mirror", assignmentId, batch: rawBatch }),
        "utf8",
      ) > MAX_INLINE_LOGICAL_RECORD_BYTES
    ) {
      throw new TypeError("Interaction mirror batch exceeds the durable record limit");
    }
    const batch = validateConversationInteractionMirrorBatch(
      rawBatch,
      this.#verifier,
    );
    if (batch.assignmentId !== assignmentId) {
      throw new TypeError("Interaction mirror batch names a different assignment");
    }
    const batchDigest = interactionMirrorBatchDigest(batch);
    const transaction = await this.#transact<{
      mirroredUpTo: number;
      ordinal: number;
      mirrorDigest: string;
    }>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      this.#assertActivatedSubmissionCapability(state, ctx, {
        method: "submission.mirrorInteractions",
        assignmentId,
      });
      if (!assigned || assigned.record.executorId !== batch.executorId) {
        throw new Error("Interaction mirror does not bind the durable assignment");
      }
      const existingBatch = state.mirrorBatches.get(batchDigest);
      if (existingBatch) {
        if (
          canonicalize(withoutSignature(existingBatch.batch)) !==
          canonicalize(withoutSignature(batch))
        ) {
          throw new Error("Interaction mirror batch identity has conflicting payloads");
        }
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-replay",
          method: "submission.mirrorInteractions",
          assignmentId,
        });
        const last = existingBatch.batch.entries.at(-1)!;
        return {
          kind: "return",
          value: {
            mirroredUpTo: last.seq,
            ordinal: last.ordinal,
            mirrorDigest: existingBatch.batch.mirrorDigest,
          },
        };
      }
      const mirrorState = state.mirrorStateByAssignment.get(assignmentId);
      if (!mirrorState) {
        throw new Error("Interaction mirror projection is missing its assignment");
      }
      const first = batch.entries[0]!;
      const last = batch.entries.at(-1)!;
      if (
        batch.previousDigest !== mirrorState.mirrorDigest ||
        first.ordinal !== mirrorState.ordinal + 1 ||
        first.seq <= mirrorState.mirroredUpTo
      ) {
        throw new Error("Interaction mirror batch does not continue the durable audit prefix");
      }
      const batchRequestIds = new Set<string>();
      for (const entry of batch.entries) {
        if (
          mirrorState.requestIds.has(entry.requestId) ||
          batchRequestIds.has(entry.requestId)
        ) {
          throw new Error("Interaction mirror batch repeats a durable request identity");
        }
        batchRequestIds.add(entry.requestId);
      }
      const current = state.stateByRun.get(assigned.record.runId)?.state;
      if (
        state.assignmentByRun.get(assigned.record.runId) !== assignmentId ||
        state.closedAssignments.has(assignmentId) ||
        (current !== "dispatched" && current !== "running" &&
          !(
            (current === "cancel-requested" || current === "uncertain") &&
            state.cancelFences.has(assignmentId)
          ))
      ) {
        throw new Error("New interaction mirror belongs to a historical assignment");
      }
      this.#authorizeSubmission(state, ctx, {
        mode:
          current === "cancel-requested" || current === "uncertain"
            ? "settlement"
            : "active",
        method: "submission.mirrorInteractions",
        assignmentId,
      });
      const mirrorRecord: Extract<ConversationRunJournalRecord, { t: "interaction-mirror" }> = {
        t: "interaction-mirror",
        assignmentId,
        batch,
      };
      if (
        Buffer.byteLength(canonicalize(mirrorRecord), "utf8") >
        MAX_INLINE_LOGICAL_RECORD_BYTES
      ) {
        throw new TypeError("Interaction mirror batch exceeds the durable record limit");
      }
      return {
        kind: "append",
        entries: [runRecord(this.#conversationId, mirrorRecord)],
        value: {
          mirroredUpTo: last.seq,
          ordinal: last.ordinal,
          mirrorDigest: batch.mirrorDigest,
        },
      };
    });
    return transaction.value;
  }

  async submitCancelProof(
    assignmentId: string,
    rawProof: CancelProofBody,
    ctx: AuthorityCallContext,
  ): Promise<void> {
    assertIdentifier(assignmentId, "Cancelled assignment id");
    this.#authenticateSubmission(ctx, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    await this.#loadSubmissionGuard(ctx, {
      method: "submission.submitCancelProof",
      assignmentId,
    });
    const proof = validateCancelProof(rawProof, this.#verifier);
    if (proof.assignmentId !== assignmentId) {
      throw new TypeError("Cancel proof names a different assignment");
    }
    const at = this.#clock();
    await this.#transact<void>((state) => {
      this.#assertActivatedSubmissionCapability(state, ctx, {
        method: "submission.submitCancelProof",
        assignmentId,
      });
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) {
        throw new Error("Cancel proof does not bind the durable assignment authority");
      }
      if (
        !proofBindsConversationSource(
          state,
          assigned,
          proof,
          this.#conversationId,
          this.#legacyAbortTickets,
        )
      ) {
        throw new Error(
          proof.cause === "abort-ticket"
            ? "Abort proof does not bind an owner-issued abort ticket"
            : "Cancel proof does not bind the durable assignment authority",
        );
      }
      const current = state.stateByRun.get(assigned.record.runId);
      if (!current) throw corruptRunJournal("Cancelled assignment has no run state");
      const accepted = state.acceptedCancellations.get(assignmentId);
      const prior = state.superseded.get(assignmentId);
      const containment = state.containmentByAssignment.get(assignmentId);
      const rejectedNotStarted = state.rejectedNotStarted.get(
        rejectedNotStartedKey(assignmentId, "cancel"),
      );
      const durableProofs = [
        accepted?.proof,
        prior?.proof,
        containment?.proof,
        rejectedNotStarted?.proof,
      ].filter((candidate): candidate is AssignmentTerminationProof | CancelProofBody =>
        candidate !== undefined,
      );
      if (durableProofs.length > 0) {
        if (
          durableProofs.some(
            (candidate) =>
              canonicalize(withoutSignature(candidate)) !==
              canonicalize(withoutSignature(proof)),
          )
        ) {
          throw new Error("Assignment already has a different durable termination proof");
        }
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-replay",
          method: "submission.submitCancelProof",
          assignmentId,
        });
        return { kind: "return", value: undefined };
      }
      if (state.assignmentByRun.get(assigned.record.runId) !== assignmentId) {
        throw new Error("Cancel proof belongs to a historical assignment");
      }
      if (current.state === "cancelled" || current.state === "committed") {
        throw new Error("Cancel proof has no matching durable terminal fact");
      }
      this.#authorizeSubmission(state, ctx, {
        mode: "settlement",
        method: "submission.submitCancelProof",
        assignmentId,
      });

      const open = state.resolutionsByRun.get(assigned.record.runId);
      const contradictoryNotStarted =
        proof.decision === "not-started" &&
        hasDurableStartedObservation(state, assignmentId);
      if (contradictoryNotStarted) {
        const rejectionKey = rejectedNotStartedKey(assignmentId, "cancel");
        const existingRejection = state.rejectedNotStarted.get(rejectionKey);
        if (existingRejection) {
          throw corruptRunJournal("Rejected not-started proof was not replayed durably");
        }
        const rejection = runRecord(this.#conversationId, {
          t: "not-started-rejected",
          assignmentId,
          proof,
        });
        if (current.state === "uncertain") {
          return { kind: "append", entries: [rejection], value: undefined };
        }
        const fact = createOpenResolutionFact(assigned, "cancel-unproven", at);
        return {
          kind: "append",
          entries: [
            rejection,
            runRecord(this.#conversationId, {
              t: "resolution",
              runId: assigned.record.runId,
              fact,
            }),
            ...capabilityRevocations(this.#conversationId, state, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: assigned.record.runId,
              assignmentId,
              state: "uncertain",
              statusRevision: current.statusRevision + 1,
            }),
          ],
          value: undefined,
        };
      }
      if (current.state === "uncertain") {
        if (!open || open.resolution) {
          throw corruptRunJournal("Uncertain cancellation has no open resolution fact");
        }
        const conflict = open.cause === "dispatch-conflict";
        if (conflict) {
          const conflictRecord = state.conflictByAssignment.get(assignmentId);
          if (
            !conflictRecord ||
            proof.lastRecordSeq <= conflictRecord.proof.receivedRecordSeq
          ) {
            throw new Error("Conflict containment proof does not follow the received prefix");
          }
        }
        const requiresContainment = conflict || proof.decision === "halted";
        if (requiresContainment && state.containedFacts.has(open.openFactDigest)) {
          throw corruptRunJournal("Contained cancel proof was not replayed durably");
        }
        const containment = requiresContainment
          ? runRecord(this.#conversationId, {
              t: conflict ? "dispatch-conflict-contained" : "cancel-contained",
              assignmentId,
              openFactDigest: open.openFactDigest,
              proof,
            })
          : undefined;
        if (proof.decision === "halted") {
          return { kind: "append", entries: [containment!], value: undefined };
        }
        this.#assertResourceUsageFinal(assigned.record, proof.usageFinal);
        const resolved = closeResolution(
          open,
          "proven-not-started-redispatched",
          proof.executorId,
          at,
        );
        return {
          kind: "append",
          entries: [
            ...(containment ? [containment] : []),
            runRecord(this.#conversationId, {
              t: "assignment-superseded",
              assignmentId,
              proof,
            }),
            runRecord(this.#conversationId, {
              t: "resolution",
              runId: assigned.record.runId,
              fact: resolved,
            }),
            ...capabilityRevocations(this.#conversationId, state, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: assigned.record.runId,
              assignmentId,
              state: "queued",
              statusRevision: current.statusRevision + 1,
            }),
          ],
          value: undefined,
        };
      }

      if (
        current.state !== "cancel-requested" &&
        current.state !== "dispatched" &&
        current.state !== "running"
      ) {
        throw new Error("Cancel proof is late for the current run state");
      }
      this.#assertResourceUsageFinal(assigned.record, proof.usageFinal);
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, {
            t: "cancel-proof-accepted",
            assignmentId,
            proof,
          }),
          ...capabilityRevocations(this.#conversationId, state, assigned),
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            assignmentId,
            state: "cancelled",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  async submitBundle(
    rawBundle: SealedBundle,
    ctx: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: import("@zhixing/core/contracts").AuthorityError;
      }
  > {
    if (ctx.principal.kind !== "assignment") {
      throw new Error("Bundle submission requires an assignment capability");
    }
    const assignmentId = ctx.principal.capability.assignmentId;
    this.#authenticateSubmission(ctx, {
      method: "submission.submitBundle",
      assignmentId,
    });
    const guard = await this.#loadSubmissionGuard(ctx, {
      method: "submission.submitBundle",
      assignmentId,
    });
    const guardAssigned = guard.assignedById.get(assignmentId);
    if (!guardAssigned) {
      throw new Error("Bundle capability is not activated by a durable assignment");
    }
    const guardIngress = guard.admittedByRun.get(guardAssigned.record.runId)?.ingress;
    if (!guardIngress) throw new Error("Bundle assignment has no durable ingress");
    const guardCommitted = guard.committedByAssignment.get(assignmentId);
    if (!guardCommitted) {
      const guardState = guard.stateByRun.get(guardAssigned.record.runId)?.state;
      const rejectionMessage = this.#submissionBundleRejection(
        guard,
        ctx,
        assignmentId,
        guardAssigned.record.runId,
      );
      if (rejectionMessage) {
        this.#authorizeGuardSubmission(guard, ctx, {
          mode: "durable-rejection",
          method: "submission.submitBundle",
          assignmentId,
        });
        return rejected("fence-rejected", rejectionMessage, false);
      }
      this.#authorizeGuardSubmission(guard, ctx, {
        mode: guardState === "uncertain" ? "settlement" : "active",
        method: "submission.submitBundle",
        assignmentId,
      });
    }

    let bundle: ReturnType<typeof validateConversationSealedBundle>;
    try {
      bundle = validateConversationSealedBundle(rawBundle);
    } catch (error) {
      return rejected("invalid", error instanceof Error ? error.message : "Invalid bundle", false);
    }
    if (bundle.assignmentId !== assignmentId) {
      return rejected(
        "fence-rejected",
        "Bundle does not bind the authenticated assignment",
        false,
      );
    }
    const artifact = sealedBundleArtifact(bundle);
    if (guardCommitted) {
      if (canonicalize(guardCommitted.bundle.ref) !== canonicalize(artifact.ref)) {
        this.#authorizeGuardSubmission(guard, ctx, {
          mode: "active",
          method: "submission.submitBundle",
          assignmentId,
        });
        return rejected(
          "fence-rejected",
          "Assignment already committed another bundle",
          false,
        );
      }
      if (!submissionCommitSidecarsMatch(guardCommitted.sidecars, bundle)) {
        throw corruptRunJournal("Committed bundle does not match its durable sidecars");
      }
      const capability = ctx.principal.capability;
      if (
        capability.scope.execution !== "conversation" ||
        !("ownerEpoch" in capability) ||
        capability.ownerEpoch !== guardAssigned.record.ownerEpoch ||
        bundle.body.conversationId !== this.#conversationId ||
        bundle.body.runId !== guardAssigned.record.runId ||
        !historicalBundleFenceMatches({
          assignedExecutorId: guardAssigned.record.executorId,
          assignedOwnerEpoch: guardAssigned.record.ownerEpoch,
          assignedBaseRevision: guardAssigned.record.baseRevision,
          bundleExecutorId: bundle.executorId,
          bundleOwnerEpoch: bundle.body.ownerEpoch,
          bundleBaseRevision: bundle.body.baseRevision,
          conflictOpen: guard.openConflictAssignments.has(assignmentId),
        }) ||
        bundle.body.baseRevision + 1 !== guardCommitted.commitRevision
      ) {
        throw corruptRunJournal(
          "Committed bundle does not match its durable assignment fence",
        );
      }
      this.#authorizeGuardSubmission(guard, ctx, {
        mode: "durable-replay",
        method: "submission.submitBundle",
        assignmentId,
      });
      this.#assertResourceUsageFinal(guardAssigned.record, bundle.usageFinal);
      return { committed: true, commitRevision: guardCommitted.commitRevision };
    }

    const preflight = await this.#select((state) => {
      this.#assertActivatedSubmissionCapability(state, ctx, {
        method: "submission.submitBundle",
        assignmentId,
      });
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) {
        throw new Error("Bundle capability is not activated by a durable assignment");
      }
      const committed = state.committedByAssignment.get(assignmentId);
      if (committed) {
        if (canonicalize(committed.bundle.ref) !== canonicalize(artifact.ref)) {
          this.#authorizeSubmission(state, ctx, {
            mode: "active",
            method: "submission.submitBundle",
            assignmentId,
          });
          return {
            kind: "return" as const,
            value: rejected(
              "fence-rejected",
              "Assignment already committed another bundle",
              false,
            ),
          };
        }
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-replay",
          method: "submission.submitBundle",
          assignmentId,
        });
        return {
          kind: "return" as const,
          value: { committed: true as const, commitRevision: committed.commitRevision },
        };
      }
      if (state.assignmentByRun.get(assigned.record.runId) !== assignmentId) {
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-rejection",
          method: "submission.submitBundle",
          assignmentId,
        });
        return {
          kind: "return" as const,
          value: rejected(
            "fence-rejected",
            "Bundle belongs to a historical assignment",
            false,
          ),
        };
      }
      const currentRunState = state.stateByRun.get(assigned.record.runId)?.state;
      const openResolution = state.resolutionsByRun.get(assigned.record.runId);
      if (
        currentRunState === "uncertain" &&
        openResolution?.cause === "dispatch-conflict" &&
        !openResolution.resolution
      ) {
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-rejection",
          method: "submission.submitBundle",
          assignmentId,
        });
        return {
          kind: "return" as const,
          value: rejected(
            "fence-rejected",
            "Bundle is blocked by an open dispatch conflict",
            false,
          ),
        };
      }
      if (
        currentRunState !== "dispatched" &&
        currentRunState !== "running" &&
        currentRunState !== "cancel-requested" &&
        currentRunState !== "uncertain"
      ) {
        this.#authorizeSubmission(state, ctx, {
          mode: "durable-rejection",
          method: "submission.submitBundle",
          assignmentId,
        });
        return {
          kind: "return" as const,
          value: rejected(
            "fence-rejected",
            "Bundle is late for the current run state",
            false,
          ),
        };
      }
      this.#authorizeSubmission(state, ctx, {
        mode: currentRunState === "uncertain" ? "settlement" : "active",
        method: "submission.submitBundle",
        assignmentId,
      });
      return {
        kind: "proceed" as const,
        assigned: snapshot(assigned, "Bundle preflight assignment"),
      };
    });
    if (preflight.kind === "return") return preflight.value;
    const preflightBody = bundle.body;
    if (
      preflightBody.conversationId !== this.#conversationId ||
      preflightBody.runId !== preflight.assigned.record.runId ||
      preflightBody.ownerEpoch !== this.#ownerEpoch ||
      !historicalBundleFenceMatches({
        assignedExecutorId: preflight.assigned.record.executorId,
        assignedOwnerEpoch: preflight.assigned.record.ownerEpoch,
        assignedBaseRevision: preflight.assigned.record.baseRevision,
        bundleExecutorId: bundle.executorId,
        bundleOwnerEpoch: preflightBody.ownerEpoch,
        bundleBaseRevision: preflightBody.baseRevision,
        conflictOpen: false,
      })
    ) {
      return rejected(
        "fence-rejected",
        "Bundle fence does not match the durable assignment",
        false,
      );
    }
    let closure: ValidatedConversationBundleClosure;
    try {
      closure = await validateConversationBundleClosure(bundle, this.#artifacts);
    } catch (error) {
      if (error instanceof BundleClosureError) {
        return rejected(error.code, error.message, error.code === "missing-base");
      }
      throw error;
    }
    const {
      artifact: closedArtifact,
      batch,
      references,
      runRecord: committedRunRecord,
    } = closure;
    if (canonicalize(closedArtifact.ref) !== canonicalize(artifact.ref)) {
      throw new Error("Bundle closure changed its artifact identity");
    }
    if (
      batch?.records.some(
        (record) =>
          record.domain === "global" && record.mutation.kind !== "delivery-enqueue",
      ) &&
      !this.#publisher
    ) {
      return rejected("capability-gap", "Global staged mutation publisher is not configured", false);
    }
    const compiledDelivery = await compileConversationDeliveryContents(
      committedRunRecord,
      batch,
      this.#artifacts,
      guardIngress,
    );

    const transaction = await this.#transact<
        | { readonly committed: true; readonly commitRevision: number }
        | {
            readonly committed: false;
            readonly error: import("@zhixing/core/contracts").AuthorityError;
          }
      >(
        (state, authorityPrefix) => {
        this.#assertActivatedSubmissionCapability(state, ctx, {
          method: "submission.submitBundle",
          assignmentId,
        });
        const assigned = state.assignedById.get(bundle.assignmentId);
        const committed = state.committedByAssignment.get(bundle.assignmentId);
        if (committed) {
          if (canonicalize(committed.bundle.ref) !== canonicalize(artifact.ref)) {
            this.#authorizeSubmission(state, ctx, {
              mode: "active",
              method: "submission.submitBundle",
              assignmentId: bundle.assignmentId,
            });
            return {
              kind: "return",
              value: rejected(
                "fence-rejected",
                "Assignment already committed another bundle",
                false,
              ),
            };
          }
          this.#authorizeSubmission(state, ctx, {
            mode: "durable-replay",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: { committed: true, commitRevision: committed.commitRevision },
          };
        }
        if (!assigned) {
          this.#authorizeSubmission(state, ctx, {
            mode: "active",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle names an unknown assignment", false),
          };
        }
        const body = bundle.body;
        if (state.assignmentByRun.get(assigned.record.runId) !== bundle.assignmentId) {
          this.#authorizeSubmission(state, ctx, {
            mode: "durable-rejection",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: rejected(
              "fence-rejected",
              "Bundle belongs to a historical assignment",
              false,
            ),
          };
        }
        if (
          body.conversationId !== this.#conversationId ||
          body.runId !== assigned.record.runId ||
          body.ownerEpoch !== this.#ownerEpoch ||
          !historicalBundleFenceMatches({
            assignedExecutorId: assigned.record.executorId,
            assignedOwnerEpoch: assigned.record.ownerEpoch,
            assignedBaseRevision: assigned.record.baseRevision,
            bundleExecutorId: bundle.executorId,
            bundleOwnerEpoch: body.ownerEpoch,
            bundleBaseRevision: body.baseRevision,
            conflictOpen: false,
          })
        ) {
          this.#authorizeSubmission(state, ctx, {
            mode: "active",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: rejected(
              "fence-rejected",
              "Bundle fence does not match the durable assignment",
              false,
            ),
          };
        }
        const currentRunState = state.stateByRun.get(body.runId)?.state;
        const openResolution = state.resolutionsByRun.get(body.runId);
        if (
          currentRunState === "uncertain" &&
          openResolution?.cause === "dispatch-conflict" &&
          !openResolution.resolution
        ) {
          this.#authorizeSubmission(state, ctx, {
            mode: "durable-rejection",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: rejected(
              "fence-rejected",
              "Bundle is blocked by an open dispatch conflict",
              false,
            ),
          };
        }
        if (
          currentRunState !== "dispatched" &&
          currentRunState !== "running" &&
          currentRunState !== "cancel-requested" &&
          currentRunState !== "uncertain"
        ) {
          this.#authorizeSubmission(state, ctx, {
            mode: "active",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle is late for the current run state", false),
          };
        }
        this.#assertResourceUsageFinal(assigned.record, bundle.usageFinal);
        const previousCommit = state.commits.at(-1);
        if (
          previousCommit &&
          body.baseRevision !== previousCommit.commitRevision
        ) {
          this.#authorizeSubmission(state, ctx, {
            mode: "active",
            method: "submission.submitBundle",
            assignmentId: bundle.assignmentId,
          });
          return {
            kind: "return",
            value: rejected(
              "revision-conflict",
              "Conversation base revision does not follow the durable commit chain",
              false,
            ),
          };
        }
        this.#authorizeSubmission(state, ctx, {
          mode: currentRunState === "uncertain" ? "settlement" : "active",
          method: "submission.submitBundle",
          assignmentId: bundle.assignmentId,
        });
        const sessionRecords = (batch?.records ?? [])
          .filter((record) => record.domain === "session")
          .map((record) => ({
            seq: record.seq,
            mutation: record.mutation as SessionStagedMutation,
            requestId: record.requestId,
          }));
        const authorityDecision = snapshot(
          this.#authority.decideAtPrefix({
            assignmentId: bundle.assignmentId,
            authorityPrefixLsn: authorityPrefix.lastLsn,
            conversationId: this.#conversationId,
            ownerEpoch: body.ownerEpoch,
            baseRevision: body.baseRevision,
            runRecord: committedRunRecord,
            sessionMutations: sessionRecords,
          }),
          "Conversation commit authority decision",
        );
        if (!authorityDecision.committed) {
          validateAuthorityErrorContract(authorityDecision.error);
          return { kind: "return", value: authorityDecision };
        }
        const commitRevision = authorityDecision.commitRevision;
        if (
          !Number.isSafeInteger(commitRevision) ||
          commitRevision <= 0 ||
          commitRevision !== body.baseRevision + 1 ||
          commitRevision <= (state.commits.at(-1)?.commitRevision ?? 0)
        ) {
          return {
            kind: "return",
            value: rejected(
              "revision-conflict",
              "Conversation authority returned an invalid commit revision",
              false,
            ),
          };
        }
        const outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"] = [];
        const admitted = state.admittedByRun.get(body.runId);
        if (!admitted) throw corruptRunJournal("Committed run has no durable ingress");
        const deliveryInput: ConversationDeliveryCommitInput = {
          at: authorityPrefix.at,
          conversationId: this.#conversationId,
          runId: body.runId,
          assignmentId: bundle.assignmentId,
          commitRevision,
          ingress: admitted.record.ingress,
          runRecord: committedRunRecord,
          ...(batch ? { mutationBatch: batch } : {}),
          ...(compiledDelivery.final
            ? { finalContent: compiledDelivery.final.content }
            : {}),
          stagedContents: compiledDelivery.stagedContents,
          stagedContentErrors: compiledDelivery.stagedContentErrors,
        };
        const deliveryDecision = this.#delivery.prepareConversationCommit(deliveryInput);
        if (!deliveryDecision.accepted) {
          return {
            kind: "return",
            value: { committed: false as const, error: deliveryDecision.error },
          };
        }
        if (batch) {
          const globalRecords = batch.records
            .filter(
              (record) =>
                record.domain === "global" &&
                record.mutation.kind !== "delivery-enqueue",
            )
            .map((record) => ({
              seq: record.seq,
              mutation: record.mutation as GlobalStagedMutation,
              requestId: record.requestId,
              expected: record.expected!,
            }));
          const globalOutcomes =
            globalRecords.length === 0
              ? new Map<number, ReturnType<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>[number]["outcome"]>()
              : validateGlobalPublishBatchOutcomes(
                  globalRecords,
                  this.#publisher!.decideGlobalBatchAtPrefix({
                    assignmentId: bundle.assignmentId,
                    authorityPrefixLsn: authorityPrefix.lastLsn,
                    records: globalRecords,
                  }),
                );
          for (const record of batch.records) {
            if (record.domain === "session") {
              outcomes.push({
                seq: record.seq,
                outcome: { t: "granted", targetRevision: commitRevision },
              });
            } else {
              const outcome =
                record.mutation.kind === "delivery-enqueue"
                  ? deliveryDecision.stagedRevisions.has(record.seq)
                    ? {
                        t: "granted" as const,
                        targetRevision: deliveryDecision.stagedRevisions.get(record.seq)!,
                      }
                    : deliveryDecision.stagedConflicts.has(record.seq)
                      ? {
                          t: "conflicted" as const,
                          error: deliveryDecision.stagedConflicts.get(record.seq)!,
                        }
                      : undefined
                  : globalOutcomes.get(record.seq);
              if (!outcome) throw new TypeError("Global publish batch omitted a mutation");
              outcomes.push({ seq: record.seq, outcome });
            }
          }
        }
        const committedRecord: Extract<ConversationRunJournalRecord, { t: "committed" }> = {
          t: "committed",
          runId: body.runId,
          assignmentId: bundle.assignmentId,
          bundle: { ref: artifact.ref },
          commitRevision,
        };
        const entries: LogicalRecord<unknown>[] = [
          runRecord(this.#conversationId, committedRecord),
          runRecord(this.#conversationId, {
            kind: "content-asset-index",
            entries: body.contentAssets,
          }),
          ...worksceneTurnActivityEntries(
            this.#conversationId,
            state.domainRevision + 1,
            bundle.assignmentId,
            committedRunRecord.timestamp,
            state.sessionMeta ? "touch" : "create",
          ),
          ...capabilityRevocations(this.#conversationId, state, assigned),
          runRecord(this.#conversationId, {
            t: "state",
            runId: body.runId,
            assignmentId: bundle.assignmentId,
            state: "committed",
            statusRevision:
              (state.stateByRun.get(body.runId)?.statusRevision ?? 0) + 1,
          }),
          ...deliveryDecision.records,
        ];
        if (currentRunState === "uncertain") {
          if (!openResolution || openResolution.resolution) {
            throw corruptRunJournal("Uncertain run has no open resolution fact");
          }
          entries.push(
            runRecord(this.#conversationId, {
              t: "resolution",
              runId: body.runId,
              fact: closeResolution(
                openResolution,
                "late-bundle-committed",
                bundle.executorId,
                this.#clock(),
              ),
            }),
          );
        }
        if (
          batch &&
          body.mutationBatch &&
          publishDecisionRequired(batch.records, outcomes)
        ) {
          entries.push({
            stream: "publish",
            body: {
              t: "publish-decision",
              assignmentId: bundle.assignmentId,
              batch: { ref: body.mutationBatch.ref },
              sessionCount: body.mutationBatch.sessionCount,
              globalCount: body.mutationBatch.globalCount,
              outcomes,
            },
          });
          for (const domain of ["session", "global"] as const) {
            if (
              domainPublishDecisionRequired(batch.records, outcomes, domain)
            ) {
              entries.push({
                stream: "publish",
                body: {
                  t: "publish-progress",
                  assignmentId: bundle.assignmentId,
                  domain,
                  upToSeq: 0,
                  state: "pending",
                },
              });
            }
          }
        }
        entries.push({
          stream: "final-outbox",
          body: {
            t: "final",
            conversationId: this.#conversationId,
            runId: body.runId,
            commitRevision,
            digest: bundle.digest,
            state: "pending",
          },
        });
        return {
          kind: "append",
          entries,
          value: { committed: true, commitRevision },
        };
        },
        [...references, ...compiledDelivery.references],
      ).catch((error: unknown) => {
        if (error instanceof AuthorityStorageError && error.code === "artifact-missing") {
          return undefined;
        }
        throw error;
      });
    if (!transaction) {
      return rejected(
        "missing-base",
        "Bundle artifact disappeared before the commit point",
        true,
      );
    }
    // The CAS result is authoritative. Transcript and staged-mutation
    // materialization are durable projections redriven by the runtime; their
    // failure must never reclassify an already committed run.
    return transaction.value;
  }

  /** Rebuild every missing post-commit projection from durable committed facts. */
  async resumeCommittedProjections(): Promise<number> {
    const pending = await this.#select((state) =>
      [...state.pendingCommitProjections.values()].map((committed) =>
        snapshot(committed, "Pending commit projection"),
      ),
    );
    let projected = 0;
    for (const committed of pending) {
      const bytes = await this.#artifacts.get(committed.bundle.ref);
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
      );
      const closure = await validateConversationBundleClosure(bundle, this.#artifacts);
      await this.#projection.project({
        assignmentId: committed.assignmentId,
        conversationId: this.#conversationId,
        commitRevision: committed.commitRevision,
        digest: bundle.digest,
        runRecord: closure.runRecord,
        ...(bundle.body.windowCompact ? { windowCompact: bundle.body.windowCompact } : {}),
        contentAssets: bundle.body.contentAssets,
      });
      const progress: ConversationProjectionRecord = {
        kind: "conversation-commit-projection",
        assignmentId: committed.assignmentId,
        runId: committed.runId,
        commitRevision: committed.commitRevision,
        digest: bundle.digest,
      };
      const transaction = await this.#transact<boolean>((current) => {
        const durable = current.committedByAssignment.get(committed.assignmentId);
        if (!durable) throw corruptRunJournal("Projection progress has no committed run");
        if (current.projectedByAssignment.has(committed.assignmentId)) {
          return { kind: "return", value: false };
        }
        return {
          kind: "append",
          entries: [runRecord(this.#conversationId, progress)],
          value: true,
        };
      });
      if (transaction.value) projected += 1;
    }
    return projected;
  }

  async resumePublishing(assignmentId: string): Promise<number> {
    assertIdentifier(assignmentId, "Assignment id");
    const [projection, committed] = await Promise.all([
      this.#selectPublish((state) => {
        const decision = state.decisions.get(assignmentId);
        if (!decision) return undefined;
        const batch = state.batches.get(assignmentId);
        if (!batch) {
          throw corruptRunJournal("Publish decision has no validated mutation batch");
        }
        // Decision, batch, and domain plans are immutable after insertion; settlement
        // only removes their map entries. Returning these internal references avoids
        // cloning and rescanning the entire batch on every crash-recovery attempt.
        return {
          decision,
          batch,
          domains: (["session", "global"] as const).map((domain) => {
            const key = `${assignmentId}\0${domain}`;
            const progress = state.progress.get(key);
            return {
              domain,
              plan: state.domainPlans.get(key),
              progress: progress
                ? { state: progress.state, upToSeq: progress.upToSeq }
                : undefined,
            };
          }),
        };
      }),
      this.#select((state) => state.committedByAssignment.has(assignmentId)),
    ]);
    if (!projection) return 0;
    const { decision, batch } = projection;
    if (!committed) {
      throw corruptRunJournal("Publish decision has no committed assignment");
    }
    if (!this.#publisher) {
      throw new Error("Staged mutation publisher is not configured");
    }
    let applied = 0;
    for (const { domain, plan, progress } of projection.domains) {
      const domainCount =
        domain === "session" ? decision.sessionCount : decision.globalCount;
      if (domainCount === 0) continue;
      if (!plan || !progress) {
        throw corruptRunJournal(
          "Publish decision has no durable domain recovery plan",
        );
      }
      if (progress.state === "settled") continue;
      const currentIndex =
        progress.upToSeq === 0
          ? undefined
          : plan.grantedIndexBySeq.get(progress.upToSeq);
      if (progress.upToSeq !== 0 && currentIndex === undefined) {
        throw corruptRunJournal(
          "Publish progress is outside its domain recovery plan",
        );
      }
      const startIndex = currentIndex === undefined ? 0 : currentIndex + 1;
      for (let index = startIndex; index < plan.grantedSeqs.length; index += 1) {
        const seq = plan.grantedSeqs[index]!;
        const record = batch.records[seq - 1];
        const decided = decision.outcomes[seq - 1];
        if (
          !record ||
          record.seq !== seq ||
          record.domain !== domain ||
          !decided ||
          decided.seq !== seq ||
          decided.outcome.t !== "granted"
        ) {
          throw corruptRunJournal("Publish domain recovery plan is inconsistent");
        }
        await this.#publisher.apply({
          assignmentId,
          seq,
          domain,
          mutation: record.mutation as SessionStagedMutation | GlobalStagedMutation,
          requestId: record.requestId,
          targetRevision: decided.outcome.targetRevision,
        });
        const settled = index === plan.grantedSeqs.length - 1;
        await this.#appendPublishProgress({
          t: "publish-progress",
          assignmentId,
          domain,
          upToSeq: seq,
          state: settled ? "settled" : "pending",
        });
        applied += 1;
      }
      if (plan.grantedSeqs.length === 0) {
        await this.#appendPublishProgress({
          t: "publish-progress",
          assignmentId,
          domain,
          upToSeq: plan.terminalSeq,
          state: "settled",
        });
      }
    }
    return applied;
  }

  /** Resume every committed publish decision that is not settled, without caller memory. */
  async resumePendingPublishing(): Promise<number> {
    const assignments = await this.#selectPublish((state) =>
      [...(state.pendingAssignmentsByConversation.get(this.#conversationId) ?? [])],
    );
    let applied = 0;
    for (const assignmentId of assignments) {
      applied += await this.resumePublishing(assignmentId);
    }
    return applied;
  }

  async pendingFinalFrames(): Promise<FinalFrame[]> {
    const pending = await this.#selectFinal((state) =>
      [...(state.pendingByConversation.get(this.#conversationId)?.values() ?? [])]
        .map((entry) => snapshot(entry, "Pending final frame"))
        .sort((left, right) => left.record.commitRevision - right.record.commitRevision),
    );
    const assignmentByRevision = await this.#select((state) =>
      new Map(
        pending.flatMap(({ record }) => {
          const assignmentId = state.assignmentByCommitRevision.get(record.commitRevision);
          return assignmentId ? [[record.commitRevision, assignmentId] as const] : [];
        }),
      ),
    );
    const conflictCount = await this.#selectPublish((state) =>
      new Map(
        [...assignmentByRevision.values()].map((assignmentId) => [
          assignmentId,
          state.conflictsByAssignment.get(assignmentId)?.length ?? 0,
        ]),
      ),
    );
    return pending.map(({ record }) => {
      const assignmentId = assignmentByRevision.get(record.commitRevision);
      return finalFrame(record, assignmentId ? conflictCount.get(assignmentId) ?? 0 : 0);
    });
  }

  async publishPendingFinals(
    publish: (frame: FinalFrame) => Promise<void>,
  ): Promise<number> {
    let published = 0;
    for (const frame of await this.pendingFinalFrames()) {
      await publish(frame);
      if (await this.#transitionFinal(frame, "pending", "published")) published += 1;
    }
    return published;
  }

  async expirePublishedFinals(now: IsoTime): Promise<number> {
    const cutoff = canonicalTime(now, "Final outbox sweep time") - FINAL_OUTBOX_RETENTION_MS;
    const projection = await this.#selectFinal((state) =>
      [...(state.publishedByConversation.get(this.#conversationId)?.values() ?? [])].map(
        (entry) => snapshot(entry, "Published final frame"),
      ),
    );
    let expired = 0;
    for (const { record, at } of projection.sort(
      (left, right) => left.record.commitRevision - right.record.commitRevision,
    )) {
      if (
        record.state !== "published" ||
        canonicalTime(at, "Final outbox record time") > cutoff
      ) {
        continue;
      }
      if (await this.#transitionFinal(finalFrame(record), "published", "expired", cutoff)) {
        expired += 1;
      }
    }
    return expired;
  }

  async statusHistory(
    runId: string,
    afterStatusRevision: number,
  ): Promise<ConversationStatusNotice[]> {
    return (await this.statusHistoryBatch([{ runId, afterStatusRevision }]))[0]!.notices;
  }

  async statusHistoryBatch(
    requests: readonly {
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ): Promise<
    Array<{
      readonly notices: ConversationStatusNotice[];
      readonly nextAfterStatusRevision?: number;
    }>
  > {
    if (requests.length > 64) {
      throw new RangeError("A status history batch may contain at most 64 cursors");
    }
    for (const request of requests) {
      assertIdentifier(request.runId, "Run id");
      assertNonNegativeSafeInteger(
        request.afterStatusRevision,
        "Last-seen status revision",
      );
    }
    return this.#select((state) =>
      requests.map(({ runId, afterStatusRevision }) => {
        const page = (state.statusHistoryByRun.get(runId) ?? [])
          .filter((record) => record.statusRevision > afterStatusRevision)
          .slice(0, 65);
        const selected = page.slice(0, 64);
        const notices = selected
          .map((record) =>
            conversationStatusNotice(
              this.#conversationId,
              this.#ownerEpoch,
              runId,
              record,
            ),
          )
          .filter((notice): notice is ConversationStatusNotice => notice !== undefined);
        return {
          notices,
          ...(page.length > selected.length && selected.length > 0
            ? { nextAfterStatusRevision: selected.at(-1)!.statusRevision }
            : {}),
        };
      }),
    );
  }

  async runState(runId: string): Promise<ConversationRunState | undefined> {
    assertIdentifier(runId, "Run id");
    return this.#select((state) => state.stateByRun.get(runId)?.state);
  }

  async publishConflicts(assignmentId: string): Promise<PublishConflictNotice | undefined> {
    assertIdentifier(assignmentId, "Assignment id");
    const [committed, conflicts] = await Promise.all([
      this.#select((state) => {
        const record = state.committedByAssignment.get(assignmentId);
        return record ? snapshot(record, "Committed assignment") : undefined;
      }),
      this.#selectPublish((state) => {
        const records = state.conflictsByAssignment.get(assignmentId);
        return records ? snapshot(records, "Publish conflicts") : undefined;
      }),
    ]);
    if (!committed || !conflicts || conflicts.length === 0) return undefined;
    return {
      conversationId: this.#conversationId,
      runId: committed.runId,
      commitRevision: committed.commitRevision,
      conflicts,
    };
  }

  async finalHistory(afterCommitRevision: number): Promise<CommittedConversationResult[]> {
    assertNonNegativeSafeInteger(afterCommitRevision, "Last-seen commit revision");
    const commits = await this.#select((state) => {
      const start = firstCommitIndexAfter(state.commits, afterCommitRevision);
      return state.commits
        .slice(start)
        .map((committed) => snapshot(committed, "Final history commit"));
    });
    const conflictCounts = await this.#selectPublish((state) =>
      new Map(
        commits.map((committed) => [
          committed.assignmentId,
          state.conflictsByAssignment.get(committed.assignmentId)?.length ?? 0,
        ]),
      ),
    );
    const output: CommittedConversationResult[] = [];
    for (const committed of commits) {
      const bytes = await this.#artifacts.get(committed.bundle.ref);
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
      );
      const conflictCount = conflictCounts.get(committed.assignmentId) ?? 0;
      output.push({
        frame: {
          v: 1,
          conversationId: this.#conversationId,
          runId: committed.runId,
          commitRevision: committed.commitRevision,
          digest: bundle.digest,
          ...(conflictCount > 0 ? { publishConflicts: conflictCount } : {}),
        },
        bundle,
      });
    }
    return output;
  }

  /** Materialize one committed run for exact control-request replay without re-execution. */
  async committedRun(
    runId: string,
  ): Promise<ConversationCommitProjectionInput | undefined> {
    assertIdentifier(runId, "Run id");
    const committed = await this.#select((state) => {
      const record = state.commits.find((candidate) => candidate.runId === runId);
      return record ? snapshot(record, "Committed run replay") : undefined;
    });
    if (!committed) return undefined;
    const bytes = await this.#artifacts.get(committed.bundle.ref);
    const bundle = validateConversationSealedBundle(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
    );
    const closure = await validateConversationBundleClosure(bundle, this.#artifacts);
    return {
      assignmentId: committed.assignmentId,
      conversationId: this.#conversationId,
      commitRevision: committed.commitRevision,
      digest: bundle.digest,
      runRecord: closure.runRecord,
      ...(bundle.body.windowCompact
        ? { windowCompact: bundle.body.windowCompact }
        : {}),
      contentAssets: bundle.body.contentAssets,
    };
  }

  async currentState(runId: string): Promise<ConversationRunState | undefined> {
    return this.#select((state) => state.stateByRun.get(runId)?.state);
  }

  async currentResolution(
    runId: string,
  ): Promise<ConversationUncertainResolutionFact | undefined> {
    return this.#select((state) => {
      const resolution = state.resolutionsByRun.get(runId);
      return resolution ? snapshot(resolution, "Current resolution") : undefined;
    });
  }

  async #acceptNotStartedTermination(
    proof: DispatchRejectionProof | Extract<SupersedeProof, { decision: "not-started-fenced" }>,
  ): Promise<void> {
    const at = this.#clock();
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(proof.assignmentId);
      if (
        !assigned ||
        !proofBindsConversationSource(
          state,
          assigned,
          proof,
          this.#conversationId,
          this.#legacyAbortTickets,
        )
      ) {
        throw new Error("Termination proof does not bind a durable assignment");
      }
      const prior = state.superseded.get(proof.assignmentId);
      if (prior) {
        if (
          canonicalize(withoutSignature(prior.proof)) !==
          canonicalize(withoutSignature(proof))
        ) {
          throw new Error("Assignment already has a different termination proof");
        }
        return { kind: "return", value: undefined };
      }
      const current = state.stateByRun.get(assigned.record.runId);
      if (!current) throw corruptRunJournal("Terminated assignment has no run state");
      if (state.assignmentByRun.get(assigned.record.runId) !== proof.assignmentId) {
        throw new Error("Termination proof belongs to a historical assignment");
      }
      const open = state.resolutionsByRun.get(assigned.record.runId);
      const kind = assignmentTerminationProofKind(proof);
      const conflictsWithReceived =
        kind === "dispatch-rejection" && open?.cause === "dispatch-conflict";
      if (
        hasDurableStartedObservation(state, proof.assignmentId) ||
        conflictsWithReceived
      ) {
        const rejectionKey = rejectedNotStartedKey(proof.assignmentId, kind);
        const existing = state.rejectedNotStarted.get(rejectionKey);
        if (existing) {
          if (
            canonicalize(withoutSignature(existing.proof)) !==
            canonicalize(withoutSignature(proof))
          ) {
            throw new Error("Assignment already rejected a different not-started proof");
          }
          return { kind: "return", value: undefined };
        }
        const rejection = runRecord(this.#conversationId, {
          t: "not-started-rejected",
          assignmentId: proof.assignmentId,
          proof,
        });
        if (current.state === "uncertain") {
          if (!open || open.resolution) {
            throw corruptRunJournal("Uncertain run has no open resolution fact");
          }
          return { kind: "append", entries: [rejection], value: undefined };
        }
        if (
          current.state !== "dispatched" &&
          current.state !== "running" &&
          current.state !== "cancel-requested"
        ) {
          throw new Error("Termination proof is late for the current run state");
        }
        const fact = createOpenResolutionFact(assigned, "ledger-unknown", at);
        return {
          kind: "append",
          entries: [
            rejection,
            runRecord(this.#conversationId, {
              t: "resolution",
              runId: assigned.record.runId,
              fact,
            }),
            ...capabilityRevocations(this.#conversationId, state, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: assigned.record.runId,
              assignmentId: proof.assignmentId,
              state: "uncertain",
              statusRevision: current.statusRevision + 1,
            }),
          ],
          value: undefined,
        };
      }
      if (
        current.state !== "dispatched" &&
        current.state !== "uncertain" &&
        current.state !== "cancel-requested"
      ) {
        throw new Error("Termination proof is late for the current run state");
      }
      if (current.state === "uncertain" && (!open || open.resolution)) {
        throw corruptRunJournal("Uncertain run has no open resolution fact");
      }
      let containment: LogicalRecord<ConversationCommitLogRecord> | undefined;
      if (open?.cause === "dispatch-conflict") {
        if (kind !== "supersede") {
          throw new Error("Dispatch rejection cannot resolve a received dispatch conflict");
        }
        const containmentProof = proof as Extract<
          SupersedeProof,
          { decision: "not-started-fenced" }
        >;
        const conflict = state.conflictByAssignment.get(containmentProof.assignmentId);
        if (
          !conflict ||
          containmentProof.lastRecordSeq <= conflict.proof.receivedRecordSeq
        ) {
          throw new Error("Conflict containment proof does not follow the received prefix");
        }
        containment = runRecord(this.#conversationId, {
          t: "dispatch-conflict-contained",
          assignmentId: containmentProof.assignmentId,
          openFactDigest: open.openFactDigest,
          proof: containmentProof,
        });
      }
      const entries: LogicalRecord<ConversationCommitLogRecord>[] = [
        ...(containment ? [containment] : []),
        runRecord(this.#conversationId, {
          t: "assignment-superseded",
          assignmentId: proof.assignmentId,
          proof,
        }),
        ...capabilityRevocations(this.#conversationId, state, assigned),
      ];
      if (open && !open.resolution) {
        entries.push(
          runRecord(this.#conversationId, {
            t: "resolution",
            runId: assigned.record.runId,
            fact: closeResolution(
              open,
              "proven-not-started-redispatched",
              proof.executorId,
              at,
            ),
          }),
        );
      }
      entries.push(
        runRecord(this.#conversationId, {
          t: "state",
          runId: assigned.record.runId,
          assignmentId: proof.assignmentId,
          state: current.state === "cancel-requested" ? "cancelled" : "queued",
          statusRevision: current.statusRevision + 1,
        }),
      );
      return { kind: "append", entries, value: undefined };
    });
  }

  async #materializeDispatch(
    assigned: AssignedProjection,
  ): Promise<PendingConversationDispatch> {
    const bytes = await this.#artifacts.get(assigned.record.dispatchRef);
    const envelope = validateConversationEnvelope(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as PendingConversationDispatch["envelope"],
      this.#verifier,
    );
    const payload = buildConversationActivationPayload({
      envelope,
      dispatchRef: assigned.record.dispatchRef,
      commit: {
        lsn: assigned.commit.lsn,
        envelopeDigest: assigned.commit.envelopeDigest,
      },
      issuedAt: assigned.commit.at,
    });
    return {
      assignmentId: assigned.record.assignmentId,
      envelope,
      activation: signConversationActivation(payload, this.#signer),
    };
  }

  async #select<Value>(select: (state: RunProjection) => Value): Promise<Value> {
    return this.#operations.run(async () => {
      const cached = this.#runProjection;
      const replay = async () => {
        try {
          return await this.#log.transactProjection<
            RunProjection,
            unknown,
            void
          >(
            cached?.state ?? emptyProjection(this.#conversationId),
            this.#reduce,
            () => ({ kind: "return", value: undefined }),
            {
              stream: runStream(this.#conversationId),
              ...(cached ? { cursor: cached.cursor } : {}),
            },
          );
        } catch (error) {
          this.#runProjection = undefined;
          throw error;
        }
      };
      const transaction = await (
        this.#resources ? this.#resources.coordinate(replay) : replay()
      );
      this.#runProjection = {
        state: transaction.state,
        cursor: transaction.cursor,
      };
      return select(transaction.state);
    });
  }

  readonly #reduce = async (
    state: RunProjection,
    record: LogicalRecord<unknown>,
    rawEnvelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  ): Promise<RunProjection> => {
    if (record.stream !== runStream(this.#conversationId)) {
      return state;
    }
    const envelope = rawEnvelope as import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>;
    const body = snapshot(
      record.body as ConversationRunJournalRecord | ConversationRunInternalRecord,
      "Run journal record",
    );
    if ("kind" in body) {
      assertConversationRunInternalRecord(body);
      if (body.kind === "conversation-commit-projection") {
        const committed = state.committedByAssignment.get(body.assignmentId);
        if (
          !committed ||
          committed.runId !== body.runId ||
          committed.commitRevision !== body.commitRevision ||
          state.projectedByAssignment.has(body.assignmentId)
        ) {
          throw corruptRunJournal("Projection progress does not name one unprojected commit");
        }
        const bytes = await this.#artifacts.get(committed.bundle.ref);
        const bundle = validateConversationSealedBundle(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
        );
        if (bundle.digest !== body.digest) {
          throw corruptRunJournal("Projection progress digest does not match its bundle");
        }
        state.projectedByAssignment.set(body.assignmentId, body);
        state.pendingCommitProjections.delete(body.assignmentId);
        return state;
      }
      if (body.kind === "conversation-lifecycle-projection") {
        const pending = state.pendingLifecycleProjections.get(body.domainRevision);
        if (
          !pending ||
          pending.mutation !== body.mutation ||
          pending.requestId !== body.requestId ||
          state.projectedLifecycleRevisions.has(body.domainRevision)
        ) {
          throw corruptRunJournal(
            "Lifecycle projection progress does not name one pending lifecycle fact",
          );
        }
        state.projectedLifecycleRevisions.add(body.domainRevision);
        state.pendingLifecycleProjections.delete(body.domainRevision);
        return state;
      }
      if (body.kind === "session-activity") {
        throw corruptRunJournal(
          "Session activity record was written to the run stream",
        );
      }
      const committed = state.commits.at(-1);
      if (
        !committed ||
        state.contentByRevision.has(committed.commitRevision) ||
        !envelopeContainsCommit(envelope, this.#conversationId, committed)
      ) {
        throw corruptRunJournal("Content index has no unique committed run");
      }
      const bundleBytes = await this.#artifacts.get(committed.bundle.ref);
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bundleBytes).toString("utf8")) as SealedBundle,
      );
      if (canonicalize(body.entries) !== canonicalize(bundle.body.contentAssets)) {
        throw corruptRunJournal("Content index does not match its committed bundle");
      }
      state.contentByRevision.set(
        committed.commitRevision,
        snapshot(body.entries, "Content asset index"),
      );
      return state;
    }
    assertConversationRunRecord(body, this.#verifier);
    switch (body.t) {
      case "session-meta": {
        assertWorksceneIdentity(this.#conversationId, body.sceneId);
        const current = state.sessionMeta;
        if (
          body.domainRevision !== state.domainRevision + 1 ||
          state.sessionMetaByRequest.has(body.requestId) ||
          (body.operation === "create" && current !== undefined) ||
          (body.operation !== "create" &&
            (!current || current.sceneId !== body.sceneId)) ||
          (body.operation !== "delete" && state.deleted) ||
          (current !== undefined &&
            Date.parse(body.lastActiveAt) < Date.parse(current.lastActiveAt))
        ) {
          throw corruptRunJournal(
            "Session metadata transition is not the unique next owner mutation",
          );
        }
        if (
          !envelopeContainsSessionActivity(
            envelope,
            this.#conversationId,
            body,
          )
        ) {
          throw corruptRunJournal(
            "Session metadata transition lacks its atomic activity fact",
          );
        }
        state.domainRevision = body.domainRevision;
        state.sessionMeta = body;
        state.sessionMetaByRequest.set(body.requestId, body);
        if (body.operation === "delete") {
          state.deleted = true;
          state.pendingLifecycleProjections.set(body.domainRevision, {
            mutation: "delete",
            domainRevision: body.domainRevision,
            requestId: body.requestId,
          });
        }
        return state;
      }
      case "session-lifecycle": {
        if (
          body.domainRevision !== state.domainRevision + 1 ||
          state.deleted ||
          state.lifecycleByRequest.has(body.requestId)
        ) {
          throw corruptRunJournal("Session lifecycle revision or terminal state is invalid");
        }
        state.domainRevision = body.domainRevision;
        state.lifecycleByRequest.set(body.requestId, body);
        state.pendingLifecycleProjections.set(body.domainRevision, body);
        if (body.mutation === "delete") state.deleted = true;
        return state;
      }
      case "admitted": {
        if (state.deleted) {
          throw corruptRunJournal("Deleted conversation contains a later admitted run");
        }
        assertAdmissionReplayContract({
          runAlreadyAdmitted: state.admittedByRun.has(body.runId),
          ingressAlreadyAdmitted: state.runByIngress.has(body.ingressKey),
          queuedPositionAlreadyUsed: state.queuedRunByPosition.has(body.queuedPosition),
          hasAtomicQueuedState: envelopeHasRunState(
            envelope,
            this.#conversationId,
            body.runId,
            "queued",
            1,
            undefined,
          ),
        });
        const input = await loadStored(body.input, this.#artifacts);
        try {
          validateNonEmptyUserTurnInput(input);
        } catch {
          throw corruptRunJournal("Run journal contains invalid user input");
        }
        state.admittedByRun.set(body.runId, { record: body, input });
        state.runByIngress.set(body.ingressKey, body.runId);
        return state;
      }
      case "assigned": {
        const admitted = state.admittedByRun.get(body.runId);
        const current = state.stateByRun.get(body.runId);
        assertAssignmentReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          runAlreadyAssigned: state.assignmentByRun.has(body.runId),
          assignmentAlreadyKnown: state.assignedById.has(body.assignmentId),
          isEarliestQueuedRun:
            admitted !== undefined &&
            state.queuedPositionHeap[0] === admitted.record.queuedPosition,
          hasAtomicDispatchedState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              body.runId,
              "dispatched",
              current.statusRevision + 1,
              body.assignmentId,
            ),
        });
        if (!admitted) {
          throw corruptRunJournal("Run assignment is not the earliest admitted run");
        }
        const bytes = await this.#artifacts.get(body.dispatchRef);
        const dispatch = validateConversationEnvelope(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as PendingConversationDispatch["envelope"],
          this.#verifier,
        );
        await resolveDispatchArtifactClosure(dispatch, this.#artifacts);
        assertAssignedMatchesDispatch(
          body,
          dispatch,
          admitted.record.ingress,
          this.#conversationId,
        );
        if (requiresFormalResourceCoordination(dispatch.resourceLease)) {
          if (!this.#resources) {
            throw corruptRunJournal("Anchor assignment has no resource coordinator");
          }
          this.#resources.assertActivationRecords({
            lease: dispatch.resourceLease,
            records: envelope.entries,
            acceptedAt: envelope.at,
          });
        }
        state.assignedById.set(body.assignmentId, {
          record: body,
          envelope: dispatch,
          commit: {
            lsn: envelope.lsn,
            envelopeDigest: envelope.envelopeDigest,
            at: envelope.at,
          },
          acked: false,
        });
        state.assignmentByRun.set(body.runId, body.assignmentId);
        state.recoveryAssignments.add(body.assignmentId);
        state.mirrorStateByAssignment.set(body.assignmentId, {
          ordinal: 0,
          mirrorDigest: interactionMirrorSeed(body.assignmentId),
          mirroredUpTo: 0,
          requestIds: new Set(),
        });
        return state;
      }
      case "dispatch-acked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          alreadyAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.superseded.has(body.assignmentId),
          assignmentClosed: state.closedAssignments.has(body.assignmentId),
        });
        if (!assigned) {
          throw corruptRunJournal("Dispatch acknowledgement is missing or duplicated");
        }
        assigned.acked = true;
        return state;
      }
      case "supersede-requested": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertSupersedeRequestReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          requestAlreadyExists: state.supersedeRequests.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
        });
        state.supersedeRequests.set(body.assignmentId, body);
        return state;
      }
      case "supersede-started-observed": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsConversationSource(
              state,
              assigned,
              proof,
              this.#conversationId,
              this.#legacyAbortTickets,
            ),
          observationAlreadyExists: state.supersedeStartedObservations.has(
            body.assignmentId,
          ),
        });
        state.supersedeStartedObservations.set(body.assignmentId, body);
        return state;
      }
      case "dispatch-conflict": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const key = dispatchConflictKey(proof);
        assertDispatchConflictReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          proofBindsAssignment:
            assigned !== undefined &&
            proof.assignmentId === body.assignmentId &&
            proof.executorId === assigned.record.executorId,
          handling: body.handling,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.superseded.has(body.assignmentId),
          assignmentClosed: state.closedAssignments.has(body.assignmentId),
          conflictAlreadySeen: state.conflictByAssignment.has(body.assignmentId),
        });
        if (!assigned || !current || state.conflicts.has(key)) {
          throw corruptRunJournal("Dispatch conflict record is invalid or duplicated");
        }
        const expectedActivation = buildConversationActivationPayload({
          envelope: assigned.envelope,
          dispatchRef: assigned.record.dispatchRef,
          commit: {
            lsn: assigned.commit.lsn,
            envelopeDigest: assigned.commit.envelopeDigest,
          },
          issuedAt: assigned.commit.at,
        });
        const expectedActivationDigest = assignmentActivationDigest(expectedActivation);
        const acceptedMatches =
          canonicalize(proof.acceptedDispatchRef) ===
            canonicalize(assigned.record.dispatchRef) &&
          proof.acceptedActivationDigest === expectedActivationDigest;
        const conflictingMatches =
          canonicalize(proof.conflictingDispatchRef) ===
            canonicalize(assigned.record.dispatchRef) &&
          proof.conflictingActivationDigest === expectedActivationDigest;
        const atomicHandling =
          body.handling === "acked-original"
            ? envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "dispatch-acked" &&
                  candidate.assignmentId === body.assignmentId,
              )
            : envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "resolution" &&
                  candidate.runId === assigned.record.runId &&
                  candidate.fact.subject.execution === "conversation" &&
                  candidate.fact.subject.assignmentId === body.assignmentId &&
                  candidate.fact.cause === "dispatch-conflict" &&
                  candidate.fact.resolution === undefined,
              ) &&
              envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "cancel-fence" &&
                  candidate.assignmentId === body.assignmentId,
              ) &&
              envelopeHasRunState(
                envelope,
                this.#conversationId,
                assigned.record.runId,
                "uncertain",
                current.statusRevision + 1,
                body.assignmentId,
              ) &&
              envelopeRevokesRemainingCapabilities(
                envelope,
                this.#conversationId,
                state,
                assigned,
              );
        assertDispatchConflictHandlingReplayContract({
          handling: body.handling,
          acceptedMatches,
          conflictingMatches,
          atomicHandling,
        });
        state.conflicts.set(key, body);
        state.conflictByAssignment.set(body.assignmentId, body);
        return state;
      }
      case "dispatch-conflict-contained": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const open = assigned
          ? state.resolutionsByRun.get(assigned.record.runId)
          : undefined;
        const conflict = state.conflictByAssignment.get(body.assignmentId);
        const cancelProof = "cause" in proof ? proof : undefined;
        const supersedeProof =
          "decision" in proof && proof.decision === "not-started-fenced"
            ? proof
            : undefined;
        const terminatesForRedispatch =
          cancelProof?.decision === "not-started" || supersedeProof !== undefined;
        if (
          !assigned ||
          current?.state !== "uncertain" ||
          state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
          !open ||
          open.resolution !== undefined ||
          open.cause !== "dispatch-conflict" ||
          open.openFactDigest !== body.openFactDigest ||
          state.containedFacts.has(body.openFactDigest) ||
          !conflict ||
          (!cancelProof && !supersedeProof) ||
          !proofBindsConversationSource(
            state,
            assigned,
            proof,
            this.#conversationId,
            this.#legacyAbortTickets,
          ) ||
          (terminatesForRedispatch &&
            (!envelopeHasResolution(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              open.openFactDigest,
              true,
            ) ||
              !envelopeHasRunState(
                envelope,
                this.#conversationId,
                assigned.record.runId,
                "queued",
                current.statusRevision + 1,
                body.assignmentId,
              ) ||
              !envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "assignment-superseded" &&
                  candidate.assignmentId === body.assignmentId &&
                  sameTerminationProof(
                    candidate.proof,
                    proof as AssignmentTerminationProof,
                  ),
              ))) ||
          proof.lastRecordSeq <= conflict.proof.receivedRecordSeq
        ) {
          throw corruptRunJournal("Dispatch conflict containment is invalid or duplicated");
        }
        state.containedFacts.add(body.openFactDigest);
        state.containmentByAssignment.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        return state;
      }
      case "cancel-contained": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const open = assigned
          ? state.resolutionsByRun.get(assigned.record.runId)
          : undefined;
        if (
          !assigned ||
          current?.state !== "uncertain" ||
          state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
          !open ||
          open.resolution !== undefined ||
          open.cause === "dispatch-conflict" ||
          open.openFactDigest !== body.openFactDigest ||
          state.containedFacts.has(body.openFactDigest) ||
          proof.decision !== "halted" ||
          !proofBindsConversationSource(
            state,
            assigned,
            proof,
            this.#conversationId,
            this.#legacyAbortTickets,
          )
        ) {
          throw corruptRunJournal("Cancellation containment is invalid or duplicated");
        }
        state.containedFacts.add(body.openFactDigest);
        state.containmentByAssignment.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        return state;
      }
      case "cancel-proof-accepted": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertCancelProofAcceptedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          acceptanceAlreadyExists: state.acceptedCancellations.has(body.assignmentId),
          durableStartedObserved: hasDurableStartedObservation(state, body.assignmentId),
          proofDecision: proof.decision,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsConversationSource(
              state,
              assigned,
              proof,
              this.#conversationId,
              this.#legacyAbortTickets,
            ),
          hasAtomicCancelledState:
            assigned !== undefined &&
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              "cancelled",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesRemainingCapabilities(
              envelope,
              this.#conversationId,
              state,
              assigned,
            ),
        });
        if (!assigned) {
          throw corruptRunJournal("Accepted cancellation has no durable assignment");
        }
        this.#assertResourceUsageFinal(assigned.record, proof.usageFinal);
        this.#assertResourceTerminalRecords(
          assigned.record,
          proof.decision === "not-started" ? "release" : "settle-release",
          envelope.entries,
        );
        state.acceptedCancellations.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        return state;
      }
      case "not-started-rejected": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const kind = assignmentTerminationProofKind(proof);
        const open = assigned
          ? state.resolutionsByRun.get(assigned.record.runId)
          : undefined;
        const contradictory =
          hasDurableStartedObservation(state, body.assignmentId) ||
          (kind === "dispatch-rejection" && open?.cause === "dispatch-conflict");
        const proofBindsSource =
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            assigned,
            proof,
            this.#conversationId,
            this.#legacyAbortTickets,
          );
        const rejectionKey = rejectedNotStartedKey(body.assignmentId, kind);
        if (
          !assigned ||
          state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
          !proofBindsSource ||
          !contradictory ||
          (current?.state !== "uncertain" &&
            (!current ||
              !envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "resolution" &&
                  candidate.runId === assigned.record.runId &&
                  candidate.fact.subject.execution === "conversation" &&
                  candidate.fact.subject.assignmentId === body.assignmentId &&
                  candidate.fact.cause ===
                    (kind === "cancel" ? "cancel-unproven" : "ledger-unknown") &&
                  candidate.fact.resolution === undefined,
              ) ||
              !envelopeHasRunState(
                envelope,
                this.#conversationId,
                assigned.record.runId,
                "uncertain",
                current.statusRevision + 1,
                body.assignmentId,
              ) ||
              !envelopeRevokesRemainingCapabilities(
                envelope,
                this.#conversationId,
                state,
                assigned,
              ))) ||
          state.rejectedNotStarted.has(rejectionKey)
        ) {
          throw corruptRunJournal(
            "Rejected not-started proof is invalid or duplicated",
          );
        }
        state.rejectedNotStarted.set(rejectionKey, body);
        return state;
      }
      case "assignment-superseded": {
        const assigned = state.assignedById.get(body.assignmentId);
        const proof = body.proof;
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const kind = assignmentTerminationProofKind(proof);
        const open = assigned
          ? state.resolutionsByRun.get(assigned.record.runId)
          : undefined;
        assertAssignmentSupersededReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          assignmentAlreadyClosed: state.superseded.has(body.assignmentId),
          currentState: current?.state,
          durableStartedObserved: hasDurableStartedObservation(state, body.assignmentId),
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsConversationSource(
              state,
              assigned,
              proof,
              this.#conversationId,
              this.#legacyAbortTickets,
            ),
          proofKind: kind,
          hasAtomicTargetState:
            assigned !== undefined &&
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              current.state === "cancel-requested" ? "cancelled" : "queued",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesRemainingCapabilities(
              envelope,
              this.#conversationId,
              state,
              assigned,
            ),
          hasAtomicResolutionClose:
            assigned !== undefined &&
            open !== undefined &&
            envelopeHasResolution(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              open.openFactDigest,
              true,
            ),
          conflictOpen:
            open !== undefined &&
            open.cause === "dispatch-conflict" &&
            open.resolution === undefined,
          hasAtomicConflictContainment:
            open !== undefined &&
            envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "dispatch-conflict-contained" &&
                candidate.assignmentId === body.assignmentId &&
                candidate.openFactDigest === open.openFactDigest &&
                sameTerminationProof(candidate.proof, proof),
            ),
        });
        if (!assigned) {
          throw corruptRunJournal("Assignment supersede fact is invalid or duplicated");
        }
        this.#assertResourceTerminalRecords(
          assigned.record,
          "release",
          envelope.entries,
        );
        state.superseded.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        if (state.assignmentByRun.get(assigned.record.runId) === body.assignmentId) {
          state.assignmentByRun.delete(assigned.record.runId);
        }
        state.closedAssignments.add(body.assignmentId);
        return state;
      }
      case "cancel-fence": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const opensConflict = envelopeHasRunRecord(
          envelope,
          this.#conversationId,
          (candidate) =>
            candidate.t === "dispatch-conflict" &&
            candidate.assignmentId === body.assignmentId &&
            candidate.handling === "opened-uncertain",
        );
        const targetState = opensConflict ? "uncertain" : "cancel-requested";
        assertCancelFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: state.cancelFences.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
          hasAtomicTargetState:
            assigned !== undefined &&
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              targetState,
              current.statusRevision + 1,
              body.assignmentId,
            ),
        });
        if (!assigned || !current) {
          throw corruptRunJournal("Cancel fence is invalid or duplicated");
        }
        state.cancelOrigins.set(
          body.assignmentId,
          current.state as "dispatched" | "running",
        );
        state.cancelFences.set(body.assignmentId, body);
        return state;
      }
      case "capability-revoked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const key = `${body.assignmentId}\0${body.capId}`;
        assertCapabilityRevocationReplayContract({
          assignmentExists: assigned !== undefined,
          capabilityBelongsToAssignment: assigned?.record.capIds.includes(body.capId) ?? false,
          alreadyRevoked: state.revokedCapabilities.has(key),
        });
        state.revokedCapabilities.add(key);
        return state;
      }
      case "ticket-issued": {
        const assigned = state.assignedById.get(body.ticket.assignmentId);
        const admitted = assigned
          ? state.admittedByRun.get(assigned.record.runId)
          : undefined;
        applyConversationTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          conversationId: this.#conversationId,
          assigned: assigned?.record,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) ===
              assigned.record.assignmentId,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentClosed: state.closedAssignments.has(
            body.ticket.assignmentId,
          ),
          assignmentActive:
            assigned !== undefined &&
            (state.stateByRun.get(assigned.record.runId)?.state ===
              "dispatched" ||
              state.stateByRun.get(assigned.record.runId)?.state ===
                "running") &&
            !state.cancelFences.has(body.ticket.assignmentId),
          originalSurfacePrincipal: admitted?.record.ingress.surfacePrincipal,
          hasAtomicReplacementRevocation:
            body.replacesTicketId === undefined ||
            envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "ticket-revoked" &&
                candidate.ticketId === body.replacesTicketId,
            ),
        });
        return state;
      }
      case "ticket-revoked":
        applyConversationTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          conversationId: this.#conversationId,
          assignmentIsCurrent: false,
          assignmentAcknowledged: false,
          assignmentClosed: false,
          assignmentActive: false,
        });
        return state;
      case "ticket-sync-frontier":
        applyConversationTicketSyncFrontier(
          state,
          body.expiresThrough,
          envelope.at,
        );
        return state;
      case "interaction-mirror": {
        const assigned = state.assignedById.get(body.assignmentId);
        const batch = body.batch;
        const batchDigest = interactionMirrorBatchDigest(batch);
        if (
          !assigned ||
          batch.assignmentId !== body.assignmentId ||
          batch.executorId !== assigned.record.executorId ||
          state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
          state.closedAssignments.has(body.assignmentId) ||
          state.mirrorBatches.has(batchDigest)
        ) {
          throw corruptRunJournal("Interaction mirror has no assignment");
        }
        const mirrorState = state.mirrorStateByAssignment.get(body.assignmentId);
        if (!mirrorState || batch.entries.length === 0) {
          throw corruptRunJournal("Interaction mirror has no durable entries");
        }
        const current = state.stateByRun.get(assigned.record.runId)?.state;
        if (
          current !== "dispatched" &&
          current !== "running" &&
          !(
            (current === "cancel-requested" || current === "uncertain") &&
            state.cancelFences.has(body.assignmentId)
          )
        ) {
          throw corruptRunJournal("Interaction mirror is outside its authorized state");
        }
        if (
          batch.previousDigest !== mirrorState.mirrorDigest ||
          batch.entries[0]!.ordinal !== mirrorState.ordinal + 1
        ) {
          throw corruptRunJournal("Interaction mirror does not continue its audit prefix");
        }
        let lastSeq = mirrorState.mirroredUpTo;
        let lastOrdinal = mirrorState.ordinal;
        const batchRequestIds = new Set<string>();
        for (const rawEntry of batch.entries) {
          const entry = validateConversationInteractionMirrorEntry(rawEntry);
          if (
            entry.ordinal !== lastOrdinal + 1 ||
            entry.seq <= lastSeq ||
            mirrorState.requestIds.has(entry.requestId) ||
            batchRequestIds.has(entry.requestId)
          ) {
            throw corruptRunJournal(
              "Interaction mirror sequence or request identity is invalid",
            );
          }
          lastSeq = entry.seq;
          lastOrdinal = entry.ordinal;
          batchRequestIds.add(entry.requestId);
        }
        mirrorState.ordinal = lastOrdinal;
        mirrorState.mirrorDigest = batch.mirrorDigest;
        mirrorState.mirroredUpTo = lastSeq;
        for (const requestId of batchRequestIds) mirrorState.requestIds.add(requestId);
        state.mirrorBatches.set(batchDigest, body);
        return state;
      }
      case "channel-challenge-prepared": {
        const assigned = state.assignedById.get(body.assignmentId);
        const admitted = assigned
          ? state.admittedByRun.get(assigned.record.runId)
          : undefined;
        if (
          !assigned ||
          !admitted ||
          admitted.record.ingress.kind !== "channel" ||
          body.ref.conversationId !== this.#conversationId ||
          body.ref.runId !== assigned.record.runId ||
          body.ref.ownerEpoch !== assigned.record.ownerEpoch ||
          canonicalize(body.responder) !==
            canonicalize(admitted.record.ingress.responder) ||
          canonicalize(body.token.route) !==
            canonicalize(admitted.record.ingress.replyTarget)
        ) {
          throw corruptRunJournal(
            "Conversation channel challenge does not bind its assignment ingress",
          );
        }
        try {
          state.channelInteractions = advanceChannelInteractionJournal(
            state.channelInteractions,
            body,
            this.#verifier,
          );
        } catch (error) {
          throw corruptRunJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      }
      case "channel-challenge-delivered":
      case "channel-challenge-closed":
        try {
          state.channelInteractions = advanceChannelInteractionJournal(
            state.channelInteractions,
            body,
            this.#verifier,
          );
        } catch (error) {
          throw corruptRunJournal(
            error instanceof Error ? error.message : String(error),
          );
        }
        return state;
      case "state": {
        const admitted = state.admittedByRun.get(body.runId);
        if (!admitted) {
          throw corruptRunJournal("Run state has no admitted run");
        }
        try {
          this.#delivery.assertConversationStatuses(
            [
              {
                at: envelope.at,
                conversationId: this.#conversationId,
                runId: body.runId,
                state: body.state,
                statusRevision: body.statusRevision,
                ingress: admitted.record.ingress,
              },
            ],
            envelope,
          );
        } catch (error) {
          throw corruptRunJournal(
            error instanceof Error
              ? `Conversation status delivery is invalid: ${error.message}`
              : "Conversation status delivery is invalid",
          );
        }
        const current = state.stateByRun.get(body.runId);
        const mappedAssignmentId = state.assignmentByRun.get(body.runId);
        const closedEarlierInEnvelope =
          body.assignmentId !== undefined &&
          mappedAssignmentId === undefined &&
          state.closedAssignments.has(body.assignmentId) &&
          envelopeClosesAssignment(
            envelope,
            this.#conversationId,
            body.runId,
            body.assignmentId,
          );
        assertStateReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          nextState: body.state,
          nextRevision: body.statusRevision,
          assignmentId: body.assignmentId,
          assignmentBindingValid:
            mappedAssignmentId === body.assignmentId || closedEarlierInEnvelope,
          unassignedBindingValid: mappedAssignmentId === undefined,
          hasAtomicAssignment:
            current?.state !== "queued" ||
            body.state !== "dispatched" ||
            envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "assigned" &&
                candidate.runId === body.runId &&
                candidate.assignmentId === body.assignmentId,
            ),
        });
        if (
          current?.state === "queued" &&
          (body.state === "cancelled" || body.state === "failed" || body.state === "expired")
        ) {
          try {
            assertQueuedTerminalDequeue(
              envelope.entries,
              {
                kind: "run",
                id: body.runId,
                attempt: nextConversationAssignmentAttempt(state, body.runId),
              },
              body.state,
            );
          } catch (error) {
            throw corruptRunJournal(
              error instanceof Error ? error.message : "Queued run resource dequeue is invalid",
            );
          }
        }
        const committed = state.commits.at(-1);
        assertStateAtomicReplayContract({
          currentState: current?.state,
          nextState: body.state,
          hasAtomicCancelFence: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "cancel-fence" &&
              candidate.assignmentId === body.assignmentId &&
              state.assignedById.get(candidate.assignmentId)?.record.runId ===
                body.runId,
          ),
          hasAtomicOpenResolution: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "resolution" &&
              candidate.runId === body.runId &&
              candidate.fact.subject.assignmentId === body.assignmentId &&
              candidate.fact.resolution === undefined,
          ),
          hasAtomicSupersede: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "assignment-superseded" &&
              candidate.assignmentId === body.assignmentId &&
              state.assignedById.get(candidate.assignmentId)?.record.runId ===
                body.runId,
          ),
          hasAtomicTermination: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              (candidate.t === "cancel-proof-accepted" ||
                candidate.t === "assignment-superseded") &&
              candidate.assignmentId === body.assignmentId &&
              state.assignedById.get(candidate.assignmentId)?.record.runId ===
                body.runId,
          ),
          hasAtomicResolutionClose: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "resolution" &&
              candidate.runId === body.runId &&
              candidate.fact.subject.assignmentId === body.assignmentId &&
              candidate.fact.resolution !== undefined,
          ),
          hasAtomicCommit:
            committed !== undefined &&
            committed.runId === body.runId &&
            committed.assignmentId === body.assignmentId &&
            envelopeContainsCommit(envelope, this.#conversationId, committed),
        });
        if (
          body.state === "failed" &&
          body.assignmentId !== undefined &&
          !envelopeRevokesRemainingCapabilities(
            envelope,
            this.#conversationId,
            state,
            state.assignedById.get(body.assignmentId)!,
          )
        ) {
          throw corruptRunJournal("Assigned failure is not atomic with capability revocation");
        }
        if (body.state === "failed" && body.assignmentId !== undefined) {
          const assigned = state.assignedById.get(body.assignmentId);
          if (!assigned) throw corruptRunJournal("Assigned failure has no assignment");
          if (body.usageFinal) {
            this.#assertResourceUsageFinal(assigned.record, body.usageFinal);
          }
          this.#assertResourceTerminalRecords(
            assigned.record,
            body.usageFinal ? "settle-release" : "reclaim",
            envelope.entries,
          );
        }
        if (body.state === "uncertain" && current?.state !== "uncertain") {
          const assignmentId = state.assignmentByRun.get(body.runId);
          if (
            !assignmentId ||
            (current?.state !== "dispatched" &&
              current?.state !== "running" &&
              current?.state !== "cancel-requested")
          ) {
            throw corruptRunJournal("Uncertain state has no durable active origin");
          }
          state.uncertainOrigins.set(assignmentId, current.state);
        }
        const nextActiveRunId = nextActiveRunIdForReplay({
          activeRunId: state.activeRunId,
          runId: body.runId,
          currentState: current?.state,
          nextState: body.state,
        });
        if (current?.state === "queued") {
          removeQueuedRun(state, admitted.record.queuedPosition, body.runId);
        }
        if (body.state === "queued") {
          addQueuedRun(state, admitted.record.queuedPosition, body.runId);
        }
        state.activeRunId = nextActiveRunId;
        state.stateByRun.set(body.runId, {
          state: body.state,
          statusRevision: body.statusRevision,
        });
        if (body.state === "failed" && body.assignmentId !== undefined) {
          state.assignmentByRun.delete(body.runId);
          state.closedAssignments.add(body.assignmentId);
        }
        if (
          body.assignmentId !== undefined &&
          (body.state === "queued" ||
            body.state === "cancelled" ||
            body.state === "failed" ||
            body.state === "expired")
        ) {
          state.recoveryAssignments.delete(body.assignmentId);
        }
        const history = state.statusHistoryByRun.get(body.runId) ?? [];
        if (history.length + 1 !== body.statusRevision) {
          throw corruptRunJournal("Run status history index is not contiguous");
        }
        const uncertainStatus = projectUncertainStatusTransition({
          currentState: current?.state,
          nextState: body.state,
          resolutionFacts: conversationResolutionFactsInEnvelope(
            envelope,
            this.#conversationId,
            body.runId,
          ),
        });
        history.push({
          state: body.state,
          statusRevision: body.statusRevision,
          at: envelope.at,
          ...(body.reason ? { reason: body.reason } : {}),
          ...(uncertainStatus.kind === "opened"
            ? {
                uncertainTransition: "opened" as const,
                openFactDigest: uncertainStatus.openFactDigest,
              }
            : uncertainStatus.kind === "closed"
              ? {
                  uncertainTransition: "closed" as const,
                  openFactDigest: uncertainStatus.openFactDigest,
                  ...conversationUncertainClosure(
                    requireConversationResolutionKind(
                      uncertainStatus.resolutionKind,
                    ),
                  ),
                }
              : {}),
        });
        state.statusHistoryByRun.set(body.runId, history);
        return state;
      }
      case "resolution": {
        const fact = snapshot(body.fact, "Uncertain resolution fact");
        const conversationFact = fact as ConversationUncertainResolutionFact;
        const assigned = state.assignedById.get(conversationFact.subject.assignmentId);
        // Subject identity self-consistency (openFactDigest over subject/openedAt/cause)
        // is enforced by the shared record validator; this predicate binds the subject
        // to the durable authority (conversation, run, owner epoch).
        assertConversationResolutionBinding({
          execution: fact.subject.execution,
          conversationId:
            fact.subject.execution === "conversation"
              ? fact.subject.conversationId
              : undefined,
          subjectRunId:
            fact.subject.execution === "conversation" ? fact.subject.runId : undefined,
          recordRunId: body.runId,
          authorityConversationId: this.#conversationId,
          subjectOwnerEpoch:
            fact.subject.execution === "conversation"
              ? fact.subject.ownerEpoch
              : undefined,
          authorityOwnerEpoch: assigned?.record.ownerEpoch,
        });
        const currentAssignmentId = state.assignmentByRun.get(body.runId);
        const closesEarlierInEnvelope =
          currentAssignmentId === undefined &&
          state.closedAssignments.has(conversationFact.subject.assignmentId) &&
          envelopeClosesAssignment(
            envelope,
            this.#conversationId,
            body.runId,
            conversationFact.subject.assignmentId,
          );
        if (!assigned) {
          throw corruptRunJournal("Uncertain resolution fact has no durable assignment");
        }
        const existing = state.resolutionsByRun.get(body.runId);
        const current = state.stateByRun.get(body.runId);
        if (!conversationFact.resolution) {
          assertResolutionOpenReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned.record.runId === body.runId,
            assignmentIsCurrent:
              currentAssignmentId === conversationFact.subject.assignmentId,
            currentState: current?.state,
            alreadyOpen: isOpenResolutionFact(existing),
            cause: conversationFact.cause,
            hasAtomicUncertainState:
              current !== undefined &&
              envelopeHasRunState(
                envelope,
                this.#conversationId,
                body.runId,
                "uncertain",
                current.statusRevision + 1,
                conversationFact.subject.assignmentId,
              ),
            hasAtomicDispatchConflict: envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "dispatch-conflict" &&
                candidate.assignmentId === conversationFact.subject.assignmentId &&
                candidate.handling === "opened-uncertain",
            ),
          });
        } else {
          assertResolutionClosureReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned.record.runId === body.runId,
            assignmentIsCurrentOrAtomicallyClosed:
              currentAssignmentId === conversationFact.subject.assignmentId ||
              closesEarlierInEnvelope,
            conflictOpen: conversationFact.cause === "dispatch-conflict",
            resolutionKind: conversationFact.resolution.kind,
          });
          const nextState = resolutionTargetState(conversationFact.resolution.kind);
          assertResolutionCloseAtomicReplayContract({
            cause: conversationFact.cause,
            kind: conversationFact.resolution.kind,
            existingOpenMatches:
              existing?.openFactDigest === conversationFact.openFactDigest &&
              existing.resolution === undefined,
            hasAtomicTargetState:
              current !== undefined &&
              envelopeHasRunState(
                envelope,
                this.#conversationId,
                body.runId,
                nextState,
                current.statusRevision + (current.state === "uncertain" ? 1 : 0),
                conversationFact.subject.assignmentId,
              ),
            allCapabilitiesRevoked: envelopeRevokesRemainingCapabilities(
              envelope,
              this.#conversationId,
              state,
              assigned,
            ),
            hasRequiredCompanion:
              (conversationFact.resolution.kind !==
                "proven-not-started-redispatched" ||
                envelopeHasRunRecord(
                  envelope,
                  this.#conversationId,
                  (candidate) =>
                    candidate.t === "assignment-superseded" &&
                    candidate.assignmentId === conversationFact.subject.assignmentId,
                )) &&
              (!conversationFact.resolution.kind.startsWith("user-") ||
                envelopeHasSuccessfulUncertainControl(
                  envelope,
                  nextState,
                  conversationFact.resolution.factDigest,
                )),
          });
          if (conversationFact.resolution.kind.startsWith("user-")) {
            this.#assertResourceTerminalRecords(
              assigned.record,
              "reclaim",
              envelope.entries,
            );
          }
        }
        state.resolutionsByRun.set(body.runId, conversationFact);
        if (conversationFact.resolution) {
          state.closedAssignments.add(conversationFact.subject.assignmentId);
          if (state.assignmentByRun.get(body.runId) === conversationFact.subject.assignmentId) {
            state.assignmentByRun.delete(body.runId);
          }
        }
        return state;
      }
      case "committed": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const openResolution = state.resolutionsByRun.get(body.runId);
        assertCommittedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.runId === body.runId,
          assignmentIsCurrent: state.assignmentByRun.get(body.runId) === body.assignmentId,
          currentState: current?.state,
          alreadyCommitted: state.committedByAssignment.has(body.assignmentId),
          conflictOpen:
            openResolution?.cause === "dispatch-conflict" && !openResolution.resolution,
          commitRevisionMatchesAssignedBase:
            assigned !== undefined &&
            body.commitRevision === assigned.record.baseRevision + 1,
          hasAtomicCommittedState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              body.runId,
              "committed",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesRemainingCapabilities(
              envelope,
              this.#conversationId,
              state,
              assigned,
            ),
        });
        if (!assigned || !current) {
          throw corruptRunJournal(
            "Committed run does not match a complete unique assignment closure",
          );
        }
        const previous = state.commits.at(-1);
        if (
          previous &&
          body.commitRevision !== previous.commitRevision + 1
        ) {
          throw corruptRunJournal("Committed run revision is not contiguous");
        }
        const bytes = await this.#artifacts.get(body.bundle.ref);
        const bundle = validateConversationSealedBundle(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
        );
        assertHistoricalBundleFence({
          assignedExecutorId: assigned.record.executorId,
          assignedOwnerEpoch: assigned.record.ownerEpoch,
          assignedBaseRevision: assigned.record.baseRevision,
          bundleExecutorId: bundle.executorId,
          bundleOwnerEpoch: bundle.body.ownerEpoch,
          bundleBaseRevision: bundle.body.baseRevision,
          conflictOpen:
            openResolution?.cause === "dispatch-conflict" &&
            openResolution.resolution === undefined,
        });
        if (
          canonicalize(sealedBundleArtifact(bundle).ref) !== canonicalize(body.bundle.ref) ||
          bundle.assignmentId !== body.assignmentId ||
          bundle.body.runId !== body.runId ||
          bundle.body.conversationId !== this.#conversationId ||
          bundle.body.baseRevision + 1 !== body.commitRevision
        ) {
          throw corruptRunJournal("Committed bundle does not bind its run journal fact");
        }
        this.#assertResourceUsageFinal(assigned.record, bundle.usageFinal);
        this.#assertResourceTerminalRecords(
          assigned.record,
          "settle-release",
          envelope.entries,
        );
        let closure: ValidatedConversationBundleClosure;
        try {
          closure = await validateConversationBundleClosure(bundle, this.#artifacts);
        } catch (error) {
          throw corruptRunJournal(
            error instanceof Error
              ? `Committed bundle closure is invalid: ${error.message}`
              : "Committed bundle closure is invalid",
          );
        }
        if (
          !envelopeHasConversationCommitSidecars(
            envelope,
            this.#conversationId,
            body,
            bundle,
            closure.batch,
          )
        ) {
          throw corruptRunJournal(
            "Committed run is missing its content, publish, or final sidecars",
          );
        }
        const admitted = state.admittedByRun.get(body.runId);
        if (!admitted) throw corruptRunJournal("Committed run has no durable ingress");
        try {
          this.#delivery.assertConversationCommit(
            {
              at: envelope.at,
              conversationId: this.#conversationId,
              runId: body.runId,
              assignmentId: body.assignmentId,
              commitRevision: body.commitRevision,
              ingress: admitted.record.ingress,
              runRecord: closure.runRecord,
              ...(closure.batch ? { mutationBatch: closure.batch } : {}),
            },
            envelope,
          );
        } catch (error) {
          throw corruptRunJournal(
            error instanceof Error
              ? `Committed delivery companions are invalid: ${error.message}`
              : "Committed delivery companions are invalid",
          );
        }
        state.committedByAssignment.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        state.bundleAcknowledgementOutbox.add(body.assignmentId);
        state.commits.push(body);
        state.assignmentByCommitRevision.set(body.commitRevision, body.assignmentId);
        state.pendingCommitProjections.set(body.assignmentId, body);
        return state;
      }
      case "bundle-ack-observed": {
        const committed = state.committedByAssignment.get(body.assignmentId);
        if (
          !committed ||
          state.bundleAcknowledgements.has(body.assignmentId) ||
          !bundleAcknowledgementBindsCommitted({
            observedBundleRef: body.bundleRef,
            observedCommitRevision: body.commitRevision,
            expectedBundleRef: committed.bundle.ref,
            expectedCommitRevision: committed.commitRevision,
          })
        ) {
          throw corruptRunJournal(
            "Bundle acknowledgement observation does not bind one committed conversation bundle",
          );
        }
        state.bundleAcknowledgements.set(body.assignmentId, body);
        state.recoveryAssignments.delete(body.assignmentId);
        state.bundleAcknowledgementOutbox.delete(body.assignmentId);
        return state;
      }
    }
  };

  readonly #reduceSubmissionGuard = async (
    state: SubmissionGuardProjection,
    record: LogicalRecord<ConversationCommitLogRecord>,
    envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  ): Promise<SubmissionGuardProjection> => {
    if (record.stream !== runStream(this.#conversationId)) {
      throw corruptRunJournal("Submission guard projection received a different stream");
    }
    const body = record.body as unknown;
    assertPlainRecord(body, "Submission guard record");
    if ("kind" in body) {
      assertConversationRunInternalRecord(body);
      return state;
    }
    assertConversationRunRecord(body, this.#verifier);
    switch (body.t) {
      case "session-lifecycle":
        return state;
      case "admitted": {
        assertAdmissionReplayContract({
          runAlreadyAdmitted: state.admittedByRun.has(body.runId),
          ingressAlreadyAdmitted: state.runByIngress.has(body.ingressKey),
          queuedPositionAlreadyUsed: state.queuedRunByPosition.has(body.queuedPosition),
          hasAtomicQueuedState: envelopeHasRunState(
            envelope,
            this.#conversationId,
            body.runId,
            "queued",
            1,
            undefined,
          ),
        });
        state.admittedByRun.set(body.runId, {
          ingressKey: body.ingressKey,
          queuedPosition: body.queuedPosition,
          ingress: body.ingress,
        });
        state.runByIngress.set(body.ingressKey, body.runId);
        return state;
      }
      case "assigned": {
        const capIds = new Set(body.capIds);
        const runId = body.runId;
        const assignmentId = body.assignmentId;
        const admitted = state.admittedByRun.get(runId);
        const current = state.stateByRun.get(runId);
        assertAssignmentReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          runAlreadyAssigned: state.assignmentByRun.has(runId),
          assignmentAlreadyKnown: state.assignedById.has(assignmentId),
          isEarliestQueuedRun:
            admitted !== undefined &&
            state.queuedPositionHeap[0] === admitted.queuedPosition,
          hasAtomicDispatchedState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              runId,
              "dispatched",
              current.statusRevision + 1,
              assignmentId,
            ),
        });
        if (!admitted) {
          throw corruptRunJournal("Run assignment is not the earliest admitted run");
        }
        state.assignedById.set(assignmentId, {
          record: body,
          commit: {
            lsn: envelope.lsn,
            envelopeDigest: envelope.envelopeDigest,
            at: envelope.at,
          },
          capIds,
          acked: false,
        });
        state.assignmentByRun.set(runId, assignmentId);
        return state;
      }
      case "dispatch-acked": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertDispatchAcknowledgementReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          alreadyAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.closedAssignments.has(body.assignmentId),
          assignmentClosed: state.closedAssignments.has(body.assignmentId),
        });
        if (!assigned) {
          throw corruptRunJournal("Dispatch acknowledgement is missing or duplicated");
        }
        assigned.acked = true;
        return state;
      }
      case "dispatch-conflict": {
        const assignmentId = body.assignmentId;
        const assigned = state.assignedById.get(assignmentId);
        const proof = body.proof;
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertDispatchConflictReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === assignmentId,
          currentState: current?.state,
          proofBindsAssignment:
            assigned !== undefined &&
            proof.assignmentId === assignmentId &&
            proof.executorId === assigned.record.executorId,
          handling: body.handling,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentSuperseded: state.closedAssignments.has(assignmentId),
          assignmentClosed: state.closedAssignments.has(assignmentId),
          conflictAlreadySeen: state.conflictAssignments.has(assignmentId),
        });
        if (!assigned || !current) {
          throw corruptRunJournal("Dispatch conflict record is invalid or duplicated");
        }
        const expectedActivation = buildConversationActivationPayloadFromBinding({
          binding: {
            runId: assigned.record.runId,
            conversationId: this.#conversationId,
            ownerEpoch: assigned.record.ownerEpoch,
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            dispatchRef: assigned.record.dispatchRef,
            manifestDigest: assigned.record.manifestDigest,
            permissionLeaseDigest: assigned.record.permissionLeaseDigest,
            capIds: assigned.record.capIds,
            reservation: assigned.record.reservation,
          },
          commit: {
            lsn: assigned.commit.lsn,
            envelopeDigest: assigned.commit.envelopeDigest,
          },
          issuedAt: assigned.commit.at,
        });
        const expectedActivationDigest = assignmentActivationDigest(expectedActivation);
        const acceptedMatches =
          canonicalize(proof.acceptedDispatchRef) ===
            canonicalize(assigned.record.dispatchRef) &&
          proof.acceptedActivationDigest === expectedActivationDigest;
        const conflictingMatches =
          canonicalize(proof.conflictingDispatchRef) ===
            canonicalize(assigned.record.dispatchRef) &&
          proof.conflictingActivationDigest === expectedActivationDigest;
        const atomicHandling =
          body.handling === "acked-original"
            ? envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "dispatch-acked" &&
                  candidate.assignmentId === assignmentId,
              )
            : envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "resolution" &&
                  candidate.runId === assigned.record.runId &&
                  candidate.fact.subject.execution === "conversation" &&
                  candidate.fact.subject.assignmentId === assignmentId &&
                  candidate.fact.cause === "dispatch-conflict" &&
                  candidate.fact.resolution === undefined,
              ) &&
              envelopeHasRunRecord(
                envelope,
                this.#conversationId,
                (candidate) =>
                  candidate.t === "cancel-fence" &&
                  candidate.assignmentId === assignmentId,
              ) &&
              envelopeHasRunState(
                envelope,
                this.#conversationId,
                assigned.record.runId,
                "uncertain",
                current.statusRevision + 1,
                assignmentId,
              ) &&
              envelopeRevokesCapabilities(
                envelope,
                this.#conversationId,
                state.revokedCapabilities,
                assignmentId,
                assigned.capIds,
                state.ticketIdsByAssignment.get(assignmentId) ?? [],
                state.revokedTickets,
              );
        assertDispatchConflictHandlingReplayContract({
          handling: body.handling,
          acceptedMatches,
          conflictingMatches,
          atomicHandling,
        });
        state.conflictAssignments.add(assignmentId);
        if (body.handling === "opened-uncertain") {
          state.openConflictAssignments.add(assignmentId);
        }
        return state;
      }
      case "supersede-requested": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertSupersedeRequestReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          requestAlreadyExists: state.supersedeRequests.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
        });
        state.supersedeRequests.set(body.assignmentId, body);
        return state;
      }
      case "supersede-started-observed": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertSupersedeStartedObservationReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsConversationSource(
              state,
              assigned,
              proof,
              this.#conversationId,
              this.#legacyAbortTickets,
            ),
          observationAlreadyExists: state.supersedeStartedAssignments.has(
            body.assignmentId,
          ),
        });
        state.supersedeStartedAssignments.add(body.assignmentId);
        state.durableStartedAssignments.add(body.assignmentId);
        return state;
      }
      case "cancel-fence": {
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const opensConflict = envelopeHasRunRecord(
          envelope,
          this.#conversationId,
          (candidate) =>
            candidate.t === "dispatch-conflict" &&
            candidate.assignmentId === body.assignmentId &&
            candidate.handling === "opened-uncertain",
        );
        assertCancelFenceReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          fenceAlreadyExists: state.cancelFences.has(body.assignmentId),
          fenceSeq: body.fenceSeq,
          envelopeLsn: envelope.lsn,
          hasAtomicTargetState:
            assigned !== undefined &&
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              opensConflict ? "uncertain" : "cancel-requested",
              current.statusRevision + 1,
              body.assignmentId,
            ),
        });
        state.cancelFences.set(body.assignmentId, body);
        return state;
      }
      case "cancel-proof-accepted": {
        const proof = body.proof;
        const assigned = state.assignedById.get(body.assignmentId);
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        assertCancelProofAcceptedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
          currentState: current?.state,
          acceptanceAlreadyExists: state.acceptedCancellations.has(body.assignmentId),
          durableStartedObserved: state.durableStartedAssignments.has(body.assignmentId),
          proofDecision: proof.decision,
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsConversationSource(
              state,
              assigned,
              proof,
              this.#conversationId,
              this.#legacyAbortTickets,
            ),
          hasAtomicCancelledState:
            assigned !== undefined &&
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              "cancelled",
              current.statusRevision + 1,
              body.assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesCapabilities(
              envelope,
              this.#conversationId,
              state.revokedCapabilities,
              body.assignmentId,
              assigned.capIds,
              state.ticketIdsByAssignment.get(body.assignmentId) ?? [],
              state.revokedTickets,
            ),
        });
        if (!assigned) {
          throw corruptRunJournal("Submission guard cancellation has no assignment");
        }
        this.#assertResourceUsageFinal(assigned.record, proof.usageFinal);
        this.#assertResourceTerminalRecords(
          assigned.record,
          proof.decision === "not-started" ? "release" : "settle-release",
          envelope.entries,
        );
        state.acceptedCancellations.add(body.assignmentId);
        return state;
      }
      case "assignment-superseded": {
        const assignmentId = body.assignmentId;
        const assigned = state.assignedById.get(assignmentId);
        const proof = body.proof;
        const current = assigned
          ? state.stateByRun.get(assigned.record.runId)
          : undefined;
        const kind = assignmentTerminationProofKind(proof);
        const open = assigned
          ? state.resolutionsByRun.get(assigned.record.runId)
          : undefined;
        assertAssignmentSupersededReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) === assignmentId,
          assignmentAlreadyClosed: state.closedAssignments.has(assignmentId),
          currentState: current?.state,
          durableStartedObserved: state.durableStartedAssignments.has(assignmentId),
          proofBindsDurableSource:
            assigned !== undefined &&
            proofBindsConversationSource(
              state,
              assigned,
              proof,
              this.#conversationId,
              this.#legacyAbortTickets,
            ),
          proofKind: kind,
          hasAtomicTargetState:
            assigned !== undefined &&
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              current.state === "cancel-requested" ? "cancelled" : "queued",
              current.statusRevision + 1,
              assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesCapabilities(
              envelope,
              this.#conversationId,
              state.revokedCapabilities,
              assignmentId,
              assigned.capIds,
              state.ticketIdsByAssignment.get(assignmentId) ?? [],
              state.revokedTickets,
            ),
          hasAtomicResolutionClose:
            assigned !== undefined &&
            open !== undefined &&
            envelopeHasResolution(
              envelope,
              this.#conversationId,
              assigned.record.runId,
              open.openFactDigest,
              true,
            ),
          conflictOpen:
            open !== undefined &&
            open.cause === "dispatch-conflict" &&
            open.resolution === undefined,
          hasAtomicConflictContainment:
            open !== undefined &&
            envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "dispatch-conflict-contained" &&
                candidate.assignmentId === assignmentId &&
                candidate.openFactDigest === open.openFactDigest &&
                sameTerminationProof(candidate.proof, proof),
            ),
        });
        if (!assigned) throw corruptRunJournal("Submission guard supersede has no assignment");
        this.#assertResourceTerminalRecords(
          assigned.record,
          "release",
          envelope.entries,
        );
        state.assignmentByRun.delete(assigned.record.runId);
        state.closedAssignments.add(assignmentId);
        state.openConflictAssignments.delete(assignmentId);
        return state;
      }
      case "resolution": {
        const fact = body.fact as ConversationUncertainResolutionFact;
        const runId = body.runId;
        const assignmentId = fact.subject.assignmentId;
        const assigned = state.assignedById.get(assignmentId);
        assertConversationResolutionBinding({
          execution: body.fact.subject.execution,
          conversationId:
            body.fact.subject.execution === "conversation"
              ? body.fact.subject.conversationId
              : undefined,
          subjectRunId:
            body.fact.subject.execution === "conversation"
              ? body.fact.subject.runId
              : undefined,
          recordRunId: body.runId,
          authorityConversationId: this.#conversationId,
          subjectOwnerEpoch:
            fact.subject.execution === "conversation"
              ? fact.subject.ownerEpoch
              : undefined,
          authorityOwnerEpoch: assigned?.record.ownerEpoch,
        });
        const currentAssignmentId = state.assignmentByRun.get(runId);
        const closesEarlierInEnvelope =
          currentAssignmentId === undefined &&
          state.closedAssignments.has(assignmentId) &&
          envelopeClosesAssignment(
            envelope,
            this.#conversationId,
            runId,
            assignmentId,
          );
        const current = state.stateByRun.get(runId);
        const existing = state.resolutionsByRun.get(runId);
        if (!fact.resolution) {
          assertResolutionOpenReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.runId === runId,
            assignmentIsCurrent: currentAssignmentId === assignmentId,
            currentState: current?.state,
            alreadyOpen: isOpenResolutionFact(existing),
            cause: fact.cause,
            hasAtomicUncertainState:
              current !== undefined &&
              envelopeHasRunState(
                envelope,
                this.#conversationId,
                runId,
                "uncertain",
                current.statusRevision + 1,
                assignmentId,
              ),
            hasAtomicDispatchConflict: envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "dispatch-conflict" &&
                candidate.assignmentId === assignmentId &&
                candidate.handling === "opened-uncertain",
            ),
          });
        } else {
          assertResolutionClosureReplayContract({
            assignmentExists: assigned !== undefined,
            assignmentBindsRun: assigned?.record.runId === runId,
            assignmentIsCurrentOrAtomicallyClosed:
              currentAssignmentId === assignmentId || closesEarlierInEnvelope,
            conflictOpen: fact.cause === "dispatch-conflict",
            resolutionKind: fact.resolution.kind,
          });
          const nextState = resolutionTargetState(fact.resolution.kind);
          assertResolutionCloseAtomicReplayContract({
            cause: fact.cause,
            kind: fact.resolution.kind,
            existingOpenMatches:
              existing?.openFactDigest === fact.openFactDigest &&
              existing.resolution === undefined,
            hasAtomicTargetState:
              current !== undefined &&
              envelopeHasRunState(
                envelope,
                this.#conversationId,
                runId,
                nextState,
                current.statusRevision + (current.state === "uncertain" ? 1 : 0),
                assignmentId,
              ),
            allCapabilitiesRevoked:
              assigned !== undefined &&
              envelopeRevokesCapabilities(
                envelope,
                this.#conversationId,
                state.revokedCapabilities,
                assignmentId,
                assigned.capIds,
                state.ticketIdsByAssignment.get(assignmentId) ?? [],
                state.revokedTickets,
              ),
            hasRequiredCompanion:
              (fact.resolution.kind !== "proven-not-started-redispatched" ||
                envelopeHasRunRecord(
                  envelope,
                  this.#conversationId,
                  (candidate) =>
                    candidate.t === "assignment-superseded" &&
                    candidate.assignmentId === assignmentId,
                )) &&
              (!fact.resolution.kind.startsWith("user-") ||
                envelopeHasSuccessfulUncertainControl(
                  envelope,
                  nextState,
                  fact.resolution.factDigest,
                )),
          });
          if (fact.resolution.kind.startsWith("user-") && assigned) {
            this.#assertResourceTerminalRecords(
              assigned.record,
              "reclaim",
              envelope.entries,
            );
          }
        }
        state.resolutionsByRun.set(runId, fact);
        if (fact.resolution) {
          state.assignmentByRun.delete(runId);
          state.closedAssignments.add(assignmentId);
          state.openConflictAssignments.delete(assignmentId);
        }
        return state;
      }
      case "capability-revoked": {
        const assignmentId = body.assignmentId;
        const capId = body.capId;
        const assigned = state.assignedById.get(assignmentId);
        const key = `${assignmentId}\0${capId}`;
        assertCapabilityRevocationReplayContract({
          assignmentExists: assigned !== undefined,
          capabilityBelongsToAssignment: assigned?.capIds.has(capId) ?? false,
          alreadyRevoked: state.revokedCapabilities.has(key),
        });
        state.revokedCapabilities.add(key);
        return state;
      }
      case "ticket-issued": {
        const assigned = state.assignedById.get(body.ticket.assignmentId);
        const admitted = assigned
          ? state.admittedByRun.get(assigned.record.runId)
          : undefined;
        applyConversationTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          conversationId: this.#conversationId,
          assigned: assigned?.record,
          assignmentIsCurrent:
            assigned !== undefined &&
            state.assignmentByRun.get(assigned.record.runId) ===
              assigned.record.assignmentId,
          assignmentAcknowledged: assigned?.acked ?? false,
          assignmentClosed: state.closedAssignments.has(
            body.ticket.assignmentId,
          ),
          assignmentActive:
            assigned !== undefined &&
            (state.stateByRun.get(assigned.record.runId)?.state ===
              "dispatched" ||
              state.stateByRun.get(assigned.record.runId)?.state ===
                "running") &&
            !state.cancelFences.has(body.ticket.assignmentId),
          originalSurfacePrincipal: admitted?.ingress.surfacePrincipal,
          hasAtomicReplacementRevocation:
            body.replacesTicketId === undefined ||
            envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "ticket-revoked" &&
                candidate.ticketId === body.replacesTicketId,
            ),
        });
        return state;
      }
      case "ticket-revoked":
        applyConversationTicketRecord({
          state,
          record: body,
          verifier: this.#verifier,
          envelopeAt: envelope.at,
          conversationId: this.#conversationId,
          assignmentIsCurrent: false,
          assignmentAcknowledged: false,
          assignmentClosed: false,
          assignmentActive: false,
        });
        return state;
      case "ticket-sync-frontier":
        applyConversationTicketSyncFrontier(
          state,
          body.expiresThrough,
          envelope.at,
        );
        return state;
      case "state": {
        const runId = body.runId;
        const admitted = state.admittedByRun.get(runId);
        if (!admitted) {
          throw corruptRunJournal("Submission guard state has no admitted run");
        }
        const current = state.stateByRun.get(runId);
        const next = body.state;
        const assignmentId = body.assignmentId;
        const assigned = assignmentId
          ? state.assignedById.get(assignmentId)
          : undefined;
        const mappedAssignmentId = state.assignmentByRun.get(runId);
        const closedEarlierInEnvelope =
          assignmentId !== undefined &&
          mappedAssignmentId === undefined &&
          state.closedAssignments.has(assignmentId) &&
          envelopeClosesAssignment(
            envelope,
            this.#conversationId,
            runId,
            assignmentId,
          );
        assertStateReplayContract({
          currentState: current?.state,
          currentRevision: current?.statusRevision,
          nextState: next,
          nextRevision: body.statusRevision,
          assignmentId,
          assignmentBindingValid:
            assigned?.record.runId === runId &&
            (mappedAssignmentId === assignmentId || closedEarlierInEnvelope),
          unassignedBindingValid: mappedAssignmentId === undefined,
          hasAtomicAssignment:
            current?.state !== "queued" ||
            next !== "dispatched" ||
            envelopeHasRunRecord(
              envelope,
              this.#conversationId,
              (candidate) =>
                candidate.t === "assigned" &&
                candidate.runId === runId &&
                candidate.assignmentId === assignmentId,
            ),
        });
        if (
          current?.state === "queued" &&
          (next === "cancelled" || next === "failed" || next === "expired")
        ) {
          try {
            assertQueuedTerminalDequeue(
              envelope.entries,
              {
                kind: "run",
                id: runId,
                attempt: nextConversationAssignmentAttempt(state, runId),
              },
              next,
            );
          } catch (error) {
            throw corruptRunJournal(
              error instanceof Error ? error.message : "Queued run resource dequeue is invalid",
            );
          }
        }
        assertStateAtomicReplayContract({
          currentState: current?.state,
          nextState: next,
          hasAtomicCancelFence: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "cancel-fence" &&
              candidate.assignmentId === assignmentId &&
              state.assignedById.get(candidate.assignmentId)?.record.runId === runId,
          ),
          hasAtomicOpenResolution: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "resolution" &&
              candidate.runId === runId &&
              candidate.fact.subject.assignmentId === assignmentId &&
              candidate.fact.resolution === undefined,
          ),
          hasAtomicSupersede: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "assignment-superseded" &&
              candidate.assignmentId === assignmentId &&
              state.assignedById.get(candidate.assignmentId)?.record.runId === runId,
          ),
          hasAtomicTermination: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              (candidate.t === "cancel-proof-accepted" ||
                candidate.t === "assignment-superseded") &&
              candidate.assignmentId === assignmentId &&
              state.assignedById.get(candidate.assignmentId)?.record.runId === runId,
          ),
          hasAtomicResolutionClose: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "resolution" &&
              candidate.runId === runId &&
              candidate.fact.subject.assignmentId === assignmentId &&
              candidate.fact.resolution !== undefined,
          ),
          hasAtomicCommit: envelopeHasRunRecord(
            envelope,
            this.#conversationId,
            (candidate) =>
              candidate.t === "committed" &&
              candidate.runId === runId &&
              candidate.assignmentId === assignmentId,
          ),
        });
        if (next === "failed" && assigned) {
          if (body.usageFinal) {
            this.#assertResourceUsageFinal(assigned.record, body.usageFinal);
          }
          this.#assertResourceTerminalRecords(
            assigned.record,
            body.usageFinal ? "settle-release" : "reclaim",
            envelope.entries,
          );
        }
        const nextActiveRunId = nextActiveRunIdForReplay({
          activeRunId: state.activeRunId,
          runId,
          currentState: current?.state,
          nextState: next,
        });
        if (current?.state === "queued") {
          removeQueuedRun(state, admitted.queuedPosition, runId);
        }
        if (next === "queued") {
          addQueuedRun(state, admitted.queuedPosition, runId);
        }
        state.activeRunId = nextActiveRunId;
        state.stateByRun.set(runId, {
          state: next,
          statusRevision: body.statusRevision,
        });
        if (next === "running" && assignmentId !== undefined) {
          state.durableStartedAssignments.add(assignmentId);
        }
        return state;
      }
      case "committed": {
        const runId = body.runId;
        const assignmentId = body.assignmentId;
        const assigned = state.assignedById.get(assignmentId);
        const current = state.stateByRun.get(runId);
        assertCommittedReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.runId === runId,
          assignmentIsCurrent: state.assignmentByRun.get(runId) === assignmentId,
          currentState: current?.state,
          alreadyCommitted: state.committedByAssignment.has(assignmentId),
          conflictOpen: state.openConflictAssignments.has(assignmentId),
          commitRevisionMatchesAssignedBase:
            assigned !== undefined &&
            body.commitRevision === assigned.record.baseRevision + 1,
          hasAtomicCommittedState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              this.#conversationId,
              runId,
              "committed",
              current.statusRevision + 1,
              assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesCapabilities(
              envelope,
              this.#conversationId,
              state.revokedCapabilities,
              assignmentId,
              assigned.capIds,
              state.ticketIdsByAssignment.get(assignmentId) ?? [],
              state.revokedTickets,
            ),
        });
        if (!assigned) {
          throw corruptRunJournal("Submission guard commit has no assignment");
        }
        this.#assertResourceTerminalRecords(
          assigned.record,
          "settle-release",
          envelope.entries,
        );
        state.committedByAssignment.set(assignmentId, {
          bundle: body.bundle,
          commitRevision: body.commitRevision,
          sidecars: submissionCommitSidecars(
            envelope,
            this.#conversationId,
            {
              t: "committed",
              runId,
              assignmentId,
              bundle: body.bundle,
              commitRevision: body.commitRevision,
            },
          ),
        });
        return state;
      }
      case "bundle-ack-observed": {
        const committed = state.committedByAssignment.get(body.assignmentId);
        if (
          !committed ||
          state.bundleAcknowledgements.has(body.assignmentId) ||
          !bundleAcknowledgementBindsCommitted({
            observedBundleRef: body.bundleRef,
            observedCommitRevision: body.commitRevision,
            expectedBundleRef: committed.bundle.ref,
            expectedCommitRevision: committed.commitRevision,
          })
        ) {
          throw corruptRunJournal(
            "Submission guard bundle acknowledgement is invalid or duplicated",
          );
        }
        state.bundleAcknowledgements.set(body.assignmentId, body);
        return state;
      }
      default:
        return state;
    }
  };

  async #loadSubmissionGuard(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<SubmissionGuardProjection> {
    this.#assertSubmissionContextIdentity(context, identity);
    return this.#operations.run(async () => {
      const cached = this.#submissionGuardProjection;
      const replay = async () => {
        try {
          return await this.#log.transactProjection<
            SubmissionGuardProjection,
            ConversationCommitLogRecord,
            void
          >(
            cached?.state ?? emptySubmissionGuardProjection(),
            this.#reduceSubmissionGuard,
            () => ({ kind: "return", value: undefined }),
            {
              stream: runStream(this.#conversationId),
              ...(cached ? { cursor: cached.cursor } : {}),
            },
          );
        } catch (error) {
          this.#submissionGuardProjection = undefined;
          throw error;
        }
      };
      const transaction = await (
        this.#resources ? this.#resources.coordinate(replay) : replay()
      );
      this.#submissionGuardProjection = {
        state: transaction.state,
        cursor: transaction.cursor,
      };
      if (context.principal.kind !== "assignment") return transaction.state;
      const capability = context.principal.capability;
      const assigned = transaction.state.assignedById.get(identity.assignmentId);
      assertActivatedAssignmentCapability({
        capability,
        activation: assigned
          ? {
              capIds: assigned.record.capIds,
              assignmentId: assigned.record.assignmentId,
              executorId: assigned.record.executorId,
              authority: {
                execution: "conversation",
                conversationId: this.#conversationId,
                ownerEpoch: assigned.record.ownerEpoch,
              },
            }
          : undefined,
        verifier: this.#verifier,
        method: identity.method,
        resource: `conversation:${this.#conversationId}`,
        mode: "durable-replay",
        revoked: false,
        now: this.#clock(),
        deadlineAt: context.deadlineAt,
      });
      return transaction.state;
    });
  }

  #hasCurrentSubmissionAuthorityEpoch(context: AuthorityCallContext): boolean {
    if (context.principal.kind !== "assignment") return false;
    const capability = context.principal.capability;
    return (
      capability.scope.execution === "conversation" &&
      "ownerEpoch" in capability &&
      capability.ownerEpoch === this.#ownerEpoch
    );
  }

  #submissionBundleRejection(
    guard: SubmissionGuardProjection,
    context: AuthorityCallContext,
    assignmentId: string,
    runId: string,
  ): string | undefined {
    const state = guard.stateByRun.get(runId)?.state;
    return !this.#hasCurrentSubmissionAuthorityEpoch(context)
      ? "Bundle capability belongs to a stale owner epoch"
      : guard.assignmentByRun.get(runId) !== assignmentId
        ? "Bundle belongs to a historical assignment"
        : guard.openConflictAssignments.has(assignmentId)
          ? "Bundle is blocked by an open dispatch conflict"
          : state !== "dispatched" &&
              state !== "running" &&
              state !== "cancel-requested" &&
              state !== "uncertain"
            ? "Bundle is late for the current run state"
            : undefined;
  }

  #authenticateSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    this.#submission.authenticate(context, identity);
    this.#assertSubmissionContextIdentity(context, identity);
  }

  #assertSubmissionContextIdentity(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    if (
      context.principal.kind !== "assignment" ||
      context.principal.capability.assignmentId !== identity.assignmentId ||
      !context.principal.capability.methods.includes(identity.method)
    ) {
      throw new Error("Assignment submission identity does not bind the call");
    }
  }

  #assertActivatedSubmissionCapability(
    state: RunProjection,
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    this.#assertSubmissionContextIdentity(context, identity);
    if (context.principal.kind !== "assignment") return;
    const capability = context.principal.capability;
    const assigned = state.assignedById.get(identity.assignmentId);
    assertActivatedAssignmentCapability({
      capability,
      activation: assigned
        ? {
            capIds: assigned.record.capIds,
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            authority: {
              execution: "conversation",
              conversationId: this.#conversationId,
              ownerEpoch: assigned.record.ownerEpoch,
            },
          }
        : undefined,
      verifier: this.#verifier,
      method: identity.method,
      resource: `conversation:${this.#conversationId}`,
      mode: "durable-replay",
      revoked: false,
      now: this.#clock(),
      deadlineAt: context.deadlineAt,
    });
    if (assigned) {
      assertCapabilityMatchesAssignedEnvelope(capability, assigned.envelope);
    }
  }

  #authorizeSubmission(
    state: RunProjection,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    this.#authorizeAuthenticatedSubmission(context, authorization);
    this.#assertDurableSubmissionCapability(
      state.assignedById.get(authorization.assignmentId),
      state.revokedCapabilities,
      context,
      authorization,
    );
  }

  #authorizeGuardSubmission(
    state: SubmissionGuardProjection,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    this.#authorizeAuthenticatedSubmission(context, authorization);
    this.#assertDurableSubmissionCapability(
      state.assignedById.get(authorization.assignmentId),
      state.revokedCapabilities,
      context,
      authorization,
    );
  }

  #assertDurableSubmissionCapability(
    assigned:
      | {
          readonly record: Extract<ConversationRunJournalRecord, { t: "assigned" }>;
          readonly envelope?: PendingConversationDispatch["envelope"];
        }
      | undefined,
    revokedCapabilities: ReadonlySet<string>,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    if (context.principal.kind !== "assignment") return;
    const capability = context.principal.capability;
    assertActivatedAssignmentCapability({
      capability,
      activation: assigned
        ? {
            capIds: assigned.record.capIds,
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            authority: {
              execution: "conversation",
              conversationId: this.#conversationId,
              ownerEpoch: assigned.record.ownerEpoch,
            },
          }
        : undefined,
      verifier: this.#verifier,
      method: authorization.method,
      resource: `conversation:${this.#conversationId}`,
      mode: authorization.mode,
      revoked: revokedCapabilities.has(
        `${authorization.assignmentId}\0${capability.capId}`,
      ),
      now: this.#clock(),
      deadlineAt: context.deadlineAt,
    });
    if (assigned?.envelope) {
      assertCapabilityMatchesAssignedEnvelope(capability, assigned.envelope);
    }
  }

  #authorizeAuthenticatedSubmission(
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    this.#submission.authorize(context, authorization);
    this.#assertSubmissionContextIdentity(context, authorization);
    if (
      (authorization.mode === "active" || authorization.mode === "settlement") &&
      !this.#hasCurrentSubmissionAuthorityEpoch(context)
    ) {
      throw new Error("Assignment capability belongs to a stale owner epoch");
    }
  }

  async #transact<Value>(
    decide: (
      state: RunProjection,
      authorityPrefix: ProjectionTransactionContext,
    ) => ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    return this.#operations.run(async () => {
      try {
        const cached = this.#runProjection;
        const transact = () => this.#delivery.coordinate(() =>
          this.#log.transactProjection<
          RunProjection,
          unknown,
          Value
        >(
          cached?.state ?? emptyProjection(this.#conversationId),
          this.#reduce,
          (state, context) => {
            const decision = decide(state, context);
            if (decision.kind !== "append") return decision;
            const statuses = conversationStatusDeliveryInputs(
              this.#conversationId,
              state,
              decision.entries,
              context.at,
            );
            const prepared = this.#delivery.prepareConversationStatuses(statuses);
            if (!prepared.accepted) {
              throw corruptRunJournal(prepared.error.message);
            }
            const resourceRecords = this.#prepareResourceTerminalRecords(
              state,
              decision.entries,
            );
            return {
              ...decision,
              entries: [...resourceRecords, ...decision.entries, ...prepared.records],
            };
          },
          {
            stream: runStream(this.#conversationId),
            ...(cached ? { cursor: cached.cursor } : {}),
            candidateReferences,
          },
        ));
        const transaction = await (
          this.#resources ? this.#resources.coordinate(transact) : transact()
        );
        this.#runProjection = {
          state: transaction.state,
          cursor: transaction.cursor,
        };
        if (transaction.commit) {
          if (
            transaction.commit.entries.some(
              (entry) =>
                typeof entry.body === "object" &&
                entry.body !== null &&
                "kind" in entry.body &&
                entry.body.kind === "session-activity",
            )
          ) {
            publishTerminalPerformanceObservation({
              kind: "session-activity-commit",
            });
          }
          this.#publishStatusNotices(
            conversationStatusNoticesForCommit(
              transaction.state,
              transaction.commit,
              this.#conversationId,
              this.#ownerEpoch,
            ),
          );
        }
        return transaction;
      } catch (error) {
        this.#runProjection = undefined;
        throw error;
      }
    });
  }

  #prepareResourceTerminalRecords(
    state: RunProjection,
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const bodies: readonly unknown[] = entries
      .filter((entry) => entry.stream === runStream(this.#conversationId))
      .map((entry) => entry.body);
    const committed = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "committed" }> =>
        isTaggedRecord(body, "committed"),
    );
    const cancelled = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "cancel-proof-accepted" }> =>
        isTaggedRecord(body, "cancel-proof-accepted"),
    );
    const superseded = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "assignment-superseded" }> =>
        isTaggedRecord(body, "assignment-superseded"),
    );
    const closedResolution = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "resolution" }> =>
        isTaggedRecord(body, "resolution") && body.fact.resolution !== undefined,
    );
    const failed = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "state" }> =>
        isTaggedRecord(body, "state") &&
        body.state === "failed" &&
        body.assignmentId !== undefined,
    );
    const assignmentId =
      committed?.assignmentId ??
      cancelled?.assignmentId ??
      superseded?.assignmentId ??
      closedResolution?.fact.subject.assignmentId ??
      failed?.assignmentId;
    if (!assignmentId) return [];
    const assigned = state.assignedById.get(assignmentId);
    if (!assigned) throw corruptRunJournal("Resource terminal has no durable assignment");
    const lease = assigned.envelope.resourceLease;
    if (!requiresFormalResourceCoordination(lease)) return [];
    if (!this.#resources) {
      throw corruptRunJournal("Governed assignment has no resource coordinator");
    }
    const mode = committed
      ? "settle-release"
      : cancelled
        ? cancelled.proof.decision === "not-started"
          ? "release"
          : "settle-release"
        : superseded
          ? "release"
          : failed?.usageFinal
            ? "settle-release"
            : "reclaim";
    return this.#resources.prepareTerminal({ lease, mode });
  }

  #assertResourceTerminalRecords(
    assigned: {
      readonly assignmentId: string;
      readonly reservation: { readonly reservationId: string };
    },
    mode: "settle-release" | "release" | "reclaim",
    records: readonly LogicalRecord<unknown>[],
  ): void {
    if (!requiresFormalResourceCoordination({
      reservationId: assigned.reservation.reservationId,
      assignmentId: assigned.assignmentId,
    })) return;
    if (!this.#resources) {
      throw corruptRunJournal("Governed assignment has no resource coordinator");
    }
    try {
      this.#resources.assertTerminalRecords({
        reservationId: assigned.reservation.reservationId,
        mode,
        records,
      });
    } catch (error) {
      throw corruptRunJournal(
        error instanceof Error
          ? `Assignment resource terminal is invalid: ${error.message}`
          : "Assignment resource terminal is invalid",
      );
    }
  }

  #assertResourceUsageFinal(
    assigned: {
      readonly assignmentId: string;
      readonly executorId: string;
      readonly reservation: { readonly reservationId: string };
    },
    usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): void {
    if (!requiresFormalResourceCoordination({
      reservationId: assigned.reservation.reservationId,
      assignmentId: assigned.assignmentId,
    })) return;
    if (!this.#resources) {
      throw corruptRunJournal("Governed assignment has no resource coordinator");
    }
    try {
      this.#resources.assertUsageFinal({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
        executorId: assigned.executorId,
        usageFinal,
      });
    } catch (error) {
      throw corruptRunJournal(
        error instanceof Error
          ? `Assignment final usage is invalid: ${error.message}`
          : "Assignment final usage is invalid",
      );
    }
  }

  #publishStatusNotices(notices: readonly ConversationStatusNotice[]): void {
    for (const notice of notices) {
      for (const listener of this.#statusListeners) {
        void Promise.resolve()
          .then(() => listener(notice))
          .catch(() => undefined);
      }
    }
  }

  async #appendPublishProgress(progress: Extract<PublishRecord, { t: "publish-progress" }>) {
    await this.#operations.run(async () => {
      try {
        const cached = this.#publishProjection;
        const transaction = await this.#log.transactProjection<
          PublishProjection,
          PublishRecord,
          void
        >(
          cached?.state ?? emptyPublishProjection(),
          (state, record, envelope) =>
            reducePublishRecord(state, record, envelope, this.#artifacts),
          (state) => {
            const key = `${progress.assignmentId}\0${progress.domain}`;
            const current = state.progress.get(key);
            if (
              current &&
              (current.upToSeq > progress.upToSeq ||
                current.state === "settled" ||
                (current.upToSeq === progress.upToSeq && current.state === progress.state))
            ) {
              return { kind: "return", value: undefined };
            }
            return {
              kind: "append",
              entries: [{ stream: "publish", body: progress }],
              value: undefined,
            };
          },
          {
            stream: "publish",
            ...(cached ? { cursor: cached.cursor } : {}),
          },
        );
        this.#publishProjection = {
          state: transaction.state,
          cursor: transaction.cursor,
        };
      } catch (error) {
        this.#publishProjection = undefined;
        throw error;
      }
    });
  }

  async #selectPublish<Value>(select: (state: PublishProjection) => Value): Promise<Value> {
    return this.#operations.run(async () => {
      try {
        const cached = this.#publishProjection;
        const transaction = await this.#log.transactProjection<
          PublishProjection,
          PublishRecord,
          void
        >(
          cached?.state ?? emptyPublishProjection(),
          (state, record, envelope) =>
            reducePublishRecord(state, record, envelope, this.#artifacts),
          () => ({ kind: "return", value: undefined }),
          {
            stream: "publish",
            ...(cached ? { cursor: cached.cursor } : {}),
          },
        );
        this.#publishProjection = {
          state: transaction.state,
          cursor: transaction.cursor,
        };
        return select(transaction.state);
      } catch (error) {
        this.#publishProjection = undefined;
        throw error;
      }
    });
  }

  async #selectFinal<Value>(select: (state: FinalOutboxProjection) => Value): Promise<Value> {
    return this.#operations.run(async () => {
      try {
        const cached = this.#finalProjection;
        const transaction = await this.#log.transactProjection<
          FinalOutboxProjection,
          FinalOutboxRecord,
          void
        >(
          cached?.state ?? emptyFinalProjection(),
          async (projection, record, envelope) => {
            await applyFinalRecord(
              projection,
              record.body,
              envelope.at,
              envelope,
              this.#artifacts,
            );
            return projection;
          },
          () => ({ kind: "return", value: undefined }),
          {
            stream: "final-outbox",
            ...(cached ? { cursor: cached.cursor } : {}),
          },
        );
        this.#finalProjection = {
          state: transaction.state,
          cursor: transaction.cursor,
        };
        return select(transaction.state);
      } catch (error) {
        this.#finalProjection = undefined;
        throw error;
      }
    });
  }

  async #transitionFinal(
    frame: FinalFrame,
    expectedState: "pending" | "published",
    state: "published" | "expired",
    notAfter?: number,
  ): Promise<boolean> {
    const key = finalKey(frame);
    return this.#operations.run(async () => {
      try {
        const cached = this.#finalProjection;
        const result = await this.#log.transactProjection<
          FinalOutboxProjection,
          FinalOutboxRecord,
          boolean
        >(
          cached?.state ?? emptyFinalProjection(),
          async (projection, record, envelope) => {
            await applyFinalRecord(
              projection,
              record.body,
              envelope.at,
              envelope,
              this.#artifacts,
            );
            return projection;
          },
          (projection) => {
            const current = projection.entries.get(key);
            if (
              !current ||
              current.record.state !== expectedState ||
              current.record.digest !== frame.digest ||
              (notAfter !== undefined &&
                canonicalTime(current.at, "Final outbox record time") > notAfter)
            ) {
              return { kind: "return", value: false };
            }
            return {
              kind: "append",
              entries: [
                { stream: "final-outbox", body: { ...current.record, state } },
              ],
              value: true,
            };
          },
          {
            stream: "final-outbox",
            ...(cached ? { cursor: cached.cursor } : {}),
          },
        );
        this.#finalProjection = { state: result.state, cursor: result.cursor };
        return result.value;
      } catch (error) {
        this.#finalProjection = undefined;
        throw error;
      }
    });
  }
}

/** Explicitly gated single-process transport; disabled means zero dispatch side effects. */
export class InProcessConversationDispatcher {
  readonly #enabled: boolean;
  readonly #journal: ConversationRunJournal;
  readonly #executor: ConversationDispatchPort;
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #cancellationSubmission: InProcessCancellationSubmission | undefined;
  readonly #bundleSubmission: InProcessBundleSubmission | undefined;

  constructor(options: InProcessConversationDispatcherOptions) {
    this.#enabled = options.enabled;
    this.#journal = options.journal;
    this.#executor = options.executor;
    this.#contexts = options.contexts;
    this.#cancellationSubmission = options.cancellationSubmission;
    this.#bundleSubmission = options.bundleSubmission;
  }

  async dispatchPending(): Promise<readonly DispatchResult[]> {
    if (!this.#enabled) return [];
    const pending = await this.#journal.pendingDispatches();
    const outcomes: DispatchResult[] = [];
    for (const item of pending) {
      const outcome = this.#journal.validateExecutorDispatchResult(
        await this.#executor.dispatch(
          item.envelope,
          item.activation,
          this.#dispatchContext(item),
        ),
      );
      outcomes.push(outcome);
      if (outcome.accepted) {
        await this.#journal.acknowledgeDispatch(item.assignmentId);
      } else if (outcome.outcome === "rejected-before-received") {
        await this.#journal.acceptDispatchRejection(outcome);
      } else {
        await this.#journal.recordDispatchConflict(item, outcome);
      }
    }
    return outcomes;
  }

  async recoverStarted(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.dispatchesAwaitingStarted();
    let recovered = 0;
    for (const item of pending) {
      const snapshot = this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          item.assignmentId,
          this.#queryContext(item.assignmentId),
        ),
      );
      if (
        snapshot.phase === "started" ||
        snapshot.phase === "sealed" ||
        snapshot.phase === "acked"
      ) {
        await this.#journal.reconcileStarted(item.assignmentId, snapshot);
        recovered += 1;
      }
    }
    return recovered;
  }

  async cancelRun(input: ConversationCancelRequest): Promise<ConversationCancelResult> {
    const result = await this.#journal.cancelRun(input);
    if (!this.#enabled || result.state !== "cancel-requested") return result;
    await this.#executor.cancel(
      result.assignmentId,
      result.fence,
      this.#fenceContext(result.assignmentId, "executor.cancel", result.fence),
    );
    if (!(await this.#submitCancellation(result.assignmentId))) {
      await this.#executor.cancel(
        result.assignmentId,
        result.fence,
        this.#fenceContext(result.assignmentId, "executor.cancel", result.fence),
      );
      await this.#submitCancellation(result.assignmentId);
    }
    return result;
  }

  async recoverCancellations(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingCancellations();
    for (const item of pending) {
      await this.#executor.cancel(
        item.assignmentId,
        item.fence,
        this.#fenceContext(item.assignmentId, "executor.cancel", item.fence),
      );
      if (!(await this.#submitCancellation(item.assignmentId))) {
        await this.#executor.cancel(
          item.assignmentId,
          item.fence,
          this.#fenceContext(item.assignmentId, "executor.cancel", item.fence),
        );
        await this.#submitCancellation(item.assignmentId);
      }
    }
    return pending.length;
  }

  async recoverAssignments(): Promise<number> {
    if (!this.#enabled) return 0;
    const assignments = await this.#journal.assignmentsAwaitingRecovery();
    let recovered = 0;
    for (const candidate of assignments) {
      const ledger = this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          candidate.assignmentId,
          this.#queryContext(candidate.assignmentId),
        ),
      );
      if (ledger.phase === "dispatch-rejected") {
        const outcome = this.#journal.validateExecutorDispatchResult(
          await this.#executor.dispatch(
            candidate.dispatch.envelope,
            candidate.dispatch.activation,
            this.#dispatchContext(candidate.dispatch),
          ),
        );
        if (outcome.accepted || outcome.outcome !== "rejected-before-received") {
          throw new Error("Dispatch rejection terminal did not replay its original proof");
        }
        await this.#journal.acceptDispatchRejection(outcome);
        recovered += 1;
        continue;
      }
      if (ledger.phase === "failed") {
        if (!ledger.failure) {
          throw new Error("Failed executor assignment has no durable failure fact");
        }
        await this.#journal.failAssignedRun(
          candidate.dispatch.envelope.work.runId,
          candidate.assignmentId,
          ledger.failure.reason,
          ledger.failure.usageFinal,
        );
        recovered += 1;
        continue;
      }
      if (ledger.cancelProof) {
        if (!(await this.#submitCancellation(candidate.assignmentId))) {
          throw new Error("Durable cancel proof disappeared before submission");
        }
        recovered += 1;
        continue;
      }
      if (ledger.phase === "acked") {
        if (candidate.state === "dispatched") {
          await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
        }
        await this.#journal.observeBundleAcknowledgement(
          candidate.assignmentId,
          ledger,
        );
        recovered += 1;
        continue;
      }
      if (ledger.phase === "sealed") {
        let progressed = false;
        if (candidate.state === "dispatched") {
          await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
          progressed = true;
        }
        const result = await this.#submitSealedBundle(candidate.assignmentId);
        if (result.committed) {
          const acknowledged = this.#journal.validateExecutorLedgerSnapshot(
            await this.#executor.queryLedger(
              candidate.assignmentId,
              this.#queryContext(candidate.assignmentId),
            ),
          );
          await this.#journal.observeBundleAcknowledgement(
            candidate.assignmentId,
            acknowledged,
          );
          progressed = true;
        }
        if (progressed) recovered += 1;
        continue;
      }
      if (
        candidate.state === "uncertain" ||
        candidate.state === "committed" ||
        ledger.lastSeq <= 0
      ) {
        continue;
      }
      const assignmentId = candidate.assignmentId;
      const executor = this.#executor;
      const contexts = this.#contexts;
      const pages = (async function* (): AsyncGenerator<LedgerEvidencePage> {
        let fromSeq = 1;
        while (fromSeq <= ledger.lastSeq) {
          const page = await executor.queryLedger(
            assignmentId,
            contexts.create(assignmentId, "executor.queryLedger", {
              requestId: `ledger:${assignmentId}:${fromSeq}:${Math.min(256, ledger.lastSeq - fromSeq + 1)}`,
              body: {
                range: {
                  fromSeq,
                  limit: Math.min(256, ledger.lastSeq - fromSeq + 1),
                },
              },
            }),
            { fromSeq, limit: Math.min(256, ledger.lastSeq - fromSeq + 1) },
          );
          if (!("entries" in page)) {
            throw new TypeError("Executor returned a snapshot for an evidence page query");
          }
          yield page;
          fromSeq = page.toSeq + 1;
        }
      })();
      if (
        await this.#journal.reconcileCancellationEvidence(
          assignmentId,
          ledger,
          pages,
        )
      ) {
        recovered += 1;
      }
    }
    return recovered;
  }

  async recoverCancellationProofs(): Promise<number> {
    return this.recoverAssignments();
  }

  async supersede(
    assignmentId: string,
    requestId: string,
  ): Promise<SupersedeProof> {
    if (!this.#enabled) throw new Error("In-process dispatch is disabled");
    const fence = await this.#journal.requestSupersede(assignmentId, requestId);
    const proof = await this.#executor.supersede(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.supersede", fence),
    );
    await this.#journal.acceptSupersedeProof(proof);
    return proof;
  }

  async recoverSupersedes(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingSupersedes();
    for (const item of pending) {
      const proof = await this.#executor.supersede(
        item.assignmentId,
        item.fence,
        this.#fenceContext(item.assignmentId, "executor.supersede", item.fence),
      );
      await this.#journal.acceptSupersedeProof(proof);
    }
    return pending.length;
  }

  async #submitCancellation(assignmentId: string): Promise<boolean> {
    if (!this.#cancellationSubmission) {
      throw new Error("In-process cancellation submission is not configured");
    }
    return this.#cancellationSubmission.submitCancellation(assignmentId);
  }

  #dispatchContext(item: PendingConversationDispatch): AuthorityCallContext {
    return this.#contexts.create(item.assignmentId, "executor.dispatch", {
      requestId: `dispatch:${item.assignmentId}`,
      body: {
        dispatchDigest: dispatchEnvelopeDigest(item.envelope),
        activationDigest: assignmentActivationDigest(
          withoutSignature(item.activation),
        ),
      },
    });
  }

  #queryContext(
    assignmentId: string,
    range?: { readonly fromSeq: number; readonly limit: number },
  ): AuthorityCallContext {
    return this.#contexts.create(assignmentId, "executor.queryLedger", {
      requestId: range
        ? `ledger:${assignmentId}:${range.fromSeq}:${range.limit}`
        : `ledger:${assignmentId}:snapshot`,
      body: { range: range ?? null },
    });
  }

  #fenceContext(
    assignmentId: string,
    method: "executor.cancel" | "executor.supersede",
    fence: { readonly fenceSeq: number; readonly requestId: string },
  ): AuthorityCallContext {
    return this.#contexts.create(assignmentId, method, {
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
  }

  async #submitSealedBundle(
    assignmentId: string,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  > {
    if (!this.#bundleSubmission) {
      throw new Error("In-process bundle submission is not configured");
    }
    return this.#bundleSubmission.submitSealedBundle(assignmentId);
  }
}

function emptyProjection(conversationId: string): RunProjection {
  return {
    conversationId,
    domainRevision: 0,
    deleted: false,
    sessionMeta: undefined,
    sessionMetaByRequest: new Map(),
    lifecycleByRequest: new Map(),
    pendingLifecycleProjections: new Map(),
    projectedLifecycleRevisions: new Set(),
    admittedByRun: new Map(),
    runByIngress: new Map(),
    assignedById: new Map(),
    assignmentByRun: new Map(),
    stateByRun: new Map(),
    queuedRunByPosition: new Map(),
    queuedPositionHeap: [],
    queuedPositionHeapIndex: new Map(),
    mirrorStateByAssignment: new Map(),
    mirrorBatches: new Map(),
    committedByAssignment: new Map(),
    bundleAcknowledgements: new Map(),
    recoveryAssignments: new Set(),
    bundleAcknowledgementOutbox: new Set(),
    commits: [],
    assignmentByCommitRevision: new Map(),
    contentByRevision: new Map(),
    projectedByAssignment: new Map(),
    pendingCommitProjections: new Map(),
    conflicts: new Map(),
    conflictByAssignment: new Map(),
    containedFacts: new Set(),
    containmentByAssignment: new Map(),
    superseded: new Map(),
    supersedeRequests: new Map(),
    supersedeStartedObservations: new Map(),
    cancelFences: new Map(),
    cancelOrigins: new Map(),
    acceptedCancellations: new Map(),
    rejectedNotStarted: new Map(),
    uncertainOrigins: new Map(),
    revokedCapabilities: new Set(),
    ticketsById: new Map(),
    ticketIdsByAssignment: new Map(),
    ticketReplacementsById: new Map(),
    revokedTickets: new Set(),
    ticketSyncFrontier: undefined,
    resolutionsByRun: new Map(),
    statusHistoryByRun: new Map(),
    closedAssignments: new Set(),
    channelInteractions: createChannelInteractionJournalState("conversation"),
  };
}

function emptySubmissionGuardProjection(): SubmissionGuardProjection {
  return {
    admittedByRun: new Map(),
    runByIngress: new Map(),
    queuedRunByPosition: new Map(),
    queuedPositionHeap: [],
    queuedPositionHeapIndex: new Map(),
    assignedById: new Map(),
    assignmentByRun: new Map(),
    stateByRun: new Map(),
    conflictAssignments: new Set(),
    openConflictAssignments: new Set(),
    supersedeRequests: new Map(),
    supersedeStartedAssignments: new Set(),
    cancelFences: new Map(),
    acceptedCancellations: new Set(),
    durableStartedAssignments: new Set(),
    resolutionsByRun: new Map(),
    committedByAssignment: new Map(),
    bundleAcknowledgements: new Map(),
    closedAssignments: new Set(),
    revokedCapabilities: new Set(),
    ticketsById: new Map(),
    ticketIdsByAssignment: new Map(),
    ticketReplacementsById: new Map(),
    revokedTickets: new Set(),
    ticketSyncFrontier: undefined,
    activeRunId: undefined,
  };
}

/**
 * 用户取消控制面的候选枚举——投影查询与 cancel-batch 权威决定共用的
 * 单源谓词;两处对"什么算可取消"的判定不允许分叉。
 */
function cancellableRunDescriptors(
  state: RunProjection,
): ConversationRunControlDescriptor[] {
  const runs: ConversationRunControlDescriptor[] = state.queuedPositionHeap.map((position) => {
    const runId = state.queuedRunByPosition.get(position);
    const current = runId ? state.stateByRun.get(runId)?.state : undefined;
    const admitted = runId ? state.admittedByRun.get(runId) : undefined;
    if (!runId || current !== "queued" || !admitted) {
      throw corruptRunJournal("Queued cancellation projection is inconsistent");
    }
    return {
      runId,
      state: current,
      source: admitted.record.invocation.source,
      ingressId: admitted.record.ingress.ingressId,
    };
  });
  if (state.activeRunId !== undefined) {
    const current = state.stateByRun.get(state.activeRunId)?.state;
    const admitted = state.admittedByRun.get(state.activeRunId);
    if (
      admitted &&
      (current === "dispatched" ||
        current === "running" ||
        current === "cancel-requested")
    ) {
      runs.unshift({
        runId: state.activeRunId,
        state: current,
        source: admitted.record.invocation.source,
        ingressId: admitted.record.ingress.ingressId,
      });
    }
  }
  return runs;
}

function decideConversationCancel(
  conversationId: string,
  state: RunProjection,
  input: ConversationCancelRequest,
  nextLsn: number,
  queuedTerminalRecords: readonly LogicalRecord<GovernorRecord>[] = [],
): ProjectionTransactionDecision<ConversationCommitLogRecord, ConversationCancelResult> {
  const current = state.stateByRun.get(input.runId);
  if (!current) throw new Error("Cannot cancel an unknown run");
  const assignmentId = state.assignmentByRun.get(input.runId);
  if (current.state === "queued") {
    return {
      kind: "append",
      entries: [
        ...queuedTerminalRecords,
        runRecord(conversationId, {
          t: "state",
          runId: input.runId,
          state: "cancelled",
          statusRevision: current.statusRevision + 1,
        }),
      ],
      value: { state: "cancelled", ...(assignmentId ? { assignmentId } : {}) },
    };
  }
  if (current.state === "cancel-requested") {
    if (!assignmentId) throw corruptRunJournal("Cancelling run has no assignment");
    const durableFence = state.cancelFences.get(assignmentId);
    if (!durableFence) throw corruptRunJournal("Cancelling run has no durable fence");
    return {
      kind: "return",
      value: {
        state: "cancel-requested",
        assignmentId,
        fence: {
          fenceSeq: durableFence.fenceSeq,
          requestId: durableFence.requestId,
        },
      },
    };
  }
  if (current.state !== "dispatched" && current.state !== "running") {
    return { kind: "return", value: { state: current.state } };
  }
  if (!assignmentId) throw corruptRunJournal("Active run has no assignment");
  if (!state.assignedById.has(assignmentId)) {
    throw corruptRunJournal("Active assignment is missing");
  }
  const fence = { fenceSeq: nextLsn, requestId: input.requestId };
  return {
    kind: "append",
    entries: [
      runRecord(conversationId, {
        t: "cancel-fence",
        assignmentId,
        ...fence,
      }),
      ...dataPlaneTicketRevocations(conversationId, state, assignmentId),
      runRecord(conversationId, {
        t: "state",
        runId: input.runId,
        assignmentId,
        state: "cancel-requested",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: { state: "cancel-requested", assignmentId, fence },
  };
}

function rejectedControl(
  code: import("@zhixing/core/contracts").AuthorityError["code"],
  message: string,
): Extract<ControlResult, { status: "rejected" }> {
  return {
    v: 1,
    status: "rejected",
    error: { code, message, retryable: false },
  };
}

function capabilityRevocations(
  conversationId: string,
  state: RunProjection,
  assigned: AssignedProjection,
): LogicalRecord<ConversationCommitLogRecord>[] {
  const capabilities = assigned.record.capIds
    .filter(
      (capId) =>
        !state.revokedCapabilities.has(
          `${assigned.record.assignmentId}\0${capId}`,
        ),
    )
    .map((capId) =>
      runRecord(conversationId, {
        t: "capability-revoked",
        capId,
        assignmentId: assigned.record.assignmentId,
      }),
    );
  const tickets = [
    ...(state.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? []),
  ]
    .filter((ticketId) => !state.revokedTickets.has(ticketId))
    .map((ticketId) =>
      runRecord(conversationId, {
        t: "ticket-revoked" as const,
        ticketId,
      }),
    );
  return [...capabilities, ...tickets];
}

function dataPlaneTicketRevocations(
  conversationId: string,
  state: Pick<RunProjection, "ticketIdsByAssignment" | "revokedTickets">,
  assignmentId: string,
): LogicalRecord<ConversationCommitLogRecord>[] {
  return [...(state.ticketIdsByAssignment.get(assignmentId) ?? [])]
    .filter((ticketId) => !state.revokedTickets.has(ticketId))
    .map((ticketId) =>
      runRecord(conversationId, {
        t: "ticket-revoked",
        ticketId,
      }),
    );
}

function validateTicketIssueRequest(input: DataPlaneTicketIssueRequest): void {
  assertIdentifier(input.ticketId, "Data-plane ticket id");
  assertIdentifier(input.assignmentId, "Data-plane ticket assignment id");
  assertIdentifier(
    input.surfacePrincipal,
    "Data-plane ticket surface principal",
  );
  assertDataPlaneTicketTtlMs(input.ttlMs);
  if (input.replacesTicketId !== undefined) {
    assertIdentifier(input.replacesTicketId, "Replaced data-plane ticket id");
    if (input.replacesTicketId === input.ticketId) {
      throw new TypeError("Ticket renewal requires a new ticket id");
    }
  }
}

function applyConversationTicketRecord(
  input: {
    readonly state: Pick<
      RunProjection,
      | "ticketsById"
      | "ticketIdsByAssignment"
      | "ticketReplacementsById"
      | "revokedTickets"
      | "ticketSyncFrontier"
    >;
    readonly record: Extract<
      ConversationRunJournalRecord,
      { t: "ticket-issued" | "ticket-revoked" }
    >;
    readonly verifier: ProtocolSignatureVerifier;
    readonly envelopeAt: string;
    readonly conversationId: string;
    readonly assigned?: Extract<
      ConversationRunJournalRecord,
      { t: "assigned" }
    >;
    readonly assignmentIsCurrent: boolean;
    readonly assignmentAcknowledged: boolean;
    readonly assignmentClosed: boolean;
    readonly assignmentActive: boolean;
    readonly originalSurfacePrincipal?: string;
    readonly hasAtomicReplacementRevocation?: boolean;
  },
): void {
  const { state, record } = input;
  if (record.t === "ticket-revoked") {
    assertIdentifier(record.ticketId, "Revoked data-plane ticket id");
    if (!state.ticketsById.has(record.ticketId)) {
      throw corruptRunJournal("Ticket revocation names an unknown ticket");
    }
    if (state.revokedTickets.has(record.ticketId)) {
      throw corruptRunJournal("Ticket is revoked more than once");
    }
    state.revokedTickets.add(record.ticketId);
    return;
  }

  const ticket = validateDataPlaneTicket(record.ticket, input.verifier);
  const assigned = input.assigned;
  const replaced =
    record.replacesTicketId === undefined
      ? undefined
      : state.ticketsById.get(record.replacesTicketId);
  if (
    !assigned ||
    !input.assignmentIsCurrent ||
    !input.assignmentAcknowledged ||
    input.assignmentClosed ||
    !input.assignmentActive ||
    state.ticketsById.has(ticket.ticketId) ||
    ticket.assignmentId !== assigned.assignmentId ||
    ticket.executorId !== assigned.executorId ||
    ticket.issuedAt !== input.envelopeAt ||
    ticket.ref.execution !== "conversation" ||
    ticket.ref.runId !== assigned.runId ||
    ticket.ref.conversationId !== input.conversationId ||
    ticket.ref.ownerEpoch !== assigned.ownerEpoch ||
    ticketPrecedesSyncFrontier(ticket, state.ticketSyncFrontier) ||
    (record.replacesTicketId !== undefined &&
      (!replaced ||
        !input.hasAtomicReplacementRevocation ||
        state.revokedTickets.has(record.replacesTicketId) ||
        !replaced.renewable ||
        ticket.kind === "abort" ||
        replaced.assignmentId !== ticket.assignmentId ||
        replaced.surfacePrincipal !== ticket.surfacePrincipal ||
        replaced.kind !== ticket.kind))
  ) {
    throw corruptRunJournal("Issued ticket does not bind an active acknowledged assignment");
  }
  if (
    ticket.kind !== "run-observe" &&
    ticket.surfacePrincipal !== input.originalSurfacePrincipal
  ) {
    throw corruptRunJournal("Interactive ticket does not bind the original surface");
  }
  state.ticketsById.set(ticket.ticketId, ticket);
  if (record.replacesTicketId !== undefined) {
    state.ticketReplacementsById.set(
      ticket.ticketId,
      record.replacesTicketId,
    );
  }
  const byAssignment =
    state.ticketIdsByAssignment.get(ticket.assignmentId) ?? new Set<string>();
  byAssignment.add(ticket.ticketId);
  state.ticketIdsByAssignment.set(ticket.assignmentId, byAssignment);
}

function applyConversationTicketSyncFrontier(
  state: Pick<RunProjection, "ticketsById" | "ticketSyncFrontier">,
  expiresThrough: string,
  envelopeAt: string,
): void {
  const expected = nextDataPlaneTicketSyncFrontier(
    state.ticketsById.values(),
    state.ticketSyncFrontier,
    envelopeAt,
  );
  if (expected !== expiresThrough) {
    throw corruptRunJournal("Ticket sync frontier is not the next durable boundary");
  }
  state.ticketSyncFrontier = expiresThrough;
}

function proofBindsConversationSource(
  state: Pick<
    RunProjection,
    | "supersedeRequests"
    | "cancelFences"
    | "ticketIdsByAssignment"
    | "ticketsById"
  >,
  assigned: Pick<AssignedProjection, "record">,
  proof: DurableSourceBoundProof,
  conversationId: string,
  legacy: ConversationAbortTicketAuthorizer | undefined,
): boolean {
  const assignmentId = assigned.record.assignmentId;
  const abortTicketProofBindsDurableSource =
    "cause" in proof && proof.cause === "abort-ticket"
      ? abortTicketProofBindsOwnerHistory({
          assignmentId,
          ticketIds:
            state.ticketIdsByAssignment.get(assignmentId) ?? new Set<string>(),
          ticketsById: state.ticketsById,
          proof,
          ...(legacy ? { legacy } : {}),
        })
      : false;
  return terminationProofBindsDurableSource({
    proof,
    assignmentId,
    executorId: assigned.record.executorId,
    conversationId,
    ownerEpoch: assigned.record.ownerEpoch,
    dispatchDigest: assigned.record.dispatchDigest,
    supersedeRequest: state.supersedeRequests.get(assignmentId),
    cancelFence: state.cancelFences.get(assignmentId),
    abortTicketProofBindsDurableSource,
  });
}

function conversationBundleAcknowledgementRecord(
  assignmentId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
): Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }> {
  return {
    t: "bundle-ack-observed",
    assignmentId,
    bundleRef: committed.bundle.ref,
    commitRevision: committed.commitRevision,
  };
}

function assertLedgerAcknowledgesCommittedConversationBundle(
  ledger: Pick<
    LedgerSnapshot,
    "sealedBundleRef" | "acknowledgedCommitRevision"
  >,
  expected: Extract<
    ConversationRunJournalRecord,
    { t: "bundle-ack-observed" }
  >,
): void {
  if (!bundleAcknowledgementBindsCommitted({
    observedBundleRef: ledger.sealedBundleRef,
    observedCommitRevision: ledger.acknowledgedCommitRevision,
    expectedBundleRef: expected.bundleRef,
    expectedCommitRevision: expected.commitRevision,
  })) {
    throw new Error(
      "Bundle acknowledgement does not bind the committed conversation revision",
    );
  }
}

function createOpenResolutionFact(
  assigned: AssignedProjection,
  cause: ConversationUncertainResolutionFact["cause"],
  openedAt: string,
): ConversationUncertainResolutionFact {
  const subject = {
    execution: "conversation" as const,
    runId: assigned.record.runId,
    conversationId: assigned.envelope.work.conversationId,
    ownerEpoch: assigned.envelope.work.ownerEpoch,
    assignmentId: assigned.record.assignmentId,
  };
  const openFactDigest = protocolDigest("UncertainOpenFact", 1, {
    subject,
    openedAt,
    cause,
  });
  return { subject, openedAt, cause, openFactDigest };
}

function closeResolution(
  fact: ConversationUncertainResolutionFact,
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
  by: string,
  at: string,
): ConversationUncertainResolutionFact {
  return snapshot(
    {
      ...fact,
      resolution: {
        kind,
        by,
        at,
        factDigest: resolutionFactDigest(fact.openFactDigest, kind, by, at),
      },
    },
    "Uncertain resolution fact",
  );
}

function dispatchConflictKey(proof: DispatchConflictProof): string {
  return `${proof.assignmentId}\0${proof.conflictingActivationDigest}`;
}

function rejectedNotStartedKey(
  assignmentId: string,
  kind: AssignmentTerminationProofKind,
): string {
  return `${assignmentId}\0${kind}`;
}

function hasRejectedNotStarted(
  state: RunProjection,
  assignmentId: string,
  kind: AssignmentTerminationProofKind,
): boolean {
  return state.rejectedNotStarted.has(rejectedNotStartedKey(assignmentId, kind));
}

function hasDurableStartedObservation(
  state: RunProjection,
  assignmentId: string,
): boolean {
  const assigned = state.assignedById.get(assignmentId);
  const currentState =
    assigned && state.assignmentByRun.get(assigned.record.runId) === assignmentId
      ? state.stateByRun.get(assigned.record.runId)?.state
      : undefined;
  return (
    currentState === "running" ||
    state.cancelOrigins.get(assignmentId) === "running" ||
    state.uncertainOrigins.get(assignmentId) === "running" ||
    state.supersedeStartedObservations.has(assignmentId)
  );
}

function sameTerminationProof(
  left: DurableSourceBoundProof,
  right: DurableSourceBoundProof,
): boolean {
  return canonicalize(withoutSignature(left)) === canonicalize(withoutSignature(right));
}

function prepareRunQueuedTerminal(
  coordinator: AssignmentResourceCoordinator | undefined,
  state: RunProjection,
  runId: string,
  reason: "cancelled" | "failed" | "expired",
): readonly LogicalRecord<GovernorRecord>[] {
  return coordinator?.prepareQueuedTerminal({
    workload: { kind: "run", id: runId, attempt: nextConversationAssignmentAttempt(state, runId) },
    reason,
  }) ?? [queuedTerminalDequeueRecord({
    kind: "run",
    id: runId,
    attempt: nextConversationAssignmentAttempt(state, runId),
  }, reason)];
}

function nextConversationAssignmentAttempt(
  state: {
    readonly assignedById: ReadonlyMap<
      string,
      { readonly record: { readonly runId: string; readonly reservation: { readonly attempt: number } } }
    >;
  },
  runId: string,
): number {
  let latest = 0;
  for (const assigned of state.assignedById.values()) {
    if (assigned.record.runId === runId) {
      latest = Math.max(latest, assigned.record.reservation.attempt);
    }
  }
  if (latest >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Conversation assignment attempt is exhausted");
  }
  return latest + 1;
}

function runRecord(
  conversationId: string,
  body: ConversationRunJournalRecord | ConversationRunInternalRecord,
): LogicalRecord<ConversationCommitLogRecord> {
  return { stream: runStream(conversationId), body };
}

function runStream(conversationId: string): string {
  return `run:${conversationId}`;
}

function worksceneTurnActivityEntries(
  conversationId: string,
  sessionRevision: number,
  assignmentId: string,
  at: string,
  operation: "create" | "touch",
): LogicalRecord<unknown>[] {
  const scope = parseConversationId(conversationId).scope;
  if (scope.kind !== "workscene") return [];
  return worksceneSessionMetaEntries(conversationId, {
    t: "session-meta",
    operation,
    domainRevision: sessionRevision,
    requestId: `session-activity:${assignmentId}`,
    sceneId: scope.sceneId,
    lastActiveAt: at,
  });
}

function worksceneSessionMetaEntries(
  conversationId: string,
  meta: Extract<ConversationRunJournalRecord, { t: "session-meta" }>,
): LogicalRecord<unknown>[] {
  const operation = meta.operation === "delete" ? "delete" : "upsert";
  return [
    runRecord(conversationId, meta),
    {
      stream: `session-activity:${conversationId}`,
      body: {
        kind: "session-activity",
        operation,
        conversationId,
        sceneId: meta.sceneId,
        sessionRevision: meta.domainRevision,
        lastActiveAt: meta.lastActiveAt,
      } satisfies Extract<
        SessionInternalRecord,
        { kind: "session-activity" }
      >,
    },
  ];
}

function envelopeContainsSessionActivity(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  meta: Extract<ConversationRunJournalRecord, { t: "session-meta" }>,
): boolean {
  const expected = {
    kind: "session-activity",
    operation: meta.operation === "delete" ? "delete" : "upsert",
    conversationId,
    sceneId: meta.sceneId,
    sessionRevision: meta.domainRevision,
    lastActiveAt: meta.lastActiveAt,
  };
  return envelope.entries.some(
    (entry) =>
      entry.stream === `session-activity:${conversationId}` &&
      canonicalize(entry.body) === canonicalize(expected),
  );
}

function assertWorksceneIdentity(
  conversationId: string,
  sceneId: string,
): void {
  const scope = parseConversationId(conversationId).scope;
  if (scope.kind !== "workscene" || scope.sceneId !== sceneId) {
    throw new TypeError(
      "Workscene session metadata does not match its conversation identity",
    );
  }
}

function assertCanonicalActivityTime(value: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError("Session activity time is invalid");
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function conversationStatusDeliveryInputs(
  conversationId: string,
  state: RunProjection,
  entries: readonly LogicalRecord<unknown>[],
  at: string,
): ConversationStatusDeliveryInput[] {
  const admittedInEnvelope = new Map<string, IngressContext>();
  for (const entry of entries) {
    if (entry.stream !== runStream(conversationId)) continue;
    const body = entry.body as Partial<ConversationRunJournalRecord>;
    if ("t" in body && body.t === "admitted" && "runId" in body && "ingress" in body) {
      admittedInEnvelope.set(body.runId as string, body.ingress as IngressContext);
    }
  }
  const result: ConversationStatusDeliveryInput[] = [];
  for (const entry of entries) {
    if (entry.stream !== runStream(conversationId)) continue;
    const body = entry.body as Partial<ConversationRunJournalRecord>;
    if (
      !("t" in body) ||
      body.t !== "state" ||
      !("runId" in body) ||
      !("state" in body) ||
      !("statusRevision" in body)
    ) {
      continue;
    }
    const runId = body.runId as string;
    const ingress =
      admittedInEnvelope.get(runId) ?? state.admittedByRun.get(runId)?.record.ingress;
    if (!ingress) throw corruptRunJournal("Run state has no durable ingress for status delivery");
    result.push({
      at,
      conversationId,
      runId,
      state: body.state as ConversationRunState,
      statusRevision: body.statusRevision as number,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ingress,
    });
  }
  return result;
}

/**
 * 空批次 cancel-batch 的唯一回执 item:非空批次的用户反馈由逐 run 权威
 * cancelled 投递单源承担;仅当批量决定命中零候选且请求携带渠道回执绑定时,
 * 同一权威决定产出一条以 canonical requestId 幂等的回执。
 */
function conversationControlResponseDeliveryInputs(
  conversationId: string,
  envelope: ConversationControlEnvelope,
  plan: { readonly result: ControlResult },
  canonicalRequestId: string,
  at: string,
): ConversationControlResponseInput[] {
  const body = envelope.body;
  if (body.t !== "cancel-batch" || body.response === undefined) return [];
  if (
    plan.result.status !== "ok" ||
    plan.result.body.t !== "cancel-batch" ||
    plan.result.body.runs.length > 0
  ) {
    return [];
  }
  return [
    {
      at,
      conversationId,
      requestId: canonicalRequestId,
      replyTarget: body.response.replyTarget,
      response: "empty-cancel-batch",
    },
  ];
}

// 权威记录注册表随公开 conversation 模块再导出:执行点行为矩阵按它做
// 类型级闭合,新增记录类型缺行即编译失败。
export {
  CONVERSATION_RUN_RECORD_SHAPES,
  CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
  type ConversationRunRecordType,
} from "./conversation-run-contracts.js";

function envelopeHasRunRecord(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  predicate: (
    body: Exclude<ConversationRunJournalRecord, SessionInternalRecord>,
  ) => boolean,
): boolean {
  return envelope.entries.some((entry) => {
    if (entry.stream !== runStream(conversationId)) return false;
    const body = entry.body as ConversationRunJournalRecord;
    return (
      typeof body === "object" &&
      body !== null &&
      "t" in body &&
      predicate(
        body as Exclude<ConversationRunJournalRecord, SessionInternalRecord>,
      )
    );
  });
}

function conversationResolutionFactsInEnvelope(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  runId: string,
): ConversationUncertainResolutionFact[] {
  return envelope.entries.flatMap((entry) => {
    if (entry.stream !== runStream(conversationId)) return [];
    const body = entry.body as ConversationRunJournalRecord;
    return "t" in body && body.t === "resolution" && body.runId === runId
      ? [body.fact as ConversationUncertainResolutionFact]
      : [];
  });
}

function requireConversationResolutionKind(
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
): Exclude<
  NonNullable<UncertainResolutionFact["resolution"]>["kind"],
  "proven-not-started-cancelled"
> {
  if (kind === "proven-not-started-cancelled") {
    throw corruptRunJournal("Conversation uncertainty uses a job-only closure kind");
  }
  return kind;
}

function conversationStatusNotice(
  conversationId: string,
  ownerEpoch: number,
  runId: string,
  entry: StatusHistoryEntry,
): ConversationStatusNotice | undefined {
  const ref = {
    execution: "conversation" as const,
    conversationId,
    runId,
    ownerEpoch,
  };
  if (entry.uncertainTransition === "opened") {
    if (entry.state !== "uncertain") {
      throw corruptRunJournal("Uncertain opening notice has a non-uncertain state");
    }
    return {
      v: 1,
      ref,
      state: "uncertain",
      statusRevision: entry.statusRevision,
      actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
    };
  }
  if (entry.uncertainTransition === "closed") {
    if (entry.resultingState !== entry.state) {
      throw corruptRunJournal("Uncertain closure notice has a mismatched successor state");
    }
    return {
      v: 1,
      ref,
      state: "uncertain-closed",
      statusRevision: entry.statusRevision,
      actions: [],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
      closedBy: entry.closedBy,
      resultingState: entry.resultingState,
    } as ConversationStatusNotice;
  }
  if (entry.state === "committed") return undefined;
  if (entry.state === "uncertain") {
    throw corruptRunJournal("Uncertain state has no durable open fact identity");
  }
  return {
    v: 1,
    ref,
    state: entry.state,
    statusRevision: entry.statusRevision,
    actions: [],
    at: entry.at,
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}

function conversationStatusNoticesForCommit(
  state: RunProjection,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  conversationId: string,
  ownerEpoch: number,
): ConversationStatusNotice[] {
  const notices: ConversationStatusNotice[] = [];
  for (const record of envelope.entries) {
    if (record.stream !== runStream(conversationId)) continue;
    const candidate = record.body as ConversationRunJournalRecord;
    if (!("t" in candidate) || candidate.t !== "state") continue;
    const body = candidate;
    const entry = state.statusHistoryByRun
      .get(body.runId)
      ?.find((candidate) => candidate.statusRevision === body.statusRevision);
    if (!entry) throw corruptRunJournal("Committed run status has no history projection");
    const notice = conversationStatusNotice(
      conversationId,
      ownerEpoch,
      body.runId,
      entry,
    );
    if (notice) notices.push(notice);
  }
  return notices;
}

function envelopeHasRunState(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  runId: string,
  state: ConversationRunState,
  statusRevision: number,
  assignmentId: string | undefined,
): boolean {
  return envelopeHasRunRecord(
    envelope,
    conversationId,
    (body) =>
      body.t === "state" &&
      body.runId === runId &&
      body.assignmentId === assignmentId &&
      body.state === state &&
      body.statusRevision === statusRevision,
  );
}

function envelopeClosesAssignment(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  runId: string,
  assignmentId: string,
): boolean {
  return envelopeHasRunRecord(
    envelope,
    conversationId,
    (body) =>
      (body.t === "assignment-superseded" &&
        body.assignmentId === assignmentId) ||
      (body.t === "resolution" &&
        body.runId === runId &&
        body.fact.subject.assignmentId === assignmentId &&
        body.fact.resolution !== undefined),
  );
}

function envelopeHasResolution(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  runId: string,
  openFactDigest: string,
  resolved: boolean,
): boolean {
  return envelopeHasRunRecord(
    envelope,
    conversationId,
    (body) =>
      body.t === "resolution" &&
      body.runId === runId &&
      body.fact.openFactDigest === openFactDigest &&
      (body.fact.resolution !== undefined) === resolved,
  );
}

function envelopeRevokesRemainingCapabilities(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  state: RunProjection,
  assigned: AssignedProjection,
): boolean {
  return envelopeRevokesCapabilities(
    envelope,
    conversationId,
    state.revokedCapabilities,
    assigned.record.assignmentId,
    assigned.record.capIds,
    state.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? [],
    state.revokedTickets,
  );
}

function envelopeRevokesCapabilities(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  revokedCapabilities: ReadonlySet<string>,
  assignmentId: string,
  capIds: Iterable<string>,
  ticketIds: Iterable<string> = [],
  revokedTickets: ReadonlySet<string> = new Set(),
): boolean {
  const capabilitiesRevoked = [...capIds].every((capId) => {
    const key = `${assignmentId}\0${capId}`;
    return (
      revokedCapabilities.has(key) ||
      envelopeHasRunRecord(
        envelope,
        conversationId,
        (body) =>
          body.t === "capability-revoked" &&
          body.assignmentId === assignmentId &&
          body.capId === capId,
      )
    );
  });
  return (
    capabilitiesRevoked &&
    [...ticketIds].every(
      (ticketId) =>
        revokedTickets.has(ticketId) ||
        envelopeHasRunRecord(
          envelope,
          conversationId,
          (body) =>
            body.t === "ticket-revoked" && body.ticketId === ticketId,
        ),
    )
  );
}

function envelopeHasSuccessfulUncertainControl(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  state: ConversationRunState,
  factDigest: string,
): boolean {
  return envelope.entries.some((entry) => {
    if (
      entry.stream !== "control" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const applied = entry.body as {
      readonly t?: unknown;
      readonly authorityRevision?: unknown;
      readonly result?: unknown;
    };
    if (
      applied.t !== "applied" ||
      applied.authorityRevision !== envelope.lsn ||
      typeof applied.result !== "object" ||
      applied.result === null
    ) {
      return false;
    }
    const result = applied.result as {
      readonly v?: unknown;
      readonly status?: unknown;
      readonly body?: unknown;
    };
    if (
      result.v !== 1 ||
      result.status !== "ok" ||
      typeof result.body !== "object" ||
      result.body === null
    ) {
      return false;
    }
    const body = result.body as {
      readonly t?: unknown;
      readonly state?: unknown;
      readonly factDigest?: unknown;
    };
    return (
      body.t === "uncertain-resolve" &&
      body.state === state &&
      body.factDigest === factDigest
    );
  });
}

// Cancel/supersede/rejection proof binding is single-sourced in
// conversation-run-contracts.ts (terminationProofBindsDurableSource); abort-ticket
// ownership itself is checked before the owner appends the authority fact, so replay
// only re-checks the signed executor/assignment/epoch binding carried by the proof.

interface ValidatedConversationBundleClosure {
  readonly artifact: ReturnType<typeof sealedBundleArtifact>;
  readonly batch?: MutationBatch;
  readonly runRecord: TranscriptRunRecord;
  readonly references: ArtifactRef[];
}

class BundleClosureError extends Error {
  constructor(
    readonly code: "invalid" | "missing-base",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BundleClosureError";
  }
}

async function validateConversationBundleClosure(
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  artifacts: ArtifactStore,
): Promise<ValidatedConversationBundleClosure> {
  const artifact = sealedBundleArtifact(bundle);
  if (!(await artifacts.has(artifact.ref))) {
    throw new BundleClosureError("missing-base", "Sealed bundle artifact is not present");
  }
  let closure: Awaited<ReturnType<typeof resolveSealedBundleArtifactClosure>>;
  try {
    closure = await resolveSealedBundleArtifactClosure(bundle, artifacts);
  } catch (error) {
    throw bundleClosureReadError(error, "Invalid sealed bundle closure");
  }

  const references = [artifact.ref, ...closure.transfer];

  let runRecord: TranscriptRunRecord;
  if (isStoredReference(bundle.body.runRecord)) {
    try {
      const bytes = await artifacts.get(bundle.body.runRecord.ref);
      const text = Buffer.from(bytes).toString("utf8");
      runRecord = validateTranscriptRunRecord(
        JSON.parse(text) as import("@zhixing/core/contracts").TranscriptRunRecord,
        bundle.body.runId,
      );
      if (canonicalize(runRecord) !== text) {
        throw new TypeError("Transcript run record artifact is not canonical");
      }
    } catch (error) {
      throw bundleClosureReadError(error, "Invalid transcript run record");
    }
  } else {
    runRecord = validateTranscriptRunRecord(bundle.body.runRecord, bundle.body.runId);
  }

  let batch: MutationBatch | undefined;
  if (bundle.body.mutationBatch) {
    try {
      const bytes = await artifacts.get(bundle.body.mutationBatch.ref);
      const text = Buffer.from(bytes).toString("utf8");
      batch = validateMutationBatch(JSON.parse(text) as MutationBatch);
      if (canonicalize(batch) !== text) {
        throw new TypeError("Mutation batch artifact is not canonical");
      }
    } catch (error) {
      throw bundleClosureReadError(error, "Invalid mutation batch");
    }
    const sessionCount = batch.records.filter((record) => record.domain === "session").length;
    const globalCount = batch.count - sessionCount;
    if (
      batch.assignmentId !== bundle.assignmentId ||
      sessionCount !== bundle.body.mutationBatch.sessionCount ||
      globalCount !== bundle.body.mutationBatch.globalCount
    ) {
      throw new BundleClosureError(
        "invalid",
        "Mutation batch summary does not bind the bundle",
      );
    }
  }

  return { artifact, ...(batch ? { batch } : {}), runRecord, references };
}

function bundleClosureReadError(error: unknown, message: string): BundleClosureError {
  return error instanceof AuthorityStorageError && error.code === "artifact-missing"
    ? new BundleClosureError("missing-base", `${message}: artifact is not present`, {
        cause: error,
      })
    : new BundleClosureError(
        "invalid",
        error instanceof Error ? `${message}: ${error.message}` : message,
        { cause: error },
      );
}

function envelopeContainsCommit(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
): boolean {
  return envelope.entries.some(
    (entry) =>
      entry.stream === runStream(conversationId) &&
      "t" in entry.body &&
      entry.body.t === "committed" &&
      entry.body.assignmentId === committed.assignmentId &&
      entry.body.runId === committed.runId &&
      entry.body.commitRevision === committed.commitRevision &&
      canonicalize(entry.body.bundle) === canonicalize(committed.bundle),
  );
}

function mutationNeedsExternalPublish(
  record: MutationBatch["records"][number],
): boolean {
  return record.domain === "session" || record.mutation.kind !== "delivery-enqueue";
}

function publishDecisionRequired(
  records: MutationBatch["records"],
  _outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"],
): boolean {
  return records.length > 0;
}

function domainPublishDecisionRequired(
  records: MutationBatch["records"],
  outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"],
  domain: "session" | "global",
): boolean {
  return records.some(
    (record, index) =>
      record.domain === domain &&
      (mutationNeedsExternalPublish(record) ||
        outcomes[index]?.outcome.t === "conflicted"),
  );
}

interface CompiledConversationDeliveryContents {
  readonly final?: CompiledDeliveryContent;
  readonly stagedContents: ReadonlyMap<
    number,
    import("@zhixing/core/contracts").DeliveryIntentDto["content"]
  >;
  readonly stagedContentErrors: ReadonlyMap<number, AuthorityError>;
  readonly references: readonly ArtifactRef[];
}

async function compileConversationDeliveryContents(
  runRecord: TranscriptRunRecord,
  batch: MutationBatch | undefined,
  artifacts: ArtifactStore,
  ingress: IngressContext,
): Promise<CompiledConversationDeliveryContents> {
  const final =
    ingress.kind === "channel"
      ? await compileDeliveryContent(transcriptFinalAssistantText(runRecord), artifacts)
      : undefined;
  const stagedContents = new Map<
    number,
    import("@zhixing/core/contracts").DeliveryIntentDto["content"]
  >();
  const stagedContentErrors = new Map<number, AuthorityError>();
  const references: ArtifactRef[] = [...(final?.references ?? [])];
  for (const record of batch?.records ?? []) {
    if (record.mutation.kind !== "delivery-enqueue") continue;
    if (
      record.mutation.request.target.kind === "turn-origin" &&
      ingress.kind !== "channel"
    ) {
      continue;
    }
    try {
      const compiled = await compileDeliveryContent(
        record.mutation.request.content,
        artifacts,
      );
      stagedContents.set(record.seq, compiled.content);
      references.push(...compiled.references);
    } catch (error) {
      if (!(error instanceof DeliveryContentValidationError)) throw error;
      stagedContentErrors.set(record.seq, {
        code: "invalid",
        message: "Delivery content is invalid or unavailable",
        retryable: false,
      });
    }
  }
  return {
    final,
    stagedContents,
    stagedContentErrors,
    references,
  };
}

function transcriptFinalAssistantText(record: TranscriptRunRecord): string {
  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const message = record.messages[index]!;
    if (message.role !== "assistant") continue;
    return message.content
      .filter(
        (block): block is Extract<
          (typeof message.content)[number],
          { type: "text" }
        > => block.type === "text",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function envelopeHasConversationCommitSidecars(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  batch?: MutationBatch,
): boolean {
  const hasContentIndex = envelope.entries.some((entry) => {
    if (
      entry.stream !== runStream(conversationId) ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as { readonly kind?: unknown; readonly entries?: unknown };
    return (
      body.kind === "content-asset-index" &&
      canonicalize(body.entries) === canonicalize(bundle.body.contentAssets)
    );
  });
  const hasFinal = envelope.entries.some((entry) => {
    if (
      entry.stream !== "final-outbox" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as Partial<FinalOutboxRecord>;
    return (
      body.t === "final" &&
      body.conversationId === conversationId &&
      body.runId === committed.runId &&
      body.commitRevision === committed.commitRevision &&
      body.digest === bundle.digest &&
      body.state === "pending"
    );
  });
  if (!hasContentIndex || !hasFinal) return false;

  const mutationBatch = bundle.body.mutationBatch;
  if (!mutationBatch) return true;
  if (!batch) return true;
  const decision = envelope.entries.find((entry) => {
    if (
      entry.stream !== "publish" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as Partial<
      Extract<PublishRecord, { t: "publish-decision" }>
    >;
    return (
      body.t === "publish-decision" &&
      body.assignmentId === committed.assignmentId &&
      canonicalize(body.batch) === canonicalize({ ref: mutationBatch.ref }) &&
      body.sessionCount === mutationBatch.sessionCount &&
      body.globalCount === mutationBatch.globalCount
    );
  })?.body as Extract<PublishRecord, { t: "publish-decision" }> | undefined;
  const needsDecision = batch.records.length > 0;
  if (!needsDecision) return decision === undefined;
  if (!decision) return false;
  return (["session", "global"] as const).every((domain) => {
    if (!domainPublishDecisionRequired(batch.records, decision.outcomes, domain)) {
      return true;
    }
    return envelope.entries.some((entry) => {
      if (
        entry.stream !== "publish" ||
        typeof entry.body !== "object" ||
        entry.body === null
      ) {
        return false;
      }
      const body = entry.body as Partial<
        Extract<PublishRecord, { t: "publish-progress" }>
      >;
      return (
        body.t === "publish-progress" &&
        body.assignmentId === committed.assignmentId &&
        body.domain === domain &&
        body.upToSeq === 0 &&
        body.state === "pending"
      );
    });
  });
}

function submissionCommitSidecars(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  conversationId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
): SubmissionCommitSidecars {
  const contentRecords = envelope.entries.filter((entry) => {
    if (
      entry.stream !== runStream(conversationId) ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    return (entry.body as { readonly kind?: unknown }).kind === "content-asset-index";
  });
  if (contentRecords.length !== 1) {
    throw corruptRunJournal("Submission guard commit has no unique content sidecar");
  }
  const content = contentRecords[0]!.body as unknown;
  assertConversationRunInternalRecord(content);
  if (content.kind !== "content-asset-index") {
    throw corruptRunJournal("Submission guard commit has an invalid content sidecar");
  }

  const finalRecords = envelope.entries.filter((entry) => {
    if (
      entry.stream !== "final-outbox" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as Partial<FinalOutboxRecord>;
    return (
      body.t === "final" &&
      body.conversationId === conversationId &&
      body.runId === committed.runId &&
      body.commitRevision === committed.commitRevision
    );
  });
  if (finalRecords.length !== 1) {
    throw corruptRunJournal("Submission guard commit has no unique final sidecar");
  }
  const final = finalRecords[0]!.body as unknown;
  assertPlainRecord(final, "Submission guard final sidecar");
  assertExactRecordKeys(
    final,
    ["commitRevision", "conversationId", "digest", "runId", "state", "t"],
    "Submission guard final sidecar",
  );
  assertDigest(final.digest, "Submission guard final digest");
  if (final.state !== "pending") {
    throw corruptRunJournal("Submission guard final sidecar is not pending");
  }

  const publishRecords = envelope.entries.filter((entry) => {
    if (
      entry.stream !== "publish" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as { readonly assignmentId?: unknown; readonly t?: unknown };
    return body.assignmentId === committed.assignmentId;
  });
  const decisionRecords = publishRecords.filter(
    (entry) => (entry.body as { readonly t?: unknown }).t === "publish-decision",
  );
  const progressRecords = publishRecords.filter(
    (entry) => (entry.body as { readonly t?: unknown }).t === "publish-progress",
  );
  if (
    decisionRecords.length + progressRecords.length !== publishRecords.length ||
    decisionRecords.length > 1
  ) {
    throw corruptRunJournal("Submission guard commit has duplicate publish decisions");
  }
  let publish: SubmissionCommitSidecars["publish"];
  if (decisionRecords.length === 1) {
    const decision = decisionRecords[0]!.body as unknown;
    assertPlainRecord(decision, "Submission guard publish decision");
    assertExactRecordKeys(
      decision,
      ["assignmentId", "batch", "globalCount", "outcomes", "sessionCount", "t"],
      "Submission guard publish decision",
    );
    assertPlainRecord(decision.batch, "Submission guard publish batch");
    assertExactRecordKeys(decision.batch, ["ref"], "Submission guard publish batch");
    assertArtifactReference(decision.batch.ref, "Submission guard publish batch ref");
    assertNonNegativeSafeInteger(
      decision.sessionCount as number,
      "Submission guard session mutation count",
    );
    assertNonNegativeSafeInteger(
      decision.globalCount as number,
      "Submission guard global mutation count",
    );
    if (!Array.isArray(decision.outcomes)) {
      throw corruptRunJournal("Submission guard publish outcomes must be an array");
    }
    const pendingDomains = new Set<"session" | "global">();
    for (const record of progressRecords) {
      const progress = record.body as unknown;
      assertPlainRecord(progress, "Submission guard publish progress");
      assertExactRecordKeys(
        progress,
        ["assignmentId", "domain", "state", "t", "upToSeq"],
        "Submission guard publish progress",
      );
      if (
        (progress.domain !== "session" && progress.domain !== "global") ||
        progress.state !== "pending" ||
        progress.upToSeq !== 0 ||
        pendingDomains.has(progress.domain)
      ) {
        throw corruptRunJournal("Submission guard publish progress is invalid");
      }
      pendingDomains.add(progress.domain);
    }
    publish = {
      batch: { ref: decision.batch.ref as ArtifactRef },
      sessionCount: decision.sessionCount as number,
      globalCount: decision.globalCount as number,
      pendingDomains,
    };
  } else if (progressRecords.length > 0) {
    throw corruptRunJournal("Submission guard publish progress has no decision");
  }
  return {
    contentAssetsDigest: byteDigest(
      Buffer.from(canonicalize(content.entries), "utf8"),
    ),
    finalDigest: final.digest as string,
    ...(publish ? { publish } : {}),
  };
}

function submissionCommitSidecarsMatch(
  sidecars: SubmissionCommitSidecars,
  bundle: ReturnType<typeof validateConversationSealedBundle>,
): boolean {
  if (
    sidecars.contentAssetsDigest !==
      byteDigest(Buffer.from(canonicalize(bundle.body.contentAssets), "utf8")) ||
    sidecars.finalDigest !== bundle.digest
  ) {
    return false;
  }
  const mutationBatch = bundle.body.mutationBatch;
  if (!mutationBatch) return sidecars.publish === undefined;
  const publish = sidecars.publish;
  if (
    !publish ||
    canonicalize(publish.batch) !== canonicalize({ ref: mutationBatch.ref }) ||
    publish.sessionCount !== mutationBatch.sessionCount ||
    publish.globalCount !== mutationBatch.globalCount
  ) {
    return false;
  }
  const expectedDomains = new Set<"session" | "global">();
  if (mutationBatch.sessionCount > 0) expectedDomains.add("session");
  if (mutationBatch.globalCount > 0) expectedDomains.add("global");
  return (
    publish.pendingDomains.size === expectedDomains.size &&
    [...expectedDomains].every((domain) => publish.pendingDomains.has(domain))
  );
}

interface CommittedBundleBinding {
  readonly committed: Extract<ConversationRunJournalRecord, { t: "committed" }>;
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly closure: ValidatedConversationBundleClosure;
}

async function loadCommittedBundleBinding(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  artifacts: ArtifactStore,
  matches: (
    committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
  ) => boolean,
): Promise<CommittedBundleBinding> {
  const candidates = envelope.entries
    .filter(
      (entry) =>
        entry.stream.startsWith("run:") &&
        typeof entry.body === "object" &&
        entry.body !== null &&
        "t" in entry.body &&
        entry.body.t === "committed",
    )
    .map((entry) => ({
      stream: entry.stream,
      committed: snapshot(
        entry.body as Extract<ConversationRunJournalRecord, { t: "committed" }>,
        "Committed run sidecar binding",
      ),
    }))
    .filter((candidate) => matches(candidate.committed));
  if (candidates.length !== 1) {
    throw corruptRunJournal("Commit sidecar must bind exactly one committed run");
  }
  const { committed, stream } = candidates[0]!;
  assertExactRecordKeys(
    committed,
    ["assignmentId", "bundle", "commitRevision", "runId", "t"],
    "Committed run sidecar binding",
  );
  assertIdentifier(committed.assignmentId, "Committed assignment id");
  assertIdentifier(committed.runId, "Committed run id");
  assertPositiveSafeInteger(committed.commitRevision, "Committed revision");
  assertExactRecordKeys(committed.bundle, ["ref"], "Committed bundle reference");
  assertArtifactReference(committed.bundle.ref, "Committed bundle reference");
  const bytes = await artifacts.get(committed.bundle.ref);
  const bundle = validateConversationSealedBundle(
    JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
  );
  const closure = await validateConversationBundleClosure(bundle, artifacts);
  if (
    stream !== runStream(bundle.body.conversationId) ||
    bundle.assignmentId !== committed.assignmentId ||
    bundle.body.runId !== committed.runId ||
    bundle.body.baseRevision + 1 !== committed.commitRevision ||
    canonicalize(closure.artifact.ref) !== canonicalize(committed.bundle.ref)
  ) {
    throw corruptRunJournal("Committed run sidecar binding does not match its bundle");
  }
  return { committed, bundle, closure };
}

async function prepareStored<T>(
  value: T,
  artifacts: ArtifactStore,
): Promise<PreparedStored<T>> {
  const bytes = Buffer.from(canonicalize(value), "utf8");
  if (bytes.byteLength <= MAX_INLINE_LOGICAL_RECORD_BYTES / 2) {
    return { stored: value, references: [] };
  }
  const ref = await artifacts.put(bytes);
  return { stored: { ref }, references: [ref] };
}

async function loadStored<T>(stored: Stored<T>, artifacts: ArtifactStore): Promise<T> {
  if (isStoredReference(stored)) {
    return JSON.parse(Buffer.from(await artifacts.get(stored.ref)).toString("utf8")) as T;
  }
  return snapshot(stored, "Inline run journal value");
}

function isStoredReference<T>(value: Stored<T>): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

function assertAssignedMatchesDispatch(
  assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
  dispatch: PendingConversationDispatch["envelope"],
  ingress: IngressContext,
  conversationId: string,
): void {
  const artifact = dispatchEnvelopeArtifact(dispatch);
  if (
    assigned.runId !== dispatch.work.runId ||
    dispatch.work.conversationId !== conversationId ||
    assigned.assignmentId !== dispatch.assignmentId ||
    assigned.executorId !== dispatch.executorId ||
    assigned.ownerEpoch !== dispatch.work.ownerEpoch ||
    assigned.baseRevision !== dispatch.work.baseRevision ||
    assigned.dispatchDigest !== dispatchEnvelopeDigest(dispatch) ||
    assigned.manifestDigest !== dispatch.manifest.digest ||
    canonicalize(assigned.dispatchRef) !== canonicalize(artifact.ref) ||
    assigned.permissionLeaseDigest !== permissionSnapshotLeaseDigest(dispatch) ||
    assigned.capIds.join("\u0000") !==
      dispatch.capabilities.map((capability) => capability.capId).join("\u0000") ||
    assigned.reservation.reservationId !== dispatch.resourceLease.reservationId ||
    assigned.reservation.attempt !== dispatch.resourceLease.workload.attempt ||
    canonicalize(ingress) !== canonicalize(dispatch.work.ingress)
  ) {
    throw corruptRunJournal("Assigned record does not match its dispatch artifact");
  }
}

function assertCapabilityMatchesAssignedEnvelope(
  capability: import("@zhixing/core/contracts").AuthorityCapability,
  envelope: PendingConversationDispatch["envelope"],
): void {
  const assigned = envelope.capabilities.find(
    (candidate) => candidate.capId === capability.capId,
  );
  if (!assigned || canonicalize(assigned) !== canonicalize(capability)) {
    throw new TypeError(
      "Assignment capability does not match the durable dispatch capability",
    );
  }
}

function isActiveRunState(state: ConversationRunState): boolean {
  return (
    state === "dispatched" ||
    state === "running" ||
    state === "cancel-requested" ||
    state === "uncertain"
  );
}

function selectActiveAssignment<Value>(
  state: RunProjection,
  select: (assigned: AssignedProjection, current: ConversationRunState) => Value | undefined,
): Value | undefined {
  const runId = state.activeRunId;
  if (runId === undefined) return undefined;
  const current = state.stateByRun.get(runId)?.state;
  const assignmentId = state.assignmentByRun.get(runId);
  const assigned = assignmentId ? state.assignedById.get(assignmentId) : undefined;
  if (!current || !isActiveRunState(current) || !assigned) {
    throw corruptRunJournal("Active run index has no durable assignment state");
  }
  return select(assigned, current);
}

type QueuedRunIndex = Pick<
  RunProjection,
  | "queuedRunByPosition"
  | "queuedPositionHeap"
  | "queuedPositionHeapIndex"
>;

function addQueuedRun(state: QueuedRunIndex, position: number, runId: string): void {
  const existing = state.queuedRunByPosition.get(position);
  if (existing !== undefined || state.queuedPositionHeapIndex.has(position)) {
    throw corruptRunJournal("Queued position belongs to more than one run");
  }
  state.queuedRunByPosition.set(position, runId);
  const heap = state.queuedPositionHeap;
  const indexes = state.queuedPositionHeapIndex;
  let index = heap.length;
  heap.push(position);
  indexes.set(position, index);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! <= heap[index]!) break;
    swapQueuedHeap(heap, indexes, parent, index);
    index = parent;
  }
}

function removeQueuedRun(state: QueuedRunIndex, position: number, runId: string): void {
  if (state.queuedRunByPosition.get(position) !== runId) {
    throw corruptRunJournal("Queued run index does not match the durable state");
  }
  const index = state.queuedPositionHeapIndex.get(position);
  if (index === undefined) {
    throw corruptRunJournal("Queued run heap is missing its durable position");
  }
  state.queuedRunByPosition.delete(position);
  const heap = state.queuedPositionHeap;
  const indexes = state.queuedPositionHeapIndex;
  const last = heap.length - 1;
  if (index !== last) swapQueuedHeap(heap, indexes, index, last);
  heap.pop();
  indexes.delete(position);
  if (index >= heap.length) return;
  let cursor = index;
  const parent = Math.floor((cursor - 1) / 2);
  if (cursor > 0 && heap[cursor]! < heap[parent]!) {
    while (cursor > 0) {
      const nextParent = Math.floor((cursor - 1) / 2);
      if (heap[nextParent]! <= heap[cursor]!) break;
      swapQueuedHeap(heap, indexes, nextParent, cursor);
      cursor = nextParent;
    }
    return;
  }
  while (true) {
    const left = cursor * 2 + 1;
    const right = left + 1;
    let smallest = cursor;
    if (left < heap.length && heap[left]! < heap[smallest]!) smallest = left;
    if (right < heap.length && heap[right]! < heap[smallest]!) smallest = right;
    if (smallest === cursor) return;
    swapQueuedHeap(heap, indexes, cursor, smallest);
    cursor = smallest;
  }
}

function swapQueuedHeap(
  heap: number[],
  indexes: Map<number, number>,
  left: number,
  right: number,
): void {
  const leftValue = heap[left]!;
  const rightValue = heap[right]!;
  heap[left] = rightValue;
  heap[right] = leftValue;
  indexes.set(leftValue, right);
  indexes.set(rightValue, left);
}

function withoutSignature<T extends { signature: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return payload;
}

function canonicalTime(value: IsoTime, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

type GlobalPublishBatch = ReturnType<
  ConversationMutationPublisher["decideGlobalBatchAtPrefix"]
>;
type GlobalPublishOutcome = GlobalPublishBatch[number]["outcome"];

function validateGlobalPublishBatchOutcomes(
  records: readonly { readonly seq: number }[],
  value: GlobalPublishBatch,
): Map<number, GlobalPublishOutcome> {
  if (!Array.isArray(value) || value.length !== records.length) {
    throw new TypeError("Global publish batch must decide every mutation exactly once");
  }
  const outcomes = new Map<number, GlobalPublishOutcome>();
  for (let index = 0; index < value.length; index += 1) {
    const item = snapshot(value[index], "Global publish batch outcome");
    assertExactRecordKeys(item, ["outcome", "seq"], "Global publish batch outcome");
    if (item.seq !== records[index]?.seq || outcomes.has(item.seq as number)) {
      throw new TypeError("Global publish batch sequence is incomplete, reordered, or duplicated");
    }
    outcomes.set(
      item.seq as number,
      validateGlobalPublishOutcome(item.outcome as GlobalPublishOutcome),
    );
  }
  return outcomes;
}

function validateGlobalPublishOutcome(value: GlobalPublishOutcome): GlobalPublishOutcome {
  const outcome = snapshot(value, "Global publish outcome");
  assertPlainRecord(outcome, "Global publish outcome");
  if (outcome.t === "granted") {
    assertExactRecordKeys(outcome, ["t", "targetRevision"], "Granted publish outcome");
    assertPositiveSafeInteger(outcome.targetRevision as number, "Granted target revision");
    return outcome as GlobalPublishOutcome;
  }
  if (outcome.t === "conflicted") {
    assertExactRecordKeys(outcome, ["error", "t"], "Conflicted publish outcome");
    validateAuthorityErrorContract(outcome.error);
    return outcome as GlobalPublishOutcome;
  }
  throw new TypeError("Global publish outcome kind is invalid");
}

function rejected(
  code: import("@zhixing/core/contracts").AuthorityError["code"],
  message: string,
  retryable: boolean,
): {
  readonly committed: false;
  readonly error: import("@zhixing/core/contracts").AuthorityError;
} {
  return { committed: false, error: { code, message, retryable } };
}

function emptyPublishProjection(): PublishProjection {
  return {
    decisions: new Map(),
    batches: new Map(),
    commitRevisions: new Map(),
    progress: new Map(),
    domainPlans: new Map(),
    conversationByAssignment: new Map(),
    pendingAssignmentsByConversation: new Map(),
    completedAssignments: new Set(),
    conflictsByAssignment: new Map(),
  };
}

function emptyFinalProjection(): FinalOutboxProjection {
  return {
    entries: new Map(),
    activeKeyByConversationRevision: new Map(),
    pendingByConversation: new Map(),
    publishedByConversation: new Map(),
    lastPendingRevisionByConversation: new Map(),
  };
}

async function reducePublishRecord(
  state: PublishProjection,
  record: LogicalRecord<PublishRecord>,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  artifacts: ArtifactStore,
): Promise<PublishProjection> {
  if (record.body.t === "publish-decision") {
    const binding = await loadCommittedBundleBinding(
      envelope,
      artifacts,
      (body) => body.assignmentId === record.body.assignmentId,
    );
    const summary = binding.bundle.body.mutationBatch;
    if (
      !summary ||
      canonicalize(summary.ref) !== canonicalize(record.body.batch.ref) ||
      summary.sessionCount !== record.body.sessionCount ||
      summary.globalCount !== record.body.globalCount ||
      !binding.closure.batch
    ) {
      throw corruptRunJournal("Publish decision does not bind its committed mutation batch");
    }
    state.conversationByAssignment.set(
      record.body.assignmentId,
      binding.bundle.body.conversationId,
    );
    state.batches.set(record.body.assignmentId, binding.closure.batch);
    state.commitRevisions.set(record.body.assignmentId, binding.committed.commitRevision);
  }
  reducePublishBody(state, record.body, envelope);
  return state;
}

function reducePublishBody(
  state: PublishProjection,
  raw: PublishRecord,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
): void {
  const body = snapshot(raw, "Publish record");
  assertPlainRecord(body, "Publish record");
  if (body.t === "publish-decision") {
    try {
      validatePublishDecisionRecord(body);
    } catch {
      throw corruptRunJournal("Publish decision structure is invalid");
    }
    if (
      state.decisions.has(body.assignmentId) ||
      state.completedAssignments.has(body.assignmentId)
    ) {
      throw corruptRunJournal("Publish decision is duplicated");
    }
    const batch = state.batches.get(body.assignmentId);
    if (!batch || batch.assignmentId !== body.assignmentId) {
      throw corruptRunJournal("Publish decision has no validated mutation batch");
    }
    if (!publishDecisionRequired(batch.records, body.outcomes)) {
      throw corruptRunJournal("Publish decision has no externally published mutation");
    }
    for (const [index, item] of body.outcomes.entries()) {
      const mutation = batch.records[index];
      if (!mutation || mutation.seq !== item.seq) {
        throw corruptRunJournal("Publish decision sequence does not match its mutation batch");
      }
      if (
        mutation.domain === "session" &&
        (item.outcome.t !== "granted" ||
          item.outcome.targetRevision !== state.commitRevisions.get(body.assignmentId))
      ) {
        throw corruptRunJournal("Session mutation decision does not match its conversation commit");
      }
    }
    if (
      !envelope.entries.some(
        (entry) =>
          entry.stream.startsWith("run:") &&
          typeof entry.body === "object" &&
          entry.body !== null &&
          "t" in entry.body &&
          entry.body.t === "committed" &&
          "assignmentId" in entry.body &&
          entry.body.assignmentId === body.assignmentId,
      )
    ) {
      throw corruptRunJournal("Publish decision is not atomic with its committed run fact");
    }
    state.decisions.set(body.assignmentId, body);
    const conflicts: PublishConflictNotice["conflicts"] = [];
    for (const item of body.outcomes) {
      if (item.outcome.t !== "conflicted") continue;
      const mutation = batch.records[item.seq - 1];
      if (!mutation || mutation.domain !== "global") {
        throw corruptRunJournal("Publish conflict has no global staged mutation");
      }
      conflicts.push({
        seq: item.seq,
        mutation: snapshot(mutation.mutation, "Publish conflict mutation") as GlobalStagedMutation,
        error: snapshot(item.outcome.error, "Publish conflict error"),
      });
    }
    if (conflicts.length > 0) {
      state.conflictsByAssignment.set(body.assignmentId, conflicts);
    }
    for (const domain of ["session", "global"] as const) {
      const domainRecords = batch.records.filter((record, index) =>
        record.domain === domain &&
        (mutationNeedsExternalPublish(record) ||
          body.outcomes[index]?.outcome.t === "conflicted"),
      );
      if (domainRecords.length === 0) continue;
      const grantedSeqs = body.outcomes
        .filter(
          (item) =>
            item.outcome.t === "granted" &&
            batch.records[item.seq - 1]?.domain === domain &&
            mutationNeedsExternalPublish(batch.records[item.seq - 1]!),
        )
        .map((item) => item.seq);
      state.domainPlans.set(`${body.assignmentId}\0${domain}`, {
        grantedSeqs,
        grantedIndexBySeq: new Map(
          grantedSeqs.map((seq, index) => [seq, index]),
        ),
        terminalSeq:
          grantedSeqs.at(-1) ?? domainRecords.at(-1)!.seq,
      });
    }
    const conversationId = state.conversationByAssignment.get(body.assignmentId);
    if (!conversationId) {
      throw corruptRunJournal("Publish decision has no conversation binding");
    }
    if (
      [...state.domainPlans.keys()].some((key) =>
        key.startsWith(`${body.assignmentId}\0`),
      )
    ) {
      pendingPublishAssignments(state, conversationId).add(body.assignmentId);
    } else {
      compactSettledPublish(state, body.assignmentId);
    }
    return;
  }
  assertExactRecordKeys(
    body,
    ["assignmentId", "domain", "state", "t", "upToSeq"],
    "Publish progress",
  );
  assertIdentifier(body.assignmentId, "Publish progress assignment id");
  assertNonNegativeSafeInteger(body.upToSeq, "Publish progress sequence");
  if (
    (body.domain !== "session" && body.domain !== "global") ||
    (body.state !== "pending" && body.state !== "settled")
  ) {
    throw corruptRunJournal("Publish progress value is invalid");
  }
  const decision = state.decisions.get(body.assignmentId);
  if (!decision) {
    throw corruptRunJournal("Publish progress has no decision");
  }
  if (
    (body.domain === "session" && decision.sessionCount === 0) ||
    (body.domain === "global" && decision.globalCount === 0)
  ) {
    throw corruptRunJournal("Publish progress names an empty domain");
  }
  const key = `${body.assignmentId}\0${body.domain}`;
  const plan = state.domainPlans.get(key);
  if (!plan) throw corruptRunJournal("Publish progress has no domain plan");
  const current = state.progress.get(key);
  const nextGrantedIndex = current
    ? (plan.grantedIndexBySeq.get(current.upToSeq) ?? -1) + 1
    : 0;
  const nextGrantedSeq = plan.grantedSeqs[nextGrantedIndex];
  const validProgress =
    (body.upToSeq === 0 && body.state === "pending" && !current) ||
    (current?.state === "pending" &&
      nextGrantedSeq !== undefined &&
      body.upToSeq === nextGrantedSeq &&
      body.state === (body.upToSeq === plan.terminalSeq ? "settled" : "pending")) ||
    (current?.state === "pending" &&
      plan.grantedSeqs.length === 0 &&
      body.upToSeq === plan.terminalSeq &&
      body.state === "settled");
  if (!validProgress) {
    throw corruptRunJournal("Publish progress skips or misstates a decided mutation");
  }
  if (
    !Number.isSafeInteger(body.upToSeq) ||
    body.upToSeq < 0 ||
    (current &&
      (body.upToSeq < current.upToSeq ||
        current.state === "settled" ||
        (body.upToSeq === current.upToSeq && body.state === current.state)))
  ) {
    throw corruptRunJournal("Publish progress does not advance monotonically");
  }
  state.progress.set(key, body);
  const conversationId = state.conversationByAssignment.get(body.assignmentId);
  if (!conversationId) {
    throw corruptRunJournal("Publish progress has no conversation binding");
  }
  if (publishAssignmentPending(state, body.assignmentId)) {
    pendingPublishAssignments(state, conversationId).add(body.assignmentId);
  } else {
    removePendingPublishAssignment(state, conversationId, body.assignmentId);
    compactSettledPublish(state, body.assignmentId);
  }
}

function compactSettledPublish(
  state: PublishProjection,
  assignmentId: string,
): void {
  const conversationId = state.conversationByAssignment.get(assignmentId);
  if (conversationId) {
    removePendingPublishAssignment(state, conversationId, assignmentId);
  }
  state.decisions.delete(assignmentId);
  state.batches.delete(assignmentId);
  state.commitRevisions.delete(assignmentId);
  state.conversationByAssignment.delete(assignmentId);
  state.completedAssignments.add(assignmentId);
  for (const domain of ["session", "global"] as const) {
    const key = `${assignmentId}\0${domain}`;
    state.progress.delete(key);
    state.domainPlans.delete(key);
  }
}

function pendingPublishAssignments(
  state: PublishProjection,
  conversationId: string,
): Set<string> {
  const current = state.pendingAssignmentsByConversation.get(conversationId);
  if (current) return current;
  const created = new Set<string>();
  state.pendingAssignmentsByConversation.set(conversationId, created);
  return created;
}

function removePendingPublishAssignment(
  state: PublishProjection,
  conversationId: string,
  assignmentId: string,
): void {
  const pending = state.pendingAssignmentsByConversation.get(conversationId);
  if (!pending) return;
  pending.delete(assignmentId);
  if (pending.size === 0) {
    state.pendingAssignmentsByConversation.delete(conversationId);
  }
}

function publishAssignmentPending(
  state: PublishProjection,
  assignmentId: string,
): boolean {
  if (!state.decisions.has(assignmentId)) return false;
  return (["session", "global"] as const).some((domain) => {
    const key = `${assignmentId}\0${domain}`;
    return (
      state.domainPlans.has(key) && state.progress.get(key)?.state !== "settled"
    );
  });
}

function finalKey(value: Pick<FinalFrame, "conversationId" | "runId" | "commitRevision">): string {
  return `${value.conversationId}\0${value.runId}\0${value.commitRevision}`;
}

function finalRevisionKey(
  value: Pick<FinalFrame, "conversationId" | "commitRevision">,
): string {
  return `${value.conversationId}\0${value.commitRevision}`;
}

function finalEntriesByConversation(
  index: Map<string, Map<string, FinalOutboxProjectionEntry>>,
  conversationId: string,
): Map<string, FinalOutboxProjectionEntry> {
  const current = index.get(conversationId);
  if (current) return current;
  const created = new Map<string, FinalOutboxProjectionEntry>();
  index.set(conversationId, created);
  return created;
}

function removeFinalEntry(
  index: Map<string, Map<string, FinalOutboxProjectionEntry>>,
  conversationId: string,
  key: string,
): void {
  const entries = index.get(conversationId);
  if (!entries) return;
  entries.delete(key);
  if (entries.size === 0) index.delete(conversationId);
}

function finalFrame(record: FinalOutboxRecord, publishConflicts = 0): FinalFrame {
  return {
    v: 1,
    conversationId: record.conversationId,
    runId: record.runId,
    commitRevision: record.commitRevision,
    digest: record.digest,
    ...(publishConflicts > 0 ? { publishConflicts } : {}),
  };
}

async function applyFinalRecord(
  projection: FinalOutboxProjection,
  raw: FinalOutboxRecord,
  at: IsoTime,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  artifacts: ArtifactStore,
): Promise<void> {
  const body = snapshot(raw, "Final outbox record");
  assertExactRecordKeys(
    body,
    ["commitRevision", "conversationId", "digest", "runId", "state", "t"],
    "Final outbox record",
  );
  if (body.t !== "final") throw corruptRunJournal("Final outbox record kind is invalid");
  assertIdentifier(body.conversationId, "Final conversation id");
  assertIdentifier(body.runId, "Final run id");
  assertPositiveSafeInteger(body.commitRevision, "Final commit revision");
  assertDigest(body.digest, "Final bundle digest");
  if (body.state !== "pending" && body.state !== "published" && body.state !== "expired") {
    throw corruptRunJournal("Final outbox state is invalid");
  }
  canonicalTime(at, "Final outbox record time");
  const key = finalKey(body);
  const revisionKey = finalRevisionKey(body);
  const current = projection.entries.get(key);
  if (!current) {
    const lastPendingRevision = projection.lastPendingRevisionByConversation.get(
      body.conversationId,
    );
    if (
      body.state !== "pending" ||
      (lastPendingRevision !== undefined && body.commitRevision <= lastPendingRevision) ||
      projection.activeKeyByConversationRevision.has(revisionKey)
    ) {
      throw corruptRunJournal("Final outbox must begin pending");
    }
    const binding = await loadCommittedBundleBinding(
      envelope,
      artifacts,
      (committed) =>
        committed.runId === body.runId &&
        committed.commitRevision === body.commitRevision,
    );
    if (
      binding.bundle.body.conversationId !== body.conversationId ||
      binding.bundle.digest !== body.digest
    ) {
      throw corruptRunJournal("Final outbox does not bind its committed bundle");
    }
    const entry = { record: body, at };
    projection.lastPendingRevisionByConversation.set(
      body.conversationId,
      body.commitRevision,
    );
    projection.entries.set(key, entry);
    projection.activeKeyByConversationRevision.set(revisionKey, key);
    finalEntriesByConversation(projection.pendingByConversation, body.conversationId).set(
      key,
      entry,
    );
    return;
  }
  const validTransition =
    (current.record.state === "pending" &&
      (body.state === "published" || body.state === "expired")) ||
    (current.record.state === "published" && body.state === "expired");
  if (
    current.record.digest !== body.digest ||
    current.record.conversationId !== body.conversationId ||
    current.record.runId !== body.runId ||
    current.record.commitRevision !== body.commitRevision ||
    !validTransition
  ) {
    throw corruptRunJournal("Final outbox transition is invalid");
  }
  const entry = { record: body, at };
  removeFinalEntry(projection.pendingByConversation, body.conversationId, key);
  removeFinalEntry(projection.publishedByConversation, body.conversationId, key);
  if (body.state === "published") {
    projection.entries.set(key, entry);
    finalEntriesByConversation(projection.publishedByConversation, body.conversationId).set(
      key,
      entry,
    );
  } else {
    projection.entries.delete(key);
    projection.activeKeyByConversationRevision.delete(revisionKey);
  }
}

type TaggedConversationRunJournalRecord = Extract<
  ConversationRunJournalRecord,
  { t: string }
>;

function isTaggedRecord<Tag extends TaggedConversationRunJournalRecord["t"]>(
  value: unknown,
  tag: Tag,
): value is Extract<TaggedConversationRunJournalRecord, { t: Tag }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "t" in value &&
    value.t === tag
  );
}

function firstCommitIndexAfter(
  commits: readonly Extract<ConversationRunJournalRecord, { t: "committed" }>[],
  revision: number,
): number {
  let low = 0;
  let high = commits.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (commits[middle]!.commitRevision <= revision) low = middle + 1;
    else high = middle;
  }
  return low;
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}
