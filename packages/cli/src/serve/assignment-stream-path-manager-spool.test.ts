import fs from "node:fs/promises";
import path from "node:path";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type {
  ExecutionRef,
  StreamAck,
  StreamConsumerAuth,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
} from "@zhixing/executor/assignment-stream-spool";
import type { SecureMeshConnection } from "@zhixing/mesh";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  createAssignmentStreamServiceHandler,
  createInProcessAssignmentStreamClient,
  type AssignmentStreamClient,
} from "./assignment-stream-mesh.js";
import {
  AssignmentStreamPathManager,
  AssignmentStreamPathUnavailableError,
  type AssignmentStreamPathConnection,
  type AssignmentStreamPathConnector,
} from "./assignment-stream-path-manager.js";

// 真实生产者 → spool → 进程内流服务 → 路径管理器：确认按订阅页累积提交，帧、显示与恢复语义不变。

const ASSIGNMENT_ID = "assignment-fixed";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 120_000;

const ref: ExecutionRef = {
  execution: "conversation",
  runId: "run-fixed",
  conversationId: "conversation-fixed",
  ownerEpoch: 0,
};

const consumer: StreamConsumerAuth = {
  kind: "surface-ticket",
  ticketId: "ticket-fixed",
};

const jobRef: ExecutionRef = {
  execution: "job",
  taskId: "task-fixed",
  jobRunId: "job-fixed",
  anchorEpoch: 4,
};

const ownerRelay: StreamConsumerAuth = {
  kind: "owner-relay",
  authority: { execution: "job", taskId: "task-fixed", anchorEpoch: 4 },
  controlLeaseId: "lease-1",
};

describe("AssignmentStreamPathManager 按订阅页确认（真实 spool）", () => {
  it("多帧页只提交一笔累积确认，单帧页即时确认，帧与显示不变", async () => {
    const chain = await openChain();
    await chain.writer.appendYield({ type: "text_delta", text: "a" });
    const reader = chain.reader();

    await expect(reader.manager.poll()).resolves.toMatchObject({ accepted: 1, checkpoint: { lastSeq: 1 } });
    expect(await chain.ackSeqs()).toEqual([1]);

    for (const text of ["b", "c", "d", "e"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    await chain.writer.finalize();
    await expect(reader.manager.poll()).resolves.toMatchObject({
      accepted: 5,
      checkpoint: { lastSeq: 6, finalSeq: 6 },
    });

    expect(reader.adopted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(reader.texts).toEqual(["a", "b", "c", "d", "e"]);
    // 最终帧采纳前先确认前缀，页末再确认最终帧：两笔，而不是逐帧五笔。
    expect(await chain.ackSeqs()).toEqual([1, 5, 6]);
    expect(reader.ackAtAdoption.get(6)).toBe(5);
    const records = await chain.records();
    expect(records.filter((body) => body.t === "frame")).toHaveLength(6);
    expect(records.filter((body) => body.t === "pruned").length).toBeLessThanOrEqual(3);
    const snapshot = await chain.spool.snapshot(ASSIGNMENT_ID);
    expect(snapshot.prunedThrough).toBe(6);
    expect(snapshot.retainedBytes).toBe(0);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("交互帧采纳前先确认此前已采纳的前缀", async () => {
    const chain = await openChain();
    await chain.writer.appendYield({ type: "text_delta", text: "before" });
    await chain.writer.appendYield({ type: "text_delta", text: "more" });
    await chain.writer.appendInteractionRequested({
      requestId: "interaction-1",
      toolName: "bash",
      display: { title: "Approve?", lines: ["run"] },
      issuedAt: "2026-10-29T00:00:00.000Z",
      ttlMs: 60_000,
      expiresAt: "2026-10-29T00:01:00.000Z",
    });
    await chain.writer.appendYield({ type: "text_delta", text: "after" });
    const reader = chain.reader();

    await expect(reader.manager.poll()).resolves.toMatchObject({ accepted: 4, checkpoint: { lastSeq: 4 } });
    expect(reader.ackAtAdoption.get(3)).toBe(2);
    expect(await chain.ackSeqs()).toEqual([2, 4]);
    expect(reader.texts).toEqual(["before", "more", "after"]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("两个独立消费者各按自己的页确认，裁剪只推进到较低水位", async () => {
    const second: StreamConsumerAuth = { kind: "surface-ticket", ticketId: "ticket-second" };
    const chain = await openChain([consumer, second]);
    for (const text of ["x", "y", "z"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    const first = chain.reader();
    const other = chain.reader({ consumer: second });

    await first.manager.poll();
    expect((await chain.spool.snapshot(ASSIGNMENT_ID)).prunedThrough).toBe(0);
    await other.manager.poll();
    expect((await chain.spool.snapshot(ASSIGNMENT_ID)).prunedThrough).toBe(3);

    await chain.writer.finalize();
    await first.manager.poll();
    await other.manager.poll();
    expect(first.texts).toEqual(["x", "y", "z"]);
    expect(other.texts).toEqual(["x", "y", "z"]);
    const acks = await chain.ackRecords();
    const byConsumer = new Map<string, number[]>();
    for (const ack of acks) byConsumer.set(ack.key, [...(byConsumer.get(ack.key) ?? []), ack.ackSeq]);
    expect([...byConsumer.values()]).toEqual([[3, 4], [3, 4]]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("页中采纳失败时确认已成功的前缀，重试从该处接续且不重复展示", async () => {
    const chain = await openChain();
    for (const text of ["1", "2", "3", "4"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    const reader = chain.reader({ failAdoptOnce: 3 });

    await expect(reader.manager.poll()).rejects.toThrow(/adopt failed at 3/);
    expect(reader.manager.checkpoint().lastSeq).toBe(2);
    expect(await chain.ackSeqs()).toEqual([2]);

    await expect(reader.manager.poll()).resolves.toMatchObject({ accepted: 2, checkpoint: { lastSeq: 4 } });
    expect(reader.adopted).toEqual([1, 2, 3, 4]);
    expect(reader.texts).toEqual(["1", "2", "3", "4"]);
    expect(await chain.ackSeqs()).toEqual([2, 4]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("前缀确认也失败时，下一次订阅前先补上确认", async () => {
    const chain = await openChain();
    for (const text of ["1", "2", "3", "4"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    const reader = chain.reader({ failAdoptOnce: 3, failAckOnce: { ackSeq: 2, phase: "before-commit", error: () => new Error("ack transport stalled") } });

    await expect(reader.manager.poll()).rejects.toThrow(/adopt failed at 3/);
    expect(await chain.ackSeqs()).toEqual([]);

    await expect(reader.manager.poll()).resolves.toMatchObject({ accepted: 2, checkpoint: { lastSeq: 4 } });
    expect(reader.subscriptions).toEqual([0, 2]);
    expect(reader.adopted).toEqual([1, 2, 3, 4]);
    expect(await chain.ackSeqs()).toEqual([2, 4]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("确认在提交前失败或提交后回包丢失，都切路径按检查点接续、不丢不重", async () => {
    const chain = await openChain();
    for (const text of ["1", "2", "3"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    const reader = chain.reader({
      failAckOnce: { ackSeq: 3, phase: "before-commit", error: () => new AssignmentStreamPathUnavailableError("ack request lost") },
    });

    await expect(reader.manager.poll()).resolves.toMatchObject({ path: "relay", accepted: 3, checkpoint: { lastSeq: 3 } });
    expect(await chain.ackSeqs()).toEqual([3]);

    for (const text of ["4", "5"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    await chain.writer.finalize();
    reader.failAckOnce({ ackSeq: 6, phase: "after-commit", error: () => new AssignmentStreamPathUnavailableError("ack response lost") });
    await expect(reader.manager.poll()).resolves.toMatchObject({ path: "direct", accepted: 3, checkpoint: { lastSeq: 6, finalSeq: 6 } });

    expect(reader.adopted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(reader.texts).toEqual(["1", "2", "3", "4", "5"]);
    expect(await chain.ackSeqs()).toEqual([3, 5, 6]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("采纳中途取消后，下一次 poll 补确认已采纳前缀再继续", async () => {
    const chain = await openChain();
    for (const text of ["1", "2", "3", "4"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    const cancel = new AbortController();
    const reader = chain.reader({ abortAt: { seq: 3, controller: cancel } });

    await expect(reader.manager.poll(cancel.signal)).rejects.toThrow(/cancelled at 3/);
    expect(reader.manager.checkpoint().lastSeq).toBe(2);

    await expect(reader.manager.poll()).resolves.toMatchObject({ checkpoint: { lastSeq: 4 } });
    expect(reader.adopted).toEqual([1, 2, 3, 4]);
    expect((await chain.ackSeqs()).at(-1)).toBe(4);
    expect(new Set(await chain.ackSeqs()).size).toBe((await chain.ackSeqs()).length);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("页中撤销消费者时，页末确认失败如实抛出、不转去另一条路径", async () => {
    const chain = await openChain();
    for (const text of ["1", "2", "3"]) {
      await chain.writer.appendYield({ type: "text_delta", text });
    }
    const reader = chain.reader({
      onAdopt: async (seq) => {
        if (seq === 2) await chain.spool.revokeConsumer({ assignmentId: ASSIGNMENT_ID, consumer });
      },
    });

    await expect(reader.manager.poll()).rejects.toThrow();
    expect(reader.relayOpens).toBe(0);
    expect(await chain.ackSeqs()).toEqual([]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  // surface 消费者滞后超过容量一半即降级（不阻塞生产者）；真正承受背压的是 job 的 owner-relay 消费者。
  it("容量满时生产者等待页末确认释放空间，全部帧按序送达", async () => {
    const frameBytes = await measureFrameBytes(jobRef, ownerRelay);
    const chain = await openChain([ownerRelay], { capacityBytes: frameBytes * 3, ref: jobRef });
    const texts = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const produced = (async () => {
      for (const text of texts) {
        await chain.writer.appendYield({ type: "text_delta", text });
      }
      await chain.writer.finalize();
    })();
    // 消费者开始前，生产者写满三帧后停在容量处等待释放。
    while ((await chain.spool.snapshot(ASSIGNMENT_ID)).lastSeq < 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await chain.spool.snapshot(ASSIGNMENT_ID)).lastSeq).toBe(3);
    const reader = chain.reader({ consumer: ownerRelay });

    while (reader.manager.checkpoint().finalSeq === undefined) {
      const result = await reader.manager.poll();
      if (result.accepted === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await chain.spool.snapshot(ASSIGNMENT_ID)).retainedBytes).toBeLessThanOrEqual(frameBytes * 3);
    }
    await produced;
    expect(reader.texts).toEqual(texts);
    expect(reader.adopted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});

interface AckFailure {
  readonly ackSeq: number;
  readonly phase: "before-commit" | "after-commit";
  readonly error: () => Error;
}

interface ReaderOptions {
  readonly consumer?: StreamConsumerAuth;
  readonly failAdoptOnce?: number;
  readonly failAckOnce?: AckFailure;
  readonly abortAt?: { readonly seq: number; readonly controller: AbortController };
  readonly onAdopt?: (seq: number) => Promise<void>;
}

async function openChain(
  consumers: readonly StreamConsumerAuth[] = [consumer],
  options: { readonly capacityBytes?: number; readonly ref?: ExecutionRef } = {},
) {
  const root = await createTempDir("assignment-stream-page-ack");
  const chainRef = options.ref ?? ref;
  const spool = new AssignmentStreamSpool(
    path.join(root, "spool"),
    new FileArtifactStore(path.join(root, "artifacts")),
    options.capacityBytes === undefined ? {} : { capacityBytes: options.capacityBytes },
  );
  const writer = await AssignmentStreamWriter.open(spool, ASSIGNMENT_ID, chainRef);
  for (const qualified of consumers) {
    await spool.qualifyConsumer({ assignmentId: ASSIGNMENT_ID, ref: chainRef, consumer: qualified, ...expiryOf(qualified) });
  }
  const handler = createAssignmentStreamServiceHandler({
    spool,
    authorize: async (request) => expiryOf(request.consumer),
  });
  let connections = 0;
  const records = async () => {
    const assignments = path.join(root, "spool", "assignments");
    const [key] = await fs.readdir(assignments);
    const directory = path.join(assignments, key!);
    const log = new FileAuthorityCommitLog(
      path.join(directory, "index"),
      new FileArtifactStore(path.join(directory, "frames")),
      { readOnly: true },
    );
    const commits = await log.readAll();
    return commits.flatMap((commit) =>
      commit.entries.map((entry) => entry.body as { readonly t: string; readonly key?: string; readonly ackSeq?: number }),
    );
  };
  const ackRecords = async () =>
    (await records())
      .filter((body) => body.t === "ack")
      .map((body) => ({ key: body.key!, ackSeq: body.ackSeq! }));
  return {
    spool,
    writer,
    records,
    ackRecords,
    ackSeqs: async () => (await ackRecords()).map((ack) => ack.ackSeq),
    reader(readerOptions: ReaderOptions = {}) {
      const readerConsumer = readerOptions.consumer ?? consumer;
      const adopted: number[] = [];
      const texts: string[] = [];
      const subscriptions: number[] = [];
      const ackAtAdoption = new Map<number, number>();
      let pendingAckFailure = readerOptions.failAckOnce;
      let pendingAdoptFailure = readerOptions.failAdoptOnce;
      let pendingAbort = readerOptions.abortAt;
      let relayOpens = 0;
      const open = (): AssignmentStreamPathConnection =>
        observedConnection(
          createInProcessAssignmentStreamClient(handler, meshConnection(`surface-${++connections}`)),
          {
            onSubscribe: (request) => subscriptions.push(request.afterSeq),
            takeAckFailure: (ack) => {
              if (pendingAckFailure?.ackSeq !== ack.ackSeq) return undefined;
              const failure = pendingAckFailure;
              pendingAckFailure = undefined;
              return failure;
            },
          },
        );
      const direct: AssignmentStreamPathConnector = { open: async () => open() };
      const relay: AssignmentStreamPathConnector = {
        open: async () => {
          relayOpens += 1;
          return open();
        },
      };
      const manager = new AssignmentStreamPathManager({
        assignmentId: ASSIGNMENT_ID,
        ref: chainRef,
        consumer: readerConsumer,
        direct,
        relay,
        async adoptFrame(frame, _checkpoint, signal, readDisplay) {
          if (pendingAdoptFailure === frame.seq) {
            pendingAdoptFailure = undefined;
            throw new Error(`adopt failed at ${frame.seq}`);
          }
          if (pendingAbort?.seq === frame.seq) {
            const { controller } = pendingAbort;
            pendingAbort = undefined;
            controller.abort(new Error(`cancelled at ${frame.seq}`));
            signal.throwIfAborted();
          }
          const snapshot = await spool.snapshot(ASSIGNMENT_ID);
          const own = snapshot.consumers.find((candidate) => candidate.key.endsWith(readerTicket(readerConsumer)));
          ackAtAdoption.set(frame.seq, own?.ackSeq ?? -1);
          if (frame.payload.kind === "agent-yield") {
            const display = await readDisplay();
            texts.push(displayText(display));
          }
          adopted.push(frame.seq);
          await readerOptions.onAdopt?.(frame.seq);
        },
      });
      return {
        manager,
        adopted,
        texts,
        subscriptions,
        ackAtAdoption,
        get relayOpens() {
          return relayOpens;
        },
        failAckOnce(failure: AckFailure) {
          pendingAckFailure = failure;
        },
      };
    },
  };
}

function observedConnection(
  client: AssignmentStreamClient,
  hooks: {
    readonly onSubscribe: (request: StreamSubscribe) => void;
    readonly takeAckFailure: (ack: StreamAck) => AckFailure | undefined;
  },
): AssignmentStreamPathConnection {
  return {
    async subscribe(request, signal) {
      hooks.onSubscribe(request);
      return client.subscribe(request, signal);
    },
    async acknowledge(ack, signal) {
      const failure = hooks.takeAckFailure(ack);
      if (failure?.phase === "before-commit") throw failure.error();
      await client.acknowledge(ack, signal);
      if (failure?.phase === "after-commit") throw failure.error();
    },
    ...(client.readArtifact
      ? { readArtifact: (request, signal) => client.readArtifact!(request, signal) }
      : {}),
  };
}

async function measureFrameBytes(frameRef: ExecutionRef, frameConsumer: StreamConsumerAuth): Promise<number> {
  const root = await createTempDir("assignment-stream-frame-bytes");
  const spool = new AssignmentStreamSpool(path.join(root, "spool"), new FileArtifactStore(path.join(root, "artifacts")));
  const writer = await AssignmentStreamWriter.open(spool, ASSIGNMENT_ID, frameRef);
  await spool.qualifyConsumer({ assignmentId: ASSIGNMENT_ID, ref: frameRef, consumer: frameConsumer, ...expiryOf(frameConsumer) });
  await writer.appendYield({ type: "text_delta", text: "1" });
  return (await spool.snapshot(ASSIGNMENT_ID)).retainedBytes;
}

// owner-relay 消费者不带到期时间，surface 票据必须带。
function expiryOf(auth: StreamConsumerAuth): { readonly expiresAt?: string } {
  return auth.kind === "surface-ticket" ? { expiresAt: EXPIRES_AT } : {};
}

function readerTicket(auth: StreamConsumerAuth): string {
  return auth.kind === "surface-ticket" ? auth.ticketId : auth.kind;
}

function displayText(display: unknown): string {
  const value = display as { readonly kind?: string; readonly yield?: { readonly text?: string } };
  return value.yield?.text ?? JSON.stringify(display);
}

function meshConnection(deviceId: string): SecureMeshConnection {
  return {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
}
