import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  DurableProjectionStorageError,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  collectArtifactRefs,
  resolveDispatchArtifactClosure,
  resolveSealedBundleArtifactClosure,
  type ArtifactStore,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
  type RebuildableDurableProjectionIndex,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityCallContext,
  AuthorityEpochRef,
  AuthorityError,
  CancelProofBody,
  ControlLease,
  CommitEnvelope,
  DispatchConflictProof,
  DispatchRejectionProof,
  DispatchResult,
  ExecutionAbortRequest,
  ExecutionRef,
  ExecutionManifest,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
  JsonValue,
  PermissionSnapshotLease,
  SealedBundle,
  SupersedeProof,
  SessionStagedMutation,
  GlobalStagedMutation,
  TranscriptRunRecord,
  WindowCompactInstruction,
  ContentAssetRef,
  JobCommitFence,
  JobGlobalStagedMutation,
  InteractionDisplay,
  InteractionMirrorBatch,
  InteractionMirrorEntry,
  InteractionSettlementStreamProof,
  ChannelInteractionGrant,
  RunDispatchArguments,
  RunExecutorPort,
  StreamConsumerAuth,
  StreamFrame,
} from "@zhixing/core/contracts";
import {
  MAX_LEDGER_EVIDENCE_PAGE_BYTES,
  MAX_LEDGER_EVIDENCE_PAGE_ENTRIES,
} from "@zhixing/core/contracts";
import type { PermissionRule, TrustRuleSnapshot } from "@zhixing/core/security";
import {
  assertActivePermissionSnapshotLease,
  acceptedRemoteIntervalRemainingMs,
  MAX_CONTROL_LEASE_TTL_MS,
  MAX_PERMISSION_LEASE_TTL_MS,
  assertProtocolIdentifier as assertIdentifier,
  advanceAssignmentLedger,
  advanceAssignmentInteractionMirrorDigest,
  applyValidatedAssignmentEntry,
  assignmentLedgerSeed,
  canonicalize,
  confirmationDecisionDigest,
  controlLeaseBindsDispatchEnvelope,
  controlLeaseIdentityDigest,
  conversationBundleRoots,
  createJobSealedBundle,
  createConversationSealedBundle,
  createMutationBatch,
  createAssignmentLedgerValidationState,
  createSignedAssignmentInteractionMirrorBatch,
  createSignedInteractionSettlementStreamProof,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  dataPlaneTicketDigest,
  jobBundleRoots,
  mutationBatchArtifact,
  interactionMirrorSeed,
  materializeInteractionDisplay,
  matchManifest,
  validateTrustRuleSnapshot,
  protocolDigest,
  prepareInteractionDisplay,
  requiresFormalResourceCoordination,
  sealedBundleArtifact,
  signCancelProof,
  signDispatchConflictProof,
  signSupersedeProof,
  validateAssignmentEntry,
  validateConversationSealedBundle,
  validateJobMutationBatch,
  validateJobStagedMutationRecord,
  validateMutationBatch,
  validateStagedMutationRecord,
  validateTranscriptRunRecord,
  validateAssignmentInteractionMirrorEntry,
  validateAssignmentInteractionOutcome,
  validateConversationInteractionMirrorEntry,
  validateConversationInteractionOutcome,
  assertChannelInteractionGrantActiveAt,
  assertChannelInteractionGrantBinding,
  channelInteractionConfirmationDecision,
  channelResponderPrincipal,
  validateChannelInteractionGrant,
  validateConversationActivation,
  validateConversationEnvelope,
  validateDispatchControlBinding,
  validateExecutionAbortRequest,
  validateFirstPartyInteractionDecision,
  validateJobActivation,
  validateJobEnvelope,
  validateJobSealedBundle,
  validateInteractionDisplay,
  validateCancelProof,
  type ConversationInteractionMirrorEntry,
  type AssignmentInteractionOutcome,
  type ConversationInteractionOutcome,
  type AssignmentLedgerValidationState,
  type ExecutorCapabilitySnapshot,
  type FirstPartyInteractionDecision,
  type DataPlaneTicketUse,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamDataFramePayload,
  type StreamVerifierCheckpoint,
} from "@zhixing/core/protocol";
import type { ExecutorAssignmentResourceCoordinator } from "./resource-governor.js";
import type { DataPlaneTicketRegistry } from "./data-plane-ticket-registry.js";
import { SerialTaskQueue } from "@zhixing/core/persistence";

type ConversationEnvelope = Extract<
  import("@zhixing/core/contracts").DispatchEnvelope,
  { execution: "conversation" }
>;
type JobEnvelope = Extract<
  import("@zhixing/core/contracts").DispatchEnvelope,
  { execution: "job" }
>;
type AssignmentEnvelope = ConversationEnvelope | JobEnvelope;
type AnyAssignmentActivationProof =
  | AssignmentActivationProof<"conversation">
  | AssignmentActivationProof<"job">;
type AnyAssignmentActivationPayload =
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
}

export interface OwnerControlAuthorizer {
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
  readonly permissionSnapshotFor: (digest: string) => TrustRuleSnapshot | undefined;
  readonly runtimeBindingGuard?: (input: {
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
  }) => AuthorityError | undefined;
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
  /**
   * Enables production creation of assignment v2 facts. Compatibility
   * readers leave this disabled and may only continue an already-cut-over log.
   */
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

export interface InProcessAssignmentSubmissionOptions {
  readonly ledger: ConversationAssignmentLedger;
  readonly owner: AssignmentSubmissionPort;
}

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

export interface StagedJobMutationInput {
  readonly domain: "global";
  readonly mutation: JobGlobalStagedMutation;
  readonly requestId: string;
  readonly expected: { readonly anchorEpoch: number };
}

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

export interface SurfaceAbortInput {
  readonly ticketDigest: string;
  readonly surfacePrincipal: string;
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

interface FinishedInteraction {
  readonly body: Extract<AssignmentRecord, { t: "interaction-finished" }>;
  readonly recordSeq: number;
  readonly at: string;
  readonly ordinal: number;
  readonly mirrorDigest: string;
}

interface RequestedInteraction {
  readonly body: Extract<AssignmentRecord, { t: "interaction-requested" }>;
  readonly recordSeq: number;
}

interface LedgerProjection {
  readonly assignmentId: string;
  readonly validation: AssignmentLedgerValidationState;
  lastSeq: number;
  chainDigest: string;
  phase: LedgerSnapshot["phase"];
  control?: {
    readonly authority: AuthorityEpochRef;
    readonly ownerDeviceId: string;
    readonly lease: ControlLease;
    readonly validForMs: number;
    readonly acceptedAt: string;
  };
  sealed?: Extract<AssignmentRecord, { t: "bundle_sealed" }>;
  received?: {
    readonly body: Extract<AssignmentRecord, { t: "received" }>;
    readonly recordSeq: number;
    readonly ledgerDigest: string;
    resourceLease?: AssignmentResourceLease;
    permission?: {
      readonly controlLeaseId: string;
      readonly validForMs: number;
      readonly acceptedAt: string;
    };
  };
  rejection?: {
    readonly body: Extract<AssignmentRecord, { t: "dispatch-rejected" }>;
    readonly recordSeq: number;
    readonly ledgerDigest: string;
  };
  started?: { readonly recordSeq: number; readonly ledgerDigest: string };
  supersedeFence?: {
    readonly body: Extract<AssignmentRecord, { t: "supersede-fenced" }>;
    readonly recordSeq: number;
    readonly ledgerDigest: string;
  };
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
  readonly finishedOrder: FinishedInteraction[];
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
  acknowledgedCommitRevision?: number;
}

interface JobInteractionRecoveryIndexValue {
  readonly v: 3;
  readonly assignmentId: string;
  readonly envelopeRef: ArtifactRef;
  readonly phase: LedgerSnapshot["phase"];
  readonly pendingInteractions: number;
  readonly hasInteractionFacts: boolean;
  readonly maxFinishedSeq: number;
  readonly mirroredUpTo: number;
  readonly streamProjectionEnabledAfter?: number;
  readonly streamProjectedUpTo: number;
  readonly hasAbort: boolean;
  readonly hasAbortTicket: boolean;
  readonly cancelProofOwnerAccepted: boolean;
  readonly interactionSettlementOwnerAccepted: boolean;
}

type DispatchDecision =
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
      readonly received: NonNullable<LedgerProjection["received"]>;
    };

type AbortCause =
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

const DEFAULT_MAX_PENDING_INTERACTIONS = 32;
const DEFAULT_MAX_CACHED_ASSIGNMENTS = 64;
const MAX_WIDTH_CANONICAL_TIME = "+275760-09-13T00:00:00.000Z";

/** Durable executor-side assignment protocol shared by conversation and job execution. */
export class ConversationAssignmentLedger implements
  ConversationDispatchPort,
  RunExecutorPort,
  OwnerControlPreflightPort
{
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #ownerControl: OwnerControlAuthorizer;
  readonly #snapshotFor: AssignmentLedgerOptions["snapshotFor"];
  readonly #permissionSnapshotFor: AssignmentLedgerOptions["permissionSnapshotFor"];
  readonly #runtimeBindingGuard: AssignmentLedgerOptions["runtimeBindingGuard"];
  readonly #clock: () => string;
  readonly #monotonicClock: () => number;
  readonly #usageFinal: NonNullable<AssignmentLedgerOptions["usageFinal"]>;
  readonly #resources: ExecutorAssignmentResourceCoordinator | undefined;
  readonly #surfaceAbort: AssignmentLedgerOptions["surfaceAbort"];
  readonly #dataPlaneTickets: AssignmentLedgerOptions["dataPlaneTickets"];
  readonly #maxPendingInteractions: number;
  readonly #maxCachedAssignments: number;
  readonly #assignmentRecordV2Writes: boolean;
  readonly #operations = new SerialTaskQueue();
  readonly #jobInteractionRecoveryIndex: RebuildableDurableProjectionIndex;
  readonly #projections = new Map<
    string,
    { readonly state: LedgerProjection; readonly cursor: ProjectionCursor }
  >();
  readonly #controlDeadlines = new Map<
    string,
    { readonly renewalSeq: number; readonly deadline: number }
  >();
  readonly #ownerControlDeadlines = new Map<
    string,
    { readonly renewalSeq: number; readonly deadline: number }
  >();

  constructor(options: AssignmentLedgerOptions) {
    assertIdentifier(options.executorId, "Executor id");
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#ownerControl = options.ownerControl;
    this.#snapshotFor = options.snapshotFor;
    this.#permissionSnapshotFor = options.permissionSnapshotFor;
    this.#runtimeBindingGuard = options.runtimeBindingGuard;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#monotonicClock = options.monotonicClock ?? (() => performance.now());
    // A missing usage reporter is represented explicitly as zero-usage evidence.
    // When a reporter is configured, its signed UsageReport digest replaces this
    // domain-separated fallback in cancel proofs.
    this.#usageFinal =
      options.usageFinal ??
      ((assignmentId) => zeroAssignmentUsageFinal(assignmentId));
    this.#resources = options.resources;
    this.#surfaceAbort = options.surfaceAbort;
    this.#dataPlaneTickets = options.dataPlaneTickets;
    this.#assignmentRecordV2Writes =
      options.assignmentRecordV2Writes ?? false;
    this.#jobInteractionRecoveryIndex = this.#log.durableProjection({
      projectionId: "executor-job-interaction-obligations",
      reducerVersion: 4,
      reduce: (envelope, current) =>
        reduceJobInteractionRecoveryIndex(
          envelope,
          current,
          this.#verifier,
        ),
    });
    this.#maxPendingInteractions =
      options.maxPendingInteractions ?? DEFAULT_MAX_PENDING_INTERACTIONS;
    if (
      !Number.isSafeInteger(this.#maxPendingInteractions) ||
      this.#maxPendingInteractions <= 0
    ) {
      throw new TypeError("Maximum pending interactions must be a positive safe integer");
    }
    this.#maxCachedAssignments =
      options.maxCachedAssignments ?? DEFAULT_MAX_CACHED_ASSIGNMENTS;
    if (
      !Number.isSafeInteger(this.#maxCachedAssignments) ||
      this.#maxCachedAssignments <= 0
    ) {
      throw new TypeError("Maximum cached assignments must be a positive safe integer");
    }
  }

  async dispatch(
    envelope: ConversationEnvelope,
    activation: AssignmentActivationProof<"conversation">,
    ctx: AuthorityCallContext,
  ): Promise<DispatchResult>;
  async dispatch(
    envelope: JobEnvelope,
    activation: AssignmentActivationProof<"job">,
    ctx: AuthorityCallContext,
  ): Promise<DispatchResult>;
  async dispatch(
    ...[rawEnvelope, rawActivation, ctx]: RunDispatchArguments
  ): Promise<DispatchResult> {
    const controlBinding = validateDispatchControlBinding(rawEnvelope, this.#verifier);
    const assignmentId = assertDispatchIdentity(rawEnvelope, this.#executorId);
    if (
      controlBinding.assignmentId !== assignmentId ||
      controlBinding.executorId !== this.#executorId
    ) {
      throw new TypeError("Dispatch control binding targets a different executor");
    }
    const artifact = dispatchEnvelopeArtifact(rawEnvelope);
    const dispatchDigest = dispatchEnvelopeDigest(rawEnvelope);
    const rawActivationPayload = withoutSignature(rawActivation);
    const claimedAuthority = controlBinding.authority;
    await this.#acceptOwnerControl(ctx, {
      method: "executor.dispatch",
      assignmentId,
      authority: claimedAuthority,
      requestId: ctx.requestId,
      body: {
        dispatchDigest,
        activationDigest: protocolDigest(
          "AssignmentActivationPayload",
          1,
          rawActivationPayload,
        ),
      },
      expectedOwnerDeviceId: controlBinding.ownerDeviceId,
    });

    let envelope: AssignmentEnvelope;
    let envelopeReferences: ArtifactRef[];
    let activation: AnyAssignmentActivationProof;
    let activationPayload: AnyAssignmentActivationPayload;
    try {
      envelope = rawEnvelope.execution === "conversation"
        ? validateConversationEnvelope(rawEnvelope, this.#verifier)
        : validateJobEnvelope(rawEnvelope, this.#verifier);
      activation = snapshot(rawActivation, "Assignment activation proof");
      activationPayload = envelope.execution === "conversation"
        ? validateConversationActivation({
            envelope,
            activation: activation as AssignmentActivationProof<"conversation">,
            dispatchRef: artifact.ref,
            verifier: this.#verifier,
          })
        : validateJobActivation({
            envelope,
            activation: activation as AssignmentActivationProof<"job">,
            dispatchRef: artifact.ref,
            verifier: this.#verifier,
          });
    } catch (error) {
      const authorityError = invalidDispatchError(error);
      return this.#rejectBeforeReceived(
        assignmentId,
        dispatchDigest,
        authorityError,
      );
    }

    if (
      canonicalize(claimedAuthority) !==
      canonicalize(authorityForExecutionRef(activationPayload.ref))
    ) {
      throw new TypeError("Dispatch authority changed during validation");
    }
    try {
      if (
        (await this.#artifacts.put(artifact.bytes)).digest !== artifact.ref.digest
      ) {
        throw new TypeError("Dispatch artifact store returned a different digest");
      }
      envelopeReferences = await this.#assertEnvelopeArtifactsPresent(envelope);
    } catch (error) {
      const authorityError = invalidDispatchError(error);
      return this.#rejectBeforeReceived(
        assignmentId,
        dispatchDigest,
        authorityError,
      );
    }

    const transaction = await this.#transact<DispatchDecision>(
      assignmentId,
      (state, transactionContext) => {
        if (state.supersedeFence || state.aborts.length > 0 || state.halted) {
          throw new Error("Assignment is durably fenced and rejects late dispatch");
        }
        if (state.rejection) {
          return {
            kind: "return",
            value: {
              kind: "rejected",
              dispatchDigest: state.rejection.body.dispatchDigest,
              error: state.rejection.body.reason,
              recordSeq: state.rejection.recordSeq,
              ledgerDigest: state.rejection.ledgerDigest,
            },
          };
        }
        if (state.received) {
          const acceptedPayload = withoutSignature(state.received.body.activation);
          return canonicalize(acceptedPayload) === canonicalize(activationPayload)
            ? { kind: "return", value: { kind: "accepted" } }
            : {
                kind: "return",
                value: { kind: "conflict", received: state.received },
              };
        }
        const target = this.#snapshotFor(this.#executorId);
        const compatibility = target === undefined
          ? {
              ok: false as const,
              error: {
                code: "capability-gap" as const,
                message: "Executor capability snapshot is unavailable",
                retryable: true,
              },
            }
          : matchManifest(envelope.manifest, target.descriptor, target.inventory);
        if (!compatibility.ok) {
          const entry = nextEntry(state, {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest,
            reason: compatibility.error,
          });
          const ledgerDigest = advanceAssignmentLedger(state.chainDigest, entry);
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, entry)],
            value: {
              kind: "rejected",
              dispatchDigest,
              error: compatibility.error,
              recordSeq: entry.recordSeq,
              ledgerDigest,
            },
          };
        }
        const runtimeBindingError = envelope.execution === "conversation"
          ? this.#runtimeBindingGuard?.({
              assignmentId,
              manifest: envelope.manifest,
            })
          : undefined;
        if (runtimeBindingError !== undefined) {
          const entry = nextEntry(state, {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest,
            reason: runtimeBindingError,
          });
          const ledgerDigest = advanceAssignmentLedger(state.chainDigest, entry);
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, entry)],
            value: {
              kind: "rejected",
              dispatchDigest,
              error: runtimeBindingError,
              recordSeq: entry.recordSeq,
              ledgerDigest,
            },
          };
        }
        const permissionSnapshot = this.#permissionSnapshotFor(
          envelope.permissionLease.snapshotDigest,
        );
        let permissionError: AuthorityError | undefined;
        try {
          acceptedRemoteIntervalRemainingMs({
            issuedAt: envelope.permissionLease.issuedAt,
            expiry: envelope.permissionLease.expiry,
            acceptedAt: transactionContext.at,
            maxTtlMs: MAX_PERMISSION_LEASE_TTL_MS,
          });
        } catch {
          permissionError = {
            code: "invalid",
            message: "Permission snapshot lease is outside its accepted time window",
            retryable: false,
          };
        }
        if (permissionError !== undefined) {
          // Preserve the time error; no snapshot lookup can make this lease valid.
        } else if (permissionSnapshot === undefined) {
          permissionError = {
            code: "capability-gap",
            message: "Permission snapshot is unavailable",
            retryable: true,
          };
        } else {
          try {
            const validated = validateTrustRuleSnapshot(permissionSnapshot, this.#verifier);
            if (
              validated.digest !== envelope.permissionLease.snapshotDigest ||
              validated.snapshotVersion !== envelope.permissionLease.snapshotVersion
            ) {
              permissionError = {
                code: "invalid",
                message: "Permission snapshot does not match its dispatch lease",
                retryable: false,
              };
            }
          } catch {
            permissionError = {
              code: "invalid",
              message: "Permission snapshot is invalid",
              retryable: false,
            };
          }
        }
        if (permissionError !== undefined) {
          const entry = nextEntry(state, {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest,
            reason: permissionError,
          });
          const ledgerDigest = advanceAssignmentLedger(state.chainDigest, entry);
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, entry)],
            value: {
              kind: "rejected",
              dispatchDigest,
              error: permissionError,
              recordSeq: entry.recordSeq,
              ledgerDigest,
            },
          };
        }
        const entry = nextEntry(state, {
          v: 1,
          t: "received",
          envelope: { ref: artifact.ref },
          activation: activation as unknown as AssignmentActivationProof,
        });
        let resourceRecords: readonly LogicalRecord<unknown>[] = [];
        if (requiresExecutorResourceReceipt(envelope.resourceLease)) {
          if (!this.#resources) {
            const error: AuthorityError = {
              code: "capability-gap",
              message: "Executor resource governance is unavailable",
              retryable: true,
            };
            const rejected = nextEntry(state, {
              v: 1,
              t: "dispatch-rejected",
              dispatchDigest,
              reason: error,
            });
            return {
              kind: "append",
              entries: [assignmentRecord(assignmentId, rejected)],
              value: {
                kind: "rejected",
                dispatchDigest,
                error,
                recordSeq: rejected.recordSeq,
                ledgerDigest: advanceAssignmentLedger(state.chainDigest, rejected),
              },
            };
          }
          try {
            resourceRecords = this.#resources.prepareReceipt(envelope.resourceLease);
          } catch (cause) {
            const error: AuthorityError = {
              code: "lease-exhausted",
              message: cause instanceof Error
                ? cause.message
                : "Executor resource admission failed",
              retryable: true,
            };
            const rejected = nextEntry(state, {
              v: 1,
              t: "dispatch-rejected",
              dispatchDigest,
              reason: error,
            });
            return {
              kind: "append",
              entries: [assignmentRecord(assignmentId, rejected)],
              value: {
                kind: "rejected",
                dispatchDigest,
                error,
                recordSeq: rejected.recordSeq,
                ledgerDigest: advanceAssignmentLedger(state.chainDigest, rejected),
              },
            };
          }
        }
        return {
          kind: "append",
          entries: [...resourceRecords, assignmentRecord(assignmentId, entry)],
          value: { kind: "accepted" },
        };
      },
      [artifact.ref, ...envelopeReferences],
    );

    if (transaction.value.kind === "accepted") {
      return { v: 1, accepted: true };
    }
    if (transaction.value.kind === "rejected") {
      return this.#rejectionResult(
        assignmentId,
        transaction.value.dispatchDigest,
        transaction.value.error,
        transaction.value.recordSeq,
        transaction.value.ledgerDigest,
      );
    }
    return this.#conflictResult(
      assignmentId,
      artifact.ref,
      activationPayload,
      transaction.value.received,
    );
  }

  /** Runs the same durable owner-control guard before a remote adapter dereferences payload assets. */
  async preflightOwnerControl(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId: string,
  ): Promise<void> {
    await this.#acceptOwnerControl(context, request, authenticatedCallerDeviceId);
  }

  async queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    assertIdentifier(assignmentId, "Assignment id");
    if (
      range &&
      (!Number.isSafeInteger(range.fromSeq) ||
        range.fromSeq <= 0 ||
        !Number.isSafeInteger(range.limit) ||
        range.limit <= 0 ||
        range.limit > MAX_LEDGER_EVIDENCE_PAGE_ENTRIES)
    ) {
      throw new RangeError(
        `Ledger evidence range must be within 1..${MAX_LEDGER_EVIDENCE_PAGE_ENTRIES}`,
      );
    }
    await this.#acceptOwnerControl(ctx, {
      method: "executor.queryLedger",
      assignmentId,
      requestId: ctx.requestId,
      body: { range: range ?? null },
    });
    return this.#select(assignmentId, (state) => {
      if (!range) return snapshot(ledgerSnapshot(state), "Ledger snapshot");
      const candidates = state.entries.slice(
        range.fromSeq - 1,
        range.fromSeq - 1 + range.limit,
      );
      if (candidates.length === 0) {
        throw new RangeError("Ledger evidence range starts beyond the durable ledger");
      }
      let lower = 1;
      let upper = candidates.length;
      let selected = 0;
      while (lower <= upper) {
        const count = Math.floor((lower + upper) / 2);
        const payload = ledgerEvidencePayload(
          assignmentId,
          this.#executorId,
          candidates.slice(0, count),
          state.ledgerBySeq,
        );
        if (
          Buffer.byteLength(canonicalize(payload), "utf8") <=
          MAX_LEDGER_EVIDENCE_PAGE_BYTES
        ) {
          selected = count;
          lower = count + 1;
        } else {
          upper = count - 1;
        }
      }
      if (selected === 0) {
        throw new RangeError("A ledger evidence entry exceeds the protocol page byte limit");
      }
      const payload = ledgerEvidencePayload(
        assignmentId,
        this.#executorId,
        candidates.slice(0, selected),
        state.ledgerBySeq,
      );
      return snapshot(
        {
          ...payload,
          signature: this.#signer.sign("LedgerEvidencePage", 1, payload),
        },
        "Ledger evidence page",
      );
    });
  }

  async cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    await this.beginOwnerCancellation(assignmentId, fence, ctx);
    await this.finishOwnerCancellation(assignmentId, fence, ctx);
  }

  /**
   * Persists the owner fence without waiting for runtime shutdown, remote usage,
   * mirrors, or proof generation. The executor composition root must signal and
   * quiesce the matching runtime before calling finishOwnerCancellation.
   */
  async beginOwnerCancellation(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    assertFence(fence, "Cancel fence");
    if (ctx.principal.kind !== "owner-control") {
      throw new Error("Cancellation requires an owner-control principal");
    }
    await this.#acceptOwnerControl(ctx, {
      method: "executor.cancel",
      assignmentId,
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
    await this.#requestAbort(assignmentId, {
      cause: "owner-fence",
      fence: snapshot(fence, "Cancel fence"),
      authority: snapshot(ctx.principal.grant.scope, "Cancel authority"),
    }, false);
  }

  /**
   * Completes the already-persisted owner cancellation after the runtime owner
   * has quiesced local execution and drained deterministic interaction duties.
   */
  async finishOwnerCancellation(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    assertFence(fence, "Cancel fence");
    if (ctx.principal.kind !== "owner-control") {
      throw new Error("Cancellation requires an owner-control principal");
    }
    await this.#requestAbort(assignmentId, {
      cause: "owner-fence",
      fence: snapshot(fence, "Cancel fence"),
      authority: snapshot(ctx.principal.grant.scope, "Cancel authority"),
    });
  }

  async abortFromSurface(
    assignmentId: string,
    input: SurfaceAbortInput,
  ): Promise<void> {
    assertDigest(input.ticketDigest, "Abort ticket digest");
    assertIdentifier(input.surfacePrincipal, "Abort surface principal");
    if (!this.#surfaceAbort) {
      throw new Error("Surface abort authorization is not configured");
    }
    this.#surfaceAbort.authorize(assignmentId, input);
    await this.#requestAbort(assignmentId, {
      cause: "abort-ticket",
      ticketDigest: input.ticketDigest,
      surfacePrincipal: input.surfacePrincipal,
    });
  }

  async abortWithTicket(
    input: ExecutionAbortRequest,
  ): Promise<SurfaceAbortDisposition> {
    const request = validateExecutionAbortRequest(input, this.#verifier);
    const ticketDigest = dataPlaneTicketDigest(request.ticket);
    const existing = await this.#select(request.assignmentId, (state) => ({
      matching: state.aborts.some(
        (abort) =>
          abort.via === "abort-ticket" &&
          abort.refId === ticketDigest &&
          abort.surfacePrincipal === request.ticket.surfacePrincipal,
      ),
      conflicting: state.aborts.some(
        (abort) =>
          abort.via === "abort-ticket" &&
          (abort.refId !== ticketDigest ||
            abort.surfacePrincipal !== request.ticket.surfacePrincipal),
      ),
      terminal: surfaceOperationIsTerminal(state),
    }));
    if (existing.matching) return { kind: "accepted" };
    if (existing.conflicting) {
      throw new Error("Assignment already has a different surface abort");
    }
    if (existing.terminal) return { kind: "terminal" };
    const tickets = this.#dataPlaneTickets;
    if (!tickets) {
      throw new Error("Data-plane ticket authorization is not configured");
    }
    await tickets.authorize(request.ticket.ticketId, "abort", {
      assignmentId: request.assignmentId,
      ref: request.ref,
      executorId: this.#executorId,
      surfacePrincipal: request.ticket.surfacePrincipal,
    });
    await this.#requestAbort(request.assignmentId, {
      cause: "abort-ticket",
      ticketDigest,
      surfacePrincipal: request.ticket.surfacePrincipal,
    }, false);
    return this.#select(request.assignmentId, (state) => {
      if (
        state.aborts.some(
          (abort) =>
            abort.via === "abort-ticket" &&
            abort.refId === ticketDigest &&
            abort.surfacePrincipal === request.ticket.surfacePrincipal,
        )
      ) {
        return { kind: "accepted" as const };
      }
      if (surfaceOperationIsTerminal(state)) {
        return { kind: "terminal" as const };
      }
      throw new Error("Surface abort produced no durable disposition");
    });
  }

  async supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    assertFence(fence, "Supersede fence");
    await this.#acceptOwnerControl(ctx, {
      method: "executor.supersede",
      assignmentId,
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
    const transaction = await this.#transact<{
      readonly decision: SupersedeProof["decision"];
      readonly recordSeq: number;
      readonly ledgerDigest: string;
    }>(assignmentId, (state) => {
      if (state.supersedeFence) {
        if (canonicalize(state.supersedeFence.body) !== canonicalize({
          v: 1,
          t: "supersede-fenced",
          ...fence,
        })) {
          throw new Error("Assignment already has a different supersede fence");
        }
        return {
          kind: "return",
          value: {
            decision: "not-started-fenced",
            recordSeq: state.supersedeFence.recordSeq,
            ledgerDigest: state.supersedeFence.ledgerDigest,
          },
        };
      }
      if (state.started) {
        return {
          kind: "return",
          value: {
            decision: "already-started",
            recordSeq: state.started.recordSeq,
            ledgerDigest: state.started.ledgerDigest,
          },
        };
      }
      if (
        state.phase === "dispatch-rejected" ||
        state.phase === "halted" ||
        state.phase === "failed"
      ) {
        throw new Error("Terminated assignment cannot be superseded through a new fence");
      }
      if (state.aborts.length > 0) {
        throw new Error("Cancelling assignment cannot accept a supersede fence");
      }
      const entry = nextEntry(state, { v: 1, t: "supersede-fenced", ...fence });
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: {
          decision: "not-started-fenced",
          recordSeq: entry.recordSeq,
          ledgerDigest: advanceAssignmentLedger(state.chainDigest, entry),
        },
      };
    });
    return signSupersedeProof(
      {
        v: 1,
        assignmentId,
        executorId: this.#executorId,
        fence: snapshot(fence, "Supersede fence"),
        decision: transaction.value.decision,
        lastRecordSeq: transaction.value.recordSeq,
        ledgerDigest: transaction.value.ledgerDigest,
      },
      this.#signer,
    );
  }

  async start(assignmentId: string): Promise<{ readonly started: boolean }> {
    const transaction = await this.#transact<{ started: boolean }>(
      assignmentId,
      (state) => {
        if (state.aborts.length > 0 || state.supersedeFence) {
          throw new Error("Assignment is fenced and cannot start");
        }
        if (state.phase === "received") {
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, nextEntry(state, { v: 1, t: "started" }))],
            value: { started: true },
          };
        }
        if (
          state.phase === "started" ||
          state.phase === "failed" ||
          state.phase === "sealed" ||
          state.phase === "acked"
        ) {
          return { kind: "return", value: { started: false } };
        }
        throw new Error("Assignment cannot start before a durable received record");
      },
    );
    return transaction.value;
  }

  async startSideEffect(
    assignmentId: string,
    input: SideEffectInput,
  ): Promise<{ readonly effectSeq: number }> {
    assertIdentifier(input.toolName, "Side-effect tool name");
    assertBoundedText(input.summary, "Side-effect summary");
    if (input.kind !== "tool-mutation" && input.kind !== "external-call") {
      throw new TypeError("Side-effect kind is invalid");
    }
    if (
      input.target !== "workspace-file" &&
      input.target !== "external-service" &&
      input.target !== "device-system"
    ) {
      throw new TypeError("Side-effect target is invalid");
    }
    const transaction = await this.#transact<{ effectSeq: number }>(
      assignmentId,
      (state) => {
        if (state.phase !== "started" || state.aborts.length > 0) {
          throw new Error("Side effects require an active, unfenced assignment");
        }
        const effectSeq = state.sideEffects.size + 1;
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntry(state, {
                v: 1,
                t: "side-effect-started",
                effectSeq,
                ...snapshot(input, "Side-effect input"),
              }),
            ),
          ],
          value: { effectSeq },
        };
      },
    );
    return transaction.value;
  }

  async completeSideEffect(
    assignmentId: string,
    effectSeq: number,
    result: {
      readonly status: "ok" | "failed" | "aborted";
      readonly resultDigest?: string;
    },
  ): Promise<void> {
    assertPositiveSafeInteger(effectSeq, "Side-effect sequence");
    if (result.status !== "ok" && result.status !== "failed" && result.status !== "aborted") {
      throw new TypeError("Side-effect completion status is invalid");
    }
    if (result.resultDigest !== undefined) {
      assertDigest(result.resultDigest, "Side-effect result digest");
    }
    await this.#transact<void>(assignmentId, (state) => {
      const effect = state.sideEffects.get(effectSeq);
      if (!effect) throw new Error("Side-effect completion has no durable start");
      const body = snapshot(
        {
          v: 1 as const,
          t: "side-effect-completed" as const,
          effectSeq,
          status: result.status,
          ...(result.resultDigest ? { resultDigest: result.resultDigest } : {}),
        },
        "Side-effect completion",
      );
      if (effect.completed) {
        if (canonicalize(effect.completed) !== canonicalize(body)) {
          throw new Error("Side effect already has a different terminal result");
        }
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, nextEntry(state, body))],
        value: undefined,
      };
    });
  }

  async requestInteraction(
    assignmentId: string,
    input: InteractionRequestInput,
  ): Promise<InteractionRequestDisposition> {
    await this.enableInteractionStreamProjection(assignmentId);
    const prepared = await interactionRequested(input, this.#artifacts);
    const body = prepared.body;
    const transaction = await this.#transact<InteractionRequestDisposition>(
      assignmentId,
      (state) => {
        const existing = state.requested.get(body.requestId);
        if (existing) {
          if (canonicalize(existing.body) !== canonicalize(body)) {
            throw new Error("Interaction requestId has conflicting durable payloads");
          }
          const finished = state.finished.get(body.requestId);
          const rejectedByBackpressure =
            finished?.body.outcome.t === "cancelled" &&
            finished.body.outcome.via === "backpressure";
          return {
            kind: "return",
            value: {
              recordSeq: existing.recordSeq,
              accepted: !rejectedByBackpressure,
              display: existing.body.display,
            },
          };
        }
        if (state.phase !== "started" || state.aborts.length > 0) {
          throw new Error("Interactions can only be requested by a started assignment");
        }
        const entry = nextEntry(state, body);
        const entries = [entry];
        if (state.pendingRequests.size >= this.#maxPendingInteractions) {
          entries.push({
            recordSeq: entry.recordSeq + 1,
            body: {
              v: 1,
              t: "interaction-finished",
              requestId: body.requestId,
              kind: "allow-once",
              outcome: { t: "cancelled", via: "backpressure" },
            },
          });
        }
        return {
          kind: "append",
          entries: entries.map((item) => assignmentRecord(assignmentId, item)),
          value: {
            recordSeq: entry.recordSeq,
            accepted: entries.length === 1,
            display: body.display,
          },
        };
      },
      prepared.references,
    );
    return transaction.value;
  }

  async finishInteraction(
    assignmentId: string,
    requestId: string,
    outcome: InteractionOutcome,
  ): Promise<InteractionMirrorEntry> {
    assertIdentifier(requestId, "Interaction requestId");
    const validatedOutcome = validateAssignmentInteractionOutcome(
      outcome,
      this.#verifier,
    );
    const body = snapshot(
      {
        v: 1 as const,
        t: "interaction-finished" as const,
        requestId,
        kind: "allow-once" as const,
        outcome: validatedOutcome,
      },
      "Interaction result",
    );
    assertFinishedInteractionFits(assignmentId, this.#executorId, body);
    const transaction = await this.#transact<{
      readonly existing?: FinishedInteraction;
      readonly recordSeq?: number;
      readonly ordinal?: number;
      readonly mirrorDigest?: string;
    }>(assignmentId, (state) => {
      const requested = state.requested.get(requestId);
      if (!requested) throw new Error("Interaction result has no durable request");
      if (validatedOutcome.t === "answered") {
        assertAnsweredInteractionAuthority(validatedOutcome.authority, {
          assignmentId,
          requestId,
          ref: state.received?.body.activation.ref,
          ownerKeyId: state.received?.body.activation.signature.keyId,
          requested: requested.body,
        });
      }
      const existing = state.finished.get(requestId);
      if (existing) {
        if (canonicalize(existing.body) !== canonicalize(body)) {
          throw new Error("Interaction requestId already has a different terminal result");
        }
        return { kind: "return", value: { existing } };
      }
      if (state.aborts.length > 0) {
        throw new Error("Interaction result cannot overtake a durable cancellation");
      }
      const entry = nextEntry(state, body);
      const ordinal = state.finishedOrder.length + 1;
      const mirrorDigest = advanceAssignmentInteractionMirrorDigest(
        state.validation.interactionMirrorDigest,
        {
          ordinal,
          seq: entry.recordSeq,
          requestId,
          kind: "allow-once",
          outcome: validatedOutcome,
        },
      );
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: { recordSeq: entry.recordSeq, ordinal, mirrorDigest },
      };
    });
    if (transaction.value.existing) {
      return mirrorEntry(transaction.value.existing);
    }
    return validateAssignmentInteractionMirrorEntry({
      ordinal: transaction.value.ordinal!,
      seq: transaction.value.recordSeq!,
      requestId,
      kind: "allow-once",
      outcome: validatedOutcome,
      at: transaction.commit!.at,
    }, this.#verifier);
  }

  async jobInteractionOutcome(
    assignmentId: string,
    requestId: string,
  ): Promise<InteractionOutcome | undefined> {
    assertIdentifier(requestId, "Interaction requestId");
    return this.#select(assignmentId, (state) => {
      if (
        state.received?.body.activation.ref.execution !== "job" ||
        !state.requested.has(requestId)
      ) {
        throw new Error(
          "Job interaction outcome has no durable job request",
        );
      }
      const finished = state.finished.get(requestId);
      return finished
        ? snapshot(finished.body.outcome, "Interaction outcome")
        : undefined;
    });
  }

  async interactionStreamEvents(
    assignmentId: string,
  ): Promise<readonly DurableInteractionStreamEvent[]> {
    return this.#select(assignmentId, (state) => {
      const events: DurableInteractionStreamEvent[] = [];
      for (const requested of state.requested.values()) {
        events.push({
          recordSeq: requested.recordSeq,
          payload: {
            kind: "interaction",
            event: {
              t: "requested",
              requestId: requested.body.requestId,
              toolName: requested.body.toolName,
              display: snapshot(
                requested.body.display,
                "Interaction stream display",
              ),
              issuedAt: requested.body.issuedAt,
              ttlMs: requested.body.ttlMs,
              expiresAt: requested.body.expiresAt,
            },
          },
        });
      }
      for (const finished of state.finished.values()) {
        events.push({
          recordSeq: finished.recordSeq,
          payload: {
            kind: "interaction",
            event: {
              t: "finished",
              requestId: finished.body.requestId,
              outcome: streamInteractionOutcome(finished.body.outcome),
            },
          },
        });
      }
      return events.sort((left, right) => left.recordSeq - right.recordSeq);
    });
  }

  async prepareInteractionAnswerFromSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decision: Parameters<typeof validateFirstPartyInteractionDecision>[0];
  }): Promise<SurfaceInteractionAnswerPreparation> {
    const decision = validateFirstPartyInteractionDecision(input.decision);
    const expectedOutcome = surfaceTicketInteractionOutcome({
      requestId: input.requestId,
      ticketId: input.ticketId,
      surfacePrincipal: input.surfacePrincipal,
      decision,
    });
    const existing = await this.#select(input.assignmentId, (state) =>
      state.finished.get(input.requestId),
    );
    if (existing) {
      if (
        canonicalize(existing.body.outcome) !== canonicalize(expectedOutcome)
      ) {
        throw new Error(
          "Interaction requestId already has a different terminal result",
        );
      }
      return {
        kind: "replayed",
        result: validateConversationInteractionMirrorEntry(
          mirrorEntry(existing),
        ),
      };
    }
    const tickets = this.#dataPlaneTickets;
    if (!tickets) {
      throw new Error("Data-plane ticket authorization is not configured");
    }
    const binding = await this.dataPlaneBinding(input.assignmentId);
    if (!binding) {
      throw new Error("Interaction answer has no durable assignment activation");
    }
    const authorization = await tickets.authorize(
      input.ticketId,
      "interact",
      {
        assignmentId: input.assignmentId,
        ref: binding.ref,
        executorId: binding.executorId,
        surfacePrincipal: input.surfacePrincipal,
      },
    );
    return {
      kind: "authorized",
      decision,
      ticketId: authorization.ticket.ticketId,
      surfacePrincipal: authorization.ticket.surfacePrincipal,
    };
  }

  async prepareInteractionAnswerFromChannel(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly grant: ChannelInteractionGrant;
    readonly at?: string;
  }): Promise<ChannelInteractionAnswerPreparation> {
    assertIdentifier(input.assignmentId, "Channel answer assignmentId");
    assertIdentifier(input.requestId, "Channel answer requestId");
    const grant = validateChannelInteractionGrant(input.grant, this.#verifier);
    const at = input.at ?? this.#clock();
    const selected = await this.#select(input.assignmentId, (state) => ({
      ref: state.received?.body.activation.ref,
      ownerKeyId: state.received?.body.activation.signature.keyId,
      requested: state.requested.get(input.requestId)?.body,
      existing: state.finished.get(input.requestId),
      active:
        state.phase === "started" &&
        state.aborts.length === 0 &&
        !state.supersedeFence,
    }));
    assertAnsweredInteractionAuthority(
      { via: "channel-grant", grant },
      {
        assignmentId: input.assignmentId,
        requestId: input.requestId,
        ref: selected.ref,
        ownerKeyId: selected.ownerKeyId,
        requested: selected.requested,
      },
    );
    const outcome = validateAssignmentInteractionOutcome({
      t: "answered",
      authority: { via: "channel-grant", grant },
      decision: grant.decision,
      decisionDigest: confirmationDecisionDigest(
        input.requestId,
        channelInteractionConfirmationDecision(grant.decision),
      ),
      by: channelResponderPrincipal(grant.responder),
    }, this.#verifier) as Extract<
      InteractionOutcome,
      { readonly t: "answered" }
    >;
    if (selected.existing) {
      if (
        canonicalize(selected.existing.body.outcome) !== canonicalize(outcome)
      ) {
        throw new Error(
          "Interaction requestId already has a different terminal result",
        );
      }
      return { kind: "replayed", result: mirrorEntry(selected.existing) };
    }
    if (!selected.active) {
      throw new Error("Channel interaction grant cannot answer an inactive job");
    }
    assertChannelInteractionGrantActiveAt(grant, at);
    return { kind: "authorized", grant, outcome };
  }

  async dataPlaneBinding(
    assignmentId: string,
    use?: DataPlaneTicketUse,
  ): Promise<
    {
      readonly ref: ExecutionRef;
      readonly executorId: string;
      readonly ownerKeyId: string;
    } | undefined
  > {
    assertIdentifier(assignmentId, "Data-plane assignment id");
    return this.#select(assignmentId, (state) => {
      if (!state.received) return undefined;
      const acceptsActiveUse =
        (state.phase === "received" || state.phase === "started") &&
        state.aborts.length === 0 &&
        !state.supersedeFence;
      if (!acceptsActiveUse && use !== "observe") return undefined;
      return {
        ref: snapshot(
          state.received.body.activation.ref,
          "Data-plane execution reference",
        ),
        executorId: this.#executorId,
        ownerKeyId: state.received.body.activation.signature.keyId,
      };
    });
  }

  async authorizeOwnerRelay(input: {
    readonly assignmentId: string;
    readonly consumer: Extract<
      StreamConsumerAuth,
      { readonly kind: "owner-relay" }
    >;
    readonly ownerDeviceId: string;
  }): Promise<void> {
    assertIdentifier(input.assignmentId, "Owner relay assignment id");
    assertIdentifier(input.ownerDeviceId, "Owner relay device id");
    await this.#select(input.assignmentId, (state) => {
      const ref = state.received?.body.activation.ref;
      const control = state.control;
      if (
        !ref ||
        ref.execution !== "job" ||
        !control ||
        control.ownerDeviceId !== input.ownerDeviceId ||
        canonicalize(control.authority) !==
          canonicalize(input.consumer.authority) ||
        control.lease.controlLeaseId !== input.consumer.controlLeaseId ||
        !this.#ownerControlLeaseIsActive(state)
      ) {
        throw new Error("Owner relay authorization is not active for this assignment");
      }
    });
  }

  async pendingInteractionMirrors(
    assignmentId: string,
  ): Promise<InteractionMirrorEntry[]> {
    return this.#select(assignmentId, (state) =>
      selectPendingInteractionMirrors(state, assignmentId, this.#executorId),
    );
  }

  async pendingInteractionMirrorBatch(
    assignmentId: string,
  ): Promise<InteractionMirrorBatch | undefined> {
    const selected = await this.#select(assignmentId, (state) => ({
      previousDigest: state.mirroredInteractionDigest,
      entries: selectPendingInteractionMirrors(
        state,
        assignmentId,
        this.#executorId,
      ),
    }));
    if (selected.entries.length === 0) return undefined;
    const batch = createSignedAssignmentInteractionMirrorBatch({
      assignmentId,
      executorId: this.#executorId,
      previousDigest: selected.previousDigest,
      entries: selected.entries,
      signer: this.#signer,
      verifier: this.#verifier,
    });
    if (interactionMirrorRecordBytes(assignmentId, batch) > MAX_INLINE_LOGICAL_RECORD_BYTES) {
      throw new Error("Signed interaction mirror batch exceeded its capacity proof");
    }
    return batch;
  }

  async markInteractionsMirrored(
    assignmentId: string,
    receipt: InteractionMirrorReceipt,
  ): Promise<void> {
    if (!Number.isSafeInteger(receipt.mirroredUpTo) || receipt.mirroredUpTo <= 0) {
      throw new TypeError("Interaction mirror watermark must be a positive safe integer");
    }
    if (!Number.isSafeInteger(receipt.ordinal) || receipt.ordinal <= 0) {
      throw new TypeError("Interaction mirror ordinal must be a positive safe integer");
    }
    await this.#transact<void>(assignmentId, (state) => {
      const finishedIndex = state.finishedIndexBySeq.get(receipt.mirroredUpTo);
      const finished =
        finishedIndex === undefined ? undefined : state.finishedOrder[finishedIndex];
      if (
        finishedIndex === undefined ||
        !finished ||
        finished.ordinal !== receipt.ordinal ||
        finished.mirrorDigest !== receipt.mirrorDigest ||
        receipt.ordinal !== finishedIndex + 1
      ) {
        throw new Error("Interaction mirror watermark exceeds durable finished records");
      }
      if (receipt.ordinal <= state.mirroredInteractionOrdinal) {
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntry(state, {
              v: 1,
              t: "mirrored",
              upTo: receipt.mirroredUpTo,
              ordinal: receipt.ordinal,
              mirrorDigest: receipt.mirrorDigest,
            }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async enableInteractionStreamProjection(
    assignmentId: string,
  ): Promise<number | undefined> {
    if (!this.#assignmentRecordV2Writes) return undefined;
    return (
      await this.#transact<number | undefined>(assignmentId, (state) => {
        if (state.received?.body.activation.ref.execution !== "job") {
          return { kind: "return", value: undefined };
        }
        if (state.streamProjectionEnabledAfter !== undefined) {
          return {
            kind: "return",
            value: state.streamProjectionEnabledAfter,
          };
        }
        const legacyUpToRecordSeq = state.lastSeq;
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntry(state, {
                v: 2,
                t: "interaction-stream-projection-enabled",
                legacyUpToRecordSeq,
              }),
            ),
          ],
          value: legacyUpToRecordSeq,
        };
      })
    ).value;
  }

  async interactionStreamProjectionEnabled(
    assignmentId: string,
  ): Promise<boolean> {
    return this.#select(
      assignmentId,
      (state) => state.streamProjectionEnabledAfter !== undefined,
    );
  }

  async interactionStreamProjectedUpTo(
    assignmentId: string,
  ): Promise<number | undefined> {
    return this.#select(assignmentId, (state) =>
      state.streamProjectionEnabledAfter === undefined
        ? undefined
        : state.streamProjectedUpTo,
    );
  }

  async markInteractionStreamProjected(
    assignmentId: string,
    receipts: readonly InteractionStreamProjectionReceipt[],
  ): Promise<void> {
    if (receipts.length === 0) return;
    const lastReceipt = receipts.at(-1)!;
    const checkpoint = lastReceipt.checkpoint;
    if (
      checkpoint.assignmentId !== assignmentId ||
      checkpoint.lastSeq < lastReceipt.frame.seq ||
      lastReceipt.frame.assignmentId !== assignmentId ||
      checkpoint.streamEpoch !== lastReceipt.frame.streamEpoch ||
      canonicalize(checkpoint.ref) !== canonicalize(lastReceipt.frame.ref)
    ) {
      throw new TypeError(
        "Interaction stream receipt does not bind its durable checkpoint",
      );
    }
    let previousFrameSeq = 0;
    let previousRecordSeq = 0;
    for (const receipt of receipts) {
      const recordSeq = interactionRecordSeqFromSource(receipt.sourceId);
      if (
        receipt.frame.assignmentId !== assignmentId ||
        receipt.frame.payload.kind !== "interaction" ||
        receipt.checkpoint.assignmentId !== assignmentId ||
        receipt.checkpoint.lastSeq < receipt.frame.seq ||
        receipt.checkpoint.streamEpoch !== receipt.frame.streamEpoch ||
        canonicalize(receipt.checkpoint.ref) !==
          canonicalize(receipt.frame.ref) ||
        receipt.frame.seq <= previousFrameSeq ||
        recordSeq <= previousRecordSeq
      ) {
        throw new TypeError(
          "Interaction stream receipts are not a contiguous ordered projection",
        );
      }
      previousFrameSeq = receipt.frame.seq;
      previousRecordSeq = recordSeq;
    }
    await this.#transact<void>(assignmentId, (state) => {
      if (state.received?.body.activation.ref.execution !== "job") {
        throw new TypeError(
          "Conversation assignments cannot write job stream projection facts",
        );
      }
      if (state.streamProjectionEnabledAfter === undefined) {
        throw new Error(
          "Interaction stream projection has no durable format cutover",
        );
      }
      const finishedRecordSeqs = receipts
        .filter((receipt) => receipt.frame.payload.kind === "interaction" &&
          receipt.frame.payload.event.t === "finished")
        .map((receipt) => interactionRecordSeqFromSource(receipt.sourceId));
      const upToRecordSeq = finishedRecordSeqs.at(-1);
      if (upToRecordSeq === undefined) return { kind: "return", value: undefined };
      if (upToRecordSeq < state.streamProjectedUpTo) {
        throw new Error(
          "Interaction stream projection watermark cannot move backward",
        );
      }
      if (upToRecordSeq === state.streamProjectedUpTo) {
        if (
          checkpoint.lastSeq !== state.lastInteractionStreamSeq ||
          checkpoint.head !== state.interactionStreamDigest
        ) {
          throw new Error(
            "Interaction stream projection watermark has a conflicting durable checkpoint",
          );
        }
        return { kind: "return", value: undefined };
      }
      const expected = interactionProjectionSourceIds(
        state,
        state.streamProjectedUpTo,
        upToRecordSeq,
      );
      const actual = receipts
        .map((receipt) => receipt.sourceId)
        .filter((sourceId) => {
          const seq = interactionRecordSeqFromSource(sourceId);
          return seq > state.streamProjectedUpTo && seq <= upToRecordSeq;
        });
      if (canonicalize(actual) !== canonicalize(expected)) {
        throw new Error(
          "Interaction stream receipt skips or reorders a durable interaction prefix",
        );
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntry(state, {
              v: 2,
              t: "interaction-stream-projected",
              assignmentId,
              upToRecordSeq,
              lastStreamSeq: checkpoint.lastSeq,
              streamDigest: checkpoint.head,
            }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async interactionSettlementStreamProof(
    assignmentId: string,
  ): Promise<InteractionSettlementStreamProof> {
    return this.#select(assignmentId, (state) => {
      const abort = [...state.validation.aborts.values()]
        .find((candidate) => candidate.via === "abort-ticket");
      const target = state.finishedOrder.at(-1);
      if (
        !abort ||
        !target ||
        state.streamProjectionEnabledAfter === undefined ||
        state.streamProjectedUpTo < target.recordSeq ||
        state.lastStreamProjectionRecordSeq === undefined ||
        state.interactionStreamDigest === undefined
      ) {
        throw new Error(
          "Interaction settlement stream proof is not yet derivable from the assignment ledger",
        );
      }
      return createSignedInteractionSettlementStreamProof({
        v: 2,
        assignmentId,
        executorId: this.#executorId,
        ticketDigest: abort.refId,
        sourceLastSeq: abort.recordSeq,
        sourceChainDigest: abort.ledgerDigest,
        targetInteractionRecordSeq: target.recordSeq,
        projectedRecordSeq: state.lastStreamProjectionRecordSeq,
        upToRecordSeq: state.streamProjectedUpTo,
        lastStreamSeq: state.lastInteractionStreamSeq,
        streamDigest: state.interactionStreamDigest,
        ledgerChainDigest:
          state.ledgerBySeq[state.lastStreamProjectionRecordSeq - 1]!,
        signer: this.#signer,
      });
    });
  }

  async recoverInteractions(
    assignmentId: string,
    now = this.#clock(),
  ): Promise<InteractionRecoveryResult> {
    const nowMs = canonicalTime(now, "Interaction recovery time");
    const transaction = await this.#transact<{
      readonly pending: Array<Extract<AssignmentRecord, { t: "interaction-requested" }>>;
      readonly appended: Array<{
        requestId: string;
        outcome: InteractionOutcome;
        recordSeq: number;
        ordinal: number;
      }>;
    }>(assignmentId, (state) => {
      const pending = [...state.pendingRequests.values()].map((request) => request.body);
      const terminal =
        state.phase === "failed" || state.phase === "sealed" || state.phase === "acked";
      const cancellation = state.aborts.at(-1);
      const toResolve = pending.filter(
        (request) =>
          terminal ||
          cancellation !== undefined ||
          canonicalTime(request.expiresAt, "Interaction expiry") < nowMs,
      );
      const stillPending = pending.filter((request) => !toResolve.includes(request));
      if (toResolve.length === 0) {
        return {
          kind: "return",
          value: { pending: stillPending, appended: [] },
        };
      }
      let nextSeq = state.lastSeq;
      let ordinal = state.finishedOrder.length;
      const appended = toResolve.map((request) => {
        const outcome: InteractionOutcome =
          terminal || cancellation
            ? {
                t: "cancelled",
                via: terminal
                  ? "run-end"
                  : cancellation!.via === "owner-fence"
                    ? "cancel-fence"
                    : "abort-ticket",
              }
            : { t: "expired" };
        nextSeq += 1;
        ordinal += 1;
        return { requestId: request.requestId, outcome, recordSeq: nextSeq, ordinal };
      });
      return {
        kind: "append",
        entries: appended.map((item) =>
          assignmentRecord(assignmentId, {
            recordSeq: item.recordSeq,
            body: {
              v: 1,
              t: "interaction-finished",
              requestId: item.requestId,
              kind: "allow-once",
              outcome: item.outcome,
            },
          }),
        ),
        value: { pending: stillPending, appended },
      };
    });
    const resolved: InteractionMirrorEntry[] = [];
    if (transaction.commit) {
      resolved.push(
        ...transaction.value.appended.map((item) =>
          validateAssignmentInteractionMirrorEntry({
            ordinal: item.ordinal,
            seq: item.recordSeq,
            requestId: item.requestId,
            kind: "allow-once",
            outcome: item.outcome,
            at: transaction.commit!.at,
          }, this.#verifier),
        ),
      );
    }
    return { pending: transaction.value.pending, resolved };
  }

  /** Close every still-pending interaction before a successful run is sealed. */
  async closePendingInteractionsForRunEnd(
    assignmentId: string,
  ): Promise<number> {
    const transaction = await this.#transact<number>(assignmentId, (state) => {
      if (state.phase !== "started" || state.aborts.length > 0) {
        throw new Error("Run-end interaction closure requires an active started assignment");
      }
      if (state.pendingRequests.size === 0) {
        return { kind: "return", value: 0 };
      }
      let nextSeq = state.lastSeq;
      const entries = [...state.pendingRequests.values()].map((request) => ({
        recordSeq: ++nextSeq,
        body: {
          v: 1 as const,
          t: "interaction-finished" as const,
          requestId: request.body.requestId,
          kind: "allow-once" as const,
          outcome: { t: "cancelled" as const, via: "run-end" as const },
        },
      }));
      return {
        kind: "append",
        entries: entries.map((entry) => assignmentRecord(assignmentId, entry)),
        value: entries.length,
      };
    });
    return transaction.value;
  }

  async stageMutation(
    assignmentId: string,
    input: StagedConversationMutationInput | StagedJobMutationInput,
  ): Promise<{ readonly seq: number }> {
    const candidate = snapshot(input, "Staged mutation input");
    const transaction = await this.#transact<{ seq: number }>(assignmentId, (state) => {
      if (state.mutationRequestIds.has(candidate.requestId)) {
        const existing = state.stagedMutationByRequestId.get(candidate.requestId);
        if (
          !existing ||
          canonicalize({
            domain: existing.domain,
            mutation: existing.mutation,
            requestId: existing.requestId,
            ...(existing.expected ? { expected: existing.expected } : {}),
          }) !== canonicalize(candidate)
        ) {
          throw new Error("Staged mutation requestId has a conflicting payload");
        }
        return { kind: "return", value: { seq: existing.seq } };
      }
      if (state.phase !== "started" || state.aborts.length > 0) {
        throw new Error("Assignment can stage mutations only while started");
      }
      const execution = state.received?.body.activation.ref.execution;
      if (!execution) throw new Error("Assignment has no durable activation");
      const staged = {
        v: 1 as const,
        t: "staged-mutation" as const,
        seq: state.stagedMutations.length + 1,
        ...candidate,
      } as Extract<AssignmentRecord, { t: "staged-mutation" }>;
      if (execution === "job") {
        validateJobStagedMutationRecord(staged);
      } else {
        validateStagedMutationRecord(staged);
      }
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, nextEntry(state, staged))],
        value: { seq: staged.seq },
      };
    }, collectArtifactRefs(candidate));
    return transaction.value;
  }

  async sealConversationBundle(
    assignmentId: string,
    input: ConversationSealInput,
  ): Promise<ReturnType<typeof validateConversationSealedBundle>> {
    const state = await this.#select(assignmentId, (current) => ({
      phase: current.phase,
      received: current.received
        ? snapshot(current.received, "Received seal projection")
        : undefined,
      stagedMutations: current.stagedMutations.map((record) =>
        snapshot(record, "Staged seal mutation"),
      ),
    }));
    if (
      (state.phase !== "started" && state.phase !== "sealed" && state.phase !== "acked") ||
      !state.received
    ) {
      throw new Error("Assignment cannot seal a conversation result before started");
    }
    const envelopeBytes = await this.#artifacts.get(state.received.body.envelope.ref);
    const envelope = validateConversationEnvelope(
      JSON.parse(Buffer.from(envelopeBytes).toString("utf8")) as ConversationEnvelope,
      this.#verifier,
    );
    const staged = state.stagedMutations;
    const runRecordDependencies: ArtifactRef[] = [];
    if (isReferenceContainer(input.runRecord)) {
      const bytes = await this.#artifacts.get(input.runRecord.ref);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text) as TranscriptRunRecord;
      if (canonicalize(parsed) !== text) {
        throw new TypeError("Transcript run record artifact must be canonical JSON");
      }
      validateTranscriptRunRecord(parsed, envelope.work.runId);
      runRecordDependencies.push(...collectArtifactRefs(parsed));
    } else {
      validateTranscriptRunRecord(input.runRecord, envelope.work.runId);
    }
    let batchValue: import("@zhixing/core/contracts").MutationBatch | undefined;
    let batchSummary:
      | { readonly ref: ArtifactRef; readonly sessionCount: number; readonly globalCount: number }
      | undefined;
    if (staged.length > 0) {
      batchValue = createMutationBatch(assignmentId, staged);
      const artifact = mutationBatchArtifact(batchValue);
      const stored = await this.#artifacts.put(artifact.bytes);
      if (canonicalize(stored) !== canonicalize(artifact.ref)) {
        throw new Error("Mutation batch store returned a different reference");
      }
      batchSummary = {
        ref: artifact.ref,
        sessionCount: staged.filter((record) => record.domain === "session").length,
        globalCount: staged.filter((record) => record.domain === "global").length,
      };
    }
    const body = {
      t: "conversation" as const,
      runId: envelope.work.runId,
      conversationId: envelope.work.conversationId,
      ownerEpoch: envelope.work.ownerEpoch,
      baseRevision: envelope.work.baseRevision,
      runRecord: input.runRecord,
      ...(input.windowCompact ? { windowCompact: input.windowCompact } : {}),
      contentAssets: [...input.contentAssets].sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      ),
      ...(batchSummary ? { mutationBatch: batchSummary } : {}),
    };
    const rootRefs = conversationBundleRoots(body);
    const rootDigests = new Set(rootRefs.map((ref) => ref.digest));
    const dependencyArtifacts = collectArtifactRefs([staged, runRecordDependencies])
      .filter((ref) => !rootDigests.has(ref.digest))
      .sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
    const bundle = createConversationSealedBundle({
      assignmentId,
      executorId: this.#executorId,
      streamFinal: input.streamFinal,
      usage: input.usage,
      usageFinal: input.usageFinal,
      dependencyArtifacts,
      body,
    });
    const artifact = sealedBundleArtifact(bundle);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Sealed bundle store returned a different reference");
    }
    await resolveSealedBundleArtifactClosure(bundle, this.#artifacts);
    await this.#recordSealedBundle(
      assignmentId,
      bundle,
      artifact.ref,
      batchValue,
    );
    return bundle;
  }

  async sealJobBundle(
    assignmentId: string,
    input: JobSealInput,
  ): Promise<ReturnType<typeof createJobSealedBundle>> {
    const state = await this.#select(assignmentId, (current) => ({
      phase: current.phase,
      received: current.received
        ? snapshot(current.received, "Received seal projection")
        : undefined,
      stagedMutations: current.stagedMutations.map((record) =>
        snapshot(record, "Staged seal mutation"),
      ),
    }));
    if (
      (state.phase !== "started" && state.phase !== "sealed" && state.phase !== "acked") ||
      !state.received
    ) {
      throw new Error("Assignment cannot seal a job result before started");
    }
    const envelopeBytes = await this.#artifacts.get(state.received.body.envelope.ref);
    const envelope = validateJobEnvelope(
      JSON.parse(Buffer.from(envelopeBytes).toString("utf8")) as JobEnvelope,
      this.#verifier,
    );
    if (canonicalize(input.fence) !== canonicalize(envelope.work.fence)) {
      throw new TypeError("Job seal fence does not match the durable dispatch");
    }
    const staged = state.stagedMutations;
    if (staged.some((record) => record.domain !== "global")) {
      throw corruptLedger("Job assignment contains a session mutation");
    }
    let batchValue: import("@zhixing/core/contracts").MutationBatch | undefined;
    let batchSummary:
      | { readonly ref: ArtifactRef; readonly sessionCount: 0; readonly globalCount: number }
      | undefined;
    if (staged.length > 0) {
      batchValue = createMutationBatch(assignmentId, staged);
      const batchArtifact = mutationBatchArtifact(batchValue);
      const stored = await this.#artifacts.put(batchArtifact.bytes);
      if (canonicalize(stored) !== canonicalize(batchArtifact.ref)) {
        throw new Error("Mutation batch store returned a different reference");
      }
      batchSummary = {
        ref: batchArtifact.ref,
        sessionCount: 0,
        globalCount: staged.length,
      };
    }
    const body = {
      t: "job" as const,
      jobRunId: envelope.work.jobRunId,
      taskId: envelope.work.taskId,
      fence: snapshot(input.fence, "Job commit fence"),
      outcome: snapshot(input.outcome, "Job outcome"),
      contentAssets: [...input.contentAssets].sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      ),
      ...(batchSummary ? { mutationBatch: batchSummary } : {}),
    };
    const rootRefs = jobBundleRoots(body);
    const rootDigests = new Set(rootRefs.map((ref) => ref.digest));
    const dependencyArtifacts = collectArtifactRefs(staged)
      .filter((ref) => !rootDigests.has(ref.digest))
      .sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      );
    const bundle = createJobSealedBundle({
      assignmentId,
      executorId: this.#executorId,
      streamFinal: input.streamFinal,
      usage: input.usage,
      usageFinal: input.usageFinal,
      dependencyArtifacts,
      body,
    });
    const artifact = sealedBundleArtifact(bundle);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Sealed bundle store returned a different reference");
    }
    await resolveSealedBundleArtifactClosure(bundle, this.#artifacts);
    await this.#recordSealedBundle(
      assignmentId,
      bundle,
      artifact.ref,
      batchValue,
    );
    return bundle;
  }

  async sealedBundle(assignmentId: string): Promise<SealedBundle> {
    const projection = await this.#select(assignmentId, (state) => {
      if ((state.phase !== "sealed" && state.phase !== "acked") || !state.sealed) {
        throw new Error("Assignment has no sealed bundle");
      }
      const execution = state.received?.body.activation.ref.execution;
      if (!execution) throw corruptLedger("Sealed assignment has no received activation");
      return {
        sealed: snapshot(state.sealed, "Sealed record"),
        execution,
      };
    });
    return this.#loadSealedBundle(
      assignmentId,
      projection.sealed,
      projection.execution,
    );
  }

  async assignmentArtifactAuthority(assignmentId: string): Promise<{
    readonly capability: AuthorityCapability;
    readonly activation: AnyAssignmentActivationProof;
  }> {
    const received = await this.#select(assignmentId, (state) => {
      if (!state.received) {
        throw new Error("Assignment has no durable received activation");
      }
      return snapshot(state.received.body, "Received artifact authorization");
    });
    const bytes = await this.#artifacts.get(received.envelope.ref);
    const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as AssignmentEnvelope;
    const envelope = raw.execution === "conversation"
      ? validateConversationEnvelope(raw, this.#verifier)
      : validateJobEnvelope(raw, this.#verifier);
    const capability = envelope.capabilities.find((candidate) =>
      received.activation.capIds.includes(candidate.capId) &&
      candidate.assignmentId === assignmentId &&
      candidate.executorId === this.#executorId
    );
    if (!capability) {
      throw corruptLedger("Received assignment has no activated artifact capability");
    }
    const activation = received.activation.ref.execution === "conversation"
      ? received.activation as AssignmentActivationProof<"conversation">
      : received.activation as AssignmentActivationProof<"job">;
    return {
      capability: snapshot(capability, "Artifact authority capability"),
      activation: snapshot(activation, "Artifact activation proof"),
    };
  }

  async sealedBundleForRecovery(
    assignmentId: string,
  ): Promise<
    | { readonly kind: "not-sealed" }
    | { readonly kind: "sealed"; readonly bundle: SealedBundle }
  > {
    const projection = await this.#select(assignmentId, (state) => {
      if (state.phase !== "sealed" && state.phase !== "acked") {
        return undefined;
      }
      if (!state.sealed) throw corruptLedger("Sealed assignment has no sealed record");
      const execution = state.received?.body.activation.ref.execution;
      if (!execution) throw corruptLedger("Sealed assignment has no received activation");
      return {
        sealed: snapshot(state.sealed, "Sealed record"),
        execution,
      };
    });
    if (!projection) return { kind: "not-sealed" };
    return {
      kind: "sealed",
      bundle: await this.#loadSealedBundle(
        assignmentId,
        projection.sealed,
        projection.execution,
      ),
    };
  }

  async sealedConversationAssignmentsAwaitingAcknowledgement(): Promise<
    readonly ConversationEnvelope[]
  > {
    return this.#conversationAssignmentsInPhases(new Set(["sealed"]));
  }

  async recoverableConversationAssignments(): Promise<
    readonly ConversationEnvelope[]
  > {
    const phases = new Set<LedgerSnapshot["phase"]>(["received", "sealed"]);
    return this.#conversationAssignmentsMatching(
      (state) => phases.has(state.phase) && state.aborts.length === 0,
    );
  }

  async recoverableConversationCancellations(): Promise<
    readonly ConversationEnvelope[]
  > {
    return this.#conversationAssignmentsMatching(
      (state) =>
        state.aborts.some((abort) => abort.via === "abort-ticket") &&
        (state.phase === "received" ||
          state.phase === "started" ||
          state.phase === "halted"),
    );
  }

  async conversationAssignmentForRecovery(
    assignmentId: string,
  ): Promise<ConversationEnvelope | undefined> {
    assertIdentifier(assignmentId, "Conversation recovery assignment id");
    const envelopeRef = await this.#select(
      assignmentId,
      (state) => state.received?.body.envelope.ref,
    );
    return envelopeRef
      ? this.#loadConversationEnvelope(assignmentId, envelopeRef)
      : undefined;
  }

  /**
   * job 恢复义务从同一账本状态派生,不建立第二事实源:received 恢复执行,
   * sealed 恢复本地终态标记与 bundle 提交;started 未封包不得重新执行——
   * 失联的 started 归 owner 的 uncertain 裁决,不在恢复集内。
   */
  async recoverableJobAssignments(): Promise<readonly JobEnvelope[]> {
    const phases = new Set<LedgerSnapshot["phase"]>(["received", "sealed"]);
    return this.#jobAssignmentsMatching(
      (state) => phases.has(state.phase) && state.aborts.length === 0,
    );
  }

  /**
   * 独立于业务重执行的交互义务恢复枚举。索引只是 authority log 的可丢弃
   * 派生物；commit log 负责 checkpoint、尾部追平与损坏重建。
   */
  async recoverableJobInteractionAssignments(): Promise<
    readonly JobEnvelope[]
  > {
    const refs = await this.#readJobInteractionRecoveryIndex();
    const envelopes: JobEnvelope[] = [];
    for (const { assignmentId, envelopeRef } of refs) {
      const envelope = await this.#loadJobEnvelope(assignmentId, envelopeRef);
      if (envelope) envelopes.push(envelope);
    }
    return envelopes;
  }

  async jobAssignmentPhaseForRecovery(
    assignmentId: string,
  ): Promise<LedgerSnapshot["phase"] | undefined> {
    assertIdentifier(assignmentId, "Job recovery assignment id");
    return this.#select(assignmentId, (state) =>
      state.received?.body.activation.ref.execution === "job"
        ? state.phase
        : undefined,
    );
  }

  /** 已耐久取消的 job 恢复收束(镜像/stream 与可生成 proof),而非业务执行。 */
  async recoverableJobCancellations(): Promise<readonly JobEnvelope[]> {
    return this.#jobAssignmentsMatching(
      (state) =>
        state.aborts.some((abort) => abort.via === "abort-ticket") &&
        !state.validation.cancelProofOwnerAccepted &&
        state.validation.interactionSettlementOwnerAccepted === undefined,
    );
  }

  async jobAssignmentForRecovery(
    assignmentId: string,
  ): Promise<JobEnvelope | undefined> {
    assertIdentifier(assignmentId, "Job recovery assignment id");
    const envelopeRef = await this.#select(
      assignmentId,
      (state) => state.received?.body.envelope.ref,
    );
    return envelopeRef
      ? this.#loadJobEnvelope(assignmentId, envelopeRef)
      : undefined;
  }

  async hasPendingTicketCancellation(assignmentId: string): Promise<boolean> {
    return this.#select(
      assignmentId,
      (state) =>
        state.aborts.some((abort) => abort.via === "abort-ticket") &&
        !state.validation.cancelProofOwnerAccepted &&
        state.validation.interactionSettlementOwnerAccepted === undefined,
    );
  }

  /** job 的取消由 owner fence 发起;失败路径以此让位给取消收束,避免竞争终态。 */
  async hasPendingOwnerCancellation(assignmentId: string): Promise<boolean> {
    return this.#select(
      assignmentId,
      (state) =>
        state.aborts.some((abort) => abort.via === "owner-fence") &&
        state.phase !== "failed" &&
        state.phase !== "sealed" &&
        state.phase !== "acked",
    );
  }

  async continueTicketCancellation(
    assignmentId: string,
  ): Promise<CancelProofBody | undefined> {
    const abort = await this.#select(assignmentId, (state) =>
      [...state.aborts]
        .reverse()
        .find(
          (
            candidate,
          ): candidate is Extract<
            AssignmentRecord,
            { t: "abort-requested"; via: "abort-ticket" }
          > => candidate.via === "abort-ticket",
        ),
    );
    if (!abort) return undefined;
    return this.#requestAbort(assignmentId, {
      cause: "abort-ticket",
      ticketDigest: abort.refId,
      surfacePrincipal: abort.surfacePrincipal,
    });
  }

  /**
   * owner 已耐久接受 abort-ticket proof 后，在同一 assignment 日志退休本地重提义务。
   * 响应丢失时允许重提同一 proof；只有本记录落盘后恢复枚举才会停止。
   */
  async markTicketCancellationProofOwnerAccepted(
    assignmentId: string,
  ): Promise<boolean> {
    return (
      await this.#transact<boolean>(assignmentId, (state) => {
      if (state.validation.cancelProofOwnerAccepted) {
        return { kind: "return", value: true };
      }
      if (
        state.received?.body.activation.ref.execution !== "job" ||
        state.phase !== "halted" ||
        !state.halted ||
        !state.aborts.some((abort) => abort.via === "abort-ticket")
      ) {
        throw new Error(
          "Ticket cancellation proof cannot be retired before its durable halted proof",
        );
      }
      if (
        !this.#assignmentRecordV2Writes &&
        state.streamProjectionEnabledAfter === undefined
      ) {
        return { kind: "return", value: false };
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntry(state, {
              v: 2,
              t: "cancel-proof-owner-accepted",
            }),
          ),
        ],
        value: true,
      };
      })
    ).value;
  }

  /**
   * Retires an audit-only abort-ticket settlement only after the authenticated
   * owner has durably accepted the exact legacy/v2 settlement request.
   */
  async markInteractionSettlementOwnerAccepted(
    assignmentId: string,
    streamProof: InteractionSettlementStreamProof | undefined,
  ): Promise<boolean> {
    return (
      await this.#transact<boolean>(assignmentId, (state) => {
        const abort = [...state.validation.aborts.values()].find(
          (candidate) => candidate.via === "abort-ticket",
        );
        if (!abort) {
          throw new Error(
            "Interaction settlement acceptance has no durable abort ticket",
          );
        }
        const body = streamProof
          ? ({
              v: 2,
              t: "interaction-settlement-owner-accepted",
              assignmentId,
              ticketDigest: abort.refId,
              settlementVersion: 2,
              streamProof,
            } as const)
          : ({
              v: 2,
              t: "interaction-settlement-owner-accepted",
              assignmentId,
              ticketDigest: abort.refId,
              settlementVersion: 1,
            } as const);
        const existing =
          state.validation.interactionSettlementOwnerAccepted;
        if (existing) {
          if (canonicalize(existing) !== canonicalize(body)) {
            throw new Error(
              "Interaction settlement was already accepted with a different durable identity",
            );
          }
          return { kind: "return", value: true };
        }
        if (
          !this.#assignmentRecordV2Writes &&
          state.streamProjectionEnabledAfter === undefined
        ) {
          return { kind: "return", value: false };
        }
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntry(state, body),
            ),
          ],
          value: true,
        };
      })
    ).value;
  }

  async #conversationAssignmentsInPhases(
    phases: ReadonlySet<LedgerSnapshot["phase"]>,
  ): Promise<readonly ConversationEnvelope[]> {
    return this.#conversationAssignmentsMatching((state) =>
      phases.has(state.phase),
    );
  }

  async #conversationAssignmentsMatching(
    predicate: (state: LedgerProjection) => boolean,
  ): Promise<readonly ConversationEnvelope[]> {
    const envelopes: ConversationEnvelope[] = [];
    for (
      const { assignmentId, envelopeRef } of
      await this.#assignmentEnvelopeRefsMatching(predicate)
    ) {
      const envelope = await this.#loadConversationEnvelope(
        assignmentId,
        envelopeRef,
      );
      if (envelope) envelopes.push(envelope);
    }
    return envelopes;
  }

  async #loadConversationEnvelope(
    assignmentId: string,
    envelopeRef: ArtifactRef,
  ): Promise<ConversationEnvelope | undefined> {
    const envelope = await this.#loadAssignmentEnvelope(
      assignmentId,
      envelopeRef,
    );
    return envelope.execution === "conversation" ? envelope : undefined;
  }

  async #jobAssignmentsMatching(
    predicate: (state: LedgerProjection) => boolean,
  ): Promise<readonly JobEnvelope[]> {
    const envelopes: JobEnvelope[] = [];
    for (
      const { assignmentId, envelopeRef } of
      await this.#assignmentEnvelopeRefsMatching(predicate)
    ) {
      const envelope = await this.#loadJobEnvelope(assignmentId, envelopeRef);
      if (envelope) envelopes.push(envelope);
    }
    return envelopes;
  }

  async #loadJobEnvelope(
    assignmentId: string,
    envelopeRef: ArtifactRef,
  ): Promise<JobEnvelope | undefined> {
    const envelope = await this.#loadAssignmentEnvelope(
      assignmentId,
      envelopeRef,
    );
    return envelope.execution === "job" ? envelope : undefined;
  }

  async #assignmentEnvelopeRefsMatching(
    predicate: (state: LedgerProjection) => boolean,
  ): Promise<
    readonly {
      readonly assignmentId: string;
      readonly envelopeRef: ArtifactRef;
    }[]
  > {
    const assignmentIds = new Set<string>();
    for (const commit of await this.#log.readAll<unknown>()) {
      for (const record of commit.entries) {
        const assignmentId = assignmentIdFromStream(record.stream);
        if (!assignmentId) continue;
        assignmentIds.add(assignmentId);
      }
    }
    const refs: Array<{
      readonly assignmentId: string;
      readonly envelopeRef: ArtifactRef;
    }> = [];
    for (const assignmentId of [...assignmentIds].sort((left, right) =>
      left.localeCompare(right, "en-US"))) {
      const envelopeRef = await this.#select(assignmentId, (state) =>
        predicate(state) && state.received
          ? state.received.body.envelope.ref
          : undefined);
      if (envelopeRef) refs.push({ assignmentId, envelopeRef });
    }
    return refs;
  }

  async #readJobInteractionRecoveryIndex(): Promise<
    readonly {
      readonly assignmentId: string;
      readonly envelopeRef: ArtifactRef;
    }[]
  > {
    const scan = async () => {
      const refs: Array<{
        readonly assignmentId: string;
        readonly envelopeRef: ArtifactRef;
      }> = [];
      let continuation: string | undefined;
      do {
        const page = await this.#jobInteractionRecoveryIndex.scan(
          {
            gte: JOB_INTERACTION_RECOVERY_KEY_PREFIX,
            lt: `${JOB_INTERACTION_RECOVERY_KEY_PREFIX}\uffff`,
          },
          256,
          continuation,
        );
        for (const entry of page.entries) {
          const value = validateJobInteractionRecoveryIndexValue(entry.value);
          if (entry.key !== jobInteractionRecoveryKey(value.assignmentId)) {
            throw new TypeError(
              "Job interaction recovery index value does not bind its key",
            );
          }
          if (!isRecoverableJobInteractionObligation(value)) continue;
          refs.push({
            assignmentId: value.assignmentId,
            envelopeRef: value.envelopeRef,
          });
        }
        continuation = page.continuation;
      } while (continuation);
      return refs;
    };
    try {
      return await scan();
    } catch (error) {
      if (!(error instanceof JobInteractionRecoveryProjectionValueError)) {
        throw error;
      }
      await this.#jobInteractionRecoveryIndex.rebuild();
      return scan();
    }
  }

  async #loadAssignmentEnvelope(
    assignmentId: string,
    envelopeRef: ArtifactRef,
  ): Promise<AssignmentEnvelope> {
    const bytes = await this.#artifacts.get(envelopeRef);
    const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as AssignmentEnvelope;
    if (raw.assignmentId !== assignmentId) {
      throw corruptLedger("Assignment envelope does not bind its ledger");
    }
    return raw.execution === "conversation"
      ? validateConversationEnvelope(raw, this.#verifier)
      : validateJobEnvelope(raw, this.#verifier);
  }

  async cancelProof(assignmentId: string): Promise<CancelProofBody | undefined> {
    return this.#select(assignmentId, (state) =>
      state.halted ? snapshot(state.halted, "Cancel proof") : undefined,
    );
  }

  async #recordSealedBundle(
    assignmentId: string,
    bundle: SealedBundle,
    bundleRef: ArtifactRef,
    mutationBatch?: import("@zhixing/core/contracts").MutationBatch,
  ): Promise<void> {
    const mutationBatchRef = mutationBatchArtifactReference(mutationBatch);
    const references = [
      bundleRef,
      ...(bundle.body.t === "conversation"
        ? conversationBundleRoots(bundle.body)
        : jobBundleRoots(bundle.body)),
      ...bundle.dependencyArtifacts,
      ...(mutationBatchRef ? [mutationBatchRef] : []),
    ];
    const sealed = snapshot(
      {
        v: 1 as const,
        t: "bundle_sealed" as const,
        bundle: { ref: snapshot(bundleRef, "Sealed bundle reference") },
        ...(mutationBatchRef
          ? { mutationBatch: { ref: snapshot(mutationBatchRef, "Mutation batch reference") } }
          : {}),
      },
      "Bundle sealed record",
    );
    await this.#transact<void>(
      assignmentId,
      (state) => {
        if (
          state.phase === "failed" ||
          state.phase === "sealed" ||
          state.phase === "acked"
        ) {
          if (canonicalize(state.sealed) !== canonicalize(sealed)) {
            throw new Error("Assignment already sealed a different bundle payload");
          }
          return { kind: "return", value: undefined };
        }
        if (state.phase !== "started" || state.aborts.length > 0) {
          throw new Error("Assignment cannot seal a bundle before started");
        }
        if ([...state.sideEffects.values()].some((effect) => !effect.completed)) {
          throw new Error("Assignment cannot seal a bundle with an open side effect");
        }
        if (hasPendingInteractionObligations(state)) {
          throw new Error(
            "Assignment cannot seal a bundle before every interaction obligation is complete",
          );
        }
        if (!state.received) {
          throw corruptLedger("Started assignment has no received record");
        }
        const activationRef = state.received.body.activation.ref;
        const bodyMatches = activationRef.execution === "conversation"
          ? bundle.body.t === "conversation" &&
            bundle.body.runId === activationRef.runId &&
            bundle.body.conversationId === activationRef.conversationId
          : bundle.body.t === "job" &&
            bundle.body.jobRunId === activationRef.jobRunId &&
            bundle.body.taskId === activationRef.taskId;
        if (
          !bodyMatches ||
          bundle.assignmentId !== assignmentId ||
          bundle.executorId !== this.#executorId
        ) {
          throw new Error("Sealed bundle does not bind the received assignment");
        }
        if (state.stagedMutations.length === 0) {
          if (mutationBatch || bundle.body.mutationBatch) {
            throw new Error("Sealed bundle declares a mutation batch without staged mutations");
          }
        } else {
          if (!mutationBatch || !mutationBatchRef || !bundle.body.mutationBatch) {
            throw new Error("Sealed bundle omits its staged mutation batch");
          }
          const expected = createMutationBatch(assignmentId, state.stagedMutations);
          if (
            canonicalize(expected) !== canonicalize(mutationBatch) ||
            canonicalize(bundle.body.mutationBatch.ref) !== canonicalize(mutationBatchRef)
          ) {
            throw new Error("Sealed bundle mutation batch is not the current staged prefix");
          }
        }
        return {
          kind: "append",
          entries: [assignmentRecord(assignmentId, nextEntry(state, sealed))],
          value: undefined,
        };
      },
      references,
    );
  }

  async acknowledge(assignmentId: string, commitRevision: number): Promise<void> {
    if (!Number.isSafeInteger(commitRevision) || commitRevision < 0) {
      throw new TypeError("Commit revision must be a non-negative safe integer");
    }
    await this.#transact<void>(assignmentId, (state) => {
      if (state.phase === "acked") {
        if (state.acknowledgedCommitRevision !== commitRevision) {
          throw new Error("Assignment already acknowledged a different commit revision");
        }
        return { kind: "return", value: undefined };
      }
      if (state.phase !== "sealed") {
        throw new Error("Assignment cannot be acknowledged before bundle sealing");
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntry(state, { v: 1, t: "acked", commitRevision }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async #rejectBeforeReceived(
    assignmentId: string,
    dispatchDigest: string,
    error: AuthorityError,
  ): Promise<DispatchResult> {
    const transaction = await this.#transact<DispatchDecision>(assignmentId, (state) => {
      if (state.received) {
        throw new Error("Invalid redelivery cannot change an accepted assignment ledger");
      }
      if (state.rejection) {
        return {
          kind: "return",
          value: {
            kind: "rejected",
            dispatchDigest: state.rejection.body.dispatchDigest,
            error: state.rejection.body.reason,
            recordSeq: state.rejection.recordSeq,
            ledgerDigest: state.rejection.ledgerDigest,
          },
        };
      }
      const entry = nextEntry(state, {
        v: 1,
        t: "dispatch-rejected",
        dispatchDigest,
        reason: error,
      });
      const ledgerDigest = advanceAssignmentLedger(state.chainDigest, entry);
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: {
          kind: "rejected",
          dispatchDigest,
          error,
          recordSeq: entry.recordSeq,
          ledgerDigest,
        },
      };
    });
    if (transaction.value.kind !== "rejected") {
      throw new Error("Dispatch rejection did not produce a rejection result");
    }
    return this.#rejectionResult(
      assignmentId,
      transaction.value.dispatchDigest,
      transaction.value.error,
      transaction.value.recordSeq,
      transaction.value.ledgerDigest,
    );
  }

  async #acceptOwnerControl(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId = ownerControlCallerDeviceId(context),
  ): Promise<void> {
    const transaction = await this.#transact<boolean>(request.assignmentId, (state) => {
      const durableAuthority = state.control?.authority ?? authorityForProjection(state);
      const durableOwnerDeviceId =
        state.control?.ownerDeviceId ??
        state.received?.body.activation.signature.keyId;
      const authority = durableAuthority ?? request.authority;
      const expectedOwnerDeviceId =
        durableOwnerDeviceId ?? request.expectedOwnerDeviceId;
      const authorized = this.#ownerControl.authorize(
        context,
        {
          ...request,
          ...(authority === undefined ? {} : { authority }),
          ...(expectedOwnerDeviceId === undefined
            ? {}
            : { expectedOwnerDeviceId }),
        },
        authenticatedCallerDeviceId,
      );
      if (
        (authority !== undefined &&
          canonicalize(authorized.authority) !== canonicalize(authority)) ||
        (expectedOwnerDeviceId !== undefined &&
          authorized.ownerDeviceId !== expectedOwnerDeviceId)
      ) {
        throw new TypeError("Owner control authority changed during authorization");
      }
      const current = state.control;
      if (current) {
        if (
          canonicalize(current.authority) !== canonicalize(authorized.authority) ||
          current.ownerDeviceId !== authorized.ownerDeviceId ||
          current.lease.controlLeaseId !== authorized.controlLease.controlLeaseId
        ) {
          throw new TypeError("Owner control grant conflicts with durable authority");
        }
        if (authorized.controlLease.renewalSeq < current.lease.renewalSeq) {
          throw new TypeError("Owner control lease renewal sequence regressed");
        }
        if (authorized.controlLease.renewalSeq === current.lease.renewalSeq) {
          if (
            controlLeaseIdentityDigest(authorized.controlLease) !==
            controlLeaseIdentityDigest(current.lease)
          ) {
            throw new TypeError("Owner control lease sequence was reused");
          }
          if (!this.#ownerControlLeaseIsActive(state)) {
            throw new TypeError("Owner control lease is no longer active");
          }
          return { kind: "return", value: true };
        }
      }
      const entry = nextEntry(state, {
        v: 1,
        t: "control-lease-renewed",
        lease: snapshot(authorized.controlLease, "Authorized control lease"),
      });
      return {
        kind: "append",
        entries: [assignmentRecord(request.assignmentId, entry)],
        value: true,
      };
    });
    if (!transaction.value || !this.#ownerControlLeaseIsActive(transaction.state)) {
      throw new TypeError("Owner control lease is no longer active");
    }
  }

  #ownerControlLeaseIsActive(state: LedgerProjection): boolean {
    const control = state.control;
    if (!control) return false;
    const monotonicNow = this.#monotonicClock();
    const cached = this.#ownerControlDeadlines.get(state.assignmentId);
    if (cached?.renewalSeq === control.lease.renewalSeq) {
      return monotonicNow < cached.deadline;
    }
    const now = canonicalTime(this.#clock(), "Owner control local clock");
    const acceptedAt = canonicalTime(
      control.acceptedAt,
      "Control lease local acceptance",
    );
    if (now < acceptedAt) return false;
    const remaining = control.validForMs - (now - acceptedAt);
    if (remaining <= 0) return false;
    this.#ownerControlDeadlines.set(state.assignmentId, {
      renewalSeq: control.lease.renewalSeq,
      deadline: monotonicNow + remaining,
    });
    return true;
  }

  #rejectionResult(
    assignmentId: string,
    dispatchDigest: string,
    error: AuthorityError,
    recordSeq: number,
    ledgerDigest: string,
  ): DispatchResult {
    const payload = {
      v: 1 as const,
      assignmentId,
      executorId: this.#executorId,
      dispatchDigest,
      error,
      lastRecordSeq: recordSeq,
      ledgerDigest,
    };
    const proof: DispatchRejectionProof = snapshot(
      {
        ...payload,
        signature: this.#signer.sign("DispatchRejectionProof", 1, payload),
      },
      "Dispatch rejection proof",
    );
    return {
      v: 1,
      accepted: false,
      outcome: "rejected-before-received",
      error: snapshot(error, "Dispatch rejection error"),
      proof,
    };
  }

  #conflictResult(
    assignmentId: string,
    conflictingDispatchRef: ArtifactRef,
    conflictingPayload: AnyAssignmentActivationPayload,
    received: NonNullable<LedgerProjection["received"]>,
  ): DispatchResult {
    const acceptedPayload = withoutSignature(received.body.activation);
    const payload = {
      v: 1 as const,
      assignmentId,
      executorId: this.#executorId,
      acceptedDispatchRef: received.body.envelope.ref,
      conflictingDispatchRef,
      acceptedActivationDigest: protocolDigest(
        "AssignmentActivationPayload",
        1,
        acceptedPayload,
      ),
      conflictingActivationDigest: protocolDigest(
        "AssignmentActivationPayload",
        1,
        conflictingPayload,
      ),
      receivedRecordSeq: received.recordSeq,
      receivedLedgerDigest: received.ledgerDigest,
      error: { code: "idempotency-conflict" as const, retryable: false as const },
    };
    const proof: DispatchConflictProof = signDispatchConflictProof(payload, this.#signer);
    return {
      v: 1,
      accepted: false,
      outcome: "conflicting-redelivery",
      error: {
        code: "idempotency-conflict",
        retryable: false,
        message: "Assignment id was redelivered with a different activation payload",
      },
      proof,
    };
  }

  async #requestAbort(
    assignmentId: string,
    cause: AbortCause,
    complete = true,
  ): Promise<CancelProofBody | undefined> {
    const prefix = await this.#transact<{
      readonly proof?: CancelProofBody;
      readonly ready: boolean;
    }>(
      assignmentId,
      (state) => {
        if (state.halted) {
          return {
            kind: "return",
            value: { proof: state.halted, ready: false },
          };
        }
        if (
          state.phase === "failed" ||
          state.phase === "sealed" ||
          state.phase === "acked"
        ) {
          return { kind: "return", value: { ready: false } };
        }
        if (state.phase === "dispatch-rejected" || state.supersedeFence) {
          return { kind: "return", value: { ready: false } };
        }
        assertAbortAuthority(state, cause);

        let recordSeq = state.lastSeq;
        const entries: AssignmentEntry[] = [];
        const append = (body: AssignmentRecord) => {
          const entry = {
            recordSeq: ++recordSeq,
            body: snapshot(body, "Cancellation record"),
          };
          entries.push(entry);
        };
        const via = cause.cause === "owner-fence" ? "owner-fence" : "abort-ticket";
        const refId =
          cause.cause === "owner-fence" ? cause.fence.requestId : cause.ticketDigest;
        if (!state.aborts.some((abort) => abort.via === via && abort.refId === refId)) {
          if (cause.cause === "owner-fence") {
            append({
              v: 1,
              t: "abort-requested",
              via: "owner-fence",
              refId: cause.fence.requestId,
            });
          } else {
            append({
              v: 1,
              t: "abort-requested",
              via: "abort-ticket",
              refId: cause.ticketDigest,
              surfacePrincipal: cause.surfacePrincipal,
            });
          }
        }
        for (const request of state.pendingRequests.values()) {
          append({
            v: 1,
            t: "interaction-finished",
            requestId: request.body.requestId,
            kind: "allow-once",
            outcome: {
              t: "cancelled",
              via: cause.cause === "owner-fence" ? "cancel-fence" : "abort-ticket",
            },
          });
        }
        const openEffect = [...state.sideEffects.values()].some(
          (effect) => !effect.completed,
        );
        if (openEffect || hasPendingInteractionObligations(state)) {
          if (entries.length === 0) {
            return { kind: "return", value: { ready: false } };
          }
          return {
            kind: "append",
            entries: entries.map((entry) => assignmentRecord(assignmentId, entry)),
            value: { ready: false },
          };
        }
        if (entries.length === 0) {
          return { kind: "return", value: { ready: true } };
        }
        return {
          kind: "append",
          entries: entries.map((entry) => assignmentRecord(assignmentId, entry)),
          value: { ready: true },
        };
      },
    );
    if (prefix.value.proof) return prefix.value.proof;
    if (!complete || !prefix.value.ready) return undefined;
    return this.#completeAbort(assignmentId, cause);
  }

  async #completeAbort(
    assignmentId: string,
    cause: AbortCause,
  ): Promise<CancelProofBody | undefined> {
    const governed = await this.#select(assignmentId, (state) => {
      const lease = state.received?.resourceLease;
      return lease !== undefined && requiresFormalResourceCoordination(lease);
    });
    const finalUsage = snapshot(
      governed
        ? await this.#usageFinal(assignmentId)
        : zeroAssignmentUsageFinal(assignmentId),
      "Final usage report",
    );
    assertDigest(finalUsage.reportDigest, "Final usage report digest");
    assertNonNegativeSafeInteger(finalUsage.upToUsageSeq, "Final usage sequence");
    const transaction = await this.#transact<CancelProofBody | undefined>(
      assignmentId,
      (state) => {
        if (state.halted) return { kind: "return", value: state.halted };
        if (
          state.phase === "failed" ||
          state.phase === "sealed" ||
          state.phase === "acked" ||
          state.phase === "dispatch-rejected" ||
          state.supersedeFence
        ) {
          return { kind: "return", value: undefined };
        }
        const authority = assertAbortAuthority(state, cause);
        const via = cause.cause === "owner-fence" ? "owner-fence" : "abort-ticket";
        const refId =
          cause.cause === "owner-fence" ? cause.fence.requestId : cause.ticketDigest;
        if (!state.aborts.some((abort) => abort.via === via && abort.refId === refId)) {
          return { kind: "return", value: undefined };
        }
        const openEffect = [...state.sideEffects.values()].some(
          (effect) => !effect.completed,
        );
        if (openEffect || hasPendingInteractionObligations(state)) {
          return { kind: "return", value: undefined };
        }
        const decision = state.started ? "halted" : "not-started";
        const proof = signCancelProof(
          {
            v: 1,
            assignmentId,
            executorId: this.#executorId,
            authority,
            lastRecordSeq: state.lastSeq,
            usageFinal: finalUsage,
            ledgerDigest: state.chainDigest,
            issuedAt: this.#clock(),
            ...(cause.cause === "owner-fence"
              ? { cause: "owner-fence" as const, fence: cause.fence }
              : {
                  cause: "abort-ticket" as const,
                  ticketDigest: cause.ticketDigest,
                  surfacePrincipal: cause.surfacePrincipal,
                }),
            ...(decision === "halted"
              ? {
                  decision: "halted" as const,
                  lastEffectSeq: Math.max(0, ...state.sideEffects.keys()),
                }
              : { decision: "not-started" as const }),
          },
          this.#signer,
        );
        const entry = nextEntry(state, { v: 1, t: "halted", proof });
        return {
          kind: "append",
          entries: [assignmentRecord(assignmentId, entry)],
          value: proof,
        };
      },
    );
    return transaction.value;
  }

  async hasOpenSideEffects(assignmentId: string): Promise<boolean> {
    return this.#select(assignmentId, (state) =>
      [...state.sideEffects.values()].some((effect) => !effect.completed),
    );
  }

  async failExecution(
    assignmentId: string,
    input: {
      readonly reason: string;
      readonly usageFinal: {
        readonly reportDigest: string;
        readonly upToUsageSeq: number;
      };
    },
  ): Promise<Extract<AssignmentRecord, { t: "execution-failed" }> | undefined> {
    assertIdentifier(assignmentId, "Failed assignment id");
    const reason = truncateUtf8(input.reason.trim(), 512);
    if (reason.length === 0) throw new TypeError("Execution failure reason is empty");
    assertDigest(input.usageFinal.reportDigest, "Execution failure report digest");
    assertNonNegativeSafeInteger(
      input.usageFinal.upToUsageSeq,
      "Execution failure usage sequence",
    );
    const failure = snapshot(
      {
        v: 1 as const,
        t: "execution-failed" as const,
        reason,
        usageFinal: snapshot(input.usageFinal, "Execution failure final usage"),
      },
      "Execution failure record",
    );
    const transaction = await this.#transact<
      Extract<AssignmentRecord, { t: "execution-failed" }> | undefined
    >(assignmentId, (state) => {
      if (state.phase === "failed") {
        if (canonicalize(state.failure) !== canonicalize(failure)) {
          throw new Error("Assignment already failed with a different durable result");
        }
        return { kind: "return", value: state.failure };
      }
      if (
        state.phase === "halted" ||
        state.phase === "sealed" ||
        state.phase === "acked"
      ) {
        return { kind: "return", value: undefined };
      }
      if (
        state.phase !== "started" ||
        state.aborts.length > 0 ||
        hasPendingInteractionObligations(state) ||
        [...state.sideEffects.values()].some((effect) => !effect.completed)
      ) {
        throw new Error("Assignment execution failure has no clean started prefix");
      }
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, nextEntry(state, failure))],
        value: failure,
      };
    });
    return transaction.value;
  }

  /**
   * Re-authorizes the frozen permission lease from durable executor facts before
   * every tool call. A signed candidate is inert until `received.activation`
   * binds it, and any fence, termination, or expiry closes it. The validated
   * historical snapshot remains the assignment's policy for its lifetime.
   */
  async authorizeToolExecution(
    assignmentId: string,
    lease:
      | PermissionSnapshotLease<"conversation">
      | PermissionSnapshotLease<"job">,
  ): Promise<readonly PermissionRule[]> {
    return this.#select(assignmentId, (state) => {
      const received = state.received?.body.activation;
      const active =
        state.phase === "started" &&
        state.supersedeFence === undefined &&
        state.aborts.length === 0 &&
        state.halted === undefined;
      const validatedLease = assertActivePermissionSnapshotLease({
        lease,
        verifier: this.#verifier,
        activationDigest: received?.permissionLeaseDigest,
        assignmentId,
        executorId: this.#executorId,
        active,
        now: this.#clock(),
        timeValid: this.#permissionControlIsActive(state, lease),
      });
      if (
        received === undefined ||
        canonicalize(validatedLease.binding) !== canonicalize(received.ref)
      ) {
        throw new TypeError("Permission snapshot lease does not bind received execution");
      }
      const snapshot = this.#permissionSnapshotFor(validatedLease.snapshotDigest);
      if (snapshot === undefined) {
        throw new TypeError("Permission snapshot is unavailable for active execution");
      }
      const validatedSnapshot = validateTrustRuleSnapshot(snapshot, this.#verifier);
      if (
        validatedSnapshot.snapshotVersion !== validatedLease.snapshotVersion ||
        validatedSnapshot.digest !== validatedLease.snapshotDigest
      ) {
        throw new TypeError("Permission snapshot does not match the active lease");
      }
      return validatedSnapshot.rules.map((rule): PermissionRule => ({
        ...rule,
        pattern: { ...rule.pattern },
        ...(rule.contextId === undefined
          ? {}
          : { contextId: structuredClone(rule.contextId) }),
        ...(rule.contributors === undefined
          ? {}
          : { contributors: structuredClone(rule.contributors) }),
        lastMatchedAt: 0,
        matchCount: 0,
      }));
    });
  }

  #permissionControlIsActive(
    state: LedgerProjection,
    lease:
      | PermissionSnapshotLease<"conversation">
      | PermissionSnapshotLease<"job">,
  ): boolean {
    const control = state.control;
    const permission = state.received?.permission;
    if (
      !control ||
      !permission ||
      control.lease.controlLeaseId !== lease.controlLeaseId ||
      permission.controlLeaseId !== lease.controlLeaseId
    ) {
      return false;
    }
    const monotonicNow = this.#monotonicClock();
    const cached = this.#controlDeadlines.get(state.assignmentId);
    if (cached?.renewalSeq === control.lease.renewalSeq) {
      return monotonicNow < cached.deadline;
    }
    const now = canonicalTime(this.#clock(), "Permission guard local clock");
    const controlAcceptedAt = canonicalTime(
      control.acceptedAt,
      "Control lease local acceptance",
    );
    const permissionAcceptedAt = canonicalTime(
      permission.acceptedAt,
      "Permission lease local acceptance",
    );
    if (now < controlAcceptedAt || now < permissionAcceptedAt) return false;
    const controlRemaining =
      control.validForMs - (now - controlAcceptedAt);
    const permissionRemaining =
      permission.validForMs - (now - permissionAcceptedAt);
    if (controlRemaining <= 0 || permissionRemaining <= 0) return false;
    this.#controlDeadlines.set(state.assignmentId, {
      renewalSeq: control.lease.renewalSeq,
      deadline: monotonicNow + Math.min(controlRemaining, permissionRemaining),
    });
    return true;
  }

  async #select<Value>(
    assignmentId: string,
    select: (state: LedgerProjection) => Value,
  ): Promise<Value> {
    assertIdentifier(assignmentId, "Assignment id");
    return this.#operations.run(async () => {
      const cached = this.#takeCachedProjection(assignmentId);
      let state: LedgerProjection;
      try {
        const transaction = await this.#log.transactProjection<
          LedgerProjection,
          AssignmentEntry,
          void
        >(
          cached?.state ?? emptyProjection(assignmentId),
          this.#reduce,
          () => ({ kind: "return", value: undefined }),
          {
            stream: assignmentStream(assignmentId),
            ...(cached ? { cursor: cached.cursor } : {}),
          },
        );
        this.#cacheProjection(assignmentId, {
          state: transaction.state,
          cursor: transaction.cursor,
        });
        state = transaction.state;
      } catch (error) {
        this.#projections.delete(assignmentId);
        this.#controlDeadlines.delete(assignmentId);
        this.#ownerControlDeadlines.delete(assignmentId);
        throw error;
      }
      return select(state);
    });
  }

  async #transact<Value>(
    assignmentId: string,
    decide: (
      state: LedgerProjection,
      context: ProjectionTransactionContext,
    ) => ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    assertIdentifier(assignmentId, "Assignment id");
    return this.#operations.run(async () => {
      const cached = this.#takeCachedProjection(assignmentId);
      try {
        const transact = () => this.#log.transactProjection<
          LedgerProjection,
          unknown,
          Value
        >(
          cached?.state ?? emptyProjection(assignmentId),
          this.#reduce,
          (state, context) => {
            const decision = decide(state, context);
            if (decision.kind !== "append") return decision;
            const resourceRecords = this.#prepareResourceTerminalRecords(
              state,
              decision.entries,
            );
            return {
              ...decision,
              entries: [...resourceRecords, ...decision.entries],
            };
          },
          {
            stream: assignmentStream(assignmentId),
            ...(cached ? { cursor: cached.cursor } : {}),
            candidateReferences,
          },
        );
        const transaction = await (
          this.#resources ? this.#resources.coordinate(transact) : transact()
        );
        this.#cacheProjection(assignmentId, {
          state: transaction.state,
          cursor: transaction.cursor,
        });
        return transaction;
      } catch (error) {
        this.#projections.delete(assignmentId);
        this.#controlDeadlines.delete(assignmentId);
        this.#ownerControlDeadlines.delete(assignmentId);
        throw error;
      }
    });
  }

  #prepareResourceTerminalRecords(
    state: LedgerProjection,
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const terminal = entries
      .filter((record) => record.stream === assignmentStream(state.assignmentId))
      .map((record) => record.body)
      .find((raw): raw is AssignmentEntry => {
        if (typeof raw !== "object" || raw === null || !("body" in raw)) return false;
        const body = raw.body;
        return (
          typeof body === "object" &&
          body !== null &&
          "t" in body &&
          (body.t === "bundle_sealed" ||
            body.t === "halted" ||
            body.t === "execution-failed")
        );
    });
    if (!terminal) return [];
    const lease = state.received?.resourceLease;
    if (!lease) return [];
    if (!requiresExecutorResourceReceipt(lease)) return [];
    if (!this.#resources) {
      throw corruptLedger("Governed assignment has no executor resource coordinator");
    }
    const mode = terminal.body.t === "halted" && terminal.body.proof.decision === "not-started"
      ? "release"
      : "settle-release";
    return this.#resources.prepareTerminal({ lease, mode });
  }

  #takeCachedProjection(
    assignmentId: string,
  ): { readonly state: LedgerProjection; readonly cursor: ProjectionCursor } | undefined {
    const cached = this.#projections.get(assignmentId);
    if (!cached) return undefined;
    this.#projections.delete(assignmentId);
    return cached;
  }

  #cacheProjection(
    assignmentId: string,
    cached: { readonly state: LedgerProjection; readonly cursor: ProjectionCursor },
  ): void {
    this.#projections.set(assignmentId, cached);
    while (this.#projections.size > this.#maxCachedAssignments) {
      const oldest = this.#projections.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#projections.delete(oldest);
      this.#controlDeadlines.delete(oldest);
      this.#ownerControlDeadlines.delete(oldest);
    }
  }

  readonly #reduce = async (
    state: LedgerProjection,
    record: LogicalRecord<unknown>,
    commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  ): Promise<LedgerProjection> => {
    if (record.stream !== assignmentStream(state.assignmentId)) {
      throw corruptLedger("Assignment projection received a different stream");
    }
    const entry = validateAssignmentEntry(record.body, this.#verifier);
    if (entry.recordSeq !== state.lastSeq + 1) {
      throw corruptLedger("Assignment record sequence is not contiguous");
    }
    let receivedEnvelope: AssignmentEnvelope | undefined;
    if (entry.body.t === "received") {
      const bytes = await this.#artifacts.get(entry.body.envelope.ref);
      const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as AssignmentEnvelope;
      const envelope = raw.execution === "conversation"
        ? validateConversationEnvelope(raw, this.#verifier)
        : validateJobEnvelope(raw, this.#verifier);
      receivedEnvelope = envelope;
      if (requiresExecutorResourceReceipt(envelope.resourceLease)) {
        if (!this.#resources) {
          throw corruptLedger("Governed assignment has no executor resource coordinator");
        }
        try {
          this.#resources.assertReceiptRecords({
            lease: envelope.resourceLease,
            records: commit.entries,
            acceptedAt: commit.at,
          });
        } catch (error) {
          throw corruptLedger(
            error instanceof Error
              ? `Executor resource receipt is invalid: ${error.message}`
              : "Executor resource receipt is invalid",
          );
        }
      }
      const artifact = dispatchEnvelopeArtifact(envelope);
      if (canonicalize(artifact.ref) !== canonicalize(entry.body.envelope.ref)) {
        throw corruptLedger("received dispatch artifact reference is inconsistent");
      }
      if (
        envelope.assignmentId !== state.assignmentId ||
        envelope.executorId !== this.#executorId
      ) {
        throw corruptLedger("received dispatch targets a different assignment or executor");
      }
      await this.#assertEnvelopeArtifactsPresent(envelope);
      const control = state.control;
      if (
        !control ||
        !controlLeaseBindsDispatchEnvelope(control.lease, envelope) ||
        envelope.permissionLease.controlLeaseId !== envelope.controlLease.controlLeaseId
      ) {
        throw corruptLedger("received assignment does not bind durable owner control");
      }
      if (envelope.execution === "conversation") {
        validateConversationActivation({
          envelope,
          activation:
            entry.body.activation as AssignmentActivationProof<"conversation">,
          dispatchRef: artifact.ref,
          verifier: this.#verifier,
        });
      } else {
        validateJobActivation({
          envelope,
          activation: entry.body.activation as AssignmentActivationProof<"job">,
          dispatchRef: artifact.ref,
          verifier: this.#verifier,
        });
      }
    }
    if (entry.body.t === "control-lease-renewed") {
      const lease = entry.body.lease;
      acceptedRemoteIntervalRemainingMs({
        issuedAt: lease.issuedAt,
        expiry: lease.expiry,
        acceptedAt: commit.at,
        maxTtlMs: MAX_CONTROL_LEASE_TTL_MS,
      });
    }
    if (entry.body.t === "halted") {
      const proof = validateCancelProof(entry.body.proof, this.#verifier);
      if (proof.executorId !== this.#executorId) {
        throw corruptLedger("Cancel proof names a different executor");
      }
      if (state.received) {
        const ref = state.received.body.activation.ref;
        const authorityMatches = ref.execution === "conversation"
          ? proof.authority.execution === "conversation" &&
            proof.authority.conversationId === ref.conversationId &&
            proof.authority.ownerEpoch === ref.ownerEpoch
          : proof.authority.execution === "job" &&
            proof.authority.taskId === ref.taskId &&
            proof.authority.anchorEpoch === ref.anchorEpoch;
        if (!authorityMatches) {
          throw corruptLedger("Cancel proof authority does not bind the received assignment");
        }
      }
    }
    if (
      entry.body.t === "halted" ||
      entry.body.t === "bundle_sealed" ||
      entry.body.t === "execution-failed"
    ) {
      const lease = state.received?.resourceLease;
      if (lease && requiresExecutorResourceReceipt(lease)) {
        if (!this.#resources) {
          throw corruptLedger("Governed assignment has no executor resource coordinator");
        }
        const mode =
          entry.body.t === "halted" && entry.body.proof.decision === "not-started"
            ? "release"
            : "settle-release";
        try {
          this.#resources.assertTerminalRecords({
            reservationId: lease.reservationId,
            mode,
            records: commit.entries,
          });
        } catch (error) {
          throw corruptLedger(
            error instanceof Error
              ? `Executor resource terminal is invalid: ${error.message}`
              : "Executor resource terminal is invalid",
          );
        }
      }
    }
    if (
      entry.body.t === "staged-mutation" &&
      state.received?.body.activation.ref.execution === "job"
    ) {
      validateJobStagedMutationRecord(entry.body);
    }
    if (entry.body.t === "interaction-requested") {
      await materializeInteractionDisplay(entry.body.display, this.#artifacts);
    }
    const digest = applyValidatedAssignmentEntry(state.validation, entry);
    applyEntry(state, entry, digest, commit.at);
    if (entry.body.t === "received" && receivedEnvelope) {
      if (!state.received) {
        throw corruptLedger("received projection was not materialized");
      }
      state.received.permission = {
        controlLeaseId: receivedEnvelope.permissionLease.controlLeaseId,
        validForMs: acceptedRemoteIntervalRemainingMs({
          issuedAt: receivedEnvelope.permissionLease.issuedAt,
          expiry: receivedEnvelope.permissionLease.expiry,
          acceptedAt: commit.at,
          maxTtlMs: MAX_PERMISSION_LEASE_TTL_MS,
        }),
        acceptedAt: commit.at,
      };
      state.received.resourceLease = snapshot(
        receivedEnvelope.resourceLease,
        "Received resource lease",
      );
      this.#controlDeadlines.delete(state.assignmentId);
    }
    if (entry.body.t === "control-lease-renewed") {
      this.#controlDeadlines.delete(state.assignmentId);
      this.#ownerControlDeadlines.delete(state.assignmentId);
    }
    state.lastSeq = entry.recordSeq;
    state.chainDigest = digest;
    if (
      state.validation.lastSeq !== state.lastSeq ||
      state.validation.chainDigest !== state.chainDigest ||
      state.validation.phase !== state.phase
    ) {
      throw corruptLedger("Assignment validation and executor projection diverged");
    }
    const projectedControl = state.control
      ? {
          authority: state.control.authority,
          ownerDeviceId: state.control.ownerDeviceId,
          controlLeaseId: state.control.lease.controlLeaseId,
          renewalSeq: state.control.lease.renewalSeq,
        }
      : undefined;
    if (
      canonicalize(state.validation.control ?? null) !==
      canonicalize(projectedControl ?? null)
    ) {
      throw corruptLedger("Owner-control validation and executor projection diverged");
    }
    state.entries.push(entry);
    state.ledgerBySeq.push(digest);
    return state;
  };

  async #assertEnvelopeArtifactsPresent(
    envelope: AssignmentEnvelope,
  ): Promise<ArtifactRef[]> {
    return [...(await resolveDispatchArtifactClosure(envelope, this.#artifacts)).transfer];
  }

  async #loadSealedBundle(
    assignmentId: string,
    sealed: Extract<AssignmentRecord, { t: "bundle_sealed" }>,
    expectedExecution: "conversation" | "job",
  ): Promise<SealedBundle> {
    const bytes = await this.#artifacts.get(sealed.bundle.ref);
    const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle;
    const bundle = raw.body.t === "conversation"
      ? validateConversationSealedBundle(raw)
      : validateJobSealedBundle(raw);
    if (bundle.body.t !== expectedExecution) {
      throw corruptLedger("Sealed bundle execution kind differs from its activation");
    }
    const artifact = bundle.body.t === "conversation"
      ? sealedBundleArtifact(bundle)
      : sealedBundleArtifact(bundle);
    if (canonicalize(artifact.ref) !== canonicalize(sealed.bundle.ref)) {
      throw corruptLedger("Sealed bundle artifact reference is inconsistent");
    }
    if (sealed.mutationBatch) {
      if (!bundle.body.mutationBatch) {
        throw corruptLedger("Ledger mutation batch reference is absent from the bundle");
      }
      if (
        canonicalize(sealed.mutationBatch.ref) !==
        canonicalize(bundle.body.mutationBatch.ref)
      ) {
        throw corruptLedger("Ledger mutation batch reference conflicts with the bundle");
      }
      const batchBytes = await this.#artifacts.get(sealed.mutationBatch.ref);
      const candidate = JSON.parse(
        Buffer.from(batchBytes).toString("utf8"),
      ) as import("@zhixing/core/contracts").MutationBatch;
      const batch = expectedExecution === "job"
        ? validateJobMutationBatch(candidate)
        : validateMutationBatch(candidate);
      if (batch.assignmentId !== assignmentId) {
        throw corruptLedger("Mutation batch belongs to a different assignment");
      }
    } else if (bundle.body.mutationBatch) {
      throw corruptLedger("Bundle mutation batch is absent from the ledger seal record");
    }
    await resolveSealedBundleArtifactClosure(bundle, this.#artifacts);
    return bundle;
  }
}

function authorityForProjection(
  state: LedgerProjection,
): AuthorityEpochRef | undefined {
  return state.received === undefined
    ? state.control?.authority
    : authorityForExecutionRef(state.received.body.activation.ref);
}

function authorityForExecutionRef(
  ref: AssignmentActivationProof["ref"],
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

function emptyProjection(assignmentId: string): LedgerProjection {
  return {
    assignmentId,
    validation: createAssignmentLedgerValidationState(assignmentId),
    lastSeq: 0,
    chainDigest: assignmentLedgerSeed(assignmentId),
    phase: "unknown",
    entries: [],
    ledgerBySeq: [],
    requested: new Map(),
    pendingRequests: new Map(),
    finished: new Map(),
    finishedOrder: [],
    finishedIndexBySeq: new Map(),
    aborts: [],
    sideEffects: new Map(),
    stagedMutations: [],
    mutationRequestIds: new Set(),
    stagedMutationByRequestId: new Map(),
    mirroredUpTo: 0,
    mirroredFinishedCount: 0,
    mirroredInteractionOrdinal: 0,
    mirroredInteractionDigest: interactionMirrorSeed(assignmentId),
    streamProjectedUpTo: 0,
    lastInteractionStreamSeq: 0,
  };
}

function hasPendingInteractionObligations(state: LedgerProjection): boolean {
  const lastFinishedRecordSeq = state.finishedOrder.at(-1)?.recordSeq ?? 0;
  return (
    state.pendingRequests.size > 0 ||
    state.mirroredFinishedCount !== state.finishedOrder.length ||
    (state.received?.body.activation.ref.execution === "job" &&
      state.streamProjectionEnabledAfter !== undefined &&
      state.streamProjectedUpTo < lastFinishedRecordSeq)
  );
}

const requiresExecutorResourceReceipt = requiresFormalResourceCoordination;

const JOB_INTERACTION_RECOVERY_KEY_PREFIX =
  "job-interaction-obligation:";

function jobInteractionRecoveryKey(assignmentId: string): string {
  return `${JOB_INTERACTION_RECOVERY_KEY_PREFIX}${assignmentId}`;
}

function interactionRecordSeqFromSource(sourceId: string): number {
  const match = /^interaction:(\d+)$/u.exec(sourceId);
  const recordSeq = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(recordSeq) || recordSeq <= 0) {
    throw new TypeError(
      "Interaction stream source identity is not a positive record sequence",
    );
  }
  return recordSeq;
}

function interactionProjectionSourceIds(
  state: LedgerProjection,
  afterRecordSeq: number,
  upToRecordSeq: number,
): string[] {
  const records = [
    ...[...state.requested.values()].map((item) => item.recordSeq),
    ...[...state.finished.values()].map((item) => item.recordSeq),
  ]
    .filter((recordSeq) =>
      recordSeq > afterRecordSeq && recordSeq <= upToRecordSeq)
    .sort((left, right) => left - right);
  return records.map((recordSeq) => `interaction:${recordSeq}`);
}

/**
 * answered 应答权威的域闸门:按 assignment 的耐久 execution 判别谁有资格
 * 应答。channel-grant 只属于 job,且必须与本 assignment/request 的耐久事实
 * 全绑定、由该 assignment 的耐久 owner key 签发。最终耐久写入口与 channel
 * 预备入口共用本谓词,不得依赖上游是否已经校验过。
 */
function assertAnsweredInteractionAuthority(
  authority: Extract<
    AssignmentInteractionOutcome,
    { readonly t: "answered" }
  >["authority"],
  durable: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ref: ExecutionRef | undefined;
    readonly ownerKeyId: string | undefined;
    readonly requested:
      | Extract<AssignmentRecord, { t: "interaction-requested" }>
      | undefined;
  },
): void {
  if (authority.via !== "channel-grant") return;
  if (!durable.ref || durable.ref.execution !== "job" || !durable.requested) {
    throw new TypeError(
      "Channel interaction grant has no durable pending job request",
    );
  }
  const grant = authority.grant;
  if (
    grant.signature.keyId !== durable.ownerKeyId ||
    grant.challengeToken.signature.keyId !== durable.ownerKeyId
  ) {
    throw new TypeError(
      "Channel interaction grant is not signed by the durable job owner",
    );
  }
  assertChannelInteractionGrantBinding(grant, {
    ref: durable.ref,
    assignmentId: durable.assignmentId,
    interactionRequestId: durable.requestId,
    challengeId: grant.challengeToken.challengeId,
    route: grant.route,
    responder: grant.responder,
    decision: grant.decision,
    toolName: durable.requested.toolName,
    display: durable.requested.display,
  });
}

/** 只探记录种类以决定是否与本索引相关,结构校验仍归 validateAssignmentEntry。 */
function isReceivedAssignmentEntry(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const inner = (body as { readonly body?: unknown }).body;
  if (!inner || typeof inner !== "object") return false;
  return (inner as { readonly t?: unknown }).t === "received";
}

async function reduceJobInteractionRecoveryIndex(
  envelope: CommitEnvelope<unknown>,
  current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier,
): Promise<readonly DurableProjectionMutation[]> {
  const byAssignment = new Map<
    string,
    {
      value: JobInteractionRecoveryIndexValue | undefined;
      touched: boolean;
    }
  >();
  for (const record of envelope.entries) {
    const assignmentId = assignmentIdFromStream(record.stream);
    if (!assignmentId) continue;
    let pending = byAssignment.get(assignmentId);
    if (!pending) {
      const stored = await current.get(jobInteractionRecoveryKey(assignmentId));
      pending = {
        value:
          stored === undefined
            ? undefined
            : validateJobInteractionRecoveryIndexValue(stored),
        touched: false,
      };
      byAssignment.set(assignmentId, pending);
    }
    // 尚未被索引跟踪的 assignment 只有 received 能让它进入索引,其余记录本就
    // 无处可落;不替本索引之外的记录承担校验,交由权威 reducer 在读取时拒绝。
    if (!pending.value && !isReceivedAssignmentEntry(record.body)) continue;
    const entry = validateAssignmentEntry(record.body, verifier);
    const body = entry.body;
    if (body.t === "received") {
      if (body.activation.ref.execution !== "job") {
        pending.value = undefined;
        pending.touched = true;
        continue;
      }
      pending.value = {
        v: 3,
        assignmentId,
        envelopeRef: body.envelope.ref,
        phase: "received",
        pendingInteractions: 0,
        hasInteractionFacts: false,
        maxFinishedSeq: 0,
        mirroredUpTo: 0,
        streamProjectedUpTo: 0,
        hasAbort: false,
        hasAbortTicket: false,
        cancelProofOwnerAccepted: false,
        interactionSettlementOwnerAccepted: false,
      };
      pending.touched = true;
      continue;
    }
    if (!pending.value) continue;
    let next = pending.value;
    switch (body.t) {
      case "dispatch-rejected":
        next = { ...next, phase: "dispatch-rejected" };
        break;
      case "supersede-fenced":
        next = { ...next, phase: "supersede-fenced" };
        break;
      case "started":
        next = { ...next, phase: "started" };
        break;
      case "interaction-requested":
        next = {
          ...next,
          pendingInteractions: next.pendingInteractions + 1,
          hasInteractionFacts: true,
        };
        break;
      case "interaction-finished":
        next = {
          ...next,
          pendingInteractions: Math.max(0, next.pendingInteractions - 1),
          hasInteractionFacts: true,
          maxFinishedSeq: Math.max(next.maxFinishedSeq, entry.recordSeq),
        };
        break;
      case "abort-requested":
        next = {
          ...next,
          hasAbort: true,
          hasAbortTicket:
            next.hasAbortTicket || body.via === "abort-ticket",
        };
        break;
      case "halted":
        next = { ...next, phase: "halted" };
        break;
      case "execution-failed":
        next = { ...next, phase: "failed" };
        break;
      case "bundle_sealed":
        next = { ...next, phase: "sealed" };
        break;
      case "acked":
        next = { ...next, phase: "acked" };
        break;
      case "mirrored":
        next = { ...next, mirroredUpTo: body.upTo };
        break;
      case "interaction-stream-projection-enabled":
        next = {
          ...next,
          streamProjectionEnabledAfter: body.legacyUpToRecordSeq,
          streamProjectedUpTo: body.legacyUpToRecordSeq,
        };
        break;
      case "interaction-stream-projected":
        next = {
          ...next,
          streamProjectedUpTo: body.upToRecordSeq,
        };
        break;
      case "cancel-proof-owner-accepted":
        next = {
          ...next,
          cancelProofOwnerAccepted: true,
        };
        break;
      case "interaction-settlement-owner-accepted":
        next = {
          ...next,
          interactionSettlementOwnerAccepted: true,
        };
        break;
      default:
        break;
    }
    pending.value = next;
    pending.touched = true;
  }
  const mutations: DurableProjectionMutation[] = [];
  for (const [assignmentId, pending] of byAssignment) {
    if (!pending.touched) continue;
    const value = pending.value;
    const retained =
      value !== undefined &&
      (canProduceJobInteractionObligation(value) ||
        isRecoverableJobInteractionObligation(value));
    mutations.push(
      value && retained
        ? {
            kind: "put",
            key: jobInteractionRecoveryKey(assignmentId),
            value: value as unknown as JsonValue,
          }
        : {
            kind: "tombstone",
            key: jobInteractionRecoveryKey(assignmentId),
          },
    );
  }
  return mutations;
}

function validateJobInteractionRecoveryIndexValue(
  input: JsonValue,
): JobInteractionRecoveryIndexValue {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw corruptJobInteractionRecoveryProjection(
      "Job interaction recovery index value is invalid",
    );
  }
  const value = input as Record<string, JsonValue>;
  const keys = Object.keys(value).sort();
  const expected = [
    "assignmentId",
    "cancelProofOwnerAccepted",
    "envelopeRef",
    "hasAbort",
    "hasAbortTicket",
    "hasInteractionFacts",
    "interactionSettlementOwnerAccepted",
    "maxFinishedSeq",
    "mirroredUpTo",
    "pendingInteractions",
    "phase",
    ...(Object.hasOwn(value, "streamProjectionEnabledAfter")
      ? ["streamProjectionEnabledAfter"]
      : []),
    "streamProjectedUpTo",
    "v",
  ].sort();
  if (canonicalize(keys) !== canonicalize(expected)) {
    throw corruptJobInteractionRecoveryProjection(
      "Job interaction recovery index value has unknown fields",
    );
  }
  const ref = value.envelopeRef;
  if (
    value.v !== 3 ||
    typeof value.assignmentId !== "string" ||
    !ref ||
    typeof ref !== "object" ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join(",") !== "bytes,digest" ||
    typeof ref.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(ref.digest) ||
    !Number.isSafeInteger(ref.bytes) ||
    (ref.bytes as number) < 0 ||
    typeof value.hasAbort !== "boolean" ||
    typeof value.hasAbortTicket !== "boolean" ||
    typeof value.cancelProofOwnerAccepted !== "boolean" ||
    typeof value.interactionSettlementOwnerAccepted !== "boolean" ||
    typeof value.hasInteractionFacts !== "boolean" ||
    !Number.isSafeInteger(value.maxFinishedSeq) ||
    (value.maxFinishedSeq as number) < 0 ||
    !Number.isSafeInteger(value.mirroredUpTo) ||
    (value.mirroredUpTo as number) < 0 ||
    (value.streamProjectionEnabledAfter !== undefined &&
      (!Number.isSafeInteger(value.streamProjectionEnabledAfter) ||
        (value.streamProjectionEnabledAfter as number) < 0)) ||
    !Number.isSafeInteger(value.streamProjectedUpTo) ||
    (value.streamProjectedUpTo as number) < 0 ||
    !Number.isSafeInteger(value.pendingInteractions) ||
    (value.pendingInteractions as number) < 0 ||
    typeof value.phase !== "string" ||
    ![
      "unknown",
      "received",
      "dispatch-rejected",
      "supersede-fenced",
      "started",
      "halted",
      "failed",
      "sealed",
      "acked",
    ].includes(value.phase)
  ) {
    throw corruptJobInteractionRecoveryProjection(
      "Job interaction recovery index value is malformed",
    );
  }
  return value as unknown as JobInteractionRecoveryIndexValue;
}

function canProduceJobInteractionObligation(
  value: JobInteractionRecoveryIndexValue,
): boolean {
  return (
    !value.hasAbort &&
    (value.phase === "received" || value.phase === "started")
  );
}

function isRecoverableJobInteractionObligation(
  value: JobInteractionRecoveryIndexValue,
): boolean {
  return (
    (value.hasInteractionFacts &&
      (value.pendingInteractions > 0 ||
        value.maxFinishedSeq > value.mirroredUpTo ||
        (value.streamProjectionEnabledAfter !== undefined &&
          value.maxFinishedSeq > value.streamProjectedUpTo))) ||
    (value.hasAbortTicket &&
      !value.cancelProofOwnerAccepted &&
      !value.interactionSettlementOwnerAccepted)
  );
}

function corruptJobInteractionRecoveryProjection(
  message: string,
): JobInteractionRecoveryProjectionValueError {
  return new JobInteractionRecoveryProjectionValueError(message);
}

class JobInteractionRecoveryProjectionValueError
  extends DurableProjectionStorageError
{
  constructor(message: string) {
    super(message);
    this.name = "JobInteractionRecoveryProjectionValueError";
  }
}

function zeroAssignmentUsageFinal(assignmentId: string): {
  readonly reportDigest: string;
  readonly upToUsageSeq: 0;
} {
  return {
    reportDigest: protocolDigest("AssignmentUsageFinal", 1, {
      assignmentId,
      upToUsageSeq: 0,
    }),
    upToUsageSeq: 0,
  };
}

function applyEntry(
  state: LedgerProjection,
  entry: AssignmentEntry,
  ledgerDigest: string,
  at: string,
): void {
  const body = entry.body;
  switch (body.t) {
    case "received":
      state.phase = "received";
      state.received = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "dispatch-rejected":
      state.phase = "dispatch-rejected";
      state.rejection = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "control-lease-renewed":
      state.control = {
        authority: snapshot(body.lease.authority, "Control lease authority"),
        ownerDeviceId: body.lease.signature.keyId,
        lease: snapshot(body.lease, "Control lease"),
        validForMs: acceptedRemoteIntervalRemainingMs({
          issuedAt: body.lease.issuedAt,
          expiry: body.lease.expiry,
          acceptedAt: at,
          maxTtlMs: MAX_CONTROL_LEASE_TTL_MS,
        }),
        acceptedAt: at,
      };
      return;
    case "supersede-fenced":
      state.phase = "supersede-fenced";
      state.supersedeFence = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "started":
      state.phase = "started";
      state.started = { recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "interaction-stream-projection-enabled":
      state.streamProjectionEnabledAfter = body.legacyUpToRecordSeq;
      state.streamProjectedUpTo = body.legacyUpToRecordSeq;
      return;
    case "interaction-requested":
      const requested = { body, recordSeq: entry.recordSeq };
      state.requested.set(body.requestId, requested);
      state.pendingRequests.set(body.requestId, requested);
      return;
    case "interaction-finished":
      const checkpoint = state.validation.unmirroredFinished.get(entry.recordSeq);
      if (!checkpoint) {
        throw corruptLedger("Validated interaction projection lost its mirror checkpoint");
      }
      const finished = {
        body,
        recordSeq: entry.recordSeq,
        at,
        ordinal: checkpoint.ordinal,
        mirrorDigest: checkpoint.mirrorDigest,
      };
      if (!state.pendingRequests.delete(body.requestId)) {
        throw corruptLedger("Validated interaction projection lost its pending request");
      }
      state.finished.set(body.requestId, finished);
      state.finishedIndexBySeq.set(entry.recordSeq, state.finishedOrder.length);
      state.finishedOrder.push(finished);
      return;
    case "staged-mutation":
      state.stagedMutations.push(body);
      state.mutationRequestIds.add(body.requestId);
      state.stagedMutationByRequestId.set(body.requestId, body);
      return;
    case "side-effect-started":
      state.sideEffects.set(body.effectSeq, { started: body });
      return;
    case "side-effect-completed": {
      const effect = state.sideEffects.get(body.effectSeq);
      if (!effect) throw corruptLedger("Validated side effect projection is missing its start");
      effect.completed = body;
      return;
    }
    case "abort-requested":
      state.aborts.push(body);
      return;
    case "halted": {
      const proof = body.proof;
      state.phase = "halted";
      state.halted = proof;
      return;
    }
    case "execution-failed":
      state.phase = "failed";
      state.failure = body;
      return;
    case "bundle_sealed":
      state.phase = "sealed";
      state.sealed = body;
      return;
    case "acked":
      state.phase = "acked";
      state.acknowledgedCommitRevision = body.commitRevision;
      return;
    case "mirrored":
      const finishedIndex = state.finishedIndexBySeq.get(body.upTo);
      if (finishedIndex === undefined) {
        throw corruptLedger("Validated mirror projection has no finished interaction");
      }
      state.mirroredUpTo = body.upTo;
      state.mirroredFinishedCount = finishedIndex + 1;
      state.mirroredInteractionOrdinal = body.ordinal;
      state.mirroredInteractionDigest = body.mirrorDigest;
      return;
    case "interaction-stream-projected":
      state.streamProjectedUpTo = body.upToRecordSeq;
      state.lastInteractionStreamSeq = body.lastStreamSeq;
      state.interactionStreamDigest = body.streamDigest;
      state.lastStreamProjectionRecordSeq = entry.recordSeq;
      return;
    case "cancel-proof-owner-accepted":
    case "interaction-settlement-owner-accepted":
      return;
    default:
      throw corruptLedger("Unsupported assignment record in this protocol stage");
  }
}

/** In-process executor-to-owner adapter; it exposes only the submission methods implemented here. */
export class InProcessAssignmentSubmission {
  readonly #ledger: ConversationAssignmentLedger;
  readonly #owner: ConversationSubmissionPort;

  constructor(options: InProcessAssignmentSubmissionOptions) {
    this.#ledger = options.ledger;
    this.#owner = options.owner;
  }

  async startAndReport(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<{ readonly started: boolean }> {
    const started = await this.#ledger.start(assignmentId);
    await this.#owner.reportStarted(assignmentId, ctx);
    return started;
  }

  async finishAndMirror(
    assignmentId: string,
    requestId: string,
    outcome: InteractionOutcome,
    ctx: AuthorityCallContext,
  ): Promise<InteractionMirrorEntry> {
    const finished = await this.#ledger.finishInteraction(
      assignmentId,
      requestId,
      outcome,
    );
    await this.flushInteractionMirrors(assignmentId, ctx);
    return finished;
  }

  async flushInteractionMirrors(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<number> {
    let mirrored = 0;
    while (true) {
      const batch = await this.#ledger.pendingInteractionMirrorBatch(assignmentId);
      if (!batch) return mirrored;
      const result = await this.#owner.mirrorInteractions(assignmentId, batch, ctx);
      const last = batch.entries.at(-1)!;
      if (
        result.mirroredUpTo !== last.seq ||
        result.ordinal !== last.ordinal ||
        result.mirrorDigest !== batch.mirrorDigest
      ) {
        throw new Error("Owner returned a mirror receipt outside the submitted batch");
      }
      await this.#ledger.markInteractionsMirrored(assignmentId, result);
      mirrored += batch.entries.length;
    }
  }

  async submitSealedBundle(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  > {
    const bundle = await this.#ledger.sealedBundle(assignmentId);
    const result = await this.#owner.submitBundle(bundle, ctx);
    if (result.committed) {
      try {
        await this.#ledger.acknowledge(assignmentId, result.commitRevision);
      } catch {
        // The owner CAS is already irreversible. Leaving the ledger sealed keeps
        // the durable acknowledgement outbox recoverable without changing the
        // committed disposition returned to the calling surface.
      }
    }
    return result;
  }

  async prepareForRunEnd(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<{ readonly closed: number; readonly mirrored: number }> {
    const closed = await this.#ledger.closePendingInteractionsForRunEnd(assignmentId);
    const mirrored = await this.flushInteractionMirrors(assignmentId, ctx);
    return { closed, mirrored };
  }

  async submitCancellation(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<boolean> {
    await this.flushInteractionMirrors(assignmentId, ctx);
    const proof = await this.#ledger.cancelProof(assignmentId);
    if (!proof) return false;
    await this.#owner.submitCancelProof(assignmentId, proof, ctx);
    return true;
  }

  async abortFromSurfaceAndSubmit(
    assignmentId: string,
    input: SurfaceAbortInput,
    ctx: AuthorityCallContext,
  ): Promise<boolean> {
    await this.#ledger.abortFromSurface(assignmentId, input);
    if (await this.submitCancellation(assignmentId, ctx)) return true;
    await this.#ledger.abortFromSurface(assignmentId, input);
    return this.submitCancellation(assignmentId, ctx);
  }
}

function assertAbortAuthority(
  state: LedgerProjection,
  cause: AbortCause,
): AuthorityEpochRef {
  const receivedRef = state.received?.body.activation.ref;
  const receivedAuthority = receivedRef
    ? receivedRef.execution === "conversation"
      ? {
          execution: "conversation" as const,
          conversationId: receivedRef.conversationId,
          ownerEpoch: receivedRef.ownerEpoch,
        }
      : {
          execution: "job" as const,
          taskId: receivedRef.taskId,
          anchorEpoch: receivedRef.anchorEpoch,
        }
    : undefined;
  const authority =
    cause.cause === "owner-fence" ? cause.authority : receivedAuthority;
  if (!authority) throw new Error("Cancellation has no authority binding");
  if (
    receivedAuthority &&
    canonicalize(receivedAuthority) !== canonicalize(authority)
  ) {
    throw new Error("Cancellation authority does not bind the received assignment");
  }
  return authority;
}

function ledgerSnapshot(state: LedgerProjection): LedgerSnapshot {
  return {
    v: 1,
    assignmentId: state.assignmentId,
    lastSeq: state.lastSeq,
    phase: state.phase,
    ...(state.sealed
      ? {
          sealedBundleRef: snapshot(
            state.sealed.bundle.ref,
            "Sealed bundle reference",
          ),
        }
      : {}),
    ...(state.phase === "acked"
      ? { acknowledgedCommitRevision: state.acknowledgedCommitRevision }
      : {}),
    ...(state.halted ? { cancelProof: snapshot(state.halted, "Cancel proof") } : {}),
    ...(state.failure
      ? {
          failure: {
            reason: state.failure.reason,
            usageFinal: snapshot(
              state.failure.usageFinal,
              "Execution failure final usage",
            ),
          },
        }
      : {}),
  };
}

function ledgerEvidencePayload(
  assignmentId: string,
  executorId: string,
  entries: readonly AssignmentEntry[],
  ledgerBySeq: readonly string[],
) {
  return {
    v: 1 as const,
    assignmentId,
    fromSeq: entries[0]!.recordSeq,
    toSeq: entries.at(-1)!.recordSeq,
    entries: snapshot([...entries], "Ledger evidence entries"),
    chainDigest: ledgerBySeq[entries.at(-1)!.recordSeq - 1]!,
    executorId,
  };
}

function nextEntry(
  state: LedgerProjection,
  body: AssignmentRecord,
): AssignmentEntry {
  return { recordSeq: state.lastSeq + 1, body: snapshot(body, "Assignment record") };
}

function assignmentRecord(
  assignmentId: string,
  entry: AssignmentEntry,
): LogicalRecord<AssignmentEntry> {
  return { stream: assignmentStream(assignmentId), body: entry };
}

function assignmentStream(assignmentId: string): string {
  return `assignment:${assignmentId}`;
}

/**
 * 与 assignment 日志共用同一提交日志、同享 `assignment:` 前缀,但由各自
 * reducer 拥有的子流。assignmentId 自身含冒号,无法按分段区分,只能按子流
 * 后缀排除;新增子流若漏登记,枚举与派生索引会以校验失败 fail-closed。
 */
const ASSIGNMENT_SUB_STREAM_SUFFIXES = [":data-plane-tickets"] as const;

/** 只认本 ledger 自己写入的 assignment 流,子流一律让位给其所有者。 */
function assignmentIdFromStream(stream: string): string | undefined {
  if (!stream.startsWith("assignment:")) return undefined;
  for (const suffix of ASSIGNMENT_SUB_STREAM_SUFFIXES) {
    if (stream.endsWith(suffix)) return undefined;
  }
  return stream.slice("assignment:".length) || undefined;
}

async function interactionRequested(
  input: InteractionRequestInput,
  artifacts: ArtifactStore,
): Promise<{
  readonly body: Extract<AssignmentRecord, { t: "interaction-requested" }>;
  readonly references: readonly ArtifactRef[];
}> {
  const prepared = await prepareInteractionDisplay(input.display, artifacts);
  const display = prepared.display;
  const body = snapshot(
    {
      v: 1 as const,
      t: "interaction-requested" as const,
      requestId: input.requestId,
      kind: "allow-once" as const,
      toolName: input.toolName,
      display,
      issuedAt: input.issuedAt,
      ttlMs: input.ttlMs,
      expiresAt: input.expiresAt,
    },
    "Interaction request",
  );
  validateInteractionRequest(body);
  return {
    body,
    references: prepared.references,
  };
}

function validateInteractionRequest(
  body: Extract<AssignmentRecord, { t: "interaction-requested" }>,
): void {
  assertPlainObject(body, "Interaction request");
  assertExactKeys(
    body,
    ["display", "expiresAt", "issuedAt", "kind", "requestId", "t", "ttlMs", "toolName", "v"],
    "Interaction request",
  );
  if (body.v !== 1 || body.t !== "interaction-requested" || body.kind !== "allow-once") {
    throw new TypeError("Interaction request discriminators are invalid");
  }
  assertIdentifier(body.requestId, "Interaction requestId");
  assertIdentifier(body.toolName, "Interaction toolName");
  if (
    !Number.isSafeInteger(body.ttlMs) ||
    body.ttlMs <= 0
  ) {
    throw new TypeError("Interaction TTL is outside the supported bound");
  }
  const issuedAt = canonicalTime(body.issuedAt, "Interaction issuedAt");
  const expiresAt = canonicalTime(body.expiresAt, "Interaction expiresAt");
  if (expiresAt - issuedAt !== body.ttlMs) {
    throw new TypeError("Interaction expiresAt must equal issuedAt plus ttlMs");
  }
  validateInteractionDisplay(body.display);
  assertInteractionRecordSize(body, "Interaction request");
}

function mirrorEntry(finished: FinishedInteraction): InteractionMirrorEntry {
  return {
    ordinal: finished.ordinal,
    seq: finished.recordSeq,
    requestId: finished.body.requestId,
    kind: "allow-once",
    outcome: snapshot(finished.body.outcome, "Interaction outcome"),
    at: finished.at,
  };
}

function surfaceTicketInteractionOutcome(input: {
  readonly requestId: string;
  readonly ticketId: string;
  readonly surfacePrincipal: string;
  readonly decision: FirstPartyInteractionDecision;
}): ConversationInteractionOutcome {
  const allowed = input.decision.kind === "allow-once";
  const reason =
    input.decision.kind === "deny"
      ? input.decision.reason
      : input.decision.note;
  return validateConversationInteractionOutcome({
    t: "answered",
    authority: { via: "surface-ticket", ticketId: input.ticketId },
    decision: { allowed, ...(reason ? { reason } : {}) },
    decisionDigest: confirmationDecisionDigest(
      input.requestId,
      input.decision,
    ),
    by: input.surfacePrincipal,
  });
}

function surfaceOperationIsTerminal(state: LedgerProjection): boolean {
  return (
    state.halted !== undefined ||
    state.phase === "failed" ||
    state.phase === "sealed" ||
    state.phase === "acked" ||
    state.phase === "dispatch-rejected" ||
    state.supersedeFence !== undefined
  );
}

function selectPendingInteractionMirrors(
  state: LedgerProjection,
  assignmentId: string,
  executorId: string,
): InteractionMirrorEntry[] {
  const entries: InteractionMirrorEntry[] = [];
  for (
    let index = state.mirroredFinishedCount;
    index < state.finishedOrder.length;
    index += 1
  ) {
    if (entries.length === 256) break;
    const finished = state.finishedOrder[index]!;
    const candidate = mirrorEntry(finished);
    const nextEntries = [...entries, candidate];
    const nextBytes = interactionMirrorRecordCapacityBytes({
      assignmentId,
      executorId,
      previousDigest: state.mirroredInteractionDigest,
      entries: nextEntries,
      mirrorDigest: finished.mirrorDigest,
    });
    if (nextBytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
      if (entries.length === 0) {
        throw new Error("A durable interaction outcome cannot fit in a mirror batch");
      }
      break;
    }
    entries.push(candidate);
  }
  return entries;
}

function interactionMirrorRecordBytes(
  assignmentId: string,
  batch: InteractionMirrorBatch,
): number {
  return Buffer.byteLength(
    canonicalize({ t: "interaction-mirror", assignmentId, batch }),
    "utf8",
  );
}

function interactionMirrorRecordCapacityBytes(input: {
  readonly assignmentId: string;
  readonly executorId: string;
  readonly previousDigest: string;
  readonly entries: readonly InteractionMirrorEntry[];
  readonly mirrorDigest: string;
}): number {
  const maxWidthIdentifier = "\0".repeat(480);
  return interactionMirrorRecordBytes(input.assignmentId, {
    v: 1,
    assignmentId: input.assignmentId,
    executorId: input.executorId,
    previousDigest: input.previousDigest,
    entries: [...input.entries],
    mirrorDigest: input.mirrorDigest,
    signature: {
      alg: maxWidthIdentifier,
      keyId: maxWidthIdentifier,
      sig: maxWidthIdentifier,
    },
  } as InteractionMirrorBatch);
}

function assertInteractionRecordSize(value: unknown, label: string): void {
  const largestSequenceWrapper = {
    recordSeq: Number.MAX_SAFE_INTEGER,
    body: value,
  };
  if (
    Buffer.byteLength(canonicalize(largestSequenceWrapper), "utf8") >
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    throw new TypeError(`${label} exceeds the durable protocol limit`);
  }
}

function assertFinishedInteractionFits(
  assignmentId: string,
  executorId: string,
  body: Extract<AssignmentRecord, { t: "interaction-finished" }>,
): void {
  assertInteractionRecordSize(body, "Interaction result");
  const digest = interactionMirrorSeed(assignmentId);
  const bytes = interactionMirrorRecordCapacityBytes({
    assignmentId,
    executorId,
    previousDigest: digest,
    entries: [
      {
        ordinal: Number.MAX_SAFE_INTEGER,
        seq: Number.MAX_SAFE_INTEGER,
        requestId: body.requestId,
        kind: "allow-once",
        outcome: body.outcome,
        at: MAX_WIDTH_CANONICAL_TIME,
      },
    ],
    mirrorDigest: digest,
  });
  if (bytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
    throw new TypeError("Interaction result cannot fit in a durable mirror record");
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function isReferenceContainer(value: unknown): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "ref")
  );
}

function mutationBatchArtifactReference(
  batch: import("@zhixing/core/contracts").MutationBatch | undefined,
): ArtifactRef | undefined {
  return batch ? mutationBatchArtifact(batch).ref : undefined;
}

function assertExactKeys(
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

function assertDispatchIdentity(
  envelope: AssignmentEnvelope,
  executorId: string,
): string {
  assertIdentifier(envelope?.assignmentId, "Dispatch assignmentId");
  if (envelope.executorId !== executorId) {
    throw new TypeError("Dispatch targets a different executor");
  }
  return envelope.assignmentId;
}

function invalidDispatchError(error: unknown): AuthorityError {
  return {
    code: "invalid",
    message: error instanceof Error ? error.message : "Dispatch validation failed",
    retryable: false,
  };
}

function withoutSignature<T extends { readonly signature: unknown }>(
  proof: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = proof;
  return snapshot(payload, "Assignment activation payload");
}

function streamInteractionOutcome(
  outcome: Extract<
    AssignmentRecord,
    { readonly t: "interaction-finished" }
  >["outcome"],
): "allowed" | "denied" | "cancelled" | "expired" {
  switch (outcome.t) {
    case "answered":
      return outcome.decision.allowed ? "allowed" : "denied";
    case "auto-resolved":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
  }
}

function ownerControlCallerDeviceId(context: AuthorityCallContext): string {
  if (context.principal.kind !== "owner-control") {
    throw new Error("Executor control requires an owner grant");
  }
  return context.principal.grant.callerDeviceId;
}

function canonicalTime(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertBoundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new TypeError(`${label} must be a bounded string`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
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

function assertFence(
  value: { readonly fenceSeq: number; readonly requestId: string },
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== "fenceSeq\0requestId") {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
  assertPositiveSafeInteger(value.fenceSeq, `${label} sequence`);
  assertIdentifier(value.requestId, `${label} requestId`);
}

function corruptLedger(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}

export { ConversationAssignmentLedger as AssignmentLedger };
