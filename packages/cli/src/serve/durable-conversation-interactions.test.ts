import { describe, expect, it, vi } from "vitest";
import {
  DurableConversationInteractionObserver,
  type DurableInteractionBinding,
} from "./durable-conversation-interactions.js";

describe("DurableConversationInteractionObserver", () => {
  it("retries the durable interaction projection from the first unconfirmed record", async () => {
    const requested = {
      kind: "interaction" as const,
      event: {
        t: "requested" as const,
        requestId: "request-fixed",
        toolName: "Write",
        display: { title: "Approve", lines: ["write file"] },
        issuedAt: "2026-07-23T00:00:00.000Z",
        ttlMs: 60_000,
        expiresAt: "2026-07-23T00:01:00.000Z",
      },
    };
    const finished = {
      kind: "interaction" as const,
      event: {
        t: "finished" as const,
        requestId: "request-fixed",
        outcome: "cancelled" as const,
      },
    };
    const append = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary stream failure"))
      .mockResolvedValue(undefined);
    const binding = {
      assignmentId: "assignment-fixed",
      ledger: {
        interactionStreamEvents: vi.fn(async () => [
          { recordSeq: 4, payload: requested },
          { recordSeq: 7, payload: finished },
        ]),
      },
      stream: { append },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const observer = new DurableConversationInteractionObserver();

    await expect(observer.drainAssignment(binding)).rejects.toThrow(
      "temporary stream failure",
    );
    await observer.drainAssignment(binding);
    await observer.drainAssignment(binding);

    expect(append).toHaveBeenNthCalledWith(
      2,
      requested,
      {},
      undefined,
      "interaction:4",
    );
    expect(append).toHaveBeenNthCalledWith(
      3,
      finished,
      {},
      undefined,
      "interaction:7",
    );
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("serializes concurrent drains for the same assignment", async () => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const append = vi.fn(async () => {
      await appendGate;
    });
    const binding = {
      assignmentId: "assignment-fixed",
      ledger: {
        interactionStreamEvents: vi.fn(async () => [{
          recordSeq: 4,
          payload: {
            kind: "interaction" as const,
            event: {
              t: "finished" as const,
              requestId: "request-fixed",
              outcome: "cancelled" as const,
            },
          },
        }]),
      },
      stream: { append },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const observer = new DurableConversationInteractionObserver();

    const first = observer.drainAssignment(binding);
    const second = observer.drainAssignment(binding);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    releaseAppend();
    await Promise.all([first, second]);

    expect(append).toHaveBeenCalledTimes(1);
  });
});
