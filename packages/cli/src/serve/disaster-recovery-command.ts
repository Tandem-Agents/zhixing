import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import type {
  DeviceIdentity,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  protocolDigest,
  createSignedDisasterRecoveryAbort,
  createSignedDisasterRecoveryCommand,
} from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { createPlatformSecretStore } from "@zhixing/secrets";
import {
  loadConfig,
  loadCredentialsWithLegacyMigration,
  type CredentialStoreCoordinator,
} from "@zhixing/providers";
import {
  FileRecoveryCheckpointTarget,
  type InventoryRecoveryCheckpointTarget,
} from "@zhixing/mesh/checkpoint-target";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";
import { keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createStdoutWriter } from "../screen/index.js";
import {
  createPlannedAnchorReadinessCoordinator,
  createProductionAnchorReadySnapshot,
} from "../setup-delivery.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { FileBackupTargetConfiguration } from "./backup-target-config.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import {
  discoverDisasterRecoveryCandidates,
  selectDisasterRecoveryCandidate,
  type DisasterRecoveryInventoryTarget,
} from "./disaster-recovery-inventory.js";
import { DisasterRecoveryTarget } from "./disaster-recovery-target.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { readRecoveryPackageFromTty } from "./recovery-package-input.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { FileExecutionAssetCache } from "./execution-asset-cache.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
import { collectDisasterRecoveryTrustEvidence } from "./disaster-recovery-trust-evidence.js";
import {
  loadCurrentDisasterRecoveryInstallation,
  waitForDisasterRecoveryPostInstallReceipt,
} from "./disaster-recovery-installation.js";

export interface DisasterRecoveryCommandOptions {
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort & CredentialStoreCoordinator;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly writeLine?: (line: string) => void;
  readonly readRecoveryPackage?: () => Promise<string>;
  readonly inventoryTargets?: readonly DisasterRecoveryInventoryTarget[];
  readonly target?: DisasterRecoveryTarget;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly reachabilityDiscoveryMs?: number;
  readonly postInstallTimeoutMs?: number;
}

export async function runDisasterRecoveryCommand(
  selection: {
    readonly directory?: string;
    readonly pairedDeviceId?: string;
    readonly pairedDeviceName?: string;
    readonly backupNumber?: number;
  },
  options: DisasterRecoveryCommandOptions = {},
): Promise<void> {
  if ([selection.directory, selection.pairedDeviceId, selection.pairedDeviceName]
    .filter((value) => value !== undefined).length > 1) {
    throw new TypeError("恢复时只能选择一个备份目录或一台备份设备");
  }
  const ownedAbort = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? ownedAbort!.signal;
  const onSignal = () => ownedAbort?.abort(new Error("Disaster recovery was cancelled"));
  if (ownedAbort) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  let evidenceMesh: Awaited<ReturnType<typeof openRecoveryEvidenceMesh>> = {
    peerIds: [],
    close: async () => undefined,
  };
  let opened: Awaited<ReturnType<typeof openInventoryTargets>> = {
    targets: [],
    close: async () => undefined,
  };
  try {
    signal.throwIfAborted();
    const context = await openRecoveryContext(options, false);
    signal.throwIfAborted();
    if (context.trust.issuer.deviceId === context.key.deviceId) {
      const installed = await loadCurrentDisasterRecoveryInstallation(context.store.authorityLog());
      if (!installed || installed.installation.trustRecord.issuer.deviceId !== context.key.deviceId) {
        throw new Error("当前设备仍在值班，无需执行无源恢复");
      }
      await waitForDisasterRecoveryPostInstallReceipt({
        log: context.store.authorityLog(),
        generation: installed.generation,
        timeoutMs: options.postInstallTimeoutMs ?? 30_000,
        signal,
      });
      await reportDisasterRecoveryCompleted(context);
      return;
    }
    evidenceMesh = await openRecoveryEvidenceMesh(context, options, signal);
    opened = options.inventoryTargets
      ? { targets: options.inventoryTargets, close: async () => undefined }
      : await openInventoryTargets(context, selection, signal);
    context.writeLine("正在查找完整的恢复备份……");
    const requestId = `recover:${protocolDigest("DisasterRecoveryDiscovery", 1, {
      homeId: context.trust.homeId,
      targetDeviceId: context.key.deviceId,
    }).slice("sha256:".length)}`;
    const candidates = await discoverDisasterRecoveryCandidates({
      requestId,
      targets: opened.targets,
      signal,
    });
    for (const candidate of candidates) {
      context.writeLine(
        `${candidate.public.number}. ${candidate.public.location} · ${candidate.public.backedUpAt} · 待验证`,
      );
    }
    const selected = selectDisasterRecoveryCandidate(candidates, selection.backupNumber);
    context.writeLine("请输入恢复包以验证备份；输入内容不会显示。");
    const decoded = options.readRecoveryPackage
      ? (await import("@zhixing/mesh/recovery-package")).decodeRecoveryPackage(
          await options.readRecoveryPackage(),
        )
      : await readRecoveryPackageFromTty();
    if (
      selected.entry.recipientKeyId !== decoded.root.publicIdentity().backupKeyId ||
      selected.entry.envelope.recipientKeyId !== decoded.root.publicIdentity().backupKeyId
    ) throw new Error("恢复包与所选备份不匹配");
    const transferId = `xfer-${digestUlid(protocolDigest("DisasterRecoveryTransfer", 1, {
      requestId,
      targetDeviceId: context.key.deviceId,
      checkpointTargetId: selected.entry.targetId,
      checkpointEnvelopeDigest: selected.entry.envelope.digest,
    }))}`;
    const prepare = createSignedDisasterRecoveryCommand({
      v: 1,
      op: "prepare",
      requestId,
      transferId,
      targetDeviceId: context.key.deviceId,
      checkpointTargetId: selected.entry.targetId,
      recoveryRoot: {
        homeId: context.trust.homeId,
        rootKeyId: decoded.root.publicIdentity().rootKeyId,
        recipientKeyId: decoded.root.publicIdentity().backupKeyId,
      },
      checkpointEnvelope: selected.entry.envelope,
    }, decoded.root) as Extract<
      import("@zhixing/core/contracts").DisasterRecoveryCommand,
      { op: "prepare" }
    >;
    context.writeLine("正在验证备份……");
    const checkpoint = await selected.target.read(selected.entry.checkpointId, signal);
    const trustEvidence = await collectDisasterRecoveryTrustEvidence({
      store: context.store,
      localDeviceId: context.key.deviceId,
      peers: evidenceMesh.peerIds
        .filter((deviceId) => evidenceMesh.control?.connections.has(deviceId))
        .map((deviceId) => ({
          deviceId,
          client: evidenceMesh.control!.connections.client(deviceId),
        })),
      signal,
    });
    const target = options.target ?? createRecoveryTarget(context, options);
    try {
      await target.prepareAndImport({
        prepare,
        checkpoint,
        recoveryRoot: decoded.root,
        trustEvidence,
        signal,
      });
      context.writeLine("备份验证完成，正在恢复数据并接管值班……");
      await target.commit({ transferId, recoveryRoot: decoded.root, signal });
      const installed = await loadCurrentDisasterRecoveryInstallation(context.store.authorityLog());
      if (!installed || installed.installation.transferId !== transferId) {
        throw new Error("Disaster recovery installation is not the current authority generation");
      }
      await waitForDisasterRecoveryPostInstallReceipt({
        log: context.store.authorityLog(),
        generation: installed.generation,
        timeoutMs: options.postInstallTimeoutMs ?? 30_000,
        signal,
      });
    } catch (error) {
      const abort = createSignedDisasterRecoveryAbort({
        v: 1,
        mode: "disaster-recovery",
        requestId,
        transferId,
        targetDeviceId: context.key.deviceId,
        checkpointTargetId: selected.entry.targetId,
        checkpointEnvelopeDigest: selected.entry.envelope.digest,
        reason: "operator-cancelled",
        at: new Date(options.now?.() ?? Date.now()).toISOString(),
      }, decoded.root);
      await target.abort({ abort, recoveryRoot: decoded.root }).catch(() => undefined);
      throw error;
    }
    await reportDisasterRecoveryCompleted(context);
  } finally {
    if (ownedAbort) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    await Promise.all([
      opened.close(),
      evidenceMesh.close(),
    ]);
  }
}

async function reportDisasterRecoveryCompleted(context: RecoveryContext): Promise<void> {
  context.writeLine("恢复数据已安全提交；旧值班设备已失权。");
  const affected = await new CredentialExposureAuthority({
    deviceId: context.key.deviceId,
    log: context.store.authorityLog(),
    secretStore: context.secretStore,
  }).rotationRequired();
  if (affected.length === 0) {
    context.writeLine("没有需要立即轮换的第三方账号。");
  } else {
    context.writeLine("请处理以下受旧设备影响的第三方账号：");
    for (const item of affected) {
      context.writeLine(`- ${item.service}${item.tenant ? `（${item.tenant}）` : ""}：${
        item.rotationHint ?? "在对应服务中撤销旧凭据并发布新凭据"
      }`);
    }
  }
  context.writeLine("确认旧设备已隔离或擦除后，运行 zz backup recover-finish。");
}

export async function runDisasterRecoveryFinishCommand(
  input: { readonly userConfirmedOldDeviceIsolated: boolean },
  options: DisasterRecoveryCommandOptions = {},
): Promise<void> {
  if (!input.userConfirmedOldDeviceIsolated) {
    throw new Error("请先确认旧值班设备已经隔离或擦除");
  }
  const context = await openRecoveryContext(options, false);
  const current = await loadCurrentDisasterRecoveryInstallation(context.store.authorityLog());
  if (!current) throw new Error("当前设备没有待完成的灾难恢复");
  const target = options.target ?? createRecoveryTarget(context, options);
  await target.tombstone({
    transferId: current.installation.transferId,
    userConfirmedOldDeviceIsolated: true,
  });
  context.writeLine("旧设备隔离已确认，恢复流程完成。");
}

export function disasterRecoveryPublicError(_error: unknown): Error {
  return new Error("恢复未完成。请核对备份位置、恢复包和设备状态后重试；系统不会自动切换值班设备。");
}

interface RecoveryContext {
  readonly home: string;
  readonly secretStore: SecretStorePort & CredentialStoreCoordinator;
  readonly key: Awaited<ReturnType<typeof loadOrCreateDeviceKey>>;
  readonly identity: DeviceIdentity;
  readonly trust: NonNullable<Awaited<ReturnType<FileMeshBootstrapStore["loadTrustRecord"]>>>;
  readonly store: FileMeshBootstrapStore;
  readonly configuration?: MeshRoleBootConfig;
  readonly config: ReturnType<typeof loadConfig>;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly writeLine: (line: string) => void;
}

async function openRecoveryContext(
  options: DisasterRecoveryCommandOptions,
  requireNonIssuer = true,
): Promise<RecoveryContext> {
  const home = options.zhixingHome ?? getZhixingHome();
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir: home });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("设备秘密存储解锁后才能恢复");
  }
  const key = await loadOrCreateDeviceKey(secretStore);
  const storageMaintenance = options.storageMaintenance ??
    createDeviceCapacityRuntime(path.join(home, "distributed-runtime", "capacity")).storage;
  const store = new FileMeshBootstrapStore(home, key, { storageMaintenance });
  const trust = await store.loadTrustRecord();
  if (!trust) throw new Error("本机没有可验证的 home 信任记录");
  const member = trust.members.find((candidate) =>
    candidate.device.deviceId === key.deviceId && candidate.state === "active");
  if (!member || !member.roles.includes("anchor")) {
    throw new Error("恢复目标必须是仍有效且可值班的已配对设备");
  }
  if (requireNonIssuer && trust.issuer.deviceId === key.deviceId) {
    throw new Error("当前设备仍在值班，无需执行无源恢复");
  }
  const config = loadConfig({ homeDir: home });
  return {
    home,
    secretStore,
    key,
    identity: member.device,
    trust,
    store,
    ...(config.mesh ? { configuration: config.mesh } : {}),
    config,
    storageMaintenance,
    writeLine: options.writeLine ?? createStdoutWriter().line,
  };
}

async function openRecoveryEvidenceMesh(
  context: RecoveryContext,
  options: DisasterRecoveryCommandOptions,
  signal: AbortSignal,
): Promise<{
  readonly control?: ProductionMeshControlPlane;
  readonly peerIds: readonly string[];
  readonly close: () => Promise<void>;
}> {
  if (!context.configuration) {
    return { peerIds: [], close: async () => undefined };
  }
  const bootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: context.home,
    secretStore: context.secretStore,
    storageMaintenance: context.storageMaintenance,
    configuration: context.configuration,
  });
  if (bootstrap.mode !== "trusted-home") {
    throw new Error("认证设备网络尚未建立");
  }
  const peerIds = Object.freeze(bootstrap.transportPeers
    .map((peer) => peer.identity.deviceId)
    .filter((deviceId) => deviceId !== context.key.deviceId)
    .sort((left, right) => left.localeCompare(right, "en-US")));
  if (peerIds.length === 0) {
    return { peerIds, close: async () => undefined };
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
    recoveryEvidencePeerIds: peerIds,
    watchTrust: false,
    credentialRouteGuard: new CredentialExposureAuthority({
      deviceId: context.key.deviceId,
      log: context.store.authorityLog(),
      secretStore: context.secretStore,
    }),
  });
  signal.throwIfAborted();
  await control.start();
  try {
    signal.throwIfAborted();
    await abortableDelay(options.reachabilityDiscoveryMs ?? 500, signal);
    return { control, peerIds, close: () => control.stop() };
  } catch (error) {
    await control.stop().catch(() => undefined);
    throw error;
  }
}

async function openInventoryTargets(
  context: RecoveryContext,
  selection: {
    readonly directory?: string;
    readonly pairedDeviceId?: string;
    readonly pairedDeviceName?: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly targets: readonly DisasterRecoveryInventoryTarget[];
  readonly close: () => Promise<void>;
}> {
  signal.throwIfAborted();
  if (selection.directory) {
    const target = await FileRecoveryCheckpointTarget.open({
      targetRoot: selection.directory,
      sourceRoot: path.join(context.home, "distributed-runtime", "authority"),
      create: false,
      storageMaintenance: context.storageMaintenance,
    });
    if (signal.aborted) {
      await target.close();
      signal.throwIfAborted();
    }
    return {
      targets: [{ displayName: path.basename(path.resolve(selection.directory)), target }],
      close: () => target.close(),
    };
  }
  const configured = await new FileBackupTargetConfiguration(context.home).load();
  signal.throwIfAborted();
  const configuredPaired = configured?.bindings.find((binding) =>
    binding.targetId === configured.currentTargetId && binding.kind === "paired-device");
  const named = selection.pairedDeviceName === undefined
    ? []
    : context.trust.members.filter((member) =>
        member.state === "active" &&
        member.device.deviceId !== context.key.deviceId &&
        member.device.displayName === selection.pairedDeviceName);
  if (selection.pairedDeviceName !== undefined && named.length !== 1) {
    throw new Error("设备名称不存在或不唯一，请使用列表中显示的唯一设备名称");
  }
  const pairedDeviceId = named[0]?.device.deviceId ?? selection.pairedDeviceId ??
    (configuredPaired?.kind === "paired-device" ? configuredPaired.deviceId : undefined);
  if (!pairedDeviceId) {
    throw new Error("请指定恢复备份目录或已配对的备份设备");
  }
  const member = context.trust.members.find((candidate) =>
    candidate.device.deviceId === pairedDeviceId && candidate.state === "active");
  if (!member || pairedDeviceId === context.key.deviceId) {
    throw new Error("所选备份设备不是另一台仍有效的已配对设备");
  }
  if (!context.trust.recoveryBackupPublicKey) {
    throw new Error("当前信任记录没有可用于发现备份的恢复根");
  }
  const bootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: context.home,
    secretStore: context.secretStore,
    storageMaintenance: context.storageMaintenance,
    ...(context.configuration ? { configuration: context.configuration } : {}),
  });
  signal.throwIfAborted();
  if (bootstrap.mode !== "trusted-home") throw new Error("认证设备网络尚未建立");
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
  signal.throwIfAborted();
  await control.start();
  try {
    signal.throwIfAborted();
    await waitForPeer(control, pairedDeviceId, 30_000, signal);
    const target = new PairedRecoveryCheckpointTarget({
      homeId: context.trust.homeId,
      sourceDeviceId: context.key.deviceId,
      targetDeviceId: pairedDeviceId,
      recipientKeyId: keyIdForPublicKey(context.trust.recoveryBackupPublicKey),
      transport: new MeshPairedCheckpointTransport(control.connections.client(pairedDeviceId)),
      storageMaintenance: context.storageMaintenance,
    });
    return {
      targets: [{ displayName: member.device.displayName, target }],
      close: () => control.stop(),
    };
  } catch (error) {
    await control.stop().catch(() => undefined);
    throw error;
  }
}

function createRecoveryTarget(
  context: RecoveryContext,
  options: DisasterRecoveryCommandOptions,
): DisasterRecoveryTarget {
  return new DisasterRecoveryTarget({
    deviceId: context.key.deviceId,
    identity: context.identity,
    identityKey: context.key,
    secretStore: context.secretStore,
    sharedArtifacts: context.store.artifactStore(),
    authorityLog: context.store.authorityLog(),
    stagingRoot: path.join(context.home, "distributed-runtime", "disaster-recovery-staging"),
    readiness: productionRecoveryReadiness(context).port,
    storageMaintenance: context.storageMaintenance,
    ...(options.now ? { now: options.now } : {}),
  });
}

function productionRecoveryReadiness(context: RecoveryContext) {
  return createPlannedAnchorReadinessCoordinator(async () => {
    if (!context.configuration?.enabledRoles.includes("anchor")) {
      throw new Error("恢复目标没有启用真实值班角色配置");
    }
    const credentials = await loadCredentialsWithLegacyMigration({
      store: context.secretStore,
      homeDir: context.home,
    });
    const verifier = createTrustedDeviceProtocolVerifier(
      context.trust.members.map((member) => member.device),
    );
    const assets = new FileExecutionAssetCache(
      path.join(context.home, "distributed-runtime", "execution-assets.json"),
      context.store.artifactStore(),
      verifier,
    );
    const assetSnapshot = await assets.current();
    const credentialRevision = protocolDigest("PlannedAnchorCredentialRevision", 1, {
      generation: credentials.generation,
      providers: Object.keys(credentials.credentials.providers ?? {}).sort(),
      mcpServers: Object.keys(credentials.credentials.mcp ?? {}).sort(),
    });
    return createProductionAnchorReadySnapshot({
      configurationSnapshot: {
        config: context.config,
        executableVersion: ZHIXING_CLI_VERSION,
        credentialGeneration: credentials.generation,
      },
      assetRevision: assetSnapshot?.digest ??
        protocolDigest("PlannedAnchorAssetRevision", 1, { state: "empty" }),
      credentialRevision,
      anchorEnabled: true,
      executorEnabled: context.configuration.enabledRoles.includes("executor"),
    });
  });
}

async function waitForPeer(
  control: ProductionMeshControlPlane,
  deviceId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!control.connections.has(deviceId)) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new Error("配对备份设备未上线，请确认设备正在运行后重试");
    }
    await abortableDelay(100, signal);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), milliseconds);
    const onAbort = () => finish(signal.reason);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type DisasterRecoveryInventoryPort = InventoryRecoveryCheckpointTarget;

function digestUlid(digest: string): string {
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
  if (!/^[a-f0-9]{64}$/u.test(hex)) throw new TypeError("恢复请求身份摘要无效");
  let value = BigInt(`0x${hex.slice(0, 32)}`);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}
