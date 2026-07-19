import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  collectArtifactRefs,
  type ArtifactStore,
  type AuthorityCommitLog,
  type ProjectionCursor,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AuthorityCallContext,
  AuthorityEpochRef,
  AuthorityError,
  CancelProofBody,
  DispatchConflictProof,
  DispatchRejectionProof,
  DispatchResult,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
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
  RunDispatchArguments,
  RunExecutorPort,
} from "@zhixing/core/contracts";
import {
  assertProtocolIdentifier as assertIdentifier,
  advanceAssignmentLedger,
  advanceInteractionMirrorDigest,
  applyValidatedAssignmentEntry,
  assignmentActivationDigest,
  assignmentLedgerSeed,
  canonicalize,
  conversationBundleRoots,
  createJobSealedBundle,
  createConversationSealedBundle,
  createMutationBatch,
  createAssignmentLedgerValidationState,
  createSignedConversationInteractionMirrorBatch,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  jobBundleRoots,
  mutationBatchArtifact,
  interactionMirrorSeed,
  materializeInteractionDisplay,
  protocolDigest,
  prepareInteractionDisplay,
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
  validateConversationInteractionMirrorEntry,
  validateConversationInteractionOutcome,
  validateConversationActivation,
  validateConversationEnvelope,
  validateJobActivation,
  validateJobEnvelope,
  validateJobSealedBundle,
  validateInteractionDisplay,
  validateCancelProof,
  type ConversationInteractionMirrorEntry,
  type ConversationInteractionMirrorBatch,
  type ConversationInteractionOutcome,
  type AssignmentLedgerValidationState,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
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

export interface OwnerControlAuthorizer {
  authorize(
    context: AuthorityCallContext,
    method:
      | "executor.dispatch"
      | "executor.cancel"
      | "executor.supersede"
      | "executor.queryLedger",
    assignmentId: string,
  ): void;
}

export interface AssignmentLedgerOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly ownerControl: OwnerControlAuthorizer;
  readonly clock?: () => string;
  readonly usageFinal?: (
    assignmentId: string,
  ) => { readonly reportDigest: string; readonly upToUsageSeq: number };
  readonly surfaceAbort?: {
    authorize(assignmentId: string, input: SurfaceAbortInput): void;
  };
  readonly maxPendingInteractions?: number;
  readonly maxCachedAssignments?: number;
}

export interface AssignmentSubmissionPort {
  reportStarted(assignmentId: string, ctx: AuthorityCallContext): Promise<void>;
  mirrorInteractions(
    assignmentId: string,
    batch: ConversationInteractionMirrorBatch,
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

export type InteractionOutcome = ConversationInteractionOutcome;

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
  readonly resolved: readonly ConversationInteractionMirrorEntry[];
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
  sealed?: Extract<AssignmentRecord, { t: "bundle_sealed" }>;
  received?: {
    readonly body: Extract<AssignmentRecord, { t: "received" }>;
    readonly recordSeq: number;
    readonly ledgerDigest: string;
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
  mirroredUpTo: number;
  mirroredFinishedCount: number;
  mirroredInteractionOrdinal: number;
  mirroredInteractionDigest: string;
  acknowledgedCommitRevision?: number;
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

const MAX_LEDGER_PAGE = 256;
const DEFAULT_MAX_PENDING_INTERACTIONS = 32;
const DEFAULT_MAX_CACHED_ASSIGNMENTS = 64;
const MAX_WIDTH_CANONICAL_TIME = "+275760-09-13T00:00:00.000Z";

/** Durable executor-side assignment protocol shared by conversation and job execution. */
export class ConversationAssignmentLedger implements ConversationDispatchPort, RunExecutorPort {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #ownerControl: OwnerControlAuthorizer;
  readonly #clock: () => string;
  readonly #usageFinal: NonNullable<AssignmentLedgerOptions["usageFinal"]>;
  readonly #surfaceAbort: AssignmentLedgerOptions["surfaceAbort"];
  readonly #maxPendingInteractions: number;
  readonly #maxCachedAssignments: number;
  readonly #operations = new SerialTaskQueue();
  readonly #projections = new Map<
    string,
    { readonly state: LedgerProjection; readonly cursor: ProjectionCursor }
  >();

  constructor(options: AssignmentLedgerOptions) {
    assertIdentifier(options.executorId, "Executor id");
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#ownerControl = options.ownerControl;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    // A missing usage reporter is represented explicitly as zero-usage evidence.
    // When a reporter is configured, its signed UsageReport digest replaces this
    // domain-separated fallback in cancel proofs.
    this.#usageFinal =
      options.usageFinal ??
      ((assignmentId) => ({
        reportDigest: protocolDigest("AssignmentUsageFinal", 1, {
          assignmentId,
          upToUsageSeq: 0,
        }),
        upToUsageSeq: 0,
      }));
    this.#surfaceAbort = options.surfaceAbort;
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
    const assignmentId = assertDispatchIdentity(rawEnvelope, this.#executorId);
    this.#ownerControl.authorize(ctx, "executor.dispatch", assignmentId);
    const artifact = dispatchEnvelopeArtifact(rawEnvelope);
    const dispatchDigest = dispatchEnvelopeDigest(rawEnvelope);

    let envelope: AssignmentEnvelope;
    let envelopeReferences: ArtifactRef[];
    let activation: AnyAssignmentActivationProof;
    let activationPayload: AnyAssignmentActivationPayload;
    try {
      envelope = rawEnvelope.execution === "conversation"
        ? validateConversationEnvelope(rawEnvelope, this.#verifier)
        : validateJobEnvelope(rawEnvelope, this.#verifier);
      if (
        (await this.#artifacts.put(artifact.bytes)).digest !== artifact.ref.digest
      ) {
        throw new TypeError("Dispatch artifact store returned a different digest");
      }
      envelopeReferences = await this.#assertEnvelopeArtifactsPresent(envelope);
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

    const transaction = await this.#transact<DispatchDecision>(
      assignmentId,
      (state) => {
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
        const entry = nextEntry(state, {
          v: 1,
          t: "received",
          envelope: { ref: artifact.ref },
          activation: activation as unknown as AssignmentActivationProof,
        });
        return {
          kind: "append",
          entries: [assignmentRecord(assignmentId, entry)],
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

  async queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    assertIdentifier(assignmentId, "Assignment id");
    this.#ownerControl.authorize(ctx, "executor.queryLedger", assignmentId);
    if (
      range &&
      (!Number.isSafeInteger(range.fromSeq) ||
        range.fromSeq <= 0 ||
        !Number.isSafeInteger(range.limit) ||
        range.limit <= 0 ||
        range.limit > MAX_LEDGER_PAGE)
    ) {
      throw new RangeError(`Ledger evidence range must be within 1..${MAX_LEDGER_PAGE}`);
    }
    return this.#select(assignmentId, (state) => {
      if (!range) return snapshot(ledgerSnapshot(state), "Ledger snapshot");
      const entries = state.entries.slice(
        range.fromSeq - 1,
        range.fromSeq - 1 + range.limit,
      );
      if (entries.length === 0) {
        throw new RangeError("Ledger evidence range starts beyond the durable ledger");
      }
      const payload = {
        v: 1 as const,
        assignmentId,
        fromSeq: entries[0]!.recordSeq,
        toSeq: entries.at(-1)!.recordSeq,
        entries: snapshot(entries, "Ledger evidence entries"),
        chainDigest: state.ledgerBySeq[entries.at(-1)!.recordSeq - 1]!,
        executorId: this.#executorId,
      };
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
    assertFence(fence, "Cancel fence");
    this.#ownerControl.authorize(ctx, "executor.cancel", assignmentId);
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

  async supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    assertFence(fence, "Supersede fence");
    this.#ownerControl.authorize(ctx, "executor.supersede", assignmentId);
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
      if (state.phase === "dispatch-rejected" || state.phase === "halted") {
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
  ): Promise<ConversationInteractionMirrorEntry> {
    assertIdentifier(requestId, "Interaction requestId");
    const validatedOutcome = validateConversationInteractionOutcome(outcome);
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
      const mirrorDigest = advanceInteractionMirrorDigest(
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
    return validateConversationInteractionMirrorEntry({
      ordinal: transaction.value.ordinal!,
      seq: transaction.value.recordSeq!,
      requestId,
      kind: "allow-once",
      outcome: validatedOutcome,
      at: transaction.commit!.at,
    });
  }

  async pendingInteractionMirrors(
    assignmentId: string,
  ): Promise<ConversationInteractionMirrorEntry[]> {
    return this.#select(assignmentId, (state) =>
      selectPendingInteractionMirrors(state, assignmentId, this.#executorId),
    );
  }

  async pendingInteractionMirrorBatch(
    assignmentId: string,
  ): Promise<ConversationInteractionMirrorBatch | undefined> {
    const selected = await this.#select(assignmentId, (state) => ({
      previousDigest: state.mirroredInteractionDigest,
      entries: selectPendingInteractionMirrors(
        state,
        assignmentId,
        this.#executorId,
      ),
    }));
    if (selected.entries.length === 0) return undefined;
    const batch = createSignedConversationInteractionMirrorBatch({
      assignmentId,
      executorId: this.#executorId,
      previousDigest: selected.previousDigest,
      entries: selected.entries,
      signer: this.#signer,
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
      const terminal = state.phase === "sealed" || state.phase === "acked";
      const toResolve = pending.filter(
        (request) => terminal || canonicalTime(request.expiresAt, "Interaction expiry") < nowMs,
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
        const outcome: InteractionOutcome = terminal
          ? { t: "cancelled", via: "run-end" }
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
    const resolved: ConversationInteractionMirrorEntry[] = [];
    if (transaction.commit) {
      resolved.push(
        ...transaction.value.appended.map((item) =>
          validateConversationInteractionMirrorEntry({
            ordinal: item.ordinal,
            seq: item.recordSeq,
            requestId: item.requestId,
            kind: "allow-once",
            outcome: item.outcome,
            at: transaction.commit!.at,
          }),
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
    for (const ref of [...conversationBundleRoots(bundle.body), ...bundle.dependencyArtifacts]) {
      if (!(await this.#artifacts.has(ref))) {
        throw new Error(`Sealed bundle dependency is not present: ${ref.digest}`);
      }
    }
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
    for (const ref of [...jobBundleRoots(bundle.body), ...bundle.dependencyArtifacts]) {
      if (!(await this.#artifacts.has(ref))) {
        throw new Error(`Sealed bundle dependency is not present: ${ref.digest}`);
      }
    }
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
        if (state.phase === "sealed" || state.phase === "acked") {
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
        if (state.pendingRequests.size > 0) {
          throw new Error(
            "Assignment cannot seal a bundle before every pending interaction is closed",
          );
        }
        if (state.mirroredFinishedCount !== state.finishedOrder.length) {
          throw new Error(
            "Assignment cannot seal a bundle before every finished interaction is mirrored",
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
      acceptedActivationDigest: assignmentActivationDigest(acceptedPayload),
      conflictingActivationDigest: assignmentActivationDigest(
        conflictingPayload as AssignmentActivationPayload,
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
  ): Promise<CancelProofBody | undefined> {
    const transaction = await this.#transact<CancelProofBody | undefined>(
      assignmentId,
      (state) => {
        if (state.halted) return { kind: "return", value: state.halted };
        if (state.phase === "sealed" || state.phase === "acked") {
          return { kind: "return", value: undefined };
        }
        if (state.phase === "dispatch-rejected" || state.supersedeFence) {
          return { kind: "return", value: undefined };
        }

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
        if (!authority) {
          throw new Error("Cancellation has no authority binding");
        }
        if (
          receivedAuthority &&
          canonicalize(receivedAuthority) !== canonicalize(authority)
        ) {
          throw new Error("Cancellation authority does not bind the received assignment");
        }

        let recordSeq = state.lastSeq;
        let ledgerDigest = state.chainDigest;
        const entries: AssignmentEntry[] = [];
        const append = (body: AssignmentRecord) => {
          const entry = {
            recordSeq: ++recordSeq,
            body: snapshot(body, "Cancellation record"),
          };
          ledgerDigest = advanceAssignmentLedger(ledgerDigest, entry);
          entries.push(entry);
        };
        const via = cause.cause === "owner-fence" ? "owner-fence" : "abort-ticket";
        const refId =
          cause.cause === "owner-fence" ? cause.fence.requestId : cause.ticketDigest;
        if (!state.aborts.some((abort) => abort.via === via && abort.refId === refId)) {
          append({ v: 1, t: "abort-requested", via, refId });
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
        const hasUnmirroredInteraction =
          state.mirroredFinishedCount !== state.finishedOrder.length ||
          state.pendingRequests.size > 0;
        if (openEffect || hasUnmirroredInteraction) {
          return {
            kind: entries.length === 0 ? "return" : "append",
            ...(entries.length === 0
              ? { value: undefined }
              : {
                  entries: entries.map((entry) => assignmentRecord(assignmentId, entry)),
                  value: undefined,
                }),
          } as ProjectionTransactionDecision<AssignmentEntry, CancelProofBody | undefined>;
        }
        const usageFinal = snapshot(this.#usageFinal(assignmentId), "Final usage report");
        assertDigest(usageFinal.reportDigest, "Final usage report digest");
        assertNonNegativeSafeInteger(usageFinal.upToUsageSeq, "Final usage sequence");
        const decision = state.started ? "halted" : "not-started";
        const proof = signCancelProof(
          {
            v: 1,
            assignmentId,
            executorId: this.#executorId,
            authority,
            lastRecordSeq: recordSeq,
            usageFinal,
            ledgerDigest,
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
        append({ v: 1, t: "halted", proof });
        return {
          kind: "append",
          entries: entries.map((entry) => assignmentRecord(assignmentId, entry)),
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
        throw error;
      }
      return select(state);
    });
  }

  async #transact<Value>(
    assignmentId: string,
    decide: (
      state: LedgerProjection,
    ) => ProjectionTransactionDecision<AssignmentEntry, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    assertIdentifier(assignmentId, "Assignment id");
    return this.#operations.run(async () => {
      const cached = this.#takeCachedProjection(assignmentId);
      try {
        const transaction = await this.#log.transactProjection<
          LedgerProjection,
          AssignmentEntry,
          Value
        >(
          cached?.state ?? emptyProjection(assignmentId),
          this.#reduce,
          decide,
          {
            stream: assignmentStream(assignmentId),
            ...(cached ? { cursor: cached.cursor } : {}),
            candidateReferences,
          },
        );
        this.#cacheProjection(assignmentId, {
          state: transaction.state,
          cursor: transaction.cursor,
        });
        return transaction;
      } catch (error) {
        this.#projections.delete(assignmentId);
        throw error;
      }
    });
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
    }
  }

  readonly #reduce = async (
    state: LedgerProjection,
    record: LogicalRecord<AssignmentEntry>,
    commit: import("@zhixing/core/contracts").CommitEnvelope<AssignmentEntry>,
  ): Promise<LedgerProjection> => {
    if (record.stream !== assignmentStream(state.assignmentId)) {
      throw corruptLedger("Assignment projection received a different stream");
    }
    const entry = validateAssignmentEntry(record.body, this.#verifier);
    if (entry.recordSeq !== state.lastSeq + 1) {
      throw corruptLedger("Assignment record sequence is not contiguous");
    }
    if (entry.body.t === "received") {
      const bytes = await this.#artifacts.get(entry.body.envelope.ref);
      const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as AssignmentEnvelope;
      const envelope = raw.execution === "conversation"
        ? validateConversationEnvelope(raw, this.#verifier)
        : validateJobEnvelope(raw, this.#verifier);
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
    state.lastSeq = entry.recordSeq;
    state.chainDigest = digest;
    if (
      state.validation.lastSeq !== state.lastSeq ||
      state.validation.chainDigest !== state.chainDigest ||
      state.validation.phase !== state.phase
    ) {
      throw corruptLedger("Assignment validation and executor projection diverged");
    }
    state.entries.push(entry);
    state.ledgerBySeq.push(digest);
    return state;
  };

  async #assertEnvelopeArtifactsPresent(
    envelope: AssignmentEnvelope,
  ): Promise<ArtifactRef[]> {
    const references = collectArtifactRefs(envelope);
    for (const ref of references) {
      if (!(await this.#artifacts.has(ref))) {
        throw new TypeError(`Dispatch dependency is not present: ${ref.digest}`);
      }
    }
    return references;
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
    return bundle;
  }
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
    case "supersede-fenced":
      state.phase = "supersede-fenced";
      state.supersedeFence = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "started":
      state.phase = "started";
      state.started = { recordSeq: entry.recordSeq, ledgerDigest };
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
  ): Promise<ConversationInteractionMirrorEntry> {
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

function mirrorEntry(finished: FinishedInteraction): ConversationInteractionMirrorEntry {
  return validateConversationInteractionMirrorEntry({
    ordinal: finished.ordinal,
    seq: finished.recordSeq,
    requestId: finished.body.requestId,
    kind: "allow-once",
    outcome: snapshot(finished.body.outcome, "Interaction outcome"),
    at: finished.at,
  });
}

function selectPendingInteractionMirrors(
  state: LedgerProjection,
  assignmentId: string,
  executorId: string,
): ConversationInteractionMirrorEntry[] {
  const entries: ConversationInteractionMirrorEntry[] = [];
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
  batch: ConversationInteractionMirrorBatch,
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
  readonly entries: readonly ConversationInteractionMirrorEntry[];
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
  } as ConversationInteractionMirrorBatch);
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
        outcome: body.outcome as ConversationInteractionOutcome,
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

function withoutSignature(
  proof: AssignmentActivationProof,
): AssignmentActivationPayload {
  const { signature: _, ...payload } = proof;
  return snapshot(payload, "Assignment activation payload");
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
