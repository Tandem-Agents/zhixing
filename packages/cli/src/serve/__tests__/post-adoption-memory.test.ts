import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { MemoryMutationConflictError } from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  ConversationTransferManifest,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import type { ConversationSegmentMemoryFlush } from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import { createPostAdoptionMemoryPort } from "../post-adoption-memory.js";

const candidate = (segmentId: string): ConversationSegmentMemoryFlush => ({
  conversationId: "local:device-a:conversation-1",
  segmentId,
  tokensBefore: 10_000,
  messages: [
    { role: "user", content: [{ type: "text", text: "Please remember this" }] },
    { role: "assistant", content: [{ type: "text", text: "I will" }] },
  ],
  summary: { facts: "A durable fact", state: "", active: "" },
});

function manifest(transferId = "transfer-1"): ConversationTransferManifest {
  return {
    v: 1,
    t: "ConversationTransferManifest",
    requestId: "request-1",
    transferId,
    sourceDeviceId: "device-a",
    targetDeviceId: "device-b",
    conversationId: "local:device-a:conversation-1",
    sourceOwnerEpoch: 1,
    nextOwnerEpoch: 2,
    lastLsn: 9,
    authorityBase: {
      checkpoint: {
        logId: "a".repeat(64),
        lsn: 9,
        frameEndOffset: 1024,
        prefixDigest: `sha256:${"b".repeat(64)}`,
      },
      records: { digest: `sha256:${"c".repeat(64)}`, bytes: 1 },
      sessionState: { digest: `sha256:${"d".repeat(64)}`, bytes: 1 },
      reducerVersion: "conversation-session-state-v1",
    },
    streams: [],
    contentAssets: [],
  };
}

async function fixture(options?: {
  failAfterFirstWrite?: boolean;
  revisionConflictOnce?: boolean;
}) {
  const root = await createTempDir("post-adoption-memory");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const authorityLog = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
  onTestFinished(() => authorityLog.stopStorageMaintenance());
  let revisionConflicted = false;
  const read = vi.fn(async () => ({
    kind: "memory-list" as const,
    entries: revisionConflicted
      ? [{
          scope: { kind: "personal" as const },
          domain: "memory" as const,
          category: "profile" as const,
          id: "profile" as const,
          meta: {},
          content: "Concurrent value",
          revision: 1,
          digest: `sha256:${"e".repeat(64)}`,
        }]
      : [],
  }));
  let failed = false;
  const durable = new Map<string, { readonly payload: string; readonly revision: number }>();
  const mutate = vi.fn(async (mutation: unknown, context: { readonly requestId: string }) => {
    const payload = JSON.stringify(mutation);
    const replay = durable.get(context.requestId);
    if (replay) {
      if (replay.payload !== payload) throw new Error("idempotency conflict");
      return { revision: replay.revision };
    }
    if (options?.revisionConflictOnce && !revisionConflicted) {
      revisionConflicted = true;
      throw new MemoryMutationConflictError({
        code: "revision-conflict",
        message: "Memory entry changed",
        retryable: false,
      });
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
    authorityLog,
    anchorEpoch: 3,
    callText,
    clock: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  return {
    read,
    mutate,
    callText,
    durable,
    authorityLog,
    port: createPort(),
    restart: createPort,
  };
}

describe("post-adoption memory", () => {
  it("durably records a zero-segment discovery watermark without calling the model", async () => {
    const f = await fixture();
    await f.port.flush({ manifest: manifest(), candidates: [] });
    expect(f.callText).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
    expect((await f.authorityLog.readStream("run:local:device-a:conversation-1"))
      .map((entry) => entry.body)).toEqual([
      expect.objectContaining({ kind: "post-adoption-memory-discovery", operationIds: [] }),
    ]);
  });

  it("single-flights and durably deduplicates a committed segment", async () => {
    const f = await fixture();
    const input = { manifest: manifest(), candidates: [candidate("segment-1")] };
    await Promise.all([f.port.flush(input), f.port.flush(input)]);
    await f.port.flush(input);
    const loadCandidates = vi.fn(async () => [candidate("segment-1")]);
    await f.restart().flush({ manifest: manifest(), loadCandidates });

    expect(f.callText).toHaveBeenCalledTimes(1);
    expect(f.mutate).toHaveBeenCalledTimes(1);
    expect(loadCandidates).not.toHaveBeenCalled();
    expect(f.mutate.mock.calls[0]![1].requestId)
      .toMatch(/^post-adoption-effect:sha256:[a-f0-9]{64}:attempt:1$/u);
  });

  it("re-drives an incomplete durable input without reloading transcript history", async () => {
    const f = await fixture();
    const durableCandidate = candidate("segment-durable-input");
    f.callText.mockRejectedValueOnce(new Error("model temporarily unavailable"));

    await expect(f.port.flush({
      manifest: manifest(),
      candidates: [durableCandidate],
    })).rejects.toThrow("model temporarily unavailable");

    const loadCandidates = vi.fn(async () => {
      throw new Error("completed history must not be reconstructed");
    });
    await f.restart().flush({ manifest: manifest(), loadCandidates });

    expect(loadCandidates).not.toHaveBeenCalled();
    expect(f.callText).toHaveBeenCalledTimes(2);
    expect(f.mutate).toHaveBeenCalledTimes(1);
    expect((await f.authorityLog.readStream("run:local:device-a:conversation-1"))
      .map((entry) => entry.body)).toContainEqual(
        expect.objectContaining({
          kind: "post-adoption-memory-attempt",
          input: durableCandidate,
        }),
      );
  });

  it("replays an effect-after-response-loss without regenerating the frozen plan", async () => {
    const f = await fixture({ failAfterFirstWrite: true });
    const input = { manifest: manifest(), candidates: [candidate("segment-retry")] };

    await expect(f.port.flush(input)).rejects.toThrow("response lost after durable write");
    const firstRequestId = f.mutate.mock.calls[0]![1].requestId;
    await f.restart().flush(input);

    expect(f.callText).toHaveBeenCalledTimes(1);
    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.mutate.mock.calls[1]![1].requestId).toBe(firstRequestId);
    expect(f.durable.size).toBe(1);
  });

  it("freezes a canonical plan when model output order changes", async () => {
    const f = await fixture({ failAfterFirstWrite: true });
    f.callText
      .mockResolvedValueOnce(JSON.stringify([
        { category: "journal", id: "2026-08-07", meta: {}, content: "A" },
        { category: "profile", id: "profile", meta: {}, content: "B" },
      ]))
      .mockResolvedValueOnce(JSON.stringify([
        { category: "profile", id: "profile", meta: {}, content: "B" },
        { category: "journal", id: "2026-08-07", meta: {}, content: "A" },
      ]));
    const input = { manifest: manifest(), candidates: [candidate("segment-plan")] };

    await expect(f.port.flush(input)).rejects.toThrow();
    await f.restart().flush(input);

    expect(f.callText).toHaveBeenCalledTimes(1);
    expect(f.durable.size).toBe(2);
  });

  it("uses independent stable identities for multiple segment boundaries", async () => {
    const f = await fixture();
    await f.port.flush({
      manifest: manifest(),
      candidates: [candidate("segment-1"), candidate("segment-2")],
    });

    expect(f.callText).toHaveBeenCalledTimes(2);
    const requestIds = f.mutate.mock.calls.map((call) => call[1].requestId);
    expect(new Set(requestIds).size).toBe(2);
  });

  it("records a zero-effect revision conflict before deriving the next CAS attempt", async () => {
    const f = await fixture({ revisionConflictOnce: true });
    await f.port.flush({
      manifest: manifest(),
      candidates: [candidate("segment-cas")],
    });

    expect(f.mutate).toHaveBeenCalledTimes(2);
    expect(f.mutate.mock.calls.map((call) => call[1].requestId)).toEqual([
      expect.stringMatching(/:attempt:1$/u),
      expect.stringMatching(/:attempt:2$/u),
    ]);
    expect(f.mutate.mock.calls[1]![0]).toMatchObject({
      payload: { expectedDigest: `sha256:${"e".repeat(64)}` },
    });
  });
});
