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
  AdvancementReviewRootBinding,
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

const REVIEW_ROOT_BINDING_PREFIX = "advancement-review-root-binding:v1:";

/**
 * Fixed external mechanism for the unique Advancement review application.
 * Full evidence targets remain local to the accepted request that resolved them;
 * the durable application only observes an opaque root binding.
 */
export function createAdvancementReviewExternalMechanism(
  options: AdvancementReviewExternalMechanismOptions,
): AdvancementReviewAttemptMechanismPort {
  const resolvedTargets = new WeakMap<
    AdvancementReviewAttemptInput,
    AdvancementEvidenceTarget
  >();

  return {
    async resolveRootBinding(session, input) {
      if (!options.evidence || !input.runId) return undefined;
      const carried = options.evidence.carriedOutcomeRootTarget(session, input.runId);
      if (carried) return encodeReviewRootBinding(input.conversationId, carried);
      const target = await options.evidence.resolveTarget(
        input.conversationId,
        input.runId,
      );
      if (target) resolvedTargets.set(input, target);
      return target
        ? encodeReviewRootBinding(input.conversationId, target)
        : undefined;
    },
    materializeReviewRoot({ root, binding }) {
      if (root.audience !== undefined || root.scopeBinding !== undefined) {
        throw new TypeError("Advancement review root is already bound");
      }
      if (binding === undefined) return root;
      const decoded = decodeReviewRootBinding(binding);
      return {
        ...root,
        audience: { executorId: decoded.executorId },
        scopeBinding: {
          kind: "conversation",
          conversationId: decoded.conversationId,
          ownerEpoch: decoded.ownerEpoch,
        },
      };
    },
    reviewRootMatchesBinding({ root, binding }) {
      if (binding === undefined) {
        return root.audience === undefined && root.scopeBinding === undefined;
      }
      const decoded = decodeReviewRootBinding(binding);
      const audience = root.audience;
      const scope = root.scopeBinding;
      return (
        isExactRecord(audience, ["executorId"]) &&
        audience.executorId === decoded.executorId &&
        isExactRecord(scope, ["conversationId", "kind", "ownerEpoch"]) &&
        scope.kind === "conversation" &&
        scope.conversationId === decoded.conversationId &&
        scope.ownerEpoch === decoded.ownerEpoch
      );
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

function encodeReviewRootBinding(
  conversationId: string,
  target: Readonly<{ executorId: string; ownerEpoch: number }>,
): AdvancementReviewRootBinding {
  assertNonEmptyString(conversationId, "conversationId");
  assertNonEmptyString(target.executorId, "executorId");
  if (!Number.isSafeInteger(target.ownerEpoch) || target.ownerEpoch <= 0) {
    throw new TypeError("Advancement review root ownerEpoch must be positive");
  }
  return `${REVIEW_ROOT_BINDING_PREFIX}${JSON.stringify([
    conversationId,
    target.executorId,
    target.ownerEpoch,
  ])}` as AdvancementReviewRootBinding;
}

function decodeReviewRootBinding(binding: AdvancementReviewRootBinding): Readonly<{
  conversationId: string;
  executorId: string;
  ownerEpoch: number;
}> {
  if (
    typeof binding !== "string" ||
    !binding.startsWith(REVIEW_ROOT_BINDING_PREFIX)
  ) {
    throw new TypeError("Advancement review root binding is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(binding.slice(REVIEW_ROOT_BINDING_PREFIX.length));
  } catch {
    throw new TypeError("Advancement review root binding is invalid");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string" ||
    typeof decoded[2] !== "number"
  ) {
    throw new TypeError("Advancement review root binding is invalid");
  }
  const target = {
    conversationId: decoded[0],
    executorId: decoded[1],
    ownerEpoch: decoded[2],
  };
  try {
    assertNonEmptyString(target.conversationId, "conversationId");
    assertNonEmptyString(target.executorId, "executorId");
  } catch {
    throw new TypeError("Advancement review root binding is invalid");
  }
  if (
    !Number.isSafeInteger(target.ownerEpoch) ||
    target.ownerEpoch <= 0 ||
    encodeReviewRootBinding(target.conversationId, target) !== binding
  ) {
    throw new TypeError("Advancement review root binding is invalid");
  }
  return target;
}

function assertNonEmptyString(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`Advancement review root ${name} must be non-empty`);
  }
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
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
