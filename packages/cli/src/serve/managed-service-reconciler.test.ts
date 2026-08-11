import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import type {
  ManagedServiceAdapter,
  ManagedServiceInspection,
  ManagedServiceSpec,
} from "./managed-service.js";
import {
  MANAGED_SERVICE_RECONCILE_TRIGGERS,
  reconcileManagedService,
} from "./managed-service-reconciler.js";

const spec = { serviceId: "service:home" } as ManagedServiceSpec;

describe("managed service reconciliation", () => {
  it("freezes the production trigger exact-set", () => {
    expect(MANAGED_SERVICE_RECONCILE_TRIGGERS).toEqual([
      "pairing-issuer-committed",
      "pairing-joiner-committed",
      "local-role-config-committed",
      "current-trust-applied",
      "managed-preflight",
      "host-missing",
    ]);
  });

  it("installs and starts current anchor while coalescing concurrent reconciliation", async () => {
    const adapter = fakeAdapter();
    let loads = 0;
    const loadCurrent = async () => {
      loads += 1;
      return current({ roles: ["anchor", "executor"], issuer: "device:local", spec });
    };
    const signal = new AbortController().signal;
    const [left, right] = await Promise.all([
      reconcileManagedService({ trigger: "host-missing", loadCurrent, adapter, signal }),
      reconcileManagedService({ trigger: "managed-preflight", loadCurrent, adapter, signal }),
    ]);
    expect(left.plan).toEqual({ mode: "managed", roles: ["anchor", "executor"] });
    expect(right).toEqual(left);
    expect(adapter.calls).toEqual(["inspect", "install", "start"]);
    expect(loads).toBeGreaterThanOrEqual(2);
  });

  it("disables automatic launch for on-demand and none plans", async () => {
    for (const roles of [["executor"], ["surface"]] as const) {
      const adapter = fakeAdapter({ state: "enabled", running: true, matches: true });
      const result = await reconcileManagedService({
        trigger: "local-role-config-committed",
        loadCurrent: async () => current({ roles, issuer: "device:anchor", spec }),
        adapter,
        signal: new AbortController().signal,
      });
      expect(result.plan.mode).toBe(roles.includes("executor") ? "on-demand" : "none");
      expect(result.action).toBe("disabled");
      expect(adapter.calls).toEqual(["inspect", "disable"]);
    }
  });

  it("re-reads the plan before start and disables when authority changed", async () => {
    const adapter = fakeAdapter();
    let read = 0;
    const result = await reconcileManagedService({
      trigger: "managed-preflight",
      loadCurrent: async () => {
        read += 1;
        return read === 1
          ? current({ roles: ["anchor"], issuer: "device:local", spec })
          : current({ roles: ["surface"], issuer: "device:anchor", spec });
      },
      adapter,
      signal: new AbortController().signal,
    });
    expect(result.plan.mode).toBe("none");
    expect(adapter.calls).toEqual(["inspect", "install", "disable"]);
  });
});

function current(input: {
  readonly roles: readonly ("anchor" | "executor" | "surface")[];
  readonly issuer: string;
  readonly spec: ManagedServiceSpec;
}) {
  const trust: HomeTrustRecord = {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home:managed",
    trustEpoch: 1,
    chainHead: { seq: 1, eventDigest: `sha256:${"1".repeat(64)}` },
    issuer: { deviceId: input.issuer, issuerKeyId: input.issuer },
    members: [{
      device: {
        deviceId: "device:local",
        publicKey: "ed25519:test",
        displayName: "Local",
        platform: "linux",
        enrolledAt: "2026-08-11T00:00:00.000Z",
      },
      roles: [...input.roles],
      state: "active",
    }],
    signature: { alg: "Ed25519", keyId: input.issuer, sig: "test" },
  };
  return {
    localDeviceId: "device:local",
    configuration: {
      enabledRoles: input.roles,
      ...(input.roles.includes("anchor")
        ? { anchorListen: { bind: { host: "127.0.0.1", port: 43121 } } }
        : {}),
    },
    trust,
    spec: input.spec,
  };
}

function fakeAdapter(
  initial: ManagedServiceInspection = { state: "absent", running: false, matches: true },
): ManagedServiceAdapter & { readonly calls: string[] } {
  let state = initial;
  const calls: string[] = [];
  return {
    calls,
    inspect: async () => {
      calls.push("inspect");
      return state;
    },
    install: async () => {
      calls.push("install");
      state = { state: "enabled", running: false, matches: true };
      return state;
    },
    start: async () => {
      calls.push("start");
      state = { state: "enabled", running: true, matches: true };
      return state;
    },
    disable: async () => {
      calls.push("disable");
      state = { state: "disabled", running: false, matches: true };
      return state;
    },
  };
}
