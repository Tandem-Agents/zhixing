import type {
  AssignmentActivationProof,
  AssignmentMutationOverlayRecord,
  AssignmentRecord,
  AssignmentStagedReceipt,
  AuthorityCallContext,
  AuthorityCapability,
  AuthorityError,
  CancelProofBody,
  ChannelInteractionGrant,
  DispatchResult,
  ExecutionAbortRequest,
  InteractionMirrorBatch,
  InteractionMirrorEntry,
  InteractionSettlementStreamProof,
  LedgerEvidencePage,
  LedgerSnapshot,
  PermissionSnapshotLease,
  RunDispatchArguments,
  RunExecutorPort,
  SealedBundle,
  StreamConsumerAuth,
  SupersedeProof,
  TrustRuleHitFact,
  TrustSedimentFact,
} from "@zhixing-ai/core/contracts";
import {
  assertProtocolIdentifier as assertIdentifier,
  type ConversationInteractionOutcome,
  type DataPlaneTicketUse,
  type validateConversationSealedBundle,
  type validateFirstPartyInteractionDecision,
  type createJobSealedBundle,
} from "@zhixing-ai/core/protocol";
import type { PermissionRule } from "@zhixing-ai/core/security";
import {
  AssignmentLeaseClock,
  leaseClockProjectionId,
  registerLeaseClockProjection,
} from "../assignment-lease-clock.js";
import { registerAssignmentLedgerIndex } from "../assignment-ledger-index.js";
import type { ExecutorExecutionScope } from "../resource-governor.js";
import {
  DEFAULT_MAX_CACHED_ASSIGNMENTS,
  DEFAULT_MAX_PENDING_INTERACTIONS,
  type AnyAssignmentActivationProof,
  type AssignmentLedgerOptions,
  type AssignmentSubmissionPort,
  type ChannelInteractionAnswerPreparation,
  type ConversationDispatchPort,
  type ConversationEnvelope,
  type ConversationSealInput,
  type ConversationSubmissionPort,
  type DurableInteractionStreamEvent,
  type InteractionMirrorReceipt,
  type InteractionOutcome,
  type InteractionRecoveryResult,
  type InteractionRequestDisposition,
  type InteractionRequestInput,
  type InteractionStreamProjectionReceipt,
  type JobEnvelope,
  type JobRecoveryObligationPage,
  type JobSealInput,
  type OwnerControlPreflightPort,
  type OwnerControlRequest,
  type PendingAssignmentInteraction,
  type SideEffectInput,
  type StagedConversationMutationInput,
  type StagedJobMutationInput,
  type SurfaceAbortDisposition,
  type SurfaceAbortInput,
  type SurfaceInteractionAnswerPreparation,
} from "./contracts.js";
import {
  LedgerExecutionControl,
  zeroAssignmentUsageFinal,
} from "./execution-control.js";
import { LedgerInteractionEffect } from "./interaction-effect.js";
import { LedgerProjectionHistoryStore } from "./projection-history-store.js";
import { LedgerReceiptRecovery } from "./receipt-recovery.js";
import { LedgerSealingEvidence } from "./sealing-evidence.js";
import { registerExecutorJobRecoveryProjection } from "./state-replay.js";

export interface InProcessAssignmentSubmissionOptions {
  readonly ledger: ConversationAssignmentLedger;
  readonly owner: AssignmentSubmissionPort;
}

/** Durable executor-side assignment protocol shared by conversation and job execution. */
export class ConversationAssignmentLedger
  implements
    ConversationDispatchPort,
    RunExecutorPort,
    OwnerControlPreflightPort
{
  readonly #store: LedgerProjectionHistoryStore;
  readonly #executionControl: LedgerExecutionControl;
  readonly #interactionEffect: LedgerInteractionEffect;
  readonly #sealingEvidence: LedgerSealingEvidence;
  readonly #receiptRecovery: LedgerReceiptRecovery;

  constructor(options: AssignmentLedgerOptions) {
    assertIdentifier(options.executorId, "Executor id");
    const clock = options.clock ?? (() => new Date().toISOString());
    const leaseTime = new AssignmentLeaseClock(
      clock,
      options.monotonicClock ?? (() => performance.now()),
    );
    const usageFinal =
      options.usageFinal ??
      ((assignmentId) => zeroAssignmentUsageFinal(assignmentId));
    const assignmentRecordV2Writes =
      options.assignmentRecordV2Writes ?? false;
    const jobRecoveryIndex = registerExecutorJobRecoveryProjection(
      options.log,
      options.verifier,
    );
    registerAssignmentLedgerIndex(options.log, options.verifier);
    registerLeaseClockProjection(options.log, options.executorId);
    const leaseClockId = leaseClockProjectionId(options.executorId);
    const maxPendingInteractions =
      options.maxPendingInteractions ?? DEFAULT_MAX_PENDING_INTERACTIONS;
    if (
      !Number.isSafeInteger(maxPendingInteractions) ||
      maxPendingInteractions <= 0
    ) {
      throw new TypeError(
        "Maximum pending interactions must be a positive safe integer",
      );
    }
    const maxCachedAssignments =
      options.maxCachedAssignments ?? DEFAULT_MAX_CACHED_ASSIGNMENTS;
    if (
      !Number.isSafeInteger(maxCachedAssignments) ||
      maxCachedAssignments <= 0
    ) {
      throw new TypeError(
        "Maximum cached assignments must be a positive safe integer",
      );
    }

    this.#store = new LedgerProjectionHistoryStore({
      log: options.log,
      artifacts: options.artifacts,
      executorId: options.executorId,
      signer: options.signer,
      verifier: options.verifier,
      ...(options.resources ? { resources: options.resources } : {}),
      leaseClockProjectionId: leaseClockId,
      maxCachedAssignments,
    });

    this.#receiptRecovery = new LedgerReceiptRecovery({
      store: this.#store,
      log: options.log,
      executorId: options.executorId,
      signer: options.signer,
      verifier: options.verifier,
      ...(options.resources ? { resources: options.resources } : {}),
      jobRecoveryIndex,
      assignmentRecordV2Writes,
      runReconcileSupersededReceipts: () => this.reconcileSupersededReceipts(),
      requestAbort: () =>
        Promise.reject(new Error("Execution control is not bound")),
    });

    this.#executionControl = new LedgerExecutionControl({
      store: this.#store,
      artifacts: options.artifacts,
      executorId: options.executorId,
      signer: options.signer,
      verifier: options.verifier,
      ownerControl: options.ownerControl,
      snapshotFor: options.snapshotFor,
      permissionSnapshotFor: options.permissionSnapshotFor,
      ...(options.runtimeBindingGuard
        ? { runtimeBindingGuard: options.runtimeBindingGuard }
        : {}),
      clock,
      leaseTime,
      usageFinal,
      ...(options.resources ? { resources: options.resources } : {}),
      ...(options.surfaceAbort ? { surfaceAbort: options.surfaceAbort } : {}),
      ...(options.dataPlaneTickets
        ? { dataPlaneTickets: options.dataPlaneTickets }
        : {}),
      reconcileSupersededReceipts: () => this.reconcileSupersededReceipts(),
      runExecutionResourceRetired: (assignmentId) =>
        this.executionResourceRetired(assignmentId),
    });

    this.#receiptRecovery.bindRequestAbort((assignmentId, cause, complete) =>
      this.#executionControl.requestAbort(assignmentId, cause, complete),
    );

    this.#interactionEffect = new LedgerInteractionEffect({
      store: this.#store,
      artifacts: options.artifacts,
      executorId: options.executorId,
      signer: options.signer,
      verifier: options.verifier,
      ownerControl: options.ownerControl,
      clock,
      ...(options.dataPlaneTickets
        ? { dataPlaneTickets: options.dataPlaneTickets }
        : {}),
      maxPendingInteractions,
      assignmentRecordV2Writes,
      prepareExecutionAuthority: (assignmentId, terminalReplay) =>
        this.#executionControl.prepareExecutionAuthority(
          assignmentId,
          terminalReplay,
        ),
      runEnableInteractionStreamProjection: (assignmentId) =>
        this.enableInteractionStreamProjection(assignmentId),
      runDataPlaneBinding: (assignmentId) =>
        this.dataPlaneBinding(assignmentId),
      runInteractionSettlementStreamProof: (assignmentId) =>
        this.interactionSettlementStreamProof(assignmentId),
    });

    this.#sealingEvidence = new LedgerSealingEvidence({
      store: this.#store,
      artifacts: options.artifacts,
      executorId: options.executorId,
      verifier: options.verifier,
      acceptOwnerControl: (context, request) =>
        this.#executionControl.acceptOwnerControl(context, request),
    });
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
    ...args: RunDispatchArguments
  ): Promise<DispatchResult> {
    return this.#executionControl.dispatch(...args);
  }

  async preflightOwnerControl(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId: string,
  ): Promise<void> {
    await this.#executionControl.preflightOwnerControl(
      context,
      request,
      authenticatedCallerDeviceId,
    );
  }

  async queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    return this.#sealingEvidence.queryLedger(assignmentId, ctx, range);
  }

  async cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    await this.beginOwnerCancellation(assignmentId, fence, ctx);
    await this.finishOwnerCancellation(assignmentId, fence, ctx);
  }

  async beginOwnerCancellation(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    await this.#executionControl.beginOwnerCancellation(
      assignmentId,
      fence,
      ctx,
    );
  }

  async finishOwnerCancellation(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    await this.#executionControl.finishOwnerCancellation(
      assignmentId,
      fence,
      ctx,
    );
  }

  async abortFromSurface(
    assignmentId: string,
    input: SurfaceAbortInput,
  ): Promise<void> {
    await this.#executionControl.abortFromSurface(assignmentId, input);
  }

  async abortWithTicket(
    input: ExecutionAbortRequest,
  ): Promise<SurfaceAbortDisposition> {
    return this.#executionControl.abortWithTicket(input);
  }

  async supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    return this.#executionControl.supersede(assignmentId, fence, ctx);
  }

  openExecutionScope(assignmentId: string): ExecutorExecutionScope {
    return this.#executionControl.openExecutionScope(assignmentId);
  }

  async executionResourceRetired(assignmentId: string): Promise<boolean> {
    return this.#executionControl.executionResourceRetired(assignmentId);
  }

  async start(assignmentId: string): Promise<{ readonly started: boolean }> {
    return this.#executionControl.start(assignmentId);
  }

  async startSideEffect(
    assignmentId: string,
    input: SideEffectInput,
  ): Promise<{ readonly effectSeq: number }> {
    return this.#interactionEffect.startSideEffect(assignmentId, input);
  }

  async completeSideEffect(
    assignmentId: string,
    effectSeq: number,
    result: {
      readonly status: "ok" | "failed" | "aborted";
      readonly resultDigest?: string;
    },
  ): Promise<void> {
    await this.#interactionEffect.completeSideEffect(
      assignmentId,
      effectSeq,
      result,
    );
  }

  async requestInteraction(
    assignmentId: string,
    input: InteractionRequestInput,
  ): Promise<InteractionRequestDisposition> {
    return this.#interactionEffect.requestInteraction(assignmentId, input);
  }

  async finishInteraction(
    assignmentId: string,
    requestId: string,
    outcome: InteractionOutcome,
  ): Promise<InteractionMirrorEntry> {
    return this.#interactionEffect.finishInteraction(
      assignmentId,
      requestId,
      outcome,
    );
  }

  async recordTrustSediment(
    assignmentId: string,
    sediment: TrustSedimentFact,
  ): Promise<{ readonly requestId: string; readonly recordSeq: number }> {
    return this.#interactionEffect.recordTrustSediment(assignmentId, sediment);
  }

  async recordTrustRuleHit(
    assignmentId: string,
    hit: TrustRuleHitFact,
  ): Promise<{ readonly requestId: string; readonly recordSeq: number }> {
    return this.#interactionEffect.recordTrustRuleHit(assignmentId, hit);
  }

  async jobInteractionOutcome(
    assignmentId: string,
    requestId: string,
  ): Promise<InteractionOutcome | undefined> {
    return this.#interactionEffect.jobInteractionOutcome(
      assignmentId,
      requestId,
    );
  }

  async conversationInteractionOutcome(
    assignmentId: string,
    requestId: string,
  ): Promise<ConversationInteractionOutcome | undefined> {
    return this.#interactionEffect.conversationInteractionOutcome(
      assignmentId,
      requestId,
    );
  }

  async pendingInteractionRequests(
    assignmentId: string,
  ): Promise<readonly PendingAssignmentInteraction[]> {
    return this.#interactionEffect.pendingInteractionRequests(assignmentId);
  }

  async interactionStreamEvents(
    assignmentId: string,
    afterRecordSeq = 0,
  ): Promise<readonly DurableInteractionStreamEvent[]> {
    return this.#interactionEffect.interactionStreamEvents(
      assignmentId,
      afterRecordSeq,
    );
  }

  async prepareInteractionAnswerFromSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decision: Parameters<
      typeof validateFirstPartyInteractionDecision
    >[0];
  }): Promise<SurfaceInteractionAnswerPreparation> {
    return this.#interactionEffect.prepareInteractionAnswerFromSurface(input);
  }

  async prepareInteractionAnswerFromChannel(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly grant: ChannelInteractionGrant;
    readonly at?: string;
  }): Promise<ChannelInteractionAnswerPreparation> {
    return this.#interactionEffect.prepareInteractionAnswerFromChannel(input);
  }

  async dataPlaneBinding(assignmentId: string, use?: DataPlaneTicketUse) {
    return this.#store.dataPlaneBinding(assignmentId, use);
  }

  async dataPlaneBindings(
    requests: readonly {
      readonly assignmentId: string;
      readonly use?: DataPlaneTicketUse;
    }[],
  ) {
    return this.#store.dataPlaneBindings(requests);
  }

  async authorizeOwnerRelay(input: {
    readonly assignmentId: string;
    readonly consumer: Extract<
      StreamConsumerAuth,
      { readonly kind: "owner-relay" }
    >;
    readonly ownerDeviceId: string;
  }): Promise<void> {
    await this.#executionControl.authorizeOwnerRelay(input);
  }

  async pendingInteractionMirrors(
    assignmentId: string,
  ): Promise<InteractionMirrorEntry[]> {
    return this.#receiptRecovery.pendingInteractionMirrors(assignmentId);
  }

  async pendingInteractionMirrorBatch(
    assignmentId: string,
  ): Promise<InteractionMirrorBatch | undefined> {
    return this.#receiptRecovery.pendingInteractionMirrorBatch(assignmentId);
  }

  async markInteractionsMirrored(
    assignmentId: string,
    receipt: InteractionMirrorReceipt,
  ): Promise<void> {
    await this.#receiptRecovery.markInteractionsMirrored(assignmentId, receipt);
  }

  async enableInteractionStreamProjection(
    assignmentId: string,
  ): Promise<number | undefined> {
    return this.#interactionEffect.enableInteractionStreamProjection(
      assignmentId,
    );
  }

  async interactionStreamProjectionEnabled(
    assignmentId: string,
  ): Promise<boolean> {
    return this.#interactionEffect.interactionStreamProjectionEnabled(
      assignmentId,
    );
  }

  async interactionStreamProjectedUpTo(
    assignmentId: string,
  ): Promise<number | undefined> {
    return this.#interactionEffect.interactionStreamProjectedUpTo(assignmentId);
  }

  async markInteractionStreamProjected(
    assignmentId: string,
    receipts: readonly InteractionStreamProjectionReceipt[],
  ): Promise<void> {
    await this.#interactionEffect.markInteractionStreamProjected(
      assignmentId,
      receipts,
    );
  }

  async interactionSettlementRequest(
    assignmentId: string,
  ): Promise<
    | { readonly settlementVersion: 1 }
    | {
        readonly settlementVersion: 2;
        readonly streamProof?: InteractionSettlementStreamProof;
      }
  > {
    return this.#interactionEffect.interactionSettlementRequest(assignmentId);
  }

  async interactionSettlementStreamProof(
    assignmentId: string,
  ): Promise<InteractionSettlementStreamProof> {
    return this.#interactionEffect.interactionSettlementStreamProof(
      assignmentId,
    );
  }

  async recoverInteractions(
    assignmentId: string,
    now?: string,
  ): Promise<InteractionRecoveryResult> {
    return this.#interactionEffect.recoverInteractions(assignmentId, now);
  }

  async closePendingInteractionsForRunEnd(
    assignmentId: string,
  ): Promise<number> {
    return this.#interactionEffect.closePendingInteractionsForRunEnd(
      assignmentId,
    );
  }

  async stageMutation(
    assignmentId: string,
    input: StagedConversationMutationInput | StagedJobMutationInput,
  ): Promise<AssignmentStagedReceipt> {
    return this.#sealingEvidence.stageMutation(assignmentId, input);
  }

  async readStagedMutationOverlay(
    assignmentId: string,
  ): Promise<readonly AssignmentMutationOverlayRecord[]> {
    return this.#sealingEvidence.readStagedMutationOverlay(assignmentId);
  }

  async sealConversationBundle(
    assignmentId: string,
    input: ConversationSealInput,
  ): Promise<ReturnType<typeof validateConversationSealedBundle>> {
    return this.#sealingEvidence.sealConversationBundle(assignmentId, input);
  }

  async sealJobBundle(
    assignmentId: string,
    input: JobSealInput,
  ): Promise<ReturnType<typeof createJobSealedBundle>> {
    return this.#sealingEvidence.sealJobBundle(assignmentId, input);
  }

  async sealedBundle(assignmentId: string): Promise<SealedBundle> {
    return this.#sealingEvidence.sealedBundle(assignmentId);
  }

  async assignmentArtifactAuthority(assignmentId: string): Promise<{
    readonly capability: AuthorityCapability;
    readonly activation: AnyAssignmentActivationProof;
  }> {
    return this.#sealingEvidence.assignmentArtifactAuthority(assignmentId);
  }

  async sealedBundleForRecovery(
    assignmentId: string,
  ): Promise<
    | { readonly kind: "not-sealed" }
    | { readonly kind: "sealed"; readonly bundle: SealedBundle }
  > {
    return this.#sealingEvidence.sealedBundleForRecovery(assignmentId);
  }

  async sealedConversationAssignmentsAwaitingAcknowledgement(): Promise<
    readonly ConversationEnvelope[]
  > {
    return this.#receiptRecovery.sealedConversationAssignmentsAwaitingAcknowledgement();
  }

  reconcileSupersededReceipts(): Promise<number> {
    return this.#receiptRecovery.reconcileSupersededReceipts();
  }

  async recoverableConversationAssignments(): Promise<
    readonly ConversationEnvelope[]
  > {
    return this.#receiptRecovery.recoverableConversationAssignments();
  }

  async recoverableConversationCancellations(): Promise<
    readonly ConversationEnvelope[]
  > {
    return this.#receiptRecovery.recoverableConversationCancellations();
  }

  async conversationAssignmentForRecovery(
    assignmentId: string,
  ): Promise<ConversationEnvelope | undefined> {
    return this.#receiptRecovery.conversationAssignmentForRecovery(
      assignmentId,
    );
  }

  async recoverableJobObligations(input: {
    readonly limit: number;
    readonly continuation?: string;
  }): Promise<JobRecoveryObligationPage> {
    return this.#receiptRecovery.recoverableJobObligations(input);
  }

  async jobAssignmentPhaseForRecovery(
    assignmentId: string,
  ): Promise<LedgerSnapshot["phase"] | undefined> {
    return this.#receiptRecovery.jobAssignmentPhaseForRecovery(assignmentId);
  }

  async jobAssignmentForRecovery(
    assignmentId: string,
  ): Promise<JobEnvelope | undefined> {
    return this.#receiptRecovery.jobAssignmentForRecovery(assignmentId);
  }

  async hasPendingTicketCancellation(assignmentId: string): Promise<boolean> {
    return this.#receiptRecovery.hasPendingTicketCancellation(assignmentId);
  }

  async hasPendingOwnerCancellation(assignmentId: string): Promise<boolean> {
    return this.#receiptRecovery.hasPendingOwnerCancellation(assignmentId);
  }

  async continueTicketCancellation(
    assignmentId: string,
  ): Promise<CancelProofBody | undefined> {
    return this.#receiptRecovery.continueTicketCancellation(assignmentId);
  }

  async markTicketCancellationProofOwnerAccepted(
    assignmentId: string,
  ): Promise<boolean> {
    return this.#receiptRecovery.markTicketCancellationProofOwnerAccepted(
      assignmentId,
    );
  }

  async markInteractionSettlementOwnerAccepted(
    assignmentId: string,
    settlement:
      | { readonly settlementVersion: 1 }
      | {
          readonly settlementVersion: 2;
          readonly streamProof?: InteractionSettlementStreamProof;
        },
  ): Promise<boolean> {
    return this.#receiptRecovery.markInteractionSettlementOwnerAccepted(
      assignmentId,
      settlement,
    );
  }

  async cancelProof(assignmentId: string): Promise<CancelProofBody | undefined> {
    return this.#sealingEvidence.cancelProof(assignmentId);
  }

  async acknowledge(assignmentId: string, commitRevision: number): Promise<void> {
    await this.#receiptRecovery.acknowledge(assignmentId, commitRevision);
  }

  async hasOpenSideEffects(assignmentId: string): Promise<boolean> {
    return this.#interactionEffect.hasOpenSideEffects(assignmentId);
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
    return this.#sealingEvidence.failExecution(assignmentId, input);
  }

  async authorizeToolExecution(
    assignmentId: string,
    lease:
      | PermissionSnapshotLease<"conversation">
      | PermissionSnapshotLease<"job">,
  ): Promise<readonly PermissionRule[]> {
    return this.#executionControl.authorizeToolExecution(assignmentId, lease);
  }

  async flushDecisionStates(): Promise<void> {
    await this.#store.flushDecisionStates();
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
      const batch =
        await this.#ledger.pendingInteractionMirrorBatch(assignmentId);
      if (!batch) return mirrored;
      const result = await this.#owner.mirrorInteractions(
        assignmentId,
        batch,
        ctx,
      );
      const last = batch.entries.at(-1)!;
      if (
        result.mirroredUpTo !== last.seq ||
        result.ordinal !== last.ordinal ||
        result.mirrorDigest !== batch.mirrorDigest
      ) {
        throw new Error(
          "Owner returned a mirror receipt outside the submitted batch",
        );
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
    const closed =
      await this.#ledger.closePendingInteractionsForRunEnd(assignmentId);
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
    if (proof.cause === "abort-ticket") {
      await this.#ledger.markTicketCancellationProofOwnerAccepted(assignmentId);
    }
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

export { ConversationAssignmentLedger as AssignmentLedger };
