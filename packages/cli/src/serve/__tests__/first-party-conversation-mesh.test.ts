import { describe, expect, it, vi } from "vitest";
import { createSessionBroadcastTransport } from '@zhixing/rpc/session-broadcast';
import { projectProcessYield, validateSessionProcessProjection } from '@zhixing/rpc/session-wire';
import type { RpcConnection } from '../../../../server/src/rpc/connection.js';
import { startServer, type ZhixingServerInstance } from '../../../../server/src/server.js';
import { createServerContext } from '../../../../server/src/context.js';
import { DEFAULT_SERVER_CONFIG } from '../../../../server/src/types.js';
import { buildSessionSubscribeMethod, buildSessionUnsubscribeMethod } from '../../../../server/src/rpc/methods/session.js';
import { canonicalize } from "@zhixing/core/protocol";
import {
  MeshProtocolError,
  type MeshDeviceIdentity,
  type MeshFrameTransport,
  type MeshServiceClient,
} from "@zhixing/mesh";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  captureCurrentAnchorRelayMethods,
  DEVICE_LOCAL_RPC_METHODS,
  RPC_ERROR_CODES,
} from "@zhixing/server";
import {
  CURRENT_ANCHOR_RELAY_METHODS,
  FIRST_PARTY_CONVERSATION_MESH_SERVICE,
  CurrentAnchorFirstPartyRpcRouter,
  FirstPartyConversationMeshClient,
  FirstPartyConversationMeshSurfaceLifecycle,
  FirstPartyConversationMeshTarget,
  isCurrentAnchorRelayMethod,
  registerFirstPartyConversationMeshService,
} from "../first-party-conversation-mesh.js";

describe("first-party conversation mesh", () => {
  it('sends a valid artifact burst and mixed controls through the real Mesh cap without losing the tail', async () => {
    const harness = presentationRelayHarness(), surface = identity(1, 'large-burst');
    const channel = await relayChannel(harness.target);
    try {
      expect(await channel.request({ v: 1, op: 'dispatch', surface, method: 'session.subscribe',
        params: { conversationId: 'conv', presentation: 'bounded-v1', replayFinals: false } })).toMatchObject({ ok: true });
      const expected: { method: string; params: unknown }[] = [];
      for (let i = 0; i < 14; i++) {
        const value = largeRelayProcess(i + 1);
        validateSessionProcessProjection(value);
        expected.push({ method: 'session.process', params: value });
        harness.transport.session('conv', 'session.process', value);
        if (i === 5) {
          const control = { method: 'confirmation.pending', params: { requestId: 'mixed-control' } };
          expected.push(control); harness.transport.session('conv', control.method, control.params);
        }
      }
      const closed = { version: 1, source: largeRelayProcess(14).source, payload: { kind: 'closed' } };
      expected.push({ method: 'session.process', params: closed });
      harness.transport.session('conv', 'session.process', closed);
      expect(encode({ v: 1, ok: true, notifications: expected }).byteLength).toBeGreaterThan(1024 * 1024);
      const first = await channel.request({ v: 1, op: 'poll', surface });
      expect(first.ok).toBe(true); expect(first.notifications.length).toBeLessThan(expected.length);
      const received = [...first.notifications];
      for (let attempt = 0; received.length < expected.length && attempt < 3; attempt++) {
        const page = await channel.request({ v: 1, op: 'poll', surface });
        expect(page.ok).toBe(true); received.push(...page.notifications);
      }
      expect(received).toEqual(expected);
      expect(harness.connectionsByPrincipal.get(surface.surfacePrincipal)!.closed).toBe(false);
    } finally { harness.target.close(); await channel.close(); }
  });

  it('reserves encoded reply space for dispatch results and leaves immutable notifications for poll', async () => {
    let relay!: RpcConnection, result: unknown = null;
    const target = new FirstPartyConversationMeshTarget({ surface: { dispatch: async input => {
      relay = input.connection; return result;
    } } });
    const channel = await relayChannel(target), surface = identity(1, 'result-budget');
    try {
      const dispatch = () => channel.request({ v: 1, op: 'dispatch', surface, method: 'confirmation.list', params: {} });
      await dispatch();
      const params = { text: '汉'.repeat(80 * 1024) }, original = params.text;
      expect(relay.tryNotify!('session.changed', params)).toBe(true);
      params.text = 'mutated after admission';
      result = { history: 'x'.repeat(900 * 1024) };
      expect(await dispatch()).toEqual({ v: 1, ok: true, result, notifications: [] });
      expect(await channel.request({ v: 1, op: 'poll', surface })).toMatchObject({
        ok: true, notifications: [{ method: 'session.changed', params: { text: original } }],
      });
      result = { history: 'x'.repeat(1024 * 1024) };
      expect(await dispatch()).toMatchObject({ ok: false, error: { code: RPC_ERROR_CODES.INTERNAL_ERROR } });
      expect(relay.closed).toBe(true);
      expect(await channel.request({ v: 1, op: 'poll', surface })).toMatchObject({ ok: false });
    } finally { target.close(); await channel.close(); }
  });

  it('closes an exhausted relay explicitly and wakes the client poll with a stable failure', async () => {
    let relay!: RpcConnection;
    const target = new FirstPartyConversationMeshTarget({ surface: { dispatch: async input => {
      relay = input.connection; return null;
    } } });
    const channel = await relayChannel(target), errors: Error[] = [], connection = ingressConnection(91);
    const client = new FirstPartyConversationMeshClient(channel.client, 'device-source', error => errors.push(error));
    try {
      await client.dispatch('confirmation.list', {}, connection);
      const onClose = vi.fn(); relay.onClose(onClose);
      // One synchronous burst cannot be drained by an interleaving poll handler.
      const params = { text: 'x'.repeat(128 * 1024) };
      let admitted = 0;
      while (admitted < 40 && relay.tryNotify!('session.changed', params)) admitted++;
      expect(admitted).toBeGreaterThan(0); expect(admitted).toBeLessThan(40);
      expect(relay.closed).toBe(true); expect(onClose).toHaveBeenCalledOnce();
      await waitUntil(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ code: RPC_ERROR_CODES.INTERNAL_ERROR });
      expect(errors[0]!.message).toContain('capacity');
      expect(relay.tryNotify!('session.changed', {})).toBe(false);
    } finally { await client.close(connection); target.close(); await channel.close(); }
  });

  it('registers real relays in the running Server broadcast and closes observers at generation replacement and shutdown', async () => {
    const observers = new Set<string>(), removeObserverFromAll = vi.fn((id: string) => { observers.delete(id); });
    const context = createServerContext({ config: { ...DEFAULT_SERVER_CONFIG, port: 0 }, version: 'test', token: 'synthetic-test-token',
      conversation: { has: () => true, addObserver: (_id: string, connectionId: string) => { observers.add(connectionId); return true; },
        removeObserver: (_id: string, connectionId: string) => { observers.delete(connectionId); },
        getObserverConnectionIds: () => observers, removeObserverFromAll, disposeAll: async () => {} } as never,
    });
    const server = await startServer({ context });
    let other: ZhixingServerInstance | undefined;
    const target = new FirstPartyConversationMeshTarget({ surface: { dispatch: ({ method, params, connection }) => {
      server.registerConnection(connection);
      return server.registry.dispatchCanonical(method, params, { connection, server: context });
    } } });
    const request = async (command: unknown) => decode(await target.handle(encode(command), { peer: { deviceId: 'device-source' } } as never, AbortSignal.abort()));
    const dispatch = (surface: ReturnType<typeof identity>) => request({ v: 1, op: 'dispatch', surface, method: 'session.subscribe',
      params: { conversationId: 'conv', presentation: 'bounded-v1', replayFinals: false } });
    try {
      const first = identity(1, 'first');
      expect(await dispatch(first)).toMatchObject({ ok: true, result: { subscribed: true, presentation: 'bounded-v1' } });
      const relay = [...server.connections][0]!;
      expect(observers.has(String(relay.id))).toBe(true);
      server.registerConnection(relay); expect(server.connections.size).toBe(1);
      context.sessionBroadcast!('conv', 'session.process', relayProcess());
      expect(JSON.stringify(await request({ v: 1, op: 'poll', surface: first }))).toContain('file-diff');
      other = await startServer({ context: createServerContext({ config: { ...DEFAULT_SERVER_CONFIG, port: 0 }, version: 'test', token: 'synthetic-other-token' }) });
      expect(() => other!.registerConnection(relay)).toThrow('another Server generation');
      expect(other.connections.size).toBe(0);
      const next = identity(2, 'replacement');
      expect(await dispatch(next)).toMatchObject({ ok: true });
      expect(relay.closed).toBe(true);
      expect(removeObserverFromAll).toHaveBeenCalledWith(String(relay.id));
      expect(observers.has(String(relay.id))).toBe(false);
      expect(server.connections.size).toBe(1);
      const current = [...server.connections][0]!;
      await server.close();
      expect(current.closed).toBe(true); expect(observers.size).toBe(0); expect(server.connections.size).toBe(0);
      expect(await dispatch(identity(3, 'after-shutdown'))).toMatchObject({ ok: false });
      expect(observers.size).toBe(0);
    } finally { target.close(); await server.close(); await other?.close(); }
  });
  it('negotiates actual relays through canonical dispatch and the shared observer transport', async () => {
    const harness = presentationRelayHarness();
    const plain = { ...identity(1, 'plain'), surfacePrincipal: 'rpc:plain' };
    const enhanced = identity(1, 'enhanced');
    expect(await harness.dispatch(plain, 'session.subscribe', { conversationId: 'conv' })).toMatchObject({ ok: true, result: { subscribed: true, presentation: 'default' } });
    expect(await harness.dispatch(enhanced, 'session.subscribe', { conversationId: 'conv', presentation: 'bounded-v1' })).toMatchObject({ ok: true, result: { subscribed: true, presentation: 'bounded-v1' } });
    const relay = harness.connectionsByPrincipal.get(enhanced.surfacePrincipal)!;
    const revision = relay.observationRevision!('conv');
    const value = relayProcess();
    harness.transport.session('conv', 'session.process', value);
    harness.transport.session('conv', 'session.assignmentStream', { ref: 'canonical-private' });
    const plainResult = await harness.poll(plain), enhancedResult = await harness.poll(enhanced);
    expect(plainResult).toMatchObject({ notifications: [{ method: 'session.process' }] });
    expect(JSON.stringify(plainResult)).not.toMatch(/file-diff|presentation|"ref"/u);
    expect(JSON.stringify(enhancedResult)).toContain('file-diff');
    expect(await harness.dispatch(enhanced, 'session.subscribe', { conversationId: 'conv', presentation: 'default', replayFinals: false })).toMatchObject({ result: { presentation: 'default' } });
    expect(relay.observationRevision!('conv')).toBe(revision);
    harness.transport.session('conv', 'session.process', relayProcess());
    expect(JSON.stringify(await harness.poll(enhanced))).not.toContain('file-diff');
    await harness.dispatch(enhanced, 'session.subscribe', { conversationId: 'conv', presentation: 'bounded-v1', replayFinals: false });
    harness.transport.session('conv', 'session.process', value);
    expect(JSON.stringify(await harness.poll(enhanced))).not.toContain('file-diff');
    harness.transport.session('conv', 'session.process', relayProcess());
    expect(JSON.stringify(await harness.poll(enhanced))).toContain('file-diff');
    await harness.dispatch(enhanced, 'session.unsubscribe', { conversationId: 'conv' });
    expect(relay.observationRevision!('conv')).toBe(-1);
    harness.transport.session('conv', 'session.complete', { conversationId: 'conv' });
    expect(await harness.poll(enhanced)).toMatchObject({ notifications: [] });
    await harness.dispatch(enhanced, 'session.subscribe', { conversationId: 'conv', replayFinals: false });
    expect(relay.observationRevision!('conv')).not.toBe(revision);
    const next = identity(2, 'replacement');
    await harness.dispatch(next, 'session.subscribe', { conversationId: 'conv', replayFinals: false });
    expect(relay.closed).toBe(true);
    expect(relay.observationRevision!('conv')).toBe(-1);
    expect(harness.connections.has(relay)).toBe(false);
    expect(harness.observers.has(String(relay.id))).toBe(false);
    expect(await harness.dispatch(enhanced, 'session.subscribe', { conversationId: 'conv' })).toMatchObject({ ok: false });
    harness.transport.session('conv', 'session.process', relayProcess());
    expect(JSON.stringify(await harness.poll(next))).not.toContain('file-diff');
    await harness.close(next);
    expect(harness.observers.size).toBe(1); // Only the independent plain observer remains.
    harness.target.close();
    expect(harness.connections.size).toBe(0);
    expect(harness.observers.size).toBe(0);
    expect(await harness.dispatch(identity(3, 'closed-target'), 'session.subscribe', { conversationId: 'conv' })).toMatchObject({ ok: false });
  });

  it('preserves final and publish replay when a pause dispatch queues behind subscription', async () => {
    let release!: (value: unknown[]) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const harness = presentationRelayHarness(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const surface = identity(1, 'replay');
    const pending = harness.dispatch(surface, 'session.subscribe', { conversationId: 'conv', presentation: 'bounded-v1' });
    await waiting;
    const paused = harness.dispatch(surface, 'session.subscribe', { conversationId: 'conv', presentation: 'default', replayFinals: false });
    release([{ frame: { conversationId: 'conv', runId: 'run', commitRevision: 4 }, publishResults: [{ conversationId: 'conv', runId: 'run', seq: 1, assignmentId: 'assignment' }] }]);
    const replay = await pending;
    expect(replay).toMatchObject({ ok: true, notifications: [{ method: 'session.final' }, { method: 'session.event', params: { event: 'publish:result', scope: 'control' } }] });
    expect(await paused).toMatchObject({ ok: true, result: { presentation: 'default' }, notifications: [] });
    harness.target.close();
  });

  it('closes real relay observers while history awaits and rejects queued stale-generation dispatch', async () => {
    let release!: (value: unknown[]) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const history = vi.fn(() => { entered(); return new Promise<unknown[]>(resolve => { release = resolve; }); });
    const harness = presentationRelayHarness(history);
    const first = identity(1, 'old');
    const pending = harness.dispatch(first, 'session.subscribe', { conversationId: 'conv', presentation: 'bounded-v1' });
    await waiting;
    const queued = harness.dispatch(first, 'session.subscribe', { conversationId: 'conv', replayFinals: false });
    const relay = harness.connectionsByPrincipal.get(first.surfacePrincipal)!;
    const next = identity(2, 'next');
    expect(await harness.dispatch(next, 'session.subscribe', { conversationId: 'conv', replayFinals: false })).toMatchObject({ result: { subscribed: true, presentation: 'default' } });
    release([{ frame: { conversationId: 'conv', runId: 'run', commitRevision: 4 }, publishResults: [] }]);
    // The relay was retired while its history read was pending. Its completion
    // must not reopen a successful response path into the replacement generation.
    const retired = await pending;
    expect(retired).toMatchObject({ v: 1, ok: false, error: { code: RPC_ERROR_CODES.BUSY } });
    expect(retired).not.toHaveProperty('result');
    expect(retired).not.toHaveProperty('notifications');
    expect(await queued).toMatchObject({ ok: false });
    expect(relay.closed).toBe(true);
    expect(harness.observers).not.toContain(String(relay.id));
    expect(history).toHaveBeenCalledOnce();
    harness.transport.session('conv', 'session.complete', { conversationId: 'conv' });
    expect(await harness.poll(next)).toMatchObject({ notifications: [{ method: 'session.complete' }] });
    harness.target.close();
  });

  it("keeps MCP configuration pending device-local even while Anchor is offline", async () => {
    const { ExecutorFirstPartyRpcRouter } = await import("../local-conversation-rpc.js");
    const { buildMcpPendingMethod } = await import("../../../../server/src/rpc/methods/mcp.js");
    const remote = vi.fn(async () => { throw new Error("Anchor offline"); });
    const router = new ExecutorFirstPartyRpcRouter({ local: { dispatch: vi.fn() }, currentAnchor: new CurrentAnchorFirstPartyRpcRouter({ deviceId: "remote", currentAnchorDeviceId: () => "anchor", remoteFor: () => ({ dispatch: remote }) as never }) });
    const connection = ingressConnection(1);
    expect(await router.dispatch({ method: "mcp.pending", params: { conversationId: "main-1" }, connection })).toEqual({ handled: false });
    expect(remote).not.toHaveBeenCalled();
    expect(await buildMcpPendingMethod().handler({ conversationId: "main-1" }, { connection, server: {} } as never)).toEqual([]);
    const dispatch = vi.fn();
    const target = new FirstPartyConversationMeshTarget({ surface: { dispatch } as never });
    expect(decode(await target.handle(encode({ v: 1, op: "dispatch", surface: identity(1, "connection-1"), method: "mcp.pending", params: { conversationId: "main-1" } }), { peer: { deviceId: "device-source" } } as never, new AbortController().signal))).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("relays only the finite canonical surface and closes the prior generation", async () => {
    let relay: { notify(method: string, params: unknown): void; onClose(handler: () => void): () => void } | undefined;
    const closed = vi.fn();
    const dispatch = vi.fn(async (input: { connection: typeof relay }) => {
      relay = input.connection;
      relay!.onClose(closed);
      return { items: [] };
    });
    const target = new FirstPartyConversationMeshTarget({
      surface: { dispatch } as never,
    });
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
    const dispatch = vi.fn();
    const target = new FirstPartyConversationMeshTarget({
      surface: { dispatch } as never,
    });
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
    const target = new FirstPartyConversationMeshTarget({
      surface: { dispatch } as never,
      isReady: () => ready,
    });
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

  it("registers only a complete required surface and closes its owner idempotently", () => {
    const services = new MeshServiceRegistry();
    expect(() => new FirstPartyConversationMeshSurfaceLifecycle({
      registry: services,
      surface: undefined as never,
      authorizePeer: () => true,
    })).toThrow("surface is required");
    expect(services.list()).toEqual([]);

    const lifecycle = new FirstPartyConversationMeshSurfaceLifecycle({
      registry: services,
      surface: { dispatch: vi.fn() } as never,
      authorizePeer: () => true,
    });
    expect(services.list()).toEqual([FIRST_PARTY_CONVERSATION_MESH_SERVICE]);

    lifecycle.close();
    lifecycle.close();
    expect(services.list()).toEqual([]);
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
    let relay: {
      notify(method: string, params: unknown): void;
      tryNotify(method: string, params: unknown): boolean;
    } | undefined;
    const target = new FirstPartyConversationMeshTarget({
      surface: {
        dispatch: async (input: { connection: typeof relay }) => {
          relay = input.connection;
          return { items: [] };
        },
      } as never,
    });
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
      expect(connection.closeHandlerCount()).toBe(1);
      await client.close(connection);
      expect(connection.closeHandlerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one connection owner across an unbounded sequence of successful polls", async () => {
    let pollCalls = 0;
    const service: MeshServiceClient = {
      request: async (_serviceId, payload, signal) => {
        const command = decode(payload) as { op: string };
        if (command.op === "dispatch" || command.op === "close") return successResult([]);
        pollCalls += 1;
        if (pollCalls <= 128) return successResult([]);
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new MeshProtocolError("request-aborted", "aborted");
      },
    };
    const client = new FirstPartyConversationMeshClient(service, "device-source");
    const connection = ingressConnection(44);

    await client.dispatch("confirmation.list", {}, connection);
    await waitUntil(() => pollCalls > 128);
    expect(connection.closeHandlerCount()).toBe(1);

    await client.close(connection);
    expect(connection.closeHandlerCount()).toBe(0);
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
    closeHandlerCount: () => closeHandlers.size,
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

function presentationRelayHarness(history: () => Promise<unknown[]> = async () => []) {
  const connections = new Set<RpcConnection>();
  const connectionsByPrincipal = new Map<string, RpcConnection>();
  const observers = new Set<string>();
  const transport = createSessionBroadcastTransport({ connections, observerConnectionIds: () => observers });
  const server = { conversation: {
    has: () => true,
    addObserver: (_conversationId: string, id: string) => { observers.add(id); return true; },
    removeObserver: (_conversationId: string, id: string) => { observers.delete(id); },
  }, conversationFinalHistory: history };
  const target = new FirstPartyConversationMeshTarget({ surface: {
    dispatch: async ({ method, params, connection }) => {
      // The production Server registration seam owns this same set and cleanup.
      if (!connections.has(connection)) {
        connections.add(connection);
        connectionsByPrincipal.set(connection.surfacePrincipal!, connection);
        connection.onClose(() => { connections.delete(connection); observers.delete(String(connection.id)); });
      }
      const entry = method === 'session.subscribe' ? buildSessionSubscribeMethod() : buildSessionUnsubscribeMethod();
      return entry.handler(params, { connection, server } as never);
    },
  } });
  const request = async (command: unknown) => decode(await target.handle(encode(command), { peer: { deviceId: 'device-source' } } as never, AbortSignal.abort()));
  return { target, connections, connectionsByPrincipal, observers, transport,
    dispatch: (surface: ReturnType<typeof identity>, method: string, params: unknown) => request({ v: 1, op: 'dispatch', surface, method, params }),
    poll: (surface: ReturnType<typeof identity>) => request({ v: 1, op: 'poll', surface }),
    close: (surface: ReturnType<typeof identity>) => request({ v: 1, op: 'close', surface }),
  };
}
function relayProcess() {
  return projectProcessYield({ conversationId: 'conv', runId: 'run', assignmentId: 'assignment', streamEpoch: 1, sourceSeq: 1, observedAt: performance.now() }, {
    type: 'tool_end', id: 'edit', name: 'edit', duration: 0,
    result: { content: 'saved', presentation: { kind: 'file-diff', path: 'file.ts', operation: 'modified',
      changeStats: { kind: 'exact', addedLines: 1, removedLines: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ type: 'added', newLineNumber: 1, content: 'new' }] }] } },
  });
}

function largeRelayProcess(seq: number) {
  return projectProcessYield({ conversationId: 'conv', runId: 'run', assignmentId: 'assignment', streamEpoch: 1,
    sourceSeq: seq, observedAt: performance.now() }, {
    type: 'tool_end', id: `edit-${seq}`, name: 'edit', duration: 0,
    result: { content: 'saved', presentation: { kind: 'file-diff', path: 'file.ts', operation: 'modified',
      changeStats: { kind: 'exact', addedLines: 80, removedLines: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 80,
        lines: Array.from({ length: 80 }, (_, i) => ({ type: 'added', newLineNumber: i + 1, content: '汉'.repeat(340) })) }] } },
  });
}

async function relayChannel(target: FirstPartyConversationMeshTarget) {
  const sessionModule = await import(/* @vite-ignore */ new URL('../../../../mesh/src/session.ts', import.meta.url).href);
  const channelModule = await import(/* @vite-ignore */ new URL('../../../../mesh/src/request-channel.ts', import.meta.url).href);
  const registryModule = await import(/* @vite-ignore */ new URL('../../../../mesh/src/service-registry.ts', import.meta.url).href);
  const [sourceTransport, targetTransport] = memoryTransports(), range = { min: '1', max: '1' } as const;
  const registry = new registryModule.MeshServiceRegistry();
  registerFirstPartyConversationMeshService(registry, target, () => true);
  const secure = (transport: MeshFrameTransport, peer: string) => sessionModule.createSecureMeshConnection({
    transport, connectionId: peer, compatibility: { mode: 'read-write', protocolVersion: '1' },
    localProtocolRange: range, peerProtocolRange: range, peer: deviceIdentity(peer),
  });
  const source = new channelModule.MeshRequestChannel(secure(sourceTransport, 'device-target'), new registryModule.MeshServiceRegistry());
  const destination = new channelModule.MeshRequestChannel(secure(targetTransport, 'device-source'), registry);
  return {
    client: source as MeshServiceClient,
    request: async (command: unknown) => {
      const response: Uint8Array = await source.request(FIRST_PARTY_CONVERSATION_MESH_SERVICE, encode(command));
      expect(response.byteLength).toBeLessThanOrEqual(1024 * 1024);
      return decode(response) as { ok: boolean; notifications: { method: string; params: unknown }[]; result?: unknown };
    },
    close: () => Promise.all([source.close(), destination.close()]),
  };
}
