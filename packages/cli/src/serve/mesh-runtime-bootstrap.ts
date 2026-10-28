import type { CurrentTrustProjection } from "@zhixing/mesh/trust-chain";
import type {
  DeviceIdentity,
  DeviceRole,
  MeshEndpointDescriptor,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  createMeshEndpointDescriptor,
  resolveEffectiveMeshRoles,
  validateMeshRoleBootConfig,
  type MeshEndpointDirectory,
} from "@zhixing/mesh/bootstrap";
import { canonicalize, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { DeviceCapacityArbiterPort, StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { loadActiveAnchorIssuerKey } from "@zhixing/mesh/device-key-store";
import { deleteDeviceKey } from "@zhixing/mesh/device-key-store";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import { loadExistingDeviceKey, loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { settleExecutorRemovalBeforeBootstrap } from "./device-removal.js";
import { createFileMeshPairingContinuationRepository } from "./mesh-pairing-continuation.js";
import { DeviceRestrictedError } from "./device-restriction.js";
import {
  createMeshBootstrapProjectionPorts,
  loadActiveMemberTransportPeers,
  type MeshBootstrapProjectionPorts,
} from "./mesh-bootstrap-projection.js";
import {
  completePlannedAnchorInstallationBeforeBootstrap,
  type InstalledAuthorityGeneration,
  type PlannedAnchorPostInstallDescriptor,
  type PlannedAnchorTransferStagingArea,
} from "./planned-anchor-transfer.js";
import {
  completeDisasterRecoveryInstallationBeforeBootstrap,
  type DisasterRecoveryPostInstallDescriptor,
} from "./disaster-recovery-target.js";
import type { DisasterRecoveryStagingArea } from "./disaster-recovery-staging.js";

export type MeshRuntimeBootstrap =
  | {
      readonly mode: "single-machine";
      readonly roles: readonly ["anchor", "executor"];
      readonly deviceKey: DeviceKey;
      readonly bootstrapStore: FileMeshBootstrapStore;
      readonly bootstrapProjection: MeshBootstrapProjectionPorts;
      readonly plannedAnchorTransferStaging: PlannedAnchorTransferStagingArea;
      readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;
      readonly trustedIdentities: readonly DeviceIdentity[];
      readonly authorizedDeviceIds: readonly string[];
    }
  | {
      readonly mode: "trusted-home";
      readonly roles: readonly DeviceRole[];
      readonly deviceKey: DeviceKey;
      readonly anchorIssuerKey?: DeviceKey;
      readonly bootstrapStore: FileMeshBootstrapStore;
      readonly bootstrapProjection: MeshBootstrapProjectionPorts;
      readonly plannedAnchorTransferStaging: PlannedAnchorTransferStagingArea;
      readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;
      readonly trust: CurrentTrustProjection;
      readonly configuration: MeshRoleBootConfig;
      readonly endpoints: MeshEndpointDirectory;
      readonly transportPeers: readonly TrustedMeshPeer[];
      readonly trustedIdentities: readonly DeviceIdentity[];
      readonly authorizedDeviceIds: readonly string[];
      readonly localEndpoint?: MeshEndpointDescriptor;
      readonly installedAuthorityGeneration?: InstalledAuthorityGeneration;
      readonly plannedAnchorPostInstall?:
        | PlannedAnchorPostInstallDescriptor
        | DisasterRecoveryPostInstallDescriptor;
    };

/**
 * 本机处于撤销阶段、仍需联网取回终态的移除：只开放专用取回，不进入普通身份与角色装配。
 * 只有宿主在显式允许时拿到它；其他命令遇到这种状态直接失败关闭。
 */
export interface ExecutorRemovalRetrievalBootstrap {
  readonly mode: "removal-retrieval";
  readonly operationId: string;
  readonly deviceKey: DeviceKey;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;
}

export interface PrepareMeshRuntimeBootstrapInput {
  readonly records?: import("@zhixing/core/logging").LogRecordPort;
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly deviceCapacity?: DeviceCapacityArbiterPort;
  /** Full Host composition prepares its domain dependencies before entering
   * any domain queue. Short management commands keep demand-only preparation. */
  readonly prepareRuntimeBeforeDomains?: boolean;
  readonly configuration?: MeshRoleBootConfig;
  readonly plannedAnchorTransferStaging: PlannedAnchorTransferStagingArea;
  readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;
  /** 宿主才允许拿到专用取回状态并负责运行它。 */
  readonly allowRemovalRetrieval?: boolean;
}

/** Resolves durable trust before loading any role-specific production listener. */
export function prepareMeshRuntimeBootstrap(
  input: PrepareMeshRuntimeBootstrapInput & { readonly allowRemovalRetrieval: true },
): Promise<MeshRuntimeBootstrap | ExecutorRemovalRetrievalBootstrap>;
export function prepareMeshRuntimeBootstrap(input: PrepareMeshRuntimeBootstrapInput): Promise<MeshRuntimeBootstrap>;
export async function prepareMeshRuntimeBootstrap(
  input: PrepareMeshRuntimeBootstrapInput,
): Promise<MeshRuntimeBootstrap | ExecutorRemovalRetrievalBootstrap> {
  const configuration = input.configuration === undefined
    ? undefined
    : validateMeshRoleBootConfig(input.configuration);
  // 统一入口：本进程该 home 的权威日志 owner，先登记自校验的当前信任投影，再登记全部固定定义。
  const bootstrapStore = await FileMeshBootstrapStore.open(input.zhixingHome, undefined, {
    secretStore: input.secretStore,
    storageMaintenance: input.storageMaintenance,
    records: input.records,
    deviceCapacity: input.deviceCapacity,
  });
  try {
    return await prepareWithBootstrapStore(input, configuration, bootstrapStore);
  } catch (error) {
    await bootstrapStore.stopStorageMaintenance().catch(() => undefined);
    throw error;
  }
}

/** 本机有已在值班设备提交、但本机还没完成接续的加入续接（重新配对已提交，本机接续未完成）。 */
export async function committedRejoinPending(zhixingHome: string): Promise<boolean> {
  const continuation = await createFileMeshPairingContinuationRepository(zhixingHome).load();
  return continuation?.side === "joiner" && continuation.phase === "bootstrap-ready";
}

async function prepareWithBootstrapStore(
  input: PrepareMeshRuntimeBootstrapInput,
  configuration: MeshRoleBootConfig | undefined,
  bootstrapStore: FileMeshBootstrapStore,
): Promise<MeshRuntimeBootstrap | ExecutorRemovalRetrievalBootstrap> {
  const sources = bootstrapStore.authoritySources()!;
  const bootstrapProjection = createMeshBootstrapProjectionPorts(bootstrapStore);
  // 普通启动只读取已验当前视图；历史身份在既有异步校验边界按 keyId 精确补齐。
  const preRuntimeTrust = await bootstrapStore.loadCurrentTrust();
  if (input.prepareRuntimeBeforeDomains) {
    await sources.prepareRuntime("runtime-prepare", configuration !== undefined && !configuration.enabledRoles.includes("anchor"));
  }
  const existingDeviceKey = await loadExistingDeviceKey(input.secretStore);
  // 撤销阶段的本机移除先于普通身份与角色装配处理：已有终态依据就本地终结，零网络；否则只开放专用取回。
  // 被显式重新配对取代的旧移除已在加入完成时终结，这里不读信任链
  const removal = await settleExecutorRemovalBeforeBootstrap({
    log: bootstrapStore.authorityLog(),
    verifier: sources.verifier,
    secretStore: input.secretStore,
  });
  // 重新配对已在值班设备提交、本机接续未完成：如实呈现，不按旧移除继续取回或显示 lost（重试 zz pair 续做）
  if (removal.kind === "retrieval" || removal.kind === "lost") {
    if (await committedRejoinPending(input.zhixingHome)) {
      throw new DeviceRestrictedError({ kind: "rejoin-pending" }, "This device's re-pairing is committed but not yet continued locally");
    }
  }
  if (removal.kind === "lost") {
    // 值班设备已按失联移出：零网络本地呈现，不删钥、不清理、不装配普通业务
    throw new DeviceRestrictedError({ kind: "removed-lost", cleanup: removal.cleanup },
      "The duty device removed this device as lost; local data was not cleaned by it");
  }
  if (removal.kind === "retrieval") {
    if (!input.allowRemovalRetrieval) {
      throw new Error("This device is finishing its removal; start the local service so it can reach the duty device");
    }
    if (!existingDeviceKey || existingDeviceKey.deviceId !== removal.targetDeviceId) {
      throw new Error("Device removal retrieval requires this device's existing identity");
    }
    return Object.freeze({
      mode: "removal-retrieval" as const,
      operationId: removal.operationId,
      deviceKey: existingDeviceKey,
      bootstrapStore,
      verifier: sources.verifier,
      disasterRecoveryStaging: input.disasterRecoveryStaging,
    });
  }
  const [authorityLifecycle, executorLifecycle] = await Promise.all([
    new DeviceLifecycleJournal(sources.authority).startupState(existingDeviceKey?.deviceId),
    new DeviceLifecycleJournal(sources.executor).startupState(existingDeviceKey?.deviceId),
  ]);
  const terminalRetirement = executorLifecycle.retirement ?? authorityLifecycle.retirement;
  if (terminalRetirement) {
    if (
      terminalRetirement.identity.kind !== "executor-removal" &&
      terminalRetirement.identity.kind !== "anchor-uninstall"
    ) {
      throw new Error("Terminal device retirement has the wrong lifecycle kind");
    }
    const retiredDeviceId = terminalRetirement.identity.kind === "executor-removal"
      ? terminalRetirement.identity.targetDeviceId
      : terminalRetirement.identity.currentDeviceId;
    await deleteDeviceKey(input.secretStore, retiredDeviceId);
    throw terminalRetirement.identity.kind === "executor-removal"
      ? new DeviceRestrictedError({ kind: "removed" }, "This device was removed; pair it again to create a new identity")
      : new DeviceRestrictedError({ kind: "uninstalled" }, "This duty-device home was permanently uninstalled; use the recovery flow to restore it");
  }
  const hasActiveLifecycle = authorityLifecycle.active || executorLifecycle.active;
  if (hasActiveLifecycle && !existingDeviceKey) {
    throw new Error("Device lifecycle recovery requires the existing local identity");
  }
  const deviceKey = existingDeviceKey ?? await loadOrCreateDeviceKey(input.secretStore);
  bootstrapStore.bindIssuerKey(deviceKey);
  const trust = preRuntimeTrust;
  const disasterRecoveryPostInstall = trust
      ? await completeDisasterRecoveryInstallationBeforeBootstrap({
        deviceId: deviceKey.deviceId,
        secretStore: input.secretStore,
        bootstrapStore,
        staging: input.disasterRecoveryStaging,
      })
    : undefined;
  const plannedAnchorPostInstall = trust && !disasterRecoveryPostInstall
    ? await completePlannedAnchorInstallationBeforeBootstrap({
        deviceId: deviceKey.deviceId,
        secretStore: input.secretStore,
        bootstrapStore,
        verifier: sources.verifier,
        staging: input.plannedAnchorTransferStaging,
      })
    : undefined;
  const anchorPostInstall = disasterRecoveryPostInstall ?? plannedAnchorPostInstall;
  const effective = resolveEffectiveMeshRoles({
    localDeviceId: deviceKey.deviceId,
    ...(configuration ? { configuration } : {}),
    ...(trust ? { trust } : {}),
  });
  if (effective.mode === "single-machine") {
    return {
      mode: "single-machine",
      roles: ["anchor", "executor"],
      deviceKey,
      bootstrapStore,
      bootstrapProjection,
      plannedAnchorTransferStaging: input.plannedAnchorTransferStaging,
      disasterRecoveryStaging: input.disasterRecoveryStaging,
      trustedIdentities: [],
      authorizedDeviceIds: [],
    };
  }
  if (!trust || !configuration) {
    throw new Error("Trusted-home mesh bootstrap is incomplete");
  }
  let anchorIssuerKey: DeviceKey | undefined;
  if (trust.issuer.deviceId === deviceKey.deviceId) {
    const issuerPublicKey = trust.issuer.issuerPublicKey ?? trust.members.find((member) =>
      member.device.deviceId === trust.issuer.deviceId)?.device.publicKey;
    anchorIssuerKey = trust.issuer.issuerKeyId === deviceKey.deviceId
      ? deviceKey
      : await loadActiveAnchorIssuerKey(input.secretStore, trust.issuer.issuerKeyId) ?? undefined;
    if (!anchorIssuerKey || anchorIssuerKey.publicKey !== issuerPublicKey) {
      throw new Error("Current duty device is missing its active issuer key");
    }
    bootstrapStore.bindIssuerKey(anchorIssuerKey);
    // 开发资料的一次性接续：链头只由 v1 历史帧闭合时补签 v2，其他设备对齐时即可取回当前快照
    await bootstrapStore.continueCurrentTrustRecord(anchorIssuerKey);
  }
  if (!!trust.recoveryRootPublicKey !== !!trust.recoveryBackupPublicKey) {
    throw new Error("Trusted-home recovery root identity is inconsistent");
  }
  let endpoints = await bootstrapProjection.endpoints.loadEndpoints();
  let localEndpoint: MeshEndpointDescriptor | undefined;
  if (effective.roles.includes("anchor")) {
    const current = endpoints.get(deviceKey.deviceId);
    const candidate = createMeshEndpointDescriptor({
      deviceId: deviceKey.deviceId,
      configuration,
      revision: (current?.revision ?? 0) + 1,
    });
    if (
      current &&
      canonicalize(current.transports) === canonicalize(candidate.transports)
    ) {
      localEndpoint = current;
    } else {
      localEndpoint = candidate;
      await bootstrapProjection.endpoints.acceptEndpoint(localEndpoint);
      endpoints = await bootstrapProjection.endpoints.loadEndpoints();
    }
  }
  return {
    mode: "trusted-home",
    roles: effective.roles,
    deviceKey,
    ...(anchorIssuerKey ? { anchorIssuerKey } : {}),
    bootstrapStore,
    bootstrapProjection,
    plannedAnchorTransferStaging: input.plannedAnchorTransferStaging,
    disasterRecoveryStaging: input.disasterRecoveryStaging,
    trust,
    configuration,
    endpoints,
    // 只为当前 active 成员精确读传输身份；已不是成员的设备经终态入口按请求解析。
    transportPeers: await loadActiveMemberTransportPeers(
      bootstrapProjection.transportPeers,
      trust.members,
      deviceKey.deviceId,
    ),
    // Only live members are materialized here. Revoked signers remain available
    // through the source-bound exact identity resolver, without active authority.
    trustedIdentities: trust.members.map((member) => member.device),
    authorizedDeviceIds: trust.members
      .filter((member) => member.state === "active")
      .map((member) => member.device.deviceId),
    ...(localEndpoint ? { localEndpoint } : {}),
    ...(anchorPostInstall
      ? { installedAuthorityGeneration: anchorPostInstall.installedGeneration }
      : {}),
    ...(anchorPostInstall && anchorPostInstall.requiresPostInstallCompletion
      ? { plannedAnchorPostInstall: anchorPostInstall }
      : {}),
  };
}
