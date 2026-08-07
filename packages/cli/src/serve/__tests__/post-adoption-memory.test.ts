import { describe, expect, it, vi } from "vitest";
import type { GlobalStatePort } from "@zhixing/core/contracts";
import type { ConversationSegmentMemoryFlush } from "@zhixing/owner-kernel";
import { createPostAdoptionMemoryPort } from "../post-adoption-memory.js";

const candidate = (
  segmentId: string,
): ConversationSegmentMemoryFlush => ({
  conversationId: "local:device-a:conversation-1",
  segmentId,
  tokensBefore: 10_000,
  messages: [
    { role: "user", content: [{ type: "text", text: "Please remember this" }] },
    { role: "assistant", content: [{ type: "text", text: "I will" }] },
  ],
  summary: { facts: "A durable fact", state: "", active: "" },
});

function fixture(options?: { failAfterFirstWrite?: boolean }) {
  const read = vi.fn(async () => ({ kind: "memory-list" as const, entries: [] }));
  let failed = false;
  const durable = new Map<string, { readonly payload: string; readonly revision: number }>();
  const mutate = vi.fn(async (mutation: unknown, context: { readonly requestId: string }) => {
    const payload = JSON.stringify(mutation);
    const replay = durable.get(context.requestId);
    if (replay) {
      if (replay.payload !== payload) throw new Error("idempotency conflict");
      return { revision: replay.revision };
    }
    durable.set(context.requestId, { payload, revision: durable.size + 1 });
    if (options?.failAfterFirstWrite && !failed) {
      failed = true;
      throw new Error("response lost after durable write");
    }
    return { revision: durable.size };
  });
  const callText = vi.fn(async () => JSON.stringify([
    {
      category: "profile",
      id: "profile",
      meta: { preference: "concise" },
      content: "Prefers concise answers.",
    },
  ]));
  const createPort = () => createPostAdoptionMemoryPort({
    globalState: { read, mutate } as unknown as GlobalStatePort,
    anchorEpoch: 3,
    callText,
    clock: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  return {
    read,
    mutate,
    callText,
    durable,
    port: createPort(),
    restart: createPort,
  };
}

describe("post-adoption memory", () => {
  it("does nothing when the adopted conversation has no segment boundary", async () => {
    const f = fixture();
    await f.port.flush([]);
    expect(f.callText).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it("single-flights and deduplicates the same committed segment in one process", async () => {
    const f = fixture();
    const input = candidate("segment-1");
    await Promise.all([f.port.flush([input]), f.port.flush([input])]);
    await f.port.flush([input]);

    expect(f.callText).toHaveBeenCalledTimes(1);
    expect(f.mutate).toHaveBeenCalledTimes(1);
    const context = f.mutate.mock.calls[0]![1];
    expect(context.requestId).toMatch(/^post-adoption-memory:sha256:[a-f0-9]{64}:0$/);
  });

  it("replays an effect-after-response-loss through the same durable request after restart", async () => {
    const f = fixture({ failAfterFirstWrite: true });
    const input = candidate("segment-retry");

    await expect(f.port.flush([input])).rejects.toThrow("Memory flush did not settle");
    const firstRequestId = f.mutate.mock.calls[0]![1].requestId;
    await f.restart().flush([input]);

    expect(f.callText).toHaveBeenCalledTimes(2);
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.mutate.mock.calls[1]![1].requestId).toBe(firstRequestId);
    expect(f.durable.size).toBe(1);
  });

  it("uses independent stable identities for multiple segment boundaries", async () => {
    const f = fixture();
    await f.port.flush([candidate("segment-1"), candidate("segment-2")]);

    expect(f.callText).toHaveBeenCalledTimes(2);
    const requestIds = f.mutate.mock.calls.map((call) => call[1].requestId);
    expect(new Set(requestIds).size).toBe(2);
  });
});
