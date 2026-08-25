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
      reconcileManagedService({ homeKey: "home", trigger: "host-missing", loadCurrent, adapter, signal }),
      reconcileManagedService({ homeKey: "home", trigger: "managed-preflight", loadCurrent, adapter, signal }),
    ]);
    expect(left.plan).toEqual({ mode: "managed", roles: ["anchor", "executor"] });
    expect(right).toEqual(left);
    expect(adapter.calls).toEqual(["inspect", "install", "start", "inspect"]);
    expect(loads).toBeGreaterThanOrEqual(2);
  });

  it.each(MANAGED_SERVICE_RECONCILE_TRIGGERS)(
    "limits %s reconciliation to future launch across every non-managed boundary",
    async (trigger) => {
      const signal = new AbortController().signal;
      const nonManaged = fakeAdapter({ state: "enabled", running: true, matches: true });
      await expect(reconcileManagedService({
        homeKey: `home-${trigger}-non-managed`,
        trigger,
        loadCurrent: async () => current({ roles: ["surface"], issuer: "device:anchor", spec }),
        adapter: nonManaged,
        signal,
      })).resolves.toMatchObject({
        plan: { mode: "none" },
        action: "future-disabled",
        service: { state: "disabled", running: true },
      });
      expect(nonManaged.calls).toEqual(["inspect", "disable-future"]);

      const dutyCandidate = fakeAdapter({ state: "enabled", running: true, matches: true });
      await expect(reconcileManagedService({
        homeKey: `home-${trigger}-duty-candidate`,
        trigger,
        loadCurrent: async () => current({ roles: ["anchor"], issuer: "device:remote", spec }),
        adapter: dutyCandidate,
        signal,
      })).resolves.toMatchObject({
        plan: { mode: "managed", roles: ["anchor"] },
        action: "unchanged",
      });
      expect(dutyCandidate.calls).toEqual(["inspect"]);

      const driftAfterInstall = fakeAdapter();
      let read = 0;
      await expect(reconcileManagedService({
        homeKey: `home-${trigger}-post-install-drift`,
        trigger,
        loadCurrent: async () => {
          read += 1;
          return read === 1
            ? current({ roles: ["anchor"], issuer: "device:local", spec })
            : current({ roles: ["surface"], issuer: "device:anchor", spec });
        },
        adapter: driftAfterInstall,
        signal,
      })).resolves.toMatchObject({
        plan: { mode: "none" },
        action: "future-disabled",
      });
      expect(driftAfterInstall.calls).toEqual(["inspect", "install", "disable-future"]);
    },
  );

  it("keeps one canonical-home worker across binding changes and drains a late wake", async () => {
    const adapter = fakeAdapter();
    const first = current({ roles: ["anchor"], issuer: "device:local", spec });
    const nextSpec = { serviceId: "service:home-after-binding" } as ManagedServiceSpec;
    const next = current({ roles: ["anchor"], issuer: "device:local", spec: nextSpec });
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let loads = 0;
    const loadCurrent = async () => {
      loads += 1;
      if (loads === 1) await blocked;
      return loads === 1 ? first : next;
    };
    const signal = new AbortController().signal;
    const left = reconcileManagedService({
      homeKey: "same-home",
      trigger: "pairing-issuer-committed",
      loadCurrent,
      adapter,
      signal,
    });
    await Promise.resolve();
    const right = reconcileManagedService({
      homeKey: "same-home",
      trigger: "pairing-joiner-committed",
      loadCurrent,
      adapter,
      signal,
    });
    releaseFirst();
    await expect(Promise.all([left, right])).resolves.toHaveLength(2);
    expect(loads).toBeGreaterThanOrEqual(4);
    expect(adapter.calls).toEqual([
      "inspect",
      "install",
      "disable-future",
      "inspect",
      "install",
      "start",
    ]);
  });

  it.each(["load", "manager", "apply"] as const)(
    "gives joined callers one shared successor after a %s failure",
    async (failure) => {
      let releaseFirst!: () => void;
      let enteredFirst!: () => void;
      const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
      let firstLoads = 0;
      const firstAdapter = fakeAdapter();
      const originalInspect = firstAdapter.inspect.bind(firstAdapter);
      const originalStart = firstAdapter.start.bind(firstAdapter);
      firstAdapter.inspect = async (inputSpec, signal) => {
        if (failure === "manager") throw new Error("first manager failure");
        return originalInspect(inputSpec, signal);
      };
      firstAdapter.start = async (inputSpec, signal) => {
        if (failure === "apply") throw new Error("first apply failure");
        return originalStart(inputSpec, signal);
      };
      const firstLoad = async () => {
        firstLoads += 1;
        if (firstLoads === 1) {
          enteredFirst();
          await blocked;
          if (failure === "load") throw new Error("first load failure");
        }
        return current({ roles: ["anchor"], issuer: "device:local", spec });
      };
      const successorAdapter = fakeAdapter();
      let successorLoads = 0;
      const successorLoad = async () => {
        successorLoads += 1;
        return current({ roles: ["anchor"], issuer: "device:local", spec });
      };
      const signal = new AbortController().signal;
      const first = reconcileManagedService({
        homeKey: `failed-home-${failure}`,
        trigger: "host-missing",
        loadCurrent: firstLoad,
        adapter: firstAdapter,
        signal,
      });
      const firstFailure = expect(first).rejects.toThrow(`first ${failure} failure`);
      await entered;
      const joined = [
        reconcileManagedService({
          homeKey: `failed-home-${failure}`,
          trigger: "managed-preflight",
          loadCurrent: successorLoad,
          adapter: successorAdapter,
          signal,
        }),
        reconcileManagedService({
          homeKey: `failed-home-${failure}`,
          trigger: "current-trust-applied",
          loadCurrent: successorLoad,
          adapter: successorAdapter,
          signal,
        }),
      ];
      releaseFirst();
      await firstFailure;
      await expect(Promise.all(joined)).resolves.toHaveLength(2);
      expect(successorAdapter.calls.filter((call) => call === "start")).toHaveLength(1);
      expect(successorLoads).toBeGreaterThanOrEqual(3);
    },
  );

  it("does not recursively replace a failed successor", async () => {
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const signal = new AbortController().signal;
    const first = reconcileManagedService({
      homeKey: "persistently-failed-home",
      trigger: "host-missing",
      loadCurrent: async () => {
        enteredFirst();
        await blocked;
        throw new Error("initial failure");
      },
      adapter: fakeAdapter(),
      signal,
    });
    const firstFailure = expect(first).rejects.toThrow("initial failure");
    await entered;
    let successorLoads = 0;
    const joined = reconcileManagedService({
      homeKey: "persistently-failed-home",
      trigger: "managed-preflight",
      loadCurrent: async () => {
        successorLoads += 1;
        throw new Error("successor failure");
      },
      adapter: fakeAdapter(),
      signal,
    });
    releaseFirst();
    await firstFailure;
    await expect(joined).rejects.toThrow("successor failure");
    expect(successorLoads).toBe(1);
  });

  it("read-backs an effect whose response was lost instead of repeating it", async () => {
    let service: ManagedServiceInspection = { state: "absent", running: false, matches: true };
    let releaseStart!: () => void;
    let enteredStart!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseStart = resolve; });
    const entered = new Promise<void>((resolve) => { enteredStart = resolve; });
    let starts = 0;
    const adapter: ManagedServiceAdapter = {
      inspect: async () => service,
      install: async () => {
        service = { state: "enabled", running: false, matches: true };
        return service;
      },
      start: async () => {
        starts += 1;
        enteredStart();
        await blocked;
        service = { state: "enabled", running: true, matches: true };
        throw new Error("start response lost");
      },
      disableFuture: async () => {
        service = { ...service, state: "disabled" };
        return service;
      },
      disable: async () => {
        service = { state: "disabled", running: false, matches: true };
        return service;
      },
    };
    const input = {
      homeKey: "effect-response-home",
      loadCurrent: async () => current({ roles: ["anchor"], issuer: "device:local", spec }),
      adapter,
      signal: new AbortController().signal,
    };
    const first = reconcileManagedService({ ...input, trigger: "host-missing" });
    const firstFailure = expect(first).rejects.toThrow("start response lost");
    await entered;
    const joined = reconcileManagedService({ ...input, trigger: "managed-preflight" });
    releaseStart();
    await firstFailure;
    await expect(joined).resolves.toMatchObject({ action: "unchanged" });
    expect(starts).toBe(1);
  });

  it("keeps different canonical homes independent", async () => {
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const signal = new AbortController().signal;
    const first = reconcileManagedService({
      homeKey: "independent-home-left",
      trigger: "host-missing",
      loadCurrent: async () => {
        enteredFirst();
        await blocked;
        return current({ roles: ["anchor"], issuer: "device:local", spec });
      },
      adapter: fakeAdapter(),
      signal,
    });
    await entered;
    await expect(reconcileManagedService({
      homeKey: "independent-home-right",
      trigger: "host-missing",
      loadCurrent: async () => current({ roles: ["anchor"], issuer: "device:local", spec }),
      adapter: fakeAdapter(),
      signal,
    })).resolves.toMatchObject({ action: "installed-and-started" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ action: "installed-and-started" });
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
    disableFuture: async () => {
      calls.push("disable-future");
      state = { ...state, state: "disabled" };
      return state;
    },
    disable: async () => {
      calls.push("disable");
      state = { state: "disabled", running: false, matches: true };
      return state;
    },
  };
}
