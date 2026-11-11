import { recordingFixture } from "../../../core/src/logging/__tests__/recording.js";
import { createDeviceCapacityRuntime } from "../__tests__/device-capacity-fixture.js";
import { createServer } from "node:net";
import path from "node:path";
import fs, { writeFile } from "node:fs/promises";
import type { SecretRef, SecretStorePort } from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import {
  StorageMaintenanceAdmissionError,
  type DeviceCapacityAdmission,
  type StorageMaintenanceGovernorPort,
} from "@zhixing-ai/core/resources";
import { createRootActivationCheckpoint } from "@zhixing-ai/mesh/checkpoint";
import { enrollDeviceIdentity } from "@zhixing-ai/mesh/device-identity";
import { FileRecoveryCheckpointTarget } from "@zhixing-ai/mesh/checkpoint-target";
import { RecoveryRoot, keyIdForPublicKey } from "@zhixing-ai/mesh/recovery-root";
import {
  PairedRecoveryCheckpointTarget,
  registerPairedCheckpointMeshService,
} from "@zhixing-ai/mesh/paired-checkpoint-target";
import { MeshServiceRegistry } from "@zhixing-ai/mesh/service-registry";
import { createRecoveryRootEvent, createSignedTrustEvent } from "@zhixing-ai/mesh/trust-chain";
import { createTempDir } from "@zhixing-ai/test-utils";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@zhixing-ai/providers";
import { resolveHostLaunchPlan } from "@zhixing-ai/mesh/bootstrap";
import { encodeRecoveryPackage } from "@zhixing-ai/mesh/recovery-package";
import { createBackupTargetConfigurationInfrastructure } from "./backup-target-config-infrastructure.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadExistingDeviceKey } from "./mesh-device-key.js";
import {
  runBackupSetupCommand,
  runBackupStatusCommand,
  runRecoveryRootApproveResetCommand,
  runRecoveryRootInvalidateCommand,
  runRecoveryRootResetCommand,
  runRecoveryRootRotateCommand,
  withBackupBusyMessage,
} from "./backup-command.js";
import {
  prepareMeshRuntimeBootstrap,
  type MeshRuntimeBootstrap,
} from "./mesh-runtime-bootstrap.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { RecoveryRootEstablishmentRuntime } from "./recovery-root-establishment-runtime.js";
import {
  createPairedCheckpointCommandReceiverInfrastructure,
  createPersistentPairedCheckpointCommandReceiverInfrastructure,
  createRecoveryRootPairedCheckpointCommandReceiverInfrastructure,
} from "./paired-checkpoint-incoming-infrastructure.js";
import {
  assertRecoveryRootActivationReplay,
} from "./recovery-root-activation.js";

vi.setConfig({ testTimeout: 120_000 });

describe("paired recovery backup setup", () => {
  it("从未初始化的单机缺保密界面时，在任何持久变更之前拒绝：不建设备钥匙、不写 home 文件", async () => {
    const home = await createTempDir("backup-command-unpaired");
    const secrets = new MemorySecretStore();
    await expect(runBackupSetupCommand(
      { directory: path.join(home, "..", "backup-command-unpaired-target") },
      { zhixingHome: home, secretStore: secrets, writeLine: () => undefined },
    )).rejects.toThrow("恢复包需要交互式保密输入");
    expect(await secrets.list()).toEqual([]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("首次独立目录备份的目录与 home 同盘时，在展示恢复包之前以中文说明拒绝，零持久变更", async () => {
    const home = await createTempDir("backup-command-same-volume");
    const secrets = new MemorySecretStore();
    const show = vi.fn(async () => undefined);
    await expect(runBackupSetupCommand(
      { directory: path.join(home, "..", "backup-command-same-volume-target") },
      {
        zhixingHome: home,
        secretStore: secrets,
        writeLine: () => undefined,
        showRecoveryPackage: show,
        readRecoveryPackage: async () => { throw new Error("不应走到回读"); },
      },
    )).rejects.toThrow("恢复备份目录与知行数据在同一块磁盘上");
    expect(show).not.toHaveBeenCalled();
    expect(await secrets.list()).toEqual([]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it.each([
    ["取消回读", async () => { throw new Error("用户取消了恢复包回读"); }, "用户取消了恢复包回读"],
    ["回读的不是本次的恢复包", async () => encodeRecoveryPackage(RecoveryRoot.generate()), "回读的恢复包与本次生成的恢复根不一致"],
  ] as const)("首次独立目录备份%s时本机原样：恢复包已展示，但不建设备钥匙、信任与角色配置", async (_label, read, message) => {
    const home = await createTempDir("backup-command-candidate-first");
    const secrets = new MemorySecretStore();
    const show = vi.fn(async () => undefined);
    await expect(runBackupSetupCommand(
      { directory: path.join(home, "..", "backup-command-candidate-target") },
      {
        zhixingHome: home,
        secretStore: secrets,
        writeLine: () => undefined,
        showRecoveryPackage: show,
        readRecoveryPackage: read,
        preflightDirectoryTarget: async () => undefined,
      },
    )).rejects.toThrow(message);
    expect(show).toHaveBeenCalledOnce();
    expect(await secrets.list()).toEqual([]);
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("回读确认后才建链；建链之后、恢复根激活之前中断时按需启动，备份状态如实报设置未完成", async () => {
    const home = await createTempDir("backup-command-interrupted");
    const secrets = new MemorySecretStore();
    const directory = path.join(home, "..", "backup-command-interrupted-target");
    let shown: string | undefined;
    // 同盘目录过了注入的预检，却在打开目标时被权威判定拒绝：相当于建链之后、激活之前中断
    await expect(runBackupSetupCommand({ directory }, {
      zhixingHome: home,
      secretStore: secrets,
      writeLine: () => undefined,
      showRecoveryPackage: async (encoded) => { shown = encoded; },
      readRecoveryPackage: async () => shown!,
      preflightDirectoryTarget: async () => undefined,
    })).rejects.toThrow("恢复备份目录与知行数据在同一块磁盘上");
    expect(loadConfig({ homeDir: home }).mesh).toEqual({ enabledRoles: ["anchor", "executor"] });
    const key = await loadExistingDeviceKey(secrets);
    const store = await FileMeshBootstrapStore.open(home, key!, { secretStore: secrets, readOnly: true });
    const trust = await store.loadCurrentTrust().finally(() => store.stopStorageMaintenance());
    expect(trust?.recoveryRootPublicKey).toBeUndefined();
    expect(resolveHostLaunchPlan({
      localDeviceId: key!.deviceId,
      configuration: loadConfig({ homeDir: home }).mesh,
      trust: trust!,
    })).toEqual({ mode: "on-demand", roles: ["anchor", "executor"] });

    // 中断落在选定目标之后：状态给出原目录上的交互设置命令，不伪报备份就绪
    await createBackupTargetConfigurationInfrastructure(home).select({
      kind: "directory",
      targetId: "backup-dir:interrupted",
      directory,
    });
    const lines: string[] = [];
    await runBackupStatusCommand({ zhixingHome: home, secretStore: secrets, writeLine: (line) => lines.push(line) });
    expect(lines).toEqual([
      `恢复备份：设置未完成，恢复根尚未建立，还没有可恢复的副本。下一步：在完整交互终端运行 zz backup setup --directory "${path.resolve(directory)}"，按提示保存并回读恢复包。`,
    ]);
  });

  it("没有保密界面时（管道/非交互）在生成恢复包之前拒绝，普通输出里不出现恢复包，也不建立恢复根", async () => {
    const fixture = await pairedHomeWithoutRecoveryRoot("v2");
    const ordinary: string[] = [];
    await expect(runBackupSetupCommand(
      { pairedDeviceName: "recovery target" },
      {
        zhixingHome: fixture.sourceHome,
        secretStore: fixture.sourceSecrets,
        storageMaintenance: fixture.sourceStorage,
        writeLine: (line) => ordinary.push(line),
      },
    )).rejects.toThrow("恢复包需要交互式保密输入");
    expect(ordinary.join("\n")).not.toMatch(/恢复包：|zxrp/u);
    const sourceTrust = await fixture.sourceBootstrap.bootstrapStore.loadTrustRecord();
    expect(sourceTrust?.recoveryRootPublicKey).toBeUndefined();
  });

  it.each(["v1", "v2"] as const)(
    "establishes the first recovery root from a %s package over the restricted production transport",
    async (version) => {
      const fixture = await pairedHomeWithoutRecoveryRoot(version);
      const logs = recordingFixture();
      const runtime = createRecoveryRootEstablishmentRuntime({
        zhixingHome: fixture.targetHome,
        mesh: fixture.targetBootstrap,
        secretStore: fixture.targetSecrets,
        storageMaintenance: fixture.targetStorage,
      });
      let displayedPackage: string | undefined;
      const ordinary: string[] = [];
      try {
        await runtime.start();
        await runBackupSetupCommand(
          { pairedDeviceName: "recovery target" },
          {
            zhixingHome: fixture.sourceHome,
            logging: { bind: logs.bind, capacity: createDeviceCapacityRuntime(fixture.sourceHome) },
            secretStore: fixture.sourceSecrets,
            storageMaintenance: fixture.sourceStorage,
            writeLine: (line) => ordinary.push(line),
            showRecoveryPackage: async (encoded) => { displayedPackage = encoded; },
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

      expect(displayedPackage).toBeDefined();
      expect(ordinary.join("\n")).not.toContain(displayedPackage!);
      if (fixture.legacyPackage) expect(ordinary.join("\n")).not.toContain(fixture.legacyPackage);

      const sourceTrust = await fixture.sourceBootstrap.bootstrapStore.loadTrustRecord();
      const targetTrust = await fixture.targetBootstrap.bootstrapStore.loadTrustRecord();
      expect(sourceTrust?.recoveryRootPublicKey).toBeDefined();
      expect(sourceTrust?.recoveryBackupPublicKey).toBeDefined();
      expect(targetTrust?.recoveryRootPublicKey).toBe(sourceTrust?.recoveryRootPublicKey);
      expect(targetTrust?.recoveryBackupPublicKey).toBe(sourceTrust?.recoveryBackupPublicKey);

      const records = await fixture.sourceBootstrap.bootstrapStore.authorityLog().readStream<import("@zhixing-ai/core/contracts").CheckpointStreamRecord>("checkpoint").then((entries) => entries.map((entry) => entry.body));
      const verified = records.find((record) => record.t === "checkpoint-verified");
      expect(verified).toBeDefined();
      // 首次建根的激活检查点是完整范围、已复制并真解封验证：没有任何每日备份时材料即已完整验证。
      // 夹具里的配对目标只做执行端、不具备值班资格，所以如实说明还没有可执行恢复的设备；
      // 旧格式恢复包只带信任激活，不是完整备份，状态如实不算已验证
      const statusLines: string[] = [];
      await runBackupStatusCommand({
        zhixingHome: fixture.sourceHome,
        secretStore: fixture.sourceSecrets,
        storageMaintenance: fixture.sourceStorage,
        writeLine: (line) => statusLines.push(line),
      });
      expect(statusLines).toEqual([version === "v2"
        ? "恢复备份：备份已从独立目标完整验证，但还没有可执行恢复的设备。恢复要在同一家庭里另一台已配对、有效且可值班的设备上运行 zz backup recover；这台电脑整机损坏后，目前无法用这份备份恢复。"
        : "恢复备份：尚无可恢复副本。下一步：重新运行 zz backup setup。"]);
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
        const receiver = createPairedCheckpointCommandReceiverInfrastructure({
          zhixingHome: fixture.targetHome,
          target,
          storageMaintenance: fixture.targetStorage,
          receiver: {
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
          },
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
      expect((await fixture.sourceBootstrap.bootstrapStore.authorityLog().readStream<import("@zhixing-ai/core/contracts").CheckpointStreamRecord>("checkpoint").then((entries) => entries.map((entry) => entry.body))).some((record) =>
        record.t === "checkpoint-created" &&
        record.purpose.kind === "periodic" &&
        record.targetId === `backup-device:${fixture.targetDeviceId}`)).toBe(true);
    },
  );

  it.each(["v1", "v2"] as const)(
    "replays the originating %s checkpoint after source trust advances before target commit",
    async (version) => {
      const fixture = await pairedHomeWithoutRecoveryRoot(version);
      const firstRuntime = createRecoveryRootEstablishmentRuntime({
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
            showRecoveryPackage: async (encoded) => { displayedPackage = encoded; },
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
      const replayRuntime = createRecoveryRootEstablishmentRuntime({
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

describe("backup administration error mapping", () => {
  it("重试后仍被存储维护背压时说明本机正忙，不显示内部英文原文", async () => {
    const busy = new StorageMaintenanceAdmissionError(
      { kind: "backpressured", blockedBy: "ioOperations", retryAfterMs: 25 },
      "lifecycle-reconcile",
    );
    const failure = await withBackupBusyMessage(async () => { throw busy; }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("本机数据正忙，暂时无法完成恢复备份，请稍后重试");
    expect((failure as Error).cause).toBe(busy);
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

  it("缺确认时说清后果并给出重新运行要加的参数，不打开任何机制", async () => {
    const readRecoveryPackage = vi.fn(async () => "must-not-read");
    const openRecoveryTarget = vi.fn(async () => { throw new Error("must not open recovery target"); });
    const options = { readRecoveryPackage, openRecoveryTarget, writeLine: vi.fn() };
    await expect(runRecoveryRootRotateCommand({ userConfirmed: false }, options))
      .rejects.toThrow(/旧恢复码随之永久失效.*--confirm-save-new-code/u);
    await expect(runRecoveryRootInvalidateCommand({ userConfirmed: false }, options))
      .rejects.toThrow(/不可用于接管值班.*--confirm-disable/u);
    await expect(runRecoveryRootApproveResetCommand({ userConfirmed: false }, options))
      .rejects.toThrow(/交给当前主设备的确认码.*--confirm-reset/u);
    await expect(runRecoveryRootResetCommand({ approval: "malformed-reset-approval", userConfirmed: false }, options))
      .rejects.toThrow(/其他设备需要重新加入.*--approval <确认码>.*--confirm-save-new-code/u);
    expect(readRecoveryPackage).not.toHaveBeenCalled();
    expect(openRecoveryTarget).not.toHaveBeenCalled();
  });

  it("rotates through a verified independent checkpoint and can then invalidate the new code", async () => {
    const fixture = await pairedHomeWithoutRecoveryRoot("v2");
    const initialRuntime = createRecoveryRootEstablishmentRuntime({
      zhixingHome: fixture.targetHome,
      mesh: fixture.targetBootstrap,
      secretStore: fixture.targetSecrets,
      storageMaintenance: fixture.targetStorage,
    });
    let currentCode: string | undefined;
    const ordinary: string[] = [];
    try {
      await initialRuntime.start();
      await runBackupSetupCommand(
        { pairedDeviceName: "recovery target" },
        {
          zhixingHome: fixture.sourceHome,
          secretStore: fixture.sourceSecrets,
          storageMaintenance: fixture.sourceStorage,
          writeLine: (line) => ordinary.push(line),
          showRecoveryPackage: async (encoded) => { currentCode = encoded; },
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
          writeLine: (line) => ordinary.push(line),
          showRecoveryPackage: async (encoded) => { currentCode = encoded; },
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
    expect(ordinary.join("\n")).not.toContain(oldCode);
    expect(ordinary.join("\n")).not.toContain(currentCode!);

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
    const initialRuntime = createRecoveryRootEstablishmentRuntime({
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
          showRecoveryPackage: async (encoded) => { initialCode = encoded; },
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
    const ordinary: string[] = [];
    await runRecoveryRootApproveResetCommand(
      { userConfirmed: true },
      {
        zhixingHome: fixture.targetHome,
        secretStore: fixture.targetSecrets,
        writeLine: (line) => ordinary.push(line),
        showResetApproval: async (encoded) => { approval = encoded; },
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
        writeLine: (line) => ordinary.push(line),
        showRecoveryPackage: async (encoded) => { replacementCode = encoded; },
        readRecoveryPackage: async () => {
          if (!replacementCode) throw new Error("replacement recovery code was not displayed");
          return replacementCode;
        },
        openRecoveryTarget: (_binding, recipientKeyId) =>
          openRootLifecycleTarget(fixture, recipientKeyId),
      },
    );

    expect(replacementCode).toBeDefined();
    expect(ordinary.join("\n")).not.toContain(replacementCode!);
    expect(ordinary.join("\n")).not.toContain(approval);

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
  readonly kind: "paired-device";
  readonly target: PairedRecoveryCheckpointTarget;
  readonly rootActivation: PairedRecoveryCheckpointTarget;
  readonly close: () => Promise<void>;
}> {
  const targetTrust = await fixture.targetBootstrap.bootstrapStore.loadTrustRecord();
  const sourceTrust = await fixture.sourceBootstrap.bootstrapStore.loadTrustRecord();
  if (!targetTrust?.recoveryBackupPublicKey || !sourceTrust) {
    throw new Error("root lifecycle target is not ready");
  }
  const receiver = createPersistentPairedCheckpointCommandReceiverInfrastructure({
    zhixingHome: fixture.targetHome,
    trust: targetTrust,
    deviceId: fixture.targetDeviceId,
    bootstrapStore: fixture.targetBootstrap.bootstrapStore,
    storageMaintenance: fixture.targetStorage,
  });
  if (!receiver) throw new Error("root lifecycle receiver is not active");
  const target = new PairedRecoveryCheckpointTarget({
    homeId: sourceTrust.homeId,
    sourceDeviceId: fixture.sourceBootstrap.deviceKey.deviceId,
    targetDeviceId: fixture.targetDeviceId,
    recipientKeyId,
    transport: receiver,
    storageMaintenance: fixture.sourceStorage,
  });
  return {
    kind: "paired-device",
    target,
    rootActivation: target,
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
  const receiver = createPersistentPairedCheckpointCommandReceiverInfrastructure({
    zhixingHome: fixture.targetHome,
    trust: mesh.trust,
    deviceId: fixture.targetDeviceId,
    bootstrapStore: mesh.bootstrapStore,
    storageMaintenance: fixture.targetStorage,
  });
  if (!receiver) throw new Error("active paired checkpoint receiver is unavailable");
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
    endpointDirectory: mesh.bootstrapProjection.endpoints,
    transportPeerDirectory: mesh.bootstrapProjection.transportPeers,
    trustProjection: Object.freeze({
      loadCurrentTrust: () => mesh.bootstrapStore.loadCurrentTrust(),
    }),
    services,
    ...(onError ? { onConnectionError: onError } : {}),
    ...(mesh.localEndpoint ? { localEndpoint: mesh.localEndpoint } : {}),
  });
  await control.start();
  return control;
}

function createRecoveryRootEstablishmentRuntime(input: {
  readonly zhixingHome: string;
  readonly mesh: Extract<MeshRuntimeBootstrap, { readonly mode: "trusted-home" }>;
  readonly secretStore: SecretStorePort;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): RecoveryRootEstablishmentRuntime {
  return new RecoveryRootEstablishmentRuntime({
    mesh: input.mesh,
    secretStore: input.secretStore,
    pairedCheckpointReceiver:
      createRecoveryRootPairedCheckpointCommandReceiverInfrastructure({
        zhixingHome: input.zhixingHome,
        trust: input.mesh.trust,
        deviceId: input.mesh.deviceKey.deviceId,
        bootstrapStore: input.mesh.bootstrapStore,
        storageMaintenance: input.storageMaintenance,
      }),
  });
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
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = `${ref.kind}/${ref.bindingId}`;
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
    return value;
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
