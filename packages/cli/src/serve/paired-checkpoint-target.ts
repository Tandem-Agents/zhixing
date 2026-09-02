import type { HomeTrustEvent, HomeTrustRecord } from "@zhixing/core/contracts";
import type {
  InventoryPublishedRecoveryCheckpointTarget,
  PublishedRecoveryCheckpointTargetSession,
  RetirablePublishedRecoveryCheckpointTarget,
} from "./published-checkpoint-target.js";

export interface PairedCheckpointTargetBinding {
  readonly homeId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly recipientKeyId: string;
}

export interface PairedRecoveryRootActivation {
  readonly activateRoot: (
    input: {
      readonly checkpointId: string;
      readonly event: HomeTrustEvent;
      readonly record: HomeTrustRecord;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface OwnedPairedCheckpointTargetSession
  extends PublishedRecoveryCheckpointTargetSession<RetirablePublishedRecoveryCheckpointTarget> {
  readonly rootActivation: PairedRecoveryRootActivation;
}

export type OwnedPairedCheckpointInventorySession =
  PublishedRecoveryCheckpointTargetSession<InventoryPublishedRecoveryCheckpointTarget>;

export type BorrowedPairedCheckpointTargetResult =
  | {
      readonly kind: "available";
      readonly session: PublishedRecoveryCheckpointTargetSession<RetirablePublishedRecoveryCheckpointTarget>;
    }
  | { readonly kind: "runtime-unavailable" };

export interface BorrowedPairedCheckpointTargetSessions {
  readonly open: (
    binding: PairedCheckpointTargetBinding,
  ) => Promise<BorrowedPairedCheckpointTargetResult>;
}

export function projectPairedRecoveryRootActivation(
  target: PairedRecoveryRootActivation,
): PairedRecoveryRootActivation {
  if (typeof target.activateRoot !== "function") {
    throw new TypeError("Paired recovery checkpoint target requires root activation");
  }
  return Object.freeze({
    activateRoot: (
      input: Parameters<PairedRecoveryRootActivation["activateRoot"]>[0],
      signal?: AbortSignal,
    ) => target.activateRoot(input, signal),
  });
}
