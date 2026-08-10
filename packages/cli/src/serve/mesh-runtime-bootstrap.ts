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
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
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
  const deviceKey = await loadOrCreateDeviceKey(input.secretStore);
  const bootstrapStore = new FileMeshBootstrapStore(
    input.zhixingHome,
    deviceKey,
    { storageMaintenance: input.storageMaintenance },
  );
  const trust = await bootstrapStore.loadTrustRecord();
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
    ...(anchorPostInstall && (
      anchorPostInstall.installation.t === "disaster-anchor-installed" ||
      ("requiresPostInstallCompletion" in anchorPostInstall &&
        anchorPostInstall.requiresPostInstallCompletion)
    )
      ? { plannedAnchorPostInstall: anchorPostInstall }
      : {}),
  };
}
