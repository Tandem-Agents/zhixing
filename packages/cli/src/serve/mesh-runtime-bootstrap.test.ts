import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { CheckpointStreamRecord } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { projectRecoveryReadiness } from "@zhixing/mesh/bootstrap-authority";
import { createRootActivationCheckpoint } from "@zhixing/mesh/checkpoint";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { createRecoveryRootEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { prepareMeshRuntimeBootstrap as prepareProductionMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { activateInitialRecoveryRoot } from "./mesh-pair-command.js";
import { createPlannedAnchorTransferStagingInfrastructure } from "./planned-anchor-transfer-staging-infrastructure.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";

vi.setConfig({ testTimeout: 30_000 });

function prepareMeshRuntimeBootstrap(
  input: Omit<Parameters<typeof prepareProductionMeshRuntimeBootstrap>[0],
    "plannedAnchorTransferStaging">,
) {
  return prepareProductionMeshRuntimeBootstrap({
    ...input,
    plannedAnchorTransferStaging: createPlannedAnchorTransferStagingInfrastructure({
      zhixingHome: input.zhixingHome,
      ...(input.storageMaintenance
        ? { storageMaintenance: input.storageMaintenance }
        : {}),
    }),
  });
}

describe("production mesh runtime bootstrap", () => {
  it("rejects a removed executor identity before ordinary runtime bootstrap and never recreates its key", async () => {
    const root = await createTempDir("mesh-runtime-removed-device");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "removed executor",
      platform: "headless",
      enrolledAt: "2026-08-12T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
      homeId: "home-removed",
      at: "2026-08-12T00:00:00.000Z",
    });
    const executorLog = new FileAuthorityCommitLog(
      path.join(root, "distributed-runtime", "executor-authority"),
      local.bootstrapStore.artifactStore(),
    );
    const journal = new DeviceLifecycleJournal(
      executorLog,
      createTrustedDeviceProtocolVerifier([identity]),
    );
    await journal.accept({
      v: 1,
      kind: "executor-removal",
      requestId: "request-remove",
      operationId: "remove-local",
      homeId: initialized.projection.homeId,
      targetDeviceId: local.deviceKey.deviceId,
      targetMemberPublicKey: local.deviceKey.publicKey,
      targetDeviceKeyGeneration: protocolDigest("DeviceKeyGeneration", 1, {
        deviceId: local.deviceKey.deviceId,
        publicKey: local.deviceKey.publicKey,
      }),
      acceptedIssuerDeviceId: "previous-duty-device",
      acceptedTrustHeadDigest: initialized.projection.chainHead.eventDigest,
    });
    for (const phase of [
      "gate-frozen",
      "authority-decided",
      "authority-settled",
      "revocation-ready",
      "revoked",
      "cleanup-complete",
    ] as const) await journal.advance("remove-local", phase);
    await journal.terminal("remove-local", "removed");

    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets }))
      .rejects.toThrow("pair it again to create a new identity");
    expect((await secrets.list("")).filter((ref) => ref.kind === "device-key")).toHaveLength(0);
    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets }))
      .rejects.toThrow("pair it again to create a new identity");
  });

  it("keeps a retired anchor home closed to ordinary startup", async () => {
    const root = await createTempDir("mesh-runtime-retired-anchor");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "retired anchor",
      platform: "headless",
      enrolledAt: "2026-08-12T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor"],
      homeId: "home-retired",
      at: "2026-08-12T00:00:00.000Z",
    });
    const journal = new DeviceLifecycleJournal(
      local.bootstrapStore.authorityLog(),
      createTrustedDeviceProtocolVerifier([identity]),
    );
    await journal.accept({
      v: 1,
      kind: "anchor-uninstall",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      homeId: initialized.projection.homeId,
      currentDeviceId: local.deviceKey.deviceId,
      anchorEpoch: 1,
      trustHeadDigest: initialized.projection.chainHead.eventDigest,
      path: { kind: "migration", targetDeviceId: "new-anchor", transferId: "transfer-1" },
    });
    for (const phase of ["gate-frozen", "transfer-committed", "cleanup-complete"] as const) {
      await journal.advance("uninstall-local", phase);
    }
    await journal.terminal("uninstall-local", "retired");

    await expect(prepareMeshRuntimeBootstrap({ zhixingHome: root, secretStore: secrets }))
      .rejects.toThrow("use the recovery flow");
    expect((await secrets.list("")).filter((ref) => ref.kind === "device-key")).toHaveLength(0);
  });

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

  it("exposes only the trusted-home bootstrap needed for recovery-root establishment", async () => {
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
    const bootstrap = await prepareMeshRuntimeBootstrap({
      zhixingHome: root,
      secretStore: secrets,
      configuration: {
        enabledRoles: ["anchor"],
        anchorListen: { bind: { host: "127.0.0.1", port: 7443 } },
      },
    });
    expect(bootstrap.mode).toBe("trusted-home");
    if (bootstrap.mode !== "trusted-home") throw new Error("expected trusted home");
    expect(bootstrap.trust.recoveryRootPublicKey).toBeUndefined();
    expect(bootstrap.trust.recoveryBackupPublicKey).toBeUndefined();
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

  it("replays a strict legacy trust-only package after target response loss without claiming a full backup", async () => {
    const home = await createTempDir("mesh-runtime-legacy-root");
    const secrets = new MemorySecretStore();
    const local = await prepareMeshRuntimeBootstrap({ zhixingHome: home, secretStore: secrets });
    const identity = enrollDeviceIdentity(local.deviceKey, {
      displayName: "home anchor",
      platform: "headless",
      enrolledAt: "2026-08-12T00:00:00.000Z",
    });
    const initialized = await local.bootstrapStore.initializeLocalHome({
      key: local.deviceKey,
      identity,
      roles: ["anchor", "executor"],
      at: "2026-08-12T00:00:00.000Z",
    });
    const recoveryRoot = RecoveryRoot.generate();
    const plan = {
      v: 1 as const,
      kind: "establish" as const,
      rootEvent: createRecoveryRootEvent({
        current: initialized.projection,
        op: "establish",
        candidate: recoveryRoot,
        outerSigner: local.deviceKey,
        at: "2026-08-12T00:01:00.000Z",
      }),
    };
    const checkpoint = createRootActivationCheckpoint({
      checkpointId: "01J00000000000000000000041",
      createdAt: "2026-08-12T00:01:00.000Z",
      plan,
      recoveryRoot,
      issuer: Object.assign({}, identity, { sign: local.deviceKey.sign.bind(local.deviceKey) }),
      scope: ["trust"],
      domainRevisions: { trust: initialized.projection.chainHead.seq },
      upToLsn: initialized.projection.chainHead.seq,
      plaintextChunks: [Buffer.from("legacy trust checkpoint")],
    });
    const legacyPackage = encodeLegacyRecoveryPackage(recoveryRoot, checkpoint);
    const durableTarget = await FileRecoveryCheckpointTarget.openPaired({
      targetRoot: `${home}/recovery-target`,
      targetDeviceId: "legacy-target",
    });
    let loseWriteResponse = true;
    const responseLossTarget = {
      targetId: durableTarget.targetId,
      independenceDomain: durableTarget.independenceDomain,
      async writeDurable(value: Parameters<typeof durableTarget.writeDurable>[0]) {
        await durableTarget.writeDurable(value);
        if (loseWriteResponse) {
          loseWriteResponse = false;
          throw new Error("simulated target response loss");
        }
      },
      read: durableTarget.read.bind(durableTarget),
    };
    const activation = {
      store: local.bootstrapStore,
      issuerKey: local.deviceKey,
      issuerIdentity: identity,
      current: initialized.projection,
      targetId: durableTarget.targetId,
      targetIndependenceDomain: durableTarget.independenceDomain,
      createTarget: async () => responseLossTarget,
      writeLine: () => undefined,
      confirmRecoveryPackage: async () => legacyPackage,
    };
    try {
      await expect(activateInitialRecoveryRoot(activation)).rejects.toThrow(
        "simulated target response loss",
      );
      await expect(activateInitialRecoveryRoot(activation)).resolves.toMatchObject({
        recoveryRootPublicKey: recoveryRoot.rootPublicKey,
        recoveryBackupPublicKey: recoveryRoot.backupPublicKey,
      });

      const trust = await local.bootstrapStore.loadTrustProjection();
      if (!trust) throw new Error("recovery trust projection is missing");
      const records = await local.bootstrapStore.loadCheckpointRecords();
      const readiness = projectRecoveryReadiness({
        trust,
        verifiedRecords: records.filter(
          (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-verified" }> =>
            record.t === "checkpoint-verified",
        ),
        createdRecords: records.filter(
          (record): record is Extract<CheckpointStreamRecord, { t: "checkpoint-created" }> =>
            record.t === "checkpoint-created",
        ),
        checkpointEnvelopes: [checkpoint.envelope],
      });
      expect(readiness).toMatchObject({ ready: true, fullBackupReady: false });
    } finally {
      await durableTarget.close();
    }
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

});

function encodeLegacyRecoveryPackage(
  recoveryRoot: RecoveryRoot,
  checkpoint: ReturnType<typeof createRootActivationCheckpoint>,
): string {
  return `zxrp1:${Buffer.from(canonicalize({
    v: 1,
    recoverySecret: recoveryRoot.exportSecret(),
    checkpoint: {
      envelope: checkpoint.envelope,
      chunks: checkpoint.chunks?.map((chunk) => ({
        seq: chunk.seq,
        bytes: Buffer.from(chunk.bytes).toString("base64url"),
      })) ?? [],
    },
  }), "utf8").toString("base64url")}`;
}

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
import path from "node:path";
import { DeviceLifecycleJournal, FileAuthorityCommitLog } from "@zhixing/core/authority";
