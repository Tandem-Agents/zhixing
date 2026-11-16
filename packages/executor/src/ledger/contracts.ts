import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  DurableProjectionStorageError,
  projectionCheckpointKey,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  ProjectionTransactionContext,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentResourceLease,
  AuthorityCallContext,
  AuthorityEpochRef,
  AuthorityError,
  CancelProofBody,
  ChannelInteractionGrant,
  ContentAssetRef,
  ControlLease,
  DispatchEnvelope,
  DispatchResult,
  ExecutionManifest,
  GlobalStagedMutation,
  InteractionDisplay,
  InteractionMirrorBatch,
  InteractionMirrorEntry,
  JobCommitFence,
  JobGlobalStagedMutation,
  JsonValue,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
  SealedBundle,
  SessionStagedMutation,
  StreamFrame,
  SupersedeProof,
  TranscriptRunRecord,
  WindowCompactInstruction,
} from "@zhixing-ai/core/contracts";
import type { StorageMaintenanceUrgency } from "@zhixing-ai/core/resources";
import type { TrustRuleSnapshot } from "@zhixing-ai/core/security";
import {
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  requiresFormalResourceCoordination,
  type AssignmentInteractionOutcome,
  type AssignmentLedgerValidationState,
  type ConversationInteractionMirrorEntry,
  type ExecutorCapabilitySnapshot,
  type FirstPartyInteractionDecision,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamDataFramePayload,
  type StreamVerifierCheckpoint,
} from "@zhixing-ai/core/protocol";
import type {
  DataPlaneAssignmentBinding,
  DataPlaneTicketRegistry,
} from "../data-plane-ticket-registry.js";
import type { ExecutorAssignmentResourceCoordinator } from "../resource-governor.js";

export type ConversationEnvelope = Extract<DispatchEnvelope, { execution: "conversation" }>;
export type JobEnvelope = Extract<DispatchEnvelope, { execution: "job" }>;
export type AssignmentEnvelope = ConversationEnvelope | JobEnvelope;
export type AnyAssignmentActivationProof =
  | AssignmentActivationProof<"conversation">
  | AssignmentActivationProof<"job">;
export type AnyAssignmentActivationPayload =
  | AssignmentActivationPayload<"conversation">
  | AssignmentActivationPayload<"job">;

export type ConversationDispatchPort = {
  dispatch(
    envelope: ConversationEnvelope,
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
};

export interface OwnerControlRequest {
  readonly method:
    | "executor.dispatch"
    | "executor.cancel"
    | "executor.supersede"
    | "executor.queryLedger";
  readonly assignmentId: string;
  readonly authority?: AuthorityEpochRef;
  readonly requestId: string;
  readonly body: unknown;
  readonly expectedOwnerDeviceId?: string;
  readonly anchorEpoch?: number;
}

export interface OwnerControlAuthorizer {
  readonly readProjectionIds?: readonly string[];
  prepare?(context: AuthorityCallContext, request: OwnerControlRequest, authenticatedCallerDeviceId: string):
    Promise<((prefix: ProjectionTransactionContext) => Promise<void>) | undefined>;
  prepareExecution?(control: { readonly authority: AuthorityEpochRef; readonly ownerDeviceId: string; readonly lease: ControlLease }):
    Promise<((prefix: ProjectionTransactionContext) => Promise<void>) | undefined>;
  authorize(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId: string,
  ): {
    readonly authority: AuthorityEpochRef;
    readonly ownerDeviceId: string;
    readonly controlLease: ControlLease;
  };
}

export interface OwnerControlPreflightPort {
  preflightOwnerControl(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId: string,
  ): Promise<void>;
}

export interface SurfaceAbortInput {
  readonly ticketDigest: string;
  readonly surfacePrincipal: string;
}

export interface AssignmentLedgerOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly ownerControl: OwnerControlAuthorizer;
  readonly snapshotFor: (
    executorId: string,
  ) => ExecutorCapabilitySnapshot | undefined;
  readonly permissionSnapshotFor: (
    digest: string,
  ) => TrustRuleSnapshot | undefined | Promise<TrustRuleSnapshot | undefined>;
  readonly runtimeBindingGuard?: (input: {
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
  }) => AuthorityError | undefined | Promise<AuthorityError | undefined>;
  readonly clock?: () => string;
  readonly monotonicClock?: () => number;
  readonly usageFinal?: (
    assignmentId: string,
  ) =>
    | { readonly reportDigest: string; readonly upToUsageSeq: number }
    | Promise<{ readonly reportDigest: string; readonly upToUsageSeq: number }>;
  readonly resources?: ExecutorAssignmentResourceCoordinator;
  readonly surfaceAbort?: {
    authorize(assignmentId: string, input: SurfaceAbortInput): void;
  };
  readonly dataPlaneTickets?: Pick<DataPlaneTicketRegistry, "authorize">;
  readonly maxPendingInteractions?: number;
  readonly maxCachedAssignments?: number;
  readonly assignmentRecordV2Writes?: boolean;
}

export interface AssignmentSubmissionPort {
  reportStarted(assignmentId: string, ctx: AuthorityCallContext): Promise<void>;
  mirrorInteractions(
    assignmentId: string,
    batch: InteractionMirrorBatch,
    ctx: AuthorityCallContext,
  ): Promise<InteractionMirrorReceipt>;
  submitBundle(
    bundle: SealedBundle,
    ctx: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  >;
  submitCancelProof(
    assignmentId: string,
    proof: CancelProofBody,
    ctx: AuthorityCallContext,
  ): Promise<void>;
}

export type ConversationSubmissionPort = AssignmentSubmissionPort;

export interface InteractionRequestInput {
  readonly requestId: string;
  readonly toolName: string;
  readonly display: { readonly title: string; readonly lines: readonly string[] };
  readonly issuedAt: string;
  readonly ttlMs: number;
  readonly expiresAt: string;
}

export interface InteractionRequestDisposition {
  readonly recordSeq: number;
  readonly accepted: boolean;
  readonly display: InteractionDisplay;
}

export interface InteractionMirrorReceipt {
  readonly mirroredUpTo: number;
  readonly ordinal: number;
  readonly mirrorDigest: string;
}

export type InteractionOutcome = AssignmentInteractionOutcome;

export type StagedConversationMutationInput =
  | {
      readonly domain: "session";
      readonly mutation: SessionStagedMutation;
      readonly requestId: string;
      readonly expected?: never;
    }
  | {
      readonly domain: "global";
      readonly mutation: GlobalStagedMutation;
      readonly requestId: string;
      readonly expected: { readonly anchorEpoch: number };
    };

export interface ConversationSealInput {
  readonly runRecord: TranscriptRunRecord | { readonly ref: ArtifactRef };
  readonly windowCompact?: WindowCompactInstruction;
  readonly contentAssets: readonly ContentAssetRef[];
  readonly streamFinal: { readonly finalSeq: number; readonly streamDigest: string };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
  };
  readonly usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number };
}

export interface JobSealInput {
  readonly fence: JobCommitFence;
  readonly outcome: { readonly status: "completed" | "failed"; readonly summary: string };
  readonly contentAssets: readonly ContentAssetRef[];
  readonly streamFinal: { readonly finalSeq: number; readonly streamDigest: string };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
  };
  readonly usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number };
}

export type StagedJobMutationInput = {
  readonly domain: "global";
  readonly mutation: JobGlobalStagedMutation;
  readonly requestId: string;
  readonly expected: { readonly anchorEpoch: number };
};

export interface InteractionRecoveryResult {
  readonly pending: ReadonlyArray<
    Extract<AssignmentRecord, { t: "interaction-requested" }>
  >;
  readonly resolved: readonly InteractionMirrorEntry[];
}

export interface DurableInteractionStreamEvent {
  readonly recordSeq: number;
  readonly payload: Extract<
    StreamDataFramePayload,
    { readonly kind: "interaction" }
  >;
}

export interface SideEffectInput {
  readonly kind: "tool-mutation" | "external-call";
  readonly toolName: string;
  readonly summary: string;
  readonly target: "workspace-file" | "external-service" | "device-system";
}

export type SurfaceInteractionAnswerPreparation =
  | {
      readonly kind: "authorized";
      readonly decision: FirstPartyInteractionDecision;
      readonly ticketId: string;
      readonly surfacePrincipal: string;
    }
  | {
      readonly kind: "replayed";
      readonly result: ConversationInteractionMirrorEntry;
    };

export type ChannelInteractionAnswerPreparation =
  | {
      readonly kind: "authorized";
      readonly grant: ChannelInteractionGrant;
      readonly outcome: Extract<InteractionOutcome, { readonly t: "answered" }>;
    }
  | {
      readonly kind: "replayed";
      readonly result: InteractionMirrorEntry;
    };

export type SurfaceAbortDisposition =
  | { readonly kind: "accepted" }
  | { readonly kind: "terminal" };

export interface InteractionStreamProjectionReceipt {
  readonly sourceId: string;
  readonly frame: StreamFrame;
  readonly checkpoint: StreamVerifierCheckpoint;
}

export interface AssignmentInteractionStreamSourcePort {
  interactionStreamEvents(assignmentId: string, afterRecordSeq?: number): Promise<readonly DurableInteractionStreamEvent[]>;
  interactionStreamProjectedUpTo(assignmentId: string): Promise<number>;
}

export interface PendingAssignmentInteraction {
  readonly assignmentId: string;
  readonly request: Extract<AssignmentRecord, { readonly t: "interaction-requested" }>;
}

export interface FinishedInteraction {
  readonly body: Extract<AssignmentRecord, { t: "interaction-finished" }>;
  readonly recordSeq: number;
  readonly at: string;
  readonly ordinal: number;
  readonly mirrorDigest: string;
}

export interface RecordedTrustSediment {
  readonly body: Extract<AssignmentRecord, { t: "trust-sediment" }>;
  readonly recordSeq: number;
  readonly at: string;
  readonly ordinal: number;
  readonly mirrorDigest: string;
}

export interface RecordedTrustRuleHit {
  readonly body: Extract<AssignmentRecord, { t: "trust-rule-hit" }>;
  readonly recordSeq: number;
  readonly at: string;
  readonly ordinal: number;
  readonly mirrorDigest: string;
}

export type MirrorChainItem = FinishedInteraction | RecordedTrustSediment | RecordedTrustRuleHit;

export interface RequestedInteraction {
  readonly body: Extract<AssignmentRecord, { t: "interaction-requested" }>;
  readonly recordSeq: number;
}

export type LegacyHistoryPages = {
  readonly requests: number;
  readonly effects: number;
  readonly mirror: number;
};
export type LegacyHistoryCategory = keyof LegacyHistoryPages;

export type LegacyHistory = {
  readonly generation: string;
  readonly upToSeq: number;
  readonly requests: Map<string, { readonly seq: number; readonly body: JsonValue }>;
  readonly finished: Map<string, JsonValue>;
  readonly effectStarts: Map<number, { readonly body: JsonValue }>;
  readonly effectEnds: Map<number, { readonly body: JsonValue }>;
  readonly mirror: Map<number, JsonValue>;
};

export type LegacyHistoryPage = LegacyHistory & {
  readonly category: LegacyHistoryCategory;
  readonly page: number;
  readonly pages: number;
};

export interface LedgerControlState {
  readonly authority: AuthorityEpochRef;
  readonly ownerDeviceId: string;
  readonly lease: ControlLease;
  readonly validForMs: number;
  readonly acceptedAt: string;
}

export interface LedgerReceivedState {
  readonly body: Extract<AssignmentRecord, { t: "received" }>;
  readonly recordSeq: number;
  readonly ledgerDigest: string;
  resourceLease?: AssignmentResourceLease;
  permission?: {
    readonly controlLeaseId: string;
    readonly validForMs: number;
    readonly acceptedAt: string;
  };
}

export interface LedgerRejectionState {
  readonly body: Extract<AssignmentRecord, { t: "dispatch-rejected" }>;
  readonly recordSeq: number;
  readonly ledgerDigest: string;
}

export interface LedgerSupersedeFenceState {
  readonly body: Extract<AssignmentRecord, { t: "supersede-fenced" }>;
  readonly recordSeq: number;
  readonly ledgerDigest: string;
}

export interface LedgerStartedState {
  readonly recordSeq: number;
  readonly ledgerDigest: string;
}

export interface LedgerProjection {
  readonly assignmentId: string;
  leaseTimeFrontier: number;
  leaseAcceptanceFloor: number;
  leaseClockActivated: boolean;
  readonly validation: AssignmentLedgerValidationState;
  lastSeq: number;
  chainDigest: string;
  phase: LedgerSnapshot["phase"];
  control?: LedgerControlState;
  sealed?: Extract<AssignmentRecord, { t: "bundle_sealed" }>;
  received?: LedgerReceivedState;
  rejection?: LedgerRejectionState;
  started?: LedgerStartedState;
  supersedeFence?: LedgerSupersedeFenceState;
  aborts: Array<Extract<AssignmentRecord, { t: "abort-requested" }>>;
  halted?: CancelProofBody;
  readonly sideEffects: Map<
    number,
    {
      readonly started: Extract<AssignmentRecord, { t: "side-effect-started" }>;
      completed?: Extract<AssignmentRecord, { t: "side-effect-completed" }>;
    }
  >;
  readonly entries: AssignmentEntry[];
  readonly ledgerBySeq: string[];
  readonly requested: Map<string, RequestedInteraction>;
  readonly pendingRequests: Map<string, RequestedInteraction>;
  readonly finished: Map<string, FinishedInteraction>;
  readonly finishedOrder: MirrorChainItem[];
  readonly finishedIndexBySeq: Map<number, number>;
  readonly stagedMutations: Array<Extract<AssignmentRecord, { t: "staged-mutation" }>>;
  readonly mutationRequestIds: Set<string>;
  readonly stagedMutationByRequestId: Map<
    string,
    Extract<AssignmentRecord, { t: "staged-mutation" }>
  >;
  failure?: Extract<AssignmentRecord, { t: "execution-failed" }>;
  mirroredUpTo: number;
  mirroredFinishedCount: number;
  mirroredInteractionOrdinal: number;
  mirroredInteractionDigest: string;
  streamProjectionEnabledAfter?: number;
  streamProjectedUpTo: number;
  lastInteractionStreamSeq: number;
  interactionStreamDigest?: string;
  lastStreamProjectionRecordSeq?: number;
  lastStreamProjectionDigest?: string;
  acknowledgedCommitRevision?: number;
  historyBase?: number;
  keyed?: boolean;
  finishedBase?: number;
  historyInteractionUpTo?: number;
  historyChecked?: Set<string>;
  historicMirror?: Map<number, MirrorChainItem>;
  legacyHistoryUpTo?: number;
  legacyHistoryGeneration?: string;
  legacyHistoryPages?: LegacyHistoryPages;
}

export type DecisionState = {
  readonly coveredLsn: number;
  readonly state: LedgerProjection;
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? readonly DeepReadonly<U>[]
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

export type ReadonlyLedgerReceivedState = DeepReadonly<LedgerReceivedState>;

export interface ValidationTicketAbortFact {
  readonly refId: string;
  readonly recordSeq: number;
  readonly ledgerDigest: string;
}

export type DispatchDecision =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "rejected";
      readonly dispatchDigest: string;
      readonly error: AuthorityError;
      readonly recordSeq: number;
      readonly ledgerDigest: string;
    }
  | {
      readonly kind: "conflict";
      readonly received: ReadonlyLedgerReceivedState;
    };

export type AbortCause =
  | {
      readonly cause: "owner-fence";
      readonly fence: { readonly fenceSeq: number; readonly requestId: string };
      readonly authority: AuthorityEpochRef;
    }
  | {
      readonly cause: "abort-ticket";
      readonly ticketDigest: string;
      readonly surfacePrincipal: string;
    };

export interface ExecutionControlFacts {
  readonly assignmentId: string;
  readonly lastSeq: number;
  readonly chainDigest: string;
  readonly phase: LedgerSnapshot["phase"];
  readonly leaseTimeFrontier: number;
  readonly leaseAcceptanceFloor: number;
  readonly control: DeepReadonly<LedgerControlState> | undefined;
  readonly received: ReadonlyLedgerReceivedState | undefined;
  readonly rejection: DeepReadonly<LedgerRejectionState> | undefined;
  readonly started: DeepReadonly<LedgerStartedState> | undefined;
  readonly supersedeFence: DeepReadonly<LedgerSupersedeFenceState> | undefined;
  readonly halted: DeepReadonly<CancelProofBody> | undefined;
  readonly hasAborts: boolean;
  hasAbortMatching(
    predicate: (
      abort: DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>>,
    ) => boolean,
  ): boolean;
  pendingRequestsSnapshot(): readonly DeepReadonly<RequestedInteraction>[];
  readonly sideEffectCount: number;
  readonly hasOpenSideEffects: boolean;
  readonly hasPendingInteractionObligations: boolean;
}

export interface InteractionEffectFacts {
  readonly assignmentId: string;
  readonly lastSeq: number;
  readonly phase: LedgerSnapshot["phase"];
  readonly control: DeepReadonly<LedgerControlState> | undefined;
  readonly received: ReadonlyLedgerReceivedState | undefined;
  readonly supersedeFence: DeepReadonly<LedgerSupersedeFenceState> | undefined;
  readonly hasAborts: boolean;
  latestAbort(
    via?: "owner-fence" | "abort-ticket",
  ): DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>> | undefined;
  firstValidationTicketAbort(): DeepReadonly<ValidationTicketAbortFact> | undefined;
  readonly sideEffectCount: number;
  readonly hasOpenSideEffects: boolean;
  sideEffectBySeq(effectSeq: number):
    | DeepReadonly<{
        readonly started: Extract<AssignmentRecord, { t: "side-effect-started" }>;
        readonly completed?: Extract<AssignmentRecord, { t: "side-effect-completed" }>;
      }>
    | undefined;
  readonly trustSedimentCount: number;
  readonly trustRuleHitCount: number;
  readonly interactionMirrorDigest: string;
  readonly lastFinishedInteractionRecordSeq: number;
  readonly needsStreamProof: boolean;
  hasRequested(requestId: string): boolean;
  requestedById(requestId: string): DeepReadonly<RequestedInteraction> | undefined;
  readonly pendingRequestCount: number;
  pendingRequestsSnapshot(): readonly DeepReadonly<RequestedInteraction>[];
  finishedById(requestId: string): DeepReadonly<FinishedInteraction> | undefined;
  readonly finishedCount: number;
  interactionProjectionSourceIdsBetween(
    afterRecordSeq: number,
    upToRecordSeq: number,
  ): readonly string[];
  readonly streamProjectionEnabledAfter: number | undefined;
  readonly streamProjectedUpTo: number;
  readonly lastInteractionStreamSeq: number;
  readonly interactionStreamDigest: string | undefined;
  readonly lastStreamProjectionRecordSeq: number | undefined;
  readonly lastStreamProjectionDigest: string | undefined;
  readonly historyInteractionUpTo: number | undefined;
}

export interface SealingEvidenceFacts {
  readonly assignmentId: string;
  readonly lastSeq: number;
  readonly phase: LedgerSnapshot["phase"];
  readonly received: ReadonlyLedgerReceivedState | undefined;
  readonly sealed: DeepReadonly<Extract<AssignmentRecord, { t: "bundle_sealed" }>> | undefined;
  readonly halted: DeepReadonly<CancelProofBody> | undefined;
  readonly failure: DeepReadonly<Extract<AssignmentRecord, { t: "execution-failed" }>> | undefined;
  readonly hasAborts: boolean;
  readonly stagedMutationCount: number;
  hasMutationRequestId(requestId: string): boolean;
  stagedMutationForRequestId(
    requestId: string,
  ): DeepReadonly<Extract<AssignmentRecord, { t: "staged-mutation" }>> | undefined;
  stagedMutationsSnapshot(): readonly DeepReadonly<
    Extract<AssignmentRecord, { t: "staged-mutation" }>
  >[];
  readonly hasOpenSideEffects: boolean;
  readonly hasPendingInteractionObligations: boolean;
}

export interface ReceiptRecoveryFacts {
  readonly assignmentId: string;
  readonly lastSeq: number;
  readonly phase: LedgerSnapshot["phase"];
  readonly received: ReadonlyLedgerReceivedState | undefined;
  readonly started: DeepReadonly<LedgerStartedState> | undefined;
  readonly supersedeFence: DeepReadonly<LedgerSupersedeFenceState> | undefined;
  readonly halted: DeepReadonly<CancelProofBody> | undefined;
  readonly hasAborts: boolean;
  hasAbortMatching(
    predicate: (
      abort: DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>>,
    ) => boolean,
  ): boolean;
  latestAbort(
    via?: "owner-fence" | "abort-ticket",
  ): DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>> | undefined;
  firstValidationTicketAbort(): DeepReadonly<ValidationTicketAbortFact> | undefined;
  readonly acknowledgedCommitRevision: number | undefined;
  readonly streamProjectionEnabledAfter: number | undefined;
  readonly cancelProofOwnerAccepted: boolean;
  readonly interactionSettlementOwnerAccepted: DeepReadonly<
    AssignmentLedgerValidationState["interactionSettlementOwnerAccepted"]
  >;
  readonly mirroredInteractionOrdinal: number;
  readonly mirroredInteractionDigest: string;
  readonly mirroredFinishedCount: number;
  readonly finishedCount: number;
  finishedIndexAtSeq(seq: number): number | undefined;
  historicMirrorAt(seq: number): DeepReadonly<MirrorChainItem> | undefined;
  finishedAt(index: number): DeepReadonly<MirrorChainItem> | undefined;
}

export type PreparedExecutionAuthorityCheck = (
  facts: {
    readonly phase: LedgerSnapshot["phase"];
    readonly control: DeepReadonly<LedgerControlState> | undefined;
  },
  prefix: ProjectionTransactionContext,
) => Promise<void>;

export interface JobRecoveryIndexValue {
  readonly v: 5;
  readonly assignmentId: string;
  readonly envelopeRef: ArtifactRef;
  readonly phase: LedgerSnapshot["phase"];
  readonly pendingInteractions: number;
  readonly hasInteractionFacts: boolean;
  readonly maxFinishedSeq: number;
  readonly maxFinishedInteractionSeq: number;
  readonly mirroredUpTo: number;
  readonly streamProjectionEnabledAfter?: number;
  readonly streamProjectedUpTo: number;
  readonly hasAbort: boolean;
  readonly hasAbortTicket: boolean;
  readonly cancelProofOwnerAccepted: boolean;
  readonly interactionSettlementOwnerAccepted: boolean;
}

export interface JobRecoveryObligation {
  readonly envelope: JobEnvelope;
  readonly execution: boolean;
  readonly cancellation: boolean;
  readonly interaction: boolean;
}

export interface JobRecoveryObligationPage {
  readonly entries: readonly JobRecoveryObligation[];
  readonly continuation?: string;
}

export const DEFAULT_MAX_PENDING_INTERACTIONS = 32;
export const DEFAULT_MAX_CACHED_ASSIGNMENTS = 64;
export const LEDGER_DECISION_STATE_VERSION = 2;
export const DECISION_STATE_SAVE_DELAY_MS = 5_000;
export const LEGACY_HISTORY_PAGE_KEYS = 8;
export const DATA_PLANE_BINDING_BATCH_LIMIT = 4096;
export const BINDING_RECOVERY_CHUNK = 64;
export const MAX_WIDTH_CANONICAL_TIME = "+275760-09-13T00:00:00.000Z";

export interface StoredDataPlaneBinding {
  readonly observe?: DataPlaneAssignmentBinding;
  readonly active?: DataPlaneAssignmentBinding;
  readonly resourceReservationId?: string;
}

export interface ReceiptWaiter {
  readonly urgency: StorageMaintenanceUrgency;
  settled: boolean;
  readonly resolve: (value: number) => void;
  readonly reject: (error: unknown) => void;
}

export class HistoryLookupRequired extends Error {}

export class JobRecoveryProjectionValueError extends DurableProjectionStorageError {
  constructor(message: string) {
    super(message);
    this.name = "JobRecoveryProjectionValueError";
  }
}

export class AssignmentExecutionResourceRetiredError extends TypeError {
  constructor(readonly assignmentId: string) {
    super("Assignment execution resource was reclaimed after its lease ended; no executor terminal can be written");
    this.name = "AssignmentExecutionResourceRetiredError";
  }
}

export class AssignmentStartCancelledError extends Error {
  constructor(readonly assignmentId: string) {
    super("Assignment is cancelled and cannot start");
    this.name = "AssignmentStartCancelledError";
  }
}

export type ExecutorLedgerUnitOwner =
  | "state-replay"
  | "execution-control"
  | "interaction-effect"
  | "sealing-evidence"
  | "receipt-recovery";

export const EXECUTOR_RECORD_UNIT_OWNERS = {
  received: "execution-control",
  "dispatch-rejected": "execution-control",
  "control-lease-renewed": "execution-control",
  started: "execution-control",
  "supersede-fenced": "execution-control",
  "abort-requested": "execution-control",
  halted: "execution-control",
  "cancel-proof-owner-accepted": "receipt-recovery",
  "interaction-requested": "interaction-effect",
  "interaction-finished": "interaction-effect",
  "interaction-stream-projection-enabled": "interaction-effect",
  "interaction-stream-projected": "interaction-effect",
  "interaction-settlement-owner-accepted": "receipt-recovery",
  mirrored: "receipt-recovery",
  "trust-sediment": "interaction-effect",
  "trust-rule-hit": "interaction-effect",
  "side-effect-started": "interaction-effect",
  "side-effect-completed": "interaction-effect",
  "staged-mutation": "sealing-evidence",
  "execution-failed": "sealing-evidence",
  bundle_sealed: "sealing-evidence",
  acked: "receipt-recovery",
} as const satisfies Record<AssignmentRecord["t"], ExecutorLedgerUnitOwner>;

export function buildLedgerProjectionCheckpointPrefix(
  projectionName: string,
  version: number,
  leafFns: readonly ((...args: never[]) => unknown)[],
): string {
  if (leafFns.length === 0) {
    throw new TypeError(
      `Ledger checkpoint ${projectionName}@v${version} requires at least one leaf reducer function`,
    );
  }
  return projectionCheckpointKey(projectionName, version, ...leafFns);
}

export const requiresExecutorResourceReceipt = requiresFormalResourceCoordination;

export function nextEntryFromSeq(
  lastSeq: number,
  body: AssignmentRecord,
): AssignmentEntry {
  return { recordSeq: lastSeq + 1, body: snapshot(body, "Assignment record") };
}

export function assignmentRecord(
  assignmentId: string,
  entry: AssignmentEntry,
): LogicalRecord<AssignmentEntry> {
  return { stream: assignmentStream(assignmentId), body: entry };
}

export function assignmentStream(assignmentId: string): string {
  return `assignment:${assignmentId}`;
}

export function authorityForExecutionRef(
  ref: DeepReadonly<AssignmentActivationProof["ref"]> | AssignmentActivationProof["ref"],
): AuthorityEpochRef {
  return ref.execution === "conversation"
    ? {
        execution: "conversation",
        conversationId: ref.conversationId,
        ownerEpoch: ref.ownerEpoch,
      }
    : {
        execution: "job",
        taskId: ref.taskId,
        anchorEpoch: ref.anchorEpoch,
      };
}

export function withoutSignature<T extends { readonly signature: unknown }>(
  proof: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = proof;
  return snapshot(payload, "Assignment activation payload");
}

export function canonicalTime(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

export function assertBoundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new TypeError(`${label} must be a bounded string`);
  }
}

export function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

export function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function assertNonNegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

export function truncateUtf8(value: string, maxBytes: number): string {
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

export function assertFence(
  value: { readonly fenceSeq: number; readonly requestId: string },
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== "fenceSeq\0requestId") {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
  assertPositiveSafeInteger(value.fenceSeq, `${label} sequence`);
  assertIdentifier(value.requestId, `${label} requestId`);
}

export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

export function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalize(actual) !== canonicalize(wanted)) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

export function corruptLedger(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

export function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}

export function mutableSnapshot<T>(value: DeepReadonly<T> | T, label: string): T {
  return snapshot(value, label) as T;
}
