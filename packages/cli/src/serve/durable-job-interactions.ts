import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ConfirmationAdmissionDisposition,
  ConfirmationDecision,
  IConfirmationBroker,
  ConfirmationLifecycleObserver,
  ConfirmationRequest,
  ConfirmationResolutionSource,
  ToolDefinition,
  ToolSideEffectObserver,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  ChannelInteractionGrant,
  IngressContext,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  channelInteractionConfirmationDecision,
  confirmationDecisionDigest,
  type AssignmentInteractionOutcome,
  type StreamFrameAppender,
} from "@zhixing/core/protocol";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import {
  AssignmentInteractionProjector,
  finishAssignmentSideEffect,
  startAssignmentSideEffect,
} from "./assignment-interaction-projection.js";
import {
  ConversationInteractionRuntimeUnavailableError,
  type ConversationInteractionAnswerPort,
} from "./durable-conversation-interactions.js";

/**
 * job 交互的耐久承载,独立于 conversation observer:job 只有渠道
 * grant 与无合法应答者两条答复路径,没有 surface ticket 语义。两域仅
 * 共享底层耐久 interaction、mirror 与 stream 投影原语。
 */

export interface DurableJobInteractionBinding {
  readonly assignmentId: string;
  readonly ledger: ConversationAssignmentLedger;
  readonly submission: InProcessAssignmentSubmission;
  readonly context: AuthorityCallContext;
  broker?: IConfirmationBroker;
  readonly stream: StreamFrameAppender;
  readonly streamMeta: {
    readonly turnOrigin?: NonNullable<IngressContext["turnOrigin"]>;
  };
  /** 只取消投影义务的 owner,不取消被投影的运行本身。 */
  readonly signal?: AbortSignal;
}

export class JobInteractionRuntimeUnavailableError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobInteractionRuntimeUnavailableError";
  }
}

/**
 * executor-owned 的 job 交互答复端口:owner relay 的 grant/无应答转交
 * 半边由它承接——进程内直连本实现,跨机经 mesh client/handler 到达
 * 同一实现。禁止 owner 或测试绕过端口直接操作 executor 账本。
 */
export interface JobInteractionGrantPort {
  deliverGrant(grant: ChannelInteractionGrant): Promise<void>;
  resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void>;
}

export interface JobInteractionAnswerPort extends JobInteractionGrantPort {
  answerInteractionWithTicket(
    input: Parameters<
      ConversationInteractionAnswerPort["answerInteractionWithTicket"]
    >[0],
  ): Promise<void>;
}

/** Binds job confirmations and side effects to the executor ledger that owns the run. */
export class DurableJobInteractionCoordinator
  implements
    ToolSideEffectObserver,
    JobInteractionAnswerPort
{
  readonly #bindings = new AsyncLocalStorage<DurableJobInteractionBinding>();
  readonly #requests = new Map<string, DurableJobInteractionBinding>();
  readonly #projector = new AssignmentInteractionProjector();
  readonly #channelAnswers = new Map<
    string,
    {
      readonly grant: ChannelInteractionGrant;
      readonly outcome: Extract<
        AssignmentInteractionOutcome,
        { readonly t: "answered" }
      >;
    }
  >();
  readonly #surfaceAnswers = new Map<
    string,
    {
      readonly ticketId: string;
      readonly surfacePrincipal: string;
      readonly decision: Extract<
        ConfirmationDecision,
        { readonly kind: "allow-once" | "deny" }
      >;
    }
  >();

  constructor(private readonly ledger: ConversationAssignmentLedger) {}

  lifecycleObserverFor(
    binding: DurableJobInteractionBinding,
  ): ConfirmationLifecycleObserver {
    return {
      beforeRequest: (request) => this.#beforeRequest(binding, request),
      afterResolved: (request, decision, source) =>
        this.#afterResolved(binding, request, decision, source),
    };
  }

  withBinding<T>(
    binding: DurableJobInteractionBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#bindings.run(binding, operation);
  }

  async #beforeRequest(
    active: DurableJobInteractionBinding,
    request: ConfirmationRequest,
  ): Promise<ConfirmationAdmissionDisposition> {
    const key = interactionKey(active.assignmentId, request.id);
    if (this.#requests.has(key)) {
      throw new Error(`Job interaction ${request.id} is already bound`);
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
        jobInteractionOutcome(request.id, decision, { kind: "backpressure" }),
        active.context,
      );
      await this.drainAssignment(active);
      return { accepted: false, decision };
    }
    await this.drainAssignment(active);
    this.#requests.set(key, active);
    return { accepted: true };
  }

  async #afterResolved(
    expected: DurableJobInteractionBinding,
    request: ConfirmationRequest,
    decision: ConfirmationDecision,
    source: ConfirmationResolutionSource,
  ): Promise<void> {
    const key = interactionKey(expected.assignmentId, request.id);
    const active = this.#requests.get(key);
    if (active !== expected) {
      throw new Error(`Job interaction ${request.id} has no durable binding`);
    }
    await active.submission.finishAndMirror(
      active.assignmentId,
      request.id,
      jobInteractionOutcome(
        request.id,
        decision,
        source,
        this.#channelAnswers.get(key),
        this.#surfaceAnswers.get(key),
      ),
      active.context,
    );
    await this.drainAssignment(active);
    this.#requests.delete(key);
    this.#channelAnswers.delete(key);
    this.#surfaceAnswers.delete(key);
  }

  async answerInteractionWithTicket(
    input: Parameters<
      ConversationInteractionAnswerPort["answerInteractionWithTicket"]
    >[0],
  ): Promise<void> {
    const prepared =
      await this.ledger.prepareInteractionAnswerFromSurface(input);
    if (prepared.kind === "replayed") {
      await this.#drainActiveBinding(input);
      return;
    }
    const key = interactionKey(input.assignmentId, input.requestId);
    const binding = this.#runtimeBinding(input);
    const broker = binding.broker;
    if (!broker?.resolveDurably) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Job interaction answer has no active durable executor runtime",
      );
    }
    const answer = {
      ticketId: prepared.ticketId,
      surfacePrincipal: prepared.surfacePrincipal,
      decision: prepared.decision,
    };
    const existing = this.#surfaceAnswers.get(key);
    if (existing && canonicalize(existing) !== canonicalize(answer)) {
      throw new Error("Job interaction already has a different surface answer");
    }
    this.#surfaceAnswers.set(key, answer);
    const resolved = await broker.resolveDurably(
      input.requestId,
      prepared.decision,
    );
    if (!resolved) {
      this.#surfaceAnswers.delete(key);
      throw new ConversationInteractionRuntimeUnavailableError(
        "Job interaction request is not yet restored in the executor runtime",
      );
    }
    const replay = await this.ledger.prepareInteractionAnswerFromSurface(input);
    if (replay.kind !== "replayed") {
      throw new Error(
        "Job surface answer did not reach a durable terminal result",
      );
    }
  }

  /**
   * 渠道 grant 的 executor 消费:账本先鉴权并给出规范终态,broker 恢复
   * 运行,再以回放复查确认终态已耐久。重复投递由账本回放吸收。
   */
  async deliverGrant(grant: ChannelInteractionGrant): Promise<void> {
    const prepared = await this.ledger.prepareInteractionAnswerFromChannel({
      assignmentId: grant.assignmentId,
      requestId: grant.interactionRequestId,
      grant,
    });
    if (prepared.kind === "replayed") {
      await this.#drainActiveBinding({
        assignmentId: grant.assignmentId,
        requestId: grant.interactionRequestId,
      });
      return;
    }
    const key = interactionKey(
      grant.assignmentId,
      grant.interactionRequestId,
    );
    const binding = this.#runtimeBinding({
      assignmentId: grant.assignmentId,
      requestId: grant.interactionRequestId,
    });
    const broker = binding.broker;
    if (!broker) {
      throw new JobInteractionRuntimeUnavailableError(
        "Job grant has no active executor confirmation runtime",
      );
    }
    const existing = this.#channelAnswers.get(key);
    if (existing) {
      if (canonicalize(existing.grant) !== canonicalize(prepared.grant)) {
        throw new Error("Job interaction already has a different channel grant");
      }
    } else {
      this.#channelAnswers.set(key, {
        grant: prepared.grant,
        outcome: prepared.outcome,
      });
    }
    if (!broker.resolveDurably) {
      throw new Error("Job confirmation broker lacks durable resolution");
    }
    const resolved = await broker.resolveDurably(
      grant.interactionRequestId,
      channelInteractionConfirmationDecision(prepared.grant.decision),
    );
    if (!resolved) {
      if (
        this.#channelAnswers.get(key)?.grant ===
        prepared.grant
      ) {
        this.#channelAnswers.delete(key);
        this.#surfaceAnswers.delete(key);
      }
      throw new JobInteractionRuntimeUnavailableError(
        "Job interaction request is not yet restored in the executor runtime",
      );
    }
    const replay = await this.ledger.prepareInteractionAnswerFromChannel({
      assignmentId: grant.assignmentId,
      requestId: grant.interactionRequestId,
      grant,
    });
    if (replay.kind !== "replayed") {
      throw new Error("Job grant did not reach a durable terminal result");
    }
  }

  async resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    if (
      (await this.ledger.jobInteractionOutcome(
        input.assignmentId,
        input.requestId,
      )) !== undefined
    ) {
      await this.#drainActiveBinding(input);
      return;
    }
    const binding = this.#runtimeBinding(input);
    const resolve = binding.broker?.resolveNonInteractiveDurably;
    if (!resolve) {
      throw new JobInteractionRuntimeUnavailableError(
        "Job interaction has no active durable fail-closed runtime",
      );
    }
    const resolved = await resolve.call(binding.broker, input.requestId);
    if (!resolved) {
      if (
        (await this.ledger.jobInteractionOutcome(
          input.assignmentId,
          input.requestId,
        )) !== undefined
      ) {
        return;
      }
      throw new JobInteractionRuntimeUnavailableError(
        "Job interaction request is not yet restored in the executor runtime",
      );
    }
  }

  async drainAssignment(binding: DurableJobInteractionBinding): Promise<void> {
    await this.#projector.drainAssignment(binding);
  }

  releaseAssignment(assignmentId: string): void {
    for (const [key, binding] of this.#requests) {
      if (binding.assignmentId === assignmentId) {
        this.#requests.delete(key);
        this.#channelAnswers.delete(key);
      }
    }
    this.#projector.release(assignmentId);
  }

  async #drainActiveBinding(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    const binding = this.#requests.get(
      interactionKey(input.assignmentId, input.requestId),
    );
    if (binding) await this.drainAssignment(binding);
  }

  #runtimeBinding(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): DurableJobInteractionBinding {
    const binding = this.#requests.get(
      interactionKey(input.assignmentId, input.requestId),
    );
    if (!binding) {
      throw new JobInteractionRuntimeUnavailableError(
        "Job interaction request is not yet restored in the executor runtime",
      );
    }
    return binding;
  }

  async start(
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return startAssignmentSideEffect(this.#requireActive(), tool, input);
  }

  async finish(
    token: unknown,
    result: { readonly status: "ok" | "failed" | "aborted" },
  ): Promise<void> {
    await finishAssignmentSideEffect(token, result);
  }

  #requireActive(): DurableJobInteractionBinding {
    const active = this.#bindings.getStore();
    if (!active) {
      throw new Error("Job confirmation has no active durable assignment");
    }
    return active;
  }
}

function interactionKey(assignmentId: string, requestId: string): string {
  return canonicalize([assignmentId, requestId]);
}

function jobInteractionOutcome(
  requestId: string,
  decision: ConfirmationDecision,
  source: ConfirmationResolutionSource,
  channelAnswer?: {
    readonly grant: ChannelInteractionGrant;
    readonly outcome: Extract<
      AssignmentInteractionOutcome,
      { readonly t: "answered" }
    >;
  },
  surfaceAnswer?: {
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decision: Extract<
      ConfirmationDecision,
      { readonly kind: "allow-once" | "deny" }
    >;
  },
): AssignmentInteractionOutcome {
  if (source.kind === "expired" || decision.kind === "expired") {
    return { t: "expired" };
  }
  if (source.kind === "non-interactive") {
    if (decision.kind !== "deny") {
      throw new Error("Non-interactive durable job confirmations must fail closed");
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
    throw new Error("Job confirmation resolution source is invalid");
  }
  if (surfaceAnswer) {
    if (channelAnswer) {
      throw new Error(
        `Job interaction ${requestId} has two answer authorities`,
      );
    }
    const allowed = surfaceAnswer.decision.kind === "allow-once";
    const reason =
      surfaceAnswer.decision.kind === "deny"
        ? surfaceAnswer.decision.reason
        : surfaceAnswer.decision.note;
    return {
      t: "answered",
      authority: {
        via: "surface-ticket",
        ticketId: surfaceAnswer.ticketId,
      },
      decision: { allowed, ...(reason ? { reason } : {}) },
      decisionDigest: confirmationDecisionDigest(
        requestId,
        surfaceAnswer.decision,
      ),
      by: surfaceAnswer.surfacePrincipal,
    };
  }
  if (!channelAnswer) {
    throw new Error(
      `Job interaction ${requestId} resolved without a durable answer authority`,
    );
  }
  const allowed = decision.kind !== "deny" && decision.kind !== "cancelled";
  if (channelAnswer.outcome.decision.allowed !== allowed) {
    throw new Error("Job interaction decision does not match its channel grant");
  }
  return channelAnswer.outcome;
}
