import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { coordinateManagedHostTrustTransition } from "./managed-service-runtime.js";

describe("managed host trust transition", () => {
  it("keeps a current anchor online after reconciling the durable plan", async () => {
    const refuseNewMessages = vi.fn();
    const requestShutdown = vi.fn();
    const reconcile = vi.fn(async () => ({
      plan: { mode: "managed" as const, roles: ["anchor"] as const },
      service: undefined,
      action: "unchanged" as const,
    }));

    await expect(coordinateManagedHostTrustTransition({
      loadCurrent: async () => current(["anchor"], "device:local"),
      reconcile,
      refuseNewMessages,
      requestShutdown,
    })).resolves.toBe("retained");
    expect(reconcile).toHaveBeenCalledWith("current-trust-applied");
    expect(refuseNewMessages).not.toHaveBeenCalled();
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("closes admission before reconciliation and then stops when authority moved", async () => {
    const order: string[] = [];
    await expect(coordinateManagedHostTrustTransition({
      loadCurrent: async () => current(["anchor"], "device:new-anchor"),
      reconcile: async () => {
        order.push("reconcile");
        return {
          plan: { mode: "none", roles: [] },
          service: undefined,
          action: "disabled",
        };
      },
      refuseNewMessages: () => order.push("refuse"),
      requestShutdown: () => order.push("shutdown"),
    })).resolves.toBe("stopped");
    expect(order).toEqual(["refuse", "reconcile", "shutdown"]);
  });
});

function current(
  roles: readonly ("anchor" | "executor" | "surface")[],
  issuer: string,
) {
  const trust: HomeTrustRecord = {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home:managed-transition",
    trustEpoch: 1,
    chainHead: { seq: 1, eventDigest: `sha256:${"1".repeat(64)}` },
    issuer: { deviceId: issuer, issuerKeyId: issuer },
    members: [{
      device: {
        deviceId: "device:local",
        publicKey: "ed25519:test",
        displayName: "Local",
        platform: "linux",
        enrolledAt: "2026-08-11T00:00:00.000Z",
      },
      roles: [...roles],
      state: "active",
    }],
    signature: { alg: "Ed25519", keyId: issuer, sig: "test" },
  };
  return {
    localDeviceId: "device:local",
    configuration: {
      enabledRoles: roles,
      ...(roles.includes("anchor")
        ? { anchorListen: { bind: { host: "127.0.0.1", port: 43121 } } }
        : {}),
    },
    trust,
  };
}
