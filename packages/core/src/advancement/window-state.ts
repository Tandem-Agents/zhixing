import { assistantMessage, userMessage } from "../types/messages.js";
import type {
  AdvancementRunReview,
  AdvancementWindowEntry,
} from "./types.js";

export function createAdvancementWindowReviewEntry(
  review: AdvancementRunReview,
): AdvancementWindowEntry {
  return {
    kind: "review",
    reviewId: review.id,
    runIndex: review.runIndex,
    messages: [
      userMessage(
        JSON.stringify(
          {
            reviewId: review.id,
            runIndex: review.runIndex,
            decision: review.decision,
            unmetCriteria: review.unmetCriteria,
            selectedFailureHandlingId: review.selectedFailureHandlingId,
            exitReason: review.exitReason,
          },
          null,
          2,
        ),
      ),
      assistantMessage(
        JSON.stringify(
          {
            reviewId: review.id,
            evidence: review.evidence,
            proxyMessageId: review.proxyMessageId,
          },
          null,
          2,
        ),
      ),
    ],
  };
}
