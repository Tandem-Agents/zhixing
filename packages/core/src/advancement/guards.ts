import type {
  AdvancementRunReview,
  AdvancementStoreEvent,
} from "./types.js";
import {
  applyAdvancementEvent,
  assertTerminalReviewDecision,
  isOpenAdvancementSession,
  type AdvancementFoldMap,
  type AdvancementFoldSession,
} from "./reducer.js";
import {
  canonicalize,
  evidenceRequestDigest,
  protocolDigest,
} from "../protocol/index.js";
import { assertUniqueConfirmedRubricContractContentIds } from "./contract.js";
import { advancementEvidenceRequestId } from "./evidence-identity.js";
import {
  advancementReviewAttemptId,
  advancementReviewLineageId,
  advancementReviewRootRequestId,
} from "./review-attempt-identity.js";

/**
 * 一次推进写入的批次合法性谓词——权威日志写入侧的唯一领域门禁：与文件
 * 控制日志的写方法守卫同一规则集，按序在折叠副本上逐项验证并应用，
 * 任一事件不合法即整批拒绝，杜绝半组事件成为权威事实。
 */
export function assertAdvancementEventBatchLegal(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  events: readonly AdvancementStoreEvent[],
): void {
  if (events.length === 0) {
    throw new Error("AdvancementStore: write requires at least one event");
  }
  const sessionIds = new Set(events.map((event) => event.sessionId));
  if (sessionIds.size !== 1) {
    throw new Error(
      "AdvancementStore: write events must bind exactly one advancement session",
    );
  }
  const work: AdvancementFoldMap = new Map(
    [...sessions.entries()].map(([id, session]) => [
      id,
      structuredClone(session),
    ]),
  );
  let batchReview: AdvancementRunReview | undefined;
  for (const event of events) {
    switch (event.type) {
      case "session_created": {
        if (work.has(event.sessionId)) {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" already exists`,
          );
        }
        if ([...work.values()].some(isOpenAdvancementSession)) {
          throw new Error(
            `AdvancementStore: conversation "${event.conversationId}" already has an open advancement session`,
          );
        }
        break;
      }
      case "rubric_confirmed": {
        const session = requireAwaiting(work, event.sessionId);
        assertUniqueConfirmedRubricContractContentIds(
          event.confirmedRubric.content,
        );
        const expected = protocolDigest(
          "AdvancementOriginalTaskInput",
          1,
          session.originalUserTask,
        );
        if (event.admissionIntent.inputDigest !== expected) {
          throw new Error(
            "AdvancementStore: original-task admission intent does not bind task content",
          );
        }
        if (
          event.admissionIntent.turnOrigin.triggeredBy !==
          event.admissionIntent.surfacePrincipal
        ) {
          throw new Error(
            "AdvancementStore: original-task admission intent does not bind its surface principal",
          );
        }
        break;
      }
      case "original_task_admitted": {
        const session = requireActive(work, event.sessionId);
        const admission = session.originalTaskAdmission;
        if (!admission || admission.status !== "pending") {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" has no pending original-task admission`,
          );
        }
        if (
          admission.intent.turnId !== event.turnId ||
          admission.intent.inputDigest !== event.inputDigest
        ) {
          throw new Error(
            "AdvancementStore: original-task admission settlement does not bind its intent",
          );
        }
        break;
      }
      case "rubric_draft_revised": {
        const session = requireAwaiting(work, event.sessionId);
        if (
          session.pendingRubricDraft &&
          event.pendingRubricDraft.originalTurnId !==
            session.pendingRubricDraft.originalTurnId
        ) {
          throw new Error(
            "AdvancementStore: revised draft belongs to another turn",
          );
        }
        break;
      }
      case "run_reviewed": {
        const session = requireActive(work, event.sessionId);
        if (batchReview) {
          throw new Error(
            "AdvancementStore: write batch carries more than one run review",
          );
        }
        batchReview = event.review;
        if (
          session.runs.some(
            (review) =>
              review.id === event.review.id ||
              review.runIndex === event.review.runIndex ||
              (!!review.runRecordRef &&
                !!event.review.runRecordRef &&
                review.runRecordRef.shardId ===
                  event.review.runRecordRef.shardId &&
                review.runRecordRef.runIndex ===
                  event.review.runRecordRef.runIndex),
          )
        ) {
          throw new Error(
            "AdvancementStore: accepted run or review identity already has a durable review",
          );
        }
        if (
          event.review.selectedFailureHandlingId !== undefined &&
          !session.confirmedRubric?.content.failureHandling.some(
            (item) => item.id === event.review.selectedFailureHandlingId,
          )
        ) {
          throw new Error(
            "AdvancementStore: review selects unknown failure handling",
          );
        }
        break;
      }
      case "window_updated": {
        requireActive(work, event.sessionId);
        break;
      }
      case "proxy_enqueued": {
        const session = requireActive(work, event.sessionId);
        if (session.outstandingProxyMessageId) {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" already has an outstanding proxy message`,
          );
        }
        if (event.proxyMessage.sessionId !== event.sessionId) {
          throw new Error(
            `AdvancementStore: proxy message "${event.proxyMessage.id}" belongs to another session`,
          );
        }
        const boundReview = batchReview ?? session.runs.find(
          (review) =>
            review.decision === "failed" &&
            review.proxyMessageId === event.proxyMessage.id,
        );
        if (batchReview && batchReview.decision !== "failed") {
          throw new Error(
            "AdvancementStore: proxy message requires failed review",
          );
        }
        if (!boundReview) {
          throw new Error(
            "AdvancementStore: proxy message does not bind a failed review",
          );
        }
        if (boundReview.proxyMessageId !== event.proxyMessage.id) {
          throw new Error(
            "AdvancementStore: review proxyMessageId must match proxy message",
          );
        }
        if (
          event.proxyMessage.reviewId !== boundReview.id ||
          event.proxyMessage.rubricFailureHandlingId !==
            boundReview.selectedFailureHandlingId ||
          canonicalize(event.proxyMessage.attribution) !==
            canonicalize(boundReview.attribution)
        ) {
          throw new Error(
            "AdvancementStore: proxy message does not exactly bind its failed review",
          );
        }
        break;
      }
      case "proxy_settled": {
        const session = requireActive(work, event.sessionId);
        if (session.outstandingProxyMessageId !== event.proxyMessageId) {
          throw new Error(
            `AdvancementStore: proxy message "${event.proxyMessageId}" is not outstanding`,
          );
        }
        break;
      }
      case "completed":
      case "exited": {
        const session = requireActive(work, event.sessionId);
        if (batchReview) {
          assertTerminalReviewDecision(batchReview, event.type);
        } else if (event.type === "completed") {
          const durableReview = session.runs[session.runs.length - 1];
          if (!durableReview) {
            throw new Error(
              "AdvancementStore: completion requires a durable passed review",
            );
          }
          assertTerminalReviewDecision(durableReview, event.type);
        }
        break;
      }
      case "cancelled": {
        const session = requireSession(work, event.sessionId);
        if (!isOpenAdvancementSession(session)) {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" is already closed`,
          );
        }
        break;
      }
      case "review_attempt_transitioned": {
        const session = requireActive(work, event.sessionId);
        const attempt = event.attempt;
        const expectedLineage = advancementReviewLineageId(
          event.sessionId,
          attempt.runRecordRef,
        );
        if (
          attempt.lineageId !== expectedLineage ||
          attempt.runIndex !== attempt.runRecordRef.runIndex ||
          attempt.root.workload.kind !== "control" ||
          attempt.root.workload.id !==
            advancementReviewAttemptId(attempt.lineageId, attempt.generation) ||
          attempt.root.workload.attempt !== 1 ||
          attempt.root.requestId !==
            advancementReviewRootRequestId(attempt.lineageId, attempt.generation) ||
          (attempt.root.audience === undefined) !==
            (attempt.root.scopeBinding === undefined) ||
          (attempt.root.scopeBinding !== undefined &&
            (attempt.root.scopeBinding.kind !== "conversation" ||
              attempt.root.scopeBinding.conversationId !== session.conversationId))
        ) {
          throw new Error(
            "AdvancementStore: review attempt does not bind its accepted run and root contract",
          );
        }
        const current = session.reviewAttempts.find((candidate) =>
          sameRunRecordRef(candidate.runRecordRef, attempt.runRecordRef),
        );
        if (attempt.phase === "started") {
          const legacyGeneration = session.evidenceGenerations.find(
            (entry) => entry.runId === attempt.runId,
          )?.generation;
          if (
            current
              ? !isTerminalReviewAttempt(current.phase) ||
                attempt.generation !== current.generation + 1 ||
                attempt.runId !== current.runId ||
                attempt.lineageId !== current.lineageId
              : attempt.generation !== (legacyGeneration ?? 0) + 1
          ) {
            throw new Error(
              "AdvancementStore: review attempt generation must advance from a terminal attempt",
            );
          }
          break;
        }
        if (
          !current ||
          current.lineageId !== attempt.lineageId ||
          current.generation !== attempt.generation ||
          current.runId !== attempt.runId ||
          current.runIndex !== attempt.runIndex ||
          canonicalize(current.root) !== canonicalize(attempt.root)
        ) {
          throw new Error(
            "AdvancementStore: review attempt transition changed its frozen identity",
          );
        }
        if (attempt.phase === "invoking") {
          if (current.phase !== "started") {
            throw new Error(
              "AdvancementStore: only a started review attempt can begin invocation",
            );
          }
          break;
        }
        if (
          attempt.phase === "consumed" &&
          (current.phase !== "invoking" ||
            !session.runs.some(
              (review) =>
                review.runRecordRef !== undefined &&
                sameRunRecordRef(review.runRecordRef, attempt.runRecordRef),
            ))
        ) {
          throw new Error(
            "AdvancementStore: consumed review attempt requires its run review in the same batch",
          );
        }
        if (
          attempt.phase === "deferred" && current.phase !== "invoking"
        ) {
          throw new Error(
            "AdvancementStore: deferred review attempt requires an unknown invocation outcome",
          );
        }
        if (
          attempt.phase === "expired" &&
          current.phase !== "started" &&
          current.phase !== "invoking"
        ) {
          throw new Error(
            "AdvancementStore: expired review attempt requires a pending attempt",
          );
        }
        break;
      }
      case "evidence_requested": {
        const session = requireActive(work, event.sessionId);
        const attempt = event.attempt;
        const reviewAttempt = session.reviewAttempts.find(
          (candidate) => candidate.runId === attempt.request.runId,
        );
        const currentGeneration = session.evidenceGenerations.find(
          (entry) => entry.runId === attempt.request.runId,
        );
        const currentRunPending = session.evidencePending.find(
          (entry) => entry.request.runId === attempt.request.runId,
        );
        if (
          attempt.requestId !== attempt.request.requestId ||
          attempt.reviewId !== attempt.request.reviewId ||
          attempt.requestDigest !== evidenceRequestDigest(attempt.request) ||
          attempt.requestId !==
            advancementEvidenceRequestId(
              attempt.reviewId,
              attempt.generation,
              attempt.attempt,
            ) ||
          attempt.request.lease.workload.id !== attempt.requestId ||
          attempt.request.lease.workload.attempt !== attempt.generation ||
          (reviewAttempt !== undefined &&
            (reviewAttempt.phase !== "started" ||
              reviewAttempt.lineageId !== attempt.reviewId ||
              reviewAttempt.generation !== attempt.generation)) ||
          (reviewAttempt === undefined && session.reviewAttempts.length > 0)
        ) {
          throw new Error(
            "AdvancementStore: evidence attempt does not bind its signed request",
          );
        }
        if (
          currentGeneration
            ? currentGeneration.reviewId !== attempt.reviewId ||
              (attempt.generation === currentGeneration.generation
                ? attempt.attempt !== currentGeneration.lastAttempt + 1
                : attempt.generation !== currentGeneration.generation + 1 ||
                  attempt.attempt !== 1 ||
                  currentRunPending !== undefined)
            : attempt.generation !== (reviewAttempt?.generation ?? 1) ||
              attempt.attempt !== 1
        ) {
          throw new Error(
            "AdvancementStore: evidence generation must advance monotonically",
          );
        }
        const indexes = new Set<number>();
        const requirementIds = new Set(
          session.confirmedRubric?.content.evidenceRequirements?.map(
            (item) => item.id,
          ) ?? [],
        );
        for (const mapping of attempt.itemRequirements) {
          if (
            indexes.has(mapping.itemIndex) ||
            mapping.itemIndex >= attempt.request.items.length ||
            mapping.requirementIds.length === 0 ||
            new Set(mapping.requirementIds).size !== mapping.requirementIds.length ||
            mapping.requirementIds.some((id) => !requirementIds.has(id))
          ) {
            throw new Error(
              "AdvancementStore: evidence requirement mapping is invalid",
            );
          }
          indexes.add(mapping.itemIndex);
        }
        break;
      }
      case "evidence_result": {
        const session = requireActive(work, event.sessionId);
        const pending = session.evidencePending.find(
          (entry) => entry.requestId === event.requestId,
        );
        if (!pending) {
          throw new Error(
            "AdvancementStore: evidence result does not bind a pending request",
          );
        }
        if (
          event.outcome.kind === "bundle" &&
          (event.outcome.bundle.requestId !== pending.requestId ||
            event.outcome.bundle.requestDigest !== pending.requestDigest)
        ) {
          throw new Error(
            "AdvancementStore: evidence bundle does not bind its pending request",
          );
        }
        break;
      }
      case "evidence_settled": {
        const session = requireActive(work, event.sessionId);
        if (
          !session.evidencePending.some(
            (entry) => entry.requestId === event.requestId,
          )
        ) {
          throw new Error(
            "AdvancementStore: evidence settlement does not bind a pending request",
          );
        }
        break;
      }
    }
    applyAdvancementEvent(work, event);
  }
}

function sameRunRecordRef(
  left: { readonly shardId: string; readonly runIndex: number },
  right: { readonly shardId: string; readonly runIndex: number },
): boolean {
  return left.shardId === right.shardId && left.runIndex === right.runIndex;
}

function isTerminalReviewAttempt(
  phase: "started" | "invoking" | "consumed" | "deferred" | "expired",
): boolean {
  return phase === "consumed" || phase === "deferred" || phase === "expired";
}

function requireSession(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  sessionId: string,
): AdvancementFoldSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`AdvancementStore: session "${sessionId}" not found`);
  }
  return session;
}

function requireAwaiting(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  sessionId: string,
): AdvancementFoldSession {
  const session = requireSession(sessions, sessionId);
  if (session.status !== "awaiting-rubric-confirmation") {
    throw new Error(
      `AdvancementStore: session "${sessionId}" is not awaiting rubric confirmation`,
    );
  }
  return session;
}

function requireActive(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  sessionId: string,
): AdvancementFoldSession {
  const session = requireSession(sessions, sessionId);
  if (session.status !== "active") {
    throw new Error(`AdvancementStore: session "${sessionId}" is not active`);
  }
  return session;
}
