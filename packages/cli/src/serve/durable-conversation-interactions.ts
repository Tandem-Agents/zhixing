import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ConfirmationAdmissionDisposition,
  ConfirmationDecision,
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
  type StreamDigestChain,
} from "@zhixing/core/protocol";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";

export interface DurableInteractionBinding {
  readonly assignmentId: string;
  readonly ledger: ConversationAssignmentLedger;
  readonly submission: InProcessAssignmentSubmission;
  readonly context: AuthorityCallContext;
  readonly surfacePrincipal: string;
  readonly stream: StreamDigestChain;
  readonly streamMeta: { readonly turnOrigin?: NonNullable<IngressContext["turnOrigin"]> };
}

/** Binds confirmations and side effects to the executor ledger that owns the run. */
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
