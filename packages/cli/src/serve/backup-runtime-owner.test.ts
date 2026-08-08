import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileBackupTargetConfiguration } from "./backup-target-config.js";
import {
  createConfiguredCheckpointOwner,
  projectRecoveryBackupStatus,
} from "./backup-runtime-owner.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";

describe("public recovery backup status", () => {
  it("projects exact public keys for every stable status", () => {
    expect(projectRecoveryBackupStatus({
      state: "recoverable",
      fullBackupReady: true,
      checkpointId: "checkpoint-private",
      targetId: "target-private",
      upToLsn: 42,
    })).toEqual({ state: "recoverable", fullBackupReady: true });
    expect(projectRecoveryBackupStatus({
      state: "pending-verification",
      fullBackupReady: false,
      checkpointId: "checkpoint-private",
    })).toEqual({
      state: "pending-verification",
      fullBackupReady: false,
      nextAction: "run-backup-verify",
    });
    expect(projectRecoveryBackupStatus({
      state: "not-configured",
      fullBackupReady: false,
    })).toEqual({
      state: "not-configured",
      fullBackupReady: false,
      nextAction: "run-backup-setup",
    });
    for (const code of ["configuration-invalid", "runtime-unavailable", "target-unavailable"] as const) {
      const projected = projectRecoveryBackupStatus({
        state: "unavailable",
        fullBackupReady: false,
        code,
      });
      expect(Object.keys(projected).sort()).toEqual(["fullBackupReady", "nextAction", "state"]);
    }
  });

  it("isolates optional configuration and runtime failures and reloads a repaired binding", async () => {
    const home = await createTempDir("recovery-owner-slot");
    const key = await DeviceKey.generate();
    const identity = enrollDeviceIdentity(key, {
      displayName: "anchor",
      platform: "headless",
      enrolledAt: "2026-08-08T00:00:00.000Z",
    });
    const recovery = RecoveryRoot.generate();
    const trust = {
      v: 1,
      homeId: "home-recovery-slot",
      trustEpoch: 1,
      issuer: identity,
      members: [{ device: identity, roles: ["anchor"], state: "active" }],
      chainHead: { seq: 1, eventDigest: `sha256:${"1".repeat(64)}` },
      recoveryRootPublicKey: recovery.rootPublicKey,
      recoveryBackupPublicKey: recovery.backupPublicKey,
    } as HomeTrustRecord;
    const log = { readStream: async () => [] };
    const mesh = {
      deviceKey: key,
      bootstrapStore: {
        loadTrustRecord: async () => trust,
        authorityLog: () => log,
        artifactStore: () => ({}),
        checkpointRetention: () => ({}),
      },
    } as unknown as MeshRuntimeBootstrap;
    const runtime = {
      connections: {
        client: () => ({ request: async () => Buffer.alloc(0) }),
      },
    };
    const maintenance = allowMaintenance();
    const configDir = path.join(home, "distributed-runtime");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "recovery-backup-targets.json"), "not-json");
    const owner = await createConfiguredCheckpointOwner({
      zhixingHome: home,
      mesh,
      meshRuntime: runtime as never,
      storageMaintenance: maintenance,
    });
    expect(owner).toBeDefined();
    await expect(owner!.status()).resolves.toEqual({
      state: "unavailable",
      fullBackupReady: false,
      code: "configuration-invalid",
    });

    await writeFile(path.join(configDir, "recovery-backup-targets.json"), canonicalize({
      v: 1,
      currentTargetId: "backup-device:target",
      bindings: [{ kind: "paired-device", targetId: "backup-device:target", deviceId: "target" }],
    }));
    await expect(owner!.status()).resolves.toEqual({ state: "not-configured", fullBackupReady: false });

    const noRuntimeHome = await createTempDir("recovery-owner-no-runtime");
    await new FileBackupTargetConfiguration(noRuntimeHome).select({
      kind: "paired-device",
      targetId: "backup-device:target",
      deviceId: "target",
    });
    const withoutRuntime = await createConfiguredCheckpointOwner({
      zhixingHome: noRuntimeHome,
      mesh,
      storageMaintenance: maintenance,
    });
    await expect(withoutRuntime!.status()).resolves.toEqual({
      state: "unavailable",
      fullBackupReady: false,
      code: "runtime-unavailable",
    });
  });
});

function allowMaintenance(): StorageMaintenanceGovernorPort {
  return {
    acquire: async () => ({
      kind: "granted",
      permit: {
        granted: {
          memoryReservationBytes: 0,
          temporaryBytes: 0,
          slots: 0,
          readBytes: Number.MAX_SAFE_INTEGER,
          writeBytes: Number.MAX_SAFE_INTEGER,
          ioOperations: Number.MAX_SAFE_INTEGER,
        },
        tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
        release: () => undefined,
      },
    }),
    snapshot: () => ({ queued: {}, inFlight: {} }),
  };
}
