import path from "node:path";
import { FileArtifactStore } from "@zhixing/core/authority";
import type {
  ExecutionRef,
  StreamConsumerAuth,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  StreamConsumerDegradedError,
  StreamHistoryUnavailableError,
} from "@zhixing/executor/assignment-stream-spool";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { SecureMeshConnection } from "@zhixing/mesh";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  ASSIGNMENT_STREAM_SERVICE,
  AssignmentStreamMeshClient,
  createAssignmentStreamServiceHandler,
} from "./assignment-stream-mesh.js";

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

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe("assignment stream mesh adapter", () => {
  it("binds authorization, fences the old path and preserves absolute sequence", async () => {
    const root = await createTempDir("assignment-stream-mesh");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const spool = new AssignmentStreamSpool(path.join(root, "spool"), artifacts);
    const writer = await AssignmentStreamWriter.open(
      spool,
      "assignment-fixed",
      ref,
    );
    await writer.appendYield({ type: "text_delta", text: "hello" });
    await spool.qualifyConsumer({
      assignmentId: "assignment-fixed",
      ref,
      consumer,
      expiresAt: "2026-07-24T00:00:00.000Z",
    });

    const authorized: string[] = [];
    const handler = createAssignmentStreamServiceHandler({
      spool,
      async authorize(request) {
        authorized.push(
          `${request.operation}:${request.connection.peer.deviceId}`,
        );
        return { expiresAt: "2026-07-24T00:00:00.000Z" };
      },
    });
    const firstConnection = connection("surface-one");
    const secondConnection = connection("surface-one");
    const first = new AssignmentStreamMeshClient(
      directClient(handler, firstConnection),
    );
    const second = new AssignmentStreamMeshClient(
      directClient(handler, secondConnection),
    );

    const firstFrames = await first.subscribe(subscribe(0));
    await writer.appendYield({ type: "text_delta", text: "world" });
    await writer.finalize();
    const secondFrames = await second.subscribe(subscribe(0));
    expect(firstFrames.map((frame) => frame.seq)).toEqual([1]);
    expect(secondFrames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(secondFrames[0]!.streamEpoch).toBeGreaterThan(
      firstFrames[0]!.streamEpoch,
    );
    await expect(first.subscribe(subscribe(0))).rejects.toThrow(/fenced/);
    await expect(
      first.acknowledge({
        v: 1,
        assignmentId: "assignment-fixed",
        consumer,
        ackSeq: 1,
      }),
    ).rejects.toThrow(/fenced/);

    await second.acknowledge({
      v: 1,
      assignmentId: "assignment-fixed",
      consumer,
      ackSeq: 3,
    });
    expect(authorized).toEqual([
      "subscribe:surface-one",
      "subscribe:surface-one",
      "subscribe:surface-one",
      "ack:surface-one",
      "ack:surface-one",
    ]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps independent consumers live and retries a rejected epoch initialization", async () => {
    const root = await createTempDir("assignment-stream-mesh-consumers");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const spool = new AssignmentStreamSpool(path.join(root, "spool"), artifacts);
    const writer = await AssignmentStreamWriter.open(
      spool,
      "assignment-fixed",
      ref,
    );
    await writer.appendYield({ type: "text_delta", text: "hello" });
    const secondConsumer: StreamConsumerAuth = {
      kind: "surface-ticket",
      ticketId: "ticket-second",
    };
    for (const qualified of [consumer, secondConsumer]) {
      await spool.qualifyConsumer({
        assignmentId: "assignment-fixed",
        ref,
        consumer: qualified,
        expiresAt: "2026-07-24T00:00:00.000Z",
      });
    }
    const originalBegin = spool.beginConnection.bind(spool);
    const begin = vi
      .spyOn(spool, "beginConnection")
      .mockRejectedValueOnce(new Error("temporary spool failure"))
      .mockImplementation(originalBegin);
    const handler = createAssignmentStreamServiceHandler({
      spool,
      authorize: async () => ({
        expiresAt: "2026-07-24T00:00:00.000Z",
      }),
    });
    const first = new AssignmentStreamMeshClient(
      directClient(handler, connection("surface-one")),
    );
    const second = new AssignmentStreamMeshClient(
      directClient(handler, connection("surface-two")),
    );

    await expect(first.subscribe(subscribe(0))).rejects.toThrow(
      /temporary spool failure/,
    );
    await expect(first.subscribe(subscribe(0))).resolves.toHaveLength(1);
    await expect(
      second.subscribe({
        ...subscribe(0),
        consumer: secondConsumer,
      }),
    ).resolves.toHaveLength(1);
    await expect(first.subscribe(subscribe(0))).resolves.toHaveLength(1);
    expect(begin).toHaveBeenCalledTimes(3);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects responses that do not bind the subscription", async () => {
    const client = new AssignmentStreamMeshClient({
      async request(serviceId) {
        expect(serviceId).toBe(ASSIGNMENT_STREAM_SERVICE);
        return Buffer.from(
          canonicalize({
            v: 1,
            t: "frames",
            frames: [
              {
                v: 1,
                ref,
                assignmentId: "another-assignment",
                streamEpoch: 1,
                seq: 1,
                payload: {
                  kind: "agent-yield",
                  yield: { type: "text_delta", text: "wrong" },
                },
                meta: {},
              },
            ],
          }),
          "utf8",
        );
      },
    });
    await expect(client.subscribe(subscribe(0))).rejects.toThrow(
      /does not bind/,
    );
  });

  it("rejects acknowledgments that do not bind the request", async () => {
    const client = new AssignmentStreamMeshClient({
      async request() {
        return Buffer.from(
          canonicalize({
            v: 1,
            t: "acked",
            assignmentId: "another-assignment",
            consumer,
            ackSeq: 1,
          }),
          "utf8",
        );
      },
    });

    await expect(
      client.acknowledge({
        v: 1,
        assignmentId: "assignment-fixed",
        consumer,
        ackSeq: 1,
      }),
    ).rejects.toThrow(/does not bind/);
  });

  it("preserves typed consumer terminal states across mesh", async () => {
    const terminalClient = (body: unknown) =>
      new AssignmentStreamMeshClient({
        async request() {
          return Buffer.from(canonicalize(body), "utf8");
        },
      });

    await expect(
      terminalClient({
        v: 1,
        t: "consumer-degraded",
        assignmentId: "assignment-fixed",
        consumer,
      }).subscribe(subscribe(0)),
    ).rejects.toBeInstanceOf(StreamConsumerDegradedError);
    await expect(
      terminalClient({
        v: 1,
        t: "history-unavailable",
        assignmentId: "assignment-fixed",
        consumer,
        requestedAfterSeq: 0,
        prunedThrough: 3,
      }).subscribe(subscribe(0)),
    ).rejects.toBeInstanceOf(StreamHistoryUnavailableError);
  });
});

function subscribe(afterSeq: number): StreamSubscribe {
  return {
    v: 1,
    ref,
    assignmentId: "assignment-fixed",
    consumer,
    afterSeq,
  };
}

function directClient(
  handler: ReturnType<typeof createAssignmentStreamServiceHandler>,
  meshConnection: SecureMeshConnection,
): MeshServiceClient {
  return {
    request(serviceId, payload, signal) {
      expect(serviceId).toBe(ASSIGNMENT_STREAM_SERVICE);
      return handler(
        payload,
        meshConnection,
        signal ?? new AbortController().signal,
      );
    },
  };
}

function connection(deviceId: string): SecureMeshConnection {
  return {
    peer: { deviceId, publicKey: "test-public-key" },
  } as unknown as SecureMeshConnection;
}
