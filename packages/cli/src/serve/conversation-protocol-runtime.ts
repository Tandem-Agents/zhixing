import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  normalizeUserTurnInput,
  userMessageFromTurnInput,
  type AgentYield,
  type RunResult,
  type ToolDefinition,
  type ToolSideEffectObserver,
} from "@zhixing/core";
import type {
  AuthorityLogSnapshot,
} from "@zhixing/core/authority";
import type {
  AuthorityCapability,
  AuthorityCallContext,
  CommitEnvelope,
  ControlLease,
  ConversationStatusNotice,
  FinalFrame,
  IngressContext,
  OwnerControlGrant,
  ConversationInvocation,
  AssignmentResourceLease,
  ReservationOrigin,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  assertPrincipalAllowsAuthorityMethod,
  assertAuthorizedOwnerControlGrant,
  MAX_CONTROL_LEASE_TTL_MS,
  canonicalize,
  confirmationDecisionDigest,
  ownerControlRequestDigest,
  protocolDigest,
  StreamDigestChain,
  validateAuthorityCapability,
  type ConversationInteractionOutcome,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type {
  ConfirmationDecision,
  ConfirmationAdmissionDisposition,
  ConfirmationLifecycleObserver,
  ConfirmationRequest,
  ConfirmationResolutionSource,
} from "@zhixing/core";
import {
  ConversationRunJournal,
  InProcessConversationDispatcher,
  ConversationAssignmentAuthority,
  assignmentReservationId,
  channelSurfacePrincipal,
  createConversationControlEnvelope,
  createInitialControlEnvelope,
  type AssignmentSubmissionAuthorizer,
  type ConversationCommitAuthority,
  type ConversationManager,
  type ManagedSession,
  type PendingConversationInput,
  type SessionRuntime,
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
  type InProcessDispatchContextFactory,
} from "@zhixing/owner-kernel";
import { runTurnWithCommit } from "@zhixing/owner-kernel/run-turn";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
  type OwnerControlAuthorizer,
} from "@zhixing/executor";
import type {
  AuthorityRuntimeStack,
  ConversationRuntimeBinding,
} from "../setup-delivery.js";

const CONTEXT_TTL_MS = MAX_CONTROL_LEASE_TTL_MS;
const CONTROL_RENEWAL_INTERVAL_MS = Math.floor(CONTEXT_TTL_MS / 3);

export interface ConversationProtocolRuntimeOptions {
  readonly authority: AuthorityRuntimeStack;
  readonly manager: () => ConversationManager;
  readonly clock?: () => string;
  readonly maxPendingInteractions?: number;
  readonly interactions: DurableConversationInteractionObserver;
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
  /** Idempotently materializes a durable clear/delete fact into legacy storage/runtime views. */
  readonly projectLifecycle?: (
    input: DurableConversationSessionProjectionInput,
  ) => Promise<void>;
  /** Reconciles durable conversation facts with independently persisted auxiliary views. */
  readonly recoverAuxiliary?: (conversationId: string) => Promise<void>;
}

interface DurableInteractionBinding {
  readonly assignmentId: string;
  readonly ledger: ConversationAssignmentLedger;
  readonly submission: InProcessAssignmentSubmission;
  readonly context: AuthorityCallContext;
  readonly surfacePrincipal: string;
  readonly stream: StreamDigestChain;
  readonly streamMeta: { readonly turnOrigin?: NonNullable<IngressContext["turnOrigin"]> };
}

interface AppliedConversationAdmission {
  readonly runId: string;
  readonly ingress: IngressContext;
  readonly replayed: boolean;
}

interface PreparedConversationAdmission {
  readonly conversationId: string;
  readonly surfacePrincipal: string;
  readonly admission: AppliedConversationAdmission;
  readonly input: PendingConversationInput["input"];
  readonly invocation: ConversationInvocation;
}

export class DurableConversationInteractionObserver
  implements ConfirmationLifecycleObserver, ToolSideEffectObserver
{
  readonly #bindings = new AsyncLocalStorage<DurableInteractionBinding>();
  readonly #requests = new Map<string, DurableInteractionBinding>();

  withBinding<T>(
    binding: DurableInteractionBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#bindings.run(binding, operation);
  }

  async beforeRequest(
    request: ConfirmationRequest,
  ): Promise<ConfirmationAdmissionDisposition> {
    const active = this.#requireActive();
    if (this.#requests.has(request.id)) {
      throw new Error(`Confirmation interaction ${request.id} is already bound`);
    }
    const disposition = await active.ledger.requestInteraction(active.assignmentId, {
      requestId: request.id,
      toolName: request.tool,
      display: {
        title: request.display.title,
        lines: [canonicalize(request.display.body)],
      },
      issuedAt: new Date(request.createdAt).toISOString(),
      ttlMs: Math.max(0, request.expiresAt - request.createdAt),
      expiresAt: new Date(request.expiresAt).toISOString(),
    });
    if (!disposition.accepted) {
      const decision = {
        kind: "cancelled" as const,
        cause: "backpressure" as const,
      };
      await active.submission.finishAndMirror(
        active.assignmentId,
        request.id,
        interactionOutcome(
          request,
          decision,
          { kind: "backpressure" },
          active.surfacePrincipal,
        ),
        active.context,
      );
      return { accepted: false, decision };
    }
    active.stream.append(
      {
        kind: "interaction",
        event: {
          t: "requested",
          requestId: request.id,
          toolName: request.tool,
          display: disposition.display,
          issuedAt: new Date(request.createdAt).toISOString(),
          ttlMs: Math.max(0, request.expiresAt - request.createdAt),
          expiresAt: new Date(request.expiresAt).toISOString(),
        },
      },
      active.streamMeta,
    );
    this.#requests.set(request.id, active);
    return { accepted: true };
  }

  async afterResolved(
    request: ConfirmationRequest,
    decision: ConfirmationDecision,
    source: ConfirmationResolutionSource,
  ): Promise<void> {
    const active = this.#requests.get(request.id);
    if (!active) {
      throw new Error(`Confirmation interaction ${request.id} has no durable binding`);
    }
    await active.submission.finishAndMirror(
      active.assignmentId,
      request.id,
      interactionOutcome(request, decision, source, active.surfacePrincipal),
      active.context,
    );
    active.stream.append(
      {
        kind: "interaction",
        event: {
          t: "finished",
          requestId: request.id,
          outcome: streamInteractionOutcome(decision),
        },
      },
      active.streamMeta,
    );
    this.#requests.delete(request.id);
  }

  releaseAssignment(assignmentId: string): void {
    for (const [requestId, binding] of this.#requests) {
      if (binding.assignmentId === assignmentId) this.#requests.delete(requestId);
    }
  }

  async start(
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const active = this.#requireActive();
    const external = tool.boundaries?.some((boundary) =>
      boundary.boundaryType === "external-service" ||
      boundary.boundaryType === "messaging" ||
      boundary.boundaryType === "calendar" ||
      boundary.boundaryType === "financial"
    ) ?? false;
    const started = await active.ledger.startSideEffect(active.assignmentId, {
      kind: external ? "external-call" : "tool-mutation",
      toolName: tool.name,
      summary: `${tool.name}(${Object.keys(input).sort().join(",")})`,
      target: external
        ? "external-service"
        : tool.name === "Write" || tool.name === "Edit"
          ? "workspace-file"
          : "device-system",
    });
    return {
      binding: active,
      effectSeq: started.effectSeq,
    };
  }

  async finish(
    token: unknown,
    result: { readonly status: "ok" | "failed" | "aborted" },
  ): Promise<void> {
    if (!token || typeof token !== "object" || Array.isArray(token)) {
      throw new TypeError("Side-effect observer token is invalid");
    }
    const value = token as { binding?: DurableInteractionBinding; effectSeq?: number };
    if (!value.binding || !Number.isSafeInteger(value.effectSeq)) {
      throw new TypeError("Side-effect observer token is incomplete");
    }
    await value.binding.ledger.completeSideEffect(
      value.binding.assignmentId,
      value.effectSeq!,
      result,
    );
  }

  #requireActive(): DurableInteractionBinding {
    const active = this.#bindings.getStore();
    if (!active) {
      throw new Error("Confirmation interaction has no active durable assignment");
    }
    return active;
  }
}

/** Single-process production composition for the durable conversation protocol. */
export class ConversationProtocolRuntime implements DurableConversationTurnExecutor {
  readonly #authority: AuthorityRuntimeStack;
  readonly #manager: () => ConversationManager;
  readonly #clock: () => string;
  readonly #ledger: ConversationAssignmentLedger;
  readonly #issuer: ConversationAssignmentAuthority;
  readonly #journals = new Map<string, ConversationRunJournal>();
  readonly #assignmentConversations = new Map<string, string>();
  readonly #assignmentCapabilities = new Map<
    string,
    AuthorityCapability<"conversation">
  >();
  readonly #assignmentRuntimeBindings = new Map<string, ConversationRuntimeBinding>();
  readonly #schedulingRuns = new Set<string>();
  readonly #scheduledRuns = new Set<string>();
  readonly #preparedAdmissions = new Map<string, PreparedConversationAdmission>();
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #executeRecoveredPerspective:
    | ConversationProtocolRuntimeOptions["executeRecoveredPerspective"]
    | undefined;
  readonly #onStatus: ((notice: ConversationStatusNotice) => void | Promise<void>) | undefined;
  readonly #onFinal: ((frame: FinalFrame) => void | Promise<void>) | undefined;
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
  #recoveryGeneration = 0;
  readonly #recoveryConversations = new Map<string, number>();

  constructor(options: ConversationProtocolRuntimeOptions) {
    this.#authority = options.authority;
    this.#manager = options.manager;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#interactions = options.interactions;
    this.#executeRecoveredPerspective = options.executeRecoveredPerspective;
    this.#onStatus = options.onStatus;
    this.#onFinal = options.onFinal;
    this.#projectLifecycle = options.projectLifecycle;
    this.#recoverAuxiliary = options.recoverAuxiliary;
    const ownerControl = createOwnerControlAuthorizer(
      options.authority.deviceId,
      options.authority.verifier,
      this.#clock,
    );
    this.#ledger = new ConversationAssignmentLedger({
      log: options.authority.executorLog,
      artifacts: options.authority.artifacts,
      executorId: options.authority.executorId,
      signer: options.authority.signer,
      verifier: options.authority.verifier,
      ownerControl,
      resources: options.authority.executorResourceGovernor,
      usageFinal: (assignmentId) =>
        options.authority.executorResourceGovernor.flushAssignment(
          assignmentId,
          options.authority.resourceGovernor,
          (report) =>
            usageReporterContext(report.reporterId, report.digest, this.#clock()),
        ),
      snapshotFor: (executorId) =>
        options.authority.executorCapabilities.snapshotFor(executorId),
      permissionSnapshotFor: options.authority.permissionSnapshotFor,
      runtimeBindingGuard: ({ assignmentId, manifest }) => {
        const binding = this.#assignmentRuntimeBindings.get(assignmentId);
        if (binding === undefined) {
          return {
            code: "capability-gap",
            message: "Assembled runtime binding is unavailable",
            retryable: true,
          };
        }
        return options.authority.validateConversationRuntimeBinding({
          manifest,
          binding,
        });
      },
      clock: this.#clock,
      ...(options.maxPendingInteractions === undefined
        ? {}
        : { maxPendingInteractions: options.maxPendingInteractions }),
    });
    this.#issuer = new ConversationAssignmentAuthority({
      signer: options.authority.signer,
      verifier: options.authority.verifier,
      snapshotFor: (executorId) =>
        options.authority.executorCapabilities.snapshotFor(executorId),
      clock: this.#clock,
    });
    this.#contexts = createDispatchContexts({
      signer: options.authority.signer,
      deviceId: options.authority.deviceId,
      ownerEpoch: options.authority.anchorEpoch,
      clock: this.#clock,
      conversationIdFor: (assignmentId) =>
        this.#conversationForAssignment(assignmentId),
    });
  }

  bindDeliveryDrain(drain: () => Promise<void>): void {
    this.#deliveryDrain = drain;
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
  }

  async admit(
    input: DurableConversationAdmissionInput,
  ): Promise<DurableConversationAdmissionResult> {
    const key = admissionKey(input);
    if (!key) {
      throw new Error("Durable conversation admission requires a stable turn id");
    }
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
        invocation: input.invocation,
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
    try {
      await this.#journal(conversationId).cancelRun(request);
      this.#clearRunClaims(runId);
      this.#markRecovery(conversationId);
      this.#kickDelivery();
    } catch (firstError) {
      this.#markRecovery(conversationId);
      try {
        await this.#journal(conversationId).cancelRun(request);
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

  async cancel(
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
          ownerEpoch: this.#authority.anchorEpoch,
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
          ownerEpoch: this.#authority.anchorEpoch,
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
    const existing = await journal.lifecycleRequest(input.requestId);
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
          ownerEpoch: this.#authority.anchorEpoch,
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
    this.#markRecovery(input.conversationId);
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
        canonicalize(prepared.invocation) !== canonicalize(input.invocation))
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
      const preparedAuthority = await this.#authority.prepareConversationAssignment({
        executionProfile,
        permissionRules,
      });
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
        executorId: this.#authority.executorId,
        workload: { kind: "run", id: runId, attempt },
        scopeBinding: {
          kind: "conversation",
          conversationId: input.conversationId,
          ownerEpoch: this.#authority.anchorEpoch,
        },
        budget: preparedAuthority.policy.budget,
        }, origin, resourceContext);
      const unsigned = this.#issuer.issue({
        runId,
        assignmentId,
        executorId: this.#authority.executorId,
        conversationId: input.conversationId,
        ownerEpoch: this.#authority.anchorEpoch,
        baseRevision: authority.commitRevision,
        attempt,
        resourceLease,
        ingress: executionIngress,
        windowInput: {
          t: "full",
          windowEpoch: authority.commitRevision + 1,
          messages: [...input.messages],
        },
        policy: preparedAuthority.policy,
      });
      const dispatch = await journal.assign(unsigned);
      this.#rememberAssignment(dispatch.envelope);
      this.#assignmentRuntimeBindings.set(
        assignmentId,
        preparedAuthority.binding,
      );
      const submission = new InProcessAssignmentSubmission({
        ledger: this.#ledger,
        owner: journal,
      });
      const submissionContext = assignmentContext(dispatch.envelope);
      const resourceSubmissionContext = assignmentResourceContext(dispatch.envelope);
      const flushResourceUsage = () =>
        this.#authority.executorResourceGovernor.flushAssignment(
          assignmentId,
          this.#authority.resourceGovernor,
          (report) => usageReporterContext(report.reporterId, report.digest, this.#clock()),
        );
      const dispatcher = new InProcessConversationDispatcher({
        enabled: true,
        journal,
        executor: this.#ledger,
        contexts: this.#contexts,
        cancellationSubmission: {
          submitCancellation: (id) =>
            submission.submitCancellation(
              id,
              assignmentContext(dispatch.envelope),
            ),
        },
        bundleSubmission: {
          submitSealedBundle: (id) =>
            submission.submitSealedBundle(
              id,
              assignmentContext(dispatch.envelope),
            ),
        },
      });
      const dispatchResults = await (async () => {
        try {
          return await dispatcher.dispatchPending();
        } finally {
          this.#assignmentRuntimeBindings.delete(assignmentId);
        }
      })();
      if (dispatchResults.length !== 1 || !dispatchResults[0]!.accepted) {
        const rejection = dispatchResults[0];
        throw new Error(
          rejection && !rejection.accepted
            ? `Local executor rejected a freshly issued assignment: ${rejection.error.message}`
            : "Local executor did not return exactly one dispatch result",
        );
      }
      await submission.startAndReport(assignmentId, submissionContext);

      const stream = new StreamDigestChain(assignmentId);
      const streamMeta = executionIngress.turnOrigin
        ? { turnOrigin: executionIngress.turnOrigin }
        : {};
      let toolCalls = 0;
      const interactionBinding: DurableInteractionBinding = {
        assignmentId,
        ledger: this.#ledger,
        submission,
        context: submissionContext,
        surfacePrincipal: executionIngress.surfacePrincipal,
        stream,
        streamMeta,
      };
      const controlHeartbeat = this.#startControlHeartbeat(assignmentId);
      let runResult: RunResult;
      try {
        const generator = input.runtime.run(input.messages, {
          ...input.options,
          onProtocolEvent: (event, meta) => {
            stream.append(
              { kind: "agent-event", event },
              {
                ...streamMeta,
                ...(meta.lineage ? { lineage: meta.lineage } : {}),
              },
            );
          },
          toolSideEffectObserver: this.#interactions,
          authorizeToolExecution: () =>
            this.#ledger.authorizeToolExecution(
              assignmentId,
              dispatch.envelope.permissionLease,
            ),
          modelCallResourceMeter: {
            reserve: async ({ callIndex, tokenUpperBound }) => {
              const usageId = `usage:${assignmentId}:model:${callIndex}`;
              await this.#authority.executorResourceGovernor.reserveUsage(
                dispatch.envelope.resourceLease,
                { usageId, tokens: tokenUpperBound, calls: 1 },
                resourceSubmissionContext,
              );
              return { usageId };
            },
            consume: async ({ usageId, tokens }) => {
              await this.#authority.executorResourceGovernor.consume(
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
          stream.append({ kind: "agent-yield", yield: item.value }, streamMeta);
          yield item.value;
        }
      } catch (error) {
        await controlHeartbeat.stop();
        try {
          const usageFinal = await flushResourceUsage();
          if (await this.#ledger.hasOpenSideEffects(assignmentId)) {
            await journal.markAssignmentUncertain(assignmentId, "ledger-unknown");
          } else {
            await submission.prepareForRunEnd(assignmentId, submissionContext);
            const failure = await this.#ledger.failExecution(assignmentId, {
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
          }
          this.#kickDelivery();
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
        const usageFinal = await flushResourceUsage();
        if (await this.#ledger.hasOpenSideEffects(assignmentId)) {
          await journal.markAssignmentUncertain(assignmentId, "ledger-unknown");
        } else {
          await submission.prepareForRunEnd(assignmentId, submissionContext);
          const failure = await this.#ledger.failExecution(assignmentId, {
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
        }
        this.#kickDelivery(input.hooks?.onFinalPublishFailure, runResult);
        return runResult;
      }

      await submission.prepareForRunEnd(assignmentId, submissionContext);
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
      await this.#ledger.sealConversationBundle(assignmentId, {
        runRecord: transcriptRun,
        ...(runResult.windowCompact
          ? { windowCompact: runResult.windowCompact }
          : {}),
        contentAssets: [],
        streamFinal: stream.final(),
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
      this.#markRecovery(input.conversationId);
      this.#kickDelivery(input.hooks?.onFinalPublishFailure, runResult);
      return runResult;
    } catch (error) {
      this.#markRecovery(input.conversationId);
      throw error;
    } finally {
      this.#clearRunClaims(runId);
      this.#forgetAssignment(assignmentId);
    }
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
        canonicalize(durablePending.invocation) !== canonicalize(input.invocation)
      ) {
        throw new Error("Conversation ingress is already bound to another invocation");
      }
      return {
        runId: durablePending.runId,
        ingress: durablePending.ingress,
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
    const control = {
      admission: this.#authority.controlAdmission,
      envelope: createInitialControlEnvelope({
        requestId,
        source,
        at,
        body: {
          t: "input",
          conversationId: input.conversationId,
          ingress: { ingressId: ingress.ingressId, source: ingress.kind },
          input: normalizeUserTurnInput(input.input),
          invocation: input.invocation,
          ownerEpoch: this.#authority.anchorEpoch,
        },
      }),
      source,
      runId: `run:${randomUUID()}`,
    } as const;
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
        throw new AggregateError(
          [firstError, replayError],
          "Conversation input admission could not determine its durable disposition",
        );
      }
    }
    if (admission.kind === "rejected") {
      throw new Error(`Conversation input was rejected: ${admission.result.error.message}`);
    }
    if (admission.result.status === "rejected") {
      throw new Error(`Conversation input was rejected: ${admission.result.error.message}`);
    }
    if (admission.result.body.t !== "input") {
      throw new Error("Conversation input admission returned another control result");
    }
    let durableIngress = ingress;
    const admittedRunId = admission.result.body.runId;
    if (admission.kind === "replayed") {
      const pending = (await journal.pendingInputs()).find(
        (candidate) => candidate.runId === admittedRunId,
      );
      if (pending) durableIngress = pending.ingress;
    }
    return {
      runId: admittedRunId,
      ingress: durableIngress,
      replayed: admission.kind === "replayed",
    };
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
    recovered += await this.#authority.executorResourceGovernor.reclaimExpired();
    const recoverConversation = async (conversationId: string): Promise<number> =>
      this.#withRecoveryClaim(conversationId, async () => {
        let count = 0;
        const journal = this.#journal(conversationId);
        count += await this.#resumeLifecycleProjections(conversationId, journal);
        const authority = await journal.authorityState();
        if (authority.deleted && authority.pendingLifecycleProjections === 0) {
          this.#retireConversation(conversationId);
          return 0;
        }
        for (const candidate of await journal.assignmentsAwaitingRecovery()) {
          this.#rememberAssignment(candidate.dispatch.envelope);
        }
        for (const candidate of await journal.pendingDispatches()) {
          this.#rememberAssignment(candidate.envelope);
        }
        const submission = new InProcessAssignmentSubmission({
          ledger: this.#ledger,
          owner: journal,
        });
        const dispatcher = new InProcessConversationDispatcher({
          enabled: true,
          journal,
          executor: this.#ledger,
          contexts: this.#contexts,
          cancellationSubmission: {
            submitCancellation: (assignmentId) =>
              submission.submitCancellation(
                assignmentId,
                this.#submissionContext(assignmentId),
              ),
          },
          bundleSubmission: {
            submitSealedBundle: (assignmentId) =>
              submission.submitSealedBundle(
                assignmentId,
                this.#submissionContext(assignmentId),
              ),
          },
        });
        if (this.#recoveryStopped) return count;
        count += await journal.resumeCommittedProjections();
        if (this.#recoveryStopped) return count;
        count += await journal.resumePendingPublishing();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.dispatchPending().then((items) => items.length);
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverAssignments();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverCancellations();
        if (this.#recoveryStopped) return count;
        count += await dispatcher.recoverSupersedes();
        if (this.#recoveryStopped) return count;
        count += await this.#reconcileAbandonedLocalAssignments(
          journal,
          dispatcher,
        );
        if (this.#recoveryStopped) return count;
        count += await this.#resumeQueuedInputs(conversationId, journal);
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

  async publishPendingFinals(conversationId: string): Promise<number> {
    try {
      const journal = this.#journal(conversationId);
      await journal.resumeCommittedProjections();
      if (!this.#onFinal) return 0;
      return await journal.publishPendingFinals(async (frame) => {
        await this.#onFinal?.(frame);
      });
    } catch (error) {
      this.#markRecovery(conversationId);
      throw error;
    }
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
            if (page.nextAfterStatusRevision !== undefined) {
              next.push({
                conversationId,
                runId: cursor.runId,
                afterStatusRevision: page.nextAfterStatusRevision,
              });
            }
          }
        }
      }),
    );
    return { notices: notices.flat(), next };
  }

  #journal(conversationId: string): ConversationRunJournal {
    const existing = this.#journals.get(conversationId);
    if (existing) return existing;
    const journal = this.#createJournal(conversationId);
    this.#journals.set(conversationId, journal);
    return journal;
  }

  #journalForQuery(conversationId: string): ConversationRunJournal {
    return this.#journals.get(conversationId) ?? this.#createJournal(conversationId);
  }

  #createJournal(conversationId: string): ConversationRunJournal {
    const journal = new ConversationRunJournal({
      conversationId,
      ownerEpoch: this.#authority.anchorEpoch,
      log: this.#authority.authorityLog,
      artifacts: this.#authority.artifacts,
      signer: this.#authority.signer,
      verifier: this.#authority.verifier,
      submission: createSubmissionAuthorizer(
        this.#authority.executorId,
        this.#authority.verifier,
      ),
      authority: this.#commitAuthority(conversationId),
      projection: {
        project: (projection) => this.#manager().project(projection),
      },
      delivery: this.#authority.participant,
      resources: this.#authority.resourceGovernor,
      clock: this.#clock,
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
          decision.ownerEpoch !== this.#authority.anchorEpoch ||
          decision.sessionMutations.length > 0
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

  #startControlHeartbeat(assignmentId: string): {
    stop(): Promise<void>;
  } {
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = this.#ledger
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

  async #reconcileAbandonedLocalAssignments(
    journal: ConversationRunJournal,
    dispatcher: InProcessConversationDispatcher,
  ): Promise<number> {
    let reconciled = 0;
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      this.#rememberAssignment(candidate.dispatch.envelope);
      const snapshot = journal.validateExecutorLedgerSnapshot(
        await this.#ledger.queryLedger(
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
      const runtime: SessionRuntime = {
        sessionId: `recovered-perspectives:${conversationId}`,
        async *run(_messages, runtimeOptions): AsyncGenerator<AgentYield, RunResult> {
          // 恢复执行同样独占该 assignment 的计量序列——与正常 durable 路径同构
          const meter = runtimeOptions?.modelCallResourceMeter;
          let callIndex = 0;
          return await execute({
            manager,
            managed,
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
        abort: (reason) => managed.runtime.abort(reason),
        async dispose() {},
        securitySnapshot: () => requireRuntimeSecuritySnapshot(managed.runtime),
        executionPermissionRules: () =>
          requireRuntimeExecutionPermissionRules(managed.runtime),
        executionProfile: () => requireRuntimeExecutionProfile(managed.runtime),
      };
      const generator = this.run({
        conversationId,
        input: pending.input,
        messages: [
          ...managed.window.getMessages(),
          userMessageFromTurnInput(pending.input),
        ],
        baseRevision: managed.turnCount,
        runtime,
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
        { ...options, turnIndex: managed.turnCount },
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
    const conversationIds = discoverRecoveryConversations(snapshot.commits);
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
  ): void {
    const capability = envelope.capabilities[0];
    if (!capability) throw new Error("Conversation assignment has no submission capability");
    this.#assignmentConversations.set(
      envelope.assignmentId,
      envelope.work.conversationId,
    );
    this.#assignmentCapabilities.set(envelope.assignmentId, capability);
  }

  #forgetAssignment(assignmentId: string): void {
    this.#assignmentConversations.delete(assignmentId);
    this.#assignmentCapabilities.delete(assignmentId);
    this.#interactions.releaseAssignment(assignmentId);
  }
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
  executorId: string,
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
      capability.executorId !== executorId ||
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

function createOwnerControlAuthorizer(
  deviceId: string,
  verifier: ProtocolSignatureVerifier,
  clock: () => string,
): OwnerControlAuthorizer {
  return {
    authorize(context, request) {
      if (context.principal.kind !== "owner-control") {
        throw new Error("Executor control requires an owner grant");
      }
      const authority = request.authority ?? context.principal.grant.scope;
      const requestDigest = ownerControlRequestDigest({
        method: request.method,
        assignmentId: request.assignmentId,
        authority,
        requestId: request.requestId,
        body: request.body,
      });
      const grant = assertAuthorizedOwnerControlGrant({
        grant: context.principal.grant,
        verifier,
        method: request.method,
        assignmentId: request.assignmentId,
        callerDeviceId: deviceId,
        authenticatedCallerDeviceId: deviceId,
        ...(request.expectedOwnerDeviceId === undefined
          ? {}
          : { expectedOwnerDeviceId: request.expectedOwnerDeviceId }),
        requestId: request.requestId,
        requestDigest,
        now: clock(),
        deadlineAt: context.deadlineAt,
        authority,
      });
      return {
        authority: structuredClone(grant.scope),
        ownerDeviceId: grant.callerDeviceId,
        controlLease: structuredClone(grant.controlLease),
      };
    },
  };
}

function createDispatchContexts(options: {
  readonly signer: ProtocolSigner;
  readonly deviceId: string;
  readonly ownerEpoch: number;
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
        ownerEpoch: options.ownerEpoch,
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

function interactionOutcome(
  request: ConfirmationRequest,
  decision: ConfirmationDecision,
  source: ConfirmationResolutionSource,
  surfacePrincipal: string,
): ConversationInteractionOutcome {
  if (source.kind === "expired" || decision.kind === "expired") {
    return { t: "expired" };
  }
  if (source.kind === "non-interactive") {
    if (decision.kind !== "deny") {
      throw new Error("Non-interactive durable confirmations must fail closed");
    }
    return {
      t: "auto-resolved",
      decision: "denied",
      reason: "no-interactive-surface",
    };
  }
  if (source.kind === "backpressure" || source.kind === "cancel") {
    return {
      t: "cancelled",
      via: source.kind === "backpressure" ? "backpressure" : "run-end",
    };
  }
  if (source.kind !== "surface") {
    throw new Error("Confirmation resolution source is invalid");
  }
  const allowed =
    decision.kind === "allow-once" ||
    decision.kind === "allow-session" ||
    decision.kind === "allow-context" ||
    decision.kind === "allow-global" ||
    decision.kind === "edit-then-allow";
  const reason = decision.kind === "deny"
    ? decision.reason
    : "note" in decision
      ? decision.note
      : undefined;
  return {
    t: "answered",
    authority: {
      via: "surface-ticket",
      ticketId: `ticket:${request.id}`,
    },
    decision: { allowed, ...(reason ? { reason } : {}) },
    decisionDigest: confirmationDecisionDigest(request.id, decision),
    by: surfacePrincipal,
  };
}

function streamInteractionOutcome(
  decision: ConfirmationDecision,
): "allowed" | "denied" | "cancelled" | "expired" {
  if (decision.kind === "expired") return "expired";
  if (decision.kind === "cancelled") return "cancelled";
  if (decision.kind === "deny") return "denied";
  return "allowed";
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
