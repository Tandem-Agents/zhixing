import { describe, expect, it, vi } from "vitest";
import type {
  ConversationStatusNotice,
  DeliveryStatusNotice,
  JobStatusNotice,
  StreamFrame,
} from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import { createConversationSealedBundle } from "./commit.js";
import { ExecutionFinalityProjection } from "./execution-finality.js";
import { StreamDigestChain } from "./stream.js";

const at = "2026-07-28T00:00:00.000Z";
const conversationRef = {
  execution: "conversation",
  conversationId: "conversation-1",
  runId: "run-1",
  ownerEpoch: 1,
} as const;
const jobRef = {
  execution: "job",
  taskId: "task-1",
  jobRunId: "job-run-1",
  anchorEpoch: 1,
} as const;

describe("ExecutionFinalityProjection", () => {
  it("keeps conversation, job, and delivery revisions independent and drains reorder gaps", async () => {
    const accepted: Array<
      ConversationStatusNotice | JobStatusNotice | DeliveryStatusNotice
    > = [];
    const projection = new ExecutionFinalityProjection({
      onStatus: (notice) => accepted.push(notice),
    });
    const conversation = status(conversationRef, 1, "running");
    const jobTwo = status(jobRef, 2, "failed");
    const jobOne = status(jobRef, 1, "running");
    const delivery = {
      ref: {
        execution: "delivery",
        itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      },
      state: "delivery-failed",
      statusRevision: 1,
      actions: [],
      at,
      attempt: 1,
      anchorEpoch: 1,
    } satisfies DeliveryStatusNotice;

    await expect(projection.acceptStatus(jobTwo)).resolves.toBe("buffered");
    await expect(projection.acceptStatus(conversation)).resolves.toBe("accepted");
    await expect(projection.acceptStatus(delivery)).resolves.toBe("accepted");
    await expect(projection.acceptStatus(jobOne)).resolves.toBe("accepted");
    await expect(projection.acceptStatus(jobTwo)).resolves.toBe("duplicate");

    expect(accepted).toEqual([conversation, delivery, jobOne, jobTwo]);
    expect(projection.statusRevision(conversationRef)).toBe(1);
    expect(projection.statusRevision(jobRef)).toBe(2);
    expect(projection.statusRevision(delivery.ref)).toBe(1);
  });

  it("keeps provisional final pending until the matching sealed bundle and final arrive", async () => {
    const onFinal = vi.fn();
    const projection = new ExecutionFinalityProjection({
      onConversationFinal: onFinal,
    });
    const chain = new StreamDigestChain("assignment-1");
    chain.append({
      kind: "agent-yield",
      yield: { type: "text_delta", text: "done" },
    });
    const streamFinal = chain.final();
    const provisional = {
      v: 1,
      ref: conversationRef,
      assignmentId: "assignment-1",
      streamEpoch: 1,
      seq: streamFinal.finalSeq,
      payload: { kind: "provisional-final", ...streamFinal },
      meta: {},
    } satisfies StreamFrame;
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      streamFinal,
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: {
        reportDigest: protocolDigest("TestUsage", 1, {}),
        upToUsageSeq: 1,
      },
      dependencyArtifacts: [],
      body: {
        t: "conversation",
        runId: "run-1",
        conversationId: "conversation-1",
        ownerEpoch: 1,
        baseRevision: 0,
        runRecord: {
          type: "run",
          runId: "run-1",
          runIndex: 0,
          timestamp: at,
          messages: [
            { role: "user", content: [{ type: "text", text: "finish" }] },
          ],
        },
        contentAssets: [],
      },
    });
    const frame = {
      v: 1,
      conversationId: "conversation-1",
      runId: "run-1",
      commitRevision: 1,
      digest: bundle.digest,
    } as const;

    await expect(
      projection.acceptProvisionalFinal(provisional),
    ).resolves.toBe("accepted");
    expect(
      projection.isConversationFinalConfirmed("conversation-1", "run-1"),
    ).toBe(false);
    await expect(
      projection.confirmConversationFinal({ frame, bundle }),
    ).resolves.toBe("accepted");
    expect(
      projection.isConversationFinalConfirmed("conversation-1", "run-1"),
    ).toBe(true);
    expect(onFinal).toHaveBeenCalledTimes(1);

    await expect(
      projection.confirmConversationFinal({
        frame: { ...frame, digest: "0".repeat(64) },
        bundle,
      }),
    ).rejects.toThrow(/does not bind/);
  });

  it("buffers a committed final that arrives before its provisional stream frame", async () => {
    const onFinal = vi.fn();
    const projection = new ExecutionFinalityProjection({
      onConversationFinal: onFinal,
    });
    const chain = new StreamDigestChain("assignment-1");
    const streamFinal = chain.final();
    const provisional = {
      v: 1,
      ref: conversationRef,
      assignmentId: "assignment-1",
      streamEpoch: 1,
      seq: streamFinal.finalSeq,
      payload: { kind: "provisional-final", ...streamFinal },
      meta: {},
    } satisfies StreamFrame;
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      streamFinal,
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      usageFinal: {
        reportDigest: protocolDigest("TestUsage", 1, {}),
        upToUsageSeq: 1,
      },
      dependencyArtifacts: [],
      body: {
        t: "conversation",
        runId: "run-1",
        conversationId: "conversation-1",
        ownerEpoch: 1,
        baseRevision: 0,
        runRecord: {
          type: "run",
          runId: "run-1",
          runIndex: 0,
          timestamp: at,
          messages: [
            { role: "user", content: [{ type: "text", text: "finish" }] },
          ],
        },
        contentAssets: [],
      },
    });
    const frame = {
      v: 1,
      conversationId: "conversation-1",
      runId: "run-1",
      commitRevision: 1,
      digest: bundle.digest,
    } as const;

    await expect(
      projection.confirmConversationFinal({ frame, bundle }),
    ).resolves.toBe("buffered");
    expect(onFinal).not.toHaveBeenCalled();
    await expect(
      projection.acceptProvisionalFinal(provisional),
    ).resolves.toBe("accepted");
    expect(onFinal).toHaveBeenCalledWith(frame);
    expect(
      projection.isConversationFinalConfirmed("conversation-1", "run-1"),
    ).toBe(true);
  });

  it("accepts job committed results only through one stable delivery identity", async () => {
    const onJobResult = vi.fn();
    const projection = new ExecutionFinalityProjection({ onJobResult });
    const result = {
      ref: jobRef,
      itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      statusRevision: 1,
    };
    await expect(projection.acceptJobResult(result)).resolves.toBe("accepted");
    await expect(projection.acceptJobResult(result)).resolves.toBe("duplicate");
    await expect(
      projection.acceptJobResult({
        ...result,
        itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVM",
      }),
    ).rejects.toThrow(/conflicting/);
    expect(onJobResult).toHaveBeenCalledTimes(1);
  });
});

function status(
  ref: typeof conversationRef,
  statusRevision: number,
  state: "running",
): ConversationStatusNotice;
function status(
  ref: typeof jobRef,
  statusRevision: number,
  state: "running" | "failed",
): JobStatusNotice;
function status(
  ref: typeof conversationRef | typeof jobRef,
  statusRevision: number,
  state: "running" | "failed",
): ConversationStatusNotice | JobStatusNotice {
  return {
    ref,
    state,
    statusRevision,
    actions: [],
    at,
  } as ConversationStatusNotice | JobStatusNotice;
}
