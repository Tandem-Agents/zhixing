import type { ConfirmationRequest } from "@zhixing/core";
import type {
  AuthorityCallContext,
  ChannelInteractionGrant,
} from "@zhixing/core/contracts";
import type { StreamFrameAppender } from "@zhixing/core/protocol";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import { describe, expect, it, vi } from "vitest";
import {
  DurableJobInteractionCoordinator,
  type DurableJobInteractionBinding,
} from "./durable-job-interactions.js";
import { retryRemoteObligation } from "./assignment-worker-obligations.js";

const REQUEST: ConfirmationRequest = {
  id: "shared-request",
  tool: "bash",
  toolInput: { command: "echo ok" },
  workingDirectory: "C:\\workspace",
  display: {
    title: "Approve?",
    body: { kind: "generic", summary: "run command" },
    cwd: "C:\\workspace",
  },
  options: [{ kind: "allow-once", label: "Allow" }],
  sessionType: "interactive",
  contextId: { kind: "main" },
  createdAt: Date.parse("2026-07-29T00:00:00.000Z"),
  expiresAt: Date.parse("2026-07-29T00:01:00.000Z"),
};

describe("assignment worker remote obligations", () => {
  it("stops awaiting an in-flight remote operation when cancellation is signalled", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const task = retryRemoteObligation(
      async () => {
        started();
        return new Promise<never>(() => undefined);
      },
      controller.signal,
    );

    await operationStarted;
    controller.abort(new Error("assignment cancelled"));

    await expect(task).rejects.toThrow("assignment cancelled");
  });
});

describe("DurableJobInteractionCoordinator", () => {
  it("scopes identical request ids by assignment", async () => {
    const requestInteraction = vi.fn(async () => ({
      accepted: true,
      recordSeq: 1,
      display: { title: "Approve?", lines: ["run command"] },
    }));
    const ledger = {
      requestInteraction,
      interactionStreamEvents: async () => [],
    } as unknown as ConversationAssignmentLedger;
    const coordinator = new DurableJobInteractionCoordinator(ledger);

    await coordinator.lifecycleObserverFor(binding("assignment-a", ledger))
      .beforeRequest(REQUEST);
    await coordinator.lifecycleObserverFor(binding("assignment-b", ledger))
      .beforeRequest(REQUEST);

    expect(requestInteraction).toHaveBeenNthCalledWith(
      1,
      "assignment-a",
      expect.objectContaining({ requestId: REQUEST.id }),
    );
    expect(requestInteraction).toHaveBeenNthCalledWith(
      2,
      "assignment-b",
      expect.objectContaining({ requestId: REQUEST.id }),
    );
  });

  it("absorbs durable answer replays without an active runtime", async () => {
    const ledger = {
      prepareInteractionAnswerFromChannel: vi.fn(async () => ({
        kind: "replayed",
        result: {},
      })),
      jobInteractionOutcome: vi.fn(async () => ({ t: "expired" })),
    } as unknown as ConversationAssignmentLedger;
    const coordinator = new DurableJobInteractionCoordinator(ledger);

    await expect(
      coordinator.deliverGrant({
        assignmentId: "assignment-a",
        interactionRequestId: "request-a",
      } as ChannelInteractionGrant),
    ).resolves.toBeUndefined();
    await expect(
      coordinator.resolveNoInteractiveSurface({
        assignmentId: "assignment-a",
        requestId: "request-a",
      }),
    ).resolves.toBeUndefined();
  });

  it("re-drives the active projection when a durable answer is replayed", async () => {
    const ledger = {
      requestInteraction: vi.fn(async () => ({
        accepted: true,
        recordSeq: 1,
        display: { title: "Approve?", lines: ["run command"] },
      })),
      prepareInteractionAnswerFromChannel: vi.fn(async () => ({
        kind: "replayed",
        result: {},
      })),
    } as unknown as ConversationAssignmentLedger;
    const wakeConvergence = vi.fn();
    const coordinator = new DurableJobInteractionCoordinator(ledger, wakeConvergence);
    const active = binding("assignment-a", ledger);
    await coordinator.lifecycleObserverFor(active)
      .beforeRequest(REQUEST);
    wakeConvergence.mockClear();

    await coordinator.deliverGrant({
      assignmentId: "assignment-a",
      interactionRequestId: REQUEST.id,
    } as ChannelInteractionGrant);

    expect(wakeConvergence).toHaveBeenCalledWith("assignment-a", active);
  });
});

function binding(
  assignmentId: string,
  ledger: ConversationAssignmentLedger,
): DurableJobInteractionBinding {
  return {
    assignmentId,
    ledger,
    submission: {} as InProcessAssignmentSubmission,
    context: {
      principal: { kind: "system", authority: "executor" },
      requestId: `submission:${assignmentId}`,
      deadlineAt: "2026-07-29T00:01:00.000Z",
    } as unknown as AuthorityCallContext,
    stream: {
      append: vi.fn(async () => undefined),
    } as unknown as StreamFrameAppender,
    streamMeta: {},
  };
}
