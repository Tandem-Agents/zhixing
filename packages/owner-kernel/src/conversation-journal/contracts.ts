import type {
  ArtifactStore,
  AuthorityCommitLog,
  ProjectionTransactionContext,
} from "@zhixing-ai/core/authority";
import type { AdvancementFoldMap, AdvancementSession, AdvancementSubmissionReceipt } from "@zhixing-ai/core/advancement";
import { defineDurableRuntimeContract } from "@zhixing-ai/core/contracts";
import type {
  ArtifactRef,
  AssignmentActivationProof,
  AuthorityCallContext,
  AuthorityError,
  ContentAssetRef,
  ConversationInvocation,
  ConversationRunState,
  DataPlaneTicket,
  DispatchResult,
  ExplicitEnvironmentSelection,
  FinalFrame,
  FinalOutboxRecord,
  GlobalStagedMutation,
  GovernorRecord,
  IngressContext,
  IsoTime,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
  MutationBatch,
  PublishConflictNotice,
  PublishRecord,
  PublishResultNotice,
  SealedBundle,
  SegmentRecord,
  SessionStagedMutation,
  SupersedeProof,
  TaskListState,
  TranscriptRunRecord,
  UncertainResolutionFact,
  UserTurnInput,
  WindowCompactInstruction,
  WorksceneAppliedResult,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  permissionSnapshotLeaseDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  createChannelInteractionJournalState,
  type ChannelInteractionJournalState,
  type ConversationChannelChallengePreparedRecord,
  type ConversationChannelChallengeRecord,
} from "../channel-interaction-records.js";
import type { ConversationBaseLocation } from "../conversation-base-source.js";
import type { StatusHistoryEntry } from "../conversation-status-projection.js";
import {
  corruptRunJournal,
  type ConversationRunInternalRecord,
  type ConversationRunJournalRecord,
  type ConversationRunRecordType,
  type Stored,
} from "../conversation-run-contracts.js";
import type { ConversationDeliveryParticipant } from "../delivery-participant.js";
import type { AssignmentResourceCoordinator } from "../resource-governor.js";
import type { TrustRuleHitPort } from "../trust-rule-hits.js";
import {
  dispatchConflictKey,
  rejectedNotStartedKey,
  type AssignmentSubmissionAuthorizer,
  type DataPlaneTicketFacts,
  type DataPlaneTicketIssueRequest,
  type InProcessBundleSubmission,
  type InProcessCancellationSubmission,
  type InProcessDispatchContextFactory,
} from "../shared-protocol/contracts.js";

export { dispatchConflictKey, rejectedNotStartedKey };
export type {
  DataPlaneTicketFacts,
  DataPlaneTicketIssueRequest,
  InProcessBundleSubmission,
  InProcessCancellationSubmission,
  InProcessDispatchContextFactory,
};

export type ConversationUncertainResolutionFact = Extract<
  UncertainResolutionFact,
  { subject: { execution: "conversation" } }
>;

export type ConversationCommitLogRecord =
  | ConversationRunJournalRecord
  | ConversationRunInternalRecord
  | GovernorRecord
  | PublishRecord
  | FinalOutboxRecord;

export type ConversationProjectionRecord = Extract<
  ConversationRunInternalRecord,
  { kind: "conversation-commit-projection" }
>;

export interface PublishDomainPlan {
  readonly grantedSeqs: number[];
  readonly grantedIndexBySeq: Map<number, number>;
  readonly terminalSeq: number;
}

export interface PublishProjection {
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

export interface FinalOutboxProjectionEntry {
  readonly record: FinalOutboxRecord;
  readonly at: IsoTime;
}

export interface FinalOutboxProjection {
  readonly entries: Map<string, FinalOutboxProjectionEntry>;
  readonly activeKeyByConversationRevision: Map<string, string>;
  readonly pendingByConversation: Map<string, Map<string, FinalOutboxProjectionEntry>>;
  readonly publishedByConversation: Map<string, Map<string, FinalOutboxProjectionEntry>>;
  readonly lastPendingRevisionByConversation: Map<string, number>;
}

export const FINAL_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface ConversationTrustSedimentPort {
  prepare(input: {
    readonly conversationId: string;
    readonly assignmentId: string;
    readonly executorId: string;
    readonly environment: import("@zhixing-ai/core/contracts").EnvironmentRequirement;
    readonly entry: import("@zhixing-ai/core/contracts").TrustSedimentMirrorEntry;
    readonly answered: (requestId: string) => Promise<boolean>;
  }): Promise<void>;
  accept(input: {
    readonly conversationId: string;
    readonly assignmentId: string;
    readonly entry: import("@zhixing-ai/core/contracts").TrustSedimentMirrorEntry;
  }): Promise<void>;
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
  decideAtPrefix(
    input: ConversationCommitDecisionInput,
  ):
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: AuthorityError;
      };
}

export interface ConversationCommitProjectionInput {
  readonly assignmentId: string;
  readonly conversationId: string;
  readonly commitRevision: number;
  readonly digest: string;
  readonly runRecord: TranscriptRunRecord;
  readonly windowCompact?: WindowCompactInstruction;
  readonly contentAssets: readonly ContentAssetRef[];
  readonly sessionMutations: ReadonlyArray<{
    readonly seq: number;
    readonly mutation: SessionStagedMutation;
    readonly requestId: string;
  }>;
}

export interface ConversationCommitProjection {
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

export type ConversationGlobalMutationDecision = ReadonlyArray<{
  readonly seq: number;
  readonly outcome:
    | {
        readonly t: "granted";
        readonly targetRevision: number;
        readonly appliedResult?: WorksceneAppliedResult;
      }
    | {
        readonly t: "conflicted";
        readonly error: AuthorityError;
      };
}>;

export interface ConversationMutationPublisher {
  readonly readProjectionIds?: readonly string[];
  collectStagedReferences?(records: readonly {
    readonly seq: number;
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
  }[]): Promise<readonly ArtifactRef[]>;
  decideGlobalBatchAtPrefix(input: {
    readonly assignmentId: string;
    readonly authorityPrefixLsn: number;
    readonly authorityContext: ProjectionTransactionContext;
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly mutation: GlobalStagedMutation;
      readonly requestId: string;
      readonly expected: { readonly anchorEpoch: number };
    }>;
  }): ConversationGlobalMutationDecision | Promise<ConversationGlobalMutationDecision>;
  prepareGlobalBatchAtPrefix?(input: {
    readonly assignmentId: string;
    readonly authorityPrefixLsn: number;
    readonly authorityContext: ProjectionTransactionContext;
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly mutation: GlobalStagedMutation;
      readonly requestId: string;
      readonly expected: { readonly anchorEpoch: number };
    }>;
  }): {
    readonly outcomes: ConversationGlobalMutationDecision;
    readonly records: readonly LogicalRecord<unknown>[];
  } | Promise<{
    readonly outcomes: ConversationGlobalMutationDecision;
    readonly records: readonly LogicalRecord<unknown>[];
  }>;
  afterGlobalCommit?(input: {
    readonly conversationId: string;
    readonly assignmentId: string;
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }>;
  }): Promise<void>;
  apply(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly domain: "session" | "global";
    readonly mutation: SessionStagedMutation | GlobalStagedMutation;
    readonly requestId: string;
    readonly targetRevision: number;
    readonly appliedResult?: WorksceneAppliedResult;
  }): Promise<void>;
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
  readonly delivery?: ConversationDeliveryParticipant;
  readonly resources?: AssignmentResourceCoordinator;
  readonly clock?: () => string;
  readonly legacyAbortTickets?: ConversationAbortTicketAuthorizer;
  readonly currentAuthority?: {
    readonly deviceId: string;
    readonly executorId?: string;
  };
  readonly trustSediments?: ConversationTrustSedimentPort;
  readonly trustRuleHits?: TrustRuleHitPort;
}

export interface CommittedConversationResult {
  readonly frame: FinalFrame;
  readonly bundle: SealedBundle & { readonly body: { readonly t: "conversation" } };
  readonly publishResults: readonly PublishResultNotice[];
}

export interface PendingConversationDispatch {
  readonly assignmentId: string;
  readonly envelope: Extract<
    import("@zhixing-ai/core/contracts").DispatchEnvelope,
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
  ): Promise<LedgerSnapshot | LedgerEvidencePage>;
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

export interface AdmittedProjection {
  readonly domainRevision?: number;
  readonly lsn: number;
  readonly record: Omit<Extract<ConversationRunJournalRecord, { t: "admitted" }>, "input">;
  readonly input?: UserTurnInput;
  readonly inputDigest?: string;
  readonly inputRef?: ArtifactRef;
}

export type RetainedConversationEnvelope = Omit<PendingConversationDispatch["envelope"], "work"> & {
  readonly work: Omit<PendingConversationDispatch["envelope"]["work"], "windowInput">;
};

export interface AssignedProjection {
  readonly record: Extract<ConversationRunJournalRecord, { t: "assigned" }>;
  readonly envelope?: RetainedConversationEnvelope;
  readonly commit?: { readonly lsn: number; readonly envelopeDigest: string; readonly at: string };
  readonly origin?: ConversationBaseLocation;
  acked: boolean;
}

export const SESSION_ACTIVITY_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "session-activity",
  producer: "ConversationRunJournal",
  recoveryOwner: "anchor-workscene-owner",
  resourceIdentity: "session-activity:<conversationId>",
  recoveryClass: "authority-replay",
  cases: [
    ...["upsert", "delete"].map((key) => ({ kind: "variant" as const, key })),
    ...["conversation-scene-mismatch", "external-construction"].map((key) => ({ kind: "rejection" as const, key, reasonCode: "SESSION_ACTIVITY_REJECTED" })),
    { kind: "rejection", key: "non-monotonic-revision", reasonCode: "AUTHORITY_RECORD_INVALID" },
    ...["wrong-stream", "invalid-time", "identity-rebinding"].map((key) => ({ kind: "corruption" as const, key, reasonCode: "AUTHORITY_RECORD_INVALID" })),
  ],
} as const);

export const ADVANCEMENT_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "advancement-event",
  producer: "ConversationRunJournal",
  recoveryOwner: "anchor-conversation-owner",
  resourceIdentity: "run:<conversationId>",
  recoveryClass: "authority-replay",
  cases: [
    ...["single-event", "composite-batch", "artifact-stored"].map((key) => ({
      kind: "variant" as const,
      key,
    })),
    ...["conflicting-payload", "illegal-batch"].map((key) => ({
      kind: "rejection" as const,
      key,
      reasonCode: "ADVANCEMENT_WRITE_REJECTED",
    })),
    ...["invalid-event", "non-monotonic-revision", "conflicting-durable-payload"].map(
      (key) => ({
        kind: "corruption" as const,
        key,
        reasonCode: "AUTHORITY_RECORD_INVALID",
      }),
    ),
  ],
} as const);

export class AdvancementWriteRejectedError extends TypeError {
  readonly reasonCode = "ADVANCEMENT_WRITE_REJECTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdvancementWriteRejectedError";
  }
}

export class SessionActivityRejectedError extends TypeError {
  readonly reasonCode = "SESSION_ACTIVITY_REJECTED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionActivityRejectedError";
  }
}

export interface PendingLifecycleProjection {
  readonly mutation: "clear" | "delete";
  readonly domainRevision: number;
  readonly requestId: string;
}

export interface RunProjection {
  readonly conversationId: string;
  domainRevision: number;
  deleted: boolean;
  hasDurableIdentity?: boolean;
  activeAdvancementSessionId?: string;
  advancementStatuses?: Map<string, AdvancementSession["status"]>;
  pendingLifecycleCount?: number;
  readonly advancementSessions: AdvancementFoldMap;
  readonly advancementWrites: Map<
    string,
    { readonly domainRevision: number; readonly eventsDigest: string; readonly receipt?: AdvancementSubmissionReceipt }
  >;
  readonly sessionMutationDigests: Map<
    string,
    { readonly digest: string; readonly domainRevision: number }
  >;
  readonly taskListRequestIds: Set<string>;
  taskList: TaskListState;
  readonly segments: Pick<SegmentRecord, "segmentId" | "timestamp">[];
  readonly worksceneControls: Map<string, { readonly record: TranscriptRunRecord; readonly advancementSessionId?: string }>;
  clearedThroughLsn: number;
  clearedThroughRevision?: number;
  sessionName?: string;
  lastActiveAt?: string;
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
  readonly appendedInputs: Map<string, { readonly record: Omit<Extract<ConversationRunJournalRecord, { t: "run-input-appended" }>, "input">; readonly input?: UserTurnInput; readonly lsn: number }>;
  readonly appendedInputKeysByRun: Map<string, Set<string>>;
  readonly openInputAssignments: Map<string, string>;
  readonly closedInputAssignments: Set<string>;
  readonly inputConsumptions: Map<string, Extract<ConversationRunJournalRecord, { t: "run-input-consumed" }>>;
  readonly runByIngress: Map<string, string>;
  readonly assignedById: Map<string, AssignedProjection>;
  readonly assignmentByRun: Map<string, string>;
  readonly assignmentAttemptByRun?: Map<string, number>;
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
  readonly contentByRevision: Map<number, readonly ContentAssetRef[]>;
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

export interface SubmissionCommitSidecars {
  readonly contentAssetsDigest: string;
  readonly finalDigest: string;
  readonly publish?: {
    readonly batch: { readonly ref: ArtifactRef };
    readonly sessionCount: number;
    readonly globalCount: number;
    readonly pendingDomains: ReadonlySet<"session" | "global">;
  };
}

export interface SubmissionGuardProjection {
  readonly assignmentAttemptByRun?: Map<string, number>;
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
      readonly origin?: ConversationBaseLocation;
      readonly commit?: {
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

export interface ConversationCancelRequest {
  readonly runId: string;
  readonly requestId: string;
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

/** An exact assignment lost the atomic preparation decision to a durable cancellation. */
export class ConversationAssignmentCancelledError extends Error {
  constructor(readonly runId: string, readonly assignmentId: string) {
    super("Conversation assignment was durably cancelled before execution");
    this.name = "ConversationAssignmentCancelledError";
  }
}

/** No dispatch decision may overtake this target's already received control. */
export class ConversationPendingCancellationError extends Error {
  constructor(readonly runId: string) {
    super("Conversation dispatch is waiting for its received cancellation decision");
    this.name = "ConversationPendingCancellationError";
  }
}

export interface ConversationSubmissionGuardContext {
  readonly conversationId: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly legacyAbortTickets?: ConversationAbortTicketAuthorizer;
  readonly assertResourceUsageFinal: (
    assigned: { assignmentId: string; executorId: string; reservation: { reservationId: string } },
    usage: { reportDigest: string; upToUsageSeq: number },
  ) => void;
  readonly assertResourceTerminalRecords: (
    assigned: { assignmentId: string; reservation: { reservationId: string } },
    mode: "settle-release" | "release" | "reclaim",
    records: readonly LogicalRecord<unknown>[],
  ) => void;
}

export type ConversationFactGroup<Body = ConversationCommitLogRecord> = {
  readonly entries: readonly LogicalRecord<Body>[];
  readonly at: string;
};

export interface ConversationRunReductionContext extends ConversationSubmissionGuardContext {
  readonly artifacts: ArtifactStore;
  readonly resources?: Pick<AssignmentResourceCoordinator, "assertActivationRecords">;
  readonly delivery?: Pick<ConversationDeliveryParticipant, "assertConversationCommit" | "assertConversationStatuses">;
  readonly currentAuthority?: ConversationRunJournalOptions["currentAuthority"];
}

export function emptyConversationRunProjection(conversationId: string): RunProjection {
  return {
    conversationId,
    domainRevision: 0,
    deleted: false,
    advancementSessions: new Map(),
    advancementWrites: new Map(),
    sessionMutationDigests: new Map(),
    taskListRequestIds: new Set(),
    taskList: { items: [] },
    segments: [],
    worksceneControls: new Map(),
    clearedThroughLsn: 0,
    sessionMeta: undefined,
    sessionMetaByRequest: new Map(),
    lifecycleByRequest: new Map(),
    pendingLifecycleProjections: new Map(),
    projectedLifecycleRevisions: new Set(),
    admittedByRun: new Map(),
    appendedInputs: new Map(),
    appendedInputKeysByRun: new Map(),
    openInputAssignments: new Map(),
    closedInputAssignments: new Set(),
    inputConsumptions: new Map(),
    runByIngress: new Map(),
    assignedById: new Map(),
    assignmentByRun: new Map(),
    assignmentAttemptByRun: new Map(),
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

export function emptySubmissionGuardProjection(): SubmissionGuardProjection {
  return {
    admittedByRun: new Map(),
    runByIngress: new Map(),
    queuedRunByPosition: new Map(),
    queuedPositionHeap: [],
    queuedPositionHeapIndex: new Map(),
    assignedById: new Map(),
    assignmentByRun: new Map(),
    assignmentAttemptByRun: new Map(),
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

export function assertAssignedMatchesDispatch(
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

export type ConversationStateFamilyOwner =
  | "session-domain"
  | "run-queue-input"
  | "assignment-control"
  | "commit-publish"
  | "channel-tickets"
  | "joint-transitions";

export const CONVERSATION_RECORD_FAMILY_OWNERS = {
  "session-lifecycle": "session-domain",
  "session-meta": "session-domain",
  "session-control": "session-domain",
  "advancement-event": "session-domain",
  admitted: "run-queue-input",
  "run-input-opened": "run-queue-input",
  "run-input-closed": "run-queue-input",
  "run-input-appended": "run-queue-input",
  "run-input-consumed": "run-queue-input",
  assigned: "assignment-control",
  "dispatch-acked": "assignment-control",
  "dispatch-conflict": "assignment-control",
  "dispatch-conflict-contained": "assignment-control",
  "assignment-superseded": "assignment-control",
  "supersede-requested": "assignment-control",
  "supersede-started-observed": "assignment-control",
  "cancel-fence": "assignment-control",
  "cancel-contained": "assignment-control",
  "cancel-proof-accepted": "assignment-control",
  "not-started-rejected": "assignment-control",
  "capability-revoked": "assignment-control",
  resolution: "assignment-control",
  "interaction-mirror": "commit-publish",
  "bundle-ack-observed": "commit-publish",
  "ticket-issued": "channel-tickets",
  "ticket-revoked": "channel-tickets",
  "ticket-sync-frontier": "channel-tickets",
  "channel-challenge-prepared": "channel-tickets",
  "channel-challenge-delivered": "channel-tickets",
  "channel-challenge-closed": "channel-tickets",
  state: "joint-transitions",
  committed: "joint-transitions",
} as const satisfies Record<ConversationRunRecordType, ConversationStateFamilyOwner>;

export const CONVERSATION_INTERNAL_RECORD_FAMILY_OWNERS = {
  "content-asset-index": "commit-publish",
  "session-activity": "session-domain",
  "conversation-commit-projection": "commit-publish",
  "conversation-lifecycle-projection": "session-domain",
} as const satisfies Record<ConversationRunInternalRecord["kind"], ConversationStateFamilyOwner>;

export type StoredArtifactHolder<T> = Stored<T>;
