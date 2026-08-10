import { hostname, platform } from "node:os";
import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import type {
  DeviceIdentity,
  HomeTrustRecord,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { canonicalize } from "@zhixing/core/protocol";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { loadConfig } from "@zhixing/providers";
import { RecoveryActivationCoordinator } from "@zhixing/mesh/bootstrap-authority";
import {
  createCheckpointId,
  type CheckpointPackage,
  type CheckpointSigner,
} from "@zhixing/mesh/checkpoint";
import { AuthorityCheckpointService } from "@zhixing/mesh/checkpoint-service";
import {
  FileRecoveryCheckpointTarget,
  type RetirableRecoveryCheckpointTarget,
} from "@zhixing/mesh/checkpoint-target";
import { captureFullAuthorityCheckpoint } from "@zhixing/mesh/full-checkpoint";
import { decodeRecoveryPackage, encodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import { enrollDeviceIdentity, type DeviceKey } from "@zhixing/mesh/device-identity";
import {
  activateAnchorIssuerKey,
  loadActiveAnchorIssuerKey,
  persistAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import { RecoveryRoot, keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";
import {
  applyTrustEvent,
  createDomainResetApproval,
  createDomainResetEventFromApproval,
  createRecoveryRootEvent,
  type DomainResetApproval,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import { createStdoutWriter } from "../screen/index.js";
import {
  FileBackupTargetConfiguration,
  type BackupTargetBinding,
} from "./backup-target-config.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { readRecoveryPackageFromTty } from "./recovery-package-input.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { RecoveryRootLifecycleService } from "./recovery-root-lifecycle.js";

export interface BackupCommandOptions {
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort;
  readonly writeLine?: (line: string) => void;
  readonly readRecoveryPackage?: () => Promise<string>;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly now?: () => string;
  readonly openRecoveryTarget?: (
    binding: BackupTargetBinding,
    recipientKeyId: string,
  ) => Promise<{
    readonly target: RetirableRecoveryCheckpointTarget;
    readonly close: () => Promise<void>;
  }>;
}

export async function runBackupSetupCommand(
  selection: {
    readonly directory?: string;
    readonly pairedDeviceName?: string;
    /** Internal test/adapter identity; public callers use pairedDeviceName. */
    readonly pairedDeviceId?: string;
  },
  options: BackupCommandOptions = {},
): Promise<void> {
  const selectedDevice = selection.pairedDeviceName ?? selection.pairedDeviceId;
  if ((selection.directory === undefined) === (selectedDevice === undefined)) {
    throw new TypeError("请选择一个独立目录或一台已配对设备作为恢复备份目标");
  }
  const context = await openContext(options);
  if (selectedDevice) {
    const matches = context.trust.members.filter((candidate) =>
      candidate.state === "active" && (
        selection.pairedDeviceId
          ? candidate.device.deviceId === selectedDevice
          : candidate.device.displayName === selectedDevice
      ));
    if (matches.length > 1) throw new Error("存在同名配对设备，请先修改设备名称后重试");
    const member = matches[0];
    if (!member || member.device.deviceId === context.key.deviceId) {
      throw new Error("恢复备份目标必须是另一台已配对且仍有效的设备");
    }
    const binding = {
      kind: "paired-device",
      targetId: `backup-device:${member.device.deviceId}`,
      deviceId: member.device.deviceId,
    } as const;
    const prepared = !context.trust.recoveryRootPublicKey || !context.trust.recoveryBackupPublicKey
      ? await prepareInitialRoot(context, options.readRecoveryPackage)
      : undefined;
    await context.targets.select(binding);
    if (!prepared) {
      const replay = await currentPairedRootActivation(context, binding.targetId);
      if (replay) {
        const activationConnection = await connectPairedTarget(
          context,
          binding.deviceId,
          keyIdForPublicKey(context.trust.recoveryBackupPublicKey!),
        );
        try {
          await activationConnection.target.activateRoot(replay);
        } finally {
          await activationConnection.close();
        }
      }
    }
    const connection = await connectPairedTarget(
      context,
      binding.deviceId,
      prepared
        ? prepared.checkpoint.envelope.recipientKeyId
        : keyIdForPublicKey(context.trust.recoveryBackupPublicKey!),
    );
    try {
      await completeBackupSetup(
        context,
        connection.target,
        options.readRecoveryPackage,
        prepared,
      );
      if (prepared) {
        const record = await context.store.loadTrustRecord();
        if (!record || prepared.plan.kind !== "establish") {
          throw new Error("恢复根激活后缺少可提交的 current-issuer 信任事实");
        }
        await connection.target.activateRoot({
          checkpointId: prepared.checkpoint.envelope.checkpointId,
          event: prepared.plan.rootEvent,
          record,
        });
      }
    } finally {
      await connection.close();
    }
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
  try {
    await completeBackupSetup(context, target, options.readRecoveryPackage);
  } finally {
    await target.close();
  }
}

export async function runRecoveryRootRotateCommand(
  input: { readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  if (!input.userConfirmed) throw new Error("请先确认已准备保存新的恢复码");
  const context = await openContext(options, false);
  const currentPackage = await readDecodedRecoveryPackage(options.readRecoveryPackage);
  const candidate = await prepareReplacementRoot(context, options);
  const target = await openCurrentTarget(context, candidate.root, options);
  try {
    const at = context.now();
    const rootEvent = createRecoveryRootEvent({
      current: context.projection,
      op: "rotate",
      candidate: candidate.root,
      outerSigner: currentPackage.root,
      at,
    });
    const checkpoint = await captureRootLifecycleCheckpoint(context, {
      v: 1,
      kind: "rotate",
      rootEvent,
    }, candidate.root, at);
    await (await lifecycle(context)).rotate({
      currentRoot: currentPackage.root,
      candidateRoot: candidate.root,
      rootEvent,
      checkpoint,
      target: target.target,
      supersedeCheckpointIds: await currentRootCheckpointIds(context, target.target.targetId),
    });
    context.writeLine("新的恢复码已回读验证并启用；旧恢复码已永久失效。");
  } finally {
    await target.close();
  }
}

export async function runRecoveryRootInvalidateCommand(
  input: { readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  if (!input.userConfirmed) throw new Error("请先确认立即停用当前恢复码");
  const context = await openContext(options, false);
  const decoded = await readDecodedRecoveryPackage(options.readRecoveryPackage);
  await (await lifecycle(context)).invalidate(decoded.root);
  context.writeLine("当前恢复码已停用；创建新恢复码前，恢复备份不可用于接管值班。");
}

export async function runRecoveryRootApproveResetCommand(
  input: { readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  if (!input.userConfirmed) throw new Error("请先在另一台已加入设备上确认重置恢复码");
  const context = await openContext(options, false, false);
  const approval = createDomainResetApproval({
    current: context.projection,
    coSigner: context.key,
    at: context.now(),
  });
  context.writeLine(`重置确认码：${encodeResetApproval(approval)}`);
  context.writeLine("请把确认码交给当前主设备，并立即在那里完成恢复码重置。");
}

export async function runRecoveryRootResetCommand(
  input: { readonly approval: string; readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  if (!input.userConfirmed) throw new Error("请先确认旧恢复码已永久丢失并准备保存新恢复码");
  const context = await openContext(options, false);
  const resetEvent = createDomainResetEventFromApproval({
    current: context.projection,
    issuer: context.issuerKey,
    approval: decodeResetApproval(input.approval),
  });
  const afterReset = applyTrustEvent(context.projection, resetEvent);
  const candidate = await prepareReplacementRoot(context, options);
  const rootEvent = createRecoveryRootEvent({
    current: afterReset,
    op: "establish",
    candidate: candidate.root,
    outerSigner: context.issuerKey,
    at: context.now(),
  });
  const target = await openCurrentTarget(context, candidate.root, options);
  try {
    const checkpoint = await captureRootLifecycleCheckpoint(context, {
      v: 1,
      kind: "domain-reset-establish",
      resetEvent,
      rootEvent,
    }, candidate.root, rootEvent.at);
    await (await lifecycle(context)).reset({
      resetEvent,
      rootEvent,
      candidateRoot: candidate.root,
      checkpoint,
      target: target.target,
      supersedeCheckpointIds: await currentRootCheckpointIds(context, target.target.targetId),
    });
    context.writeLine("新的恢复码已在独立目标回读验证并启用；其他设备需要重新加入。");
  } finally {
    await target.close();
  }
}

export function recoveryRootPublicError(_error: unknown): Error {
  return new Error(
    "恢复码操作未完成。请核对当前设备状态、独立备份和确认码后重试；系统不会绕过共同确认或自动重置安全域。",
  );
}

export async function runBackupVerifyCommand(options: BackupCommandOptions = {}): Promise<void> {
  const context = await openContext(options, false);
  const configured = await context.targets.load();
  if (!configured) throw new Error("尚未配置恢复备份目标，请先运行 zz backup setup");
  const current = configured.bindings.find((candidate) => candidate.targetId === configured.currentTargetId);
  if (!current) throw new Error("恢复备份目标配置缺少当前绑定");
  const selector = createService(context, context.trust, metadataOnlyTarget(current.targetId));
  const candidate = await selector.verificationCandidate();
  if (!candidate) throw new Error("当前恢复根没有待验证的恢复备份");
  const binding = configured.bindings.find((item) => item.targetId === candidate.targetId);
  if (!binding) throw new Error("待验证恢复备份的目标绑定不存在");
  const connection = await openTargetBinding(context, binding);
  try {
    const service = createService(context, context.trust, connection.target);
    const decoded = await readDecodedRecoveryPackage(options.readRecoveryPackage);
    await service.verify({ checkpointId: candidate.checkpointId, recoveryRoot: decoded.root });
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
  const status = await createService(context, context.trust, metadataOnlyTarget(binding.targetId)).status();
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
  readonly issuerKey: DeviceKey;
  readonly identity: DeviceIdentity;
  readonly trust: HomeTrustRecord;
  readonly projection: TrustProjection;
  readonly store: FileMeshBootstrapStore;
  readonly capacity: { readonly storage: StorageMaintenanceGovernorPort };
  readonly targets: FileBackupTargetConfiguration;
  readonly writeLine: (line: string) => void;
  readonly now: () => string;
}

async function openContext(
  options: BackupCommandOptions,
  initialize = true,
  requireIssuer = true,
): Promise<BackupContext> {
  const home = options.zhixingHome ?? getZhixingHome();
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir: home });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("设备秘密存储解锁后才能管理恢复备份");
  }
  const key = await loadOrCreateDeviceKey(secretStore);
  const capacity = options.storageMaintenance
    ? { storage: options.storageMaintenance }
    : createDeviceCapacityRuntime(path.join(home, "distributed-runtime", "capacity"));
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
  if (requireIssuer && trust.issuer.deviceId !== key.deviceId) {
    throw new Error("只有当前主设备可以管理恢复备份");
  }
  const config = loadConfig({ homeDir: home });
  if (config.mesh?.enabledRoles && !config.mesh.enabledRoles.includes("anchor")) {
    throw new Error("只有当前主设备可以管理恢复备份");
  }
  let issuerKey = await loadActiveAnchorIssuerKey(secretStore, trust.issuer.issuerKeyId);
  if (!issuerKey && trust.issuer.issuerKeyId === key.deviceId) {
    const bootstrapKeyId = `home-bootstrap:${trust.homeId}`;
    await persistAnchorIssuerKey(secretStore, bootstrapKeyId, key);
    await activateAnchorIssuerKey(secretStore, bootstrapKeyId, key.deviceId);
    issuerKey = key;
  }
  if (!issuerKey || issuerKey.deviceId !== trust.issuer.issuerKeyId) {
    throw new Error("当前主设备缺少可用的值班签发密钥");
  }
  store.bindIssuerKey(issuerKey);
  return {
    home,
    secretStore,
    ...(config.mesh ? { meshConfiguration: config.mesh } : {}),
    key,
    issuerKey,
    identity,
    trust,
    projection,
    store,
    capacity,
    targets: new FileBackupTargetConfiguration(home),
    writeLine: options.writeLine ?? createStdoutWriter().line,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

interface PreparedInitialRoot {
  readonly root: RecoveryRoot;
  readonly plan: Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["plan"];
  readonly checkpoint: Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["checkpoint"];
}

async function prepareInitialRoot(
  context: BackupContext,
  readRecoveryPackage?: () => Promise<string>,
): Promise<PreparedInitialRoot> {
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
      outerSigner: context.issuerKey,
      at: createdAt,
    }),
  };
  const legacyPurpose = decoded.legacyCheckpoint?.envelope.manifest.purpose;
  if (legacyPurpose && legacyPurpose.kind !== "root-activation") {
    throw new Error("旧版恢复包不包含恢复根激活计划");
  }
  const plan = legacyPurpose?.kind === "root-activation" ? legacyPurpose.plan : generatedPlan;
  const issuer = checkpointIssuer(currentIssuerIdentity(context), context.issuerKey);
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
  if (checkpoint.envelope.recipientKeyId !== keyIdForPublicKey(decoded.root.backupPublicKey)) {
    throw new Error("恢复包与恢复 checkpoint 的 recipient 身份不一致");
  }
  return { root: decoded.root, plan, checkpoint };
}

async function establishInitialRoot(
  context: BackupContext,
  target: RetirableRecoveryCheckpointTarget,
  readRecoveryPackage?: () => Promise<string>,
  prepared?: PreparedInitialRoot,
): Promise<void> {
  const initial = prepared ?? await prepareInitialRoot(context, readRecoveryPackage);
  await new RecoveryActivationCoordinator(context.store.bootstrapAuthority()).activatePrepared({
    current: context.projection,
    plan: initial.plan,
    checkpoint: initial.checkpoint,
    candidateRoot: initial.root,
    issuerIdentity: currentIssuerIdentity(context),
    target,
    sourceIndependenceDomain: `filesystem:${await sourceDevice(context.store)}`,
    now: () => new Date().toISOString(),
  });
}

async function completeBackupSetup(
  context: BackupContext,
  target: RetirableRecoveryCheckpointTarget,
  readRecoveryPackage?: () => Promise<string>,
  prepared?: PreparedInitialRoot,
): Promise<void> {
  if (!context.trust.recoveryRootPublicKey || !context.trust.recoveryBackupPublicKey) {
    await establishInitialRoot(context, target, readRecoveryPackage, prepared);
    context.writeLine("恢复备份已创建、回读并验证，可用于恢复。");
    return;
  }
  const checkpoint = await createService(context, context.trust, target).createAndReplicate({
    request: {
      kind: "forced",
      requestId: `backup-setup:${target.targetId}:${context.trust.chainHead.eventDigest}`,
    },
  });
  context.writeLine(`恢复备份已写入目标，仍需运行 zz backup verify 完成验证（${checkpoint.envelope.checkpointId}）。`);
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
    issuer: checkpointIssuer(currentIssuerIdentity(context), context.issuerKey),
    recipient,
    currentAnchor: trust.issuer.deviceId === context.key.deviceId,
    storageMaintenance: context.capacity.storage,
  });
}

async function connectPairedTarget(
  context: BackupContext,
  targetDeviceId: string,
  recipientKeyId = context.trust.recoveryBackupPublicKey
    ? keyIdForPublicKey(context.trust.recoveryBackupPublicKey)
    : undefined,
): Promise<{
  readonly target: PairedRecoveryCheckpointTarget;
  readonly close: () => Promise<void>;
}> {
  const member = context.trust.members.find((candidate) =>
    candidate.state === "active" && candidate.device.deviceId === targetDeviceId);
  if (!member || targetDeviceId === context.key.deviceId) {
    throw new Error("恢复备份目标不再是另一台有效配对设备");
  }
  if (!recipientKeyId) throw new Error("恢复备份目标缺少候选恢复根身份");
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
    credentialRouteGuard: new CredentialExposureAuthority({
      deviceId: context.key.deviceId,
      log: context.store.authorityLog(),
      secretStore: context.secretStore,
    }),
    watchTrust: false,
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
        recipientKeyId,
        transport: new MeshPairedCheckpointTransport(control.connections.client(targetDeviceId)),
        storageMaintenance: context.capacity.storage,
      }),
      close: () => control.stop(),
    };
  } catch (error) {
    await control.stop().catch(() => undefined);
    throw error;
  }
}

async function currentPairedRootActivation(
  context: BackupContext,
  targetId: string,
): Promise<{
  readonly checkpointId: string;
  readonly event: Parameters<PairedRecoveryCheckpointTarget["activateRoot"]>[0]["event"];
  readonly record: HomeTrustRecord;
} | undefined> {
  if (!context.projection.recoveryActivationDigest) return undefined;
  return context.store.loadRecoveryRootActivationReplay({
    activationDigest: context.projection.recoveryActivationDigest,
    targetId,
  });
}

async function openTargetBinding(
  context: BackupContext,
  binding: BackupTargetBinding,
  recipientKeyId?: string,
): Promise<{ readonly target: RetirableRecoveryCheckpointTarget; readonly close: () => Promise<void> }> {
  if (binding.kind === "paired-device") {
    return connectPairedTarget(context, binding.deviceId, recipientKeyId);
  }
  const target = await FileRecoveryCheckpointTarget.open({
    targetRoot: binding.directory,
    sourceRoot: path.join(context.home, "distributed-runtime", "authority"),
    create: false,
    storageMaintenance: context.capacity.storage,
  });
  if (target.targetId !== binding.targetId) {
    await target.close();
    throw new Error("恢复备份目标的物理身份已改变");
  }
  return {
    target,
    close: () => target.close(),
  };
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

function currentIssuerIdentity(context: BackupContext): DeviceIdentity {
  if (context.issuerKey.deviceId === context.identity.deviceId) return context.identity;
  return Object.freeze({
    ...context.identity,
    deviceId: context.issuerKey.deviceId,
    publicKey: context.issuerKey.publicKey,
  });
}

async function prepareReplacementRoot(
  context: BackupContext,
  options: BackupCommandOptions,
): Promise<{ readonly root: RecoveryRoot }> {
  const generated = RecoveryRoot.generate();
  context.writeLine(`新的恢复码：${encodeRecoveryPackage(generated)}`);
  const readBack = await readDecodedRecoveryPackage(options.readRecoveryPackage);
  if (
    readBack.root.rootPublicKey !== generated.rootPublicKey ||
    readBack.root.backupPublicKey !== generated.backupPublicKey
  ) throw new Error("回读的恢复码与本次生成的新恢复码不一致");
  return { root: readBack.root };
}

async function openCurrentTarget(
  context: BackupContext,
  recipient: RecoveryRoot,
  options: BackupCommandOptions,
): Promise<{ readonly target: RetirableRecoveryCheckpointTarget; readonly close: () => Promise<void> }> {
  const configured = await context.targets.load();
  if (!configured) throw new Error("尚未配置独立恢复备份目标");
  const binding = configured.bindings.find((candidate) =>
    candidate.targetId === configured.currentTargetId);
  if (!binding) throw new Error("恢复备份目标配置缺少当前绑定");
  const recipientKeyId = keyIdForPublicKey(recipient.backupPublicKey);
  if (options.openRecoveryTarget) return options.openRecoveryTarget(binding, recipientKeyId);
  return openTargetBinding(context, binding, recipientKeyId);
}

async function captureRootLifecycleCheckpoint(
  context: BackupContext,
  plan: Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["plan"],
  candidateRoot: RecoveryRoot,
  createdAt: string,
): Promise<CheckpointPackage> {
  return (await captureFullAuthorityCheckpoint({
    checkpointId: createCheckpointId(),
    createdAt,
    purpose: { kind: "root-activation", plan },
    trust: context.trust,
    issuer: checkpointIssuer(currentIssuerIdentity(context), context.issuerKey),
    recipient: candidateRoot.publicIdentity(),
    log: context.store.authorityLog(),
    artifacts: context.store.artifactStore(),
    retention: context.store.checkpointRetention(),
    storageMaintenance: context.capacity.storage,
  })).checkpoint;
}

async function currentRootCheckpointIds(
  context: BackupContext,
  targetId: string,
): Promise<readonly string[]> {
  if (!context.projection.recoveryActivationDigest) return [];
  const replay = await context.store.loadRecoveryRootActivationReplay({
    activationDigest: context.projection.recoveryActivationDigest,
    targetId,
  });
  return replay ? [replay.checkpointId] : [];
}

async function lifecycle(context: BackupContext): Promise<RecoveryRootLifecycleService> {
  return new RecoveryRootLifecycleService({
    store: context.store,
    issuerKey: context.issuerKey,
    issuerIdentity: currentIssuerIdentity(context),
    sourceIndependenceDomain: `filesystem:${await sourceDevice(context.store)}`,
    now: context.now,
  });
}

const RESET_APPROVAL_PREFIX = "zxra1:";

function encodeResetApproval(approval: DomainResetApproval): string {
  return `${RESET_APPROVAL_PREFIX}${Buffer.from(canonicalize(approval), "utf8").toString("base64url")}`;
}

function decodeResetApproval(value: string): DomainResetApproval {
  if (!value.startsWith(RESET_APPROVAL_PREFIX)) throw new TypeError("重置确认码格式无效");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(RESET_APPROVAL_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new TypeError("重置确认码格式无效");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("重置确认码格式无效");
  }
  const record = parsed as Record<string, unknown>;
  if (
    canonicalize(Object.keys(record).sort()) !== canonicalize([
      "at", "coSign", "homeId", "prevEventDigest", "seq", "trustEpoch", "v",
    ]) ||
    record.v !== 1 || typeof record.homeId !== "string" ||
    typeof record.prevEventDigest !== "string" || typeof record.seq !== "number" ||
    typeof record.trustEpoch !== "number" || typeof record.at !== "string" ||
    !record.coSign || typeof record.coSign !== "object" || Array.isArray(record.coSign)
  ) throw new TypeError("重置确认码格式无效");
  const coSign = record.coSign as Record<string, unknown>;
  const signature = coSign.sig;
  if (
    canonicalize(Object.keys(coSign).sort()) !== canonicalize(["deviceId", "sig"]) ||
    typeof coSign.deviceId !== "string" || !signature || typeof signature !== "object" ||
    Array.isArray(signature)
  ) throw new TypeError("重置确认码格式无效");
  const signatureRecord = signature as Record<string, unknown>;
  if (
    canonicalize(Object.keys(signatureRecord).sort()) !== canonicalize(["alg", "keyId", "sig"]) ||
    typeof signatureRecord.alg !== "string" || typeof signatureRecord.keyId !== "string" ||
    typeof signatureRecord.sig !== "string"
  ) throw new TypeError("重置确认码格式无效");
  return Object.freeze({
    v: 1,
    homeId: record.homeId,
    seq: record.seq,
    prevEventDigest: record.prevEventDigest,
    trustEpoch: record.trustEpoch,
    at: record.at,
    coSign: Object.freeze({
      deviceId: coSign.deviceId,
      sig: Object.freeze({
        alg: signatureRecord.alg,
        keyId: signatureRecord.keyId,
        sig: signatureRecord.sig,
      }),
    }),
  });
}

function devicePlatform(): "linux" | "windows" | "macos" | "headless" {
  const current = platform();
  if (current === "win32") return "windows";
  if (current === "darwin") return "macos";
  if (current === "linux") return "linux";
  return "headless";
}
