import { randomUUID } from "node:crypto";
import {
  normalizeUserTurnInput,
  parseConversationId,
  userMessageFromTurnInput,
  type AgentYield,
  type RunResult,
} from "@zhixing/core";
import type {
  AuthorityLogSnapshot,
} from "@zhixing/core/authority";
import type {
  AuthorityCapability,
  AuthorityCallContext,
  AuthorityError,
  AssignmentActivationProof,
  CommitEnvelope,
  ControlLease,
  ConversationStatusNotice,
  FinalFrame,
  IngressContext,
  InteractionMirrorBatch,
  OwnerControlGrant,
  PublishResultNotice,
  ConversationInvocation,
  AssignmentResourceLease,
  DispatchResult,
  ExecutionAssetBundle,
  LedgerEvidencePage,
  LedgerSnapshot,
  RunDispatchArguments,
  RunExecutorPort,
  RunSubmissionPort,
  SupersedeProof,
  TrustRuleSnapshot,
  ReservationOrigin,
  StreamFrame,
  TranscriptRunRecord,
  ConversationTransferManifest,
} from "@zhixing/core/contracts";
import {
  assertPrincipalAllowsAuthorityMethod,
  MAX_CONTROL_LEASE_TTL_MS,
  canonicalize,
  ownerControlRequestDigest,
  protocolDigest,
  StreamDigestChain,
  validateAuthorityCapability,
  type ConversationInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type StreamFrameProducer,
} from "@zhixing/core/protocol";
import {
  ConversationRunJournal,
  InProcessConversationDispatcher,
  ConversationAssignmentAuthority,
  assignmentReservationId,
  channelSurfacePrincipal,
  createConversationControlEnvelope,
  createInitialControlEnvelope,
  type AssignmentSubmissionAuthorizer,
  type AssignmentSubmissionIdentity,
  type AssignmentSubmissionPreflightPort,
  type ConversationCommitAuthority,
  type CommittedConversationResult,
  type ConversationMutationPublisher,
  type ConversationManager,
  type ManagedSession,
  type PendingConversationInput,
  type SessionRuntime,
  type RuntimeFactory,
  type DurableConversationAdmissionInput,
  type DurableConversationAdmissionResult,
  type DurableConversationCancelInput,
  type DurableConversationCancellationDisposition,
  type DurableConversationCancellationResult,
  type DurableConversationResolutionResult,
  type DurableConversationResolveInput,
  type DurableConversationSessionProjectionInput,
  type DurableConversationSessionWriteInput,
  type DurableConversationSessionWriteResult,
  type DurableConversationTurnExecutor,
  type DurableConversationTurnInput,
  type DeferredIntentConversationAuthority,
  type DeferredIntentConversationTransaction,
  type InProcessDispatchContextFactory,
  type ConversationTransferAuthorityRecord,
  type ConversationSegmentMemoryFlush,
  ConversationSessionStateAdapter,
} from "@zhixing/owner-kernel";
import {
  DurableConversationAdmissionRejectedError,
  runTurnWithCommit,
} from "@zhixing/owner-kernel/run-turn";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type {
  AuthorityRuntimeStack,
  ConversationRuntimeBinding,
} from "../setup-delivery.js";
import {
  anchorConversationOwnerRuntime,
  type ConversationOwnerRuntimeStack,
} from "./conversation-owner-runtime.js";
import type { ExecutorCapabilitySnapshot } from "@zhixing/core/protocol";
import type { SessionStatePort } from "@zhixing/core/contracts";
import {
  DurableConversationInteractionObserver,
  type DurableInteractionBinding,
} from "./durable-conversation-interactions.js";
import {
  ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
  createConversationExecutorLedger,
} from "./conversation-executor-ledger.js";
import {
  isRetryableMeshFailure,
} from "./remote-obligation-failure.js";
import { retryDurableObligation } from "./durable-obligation-retry.js";
import {
  assignmentGlobalCapability,
  createAssignmentGlobalQueryPort,
  createAssignmentMutationPort,
  createAssignmentScheduleStager,
} from "./assignment-schedule-stager.js";
import type {
  FirstPartySurfaceSession,
  LosslessDataPlaneRuntime,
  LosslessDataPlaneSession,
} from "./lossless-data-plane-runtime.js";
import type {
  FirstPartyFinalitySession,
  FirstPartyFinalitySessionOptions,
} from "./first-party-finality-session.js";

export { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";

const CONTEXT_TTL_MS = MAX_CONTROL_LEASE_TTL_MS;
const CONTROL_RENEWAL_INTERVAL_MS = Math.floor(CONTEXT_TTL_MS / 3);

export interface RemoteConversationExecutionTarget {
  readonly executorId: string;
  readonly deviceId: string;
  readonly executor: RunExecutorPort;
  synchronizePermission(
    snapshot: TrustRuleSnapshot,
    executionAssets?: ExecutionAssetBundle,
  ): Promise<ExecutorCapabilitySnapshot>;
}

export interface RemoteConversationExecutionDirectory {
  candidates(): Promise<readonly RemoteConversationExecutionTarget[]>;
  forExecutor(executorId: string): RemoteConversationExecutionTarget | undefined;
}

export interface ConversationProtocolRuntimeOptions {
  readonly authority?: AuthorityRuntimeStack;
  readonly owner?: ConversationOwnerRuntimeStack;
  readonly manager: () => ConversationManager;
  readonly clock?: () => string;
  readonly maxPendingInteractions?: number;
  readonly interactions: DurableConversationInteractionObserver;
  readonly localExecutor?: {
    readonly ledger?: ConversationAssignmentLedger;
    readonly ConversationAssignmentLedger: typeof ConversationAssignmentLedger;
    readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
    readonly dataPlaneTickets?: ConstructorParameters<
      typeof ConversationAssignmentLedger
    >[0]["dataPlaneTickets"];
    readonly createStream?: (input: {
      readonly assignmentId: string;
      readonly ref: import("@zhixing/core/contracts").ExecutionRef;
    }) => Promise<DurableAssignmentRunStream>;
    readonly runtimeFactory: RuntimeFactory;
  };
  readonly executeRecoveredPerspective?: (input: {
    readonly manager: ConversationManager;
    readonly managed: ManagedSession;
    readonly originalInput: PendingConversationInput["input"];
    readonly question: string;
    readonly source: "interactive" | "channel";
    readonly abortSignal?: AbortSignal;
    readonly turnContext: NonNullable<
      import("@zhixing/owner-kernel").RunTurnOptions["turnContext"]
    >;
    readonly authorizeToolExecution?: NonNullable<
      import("@zhixing/owner-kernel").RunTurnOptions["authorizeToolExecution"]
    >;
    readonly modelCallMetering?: import("@zhixing/owner-kernel").SessionRuntimeModelCallMetering;
  }) => Promise<RunResult>;
  readonly onStatus?: (notice: ConversationStatusNotice) => void | Promise<void>;
  readonly onFinal?: (frame: FinalFrame) => void | Promise<void>;
  readonly onPublishResult?: (
    notice: PublishResultNotice,
  ) => void | Promise<void>;
  readonly onFirstPartyFrame?: (frame: StreamFrame) => void | Promise<void>;
  readonly createFirstPartyFinality?: (
    input: Omit<FirstPartyFinalitySessionOptions, "sources">,
  ) => FirstPartyFinalitySession;
  /** Idempotently materializes a durable clear/delete fact into legacy storage/runtime views. */
  readonly projectLifecycle?: (
    input: DurableConversationSessionProjectionInput,
  ) => Promise<void>;
  /** Reconciles durable conversation facts with independently persisted auxiliary views. */
  readonly recoverAuxiliary?: (conversationId: string) => Promise<void>;
}

interface AppliedConversationAdmission {
  readonly runId: string;
  readonly ingress: IngressContext;
  readonly attachments: PendingConversationInput["attachments"];
  readonly environment?: import("@zhixing/core/contracts").ExplicitEnvironmentSelection;
  readonly replayed: boolean;
}

interface PreparedConversationAdmission {
  readonly conversationId: string;
  readonly surfacePrincipal: string;
  readonly admission: AppliedConversationAdmission;
  readonly input: PendingConversationInput["input"];
  readonly attachments: PendingConversationInput["attachments"];
  readonly invocation: ConversationInvocation;
  readonly environment?: import("@zhixing/core/contracts").ExplicitEnvironmentSelection;
}

interface DurableAssignmentRunStream extends StreamFrameProducer {
  markTerminal?(): Promise<unknown>;
}

type ConversationLosslessDataPlane = Pick<
  LosslessDataPlaneRuntime,
  "openConversationChannel" | "openFirstPartySurfaceSession"
> & {
  recoverConversationChannels(journal: ConversationRunJournal): Promise<number>;
};

/** Single-process production composition for the durable conversation protocol. */
export class ConversationProtocolRuntime implements DurableConversationTurnExecutor {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #manager: () => ConversationManager;
  readonly #clock: () => string;
  #sessionState: SessionStatePort | undefined;
  readonly #ledger: ConversationAssignmentLedger | undefined;
  readonly #InProcessAssignmentSubmission:
    | typeof InProcessAssignmentSubmission
    | undefined;
  readonly #createStream:
    | ((
        input: {
          readonly assignmentId: string;
          readonly ref: import("@zhixing/core/contracts").ExecutionRef;
        },
      ) => Promise<DurableAssignmentRunStream>)
    | undefined;
  readonly #localRuntimeFactory: RuntimeFactory | undefined;
  readonly #issuer: ConversationAssignmentAuthority;
  readonly #journals = new Map<string, ConversationRunJournal>();
  readonly #adoptedConversations = new Map<string, {
    readonly transferId: string;
    readonly ownerEpoch: number;
    readonly records: readonly ConversationTransferAuthorityRecord[];
  }>();
  readonly #assignmentConversations = new Map<string, string>();
  readonly #assignmentCapabilities = new Map<
    string,
    AuthorityCapability<"conversation">
  >();
  readonly #assignmentActivations = new Map<
    string,
    AssignmentActivationProof<"conversation">
  >();
  readonly #assignmentIngress = new Map<string, IngressContext>();
  readonly #assignmentRuntimeBindings = new Map<string, ConversationRuntimeBinding>();
  readonly #schedulingRuns = new Set<string>();
  readonly #scheduledRuns = new Set<string>();
  readonly #firstPartyPublishedFinals = new Set<string>();
  readonly #ownerPublishedFirstPartyFinals = new Set<string>();
  readonly #pendingFirstPartyFinals = new Set<string>();
  readonly #preparedAdmissions = new Map<string, PreparedConversationAdmission>();
  readonly #terminalOperations = new SerialTaskQueue();
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #executeRecoveredPerspective:
    | ConversationProtocolRuntimeOptions["executeRecoveredPerspective"]
    | undefined;
  readonly #onStatus: ((notice: ConversationStatusNotice) => void | Promise<void>) | undefined;
  readonly #onFinal: ((frame: FinalFrame) => void | Promise<void>) | undefined;
  readonly #onPublishResult:
    | ((notice: PublishResultNotice) => void | Promise<void>)
    | undefined;
  readonly #onFirstPartyFrame:
    | ((frame: StreamFrame) => void | Promise<void>)
    | undefined;
  readonly #createFirstPartyFinality:
    | ConversationProtocolRuntimeOptions["createFirstPartyFinality"]
    | undefined;
  readonly #projectLifecycle:
    | ((input: DurableConversationSessionProjectionInput) => Promise<void>)
    | undefined;
  readonly #recoverAuxiliary: ((conversationId: string) => Promise<void>) | undefined;
  readonly #lifecycleProjectionClaims = new Map<string, Promise<number>>();
  readonly #activeRecoveryClaims = new Map<string, number>();
  readonly #pendingConversationRetirements = new Set<string>();
  #deliveryDrain: (() => Promise<void>) | undefined;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #recoveryRunning: Promise<number> | undefined;
  #readinessRecovery: Promise<number> | undefined;
  #recoveryStopped = false;
  #recoveryDiscovered = false;
  #shutdownDraining = false;
  #recoveryGeneration = 0;
  readonly #recoveryConversations = new Map<string, number>();
  readonly #sessionIdentities = new Map<string, Promise<void>>();
  #remoteExecution: RemoteConversationExecutionDirectory | undefined;
  #losslessDataPlane:
    | ConversationLosslessDataPlane
    | undefined;
  #mutationPublisher: ConversationMutationPublisher | undefined;
  readonly #mutationPublisherProxy: ConversationMutationPublisher;
  readonly deferredIntentAuthority: DeferredIntentConversationAuthority;

  constructor(options: ConversationProtocolRuntimeOptions) {
    if ((options.authority === undefined) === (options.owner === undefined)) {
      throw new Error("Conversation protocol requires exactly one owner runtime");
    }
    const authority = options.owner ?? anchorConversationOwnerRuntime(options.authority!);
    const runtime = this;
    this.#mutationPublisherProxy = {
      get readProjectionIds() {
        return runtime.#mutationPublisher?.readProjectionIds ?? [];
      },
      decideGlobalBatchAtPrefix: (input) =>
        this.#requiredMutationPublisher().decideGlobalBatchAtPrefix(input),
      prepareGlobalBatchAtPrefix: async (input) => {
        const publisher = this.#requiredMutationPublisher();
        return await (publisher.prepareGlobalBatchAtPrefix?.(input) ??
          Promise.resolve(publisher.decideGlobalBatchAtPrefix(input))
            .then((outcomes) => ({ outcomes, records: [] })));
      },
      apply: (input) => this.#requiredMutationPublisher().apply(input),
    };
    this.#authority = authority;
    this.#manager = options.manager;
    const protocol = this;
    this.deferredIntentAuthority = Object.freeze({
      transact<Value>(input: DeferredIntentConversationTransaction<Value>) {
        return protocol.#journal(input.conversationId).transactDeferredIntent(input);
      },
    });
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#interactions = options.interactions;
    this.#executeRecoveredPerspective = options.executeRecoveredPerspective;
    this.#onStatus = options.onStatus;
    this.#onFinal = options.onFinal;
    this.#onPublishResult = options.onPublishResult;
    this.#onFirstPartyFrame = options.onFirstPartyFrame;
    this.#createFirstPartyFinality = options.createFirstPartyFinality;
    this.#projectLifecycle = options.projectLifecycle;
    this.#recoverAuxiliary = options.recoverAuxiliary;
    this.#InProcessAssignmentSubmission =
      options.localExecutor?.InProcessAssignmentSubmission;
    this.#createStream = options.localExecutor?.createStream;
    this.#localRuntimeFactory = options.localExecutor?.runtimeFactory;
    const executorAuthority = authority.executorLog && authority.executorResources
      ? authority as ConversationOwnerRuntimeStack & {
          readonly executorLog: NonNullable<ConversationOwnerRuntimeStack["executorLog"]>;
          readonly executorResources: NonNullable<
            ConversationOwnerRuntimeStack["executorResources"]
          >;
        }
      : undefined;
    if (options.localExecutor?.ConversationAssignmentLedger && !executorAuthority) {
      throw new Error(
        "Local executor ledger requires executor authority log and resources",
      );
    }
    this.#ledger = options.localExecutor?.ledger ?? (options.localExecutor?.ConversationAssignmentLedger
      ? createConversationExecutorLedger({
      Constructor: options.localExecutor.ConversationAssignmentLedger,
      authority: executorAuthority!,
      assignmentRecordV2Writes: ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
      usageFinal: (assignmentId) =>
        authority.finalizeUsage(
          assignmentId,
          (report) =>
            usageReporterContext(report.reporterId, report.digest, this.#clock()),
        ),
      runtimeBindingGuard: ({ assignmentId, manifest }) => {
        const binding = this.#assignmentRuntimeBindings.get(assignmentId);
        if (binding === undefined) {
          return authority.validateLocalConversationManifest(manifest);
        }
        return authority.validateConversationRuntimeBinding({
          assignmentId,
          manifest,
          binding,
        });
      },
      clock: this.#clock,
      ...(options.localExecutor.dataPlaneTickets === undefined
        ? {}
        : { dataPlaneTickets: options.localExecutor.dataPlaneTickets }),
      ...(options.maxPendingInteractions === undefined
        ? {}
        : { maxPendingInteractions: options.maxPendingInteractions }),
        })
      : undefined);
    this.#issuer = new ConversationAssignmentAuthority({
      signer: authority.signer,
      verifier: authority.verifier,
      snapshotFor: (executorId) =>
        authority.executorCapabilities.snapshotFor(executorId),
      clock: this.#clock,
    });
    this.#contexts = createDispatchContexts({
      signer: authority.signer,
      deviceId: authority.deviceId,
      ownerEpochFor: (assignmentId) =>
        this.#ownerEpochFor(this.#conversationForAssignment(assignmentId)),
      clock: this.#clock,
      conversationIdFor: (assignmentId) =>
        this.#conversationForAssignment(assignmentId),
    });
  }

  bindRemoteExecution(directory: RemoteConversationExecutionDirectory): void {
    if (this.#authority.domain.kind !== "anchor") {
      throw new Error("Local conversation owners cannot bind remote execution");
    }
    if (this.#remoteExecution && this.#remoteExecution !== directory) {
      throw new Error("Remote conversation execution is already bound");
    }
    this.#remoteExecution = directory;
  }

  bindLosslessDataPlane(
    runtime: ConversationLosslessDataPlane,
  ): void {
    if (this.#losslessDataPlane && this.#losslessDataPlane !== runtime) {
      throw new Error("Conversation lossless data plane is already bound");
    }
    this.#losslessDataPlane = runtime;
  }

  bindMutationPublisher(publisher: ConversationMutationPublisher): void {
    if (!this.#authority.globalPublishing) {
      throw new Error("Local conversation owners cannot bind global mutation publishing");
    }
    if (this.#mutationPublisher && this.#mutationPublisher !== publisher) {
      throw new Error("Conversation mutation publisher is already bound");
    }
    this.#mutationPublisher = publisher;
  }

  /** Installs a committed immutable source prefix before exposing the adopted session. */
  async installCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferManifest;
    readonly records: readonly ConversationTransferAuthorityRecord[];
  }): Promise<void> {
    const prepared = await this.prepareCommittedConversationTransfer(input);
    prepared.publish();
  }

  /**
   * Performs every fallible read/reduction before the owner switch. Publishing
   * the returned token only swaps already-built in-memory views and cannot do I/O.
   */
  async prepareCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferManifest;
    readonly records: readonly ConversationTransferAuthorityRecord[];
  }): Promise<{ readonly publish: () => void }> {
    if (input.manifest.targetDeviceId !== this.#authority.deviceId) {
      throw new TypeError("Conversation transfer target does not match this owner");
    }
    const conversationId = input.manifest.conversationId;
    const existing = this.#adoptedConversations.get(conversationId);
    if (
      existing &&
      (existing.transferId !== input.manifest.transferId ||
        existing.ownerEpoch !== input.manifest.nextOwnerEpoch)
    ) {
      throw new Error("Conversation already has another committed transfer generation");
    }
    const adopted = {
      transferId: input.manifest.transferId,
      ownerEpoch: input.manifest.nextOwnerEpoch,
      records: input.records.map((record) => structuredClone(record)),
    };
    const journal = this.#createJournal(conversationId, adopted.ownerEpoch);
    await journal.primeRecoverySnapshot(
      await this.#snapshotWithImportedBase(adopted.records),
    );
    return Object.freeze({
      publish: () => {
        this.#adoptedConversations.set(conversationId, adopted);
        this.#journals.set(conversationId, journal);
        this.#sessionIdentities.set(conversationId, Promise.resolve());
        this.#markRecovery(conversationId);
      },
    });
  }

  /** Derived post-adoption memory inputs from the installed authority prefix. */
  async conversationMemoryFlushes(
    conversationId: string,
  ): Promise<readonly ConversationSegmentMemoryFlush[]> {
    return this.#journal(conversationId).segmentMemoryFlushes();
  }

  assignmentIngress(assignmentId: string): IngressContext {
    const ingress = this.#assignmentIngress.get(assignmentId);
    if (!ingress) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return structuredClone(ingress);
  }

  conversationIdForAssignment(assignmentId: string): string {
    return this.#conversationForAssignment(assignmentId);
  }

  executorMeshRole(): {
    readonly port: RunExecutorPort;
    readonly guard: import("@zhixing/executor").OwnerControlPreflightPort;
  } {
    const ledger = this.#requireLocalLedger();
    return { port: ledger, guard: ledger };
  }

  executorLedger(): ConversationAssignmentLedger {
    return this.#requireLocalLedger();
  }

  assignmentCapability(assignmentId: string): AuthorityCapability {
    const capability = this.#assignmentCapabilities.get(assignmentId);
    if (!capability) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return capability;
  }

  async assignmentArtifactAuthority(assignmentId: string): Promise<{
    readonly capability: AuthorityCapability<"conversation">;
    readonly activation: AssignmentActivationProof<"conversation">;
  }> {
    const capability = this.#assignmentCapabilities.get(assignmentId);
    const activation = this.#assignmentActivations.get(assignmentId);
    if (!capability || !activation) {
      throw new Error(`Unknown conversation assignment ${assignmentId}`);
    }
    return { capability, activation };
  }

  submissionMeshRole(): {
    readonly submission: RunSubmissionPort;
    readonly submissionGuard: AssignmentSubmissionPreflightPort;
  } {
    const journalFor = (context: AuthorityCallContext) =>
      this.#journal(conversationIdFromSubmissionContext(context));
    return {
      submission: {
        reportStarted: (assignmentId, context) =>
          journalFor(context).reportStarted(assignmentId, context),
        submitBundle: (bundle, context) =>
          journalFor(context).submitBundle(bundle, context),
        submitCancelProof: (assignmentId, proof, context) =>
          journalFor(context).submitCancelProof(assignmentId, proof, context),
        mirrorInteractions: (assignmentId, batch, context) =>
          journalFor(context).mirrorInteractions(
            assignmentId,
            asConversationMirrorBatch(batch),
            context,
          ),
      },
      submissionGuard: {
        preflightSubmission: (
          context: AuthorityCallContext,
          identity: AssignmentSubmissionIdentity,
        ) => journalFor(context).preflightSubmission(context, identity),
      },
    };
  }

  bindDeliveryDrain(drain: () => Promise<void>): void {
    this.#deliveryDrain = drain;
  }

  /** Fences recovery from scheduling new provider work while durable shutdown drains. */
  beginShutdownDrain(): void {
    this.#shutdownDraining = true;
  }

  startRecoveryLoop(intervalMs = 5_000): void {
    if (this.#recoveryTimer || this.#recoveryRunning) return;
    this.#recoveryStopped = false;
    const run = () => {
      if (this.#recoveryStopped) return;
      const active = this.recover();
      this.#recoveryRunning = active;
      void active.catch(() => 0).finally(() => {
        if (this.#recoveryRunning === active) this.#recoveryRunning = undefined;
        if (!this.#recoveryStopped) {
          this.#recoveryTimer = setTimeout(() => {
            this.#recoveryTimer = undefined;
            run();
          }, intervalMs);
          this.#recoveryTimer.unref?.();
        }
      });
    };
    run();
  }

  async stopRecoveryLoop(): Promise<void> {
    this.#recoveryStopped = true;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    await this.#recoveryRunning?.catch(() => 0);
  }

  async recoverReadinessProjections(): Promise<number> {
    if (this.#readinessRecovery) return this.#readinessRecovery;
    const active = this.#recoverReadinessProjections();
    this.#readinessRecovery = active;
    try {
      return await active;
    } catch (error) {
      if (this.#readinessRecovery === active) this.#readinessRecovery = undefined;
      throw error;
    }
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
    // Grace/idle eviction only drops a rebuildable journal projection. Durable
    // recovery generations, capabilities and scheduler claims have independent
    // owners and must survive ordinary cache eviction.
    this.#journals.delete(conversationId);
    this.#sessionIdentities.delete(conversationId);
  }

  /**
   * Establishes the owner-routed conversation identity before any dependent fact.
   * The deterministic request is the sole creation identity, so response loss and
   * concurrent activation replay the original authority decision.
   */
  ensureSession(conversationId: string): Promise<void> {
    if (!this.#acceptsConversationId(conversationId)) {
      return Promise.reject(
        new Error("Conversation identity does not belong to this owner domain"),
      );
    }
    const existing = this.#sessionIdentities.get(conversationId);
    if (existing) return existing;
    const establishing = this.#establishSession(conversationId);
    this.#sessionIdentities.set(conversationId, establishing);
    void establishing.catch(() => {
      if (this.#sessionIdentities.get(conversationId) === establishing) {
        this.#sessionIdentities.delete(conversationId);
      }
    });
    return establishing;
  }

  async admit(
    input: DurableConversationAdmissionInput,
  ): Promise<DurableConversationAdmissionResult> {
    const key = admissionKey(input);
    if (!key) {
      throw new Error("Durable conversation admission requires a stable turn id");
    }
    await this.ensureSession(input.conversationId);
    const admission = await this.#applyInputAdmission(input);
    let state: Awaited<ReturnType<ConversationRunJournal["runState"]>> = "queued";
    if (admission.replayed) {
      try {
        state = await this.#journal(input.conversationId).runState(admission.runId);
      } catch {
        this.#markRecovery(input.conversationId);
        return { runId: admission.runId, shouldSchedule: false };
      }
    }
    const shouldSchedule =
      state === "queued" &&
      !this.#schedulingRuns.has(admission.runId) &&
      !this.#scheduledRuns.has(admission.runId);
    if (shouldSchedule) {
      this.#schedulingRuns.add(admission.runId);
      this.#preparedAdmissions.set(key, {
        conversationId: input.conversationId,
        surfacePrincipal: admission.ingress.surfacePrincipal,
        admission,
        input: normalizeUserTurnInput(input.input),
        attachments: [...(input.attachments ?? [])],
        invocation: input.invocation,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
      });
      this.#markRecovery(input.conversationId);
    }
    return { runId: admission.runId, shouldSchedule };
  }

  confirmScheduled(conversationId: string, runId: string): void {
    const prepared = [...this.#preparedAdmissions.values()].find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.admission.runId === runId,
    );
    if (!prepared && !this.#scheduledRuns.has(runId)) return;
    this.#schedulingRuns.delete(runId);
    this.#scheduledRuns.add(runId);
  }

  deferScheduling(conversationId: string, runId: string): void {
    this.#clearRunClaims(runId);
    this.#markRecovery(conversationId);
  }

  async cancelAdmitted(conversationId: string, runId: string): Promise<void> {
    const request = {
      runId,
      requestId: `cancel:pending:${runId}`,
    };
    const journal = this.#journal(conversationId);
    try {
      await this.#terminalOperations.run(() =>
        this.#driveCancellation(journal, request)
      );
      this.#clearRunClaims(runId);
      this.#markRecovery(conversationId);
      this.#kickDelivery();
    } catch (firstError) {
      this.#markRecovery(conversationId);
      try {
        await this.#terminalOperations.run(() =>
          this.#driveCancellation(journal, request)
        );
        this.#clearRunClaims(runId);
        this.#markRecovery(conversationId);
        this.#kickDelivery();
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation scheduler cancellation could not determine its durable disposition",
        );
      }
    }
  }

  async findRunByIngress(
    conversationId: string,
    ingressId: string,
    source: ConversationInvocation["source"],
  ) {
    return this.#journal(conversationId).runByIngress(ingressId, source);
  }

  async findInteractionOutcome(conversationId: string, requestId: string) {
    return this.#journal(conversationId).interactionOutcome(requestId);
  }

  async touchWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<{ readonly revision: number; readonly at: string }> {
    await this.ensureSession(input.conversationId);
    const { conversationId, ...activity } = input;
    return this.#journal(conversationId).touchWorksceneSession(activity);
  }

  deleteWorksceneSession(input: {
    readonly conversationId: string;
    readonly sceneId: string;
    readonly requestId: string;
    readonly at: string;
  }): Promise<
    { readonly revision: number; readonly at: string } | undefined
  > {
    const { conversationId, ...activity } = input;
    return this.#journal(conversationId).deleteWorksceneSession(activity);
  }

  async cancel(
    input: DurableConversationCancelInput,
  ): Promise<DurableConversationCancellationResult> {
    return this.#terminalOperations.run(() => this.#cancelInternal(input));
  }

  async #cancelInternal(
    input: DurableConversationCancelInput,
  ): Promise<DurableConversationCancellationResult> {
    const journal = this.#journal(input.conversationId);
    if (!input.runId) return this.#cancelBatch(input, journal);
    const candidate = await journal.runControlDescriptor(input.runId);
    if (!candidate) return { dispositions: [] };
    const runId = candidate.runId;
    const source = { principal: { ...input.principal } };
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, {
      admission: this.#authority.controlAdmission,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: {
          t: "cancel",
          conversationId: input.conversationId,
          runId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
        },
      }),
      source,
    });
    if (outcome.kind === "rejected") {
      throw new Error(
        `Conversation cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.status === "rejected") {
      throw new Error(
        `Conversation cancellation was rejected: ${outcome.result.error.message}`,
      );
    }
    if (outcome.result.body.t !== "cancel") {
      throw new Error("Conversation cancellation returned another control result");
    }
    if (outcome.result.body.runState === "cancel-requested") {
      await this.#drivePendingCancellations(journal);
    }
    const local = this.#manager().applyDurableCancellation(
      input.conversationId,
      runId,
      input.reason,
    );
    this.#clearRunClaims(runId);
    this.#markRecovery(input.conversationId);
    this.#kickDelivery();
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

  /**
   * 批量取消是一个以外层 requestId 线性化的权威决定:候选集在 apply 时刻
   * 由 owner 以单源谓词冻结,重放消费 applied 原批次、零重新枚举;本地
   * 止损按耐久结果逐 run 幂等执行。空批次的用户回执由同一决定的
   * delivery companion 承担,runtime 只负责唤醒投递。
   */
  async #cancelBatch(
    input: DurableConversationCancelInput,
    journal: ConversationRunJournal,
  ): Promise<DurableConversationCancellationResult> {
    const source = { principal: { ...input.principal } };
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, {
      admission: this.#authority.controlAdmission,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: {
          t: "cancel-batch",
          conversationId: input.conversationId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
          ...(input.response
            ? { response: { replyTarget: input.response.replyTarget } }
            : {}),
        },
      }),
      source,
    });
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
    if (outcome.result.body.runs.some((run) => run.runState === "cancel-requested")) {
      await this.#drivePendingCancellations(journal);
    }
    const dispositions: DurableConversationCancellationDisposition[] = [];
    for (const run of outcome.result.body.runs) {
      const local = this.#manager().applyDurableCancellation(
        input.conversationId,
        run.runId,
        input.reason,
      );
      this.#clearRunClaims(run.runId);
      dispositions.push({
        runId: run.runId,
        runState: run.runState,
        source: run.source,
        ingressId: run.ingressId,
        ...local,
      });
    }
    if (dispositions.length > 0) this.#markRecovery(input.conversationId);
    this.#kickDelivery();
    return { dispositions };
  }

  async resolveUncertain(
    input: DurableConversationResolveInput,
  ): Promise<DurableConversationResolutionResult> {
    const source = { principal: { ...input.principal } };
    const journal = this.#journal(input.conversationId);
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, {
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
    });
    if (outcome.kind === "rejected") {
      throw new Error(`Conversation resolution was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.status === "rejected") {
      throw new Error(`Conversation resolution was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.body.t !== "uncertain-resolve") {
      throw new Error("Conversation resolution returned another control result");
    }
    const result = {
      state: outcome.result.body.state,
      factDigest: outcome.result.body.factDigest,
    };
    this.#markRecovery(input.conversationId);
    this.#kickDelivery();
    if (result.state === "queued") {
      try {
        if ((await journal.runState(input.runId)) === "queued") {
          await this.#scheduleResolvedRetry(input.conversationId, input.runId, journal);
        }
      } catch {
        // The resolution is authoritative. Its recovery generation owns any
        // scheduler admission or projection that did not finish in this call.
        this.#markRecovery(input.conversationId);
      }
    }
    return result;
  }

  async writeSession(
    input: DurableConversationSessionWriteInput,
  ): Promise<DurableConversationSessionWriteResult> {
    const journal = this.#journal(input.conversationId);
    const lifecycleMutation =
      input.mutation.kind === "conversation-delete" ||
      (input.mutation.kind === "window-op" && input.mutation.op === "clear");
    const existingLifecycle = lifecycleMutation
      ? await journal.lifecycleRequest(input.requestId)
      : undefined;
    const existingMutation = lifecycleMutation
      ? undefined
      : await journal.sessionMutationRequest(input.requestId);
    const existing = existingLifecycle ?? existingMutation;
    const authority = existing ? undefined : await journal.authorityState();
    if (
      !existing &&
      !authority!.hasDurableIdentity &&
      !(await input.conversationExists())
    ) {
      return { status: "not-found" };
    }
    const domainRevision = existing
      ? existing.domainRevision - 1
      : authority!.domainRevision;
    const source = { principal: { ...input.principal } };
    const outcome = await this.#applyAuthorityControl(input.conversationId, journal, {
      admission: this.#authority.controlAdmission,
      envelope: createConversationControlEnvelope({
        requestId: input.requestId,
        source,
        at: this.#clock(),
        body: {
          t: "session-write",
          conversationId: input.conversationId,
          mutation: input.mutation,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
          domainRevision,
        },
      }),
      source,
    });
    if (outcome.kind === "rejected") {
      throw new Error(`Session write was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.status === "rejected") {
      if (
        outcome.result.error.code === "busy" ||
        outcome.result.error.code === "revision-conflict"
      ) {
        return { status: "busy" };
      }
      if (outcome.result.error.code === "not-found") {
        return { status: "not-found" };
      }
      throw new Error(`Session write was rejected: ${outcome.result.error.message}`);
    }
    if (outcome.result.body.t !== "session-write") {
      throw new Error("Session write returned another control result");
    }
    if (lifecycleMutation) this.#markRecovery(input.conversationId);
    return {
      status: "accepted",
      domainRevision: outcome.result.body.revision,
    };
  }

  async projectSession(
    input: DurableConversationSessionProjectionInput,
  ): Promise<void> {
    const journal = this.#journal(input.conversationId);
    const fact = await journal.lifecycleRequest(input.requestId);
    if (
      !fact ||
      fact.conversationId !== input.conversationId ||
      fact.mutation !== input.mutation ||
      fact.domainRevision !== input.domainRevision
    ) {
      throw new Error("Lifecycle projection does not bind its durable authority fact");
    }
    await this.#resumeLifecycleProjections(input.conversationId, journal);
  }

  async *run(input: DurableConversationTurnInput): AsyncGenerator<AgentYield, RunResult> {
    const preparedKey = admissionKey(input);
    const prepared = preparedKey
      ? this.#preparedAdmissions.get(preparedKey)
      : undefined;
    if (
      prepared &&
      (canonicalize(prepared.input) !==
        canonicalize(normalizeUserTurnInput(input.input)) ||
        canonicalize(prepared.attachments) !==
          canonicalize(input.attachments ?? []) ||
        canonicalize(prepared.invocation) !== canonicalize(input.invocation) ||
        canonicalize(prepared.environment ?? null) !==
          canonicalize(input.environment ?? null))
    ) {
      throw new Error("Prepared conversation admission does not bind this invocation");
    }
    const appliedAdmission =
      prepared?.admission ?? await this.#applyInputAdmission(input, true);
    const requestId = inputControlRequestId(appliedAdmission.ingress);
    const journal = this.#journal(input.conversationId);
    const runId = appliedAdmission.runId;
    if (this.#schedulingRuns.has(runId)) {
      this.confirmScheduled(input.conversationId, runId);
    } else {
      this.#scheduledRuns.add(runId);
    }
    if (preparedKey) this.#preparedAdmissions.delete(preparedKey);
    let executionIngress = appliedAdmission.ingress;
    if (appliedAdmission.replayed) {
      const committed = await journal.committedRun(runId);
      if (committed) {
        this.#clearRunClaims(runId);
        return replayCommittedRun(committed.runRecord, committed.windowCompact);
      }
      const replayedState = await journal.runState(runId);
      if (replayedState !== "queued") {
        throw new Error(
          `Conversation input ${requestId} already resolved to run ${runId} in state ${replayedState ?? "unknown"}`,
        );
      }
      const pending = (await journal.pendingInputs()).find(
        (candidate) => candidate.runId === runId,
      );
      if (!pending) {
        throw new Error(`Queued conversation run ${runId} has no durable input`);
      }
      executionIngress = pending.ingress;
    }
    const attempt = await journal.nextAssignmentAttempt(runId);
    const assignmentId = conversationAssignmentId(runId, attempt);
    let channelSession: LosslessDataPlaneSession | undefined;
    let firstPartySurfaceSession: FirstPartySurfaceSession | undefined;
    let firstPartyFinalitySession: FirstPartyFinalitySession | undefined;
    let localBaseRuntime: SessionRuntime | undefined;
    let localExecutionRuntime: SessionRuntime | undefined;
    let localRuntimePromoted = false;
    let localPreflightManifest:
      | import("@zhixing/core/contracts").ExecutionManifest<"conversation">
      | undefined;
    try {
      const authority = await journal.authorityState();
      if (authority.deleted) {
        throw new Error("Conversation has been durably deleted");
      }
      const executionProfile = input.runtime.executionProfile?.();
      const permissionRules = input.runtime.executionPermissionRules?.();
      if (executionProfile === undefined || permissionRules === undefined) {
        throw new Error(
          "Durable conversation runtime must expose execution and permission snapshots",
        );
      }
      const remoteTargets = this.#remoteExecution &&
          supportsRemoteConversationExecution(input.invocation, executionIngress)
        ? await this.#remoteExecution.candidates()
        : [];
      const localLedger = this.#ledger;
      if (remoteTargets.length === 0 && !localLedger) {
        throw new Error("No authorized conversation executor is currently available");
      }
      const recentExecutorId = await journal.recentExecutorAffinity();
      const preparedAuthority = await this.#authority.prepareConversationAssignment({
        conversationId: input.conversationId,
        executionProfile,
        permissionRules,
        ...(recentExecutorId ? { recentExecutorId } : {}),
        ...(appliedAdmission.environment
          ? { environment: appliedAdmission.environment }
          : {}),
        targets: remoteTargets.map((target) => ({
          executorId: target.executorId,
          deviceId: target.deviceId,
          synchronizePermission: (snapshot, executionAssets) =>
            target.synchronizePermission(snapshot, executionAssets),
        })),
      });
      const targetExecutorId = preparedAuthority.executorId;
      const remoteTarget = targetExecutorId === this.#authority.executorId
        ? undefined
        : remoteTargets.find((target) => target.executorId === targetExecutorId);
      if (!remoteTarget && targetExecutorId !== this.#authority.executorId) {
        throw new Error("Selected remote executor disappeared from the candidate set");
      }
      if (remoteTarget && input.adaptLocalRuntime) {
        throw new Error("A local invocation runtime adapter cannot execute remotely");
      }
      const origin = reservationOriginForSource(input.options?.source);
      const resourceContext = resourceHostContext(
        "reservation.prepareAssignmentRoot",
        assignmentId,
        this.#clock(),
      );
      await this.#authority.resourceGovernor.enqueueRoot(
        assignmentReservationId(assignmentId),
        { kind: "run", id: runId, attempt },
        origin,
        resourceContext,
      );
      const resourceLease: AssignmentResourceLease<"conversation"> =
        await this.#authority.resourceGovernor.prepareAssignmentRoot<"conversation">({
        assignmentId,
        executorId: targetExecutorId,
        workload: { kind: "run", id: runId, attempt },
        scopeBinding: {
          kind: "conversation",
          conversationId: input.conversationId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
        },
        budget: preparedAuthority.policy.budget,
        }, origin, resourceContext);
      const unsigned = this.#issuer.issue({
        runId,
        assignmentId,
        executorId: targetExecutorId,
        conversationId: input.conversationId,
        ownerEpoch: this.#ownerEpochFor(input.conversationId),
        baseRevision: authority.commitRevision,
        attempt,
        resourceLease,
        ingress: executionIngress,
        contentAssets: [...appliedAdmission.attachments],
        windowInput: {
          t: "full",
          windowEpoch: authority.commitRevision + 1,
          messages: [...input.messages],
        },
        policy: preparedAuthority.policy,
        environment: preparedAuthority.environment,
        memoryResources: await this.#memoryResourcesForAssignment(
          input.conversationId,
          assignmentId,
        ),
      });
      if (!remoteTarget) {
        localPreflightManifest = unsigned.manifest;
        const preflight =
          await this.#authority.preflightLocalConversationEnvironment(
            unsigned.manifest,
            assignmentId,
          );
        if (preflight.error) throw new Error(preflight.error.message);
        const runtimeFactory = this.#localRuntimeFactory;
        if (!runtimeFactory) {
          throw new Error("Local assignment runtime factory is unavailable");
        }
        localBaseRuntime = await runtimeFactory.create(
          input.conversationId,
          { workspaceRoot: preflight.workspaceRoot },
        );
        localExecutionRuntime = input.adaptLocalRuntime?.(localBaseRuntime) ??
          localBaseRuntime;
        const actualProfile = requireRuntimeExecutionProfile(
          localExecutionRuntime,
        );
        if (
          canonicalize(actualProfile) !==
          canonicalize(preparedAuthority.binding.executionProfile)
        ) {
          throw new Error(
            "Local assignment runtime does not match the frozen execution profile",
          );
        }
      }
      const dispatch = await journal.assign(unsigned);
      localRuntimePromoted = true;
      this.#rememberAssignment(dispatch.envelope, dispatch.activation);
      this.#assignmentRuntimeBindings.set(
        assignmentId,
        localExecutionRuntime
          ? {
              ...preparedAuthority.binding,
              executionProfile:
                requireRuntimeExecutionProfile(localExecutionRuntime),
            }
          : preparedAuthority.binding,
      );
      const submission = remoteTarget
        ? undefined
        : this.#createLocalSubmission(journal);
      const submissionContext = assignmentContext(dispatch.envelope);
      const resourceSubmissionContext = assignmentResourceContext(dispatch.envelope);
      const flushResourceUsage = () =>
        this.#authority.finalizeUsage(
          assignmentId,
          (report) => usageReporterContext(report.reporterId, report.digest, this.#clock()),
        );
      const dispatcher = new InProcessConversationDispatcher({
        enabled: true,
        journal,
        executor: remoteTarget?.executor ?? localLedger!,
        contexts: this.#contexts,
        cancellationSubmission: {
          submitCancellation: submission
            ? (id: string) => submission.submitCancellation(
                id,
                assignmentContext(dispatch.envelope),
              )
            : async (id: string) => {
                const snapshot = await remoteTarget!.executor.queryLedger(
                  id,
                  this.#contexts.create(id, "executor.queryLedger", {
                    requestId: `ledger:${id}:cancel-proof`,
                    body: { range: null },
                  }),
                );
                if (!("phase" in snapshot) || !snapshot.cancelProof) return false;
                await journal.submitCancelProof(
                  id,
                  snapshot.cancelProof,
                  assignmentContext(dispatch.envelope),
                );
                return true;
              },
        },
        bundleSubmission: {
          submitSealedBundle: submission
            ? (id: string) => submission.submitSealedBundle(
                id,
                assignmentContext(dispatch.envelope),
              )
            : async () => remoteBundleSubmissionDeferred(),
        },
      });
      let dispatchResults: readonly DispatchResult[] | undefined;
      try {
        dispatchResults = await dispatcher.dispatchPending();
      } catch (error) {
        if (!remoteTarget || !isRetryableMeshFailure(error)) throw error;
      } finally {
        this.#assignmentRuntimeBindings.delete(assignmentId);
      }
      if (dispatchResults && (
        dispatchResults.length !== 1 || !dispatchResults[0]!.accepted
      )) {
        const rejection = dispatchResults[0];
        throw new Error(
          rejection && !rejection.accepted
            ? `${remoteTarget ? "Remote" : "Local"} executor rejected a freshly issued assignment: ${rejection.error.message}`
            : `${remoteTarget ? "Remote" : "Local"} executor did not return exactly one dispatch result`,
        );
      }
      const streamRef = {
        execution: "conversation",
        conversationId: input.conversationId,
        runId,
        ownerEpoch: this.#ownerEpochFor(input.conversationId),
      } as const;
      if (
        executionIngress.kind === "channel" &&
        this.#losslessDataPlane
      ) {
        const ticketId = `ticket:${protocolDigest(
          "ConversationChannelTicketIdentity",
          1,
          {
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
          },
        )}`;
        const ticket = await journal.issueDataPlaneTicket({
          ticketId,
          assignmentId,
          surfacePrincipal: executionIngress.surfacePrincipal,
          kind: "run-interact",
          ttlMs: 24 * 60 * 60 * 1_000,
        });
        channelSession =
          await this.#losslessDataPlane.openConversationChannel({
            executorId: targetExecutorId,
            assignmentId,
            ref: {
              execution: "conversation",
              conversationId: input.conversationId,
              runId,
              ownerEpoch: this.#ownerEpochFor(input.conversationId),
            },
            ticket,
            journal,
          });
      } else if (
        executionIngress.kind === "first-party" &&
        this.#losslessDataPlane?.openFirstPartySurfaceSession
      ) {
        const ticketId = `ticket:${protocolDigest(
          "ConversationFirstPartyTicketIdentity",
          1,
          {
            assignmentId,
            surfacePrincipal: executionIngress.surfacePrincipal,
          },
        )}`;
        const ticket = await journal.issueDataPlaneTicket({
          ticketId,
          assignmentId,
          surfacePrincipal: executionIngress.surfacePrincipal,
          kind: "run-interact",
          ttlMs: 24 * 60 * 60 * 1_000,
        });
        firstPartyFinalitySession = this.#createFirstPartyFinality?.({
          lastSeen: [
            {
              subject: streamRef,
              afterStatusRevision: 0,
            },
          ],
          onStatus: () => undefined,
          ...(this.#onFinal
            ? {
                onConversationFinal: async (frame) => {
                  const identity = canonicalize(frame);
                  if (this.#ownerPublishedFirstPartyFinals.delete(identity)) {
                    this.#pendingFirstPartyFinals.delete(identity);
                    return;
                  }
                  await this.#onFinal?.(frame);
                  this.#pendingFirstPartyFinals.delete(identity);
                  this.#firstPartyPublishedFinals.add(identity);
                },
              }
            : {}),
        });
        await firstPartyFinalitySession?.start();
        firstPartySurfaceSession =
          await this.#losslessDataPlane.openFirstPartySurfaceSession({
            executorId: targetExecutorId,
            assignmentId,
            ref: streamRef,
            ticket,
            surfacePrincipal: executionIngress.surfacePrincipal,
            adoptFrame: async (frame) => {
              if (frame.payload.kind === "provisional-final") {
                await firstPartyFinalitySession?.acceptProvisionalFinal(frame);
              }
              await this.#onFirstPartyFrame?.(frame);
            },
          });
      }
      if (remoteTarget) {
        firstPartySurfaceSession?.start();
        return await this.#awaitRemoteConversationRun({
          journal,
          dispatcher,
          executor: remoteTarget.executor,
          conversationId: input.conversationId,
          runId,
          assignmentId,
        });
      }
      if (!submission) throw new Error("Local assignment submission is unavailable");
      await submission.startAndReport(assignmentId, submissionContext);

      const stream: DurableAssignmentRunStream = this.#createStream
        ? await this.#createStream({ assignmentId, ref: streamRef })
        : new StreamDigestChain(assignmentId);
      firstPartySurfaceSession?.start();
      const streamMeta = executionIngress.turnOrigin
        ? { turnOrigin: executionIngress.turnOrigin }
        : {};
      const yieldToDurableCancellation = async (): Promise<boolean> => {
        const state = await journal.runState(runId);
        if (state !== "cancel-requested" && state !== "cancelled") return false;
        if (state === "cancel-requested") {
          await this.#drivePendingCancellations(journal);
        }
        await stream.markTerminal?.();
        this.#markRecovery(input.conversationId);
        this.#kickDelivery(input.hooks?.onFinalPublishFailure);
        return true;
      };
      let toolCalls = 0;
      const interactionBinding: DurableInteractionBinding = {
        assignmentId,
        ledger: localLedger!,
        submission,
        context: submissionContext,
        surfacePrincipal: executionIngress.surfacePrincipal,
        broker: localExecutionRuntime!.confirmationBroker,
        stream,
        streamMeta,
      };
      const controlHeartbeat = this.#startControlHeartbeat(assignmentId);
      let runResult: RunResult;
      try {
        const generator = localExecutionRuntime!.run(input.messages, {
          ...input.options,
          onProtocolEvent: async (event, meta) => {
            await stream.append(
              { kind: "agent-event", event },
              {
                ...streamMeta,
                ...(meta.lineage ? { lineage: meta.lineage } : {}),
              },
            );
          },
          toolSideEffectObserver: this.#interactions,
          ...(this.#authority.globalPublishing
            ? {
                stageScheduleMutation: createAssignmentScheduleStager(
                  localLedger!,
                  assignmentId,
                  this.#authority.ownerEpoch,
                  "conversation",
                  assignmentGlobalCapability({
                    assignmentId,
                    execution: "conversation",
                    capabilities: dispatch.envelope.capabilities,
                  }),
                ),
              }
            : {}),
          assignmentMutations: createAssignmentMutationPort({
            ledger: localLedger!,
            assignmentId,
            execution: "conversation",
            anchorEpoch: this.#authority.ownerEpoch,
            allowGlobal: this.#authority.globalPublishing,
            ...(this.#authority.globalPublishing
              ? {
                  capability: assignmentGlobalCapability({
                    assignmentId,
                    execution: "conversation",
                    capabilities: dispatch.envelope.capabilities,
                  }),
                }
              : {}),
          }),
          ...(this.#authority.globalState
            ? {
                globalQuery: createAssignmentGlobalQueryPort({
                  state: this.#authority.globalState,
                  capability: assignmentGlobalCapability({
                    assignmentId,
                    execution: "conversation",
                    capabilities: dispatch.envelope.capabilities,
                  }),
                  anchorEpoch: this.#authority.ownerEpoch,
                }),
              }
            : this.#authority.executionAssetCatalog
              ? { globalQuery: this.#authority.executionAssetCatalog }
              : {}),
          authorizeToolExecution: () =>
            localLedger!.authorizeToolExecution(
              assignmentId,
              dispatch.envelope.permissionLease,
            ),
          modelCallResourceMeter: {
            reserve: async ({ callIndex, tokenUpperBound }) => {
              const usageId = `usage:${assignmentId}:model:${callIndex}`;
              await this.#requireExecutorResourceGovernor().reserveUsage(
                dispatch.envelope.resourceLease,
                { usageId, tokens: tokenUpperBound, calls: 1 },
                resourceSubmissionContext,
              );
              return { usageId };
            },
            consume: async ({ usageId, tokens }) => {
              await this.#requireExecutorResourceGovernor().consume(
                dispatch.envelope.resourceLease,
                { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
                resourceSubmissionContext,
              );
            },
          },
        });
        while (true) {
          const item = await this.#interactions.withBinding(
            interactionBinding,
            () => generator.next(),
          );
          if (item.done) {
            runResult = item.value;
            break;
          }
          if (item.value.type === "tool_start") toolCalls += 1;
          await stream.append(
            { kind: "agent-yield", yield: item.value },
            streamMeta,
          );
          yield item.value;
        }
      } catch (error) {
        await controlHeartbeat.stop();
        try {
          await this.#terminalOperations.run(async () => {
            if (await yieldToDurableCancellation()) return;
            const usageFinal = await flushResourceUsage();
            if (await localLedger!.hasOpenSideEffects(assignmentId)) {
              await journal.markAssignmentUncertain(assignmentId, "ledger-unknown");
            } else {
              await this.#prepareRunEndUntilAvailable(
                assignmentId,
                submission,
                submissionContext,
                interactionBinding,
              );
              await stream.final(streamMeta);
              const failure = await localLedger!.failExecution(assignmentId, {
                reason: executionFailureReason(error),
                usageFinal,
              });
              if (failure) {
                const currentState = await journal.runState(runId);
                if (currentState === "dispatched" || currentState === "running") {
                  await journal.failAssignedRun(
                    runId,
                    assignmentId,
                    failure.reason,
                    failure.usageFinal,
                  );
                }
              }
              await stream.markTerminal?.();
            }
            this.#kickDelivery();
          });
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            `Conversation execution failed (${executionFailureReason(error)}) and durable failure settlement failed (${executionFailureReason(settlementError)})`,
          );
        }
        throw error;
      }
      await controlHeartbeat.stop();

      if (runResult.agentResult.reason !== "completed") {
        const cancelled = await this.#terminalOperations.run(async () => {
          if (await yieldToDurableCancellation()) return true;
          const usageFinal = await flushResourceUsage();
          if (await localLedger!.hasOpenSideEffects(assignmentId)) {
            await journal.markAssignmentUncertain(assignmentId, "ledger-unknown");
          } else {
            await this.#prepareRunEndUntilAvailable(
              assignmentId,
              submission,
              submissionContext,
              interactionBinding,
            );
            await stream.final(streamMeta);
            const failure = await localLedger!.failExecution(assignmentId, {
              reason: runFailureReason(runResult.agentResult),
              usageFinal,
            });
            if (failure) {
              const currentState = await journal.runState(runId);
              if (
                currentState === "dispatched" ||
                currentState === "running"
              ) {
                await journal.failAssignedRun(
                  runId,
                  assignmentId,
                  failure.reason,
                  failure.usageFinal,
                );
              }
            }
            await stream.markTerminal?.();
          }
          return false;
        });
        if (cancelled) return cancelledRunResult(runResult);
        this.#kickDelivery(input.hooks?.onFinalPublishFailure, runResult);
        return runResult;
      }

      const terminal = await this.#terminalOperations.run(async () => {
        if (await yieldToDurableCancellation()) {
          return { kind: "cancelled" as const };
        }
        await this.#prepareRunEndUntilAvailable(
          assignmentId,
          submission,
          submissionContext,
          interactionBinding,
        );
        const sourceValue = runResult.runRecord.source ?? input.options?.source;
        const advancement =
          runResult.runRecord.advancement ?? input.options?.advancement;
        const transcriptRun: TranscriptRunRecord = {
          ...runResult.runRecord,
          type: "run",
          runId,
          runIndex: input.baseRevision,
          ...(sourceValue ? { source: sourceValue } : {}),
          ...(advancement ? { advancement } : {}),
        };
        const usageFinal = await flushResourceUsage();
        const bundle = await localLedger!.sealConversationBundle(assignmentId, {
          runRecord: transcriptRun,
          ...(runResult.windowCompact
            ? { windowCompact: runResult.windowCompact }
            : {}),
          contentAssets: [...appliedAdmission.attachments],
          streamFinal: await stream.final(streamMeta),
          usage: {
            inputTokens: runResult.agentResult.usage.inputTokens,
            outputTokens: runResult.agentResult.usage.outputTokens,
            toolCalls,
          },
          usageFinal,
        });
        const committed = await submission.submitSealedBundle(
          assignmentId,
          submissionContext,
        );
        if (!committed.committed) {
          const error = new Error(
            `Conversation commit rejected: ${committed.error.message}`,
          );
          input.hooks?.onCommitFailure?.(error, runResult);
          throw error;
        }
        await stream.markTerminal?.();
        return { kind: "committed" as const, bundle, committed };
      });
      if (terminal.kind === "cancelled") return cancelledRunResult(runResult);
      const { bundle, committed } = terminal;
      if (firstPartySurfaceSession && firstPartyFinalitySession) {
        const final = (await journal.pendingFinalFrames()).find(
          (candidate) =>
            candidate.conversationId === input.conversationId &&
            candidate.runId === runId &&
            candidate.commitRevision === committed.commitRevision,
        );
        if (!final) {
          throw new Error(
            "Committed first-party run has no durable final projection",
          );
        }
        const finalIdentity = canonicalize(final);
        this.#pendingFirstPartyFinals.add(finalIdentity);
        try {
          await firstPartyFinalitySession.confirmConversationFinal({
            frame: final,
            bundle,
          });
        } catch (error) {
          input.hooks?.onFinalPublishFailure?.(error, runResult);
        }
        const surfaceSession = firstPartySurfaceSession;
        const finalitySession = firstPartyFinalitySession;
        const closeFirstPartyProjection = async () => {
          this.#pendingFirstPartyFinals.delete(finalIdentity);
          this.#ownerPublishedFirstPartyFinals.delete(finalIdentity);
          finalitySession.close();
          await surfaceSession.close();
        };
        void surfaceSession.waitForSeq(bundle.streamFinal.finalSeq).then(
          closeFirstPartyProjection,
          closeFirstPartyProjection,
        ).catch(() => undefined);
        firstPartySurfaceSession = undefined;
        firstPartyFinalitySession = undefined;
      }
      this.#markRecovery(input.conversationId);
      this.#kickDelivery(input.hooks?.onFinalPublishFailure, runResult);
      return runResult;
    } catch (error) {
      this.#markRecovery(input.conversationId);
      throw error;
    } finally {
      await channelSession?.close();
      firstPartyFinalitySession?.close();
      await firstPartySurfaceSession?.close();
      const disposeReason = localRuntimePromoted
        ? "assignment-dispose"
        : "assembly-rollback";
      await localExecutionRuntime?.dispose(disposeReason);
      if (localBaseRuntime && localBaseRuntime !== localExecutionRuntime) {
        await localBaseRuntime.dispose(disposeReason);
      }
      if (localPreflightManifest) {
        this.#authority.releaseLocalConversationEnvironmentPreflight(
          localPreflightManifest,
          assignmentId,
        );
      }
      this.#clearRunClaims(runId);
      this.#forgetAssignment(assignmentId);
    }
  }

  async #prepareRunEndUntilAvailable(
    assignmentId: string,
    submission: InProcessAssignmentSubmission,
    context: AuthorityCallContext,
    interactionBinding: DurableInteractionBinding,
  ): Promise<void> {
    await retryDurableObligation(async () => {
      await submission.prepareForRunEnd(assignmentId, context);
      await this.#interactions.drainAssignment(interactionBinding);
    });
  }

  async #applyInputAdmission(
    input: DurableConversationAdmissionInput,
    allowPendingReplay = false,
  ): Promise<AppliedConversationAdmission> {
    const at = this.#clock();
    const ingress = ingressForTurn(input, this.#authority.deviceId, at);
    const requestId = inputControlRequestId(ingress);
    const durablePending = allowPendingReplay
      ? (await this.#journal(input.conversationId).pendingInputs()).find(
          (candidate) =>
            candidate.ingress.ingressId === ingress.ingressId &&
            candidate.ingress.surfacePrincipal === ingress.surfacePrincipal,
        )
      : undefined;
    if (durablePending) {
      if (
        canonicalize(durablePending.input) !==
          canonicalize(normalizeUserTurnInput(input.input)) ||
        canonicalize(durablePending.attachments) !==
          canonicalize(input.attachments ?? []) ||
        canonicalize(durablePending.invocation) !== canonicalize(input.invocation)
        ||
        canonicalize(durablePending.environment ?? null) !==
          canonicalize(input.environment ?? null)
      ) {
        throw new DurableConversationAdmissionRejectedError(
          "idempotency-conflict",
          "Conversation ingress is already bound to another invocation",
        );
      }
      await this.#markAttachmentsAdopted(durablePending.attachments);
      return {
        runId: durablePending.runId,
        ingress: durablePending.ingress,
        attachments: durablePending.attachments,
        ...(durablePending.environment
          ? { environment: structuredClone(durablePending.environment) }
          : {}),
        replayed: true,
      };
    }
    const source = {
      principal: {
        surfacePrincipal: ingress.surfacePrincipal,
        deviceId: this.#authority.deviceId,
        connectionId:
          input.options?.turnContext?.turnOrigin?.triggeredBy ?? "connection:local",
      },
      ingress,
    };
    const journal = this.#journal(input.conversationId);
    const envelope = createInitialControlEnvelope({
      requestId,
      source,
      at,
      body: {
        t: "input",
        conversationId: input.conversationId,
        ingress: { ingressId: ingress.ingressId, source: ingress.kind },
        input: normalizeUserTurnInput(input.input),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: [...input.attachments] }
          : {}),
        invocation: input.invocation,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
        ownerEpoch: this.#ownerEpochFor(input.conversationId),
      },
    });
    const control = {
      admission: this.#authority.controlAdmission,
      envelope,
      source,
      runId: `run:${randomUUID()}`,
    } as const;
    const admissionState = await this.#authority.controlAdmission.lookup({
      envelope,
      source,
    });
    if (admissionState.kind === "settled") {
      const appliedReplay = admissionState.outcome;
      if (appliedReplay.kind === "rejected") {
        throw new DurableConversationAdmissionRejectedError(
          "idempotency-conflict",
          `Conversation input was rejected: ${appliedReplay.result.error.message}`,
        );
      }
      if (appliedReplay.result.status === "rejected") {
        throw new DurableConversationAdmissionRejectedError(
          appliedReplay.result.error.code === "idempotency-conflict"
            ? "idempotency-conflict"
            : "conversation-not-found",
          `Conversation input was rejected: ${appliedReplay.result.error.message}`,
        );
      }
      if (appliedReplay.result.body.t !== "input") {
        throw new Error("Conversation input admission returned another control result");
      }
      const replayedAttachments = [...(input.attachments ?? [])];
      await this.#markAttachmentsAdopted(replayedAttachments);
      return {
        runId: appliedReplay.result.body.runId,
        ingress,
        attachments: replayedAttachments,
        ...(input.environment
          ? { environment: structuredClone(input.environment) }
          : {}),
        replayed: true,
      };
    }
    if (
      admissionState.kind === "absent"
      && input.attachments
      && input.attachments.length > 0
    ) {
      await this.#assertUploadAdoption({
        scope: {
          domain: "conversation",
          conversationId: input.conversationId,
          ownerEpoch: this.#ownerEpochFor(input.conversationId),
        },
        surfacePrincipal: ingress.surfacePrincipal,
        requestId,
        assets: input.attachments,
        payloadDigest: envelope.payloadDigest,
      });
    }
    let admission: Awaited<ReturnType<ConversationRunJournal["applyInputControl"]>>;
    try {
      admission = await journal.applyInputControl(control);
    } catch (firstError) {
      // The append may have committed before its response was lost. Replaying the
      // exact envelope recovers the stable runId instead of reporting an ordinary
      // admission failure for work already owned by the durable scheduler.
      this.#markRecovery(input.conversationId);
      try {
        admission = await journal.applyInputControl(control);
      } catch (replayError) {
        if (
          firstError instanceof DurableConversationAdmissionRejectedError &&
          replayError instanceof DurableConversationAdmissionRejectedError
        ) {
          throw replayError;
        }
        throw new AggregateError(
          [firstError, replayError],
          "Conversation input admission could not determine its durable disposition",
        );
      }
    }
    if (admission.kind === "rejected") {
      throw new DurableConversationAdmissionRejectedError(
        "idempotency-conflict",
        `Conversation input was rejected: ${admission.result.error.message}`,
      );
    }
    if (admission.result.status === "rejected") {
      throw new DurableConversationAdmissionRejectedError(
        admission.result.error.code === "idempotency-conflict"
          ? "idempotency-conflict"
          : "conversation-not-found",
        `Conversation input was rejected: ${admission.result.error.message}`,
      );
    }
    if (admission.result.body.t !== "input") {
      throw new Error("Conversation input admission returned another control result");
    }
    let durableIngress = ingress;
    let durableAttachments = [...(input.attachments ?? [])];
    let durableEnvironment = input.environment
      ? structuredClone(input.environment)
      : undefined;
    const admittedRunId = admission.result.body.runId;
    if (admission.kind === "replayed") {
      const pending = (await journal.pendingInputs()).find(
        (candidate) => candidate.runId === admittedRunId,
      );
      if (pending) {
        durableIngress = pending.ingress;
        durableAttachments = [...pending.attachments];
        durableEnvironment = pending.environment
          ? structuredClone(pending.environment)
          : undefined;
      }
    }
    await this.#markAttachmentsAdopted(durableAttachments);
    return {
      runId: admittedRunId,
      ingress: durableIngress,
      attachments: durableAttachments,
      ...(durableEnvironment ? { environment: durableEnvironment } : {}),
      replayed: admission.kind === "replayed",
    };
  }

  async #memoryResourcesForAssignment(
    conversationId: string,
    assignmentId: string,
  ): Promise<readonly `memory-domain:${string}`[]> {
    const scope = parseConversationId(conversationId).scope;
    if (scope.kind === "workscene" || !this.#authority.globalState) return [];
    const now = Date.parse(this.#clock());
    const result = await this.#authority.globalState.read(
      { kind: "workscene-list" },
      {
        principal: { kind: "host", component: "conversation-assignment-issuer" },
        requestId: `assignment-memory-scopes:${assignmentId}`,
        deadlineAt: new Date(now + 30_000).toISOString(),
        authority: { domain: "global", anchorEpoch: this.#authority.anchorEpoch },
      },
    );
    if (result.kind !== "workscene-list") {
      throw new Error("Workscene authority returned another result type");
    }
    return result.scenes
      .map((scene) => `memory-domain:workscene:${scene.id}` as const)
      .sort();
  }

  async #markAttachmentsAdopted(
    attachments: PendingConversationInput["attachments"],
  ): Promise<void> {
    if (this.#authority.surfaceAssets) {
      await this.#authority.surfaceAssets.markAdopted(attachments);
      return;
    }
    for (const attachment of attachments) {
      if (!await this.#authority.artifacts.has(attachment)) {
        throw new Error(`Conversation attachment is unavailable: ${attachment.digest}`);
      }
    }
  }

  async #assertUploadAdoption(
    input: Parameters<
      import("@zhixing/core/authority").SurfaceAssetCoordinator["assertUploadAdoption"]
    >[0],
  ): Promise<void> {
    if (this.#authority.surfaceAssets) {
      await this.#authority.surfaceAssets.assertUploadAdoption(input);
      return;
    }
    for (const asset of input.assets) {
      if (!await this.#authority.artifacts.has(asset)) {
        throw new Error(`Conversation attachment is unavailable: ${asset.digest}`);
      }
    }
  }

  /** Internal owner-domain directory; no public RPC or channel registration. */
  async listSessions(): Promise<readonly string[]> {
    const ids = new Set(await this.#authority.controlAdmission.listCreatedConversationIds());
    for (const conversationId of this.#adoptedConversations.keys()) ids.add(conversationId);
    const active: string[] = [];
    for (const conversationId of ids) {
      if (!this.#acceptsConversationId(conversationId)) continue;
      const state = await this.#journalForQuery(conversationId).authorityState();
      if (!state.deleted) active.push(conversationId);
    }
    return active.sort((left, right) => left.localeCompare(right, "en-US"));
  }

  async sessionExists(conversationId: string): Promise<boolean> {
    if (!this.#acceptsConversationId(conversationId)) return false;
    if (!this.#adoptedConversations.has(conversationId)) {
      const ids = await this.#authority.controlAdmission.listCreatedConversationIds();
      if (!ids.includes(conversationId)) return false;
    }
    return !(await this.#journalForQuery(conversationId).authorityState()).deleted;
  }

  async #establishSession(conversationId: string): Promise<void> {
    const scope = {
      domain: "conversation" as const,
      conversationId,
      ownerEpoch: this.#ownerEpochFor(conversationId),
    };
    if (this.#authority.surfaceAssets &&
      await this.#authority.surfaceAssets.ownsScope(scope)) return;

    const parsed = parseConversationId(conversationId);
    const source = {
      principal: {
        surfacePrincipal: "owner:conversation-lifecycle",
        deviceId: this.#authority.deviceId,
        connectionId: "owner:conversation-lifecycle",
      },
    };
    const envelope = createInitialControlEnvelope({
      requestId: `session-create:${conversationId}`,
      source,
      at: this.#clock(),
      body: {
        t: "session-create",
        ...(parsed.scope.kind === "workscene"
          ? { sceneId: parsed.scope.sceneId }
          : {}),
      },
    });
    const apply = () =>
      this.#authority.controlAdmission.apply({
        envelope,
        source,
        prepare: () => ({
          result: {
            v: 1,
            status: "ok",
            body: { t: "session-create", conversationId },
          },
          authorityRevision: 1,
        }),
      });
    let outcome: Awaited<ReturnType<typeof apply>>;
    try {
      outcome = await apply();
    } catch (firstError) {
      try {
        outcome = await apply();
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation creation could not determine its durable disposition",
        );
      }
    }
    if (outcome.kind === "rejected" || outcome.result.status === "rejected") {
      const message = outcome.result.status === "rejected"
        ? outcome.result.error.message
        : "conversation creation was rejected";
      throw new Error(`Conversation creation was rejected: ${message}`);
    }
    if (
      outcome.result.body.t !== "session-create" ||
      outcome.result.body.conversationId !== conversationId
    ) {
      throw new Error("Conversation creation returned another durable identity");
    }
  }

  #kickDelivery(
    onFailure?: (error: unknown, runResult: RunResult) => void,
    runResult?: RunResult,
  ): void {
    if (!this.#deliveryDrain) return;
    void this.#deliveryDrain().catch((error) => {
      if (onFailure && runResult) onFailure(error, runResult);
    });
  }

  async #applyAuthorityControl(
    conversationId: string,
    journal: ConversationRunJournal,
    input: Parameters<ConversationRunJournal["applyControl"]>[0],
  ): Promise<Awaited<ReturnType<ConversationRunJournal["applyControl"]>>> {
    try {
      return await journal.applyControl(input);
    } catch (firstError) {
      this.#markRecovery(conversationId);
      try {
        return await journal.applyControl(input);
      } catch (replayError) {
        throw new AggregateError(
          [firstError, replayError],
          "Conversation control could not determine its durable disposition",
        );
      }
    }
  }

  async recover(): Promise<number> {
    if (this.#recoveryRunning) return this.#recoveryRunning;
    await this.recoverReadinessProjections();
    if (this.#recoveryStopped) return 0;
    const queue = [...this.#recoveryConversations.entries()];
    let recovered = await this.#authority.resourceGovernor.reclaimExpired();
    if (this.#ledger) {
      if (
        this.#authority.executorResourceGovernor &&
        this.#authority.executorResourceGovernor !== this.#authority.resourceGovernor
      ) {
        recovered += await this.#authority.executorResourceGovernor.reclaimExpired();
      }
    }
    const recoverConversation = async (conversationId: string): Promise<number> =>
      this.#withRecoveryClaim(conversationId, async () => {
        let count = 0;
        const journal = this.#journal(conversationId);
        count +=
          (await this.#losslessDataPlane?.recoverConversationChannels(
            journal,
          )) ?? 0;
        count += await this.#resumeLifecycleProjections(conversationId, journal);
        const authority = await journal.authorityState();
        if (authority.deleted && authority.pendingLifecycleProjections === 0) {
          this.#retireConversation(conversationId);
          return 0;
        }
        await this.#primeAssignmentRouting(journal);
        const routedExecutor = this.#routedExecutor();
        const dispatcher = this.#recoveryDispatcher(journal, routedExecutor);
        if (this.#recoveryStopped) return count;
        count += await journal.resumeCommittedProjections();
        if (this.#recoveryStopped) return count;
        count += await journal.resumePendingPublishing();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverCancellations();
        if (this.#recoveryStopped) return count;
        if (!this.#shutdownDraining) {
          count += await dispatcher.dispatchPending().then((items) => items.length);
          if (this.#recoveryStopped) return count;
        }
        count += await dispatcher.recoverAssignments();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverSupersedes();
        if (this.#recoveryStopped) return count;
        count += await this.#reconcileAbandonedAssignments(
          journal,
          dispatcher,
          routedExecutor,
        );
        if (this.#recoveryStopped) return count;
        if (!this.#shutdownDraining) {
          count += await this.#resumeQueuedInputs(conversationId, journal);
        }
        if (this.#recoveryStopped) return count;
        count += await this.publishPendingFinals(conversationId);
        await this.#retireSettledAssignments(conversationId, journal);
        await this.#recoverAuxiliary?.(conversationId);
        return count;
      });
    const workers = Array.from(
      { length: Math.min(4, queue.length) },
      async () => {
        while (queue.length > 0) {
          if (this.#recoveryStopped) return;
          const entry = queue.shift();
          if (!entry) return;
          const [conversationId, claimedGeneration] = entry;
          try {
            recovered += await recoverConversation(conversationId);
            if (
              !this.#recoveryStopped &&
              this.#recoveryConversations.get(conversationId) === claimedGeneration
            ) {
              this.#recoveryConversations.delete(conversationId);
            }
          } catch {
            // A later pass retries this conversation without blocking service readiness or peers.
          }
        }
      },
    );
    await Promise.all(workers);
    return recovered;
  }

  async recoverConversation(conversationId: string): Promise<number> {
    this.#markRecovery(conversationId);
    return this.recover();
  }

  async publishPendingFinals(conversationId: string): Promise<number> {
    try {
      const journal = this.#journal(conversationId);
      await journal.resumeCommittedProjections();
      if (!this.#onFinal) return 0;
      return await journal.publishPendingFinals(async (frame, publishResults) => {
        const identity = canonicalize(frame);
        if (this.#firstPartyPublishedFinals.delete(identity)) {
          for (const notice of publishResults) await this.#onPublishResult?.(notice);
          return;
        }
        if (this.#pendingFirstPartyFinals.has(identity)) {
          await this.#onFinal?.(frame);
          for (const notice of publishResults) await this.#onPublishResult?.(notice);
          this.#ownerPublishedFirstPartyFinals.add(identity);
          return;
        }
        await this.#onFinal?.(frame);
        for (const notice of publishResults) await this.#onPublishResult?.(notice);
      });
    } catch (error) {
      this.#markRecovery(conversationId);
      throw error;
    }
  }

  /**
   * 停机收束核对:全部会话的未发布 final 总数与恢复积压会话数。
   * 在恢复循环停止后读取;两者皆零才可宣称 durable 义务已收束。
   */
  async pendingClosureWork(conversationId?: string): Promise<{
    readonly pendingFinals: number;
    readonly pendingAssignments: number;
    readonly recoveryBacklog: number;
    readonly activeLocalLeases: number;
  }> {
    let pendingFinals = 0;
    let pendingAssignments = 0;
    const conversations = conversationId === undefined
      ? await this.listSessions()
      : [conversationId];
    for (const currentConversationId of conversations) {
      const journal = this.#journal(currentConversationId);
      pendingFinals += (await journal.pendingFinalFrames()).length;
      pendingAssignments += (await journal.assignmentsAwaitingRecovery()).length;
    }
    let activeLocalLeases = 0;
    const governor = this.#authority.executorResourceGovernor;
    if (governor) {
      const projection = await governor.snapshot();
      for (const reservation of projection.reservations.values()) {
        const scope = reservation.lease.scopeBinding;
        if (
          reservation.state === "active" &&
          scope.kind === "conversation" &&
          scope.ownerEpoch === this.#ownerEpochFor(scope.conversationId) &&
          this.#acceptsConversationId(scope.conversationId) &&
          (conversationId === undefined || scope.conversationId === conversationId)
        ) {
          activeLocalLeases += 1;
        }
      }
    }
    return {
      pendingFinals,
      pendingAssignments,
      recoveryBacklog:
        (conversationId === undefined
          ? this.#recoveryConversations.size
          : Number(this.#recoveryConversations.has(conversationId))) +
        (conversationId === undefined
          ? this.#activeRecoveryClaims.size
          : Number(this.#activeRecoveryClaims.has(conversationId))) +
        (this.#recoveryRunning ? 1 : 0),
      activeLocalLeases,
    };
  }

  sessionAuthorityState(conversationId: string) {
    return this.#journal(conversationId).authorityState();
  }

  async statusHistory(
    requests: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ): Promise<{
    readonly notices: readonly ConversationStatusNotice[];
    readonly next: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[];
  }> {
    for (const request of requests) {
      if (!this.#acceptsConversationId(request.conversationId)) {
        throw new Error("Conversation identity does not belong to this owner domain");
      }
    }
    const snapshot = await this.#authority.authorityLog.readSnapshot();
    const conversationSnapshots = partitionConversationSnapshots(snapshot);
    const grouped = new Map<
      string,
      Array<{ runId: string; afterStatusRevision: number }>
    >();
    for (const request of requests) {
      const group = grouped.get(request.conversationId) ?? [];
      group.push({
        runId: request.runId,
        afterStatusRevision: request.afterStatusRevision,
      });
      grouped.set(request.conversationId, group);
    }
    const queue = [...grouped.entries()];
    const notices: ConversationStatusNotice[][] = [];
    const next: Array<{
      conversationId: string;
      runId: string;
      afterStatusRevision: number;
    }> = [];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry) return;
          const [conversationId, cursors] = entry;
          const journal = this.#journalForQuery(conversationId);
          await journal.primeRecoverySnapshot(
            conversationSnapshots.get(conversationId) ?? emptyConversationSnapshot(snapshot),
          );
          const pages = await journal.statusHistoryBatch(cursors);
          for (let index = 0; index < pages.length; index += 1) {
            const page = pages[index]!;
            const cursor = cursors[index]!;
            notices.push(page.notices);
            // 每个请求 subject 必须返回续读游标:无推进时保留原水位,
            // 不得省略——省略会被消费侧的集合全等对账当作丢失 subject。
            next.push({
              conversationId,
              runId: cursor.runId,
              afterStatusRevision:
                page.nextAfterStatusRevision ?? cursor.afterStatusRevision,
            });
          }
        }
      }),
    );
    return { notices: notices.flat(), next };
  }

  /**
   * 会话状态端口——advancement 等会话域消费者经它读写 owner 权威日志；
   * 惰性创建，journal 访问走缓存实例（查询侧不再每次重建）。
   */
  get sessionState(): SessionStatePort {
    if (!this.#sessionState) {
      this.#sessionState = new ConversationSessionStateAdapter({
        journalFor: (conversationId) => this.#journal(conversationId),
        sessionExists: (conversationId) => this.sessionExists(conversationId),
        mutateControl: async (conversationId, mutation, ctx) => {
          const principal = ctx.principal.kind === "surface"
            ? {
                surfacePrincipal: ctx.principal.surfacePrincipal,
                connectionId: ctx.principal.connectionId,
                deviceId: this.#authority.deviceId,
              }
            : ctx.principal.kind === "host"
              ? {
                  surfacePrincipal: `owner:${ctx.principal.component}`,
                  connectionId: `owner:${ctx.principal.component}`,
                  deviceId: this.#authority.deviceId,
                }
              : undefined;
          if (!principal) {
            throw new Error("Session control mutation requires a surface or host principal");
          }
          const result = await this.writeSession({
            conversationId,
            requestId: ctx.requestId,
            mutation,
            principal,
            conversationExists: () => this.sessionExists(conversationId),
          });
          if (result.status === "not-found") {
            const error: AuthorityError = {
              code: "not-found",
              message: `Session does not exist: ${conversationId}`,
              retryable: false,
            };
            throw error;
          }
          if (result.status !== "accepted") {
            const error: AuthorityError = {
              code: "busy",
              message: `Session mutation is busy: ${conversationId}`,
              retryable: true,
            };
            throw error;
          }
          return { revision: result.domainRevision };
        },
        stageAssignment: async (conversationId, mutation, ctx) => {
          if (ctx.principal.kind !== "assignment") {
            throw new Error("Staged session mutation requires an assignment principal");
          }
          const capability = validateAuthorityCapability(
            ctx.principal.capability,
            this.#authority.verifier,
          );
          if (capability.scope.execution !== "conversation") {
            throw new Error("Assignment capability does not authorize this session mutation");
          }
          if (
            capability.scope.conversationId !== conversationId ||
            !("ownerEpoch" in capability) ||
            capability.ownerEpoch !== this.#ownerEpochFor(conversationId) ||
            this.#assignmentConversations.get(capability.assignmentId) !== conversationId ||
            !capability.methods.includes("session.mutate")
          ) {
            throw new Error("Assignment capability does not authorize this session mutation");
          }
          const staged = await this.#requireLocalLedger().stageMutation(
            capability.assignmentId,
            {
              domain: "session",
              mutation,
              requestId: ctx.requestId,
            },
          );
          return { revision: staged.recordSeq };
        },
      });
    }
    return this.#sessionState!;
  }

  #acceptsConversationId(conversationId: string): boolean {
    return (
      this.#authority.acceptsConversationId(conversationId) ||
      this.#adoptedConversations.has(conversationId)
    );
  }

  #ownerEpochFor(conversationId: string): number {
    return this.#adoptedConversations.get(conversationId)?.ownerEpoch ??
      this.#authority.ownerEpoch;
  }

  async #snapshotWithImportedBase(
    records: readonly ConversationTransferAuthorityRecord[],
  ): Promise<AuthorityLogSnapshot<unknown>> {
    const current = await this.#authority.authorityLog.readSnapshot<unknown>();
    const grouped = new Map<string, {
      readonly lsn: number;
      readonly at: string;
      readonly entries: Array<{ stream: string; body: unknown }>;
    }>();
    for (const record of records) {
      const key = `${record.lsn}\0${record.at}`;
      const group = grouped.get(key) ?? {
        lsn: record.lsn,
        at: record.at,
        entries: [],
      };
      group.entries.push({ stream: record.stream, body: structuredClone(record.body) });
      grouped.set(key, group);
    }
    const imported = [...grouped.values()]
      .sort((left, right) => left.lsn - right.lsn || left.at.localeCompare(right.at))
      .map((group) => {
        const payload = {
          v: 1 as const,
          lsn: group.lsn,
          at: group.at,
          entries: group.entries,
        };
        return {
          ...payload,
          envelopeDigest: protocolDigest("CommitEnvelope", 1, payload),
        } satisfies CommitEnvelope<unknown>;
      });
    return { commits: [...imported, ...current.commits], cursor: current.cursor };
  }

  #journal(conversationId: string): ConversationRunJournal {
    if (!this.#acceptsConversationId(conversationId)) {
      throw new Error("Conversation identity does not belong to this owner domain");
    }
    const existing = this.#journals.get(conversationId);
    if (existing) return existing;
    const journal = this.#createJournal(conversationId);
    this.#journals.set(conversationId, journal);
    return journal;
  }

  #journalForQuery(conversationId: string): ConversationRunJournal {
    if (!this.#acceptsConversationId(conversationId)) {
      throw new Error("Conversation identity does not belong to this owner domain");
    }
    return this.#journals.get(conversationId) ?? this.#createJournal(conversationId);
  }

  #createJournal(
    conversationId: string,
    ownerEpoch = this.#ownerEpochFor(conversationId),
  ): ConversationRunJournal {
    const journal = new ConversationRunJournal({
      conversationId,
      ownerEpoch,
      log: this.#authority.authorityLog,
      artifacts: this.#authority.artifacts,
      signer: this.#authority.signer,
      verifier: this.#authority.verifier,
      submission: createSubmissionAuthorizer(
        (assignmentId) =>
          this.#assignmentCapabilities.get(assignmentId)?.executorId ??
          this.#authority.executorId,
        this.#authority.verifier,
      ),
      authority: this.#commitAuthority(conversationId),
      projection: {
        project: (projection) => this.#manager().project(projection),
      },
      ...(this.#authority.globalPublishing
        ? { publisher: this.#mutationPublisherProxy }
        : {}),
      ...(this.#authority.participant
        ? { delivery: this.#authority.participant }
        : {}),
      resources: this.#authority.resourceGovernor,
      clock: this.#clock,
      currentAuthority: { deviceId: this.#authority.deviceId },
    });
    if (this.#onStatus) {
      journal.onStatus(this.#onStatus);
    }
    return journal;
  }

  #commitAuthority(conversationId: string): ConversationCommitAuthority {
    return {
      decideAtPrefix: (decision) => {
        if (
          decision.conversationId !== conversationId ||
          decision.ownerEpoch !== this.#ownerEpochFor(conversationId)
        ) {
          return {
            committed: false,
            error: {
              code: "revision-conflict",
              message: "Conversation base revision is stale or unsupported",
              retryable: false,
            },
          };
        }
        return { committed: true, commitRevision: decision.baseRevision + 1 };
      },
    };
  }

  #conversationForAssignment(assignmentId: string): string {
    const conversationId = this.#assignmentConversations.get(assignmentId);
    if (!conversationId) throw new Error(`Unknown local assignment ${assignmentId}`);
    return conversationId;
  }

  #requireLocalLedger(): ConversationAssignmentLedger {
    if (!this.#ledger) {
      throw new Error("Local executor role is not enabled on this device");
    }
    return this.#ledger;
  }

  #createLocalSubmission(
    owner: ConversationRunJournal,
  ): InProcessAssignmentSubmission {
    const Constructor = this.#InProcessAssignmentSubmission;
    if (!Constructor) {
      throw new Error("Local executor submission adapter is unavailable");
    }
    return new Constructor({
      ledger: this.#requireLocalLedger(),
      owner,
    });
  }

  async #primeAssignmentRouting(journal: ConversationRunJournal): Promise<void> {
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      this.#rememberAssignment(
        candidate.dispatch.envelope,
        candidate.dispatch.activation,
      );
    }
    for (const candidate of await journal.pendingDispatches()) {
      this.#rememberAssignment(candidate.envelope, candidate.activation);
    }
  }

  #routedExecutor(): RoutedRunExecutorPort {
    return new RoutedRunExecutorPort(
      (executorId) => this.#executorFor(executorId),
      (assignmentId) => this.#executorForAssignment(assignmentId),
    );
  }

  #recoveryDispatcher(
    journal: ConversationRunJournal,
    routedExecutor = this.#routedExecutor(),
  ): InProcessConversationDispatcher {
    const submission = this.#ledger
      ? this.#createLocalSubmission(journal)
      : undefined;
    return new InProcessConversationDispatcher({
      enabled: true,
      journal,
      executor: routedExecutor,
      contexts: this.#contexts,
      cancellationSubmission: {
        submitCancellation: async (assignmentId) => {
          if (this.#isLocalAssignment(assignmentId)) {
            if (!submission) return false;
            return submission.submitCancellation(
              assignmentId,
              this.#submissionContext(assignmentId),
            );
          }
          const snapshot = await routedExecutor.queryLedger(
            assignmentId,
            this.#contexts.create(assignmentId, "executor.queryLedger", {
              requestId: `ledger:${assignmentId}:cancel-proof`,
              body: { range: null },
            }),
          );
          if (!("phase" in snapshot) || !snapshot.cancelProof) return false;
          await journal.submitCancelProof(
            assignmentId,
            snapshot.cancelProof,
            this.#submissionContext(assignmentId),
          );
          return true;
        },
      },
      bundleSubmission: {
        submitSealedBundle: (assignmentId) => {
          if (!this.#isLocalAssignment(assignmentId)) {
            return Promise.resolve(remoteBundleSubmissionDeferred());
          }
          if (!submission) {
            throw new Error("Local assignment submission is unavailable");
          }
          return submission.submitSealedBundle(
            assignmentId,
            this.#submissionContext(assignmentId),
          );
        },
      },
    });
  }

  async #driveCancellation(
    journal: ConversationRunJournal,
    request: Parameters<InProcessConversationDispatcher["cancelRun"]>[0],
  ): Promise<void> {
    await this.#primeAssignmentRouting(journal);
    await this.#recoveryDispatcher(journal).cancelRun(request);
  }

  async #drivePendingCancellations(
    journal: ConversationRunJournal,
  ): Promise<number> {
    await this.#primeAssignmentRouting(journal);
    return this.#recoveryDispatcher(journal).recoverCancellations();
  }

  #executorFor(executorId: string): RunExecutorPort {
    if (executorId === this.#authority.executorId) {
      return this.#requireLocalLedger();
    }
    const remote = this.#remoteExecution?.forExecutor(executorId);
    if (!remote) {
      throw new Error(`Remote conversation executor is unavailable: ${executorId}`);
    }
    return remote.executor;
  }

  #executorForAssignment(assignmentId: string): RunExecutorPort {
    const capability = this.#assignmentCapabilities.get(assignmentId);
    if (!capability) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return this.#executorFor(capability.executorId);
  }

  #isLocalAssignment(assignmentId: string): boolean {
    const capability = this.#assignmentCapabilities.get(assignmentId);
    if (!capability) throw new Error(`Unknown conversation assignment ${assignmentId}`);
    return capability.executorId === this.#authority.executorId;
  }

  #submissionContext(assignmentId: string): AuthorityCallContext {
    const capability = this.#assignmentCapabilities.get(assignmentId);
    if (!capability) {
      throw new Error("Recovered assignment has no durable submission capability");
    }
    return {
      principal: { kind: "assignment", capability },
      requestId: `submission:${assignmentId}`,
      deadlineAt: capability.expiry,
    };
  }

  async #awaitRemoteConversationRun(input: {
    readonly journal: ConversationRunJournal;
    readonly dispatcher: InProcessConversationDispatcher;
    readonly executor: RunExecutorPort;
    readonly conversationId: string;
    readonly runId: string;
    readonly assignmentId: string;
  }): Promise<RunResult> {
    const heartbeat = this.#startControlHeartbeat(input.assignmentId, input.executor);
    try {
      while (true) {
        const committed = await input.journal.committedRun(input.runId);
        if (committed) {
          this.#markRecovery(input.conversationId);
          this.#kickDelivery();
          return replayCommittedRun(committed.runRecord, committed.windowCompact);
        }
        const state = await input.journal.runState(input.runId);
        if (state === "failed" || state === "cancelled") {
          throw new Error(`Remote conversation run terminated in state ${state}`);
        }
        try {
          await input.dispatcher.recoverStarted();
          await input.dispatcher.recoverAssignments();
        } catch (error) {
          if (!isRetryableMeshFailure(error)) throw error;
          // Durable owner and executor outboxes retain every fact while the peer is offline.
        }
        await delay(100);
      }
    } finally {
      await heartbeat.stop();
    }
  }

  #startControlHeartbeat(assignmentId: string, executor?: RunExecutorPort): {
    stop(): Promise<void>;
  } {
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = (executor ?? this.#requireLocalLedger())
        .queryLedger(
          assignmentId,
          this.#contexts.create(assignmentId, "executor.queryLedger", {
            requestId: `ledger:${assignmentId}:snapshot`,
            body: { range: null },
          }),
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
    }, CONTROL_RENEWAL_INTERVAL_MS);
    timer.unref?.();
    return {
      async stop() {
        clearInterval(timer);
        await inFlight;
      },
    };
  }

  async #reconcileAbandonedAssignments(
    journal: ConversationRunJournal,
    dispatcher: InProcessConversationDispatcher,
    executor: RunExecutorPort,
  ): Promise<number> {
    let reconciled = 0;
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      if (this.#scheduledRuns.has(candidate.dispatch.envelope.work.runId)) {
        continue;
      }
      this.#rememberAssignment(
        candidate.dispatch.envelope,
        candidate.dispatch.activation,
      );
      const snapshot = journal.validateExecutorLedgerSnapshot(
        await executor.queryLedger(
          candidate.assignmentId,
          this.#contexts.create(candidate.assignmentId, "executor.queryLedger", {
            requestId: `ledger:${candidate.assignmentId}:snapshot`,
            body: { range: null },
          }),
        ),
      );
      if (snapshot.phase === "received" && candidate.state === "dispatched") {
        await dispatcher.supersede(
          candidate.assignmentId,
          `local-recovery:${candidate.assignmentId}`,
        );
        reconciled += 1;
        continue;
      }
      if (snapshot.phase === "started") {
        await journal.markAssignmentUncertain(
          candidate.assignmentId,
          "ledger-unknown",
        );
        reconciled += 1;
      }
    }
    return reconciled;
  }

  async #resumeQueuedInputs(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<number> {
    let resumed = 0;
    for (const pending of await journal.pendingInputs()) {
      await this.#schedulePendingInput(conversationId, pending);
      resumed += 1;
    }
    return resumed;
  }

  async #schedulePendingInput(
    conversationId: string,
    pending: PendingConversationInput,
  ): Promise<void> {
    if (this.#shutdownDraining) return;
    if (this.#scheduledRuns.has(pending.runId)) return;
    if (this.#schedulingRuns.has(pending.runId)) {
      throw new Error(`Conversation run ${pending.runId} is still entering the scheduler`);
    }
    const manager = this.#manager();
    const options = runOptionsForPending(pending);
    const retryAbort = new AbortController();
    this.#schedulingRuns.add(pending.runId);
    try {
      const admission = await manager.admitTurn({
        conversationId,
        source: options.source,
        capacityReserved: true,
        makeTask: (managed) => ({
          source: options.source,
          durableRunId: pending.runId,
          execute: async () => {
            try {
              await this.#executePendingInput(
                conversationId,
                pending,
                manager,
                managed,
                retryAbort.signal,
              );
            } catch (error) {
              this.#markRecovery(conversationId);
              throw error;
            } finally {
              manager.setBusy(conversationId, false);
            }
          },
          cancel: () => {},
          cancelLocally: () => {},
          cancelDurably: () => this.cancelAdmitted(conversationId, pending.runId),
          abort: (reason) => {
            const newlyAborted = !retryAbort.signal.aborted;
            if (newlyAborted) retryAbort.abort(reason);
            return managed.runtime.abort(reason) || newlyAborted;
          },
        }),
      });
      if (admission.status === "immediate") {
        this.#schedulingRuns.delete(pending.runId);
        this.#scheduledRuns.add(pending.runId);
        void admission.task.execute().catch(() => {});
      } else if (admission.status === "queued") {
        this.#schedulingRuns.delete(pending.runId);
        this.#scheduledRuns.add(pending.runId);
      } else if (admission.status === "full" || admission.status === "not-found") {
        throw new Error(
          `Recovered conversation run ${pending.runId} could not enter the scheduler`,
        );
      } else {
        throw new Error(
          `Recovered conversation run ${pending.runId} did not acquire a scheduler slot`,
        );
      }
    } catch (error) {
      this.#schedulingRuns.delete(pending.runId);
      this.#markRecovery(conversationId);
      throw error;
    }
  }

  async #scheduleResolvedRetry(
    conversationId: string,
    runId: string,
    journal: ConversationRunJournal,
  ): Promise<void> {
    const pending = (await journal.pendingInputs()).find(
      (candidate) => candidate.runId === runId,
    );
    if (!pending) {
      throw new Error(`Resolved conversation run ${runId} has no durable input`);
    }
    await this.#schedulePendingInput(conversationId, pending);
  }

  async #executePendingInput(
    conversationId: string,
    pending: PendingConversationInput,
    manager: ConversationManager,
    managed: ManagedSession,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const options = runOptionsForPending(pending, abortSignal, true);
    const invocation = pending.invocation;
    if (invocation.kind === "perspectives") {
      if (!this.#executeRecoveredPerspective) {
        throw new Error(
          "Durable perspective recovery has no perspective execution adapter",
        );
      }
      const execute = this.#executeRecoveredPerspective;
      const createRuntime = (baseRuntime: SessionRuntime): SessionRuntime => ({
        sessionId: `recovered-perspectives:${conversationId}`,
        async *run(_messages, runtimeOptions): AsyncGenerator<AgentYield, RunResult> {
          // 恢复执行同样独占该 assignment 的计量序列——与正常 durable 路径同构
          const meter = runtimeOptions?.modelCallResourceMeter;
          let callIndex = 0;
          return await execute({
            manager,
            managed: { ...managed, runtime: baseRuntime },
            originalInput: pending.input,
            question: invocation.question,
            source: invocation.source,
            ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
            turnContext: options.turnContext,
            authorizeToolExecution: runtimeOptions?.authorizeToolExecution,
            ...(meter
              ? {
                  modelCallMetering: {
                    meter,
                    nextCallIndex: () => ++callIndex,
                  },
                }
              : {}),
          });
        },
        abort: (reason) => baseRuntime.abort(reason),
        async dispose() {},
        securitySnapshot: () => requireRuntimeSecuritySnapshot(baseRuntime),
        executionPermissionRules: () =>
          requireRuntimeExecutionPermissionRules(baseRuntime),
        executionProfile: () => requireRuntimeExecutionProfile(baseRuntime),
      });
      const runtime = createRuntime(managed.runtime);
      const generator = this.run({
        conversationId,
        input: pending.input,
        attachments: pending.attachments,
        messages: [
          ...managed.window.getMessages(),
          userMessageFromTurnInput(pending.input),
        ],
        baseRevision: managed.turnCount,
        runtime,
        adaptLocalRuntime: createRuntime,
        invocation,
        options: { ...options, turnIndex: managed.turnCount },
      });
      while (!(await generator.next()).done) {
        // Perspective orchestration publishes provisional events through its own bus.
      }
    } else {
      const generator = runTurnWithCommit(
        manager,
        conversationId,
        pending.input,
        {
          ...options,
          attachments: pending.attachments,
          turnIndex: managed.turnCount,
        },
        undefined,
        pending.environment,
      );
      while (!(await generator.next()).done) {
        // Provisional observers do not survive restart. Durable final and delivery
        // projections remain the user-facing recovery outputs.
      }
    }
    try {
      await this.publishPendingFinals(conversationId);
    } catch {
      // The authoritative run is already terminal. The runtime-owned recovery
      // queue will redrive the durable final independently of task execution.
    }
  }

  async #recoverReadinessProjections(): Promise<number> {
    if (this.#recoveryDiscovered) return 0;
    const snapshot = await this.#authority.authorityLog.readSnapshot();
    const conversationSnapshots = partitionConversationSnapshots(snapshot);
    const conversationIds = new Set(
      [...discoverRecoveryConversations(snapshot.commits)].filter((conversationId) =>
        this.#acceptsConversationId(conversationId),
      ),
    );
    for (const conversationId of conversationIds) {
      this.#markRecovery(conversationId);
      await this.#journal(conversationId).primeRecoverySnapshot(
        conversationSnapshots.get(conversationId) ?? emptyConversationSnapshot(snapshot),
      );
    }
    let resumed = 0;
    const queue = [...conversationIds];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const conversationId = queue.shift();
          if (!conversationId) return;
          resumed += await this.#withRecoveryClaim(conversationId, async () => {
            const journal = this.#journal(conversationId);
            let count = await this.#resumeLifecycleProjections(conversationId, journal);
            const authority = await journal.authorityState();
            if (authority.deleted && authority.pendingLifecycleProjections === 0) {
              this.#retireConversation(conversationId);
              return count;
            }
            count += await journal.resumeCommittedProjections();
            return count;
          });
        }
      }),
    );
    this.#recoveryDiscovered = true;
    return resumed;
  }

  async #resumeLifecycleProjections(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<number> {
    const existing = this.#lifecycleProjectionClaims.get(conversationId);
    if (existing) return existing;
    const projection = this.#runLifecycleProjections(
      conversationId,
      journal,
    ).finally(() => {
      if (this.#lifecycleProjectionClaims.get(conversationId) === projection) {
        this.#lifecycleProjectionClaims.delete(conversationId);
      }
    });
    this.#lifecycleProjectionClaims.set(conversationId, projection);
    return projection;
  }

  async #runLifecycleProjections(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<number> {
    const state = await journal.authorityState();
    if (state.pendingLifecycleProjections === 0) {
      if (state.deleted) this.#retireConversation(conversationId);
      return 0;
    }
    if (!this.#projectLifecycle) {
      throw new Error("Durable conversation lifecycle projection is not configured");
    }
    const projected = await journal.resumeLifecycleProjections(async (input) => {
      if (input.mutation === "delete") {
        await this.#authority.surfaceAssets?.revokeConversation(input.conversationId);
      }
      await this.#projectLifecycle!(input);
    });
    const after = await journal.authorityState();
    if (after.deleted && after.pendingLifecycleProjections === 0) {
      this.#retireConversation(conversationId);
    }
    return projected;
  }

  #markRecovery(conversationId: string): void {
    this.#recoveryGeneration += 1;
    this.#recoveryConversations.set(conversationId, this.#recoveryGeneration);
  }

  #clearRunClaims(runId: string): void {
    this.#schedulingRuns.delete(runId);
    this.#scheduledRuns.delete(runId);
    for (const [key, prepared] of this.#preparedAdmissions) {
      if (prepared.admission.runId === runId) this.#preparedAdmissions.delete(key);
    }
  }

  #retireConversation(conversationId: string): void {
    if ((this.#activeRecoveryClaims.get(conversationId) ?? 0) > 0) {
      this.#pendingConversationRetirements.add(conversationId);
      return;
    }
    this.#finalizeConversationRetirement(conversationId);
  }

  #finalizeConversationRetirement(conversationId: string): void {
    this.#pendingConversationRetirements.delete(conversationId);
    this.#journals.delete(conversationId);
    this.#recoveryConversations.delete(conversationId);
    for (const [assignmentId, assignedConversationId] of this.#assignmentConversations) {
      if (assignedConversationId === conversationId) this.#forgetAssignment(assignmentId);
    }
    for (const prepared of [...this.#preparedAdmissions.values()]) {
      if (prepared.conversationId === conversationId) {
        this.#clearRunClaims(prepared.admission.runId);
      }
    }
  }

  async #withRecoveryClaim<T>(
    conversationId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.#activeRecoveryClaims.set(
      conversationId,
      (this.#activeRecoveryClaims.get(conversationId) ?? 0) + 1,
    );
    try {
      return await run();
    } finally {
      const remaining = (this.#activeRecoveryClaims.get(conversationId) ?? 1) - 1;
      if (remaining > 0) {
        this.#activeRecoveryClaims.set(conversationId, remaining);
      } else {
        this.#activeRecoveryClaims.delete(conversationId);
        if (this.#pendingConversationRetirements.has(conversationId)) {
          this.#finalizeConversationRetirement(conversationId);
        }
      }
    }
  }

  async #retireSettledAssignments(
    conversationId: string,
    journal: ConversationRunJournal,
  ): Promise<void> {
    const recoverable = new Set(
      (await journal.assignmentsAwaitingRecovery()).map(
        (candidate) => candidate.assignmentId,
      ),
    );
    for (const [assignmentId, assignedConversationId] of this.#assignmentConversations) {
      if (
        assignedConversationId === conversationId &&
        !recoverable.has(assignmentId)
      ) {
        this.#forgetAssignment(assignmentId);
      }
    }
  }

  #rememberAssignment(
    envelope: Extract<
      import("@zhixing/core/contracts").DispatchEnvelope,
      { execution: "conversation" }
    >,
    activation: AssignmentActivationProof<"conversation">,
  ): void {
    const capability = envelope.capabilities[0];
    if (!capability) throw new Error("Conversation assignment has no submission capability");
    this.#assignmentConversations.set(
      envelope.assignmentId,
      envelope.work.conversationId,
    );
    this.#assignmentCapabilities.set(envelope.assignmentId, capability);
    this.#assignmentActivations.set(envelope.assignmentId, activation);
    this.#assignmentIngress.set(
      envelope.assignmentId,
      structuredClone(envelope.work.ingress),
    );
  }

  #requireExecutorResourceGovernor() {
    const resources = this.#authority.executorResourceGovernor;
    if (!resources) {
      throw new Error("Local executor resource authority is unavailable");
    }
    return resources;
  }

  async finalHistory(
    conversationId: string,
    afterCommitRevision: number,
  ): Promise<CommittedConversationResult[]> {
    return this.#journal(conversationId).finalHistory(afterCommitRevision);
  }

  /** 推进取证目标只由 accepted run 的冻结 manifest 与已验签能力目录决定。 */
  async advancementEvidenceTarget(conversationId: string, runId: string) {
    const dispatch = await this.#journal(conversationId).advancementEvidenceDispatch(runId);
    if (!dispatch) return undefined;
    const descriptor = this.#authority.executorCapabilities.snapshotFor(
      dispatch.envelope.executorId,
    )?.descriptor;
    if (!descriptor) return undefined;
    return {
      ownerEpoch: dispatch.envelope.work.ownerEpoch,
      executorId: dispatch.envelope.executorId,
      workspace: dispatch.envelope.manifest.environment.workspace,
      descriptor,
    };
  }

  #forgetAssignment(assignmentId: string): void {
    this.#assignmentConversations.delete(assignmentId);
    this.#assignmentCapabilities.delete(assignmentId);
    this.#assignmentActivations.delete(assignmentId);
    this.#assignmentIngress.delete(assignmentId);
    this.#interactions.releaseAssignment(assignmentId);
  }

  #requiredMutationPublisher(): ConversationMutationPublisher {
    if (!this.#mutationPublisher) {
      throw new Error("Conversation global mutation publisher is unavailable");
    }
    return this.#mutationPublisher;
  }
}

class RoutedRunExecutorPort implements RunExecutorPort {
  constructor(
    private readonly forExecutor: (executorId: string) => RunExecutorPort,
    private readonly forAssignment: (assignmentId: string) => RunExecutorPort,
  ) {}

  dispatch(...args: RunDispatchArguments): Promise<DispatchResult> {
    return this.forExecutor(args[0].executorId).dispatch(...args);
  }

  cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<void> {
    return this.forAssignment(assignmentId).cancel(assignmentId, fence, context);
  }

  supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    return this.forAssignment(assignmentId).supersede(assignmentId, fence, context);
  }

  queryLedger(
    assignmentId: string,
    context: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    return this.forAssignment(assignmentId).queryLedger(
      assignmentId,
      context,
      range,
    );
  }
}

function remoteBundleSubmissionDeferred(): {
  readonly committed: false;
  readonly error: import("@zhixing/core/contracts").AuthorityError;
} {
  return {
    committed: false,
    error: {
      code: "unavailable-offline",
      message: "Remote executor owns durable bundle redelivery",
      retryable: true,
    },
  };
}

function ingressForTurn(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
  deviceId: string,
  receivedAt: string,
): IngressContext {
  const origin = input.options?.turnContext?.turnOrigin;
  const ingressId = input.options?.turnContext?.turnId ?? `ingress:${randomUUID()}`;
  if (origin?.target && origin.channel !== "rpc") {
    const responder = {
      channelId: origin.channel,
      platformSubject: origin.triggeredBy ?? "unknown",
    };
    return {
      kind: "channel",
      surfacePrincipal: surfacePrincipalForTurn(input),
      responder,
      replyTarget: origin.target,
      deviceId,
      ingressId,
      turnOrigin: origin,
      receivedAt,
    };
  }
  return {
    kind: "first-party",
    surfacePrincipal: surfacePrincipalForTurn(input),
    deviceId,
    ingressId,
    ...(origin ? { turnOrigin: origin } : {}),
    receivedAt,
  };
}

function admissionKey(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
): string | undefined {
  const turnId = input.options?.turnContext?.turnId;
  if (!turnId) return undefined;
  return canonicalize([
    input.conversationId,
    surfacePrincipalForTurn(input),
    turnId,
  ]);
}

function surfacePrincipalForTurn(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
): string {
  const origin = input.options?.turnContext?.turnOrigin;
  if (origin?.target && origin.channel !== "rpc") {
    return channelSurfacePrincipal({
      channelId: origin.channel,
      platformSubject: origin.triggeredBy ?? "unknown",
    });
  }
  const declared = input.options?.surfacePrincipal ??
    ("surfacePrincipal" in input ? input.surfacePrincipal : undefined);
  return declared ??
    `surface:${origin?.channel ?? "local"}:${origin?.triggeredBy ?? "local"}`;
}

function inputControlRequestId(ingress: IngressContext): string {
  return `input:${protocolDigest("ConversationInputIdentity", 1, {
    surfacePrincipal: ingress.surfacePrincipal,
    ingressId: ingress.ingressId,
  })}`;
}

function runOptionsForPending(
  pending: PendingConversationInput,
  abortSignal?: AbortSignal,
  recovered = false,
) {
  const ingress = pending.ingress;
  const invocation: ConversationInvocation = pending.invocation;
  return {
    source: invocation.source,
    ...(invocation.kind === "agent" && invocation.advancement
      ? { advancement: invocation.advancement }
      : {}),
    ...(abortSignal ? { abortSignal } : {}),
    turnContext: {
      turnId: ingress.ingressId,
      ...(ingress.kind === "channel"
        ? { emissionTarget: ingress.replyTarget }
        : {}),
      ...(ingress.turnOrigin
        ? {
            turnOrigin: recovered
              ? withoutRecoveredSurfaceCapabilities(ingress.turnOrigin)
              : ingress.turnOrigin,
          }
        : {}),
    },
    surfacePrincipal: ingress.surfacePrincipal,
  };
}

function withoutRecoveredSurfaceCapabilities(
  origin: NonNullable<IngressContext["turnOrigin"]>,
): NonNullable<IngressContext["turnOrigin"]> {
  if (origin.surface?.capabilities?.postTurnControl !== true) return origin;
  return {
    ...origin,
    surface: {
      ...origin.surface,
      capabilities: {
        ...origin.surface.capabilities,
        postTurnControl: false,
      },
    },
  };
}

function assignmentContext(
  envelope: Extract<import("@zhixing/core/contracts").DispatchEnvelope, { execution: "conversation" }>,
): AuthorityCallContext {
  const capability = envelope.capabilities[0];
  if (!capability) throw new Error("Conversation assignment has no submission capability");
  return {
    principal: { kind: "assignment", capability },
    requestId: `submission:${envelope.assignmentId}`,
    deadlineAt: capability.expiry,
  };
}

function assignmentResourceContext(
  envelope: Extract<import("@zhixing/core/contracts").DispatchEnvelope, { execution: "conversation" }>,
): AuthorityCallContext {
  const context = assignmentContext(envelope);
  return {
    ...context,
    requestId: `resource-usage:${envelope.assignmentId}`,
    deadlineAt:
      Date.parse(context.deadlineAt) <= Date.parse(envelope.resourceLease.expiry)
        ? context.deadlineAt
        : envelope.resourceLease.expiry,
  };
}

function createSubmissionAuthorizer(
  executorIdFor: (assignmentId: string) => string,
  verifier: ProtocolSignatureVerifier,
): AssignmentSubmissionAuthorizer {
  const authenticate: AssignmentSubmissionAuthorizer["authenticate"] = (
    context,
    identity,
  ) => {
    if (context.principal.kind !== "assignment") {
      throw new Error("Assignment submission requires an assignment capability");
    }
    assertPrincipalAllowsAuthorityMethod("assignment", identity.method);
    const capability = validateAuthorityCapability(
      context.principal.capability,
      verifier,
    );
    if (
      // capability 必须属于该 assignment 被指派的 executor——本地或远端;
      // 写死 owner 本地 executorId 会把一切远端提交拒之门外。
      capability.executorId !== executorIdFor(identity.assignmentId) ||
      capability.assignmentId !== identity.assignmentId ||
      !capability.methods.includes(identity.method) ||
      Date.parse(context.deadlineAt) > Date.parse(capability.expiry)
    ) {
      throw new Error("Assignment capability does not authorize this submission");
    }
  };
  return {
    authenticate,
    authorize(context, authorization) {
      authenticate(context, authorization);
    },
  };
}

function createDispatchContexts(options: {
  readonly signer: ProtocolSigner;
  readonly deviceId: string;
  readonly ownerEpochFor: (assignmentId: string) => number;
  readonly clock: () => string;
  readonly conversationIdFor: (assignmentId: string) => string;
}): InProcessDispatchContextFactory {
  return {
    create(assignmentId, method, request) {
      const now = Date.parse(options.clock());
      const renewalSeq = Math.floor(now / CONTROL_RENEWAL_INTERVAL_MS);
      const issuedAt = new Date(
        renewalSeq * CONTROL_RENEWAL_INTERVAL_MS,
      ).toISOString();
      const expiry = new Date(
        renewalSeq * CONTROL_RENEWAL_INTERVAL_MS + CONTEXT_TTL_MS,
      ).toISOString();
      const scope = {
        execution: "conversation" as const,
        conversationId: options.conversationIdFor(assignmentId),
        ownerEpoch: options.ownerEpochFor(assignmentId),
      };
      const controlPayload = {
        v: 1 as const,
        controlLeaseId: `control-${assignmentId}`,
        assignmentId,
        authority: scope,
        renewalSeq,
        issuedAt,
        expiry,
      };
      const controlLease: ControlLease = {
        ...controlPayload,
        signature: options.signer.sign("ControlLease", 1, controlPayload),
      };
      const requestDigest = ownerControlRequestDigest({
        method,
        assignmentId,
        authority: scope,
        requestId: request.requestId,
        body: request.body,
      });
      const payload = {
        v: 1 as const,
        assignmentId,
        scope,
        methods: [method],
        callerDeviceId: options.deviceId,
        requestId: request.requestId,
        requestDigest,
        controlLease,
        issuedAt,
        expiry,
      };
      const grant: OwnerControlGrant = {
        ...payload,
        signature: options.signer.sign("OwnerControlGrant", 1, payload),
      };
      return {
        principal: { kind: "owner-control", grant },
        requestId: request.requestId,
        deadlineAt: expiry,
      };
    },
  };
}

function reservationOriginForSource(source: string | undefined): ReservationOrigin {
  return source === "advancement"
    ? { admissionClass: "advancement", entry: "advancement-control" }
    : source === "scheduler"
      ? { admissionClass: "scheduler", entry: "schedule-trigger" }
      : { admissionClass: "interactive", entry: "conversation-input" };
}

function conversationAssignmentId(runId: string, attempt: number): string {
  return `assignment:${protocolDigest("ConversationAssignmentIdentity", 1, {
    runId,
    attempt,
  })}`;
}

function resourceHostContext(
  method: "reservation.prepareAssignmentRoot",
  assignmentId: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "resource-governor" },
    requestId: `resource:${assignmentId}:${method}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

function usageReporterContext(
  executorId: string,
  reportDigest: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId },
    requestId: `usage-report:${reportDigest}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

function runFailureReason(result: RunResult["agentResult"]): string {
  if (result.reason === "error") return result.error.message;
  if (result.reason === "max_turns") return "达到最大轮次限制";
  if (result.reason === "aborted") return "运行已中止";
  return "运行未完成";
}

function executionFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelledRunResult(result: RunResult): RunResult {
  if (result.agentResult.reason === "aborted") return result;
  return {
    ...result,
    agentResult: {
      reason: "aborted",
      usage: result.agentResult.usage,
    },
  };
}

function replayCommittedRun(
  runRecord: TranscriptRunRecord,
  windowCompact: RunResult["windowCompact"],
): RunResult {
  const message = [...runRecord.messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  if (!message || message.role !== "assistant") {
    throw new Error("Committed conversation run has no assistant result");
  }
  const usage = runRecord.usage ?? { inputTokens: 0, outputTokens: 0 };
  return {
    agentResult: { reason: "completed", message, usage },
    runRecord: {
      timestamp: runRecord.timestamp,
      messages: [...runRecord.messages],
      usage,
      ...(runRecord.source ? { source: runRecord.source } : {}),
      ...(runRecord.advancement ? { advancement: runRecord.advancement } : {}),
      ...(runRecord.perspectives ? { perspectives: runRecord.perspectives } : {}),
    },
    ...(windowCompact ? { windowCompact } : {}),
    newMessages: runRecord.messages.slice(1),
    durationMs: 0,
  };
}

function discoverRecoveryConversations(
  commits: readonly {
    readonly entries: readonly { readonly stream: string; readonly body: unknown }[];
  }[],
): Set<string> {
  type ConversationRecoveryFacts = {
    deleted: boolean;
    readonly lifecycleFacts: Set<number>;
    readonly lifecycleProjections: Set<number>;
    readonly runStates: Map<string, string>;
    readonly commits: Map<string, number>;
    readonly projected: Set<string>;
    readonly acknowledged: Set<string>;
    readonly terminalFinals: Set<number>;
  };
  const factsByConversation = new Map<string, ConversationRecoveryFacts>();
  const publishDomains = new Map<string, Set<"session" | "global">>();
  const factsFor = (conversationId: string) => {
    let facts = factsByConversation.get(conversationId);
    if (!facts) {
      facts = {
        deleted: false,
        lifecycleFacts: new Set(),
        lifecycleProjections: new Set(),
        runStates: new Map(),
        commits: new Map(),
        projected: new Set(),
        acknowledged: new Set(),
        terminalFinals: new Set(),
      };
      factsByConversation.set(conversationId, facts);
    }
    return facts;
  };

  for (const commit of commits) {
    for (const entry of commit.entries) {
      const body = entry.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) continue;
      const record = body as Record<string, unknown>;
      if (entry.stream.startsWith("run:")) {
        const conversationId = entry.stream.slice("run:".length);
        const facts = factsFor(conversationId);
        if (
          record.t === "session-lifecycle" &&
          typeof record.domainRevision === "number"
        ) {
          facts.lifecycleFacts.add(record.domainRevision);
          if (record.mutation === "delete") facts.deleted = true;
        } else if (
          record.kind === "conversation-lifecycle-projection" &&
          typeof record.domainRevision === "number"
        ) {
          facts.lifecycleProjections.add(record.domainRevision);
        } else if (
          record.t === "state" &&
          typeof record.runId === "string" &&
          typeof record.state === "string"
        ) {
          facts.runStates.set(record.runId, record.state);
        } else if (
          record.t === "committed" &&
          typeof record.assignmentId === "string" &&
          typeof record.commitRevision === "number"
        ) {
          facts.commits.set(record.assignmentId, record.commitRevision);
        } else if (
          record.t === "bundle-ack-observed" &&
          typeof record.assignmentId === "string"
        ) {
          facts.acknowledged.add(record.assignmentId);
        } else if (
          record.kind === "conversation-commit-projection" &&
          typeof record.assignmentId === "string"
        ) {
          facts.projected.add(record.assignmentId);
        }
        continue;
      }
      if (
        entry.stream === "publish" &&
        record.t === "publish-decision" &&
        typeof record.assignmentId === "string"
      ) {
        const required = new Set<"session" | "global">();
        if (typeof record.sessionCount === "number" && record.sessionCount > 0) {
          required.add("session");
        }
        if (typeof record.globalCount === "number" && record.globalCount > 0) {
          required.add("global");
        }
        publishDomains.set(record.assignmentId, required);
      } else if (
        entry.stream === "publish" &&
        record.t === "publish-progress" &&
        record.state === "settled" &&
        typeof record.assignmentId === "string" &&
        (record.domain === "session" || record.domain === "global")
      ) {
        publishDomains.get(record.assignmentId)?.delete(record.domain);
      } else if (
        entry.stream === "final-outbox" &&
        record.t === "final" &&
        typeof record.conversationId === "string" &&
        typeof record.commitRevision === "number" &&
        (record.state === "published" || record.state === "expired")
      ) {
        factsFor(record.conversationId).terminalFinals.add(record.commitRevision);
      }
    }
  }

  const result = new Set<string>();
  const openStates = new Set([
    "queued",
    "dispatched",
    "running",
    "cancel-requested",
    "uncertain",
  ]);
  for (const [conversationId, facts] of factsByConversation) {
    const hasPendingLifecycle = [...facts.lifecycleFacts].some(
      (revision) => !facts.lifecycleProjections.has(revision),
    );
    if (hasPendingLifecycle) {
      result.add(conversationId);
      continue;
    }
    if (facts.deleted) continue;
    if ([...facts.runStates.values()].some((state) => openStates.has(state))) {
      result.add(conversationId);
      continue;
    }
    for (const [assignmentId, revision] of facts.commits) {
      if (
        !facts.projected.has(assignmentId) ||
        !facts.acknowledged.has(assignmentId) ||
        !facts.terminalFinals.has(revision) ||
        (publishDomains.get(assignmentId)?.size ?? 0) > 0
      ) {
        result.add(conversationId);
        break;
      }
    }
  }
  return result;
}

function partitionConversationSnapshots(
  snapshot: AuthorityLogSnapshot<unknown>,
): Map<string, AuthorityLogSnapshot<unknown>> {
  const assignmentConversations = new Map<string, string>();
  const commitsByConversation = new Map<string, CommitEnvelope<unknown>[]>();
  for (const commit of snapshot.commits) {
    const conversations = new Set<string>();
    for (const entry of commit.entries) {
      if (!entry.stream.startsWith("run:")) continue;
      const conversationId = entry.stream.slice("run:".length);
      conversations.add(conversationId);
      if (entry.body && typeof entry.body === "object" && !Array.isArray(entry.body)) {
        const assignmentId = (entry.body as { assignmentId?: unknown }).assignmentId;
        if (typeof assignmentId === "string") {
          assignmentConversations.set(assignmentId, conversationId);
        }
      }
    }
    for (const entry of commit.entries) {
      if (!entry.body || typeof entry.body !== "object" || Array.isArray(entry.body)) {
        continue;
      }
      const record = entry.body as Record<string, unknown>;
      if (entry.stream === "publish" && typeof record.assignmentId === "string") {
        const conversationId = assignmentConversations.get(record.assignmentId);
        if (conversationId) conversations.add(conversationId);
      } else if (
        entry.stream === "final-outbox" &&
        typeof record.conversationId === "string"
      ) {
        conversations.add(record.conversationId);
      }
    }
    for (const conversationId of conversations) {
      const commits = commitsByConversation.get(conversationId) ?? [];
      commits.push(commit);
      commitsByConversation.set(conversationId, commits);
    }
  }
  return new Map(
    [...commitsByConversation].map(([conversationId, commits]) => [
      conversationId,
      { commits, cursor: snapshot.cursor },
    ]),
  );
}

function emptyConversationSnapshot(
  snapshot: AuthorityLogSnapshot<unknown>,
): AuthorityLogSnapshot<unknown> {
  return { commits: [], cursor: snapshot.cursor };
}

function requireRuntimeSecuritySnapshot(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["securitySnapshot"]>> {
  const snapshot = runtime.securitySnapshot?.();
  if (snapshot === undefined) {
    throw new Error("Recovered conversation runtime lacks a security snapshot");
  }
  return snapshot;
}

function requireRuntimeExecutionProfile(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["executionProfile"]>> {
  const profile = runtime.executionProfile?.();
  if (profile === undefined) {
    throw new Error("Recovered conversation runtime lacks an execution profile");
  }
  return profile;
}

function requireRuntimeExecutionPermissionRules(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["executionPermissionRules"]>> {
  const rules = runtime.executionPermissionRules?.();
  if (rules === undefined) {
    throw new Error(
      "Recovered conversation runtime lacks an execution permission snapshot",
    );
  }
  return rules;
}

function supportsRemoteConversationExecution(
  invocation: ConversationInvocation,
  ingress: IngressContext,
): boolean {
  // Specialized control and orchestration invocations retain their dedicated local
  // runtime until those modules bind an equivalent remote execution contract.
  return invocation.kind === "agent" &&
    invocation.advancement === undefined &&
    ((invocation.source === "interactive" && ingress.kind === "first-party") ||
      (invocation.source === "channel" && ingress.kind === "channel"));
}

function conversationIdFromSubmissionContext(context: AuthorityCallContext): string {
  const principal = context.principal;
  if (
    principal.kind !== "assignment" ||
    principal.capability.scope.execution !== "conversation"
  ) {
    throw new TypeError("Conversation submission requires a conversation assignment capability");
  }
  return principal.capability.scope.conversationId;
}

function asConversationMirrorBatch(
  batch: InteractionMirrorBatch,
): ConversationInteractionMirrorBatch {
  for (const entry of batch.entries) {
    if (
      entry.outcome.t === "answered" &&
      entry.outcome.authority.via !== "surface-ticket"
    ) {
      throw new TypeError("Conversation interaction answer requires a surface ticket");
    }
  }
  return batch as ConversationInteractionMirrorBatch;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
