import { protocolDigest } from "../protocol/canonical.js";

/** Stable identity shared by owner recovery, the durable journal, and replay guards. */
export function advancementEvidenceRequestId(
  reviewId: string,
  generation: number,
  attempt: number,
): string {
  return `evidence:${protocolDigest("AdvancementEvidenceRequestId", 1, {
    reviewId,
    generation,
    attempt,
  }).slice("sha256:".length)}`;
}
