import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import type { ArtifactRef, TranscriptRunRecord } from "../contracts/index.js";
import {
  canonicalize,
  createConversationSealedBundle,
  createJobCommitFence,
  createJobSealedBundle,
  createMutationBatch,
  jobDeliveryPlanDigest,
  protocolDigest,
} from "../protocol/index.js";
import { FileArtifactStore } from "./artifact-store.js";
import type { ArtifactStore } from "./interfaces.js";
import { collectArtifactRefs } from "./artifact-references.js";
import {
  FileResumableArtifactReceiver,
  resolveSealedBundleArtifactClosure,
} from "./assignment-artifacts.js";

const DIGEST = `sha256:${"1".repeat(64)}` as const;

describe("assignment artifact closure", () => {
  it("collects the base identity from extended artifact references", async () => {
    const fixture = await createFixture();
    expect(collectArtifactRefs({ content: { ...fixture.nestedRef, kind: "file" } })).toEqual([
      fixture.nestedRef,
    ]);
  });

  it("derives the exact registered dependency closure", async () => {
    const fixture = await createFixture();
    const resolved = await resolveSealedBundleArtifactClosure(
      fixture.bundle,
      fixture.artifacts,
    );

    expect(resolved.roots).toEqual([fixture.runRecordRef]);
    expect(resolved.dependencies).toEqual([fixture.nestedRef]);
    expect(resolved.transfer).toEqual(
      [fixture.nestedRef, fixture.runRecordRef].sort((left, right) =>
        left.digest.localeCompare(right.digest)),
    );
  });

  it("preserves the stable missing-artifact classification for an exact closure", async () => {
    const fixture = await createFixture();
    await rm(fixture.artifacts.pathFor(fixture.nestedRef));

    await expect(
      resolveSealedBundleArtifactClosure(fixture.bundle, fixture.artifacts),
    ).rejects.toMatchObject({ code: "artifact-missing" });
  });

  it("rejects missing, extra, non-canonical and cross-layer dependency declarations", async () => {
    const fixture = await createFixture();
    const extra = await fixture.artifacts.put(Buffer.from("extra"));
    const missing = bundleWithDependencies(fixture.bundle, []);
    const extraDeclared = bundleWithDependencies(
      fixture.bundle,
      [fixture.nestedRef, extra].sort((left, right) => left.digest.localeCompare(right.digest)),
    );
    const unordered = bundleWithDependencies(
      fixture.bundle,
      [...extraDeclared.dependencyArtifacts].reverse(),
    );
    const crossLayer = bundleWithDependencies(fixture.bundle, [fixture.runRecordRef]);

    await expect(resolveSealedBundleArtifactClosure(missing, fixture.artifacts)).rejects.toThrow();
    await expect(resolveSealedBundleArtifactClosure(extraDeclared, fixture.artifacts)).rejects.toThrow();
    await expect(resolveSealedBundleArtifactClosure(unordered, fixture.artifacts)).rejects.toThrow();
    await expect(resolveSealedBundleArtifactClosure(crossLayer, fixture.artifacts)).rejects.toThrow();
  });

  it("subtracts roots that are also discovered through registered content", async () => {
    const fixture = await createFixture();
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
      dependencyArtifacts: [],
      body: {
        ...fixture.bundle.body,
        contentAssets: [{ ...fixture.nestedRef, kind: "file" }],
      },
    });

    await expect(resolveSealedBundleArtifactClosure(bundle, fixture.artifacts)).resolves.toEqual({
      roots: [fixture.runRecordRef, fixture.nestedRef].sort((left, right) =>
        left.digest.localeCompare(right.digest)),
      dependencies: [],
      transfer: [fixture.runRecordRef, fixture.nestedRef].sort((left, right) =>
        left.digest.localeCompare(right.digest)),
    });
  });

  it("resolves job bundles through the shared discriminated-union validator", async () => {
    const artifacts = new FileArtifactStore(
      path.join(await temporaryRoot(), "job-artifacts"),
    );
    const content = await artifacts.put(Buffer.from("job content"));
    const bundle = createJobSealedBundle({
      assignmentId: "assignment-job",
      executorId: "executor-job",
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 0 },
      dependencyArtifacts: [],
      body: {
        t: "job",
        taskId: "task-job",
        jobRunId: "job-run-1",
        fence: createJobCommitFence({
          taskId: "task-job",
          jobRunId: "job-run-1",
          scheduledFor: "2026-07-21T00:00:00.000Z",
          taskRevision: 1,
          deliveryPlanDigest: jobDeliveryPlanDigest({ kind: "none" }),
          anchorEpoch: 1,
          assignmentId: "assignment-job",
          executorId: "executor-job",
        }),
        outcome: { status: "completed", summary: "done" },
        contentAssets: [{ ...content, kind: "file" }],
      },
    });

    await expect(
      resolveSealedBundleArtifactClosure(bundle, artifacts),
    ).resolves.toEqual({
      roots: [content],
      dependencies: [],
      transfer: [content],
    });
  });

  it("rejects a discovered root identity with a conflicting byte count", async () => {
    const fixture = await createFixture();
    const runRecord: TranscriptRunRecord = {
      type: "run",
      runId: "run-1",
      runIndex: 1,
      timestamp: "2026-07-21T00:00:00.000Z",
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "read",
            input: {
              attachment: { ...fixture.nestedRef, bytes: fixture.nestedRef.bytes + 1 },
            },
          }],
        },
      ],
    };
    const runRecordRef = await fixture.artifacts.put(
      Buffer.from(canonicalize(runRecord), "utf8"),
    );
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
      dependencyArtifacts: [],
      body: {
        ...fixture.bundle.body,
        runRecord: { ref: runRecordRef },
        contentAssets: [{ ...fixture.nestedRef, kind: "file" }],
      },
    });

    await expect(resolveSealedBundleArtifactClosure(bundle, fixture.artifacts)).rejects.toThrow(
      "different byte counts",
    );
  });

  it("discovers artifact references nested in a mutation batch", async () => {
    const fixture = await createFixture();
    const contentRef = await fixture.artifacts.put(Buffer.from("skill source"));
    const batch = createMutationBatch("assignment-1", [{
      v: 1,
      t: "staged-mutation",
      seq: 1,
      domain: "global",
      mutation: {
        kind: "skill-create",
        mode: "main",
        record: {
          name: "inspection",
          description: "Inspect an assignment",
          content: contentRef,
        },
      },
      requestId: "request-1",
      expected: { anchorEpoch: 1 },
    }]);
    const batchRef = await fixture.artifacts.put(Buffer.from(canonicalize(batch), "utf8"));
    const dependencyArtifacts = [fixture.nestedRef, contentRef].sort((left, right) =>
      left.digest.localeCompare(right.digest),
    );
    const bundle = createConversationSealedBundle({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      streamFinal: { finalSeq: 1, streamDigest: DIGEST },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
      dependencyArtifacts,
      body: {
        ...fixture.bundle.body,
        mutationBatch: { ref: batchRef, sessionCount: 0, globalCount: 1 },
      },
    });

    const resolved = await resolveSealedBundleArtifactClosure(bundle, fixture.artifacts);

    expect(resolved.roots).toEqual(
      [fixture.runRecordRef, batchRef].sort((left, right) =>
        left.digest.localeCompare(right.digest),
      ),
    );
    expect(resolved.dependencies).toEqual(dependencyArtifacts);
  });
});

function bundleWithDependencies(
  bundle: Awaited<ReturnType<typeof createFixture>>["bundle"],
  dependencyArtifacts: ArtifactRef[],
): typeof bundle {
  const { digest: _digest, ...payload } = { ...bundle, dependencyArtifacts };
  return {
    ...payload,
    digest: protocolDigest("SealedBundle", 1, payload),
  };
}

describe("FileResumableArtifactReceiver", () => {
  it("imports and reads large artifacts without whole-object materialization", async () => {
    const root = await temporaryRoot();
    const source = Buffer.alloc(512 * 1024, 0x4d);
    const expected = new FileArtifactStore(path.join(root, "expected"));
    const ref = await expected.put(source);
    const target = new FileArtifactStore(path.join(root, "target"));
    let yielded = 0;
    async function* chunks() {
      for (let offset = 0; offset < source.byteLength; offset += 4096) {
        yielded += 1;
        yield source.subarray(offset, offset + 4096);
      }
    }

    await target.putVerifiedStream(ref, chunks());

    expect(yielded).toBe(128);
    expect(await target.readRange(ref, 123_456, 8192)).toEqual(
      source.subarray(123_456, 123_456 + 8192),
    );
  });

  it("resumes a durable prefix after restart and deduplicates the completed digest", async () => {
    const root = await temporaryRoot();
    const source = Buffer.alloc(150_000, 0x5a);
    const sourceStore = new FileArtifactStore(path.join(root, "source"));
    const targetStore = new FileArtifactStore(path.join(root, "target"));
    const ref = await sourceStore.put(source);
    const scratch = path.join(root, "partial");
    const first = new FileResumableArtifactReceiver(targetStore, scratch, {
      maxArtifactBytes: 200_000,
      maxChunkBytes: 100_000,
    });

    expect(await first.append(ref, 0, source.subarray(0, 70_000))).toEqual({
      receivedBytes: 70_000,
      complete: false,
    });

    const restarted = new FileResumableArtifactReceiver(targetStore, scratch, {
      maxArtifactBytes: 200_000,
      maxChunkBytes: 100_000,
    });
    expect(await restarted.progress(ref)).toEqual({
      receivedBytes: 70_000,
      complete: false,
    });
    expect(await restarted.append(ref, 70_000, source.subarray(70_000))).toEqual({
      receivedBytes: source.byteLength,
      complete: true,
    });
    expect(Buffer.from(await targetStore.get(ref)).equals(source)).toBe(true);
    expect(await restarted.append(ref, 0, source.subarray(0, 10))).toEqual({
      receivedBytes: source.byteLength,
      complete: true,
    });
  });

  it("accepts an exact replay but rejects divergent or non-contiguous chunks", async () => {
    const root = await temporaryRoot();
    const targetStore = new FileArtifactStore(path.join(root, "target"));
    const sourceStore = new FileArtifactStore(path.join(root, "source"));
    const bytes = Buffer.from("0123456789");
    const ref = await sourceStore.put(bytes);
    const receiver = new FileResumableArtifactReceiver(targetStore, path.join(root, "partial"), {
      maxArtifactBytes: 100,
    });

    await receiver.append(ref, 0, bytes.subarray(0, 5));
    expect(await receiver.append(ref, 0, bytes.subarray(0, 5))).toEqual({
      receivedBytes: 5,
      complete: false,
    });
    await expect(receiver.append(ref, 0, Buffer.from("xxxxx"))).rejects.toThrow(
      "differs from the durable prefix",
    );
    await expect(receiver.append(ref, 6, bytes.subarray(6))).rejects.toThrow(
      "does not continue",
    );
  });

  it("rejects a completed digest mismatch without polluting the artifact store", async () => {
    const root = await temporaryRoot();
    const targetStore = new FileArtifactStore(path.join(root, "target"));
    const sourceStore = new FileArtifactStore(path.join(root, "source"));
    const expected = await sourceStore.put(Buffer.from("expected"));
    const corruptBytes = Buffer.from("corrupt!");
    const corrupt = await sourceStore.put(corruptBytes);
    const receiver = new FileResumableArtifactReceiver(targetStore, path.join(root, "partial"), {
      maxArtifactBytes: 100,
    });

    await expect(receiver.append(expected, 0, corruptBytes)).rejects.toThrow(
      "does not match",
    );
    expect(await targetStore.has(expected)).toBe(false);
    expect(await targetStore.has(corrupt)).toBe(false);
    expect(await receiver.progress(expected)).toEqual({
      receivedBytes: 0,
      complete: false,
    });
  });

  it("enforces the artifact budget and removes expired durable prefixes", async () => {
    const root = await temporaryRoot();
    const targetStore = new FileArtifactStore(path.join(root, "target"));
    const sourceStore = new FileArtifactStore(path.join(root, "source"));
    const ref = await sourceStore.put(Buffer.from("0123456789"));
    const receiver = new FileResumableArtifactReceiver(targetStore, path.join(root, "partial"), {
      maxArtifactBytes: 10,
    });
    await receiver.append(ref, 0, Buffer.from("01234"));

    expect(await receiver.discardPartialsBefore(new Date(Date.now() + 1_000))).toBe(1);
    expect(await receiver.progress(ref)).toEqual({ receivedBytes: 0, complete: false });
    await expect(receiver.progress({ ...ref, bytes: 11 })).rejects.toThrow(
      "configured byte limit",
    );
  });

  it("finalizes a complete durable prefix through concurrent exact replays", async () => {
    const root = await temporaryRoot();
    const targetStore = new FileArtifactStore(path.join(root, "target"));
    const sourceStore = new FileArtifactStore(path.join(root, "source"));
    const bytes = Buffer.from("fully durable before finalization");
    const ref = await sourceStore.put(bytes);
    const partialRoot = path.join(root, "partial");
    await mkdir(partialRoot, { recursive: true });
    await writeFile(
      path.join(partialRoot, `${ref.digest.slice("sha256:".length)}.${ref.bytes}.part`),
      bytes,
    );
    const receiver = new FileResumableArtifactReceiver(targetStore, partialRoot, {
      maxArtifactBytes: 100,
    });

    await expect(Promise.all([
      receiver.append(ref, 0, bytes),
      receiver.append(ref, 0, bytes),
    ])).resolves.toEqual([
      { receivedBytes: ref.bytes, complete: true },
      { receivedBytes: ref.bytes, complete: true },
    ]);
    expect(Buffer.from(await targetStore.get(ref)).equals(bytes)).toBe(true);
  });

  it("retains a complete durable prefix across a retryable final-store failure", async () => {
    const root = await temporaryRoot();
    const targetStore = new FileArtifactStore(path.join(root, "target"));
    const sourceStore = new FileArtifactStore(path.join(root, "source"));
    const bytes = Buffer.from("retry finalization without retransmission");
    const ref = await sourceStore.put(bytes);
    let finalizationAttempts = 0;
    const transientStore: ArtifactStore = {
      put: (...args) => targetStore.put(...args),
      get: (...args) => targetStore.get(...args),
      has: (...args) => targetStore.has(...args),
      readRange: (...args) => targetStore.readRange(...args),
      async putVerifiedStream(...args) {
        finalizationAttempts += 1;
        if (finalizationAttempts === 1) throw new Error("transient final-store failure");
        await targetStore.putVerifiedStream(...args);
      },
    };
    const receiver = new FileResumableArtifactReceiver(
      transientStore,
      path.join(root, "partial"),
      { maxArtifactBytes: 100 },
    );

    await expect(receiver.append(ref, 0, bytes)).rejects.toThrow(
      "transient final-store failure",
    );
    await expect(receiver.append(ref, ref.bytes, new Uint8Array())).resolves.toEqual({
      receivedBytes: ref.bytes,
      complete: true,
    });
    expect(finalizationAttempts).toBe(2);
    expect(Buffer.from(await targetStore.get(ref)).equals(bytes)).toBe(true);
    expect(await readdir(path.join(root, "partial"))).toEqual([]);
  });
});

async function createFixture() {
  const root = await temporaryRoot();
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const nestedRef = await artifacts.put(Buffer.from("opaque attachment"));
  const record: TranscriptRunRecord = {
    type: "run",
    runId: "run-1",
    runIndex: 1,
    timestamp: "2026-07-21T00:00:00.000Z",
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "inspect",
          input: { attachment: nestedRef },
        }],
      },
    ],
  };
  const runRecordRef = await artifacts.put(Buffer.from(canonicalize(record), "utf8"));
  const bundle = createConversationSealedBundle({
    assignmentId: "assignment-1",
    executorId: "executor-1",
    streamFinal: { finalSeq: 1, streamDigest: DIGEST },
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
    usageFinal: { reportDigest: DIGEST, upToUsageSeq: 1 },
    dependencyArtifacts: [nestedRef],
    body: {
      t: "conversation",
      runId: "run-1",
      conversationId: "conversation-1",
      ownerEpoch: 1,
      baseRevision: 0,
      runRecord: { ref: runRecordRef },
      contentAssets: [],
    },
  });
  return { artifacts, bundle, nestedRef, runRecordRef };
}

async function temporaryRoot(): Promise<string> {
  return createTempDir("assignment-artifacts");
}
