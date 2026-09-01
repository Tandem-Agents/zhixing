import { createServer } from "node:net";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import type {
  DeviceCapacityAdmission,
  StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import { createRootActivationCheckpoint } from "@zhixing/mesh/checkpoint";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { RecoveryRoot, keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  PairedRecoveryCheckpointTarget,
  registerPairedCheckpointMeshService,
} from "@zhixing/mesh/paired-checkpoint-target";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createRecoveryRootEvent, createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  runBackupSetupCommand,
  runRecoveryRootApproveResetCommand,
  runRecoveryRootInvalidateCommand,
  runRecoveryRootResetCommand,
  runRecoveryRootRotateCommand,
} from "./backup-command.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { deferredPairedCheckpointTarget } from "./paired-checkpoint-runtime.js";
import { RecoveryRootEstablishmentRuntime } from "./recovery-root-establishment-runtime.js";
import {
  assertRecoveryRootActivationReplay,
  commitRecoveryRootLifecycleActivation,
} from "./recovery-root-activation.js";

vi.setConfig({ testTimeout: 120_000 });

describe("paired recovery backup setup", () => {
  it.each(["v1", "v2"] as const)(
    "establishes the first recovery root from a %s package over the restricted production transport",
    async (version) => {
      const fixture = await pairedHomeWithoutRecoveryRoot(version);
      const runtime = new RecoveryRootEstablishmentRuntime({
        zhixingHome: fixture.targetHome,
        mesh: fixture.targetBootstrap,
        secretStore: fixture.targetSecrets,
        storageMaintenance: fixture.targetStorage,
      });
      let displayedPackage: string | undefined;
      try {
        await runtime.start();
        await runBackupSetupCommand(
          { pairedDeviceName: "recovery target" },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: (line) => {
              if (line.startsWith("恢复包：")) displayedPackage = line.slice("恢复包：".length);
            },
            readRecoveryPackage: async () => {
              if (version === "v1") return fixture.legacyPackage!;
              if (!displayedPackage) throw new Error("recovery package was not displayed before read-back");
              return displayedPackage;
            },
          },
        );
        await withTimeout(runtime.waitUntilActivated(), "target did not observe recovery-root activation");
      } finally {
        await runtime.stop();
      }

      const sourceTrust = await fixture.sourceBootstrap.bootstrapStore.loadTrustRecord();
      const targetTrust = await fixture.targetBootstrap.bootstrapStore.loadTrustRecord();
      expect(sourceTrust?.recoveryRootPublicKey).toBeDefined();
      expect(sourceTrust?.recoveryBackupPublicKey).toBeDefined();
      expect(targetTrust?.recoveryRootPublicKey).toBe(sourceTrust?.recoveryRootPublicKey);
      expect(targetTrust?.recoveryBackupPublicKey).toBe(sourceTrust?.recoveryBackupPublicKey);

      const records = await fixture.sourceBootstrap.bootstrapStore.loadCheckpointRecords();
      const verified = records.find((record) => record.t === "checkpoint-verified");
      expect(verified).toBeDefined();
      const target = await FileRecoveryCheckpointTarget.openPaired({
        targetRoot: path.join(
          fixture.targetHome,
          "distributed-runtime",
          "recovery-checkpoints",
        ),
        targetDeviceId: fixture.targetDeviceId,
      });
      try {
        await expect(target.read(verified!.checkpointId)).resolves.toMatchObject({
          envelope: { checkpointId: verified!.checkpointId },
        });
        const sourceProjection = await fixture.sourceBootstrap.bootstrapStore.loadTrustProjection();
        if (!sourceProjection?.recoveryActivationDigest) {
          throw new Error("source recovery activation was not persisted");
        }
        const activation = await fixture.sourceBootstrap.bootstrapStore
          .loadRecoveryRootActivationReplay({
            activationDigest: sourceProjection.recoveryActivationDigest,
            targetId: `backup-device:${fixture.targetDeviceId}`,
          });
        if (!activation) throw new Error("source recovery activation replay was not found");
        const receiver = new PairedCheckpointReceiver({
          homeId: sourceTrust!.homeId,
          sourceDeviceId: sourceTrust!.issuer.deviceId,
          targetDeviceId: fixture.targetDeviceId,
          recipientKeyId: keyIdForPublicKey(sourceTrust!.recoveryBackupPublicKey!),
          replayRootActivation: ({ event: replayEvent, record }) =>
            assertRecoveryRootActivationReplay(
              fixture.targetBootstrap.bootstrapStore,
              replayEvent,
              record,
            ),
          staging: new FilePairedCheckpointStaging({
            root: path.join(
              fixture.targetHome,
              "distributed-runtime",
              "recovery-checkpoint-incoming",
            ),
            target,
            storageMaintenance: fixture.targetStorage,
          }),
        });
        const replayTarget = new PairedRecoveryCheckpointTarget({
          homeId: sourceTrust!.homeId,
          sourceDeviceId: sourceTrust!.issuer.deviceId,
          targetDeviceId: fixture.targetDeviceId,
          recipientKeyId: keyIdForPublicKey(sourceTrust!.recoveryBackupPublicKey!),
          transport: receiver,
          storageMaintenance: fixture.sourceStorage,
        });
        await expect(replayTarget.activateRoot({
          checkpointId: activation.checkpointId,
          event: activation.event,
          record: activation.record,
        })).resolves.toBeUndefined();
        await expect(replayTarget.activateRoot({
          checkpointId: activation.checkpointId,
          event: activation.event,
          record: {
            ...activation.record,
            chainHead: {
              ...activation.record.chainHead,
              seq: activation.record.chainHead.seq + 1,
            },
          },
        })).rejects.toThrow(/terminal replay|record|result/);
        expect(await fixture.targetBootstrap.bootstrapStore.loadTrustRecord()).toEqual(targetTrust);
      } finally {
        await target.close();
      }

      const active = await startActiveCheckpointReceiver(fixture);
      try {
        await runBackupSetupCommand(
          { pairedDeviceName: "recovery target" },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: () => undefined,
          },
        );
      } finally {
        await active.stop();
      }
      expect((await fixture.sourceBootstrap.bootstrapStore.loadCheckpointRecords()).some((record) =>
        record.t === "checkpoint-created" &&
        record.purpose.kind === "periodic" &&
        record.targetId === `backup-device:${fixture.targetDeviceId}`)).toBe(true);
    },
  );

  it.each(["v1", "v2"] as const)(
    "replays the originating %s checkpoint after source trust advances before target commit",
    async (version) => {
      const fixture = await pairedHomeWithoutRecoveryRoot(version);
      const firstRuntime = new RecoveryRootEstablishmentRuntime({
        zhixingHome: fixture.targetHome,
        mesh: fixture.targetBootstrap,
        secretStore: fixture.targetSecrets,
        storageMaintenance: fixture.targetStorage,
      });
      const mutableTargetLog = fixture.targetBootstrap.bootstrapStore.authorityLog() as unknown as {
        transactProjection: (...args: unknown[]) => Promise<unknown>;
      };
      const originalTargetTransaction = mutableTargetLog.transactProjection.bind(
        fixture.targetBootstrap.bootstrapStore.authorityLog(),
      );
      let failTargetCommit = true;
      let displayedPackage: string | undefined;
      try {
        await firstRuntime.start();
        mutableTargetLog.transactProjection = async (...args: unknown[]) => {
          if (failTargetCommit) {
            failTargetCommit = false;
            throw new Error("injected target root commit disconnect");
          }
          return originalTargetTransaction(...args);
        };
        await expect(runBackupSetupCommand(
          { pairedDeviceName: "recovery target" },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: (line) => {
              if (line.startsWith("恢复包：")) displayedPackage = line.slice("恢复包：".length);
            },
            readRecoveryPackage: async () => {
              if (version === "v1") return fixture.legacyPackage!;
              if (!displayedPackage) throw new Error("recovery package was not displayed before read-back");
              return displayedPackage;
            },
          },
        )).rejects.toThrow("Mesh service failed");
        expect(failTargetCommit).toBe(false);
      } finally {
        mutableTargetLog.transactProjection = originalTargetTransaction;
        await firstRuntime.stop();
      }

      const sourceAfterActivation = await fixture.sourceBootstrap.bootstrapStore.loadTrustProjection();
      const targetBeforeReplay = await fixture.targetBootstrap.bootstrapStore.loadTrustProjection();
      if (!sourceAfterActivation?.recoveryActivationDigest || !targetBeforeReplay) {
        throw new Error("fault scenario did not preserve the expected source/target trust split");
      }
      expect(sourceAfterActivation.recoveryRootPublicKey).toBeDefined();
      expect(targetBeforeReplay.recoveryRootPublicKey).toBeUndefined();

      const roleChange = createSignedTrustEvent({
        current: sourceAfterActivation,
        body: {
          t: "role-change",
          deviceId: fixture.targetDeviceId,
          roles: ["executor", "surface"],
        },
        at: new Date(Date.now() + 1_000).toISOString(),
        signer: fixture.sourceBootstrap.deviceKey,
      });
      const advanced = await fixture.sourceBootstrap.bootstrapStore.appendTrustEvent({
        event: roleChange,
        issuerKey: fixture.sourceBootstrap.deviceKey,
      });
      expect(advanced.chainHead.seq).toBeGreaterThan(sourceAfterActivation.chainHead.seq);
      expect(advanced.recoveryActivationDigest).toBe(sourceAfterActivation.recoveryActivationDigest);

      const historical = await fixture.sourceBootstrap.bootstrapStore
        .loadRecoveryRootActivationReplay({
          activationDigest: sourceAfterActivation.recoveryActivationDigest,
          targetId: `backup-device:${fixture.targetDeviceId}`,
        });
      expect(historical).toBeDefined();
      expect(historical!.event.seq).toBe(sourceAfterActivation.chainHead.seq);
      expect(historical!.record.chainHead).toEqual(sourceAfterActivation.chainHead);
      await expect(fixture.sourceBootstrap.bootstrapStore.loadRecoveryRootActivationReplay({
        activationDigest: sourceAfterActivation.recoveryActivationDigest,
        targetId: "backup-device:wrong-target",
      })).resolves.toBeUndefined();

      const restartedTarget = await prepareMeshRuntimeBootstrap({
        zhixingHome: fixture.targetHome,
        secretStore: fixture.targetSecrets,
        storageMaintenance: fixture.targetStorage,
        configuration: { enabledRoles: ["executor"] },
      });
      if (restartedTarget.mode !== "trusted-home") throw new Error("expected trusted target home");
      const replayRuntime = new RecoveryRootEstablishmentRuntime({
        zhixingHome: fixture.targetHome,
        mesh: restartedTarget,
        secretStore: fixture.targetSecrets,
        storageMaintenance: fixture.targetStorage,
      });
      let finiteReplay: Promise<void> | undefined;
      let finiteReplayOutcome: Promise<void> | undefined;
      try {
        await replayRuntime.start();
        finiteReplay = runBackupSetupCommand(
          { pairedDeviceName: "recovery target" },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: () => undefined,
          },
        );
        finiteReplayOutcome = finiteReplay.catch(() => undefined);
        await withTimeout(replayRuntime.waitUntilActivated(), "target did not replay the historical root");
        await replayRuntime.stop();
        await withTimeout(
          finiteReplayOutcome,
          "source setup did not leave the finite root-establishment topology",
        );
      } finally {
        await replayRuntime.stop();
        await finiteReplayOutcome;
      }

      const targetAfterReplay = await fixture.targetBootstrap.bootstrapStore.loadTrustRecord();
      expect(targetAfterReplay?.chainHead).toEqual(historical!.record.chainHead);
      const active = await startActiveCheckpointReceiver(fixture);
      try {
        await runBackupSetupCommand(
          { pairedDeviceName: "recovery target" },
          {
            zhixingHome: fixture.sourceHome,
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: () => undefined,
          },
        );
      } finally {
        await active.stop();
      }
      expect(await fixture.targetBootstrap.bootstrapStore.loadTrustRecord()).toEqual(targetAfterReplay);

      const committed = await fixture.sourceBootstrap.bootstrapStore
        .bootstrapAuthority()
        .loadRecoveryActivation(historical!.checkpointId);
      if (!committed) throw new Error("originating activation commit was not persisted");
      await fixture.sourceBootstrap.bootstrapStore.authorityLog().append([{
        stream: "checkpoint",
        body: { t: "recovery-activation-committed" as const, commit: committed.commit },
      }]);
      await expect(fixture.sourceBootstrap.bootstrapStore.loadRecoveryRootActivationReplay({
        activationDigest: sourceAfterActivation.recoveryActivationDigest,
        targetId: `backup-device:${fixture.targetDeviceId}`,
      })).rejects.toThrow("Recovery root activation replay identity is ambiguous");
      expect(await fixture.targetBootstrap.bootstrapStore.loadTrustRecord()).toEqual(targetAfterReplay);
    },
  );
});

describe("recovery root reset co-signer", () => {
  it("uses only the distinct active device key and current signed trust", async () => {
    const fixture = await pairedHomeWithoutRecoveryRoot("v2");
    const beforeRefs = await fixture.targetSecrets.list();
    const beforeEvents = await fixture.targetBootstrap.bootstrapStore.loadTrustEvents();
    const output: string[] = [];

    await runRecoveryRootApproveResetCommand(
      { userConfirmed: true },
      {
        zhixingHome: fixture.targetHome,
        secretStore: fixture.targetSecrets,
        writeLine: (line) => output.push(line),
        now: () => "2026-08-10T00:10:00.000Z",
      },
    );

    expect(output[0]).toMatch(/^重置确认码：/u);
    expect(await fixture.targetSecrets.list()).toEqual(beforeRefs);
    expect(await fixture.targetBootstrap.bootstrapStore.loadTrustEvents()).toEqual(beforeEvents);
    await expect(runRecoveryRootApproveResetCommand(
      { userConfirmed: true },
      {
        zhixingHome: fixture.sourceHome,
        secretStore: fixture.sourceSecrets,
        writeLine: () => undefined,
      },
    )).rejects.toThrow(/主设备|第二台/u);
  });
});

describe("recovery root public lifecycle", () => {
  it("rejects reset confirmation before decoding approval or opening issuer mechanisms", async () => {
    const put = vi.fn(async () => undefined);
    const get = vi.fn(async () => null);
    const deleteSecret = vi.fn(async () => undefined);
    const list = vi.fn(async () => [] as SecretRef[]);
    const unlockState = vi.fn(async () => "unlocked" as const);
    const readRecoveryPackage = vi.fn(async () => "must-not-read");
    const openRecoveryTarget = vi.fn(async () => {
      throw new Error("must not open recovery target");
    });
    const writeLine = vi.fn();
    const secretStore = {
      put,
      get,
      delete: deleteSecret,
      list,
      unlockState,
    } satisfies SecretStorePort;

    await expect(runRecoveryRootResetCommand(
      { approval: "malformed-reset-approval", userConfirmed: false },
      {
        secretStore,
        readRecoveryPackage,
        openRecoveryTarget,
        writeLine,
      },
    )).rejects.toThrow("请先确认旧恢复码已永久丢失并准备保存新恢复码");
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(unlockState).not.toHaveBeenCalled();
    expect(readRecoveryPackage).not.toHaveBeenCalled();
    expect(openRecoveryTarget).not.toHaveBeenCalled();
    expect(writeLine).not.toHaveBeenCalled();
  });

  it("rotates through a verified independent checkpoint and can then invalidate the new code", async () => {
    const fixture = await pairedHomeWithoutRecoveryRoot("v2");
    const initialRuntime = new RecoveryRootEstablishmentRuntime({
      zhixingHome: fixture.targetHome,
      mesh: fixture.targetBootstrap,
      secretStore: fixture.targetSecrets,
      storageMaintenance: fixture.targetStorage,
    });
    let currentCode: string | undefined;
    try {
      await initialRuntime.start();
      await runBackupSetupCommand(
        { pairedDeviceName: "recovery target" },
        {
          zhixingHome: fixture.sourceHome,
          secretStore: fixture.sourceSecrets,
          storageMaintenance: fixture.sourceStorage,
          writeLine: (line) => {
            if (line.startsWith("恢复包：")) currentCode = line.slice("恢复包：".length);
          },
          readRecoveryPackage: async () => {
            if (!currentCode) throw new Error("recovery code was not displayed");
            return currentCode;
          },
        },
      );
      await withTimeout(initialRuntime.waitUntilActivated(), "target did not activate initial root");
    } finally {
      await initialRuntime.stop();
    }
    const oldCode = currentCode!;
    let reads = 0;
    await runRecoveryRootRotateCommand(
        { userConfirmed: true },
        {
          zhixingHome: fixture.sourceHome,
          secretStore: fixture.sourceSecrets,
          storageMaintenance: fixture.sourceStorage,
          writeLine: (line) => {
            if (line.startsWith("新的恢复码：")) currentCode = line.slice("新的恢复码：".length);
          },
          readRecoveryPackage: async () => {
            reads += 1;
            if (reads === 1) return oldCode;
            if (!currentCode) throw new Error("new recovery code was not displayed");
            return currentCode;
          },
          openRecoveryTarget: (_binding, recipientKeyId) =>
            openRootLifecycleTarget(fixture, recipientKeyId),
        },
      );
    expect(currentCode).not.toBe(oldCode);

    await expect(runRecoveryRootInvalidateCommand(
      { userConfirmed: true },
      {
        zhixingHome: fixture.sourceHome,
        secretStore: fixture.sourceSecrets,
        storageMaintenance: fixture.sourceStorage,
        writeLine: () => undefined,
        readRecoveryPackage: async () => currentCode!,
      },
    )).resolves.toBeUndefined();
    const bootstrap = await prepareMeshRuntimeBootstrap({
      zhixingHome: fixture.sourceHome,
      secretStore: fixture.sourceSecrets,
      storageMaintenance: fixture.sourceStorage,
      configuration: { enabledRoles: ["executor"] },
    });
    expect(bootstrap.mode).toBe("trusted-home");
    if (bootstrap.mode !== "trusted-home") return;
    expect(bootstrap.trust.recoveryRootPublicKey).toBeUndefined();
    expect(bootstrap.trust.recoveryBackupPublicKey).toBeUndefined();
  });

  it("resets through a distinct-device approval and one verified domain-reset activation", async () => {
    const fixture = await pairedHomeWithoutRecoveryRoot("v2");
    const initialRuntime = new RecoveryRootEstablishmentRuntime({
      zhixingHome: fixture.targetHome,
      mesh: fixture.targetBootstrap,
      secretStore: fixture.targetSecrets,
      storageMaintenance: fixture.targetStorage,
    });
    let initialCode: string | undefined;
    try {
      await initialRuntime.start();
      await runBackupSetupCommand(
        { pairedDeviceName: "recovery target" },
        {
          zhixingHome: fixture.sourceHome,
          secretStore: fixture.sourceSecrets,
          storageMaintenance: fixture.sourceStorage,
          writeLine: (line) => {
            if (line.startsWith("恢复包：")) initialCode = line.slice("恢复包：".length);
          },
          readRecoveryPackage: async () => {
            if (!initialCode) throw new Error("recovery code was not displayed");
            return initialCode;
          },
        },
      );
      await withTimeout(initialRuntime.waitUntilActivated(), "target did not activate initial root");
    } finally {
      await initialRuntime.stop();
    }
    const before = await fixture.sourceBootstrap.bootstrapStore.loadTrustProjection();
    if (!before) throw new Error("source trust projection was not persisted");

    let approval: string | undefined;
    await runRecoveryRootApproveResetCommand(
      { userConfirmed: true },
      {
        zhixingHome: fixture.targetHome,
        secretStore: fixture.targetSecrets,
        writeLine: (line) => {
          if (line.startsWith("重置确认码：")) approval = line.slice("重置确认码：".length);
        },
        now: () => "2026-08-10T00:20:00.000Z",
      },
    );
    if (!approval) throw new Error("reset approval was not displayed");

    let replacementCode: string | undefined;
    await runRecoveryRootResetCommand(
      { approval, userConfirmed: true },
      {
        zhixingHome: fixture.sourceHome,
        secretStore: fixture.sourceSecrets,
        storageMaintenance: fixture.sourceStorage,
        writeLine: (line) => {
          if (line.startsWith("新的恢复码：")) {
            replacementCode = line.slice("新的恢复码：".length);
          }
        },
        readRecoveryPackage: async () => {
          if (!replacementCode) throw new Error("replacement recovery code was not displayed");
          return replacementCode;
        },
        openRecoveryTarget: (_binding, recipientKeyId) =>
          openRootLifecycleTarget(fixture, recipientKeyId),
      },
    );

    const source = await fixture.sourceBootstrap.bootstrapStore.loadTrustProjection();
    const target = await fixture.targetBootstrap.bootstrapStore.loadTrustProjection();
    expect(source?.trustEpoch).toBe(before.trustEpoch + 1);
    expect(source?.recoveryRootPublicKey).toBeDefined();
    expect(source?.recoveryRootPublicKey).not.toBe(before.recoveryRootPublicKey);
    expect(target?.chainHead).toEqual(source?.chainHead);
    expect(target?.recoveryRootPublicKey).toBe(source?.recoveryRootPublicKey);
    expect(source?.members.find((member) => member.device.deviceId === fixture.targetDeviceId)?.state)
      .toBe("pending-reenroll");
  });
});

async function openRootLifecycleTarget(
  fixture: Awaited<ReturnType<typeof pairedHomeWithoutRecoveryRoot>>,
  recipientKeyId: string,
): Promise<{
  readonly target: PairedRecoveryCheckpointTarget;
  readonly close: () => Promise<void>;
}> {
  const targetTrust = await fixture.targetBootstrap.bootstrapStore.loadTrustRecord();
  const sourceTrust = await fixture.sourceBootstrap.bootstrapStore.loadTrustRecord();
  if (!targetTrust?.recoveryBackupPublicKey || !sourceTrust) {
    throw new Error("root lifecycle target is not ready");
  }
  const storedTarget = deferredPairedCheckpointTarget({
    zhixingHome: fixture.targetHome,
    deviceId: fixture.targetDeviceId,
    storageMaintenance: fixture.targetStorage,
  });
  const receiver = new PairedCheckpointReceiver({
    homeId: targetTrust.homeId,
    sourceDeviceId: fixture.sourceBootstrap.deviceKey.deviceId,
    targetDeviceId: fixture.targetDeviceId,
    recipientKeyId: keyIdForPublicKey(targetTrust.recoveryBackupPublicKey),
    rootLifecycle: true,
    commitRootActivation: ({ plan, record }) =>
      commitRecoveryRootLifecycleActivation(
        fixture.targetBootstrap.bootstrapStore,
        plan,
        record,
      ),
    staging: new FilePairedCheckpointStaging({
      root: path.join(
        fixture.targetHome,
        "distributed-runtime",
        "recovery-checkpoint-incoming",
      ),
      target: storedTarget,
      storageMaintenance: fixture.targetStorage,
    }),
  });
  return {
    target: new PairedRecoveryCheckpointTarget({
      homeId: sourceTrust.homeId,
      sourceDeviceId: fixture.sourceBootstrap.deviceKey.deviceId,
      targetDeviceId: fixture.targetDeviceId,
      recipientKeyId,
      transport: receiver,
      storageMaintenance: fixture.sourceStorage,
    }),
    close: async () => undefined,
  };
}

async function startActiveCheckpointReceiver(
  fixture: Awaited<ReturnType<typeof pairedHomeWithoutRecoveryRoot>>,
  onError?: (error: Error) => void,
): Promise<ProductionMeshControlPlane> {
  const mesh = await prepareMeshRuntimeBootstrap({
    zhixingHome: fixture.targetHome,
    secretStore: fixture.targetSecrets,
    storageMaintenance: fixture.targetStorage,
    configuration: { enabledRoles: ["executor"] },
  });
  if (
    mesh.mode !== "trusted-home" ||
    !mesh.trust.recoveryBackupPublicKey
  ) throw new Error("expected an activated target home");
  const services = new MeshServiceRegistry();
  const target = deferredPairedCheckpointTarget({
    zhixingHome: fixture.targetHome,
    deviceId: fixture.targetDeviceId,
    storageMaintenance: fixture.targetStorage,
  });
  const receiver = new PairedCheckpointReceiver({
      homeId: mesh.trust.homeId,
      sourceDeviceId: mesh.trust.issuer.deviceId,
      targetDeviceId: fixture.targetDeviceId,
      recipientKeyId: keyIdForPublicKey(mesh.trust.recoveryBackupPublicKey),
      rootLifecycle: true,
      commitRootActivation: async ({ plan, record }) => {
        try {
          await commitRecoveryRootLifecycleActivation(mesh.bootstrapStore, plan, record);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
      staging: new FilePairedCheckpointStaging({
        root: path.join(
          fixture.targetHome,
          "distributed-runtime",
          "recovery-checkpoint-incoming",
        ),
        target,
        storageMaintenance: fixture.targetStorage,
      }),
    });
  registerPairedCheckpointMeshService(
    services,
    {
      request: async (command, signal) => {
        try {
          return await receiver.request(command, signal);
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
    },
    (deviceId) => deviceId === mesh.trust.issuer.deviceId,
  );
  const control = new ProductionMeshControlPlane({
    localIdentity: mesh.deviceKey,
    trust: mesh.trust,
    configuration: mesh.configuration,
    endpoints: mesh.endpoints,
    transportPeers: mesh.transportPeers,
    secretStore: fixture.targetSecrets,
    bootstrapStore: mesh.bootstrapStore,
    services,
    ...(onError ? { onConnectionError: onError } : {}),
    ...(mesh.localEndpoint ? { localEndpoint: mesh.localEndpoint } : {}),
  });
  await control.start();
  return control;
}

async function pairedHomeWithoutRecoveryRoot(version: "v1" | "v2") {
  const sourceHome = await createTempDir(`backup-command-source-${version}`);
  const targetHome = await createTempDir(`backup-command-target-${version}`);
  const sourceSecrets = new MemorySecretStore();
  const targetSecrets = new MemorySecretStore();
  const sourceStorage = storageGovernor();
  const targetStorage = storageGovernor();
  const sourceBootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: sourceHome,
    secretStore: sourceSecrets,
  });
  const targetLocal = await prepareMeshRuntimeBootstrap({
    zhixingHome: targetHome,
    secretStore: targetSecrets,
  });
  const at = new Date().toISOString();
  const sourceIdentity = enrollDeviceIdentity(sourceBootstrap.deviceKey, {
    displayName: "recovery source",
    platform: "headless",
    enrolledAt: at,
  });
  const targetIdentity = enrollDeviceIdentity(targetLocal.deviceKey, {
    displayName: "recovery target",
    platform: "headless",
    enrolledAt: at,
  });
  const initialized = await sourceBootstrap.bootstrapStore.initializeLocalHome({
    key: sourceBootstrap.deviceKey,
    identity: sourceIdentity,
    roles: ["anchor", "executor"],
    at,
  });
  const enrolled = createSignedTrustEvent({
    current: initialized.projection,
    body: {
      t: "enroll",
      device: targetIdentity,
      roles: ["executor"],
      pairingTranscriptDigest: `sha256:${"1".repeat(64)}`,
    },
    at: new Date(Date.parse(at) + 1).toISOString(),
    signer: sourceBootstrap.deviceKey,
  });
  const projection = await sourceBootstrap.bootstrapStore.appendTrustEvent({
    event: enrolled,
    issuerKey: sourceBootstrap.deviceKey,
  });
  const record = await sourceBootstrap.bootstrapStore.loadTrustRecord();
  if (!record) throw new Error("source trust record was not persisted");
  await targetLocal.bootstrapStore.importTrustBootstrap({
    events: await sourceBootstrap.bootstrapStore.loadTrustEvents(),
    record,
    localDeviceId: targetIdentity.deviceId,
  });
  await sourceBootstrap.bootstrapStore.acceptTransportPeer({
    identity: targetIdentity,
    rootCertificatePem: targetLocal.deviceKey.rootCertificatePem,
  });
  await targetLocal.bootstrapStore.acceptTransportPeer({
    identity: sourceIdentity,
    rootCertificatePem: sourceBootstrap.deviceKey.rootCertificatePem,
  });
  const port = await freePort();
  const anchorConfiguration = {
    enabledRoles: ["anchor"] as const,
    anchorListen: { bind: { host: "127.0.0.1", port } },
  };
  const rendezvous = `pairwise-${version}`;
  await sourceSecrets.put({ kind: "rendezvous", bindingId: targetIdentity.deviceId }, rendezvous);
  await targetSecrets.put({ kind: "rendezvous", bindingId: sourceIdentity.deviceId }, rendezvous);
  await writeFile(path.join(sourceHome, "config.jsonc"), JSON.stringify({
    mesh: anchorConfiguration,
  }), "utf8");
  const sourceEndpoint = await prepareMeshRuntimeBootstrap({
    zhixingHome: sourceHome,
    secretStore: sourceSecrets,
    storageMaintenance: sourceStorage,
    configuration: anchorConfiguration,
  });
  if (sourceEndpoint.mode !== "trusted-home" || !sourceEndpoint.localEndpoint) {
    throw new Error("expected the source anchor endpoint");
  }
  await targetLocal.bootstrapStore.acceptEndpoint(sourceEndpoint.localEndpoint);
  const targetBootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: targetHome,
    secretStore: targetSecrets,
    configuration: { enabledRoles: ["executor"] },
  });
  if (targetBootstrap.mode !== "trusted-home") throw new Error("expected trusted target home");

  const legacyPackage = version === "v1"
    ? createLegacyRecoveryPackage(projection, sourceBootstrap.deviceKey)
    : undefined;
  return {
    sourceHome,
    targetHome,
    sourceSecrets,
    targetSecrets,
    sourceStorage,
    targetStorage,
    sourceBootstrap,
    targetBootstrap,
    targetDeviceId: targetIdentity.deviceId,
    legacyPackage,
  };
}

function createLegacyRecoveryPackage(
  current: Parameters<typeof createRecoveryRootEvent>[0]["current"],
  signer: Parameters<typeof createRecoveryRootEvent>[0]["outerSigner"],
): string {
  const root = RecoveryRoot.generate();
  const at = new Date().toISOString();
  const plan = {
    v: 1 as const,
    kind: "establish" as const,
    rootEvent: createRecoveryRootEvent({
      current,
      op: "establish",
      candidate: root,
      outerSigner: signer,
      at,
    }),
  };
  const checkpoint = createRootActivationCheckpoint({
    checkpointId: "01J00000000000000000000033",
    createdAt: at,
    plan,
    recoveryRoot: root,
    issuer: signer,
    scope: ["trust"],
    domainRevisions: { trust: current.chainHead.seq },
    upToLsn: current.chainHead.seq,
    plaintextChunks: [Buffer.from("legacy trust checkpoint")],
  });
  return `zxrp1:${Buffer.from(canonicalize({
    checkpoint: {
      chunks: checkpoint.chunks.map((chunk) => ({
        bytes: Buffer.from(chunk.bytes).toString("base64url"),
        seq: chunk.seq,
      })),
      envelope: checkpoint.envelope,
    },
    recoverySecret: root.exportSecret(),
    v: 1,
  }), "utf8").toString("base64url")}`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function storageGovernor(): StorageMaintenanceGovernorPort {
  const permit = {
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
  };
  return {
    acquire: async (): Promise<DeviceCapacityAdmission> => ({ kind: "granted", permit }),
    snapshot: () => ({ queued: {}, inFlight: {} }),
  };
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  readonly refs = new Map<string, SecretRef>();

  async put(ref: SecretRef, value: string): Promise<void> {
    const key = `${ref.kind}/${ref.bindingId}`;
    this.values.set(key, value);
    this.refs.set(key, ref);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    const key = `${ref.kind}/${ref.bindingId}`;
    this.values.delete(key);
    this.refs.delete(key);
  }

  async list(prefix = ""): Promise<SecretRef[]> {
    return [...this.refs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, ref]) => ref);
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}
