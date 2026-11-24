import type { HomeTrustRecord } from "@zhixing-ai/core/contracts";
import type { MeshServiceClient } from "@zhixing-ai/mesh";
import { describe, expect, it, vi } from "vitest";
import { FirstPartyConversationMeshTarget } from "../../serve/first-party-conversation-mesh.js";
import { PROGRAM_CONVERSATION_MESH_SERVICE } from "../../serve/program-conversation-mesh.js";
import { RpcProgramConversationFacade } from "../rpc-conversation-facade.js";
import {
  createCurrentAnchorSurfaceRpcClient,
  CurrentAnchorSurfaceRpcClient,
} from "../surface-core-host-link.js";

describe("current anchor surface core-host link", () => {
  it('preflights the actual 1 MiB service envelope before opening a cold source and preserves small dispatch', async () => {
    const received: unknown[] = [];
    const target = new FirstPartyConversationMeshTarget({ surface: { dispatch: async ({ params }: { params: unknown }) => { received.push(params); return { accepted: true }; } } as never });
    const client = new CurrentAnchorSurfaceRpcClient('device:surface', {
      start: vi.fn(), stop: vi.fn(), currentTrust: () => trust('device:anchor'),
      connections: { client: () => ({ request: (_service: string, payload: Uint8Array, signal?: AbortSignal) => {
        expect(payload.byteLength).toBeLessThanOrEqual(1024 * 1024);
        return target.handle(payload, { peer: { deviceId: 'device:surface' } } as never, signal ?? new AbortController().signal);
      } }) },
    } as never, { stopStorageMaintenance: vi.fn() });
    await client.connect();
    const maximum = client.maximumRequestSourceBytes('session.send'), open = vi.fn();
    expect(maximum).toBeLessThan(1024 * 1024);
    await expect(client.requestEncoded('session.send', { byteLength: maximum + 1, open })).rejects.toThrow('容量');
    expect(open).not.toHaveBeenCalled(); expect(received).toEqual([]);
    const original = { turnId: 'stable-turn', input: { parts: [{ type: 'text', text: '同一内容' }] } };
    const bytes = Buffer.from(JSON.stringify(original)), release = vi.fn();
    expect(await client.requestEncoded('session.send', { byteLength: bytes.length, open: () => ({
      async read(offset, length) { return bytes.subarray(offset, offset + length); }, release,
    }) })).toEqual({ accepted: true });
    expect(received).toEqual([original]); expect(release).toHaveBeenCalledOnce(); await client.close();
  });

  it('keeps remote hot preparation in drain after close until the actual callback exits', async () => {
    const client = new CurrentAnchorSurfaceRpcClient('device:surface', {
      start: vi.fn(), stop: vi.fn(), currentTrust: () => trust('device:anchor'), connections: { client: vi.fn() },
    } as never, { stopStorageMaintenance: vi.fn() });
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const preparing = client.prepareRequestSource(async signal => {
      entered.resolve(); await finish.promise; expect(signal.aborted).toBe(true); return undefined;
    }).catch(error => error);
    await entered.promise; await client.close();
    let drained = false; const draining = client.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    finish.resolve(); await draining; expect(await preparing).toBeInstanceOf(Error);
  });
  it("真实两侧转发边界保留三种 awaiting 处置及完整 delta 信封", async () => {
    for (const disposition of ["original-saved", "revision-saved", "not-saved"]) {
      const result = { conversationId: "conv-1", sessionId: "conv-1", turnId: "original", status: "awaiting-rubric-confirmation", submission: { turnId: "current", disposition }, rubricDraftId: "draft", rubricDraft: { originalTurnId: "original" }, advancementSessionId: "adv" };
      const delta = { conversationId: "conv-1", sessionId: "conv-1", turnId: "original", delta: { type: "tool_start", id: "tool-1", name: "read", input: { path: "synthetic.txt" } } };
      const target = new FirstPartyConversationMeshTarget({ surface: { dispatch: async ({ connection }: { connection: { notify(method: string, params: unknown): void } }) => {
        connection.notify("session.delta", delta);
        return result;
      } } as never });
      const client = new CurrentAnchorSurfaceRpcClient("device:surface", {
        start: vi.fn(), stop: vi.fn(), currentTrust: () => trust("device:anchor"),
        connections: { client: () => ({ request: (_service: string, payload: Uint8Array, signal?: AbortSignal) => target.handle(payload, { peer: { deviceId: "device:surface" } } as never, signal ?? new AbortController().signal) }) },
      } as never, { stopStorageMaintenance: vi.fn() });
      const received: unknown[] = [];
      client.onNotification("session.delta", value => received.push(value));
      await client.connect();
      expect(await client.request("session.send", { conversationId: "conv-1", turnId: "current", text: "本次输入" })).toEqual(result);
      expect(received).toContainEqual(delta);
      await client.close();
    }
  });
  it("consumes only the Configuration Provider topology projection", async () => {
    const readTopology = vi.fn(() => Object.freeze({}));

    await expect(
      createCurrentAnchorSurfaceRpcClient({
        zhixingHome: "C:/bound-data-root",
        configuration: { readTopology },
      }),
    ).rejects.toThrow("这台设备尚未完成家庭配置");

    expect(readTopology).toHaveBeenCalledOnce();
    expect(readTopology.mock.calls[0]?.[0]).toEqual({
      homeDir: "C:/bound-data-root",
    });
  });

  it("relays only canonical methods, replaces the old owner and closes every poll", async () => {
    let owner = "device:anchor-a";
    let trustEpoch = 1;
    const requests: Array<{ deviceId: string; op: string; method?: string }> = [];
    const clientFor = (deviceId: string): MeshServiceClient => ({
      request: async (_serviceId, payload, signal) => {
        const command = JSON.parse(Buffer.from(payload).toString("utf8")) as {
          op: string;
          method?: string;
        };
        requests.push({ deviceId, op: command.op, ...(command.method ? { method: command.method } : {}) });
        if (command.op === "poll") {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return Buffer.from(JSON.stringify({
          v: 1,
          ok: true,
          ...(command.op === "dispatch" ? { result: `${deviceId}:ok` } : {}),
          notifications: command.op === "dispatch"
            ? [{ method: "conversation.status", params: { owner: deviceId } }]
            : [],
        }));
      },
    });
    const control = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      currentTrust: () => trust(owner, trustEpoch),
      connections: { client: clientFor },
    };
    const bootstrapStore = { stopStorageMaintenance: vi.fn() };
    const client = new CurrentAnchorSurfaceRpcClient(
      "device:surface",
      control as never,
      bootstrapStore,
    );
    const notices: unknown[] = [];
    client.onNotification("conversation.status", (notice) => notices.push(notice));
    await client.connect();
    await expect(client.request("session.list", {})).resolves.toBe("device:anchor-a:ok");
    await expect(client.request("server.shutdown", {})).rejects.toThrow(/不能.*代理/u);
    trustEpoch = 2;
    await client.reconcileOwner(trust(owner, trustEpoch));
    await expect(client.request("session.list", {})).resolves.toBe("device:anchor-a:ok");
    owner = "device:anchor-b";
    trustEpoch = 3;
    await client.reconcileOwner(trust(owner, trustEpoch));
    await expect(client.request("session.list", {})).resolves.toBe("device:anchor-b:ok");
    expect(notices).toEqual([
      { owner: "device:anchor-a" },
      { owner: "device:anchor-a" },
      { owner: "device:anchor-b" },
    ]);
    expect(requests).toEqual(expect.arrayContaining([
      { deviceId: "device:anchor-a", op: "dispatch", method: "session.list" },
      { deviceId: "device:anchor-a", op: "close" },
      { deviceId: "device:anchor-b", op: "dispatch", method: "session.list" },
    ]));
    await client.close();
    expect(control.stop).toHaveBeenCalledOnce();
    expect(bootstrapStore.stopStorageMaintenance).toHaveBeenCalledOnce();
  });

  it("returns a stable retryable action when the current anchor is offline", async () => {
    const control = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      currentTrust: () => trust("device:anchor"),
      connections: {
        client: () => ({ request: async () => { throw new Error("raw transport failure"); } }),
      },
    };
    const client = new CurrentAnchorSurfaceRpcClient(
      "device:surface",
      control as never,
      { stopStorageMaintenance: vi.fn() },
    );
    await client.connect();
    await expect(client.request("session.list", {})).rejects.toThrow(
      "值班设备暂时离线，请稍后重试",
    );
    await client.close();
  });

  it("deducts surface client bootstrap and anchor peer-ready wait from conversation.program.result waitMs", async () => {
    const observedWaitMs: number[] = [];
    let peerReady = false;
    const control = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      currentTrust: () => trust("device:anchor"),
      connections: {
        has: (id: string) => id === "device:anchor" && peerReady,
        client: () => ({
          request: async (serviceId: string, payload: Uint8Array) => {
            expect(serviceId).toBe(PROGRAM_CONVERSATION_MESH_SERVICE);
            const cmd = JSON.parse(Buffer.from(payload).toString("utf8")) as {
              params: { conversationId: string; requestId: string; waitMs?: number };
            };
            observedWaitMs.push(cmd.params.waitMs ?? -1);
            return Buffer.from(
              JSON.stringify({
                v: 1,
                ok: true,
                result: {
                  v: 1,
                  state: "pending",
                  conversationId: cmd.params.conversationId,
                  requestId: cmd.params.requestId,
                  runId: "run-wait-check",
                  runState: "running",
                },
              }),
            );
          },
        }),
      },
    };
    const client = new CurrentAnchorSurfaceRpcClient(
      "device:surface",
      control as never,
      { stopStorageMaintenance: vi.fn() },
    );
    await client.connect();

    // Case 1: peer-ready wait (~180ms) exceeds caller waitMs (80ms) -> downstream receives waitMs === 0 immediately on connect
    setTimeout(() => {
      peerReady = true;
    }, 180);
    const resExhausted = await client.request("conversation.program.result", {
      conversationId: "default",
      requestId: "req-wait-exhausted",
      waitMs: 80,
    });
    expect(resExhausted).toMatchObject({ state: "pending", runId: "run-wait-check" });
    expect(observedWaitMs[0]).toBe(0);

    // Case 2: peer-ready wait (~140ms) + facade getClient bootstrap (~80ms) both deduct from caller waitMs (650ms)
    peerReady = false;
    const facade = new RpcProgramConversationFacade({
      getClient: async () => {
        await new Promise((r) => setTimeout(r, 80));
        setTimeout(() => {
          peerReady = true;
        }, 140);
        return client;
      },
      onNotification: () => () => {},
    } as never);
    const resRemaining = await facade.result({
      conversationId: "default",
      requestId: "req-wait-remaining",
      waitMs: 650,
    });
    expect(resRemaining).toMatchObject({ state: "pending", runId: "run-wait-check" });
    expect(observedWaitMs[1]).toBeGreaterThan(0);
    expect(observedWaitMs[1]).toBeLessThanOrEqual(460);

    // Case 3: requestEncoded deducts local queue drain wait (behind an in-flight list request) for both exhausted and remaining budgets
    peerReady = true;
    for (const [budget, expectZero] of [
      [120, true],
      [750, false],
    ] as const) {
      const listEntered = Promise.withResolvers<void>();
      const releaseList = Promise.withResolvers<void>();
      const encodedObserved: number[] = [];
      const drainClient = new CurrentAnchorSurfaceRpcClient(
        "device:surface",
        {
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
          currentTrust: () => trust("device:anchor"),
          connections: {
            has: () => true,
            client: () => ({
              request: async (_serviceId: string, payload: Uint8Array) => {
                const cmd = JSON.parse(Buffer.from(payload).toString("utf8")) as {
                  action: string;
                  params: { conversationId?: string; requestId?: string; waitMs?: number };
                };
                if (cmd.action === "list") {
                  listEntered.resolve();
                  await releaseList.promise;
                  return Buffer.from(
                    JSON.stringify({ v: 1, ok: true, result: { entries: [], partial: false } }),
                  );
                }
                encodedObserved.push(cmd.params.waitMs ?? -1);
                return Buffer.from(
                  JSON.stringify({
                    v: 1,
                    ok: true,
                    result: {
                      v: 1,
                      state: "pending",
                      conversationId: cmd.params.conversationId,
                      requestId: cmd.params.requestId,
                      runId: "run-encoded",
                      runState: "running",
                    },
                  }),
                );
              },
            }),
          },
        } as never,
        { stopStorageMaintenance: vi.fn() },
      );
      await drainClient.connect();
      const inFlightList = drainClient.request("conversation.program.list", {});
      await listEntered.promise;
      const bytes = Buffer.from(
        JSON.stringify({ conversationId: "default", requestId: "req-enc", waitMs: budget }),
      );
      const source = {
        byteLength: bytes.length,
        open: () => ({
          read: async (offset: number, max: number) => bytes.subarray(offset, offset + max),
          release: () => {},
        }),
      };
      const encodedPromise = drainClient.requestEncoded("conversation.program.result", source);
      await new Promise((r) => setTimeout(r, 320));
      releaseList.resolve();
      await inFlightList;
      const encodedOut = await encodedPromise;
      expect(encodedOut).toMatchObject({ state: "pending", runId: "run-encoded" });
      if (expectZero) {
        expect(encodedObserved[0]).toBe(0);
      } else {
        expect(encodedObserved[0]).toBeGreaterThan(0);
        expect(encodedObserved[0]).toBeLessThanOrEqual(450);
      }
      await drainClient.close();
    }

    await client.close();
  });
});

function trust(issuerDeviceId: string, trustEpoch = 1): HomeTrustRecord {
  return {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home:surface",
    trustEpoch,
    chainHead: {
      seq: trustEpoch,
      eventDigest: `sha256:${String(trustEpoch).repeat(64).slice(0, 64)}`,
    },
    issuer: { deviceId: issuerDeviceId, issuerKeyId: issuerDeviceId },
    members: [],
    signature: { alg: "Ed25519", keyId: issuerDeviceId, sig: "test" },
  };
}
