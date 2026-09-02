import type {
  ArtifactReceiveProgress,
} from "@zhixing/core/authority";
import type { ArtifactRef } from "@zhixing/core/contracts";

/** Finite durable-prefix receiver required by assignment Mesh transport. */
export interface AssignmentArtifactReceiverPort {
  readonly progress: (ref: ArtifactRef) => Promise<ArtifactReceiveProgress>;
  readonly append: (
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
  ) => Promise<ArtifactReceiveProgress>;
}

/** Hides every physical receiver capability outside the assignment transfer demand. */
export function projectAssignmentArtifactReceiver(
  receiver: AssignmentArtifactReceiverPort,
): AssignmentArtifactReceiverPort {
  if (typeof receiver.progress !== "function" || typeof receiver.append !== "function") {
    throw new TypeError("Assignment artifact receiver requires progress and append");
  }
  return Object.freeze({
    progress: (ref: ArtifactRef) => receiver.progress(ref),
    append: (ref: ArtifactRef, offset: number, bytes: Uint8Array) =>
      receiver.append(ref, offset, bytes),
  });
}
