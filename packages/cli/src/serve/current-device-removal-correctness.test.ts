import { AuthorityCheckpointOwner } from "@zhixing/mesh/checkpoint-owner";
import { AuthorityCheckpointService } from "@zhixing/mesh/checkpoint-service";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { decodeRecoveryPackage, encodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import { replayTrustChain } from "@zhixing/mesh/trust-chain";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
import { activateInitialRecoveryRoot } from "./mesh-pair-command.js";
import { createCredentialExposureRecord } from "@zhixing/mesh/credential-exposure";
import {
  HOST_STOP_ACCEPTED_WORK_OWNERS,
  freezeHostStopAcceptedWork,
  loadHostStopAcceptedWork,
  settleHostStopAcceptedWork,
  type HostStopAcceptedWorkPorts,
} from "./host-stop-lifecycle.js";
import {
  createSignedDeviceLifecycleAbort,
  protocolDigest,
  validateDeviceLifecycleRecord,
  type AnchorUninstallLifecycleIdentity,
  type DeviceLifecycleEvidenceRef,
} from "@zhixing/core/protocol";
import {
  DeviceAdministrationCurrentRemovalMigrationApplicationService,
  DeviceAdministrationCurrentRemovalRecoveryApplicationService,
} from "@zhixing/core/device-administration/application";
import {
  createDeviceAdministrationCurrentRemovalAdmissionPort,
  createDeviceAdministrationCurrentRemovalMechanismPort,
  createDeviceAdministrationCurrentRemovalMigrationLifecyclePort,
  createDeviceAdministrationCurrentRemovalRecoveryBindingPort,
  createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort,
} from "@zhixing/core/device-administration/correctness";
import { BackupRecoveryCurrentRemovalApplicationService } from "@zhixing/core/backup-recovery/application";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import {
  commitCurrentDeviceRetirementTransaction,
  readCurrentDeviceRemovalPhaseLsn,
} from "./current-device-retirement-transaction.js";

describe("current device removal correctness adapters", { timeout: 30_000 }, () => {
  it("keeps physical authority generations inside one opaque binding adapter and restores v1 records", () => {
    const port = createDeviceAdministrationCurrentRemovalRecoveryBindingPort();
    const authority = {
      homeId: "home-binding",
      anchorEpoch: 4,
      trustHeadDigest: `sha256:${"a".repeat(64)}`,
    };
    const binding = port.create({
      authority,
      checkpointTargetId: "target-binding",
      rootKeyId: "root-binding",
      recipientKeyId: "recipient-binding",
    });
    expect(Object.keys(binding).sort()).toEqual([
      "acceptedRecoveryBinding",
      "checkpointBinding",
      "checkpointTargetId",
    ]);
    expect(binding.checkpointBinding).toBe(protocolDigest(
      "AnchorUninstallCheckpointGeneration",
      1,
      {
        homeId: authority.homeId,
        anchorEpoch: authority.anchorEpoch,
        trustHeadDigest: authority.trustHeadDigest,
        targetId: "target-binding",
        rootKeyId: "root-binding",
        recipientKeyId: "recipient-binding",
      },
    ));
    const persisted: AnchorUninstallLifecycleIdentity = {
      v: 1,
      kind: "anchor-uninstall",
      requestId: "request-binding",
      operationId: "operation-binding",
      homeId: authority.homeId,
      currentDeviceId: "device-binding",
      anchorEpoch: authority.anchorEpoch,
      trustHeadDigest: authority.trustHeadDigest,
      path: {
        kind: "recovery-backup",
        checkpointTargetId: binding.checkpointTargetId,
        checkpointGeneration: binding.checkpointBinding,
      },
    };
    expect(port.restore(persisted)).toEqual(binding);
    expect(() => port.assertCurrent({
      authority: { ...authority, anchorEpoch: authority.anchorEpoch + 1 },
      binding,
      rootKeyId: "root-binding",
      recipientKeyId: "recipient-binding",
    })).toThrow("changes the accepted uninstall generation");
    expect(() => port.assertCurrent({
      authority,
      binding,
      rootKeyId: "foreign-root",
      recipientKeyId: "recipient-binding",
    })).toThrow("changes the accepted uninstall generation");
    expect(() => port.assertCurrent({
      authority,
      binding: { ...binding, checkpointTargetId: "foreign-target" },
      rootKeyId: "root-binding",
      recipientKeyId: "recipient-binding",
    })).toThrow("changes the accepted uninstall generation");
  });

  it("projects the latest paired-device removal lifecycle as a finite admission outcome", async () => {
    const fixture = await createFixture();
    const correctness = createCurrentDeviceRemovalCorrectness(fixture);

    const allowed = await correctness.admission.read();
    expect(allowed.outcome).toEqual({ kind: "allowed" });
    expect(Object.keys(allowed.context).sort()).toEqual([
      "currentDeviceName",
      "currentDutyDeviceId",
      "currentDutyIssuerKeyId",
      "localDeviceId",
      "localIssuerKeyId",
    ]);
    expect("executorRemovalInProgress" in allowed.context).toBe(false);
    expect(Object.isFrozen(allowed)).toBe(true);
    expect(Object.isFrozen(allowed.context)).toBe(true);
    expect(Object.isFrozen(allowed.outcome)).toBe(true);

    await correctness.journal.accept({
      v: 1,
      kind: "executor-removal",
      requestId: "request:paired-removal",
      operationId: "paired-removal",
      homeId: fixture.initialProjection.homeId,
      targetDeviceId: fixture.issuerKey.deviceId,
      targetMemberPublicKey: fixture.issuerKey.publicKey,
      targetDeviceKeyGeneration: protocolDigest("DeviceKeyGeneration", 1, {
        deviceId: fixture.issuerKey.deviceId,
        publicKey: fixture.issuerKey.publicKey,
      }),
      acceptedIssuerDeviceId: "previous-duty-device",
      acceptedTrustHeadDigest: fixture.initialProjection.chainHead.eventDigest,
    });

    await expect(correctness.admission.read()).resolves.toMatchObject({
      context: {
        localDeviceId: fixture.issuerKey.deviceId,
        currentDutyDeviceId: fixture.issuerKey.deviceId,
      },
      outcome: { kind: "paired-device-removal" },
    });
  });

  it("uses the preselected migration target identity and only reports terminal after transfer verification and local retirement", async () => {
    const fixture = await createFixture();
    const closeAdmission = vi.fn(async () => undefined);
    const commitMigration = vi.fn(async () => undefined);
    const verifyMigration = vi.fn(async () => undefined);
    const retireMigratedDevice = vi.fn(async () => undefined);
    const effects: string[] = [];
    const acceptedWork = acceptedWorkPorts(effects);
    const correctness = createCurrentDeviceRemovalCorrectness(fixture);
    const { journal } = correctness;
    const migration = new DeviceAdministrationCurrentRemovalMigrationApplicationService<
      DeviceLifecycleEvidenceRef
    >({
      lifecycle: correctness.migrationLifecycle,
      effects: {
        closeAdmission,
        closeAcceptedWorkAdmission: async (operationId) => {
          effects.push(`close:${operationId}`);
        },
        freezeAcceptedWork: async (operationId) =>
          (await freezeHostStopAcceptedWork(
            operationId,
            acceptedWork,
            fixture.store.artifactStore(),
          )).evidence,
        settleAcceptedWork: async ({ operationId, strategy, timeoutMs }) => {
          const operation = await journal.state(operationId);
          if (!operation) throw new Error("expected migration lifecycle operation");
          const snapshot = await loadHostStopAcceptedWork(
            operation,
            fixture.store.artifactStore(),
          );
          effects.push(`frozen:${snapshot.operationId}`);
          await settleHostStopAcceptedWork({
            operationId,
            strategy,
            timeoutMs,
            snapshot,
            ports: acceptedWork,
          });
        },
        flushDurableState: async () => {
          effects.push("flush");
          return [{
            kind: "accepted-work",
            digest: protocolDigest("TestAnchorMigrationFlush", 1, {
              operationId: "uninstall-migration",
            }),
          }];
        },
        settlePhysicalSteps: async () => {
          effects.push("physical");
        },
        commitTransfer: commitMigration,
        verifyTransfer: async ({ transferId, targetDeviceId }) => {
          await verifyMigration(targetDeviceId);
          return {
            kind: "authority-transfer",
            digest: protocolDigest("AnchorUninstallMigration", 1, {
              kind: "migration",
              targetDeviceId,
              transferId,
            }),
          };
        },
        retireLocalDevice: async ({ operationId, targetDeviceId }) => {
          await retireMigratedDevice(operationId);
          return {
            kind: "cleanup",
            digest: protocolDigest("MigratedAnchorCleanup", 1, {
              operationId,
              targetDeviceId,
            }),
          };
        },
      },
    });

    await expect(migration.begin({
      requestId: "request-migration",
      operationId: "uninstall-migration",
      transferId: "transfer-migration",
      targetDeviceId: "target-1",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "terminal",
    });
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
    await expect(correctness.currentDeviceRemoval.read({
      operationId: "uninstall-migration",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "terminal",
    });
    const migrationRecords = (await fixture.store.authorityLog()
      .readStream<unknown>("device-lifecycle"))
      .map((entry) => validateDeviceLifecycleRecord(entry.body));
    expect(migrationRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        t: "advanced",
        operationId: "uninstall-migration",
        phase: "transfer-committed",
        evidence: expect.arrayContaining([{
          kind: "authority-transfer",
          digest: protocolDigest("AnchorUninstallMigration", 1, {
            kind: "migration",
            targetDeviceId: "target-1",
            transferId: "transfer-migration",
          }),
        }]),
      }),
      expect.objectContaining({
        t: "advanced",
        operationId: "uninstall-migration",
        phase: "cleanup-complete",
        evidence: [{
          kind: "cleanup",
          digest: protocolDigest("MigratedAnchorCleanup", 1, {
            operationId: "uninstall-migration",
            targetDeviceId: "target-1",
          }),
        }],
      }),
      expect.objectContaining({
        t: "terminal",
        operationId: "uninstall-migration",
        outcome: "retired",
      }),
    ]));
    await expect(migration.begin({
      requestId: "request-migration",
      operationId: "uninstall-migration",
      transferId: "transfer-migration",
      targetDeviceId: "target-1",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "terminal",
    });
    expect(commitMigration).toHaveBeenCalledTimes(1);
    expect(verifyMigration).toHaveBeenCalledTimes(1);
    expect(retireMigratedDevice).toHaveBeenCalledTimes(1);

    await correctness.migrationLifecycle.accept({
      requestId: "request-resume",
      operationId: "uninstall-resume",
      transferId: "transfer-resume",
      targetDeviceId: "target-2",
    });
    await expect(migration.resumeActive()).resolves.toEqual([{
      kind: "current-device-removal",
      path: "migration",
      phase: "terminal",
    }]);
    await expect(correctness.currentDeviceRemoval.read({
      operationId: "uninstall-resume",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "terminal",
    });
    expect(commitMigration).toHaveBeenCalledTimes(2);
    expect(verifyMigration).toHaveBeenCalledTimes(2);
    expect(retireMigratedDevice).toHaveBeenCalledTimes(2);
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
    const correctness = createCurrentDeviceRemovalCorrectness(fixture);
    const { journal } = correctness;
    const readBindingContext = async () => {
      const current = await fixture.store.loadTrustRecord();
      if (!current?.recoveryRootPublicKey || !current.recoveryBackupPublicKey) {
        throw new Error("expected current recovery root");
      }
      return {
        authority: {
          homeId: current.homeId,
          anchorEpoch: 1,
          trustHeadDigest: current.chainHead.eventDigest,
        },
        context: {
          recoveryRootPublicKey: current.recoveryRootPublicKey,
          recoveryBackupPublicKey: current.recoveryBackupPublicKey,
        },
      };
    };
    const backup = new BackupRecoveryCurrentRemovalApplicationService({
      hasCheckpointOwner: () => true,
      readStatus: () => checkpointOwner.status(),
      decodeCurrentPackage: (value: string) => {
        const decoded = decodeRecoveryPackage(value);
        if (decoded.version !== 2) throw new Error("expected current recovery package");
        return { package: decoded.root, identity: decoded.root.publicIdentity() };
      },
      prepareAcceptedBinding: async (input) => {
        const current = await readBindingContext();
        return {
          context: current.context,
          binding: correctness.recoveryBinding.create({
            authority: current.authority,
            checkpointTargetId: input.checkpointTargetId,
            rootKeyId: input.rootKeyId,
            recipientKeyId: input.recipientKeyId,
          }),
        };
      },
      verifyAcceptedBinding: async (input) => {
        const current = await readBindingContext();
        correctness.recoveryBinding.assertCurrent({
          authority: current.authority,
          binding: input.binding,
          rootKeyId: input.rootKeyId,
          recipientKeyId: input.recipientKeyId,
        });
        return current.context;
      },
      forceCheckpoint: async (requestId: string) => {
        const checkpoint = await checkpointOwner.force(requestId);
        return {
          checkpoint,
          checkpointId: checkpoint.envelope.checkpointId,
          envelopeDigest: checkpoint.envelope.digest,
          upToLsn: checkpoint.envelope.manifest.upToLsn,
        };
      },
      verifyCheckpoint: async ({ checkpoint, recoveryPackage }) => {
        const verification = await checkpointOwner.verify(
          checkpoint.envelope.checkpointId,
          recoveryPackage,
        );
        return {
          targetId: verification.targetId,
          checkpointId: verification.checkpointId,
          envelopeDigest: verification.envelopeDigest,
          evidence: {
            kind: "checkpoint" as const,
            digest: protocolDigest("RecoveryCheckpointVerification", 1, verification),
          },
        };
      },
    });
    const recovery = new DeviceAdministrationCurrentRemovalRecoveryApplicationService<
      DeviceLifecycleEvidenceRef
    >({
      backup,
      lifecycle: correctness.recoveryLifecycle,
      effects: {
        closeAdmission: async (operationId) => {
          const operation = await journal.state(operationId);
          if (!operation || operation.identity.kind !== "anchor-uninstall") {
            throw new Error("expected recovery lifecycle operation");
          }
          return {
            kind: "accepted-work",
            digest: protocolDigest("AnchorUninstallAdmission", 1, operation.identity),
          };
        },
        closeAcceptedWorkAdmission: async (operationId) => {
          effects.push(`close:${operationId}`);
        },
        freezeAcceptedWork: async (operationId) =>
          (await freezeHostStopAcceptedWork(
            operationId,
            acceptedWork,
            fixture.store.artifactStore(),
          )).evidence,
        restoreAcceptedWork: async (operationId) => {
          const operation = await journal.state(operationId);
          if (!operation) throw new Error("expected recovery lifecycle operation");
          const snapshot = await loadHostStopAcceptedWork(
            operation,
            fixture.store.artifactStore(),
          );
          effects.push(`frozen:${snapshot.operationId}`);
        },
        settleAcceptedWork: async ({ operationId, strategy, timeoutMs }) => {
          const operation = await journal.state(operationId);
          if (!operation) throw new Error("expected recovery lifecycle operation");
          const snapshot = await loadHostStopAcceptedWork(
            operation,
            fixture.store.artifactStore(),
          );
          await settleHostStopAcceptedWork({
            operationId,
            strategy,
            timeoutMs,
            snapshot,
            ports: acceptedWork,
          });
          const artifact = operation.evidence.find((item) =>
            item.kind === "accepted-work" && item.artifact);
          if (!artifact) throw new Error("expected accepted-work artifact");
          return {
            kind: "accepted-work",
            digest: protocolDigest("AnchorUninstallAcceptedWorkSettlement", 1, {
              operationId,
              artifactDigest: artifact.digest,
            }),
          };
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
        cleanup: cleanupRecovery,
        onRetired,
      },
    });

    await expect(recovery.begin({
      requestId: "request-backup",
      operationId: "uninstall-backup",
      recoveryPackage: encodeRecoveryPackage(root),
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "checkpoint-verified",
    });
    const accepted = await journal.state("uninstall-backup");
    expect(accepted?.identity).toMatchObject({
      kind: "anchor-uninstall",
      anchorEpoch: 1,
      path: {
        kind: "recovery-backup",
        checkpointTargetId: "backup-device:independent",
        checkpointGeneration: expect.any(String),
      },
    });
    const restarted = createCurrentDeviceRemovalCorrectness(fixture);
    const restored = await restarted.recoveryLifecycle.state("uninstall-backup");
    expect(Object.keys(restored!.binding).sort()).toEqual([
      "acceptedRecoveryBinding",
      "checkpointBinding",
      "checkpointTargetId",
    ]);
    await expect(recovery.begin({
      requestId: "request-backup",
      operationId: "uninstall-backup",
      recoveryPackage: encodeRecoveryPackage(root),
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "checkpoint-verified",
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(cleanupRecovery).not.toHaveBeenCalled();
    await expect(recovery.confirm({
      operationId: "uninstall-backup",
      recoveryPackage: encodeRecoveryPackage(root),
    }))
      .resolves.toEqual({
        kind: "current-device-removal",
        path: "recovery-backup",
        phase: "terminal",
      });
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
    await expect(recovery.confirm({
      operationId: "uninstall-backup",
      recoveryPackage: encodeRecoveryPackage(root),
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "terminal",
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(cleanupRecovery).toHaveBeenCalledTimes(1);
    expect(onRetired).toHaveBeenCalledTimes(1);
    await expect(correctness.currentDeviceRemoval.read({
      operationId: "uninstall-backup",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "terminal",
    });
    await checkpointOwner.stop();
    await target.close();
  }, 120_000);

  it("returns only raw lifecycle facts while preserving signed abort, journal and admission release", async () => {
    const fixture = await createFixture();
    const trust = await fixture.store.loadTrustRecord();
    if (!trust) throw new Error("expected current trust");
    await fixture.store.authorityLog().append([{
      stream: "device-lifecycle",
      body: validateDeviceLifecycleRecord({
        v: 1,
        t: "accepted",
        identity: {
          v: 1,
          kind: "anchor-uninstall",
          requestId: "request-cancel",
          operationId: "uninstall-cancel",
          homeId: trust.homeId,
          currentDeviceId: fixture.issuerKey.deviceId,
          anchorEpoch: 1,
          trustHeadDigest: trust.chainHead.eventDigest,
          path: {
            kind: "migration",
            targetDeviceId: "target-cancel",
            transferId: "transfer-cancel",
          },
        },
      }),
    }]);
    const releaseAdmission = vi.fn(async () => undefined);
    const correctness = createCurrentDeviceRemovalCorrectness(fixture, releaseAdmission);

    await expect(correctness.currentDeviceRemoval.read({
      operationId: "uninstall-missing",
    })).resolves.toBeUndefined();
    await expect(correctness.currentDeviceRemoval.read({
      operationId: "uninstall-cancel",
    })).resolves.toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "accepted",
    });
    const aborted = await correctness.currentDeviceRemoval.abort({
      operationId: "uninstall-cancel",
    });
    expect(aborted).toEqual({
      kind: "current-device-removal",
      path: "migration",
      phase: "aborted",
    });
    expect(Object.isFrozen(aborted)).toBe(true);
    expect(releaseAdmission).toHaveBeenCalledOnce();
    expect(releaseAdmission).toHaveBeenCalledWith("uninstall-cancel");
    const lifecycle = await fixture.store.authorityLog().readStream<unknown>("device-lifecycle");
    expect(lifecycle.map((entry) => validateDeviceLifecycleRecord(entry.body))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: "aborted",
          operationId: "uninstall-cancel",
          abort: expect.objectContaining({
            reason: "user-cancelled",
            signature: expect.any(Object),
          }),
        }),
      ]),
    );
  });
});

function createCurrentDeviceRemovalCorrectness(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  releaseAdmission: (operationId: string) => void | Promise<void> = async () => undefined,
) {
  const journal = new DeviceLifecycleJournal(
    fixture.store.authorityLog(),
    fixture.base.verifier,
  );
  const readAuthority = async () => {
    const trust = replayTrustChain(await fixture.store.loadTrustEvents());
    return Object.freeze({
      homeId: trust.homeId,
      localDeviceId: fixture.issuerKey.deviceId,
      currentDutyDeviceId: trust.issuer.deviceId,
      localIssuerKeyId: fixture.issuerKey.deviceId,
      currentDutyIssuerKeyId: trust.issuer.issuerKeyId,
      currentDeviceName: trust.members.find((member) =>
        member.device.deviceId === fixture.issuerKey.deviceId)
        ?.device.displayName,
      anchorEpoch: 1,
      trustHeadDigest: trust.chainHead.eventDigest,
      executorRemovalInProgress: (await journal.active())
        .some((operation) => operation.identity.kind === "executor-removal"),
    });
  };
  const recoveryBinding = createDeviceAdministrationCurrentRemovalRecoveryBindingPort();
  return Object.freeze({
    journal,
    admission: createDeviceAdministrationCurrentRemovalAdmissionPort({ readAuthority }),
    recoveryBinding,
    migrationLifecycle: createDeviceAdministrationCurrentRemovalMigrationLifecyclePort({
      journal,
      readAuthority,
    }),
    recoveryLifecycle: createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort({
      journal,
      readAuthority,
      binding: recoveryBinding,
      commitRetirement: ({ identity, acceptedWork }) =>
        commitCurrentDeviceRetirementTransaction({
          log: fixture.store.authorityLog(),
          verifier: fixture.base.verifier,
          identity,
          acceptedWork,
        }),
      phaseLsn: ({ operationId, phase }) => readCurrentDeviceRemovalPhaseLsn({
        log: fixture.store.authorityLog(),
        operationId,
        phase,
      }),
    }),
    currentDeviceRemoval: createDeviceAdministrationCurrentRemovalMechanismPort({
      journal,
      signAbort: (input) => createSignedDeviceLifecycleAbort(input, fixture.issuerKey),
      releaseAdmission,
      now: fixture.base.now,
    }),
  });
}

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
