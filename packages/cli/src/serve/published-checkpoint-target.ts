import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";

export interface PublishedRecoveryCheckpointTarget {
  readonly targetId: string;
  readonly independenceDomain: string;
  readonly writeDurable: (
    checkpoint: CheckpointPackage,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly read: (
    checkpointId: string,
    signal?: AbortSignal,
  ) => Promise<CheckpointPackage>;
}

export interface RetirablePublishedRecoveryCheckpointTarget
  extends PublishedRecoveryCheckpointTarget {
  readonly retire: (
    checkpointId: string,
    supersededBy: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface PublishedRecoveryCheckpointInventoryEntry {
  readonly checkpointId: string;
  readonly targetId: string;
  readonly recipientKeyId: string;
  readonly envelope: CheckpointPackage["envelope"];
}

export interface InventoryPublishedRecoveryCheckpointTarget
  extends RetirablePublishedRecoveryCheckpointTarget {
  readonly inventory: (
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<readonly PublishedRecoveryCheckpointInventoryEntry[]>;
}

export interface PublishedRecoveryCheckpointTargetSession<
  Target extends PublishedRecoveryCheckpointTarget,
> {
  readonly target: Target;
  readonly close: () => Promise<void>;
}

export interface ExistingPublishedCheckpointDirectorySessions {
  readonly openExisting: (
    directory: string,
  ) => Promise<PublishedRecoveryCheckpointTargetSession<RetirablePublishedRecoveryCheckpointTarget>>;
}

export interface PublishedCheckpointDirectorySessions
  extends ExistingPublishedCheckpointDirectorySessions {
  readonly create: (
    directory: string,
  ) => Promise<PublishedRecoveryCheckpointTargetSession<RetirablePublishedRecoveryCheckpointTarget>>;
}

export interface PublishedCheckpointDirectoryInventorySessions {
  readonly openInventory: (
    directory: string,
  ) => Promise<PublishedRecoveryCheckpointTargetSession<InventoryPublishedRecoveryCheckpointTarget>>;
}

export interface PublishedCheckpointPairedSessions {
  readonly openPaired: (
    deviceId: string,
  ) => Promise<PublishedRecoveryCheckpointTargetSession<InventoryPublishedRecoveryCheckpointTarget>>;
}

export interface DeferredPublishedCheckpointPairedTargets {
  readonly deferredPaired: (
    deviceId: string,
  ) => InventoryPublishedRecoveryCheckpointTarget;
}

export interface PublishedCheckpointTargetInfrastructure {
  readonly directory: PublishedCheckpointDirectorySessions;
  readonly directoryInventory: PublishedCheckpointDirectoryInventorySessions;
  readonly paired: PublishedCheckpointPairedSessions;
  readonly deferredPaired: DeferredPublishedCheckpointPairedTargets;
}

export function projectPublishedRecoveryCheckpointTarget(
  target: PublishedRecoveryCheckpointTarget,
): PublishedRecoveryCheckpointTarget {
  assertTarget(target);
  return Object.freeze({
    targetId: target.targetId,
    independenceDomain: target.independenceDomain,
    writeDurable: (
      checkpoint: CheckpointPackage,
      signal?: AbortSignal,
    ) => target.writeDurable(checkpoint, signal),
    read: (checkpointId: string, signal?: AbortSignal) =>
      target.read(checkpointId, signal),
  });
}

export function projectRetirablePublishedRecoveryCheckpointTarget(
  target: RetirablePublishedRecoveryCheckpointTarget,
): RetirablePublishedRecoveryCheckpointTarget {
  if (typeof target.retire !== "function") {
    throw new TypeError("Published recovery checkpoint target requires retire");
  }
  const published = projectPublishedRecoveryCheckpointTarget(target);
  return Object.freeze({
    ...published,
    retire: (
      checkpointId: string,
      supersededBy: string,
      signal?: AbortSignal,
    ) => target.retire(checkpointId, supersededBy, signal),
  });
}

export function projectInventoryPublishedRecoveryCheckpointTarget(
  target: InventoryPublishedRecoveryCheckpointTarget,
): InventoryPublishedRecoveryCheckpointTarget {
  if (typeof target.inventory !== "function") {
    throw new TypeError("Published recovery checkpoint target requires inventory");
  }
  const retirable = projectRetirablePublishedRecoveryCheckpointTarget(target);
  return Object.freeze({
    ...retirable,
    inventory: async (requestId: string, signal?: AbortSignal) =>
      Object.freeze(
        (await target.inventory(requestId, signal)).map((entry) =>
          Object.freeze({
            checkpointId: entry.checkpointId,
            targetId: entry.targetId,
            recipientKeyId: entry.recipientKeyId,
            envelope: entry.envelope,
          })),
      ),
  });
}

function assertTarget(target: PublishedRecoveryCheckpointTarget): void {
  if (
    typeof target.targetId !== "string" ||
    typeof target.independenceDomain !== "string" ||
    typeof target.writeDurable !== "function" ||
    typeof target.read !== "function"
  ) {
    throw new TypeError("Published recovery checkpoint target is incomplete");
  }
}
