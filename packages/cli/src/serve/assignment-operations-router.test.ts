import { describe, expect, it, vi } from "vitest";
import {
  AssignmentInteractionRouter,
  AssignmentOperationsRouter,
} from "./assignment-operations-router.js";
import { JobInteractionRuntimeUnavailableError } from "./durable-job-interactions.js";

describe("assignment operations execution-domain routing", () => {
  it("routes local interaction answers by the durable assignment binding", async () => {
    const conversation = interactionPort();
    const job = interactionPort();
    const router = new AssignmentInteractionRouter({
      ledger: ledgerFor({
        conversation: conversationRef(),
        job: jobRef(),
      }) as never,
      conversation,
      job,
    });

    await router.resolveNoInteractiveSurface({
      assignmentId: "conversation",
      requestId: "request-conversation",
    });
    await router.answerInteractionWithTicket({
      assignmentId: "job",
      requestId: "request-job",
      ticketId: "ticket-job",
      surfacePrincipal: "surface:test",
      decision: { kind: "allow-once" },
    });

    expect(conversation.resolveNoInteractiveSurface).toHaveBeenCalledTimes(1);
    expect(job.answerInteractionWithTicket).toHaveBeenCalledTimes(1);
    expect(conversation.answerInteractionWithTicket).not.toHaveBeenCalled();
    expect(job.resolveNoInteractiveSurface).not.toHaveBeenCalled();
  });

  it("rejects job operations before the executor-owned job capability exists", async () => {
    const router = new AssignmentInteractionRouter({
      ledger: ledgerFor({ job: jobRef() }) as never,
      conversation: interactionPort(),
    });

    await expect(
      router.resolveNoInteractiveSurface({
        assignmentId: "job",
        requestId: "request-job",
      }),
    ).rejects.toBeInstanceOf(JobInteractionRuntimeUnavailableError);
  });

  it("uses the same durable-domain predicate for abort operations", async () => {
    const conversation = operationsPort();
    const job = operationsPort();
    const router = new AssignmentOperationsRouter({
      ledger: ledgerFor({ job: jobRef() }) as never,
      conversation,
      job,
    });

    await router.abortWithTicket({
      assignmentId: "job",
      ref: jobRef(),
      ticketId: "ticket-job",
      surfacePrincipal: "surface:test",
      reason: "stop",
    } as never);
    expect(job.abortWithTicket).toHaveBeenCalledTimes(1);
    expect(conversation.abortWithTicket).not.toHaveBeenCalled();

    await expect(
      router.abortWithTicket({
        assignmentId: "job",
        ref: conversationRef(),
      } as never),
    ).rejects.toThrow(/execution domain differs/u);
  });
});

function interactionPort() {
  return {
    answerInteractionWithTicket: vi.fn(async () => undefined),
    resolveNoInteractiveSurface: vi.fn(async () => undefined),
  };
}

function operationsPort() {
  return {
    ...interactionPort(),
    abortWithTicket: vi.fn(async () => undefined),
  };
}

function ledgerFor(
  bindings: Readonly<
    Record<
      string,
      ReturnType<typeof conversationRef> | ReturnType<typeof jobRef>
    >
  >,
) {
  return {
    dataPlaneBinding: vi.fn(async (assignmentId: string) => {
      const ref = bindings[assignmentId];
      return ref ? { assignmentId, ref } : undefined;
    }),
  };
}

function conversationRef() {
  return {
    execution: "conversation" as const,
    runId: "run",
    conversationId: "conversation",
    ownerEpoch: 0,
  };
}

function jobRef() {
  return {
    execution: "job" as const,
    jobRunId: "job-run",
    taskId: "task",
    anchorEpoch: 0,
  };
}
