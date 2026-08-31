import type {
  AdvancementReviewRunOutcome,
  AdvancementRunReview,
  RunRecordRef,
} from "@zhixing/core";
import type {
  AdvancementReviewerPort,
} from "@zhixing/core/contracts";
import type {
  AdvancementReviewAttemptInput,
  AdvancementReviewAttemptMechanismPort,
} from "@zhixing/core/advancement/application";
import {
  AdvancementEvidenceDeferredError,
  type AdvancementEvidenceCoordinator,
  type AdvancementEvidenceTarget,
} from "./evidence.js";

export interface AdvancementReviewExternalMechanismOptions {
  readonly evidence?: Pick<
    AdvancementEvidenceCoordinator,
    "carriedOutcomeRootTarget" | "resolveTarget" | "collect"
  >;
  readonly reviewer?: AdvancementReviewerPort;
}

/**
 * Fixed external mechanism for the unique Advancement review application.
 * Full evidence targets remain local to the accepted request that resolved them;
 * the durable application only observes the stable executor/epoch root binding.
 */
export function createAdvancementReviewExternalMechanism(
  options: AdvancementReviewExternalMechanismOptions,
): AdvancementReviewAttemptMechanismPort {
  const resolvedTargets = new WeakMap<
    AdvancementReviewAttemptInput,
    AdvancementEvidenceTarget
  >();

  return {
    async resolveRootTarget(session, input) {
      if (!options.evidence || !input.runId) return undefined;
      const carried = options.evidence.carriedOutcomeRootTarget(session, input.runId);
      if (carried) return carried;
      const target = await options.evidence.resolveTarget(
        input.conversationId,
        input.runId,
      );
      if (target) resolvedTargets.set(input, target);
      return target;
    },
    async prepareEvidence({ session, request, attempt, rootLease }) {
      const target = resolvedTargets.get(request);
      resolvedTargets.delete(request);
      try {
        const collected =
          options.evidence && request.runId
            ? await options.evidence.collect({
                session,
                runId: request.runId,
                reviewId: attempt.lineageId,
                generation: attempt.generation,
                runRecord: request.runRecord,
                rootLease,
                target,
                abort: request.abortSignal ?? new AbortController().signal,
              })
            : undefined;
        return {
          kind: "ready",
          ...(collected
            ? {
                canonicalEvidence: collected.canonicalEvidence,
                ...(collected.requestId ? { requestId: collected.requestId } : {}),
              }
            : {}),
        };
      } catch (error) {
        return {
          kind: "deferred",
          cause:
            error instanceof AdvancementEvidenceDeferredError ||
            (error instanceof Error && error.name === "AbortError")
              ? "aborted"
              : "infrastructure",
          reason: `独立取证未能形成可消费终态：${errorMessage(error)}`,
        };
      }
    },
    async invokeReviewer({
      session,
      rubric,
      request,
      rootLease,
      canonicalEvidence,
    }) {
      if (!options.reviewer) {
        throw new Error("Advancement reviewer is not assembled");
      }
      let outcome: AdvancementReviewRunOutcome;
      try {
        outcome = await options.reviewer.review(
          {
            sessionId: session.id,
            originalUserTask: session.originalUserTask,
            rubric,
            runIndex: request.runIndex,
            runRecord: request.runRecord,
            runRecordRef: request.runRecordRef,
            priorReviews: session.runs,
            advancementWindow: session.advancementWindow,
            ...(canonicalEvidence ? { canonicalEvidence } : {}),
          },
          rootLease,
          request.abortSignal ?? new AbortController().signal,
        );
      } catch (error) {
        outcome = {
          kind: "deferred",
          cause:
            error instanceof Error && error.name === "AbortError"
              ? "aborted"
              : "infrastructure",
          reason: `推进侧验收运行失败：${errorMessage(error)}`,
        };
      }
      if (outcome.kind !== "deferred") {
        assertReviewMatchesAcceptedRun(request, outcome.review);
      }
      return outcome;
    },
  };
}

function assertReviewMatchesAcceptedRun(
  accepted: {
    readonly runIndex: number;
    readonly runRecordRef?: RunRecordRef;
  },
  review: AdvancementRunReview,
): void {
  if (review.runIndex !== accepted.runIndex) {
    throw new Error(
      `review runIndex ${review.runIndex} does not match accepted runIndex ${accepted.runIndex}`,
    );
  }
  if (!sameRunRecordRef(review.runRecordRef, accepted.runRecordRef)) {
    throw new Error("review runRecordRef does not match accepted runRecordRef");
  }
}

function sameRunRecordRef(
  left: RunRecordRef | undefined,
  right: RunRecordRef | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.shardId === right.shardId && left.runIndex === right.runIndex;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Rubric contract draft generation failed";
}
