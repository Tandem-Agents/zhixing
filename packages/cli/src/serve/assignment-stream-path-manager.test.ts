import type {
  ExecutionRef,
  StreamAck,
  StreamConsumerAuth,
  StreamFrame,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import { StreamConsumerDegradedError } from "@zhixing/executor/assignment-stream-spool";
import { describe, expect, it, vi } from "vitest";
import {
  AssignmentStreamPathManager,
  AssignmentStreamPathsUnavailableError,
  AssignmentStreamPathUnavailableError,
  type AssignmentStreamPathConnection,
  type AssignmentStreamPathConnector,
} from "./assignment-stream-path-manager.js";

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

describe("AssignmentStreamPathManager", () => {
  it("prefers direct and keeps the logical stream identity out of transport selection", async () => {
    const adopted: number[] = [];
    const direct = scriptedConnector([
      connection({
        frames: [frame(1, 1, "direct")],
      }),
    ]);
    const relay = scriptedConnector([]);
    const manager = pathManager(direct, relay, adopted);

    await expect(manager.poll()).resolves.toMatchObject({
      path: "direct",
      accepted: 1,
      checkpoint: { lastSeq: 1 },
    });
    expect(adopted).toEqual([1]);
    expect(direct.opens).toHaveLength(1);
    expect(relay.opens).toHaveLength(0);
    expect(direct.connections[0]!.subscriptions).toEqual([
      expect.objectContaining({
        assignmentId: "assignment-fixed",
        ref,
        consumer,
        afterSeq: 0,
      }),
    ]);
  });

  it("falls back only for path unavailability and resumes on the relay", async () => {
    const adopted: number[] = [];
    const direct = scriptedConnector([
      new AssignmentStreamPathUnavailableError("direct unreachable"),
    ]);
    const relay = scriptedConnector([
      connection({
        frames: [frame(1, 2, "relay")],
      }),
    ]);
    const manager = pathManager(direct, relay, adopted);

    await expect(manager.poll()).resolves.toMatchObject({
      path: "relay",
      accepted: 1,
    });
    expect(adopted).toEqual([1]);
    expect(direct.opens).toHaveLength(1);
    expect(relay.opens).toHaveLength(1);
  });

  it("switches after a direct disconnect without losing or repeating a frame", async () => {
    const adopted: number[] = [];
    const first = connection({
      frames: [frame(1, 1, "first")],
      subscribeResults: [
        [frame(1, 1, "first")],
        new AssignmentStreamPathUnavailableError("direct disconnected"),
      ],
    });
    const relayConnection = connection({
      frames: [frame(2, 2, "second")],
    });
    const direct = scriptedConnector([first]);
    const relay = scriptedConnector([relayConnection]);
    const manager = pathManager(direct, relay, adopted);

    await expect(manager.poll()).resolves.toMatchObject({
      path: "direct",
      accepted: 1,
    });
    await expect(manager.poll()).resolves.toMatchObject({
      path: "relay",
      accepted: 1,
      checkpoint: { lastSeq: 2 },
    });
    expect(adopted).toEqual([1, 2]);
    expect(relayConnection.acknowledgments[0]).toMatchObject({ ackSeq: 1 });
    expect(relayConnection.subscriptions[0]).toMatchObject({ afterSeq: 1 });
  });

  it("restores direct transport from the same acknowledged cursor", async () => {
    const adopted: number[] = [];
    const direct = scriptedConnector([
      new AssignmentStreamPathUnavailableError("direct unavailable"),
      connection({ frames: [frame(2, 3, "direct-again")] }),
    ]);
    const relayConnection = connection({
      frames: [frame(1, 2, "relay")],
    });
    const relay = scriptedConnector([relayConnection]);
    const manager = pathManager(direct, relay, adopted);

    await expect(manager.poll()).resolves.toMatchObject({ path: "relay" });
    await manager.restoreDirect();
    await expect(manager.poll()).resolves.toMatchObject({
      path: "direct",
      checkpoint: { lastSeq: 2 },
    });
    expect(adopted).toEqual([1, 2]);
    expect(direct.connections[0]!.acknowledgments[0]).toMatchObject({
      ackSeq: 1,
    });
    expect(direct.connections[0]!.subscriptions[0]).toMatchObject({
      afterSeq: 1,
    });
  });

  it("drops a late frame from the superseded connection generation", async () => {
    const adopted: number[] = [];
    const pending = deferred<readonly StreamFrame[]>();
    const oldDirect = connection({
      frames: [],
      subscribeResults: [pending.promise],
    });
    const relayConnection = connection({
      frames: [frame(1, 2, "relay")],
    });
    const direct = scriptedConnector([oldDirect]);
    const relay = scriptedConnector([relayConnection]);
    const manager = pathManager(direct, relay, adopted);

    const polling = manager.poll();
    await vi.waitFor(() => {
      expect(oldDirect.subscriptions).toHaveLength(1);
    });
    await manager.fallbackToRelay();
    pending.resolve([frame(1, 1, "late-direct")]);

    await expect(polling).resolves.toMatchObject({
      path: "relay",
      checkpoint: { lastSeq: 1, streamEpoch: 2 },
    });
    expect(adopted).toEqual([1]);
    expect(oldDirect.closed).toBe(true);
  });

  it("re-ACKs an adopted frame before subscribing after an ACK response is lost", async () => {
    const adopted: number[] = [];
    const directConnection = connection({
      frames: [frame(1, 1, "durable")],
      acknowledgeResults: [
        new AssignmentStreamPathUnavailableError("ACK response lost"),
      ],
    });
    const relayConnection = connection({ frames: [] });
    const direct = scriptedConnector([directConnection]);
    const relay = scriptedConnector([relayConnection]);
    const manager = pathManager(direct, relay, adopted);

    await expect(manager.poll()).resolves.toMatchObject({
      path: "relay",
      accepted: 1,
      checkpoint: { lastSeq: 1 },
    });
    expect(adopted).toEqual([1]);
    expect(relayConnection.acknowledgments).toEqual([
      expect.objectContaining({ ackSeq: 1 }),
    ]);
    expect(relayConnection.subscriptions).toEqual([
      expect.objectContaining({ afterSeq: 1 }),
    ]);
  });

  it("fails closed on protocol errors instead of hiding them behind relay fallback", async () => {
    const direct = scriptedConnector([
      connection({
        frames: [],
        subscribeResults: [new TypeError("invalid signed frame")],
      }),
    ]);
    const relay = scriptedConnector([]);
    const manager = pathManager(direct, relay, []);

    await expect(manager.poll()).rejects.toThrow(/invalid signed frame/);
    expect(relay.opens).toHaveLength(0);
  });

  it("bounds path attempts and invokes terminal reconciliation once", async () => {
    const reconciled = vi.fn();
    const direct = scriptedConnector([
      new AssignmentStreamPathUnavailableError("direct-1"),
      new AssignmentStreamPathUnavailableError("direct-2"),
    ]);
    const relay = scriptedConnector([
      new AssignmentStreamPathUnavailableError("relay-1"),
    ]);
    const manager = pathManager(direct, relay, [], {
      maxPathAttempts: 3,
      onPathsUnavailable: reconciled,
    });

    await expect(manager.poll()).rejects.toBeInstanceOf(
      AssignmentStreamPathsUnavailableError,
    );
    expect(direct.opens).toHaveLength(2);
    expect(relay.opens).toHaveLength(1);
    expect(reconciled).toHaveBeenCalledOnce();
    expect(reconciled).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({ lastSeq: 0 }),
        failures: expect.any(Array),
      }),
    );
  });

  it("rolls back verifier state when durable frame adoption fails", async () => {
    const direct = scriptedConnector([
      connection({ frames: [frame(1, 1, "not-durable")] }),
    ]);
    const manager = new AssignmentStreamPathManager({
      assignmentId: "assignment-fixed",
      ref,
      consumer,
      direct,
      relay: scriptedConnector([]),
      adoptFrame: async () => {
        throw new Error("journal fsync failed");
      },
    });

    await expect(manager.poll()).rejects.toThrow(/journal fsync failed/);
    expect(manager.checkpoint().lastSeq).toBe(0);
    expect(direct.connections[0]!.acknowledgments).toHaveLength(0);
  });

  it("stops renewing a degraded surface and hands finality back to owner catch-up", async () => {
    const degraded = vi.fn();
    const direct = scriptedConnector([
      connection({
        frames: [],
        subscribeResults: [
          new StreamConsumerDegradedError("surface-ticket:ticket-fixed"),
        ],
      }),
    ]);
    const relay = scriptedConnector([]);
    const manager = new AssignmentStreamPathManager({
      assignmentId: "assignment-fixed",
      ref,
      consumer,
      direct,
      relay,
      adoptFrame() {},
      onConsumerDegraded: degraded,
    });

    await expect(manager.poll()).rejects.toBeInstanceOf(
      StreamConsumerDegradedError,
    );
    expect(degraded).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({ lastSeq: 0 }),
      }),
    );
    expect(direct.connections[0]!.closed).toBe(true);
    expect(relay.opens).toHaveLength(0);
  });

  it("rotates an owner lease without resetting its logical cursor", async () => {
    const jobRef: ExecutionRef = {
      execution: "job",
      taskId: "task-fixed",
      jobRunId: "job-fixed",
      anchorEpoch: 4,
    };
    const firstConsumer: StreamConsumerAuth = {
      kind: "owner-relay",
      authority: {
        execution: "job",
        taskId: "task-fixed",
        anchorEpoch: 4,
      },
      controlLeaseId: "lease-1",
    };
    const nextConsumer: StreamConsumerAuth = {
      ...firstConsumer,
      controlLeaseId: "lease-2",
    };
    const first = connection({
      frames: [
        {
          ...frame(1, 1, "first"),
          ref: jobRef,
        },
      ],
    });
    const second = connection({ frames: [] });
    const direct = scriptedConnector([first, second]);
    const manager = new AssignmentStreamPathManager({
      assignmentId: "assignment-fixed",
      ref: jobRef,
      consumer: firstConsumer,
      direct,
      relay: scriptedConnector([]),
      adoptFrame() {},
    });

    await manager.poll();
    await manager.updateConsumerAuth(nextConsumer);
    await manager.poll();

    expect(second.acknowledgments[0]).toMatchObject({
      consumer: nextConsumer,
      ackSeq: 1,
    });
    expect(second.subscriptions[0]).toMatchObject({
      consumer: nextConsumer,
      afterSeq: 1,
    });
    await expect(
      manager.updateConsumerAuth({
        kind: "surface-ticket",
        ticketId: "ticket-other",
      }),
    ).rejects.toThrow(/logical consumer/);
  });
});

interface ScriptedConnection extends AssignmentStreamPathConnection {
  readonly subscriptions: StreamSubscribe[];
  readonly acknowledgments: StreamAck[];
  readonly closed: boolean;
}

function connection(input: {
  readonly frames: readonly StreamFrame[];
  readonly subscribeResults?: readonly (
    | readonly StreamFrame[]
    | Promise<readonly StreamFrame[]>
    | Error
  )[];
  readonly acknowledgeResults?: readonly (undefined | Error)[];
}): ScriptedConnection {
  const subscriptions: StreamSubscribe[] = [];
  const acknowledgments: StreamAck[] = [];
  const subscribeResults = [...(input.subscribeResults ?? [])];
  const acknowledgeResults = [...(input.acknowledgeResults ?? [])];
  let closed = false;
  return {
    subscriptions,
    acknowledgments,
    get closed() {
      return closed;
    },
    async subscribe(request) {
      subscriptions.push(request);
      const result = subscribeResults.shift();
      if (result instanceof Error) throw result;
      if (result !== undefined) return await result;
      return input.frames.filter((candidate) => candidate.seq > request.afterSeq);
    },
    async acknowledge(ack) {
      acknowledgments.push(ack);
      const result = acknowledgeResults.shift();
      if (result instanceof Error) throw result;
    },
    close() {
      closed = true;
    },
  };
}

interface ScriptedConnector extends AssignmentStreamPathConnector {
  readonly opens: Array<{
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
    readonly consumer: StreamConsumerAuth;
  }>;
  readonly connections: ScriptedConnection[];
}

function scriptedConnector(
  script: readonly (ScriptedConnection | Error)[],
): ScriptedConnector {
  const queue = [...script];
  const opens: ScriptedConnector["opens"] = [];
  const connections: ScriptedConnection[] = [];
  return {
    opens,
    connections,
    async open(input) {
      opens.push({
        assignmentId: input.assignmentId,
        ref: input.ref,
        consumer: input.consumer,
      });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("Unexpected connector open");
      }
      if (next instanceof Error) throw next;
      connections.push(next);
      return next;
    },
  };
}

function pathManager(
  direct: AssignmentStreamPathConnector,
  relay: AssignmentStreamPathConnector,
  adopted: number[],
  overrides: Partial<{
    readonly maxPathAttempts: number;
    readonly onPathsUnavailable: NonNullable<
      ConstructorParameters<typeof AssignmentStreamPathManager>[0]["onPathsUnavailable"]
    >;
  }> = {},
): AssignmentStreamPathManager {
  return new AssignmentStreamPathManager({
    assignmentId: "assignment-fixed",
    ref,
    consumer,
    direct,
    relay,
    adoptFrame(frame) {
      adopted.push(frame.seq);
    },
    ...overrides,
  });
}

function frame(seq: number, streamEpoch: number, text: string): StreamFrame {
  return {
    v: 1,
    ref,
    assignmentId: "assignment-fixed",
    streamEpoch,
    seq,
    payload: {
      kind: "agent-yield",
      yield: { type: "text_delta", text },
    },
    meta: {},
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
