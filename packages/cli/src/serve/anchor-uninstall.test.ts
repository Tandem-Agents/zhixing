import { AuthorityCheckpointOwner } from "@zhixing/mesh/checkpoint-owner";
import { AuthorityCheckpointService } from "@zhixing/mesh/checkpoint-service";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { decodeRecoveryPackage, encodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AnchorUninstallCoordinator } from "./anchor-uninstall.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
import { activateInitialRecoveryRoot } from "./mesh-pair-command.js";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import {
  HOST_STOP_ACCEPTED_WORK_OWNERS,
  type HostStopAcceptedWorkPorts,
} from "./host-stop-lifecycle.js";
import { protocolDigest, validateDeviceLifecycleRecord } from "@zhixing/core/protocol";

describe("anchor uninstall coordinator", { timeout: 30_000 }, () => {
  it("uses the preselected migration target identity and only reports terminal after transfer verification and local retirement", async () => {
    const fixture = await createFixture();
    const closeAdmission = vi.fn(async () => undefined);
    const commitMigration = vi.fn(async () => undefined);
    const verifyMigration = vi.fn(async () => undefined);
    const retireMigratedDevice = vi.fn(async () => undefined);
    const effects: string[] = [];
    const coordinator = new AnchorUninstallCoordinator({
      ...fixture.base,
      commitMigration,
      verifyMigration,
      retireMigratedDevice,
      closeAdmission,
      releaseAdmission: async () => undefined,
      recoveryAcceptedWork: {
        ports: acceptedWorkPorts(effects),
        artifactStore: fixture.store.artifactStore(),
        closeAdmission: async (operationId) => {
          effects.push(`close:${operationId}`);
        },
        onFrozen: async (snapshot) => {
          effects.push(`frozen:${snapshot.operationId}`);
        },
        flushDurableState: async () => {
          effects.push("flush");
          return [{
            kind: "accepted-work" as const,
            digest: protocolDigest("TestAnchorMigrationFlush", 1, {
              operationId: "uninstall-migration",
            }),
          }];
        },
        settlePhysicalSteps: async () => {
          effects.push("physical");
        },
      },
      cleanupRecovery: async () => [],
      onRetired: async () => undefined,
    });

    await expect(coordinator.beginMigration({
      requestId: "request-migration",
      operationId: "uninstall-migration",
      transferId: "transfer-migration",
      targetDeviceId: "target-1",
    })).resolves.toEqual({ phase: "uninstalled" });
    expect(closeAdmission).toHaveBeenCalledTimes(1);
    expect(commitMigration).toHaveBeenCalledWith({
      requestId: "request-migration",
      transferId: "transfer-migration",
      targetDeviceId: "target-1",
    });
    expect(verifyMigration).toHaveBeenCalledWith("target-1");
    expect(retireMigratedDevice).toHaveBeenCalledWith("uninstall-migration");
    expect(effects.filter((item) => item.startsWith("settle:")).length)
      .toBe(HOST_STOP_ACCEPTED_WORK_OWNERS.length);
    expect(effects.indexOf("flush")).toBeLessThan(effects.indexOf("physical"));
    await expect(coordinator.state("uninstall-migration")).resolves.toEqual({ phase: "uninstalled" });
  });

  it("requires a second confirmation after real backup read-back and includes the retirement decision in the final backup", async () => {
    const fixture = await createFixture();
    let target: FileRecoveryCheckpointTarget | undefined;
    let recoveryPackage = "";
    await activateInitialRecoveryRoot({
      store: fixture.store,
      issuerKey: fixture.issuerKey,
      issuerIdentity: fixture.issuerIdentity,
      current: fixture.initialProjection,
      targetId: "backup-device:independent",
      targetIndependenceDomain: "device:independent",
      createTarget: async () => {
        target = await FileRecoveryCheckpointTarget.openPaired({
          targetRoot: path.join(fixture.home, "recovery-target"),
          targetDeviceId: "independent",
        });
        return target;
      },
      writeLine: () => undefined,
      confirmRecoveryPackage: async (value) => {
        recoveryPackage = value;
        return value;
      },
    });
    if (!target || !recoveryPackage) throw new Error("expected activated recovery target");
    const root = decodeRecoveryPackage(recoveryPackage).root;
    const trust = await fixture.store.loadTrustRecord();
    if (!trust) throw new Error("expected current trust");
    await fixture.store.authorityLog().append([{
      stream: "exposure",
      body: createCredentialExposureRecord({
        deviceId: fixture.issuerKey.deviceId,
        bindingId: "provider:retirement-lsn",
        service: "provider",
        markedAt: "2026-08-12T00:00:04.000Z",
      }),
    }]);
    const service = new AuthorityCheckpointService({
      log: fixture.store.authorityLog(),
      artifacts: fixture.store.artifactStore(),
      retention: fixture.store.checkpointRetention(),
      target,
      trust,
      issuer: Object.assign({}, fixture.issuerIdentity, {
        sign: fixture.issuerKey.sign.bind(fixture.issuerKey),
      }),
      recipient: root.publicIdentity(),
      currentAnchor: true,
      storageMaintenance: allowMaintenance(),
      clock: () => "2026-08-12T00:00:05.000Z",
    });
    const verify = vi.spyOn(service, "verify");
    const checkpointOwner = new AuthorityCheckpointOwner({
      service,
      identitySeed: "uninstall-backup",
      clock: () => new Date("2026-08-12T00:00:05.000Z"),
    });
    await checkpointOwner.start(false);
    const effects: string[] = [];
    let finalUpToLsn: number | undefined;
    const forceCheckpoint = checkpointOwner.force.bind(checkpointOwner);
    vi.spyOn(checkpointOwner, "force").mockImplementation(async (reason) => {
      effects.push(`force:${reason}`);
      const checkpoint = await forceCheckpoint(reason);
      if (reason === "uninstall-backup:final-retirement") {
        finalUpToLsn = checkpoint.envelope.manifest.upToLsn;
      }
      return checkpoint;
    });
    const acceptedWork = acceptedWorkPorts(effects);
    const cleanupRecovery = vi.fn(async () => {
      effects.push("cleanup");
      return [{
        kind: "cleanup" as const,
        digest: `sha256:${"c".repeat(64)}`,
      }];
    });
    const onRetired = vi.fn(async () => undefined);
    const coordinator = new AnchorUninstallCoordinator({
      ...fixture.base,
      commitMigration: async () => undefined,
      verifyMigration: async () => undefined,
      retireMigratedDevice: async () => undefined,
      checkpointOwner,
      closeAdmission: async () => undefined,
      releaseAdmission: async () => undefined,
      recoveryAcceptedWork: {
        ports: acceptedWork,
        artifactStore: fixture.store.artifactStore(),
        closeAdmission: async (operationId) => {
          effects.push(`close:${operationId}`);
        },
        onFrozen: async (snapshot) => {
          effects.push(`frozen:${snapshot.operationId}`);
        },
        flushDurableState: async () => {
          effects.push("flush");
          await fixture.store.authorityLog().append([{
            stream: "exposure",
            body: createCredentialExposureRecord({
              deviceId: fixture.issuerKey.deviceId,
              bindingId: "provider:accepted-work-flush",
              service: "provider",
              markedAt: "2026-08-12T00:00:06.000Z",
            }),
          }]);
          return [{
            kind: "accepted-work" as const,
            digest: protocolDigest("TestAnchorUninstallFlush", 1, {
              operationId: "uninstall-backup",
            }),
          }];
        },
        settlePhysicalSteps: async () => {
          effects.push("physical");
        },
      },
      cleanupRecovery,
      onRetired,
    });

    await expect(coordinator.beginRecoveryBackup({
      requestId: "request-backup",
      operationId: "uninstall-backup",
      recoveryPackage: encodeRecoveryPackage(root),
    })).resolves.toEqual({ phase: "backup-verified", nextAction: "confirm-backup" });
    expect(cleanupRecovery).not.toHaveBeenCalled();
    await expect(coordinator.confirmRecoveryBackup("uninstall-backup", encodeRecoveryPackage(root)))
      .resolves.toEqual({ phase: "uninstalled" });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(effects.indexOf("flush")).toBeLessThan(
      effects.indexOf("force:uninstall-backup:final-retirement"),
    );
    expect(effects.indexOf("force:uninstall-backup:final-retirement")).toBeLessThan(
      effects.indexOf("cleanup"),
    );
    expect(effects.filter((item) => item.startsWith("settle:")).length)
      .toBe(HOST_STOP_ACCEPTED_WORK_OWNERS.length);
    const lifecycle = await fixture.store.authorityLog().readStream<unknown>("device-lifecycle");
    const retirement = lifecycle.find((entry) => {
      const record = validateDeviceLifecycleRecord(entry.body);
      return record.t === "advanced" && record.phase === "retirement-decided";
    });
    const flushed = lifecycle.find((entry) => {
      const record = validateDeviceLifecycleRecord(entry.body);
      return record.t === "advanced" && record.phase === "flushed";
    });
    expect(retirement).toBeDefined();
    expect(validateDeviceLifecycleRecord(retirement!.body)).toMatchObject({
      t: "advanced",
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "accepted-work", artifact: expect.any(Object) }),
      ]),
    });
    expect(finalUpToLsn).toBeGreaterThanOrEqual(flushed!.lsn);
    expect(cleanupRecovery).toHaveBeenCalledTimes(1);
    expect(onRetired).toHaveBeenCalledTimes(1);
    await expect(coordinator.state("uninstall-backup")).resolves.toEqual({ phase: "uninstalled" });
    await checkpointOwner.stop();
    await target.close();
  }, 120_000);
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
  onTestFinished(() => store.stopStorageMaintenance());
  const initialized = await store.initializeLocalHome({
    key: issuerKey,
    identity: issuer,
    roles: ["anchor", "executor"],
    homeId: "home-uninstall",
    at: "2026-08-12T00:00:00.000Z",
  });
  return {
    home,
    store,
    issuerKey,
    issuerIdentity: issuer,
    initialProjection: initialized.projection,
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

function acceptedWorkPorts(effects: string[]): HostStopAcceptedWorkPorts {
  return Object.fromEntries(HOST_STOP_ACCEPTED_WORK_OWNERS.map((owner) => [
    owner,
    {
      freeze: async () => owner === "conversation" || owner === "delivery"
        ? [{ id: `${owner}-1`, revision: `sha256:${"d".repeat(64)}` }]
        : [],
      settle: async ({ operationId, strategy }: {
        readonly operationId: string;
        readonly strategy: "immediate" | "drain" | "cancel";
      }) => {
        effects.push(`settle:${owner}:${operationId}:${strategy}`);
      },
      readBack: async () => {
        effects.push(`read:${owner}`);
      },
    },
  ])) as unknown as HostStopAcceptedWorkPorts;
}
