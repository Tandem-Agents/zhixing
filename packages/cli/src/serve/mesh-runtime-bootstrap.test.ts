import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { CheckpointStreamRecord } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import { projectRecoveryReadiness } from "@zhixing/mesh/bootstrap-authority";
import { createRootActivationCheckpoint } from "@zhixing/mesh/checkpoint";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { createRecoveryRootEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { activateInitialRecoveryRoot } from "./mesh-pair-command.js";

vi.setConfig({ testTimeout: 30_000 });

describe("production mesh runtime bootstrap", () => {
  it("rejects invalid role configuration before creating a device key", async () => {
    const root = await createTempDir("mesh-runtime-invalid-config");
    const secrets = new MemorySecretStore();

    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "0.0.0.0", port: 7443 } },
      },
    })).rejects.toThrow(/requires direct or relay reachability/);
    expect(secrets.values.size).toBe(0);
  });

  it("does not start a trusted-home mesh before recovery-root activation", async () => {
    const root = await createTempDir("mesh-runtime-recovery-root-guard");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "home anchor",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
    });
    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    })).rejects.toThrow("recovery root is not activated");
  });

  it("keeps the pre-genesis topology local and switches permanently to trust-authorized roles", async () => {
    const root = await createTempDir("mesh-runtime-bootstrap");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
    });
    expect(local.mode).toBe("single-machine");
    expect(local.roles).toEqual(["anchor", "executor"]);

    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "home anchor",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
    });
    await activateInitialRecoveryRoot({
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: "backup-device:test-recovery-target",
      targetIndependenceDomain: "device:test-recovery-target",
      createTarget: () => FileRecoveryCheckpointTarget.openPaired({
        targetRoot: `${root}/recovery-target`,
        targetDeviceId: "test-recovery-target",
      }),
      writeLine: () => undefined,
      confirmRecoveryPackage: async (value) => value,
    });

    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
    })).rejects.toThrow("requires role configuration");
    const trusted = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    });
    expect(trusted.mode).toBe("trusted-home");
    if (trusted.mode !== "trusted-home") throw new Error("expected trusted home");
    expect(trusted.roles).toEqual(["anchor"]);
    expect(trusted.localEndpoint?.transports).toEqual([
      { kind: "direct", host: "127.0.0.1", port: 7443 },
    ]);
    const replay = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    });
    expect(replay.mode).toBe("trusted-home");
    if (replay.mode !== "trusted-home") throw new Error("expected trusted home");
    expect(replay.localEndpoint?.revision).toBe(trusted.localEndpoint?.revision);
  });

  it("rejects a configured role outside the signed trust projection", async () => {
    const root = await createTempDir("mesh-runtime-role-guard");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "executor",
      platform: "headless",
      enrolledAt: new Date().toISOString(),
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor"],
    });
    await activateInitialRecoveryRoot({
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: "backup-device:test-recovery-target",
      targetIndependenceDomain: "device:test-recovery-target",
      createTarget: () => FileRecoveryCheckpointTarget.openPaired({
        targetRoot: `${root}/recovery-target`,
        targetDeviceId: "test-recovery-target",
      }),
      writeLine: () => undefined,
      confirmRecoveryPackage: async (value) => value,
    });
    await expect(prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["executor"],
      },
    })).rejects.toThrow("not authorized");
  });

  it("replays a legacy trust-only checkpoint without claiming full backup readiness", async () => {
    const root = await createTempDir("mesh-runtime-legacy-recovery");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "legacy home anchor",
      platform: "headless",
      enrolledAt: "2026-08-08T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
    });
    const legacyRoot = RecoveryRoot.generate();
    const plan = {
      v: 1 as const,
      kind: "establish" as const,
      rootEvent: createRecoveryRootEvent({
        current: initialized.projection,
        op: "establish",
        candidate: legacyRoot,
        outerSigner: local.deviceKey,
        at: "2026-08-08T00:00:01.000Z",
      }),
    };
    const legacyCheckpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000020",
      createdAt: "2026-08-08T00:00:01.000Z",
      plan,
      recoveryRoot: legacyRoot,
      issuer: local.deviceKey,
      scope: ["trust"],
      domainRevisions: { trust: initialized.projection.chainHead.seq },
      upToLsn: initialized.projection.chainHead.seq,
      plaintextChunks: [Buffer.from("legacy trust checkpoint")],
    });
    const legacyPackage = `zxrp1:${Buffer.from(canonicalize({
      checkpoint: {
        chunks: legacyCheckpoint.chunks.map((chunk) => ({
          seq: chunk.seq,
          bytes: Buffer.from(chunk.bytes).toString("base64url"),
        })),
        envelope: legacyCheckpoint.envelope,
      },
      recoverySecret: legacyRoot.exportSecret(),
      v: 1,
    }), "utf8").toString("base64url")}`;
    const activate = () => activateInitialRecoveryRoot({
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: "backup-device:legacy-recovery-target",
      targetIndependenceDomain: "device:legacy-recovery-target",
      createTarget: () => FileRecoveryCheckpointTarget.openPaired({
        targetRoot: `${root}/legacy-recovery-target`,
        targetDeviceId: "legacy-recovery-target",
      }),
      writeLine: () => undefined,
      confirmRecoveryPackage: async () => legacyPackage,
    });
    const activated = await activate();
    const replayed = await activate();
    expect(replayed.chainHead).toEqual(activated.chainHead);
    const records = await local.bootstrapStore.loadCheckpointRecords();
    const createdRecords = records.filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
      record.t === "checkpoint-created");
    const verifiedRecords = records.filter((record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }> =>
      record.t === "checkpoint-verified");
    const durableLegacy = await local.bootstrapStore.bootstrapAuthority()
      .loadCheckpointPackage(createdRecords[0]!.envelopeRef);
    expect(durableLegacy?.chunks).toHaveLength(legacyCheckpoint.envelope.chunks.length);
    expect(projectRecoveryReadiness({
      trust: activated,
      createdRecords,
      verifiedRecords,
      checkpointEnvelopes: [legacyCheckpoint.envelope],
    })).toMatchObject({ ready: true, fullBackupReady: false });
  }, 120_000);
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(key(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(key(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(key(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function key(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
