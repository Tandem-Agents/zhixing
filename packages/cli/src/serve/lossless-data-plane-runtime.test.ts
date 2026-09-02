import type {
  DataPlaneTicket,
  ExecutionRef,
  StreamAck,
  StreamConsumerAuth,
  StreamFrame,
  StreamSubscribe,
} from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { LosslessDataPlaneRuntime } from "./lossless-data-plane-runtime.js";
import type { AssignmentDataPlaneTarget } from "./assignment-data-plane-topology.js";

const ref: ExecutionRef = {
  execution: "conversation",
  runId: "run-first-party",
  conversationId: "conversation-first-party",
  ownerEpoch: 0,
};

const consumer: StreamConsumerAuth = {
  kind: "surface-ticket",
  ticketId: "ticket-first-party",
};
const SURFACE_PRINCIPAL = "surface:test";
const ticket = {
  ticketId: consumer.ticketId,
  surfacePrincipal: SURFACE_PRINCIPAL,
} as DataPlaneTicket;

const ASSIGNMENT = "assignment-first-party";

describe("LosslessDataPlaneRuntime first-party surface sessions", () => {
  it("rejects a surface principal that does not own the ticket before accepting it", async () => {
    const { runtime, accept } = createRuntime({ clients: [] });
    await expect(
      runtime.openFirstPartySurfaceSession({
        executorId: "exec-local",
        assignmentId: ASSIGNMENT,
        ref,
        ticket,
        surfacePrincipal: "surface:other",
        adoptFrame: () => undefined,
      }),
    ).rejects.toThrow(/principal differs/u);
    expect(accept).not.toHaveBeenCalled();
  });

  it("accepts the owner-issued ticket before opening either stream path", async () => {
    const { runtime, accept } = createRuntime({ clients: [] });
    await runtime.openFirstPartySurfaceSession({
      executorId: "exec-local",
      assignmentId: ASSIGNMENT,
      ref,
      ticket,
      surfacePrincipal: SURFACE_PRINCIPAL,
      adoptFrame: () => undefined,
    });
    expect(accept).toHaveBeenCalledWith(ticket);
  });

  it("maps a mid-stream transport failure to relay and resumes the same watermark", async () => {
    const first = scriptedClient({
      subscribeResults: [new Error("socket reset")],
    });
    const second = scriptedClient({ frames: [frame(1, 1, "relayed")] });
    const { runtime } = createRuntime({ clients: [first, second] });
    const adopted: number[] = [];
    const session = await runtime.openFirstPartySurfaceSession({
      executorId: "exec-local",
      assignmentId: ASSIGNMENT,
      ref,
      ticket,
      surfacePrincipal: SURFACE_PRINCIPAL,
      adoptFrame: (accepted) => {
        adopted.push(accepted.seq);
      },
    });

    await expect(session.poll()).resolves.toMatchObject({
      path: "relay",
      accepted: 1,
      checkpoint: { lastSeq: 1 },
    });
    expect(adopted).toEqual([1]);
    // 两条路径携同一 surface 消费身份,relay 从 direct 已建立的水位续订。
    expect(first.subscriptions[0]).toMatchObject({ consumer, afterSeq: 0 });
    expect(second.subscriptions[0]).toMatchObject({ consumer, afterSeq: 0 });
  });

  it("falls back to the owner relay when the executor is not local", async () => {
    const meshClient = scriptedClient({ frames: [frame(1, 1, "via-mesh")] });
    const { runtime } = createRuntime({
      clients: [],
      remoteClient: meshClient,
    });
    const session = await runtime.openFirstPartySurfaceSession({
      executorId: "exec-remote",
      assignmentId: ASSIGNMENT,
      ref,
      ticket,
      surfacePrincipal: SURFACE_PRINCIPAL,
      adoptFrame: () => undefined,
    });

    await expect(session.poll()).resolves.toMatchObject({
      path: "relay",
      accepted: 1,
    });
    expect(meshClient.subscriptions).toHaveLength(1);
  });

  it("keeps both paths honest after the runtime closes", async () => {
    const { runtime } = createRuntime({ clients: [] });
    const session = await runtime.openFirstPartySurfaceSession({
      executorId: "exec-local",
      assignmentId: ASSIGNMENT,
      ref,
      ticket,
      surfacePrincipal: SURFACE_PRINCIPAL,
      adoptFrame: () => undefined,
      maxPathAttempts: 2,
    });
    await runtime.close();

    await expect(session.poll()).rejects.toThrow(/stopping/u);
  });

  it("restores the direct path after a relay interval", async () => {
    const failing = scriptedClient({
      subscribeResults: [new Error("socket reset")],
    });
    const relayed = scriptedClient({ frames: [frame(1, 1, "relayed")] });
    const restored = scriptedClient({ frames: [frame(2, 2, "direct-again")] });
    const { runtime } = createRuntime({
      clients: [failing, relayed, restored],
    });
    const session = await runtime.openFirstPartySurfaceSession({
      executorId: "exec-local",
      assignmentId: ASSIGNMENT,
      ref,
      ticket,
      surfacePrincipal: SURFACE_PRINCIPAL,
      adoptFrame: () => undefined,
    });

    await expect(session.poll()).resolves.toMatchObject({ path: "relay" });
    await session.restoreDirect();
    await expect(session.poll()).resolves.toMatchObject({
      path: "direct",
      checkpoint: { lastSeq: 2 },
    });
    expect(restored.subscriptions[0]).toMatchObject({ afterSeq: 1 });
  });

  it("does not report a terminal watermark before its ACK is durable", async () => {
    let releaseAck: (() => void) | undefined;
    const acked = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const client = scriptedClient({
      frames: [frame(1, 1, "terminal")],
      acknowledge: async () => acked,
    });
    const { runtime } = createRuntime({ clients: [client] });
    const session = await runtime.openFirstPartySurfaceSession({
      executorId: "exec-local",
      assignmentId: ASSIGNMENT,
      ref,
      ticket,
      surfacePrincipal: SURFACE_PRINCIPAL,
      adoptFrame: () => undefined,
    });

    const poll = session.poll();
    let observed = false;
    const terminal = session.waitForSeq(1).then(() => {
      observed = true;
    });
    await Promise.resolve();
    expect(observed).toBe(false);
    releaseAck?.();
    await poll;
    await terminal;
    expect(observed).toBe(true);
  });
});

interface ScriptedClient {
  readonly subscriptions: StreamSubscribe[];
  readonly acknowledgments: StreamAck[];
  subscribe(
    request: StreamSubscribe,
    signal?: AbortSignal,
  ): Promise<readonly StreamFrame[]>;
  acknowledge(ack: StreamAck, signal?: AbortSignal): Promise<void>;
}

function scriptedClient(input: {
  readonly frames?: readonly StreamFrame[];
  readonly subscribeResults?: readonly (readonly StreamFrame[] | Error)[];
  readonly acknowledge?: (ack: StreamAck) => Promise<void>;
}): ScriptedClient {
  const subscriptions: StreamSubscribe[] = [];
  const acknowledgments: StreamAck[] = [];
  const subscribeResults = [...(input.subscribeResults ?? [])];
  return {
    subscriptions,
    acknowledgments,
    async subscribe(request) {
      subscriptions.push(request);
      const result = subscribeResults.shift();
      if (result instanceof Error) throw result;
      if (result !== undefined) return result;
      return (input.frames ?? []).filter(
        (candidate) => candidate.seq > request.afterSeq,
      );
    },
    async acknowledge(ack) {
      acknowledgments.push(ack);
      await input.acknowledge?.(ack);
    },
  };
}

function createRuntime(input: {
  readonly clients: readonly ScriptedClient[];
  readonly remoteClient?: ScriptedClient;
}): { runtime: LosslessDataPlaneRuntime; accept: ReturnType<typeof vi.fn> } {
  const queue = [...input.clients];
  const accept = vi.fn(async () => undefined);
  const local: AssignmentDataPlaneTarget = {
    acceptTicket: accept,
    answerChannel: vi.fn(async () => undefined),
    resolveNoInteractiveSurface: vi.fn(async () => undefined),
    directSurfaceStream: () => {
      const next = queue.shift();
      if (!next) throw new Error("Local executor stream is unavailable");
      return next;
    },
    ownerStream: () => {
      const next = queue.shift();
      if (!next) throw new Error("Local executor stream is unavailable");
      return next;
    },
  };
  const remote: AssignmentDataPlaneTarget | undefined = input.remoteClient
    ? {
        acceptTicket: vi.fn(async () => undefined),
        answerChannel: vi.fn(async () => undefined),
        resolveNoInteractiveSurface: vi.fn(async () => undefined),
        ownerStream: () => input.remoteClient!,
        directSurfaceStream: () => undefined,
      }
    : undefined;
  const runtime = new LosslessDataPlaneRuntime({
    verifier: {} as never,
    targets: {
      targetForExecutor: (executorId) => {
        if (executorId === "exec-local") return local;
        if (remote) return remote;
        throw new Error("Remote executor data plane is unavailable");
      },
    },
  });
  return { runtime, accept };
}

function frame(seq: number, streamEpoch: number, text: string): StreamFrame {
  return {
    v: 1,
    ref,
    assignmentId: ASSIGNMENT,
    streamEpoch,
    seq,
    payload: {
      kind: "agent-yield",
      yield: { type: "text_delta", text },
    },
    meta: {},
  };
}
