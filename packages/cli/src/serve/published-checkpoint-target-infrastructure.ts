import path from "node:path";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import {
  type InventoryPublishedRecoveryCheckpointTarget,
  type PublishedCheckpointTargetInfrastructure,
  type PublishedRecoveryCheckpointTarget,
  type PublishedRecoveryCheckpointTargetSession,
  projectInventoryPublishedRecoveryCheckpointTarget,
  projectRetirablePublishedRecoveryCheckpointTarget,
  type RetirablePublishedRecoveryCheckpointTarget,
} from "./published-checkpoint-target.js";

const AUTHORITY_ROOT_SEGMENTS = Object.freeze([
  "distributed-runtime",
  "authority",
] as const);
const PAIRED_TARGET_ROOT_SEGMENTS = Object.freeze([
  "distributed-runtime",
  "recovery-checkpoints",
] as const);

/** The sole physical composition of published filesystem checkpoint targets. */
export function createPublishedCheckpointTargetInfrastructure(input: {
  readonly zhixingHome: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}): PublishedCheckpointTargetInfrastructure {
  const home = path.resolve(input.zhixingHome);
  const sourceRoot = path.join(home, ...AUTHORITY_ROOT_SEGMENTS);
  const pairedTargetRoot = path.join(home, ...PAIRED_TARGET_ROOT_SEGMENTS);
  const openDirectory = async (
    directory: string,
    create: boolean,
  ): Promise<FileRecoveryCheckpointTarget> => FileRecoveryCheckpointTarget.open({
    targetRoot: directory,
    sourceRoot,
    create,
    ...(input.storageMaintenance
      ? { storageMaintenance: input.storageMaintenance }
      : {}),
  });
  const openPaired = (deviceId: string): Promise<FileRecoveryCheckpointTarget> =>
    FileRecoveryCheckpointTarget.openPaired({
      targetRoot: pairedTargetRoot,
      targetDeviceId: deviceId,
      ...(input.storageMaintenance
        ? { storageMaintenance: input.storageMaintenance }
        : {}),
    });

  return Object.freeze({
    directory: Object.freeze({
      create: async (directory: string) =>
        retirableSession(await openDirectory(directory, true)),
      openExisting: async (directory: string) =>
        retirableSession(await openDirectory(directory, false)),
    }),
    directoryInventory: Object.freeze({
      openInventory: async (directory: string) =>
        inventorySession(await openDirectory(directory, false)),
    }),
    paired: Object.freeze({
      openPaired: async (deviceId: string) =>
        inventorySession(await openPaired(deviceId)),
    }),
    deferredPaired: Object.freeze({
      deferredPaired: (deviceId: string) =>
        deferredPairedTarget(deviceId, () => openPaired(deviceId)),
    }),
  });
}

function retirableSession(
  target: FileRecoveryCheckpointTarget,
): PublishedRecoveryCheckpointTargetSession<RetirablePublishedRecoveryCheckpointTarget> {
  return projectSession(
    target,
    projectRetirablePublishedRecoveryCheckpointTarget(target),
  );
}

function inventorySession(
  target: FileRecoveryCheckpointTarget,
): PublishedRecoveryCheckpointTargetSession<InventoryPublishedRecoveryCheckpointTarget> {
  return projectSession(
    target,
    projectInventoryPublishedRecoveryCheckpointTarget(target),
  );
}

function projectSession<Target extends PublishedRecoveryCheckpointTarget>(
  physical: FileRecoveryCheckpointTarget,
  target: Target,
): PublishedRecoveryCheckpointTargetSession<Target> {
  let closing: Promise<void> | undefined;
  return Object.freeze({
    target,
    close: () => {
      closing ??= physical.close();
      return closing;
    },
  });
}

function deferredPairedTarget(
  deviceId: string,
  open: () => Promise<FileRecoveryCheckpointTarget>,
): InventoryPublishedRecoveryCheckpointTarget {
  const use = async <Result>(
    operation: (target: FileRecoveryCheckpointTarget) => Promise<Result>,
  ): Promise<Result> => {
    const target = await open();
    try {
      return await operation(target);
    } finally {
      await target.close();
    }
  };
  return Object.freeze({
    targetId: `backup-device:${deviceId}`,
    independenceDomain: `device:${deviceId}`,
    writeDurable: (checkpoint: CheckpointPackage, signal?: AbortSignal) =>
      use((physical) => physical.writeDurable(checkpoint, signal)),
    read: async (checkpointId: string, signal?: AbortSignal) => {
      const initial = await use((physical) => physical.read(checkpointId, signal));
      if (initial.chunks) return initial;
      return {
        envelope: initial.envelope,
        source: {
          read: (seq, offset, limit, rangeSignal) =>
            use(async (physical) => {
              const current = await physical.read(checkpointId, rangeSignal ?? signal);
              if (!current.source) {
                throw new TypeError("Paired checkpoint source is unavailable");
              }
              return current.source.read(
                seq,
                offset,
                limit,
                rangeSignal ?? signal,
              );
            }),
        },
      } satisfies CheckpointPackage;
    },
    inventory: (requestId: string, signal?: AbortSignal) =>
      use((physical) => physical.inventory(requestId, signal)),
    retire: (
      checkpointId: string,
      supersededBy: string,
      signal?: AbortSignal,
    ) =>
      use((physical) => physical.retire(checkpointId, supersededBy, signal)),
  });
}
