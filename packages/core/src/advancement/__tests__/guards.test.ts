import { describe, expect, it } from "vitest";
import { assertAdvancementEventBatchLegal } from "../guards.js";
import { advancementEvidenceRequestId } from "../evidence-identity.js";
import { applyAdvancementEvent, type AdvancementFoldMap } from "../reducer.js";
import { evidenceRequestDigest, protocolDigest } from "../../protocol/index.js";
import type {
  AdvancementEvidenceAttempt,
  AdvancementControlEvent,
  AdvancementProxyMessage,
  AdvancementRunReview,
  ConfirmedRubricSnapshot,
  RubricContractDraftSnapshot,
  UserTurnInput,
} from "../types.js";

const NOW = "2026-08-02T00:00:00.000Z";

function task(text: string): UserTurnInput {
  return { parts: [{ type: "text", text }] };
}

function draft(): RubricContractDraftSnapshot {
  return {
    draftId: "draft-1",
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title: "准则",
    description: "描述",
    content: {
      passCriteria: ["测试通过"],
      evidenceRequirements: [],
      failureHandling: [{ id: "fix", scenario: "失败", reply: "修复" }],
    },
    createdAt: NOW,
  };
}

function confirmed(): ConfirmedRubricSnapshot {
  return {
    source: { kind: "library", rubricId: "rubric-1", rubricVersion: "v1" },
    title: "准则",
    description: "描述",
    content: {
      passCriteria: [{ id: "pc-1", text: "测试通过" }],
      evidenceRequirements: [],
      failureHandling: [{ id: "fix", scenario: "失败", reply: "修复" }],
    },
    confirmedAt: NOW,
    confirmedBy: "user",
  };
}

function review(extra: Partial<AdvancementRunReview> = {}): AdvancementRunReview {
  const value = {
    id: "review-1",
    runIndex: 0,
    reviewedAt: NOW,
    decision: "failed",
    evidence: [],
    attribution: { criteria: [] },
    unmetCriteria: ["测试通过"],
    selectedFailureHandlingId: "fix",
    proxyMessageId: "proxy-1",
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as AdvancementRunReview;
}

function proxy(extra: Partial<AdvancementProxyMessage> = {}): AdvancementProxyMessage {
  return {
    id: "proxy-1",
    sessionId: "session-1",
    reviewId: "review-1",
    content: task("继续"),
    rubricFailureHandlingId: "fix",
    variables: {},
    attribution: { criteria: [] },
    createdAt: NOW,
    ...extra,
  };
}

function foldOf(...events: AdvancementControlEvent[]): AdvancementFoldMap {
  const fold: AdvancementFoldMap = new Map();
  for (const event of events) applyAdvancementEvent(fold, event);
  return fold;
}

const created: AdvancementControlEvent = {
  type: "session_created",
  timestamp: NOW,
  sessionId: "session-1",
  conversationId: "conv-1",
  originalUserTask: task("任务"),
  pendingRubricDraft: draft(),
};
const confirm: AdvancementControlEvent = {
  type: "rubric_confirmed",
  timestamp: NOW,
  sessionId: "session-1",
  confirmedRubric: confirmed(),
  admissionIntent: {
    turnId: "turn-1",
    surfacePrincipal: "surface:test",
    turnOrigin: { channel: "rpc", triggeredBy: "surface:test" },
    inputDigest: protocolDigest(
      "AdvancementOriginalTaskInput",
      1,
      created.originalUserTask,
    ),
  },
};
const reviewed: AdvancementControlEvent = {
  type: "run_reviewed",
  timestamp: NOW,
  sessionId: "session-1",
  review: review(),
};
const activeFold = () => foldOf(created, confirm);

describe("assertAdvancementEventBatchLegal", () => {
  it("拒绝空批次与跨会话批次", () => {
    expect(() => assertAdvancementEventBatchLegal(new Map(), [])).toThrow(
      "at least one event",
    );
    expect(() =>
      assertAdvancementEventBatchLegal(new Map(), [
        created,
        { ...created, sessionId: "session-2" },
      ]),
    ).toThrow("exactly one advancement session");
  });

  it("拒绝确认版 Rubric 中重复的 criterion id", () => {
    const duplicateCriterion = {
      ...confirm,
      confirmedRubric: {
        ...confirm.confirmedRubric,
        content: {
          ...confirm.confirmedRubric.content,
          passCriteria: [
            { id: "pc-1", text: "测试通过" },
            { id: "pc-1", text: "构建通过" },
          ],
        },
      },
    };
    expect(() =>
      assertAdvancementEventBatchLegal(foldOf(created), [duplicateCriterion]),
    ).toThrow("pass criterion id must be unique");
  });

  it("拒绝单批次内重复 review 与错配 proxy", () => {
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [reviewed, reviewed]),
    ).toThrow("more than one run review");
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        reviewed,
        { type: "proxy_enqueued", timestamp: NOW, sessionId: "session-1", proxyMessage: proxy({ id: "proxy-2" }) },
      ]),
    ).toThrow("proxyMessageId must match proxy message");
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        { ...reviewed, review: review({ decision: "passed" }) },
        { type: "proxy_enqueued", timestamp: NOW, sessionId: "session-1", proxyMessage: proxy() },
      ]),
    ).toThrow("proxy message requires failed review");
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        reviewed,
        {
          type: "proxy_enqueued",
          timestamp: NOW,
          sessionId: "session-1",
          proxyMessage: proxy({ reviewId: "review-other" }),
        },
      ]),
    ).toThrow("does not exactly bind its failed review");
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        { ...reviewed, review: review({ selectedFailureHandlingId: "fix" }) },
        {
          type: "proxy_enqueued",
          timestamp: NOW,
          sessionId: "session-1",
          proxyMessage: proxy({ rubricFailureHandlingId: "other" }),
        },
      ]),
    ).toThrow("does not exactly bind its failed review");
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        reviewed,
        {
          type: "proxy_enqueued",
          timestamp: NOW,
          sessionId: "session-1",
          proxyMessage: proxy({
            attribution: {
              criteria: [
                { criterionId: "pc-1", verdict: "unmet", reason: "错绑" },
              ],
            },
          }),
        },
      ]),
    ).toThrow("does not exactly bind its failed review");
  });

  it("拒绝与复合终态不一致的批次", () => {
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        reviewed,
        {
          type: "completed",
          timestamp: NOW,
          sessionId: "session-1",
          exit: { reason: "passed", message: "完成", occurredAt: NOW },
        },
      ]),
    ).toThrow('completed review must have decision "passed"');
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        { ...reviewed, review: review({ decision: "passed" }) },
        {
          type: "exited",
          timestamp: NOW,
          sessionId: "session-1",
          exit: { reason: "dead-end", message: "死胡同", occurredAt: NOW },
        },
      ]),
    ).toThrow('exited review must have decision "exit"');
  });

  it("合法批次按序通过", () => {
    expect(() =>
      assertAdvancementEventBatchLegal(activeFold(), [
        reviewed,
        { type: "proxy_enqueued", timestamp: NOW, sessionId: "session-1", proxyMessage: proxy() },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAdvancementEventBatchLegal(foldOf(created, confirm, reviewed, {
        type: "proxy_enqueued",
        timestamp: NOW,
        sessionId: "session-1",
        proxyMessage: proxy(),
      }), [
        { type: "proxy_settled", timestamp: NOW, sessionId: "session-1", proxyMessageId: "proxy-1" },
      ]),
    ).not.toThrow();
  });

  it("取证代际只允许代内递增或在旧请求结清后推进一代", () => {
    const first = evidenceAttempt(1, 1);
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [
      { type: "evidence_requested", timestamp: NOW, sessionId: "session-1", attempt: first },
    ])).not.toThrow();

    const pending = foldOf(created, confirm, {
      type: "evidence_requested",
      timestamp: NOW,
      sessionId: "session-1",
      attempt: first,
    });
    expect(() => assertAdvancementEventBatchLegal(pending, [
      {
        type: "evidence_requested",
        timestamp: NOW,
        sessionId: "session-1",
        attempt: evidenceAttempt(1, 2),
      },
    ])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(pending, [
      {
        type: "evidence_requested",
        timestamp: NOW,
        sessionId: "session-1",
        attempt: evidenceAttempt(2, 1),
      },
    ])).toThrow("generation must advance monotonically");

    const settled = foldOf(created, confirm, {
      type: "evidence_requested",
      timestamp: NOW,
      sessionId: "session-1",
      attempt: first,
    }, {
      type: "evidence_settled",
      timestamp: NOW,
      sessionId: "session-1",
      requestId: first.requestId,
      settlement: "deferred",
    });
    expect(() => assertAdvancementEventBatchLegal(settled, [
      {
        type: "evidence_requested",
        timestamp: NOW,
        sessionId: "session-1",
        attempt: evidenceAttempt(1, 2),
      },
    ])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(settled, [
      {
        type: "evidence_requested",
        timestamp: NOW,
        sessionId: "session-1",
        attempt: evidenceAttempt(1, 3),
      },
    ])).toThrow("generation must advance monotonically");
    expect(() => assertAdvancementEventBatchLegal(settled, [
      {
        type: "evidence_requested",
        timestamp: NOW,
        sessionId: "session-1",
        attempt: evidenceAttempt(2, 1),
      },
    ])).not.toThrow();
  });

  it("拒绝没有 pending 绑定的取证结果和结算", () => {
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [{
      type: "evidence_result",
      timestamp: NOW,
      sessionId: "session-1",
      requestId: "evidence:unknown",
      outcome: { kind: "capability-gap" },
    }])).toThrow("does not bind a pending request");
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [{
      type: "evidence_settled",
      timestamp: NOW,
      sessionId: "session-1",
      requestId: "evidence:unknown",
      settlement: "deferred",
    }])).toThrow("does not bind a pending request");
  });
});

function evidenceAttempt(
  generation: number,
  attempt: number,
): AdvancementEvidenceAttempt {
  const reviewId = "review-evidence";
  const requestId = advancementEvidenceRequestId(reviewId, generation, attempt);
  const request = {
    v: 1,
    requestId,
    reviewId,
    runId: "run-1",
    conversationId: "conv-1",
    ownerEpoch: 1,
    executorId: "executor-1",
    workspace: { bindingRef: "workspace-1", workspaceBindingRevision: 1 },
    items: [{ kind: "log", locator: { paths: ["logs/run.log"] } }],
    lease: {
      workload: { kind: "evidence", id: requestId, attempt: generation },
    },
    issuedAt: NOW,
    expiry: NOW,
    signature: { alg: "test", keyId: "test", sig: "test" },
  } as unknown as AdvancementEvidenceAttempt["request"];
  return {
    requestId,
    reviewId,
    generation,
    attempt,
    request,
    itemRequirements: [],
    requestDigest: evidenceRequestDigest(request),
  };
}
