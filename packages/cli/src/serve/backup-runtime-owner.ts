import path from "node:path";
import { keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { AuthorityCheckpointService } from "@zhixing/mesh/checkpoint-service";
import { AuthorityCheckpointOwner } from "@zhixing/mesh/checkpoint-owner";
import { FileRecoveryCheckpointTarget, type RetirableRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import type { CheckpointSigner } from "@zhixing/mesh/checkpoint";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { FileBackupTargetConfiguration, type BackupTargetBinding } from "./backup-target-config.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import type { MeshRuntimeAssembly } from "./mesh-runtime-assembly.js";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";

export async function createConfiguredCheckpointOwner(input: {
  readonly zhixingHome: string;
  readonly mesh: MeshRuntimeBootstrap;
  readonly meshRuntime?: MeshRuntimeAssembly;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly onError?: (error: unknown) => void;
}): Promise<AuthorityCheckpointOwner | undefined> {
  const trust = await input.mesh.bootstrapStore.loadTrustRecord();
  if (
    !trust ||
    trust.issuer.deviceId !== input.mesh.deviceKey.deviceId ||
    !trust.recoveryBackupPublicKey
  ) return undefined;
  const config = await new FileBackupTargetConfiguration(input.zhixingHome).load();
  if (!config) return undefined;
  const binding = config.bindings.find((candidate) => candidate.targetId === config.currentTargetId);
  if (!binding) throw new Error("恢复备份目标配置缺少当前绑定");
  const member = trust.members.find((candidate) =>
    candidate.state === "active" && candidate.device.deviceId === input.mesh.deviceKey.deviceId);
  if (!member) throw new Error("当前主设备不在有效信任成员中");
  const target = binding.kind === "directory"
    ? deferredDirectoryTarget(binding, input.zhixingHome, input.storageMaintenance)
    : pairedTarget(
        binding,
        trust.homeId,
        input.mesh.deviceKey.deviceId,
        keyIdForPublicKey(trust.recoveryBackupPublicKey),
        input.meshRuntime,
      );
  const service = new AuthorityCheckpointService({
    log: input.mesh.bootstrapStore.authorityLog(),
    artifacts: input.mesh.bootstrapStore.artifactStore(),
    target,
    trust,
    issuer: Object.assign({}, member.device, {
      sign: input.mesh.deviceKey.sign.bind(input.mesh.deviceKey),
    }) as typeof member.device & CheckpointSigner,
    recipient: {
      backupPublicKey: trust.recoveryBackupPublicKey,
      backupKeyId: keyIdForPublicKey(trust.recoveryBackupPublicKey),
    },
    currentAnchor: true,
    storageMaintenance: input.storageMaintenance,
  });
  return new AuthorityCheckpointOwner({
    service,
    identitySeed: `${trust.homeId}:${trust.issuer.deviceId}:${binding.targetId}`,
    ...(input.onError ? { onError: input.onError } : {}),
  });
}

function pairedTarget(
  binding: Extract<BackupTargetBinding, { kind: "paired-device" }>,
  homeId: string,
  sourceDeviceId: string,
  recipientKeyId: string,
  runtime: MeshRuntimeAssembly | undefined,
): RetirableRecoveryCheckpointTarget {
  if (!runtime) throw new Error("配对设备恢复备份需要已启动的认证 mesh");
  return new PairedRecoveryCheckpointTarget({
    homeId,
    sourceDeviceId,
    targetDeviceId: binding.deviceId,
    recipientKeyId,
    transport: new MeshPairedCheckpointTransport(runtime.connections.client(binding.deviceId)),
  });
}

function deferredDirectoryTarget(
  binding: Extract<BackupTargetBinding, { kind: "directory" }>,
  zhixingHome: string,
  storageMaintenance: StorageMaintenanceGovernorPort,
): RetirableRecoveryCheckpointTarget {
  const open = async () => {
    const target = await FileRecoveryCheckpointTarget.open({
      targetRoot: binding.directory,
      sourceRoot: path.join(zhixingHome, "distributed-runtime", "authority"),
      storageMaintenance,
    });
    if (target.targetId !== binding.targetId) {
      throw new Error("恢复备份目标的物理身份已经变化");
    }
    return target;
  };
  return {
    targetId: binding.targetId,
    independenceDomain: binding.targetId,
    writeDurable: async (checkpoint) => (await open()).writeDurable(checkpoint),
    read: async (checkpointId) => (await open()).read(checkpointId),
    retire: async (checkpointId, supersededBy) =>
      (await open()).retire(checkpointId, supersededBy),
  };
}
