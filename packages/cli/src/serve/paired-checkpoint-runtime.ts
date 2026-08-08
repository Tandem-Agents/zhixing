import path from "node:path";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  FileRecoveryCheckpointTarget,
  type RetirableRecoveryCheckpointTarget,
} from "@zhixing/mesh/checkpoint-target";

export function deferredPairedCheckpointTarget(input: {
  readonly zhixingHome: string;
  readonly deviceId: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}): RetirableRecoveryCheckpointTarget {
  const open = () => FileRecoveryCheckpointTarget.openPaired({
    targetRoot: path.join(input.zhixingHome, "distributed-runtime", "recovery-checkpoints"),
    targetDeviceId: input.deviceId,
    ...(input.storageMaintenance ? { storageMaintenance: input.storageMaintenance } : {}),
  });
  const use = async <T>(operation: (target: FileRecoveryCheckpointTarget) => Promise<T>): Promise<T> => {
    const target = await open();
    try {
      return await operation(target);
    } finally {
      await target.close();
    }
  };
  return {
    targetId: `backup-device:${input.deviceId}`,
    independenceDomain: `device:${input.deviceId}`,
    writeDurable: (checkpoint) => use((target) => target.writeDurable(checkpoint)),
    read: async (checkpointId, signal) => {
      const initial = await use((target) => target.read(checkpointId, signal));
      if (initial.chunks) return initial;
      return {
        envelope: initial.envelope,
        source: {
          read: (seq, offset, limit, rangeSignal) => use(async (target) => {
            const current = await target.read(checkpointId, rangeSignal ?? signal);
            if (!current.source) throw new TypeError("Paired checkpoint source is unavailable");
            return current.source.read(seq, offset, limit, rangeSignal ?? signal);
          }),
        },
      };
    },
    retire: async (checkpointId, supersededBy) =>
      use((target) => target.retire(checkpointId, supersededBy)),
  };
}
