import type {
  IEventBus,
  SchedulerEventMap,
  SystemHandler,
} from "@zhixing/core";
import type {
  ScheduleLifecycleApplication,
  ScheduleLifecycleMechanismPort,
} from "@zhixing/core/scheduler/application";
import type {
  AuthorityCallContext,
  AuthorityCapability,
  DataPlaneTicket,
  ExecutionRef,
  JobOccurrence,
  JobExecutionInstruction,
  OwnerControlGrant,
  RunExecutorPort,
  TaskDefinition,
} from "@zhixing/core/contracts";
import {
  MAX_CONTROL_LEASE_TTL_MS,
  assertPrincipalAllowsAuthorityMethod,
  dispatchEnvelopeDigest,
  ownerControlRequestDigest,
  protocolDigest,
  validateAuthorityCapability,
} from "@zhixing/core/protocol";
import {
  AnchorScheduler,
  AnchorSchedulerGlobalStateAdapter,
  AnchorSchedulerProductPort,
  InProcessJobDispatcher,
  JobAssignmentAuthority,
  JobJournal,
  SchedulerJobCommitParticipant,
  SchedulerConversationMutationPublisher,
  GlobalMutationCommitCoordinator,
  SchedulerUserNoticeJournal,
  DeferredGlobalIntentAnchorReviewService,
  DeferredGlobalIntentRepository,
  assignmentReservationId,
  type AssignmentSubmissionAuthorizer,
  type InProcessDispatchContextFactory,
  type JobIngressAuthorizer,
  type JobLifecycleEvent,
  type PendingJobDispatch,
  type SystemJobHandler,
  type ConfirmationHub,
} from "@zhixing/owner-kernel";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import type {
  JobRelayObligationDirectory,
  JobRelayOpening,
} from "./channel-interaction-coordinator.js";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { ExecutorJobOwner } from "./executor-job-owner.js";
import type { JobStatusDirectory } from "./job-status-directory.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";
import type { AssignmentArtifactAuthority } from "./assignment-mesh-adapter.js";
import {
  ManualJobSurfaceLifecycle,
  type ManualJobSurfaceSession,
} from "./manual-job-surface-lifecycle.js";
import { SchedulerCapabilityGapError } from "./scheduler-capability-gap.js";
import {
  PostAdoptionReviewCoordinator,
  type PostAdoptionReviewPort,
} from "./post-adoption-review.js";

const OWNER_CONTEXT_RENEWAL_MS = Math.floor(MAX_CONTROL_LEASE_TTL_MS / 3);
const TERMINAL_JOB_STATES = new Set([
  "committed",
  "cancelled",
  "failed",
  "expired",
  "missed",
] as const);

export interface AnchorSchedulerRuntimeOptions {
  readonly authority: AuthorityRuntimeStack;
  readonly protocol: ConversationProtocolRuntime;
  readonly localExecutor?: RunExecutorPort;
  readonly eventBus: IEventBus<SchedulerEventMap>;
  readonly jobStatus: JobStatusDirectory;
  readonly jobRelays: JobRelayObligationDirectory;
  readonly openManualJobSurface: (input: {
    readonly executorId: string;
    readonly assignmentId: string;
    readonly ref: Extract<ExecutionRef, { readonly execution: "job" }>;
    readonly ticket: DataPlaneTicket;
    readonly surfacePrincipal: string;
  }) => Promise<ManualJobSurfaceSession>;
  readonly localJobOwner?: ExecutorJobOwner;
  readonly mesh: () => MeshRuntimeAssembly | undefined;
  readonly capabilities: {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
  readonly systemHandlers: ReadonlyMap<string, SystemHandler>;
  readonly systemTasks: NonNullable<
    import("@zhixing/owner-kernel").AnchorSchedulerOptions["systemTasks"]
  >;
  readonly now?: () => Date;
  readonly onError?: (error: Error) => void;
}

/**
 * Concrete Schedule mechanism plus the physical Authority generation captured
 * when the Host constructed it. The generation never crosses the domain port.
 */
export interface AnchorScheduleLifecycleMechanism
  extends ScheduleLifecycleMechanismPort {
  readonly installedAnchorEpoch: number;
}

/**
 * Host-owned slot for the one concrete Anchor Schedule mechanism. Schedule
 * owns lifecycle semantics; this boundary alone compares physical generations
 * and keeps the exact installed instance aligned with those lifecycle calls.
 */
export class AnchorSchedulerHostLifecycle {
  #current: AnchorSchedulerRuntime | undefined;
  #bindingRelease: (() => void) | undefined;
  #publicationRelease: (() => void) | undefined;
  #closed = false;
  #stopPromise: Promise<void> | undefined;
  readonly #application: ScheduleLifecycleApplication;
  readonly #postAdoptionReviewCoordinator: PostAdoptionReviewCoordinator;
  readonly postAdoptionReview: PostAdoptionReviewPort;

  constructor(input: Readonly<{
    application: ScheduleLifecycleApplication;
    confirmationHub: ConfirmationHub;
    workingDirectory: string;
  }>) {
    this.#application = input.application;
    this.#postAdoptionReviewCoordinator = new PostAdoptionReviewCoordinator({
      review: {
        list: (conversationId, context) =>
          this.#currentReview().list(conversationId, context),
        decide: (intentId, decision, context) =>
          this.#currentReview().decide(intentId, decision, context),
      },
      hub: input.confirmationHub,
      workingDirectory: input.workingDirectory,
    });
    this.postAdoptionReview = Object.freeze({
      reviewAfterAdoption: (conversationId: string) =>
        this.#postAdoptionReviewCoordinator.reviewAfterAdoption(conversationId),
      reviewForSurface: (
        request: Parameters<PostAdoptionReviewPort["reviewForSurface"]>[0],
      ) =>
        this.#postAdoptionReviewCoordinator.reviewForSurface(request),
    });
  }

  async installInitial(input: Readonly<{
    mechanism: AnchorSchedulerRuntime;
    prepare: (mechanism: AnchorSchedulerRuntime) => Promise<void>;
    bind: (mechanism: AnchorSchedulerRuntime) => () => void;
    publish: (mechanism: AnchorSchedulerRuntime) => () => void;
    activate: (mechanism: AnchorSchedulerRuntime) => void;
    resume: (mechanism: AnchorSchedulerRuntime) => Promise<void>;
  }>): Promise<void> {
    if (this.#closed) throw new Error("Anchor Schedule generation owner is closed");
    if (this.#current) {
      throw new Error("Anchor Schedule runtime generation is already installed");
    }
    let bindingRelease: (() => void) | undefined;
    let publicationRelease: (() => void) | undefined;
    let applicationInstalled = false;
    try {
      await input.prepare(input.mechanism);
      bindingRelease = input.bind(input.mechanism);
      this.#application.install(input.mechanism);
      applicationInstalled = true;
      publicationRelease = input.publish(input.mechanism);
      this.#bindingRelease = bindingRelease;
      this.#publicationRelease = publicationRelease;
      this.#current = input.mechanism;
      input.activate(input.mechanism);
      await input.resume(input.mechanism);
    } catch (error) {
      if (this.#current === input.mechanism) {
        this.#current = undefined;
        this.#bindingRelease = undefined;
        this.#publicationRelease = undefined;
      }
      publicationRelease?.();
      if (applicationInstalled) {
        this.#application.release(input.mechanism);
      }
      bindingRelease?.();
      await stopFailedGeneration(input.mechanism, error);
    }
  }

  stopAndRelease(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#closed = true;
    this.#stopPromise = this.#stopAndReleaseOnce();
    return this.#stopPromise;
  }

  async recoverInstalledAuthority(input: {
    readonly currentAnchorEpoch: number;
    readonly create: () => Promise<AnchorSchedulerRuntime>;
    readonly prepare: (mechanism: AnchorSchedulerRuntime) => Promise<void>;
    readonly bind: (mechanism: AnchorSchedulerRuntime) => () => void;
    readonly publish: (mechanism: AnchorSchedulerRuntime) => () => void;
    readonly activate: (mechanism: AnchorSchedulerRuntime) => void;
    readonly resume: (mechanism: AnchorSchedulerRuntime) => Promise<void>;
  }): Promise<void> {
    if (this.#closed) throw new Error("Anchor Schedule generation owner is closed");
    const current = this.#current;
    if (!current) {
      throw new Error("Anchor Schedule runtime generation is unavailable");
    }
    if (current.installedAnchorEpoch === input.currentAnchorEpoch) {
      await this.#application.recoverInstalledAuthority();
      return;
    }
    const currentBindingRelease = this.#bindingRelease;
    const currentPublicationRelease = this.#publicationRelease;
    if (!currentBindingRelease || !currentPublicationRelease) {
      throw new Error("Anchor Schedule runtime generation ownership is incomplete");
    }

    const replacement = await input.create();
    if (replacement.installedAnchorEpoch !== input.currentAnchorEpoch) {
      await stopFailedGeneration(
        replacement,
        new Error("Anchor Schedule runtime generation does not match current Authority"),
      );
    }
    try {
      await input.prepare(replacement);
    } catch (error) {
      await stopFailedGeneration(replacement, error);
    }

    let replacementBindingRelease: (() => void) | undefined;
    let replacementPublicationRelease: (() => void) | undefined;
    let currentBindingReleased = false;
    let currentPublicationReleased = false;
    let applicationSwitched = false;
    try {
      currentBindingRelease();
      currentBindingReleased = true;
      replacementBindingRelease = input.bind(replacement);

      this.#application.release(current);
      try {
        this.#application.install(replacement);
        applicationSwitched = true;
      } catch (error) {
        this.#application.install(current);
        throw error;
      }

      currentPublicationRelease();
      currentPublicationReleased = true;
      replacementPublicationRelease = input.publish(replacement);

      // Commit point: every fallible generation edge is complete. From here
      // the stable review port and Schedule application move together.
      this.#bindingRelease = replacementBindingRelease;
      this.#publicationRelease = replacementPublicationRelease;
      this.#current = replacement;
      // Activation may synchronously start timer/recovery work. Every shared
      // consumer and stable product/review boundary therefore points at the
      // replacement before this call; async surface resume is a separate step.
      input.activate(replacement);
      await input.resume(replacement);
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (this.#current === replacement) this.#current = current;
      attemptGenerationRelease(replacementPublicationRelease, rollbackFailures);
      if (applicationSwitched) {
        try {
          this.#application.release(replacement);
          this.#application.install(current);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (currentPublicationReleased) {
        try {
          this.#publicationRelease = input.publish(current);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      attemptGenerationRelease(replacementBindingRelease, rollbackFailures);
      if (currentBindingReleased) {
        try {
          this.#bindingRelease = input.bind(current);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      try {
        await replacement.stop();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      throwGenerationTransitionFailure(error, rollbackFailures);
    }

    this.#postAdoptionReviewCoordinator.resetForInstalledGeneration();
    try {
      await current.stop();
    } catch (error) {
      throw error;
    }
  }

  #currentReview(): DeferredGlobalIntentAnchorReviewService {
    const current = this.#current;
    if (!current) {
      throw new Error("Post-adoption review generation is unavailable");
    }
    return current.deferredIntents;
  }

  async #stopAndReleaseOnce(): Promise<void> {
    this.#postAdoptionReviewCoordinator.close();
    const current = this.#current;
    await this.#application.stop();
    if (!current) return;
    this.#publicationRelease?.();
    this.#publicationRelease = undefined;
    this.#bindingRelease?.();
    this.#bindingRelease = undefined;
    this.#application.release(current);
    this.#current = undefined;
  }
}

function attemptGenerationRelease(
  release: (() => void) | undefined,
  failures: unknown[],
): void {
  try {
    release?.();
  } catch (error) {
    failures.push(error);
  }
}

function throwGenerationTransitionFailure(
  cause: unknown,
  rollbackFailures: readonly unknown[],
): never {
  if (rollbackFailures.length === 0) throw cause;
  throw new AggregateError(
    [cause, ...rollbackFailures],
    "Anchor Schedule generation transition and rollback failed",
    { cause },
  );
}

async function stopFailedGeneration(
  mechanism: AnchorSchedulerRuntime,
  cause: unknown,
): Promise<never> {
  try {
    await mechanism.stop();
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      "Anchor Schedule generation setup and cleanup failed",
      { cause },
    );
  }
  throw cause;
}

/**
 * Product composition for the anchor-owned scheduler and job authority.
 *
 * All execution and projection state comes from the assignment journal,
 * executor job owner and durable submission protocol.
 */
export class AnchorSchedulerRuntime implements AnchorScheduleLifecycleMechanism {
  readonly installedAnchorEpoch: number;
  readonly #scheduler: AnchorScheduler;
  readonly schedulerNotices: SchedulerUserNoticeJournal;
  readonly deferredIntents: DeferredGlobalIntentAnchorReviewService;
  readonly #options: AnchorSchedulerRuntimeOptions;
  readonly #issuer: JobAssignmentAuthority;
  readonly #commitParticipant: SchedulerJobCommitParticipant;
  readonly #mutationCoordinator: GlobalMutationCommitCoordinator;
  readonly #intentRepository: DeferredGlobalIntentRepository;
  readonly #journals = new Map<string, JobJournal>();
  readonly #executorByAssignment = new Map<string, string>();
  readonly #artifactAuthorityByAssignment = new Map<
    string,
    AssignmentArtifactAuthority
  >();
  readonly #relayDisposers = new Map<string, () => void>();
  readonly #statusDisposers = new Map<string, () => void>();
  readonly #journalLifecycleDisposers = new Map<string, () => void>();
  readonly #mutationPublisher: SchedulerConversationMutationPublisher;
  #schedulerNoticeDisposer: (() => void) | undefined;
  #capabilityReadyDisposer: (() => void) | undefined;
  #mutationPublisherDisposer: (() => void) | undefined;
  #generationBound = false;
  readonly #dispatchers = new Map<string, InProcessJobDispatcher>();
  readonly #manualSurfaces: ManualJobSurfaceLifecycle;
  readonly #retirementTasks = new Map<string, Promise<void>>();
  readonly #clock: () => string;

  private constructor(options: AnchorSchedulerRuntimeOptions) {
    this.#options = options;
    this.installedAnchorEpoch = options.authority.anchorEpoch;
    this.#clock = () => (options.now?.() ?? new Date()).toISOString();
    this.#manualSurfaces = new ManualJobSurfaceLifecycle({
      ...(options.onError ? { onError: options.onError } : {}),
    });
    this.#issuer = new JobAssignmentAuthority({
      signer: options.authority.signer,
      verifier: options.authority.verifier,
      snapshotFor: (executorId) =>
        options.authority.executorCapabilities.snapshotFor(executorId),
      clock: this.#clock,
    });
    this.schedulerNotices = new SchedulerUserNoticeJournal({
      log: options.authority.authorityLog,
      delivery: options.authority.participant,
    });
    this.#scheduler = new AnchorScheduler({
      anchorEpoch: options.authority.anchorEpoch,
      deviceId: options.authority.deviceId,
      admission: options.authority.controlAdmission,
      eventBus: options.eventBus,
      listTaskIds: () => this.#listTaskIds(),
      journalFor: (taskId) => this.#journal(taskId),
      activateUserJob: (input) => this.#activate(input),
      recoverUserJobs: (journal, acceptedJobRunIds) =>
        this.#recoverJournal(journal, acceptedJobRunIds),
      cancelUserJob: (input) => this.#cancel(input),
      systemTasks: options.systemTasks,
      schedulerNotices: this.schedulerNotices,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
    this.#mutationCoordinator = new GlobalMutationCommitCoordinator({
      log: options.authority.authorityLog,
      artifacts: options.authority.artifacts,
      participants: options.authority.globalMutationParticipants,
      refreshSchedule: (taskIds) => this.#scheduler.refreshCommittedDefinitions(taskIds),
      scheduleDefinitionFor: (taskId) => this.#scheduler.getDefinition(taskId),
    });
    const rubricGlobalState = options.authority.rubricGlobalState;
    if (!rubricGlobalState) {
      throw new Error("Anchor deferred intent review requires the rubric authority");
    }
    this.#intentRepository = new DeferredGlobalIntentRepository({
      log: options.authority.authorityLog,
      localDomainId: options.authority.localDomainId,
      ownerEpoch: options.authority.anchorEpoch,
      mode: "anchor",
      acceptsConversationId: () => true,
      conversationExists: (conversationId) => options.protocol.sessionExists(conversationId),
      isCurrentOwner: (conversationId) => options.protocol.sessionExists(conversationId),
      conversationAuthority: options.protocol.deferredIntentAuthority,
      clock: this.#clock,
    });
    this.deferredIntents = new DeferredGlobalIntentAnchorReviewService({
      repository: this.#intentRepository,
      admission: options.authority.controlAdmission,
      coordinator: this.#mutationCoordinator,
      rubrics: rubricGlobalState,
      anchorEpoch: options.authority.anchorEpoch,
      deviceId: options.authority.deviceId,
      isCurrentOwner: (conversationId) => options.protocol.sessionExists(conversationId),
      now: this.#clock,
    });
    this.#commitParticipant = new SchedulerJobCommitParticipant({
      coordinator: this.#mutationCoordinator,
      log: options.authority.authorityLog,
      artifacts: options.authority.artifacts,
      onFatal: (error) => {
        options.onError?.(error);
        void this.#scheduler.stop().catch((stopError) => {
          options.onError?.(
            stopError instanceof Error ? stopError : new Error(String(stopError)),
          );
        });
      },
    });
    this.#mutationPublisher = new SchedulerConversationMutationPublisher({
        anchorEpoch: options.authority.anchorEpoch,
        coordinator: this.#mutationCoordinator,
        sourceForAssignment: (assignmentId) => {
          const ingress = options.protocol.assignmentIngress(assignmentId);
          const origin =
            ingress.kind === "channel"
              ? ingress.replyTarget
              : ingress.turnOrigin?.target;
          return {
            ...(origin ? { origin: structuredClone(origin) } : {}),
            ...(ingress.kind === "channel"
              ? { interactionResponder: structuredClone(ingress.responder) }
              : {}),
            createdInTurn: ingress.ingressId,
          };
        },
      });
  }

  static async create(
    options: AnchorSchedulerRuntimeOptions,
  ): Promise<AnchorSchedulerRuntime> {
    const runtime = new AnchorSchedulerRuntime(options);
    await runtime.schedulerNotices.initializeLiveCursor();
    return runtime;
  }

  createProductBoundary(): {
    readonly globalState: AnchorSchedulerGlobalStateAdapter;
    readonly product: AnchorSchedulerProductPort;
  } {
    const globalState = new AnchorSchedulerGlobalStateAdapter(
      this.#scheduler,
      this.installedAnchorEpoch,
    );
    return Object.freeze({
      globalState,
      product: new AnchorSchedulerProductPort(
        this.#scheduler,
        globalState,
        this.installedAnchorEpoch,
        this.#options.eventBus,
      ),
    });
  }

  async start(): Promise<void> {
    await this.#intentRepository.recover();
    await this.#scheduler.prepare();
    await this.#mutationCoordinator.recoverDerivedState();
    await this.#commitParticipant.start();
  }

  /** Publishes generation-scoped shared bindings only after Host selection. */
  bindGeneration(): () => void {
    if (this.#generationBound) {
      throw new Error("Anchor Schedule generation is already bound");
    }
    try {
      this.#schedulerNoticeDisposer = this.#options.jobStatus.registerScheduler(
        this.schedulerNotices,
      );
      this.#capabilityReadyDisposer =
        this.#options.authority.executorCapabilities.onAccepted(
          () => this.#scheduler.wakeQueuedUserJobs(),
        );
      for (const [taskId, journal] of this.#journals) {
        this.#statusDisposers.set(
          taskId,
          this.#options.jobStatus.register(taskId, journal),
        );
      }
      this.#mutationPublisherDisposer =
        this.#options.protocol.bindMutationPublisher(this.#mutationPublisher);
      this.#generationBound = true;
    } catch (error) {
      this.#releaseGenerationBindings();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseGenerationBindings();
    };
  }

  async recoverInstalledAuthority(): Promise<void> {
    for (const dispatcher of this.#dispatchers.values()) {
      await dispatcher.stopRecoveryLoop();
    }
    for (const dispose of this.#relayDisposers.values()) dispose();
    for (const dispose of this.#statusDisposers.values()) dispose();
    for (const dispose of this.#journalLifecycleDisposers.values()) dispose();
    this.#dispatchers.clear();
    this.#relayDisposers.clear();
    this.#statusDisposers.clear();
    this.#journalLifecycleDisposers.clear();
    this.#journals.clear();
    this.#executorByAssignment.clear();
    this.#artifactAuthorityByAssignment.clear();
    await this.#intentRepository.recover();
    await this.#scheduler.recoverInstalledAuthority();
    await this.#mutationCoordinator.recoverDerivedState();
    await this.#commitParticipant.start();
  }

  activate(): void {
    this.#scheduler.activate();
  }

  closeAdmission(): void {
    this.#scheduler.closeAdmissionForLifecycle();
  }

  listAcceptedWork(): Promise<readonly { readonly id: string; readonly revision: string }[]> {
    return this.#scheduler.acceptedWorkItems();
  }

  recoverAcceptedWork(
    frozen: readonly { readonly id: string; readonly revision: string }[],
  ): Promise<void> {
    return this.#scheduler.recoverAcceptedWorkForLifecycle(frozen);
  }

  pauseAndSettle(): Promise<void> {
    return this.#scheduler.pauseForAuthorityTransfer();
  }

  resumeAdmission(): void {
    this.#scheduler.resumeAfterAuthorityTransfer();
  }

  async stop(): Promise<void> {
    this.#capabilityReadyDisposer?.();
    this.#capabilityReadyDisposer = undefined;
    let stopFailure: unknown;
    try {
      await this.#scheduler.stop();
    } catch (error) {
      stopFailure = error;
    }
    try {
      await this.#commitParticipant.stop();
    } catch (error) {
      stopFailure ??= error;
    }
    await this.#manualSurfaces.stop();
    await Promise.allSettled(this.#retirementTasks.values());
    await Promise.all(
      [...this.#dispatchers.values()].map((dispatcher) =>
        dispatcher.stopRecoveryLoop(),
      ),
    );
    for (const dispose of this.#relayDisposers.values()) dispose();
    for (const dispose of this.#statusDisposers.values()) dispose();
    for (const dispose of this.#journalLifecycleDisposers.values()) dispose();
    this.#relayDisposers.clear();
    this.#statusDisposers.clear();
    this.#journalLifecycleDisposers.clear();
    this.#dispatchers.clear();
    this.#executorByAssignment.clear();
    this.#artifactAuthorityByAssignment.clear();
    this.#schedulerNoticeDisposer?.();
    this.#schedulerNoticeDisposer = undefined;
    this.#mutationPublisherDisposer?.();
    this.#mutationPublisherDisposer = undefined;
    this.#generationBound = false;
    if (stopFailure) throw stopFailure;
  }

  /** Called after the RPC server exists, so recovered manual surfaces can resume. */
  async resumeManualSurfaces(): Promise<void> {
    await this.#manualSurfaces.resume();
  }

  async #activate(input: {
    readonly journal: JobJournal;
    readonly definition: TaskDefinition & {
      readonly definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
    };
    readonly occurrence: JobOccurrence;
  }): Promise<void> {
    const instruction: JobExecutionInstruction = {
      kind: "agent-turn",
      prompt: input.definition.definition.spec.action.prompt,
      ...(input.definition.definition.spec.action.model
        ? { model: input.definition.definition.spec.action.model }
        : {}),
      ...(input.definition.definition.spec.action.tools
        ? { tools: [...input.definition.definition.spec.action.tools] }
        : {}),
    };
    let prepared;
    try {
      prepared = await this.#options.authority.prepareJobAssignment({
        instruction,
        capabilities: this.#options.capabilities,
        ...(await this.#remoteTargets()),
      });
    } catch (error) {
      if (error instanceof SchedulerCapabilityGapError) {
        const requestId = `scheduler-gap:${protocolDigest("SchedulerGapObservation", 1, {
          taskId: input.occurrence.taskId,
          jobRunId: input.occurrence.jobRunId,
          capabilityRevision: error.capabilityRevision,
          reason: error.message,
        })}`;
        await input.journal.noteCapabilityGap({
          jobRunId: input.occurrence.jobRunId,
          capabilityRevision: error.capabilityRevision,
          reason: error.message,
          context: {
            principal: { kind: "host", component: "anchor-scheduler" },
            requestId,
            deadlineAt: new Date(
              Date.parse(this.#clock()) + OWNER_CONTEXT_RENEWAL_MS,
            ).toISOString(),
          },
        });
      }
      throw error;
    }
    const attempt = 1;
    const assignmentId = `assignment:${protocolDigest("JobAssignmentIdentity", 1, {
      taskId: input.occurrence.taskId,
      jobRunId: input.occurrence.jobRunId,
      taskRevision: input.occurrence.taskRevision,
      attempt,
    })}`;
    const context = resourceContext(assignmentId, this.#clock());
    await this.#options.authority.resourceGovernor.enqueueRoot(
      assignmentReservationId(assignmentId),
      { kind: "job", id: input.occurrence.jobRunId, attempt },
      { admissionClass: "scheduler", entry: "schedule-trigger" },
      context,
    );
    const resourceLease =
      await this.#options.authority.resourceGovernor.prepareAssignmentRoot<"job">(
        {
          assignmentId,
          executorId: prepared.executorId,
          workload: { kind: "job", id: input.occurrence.jobRunId, attempt },
          scopeBinding: {
            kind: "job",
            taskId: input.occurrence.taskId,
            anchorEpoch: this.#options.authority.anchorEpoch,
          },
          budget: prepared.policy.budget,
        },
        { admissionClass: "scheduler", entry: "schedule-trigger" },
        context,
      );
    const unsigned = this.#issuer.issue({
      assignmentId,
      executorId: prepared.executorId,
      anchorEpoch: this.#options.authority.anchorEpoch,
      attempt,
      occurrence: input.occurrence,
      definition: input.definition,
      instruction,
      environment: prepared.environment,
      resourceLease,
      policy: prepared.policy,
    });
    this.#executorByAssignment.set(assignmentId, prepared.executorId);
    const pending = await input.journal.assign({
      taskId: input.occurrence.taskId,
      jobRunId: input.occurrence.jobRunId,
      anchorEpoch: this.#options.authority.anchorEpoch,
      assignmentId,
      executorId: prepared.executorId,
      manifest: unsigned.manifest,
      materialize: () => unsigned,
    });
    await this.#rememberPending(input.journal, pending);
    const dispatcher = this.#dispatcher(input.journal, pending);
    await dispatcher.dispatchPending();
  }

  async #cancel(input: {
    readonly journal: JobJournal;
    readonly jobRunId: string;
    readonly requestId: string;
    readonly context: AuthorityCallContext;
  }) {
    const candidate = (await input.journal.assignmentsAwaitingRecovery()).find(
      (entry) => entry.dispatch.envelope.work.jobRunId === input.jobRunId,
    );
    if (!candidate) return input.journal.cancel(input);
    await this.#rememberPending(input.journal, candidate.dispatch);
    return this.#dispatcher(input.journal, candidate.dispatch).cancel(input);
  }

  async #recoverJournal(
    journal: JobJournal,
    acceptedJobRunIds?: ReadonlySet<string>,
  ): Promise<void> {
    const candidates = await journal.assignmentsAwaitingRecovery();
    for (const candidate of candidates) {
      if (
        acceptedJobRunIds &&
        !acceptedJobRunIds.has(candidate.dispatch.envelope.work.jobRunId)
      ) {
        continue;
      }
      try {
        await this.#rememberPending(journal, candidate.dispatch);
        const dispatcher = this.#dispatcher(journal, candidate.dispatch);
        await dispatcher.dispatchPending();
        await dispatcher.recoverStarted();
        await dispatcher.recoverCancellations();
        dispatcher.startRecoveryLoop();
      } catch (error) {
        this.#options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  async #rememberPending(
    journal: JobJournal,
    pending: PendingJobDispatch,
  ): Promise<void> {
    const capability = pending.envelope.capabilities[0] as
      | AuthorityCapability<"job">
      | undefined;
    if (!capability) throw new Error("Job assignment has no authority capability");
    this.#executorByAssignment.set(
      pending.assignmentId,
      pending.envelope.executorId,
    );
    this.#artifactAuthorityByAssignment.set(pending.assignmentId, {
      capability,
      activation: pending.activation,
    });
    const route = await journal.interactionRoute(pending.assignmentId);
    if (route.kind === "surface-ticket") {
      const dispose = this.#relayDisposers.get(pending.assignmentId);
      dispose?.();
      this.#relayDisposers.delete(pending.assignmentId);
      const state = await journal.currentState(pending.envelope.work.jobRunId);
      if (state && TERMINAL_JOB_STATES.has(state as never)) {
        await this.#manualSurfaces.markJobTerminal(
          pending.envelope.work.jobRunId,
        );
        return;
      }
      this.#manualSurfaces.register({
        assignmentId: pending.assignmentId,
        jobRunId: pending.envelope.work.jobRunId,
        open: () => this.#openManualSurface(journal, pending),
      });
      return;
    }
    if (!this.#relayDisposers.has(pending.assignmentId)) {
      const opening: JobRelayOpening = {
        assignmentId: pending.assignmentId,
        sourceRevision: dispatchEnvelopeDigest(pending.envelope),
        ref: {
          execution: "job",
          taskId: pending.envelope.work.taskId,
          jobRunId: pending.envelope.work.jobRunId,
          anchorEpoch: this.#options.authority.anchorEpoch,
        },
        executorId: pending.envelope.executorId,
        controlLeaseId: pending.envelope.controlLease.controlLeaseId,
        journal,
        answers: this.#answersFor(pending.envelope.executorId),
      };
      this.#relayDisposers.set(
        pending.assignmentId,
        this.#options.jobRelays.register(opening),
      );
    }
  }

  async #openManualSurface(
    journal: JobJournal,
    pending: PendingJobDispatch,
  ): Promise<ManualJobSurfaceSession> {
    const route = await journal.interactionRoute(pending.assignmentId);
    if (route.kind !== "surface-ticket") {
      throw new Error("Manual job assignment no longer has a surface route");
    }
    const facts = await journal.dataPlaneTicketFacts();
    const revoked = new Set(facts.revokedTicketIds);
    const existing = facts.issued
      .filter(
        (ticket) =>
          ticket.assignmentId === pending.assignmentId &&
          ticket.kind === "run-interact" &&
          ticket.surfacePrincipal === route.ingress.surfacePrincipal &&
          !revoked.has(ticket.ticketId),
      )
      .sort((left, right) => left.issuedAt.localeCompare(right.issuedAt))
      .at(-1);
    const now = Date.parse(this.#clock());
    const ticket =
      existing && Date.parse(existing.expiry) > now
        ? existing
        : await journal.issueDataPlaneTicket({
            ticketId: `ticket:${protocolDigest(
              "ManualJobInteractionTicketIdentity",
              1,
              {
                assignmentId: pending.assignmentId,
                surfacePrincipal: route.ingress.surfacePrincipal,
                generation: facts.issued.filter(
                  (candidate) =>
                    candidate.assignmentId === pending.assignmentId &&
                    candidate.kind === "run-interact",
                ).length + 1,
              },
            )}`,
            assignmentId: pending.assignmentId,
            surfacePrincipal: route.ingress.surfacePrincipal,
            kind: "run-interact",
            ttlMs: 24 * 60 * 60 * 1_000,
            ...(existing ? { replacesTicketId: existing.ticketId } : {}),
          });
    return this.#options.openManualJobSurface({
      executorId: pending.envelope.executorId,
      assignmentId: pending.assignmentId,
      ref: {
        execution: "job",
        taskId: pending.envelope.work.taskId,
        jobRunId: pending.envelope.work.jobRunId,
        anchorEpoch: this.#options.authority.anchorEpoch,
      },
      ticket,
      surfacePrincipal: route.ingress.surfacePrincipal,
    });
  }

  #dispatcher(
    journal: JobJournal,
    pending: PendingJobDispatch,
  ): InProcessJobDispatcher {
    const key = pending.assignmentId;
    const current = this.#dispatchers.get(key);
    if (current) return current;
    const local = pending.envelope.executorId === this.#options.authority.executorId;
    const executor = local
      ? this.#options.localExecutor
      : this.#requiredMesh().jobExecutorFor(
          pending.envelope.executorId,
          (assignmentId) => this.#artifactAuthority(assignmentId),
        );
    if (!executor) throw new Error("Local executor role is not enabled on this device");
    const dispatcher = new InProcessJobDispatcher({
      enabled: true,
      journal,
      executor,
      contexts: jobDispatchContexts({
        signer: this.#options.authority.signer,
        ownerDeviceId: this.#options.authority.deviceId,
        pending,
        controlLease: () => this.#issuer.controlLeaseFor({
          assignmentId: pending.assignmentId,
          taskId: pending.envelope.work.taskId,
          anchorEpoch: this.#options.authority.anchorEpoch,
          at: this.#clock(),
        }),
      }),
      cancellationSubmission: { submitCancellation: async () => false },
      bundleSubmission: {
        submitSealedBundle: async () => {
          throw new Error("Executor job owner retains sealed-bundle recovery");
        },
      },
      ...(local
        ? {
            onDispatchAccepted: (envelope) =>
              this.#requiredLocalOwner().accept(envelope),
            onCancelAccepted: (assignmentId) =>
              this.#requiredLocalOwner().cancelAccepted(assignmentId),
          }
        : {}),
      onRecoveryError: (error) => this.#options.onError?.(error),
    });
    this.#dispatchers.set(key, dispatcher);
    return dispatcher;
  }

  #answersFor(executorId: string) {
    return executorId === this.#options.authority.executorId
      ? this.#requiredLocalOwner()
      : this.#requiredMesh().jobInteractionForExecutor(executorId);
  }

  #requiredLocalOwner(): ExecutorJobOwner {
    if (!this.#options.localJobOwner) {
      throw new Error("Selected local executor has no job owner");
    }
    return this.#options.localJobOwner;
  }

  #requiredMesh(): MeshRuntimeAssembly {
    const mesh = this.#options.mesh();
    if (!mesh) throw new Error("Selected remote executor transport is unavailable");
    return mesh;
  }

  async #remoteTargets() {
    const mesh = this.#options.mesh();
    if (!mesh) return {};
    return { targets: await mesh.jobExecutionTargets() };
  }

  #artifactAuthority(assignmentId: string): Promise<AssignmentArtifactAuthority> {
    const authority = this.#artifactAuthorityByAssignment.get(assignmentId);
    if (!authority) {
      return Promise.reject(new Error(`Unknown job assignment ${assignmentId}`));
    }
    return Promise.resolve(authority);
  }

  async #handleJobLifecycle(event: JobLifecycleEvent): Promise<void> {
    if (event.kind === "job-state-changed") {
      if (TERMINAL_JOB_STATES.has(event.state as never)) {
        await this.#manualSurfaces.markJobTerminal(event.ref.jobRunId);
      }
      return;
    }
    await this.#retireAssignment(
      event.assignmentId,
      event.ref.jobRunId,
    );
  }

  #retireAssignment(assignmentId: string, jobRunId: string): Promise<void> {
    const current = this.#retirementTasks.get(assignmentId);
    if (current) return current;
    let retirement!: Promise<void>;
    retirement = (async () => {
      await this.#manualSurfaces.retire(assignmentId, jobRunId);
      const dispatcher = this.#dispatchers.get(assignmentId);
      await dispatcher?.stopRecoveryLoop();
      this.#dispatchers.delete(assignmentId);
      const disposeRelay = this.#relayDisposers.get(assignmentId);
      disposeRelay?.();
      this.#relayDisposers.delete(assignmentId);
      this.#executorByAssignment.delete(assignmentId);
      this.#artifactAuthorityByAssignment.delete(assignmentId);
    })().finally(() => {
      if (this.#retirementTasks.get(assignmentId) === retirement) {
        this.#retirementTasks.delete(assignmentId);
      }
    });
    this.#retirementTasks.set(assignmentId, retirement);
    return retirement;
  }

  #journal(taskId: string): JobJournal {
    let journal = this.#journals.get(taskId);
    if (journal) return journal;
    journal = new JobJournal({
      taskId,
      anchorEpoch: this.#options.authority.anchorEpoch,
      log: this.#options.authority.authorityLog,
      artifacts: this.#options.authority.artifacts,
      signer: this.#options.authority.signer,
      verifier: this.#options.authority.verifier,
      snapshotFor: (executorId) =>
        this.#options.authority.executorCapabilities.snapshotFor(executorId),
      submission: submissionAuthorizer(
        this.#executorByAssignment,
        this.#options.authority.verifier,
      ),
      ingress: schedulerIngressAuthorizer(),
      delivery: this.#options.authority.participant,
      commitParticipant: this.#commitParticipant,
      resources: this.#options.authority.resourceGovernor,
      systemResources: this.#options.authority.resourceGovernor,
      systemHandlers: adaptSystemHandlers(this.#options.systemHandlers),
      schedulerFailureThreshold: 5,
      schedulerNotices: this.schedulerNotices,
      localExecutorId: this.#options.authority.executorId,
      clock: this.#clock,
    });
    this.#journals.set(taskId, journal);
    this.#journalLifecycleDisposers.set(
      taskId,
      journal.onLifecycle((event) => {
        void this.#handleJobLifecycle(event).catch((error) => {
          this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      }),
    );
    if (this.#generationBound) {
      this.#statusDisposers.set(
        taskId,
        this.#options.jobStatus.register(taskId, journal),
      );
    }
    return journal;
  }

  #releaseGenerationBindings(): void {
    this.#mutationPublisherDisposer?.();
    this.#mutationPublisherDisposer = undefined;
    for (const dispose of this.#statusDisposers.values()) dispose();
    this.#statusDisposers.clear();
    this.#capabilityReadyDisposer?.();
    this.#capabilityReadyDisposer = undefined;
    this.#schedulerNoticeDisposer?.();
    this.#schedulerNoticeDisposer = undefined;
    this.#generationBound = false;
  }

  async #listTaskIds(): Promise<readonly string[]> {
    const streams = (await this.#options.authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.stream)
      .filter((stream) => stream.startsWith("job:"))
      .map((stream) => stream.slice("job:".length));
    return [...new Set(streams)].sort();
  }
}

function adaptSystemHandlers(
  handlers: ReadonlyMap<string, SystemHandler>,
): ReadonlyMap<import("@zhixing/core/contracts").SystemHandlerId, SystemJobHandler> {
  return new Map(
    [...handlers].map(([id, handler]) => [
      id as import("@zhixing/core/contracts").SystemHandlerId,
      async ({ params }) => {
        const result = await handler(
          params && typeof params === "object" && !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : undefined,
        );
        if (result.status !== "ok") {
          throw new Error(result.summary ?? `System job ${id} failed`);
        }
        return result.summary ? { summary: result.summary } : {};
      },
    ]),
  );
}

function submissionAuthorizer(
  executorByAssignment: ReadonlyMap<string, string>,
  verifier: AnchorSchedulerRuntimeOptions["authority"]["verifier"],
): AssignmentSubmissionAuthorizer {
  const authenticate: AssignmentSubmissionAuthorizer["authenticate"] = (
    context,
    identity,
  ) => {
    if (context.principal.kind !== "assignment") {
      throw new Error("Job submission requires an assignment capability");
    }
    assertPrincipalAllowsAuthorityMethod("assignment", identity.method);
    const capability = validateAuthorityCapability(
      context.principal.capability,
      verifier,
    );
    if (
      capability.assignmentId !== identity.assignmentId ||
      capability.executorId !== executorByAssignment.get(identity.assignmentId) ||
      !capability.methods.includes(identity.method) ||
      Date.parse(context.deadlineAt) > Date.parse(capability.expiry)
    ) {
      throw new Error("Assignment capability does not authorize this job submission");
    }
  };
  return {
    authenticate,
    authorize(context, authorization) {
      authenticate(context, authorization);
    },
  };
}

function schedulerIngressAuthorizer(): JobIngressAuthorizer {
  return {
    authorize(context, action, definition) {
      if (action.startsWith("system-") && context.principal.kind !== "host") {
        throw new Error("Only the anchor host may control system jobs");
      }
      if (
        action.startsWith("user-") &&
        context.principal.kind !== "host" &&
        context.principal.kind !== "surface"
      ) {
        throw new Error("User jobs require an authenticated host or surface");
      }
      if (
        action.startsWith("system-") !==
        (definition.definition.kind === "system")
      ) {
        throw new Error("Job control action does not match the task domain");
      }
    },
  };
}

function jobDispatchContexts(input: {
  readonly signer: AnchorSchedulerRuntimeOptions["authority"]["signer"];
  readonly ownerDeviceId: string;
  readonly pending: PendingJobDispatch;
  readonly controlLease: () => import("@zhixing/core/contracts").ControlLease;
}): InProcessDispatchContextFactory {
  return {
    create(assignmentId, method, request) {
      const controlLease = input.controlLease();
      const scope = controlLease.authority;
      const now = Date.now();
      const issuedAt = new Date(now).toISOString();
      const expiry = controlLease.expiry;
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
        callerDeviceId: input.ownerDeviceId,
        requestId: request.requestId,
        requestDigest,
        controlLease,
        issuedAt,
        expiry,
      };
      const grant: OwnerControlGrant = {
        ...payload,
        signature: input.signer.sign("OwnerControlGrant", 1, payload),
      };
      return {
        principal: { kind: "owner-control", grant },
        requestId: request.requestId,
        deadlineAt: expiry,
      };
    },
  };
}

function resourceContext(
  assignmentId: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "anchor-scheduler" },
    requestId: `resource:${assignmentId}`,
    deadlineAt: new Date(Date.parse(now) + OWNER_CONTEXT_RENEWAL_MS).toISOString(),
  };
}
