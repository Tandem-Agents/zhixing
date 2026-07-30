import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  ExecutionRef,
  StreamConsumerAuth,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import {
  StreamFrameVerifier,
  byteDigest,
  canonicalize,
  streamLogicalFrameDigest,
} from "@zhixing/core/protocol";
import type {
  DeviceCapacityAdmission,
  DeviceCapacityDimension,
  StorageMaintenanceGovernorPort,
  StorageMaintenanceRequest,
} from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  StreamConsumerDegradedError,
  StreamSpoolCapacityError,
} from "../assignment-stream-spool.js";

const ref: ExecutionRef = {
  execution: "conversation",
  runId: "run-fixed",
  conversationId: "conversation-fixed",
  ownerEpoch: 0,
};
const jobRef: ExecutionRef = {
  execution: "job",
  jobRunId: "jobrun-fixed",
  taskId: "task-fixed",
  anchorEpoch: 1,
};

const surface: StreamConsumerAuth = {
  kind: "surface-ticket",
  ticketId: "ticket-fixed",
};
const ownerRelay: StreamConsumerAuth = {
  kind: "owner-relay",
  authority: {
    execution: "job",
    taskId: jobRef.taskId,
    anchorEpoch: jobRef.anchorEpoch,
  },
  controlLeaseId: "lease-fixed",
};
const SURFACE_EXPIRY = "2026-07-24T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe(
  "AssignmentStreamSpool",
  { timeout: DURABLE_IO_TEST_TIMEOUT_MS },
  () => {
  it("fails closed on every class of malformed durable spool record", async () => {
    const invalidKind = await createFixture();
    await invalidKind.spool.open("assignment-fixed", ref);
    await rawSpoolLog(invalidKind, "assignment-fixed").append([
      {
        stream: "assignment:stream",
        body: {
          t: "consumer-qualified",
          key: "surface:ticket-fixed",
          kind: "future-consumer",
          expiresAt: SURFACE_EXPIRY,
        },
      },
    ]);
    await expect(
      restartedSpool(invalidKind).snapshot("assignment-fixed"),
    ).rejects.toThrow(/consumer kind is invalid/);

    const invalidScalar = await createFixture();
    await invalidScalar.spool.open("assignment-fixed", ref);
    await invalidScalar.spool.qualifyConsumer({
      assignmentId: "assignment-fixed",
      ref,
      consumer: surface,
      expiresAt: SURFACE_EXPIRY,
    });
    await rawSpoolLog(invalidScalar, "assignment-fixed").append([
      {
        stream: "assignment:stream",
        body: {
          t: "ack",
          key: "surface:ticket-fixed",
          ackSeq: "0",
        },
      },
    ]);
    await expect(
      restartedSpool(invalidScalar).snapshot("assignment-fixed"),
    ).rejects.toThrow(/non-negative safe integer/);

    const source = await createFixture();
    await source.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "interaction",
        event: {
          t: "requested",
          requestId: "request-fixed",
          toolName: "read",
          display: { title: "Read", lines: [] },
          issuedAt: "2026-07-23T00:00:00.000Z",
          ttlMs: 60_000,
          expiresAt: "2026-07-23T00:01:00.000Z",
        },
      },
    });
    const frameRecord = asRecord(
      (
        await rawSpoolLog(source, "assignment-fixed").readStream<unknown>(
          "assignment:stream",
        )
      ).find((entry) => asRecord(entry.body).t === "frame")!.body,
    );
    const invalidNested = await createFixture();
    await invalidNested.spool.open("assignment-fixed", ref);
    await rawSpoolLog(invalidNested, "assignment-fixed").append([
      {
        stream: "assignment:stream",
        body: {
          ...frameRecord,
          interaction: { t: "future", requestId: "request-fixed" },
        },
      },
    ]);
    await expect(
      restartedSpool(invalidNested).snapshot("assignment-fixed"),
    ).rejects.toThrow(/interaction kind is invalid/);

    const openedRecord = asRecord(
      (
        await rawSpoolLog(source, "assignment-fixed").readStream<unknown>(
          "assignment:stream",
        )
      )[0]!.body,
    );
    const invalidCheckpoint = await createFixture();
    await rawSpoolLog(invalidCheckpoint, "assignment-fixed").append([
      {
        stream: "assignment:stream",
        body: {
          ...openedRecord,
          verifier: {
            ...asRecord(openedRecord.verifier),
            head: `sha256:${"0".repeat(64)}`,
          },
        },
      },
    ]);
    await expect(
      restartedSpool(invalidCheckpoint).snapshot("assignment-fixed"),
    ).rejects.toThrow(/open checkpoint is inconsistent/);

    const prematureReclaim = await createFixture();
    await prematureReclaim.spool.open("assignment-fixed", ref);
    const final = await prematureReclaim.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });
    await prematureReclaim.spool.markTerminal("assignment-fixed", final.seq);
    await rawSpoolLog(prematureReclaim, "assignment-fixed").append([
      { stream: "assignment:stream", body: { t: "reclaimed" } },
    ]);
    await expect(
      restartedSpool(prematureReclaim).snapshot("assignment-fixed"),
    ).rejects.toThrow(/reclamation record is inconsistent/);

    const revokedConsumer = await createFixture();
    await revokedConsumer.spool.qualifyConsumer({
      assignmentId: "assignment-fixed",
      ref,
      consumer: surface,
      expiresAt: SURFACE_EXPIRY,
    });
    await revokedConsumer.spool.revokeConsumer({
      assignmentId: "assignment-fixed",
      consumer: surface,
    });
    await rawSpoolLog(revokedConsumer, "assignment-fixed").append([
      {
        stream: "assignment:stream",
        body: {
          t: "connection",
          key: "surface:ticket-fixed",
          streamEpoch: 1,
        },
      },
    ]);
    await expect(
      restartedSpool(revokedConsumer).snapshot("assignment-fixed"),
    ).rejects.toThrow(/unavailable consumer/);
  });

  it("treats durable reclamation as irreversible before the tombstone is written", async () => {
    const fixture = await createFixture();
    await fixture.spool.open("assignment-fixed", ref);
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });
    await fixture.spool.markTerminal("assignment-fixed", final.seq);
    fixture.now = "2026-07-24T00:00:00.000Z";
    await rawSpoolLog(fixture, "assignment-fixed").append([
      { stream: "assignment:stream", body: { t: "reclaimed" } },
    ]);

    await expect(
      restartedSpool(fixture).snapshot("assignment-fixed"),
    ).rejects.toThrow(/permanently reclaimed/);

    await rawSpoolLog(fixture, "assignment-fixed").append([
      {
        stream: "assignment:stream",
        body: {
          t: "consumer-qualified",
          key: "surface:new-ticket",
          kind: "surface-ticket",
          expiresAt: "2026-07-25T00:00:00.000Z",
        },
      },
    ]);
    await expect(
      restartedSpool(fixture).snapshot("assignment-fixed"),
    ).rejects.toThrow(/follows permanent reclamation/);
  });

  it("recovers the chain, replays after ACK loss and rewraps connection epochs", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    const data = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
    });
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });

    const restarted = new AssignmentStreamSpool(
      fixture.spoolRoot,
      fixture.artifacts,
      { clock: fixture.clock },
    );
    const replayEpoch = await restarted.beginConnection(
      "assignment-fixed",
      ref,
      surface,
    );
    const firstReplay = await restarted.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: replayEpoch,
      expiresAt: SURFACE_EXPIRY,
    });
    const secondReplay = await restarted.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: replayEpoch,
      expiresAt: SURFACE_EXPIRY,
    });

    expect(firstReplay.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(firstReplay.map((frame) => frame.streamEpoch)).toEqual([
      replayEpoch,
      replayEpoch,
    ]);
    expect(firstReplay.map(streamLogicalFrameDigest)).toEqual([
      streamLogicalFrameDigest(data),
      streamLogicalFrameDigest(final),
    ]);
    expect(secondReplay.map(streamLogicalFrameDigest)).toEqual(
      firstReplay.map(streamLogicalFrameDigest),
    );

    const verifier = new StreamFrameVerifier({
      assignmentId: "assignment-fixed",
      ref,
    });
    expect(firstReplay.map((frame) => verifier.accept(frame))).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("keeps a qualified surface active until the ticket registry explicitly revokes it", async () => {
    const fixture = await createFixture();
    await fixture.spool.qualifyConsumer({
      assignmentId: "assignment-fixed",
      ref,
      consumer: surface,
      expiresAt: SURFACE_EXPIRY,
    });
    const data = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
    });
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });

    fixture.now = "2026-07-25T00:00:00.000Z";
    const terminal = await fixture.spool.markTerminal(
      "assignment-fixed",
      final.seq,
    );
    expect(terminal.reclaimAfter).toBeUndefined();
    const epoch = await fixture.spool.beginConnection(
      "assignment-fixed",
      ref,
      surface,
    );
    await expect(
      fixture.spool.subscribe({
        request: subscribe(surface, 0),
        streamEpoch: epoch,
        expiresAt: SURFACE_EXPIRY,
      }),
    ).resolves.toMatchObject([{ seq: data.seq }, { seq: final.seq }]);
    await expect(
      fixture.spool.acknowledge(
        {
          v: 1,
          assignmentId: "assignment-fixed",
          consumer: surface,
          ackSeq: final.seq,
        },
        epoch,
      ),
    ).resolves.toMatchObject({
      prunedThrough: final.seq,
      reclaimAfter: expect.any(String),
    });

    await fixture.spool.revokeConsumer({
      assignmentId: "assignment-fixed",
      consumer: surface,
    });
    await expect(
      fixture.spool.beginConnection("assignment-fixed", ref, surface),
    ).rejects.toThrow("Stream consumer is not durably qualified");
  });

  it("persists cumulative ACK before reclamation and never resurrects reclaimed streams", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
    });
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });
    await fixture.spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    await fixture.spool.markTerminal("assignment-fixed", final.seq);
    const acknowledged = await fixture.spool.acknowledge(
      {
        v: 1,
        assignmentId: "assignment-fixed",
        consumer: surface,
        ackSeq: final.seq,
      },
      epoch,
    );

    expect(acknowledged.prunedThrough).toBe(final.seq);
    expect(acknowledged.retainedBytes).toBe(0);
    expect(acknowledged.reclaimAfter).toBe("2026-07-24T00:00:00.000Z");

    const restarted = new AssignmentStreamSpool(
      fixture.spoolRoot,
      fixture.artifacts,
      { clock: fixture.clock },
    );
    await expect(restarted.snapshot("assignment-fixed")).resolves.toMatchObject({
      prunedThrough: final.seq,
      retainedBytes: 0,
    });
    fixture.now = "2026-07-24T00:00:00.000Z";
    await expect(
      restarted.reclaimDue("assignment-fixed"),
    ).resolves.toBe(true);
    await expect(
      restarted.open("assignment-fixed", ref),
    ).rejects.toThrow(/permanently reclaimed/);
  });

  it("discovers durable assignments through bounded governed pages", async () => {
    const fixture = await createFixture();
    const expected = Array.from(
      { length: 40 },
      (_, index) => `assignment-page-${index.toString().padStart(2, "0")}`,
    );
    for (const assignmentId of expected) {
      await fixture.spool.open(assignmentId, ref);
    }
    let physicalSteps = 0;
    const runPhysicalStep = async <T>(operation: () => Promise<T>): Promise<T> => {
      physicalSteps += 1;
      return operation();
    };

    const first = await fixture.spool.assignmentIdPage(32, runPhysicalStep);
    const second = await fixture.spool.assignmentIdPage(32, runPhysicalStep);

    expect(first).toHaveLength(32);
    expect(second).toHaveLength(8);
    expect(new Set([...first, ...second])).toEqual(new Set(expected));
    // 两个目录页 + 每个 assignment 的 sidecar 读取；单轮仍由 limit 固定上界。
    expect(physicalSteps).toBe(42);
    await fixture.spool.closeAssignmentScan();
  });

  it("backfills a bounded identity sidecar for a legacy spool directory", async () => {
    const fixture = await createFixture();
    const assignmentId = "assignment-legacy";
    await fixture.spool.open(assignmentId, ref);
    const assignmentDirectory = path.join(
      fixture.spoolRoot,
      "assignments",
      byteDigest(Buffer.from(assignmentId, "utf8")).slice("sha256:".length),
    );
    await rm(path.join(assignmentDirectory, "identity.json"));
    let physicalSteps = 0;

    await expect(
      fixture.spool.assignmentIdPage(1, async (operation) => {
        physicalSteps += 1;
        return operation();
      }),
    ).resolves.toEqual([assignmentId]);
    await expect(
      readFile(path.join(assignmentDirectory, "identity.json"), "utf8"),
    ).resolves.toContain(assignmentId);
    // 目录游标、sidecar 探测、日志 tail 与 sidecar 回填各自是独立物理步骤；
    // 日志格式恢复不再嵌套在目录发现 permit 内。
    expect(physicalSteps).toBe(4);
    await fixture.spool.closeAssignmentScan();
  });

  it("governs both internal log constructors without nesting the discovery step", async () => {
    const root = await createTempDir("assignment-stream-spool-governor");
    const spoolRoot = path.join(root, "spool");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const assignmentId = "assignment-governed-log";
    const key = byteDigest(Buffer.from(assignmentId, "utf8")).slice(
      "sha256:".length,
    );
    const assignmentDirectory = path.join(spoolRoot, "assignments", key);
    const indexDirectory = path.join(assignmentDirectory, "index");
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(path.join(indexDirectory, "authority.log"), Buffer.alloc(0));
    const governor = recordingStorageGovernor();
    const spool = new AssignmentStreamSpool(spoolRoot, artifacts, {
      clock: () => "2026-07-23T00:00:00.000Z",
      storageMaintenance: governor.port,
    });

    await spool.open(assignmentId, ref);
    expect(
      governor.requests.some(({ kind }) => kind === "log-migration"),
    ).toBe(true);

    await rm(path.join(assignmentDirectory, "identity.json"));
    await rm(path.join(indexDirectory, "authority.log.identity"));
    governor.requests.length = 0;
    let insideDiscoveryStep = false;
    const restarted = new AssignmentStreamSpool(spoolRoot, artifacts, {
      clock: () => "2026-07-23T00:00:00.000Z",
      storageMaintenance: governor.port,
    });
    await expect(
      restarted.assignmentIdPage(1, async (operation) => {
        expect(insideDiscoveryStep).toBe(false);
        insideDiscoveryStep = true;
        try {
          return await operation();
        } finally {
          insideDiscoveryStep = false;
        }
      }),
    ).resolves.toEqual([assignmentId]);
    expect(
      governor.requests.some(({ kind }) => kind === "log-migration"),
    ).toBe(true);
    expect(insideDiscoveryStep).toBe(false);
    restarted.stopStorageMaintenance();
    await restarted.closeAssignmentScan();
  });

  it("degrades a slow surface without blocking a fast consumer", async () => {
    const fixture = await createFixture(1_500);
    const fast: StreamConsumerAuth = {
      kind: "surface-ticket",
      ticketId: "ticket-fast",
    };
    const slow: StreamConsumerAuth = {
      kind: "surface-ticket",
      ticketId: "ticket-slow",
    };
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      fast,
      SURFACE_EXPIRY,
    );

    const first = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "a".repeat(260) },
      },
    });
    await fixture.spool.subscribe({
      request: subscribe(fast, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    const slowEpoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      slow,
      SURFACE_EXPIRY,
    );
    await fixture.spool.subscribe({
      request: subscribe(slow, 0),
      streamEpoch: slowEpoch,
      expiresAt: SURFACE_EXPIRY,
    });
    await fixture.spool.acknowledge(
      {
        v: 1,
        assignmentId: "assignment-fixed",
        consumer: fast,
        ackSeq: first.seq,
      },
      epoch,
    );

    const second = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "b".repeat(260) },
      },
    });
    const fastFrames = await fixture.spool.subscribe({
      request: subscribe(fast, first.seq),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    expect(fastFrames.map((frame) => frame.seq)).toEqual([second.seq]);
    await fixture.spool.acknowledge(
      {
        v: 1,
        assignmentId: "assignment-fixed",
        consumer: fast,
        ackSeq: second.seq,
      },
      epoch,
    );

    const snapshot = await fixture.spool.snapshot("assignment-fixed");
    expect(
      snapshot.consumers.find((consumer) => consumer.key === "surface:ticket-slow")
        ?.degraded,
    ).toBe(true);
    expect(snapshot.prunedThrough).toBe(second.seq);
    expect(snapshot.retainedBytes).toBe(0);
    await expect(
      fixture.spool.subscribe({
        request: subscribe(slow, 0),
        streamEpoch: slowEpoch,
        expiresAt: SURFACE_EXPIRY,
      }),
    ).rejects.toBeInstanceOf(StreamConsumerDegradedError);
  });

  it("releases backpressure after the only surface consumer is degraded", async () => {
    const fixture = await createFixture(1_500);
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "a".repeat(260) },
      },
    });
    await fixture.spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "b".repeat(260) },
      },
    });
    const third = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "c".repeat(260) },
      },
    });

    const snapshot = await fixture.spool.snapshot("assignment-fixed");
    expect(snapshot.consumers[0]?.degraded).toBe(true);
    expect(snapshot.prunedThrough).toBe(2);
    expect(snapshot.lastSeq).toBe(third.seq);
  });

  it("disarms pending reclamation when a new valid consumer subscribes", async () => {
    const fixture = await createFixture();
    await fixture.spool.open("assignment-fixed", ref);
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });
    const armed = await fixture.spool.markTerminal(
      "assignment-fixed",
      final.seq,
    );
    expect(armed.reclaimAfter).toBeDefined();

    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    await fixture.spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    expect(
      (await fixture.spool.snapshot("assignment-fixed")).reclaimAfter,
    ).toBeUndefined();
  });

  it("rejects one frame that can never fit instead of waiting forever", async () => {
    const fixture = await createFixture(256);
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    await expect(
      fixture.spool.append({
        assignmentId: "assignment-fixed",
        ref,
        payload: {
          kind: "agent-yield",
          yield: { type: "text_delta", text: "x".repeat(1_000) },
        },
      }),
    ).rejects.toBeInstanceOf(StreamSpoolCapacityError);
  });

  it("cancels a producer waiting on bounded spool capacity", async () => {
    const fixture = await createFixture(900);
    await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "a".repeat(260) },
      },
    });
    const abort = new AbortController();
    const blocked = fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      signal: abort.signal,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "b".repeat(260) },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort(new Error("producer cancelled"));

    await expect(blocked).rejects.toThrow("producer cancelled");
    expect((await fixture.spool.snapshot("assignment-fixed")).lastSeq).toBe(1);
  });

  it("cleans an uncommitted final frame when capacity waiting is cancelled", async () => {
    const fixture = await createFixture(700);
    await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "a".repeat(260) },
      },
    });
    const before = await storedArtifactFiles(fixture.spoolRoot);
    const abort = new AbortController();
    const blocked = fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
      signal: abort.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort(new Error("final cancelled"));

    await expect(blocked).rejects.toThrow("final cancelled");
    expect(await storedArtifactFiles(fixture.spoolRoot)).toEqual(before);
  });

  it("externalizes a large item before enforcing the bounded transport envelope", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    const frame = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "x".repeat(600 * 1024) },
      },
    });
    expect(frame.payload.kind).toBe("agent-yield");
    if (frame.payload.kind !== "agent-yield") return;
    expect("ref" in frame.payload.yield).toBe(true);
  });

  it("validates producer semantics before creating durable artifacts", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.spool.append({
        assignmentId: "assignment-fixed",
        ref,
        payload: {
          kind: "agent-yield",
          yield: { type: "text_delta", text: 42 },
        } as never,
      }),
    ).rejects.toThrow();

    expect((await fixture.spool.snapshot("assignment-fixed")).lastSeq).toBe(0);
    expect(
      await storedArtifactFiles(path.join(fixture.spoolRoot, "assignments")),
    ).toEqual([]);
  });

  it("does not let an artifact reference hide an invalid producer value", async () => {
    const root = await createTempDir("assignment-stream-invalid-source");
    const bytes = Buffer.from(
      canonicalize({
        type: "text_delta",
        text: 42,
        padding: "x".repeat(40 * 1024),
      }),
      "utf8",
    );
    const sourceRef = { digest: byteDigest(bytes), bytes: bytes.byteLength };
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      {
        put: async () => sourceRef,
        get: async () => bytes,
        has: async () => true,
        withPresentReferences: async (_refs, operation) => operation(),
      },
    );

    await expect(
      spool.append({
        assignmentId: "assignment-fixed",
        ref,
        payload: {
          kind: "agent-yield",
          yield: { ref: sourceRef },
        },
      }),
    ).rejects.toThrow();
    expect((await spool.snapshot("assignment-fixed")).lastSeq).toBe(0);
  });

  it("owns copied content independently from its producer artifact store", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    const yielded = {
      type: "text_delta" as const,
      text: "x".repeat(40 * 1024),
    };
    const sourceRef = await fixture.artifacts.put(
      Buffer.from(canonicalize(yielded), "utf8"),
    );
    const frame = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      sourceId: "yield-fixed",
      payload: { kind: "agent-yield", yield: { ref: sourceRef } },
    });
    await rm(fixture.artifacts.pathFor(sourceRef), { force: true });

    const replay = await fixture.spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    expect(replay).toEqual([frame]);
    expect(
      Buffer.from(
        await fixture.spool.readRetainedArtifact(
          "assignment-fixed",
          sourceRef,
        ),
    ).toString("utf8"),
    ).toBe(canonicalize(yielded));
  });

  it("charges externalized content to capacity and cleans failed preparation", async () => {
    const fixture = await createFixture(32 * 1024);
    await expect(
      fixture.spool.append({
        assignmentId: "assignment-fixed",
        ref,
        payload: {
          kind: "agent-yield",
          yield: { type: "text_delta", text: "x".repeat(40 * 1024) },
        },
      }),
    ).rejects.toBeInstanceOf(StreamSpoolCapacityError);

    expect((await fixture.spool.snapshot("assignment-fixed")).retainedBytes).toBe(0);
    expect(
      await storedArtifactFiles(path.join(fixture.spoolRoot, "assignments")),
    ).toEqual([]);
  });

  it("redrives a committed physical deletion failure without restarting", async () => {
    const root = await createTempDir("assignment-stream-delete-retry");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let failDeletion = true;
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      {
        removeRetiredArtifact: async (store, artifact) => {
          if (failDeletion) {
            failDeletion = false;
            throw new Error("temporary delete failure");
          }
          await rm(store.pathFor(artifact), { force: true });
        },
      },
    );
    const epoch = await qualifyAndConnect(
      spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    const frame = await spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
    });
    await spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });

    await expect(
      spool.acknowledge(
        {
          v: 1,
          assignmentId: "assignment-fixed",
          consumer: surface,
          ackSeq: frame.seq,
        },
        epoch,
      ),
    ).rejects.toThrow("temporary delete failure");
    await expect(spool.snapshot("assignment-fixed")).resolves.toMatchObject({
      prunedThrough: frame.seq,
      retainedBytes: 0,
    });
  });

  it("deduplicates stable producer identities even after frame reclamation", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    const input = {
      assignmentId: "assignment-fixed",
      ref,
      sourceId: "event-fixed",
      payload: {
        kind: "agent-yield" as const,
        yield: { type: "text_delta" as const, text: "hello" },
      },
    };
    const first = await fixture.spool.append(input);
    expect(await fixture.spool.append(input)).toEqual(first);
    await fixture.spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: epoch,
      expiresAt: SURFACE_EXPIRY,
    });
    await fixture.spool.acknowledge(
      {
        v: 1,
        assignmentId: "assignment-fixed",
        consumer: surface,
        ackSeq: first.seq,
      },
      epoch,
    );
    expect((await fixture.spool.snapshot("assignment-fixed")).prunedThrough).toBe(
      first.seq,
    );
    expect(await fixture.spool.append(input)).toEqual(first);
    await expect(
      fixture.spool.append({
        ...input,
        payload: {
          kind: "agent-yield",
          yield: { type: "text_delta", text: "different" },
        },
      }),
    ).rejects.toThrow(/conflicting logical content/);
  });

  it("fences reconnects per consumer and requires the matching ACK epoch", async () => {
    const fixture = await createFixture();
    const other: StreamConsumerAuth = {
      kind: "surface-ticket",
      ticketId: "ticket-other",
    };
    const firstEpoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    const otherEpoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      other,
      SURFACE_EXPIRY,
    );
    const frame = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
    });
    const nextEpoch = await fixture.spool.beginConnection(
      "assignment-fixed",
      ref,
      surface,
    );

    await expect(
      fixture.spool.subscribe({
        request: subscribe(surface, 0),
        streamEpoch: firstEpoch,
        expiresAt: SURFACE_EXPIRY,
      }),
    ).rejects.toThrow(/fenced connection epoch/);
    await expect(
      fixture.spool.subscribe({
        request: subscribe(other, 0),
        streamEpoch: otherEpoch,
        expiresAt: SURFACE_EXPIRY,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      fixture.spool.acknowledge(
        {
          v: 1,
          assignmentId: "assignment-fixed",
          consumer: surface,
          ackSeq: frame.seq,
        },
        firstEpoch,
      ),
    ).rejects.toThrow(/fenced connection epoch/);
    await fixture.spool.subscribe({
      request: subscribe(surface, 0),
      streamEpoch: nextEpoch,
      expiresAt: SURFACE_EXPIRY,
    });
    await expect(
      fixture.spool.acknowledge(
        {
          v: 1,
          assignmentId: "assignment-fixed",
          consumer: surface,
          ackSeq: frame.seq,
        },
        nextEpoch,
      ),
    ).resolves.toMatchObject({ lastSeq: frame.seq });
  });

  it("keeps qualified consumers in retention until revoke or expiry", async () => {
    const fixture = await createFixture();
    await fixture.spool.qualifyConsumer({
      assignmentId: "assignment-fixed",
      ref,
      consumer: surface,
      expiresAt: SURFACE_EXPIRY,
    });
    const frame = await fixture.spool.append({
      assignmentId: "assignment-fixed",
      ref,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "hello" },
      },
    });
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-fixed",
      ref,
    });
    const terminal = await fixture.spool.markTerminal(
      "assignment-fixed",
      final.seq,
    );
    expect(terminal.prunedThrough).toBe(0);
    expect(terminal.reclaimAfter).toBeUndefined();

    const revoked = await fixture.spool.revokeConsumer({
      assignmentId: "assignment-fixed",
      consumer: surface,
    });
    expect(revoked.prunedThrough).toBe(final.seq);
    expect(frame.seq).toBeLessThan(final.seq);
  });

  it("preserves job history until the required owner relay is qualified", async () => {
    const fixture = await createFixture();
    const surfaceEpoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-job",
      jobRef,
      surface,
      SURFACE_EXPIRY,
    );
    const frame = await fixture.spool.append({
      assignmentId: "assignment-job",
      ref: jobRef,
      payload: {
        kind: "agent-yield",
        yield: { type: "text_delta", text: "job output" },
      },
    });
    await fixture.spool.subscribe({
      request: {
        v: 1,
        ref: jobRef,
        assignmentId: "assignment-job",
        consumer: surface,
        afterSeq: 0,
      },
      streamEpoch: surfaceEpoch,
      expiresAt: SURFACE_EXPIRY,
    });
    await fixture.spool.acknowledge(
      {
        v: 1,
        assignmentId: "assignment-job",
        consumer: surface,
        ackSeq: frame.seq,
      },
      surfaceEpoch,
    );
    expect(
      (await fixture.spool.snapshot("assignment-job")).prunedThrough,
    ).toBe(0);

    const relayEpoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-job",
      jobRef,
      ownerRelay,
    );
    await expect(
      fixture.spool.subscribe({
        request: {
          v: 1,
          ref: jobRef,
          assignmentId: "assignment-job",
          consumer: ownerRelay,
          afterSeq: 0,
        },
        streamEpoch: relayEpoch,
      }),
    ).resolves.toEqual([frame]);
  });

  it("disarms the job fallback window when its owner relay appears", async () => {
    const fixture = await createFixture();
    await fixture.spool.open("assignment-job", jobRef);
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-job",
      ref: jobRef,
    });
    expect(
      (
        await fixture.spool.markTerminal(
          "assignment-job",
          final.seq,
        )
      ).reclaimAfter,
    ).toBe("2026-07-24T00:00:00.000Z");

    await fixture.spool.qualifyConsumer({
      assignmentId: "assignment-job",
      ref: jobRef,
      consumer: ownerRelay,
    });
    const relayEpoch = await fixture.spool.beginConnection(
      "assignment-job",
      jobRef,
      ownerRelay,
    );
    expect(
      (await fixture.spool.snapshot("assignment-job")).reclaimAfter,
    ).toBeUndefined();
    await expect(
      fixture.spool.subscribe({
        request: {
          v: 1,
          ref: jobRef,
          assignmentId: "assignment-job",
          consumer: ownerRelay,
          afterSeq: 0,
        },
        streamEpoch: relayEpoch,
      }),
    ).resolves.toEqual([final]);
    expect(
      (await fixture.spool.snapshot("assignment-job")).reclaimAfter,
    ).toBeUndefined();

    expect(
      (
        await fixture.spool.acknowledge(
          {
            v: 1,
            assignmentId: "assignment-job",
            consumer: ownerRelay,
            ackSeq: final.seq,
          },
          relayEpoch,
        )
      ).reclaimAfter,
    ).toBe("2026-07-24T00:00:00.000Z");
  });

  it("stores oversized producer items as content-addressed references", async () => {
    const fixture = await createFixture();
    const writer = await AssignmentStreamWriter.open(
      fixture.spool,
      "assignment-fixed",
      ref,
    );
    const yielded = {
      type: "text_delta" as const,
      text: "x".repeat(40 * 1024),
    };
    const frame = await writer.appendYield(yielded);
    if (
      frame.payload.kind !== "agent-yield" ||
      !("ref" in frame.payload.yield)
    ) {
      throw new TypeError("Oversized stream item was not externalized");
    }
    const stored = JSON.parse(
      Buffer.from(
        await fixture.spool.readRetainedArtifact(
          "assignment-fixed",
          frame.payload.yield.ref,
        ),
      ).toString("utf8"),
    );
    expect(stored).toEqual(yielded);
    expect(
      await fixture.spool.retainedArtifactReferences("assignment-fixed"),
    ).toEqual([frame.payload.yield.ref]);
  });

  it("starts the bounded job fallback window only after interactions are closed", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-job",
      jobRef,
      ownerRelay,
    );
    await fixture.spool.append({
      assignmentId: "assignment-job",
      ref: jobRef,
      payload: {
        kind: "interaction",
        event: {
          t: "requested",
          requestId: "request-fixed",
          toolName: "write",
          display: { title: "Approve", lines: ["write file"] },
          issuedAt: "2026-07-23T00:00:00.000Z",
          ttlMs: 60_000,
          expiresAt: "2026-07-23T00:01:00.000Z",
        },
      },
    });
    const final = await fixture.spool.finalize({
      assignmentId: "assignment-job",
      ref: jobRef,
    });
    expect(
      (
        await fixture.spool.markTerminal(
          "assignment-job",
          final.seq,
        )
      ).reclaimAfter,
    ).toBeUndefined();

    const closed = new AssignmentStreamSpool(
      path.join((await createTempDir("assignment-stream-spool-closed")), "spool"),
      fixture.artifacts,
      { clock: fixture.clock },
    );
    const closedEpoch = await qualifyAndConnect(
      closed,
      "assignment-job-closed",
      jobRef,
      ownerRelay,
    );
    await closed.append({
      assignmentId: "assignment-job-closed",
      ref: jobRef,
      streamEpoch: closedEpoch,
      payload: {
        kind: "interaction",
        event: {
          t: "requested",
          requestId: "request-fixed",
          toolName: "write",
          display: { title: "Approve", lines: ["write file"] },
          issuedAt: "2026-07-23T00:00:00.000Z",
          ttlMs: 60_000,
          expiresAt: "2026-07-23T00:01:00.000Z",
        },
      },
    });
    await closed.append({
      assignmentId: "assignment-job-closed",
      ref: jobRef,
      streamEpoch: closedEpoch,
      payload: {
        kind: "interaction",
        event: {
          t: "finished",
          requestId: "request-fixed",
          outcome: "expired",
        },
      },
    });
    const closedFinal = await closed.finalize({
      assignmentId: "assignment-job-closed",
      ref: jobRef,
      streamEpoch: closedEpoch,
    });
    await closed.subscribe({
      request: {
        v: 1,
        ref: jobRef,
        assignmentId: "assignment-job-closed",
        consumer: ownerRelay,
        afterSeq: 0,
      },
      streamEpoch: closedEpoch,
    });
    expect(
      (
        await closed.markTerminal(
          "assignment-job-closed",
          closedFinal.seq,
        )
      ).reclaimAfter,
    ).toBe("2026-07-24T00:00:00.000Z");
  });

  it("rejects frames that reference content absent from the source artifact store", async () => {
    const fixture = await createFixture();
    const epoch = await qualifyAndConnect(
      fixture.spool,
      "assignment-fixed",
      ref,
      surface,
      SURFACE_EXPIRY,
    );
    await expect(
      fixture.spool.append({
        assignmentId: "assignment-fixed",
        ref,
        payload: {
          kind: "interaction",
          event: {
            t: "requested",
            requestId: "request-fixed",
            toolName: "write",
            display: {
              ref: {
                digest:
                  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                bytes: 128,
              },
            },
            issuedAt: "2026-07-23T00:00:00.000Z",
            ttlMs: 60_000,
            expiresAt: "2026-07-23T00:01:00.000Z",
          },
        },
      }),
    ).rejects.toThrow(/Artifact is not present/);
  });
  },
);

function subscribe(
  consumer: StreamConsumerAuth,
  afterSeq: number,
): StreamSubscribe {
  return {
    v: 1,
    ref,
    assignmentId: "assignment-fixed",
    consumer,
    afterSeq,
  };
}

async function qualifyAndConnect(
  spool: AssignmentStreamSpool,
  assignmentId: string,
  executionRef: ExecutionRef,
  consumer: StreamConsumerAuth,
  expiresAt?: string,
): Promise<number> {
  await spool.qualifyConsumer({
    assignmentId,
    ref: executionRef,
    consumer,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  return spool.beginConnection(assignmentId, executionRef, consumer);
}

async function createFixture(capacityBytes?: number) {
  const root = await createTempDir("assignment-stream-spool");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  let now = "2026-07-23T00:00:00.000Z";
  const clock = () => now;
  const spoolRoot = path.join(root, "spool");
  const spool = new AssignmentStreamSpool(spoolRoot, artifacts, {
    clock,
    ...(capacityBytes === undefined ? {} : { capacityBytes }),
  });
  return {
    artifacts,
    clock,
    spool,
    spoolRoot,
    get now() {
      return now;
    },
    set now(value: string) {
      now = value;
    },
  };
}

function restartedSpool(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): AssignmentStreamSpool {
  return new AssignmentStreamSpool(
    fixture.spoolRoot,
    fixture.artifacts,
    { clock: fixture.clock },
  );
}

function rawSpoolLog(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  assignmentId: string,
): FileAuthorityCommitLog {
  const key = byteDigest(Buffer.from(assignmentId, "utf8")).slice(
    "sha256:".length,
  );
  const directory = path.join(
    fixture.spoolRoot,
    "assignments",
    key,
  );
  return new FileAuthorityCommitLog(
    path.join(directory, "index"),
    new FileArtifactStore(path.join(directory, "frames")),
    { clock: fixture.clock },
  );
}

function recordingStorageGovernor(): {
  readonly port: StorageMaintenanceGovernorPort;
  readonly requests: StorageMaintenanceRequest[];
} {
  const requests: StorageMaintenanceRequest[] = [];
  const permit = {
    granted: {
      occupancy: {
        memoryReservationBytes: Number.MAX_SAFE_INTEGER,
        temporaryBytes: Number.MAX_SAFE_INTEGER,
        slots: 1,
      },
      quantum: {
        readBytes: Number.MAX_SAFE_INTEGER,
        writeBytes: Number.MAX_SAFE_INTEGER,
        ioOperations: Number.MAX_SAFE_INTEGER,
      },
    },
    tryBegin: () => ({
      claim: (_dimension: DeviceCapacityDimension, _amount: number) => undefined,
      complete: () => undefined,
    }),
    release: () => undefined,
  };
  return {
    requests,
    port: {
      acquire: async (request): Promise<DeviceCapacityAdmission> => {
        requests.push(request);
        return { kind: "granted", permit };
      },
      snapshot: () => ({ queued: {}, inFlight: {} }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("Expected a plain record");
  }
  return value as Record<string, unknown>;
}

async function storedArtifactFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (/^[a-f0-9]{64}$/u.test(entry.name)) files.push(target);
    }
  };
  await walk(root);
  return files.sort();
}
