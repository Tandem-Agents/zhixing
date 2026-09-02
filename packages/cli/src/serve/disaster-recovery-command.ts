import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import {
  BackupRecoveryDisasterAdmissionApplicationService,
  BackupRecoveryDisasterAdmissionError,
  BackupRecoveryDisasterLifecycleApplicationService,
  BackupRecoveryDisasterLifecycleError,
  type BackupRecoveryDisasterCompletion,
  type BackupRecoveryDisasterAdmissionTargetSelection,
  validateBackupRecoveryDisasterAdmissionSelection,
} from "@zhixing/core/backup-recovery/application";
import type {
  DeviceIdentity,
  DisasterRecoveryCommand,
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
  loadCredentialSnapshot,
  type CredentialStoreCoordinator,
} from "@zhixing/providers";
import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";
import { keyIdForPublicKey, type RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createStdoutWriter } from "../screen/index.js";
import {
  createPlannedAnchorReadinessCoordinator,
  createProductionAnchorReadySnapshot,
} from "../setup-delivery.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import type { BackupTargetConfigurationRepository } from "./backup-target-config.js";
import { createBackupTargetConfigurationInfrastructure } from "./backup-target-config-infrastructure.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
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
  type DisasterInstalledAuthorityGeneration,
} from "./disaster-recovery-installation.js";
import { createPublishedCheckpointTargetInfrastructure } from "./published-checkpoint-target-infrastructure.js";
import type {
  InventoryPublishedRecoveryCheckpointTarget,
  PublishedCheckpointDirectoryInventorySessions,
  PublishedRecoveryCheckpointInventoryEntry,
} from "./published-checkpoint-target.js";

export interface DisasterRecoveryCommandOptions {
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort & CredentialStoreCoordinator;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly writeLine?: (line: string) => void;
  readonly readRecoveryPackage?: () => Promise<string>;
  readonly target?: DisasterRecoveryTarget;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly reachabilityDiscoveryMs?: number;
  readonly postInstallTimeoutMs?: number;
}

export async function runDisasterRecoveryCommand(
  selection: {
    readonly directory?: string;
    readonly pairedDeviceName?: string;
    readonly backupNumber?: number;
  },
  options: DisasterRecoveryCommandOptions = {},
): Promise<void> {
  try {
    validateBackupRecoveryDisasterAdmissionSelection(selection);
  } catch (error) {
    if (error instanceof BackupRecoveryDisasterAdmissionError) {
      throw disasterAdmissionPublicError(error);
    }
    throw error;
  }
  const ownedAbort = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? ownedAbort!.signal;
  const onSignal = () => ownedAbort?.abort(new Error("Disaster recovery was cancelled"));
  if (ownedAbort) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    signal.throwIfAborted();
    try {
      await createDisasterRecoveryLifecycleApplication(
        selection,
        options,
        signal,
      ).recover();
    } catch (error) {
      if (error instanceof BackupRecoveryDisasterLifecycleError) {
        throw disasterLifecyclePublicError(error);
      }
      throw error;
    }
  } finally {
    if (ownedAbort) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

async function admitDisasterRecoveryCandidate(
  context: RecoveryContext,
  selection: {
    readonly directory?: string;
    readonly pairedDeviceName?: string;
    readonly backupNumber?: number;
  },
  options: DisasterRecoveryCommandOptions,
  signal: AbortSignal,
) {
  const configured = await context.backupTargets.load();
  signal.throwIfAborted();
  const configuredPaired = configured?.bindings.find((binding) =>
    binding.targetId === configured.currentTargetId && binding.kind === "paired-device");
  const application = new BackupRecoveryDisasterAdmissionApplicationService<
    InventoryPublishedRecoveryCheckpointTarget,
    PublishedRecoveryCheckpointInventoryEntry["envelope"],
    RecoveryRoot,
    CheckpointPackage,
    Extract<DisasterRecoveryCommand, { op: "prepare" }>
  >(
    {
      homeId: context.trust.homeId,
      currentDeviceId: context.key.deviceId,
      issuerDeviceId: context.trust.issuer.deviceId,
      pairedDevices: context.trust.members.map((member) => ({
        deviceId: member.device.deviceId,
        displayName: member.device.displayName,
        active: member.state === "active",
        current: member.device.deviceId === context.key.deviceId,
      })),
      ...(configuredPaired?.kind === "paired-device"
        ? { configuredPairedDeviceId: configuredPaired.deviceId }
        : {}),
      ...(context.trust.recoveryBackupPublicKey
        ? {
            recoveryBackupRecipientKeyId: keyIdForPublicKey(
              context.trust.recoveryBackupPublicKey,
            ),
          }
        : {}),
    },
    {
      deriveDiscoveryRequestId: (input) =>
        `recover:${protocolDigest("DisasterRecoveryDiscovery", 1, input).slice("sha256:".length)}`,
      withInventorySources: async (targetSelection, use) => {
        const opened = await openInventoryTargets(context, targetSelection, signal);
        try {
          context.writeLine("正在查找完整的恢复备份……");
          return await use(opened.targets);
        } finally {
          await opened.close();
        }
      },
      inventory: async (target, requestId) =>
        (await target.inventory(requestId, signal)).map((entry) => ({
          checkpointId: entry.checkpointId,
          targetId: entry.targetId,
          recipientKeyId: entry.recipientKeyId,
          envelope: entry.envelope,
          envelopeIdentity: {
            checkpointId: entry.envelope.checkpointId,
            createdAt: entry.envelope.createdAt,
            recipientKeyId: entry.envelope.recipientKeyId,
            digest: entry.envelope.digest,
          },
        })),
      presentCandidates: (candidates) => {
        for (const candidate of candidates) {
          context.writeLine(
            `${candidate.number}. ${candidate.location} · ${candidate.backedUpAt} · 待验证`,
          );
        }
      },
      readRecoveryRoot: async () => {
        context.writeLine("请输入恢复包以验证备份；输入内容不会显示。");
        const recoveryPackages = await import("@zhixing/mesh/recovery-package");
        const decoded = recoveryPackages.requireCurrentRecoveryPackage(
          options.readRecoveryPackage
            ? recoveryPackages.decodeRecoveryPackage(await options.readRecoveryPackage())
            : await readRecoveryPackageFromTty(),
        );
        const identity = decoded.root.publicIdentity();
        return {
          root: decoded.root,
          identity: {
            rootKeyId: identity.rootKeyId,
            backupKeyId: identity.backupKeyId,
          },
        };
      },
      deriveTransferId: (input) =>
        `xfer-${digestUlid(protocolDigest("DisasterRecoveryTransfer", 1, input))}`,
      signPrepare: (intent, root) => createSignedDisasterRecoveryCommand(
        intent,
        root,
      ) as Extract<DisasterRecoveryCommand, { op: "prepare" }>,
      readCheckpoint: async (target, checkpointId) => {
        context.writeLine("正在验证备份……");
        return target.read(checkpointId, signal);
      },
    },
  );
  try {
    return await application.admit(selection);
  } catch (error) {
    if (error instanceof BackupRecoveryDisasterAdmissionError) {
      throw disasterAdmissionPublicError(error);
    }
    throw error;
  }
}

function disasterAdmissionPublicError(error: BackupRecoveryDisasterAdmissionError): Error {
  const message = (() => {
    switch (error.code) {
      case "source-selection-conflict":
        return "恢复时只能选择一个备份目录或一台备份设备";
      case "current-issuer":
        return "当前设备仍在值班，无需执行无源恢复";
      case "paired-device-name-not-unique":
        return "设备名称不存在或不唯一，请使用列表中显示的唯一设备名称";
      case "target-selection-required":
        return "请指定恢复备份目录或已配对的备份设备";
      case "paired-device-ineligible":
        return "所选备份设备不是另一台仍有效的已配对设备";
      case "recovery-root-missing":
        return "当前信任记录没有可用于发现备份的恢复根";
      case "invalid-discovery-request-id":
        return "恢复备份发现请求无效";
      case "invalid-candidate-location":
        return "恢复备份位置名称无效";
      case "invalid-candidate-envelope":
        return "恢复备份候选无效";
      case "candidate-not-found":
        return "没有找到完整的恢复备份";
      case "candidate-selection-required":
        return "发现多个恢复备份，请按位置和时间选择一个";
      case "invalid-candidate-number":
        return "恢复备份序号无效";
      case "recovery-package-mismatch":
        return "恢复包与所选备份不匹配";
      case "invalid-transfer-id":
        return "恢复请求身份摘要无效";
    }
  })();
  return error.errorKind === "type-error" ? new TypeError(message) : new Error(message);
}

type DisasterAdmission = Awaited<ReturnType<typeof admitDisasterRecoveryCandidate>>;
type DisasterTrustEvidence = Awaited<ReturnType<typeof collectDisasterRecoveryTrustEvidence>>;

function createDisasterRecoveryLifecycleApplication(
  selection: {
    readonly directory?: string;
    readonly pairedDeviceName?: string;
    readonly backupNumber?: number;
  },
  options: DisasterRecoveryCommandOptions,
  signal: AbortSignal,
): BackupRecoveryDisasterLifecycleApplicationService<
  DisasterAdmission,
  DisasterTrustEvidence,
  DisasterInstalledAuthorityGeneration
> {
  return new BackupRecoveryDisasterLifecycleApplicationService({
    now: () => new Date(options.now?.() ?? Date.now()).toISOString(),
    withRecoverySession: async (use) => {
      signal.throwIfAborted();
      const context = await openRecoveryContext(options, false);
      signal.throwIfAborted();
      const log = context.store.authorityLog();
      return use({
        currentDeviceId: context.key.deviceId,
        issuerDeviceId: context.trust.issuer.deviceId,
        readCurrentInstallation: async () => {
          const current = await loadCurrentDisasterRecoveryInstallation(log);
          return current && {
            transferId: current.installation.transferId,
            issuerDeviceId: current.installation.trustRecord.issuer.deviceId,
            generation: current.generation,
          };
        },
        waitForPostInstallReceipt: async (generation) => {
          await waitForDisasterRecoveryPostInstallReceipt({
            log,
            generation,
            timeoutMs: options.postInstallTimeoutMs ?? 30_000,
            signal,
          });
        },
        readCredentialRotationRequirements: async () =>
          new CredentialExposureAuthority({
            deviceId: context.key.deviceId,
            log,
            secretStore: context.secretStore,
          }).rotationRequired(),
        presentProgress: (progress) => {
          switch (progress) {
            case "installing":
              context.writeLine("备份验证完成，正在恢复数据并接管值班……");
              break;
            case "recovery-committed":
              context.writeLine("恢复数据已安全提交；旧值班设备已失权。");
              break;
          }
        },
        presentCompletion: (completion) => {
          renderDisasterRecoveryCompletion(completion, context.writeLine);
        },
        withFreshInstall: async (useFresh) => {
          const evidenceMesh = await openRecoveryEvidenceMesh(context, options, signal);
          const target = options.target ?? createRecoveryTarget(context, options);
          try {
            return await useFresh({
              admit: () => admitDisasterRecoveryCandidate(context, selection, options, signal),
              collectPrepareEvidence: async () => collectDisasterRecoveryTrustEvidence({
                store: context.store,
                localDeviceId: context.key.deviceId,
                peers: evidenceMesh.peerIds
                  .filter((deviceId) => evidenceMesh.control?.connections.has(deviceId))
                  .map((deviceId) => ({
                    deviceId,
                    client: evidenceMesh.control!.connections.client(deviceId),
                  })),
                signal,
              }),
              prepareAndImport: async ({ admission, evidence }) => {
                await target.prepareAndImport({
                  prepare: admission.prepare,
                  checkpoint: admission.checkpoint,
                  recoveryRoot: admission.recoveryRoot,
                  trustEvidence: evidence,
                  signal,
                });
              },
              commit: async (admission) => {
                await target.commit({
                  transferId: admission.transferId,
                  recoveryRoot: admission.recoveryRoot,
                  signal,
                });
              },
              abort: async (abortIntent) => {
                const abort = createSignedDisasterRecoveryAbort({
                  v: 1,
                  mode: "disaster-recovery",
                  requestId: abortIntent.requestId,
                  transferId: abortIntent.transferId,
                  targetDeviceId: context.key.deviceId,
                  checkpointTargetId: abortIntent.checkpointTargetId,
                  checkpointEnvelopeDigest: abortIntent.checkpointEnvelopeDigest,
                  reason: abortIntent.reason,
                  at: abortIntent.at,
                }, abortIntent.admission.recoveryRoot);
                await target.abort({
                  abort,
                  recoveryRoot: abortIntent.admission.recoveryRoot,
                });
              },
            });
          } finally {
            await evidenceMesh.close();
          }
        },
      });
    },
    withFinishSession: async (use) => {
      const context = await openRecoveryContext(options, false);
      const log = context.store.authorityLog();
      const target = options.target ?? createRecoveryTarget(context, options);
      return use({
        readCurrentInstallation: async () => {
          const current = await loadCurrentDisasterRecoveryInstallation(log);
          return current && {
            transferId: current.installation.transferId,
            issuerDeviceId: current.installation.trustRecord.issuer.deviceId,
            generation: current.generation,
          };
        },
        readTombstoneDisposition: (transferId) => target.tombstoneDisposition(transferId),
        tombstone: async (transferId) => {
          await target.tombstone({
            transferId,
            userConfirmedOldDeviceIsolated: true,
          });
        },
      });
    },
  });
}

function renderDisasterRecoveryCompletion(
  completion: BackupRecoveryDisasterCompletion,
  writeLine: (line: string) => void,
): void {
  if (completion.credentialRotation.state === "not-required") {
    writeLine("没有需要立即轮换的第三方账号。");
  } else {
    writeLine("请处理以下受旧设备影响的第三方账号：");
    for (const item of completion.credentialRotation.actions) {
      writeLine(`- ${item.service}${item.tenant ? `（${item.tenant}）` : ""}：${
        item.instruction
      }`);
    }
  }
  switch (completion.nextStep.kind) {
    case "confirm-old-device-isolated":
      writeLine("确认旧设备已隔离或擦除后，运行 zz backup recover-finish。");
      break;
  }
}

function disasterLifecyclePublicError(error: BackupRecoveryDisasterLifecycleError): Error {
  switch (error.code) {
    case "current-device-not-recovering":
      return new Error("当前设备仍在值班，无需执行无源恢复");
    case "installation-generation-mismatch":
      return new Error("Disaster recovery installation is not the current authority generation");
    case "finish-confirmation-required":
      return new Error("请先确认旧值班设备已经隔离或擦除");
    case "finish-installation-missing":
      return new Error("当前设备没有待完成的灾难恢复");
    case "finish-installation-ineligible":
      return new Error("灾难恢复尚未提交，不能确认旧设备隔离");
  }
}

export async function runDisasterRecoveryFinishCommand(
  input: { readonly userConfirmedOldDeviceIsolated: boolean },
  options: DisasterRecoveryCommandOptions = {},
): Promise<void> {
  try {
    await createDisasterRecoveryLifecycleApplication({}, options, new AbortController().signal)
      .finish(input);
    (options.writeLine ?? createStdoutWriter().line)("旧设备隔离已确认，恢复流程完成。");
  } catch (error) {
    if (error instanceof BackupRecoveryDisasterLifecycleError) {
      throw disasterLifecyclePublicError(error);
    }
    throw error;
  }
}

export function disasterRecoveryPublicError(_error: unknown): Error {
  return new Error("恢复未完成。请核对备份位置、恢复包和设备状态后重试；系统不会自动切换值班设备。");
}

interface RecoveryContext {
  readonly home: string;
  readonly backupTargets: BackupTargetConfigurationRepository;
  readonly secretStore: SecretStorePort & CredentialStoreCoordinator;
  readonly key: Awaited<ReturnType<typeof loadOrCreateDeviceKey>>;
  readonly identity: DeviceIdentity;
  readonly trust: NonNullable<Awaited<ReturnType<FileMeshBootstrapStore["loadTrustRecord"]>>>;
  readonly store: FileMeshBootstrapStore;
  readonly configuration?: MeshRoleBootConfig;
  readonly config: ReturnType<typeof loadConfig>;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly publishedDirectoryInventoryTargets: PublishedCheckpointDirectoryInventorySessions;
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
    backupTargets: createBackupTargetConfigurationInfrastructure(home),
    secretStore,
    key,
    identity: member.device,
    trust,
    store,
    ...(config.mesh ? { configuration: config.mesh } : {}),
    config,
    storageMaintenance,
    publishedDirectoryInventoryTargets: createPublishedCheckpointTargetInfrastructure({
      zhixingHome: home,
      storageMaintenance,
    }).directoryInventory,
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
    endpointDirectory: bootstrap.bootstrapProjection.endpoints,
    transportPeerDirectory: bootstrap.bootstrapProjection.transportPeers,
    trustProjection: Object.freeze({
      loadTrustRecord: () => bootstrap.bootstrapStore.loadTrustRecord(),
    }),
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
  selection: BackupRecoveryDisasterAdmissionTargetSelection,
  signal: AbortSignal,
): Promise<{
  readonly targets: readonly {
    readonly displayName: string;
    readonly target: InventoryPublishedRecoveryCheckpointTarget;
  }[];
  readonly close: () => Promise<void>;
}> {
  signal.throwIfAborted();
  if (selection.kind === "directory") {
    const targetSession = await context.publishedDirectoryInventoryTargets.openInventory(
      selection.directory,
    );
    if (signal.aborted) {
      await targetSession.close();
      signal.throwIfAborted();
    }
    return {
      targets: [{
        displayName: path.basename(path.resolve(selection.directory)),
        target: targetSession.target,
      }],
      close: targetSession.close,
    };
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
    endpointDirectory: bootstrap.bootstrapProjection.endpoints,
    transportPeerDirectory: bootstrap.bootstrapProjection.transportPeers,
    trustProjection: Object.freeze({
      loadTrustRecord: () => bootstrap.bootstrapStore.loadTrustRecord(),
    }),
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
    await waitForPeer(control, selection.deviceId, 30_000, signal);
    const target = new PairedRecoveryCheckpointTarget({
      homeId: context.trust.homeId,
      sourceDeviceId: context.key.deviceId,
      targetDeviceId: selection.deviceId,
      recipientKeyId: selection.recipientKeyId,
      transport: new MeshPairedCheckpointTransport(control.connections.client(selection.deviceId)),
      storageMaintenance: context.storageMaintenance,
    });
    return {
      targets: [{ displayName: selection.displayName, target }],
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
    const credentials = await loadCredentialSnapshot({ store: context.secretStore });
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
