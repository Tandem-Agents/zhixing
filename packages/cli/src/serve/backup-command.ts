import { hostname, platform } from "node:os";
import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import type {
  DeviceIdentity,
  HomeTrustRecord,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { loadConfig } from "@zhixing/providers";
import { RecoveryActivationCoordinator } from "@zhixing/mesh/bootstrap-authority";
import { createCheckpointId, type CheckpointSigner } from "@zhixing/mesh/checkpoint";
import { AuthorityCheckpointService } from "@zhixing/mesh/checkpoint-service";
import {
  FileRecoveryCheckpointTarget,
  type RetirableRecoveryCheckpointTarget,
} from "@zhixing/mesh/checkpoint-target";
import { captureFullAuthorityCheckpoint } from "@zhixing/mesh/full-checkpoint";
import { decodeRecoveryPackage, encodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import { enrollDeviceIdentity, type DeviceKey } from "@zhixing/mesh/device-identity";
import { RecoveryRoot, keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";
import { createRecoveryRootEvent, type TrustProjection } from "@zhixing/mesh/trust-chain";
import { createStdoutWriter } from "../screen/index.js";
import { FileBackupTargetConfiguration } from "./backup-target-config.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { readRecoveryPackageFromTty } from "./recovery-package-input.js";

export interface BackupCommandOptions {
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort;
  readonly writeLine?: (line: string) => void;
  readonly readRecoveryPackage?: () => Promise<string>;
}

export async function runBackupSetupCommand(
  selection: { readonly directory?: string; readonly pairedDeviceId?: string },
  options: BackupCommandOptions = {},
): Promise<void> {
  if ((selection.directory === undefined) === (selection.pairedDeviceId === undefined)) {
    throw new TypeError("请选择一个独立目录或一台已配对设备作为恢复备份目标");
  }
  const context = await openContext(options);
  if (selection.pairedDeviceId) {
    const member = context.trust.members.find((candidate) =>
      candidate.state === "active" && candidate.device.deviceId === selection.pairedDeviceId);
    if (!member || member.device.deviceId === context.key.deviceId) {
      throw new Error("恢复备份目标必须是另一台已配对且仍有效的设备");
    }
    await context.targets.select({
      kind: "paired-device",
      targetId: `backup-device:${member.device.deviceId}`,
      deviceId: member.device.deviceId,
    });
    context.writeLine("恢复备份目标已设为配对设备；设备在线时由当前主设备完成首份副本。");
    return;
  }

  const target = await FileRecoveryCheckpointTarget.open({
    targetRoot: selection.directory!,
    sourceRoot: path.join(context.home, "distributed-runtime", "authority"),
    storageMaintenance: context.capacity.storage,
  });
  await context.targets.select({
    kind: "directory",
    targetId: target.targetId,
    directory: path.resolve(selection.directory!),
  });

  if (!context.trust.recoveryRootPublicKey || !context.trust.recoveryBackupPublicKey) {
    await establishInitialRoot(context, target, options.readRecoveryPackage);
    context.writeLine("恢复备份已创建、回读并验证，可用于恢复。");
    return;
  }
  const service = createService(context, context.trust, target);
  const checkpoint = await service.createAndReplicate({
    request: {
      kind: "forced",
      requestId: `backup-setup:${target.targetId}:${context.trust.chainHead.eventDigest}`,
    },
  });
  context.writeLine(`恢复备份已写入目标，仍需运行 zz backup verify 完成验证（${checkpoint.envelope.checkpointId}）。`);
}

export async function runBackupVerifyCommand(options: BackupCommandOptions = {}): Promise<void> {
  const context = await openContext(options, false);
  const configured = await context.targets.load();
  if (!configured) throw new Error("尚未配置恢复备份目标，请先运行 zz backup setup");
  const binding = configured.bindings.find((candidate) => candidate.targetId === configured.currentTargetId);
  if (!binding) throw new Error("恢复备份目标配置缺少当前绑定");
  const connection = binding.kind === "directory"
    ? {
        target: await FileRecoveryCheckpointTarget.open({
          targetRoot: binding.directory,
          sourceRoot: path.join(context.home, "distributed-runtime", "authority"),
          storageMaintenance: context.capacity.storage,
        }) as RetirableRecoveryCheckpointTarget,
        close: async () => undefined,
      }
    : await connectPairedTarget(context, binding.deviceId);
  try {
    const service = createService(context, context.trust, connection.target);
    const checkpointId = await service.verificationCandidate();
    if (!checkpointId) throw new Error("当前目标没有待验证的恢复备份");
    const decoded = await readDecodedRecoveryPackage(options.readRecoveryPackage);
    await service.verify({ checkpointId, recoveryRoot: decoded.root });
    context.writeLine("恢复备份已从实际目标完整解封并验证，可用于恢复。");
  } finally {
    await connection.close();
  }
}

export async function runBackupStatusCommand(options: BackupCommandOptions = {}): Promise<void> {
  const context = await openContext(options, false);
  const configured = await context.targets.load();
  if (!configured) {
    context.writeLine("恢复备份：未配置。下一步：运行 zz backup setup 选择独立目录或配对设备。");
    return;
  }
  const binding = configured.bindings.find((candidate) => candidate.targetId === configured.currentTargetId);
  if (!binding) throw new Error("恢复备份目标配置缺少当前绑定");
  const target: RetirableRecoveryCheckpointTarget = binding.kind === "directory"
    ? await FileRecoveryCheckpointTarget.open({
        targetRoot: binding.directory,
        sourceRoot: path.join(context.home, "distributed-runtime", "authority"),
        storageMaintenance: context.capacity.storage,
      })
    : metadataOnlyTarget(binding.targetId);
  const status = await createService(context, context.trust, target).status();
  if (status.state === "recoverable") {
    context.writeLine("恢复备份：可恢复。最近一份备份已从独立目标完整验证。");
  } else if (status.state === "pending-verification") {
    context.writeLine("恢复备份：待验证。下一步：运行 zz backup verify 并输入恢复包。");
  } else {
    context.writeLine("恢复备份：尚无可恢复副本。下一步：重新运行 zz backup setup。");
  }
}

interface BackupContext {
  readonly home: string;
  readonly secretStore: SecretStorePort;
  readonly meshConfiguration?: MeshRoleBootConfig;
  readonly key: DeviceKey;
  readonly identity: DeviceIdentity;
  readonly trust: HomeTrustRecord;
  readonly projection: TrustProjection;
  readonly store: FileMeshBootstrapStore;
  readonly capacity: ReturnType<typeof createDeviceCapacityRuntime>;
  readonly targets: FileBackupTargetConfiguration;
  readonly writeLine: (line: string) => void;
}

async function openContext(options: BackupCommandOptions, initialize = true): Promise<BackupContext> {
  const home = options.zhixingHome ?? getZhixingHome();
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir: home });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("设备秘密存储解锁后才能管理恢复备份");
  }
  const key = await loadOrCreateDeviceKey(secretStore);
  const capacity = createDeviceCapacityRuntime(path.join(home, "distributed-runtime", "capacity"));
  const store = new FileMeshBootstrapStore(home, key, { storageMaintenance: capacity.storage });
  let projection = await store.loadTrustProjection();
  let trust = await store.loadTrustRecord();
  let identity: DeviceIdentity;
  if (!projection || !trust) {
    if (!initialize) throw new Error("当前设备尚未建立可管理恢复备份的本地身份");
    identity = enrollDeviceIdentity(key, {
      displayName: hostname(),
      platform: devicePlatform(),
      enrolledAt: new Date().toISOString(),
    });
    const created = await store.initializeLocalHome({
      key,
      identity,
      roles: ["anchor", "executor"],
    });
    projection = created.projection;
    trust = created.record;
  } else {
    const member = trust.members.find((candidate) =>
      candidate.state === "active" && candidate.device.deviceId === key.deviceId);
    if (!member) throw new Error("当前设备不在有效的 home 信任成员中");
    identity = member.device;
  }
  if (trust.issuer.deviceId !== key.deviceId) {
    throw new Error("只有当前主设备可以管理恢复备份");
  }
  const config = loadConfig({ homeDir: home });
  if (config.mesh?.enabledRoles && !config.mesh.enabledRoles.includes("anchor")) {
    throw new Error("只有当前主设备可以管理恢复备份");
  }
  return {
    home,
    secretStore,
    ...(config.mesh ? { meshConfiguration: config.mesh } : {}),
    key,
    identity,
    trust,
    projection,
    store,
    capacity,
    targets: new FileBackupTargetConfiguration(home),
    writeLine: options.writeLine ?? createStdoutWriter().line,
  };
}

async function establishInitialRoot(
  context: BackupContext,
  target: FileRecoveryCheckpointTarget,
  readRecoveryPackage?: () => Promise<string>,
): Promise<void> {
  const root = RecoveryRoot.generate();
  const recoveryPackage = encodeRecoveryPackage(root);
  context.writeLine(`恢复包：${recoveryPackage}`);
  const decoded = await readDecodedRecoveryPackage(readRecoveryPackage);
  if (
    !decoded.legacyCheckpoint && (
      decoded.root.rootPublicKey !== root.rootPublicKey ||
      decoded.root.backupPublicKey !== root.backupPublicKey
    )
  ) throw new Error("回读的恢复包与本次生成的恢复根不一致");
  const createdAt = new Date().toISOString();
  const generatedPlan = {
    v: 1 as const,
    kind: "establish" as const,
    rootEvent: createRecoveryRootEvent({
      current: context.projection,
      op: "establish",
      candidate: root,
      outerSigner: context.key,
      at: createdAt,
    }),
  };
  const legacyPurpose = decoded.legacyCheckpoint?.envelope.manifest.purpose;
  if (legacyPurpose && legacyPurpose.kind !== "root-activation") {
    throw new Error("旧版恢复包不包含恢复根激活计划");
  }
  const plan = legacyPurpose?.kind === "root-activation" ? legacyPurpose.plan : generatedPlan;
  const issuer = checkpointIssuer(context.identity, context.key);
  const checkpoint = decoded.legacyCheckpoint ?? (await captureFullAuthorityCheckpoint({
    checkpointId: createCheckpointId(),
    createdAt,
    purpose: { kind: "root-activation", plan },
    trust: context.trust,
    issuer,
    recipient: decoded.root.publicIdentity(),
    log: context.store.authorityLog(),
    artifacts: context.store.artifactStore(),
    retention: context.store.checkpointRetention(),
    storageMaintenance: context.capacity.storage,
  })).checkpoint;
  await new RecoveryActivationCoordinator(context.store.bootstrapAuthority()).activatePrepared({
    current: context.projection,
    plan,
    checkpoint,
    candidateRoot: decoded.root,
    issuerIdentity: context.identity,
    target,
    sourceIndependenceDomain: `filesystem:${await sourceDevice(context.store)}`,
    now: () => new Date().toISOString(),
  });
}

function createService(
  context: BackupContext,
  trust: HomeTrustRecord,
  target: RetirableRecoveryCheckpointTarget,
): AuthorityCheckpointService {
  if (!trust.recoveryBackupPublicKey) throw new Error("当前 home 尚未建立恢复根");
  const recipient = {
    backupPublicKey: trust.recoveryBackupPublicKey,
    backupKeyId: keyIdForPublicKey(trust.recoveryBackupPublicKey),
  };
  return new AuthorityCheckpointService({
    log: context.store.authorityLog(),
    artifacts: context.store.artifactStore(),
    retention: context.store.checkpointRetention(),
    target,
    trust,
    issuer: checkpointIssuer(context.identity, context.key),
    recipient,
    currentAnchor: trust.issuer.deviceId === context.key.deviceId,
    storageMaintenance: context.capacity.storage,
  });
}

async function connectPairedTarget(
  context: BackupContext,
  targetDeviceId: string,
): Promise<{ readonly target: RetirableRecoveryCheckpointTarget; readonly close: () => Promise<void> }> {
  const member = context.trust.members.find((candidate) =>
    candidate.state === "active" && candidate.device.deviceId === targetDeviceId);
  if (!member || targetDeviceId === context.key.deviceId) {
    throw new Error("恢复备份目标不再是另一台有效配对设备");
  }
  const bootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: context.home,
    secretStore: context.secretStore,
    storageMaintenance: context.capacity.storage,
    ...(context.meshConfiguration ? { configuration: context.meshConfiguration } : {}),
  });
  if (bootstrap.mode !== "trusted-home" || !bootstrap.roles.includes("anchor")) {
    throw new Error("只有当前主设备可以连接配对设备核对恢复备份");
  }
  const control = new ProductionMeshControlPlane({
    localIdentity: bootstrap.deviceKey,
    trust: bootstrap.trust,
    configuration: bootstrap.configuration,
    endpoints: bootstrap.endpoints,
    transportPeers: bootstrap.transportPeers,
    secretStore: context.secretStore,
    bootstrapStore: bootstrap.bootstrapStore,
    services: new MeshServiceRegistry(),
    ...(bootstrap.localEndpoint ? { localEndpoint: bootstrap.localEndpoint } : {}),
  });
  try {
    await control.start();
    context.writeLine("正在通过认证连接等待配对备份设备……");
    await waitForPeer(control, targetDeviceId, 30_000);
    return {
      target: new PairedRecoveryCheckpointTarget({
        homeId: context.trust.homeId,
        sourceDeviceId: context.key.deviceId,
        targetDeviceId,
        recipientKeyId: keyIdForPublicKey(context.trust.recoveryBackupPublicKey!),
        transport: new MeshPairedCheckpointTransport(control.connections.client(targetDeviceId)),
      }),
      close: () => control.stop(),
    };
  } catch (error) {
    await control.stop().catch(() => undefined);
    throw error;
  }
}

async function waitForPeer(
  control: ProductionMeshControlPlane,
  deviceId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!control.connections.has(deviceId)) {
    if (Date.now() >= deadline) {
      throw new Error("配对备份设备未在等待时间内上线；请确认目标设备正在运行后重试");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function metadataOnlyTarget(targetId: string): RetirableRecoveryCheckpointTarget {
  const unavailable = async (): Promise<never> => {
    throw new Error("Recovery checkpoint target is not connected");
  };
  return {
    targetId,
    independenceDomain: targetId,
    writeDurable: unavailable,
    read: unavailable,
    retire: unavailable,
  };
}

function checkpointIssuer(identity: DeviceIdentity, key: DeviceKey): DeviceIdentity & CheckpointSigner {
  return Object.assign({}, identity, {
    sign: key.sign.bind(key),
  });
}

async function sourceDevice(store: FileMeshBootstrapStore): Promise<string> {
  return String((await store.authorityLog().originCheckpoint()).logId);
}

async function readDecodedRecoveryPackage(
  injected?: () => Promise<string>,
): Promise<ReturnType<typeof decodeRecoveryPackage>> {
  return injected ? decodeRecoveryPackage(await injected()) : readRecoveryPackageFromTty();
}

function devicePlatform(): "linux" | "windows" | "macos" | "headless" {
  const current = platform();
  if (current === "win32") return "windows";
  if (current === "darwin") return "macos";
  if (current === "linux") return "linux";
  return "headless";
}
