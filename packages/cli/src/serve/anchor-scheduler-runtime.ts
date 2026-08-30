import type {
  IEventBus,
  SchedulerEventMap,
  SystemHandler,
} from "@zhixing/core";
import type { ScheduleLifecycleMechanismPort } from "@zhixing/core/scheduler/application";
import type {
  AuthorityCallContext,
  AuthorityCapability,
  DataPlaneTicket,
  ExecutionRef,
  JobOccurrence,
  JobExecutionInstruction,
  OwnerControlGrant,
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
 * Product composition for the anchor-owned scheduler and job authority.
 *
 * All execution and projection state comes from the assignment journal,
 * executor job owner and durable submission protocol.
 */
export class AnchorSchedulerRuntime implements ScheduleLifecycleMechanismPort {
  readonly anchorEpoch: number;
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
  readonly #schedulerNoticeDisposer: () => void;
  readonly #capabilityReadyDisposer: () => void;
  readonly #dispatchers = new Map<string, InProcessJobDispatcher>();
  readonly #manualSurfaces: ManualJobSurfaceLifecycle;
  readonly #retirementTasks = new Map<string, Promise<void>>();
  readonly #clock: () => string;

  private constructor(options: AnchorSchedulerRuntimeOptions) {
    this.#options = options;
    this.anchorEpoch = options.authority.anchorEpoch;
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
    this.#schedulerNoticeDisposer = options.jobStatus.registerScheduler(
      this.schedulerNotices,
    );
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
    this.#capabilityReadyDisposer = options.authority.executorCapabilities.onAccepted(
      () => this.#scheduler.wakeQueuedUserJobs(),
    );
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
    options.protocol.bindMutationPublisher(
      new SchedulerConversationMutationPublisher({
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
      }),
    );
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
      this.anchorEpoch,
    );
    return Object.freeze({
      globalState,
      product: new AnchorSchedulerProductPort(
        this.#scheduler,
        globalState,
        this.anchorEpoch,
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
    this.#capabilityReadyDisposer();
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
    this.#schedulerNoticeDisposer();
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
    const dispatcher = new InProcessJobDispatcher({
      enabled: true,
      journal,
      executor: local
        ? this.#options.protocol.executorLedger()
        : this.#requiredMesh().jobExecutorFor(
            pending.envelope.executorId,
            (assignmentId) => this.#artifactAuthority(assignmentId),
          ),
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
    this.#statusDisposers.set(
      taskId,
      this.#options.jobStatus.register(taskId, journal),
    );
    return journal;
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
