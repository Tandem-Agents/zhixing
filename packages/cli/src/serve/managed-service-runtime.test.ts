import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import {
  createPlatformSecretStore,
  readPlatformSecretStoreBackendBinding,
} from "@zhixing/secrets";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  captureManagedHostAdmission,
  coordinateManagedHostTrustTransition,
  loadCurrentManagedServiceState,
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

describe("managed service current-state intent", () => {
  it("keeps inspect read-only when a fresh home has no backend binding", async () => {
    const homeDir = await createTempDir("managed-current-inspect-fresh");
    await withManagedEnvironment(undefined, undefined, async () => {
      await expect(loadCurrentManagedServiceState("inspect", homeDir)).rejects.toThrow(
        "local-credentials-unavailable",
      );
      expect((await readdir(homeDir)).filter((name) => name.startsWith("secret-vault"))).toEqual([]);
    });
  });

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "backfills a legacy binding only during activation and projects it in the same load",
    async () => {
      const homeDir = await createTempDir("managed-current-legacy-activation");
      let backend: Awaited<ReturnType<typeof readPlatformSecretStoreBackendBinding>>;
      await withManagedEnvironment(undefined, undefined, async () => {
        const store = createPlatformSecretStore({ homeDir, context: "foreground" });
        expect(await store.unlockState()).toBe("unlocked");
        backend = await readPlatformSecretStoreBackendBinding(homeDir);
      });
      expect(backend).toBeDefined();
      await rm(path.join(homeDir, "secret-vault.backend.json"));

      await withManagedEnvironment("1", backend, async () => {
        await expect(loadCurrentManagedServiceState("inspect", homeDir)).rejects.toThrow(
          "local-credentials-unavailable",
        );
        expect(await readPlatformSecretStoreBackendBinding(homeDir)).toBeUndefined();

        const activated = await loadCurrentManagedServiceState("activate", homeDir);
        expect(activated.spec?.backend).toBe(backend);
        expect(await readPlatformSecretStoreBackendBinding(homeDir)).toBe(backend);
        await expect(loadCurrentManagedServiceState("activate", homeDir)).resolves.toEqual(
          activated,
        );
      });
    },
    30_000,
  );

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "rejects an existing binding that conflicts with the managed launch identity",
    async () => {
      const homeDir = await createTempDir("managed-current-binding-mismatch");
      let backend: Awaited<ReturnType<typeof readPlatformSecretStoreBackendBinding>>;
      await withManagedEnvironment(undefined, undefined, async () => {
        const store = createPlatformSecretStore({ homeDir, context: "foreground" });
        expect(await store.unlockState()).toBe("unlocked");
        backend = await readPlatformSecretStoreBackendBinding(homeDir);
      });
      expect(backend).toBeDefined();
      const mismatched = backend === "windows-dpapi" ? "machine-bound" : "windows-dpapi";

      await withManagedEnvironment("1", mismatched, async () => {
        await expect(loadCurrentManagedServiceState("activate", homeDir)).rejects.toThrow(
          "local-credentials-unavailable",
        );
        expect(await readPlatformSecretStoreBackendBinding(homeDir)).toBe(backend);
      });
    },
    30_000,
  );
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

async function withManagedEnvironment<T>(
  managed: string | undefined,
  backend: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = {
    managed: process.env.ZHIXING_MANAGED,
    backend: process.env.ZHIXING_SECRET_BACKEND,
  };
  setEnvironment("ZHIXING_MANAGED", managed);
  setEnvironment("ZHIXING_SECRET_BACKEND", backend);
  try {
    return await run();
  } finally {
    setEnvironment("ZHIXING_MANAGED", previous.managed);
    setEnvironment("ZHIXING_SECRET_BACKEND", previous.backend);
  }
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
