import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ConfirmationAdmissionDisposition,
  ConfirmationDecision,
  IConfirmationBroker,
  ConfirmationLifecycleObserver,
  ConfirmationRequest,
  ConfirmationResolutionSource,
} from "@zhixing/core/confirmation";
import type { ToolDefinition, ToolSideEffectObserver } from "@zhixing/core";
import type { ExplicitApprovalEffects } from "@zhixing/core/security";
import type {
  AuthorityCallContext,
  IngressContext,
  TrustRuleHitFact,
  TrustSedimentFact,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  confirmationDecisionDigest,
  type ConversationInteractionOutcome,
  type StreamFrameAppender,
} from "@zhixing/core/protocol";
import {
  type ConversationAssignmentLedger,
  type InProcessAssignmentSubmission,
  type PendingAssignmentInteraction,
} from "@zhixing/executor";
import {
  AssignmentInteractionProjector,
  finishAssignmentSideEffect,
  startAssignmentSideEffect,
} from "./assignment-interaction-projection.js";

export interface DurableInteractionBinding {
  readonly assignmentId: string;
  /** 指派所属对话；显式持久批准的待生效记录据此在重开后查 owner 耐久结果。 */
  readonly conversationId?: string;
  readonly ledger: ConversationAssignmentLedger;
  readonly submission: InProcessAssignmentSubmission;
  readonly context: AuthorityCallContext;
  readonly surfacePrincipal: string;
  broker?: IConfirmationBroker;
  readonly stream: StreamFrameAppender;
  readonly streamMeta: { readonly turnOrigin?: NonNullable<IngressContext["turnOrigin"]> };
  /** Cancels only the projection obligation owner, not the run being projected. */
  readonly signal?: AbortSignal;
}

export class ConversationInteractionRuntimeUnavailableError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationInteractionRuntimeUnavailableError";
  }
}

export interface ConversationInteractionAnswerPort {
  answerInteractionWithTicket(input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decision: Extract<
      ConfirmationDecision,
      { readonly kind: "allow-once" | "deny" }
    >;
  }): Promise<void>;
  resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void>;
}

/** Binds confirmations and side effects to the executor ledger that owns the run. */
export class DurableConversationInteractionObserver
  implements
    ConfirmationLifecycleObserver,
    ToolSideEffectObserver,
    ConversationInteractionAnswerPort
{
  readonly #bindings = new AsyncLocalStorage<DurableInteractionBinding>();
  readonly #requests = new Map<string, DurableInteractionBinding>();
  readonly #explicitApprovals: ExplicitApprovalEffects | undefined;

  /** explicitApprovals 只在持久规则权威所在的锚点宿主装配。 */
  constructor(options: { readonly explicitApprovals?: ExplicitApprovalEffects } = {}) {
    this.#explicitApprovals = options.explicitApprovals;
  }
  readonly #projector = new AssignmentInteractionProjector();
  readonly #surfaceAnswers = new Map<
    string,
    {
      readonly assignmentId: string;
      readonly ticketId: string;
      readonly surfacePrincipal: string;
      readonly decisionDigest: string;
      readonly completion: Promise<boolean>;
    }
  >();

  withBinding<T>(
    binding: DurableInteractionBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#bindings.run(binding, operation);
  }

  async beforeRequest(
    request: ConfirmationRequest,
    requester?: { readonly brokerId: string },
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
      await this.drainAssignment(active);
      return { accepted: false, decision };
    }
    await this.drainAssignment(active);
    this.#requests.set(request.id, active);
    return { accepted: true, ...(active.broker && requester?.brokerId === active.broker.id
      ? { delivery: "durable" as const } : {}) };
  }

  /**
   * 决定的接纳边界是执行端台账里的耐久交互结果。接纳前的失败（显式持久批准的待生效
   * 记录写失败、耐久结果未提交）上抛，broker 让决定回到待确认；接纳后决定已固定，
   * 镜像冲刷与规则物化的失败都不再回队：镜像由运行结束、取消与下次交互的既有义务补冲，
   * 规则按已接纳决定立即生效、物化由同一所有者补做。
   */
  async afterResolved(
    request: ConfirmationRequest,
    decision: ConfirmationDecision,
    source: ConfirmationResolutionSource,
  ): Promise<void> {
    const active = this.#requests.get(request.id);
    if (!active) {
      throw new Error(`Confirmation interaction ${request.id} has no durable binding`);
    }
    const outcome = interactionOutcome(
      request,
      decision,
      source,
      active.surfacePrincipal,
      this.#surfaceAnswers.get(request.id),
    );
    const persistent =
      source.kind === "surface" &&
      (decision.kind === "allow-context" || decision.kind === "allow-global")
        ? decision
        : undefined;
    if (persistent) {
      if (!this.#explicitApprovals) {
        throw new Error("当前执行端不支持持久授权，请改为仅本次允许");
      }
      await this.#explicitApprovals.prepare({
        requestId: request.id,
        ...(active.conversationId ? { conversationId: active.conversationId } : {}),
        assignmentId: active.assignmentId,
        contextId: request.contextId,
        decision: persistent,
        decisionDigest: confirmationDecisionDigest(request.id, decision),
      });
    }
    try {
      await active.submission.finishAndMirror(
        active.assignmentId,
        request.id,
        outcome,
        active.context,
      );
    } catch (error) {
      const durable = await active.ledger.conversationInteractionOutcome(
        active.assignmentId,
        request.id,
      );
      if (!durableResolutionSupersedesRuntime(durable, outcome, source)) {
        throw error;
      }
      await active.submission
        .flushInteractionMirrors(active.assignmentId, active.context)
        .catch(() => undefined);
    }
    if (persistent) {
      await this.#explicitApprovals!.accept(request.id);
    } else {
      await this.#explicitApprovals?.discard(request.id);
    }
    await this.drainAssignment(active).catch(() => undefined);
    this.#requests.delete(request.id);
    this.#surfaceAnswers.delete(request.id);
  }

  /**
   * 在当前耐久对话指派内记一条信任沉淀并冲刷镜像，随同一条镜像链回到 owner。
   * 不在耐久对话指派内（job、定时任务）返回 undefined；冲刷失败时事实已在台账，
   * 由运行结束、取消与下次交互的既有镜像义务补冲。
   */
  async recordTrustSediment(sediment: TrustSedimentFact): Promise<
    { readonly assignmentId: string; readonly requestId: string; readonly mirrored: boolean } | undefined
  > {
    const active = this.#bindings.getStore();
    if (!active) return undefined;
    const recorded = await active.ledger.recordTrustSediment(active.assignmentId, sediment);
    const mirrored = await active.submission
      .flushInteractionMirrors(active.assignmentId, active.context)
      .then(() => true, () => false);
    return { assignmentId: active.assignmentId, requestId: recorded.requestId, mirrored };
  }

  /**
   * 在当前耐久对话指派内记一条规则命中，随同一条镜像链回到 owner。只写台账、不单独冲刷：
   * 由运行结束、取消与下次交互的既有镜像义务带回。不在耐久对话指派内返回 undefined。
   */
  async recordTrustRuleHit(hit: TrustRuleHitFact): Promise<
    { readonly assignmentId: string; readonly requestId: string } | undefined
  > {
    const active = this.#bindings.getStore();
    if (!active) return undefined;
    const recorded = await active.ledger.recordTrustRuleHit(active.assignmentId, hit);
    return { assignmentId: active.assignmentId, requestId: recorded.requestId };
  }

  async resolveWithSurfaceTicket(
    broker: IConfirmationBroker,
    input: {
      readonly assignmentId: string;
      readonly requestId: string;
      readonly ticketId: string;
      readonly surfacePrincipal: string;
      readonly decision: Extract<
        ConfirmationDecision,
        { kind: "allow-once" | "deny" }
      >;
    },
  ): Promise<boolean> {
    const binding = this.#requests.get(input.requestId);
    if (!binding || binding.assignmentId !== input.assignmentId) return false;
    const decisionDigest = confirmationDecisionDigest(
      input.requestId,
      input.decision,
    );
    const existing = this.#surfaceAnswers.get(input.requestId);
    if (existing) {
      if (
        existing.assignmentId !== input.assignmentId ||
        existing.ticketId !== input.ticketId ||
        existing.surfacePrincipal !== input.surfacePrincipal ||
        existing.decisionDigest !== decisionDigest
      ) {
        throw new Error("Confirmation interaction already has a different surface answer");
      }
      return existing.completion;
    }
    if (!broker.resolveDurably) {
      throw new Error("Assignment confirmation broker lacks durable resolution");
    }
    let resolveCompletion!: (resolved: boolean) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<boolean>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const answer = {
      assignmentId: input.assignmentId,
      ticketId: input.ticketId,
      surfacePrincipal: input.surfacePrincipal,
      decisionDigest,
      completion,
    };
    this.#surfaceAnswers.set(input.requestId, answer);
    void (async () => {
      try {
        const resolved = await broker.resolveDurably!(
          input.requestId,
          input.decision,
        );
        if (
          !resolved &&
          this.#surfaceAnswers.get(input.requestId) === answer
        ) {
          this.#surfaceAnswers.delete(input.requestId);
        }
        resolveCompletion(resolved);
      } catch (error) {
        if (this.#surfaceAnswers.get(input.requestId) === answer) {
          this.#surfaceAnswers.delete(input.requestId);
        }
        rejectCompletion(error);
      }
    })();
    return completion;
  }

  async answerInteractionWithTicket(
    input: Parameters<
      ConversationInteractionAnswerPort["answerInteractionWithTicket"]
    >[0],
  ): Promise<void> {
    const binding = this.#runtimeBinding(input);
    const broker = binding.broker;
    if (!broker) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Interaction answer has no active executor confirmation runtime",
      );
    }
    const prepared =
      await binding.ledger.prepareInteractionAnswerFromSurface(input);
    if (prepared.kind === "replayed") return;
    const resolved = await this.resolveWithSurfaceTicket(broker, {
      assignmentId: input.assignmentId,
      requestId: input.requestId,
      ticketId: prepared.ticketId,
      surfacePrincipal: prepared.surfacePrincipal,
      decision: prepared.decision,
    });
    if (!resolved) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Interaction request is not yet restored in the executor runtime",
      );
    }
    const replay =
      await binding.ledger.prepareInteractionAnswerFromSurface(input);
    if (replay.kind !== "replayed") {
      throw new Error(
        "Interaction answer did not reach a durable terminal result",
      );
    }
  }

  async resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    const binding = this.#runtimeBinding(input);
    const resolve = binding.broker?.resolveNonInteractiveDurably;
    if (!resolve) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Interaction has no active durable fail-closed runtime",
      );
    }
    const resolved = await resolve.call(binding.broker, input.requestId);
    if (!resolved) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Interaction request is not yet restored in the executor runtime",
      );
    }
  }

  async drainAssignment(binding: DurableInteractionBinding): Promise<void> {
    await this.#projector.drainAssignment({
      ...binding,
      projectionDomain: "conversation",
    });
  }

  async pendingInteractions(): Promise<readonly PendingAssignmentInteraction[]> {
    const active = new Map<
      string,
      { readonly ledger: ConversationAssignmentLedger; readonly requestIds: Set<string> }
    >();
    for (const [requestId, binding] of this.#requests) {
      const existing = active.get(binding.assignmentId);
      if (existing) {
        if (existing.ledger !== binding.ledger) {
          throw new Error("Interaction assignment is bound to multiple ledgers");
        }
        existing.requestIds.add(requestId);
      } else {
        active.set(binding.assignmentId, {
          ledger: binding.ledger,
          requestIds: new Set([requestId]),
        });
      }
    }
    const pending: PendingAssignmentInteraction[] = [];
    for (const [assignmentId, binding] of active) {
      for (const item of await binding.ledger.pendingInteractionRequests(assignmentId)) {
        if (binding.requestIds.has(item.request.requestId)) pending.push(item);
      }
    }
    return pending.sort((left, right) =>
      left.assignmentId.localeCompare(right.assignmentId) ||
      left.request.requestId.localeCompare(right.request.requestId),
    );
  }

  releaseAssignment(assignmentId: string): void {
    for (const [requestId, binding] of this.#requests) {
      if (binding.assignmentId === assignmentId) {
        this.#requests.delete(requestId);
        this.#surfaceAnswers.delete(requestId);
      }
    }
    this.#projector.release(assignmentId);
  }

  #runtimeBinding(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): DurableInteractionBinding {
    const binding = this.#requests.get(input.requestId);
    if (!binding || binding.assignmentId !== input.assignmentId) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Interaction request is not yet restored in the executor runtime",
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

  #requireActive(): DurableInteractionBinding {
    const active = this.#bindings.getStore();
    if (!active) {
      throw new Error("Confirmation interaction has no active durable assignment");
    }
    return active;
  }
}

function interactionOutcome(
  request: ConfirmationRequest,
  decision: ConfirmationDecision,
  source: ConfirmationResolutionSource,
  surfacePrincipal: string,
  surfaceAnswer?: {
    readonly assignmentId: string;
    readonly ticketId: string;
    readonly surfacePrincipal: string;
    readonly decisionDigest: string;
    readonly completion: Promise<boolean>;
  },
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
      ticketId: surfaceAnswer?.ticketId ?? `ticket:${request.id}`,
    },
    decision: { allowed, ...(reason ? { reason } : {}) },
    decisionDigest: confirmationDecisionDigest(request.id, decision),
    by: surfaceAnswer?.surfacePrincipal ?? surfacePrincipal,
  };
}

function durableResolutionSupersedesRuntime(
  durable: ConversationInteractionOutcome | undefined,
  runtime: ConversationInteractionOutcome,
  source: ConfirmationResolutionSource,
): boolean {
  if (!durable) return false;
  if (canonicalize(durable) === canonicalize(runtime)) return true;
  return (
    source.kind === "cancel" &&
    runtime.t === "cancelled" &&
    runtime.via === "run-end" &&
    durable.t === "cancelled" &&
    (durable.via === "cancel-fence" || durable.via === "abort-ticket")
  );
}
