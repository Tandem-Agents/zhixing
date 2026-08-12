import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import type { AuthorityCheckpointOwnerPort } from "@zhixing/mesh/checkpoint-owner";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { AnchorUninstallCoordinator } from "./anchor-uninstall.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";

describe("anchor uninstall coordinator", () => {
  it("uses a ready migration target and only reports terminal after transfer verification and local retirement", async () => {
    const fixture = await createFixture();
    const closeAdmission = vi.fn(async () => undefined);
    const commitMigration = vi.fn(async () => undefined);
    const verifyMigration = vi.fn(async () => undefined);
    const retireMigratedDevice = vi.fn(async () => undefined);
    const coordinator = new AnchorUninstallCoordinator({
      ...fixture.base,
      migrationTargets: async () => [{ deviceId: "target-1", displayName: "书房电脑", ready: true }],
      commitMigration,
      verifyMigration,
      retireMigratedDevice,
      closeAdmission,
      releaseAdmission: async () => undefined,
      cleanupRecovery: async () => [],
      onRetired: async () => undefined,
    });

    await expect(coordinator.beginMigration({
      requestId: "request-migration",
      operationId: "uninstall-migration",
      transferId: "transfer-migration",
      targetName: "书房电脑",
    })).resolves.toEqual({ phase: "uninstalled" });
    expect(closeAdmission).toHaveBeenCalledTimes(1);
    expect(commitMigration).toHaveBeenCalledWith({
      requestId: "request-migration",
      transferId: "transfer-migration",
      targetDeviceId: "target-1",
    });
    expect(verifyMigration).toHaveBeenCalledWith("target-1");
    expect(retireMigratedDevice).toHaveBeenCalledWith("uninstall-migration");
    await expect(coordinator.state("uninstall-migration")).resolves.toEqual({ phase: "uninstalled" });
  });

  it("requires a second confirmation after real backup read-back and includes the retirement decision in the final backup", async () => {
    const fixture = await createFixture();
    const forced: string[] = [];
    let checkpoint = checkpointPackage("initial", 20);
    const checkpointOwner: AuthorityCheckpointOwnerPort = {
      start: async () => undefined,
      ensureDaily: async () => checkpoint,
      force: async (requestId) => {
        forced.push(requestId);
        checkpoint = checkpointPackage(`checkpoint-${forced.length}`, 10_000 + forced.length);
        return checkpoint;
      },
      status: async () => ({
        state: "recoverable",
        fullBackupReady: true,
        checkpointId: checkpoint.envelope.checkpointId,
        targetId: "backup-device:independent",
        upToLsn: checkpoint.envelope.manifest.upToLsn,
      }),
      stop: async () => undefined,
    };
    const cleanupRecovery = vi.fn(async () => [{
      kind: "cleanup" as const,
      digest: `sha256:${"c".repeat(64)}`,
    }]);
    const onRetired = vi.fn(async () => undefined);
    const coordinator = new AnchorUninstallCoordinator({
      ...fixture.base,
      migrationTargets: async () => [],
      commitMigration: async () => undefined,
      verifyMigration: async () => undefined,
      retireMigratedDevice: async () => undefined,
      checkpointOwner,
      closeAdmission: async () => undefined,
      releaseAdmission: async () => undefined,
      cleanupRecovery,
      onRetired,
    });

    await expect(coordinator.beginRecoveryBackup({
      requestId: "request-backup",
      operationId: "uninstall-backup",
    })).resolves.toEqual({ phase: "backup-verified", nextAction: "confirm-backup" });
    expect(cleanupRecovery).not.toHaveBeenCalled();
    await expect(coordinator.confirmRecoveryBackup("uninstall-backup"))
      .resolves.toEqual({ phase: "uninstalled" });
    expect(forced).toEqual([
      "uninstall-backup:pre-retirement",
      "uninstall-backup:final-retirement",
    ]);
    expect(cleanupRecovery).toHaveBeenCalledTimes(1);
    expect(onRetired).toHaveBeenCalledTimes(1);
    await expect(coordinator.state("uninstall-backup")).resolves.toEqual({ phase: "uninstalled" });
  });
});

async function createFixture() {
  const home = await createTempDir("anchor-uninstall");
  const issuerKey = await DeviceKey.generate();
  const issuer = enrollDeviceIdentity(issuerKey, {
    displayName: "当前值班电脑",
    platform: "headless",
    enrolledAt: "2026-08-12T00:00:00.000Z",
  });
  const store = new FileMeshBootstrapStore(home, issuerKey);
  await store.initializeLocalHome({
    key: issuerKey,
    identity: issuer,
    roles: ["anchor", "executor"],
    homeId: "home-uninstall",
    at: "2026-08-12T00:00:00.000Z",
  });
  return {
    base: {
      log: store.authorityLog(),
      store,
      currentDeviceId: issuerKey.deviceId,
      issuerKey,
      verifier: createTrustedDeviceProtocolVerifier([issuer]),
      anchorEpoch: () => 1,
      now: () => "2026-08-12T00:00:01.000Z",
    },
  };
}

function checkpointPackage(checkpointId: string, upToLsn: number): CheckpointPackage {
  return {
    envelope: {
      checkpointId,
      digest: `sha256:${createHash("sha256").update(checkpointId).digest("hex")}`,
      manifest: { upToLsn },
    },
    chunks: [],
  } as unknown as CheckpointPackage;
}
import { createHash } from "node:crypto";
