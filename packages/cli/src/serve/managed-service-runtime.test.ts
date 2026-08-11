import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  captureManagedHostAdmission,
  coordinateManagedHostTrustTransition,
  verifyManagedHostAdmission,
} from "./managed-service-runtime.js";

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

  it("closes admission and enters graceful shutdown before any supervisor stop when authority moved", async () => {
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
    expect(order).toEqual(["refuse", "shutdown"]);
  });

  it("restarts the current profile when trust generation changes without changing launch mode", async () => {
    const before = current(["anchor", "executor"], "device:local");
    const after = {
      ...current(["anchor"], "device:local"),
      trust: {
        ...current(["anchor"], "device:local").trust,
        trustEpoch: 2,
        chainHead: { seq: 2, eventDigest: `sha256:${"2".repeat(64)}` },
      },
    };
    const expectedAdmission = await captureManagedHostAdmission(
      "managed",
      "home",
      async () => before,
    );
    const order: string[] = [];

    await expect(coordinateManagedHostTrustTransition({
      expectedAdmission,
      loadCurrent: async () => after,
      reconcile: async () => {
        order.push("reconcile");
        return {
          plan: { mode: "managed", roles: ["anchor"] },
          service: undefined,
          action: "unchanged",
        };
      },
      refuseNewMessages: () => order.push("refuse"),
      requestShutdown: () => order.push("shutdown"),
    })).resolves.toBe("stopped");
    expect(order).toEqual(["refuse", "shutdown"]);
  });

  it.each([
    ["on-demand", ["anchor"] as const, "device:local", "stopped"],
    ["foreground", ["anchor"] as const, "device:local", "retained"],
    ["foreground", ["surface"] as const, "device:new-anchor", "stopped"],
  ] as const)(
    "applies the current plan gate to the %s process shape",
    async (processMode, roles, issuer, expected) => {
      const refuseNewMessages = vi.fn();
      const requestShutdown = vi.fn();
      await expect(coordinateManagedHostTrustTransition({
        processMode,
        loadCurrent: async () => current(roles, issuer),
        reconcile: async () => ({
          plan: { mode: "managed", roles: ["anchor"] },
          service: undefined,
          action: "unchanged",
        }),
        refuseNewMessages,
        requestShutdown,
      })).resolves.toBe(expected);
      expect(refuseNewMessages).toHaveBeenCalledTimes(expected === "stopped" ? 1 : 0);
      expect(requestShutdown).toHaveBeenCalledTimes(expected === "stopped" ? 1 : 0);
    },
  );

  it("rejects listener admission when the current plan/spec generation changes", async () => {
    const first = current(["anchor"], "device:local");
    const next = {
      ...first,
      trust: { ...first.trust, trustEpoch: 2 },
    };
    const snapshot = await captureManagedHostAdmission(
      "managed",
      "home",
      async () => first,
    );
    await expect(verifyManagedHostAdmission(
      snapshot,
      "managed",
      "home",
      async () => next,
    )).resolves.toBe(false);
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
