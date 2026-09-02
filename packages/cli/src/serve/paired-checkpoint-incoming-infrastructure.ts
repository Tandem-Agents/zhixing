import path from "node:path";
import type { HomeTrustRecord } from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { InventoryRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  projectPairedCheckpointCommandReceiver,
  type PairedCheckpointCommandReceiver,
  type PairedCheckpointReceiverConfiguration,
} from "@zhixing/mesh/paired-checkpoint-target";
import { keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { deferredPairedCheckpointTarget } from "./paired-checkpoint-runtime.js";
import {
  commitRecoveryRootActivation,
  commitRecoveryRootLifecycleActivation,
} from "./recovery-root-activation.js";

const RECOVERY_CHECKPOINT_INCOMING_SEGMENTS = Object.freeze([
  "distributed-runtime",
  "recovery-checkpoint-incoming",
] as const);

export function createPairedCheckpointCommandReceiverInfrastructure(input: {
  readonly zhixingHome: string;
  readonly target: InventoryRecoveryCheckpointTarget;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly receiver: PairedCheckpointReceiverConfiguration;
}): PairedCheckpointCommandReceiver {
  const staging = new FilePairedCheckpointStaging({
    root: path.join(input.zhixingHome, ...RECOVERY_CHECKPOINT_INCOMING_SEGMENTS),
    target: input.target,
    ...(input.storageMaintenance
      ? { storageMaintenance: input.storageMaintenance }
      : {}),
  });
  return projectPairedCheckpointCommandReceiver(new PairedCheckpointReceiver({
    ...input.receiver,
    staging,
  }));
}

export function createPersistentPairedCheckpointCommandReceiverInfrastructure(input: {
  readonly zhixingHome: string;
  readonly trust: HomeTrustRecord;
  readonly deviceId: string;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}): PairedCheckpointCommandReceiver | null {
  const recoveryBackupPublicKey = input.trust.recoveryBackupPublicKey;
  const isActiveTarget = input.trust.members.some((member) =>
    member.device.deviceId === input.deviceId && member.state === "active");
  if (
    !recoveryBackupPublicKey ||
    input.trust.issuer.deviceId === input.deviceId ||
    !isActiveTarget
  ) return null;

  return createPairedCheckpointCommandReceiverInfrastructure({
    zhixingHome: input.zhixingHome,
    target: deferredPairedCheckpointTarget({
      zhixingHome: input.zhixingHome,
      deviceId: input.deviceId,
      ...(input.storageMaintenance
        ? { storageMaintenance: input.storageMaintenance }
        : {}),
    }),
    ...(input.storageMaintenance
      ? { storageMaintenance: input.storageMaintenance }
      : {}),
    receiver: {
      homeId: input.trust.homeId,
      sourceDeviceId: input.trust.issuer.deviceId,
      targetDeviceId: input.deviceId,
      recipientKeyId: keyIdForPublicKey(recoveryBackupPublicKey),
      rootLifecycle: true,
      commitRootActivation: ({ plan, record }) =>
        commitRecoveryRootLifecycleActivation(input.bootstrapStore, plan, record),
    },
  });
}

export function createRecoveryRootPairedCheckpointCommandReceiverInfrastructure(input: {
  readonly zhixingHome: string;
  readonly trust: HomeTrustRecord;
  readonly deviceId: string;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): PairedCheckpointCommandReceiver | null {
  const local = input.trust.members.find((member) =>
    member.device.deviceId === input.deviceId && member.state === "active");
  if (!local) {
    throw new Error("Root-establishment receiver requires an active local member");
  }
  if (local.device.deviceId === input.trust.issuer.deviceId) return null;

  return createPairedCheckpointCommandReceiverInfrastructure({
    zhixingHome: input.zhixingHome,
    target: deferredPairedCheckpointTarget({
      zhixingHome: input.zhixingHome,
      deviceId: local.device.deviceId,
      storageMaintenance: input.storageMaintenance,
    }),
    storageMaintenance: input.storageMaintenance,
    receiver: {
      homeId: input.trust.homeId,
      sourceDeviceId: input.trust.issuer.deviceId,
      targetDeviceId: local.device.deviceId,
      rootEstablishment: true,
      commitRootActivation: ({ event, record }) =>
        commitRecoveryRootActivation(input.bootstrapStore, event, record),
    },
  });
}
