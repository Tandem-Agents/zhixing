import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "@zhixing/core/protocol";
import {
  MeshProtocolError,
  type MeshDeviceIdentity,
  type MeshFrameTransport,
  type MeshServiceClient,
} from "@zhixing/mesh";
import {
  captureCurrentAnchorRelayMethods,
  DEVICE_LOCAL_RPC_METHODS,
  RPC_ERROR_CODES,
} from "@zhixing/server";
import {
  CURRENT_ANCHOR_RELAY_METHODS,
  CurrentAnchorFirstPartyRpcRouter,
  FirstPartyConversationMeshClient,
  FirstPartyConversationMeshTarget,
  isCurrentAnchorRelayMethod,
  registerFirstPartyConversationMeshService,
} from "../first-party-conversation-mesh.js";

describe("first-party conversation mesh", () => {
  it("relays only the finite canonical surface and closes the prior generation", async () => {
    const target = new FirstPartyConversationMeshTarget();
    let relay: { notify(method: string, params: unknown): void; onClose(handler: () => void): () => void } | undefined;
    const closed = vi.fn();
    const dispatch = vi.fn(async (input: { connection: typeof relay }) => {
      relay = input.connection;
      relay!.onClose(closed);
      return { items: [] };
    });
    target.bind({ dispatch } as never);
    const first = identity(1, "connection-1");

    const response = await target.handle(
      encode({
        v: 1,
        op: "dispatch",
        surface: first,
        method: "confirmation.list",
        params: { conversationId: "local-device-source-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      }),
      { peer: { deviceId: "device-source" } } as never,
      new AbortController().signal,
    );
    expect(decode(response)).toMatchObject({ v: 1, ok: true, result: { items: [] } });
    relay!.notify("confirmation.pending", { requestId: "confirm-1" });
    expect(decode(await target.handle(
      encode({ v: 1, op: "poll", surface: first }),
      { peer: { deviceId: "device-source" } } as never,
      new AbortController().signal,
    ))).toMatchObject({
      ok: true,
      notifications: [{ method: "confirmation.pending", params: { requestId: "confirm-1" } }],
    });

    const next = identity(2, "connection-2");
    await target.handle(
      encode({ v: 1, op: "poll", surface: next }),
      { peer: { deviceId: "device-source" } } as never,
      AbortSignal.abort(),
    );
    expect(closed).toHaveBeenCalledTimes(1);

    const stale = decode(await target.handle(
      encode({ v: 1, op: "poll", surface: identity(1, "connection-stale") }),
      { peer: { deviceId: "device-source" } } as never,
      AbortSignal.abort(),
    ));
    expect(stale).toMatchObject({ ok: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary RPC and peer identity drift before dispatch", async () => {
    const target = new FirstPartyConversationMeshTarget();
    const dispatch = vi.fn();
    target.bind({ dispatch } as never);
    const result = decode(await target.handle(
      encode({
        v: 1,
        op: "dispatch",
        surface: identity(1, "connection-1"),
        method: "workspace.binding.admin",
        params: {},
      }),
      { peer: { deviceId: "another-device" } } as never,
      new AbortController().signal,
    ));
    expect(result).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("routes the finite current-anchor surface after planned migration", async () => {
    let current = "device-source";
    const remoteDispatch = vi.fn(async () => ({ stage: "ready" }));
    const router = new CurrentAnchorFirstPartyRpcRouter({
      deviceId: "device-source",
      currentAnchorDeviceId: () => current,
      remoteFor: () => ({ dispatch: remoteDispatch }) as never,
    });
    const connection = {
      id: 1,
      closed: false,
      authenticated: true,
      loopback: true,
      surfacePrincipal: "rpc:client-1",
      surfaceGeneration: 1,
      notify: vi.fn(),
      onClose: () => () => {},
    };

    await expect(router.dispatch({
      method: "session.new",
      params: { operationId: "operation-1" },
      connection,
    })).resolves.toEqual({ handled: false });

    current = "device-target";
    await expect(router.dispatch({
      method: "dutyMigration.targets",
      params: {},
      connection,
    })).resolves.toEqual({ handled: true, result: { stage: "ready" } });
    expect(remoteDispatch).toHaveBeenCalledWith(
      "dutyMigration.targets",
      {},
      connection,
    );
    await expect(router.dispatch({
      method: "workspace.binding.admin",
      params: {},
      connection,
    })).resolves.toEqual({ handled: false });
  });

  it("derives the relay exact-set from the canonical registry and excludes only device-local methods", () => {
    expect(CURRENT_ANCHOR_RELAY_METHODS).toEqual(captureCurrentAnchorRelayMethods());
    for (const method of CURRENT_ANCHOR_RELAY_METHODS) {
      expect(isCurrentAnchorRelayMethod(method), method).toBe(true);
    }
    for (const method of DEVICE_LOCAL_RPC_METHODS) {
      expect(isCurrentAnchorRelayMethod(method), method).toBe(false);
    }
    expect(isCurrentAnchorRelayMethod("unknown.method")).toBe(false);
  });

  it("keeps the target unavailable until planned post-install consumers complete", async () => {
    let ready = false;
    const dispatch = vi.fn(async () => ({ ok: true }));
    const target = new FirstPartyConversationMeshTarget({ isReady: () => ready });
    target.bind({ dispatch } as never);
    const request = encode({
      v: 1,
      op: "dispatch",
      surface: identity(1, "connection-1"),
      method: "schedule.list",
      params: {},
    });
    const connection = { peer: { deviceId: "device-source" } } as never;

    expect(decode(await target.handle(
      request,
      connection,
      new AbortController().signal,
    ))).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();

    ready = true;
    expect(decode(await target.handle(
      request,
      connection,
      new AbortController().signal,
    ))).toMatchObject({ ok: true, result: { ok: true } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps one live poll across a real registry disconnect and reconnect without another dispatch", async () => {
    const bootstrapModule = await import(
      /* @vite-ignore */ new URL("../../../../mesh/src/bootstrap.ts", import.meta.url).href
    );
    const serviceModule = await import(
      /* @vite-ignore */ new URL("../../../../mesh/src/service-registry.ts", import.meta.url).href
    );
    const sessionModule = await import(
      /* @vite-ignore */ new URL("../../../../mesh/src/session.ts", import.meta.url).href
    );
    const sourceRegistry = new bootstrapModule.MeshConnectionRegistry();
    const targetRegistry = new bootstrapModule.MeshConnectionRegistry();
    const sourceServices = new serviceModule.MeshServiceRegistry();
    const targetServices = new serviceModule.MeshServiceRegistry();
    const attach = (generation: number) => {
      const [sourceTransport, targetTransport] = memoryTransports();
      const range = { min: "1", max: "1" } as const;
      sourceRegistry.attach(sessionModule.createSecureMeshConnection({
        transport: sourceTransport,
        connectionId: `source-${generation}`,
        compatibility: { mode: "read-write", protocolVersion: "1" },
        localProtocolRange: range,
        peerProtocolRange: range,
        peer: deviceIdentity("device-target"),
      }), sourceServices);
      targetRegistry.attach(sessionModule.createSecureMeshConnection({
        transport: targetTransport,
        connectionId: `target-${generation}`,
        compatibility: { mode: "read-write", protocolVersion: "1" },
        localProtocolRange: range,
        peerProtocolRange: range,
        peer: deviceIdentity("device-source"),
      }), targetServices);
    };
    const target = new FirstPartyConversationMeshTarget();
    let relay: {
      notify(method: string, params: unknown): void;
      tryNotify(method: string, params: unknown): boolean;
    } | undefined;
    target.bind({
      dispatch: async (input: { connection: typeof relay }) => {
        relay = input.connection;
        return { items: [] };
      },
    } as never);
    const unregister = registerFirstPartyConversationMeshService(targetServices, target, () => true);
    attach(1);
    const registryClient = sourceRegistry.client("device-target");
    let registryRequests = 0;
    const pollErrors: Error[] = [];
    const meshClient = new FirstPartyConversationMeshClient(
      {
        request: async (serviceId, payload, signal) => {
          registryRequests += 1;
          try {
            return await registryClient.request(serviceId, payload, signal);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              (
                error.code === "connection-closed" ||
                error.code === "service-unavailable" ||
                error.code === "request-timeout"
              )
            ) {
              throw new MeshProtocolError(error.code, error.message);
            }
            throw error;
          }
        },
      },
      "device-source",
      (error) => pollErrors.push(error),
    );
    const connection = ingressConnection(41);

    await meshClient.dispatch("confirmation.list", {}, connection);
    expect(relay).toBeDefined();
    await targetRegistry.disconnect("device-source");
    await sourceRegistry.disconnect("device-target");
    expect(relay!.tryNotify(
      "confirmation.pending",
      { requestId: "confirm-after-reconnect" },
    )).toBe(true);
    attach(2);

    await waitUntil(() => connection.notify.mock.calls.length === 1, 2_000);
    expect(registryRequests).toBeGreaterThan(2);
    expect(pollErrors).toEqual([]);
    expect(connection.notify).toHaveBeenCalledWith(
      "confirmation.pending",
      { requestId: "confirm-after-reconnect" },
    );
    await meshClient.close(connection);
    unregister();
    target.close();
    await Promise.all([sourceRegistry.close(), targetRegistry.close()]);
  });

  it("retries only the finite poll transient set and resets after a successful attempt", async () => {
    vi.useFakeTimers();
    try {
      const pollFailures: unknown[] = [
        new MeshProtocolError("connection-closed", "closed"),
        new MeshProtocolError("service-unavailable", "offline"),
        new MeshProtocolError("request-timeout", "timeout"),
        { rpcCode: RPC_ERROR_CODES.BUSY },
      ];
      let pollCalls = 0;
      const service: MeshServiceClient = {
        request: async (_serviceId, payload, signal) => {
          const command = decode(payload) as { op: string };
          if (command.op === "dispatch") return successResult([]);
          if (command.op === "close") return successResult([]);
          pollCalls += 1;
          const failure = pollFailures.shift();
          if (failure instanceof Error) throw failure;
          if (failure && typeof failure === "object" && "rpcCode" in failure) {
            return errorResult((failure as { rpcCode: number }).rpcCode);
          }
          if (pollCalls === 5) {
            return successResult([{ method: "confirmation.pending", params: { requestId: "retry-ok" } }]);
          }
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw new MeshProtocolError("request-aborted", "aborted");
        },
      };
      const onError = vi.fn();
      const client = new FirstPartyConversationMeshClient(service, "device-source", onError);
      const connection = ingressConnection(42);
      await client.dispatch("confirmation.list", {}, connection);
      await vi.advanceTimersByTimeAsync(3_750);
      await vi.waitFor(() => expect(connection.notify).toHaveBeenCalledWith(
        "confirmation.pending",
        { requestId: "retry-ok" },
      ));
      expect(pollCalls).toBe(6);
      expect(onError).not.toHaveBeenCalled();
      await client.close(connection);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a fatal poll controller so the same surface can start a fresh one", async () => {
    let polls = 0;
    const service: MeshServiceClient = {
      request: async (_serviceId, payload, signal) => {
        const command = decode(payload) as { op: string };
        if (command.op === "dispatch" || command.op === "close") return successResult([]);
        polls += 1;
        if (polls === 1) throw new MeshProtocolError("service-failed", "fatal");
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new MeshProtocolError("request-aborted", "aborted");
      },
    };
    const onError = vi.fn();
    const client = new FirstPartyConversationMeshClient(service, "device-source", onError);
    const connection = ingressConnection(43);
    await client.dispatch("confirmation.list", {}, connection);
    await waitUntil(() => onError.mock.calls.length === 1);
    await client.dispatch("confirmation.list", {}, connection);
    await waitUntil(() => polls === 2);
    expect(onError).toHaveBeenCalledTimes(1);
    await client.close(connection);
  });
});

function identity(generation: number, connectionId: string) {
  return {
    deviceId: "device-source",
    surfacePrincipal: "rpc:client-1",
    connectionId,
    generation,
    loopback: true,
  };
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value));
}

function decode(value: Uint8Array): unknown {
  return JSON.parse(Buffer.from(value).toString("utf8"));
}

function successResult(
  notifications: readonly { readonly method: string; readonly params: unknown }[],
): Uint8Array {
  return encode({ v: 1, ok: true, notifications });
}

function errorResult(code: number): Uint8Array {
  return encode({ v: 1, ok: false, error: { code, message: "retryable" } });
}

function ingressConnection(id: number) {
  const closeHandlers = new Set<() => void>();
  return {
    id,
    closed: false,
    authenticated: true,
    loopback: true,
    surfacePrincipal: `rpc:client-${id}`,
    surfaceGeneration: 1,
    notify: vi.fn(),
    onClose(handler: () => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
}

function deviceIdentity(deviceId: string): MeshDeviceIdentity {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    displayName: deviceId,
    platform: "headless",
    enrolledAt: "2026-08-11T00:00:00.000Z",
  };
}

function memoryTransports(): [MeshFrameTransport, MeshFrameTransport] {
  const state = { closed: false, endpoints: [] as MemoryTransport[] };
  const left = new MemoryTransport(state);
  const right = new MemoryTransport(state);
  state.endpoints.push(left, right);
  left.peer = right;
  right.peer = left;
  return [left, right];
}

interface TransportWaiter {
  readonly resolve: (frame: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

class MemoryTransport implements MeshFrameTransport {
  peer!: MemoryTransport;
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: TransportWaiter[] = [];
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;

  constructor(private readonly state: { closed: boolean; endpoints: MemoryTransport[] }) {
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    this.#resolveClosed = resolveClosed;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.state.closed) throw new Error("closed");
    this.peer.deliver(frame.slice());
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.state.closed) throw new Error("closed");
    const queued = this.#queue.shift();
    if (queued) return queued;
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: TransportWaiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    for (const endpoint of this.state.endpoints) endpoint.finish();
  }

  deliver(frame: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (!waiter) {
      this.#queue.push(frame);
      return;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(frame);
  }

  finish(): void {
    this.#resolveClosed();
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(new Error("closed"));
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for relay state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
