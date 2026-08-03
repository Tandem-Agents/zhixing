import type {
  AdvancementControlEvent,
  AdvancementEvidenceAttempt,
  AdvancementEvidenceOutcome,
} from "./types.js";
import {
  validateEvidenceBundle,
  validateEvidenceRequest,
  type ProtocolSignatureVerifier,
} from "../protocol/index.js";

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
        typeof event.pendingRubricDraft === "object" &&
        event.pendingRubricDraft !== null &&
        typeof event.originalUserTask === "object" &&
        event.originalUserTask !== null
      );
    case "rubric_draft_revised":
      return (
        hasExactKeys(event, [
          "pendingRubricDraft",
          "sessionId",
          "timestamp",
          "type",
        ]) &&
        typeof event.pendingRubricDraft === "object" &&
        event.pendingRubricDraft !== null
      );
    case "rubric_confirmed":
      return (
        hasExactKeys(event, [
          "confirmedRubric",
          "sessionId",
          "timestamp",
          "type",
        ]) && isConfirmedRubricShape(event.confirmedRubric)
      );
    case "run_reviewed": {
      if (
        !hasExactKeys(event, ["review", "sessionId", "timestamp", "type"])
      ) {
        return false;
      }
      const review = event.review;
      return (
        typeof review === "object" &&
        review !== null &&
        typeof (review as { attribution?: unknown }).attribution === "object"
      );
    }
    case "window_updated":
      return (
        hasExactKeys(event, [
          "advancementWindow",
          "sessionId",
          "timestamp",
          "type",
        ]) &&
        typeof event.advancementWindow === "object" &&
        event.advancementWindow !== null
      );
    case "proxy_enqueued": {
      if (
        !hasExactKeys(event, ["proxyMessage", "sessionId", "timestamp", "type"])
      ) {
        return false;
      }
      const proxy = event.proxyMessage;
      return (
        typeof proxy === "object" &&
        proxy !== null &&
        typeof (proxy as { attribution?: unknown }).attribution === "object"
      );
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
      return true;
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
        typeof event.exit === "object" &&
        event.exit !== null
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
      );
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
  if (!value || typeof value !== "object") return false;
  const rubric = value as Record<string, unknown>;
  const source = rubric.source;
  if (!source || typeof source !== "object") return false;
  const kind = (source as { kind?: unknown }).kind;
  if (
    kind === "library"
      ? typeof (source as { rubricId?: unknown }).rubricId !== "string" ||
        typeof (source as { rubricVersion?: unknown }).rubricVersion !==
          "string"
      : kind === "local-draft"
        ? typeof (source as { snapshotId?: unknown }).snapshotId !==
            "string" ||
          typeof (source as { contentDigest?: unknown }).contentDigest !==
            "string"
        : true
  ) {
    return false;
  }
  const criteria = (rubric as { content?: { passCriteria?: unknown } })
    .content?.passCriteria;
  // 条目化形状校验——升级前的 legacy 快照（passCriteria: string[]）整条
  // 隔离：半隔离会让字符串条目穿透到注入渲染与裁判 schema（产出
  // undefined/null），干净地不可见让旧会话退回 awaiting、可重新确认。
  return (
    Array.isArray(criteria) &&
    criteria.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { text?: unknown }).text === "string",
    )
  );
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
