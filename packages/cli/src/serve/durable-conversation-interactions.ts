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
  IngressContext,
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
} from "@zhixing/executor";
import {
  AssignmentInteractionProjector,
  finishAssignmentSideEffect,
  startAssignmentSideEffect,
} from "./assignment-interaction-projection.js";

export interface DurableInteractionBinding {
  readonly assignmentId: string;
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
      interactionOutcome(
        request,
        decision,
        source,
        active.surfacePrincipal,
        this.#surfaceAnswers.get(request.id),
      ),
      active.context,
    );
    await this.drainAssignment(active);
    this.#requests.delete(request.id);
    this.#surfaceAnswers.delete(request.id);
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
    await this.#projector.drainAssignment(binding);
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
