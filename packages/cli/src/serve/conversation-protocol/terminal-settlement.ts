import type { FinalFrame, PublishResultNotice } from "@zhixing-ai/core/contracts";
import type { RunResult } from "@zhixing-ai/core/loop";
import { SerialTaskQueue } from "@zhixing-ai/core/persistence";
import { canonicalize } from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError,
} from "@zhixing-ai/core/resources";
import {
  createConversationControlEnvelope,
  type ConversationControlEnvelope,
} from "@zhixing-ai/owner-kernel/control-admission";
import type {
  ConversationRunJournal,
  InProcessConversationDispatcher,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import type {
  DurableConversationCancelInput,
  DurableConversationCancellationDisposition,
  DurableConversationCancellationResult,
  DurableConversationResolutionResult,
  DurableConversationResolveInput,
} from "@zhixing-ai/owner-kernel/run-turn";
import { retryControlAdmission } from "../conversation-admission-retry.js";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationExecutorDispatchApplication,
  ConversationExecutorDispatchPlan,
} from "../conversation-executor-dispatch.js";
import type { ConversationOwnerRuntimeStack } from "../conversation-owner-runtime.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import type {
  FirstPartyFinalitySession,
  FirstPartyFinalitySessionOptions,
} from "../first-party-finality-session.js";
import type {
  FirstPartySurfaceSession,
  LosslessDataPlaneSession,
} from "../lossless-data-plane-runtime.js";
import type { AdmissionAndLifecycle } from "./admission-lifecycle.js";
import type { ConversationAccess } from "./conversation-access.js";
import {
  executionFailureReason,
  isFinishedRunState,
  type AuthorityScopeState,
  type CapturedRunAttemptHandle,
  type RuntimeObligationScope,
} from "./runtime-obligation-scope.js";

export interface TerminalSettlementHost {
  scheduleResolvedRetry(
    conversationId: string,
    runId: string,
    journal: ConversationRunJournal,
    scopeState?: AuthorityScopeState,
  ): Promise<void>;
}

export interface TerminalSettlementOptions {
  readonly authority: ConversationOwnerRuntimeStack;
  readonly scope: RuntimeObligationScope;
  readonly access: ConversationAccess;
  readonly admission: AdmissionAndLifecycle;
  readonly host: TerminalSettlementHost;
  readonly requiredManager: () => ConversationManager;
  readonly clock: () => string;
  readonly executorDispatch: ConversationExecutorDispatchApplication;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly interactions: DurableConversationInteractionObserver;
  readonly onFinal?: (frame: FinalFrame) => void | Promise<void>;
  readonly onPublishResult?: (notice: PublishResultNotice) => void | Promise<void>;
  readonly createFirstPartyFinality?: (
    input: Omit<FirstPartyFinalitySessionOptions, "sources">,
  ) => FirstPartyFinalitySession;
  readonly observeFailure: (
    error: unknown,
    context: {
      readonly phase: "run" | "recovery";
      readonly conversationId: string;
      readonly runId?: string;
    },
  ) => void;
}

export interface FirstPartyTailDrainInput {
  readonly capturedScope: AuthorityScopeState;
  readonly conversationId: string;
  readonly runId: string;
  readonly finalSeq: number;
  readonly finalIdentity?: string;
  readonly finality: FirstPartyFinalitySession | undefined;
  readonly surface: FirstPartySurfaceSession;
}

export interface RunAttemptCleanupResources {
  readonly attempt: CapturedRunAttemptHandle;
  readonly assignmentId: string;
  readonly getChannelSession: () => LosslessDataPlaneSession | undefined;
  readonly getFirstPartyStreamFinalSeq: () => number | undefined;
  readonly drainFirstPartyProjection: (finalSeq: number, finalIdentity?: string) => void;
  readonly getFirstPartyFinalitySession: () => FirstPartyFinalitySession | undefined;
  readonly getFirstPartySurfaceSession: () => FirstPartySurfaceSession | undefined;
  readonly getExecutorPlan: () => ConversationExecutorDispatchPlan | undefined;
  readonly getExecutionScope: () => { close(): void } | undefined;
  readonly runFailed: boolean;
  readonly runError: unknown;
}

/**
 * Owns terminal serial queue, cancellation/uncertain settlement, final frame
 * publication, `routeRevision`-guarded settled route retirement, and
 * cross-generation-safe `run()` `finally` cleanup (`cleanupRunAttempt`).
 */
export class TerminalSettlement {
  readonly terminalOperations = new SerialTaskQueue();
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #scope: RuntimeObligationScope;
  readonly #access: ConversationAccess;
  readonly #admission: AdmissionAndLifecycle;
  readonly #host: TerminalSettlementHost;
  readonly #requiredManager: () => ConversationManager;
  readonly #clock: () => string;
  readonly #executorDispatch: ConversationExecutorDispatchApplication;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #onFinal: TerminalSettlementOptions["onFinal"];
  readonly #onPublishResult: TerminalSettlementOptions["onPublishResult"];
  readonly #observeFailure: TerminalSettlementOptions["observeFailure"];
  #createFirstPartyFinality: TerminalSettlementOptions["createFirstPartyFinality"];
  #deliveryDrain: (() => Promise<void>) | undefined;

  constructor(options: TerminalSettlementOptions) {
    this.#authority = options.authority;
    this.#scope = options.scope;
    this.#access = options.access;
    this.#admission = options.admission;
    this.#host = options.host;
    this.#requiredManager = options.requiredManager;
    this.#clock = options.clock;
    this.#executorDispatch = options.executorDispatch;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    this.#interactions = options.interactions;
    this.#onFinal = options.onFinal;
    this.#onPublishResult = options.onPublishResult;
    this.#createFirstPartyFinality = options.createFirstPartyFinality;
    this.#observeFailure = options.observeFailure;
  }

  get createFirstPartyFinality() {
    return this.#createFirstPartyFinality;
  }

  bindFirstPartyFinality(
    factory: NonNullable<TerminalSettlementOptions["createFirstPartyFinality"]>,
  ): void {
    if (this.#createFirstPartyFinality) {
      throw new Error("First-party finality is already bound");
    }
    this.#createFirstPartyFinality = factory;
  }

  bindDeliveryDrain(drain: () => Promise<void>): void {
    this.#deliveryDrain = drain;
  }

  kickDelivery(
    onFailure?: (error: unknown, runResult: RunResult) => void,
    runResult?: RunResult,
  ): void {
    if (!this.#deliveryDrain) return;
    void this.#deliveryDrain().catch((error) => {
      if (onFailure && runResult) onFailure(error, runResult);
    });
  }

  async cancelAdmitted(conversationId: string, runId: string): Promise<void> {
    const request = {
      runId,
      requestId: `cancel:pending:${runId}`,
    };
    await this.#access.adopt(conversationId);
    const scopeState = this.#scope.current;
    const journal = this.#access.journal(conversationId, scopeState);
    try {
      await this.terminalOperations.run(() =>
        this.driveCancellation(journal, request, scopeState),
      );
      this.#scope.clearRunClaimsInScope(scopeState, runId);
      this.#scope.markRecoveryInScope(scopeState, conversationId);
      this.kickDelivery();
    } catch (firstError) {
      this.#scope.markRecoveryInScope(scopeState, conversationId);
      try {
        await this.terminalOperations.run(() =>
          this.driveCancellation(journal, request, scopeState),
        );
        this.#scope.clearRunClaimsInScope(scopeState, runId);
        this.#scope.markRecoveryInScope(scopeState, conversationId);
        this.kickDelivery();
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation scheduler cancellation could not determine its durable disposition",
        );
      }
    }
  }

  async cancel(
    input: DurableConversationCancelInput,
  ): Promise<DurableConversationCancellationResult> {
    input = structuredClone(input);
    await this.#access.adopt(input.conversationId);
    const scopeState = this.#scope.current;
    const source = { principal: { ...input.principal } };
    const localResults = new Map<
      string,
      ReturnType<ConversationManager["applyDurableCancellation"]>
    >();
    const applyLocal = (runId: string) => {
      let result = localResults.get(runId);
      if (!result) {
        result = this.stopAppliedCancellation(
          input.conversationId,
          runId,
          input.reason,
          scopeState,
        );
        localResults.set(runId, result);
      }
      return result;
    };
    const control = {
      admission: this.#authority.controlAdmission,
      source,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: input.runId
          ? {
              t: "cancel",
              conversationId: input.conversationId,
              runId: input.runId,
              ownerEpoch: this.#access.ownerEpochFor(
                input.conversationId,
                scopeState,
              ),
            }
          : {
              t: "cancel-batch",
              conversationId: input.conversationId,
              ownerEpoch: this.#access.ownerEpochFor(
                input.conversationId,
                scopeState,
              ),
              ...(input.response
                ? { response: { replyTarget: { ...input.response.replyTarget } } }
                : {}),
            },
      }),
    };
    try {
      return await retryControlAdmission(
        () =>
          this.terminalOperations.run(() => {
            if (currentMaintenanceAbortSignal().aborted) {
              throw new StorageMaintenanceCancelledError();
            }
            return this.withRecoveryClaim(
              input.conversationId,
              () => this.#cancelInternal(input, control, applyLocal, scopeState),
              scopeState,
            );
          }),
        async () => {},
      );
    } catch (error) {
      if (maintenanceRetryDelayMs(error) === undefined) throw error;
      const receipt = await this.#authority.controlAdmission.lookup({
        source,
        envelope: control.envelope,
      });
      if (receipt.kind !== "received-pending") throw error;
      this.#scope.markRecoveryInScope(scopeState, input.conversationId);
      return { dispositions: [], receivedPending: true };
    }
  }

  stopAppliedCancellation(
    conversationId: string,
    runId: string,
    reason?: DurableConversationCancelInput["reason"],
    scopeState: AuthorityScopeState = this.#scope.current,
  ) {
    const result = this.#requiredManager().applyDurableCancellation(
      conversationId,
      runId,
      reason,
    );
    for (const [assignmentId, claim] of scopeState.activeAssignmentClaims) {
      if (claim.runId === runId) {
        this.#executorDispatch.stopLocalExecution(assignmentId);
      }
    }
    return result;
  }

  async recoverReceivedCancellations(
    isRecoveryStopped: () => boolean,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<number> {
    const page = await this.#authority.controlAdmission.pendingCancellations(
      scopeState.pendingCancellationAfter,
    );
    scopeState.pendingCancellationAfter = page.after;
    return this.applyReceivedCancellations(
      page.envelopes,
      isRecoveryStopped,
      scopeState,
    );
  }

  async settleTargetCancellations(
    conversationId: string,
    runId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
    isRecoveryStopped: () => boolean = () => false,
  ): Promise<boolean> {
    const target = { conversationId, runId };
    const page = await this.#authority.controlAdmission.pendingCancellations(
      undefined,
      target,
    );
    if (page.envelopes.length === 0) return true;
    await this.applyReceivedCancellations(
      page.envelopes,
      isRecoveryStopped,
      scopeState,
    );
    const remaining = await this.#authority.controlAdmission.pendingCancellations(
      undefined,
      target,
    );
    if (remaining.envelopes.length === 0) return true;
    this.#scope.markRecoveryInScope(scopeState, conversationId);
    return false;
  }

  async applyReceivedCancellations(
    envelopes: readonly ConversationControlEnvelope[],
    isRecoveryStopped: () => boolean,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<number> {
    let count = 0;
    for (const envelope of envelopes) {
      const body = envelope.body;
      if (body.t !== "cancel" && body.t !== "cancel-batch") continue;
      await this.#access.adopt(body.conversationId);
      if (!this.#access.acceptsConversationId(body.conversationId, scopeState)) {
        continue;
      }
      if (isRecoveryStopped() || !this.#scope.isCurrent(scopeState)) break;
      try {
        await this.terminalOperations.run(() =>
          this.withRecoveryClaim(
            body.conversationId,
            async () => {
              const journal = this.#access.journal(body.conversationId, scopeState);
              const outcome = await this.#admission.applyAuthorityControl(
                body.conversationId,
                journal,
                {
                  admission: this.#authority.controlAdmission,
                  envelope,
                  source: { principal: envelope.principal },
                },
                true,
                scopeState,
              );
              if (outcome.kind === "rejected" || outcome.result.status !== "ok") {
                return;
              }
              const applied = outcome.result.body;
              const runs =
                applied.t === "cancel" && body.t === "cancel"
                  ? [{ runId: body.runId, runState: applied.runState }]
                  : applied.t === "cancel-batch"
                    ? applied.runs
                    : [];
              for (const run of runs) {
                this.stopAppliedCancellation(
                  body.conversationId,
                  run.runId,
                  { kind: "external", origin: "durable-control-recovery" },
                  scopeState,
                );
                this.#scope.clearRunClaimsInScope(scopeState, run.runId);
              }
              this.#scope.markRecoveryInScope(scopeState, body.conversationId);
              this.kickDelivery();
              if (runs.some((run) => run.runState === "cancel-requested")) {
                await this.continueAppliedCancellations(journal, scopeState);
              }
              count++;
            },
            scopeState,
          ),
        );
      } catch (error) {
        this.#scope.markRecoveryInScope(scopeState, body.conversationId);
        this.#observeFailure(error, {
          phase: "recovery",
          conversationId: body.conversationId,
        });
      }
    }
    return count;
  }

  async #cancelInternal(
    input: DurableConversationCancelInput,
    control: Parameters<ConversationRunJournal["applyControl"]>[0],
    applyLocal: (
      runId: string,
    ) => ReturnType<ConversationManager["applyDurableCancellation"]>,
    scopeState: AuthorityScopeState,
  ): Promise<DurableConversationCancellationResult> {
    const journal = this.#access.journal(input.conversationId, scopeState);
    if (!input.runId) {
      return this.#cancelBatch(input, journal, control, applyLocal, scopeState);
    }
    const candidate = await journal.runControlDescriptor(input.runId);
    if (!candidate) return { dispositions: [] };
    const runId = candidate.runId;
    const outcome = await this.#admission.applyAuthorityControl(
      input.conversationId,
      journal,
      control,
      true,
      scopeState,
    );
    if (outcome.kind === "rejected") {
      return this.#rejectedCancellation(journal, runId, outcome.result.error);
    }
    if (outcome.result.status === "rejected") {
      return this.#rejectedCancellation(journal, runId, outcome.result.error);
    }
    if (outcome.result.body.t !== "cancel") {
      throw new Error("Conversation cancellation returned another control result");
    }
    const local = applyLocal(runId);
    this.#scope.clearRunClaimsInScope(scopeState, runId);
    this.#scope.markRecoveryInScope(scopeState, input.conversationId);
    this.kickDelivery();
    if (outcome.result.body.runState === "cancel-requested") {
      await this.continueAppliedCancellations(journal, scopeState);
    }
    return {
      dispositions: [
        {
          runId,
          runState: outcome.result.body.runState,
          source: candidate.source,
          ingressId: candidate.ingressId,
          ...local,
        },
      ],
    };
  }

  async #rejectedCancellation(
    journal: ConversationRunJournal,
    runId: string,
    error: { readonly code: string; readonly message: string },
  ): Promise<DurableConversationCancellationResult> {
    if (error.code === "fence-rejected") {
      const after = await journal.runControlDescriptor(runId);
      if (after && isFinishedRunState(after.state)) {
        return { dispositions: [], finished: { runId, runState: after.state } };
      }
    }
    throw new Error(`Conversation cancellation was rejected: ${error.message}`);
  }

  async #cancelBatch(
    input: DurableConversationCancelInput,
    journal: ConversationRunJournal,
    control: Parameters<ConversationRunJournal["applyControl"]>[0],
    applyLocal: (
      runId: string,
    ) => ReturnType<ConversationManager["applyDurableCancellation"]>,
    scopeState: AuthorityScopeState,
  ): Promise<DurableConversationCancellationResult> {
    const outcome = await this.#admission.applyAuthorityControl(
      input.conversationId,
      journal,
      control,
      true,
      scopeState,
    );
    if (outcome.kind === "rejected") {
      throw new Error(
        `Conversation batch cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.status === "rejected") {
      throw new Error(
        `Conversation batch cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.body.t !== "cancel-batch") {
      throw new Error(
        "Conversation batch cancellation returned another control result",
      );
    }
    const dispositions: DurableConversationCancellationDisposition[] = [];
    for (const run of outcome.result.body.runs) {
      const local = applyLocal(run.runId);
      this.#scope.clearRunClaimsInScope(scopeState, run.runId);
      dispositions.push({
        runId: run.runId,
        runState: run.runState,
        source: run.source,
        ingressId: run.ingressId,
        ...local,
      });
    }
    this.#scope.markRecoveryInScope(scopeState, input.conversationId);
    this.kickDelivery();
    if (outcome.result.body.runs.some((run) => run.runState === "cancel-requested")) {
      await this.continueAppliedCancellations(journal, scopeState);
    }
    return { dispositions };
  }

  async resolveUncertain(
    input: DurableConversationResolveInput,
  ): Promise<DurableConversationResolutionResult> {
    const source = { principal: { ...input.principal } };
    await this.#access.adopt(input.conversationId);
    const scopeState = this.#scope.current;
    const journal = this.#access.journal(input.conversationId, scopeState);
    const outcome = await this.#admission.applyAuthorityControl(
      input.conversationId,
      journal,
      {
        admission: this.#authority.controlAdmission,
        envelope: createConversationControlEnvelope({
          requestId: input.requestId,
          source,
          at: this.#clock(),
          body: {
            t: "uncertain-resolve",
            ref: {
              execution: "conversation",
              conversationId: input.conversationId,
              runId: input.runId,
              ownerEpoch: input.ownerEpoch,
            },
            openFactDigest: input.openFactDigest,
            decision: input.decision,
          },
        }),
        source,
      },
      false,
      scopeState,
    );
    if (outcome.kind === "rejected") {
      throw new Error(
        `Conversation resolution was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.status === "rejected") {
      throw new Error(
        `Conversation resolution was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.body.t !== "uncertain-resolve") {
      throw new Error("Conversation resolution returned another control result");
    }
    const result = {
      state: outcome.result.body.state,
      factDigest: outcome.result.body.factDigest,
    };
    this.#scope.markRecoveryInScope(scopeState, input.conversationId);
    this.kickDelivery();
    if (result.state === "queued" && this.#scope.isCurrent(scopeState)) {
      try {
        if ((await journal.runState(input.runId)) === "queued") {
          await this.#host.scheduleResolvedRetry(
            input.conversationId,
            input.runId,
            journal,
            scopeState,
          );
        }
      } catch {
        this.#scope.markRecoveryInScope(scopeState, input.conversationId);
      }
    }
    return result;
  }

  async publishPendingFinals(conversationId: string): Promise<number> {
    const scopeState = this.#scope.current;
    try {
      await this.#access.adopt(conversationId);
      const journal = this.#access.journal(conversationId, scopeState);
      await journal.resumeCommittedProjections();
      if (!this.#onFinal) return 0;
      return await journal.publishPendingFinals(async (frame, publishResults) => {
        const identity = canonicalize(frame);
        if (scopeState.firstPartyPublishedFinals.delete(identity)) {
          for (const notice of publishResults) {
            await this.#onPublishResult?.(notice);
          }
          return;
        }
        if (scopeState.pendingFirstPartyFinals.has(identity)) {
          await this.#onFinal?.(frame);
          for (const notice of publishResults) {
            await this.#onPublishResult?.(notice);
          }
          scopeState.ownerPublishedFirstPartyFinals.add(identity);
          return;
        }
        await this.#onFinal?.(frame);
        for (const notice of publishResults) {
          await this.#onPublishResult?.(notice);
        }
      });
    } catch (error) {
      this.#scope.markRecoveryInScope(scopeState, conversationId);
      throw error;
    }
  }

  async driveCancellation(
    journal: ConversationRunJournal,
    request: Parameters<InProcessConversationDispatcher["cancelRun"]>[0],
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    await this.withRecoveryClaim(
      journal.conversationId,
      async () => {
        await this.#access.primeAssignmentRouting(journal, scopeState);
        await this.#access
          .createRecoveryDispatcher(journal, scopeState)
          .dispatcher.cancelRun(request);
      },
      scopeState,
    );
  }

  async drivePendingCancellations(
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<number> {
    return this.withRecoveryClaim(
      journal.conversationId,
      async () => {
        await this.#access.primeAssignmentRouting(journal, scopeState);
        return this.#access
          .createRecoveryDispatcher(journal, scopeState)
          .dispatcher.recoverCancellations();
      },
      scopeState,
    );
  }

  async continueAppliedCancellations(
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    try {
      await this.drivePendingCancellations(journal, scopeState);
    } catch (error) {
      if (maintenanceRetryDelayMs(error) === undefined) throw error;
      this.#scope.markRecoveryInScope(scopeState, journal.conversationId);
    }
  }

  async withRecoveryClaim<T>(
    conversationId: string,
    run: () => Promise<T>,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<T> {
    this.#scope.activeRecoveryClaims.set(
      conversationId,
      (this.#scope.activeRecoveryClaims.get(conversationId) ?? 0) + 1,
    );
    let primaryFailed = false;
    let primaryError: unknown;
    try {
      return await run();
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
      throw error;
    } finally {
      const remaining = (this.#scope.activeRecoveryClaims.get(conversationId) ?? 1) - 1;
      if (remaining > 0) {
        this.#scope.activeRecoveryClaims.set(conversationId, remaining);
      } else {
        this.#scope.activeRecoveryClaims.delete(conversationId);
        if (this.#scope.isCurrent(scopeState)) {
          if (scopeState.pendingConversationRetirements.has(conversationId)) {
            this.#scope.finalizeConversationRetirementInScope(
              scopeState,
              conversationId,
              this.#assignmentArtifactAuthority,
              this.#interactions,
            );
          } else {
            try {
              await this.retireSettledAssignments(
                conversationId,
                this.#access.journal(conversationId, scopeState),
                scopeState,
              );
            } catch (cleanupError) {
              this.#scope.markRecoveryInScope(scopeState, conversationId);
              this.#observeFailure(cleanupError, {
                phase: "recovery",
                conversationId,
              });
              if (maintenanceRetryDelayMs(cleanupError) === undefined) {
                if (primaryFailed) {
                  throw new AggregateError(
                    [primaryError, cleanupError],
                    "Conversation operation and route cleanup failed",
                  );
                }
                throw cleanupError;
              }
            }
          }
        }
      }
    }
  }

  async retireSettledAssignments(
    conversationId: string,
    journal: ConversationRunJournal,
    capturedScope: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    if (!this.#scope.isCurrent(capturedScope)) return;
    const candidateRevisions = this.#scope.snapshotConversationRouteRevisions(
      capturedScope,
      conversationId,
    );
    const recoverable = new Set(
      (await journal.assignmentsAwaitingRecovery()).map(
        (candidate) => candidate.assignmentId,
      ),
    );
    if (!this.#scope.isCurrent(capturedScope)) return;
    for (const [assignmentId, snappedRevision] of candidateRevisions) {
      if (recoverable.has(assignmentId)) continue;
      const currentRoute = capturedScope.assignmentRoutes.get(assignmentId);
      if (!currentRoute || currentRoute.routeRevision !== snappedRevision) continue;
      this.#scope.forgetAssignmentInScope(
        capturedScope,
        assignmentId,
        this.#assignmentArtifactAuthority,
        this.#interactions,
      );
    }
  }

  /**
   * Drains the verified first-party surface stream up to `finalSeq` under a 5s deadline,
   * then closes `finality` and `surface` with strict per-handle error isolation so a
   * throwing `finality.close()` (e.g. unsubscribe failure) never skips `surface.close()`.
   */
  drainFirstPartyProjection(input: FirstPartyTailDrainInput): Promise<void> {
    const {
      capturedScope,
      conversationId,
      runId,
      finalSeq,
      finalIdentity,
      finality,
      surface,
    } = input;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Conversation stream tail drain timed out")),
      5_000,
    );
    timer.unref?.();
    const close = async () => {
      clearTimeout(timer);
      if (finalIdentity) {
        capturedScope.pendingFirstPartyFinals.delete(finalIdentity);
        capturedScope.ownerPublishedFirstPartyFinals.delete(finalIdentity);
      }
      const closeErrors: unknown[] = [];
      try {
        finality?.close();
      } catch (error) {
        closeErrors.push(error);
      }
      try {
        await surface.close();
      } catch (error) {
        closeErrors.push(error);
      }
      for (const error of closeErrors) {
        this.#observeFailure(error, {
          phase: "run",
          conversationId,
          runId,
        });
      }
    };
    return surface
      .waitForSeq(finalSeq, deadline.signal)
      .then(close, async (error) => {
        this.#observeFailure(error, {
          phase: "run",
          conversationId,
          runId,
        });
        await close();
      })
      .catch((error) =>
        this.#observeFailure(error, {
          phase: "run",
          conversationId,
          runId,
        }),
      );
  }

  /**
   * Cross-generation-safe `run()` `finally` handler:
   * 1. Isolates every private handle close so one throw cannot skip subsequent closes;
   * 2. Releases run/assignment claims ONLY on `attempt.scopeState` matching `attempt.claimToken`,
   *    never touching `newScope` if `recoverInstalledAuthority` swapped scopes;
   * 3. Retires settled routes and marks recovery ONLY when `attempt.scopeState` is still current.
   */
  async cleanupRunAttempt(input: RunAttemptCleanupResources): Promise<void> {
    const {
      attempt,
      assignmentId,
      getChannelSession,
      getFirstPartyStreamFinalSeq,
      drainFirstPartyProjection,
      getFirstPartyFinalitySession,
      getFirstPartySurfaceSession,
      getExecutorPlan,
      getExecutionScope,
      runFailed,
      runError,
    } = input;
    const {
      scopeState: capturedScope,
      conversationId,
      runId,
      claimToken,
      capturedJournal,
      attemptForeground,
    } = attempt;

    const cleanupErrors: unknown[] = [];
    const release = async (step: () => unknown) => {
      try {
        await step();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    await release(() => getChannelSession()?.close());
    const finalSeq = getFirstPartyStreamFinalSeq();
    if (finalSeq !== undefined) {
      await release(() => drainFirstPartyProjection(finalSeq));
    }
    await release(() => getFirstPartyFinalitySession()?.close());
    await release(() => getFirstPartySurfaceSession()?.close());
    await release(() => getExecutorPlan()?.dispose());
    await release(() => attemptForeground.close());
    await release(() => getExecutionScope()?.close());

    this.#scope.clearRunClaimsInScope(capturedScope, runId, claimToken);
    this.#scope.releaseAssignmentClaimInScope(capturedScope, assignmentId, claimToken);

    if (this.#scope.isCurrent(capturedScope)) {
      try {
        await this.retireSettledAssignments(
          conversationId,
          capturedJournal,
          capturedScope,
        );
      } catch (cleanupError) {
        this.#scope.markRecoveryInScope(capturedScope, conversationId);
        this.#observeFailure(cleanupError, { phase: "recovery", conversationId });
        if (maintenanceRetryDelayMs(cleanupError) === undefined) {
          cleanupErrors.push(cleanupError);
        }
      }
    }

    if (cleanupErrors.length > 0) {
      this.#scope.markRecoveryInScope(capturedScope, conversationId);
      if (runFailed) {
        throw new AggregateError(
          [runError, ...cleanupErrors],
          `Conversation run failed (${executionFailureReason(runError)}) and cleanup failed (${cleanupErrors.map(executionFailureReason).join(", ")})`,
        );
      }
      throw cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(
            cleanupErrors,
            `Conversation run cleanup failed (${cleanupErrors.map(executionFailureReason).join(", ")})`,
          );
    }
  }
}
