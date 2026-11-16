import type {
  AssignmentActivationProof,
  AuthorityCapability,
  ConversationInvocation,
  ConversationRecoveryRequest,
  ConversationStatusNotice,
  FinalFrame,
  IngressContext,
  PublishResultNotice,
  RunSubmissionPort,
  SessionStatePort,
  StreamFrame,
} from "@zhixing-ai/core/contracts";
import type { LogRecordPort } from "@zhixing-ai/core/logging";
import type { AgentYield, RunResult } from "@zhixing-ai/core/loop";
import type { StreamDataFramePayload } from "@zhixing-ai/core/protocol";
import type { ForegroundActivityPort } from "@zhixing-ai/core/resources";
import type { WorksceneContinuationQuery } from "@zhixing-ai/core/workscene/application";
import type {
  AssignmentSubmissionPreflightPort,
  CommittedConversationResult,
  ConversationMutationPublisher,
  ConversationRunJournal,
  ConversationTrustSedimentPort,
  PendingConversationInput,
  TrustRuleHitBatchState,
  TrustRuleHitPort,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import { ConversationAssignmentAuthority } from "@zhixing-ai/owner-kernel/conversation-assignment-authority";
import type {
  ConversationManager,
  ManagedSession,
} from "@zhixing-ai/owner-kernel/conversation-manager";
import type { ConversationTransferPublication } from "@zhixing-ai/owner-kernel/conversation-transfer";
import type {
  DeferredIntentConversationAuthority,
  DeferredIntentConversationTransaction,
} from "@zhixing-ai/owner-kernel/deferred-global-intents";
import type {
  DurableConversationAdmissionInput,
  DurableConversationAdmissionResult,
  DurableConversationCancelInput,
  DurableConversationCancellationResult,
  DurableConversationResolutionResult,
  DurableConversationResolveInput,
  DurableConversationSessionProjectionInput,
  DurableConversationSessionWriteInput,
  DurableConversationSessionWriteResult,
  DurableConversationTurnExecutor,
  DurableConversationTurnInput,
} from "@zhixing-ai/owner-kernel/run-turn";
import type {
  RunTurnOptions,
  SessionRuntimeModelCallMetering,
} from "@zhixing-ai/owner-kernel/types";
import type { AuthorityRuntimeStack } from "../../setup-delivery.js";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationAssignmentStagingPort,
  ConversationExecutorDispatchApplication,
} from "../conversation-executor-dispatch.js";
import {
  anchorConversationOwnerRuntime,
  type ConversationOwnerRuntimeStack,
} from "../conversation-owner-runtime.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import type {
  FirstPartyFinalitySession,
  FirstPartyFinalitySessionOptions,
} from "../first-party-finality-session.js";
import { AdmissionAndLifecycle } from "./admission-lifecycle.js";
import type {
  CommittedConversationTransferPort,
  ConversationAdvancementExecutionPort,
  ConversationLosslessDataPlaneTopology,
} from "./contracts.js";
import { ConversationAccess } from "./conversation-access.js";
import { RecoveryScheduler } from "./recovery-scheduler.js";
import { RuntimeObligationScope } from "./runtime-obligation-scope.js";
import { TerminalSettlement } from "./terminal-settlement.js";
import { TurnExecution } from "./turn-execution.js";

export interface ConversationProtocolRuntimeOptions {
  readonly authority?: AuthorityRuntimeStack;
  readonly owner?: ConversationOwnerRuntimeStack;
  readonly losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly manager: () => ConversationManager;
  /** Existing directory identities can precede their first owner-journal fact. */
  readonly storedIdentityExists?: (conversationId: string) => Promise<boolean>;
  readonly clock?: () => string;
  readonly interactions: DurableConversationInteractionObserver;
  readonly trustSediments?: ConversationTrustSedimentPort;
  readonly trustRuleHits?: TrustRuleHitPort;
  readonly executorDispatch: ConversationExecutorDispatchApplication;
  readonly phaseRecords?: LogRecordPort;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly assignmentStaging?: ConversationAssignmentStagingPort;
  readonly executeRecoveredPerspective?: (input: {
    readonly manager: ConversationManager;
    readonly managed: ManagedSession;
    readonly originalInput: PendingConversationInput["input"];
    readonly question: string;
    readonly source: "interactive" | "channel";
    readonly abortSignal?: AbortSignal;
    readonly turnContext: NonNullable<RunTurnOptions["turnContext"]>;
    readonly authorizeToolExecution?: NonNullable<
      RunTurnOptions["authorizeToolExecution"]
    >;
    readonly modelCallMetering?: SessionRuntimeModelCallMetering;
  }) => Promise<RunResult>;
  readonly onFailure?: (
    error: unknown,
    context: {
      readonly phase: "run" | "recovery";
      readonly conversationId: string;
      readonly runId?: string;
    },
  ) => void;
  readonly onStatus?: (notice: ConversationStatusNotice) => void | Promise<void>;
  readonly onFinal?: (frame: FinalFrame) => void | Promise<void>;
  readonly onPublishResult?: (
    notice: PublishResultNotice,
  ) => void | Promise<void>;
  readonly onFirstPartyFrame?: (
    frame: StreamFrame,
    readDisplay?: () => Promise<StreamDataFramePayload>,
  ) => void | Promise<void>;
  readonly onFirstPartyAssignment?: (source: {
    conversationId: string;
    runId: string;
    assignmentId: string;
  }) => void;
  readonly onFirstPartyStreamEnd?: (source: {
    readonly conversationId: string;
    readonly runId: string;
    readonly assignmentId: string;
    readonly finalSeq: number;
  }) => void;
  readonly createFirstPartyFinality?: (
    input: Omit<FirstPartyFinalitySessionOptions, "sources">,
  ) => FirstPartyFinalitySession;
  readonly projectLifecycle?: (
    input: DurableConversationSessionProjectionInput,
  ) => Promise<void>;
  readonly recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly advancementExecution?: ConversationAdvancementExecutionPort;
  readonly foreground?: ForegroundActivityPort;
}

/** Single-process production composition for the durable conversation protocol. */
export class ConversationProtocolRuntime
  implements DurableConversationTurnExecutor
{
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #manager: () => ConversationManager;
  readonly #clock: () => string;
  readonly #executorDispatch: ConversationExecutorDispatchApplication;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly #recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly #onFailure: ConversationProtocolRuntimeOptions["onFailure"];
  readonly #statusListeners = new Set<
    NonNullable<ConversationProtocolRuntimeOptions["onStatus"]>
  >();
  readonly #scope = new RuntimeObligationScope();
  readonly #access: ConversationAccess;
  readonly #admission: AdmissionAndLifecycle;
  readonly #settlement: TerminalSettlement;
  readonly #execution: TurnExecution;
  readonly #recovery: RecoveryScheduler;
  readonly deferredIntentAuthority: DeferredIntentConversationAuthority;

  constructor(options: ConversationProtocolRuntimeOptions) {
    if ((options.authority === undefined) === (options.owner === undefined)) {
      throw new Error("Conversation protocol requires exactly one owner runtime");
    }
    const authority =
      options.owner ?? anchorConversationOwnerRuntime(options.authority!);
    this.#authority = authority;
    this.#manager = options.manager;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    if (!options.executorDispatch) {
      throw new Error(
        "Conversation protocol requires the executor dispatch application",
      );
    }
    if (!options.assignmentArtifactAuthority) {
      throw new Error(
        "Conversation protocol requires assignment artifact authority",
      );
    }
    this.#executorDispatch = options.executorDispatch;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    if (options.losslessDataPlane.kind === "available") {
      if (!options.losslessDataPlane.port) {
        throw new Error("Conversation protocol requires the lossless data plane");
      }
      this.#losslessDataPlane = Object.freeze({
        kind: "available",
        port: options.losslessDataPlane.port,
      });
    } else if (options.losslessDataPlane.reason === "executor-only") {
      this.#losslessDataPlane = Object.freeze({
        kind: "absent",
        reason: "executor-only",
      });
    } else {
      throw new Error("Conversation protocol received an invalid data-plane topology");
    }
    if (!options.recoverAuxiliary) {
      throw new Error("Conversation protocol requires auxiliary recovery");
    }
    this.#recoverAuxiliary = options.recoverAuxiliary;
    this.#onFailure = options.onFailure;

    const observeFailure = (
      error: unknown,
      context: Parameters<NonNullable<ConversationProtocolRuntimeOptions["onFailure"]>>[1],
    ): void => {
      try {
        this.#onFailure?.(error, context);
      } catch {
        /* Observation must not replace recovery. */
      }
    };
    const requiredManager = () => this.#requiredManager();

    const issuer = new ConversationAssignmentAuthority({
      signer: authority.signer,
      verifier: authority.verifier,
      snapshotFor: (executorId) =>
        authority.executorCapabilities.snapshotFor(executorId),
      clock: this.#clock,
    });

    this.#access = new ConversationAccess({
      authority,
      scope: this.#scope,
      host: {
        ensureSession: (conversationId) => this.ensureSession(conversationId),
        sessionExists: (conversationId) => this.sessionExists(conversationId),
        writeSession: (input) => this.writeSession(input),
        worksceneContinuationSources: (conversationId, query) =>
          this.worksceneContinuationSources(conversationId, query),
      },
      requiredManager,
      storedIdentityExists: options.storedIdentityExists,
      clock: this.#clock,
      executorDispatch: this.#executorDispatch,
      assignmentArtifactAuthority: this.#assignmentArtifactAuthority,
      assignmentStaging: options.assignmentStaging,
      interactions: options.interactions,
      trustSediments: options.trustSediments,
      trustRuleHits: options.trustRuleHits,
      onStatus: options.onStatus,
      statusListeners: this.#statusListeners,
      observeFailure,
    });

    this.#admission = new AdmissionAndLifecycle({
      authority,
      scope: this.#scope,
      access: this.#access,
      host: {
        ensureSession: (conversationId) => this.ensureSession(conversationId),
        deferScheduling: (conversationId, runId) =>
          this.deferScheduling(conversationId, runId),
        settleTargetCancellations: (conversationId, runId, scopeState) =>
          this.#settlement.settleTargetCancellations(
            conversationId,
            runId,
            scopeState,
            () => this.#recovery.isRecoveryStopped(),
          ),
        prepareControlBasis: () => this.#recovery.prepareControlBasis(),
        prepareConversationBasis: (conversationId, scopeState) =>
          this.#recovery.prepareConversationBasis(conversationId, scopeState),
      },
      manager: this.#manager,
      clock: this.#clock,
      foreground: options.foreground,
      phaseRecords: options.phaseRecords,
      projectLifecycle: options.projectLifecycle,
      recoverAuxiliary: this.#recoverAuxiliary,
      assignmentArtifactAuthority: this.#assignmentArtifactAuthority,
      interactions: options.interactions,
    });

    this.#settlement = new TerminalSettlement({
      authority,
      scope: this.#scope,
      access: this.#access,
      admission: this.#admission,
      host: {
        scheduleResolvedRetry: (conversationId, runId, journal, scopeState) =>
          this.#recovery.scheduleResolvedRetry(
            conversationId,
            runId,
            journal,
            scopeState,
          ),
      },
      requiredManager,
      clock: this.#clock,
      executorDispatch: this.#executorDispatch,
      assignmentArtifactAuthority: this.#assignmentArtifactAuthority,
      interactions: options.interactions,
      onFinal: options.onFinal,
      onPublishResult: options.onPublishResult,
      createFirstPartyFinality: options.createFirstPartyFinality,
      observeFailure,
    });

    this.#execution = new TurnExecution({
      authority,
      scope: this.#scope,
      access: this.#access,
      admission: this.#admission,
      settlement: this.#settlement,
      host: {
        confirmScheduled: (conversationId, runId) =>
          this.confirmScheduled(conversationId, runId),
        worksceneContinuationSources: (conversationId, query) =>
          this.worksceneContinuationSources(conversationId, query),
      },
      requiredManager,
      clock: this.#clock,
      issuer,
      executorDispatch: this.#executorDispatch,
      assignmentArtifactAuthority: this.#assignmentArtifactAuthority,
      interactions: options.interactions,
      losslessDataPlane: this.#losslessDataPlane,
      advancementExecution: options.advancementExecution,
      foreground: options.foreground,
      phaseRecords: options.phaseRecords,
      onFinal: options.onFinal,
      onFirstPartyFrame: options.onFirstPartyFrame,
      onFirstPartyAssignment: options.onFirstPartyAssignment,
      onFirstPartyStreamEnd: options.onFirstPartyStreamEnd,
      observeFailure,
    });

    this.#recovery = new RecoveryScheduler({
      authority,
      scope: this.#scope,
      access: this.#access,
      admission: this.#admission,
      settlement: this.#settlement,
      host: {
        stopRecoveryLoop: () => this.stopRecoveryLoop(),
        startRecoveryLoop: (intervalMs) => this.startRecoveryLoop(intervalMs),
        recoverReadinessProjections: () => this.recoverReadinessProjections(),
        recover: (periodic, first) => this.recover(periodic, first),
        prepareConversationReadiness: (conversationId) =>
          this.prepareConversationReadiness(conversationId),
        cancelAdmitted: (conversationId, runId) =>
          this.cancelAdmitted(conversationId, runId),
        publishPendingFinals: (conversationId) =>
          this.publishPendingFinals(conversationId),
        listSessions: () => this.listSessions(),
        isWorksceneContinuationCurrent: (source) =>
          this.isWorksceneContinuationCurrent(source),
        run: (input) => this.run(input),
        installCommittedConversationTransfer: (input) =>
          this.installCommittedConversationTransfer(input),
      },
      requiredManager,
      executorDispatch: this.#executorDispatch,
      assignmentArtifactAuthority: this.#assignmentArtifactAuthority,
      interactions: options.interactions,
      losslessDataPlane: this.#losslessDataPlane,
      recoverAuxiliary: this.#recoverAuxiliary,
      executeRecoveredPerspective: options.executeRecoveredPerspective,
      observeFailure,
    });

    const protocol = this;
    this.deferredIntentAuthority = Object.freeze({
      async transact<Value>(input: DeferredIntentConversationTransaction<Value>) {
        await protocol.#adopt(input.conversationId);
        return protocol.#journal(input.conversationId).transactDeferredIntent(input);
      },
    });
  }

  #adopt(conversationId: string): Promise<void> {
    return this.#access.adopt(conversationId);
  }

  #journal(conversationId: string): ConversationRunJournal {
    return this.#access.journal(conversationId);
  }

  #requiredManager(): ConversationManager {
    return this.#manager();
  }

  bindMutationPublisher(publisher: ConversationMutationPublisher): () => void {
    return this.#access.bindMutationPublisher(publisher);
  }

  bindCommittedConversationTransfers(
    port: CommittedConversationTransferPort,
  ): () => void {
    return this.#access.bindCommittedConversationTransfers(port);
  }

  retainUnavailableCommittedConversationTransfer(
    transferId: string,
    error: Error,
  ): Promise<void> {
    return this.#access.retainUnavailableCommittedConversationTransfer(
      transferId,
      error,
    );
  }

  installCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferPublication["manifest"];
    readonly source: ConversationTransferPublication["source"];
  }): Promise<void> {
    return this.#access.installCommittedConversationTransfer(input);
  }

  prepareCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferPublication["manifest"];
    readonly source: ConversationTransferPublication["source"];
  }): Promise<{ readonly publish: () => void }> {
    return this.#access.prepareCommittedConversationTransfer(input);
  }

  assignmentIngress(assignmentId: string): IngressContext {
    return this.#access.assignmentIngress(assignmentId);
  }

  conversationIdForAssignment(assignmentId: string): string {
    return this.#access.conversationIdForAssignment(assignmentId);
  }

  assignmentCapability(assignmentId: string): AuthorityCapability {
    return this.#access.assignmentCapability(assignmentId);
  }

  assignmentArtifactAuthority(assignmentId: string): Promise<{
    readonly capability: AuthorityCapability<"conversation">;
    readonly activation: AssignmentActivationProof<"conversation">;
  }> {
    return this.#access.assignmentArtifactAuthority(assignmentId);
  }

  submissionMeshRole(): {
    readonly submission: RunSubmissionPort;
    readonly submissionGuard: AssignmentSubmissionPreflightPort;
  } {
    return this.#access.submissionMeshRole();
  }

  bindFirstPartyFinality(
    factory: NonNullable<
      ConversationProtocolRuntimeOptions["createFirstPartyFinality"]
    >,
  ): void {
    this.#settlement.bindFirstPartyFinality(factory);
  }

  onStatus(
    listener: NonNullable<ConversationProtocolRuntimeOptions["onStatus"]>,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  bindDeliveryDrain(drain: () => Promise<void>): void {
    this.#settlement.bindDeliveryDrain(drain);
  }

  beginShutdownDrain(): void {
    this.#recovery.beginShutdownDrain();
  }

  resumeAfterShutdownDrain(): void {
    this.#recovery.resumeAfterShutdownDrain();
  }

  startRecoveryLoop(intervalMs = 5_000): void {
    this.#recovery.startRecoveryLoop(intervalMs);
  }

  whileRecoveryPaused<Value>(operation: () => Promise<Value>): Promise<Value> {
    return this.#recovery.whileRecoveryPaused(operation);
  }

  stopRecoveryLoop(): Promise<void> {
    return this.#recovery.stopRecoveryLoop();
  }

  recoverReadinessProjections(): Promise<number> {
    return this.#recovery.recoverReadinessProjections();
  }

  async recoverInstalledAuthority(): Promise<number> {
    return this.#recovery.recoverInstalledAuthority();
  }

  controlPrincipal(input: {
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  }) {
    return {
      ...input,
      deviceId: this.#authority.deviceId,
    };
  }

  releaseConversation(conversationId: string): void {
    this.#scope.releaseConversationCache(conversationId);
  }

  remoteRunInput(
    address: { conversationId: string; runId: string; assignmentId: string },
    executorId: string,
  ) {
    return this.#access.remoteRunInput(address, executorId);
  }

  inspectMessage(conversationId: string, messageId: string) {
    return this.#access.inspectMessage(conversationId, messageId);
  }

  messageInputsOutsideHistory(conversationId: string) {
    return this.#access.messageInputsOutsideHistory(conversationId);
  }

  recoveryPage(request: ConversationRecoveryRequest) {
    return this.#access.recoveryPage(request);
  }

  ensureSession(conversationId: string): Promise<void> {
    return this.#access.ensureSession(conversationId);
  }

  admit(
    input: DurableConversationAdmissionInput,
  ): Promise<DurableConversationAdmissionResult> {
    return this.#admission.admit(input);
  }

  confirmScheduled(conversationId: string, runId: string): void {
    this.#admission.confirmScheduled(conversationId, runId);
  }

  deferScheduling(conversationId: string, runId: string): void {
    this.#admission.deferScheduling(conversationId, runId);
  }

  scheduledTaskSettled(conversationId: string, admissionId: string): void {
    this.#admission.scheduledTaskSettled(conversationId, admissionId);
  }

  cancelAdmitted(conversationId: string, runId: string): Promise<void> {
    return this.#settlement.cancelAdmitted(conversationId, runId);
  }

  findRunByIngress(
    conversationId: string,
    ingressId: string,
    source: ConversationInvocation["source"],
  ) {
    return this.#access.findRunByIngress(conversationId, ingressId, source);
  }

  findInteractionOutcome(conversationId: string, requestId: string) {
    return this.#access.findInteractionOutcome(conversationId, requestId);
  }

  activeRunSecurityFacts(conversationId: string) {
    return this.#access.activeRunSecurityFacts(conversationId);
  }

  trustSedimentMirrored(
    conversationId: string,
    assignmentId: string,
    requestId: string,
  ): Promise<boolean> {
    return this.#access.trustSedimentMirrored(
      conversationId,
      assignmentId,
      requestId,
    );
  }

  trustRuleHitBatchState(
    conversationId: string,
    assignmentId: string,
    batchDigest: string,
  ): Promise<TrustRuleHitBatchState> {
    return this.#access.trustRuleHitBatchState(
      conversationId,
      assignmentId,
      batchDigest,
    );
  }

  touchWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string }> {
    return this.#access.touchWorksceneSession(input);
  }

  deleteWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string } | undefined> {
    return this.#access.deleteWorksceneSession(input);
  }

  cancel(
    input: DurableConversationCancelInput,
  ): Promise<DurableConversationCancellationResult> {
    return this.#settlement.cancel(input);
  }

  resolveUncertain(
    input: DurableConversationResolveInput,
  ): Promise<DurableConversationResolutionResult> {
    return this.#settlement.resolveUncertain(input);
  }

  writeSession(
    input: DurableConversationSessionWriteInput,
  ): Promise<DurableConversationSessionWriteResult> {
    return this.#admission.writeSession(input);
  }

  projectSession(
    input: DurableConversationSessionProjectionInput,
  ): Promise<void> {
    return this.#admission.projectSession(input);
  }

  run(input: DurableConversationTurnInput): AsyncGenerator<AgentYield, RunResult> {
    return this.#execution.run(input);
  }

  inputReceipt(input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly surfacePrincipal: string;
  }) {
    return this.#authority.controlAdmission.inputReceipt(input);
  }

  listSessions(): Promise<readonly string[]> {
    return this.#access.listSessions();
  }

  sessionExists(conversationId: string): Promise<boolean> {
    return this.#access.sessionExists(conversationId);
  }

  recover(periodic = false, first?: string): Promise<number> {
    return this.#recovery.recover(periodic, first);
  }

  recoverConversation(conversationId: string): Promise<number> {
    return this.#recovery.recoverConversation(conversationId);
  }

  prepareAfterUsable(conversationId: string): Promise<void> {
    return this.#recovery.prepareAfterUsable(conversationId);
  }

  prepareConversationReadiness(conversationId: string): Promise<void> {
    return this.#recovery.prepareConversationReadiness(conversationId);
  }

  completeLifecycleProjections(conversationId: string): Promise<number> {
    return this.#admission.completeLifecycleProjections(conversationId);
  }

  publishPendingFinals(conversationId: string): Promise<number> {
    return this.#settlement.publishPendingFinals(conversationId);
  }

  pendingClosureWork(conversationId?: string) {
    return this.#recovery.pendingClosureWork(conversationId);
  }

  assignmentLifecycleProvenance(conversationId: string, assignmentId: string) {
    return this.#access.assignmentLifecycleProvenance(
      conversationId,
      assignmentId,
    );
  }

  ownsReservation(
    conversationId: string,
    reservationId: string,
  ): Promise<boolean> {
    return this.#access.ownsReservation(conversationId, reservationId);
  }

  reservationConversationScope(
    reservationId: string,
  ): Promise<string | undefined> {
    return this.#access.reservationConversationScope(reservationId);
  }

  sessionAuthorityState(conversationId: string) {
    return this.#access.sessionAuthorityState(conversationId);
  }

  statusHistory(
    requests: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ) {
    return this.#access.statusHistory(requests);
  }

  taskListBeforeMutation(conversationId: string, requestId: string) {
    return this.#access.taskListBeforeMutation(conversationId, requestId);
  }

  get advancementPending() {
    return this.#access.advancementPending;
  }

  get sessionState(): SessionStatePort {
    return this.#access.sessionState;
  }

  finalHistory(
    conversationId: string,
    afterCommitRevision: number,
  ): Promise<CommittedConversationResult[]> {
    return this.#access.finalHistory(conversationId, afterCommitRevision);
  }

  advancementEvidenceTarget(conversationId: string, runId: string) {
    return this.#access.advancementEvidenceTarget(conversationId, runId);
  }

  worksceneContinuationSources(
    conversationId: string,
    query?: WorksceneContinuationQuery,
  ) {
    return this.#access.worksceneContinuationSources(conversationId, query);
  }

  isWorksceneContinuationCurrent(source: {
    conversationId: string;
    runId: string;
  }): Promise<boolean> {
    return this.#access.isWorksceneContinuationCurrent(source);
  }
}
