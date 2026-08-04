import type { RunRecordRef } from "../transcript/shard/types.js";
import { protocolDigest } from "../protocol/canonical.js";

export function advancementReviewLineageId(
  sessionId: string,
  runRecordRef: RunRecordRef,
): string {
  return `adv-review:${protocolDigest("AdvancementReviewLineage", 1, {
    sessionId,
    runRecordRef,
  }).slice("sha256:".length)}`;
}

export function advancementReviewAttemptId(
  lineageId: string,
  generation: number,
): string {
  return `${lineageId}:generation:${generation}`;
}

export function advancementReviewRootRequestId(
  lineageId: string,
  generation: number,
): string {
  return `advancement-review-root:${advancementReviewAttemptId(lineageId, generation)}`;
}

export function advancementReviewAttemptMutationId(
  lineageId: string,
  generation: number,
  transition: string,
): string {
  return `adv-review-mutation:${protocolDigest("AdvancementReviewAttemptMutation", 1, {
    lineageId,
    generation,
    transition,
  }).slice("sha256:".length)}`;
}
