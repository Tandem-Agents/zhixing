import type {
  AdvancementControlEvent,
  AdvancementEvidenceAttempt,
  AdvancementEvidenceOutcome,
} from "./types.js";
import {
  validateEvidenceBundle,
  validateEvidenceRequest,
  validateMessage,
  evidenceRequestDigest,
  type ProtocolSignatureVerifier,
} from "../protocol/index.js";
import { isUserTurnInput } from "../types/user-input.js";
import { assertUniqueConfirmedRubricContractContentIds } from "./contract.js";

/**
 * 推进控制事件的唯一校验器——文件控制日志的容错重放与权威日志的写入 /
 * 重放校验共用同一谓词源：判不上的事件在重放时整条隔离（旧形状、半写、
 * 损坏行），在写入时直接拒绝。签名载荷（取证请求 / 证据包）经同一 wire
 * codec 校验；容错重放方可注入宽松 verifier 只做结构校验。
 */
export function isAdvancementControlEvent(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): value is AdvancementControlEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") return false;
  if (typeof event.timestamp !== "string") return false;
  if (typeof event.sessionId !== "string") return false;
  switch (event.type) {
    case "session_created":
      return (
        hasExactKeys(event, [
          "conversationId",
          "originalUserTask",
          "pendingRubricDraft",
          "sessionId",
          "timestamp",
          "type",
        ]) &&
        typeof event.conversationId === "string" &&
        isRubricDraftShape(event.pendingRubricDraft) &&
        isUserTurnInput(event.originalUserTask)
      );
    case "rubric_draft_revised":
      return (
        hasExactKeys(event, [
          "pendingRubricDraft",
          "sessionId",
          "timestamp",
          "type",
        ]) &&
        isRubricDraftShape(event.pendingRubricDraft)
      );
    case "rubric_confirmed":
      return (
        hasExactKeys(event, [
          "admissionIntent",
          "confirmedRubric",
          "sessionId",
          "timestamp",
          "type",
        ]) &&
        isConfirmedRubricShape(event.confirmedRubric) &&
        isAdmissionIntentShape(event.admissionIntent)
      );
    case "original_task_admitted":
      return (
        hasExactKeys(event, [
          "inputDigest",
          "runId",
          "sessionId",
          "timestamp",
          "turnId",
          "type",
        ]) &&
        isNonEmptyString(event.turnId) &&
        isDigest(event.inputDigest) &&
        isNonEmptyString(event.runId)
      );
    case "run_reviewed": {
      if (
        !hasExactKeys(event, ["review", "sessionId", "timestamp", "type"])
      ) {
        return false;
      }
      const review = event.review;
      return isRunReviewShape(review);
    }
    case "window_updated":
      return (
        hasExactKeys(event, [
          "advancementWindow",
          "sessionId",
          "timestamp",
          "type",
        ]) &&
        isAdvancementWindowShape(event.advancementWindow)
      );
    case "proxy_enqueued": {
      if (
        !hasExactKeys(event, ["proxyMessage", "sessionId", "timestamp", "type"])
      ) {
        return false;
      }
      const proxy = event.proxyMessage;
      return isProxyMessageShape(proxy);
    }
    case "proxy_settled":
      return (
        hasExactKeys(event, [
          "proxyMessageId",
          "sessionId",
          "timestamp",
          "type",
        ]) && typeof event.proxyMessageId === "string"
      );
    case "evidence_requested": {
      if (
        !hasExactKeys(event, ["attempt", "sessionId", "timestamp", "type"])
      ) {
        return false;
      }
      const attempt = event.attempt;
      if (
        typeof attempt !== "object" ||
        attempt === null ||
        !hasExactKeys(attempt as Record<string, unknown>, [
          "attempt",
          "generation",
          "itemRequirements",
          "request",
          "requestDigest",
          "requestId",
          "reviewId",
        ])
      ) {
        return false;
      }
      const candidate = attempt as AdvancementEvidenceAttempt;
      if (
        typeof candidate.requestId !== "string" ||
        typeof candidate.reviewId !== "string" ||
        !Number.isSafeInteger(candidate.attempt) ||
        candidate.attempt <= 0 ||
        !Number.isSafeInteger(candidate.generation) ||
        candidate.generation <= 0 ||
        !Array.isArray(candidate.itemRequirements) ||
        !candidate.itemRequirements.every((mapping) => {
          if (!mapping || typeof mapping !== "object") return false;
          const itemIndex = (mapping as { itemIndex?: unknown }).itemIndex;
          const requirementIds = (mapping as { requirementIds?: unknown })
            .requirementIds;
          return (
            Number.isSafeInteger(itemIndex) &&
            (itemIndex as number) >= 0 &&
            Array.isArray(requirementIds) &&
            (requirementIds as unknown[]).every(
              (id) => typeof id === "string",
            )
          );
        })
      ) {
        return false;
      }
      try {
        validateEvidenceRequest(candidate.request, verifier);
      } catch {
        return false;
      }
      return (
        candidate.requestId === candidate.request.requestId &&
        candidate.reviewId === candidate.request.reviewId &&
        candidate.requestDigest === evidenceRequestDigest(candidate.request) &&
        new Set(candidate.itemRequirements.map((entry) => entry.itemIndex)).size ===
          candidate.itemRequirements.length &&
        candidate.itemRequirements.every(
          (entry) =>
            entry.itemIndex < candidate.request.items.length &&
            entry.requirementIds.length > 0 &&
            new Set(entry.requirementIds).size === entry.requirementIds.length,
        )
      );
    }
    case "evidence_result": {
      if (
        !hasExactKeys(event, [
          "outcome",
          "requestId",
          "sessionId",
          "timestamp",
          "type",
        ]) ||
        typeof event.requestId !== "string"
      ) {
        return false;
      }
      return isEvidenceOutcome(event.outcome, verifier);
    }
    case "evidence_settled":
      return (
        hasExactKeys(event, [
          "requestId",
          "sessionId",
          "settlement",
          "timestamp",
          "type",
        ]) &&
        typeof event.requestId === "string" &&
        (event.settlement === "consumed" || event.settlement === "deferred")
      );
    case "completed":
    case "exited":
      return (
        hasExactKeys(event, ["exit", "sessionId", "timestamp", "type"]) &&
        isExitShape(event.exit)
      );
    case "cancelled":
      return hasExactKeys(
        event,
        [
          "sessionId",
          "timestamp",
          "type",
          ...(event.exit !== undefined ? ["exit"] : []),
        ],
      ) && (event.exit === undefined || isExitShape(event.exit));
    default:
      return false;
  }
}

function isEvidenceOutcome(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): value is AdvancementEvidenceOutcome {
  if (!value || typeof value !== "object") return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === "typed-stale" || outcome.kind === "capability-gap") {
    return hasExactKeys(outcome, ["kind"]);
  }
  if (outcome.kind === "bundle") {
    if (!hasExactKeys(outcome, ["bundle", "kind"])) return false;
    try {
      validateEvidenceBundle(outcome.bundle, verifier);
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

function isConfirmedRubricShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rubric = value as Record<string, unknown>;
  if (
    !hasExactKeys(rubric, [
      "confirmedAt",
      "confirmedBy",
      "content",
      "description",
      "source",
      "title",
    ]) ||
    typeof rubric.title !== "string" ||
    typeof rubric.description !== "string" ||
    rubric.confirmedBy !== "user" ||
    typeof rubric.confirmedAt !== "string" ||
    !isConfirmedRubricSourceShape(rubric.source) ||
    !isRubricContentShape(rubric.content, true)
  ) {
    return false;
  }
  const criteria = (rubric.content as { passCriteria?: unknown }).passCriteria;
  // 条目化形状校验——升级前的 legacy 快照（passCriteria: string[]）整条
  // 隔离：半隔离会让字符串条目穿透到注入渲染与裁判 schema（产出
  // undefined/null），干净地不可见让旧会话退回 awaiting、可重新确认。
  const criteriaShapeOk =
    Array.isArray(criteria) &&
    criteria.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { text?: unknown }).text === "string",
    );
  if (!criteriaShapeOk) return false;
  try {
    assertUniqueConfirmedRubricContractContentIds(
      rubric.content as import("./types.js").ConfirmedRubricContentSnapshot,
    );
  } catch {
    return false;
  }
  return true;
}

function isConfirmedRubricSourceShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return source.kind === "library"
    ? hasExactKeys(source, ["kind", "rubricId", "rubricVersion"]) &&
        isNonEmptyString(source.rubricId) &&
        isNonEmptyString(source.rubricVersion)
    : source.kind === "local-draft"
      ? hasExactKeys(source, ["contentDigest", "kind", "snapshotId"]) &&
          isNonEmptyString(source.snapshotId) &&
          isDigest(source.contentDigest)
      : false;
}

function isRubricDraftShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    hasExactKeys(draft, [
      "candidateRubricIds",
      ...(draft.candidateRubrics !== undefined ? ["candidateRubrics"] : []),
      "content",
      "createdAt",
      "description",
      "draftId",
      "originalTurnId",
      "source",
      "title",
    ]) &&
    isNonEmptyString(draft.draftId) &&
    isNonEmptyString(draft.originalTurnId) &&
    (draft.source === "matched" || draft.source === "generated") &&
    Array.isArray(draft.candidateRubricIds) &&
    draft.candidateRubricIds.every(isNonEmptyString) &&
    (draft.candidateRubrics === undefined ||
      (Array.isArray(draft.candidateRubrics) &&
        draft.candidateRubrics.every(isRubricCandidateShape))) &&
    typeof draft.title === "string" &&
    typeof draft.description === "string" &&
    typeof draft.createdAt === "string" &&
    isRubricContentShape(draft.content, false)
  );
}

function isRubricContentShape(value: unknown, confirmed: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const content = value as Record<string, unknown>;
  if (
    !hasExactKeys(content, [
      ...(content.evidenceRequirements !== undefined
        ? ["evidenceRequirements"]
        : []),
      "failureHandling",
      "passCriteria",
    ]) ||
    !Array.isArray(content.passCriteria) ||
    !Array.isArray(content.failureHandling)
  ) {
    return false;
  }
  const criteriaOk = confirmed
    ? content.passCriteria.every(
        (item) =>
          !!item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          hasExactKeys(item as Record<string, unknown>, ["id", "text"]) &&
          isNonEmptyString((item as { id?: unknown }).id) &&
          typeof (item as { text?: unknown }).text === "string",
      )
    : content.passCriteria.every((item) => typeof item === "string");
  return (
    criteriaOk &&
    (content.evidenceRequirements === undefined ||
      (Array.isArray(content.evidenceRequirements) &&
        content.evidenceRequirements.every(isEvidenceRequirementShape))) &&
    content.failureHandling.every(isFailureHandlingShape)
  );
}

function isEvidenceRequirementShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    hasExactKeys(item, [
      "description",
      "id",
      "kind",
      ...(item.locator !== undefined ? ["locator"] : []),
      ...(item.required !== undefined ? ["required"] : []),
    ]) &&
    isNonEmptyString(item.id) &&
    OBJECTIVE_SIGNAL_KINDS.has(String(item.kind)) &&
    typeof item.description === "string" &&
    (item.required === undefined || typeof item.required === "boolean") &&
    (item.locator === undefined || isLocatorShape(item.locator))
  );
}

function isFailureHandlingShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    hasExactKeys(item, ["id", "reply", "scenario"]) &&
    isNonEmptyString(item.id) &&
    typeof item.scenario === "string" &&
    typeof item.reply === "string"
  );
}

function isLocatorShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const locator = value as Record<string, unknown>;
  return (
    hasExactKeys(locator, locator.paths === undefined ? [] : ["paths"]) &&
    (locator.paths === undefined ||
      (Array.isArray(locator.paths) && locator.paths.every(isNonEmptyString)))
  );
}

function isRubricCandidateShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasExactKeys(candidate, [
      "description",
      "id",
      ...(candidate.matchScore !== undefined ? ["matchScore"] : []),
      "source",
      "title",
    ]) &&
    isNonEmptyString(candidate.id) &&
    typeof candidate.title === "string" &&
    typeof candidate.description === "string" &&
    (candidate.source === "own" || candidate.source === "linked") &&
    (candidate.matchScore === undefined ||
      (typeof candidate.matchScore === "number" &&
        Number.isFinite(candidate.matchScore)))
  );
}

function isAdmissionIntentShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if (
    !hasExactKeys(intent, [
      "inputDigest",
      "surfacePrincipal",
      "turnId",
      "turnOrigin",
    ]) ||
    !isNonEmptyString(intent.turnId) ||
    !isNonEmptyString(intent.surfacePrincipal) ||
    !isDigest(intent.inputDigest) ||
    !intent.turnOrigin ||
    typeof intent.turnOrigin !== "object" ||
    Array.isArray(intent.turnOrigin)
  ) {
    return false;
  }
  const origin = intent.turnOrigin as Record<string, unknown>;
  return (
    hasExactKeys(origin, ["channel", "triggeredBy"]) &&
    origin.channel === "rpc" &&
    origin.triggeredBy === intent.surfacePrincipal
  );
}

function isRunReviewShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  const optional = [
    "contextWindow",
    "exitReason",
    "proxyMessageId",
    "runRecordRef",
    "selectedFailureHandlingId",
    "usage",
  ].filter((key) => review[key] !== undefined);
  return (
    hasExactKeys(review, [
      "attribution",
      "decision",
      "evidence",
      "id",
      "reviewedAt",
      "runIndex",
      "unmetCriteria",
      ...optional,
    ]) &&
    isNonEmptyString(review.id) &&
    Number.isSafeInteger(review.runIndex) &&
    (review.runIndex as number) >= 0 &&
    typeof review.reviewedAt === "string" &&
    ["passed", "failed", "exit"].includes(String(review.decision)) &&
    Array.isArray(review.evidence) &&
    review.evidence.every(isReviewEvidenceShape) &&
    Array.isArray(review.unmetCriteria) &&
    review.unmetCriteria.every((item) => typeof item === "string") &&
    isAttributionShape(review.attribution) &&
    (review.runRecordRef === undefined || isRunRecordRefShape(review.runRecordRef)) &&
    (review.usage === undefined || isReviewUsageShape(review.usage)) &&
    (review.selectedFailureHandlingId === undefined ||
      isNonEmptyString(review.selectedFailureHandlingId)) &&
    (review.proxyMessageId === undefined || isNonEmptyString(review.proxyMessageId)) &&
    (review.exitReason === undefined || isExitReason(review.exitReason)) &&
    (review.contextWindow === undefined ||
      isReviewContextWindowShape(review.contextWindow))
  );
}

const OBJECTIVE_SIGNAL_KINDS = new Set([
  "file-diff",
  "test-result",
  "build-result",
  "log",
  "artifact",
  "conversation-fact",
  "none",
]);

function isReviewEvidenceShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (
    hasExactKeys(evidence, [
      "id",
      "kind",
      ...(evidence.passed !== undefined ? ["passed"] : []),
      ...(evidence.refs !== undefined ? ["refs"] : []),
      ...(evidence.requirementId !== undefined ? ["requirementId"] : []),
      ...(evidence.source !== undefined ? ["source"] : []),
      "summary",
    ]) &&
    isNonEmptyString(evidence.id) &&
    OBJECTIVE_SIGNAL_KINDS.has(String(evidence.kind)) &&
    typeof evidence.summary === "string" &&
    (evidence.requirementId === undefined ||
      isNonEmptyString(evidence.requirementId)) &&
    (evidence.source === undefined ||
      ["independent", "execution-report", "user"].includes(
        String(evidence.source),
      )) &&
    (evidence.passed === undefined || typeof evidence.passed === "boolean") &&
    (evidence.refs === undefined ||
      (Array.isArray(evidence.refs) && evidence.refs.every(isNonEmptyString)))
  );
}

function isRunRecordRefShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    hasExactKeys(ref, ["runIndex", "shardId"]) &&
    isNonEmptyString(ref.shardId) &&
    Number.isSafeInteger(ref.runIndex) &&
    (ref.runIndex as number) >= 0
  );
}

function isReviewUsageShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return (
    hasExactKeys(usage, [
      ...(usage.judge !== undefined ? ["judge"] : []),
      ...(usage.run !== undefined ? ["run"] : []),
    ]) &&
    (usage.judge === undefined || isTokenUsageShape(usage.judge)) &&
    (usage.run === undefined || isTokenUsageShape(usage.run))
  );
}

function isTokenUsageShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return (
    hasExactKeys(usage, [
      ...(usage.cacheReadTokens !== undefined ? ["cacheReadTokens"] : []),
      ...(usage.cacheWriteTokens !== undefined ? ["cacheWriteTokens"] : []),
      "inputTokens",
      "outputTokens",
      ...(usage.totalInputTokens !== undefined ? ["totalInputTokens"] : []),
    ]) &&
    [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.totalInputTokens,
    ].every(
      (entry) =>
        entry === undefined ||
        (Number.isSafeInteger(entry) && (entry as number) >= 0),
    )
  );
}

function isAttributionShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attribution = value as Record<string, unknown>;
  return (
    hasExactKeys(attribution, ["criteria"]) &&
    Array.isArray(attribution.criteria) &&
    attribution.criteria.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const item = entry as Record<string, unknown>;
      return (
        hasExactKeys(item, [
          "criterionId",
          ...(item.evidenceExcerpt !== undefined ? ["evidenceExcerpt"] : []),
          "reason",
          "verdict",
        ]) &&
        isNonEmptyString(item.criterionId) &&
        ["met", "unmet", "unknown"].includes(String(item.verdict)) &&
        typeof item.reason === "string" &&
        (item.evidenceExcerpt === undefined ||
          typeof item.evidenceExcerpt === "string")
      );
    })
  );
}

function isProxyMessageShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proxy = value as Record<string, unknown>;
  return (
    hasExactKeys(proxy, [
      "attribution",
      "content",
      "createdAt",
      "id",
      "reviewId",
      "rubricFailureHandlingId",
      "sessionId",
      "variables",
    ]) &&
    isNonEmptyString(proxy.id) &&
    isNonEmptyString(proxy.sessionId) &&
    isNonEmptyString(proxy.reviewId) &&
    isNonEmptyString(proxy.rubricFailureHandlingId) &&
    isUserTurnInput(proxy.content) &&
    isAttributionShape(proxy.attribution) &&
    !!proxy.variables &&
    typeof proxy.variables === "object" &&
    !Array.isArray(proxy.variables) &&
    Object.values(proxy.variables as Record<string, unknown>).every(
      (entry) => typeof entry === "string",
    ) &&
    typeof proxy.createdAt === "string"
  );
}

function isAdvancementWindowShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  return (
    hasExactKeys(window, [
      "entries",
      ...(window.lastSnapshot !== undefined ? ["lastSnapshot"] : []),
      "reviewCount",
      "source",
      "updatedAt",
    ]) &&
    window.source === "advancement-window" &&
    Number.isSafeInteger(window.reviewCount) &&
    (window.reviewCount as number) >= 0 &&
    Array.isArray(window.entries) &&
    window.entries.every(isAdvancementWindowEntryShape) &&
    (window.lastSnapshot === undefined ||
      isReviewContextWindowShape(window.lastSnapshot)) &&
    typeof window.updatedAt === "string"
  );
}

function isAdvancementWindowEntryShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const messagesOk =
    Array.isArray(entry.messages) &&
    entry.messages.length === 2 &&
    entry.messages.every(isMessageShape);
  if (entry.kind === "summary") {
    return hasExactKeys(entry, ["kind", "messages"]) && messagesOk;
  }
  return (
    entry.kind === "review" &&
    hasExactKeys(entry, ["kind", "messages", "reviewId", "runIndex"]) &&
    isNonEmptyString(entry.reviewId) &&
    Number.isSafeInteger(entry.runIndex) &&
    (entry.runIndex as number) >= 0 &&
    messagesOk
  );
}

function isReviewContextWindowShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    hasExactKeys(snapshot, [
      ...(snapshot.compact !== undefined ? ["compact"] : []),
      "decision",
      "inputMessageCount",
      "outputMessageCount",
      "priorReviewCount",
      "source",
    ]) &&
    snapshot.source === "advancement-window" &&
    [
      snapshot.priorReviewCount,
      snapshot.inputMessageCount,
      snapshot.outputMessageCount,
    ].every(
      (entry) => Number.isSafeInteger(entry) && (entry as number) >= 0,
    ) &&
    isWindowDecisionShape(snapshot.decision) &&
    (snapshot.compact === undefined || isWindowCompactShape(snapshot.compact))
  );
}

function isWindowDecisionShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  return (
    hasExactKeys(decision, [
      ...(decision.currentTokens !== undefined ? ["currentTokens"] : []),
      "kind",
      "reason",
      ...(decision.threshold !== undefined ? ["threshold"] : []),
    ]) &&
    ["pass", "defer", "trigger"].includes(String(decision.kind)) &&
    typeof decision.reason === "string" &&
    [decision.currentTokens, decision.threshold].every(
      (entry) =>
        entry === undefined ||
        (Number.isSafeInteger(entry) && (entry as number) >= 0),
    )
  );
}

function isWindowCompactShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const compact = value as Record<string, unknown>;
  return (
    hasExactKeys(compact, [
      "pairsCompacted",
      ...(compact.segmentId !== undefined ? ["segmentId"] : []),
      "tokensAfter",
      "tokensBefore",
    ]) &&
    [compact.pairsCompacted, compact.tokensBefore, compact.tokensAfter].every(
      (entry) => Number.isSafeInteger(entry) && (entry as number) >= 0,
    ) &&
    (compact.segmentId === undefined || isNonEmptyString(compact.segmentId))
  );
}

function isMessageShape(value: unknown): boolean {
  try {
    validateMessage(value);
    return true;
  } catch {
    return false;
  }
}

function isExitShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const exit = value as Record<string, unknown>;
  return (
    hasExactKeys(exit, ["message", "occurredAt", "reason"]) &&
    isExitReason(exit.reason) &&
    typeof exit.message === "string" &&
    typeof exit.occurredAt === "string"
  );
}

function isExitReason(value: unknown): boolean {
  return [
    "passed",
    "dead-end",
    "user-cancelled",
    "user-took-over",
    "superseded",
    "system-error",
    "capability-gap",
    "budget-exceeded",
  ].includes(String(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDigest(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}
