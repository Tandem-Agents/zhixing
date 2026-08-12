import type {
  DeviceIdentity,
  DeviceRole,
  HomeTrustRecord,
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
import { canonicalize } from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { loadActiveAnchorIssuerKey } from "@zhixing/mesh/device-key-store";
import { deleteDeviceKey } from "@zhixing/mesh/device-key-store";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import { FileAuthorityCommitLog, DeviceLifecycleJournal } from "@zhixing/core/authority";
import path from "node:path";
import { loadExistingDeviceKey, loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  completePlannedAnchorInstallationBeforeBootstrap,
  type InstalledAuthorityGeneration,
  type PlannedAnchorPostInstallDescriptor,
} from "./planned-anchor-transfer.js";
import { createTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
import {
  completeDisasterRecoveryInstallationBeforeBootstrap,
  type DisasterRecoveryPostInstallDescriptor,
} from "./disaster-recovery-target.js";

export type MeshRuntimeBootstrap =
  | {
      readonly mode: "single-machine";
      readonly roles: readonly ["anchor", "executor"];
      readonly deviceKey: DeviceKey;
      readonly bootstrapStore: FileMeshBootstrapStore;
      readonly trustedIdentities: readonly DeviceIdentity[];
      readonly authorizedDeviceIds: readonly string[];
    }
  | {
      readonly mode: "trusted-home";
      readonly roles: readonly DeviceRole[];
      readonly deviceKey: DeviceKey;
      readonly anchorIssuerKey?: DeviceKey;
      readonly bootstrapStore: FileMeshBootstrapStore;
      readonly trust: HomeTrustRecord;
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

/** Resolves durable trust before loading any role-specific production listener. */
export async function prepareMeshRuntimeBootstrap(input: {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly configuration?: MeshRoleBootConfig;
}): Promise<MeshRuntimeBootstrap> {
  const configuration = input.configuration === undefined
    ? undefined
    : validateMeshRoleBootConfig(input.configuration);
  const bootstrapStore = new FileMeshBootstrapStore(
    input.zhixingHome,
    undefined,
    { storageMaintenance: input.storageMaintenance },
  );
  const trustEvents = await bootstrapStore.loadTrustEvents();
  const preRuntimeTrust = await bootstrapStore.loadTrustRecord();
  const trustedIdentities = new Map(
    trustEvents.flatMap((event) => event.body.t === "genesis"
      ? [event.body.issuer]
      : event.body.t === "enroll"
        ? [event.body.device]
        : [])
      .map((identity) => [identity.deviceId, identity] as const),
  );
  if (preRuntimeTrust?.issuer.issuerPublicKey) {
    const issuerMember = preRuntimeTrust.members.find((member) =>
      member.device.deviceId === preRuntimeTrust.issuer.deviceId);
    if (!issuerMember) throw new Error("Current issuer is missing from the trust projection");
    trustedIdentities.set(preRuntimeTrust.issuer.issuerKeyId, Object.freeze({
      ...issuerMember.device,
      deviceId: preRuntimeTrust.issuer.issuerKeyId,
      publicKey: preRuntimeTrust.issuer.issuerPublicKey,
    }));
  }
  const verifier = trustEvents.length === 0
    ? undefined
    : createTrustedDeviceProtocolVerifier([...trustedIdentities.values()]);
  const executorLog = new FileAuthorityCommitLog(
    path.join(path.resolve(input.zhixingHome), "distributed-runtime", "executor-authority"),
    bootstrapStore.artifactStore(),
    { storageMaintenance: input.storageMaintenance },
  );
  const [authorityOperations, executorOperations, existingDeviceKey] = await Promise.all([
    new DeviceLifecycleJournal(bootstrapStore.authorityLog(), verifier).operations(),
    new DeviceLifecycleJournal(executorLog, verifier).operations(),
    loadExistingDeviceKey(input.secretStore),
  ]);
  const relevant = [...authorityOperations, ...executorOperations].filter((operation) => {
    if (operation.identity.kind === "executor-removal") {
      return existingDeviceKey
        ? operation.identity.targetDeviceId === existingDeviceKey.deviceId
        : true;
    }
    if (operation.identity.kind === "anchor-uninstall") {
      return existingDeviceKey
        ? operation.identity.currentDeviceId === existingDeviceKey.deviceId
        : true;
    }
    return operation.identity.kind === "stop" && existingDeviceKey !== undefined;
  });
  const terminalRetirement = [...relevant].reverse().find((operation) =>
    operation.phase === "terminal" &&
    (operation.identity.kind === "executor-removal" ||
      operation.identity.kind === "anchor-uninstall"));
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
    throw new Error(terminalRetirement.identity.kind === "executor-removal"
      ? "This device was removed; pair it again to create a new identity"
      : "This duty-device home was permanently uninstalled; use the recovery flow to restore it");
  }
  const hasActiveLifecycle = relevant.some((operation) =>
    operation.phase !== "terminal" && operation.phase !== "aborted");
  if (hasActiveLifecycle && !existingDeviceKey) {
    throw new Error("Device lifecycle recovery requires the existing local identity");
  }
  const deviceKey = existingDeviceKey ?? await loadOrCreateDeviceKey(input.secretStore);
  bootstrapStore.bindIssuerKey(deviceKey);
  const trust = preRuntimeTrust;
  const disasterRecoveryPostInstall = trust
    ? await completeDisasterRecoveryInstallationBeforeBootstrap({
        zhixingHome: input.zhixingHome,
        deviceId: deviceKey.deviceId,
        secretStore: input.secretStore,
        bootstrapStore,
        ...(input.storageMaintenance
          ? { storageMaintenance: input.storageMaintenance }
          : {}),
      })
    : undefined;
  const plannedAnchorPostInstall = trust && !disasterRecoveryPostInstall
    ? await completePlannedAnchorInstallationBeforeBootstrap({
        zhixingHome: input.zhixingHome,
        deviceId: deviceKey.deviceId,
        secretStore: input.secretStore,
        bootstrapStore,
        verifier: createTrustedDeviceProtocolVerifier(
          trust.members.map((member) => member.device),
        ),
        ...(input.storageMaintenance
          ? { storageMaintenance: input.storageMaintenance }
          : {}),
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
  }
  if (!!trust.recoveryRootPublicKey !== !!trust.recoveryBackupPublicKey) {
    throw new Error("Trusted-home recovery root identity is inconsistent");
  }
  let endpoints = await bootstrapStore.loadEndpoints();
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
      await bootstrapStore.acceptEndpoint(localEndpoint);
      endpoints = await bootstrapStore.loadEndpoints();
    }
  }
  return {
    mode: "trusted-home",
    roles: effective.roles,
    deviceKey,
    ...(anchorIssuerKey ? { anchorIssuerKey } : {}),
    bootstrapStore,
    trust,
    configuration,
    endpoints,
    transportPeers: await bootstrapStore.loadTransportPeers(),
    // Historical signatures remain verifiable after revocation; live authorization
    // is carried separately so a revoked peer can never regain an active capability.
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
