import type { HomeTrustRecord } from "@zhixing/core/contracts";
import type { MeshServiceClient } from "@zhixing/mesh";
import { describe, expect, it, vi } from "vitest";
import { CurrentAnchorSurfaceRpcClient } from "../surface-core-host-link.js";

describe("current anchor surface core-host link", () => {
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
