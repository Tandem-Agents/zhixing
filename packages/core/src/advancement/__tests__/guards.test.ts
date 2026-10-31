import { describe, expect, it } from "vitest";
import { assertAdvancementEventBatchLegal } from "../guards.js";
import { advancementEvidenceRequestId } from "../evidence-identity.js";
import {
  advancementReviewAttemptId,
  advancementReviewAttemptMutationId,
  advancementReviewLineageId,
} from "../review-attempt-identity.js";
import { applyAdvancementEvent, type AdvancementFoldMap } from "../reducer.js";
import {
  advancementProposalExecution,
  advancementProposalId,
  advancementProposalSessionId,
} from "../proposal-identity.js";
import { evidenceRequestDigest, protocolDigest } from "../../protocol/index.js";
import type { TurnOrigin } from "../../types/tools.js";
import type {
  AdvancementEvidenceAttempt,
  AdvancementControlEvent,
  AdvancementProxyMessage,
  AdvancementReviewAttempt,
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

  it("review attempt 只允许严格前进代际，并把 review 与 consumed 绑定", () => {
    const fold = activeFold();
    const started = reviewAttempt("started", 1);
    const startedEvent = reviewAttemptTransition(started);
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [
      reviewAttemptTransition({
        ...started,
        root: { ...started.root, requestId: "unstable-root-request" },
      }),
    ])).toThrow("does not bind its accepted run and root contract");
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [
      reviewAttemptTransition({
        ...started,
        root: {
          ...started.root,
          audience: { executorId: "executor-1" },
        },
      }),
    ])).toThrow("does not bind its accepted run and root contract");
    expect(() => assertAdvancementEventBatchLegal(fold, [startedEvent])).not.toThrow();
    applyAdvancementEvent(fold, startedEvent);

    expect(() =>
      assertAdvancementEventBatchLegal(fold, [reviewAttemptTransition(started)]),
    ).toThrow("generation must advance");

    const invoking = reviewAttempt("invoking", 1);
    const invokingEvent = reviewAttemptTransition(invoking);
    expect(() => assertAdvancementEventBatchLegal(fold, [invokingEvent])).not.toThrow();
    applyAdvancementEvent(fold, invokingEvent);

    const consumed = reviewAttempt("consumed", 1);
    expect(() =>
      assertAdvancementEventBatchLegal(fold, [reviewAttemptTransition(consumed)]),
    ).toThrow("requires its run review");

    const boundReview = {
      ...reviewed,
      review: review({
        decision: "passed",
        unmetCriteria: [],
        selectedFailureHandlingId: undefined,
        proxyMessageId: undefined,
        runRecordRef: { shardId: "shard-1", runIndex: 0 },
      }),
    } as AdvancementControlEvent;
    expect(() =>
      assertAdvancementEventBatchLegal(fold, [
        boundReview,
        reviewAttemptTransition(consumed),
      ]),
    ).not.toThrow();

    applyAdvancementEvent(fold, boundReview);
    expect(() =>
      assertAdvancementEventBatchLegal(fold, [reviewAttemptTransition(consumed)]),
    ).not.toThrow();
  });

  it("review attempt mutation identity 由代际与相位稳定派生", () => {
    const first = advancementReviewAttemptMutationId("lineage-1", 2, "invoking");
    expect(advancementReviewAttemptMutationId("lineage-1", 2, "invoking"))
      .toBe(first);
    expect(advancementReviewAttemptMutationId("lineage-1", 2, "deferred"))
      .not.toBe(first);
  });
});

function reviewAttempt(
  phase: AdvancementReviewAttempt["phase"],
  generation: number,
): AdvancementReviewAttempt {
  const runRecordRef = { shardId: "shard-1", runIndex: 0 };
  const lineageId = advancementReviewLineageId("session-1", runRecordRef);
  const id = advancementReviewAttemptId(lineageId, generation);
  const root = {
    workload: { kind: "control" as const, id, attempt: 1 },
    budget: { maxCalls: 8, maxTokens: 300_000 },
    requestId: `advancement-review-root:${id}`,
  };
  const unsignedLease = {
    v: 1 as const,
    reservationId: `reservation:${id}`,
    admissionClass: "advancement" as const,
    workload: root.workload,
    scopeBinding: { kind: "control" as const, subject: id },
    audience: { executorId: "executor-1" },
    budget: root.budget,
    domain: { kind: "anchor" as const, anchorEpoch: 1 },
    issuedAt: NOW,
    expiry: "2026-08-02T01:00:00.000Z",
  };
  const rootLease = {
    ...unsignedLease,
    digest: protocolDigest("ResourceLease", 1, unsignedLease),
    signature: { alg: "test", keyId: "test", sig: "test" },
  };
  return {
    lineageId,
    generation,
    runId: "accepted-run:shard-1:0",
    runIndex: 0,
    runRecordRef,
    phase,
    root,
    ...(phase === "started" ? {} : { rootLease }),
  };
}

function reviewAttemptTransition(
  attempt: AdvancementReviewAttempt,
): AdvancementControlEvent {
  return {
    type: "review_attempt_transitioned",
    timestamp: NOW,
    sessionId: "session-1",
    attempt,
  };
}

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

describe("主 Agent 提议形成的推进会话", () => {
  const proposalId = advancementProposalId("conv-1", "run-1");
  const sessionId = advancementProposalSessionId(proposalId);
  const accepted: AdvancementControlEvent = {
    type: "proposal_accepted",
    timestamp: NOW,
    sessionId,
    conversationId: "conv-1",
    proposalId,
    runId: "run-1",
    originalTurnId: "turn-1",
    originalUserTask: task("原任务"),
  };
  const attempt = (phase: "invoking" | "consumed" | "failed" | "deferred", generation = 1, revision = 0): AdvancementControlEvent =>
    ({ type: "draft_attempt_transitioned", timestamp: NOW, sessionId, attempt: { generation, revision, phase } });
  const drafted = (revision = 0): AdvancementControlEvent =>
    ({ type: "proposal_drafted", timestamp: NOW, sessionId, revision, pendingRubricDraft: draft() });
  const supplement: AdvancementControlEvent = { type: "proposal_supplemented", timestamp: NOW, sessionId, supplement: task("补充") };
  const receipt = (outcome: Record<string, unknown>): AdvancementControlEvent => ({
    type: "submission_settled",
    timestamp: NOW,
    conversationId: "conv-1",
    receipt: { identity: { surfacePrincipal: "surface:test", submissionId: "s-1", requestDigest: `sha256:${"0".repeat(64)}` }, outcome } as never,
  });

  it("接受：身份由会话与运行派生；已有未终结会话时只能记为未被接受（单条事件、直接终结）", () => {
    expect(() => assertAdvancementEventBatchLegal(new Map(), [accepted])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(new Map(), [{ ...accepted, sessionId: "other" }])).toThrow(/bind its proposal/);
    expect(() => assertAdvancementEventBatchLegal(new Map(), [{ ...accepted, runId: "run-2" }])).toThrow(/bind its proposal/);
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [accepted])).toThrow();
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [accepted])).toThrow(/open advancement session/);
    const rejected: AdvancementControlEvent = { ...(accepted as Extract<AdvancementControlEvent, { type: "proposal_accepted" }>), type: "proposal_rejected",
      exit: { reason: "superseded", message: "未被接受", occurredAt: NOW } };
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [rejected])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(activeFold(), [{ ...rejected, exit: { reason: "user-cancelled", message: "x", occurredAt: NOW } } as AdvancementControlEvent])).toThrow(/superseded/);
    expect(foldOf(...[created, confirm, rejected]).get(sessionId)?.status).toBe("cancelled");
    expect(foldOf(accepted).get(sessionId)?.status).toBe("proposed");
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [created])).toThrow(/open advancement session/);
  });

  it("草案尝试只能从 proposed 起一代，结果须同代，草案须绑定已消费的尝试与当前补充数", () => {
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [attempt("consumed")])).toThrow(/draft attempt/);
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [attempt("invoking", 2)])).toThrow(/draft attempt/);
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [attempt("invoking", 1, 1)])).toThrow(/draft attempt/);
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [attempt("invoking")])).not.toThrow();
    const invoking = foldOf(accepted, attempt("invoking"));
    expect(invoking.get(sessionId)?.status).toBe("drafting");
    expect(() => assertAdvancementEventBatchLegal(invoking, [attempt("invoking", 2)])).toThrow(/draft attempt/);
    expect(() => assertAdvancementEventBatchLegal(invoking, [drafted()])).toThrow(/consumed attempt/);
    expect(() => assertAdvancementEventBatchLegal(invoking, [attempt("consumed"), drafted()])).not.toThrow();
    // 草案期间收到补充：用旧 revision 的草案被拒
    const supplemented = foldOf(accepted, attempt("invoking"), supplement);
    expect(() => assertAdvancementEventBatchLegal(supplemented, [attempt("consumed"), drafted(0)])).toThrow(/revision/);
    expect(() => assertAdvancementEventBatchLegal(supplemented, [attempt("consumed"), drafted(1)])).not.toThrow();
    expect(foldOf(accepted, attempt("invoking"), attempt("consumed"), drafted()).get(sessionId)?.status).toBe("awaiting-rubric-confirmation");
    expect(foldOf(accepted, attempt("invoking"), attempt("deferred")).get(sessionId)?.status).toBe("draft-uncertain");
    // 失败后补充回到 proposed，由下一代并入
    const failed = foldOf(accepted, attempt("invoking"), attempt("failed"));
    expect(failed.get(sessionId)?.status).toBe("draft-failed");
    const resumed = foldOf(accepted, attempt("invoking"), attempt("failed"), supplement);
    expect(resumed.get(sessionId)?.status).toBe("proposed");
    expect(() => assertAdvancementEventBatchLegal(resumed, [attempt("invoking", 2, 1)])).not.toThrow();
  });

  it("补充只在提议阶段；确认与降级绑定由提议派生的执行身份，不绑原文", () => {
    const awaiting = foldOf(accepted, attempt("invoking"), attempt("consumed"), drafted());
    expect(() => assertAdvancementEventBatchLegal(awaiting, [supplement])).toThrow(/open proposal/);
    const execution = advancementProposalExecution({ originalTurnId: "turn-1", mode: "advancement", draftId: "draft-1" });
    const marker = { sessionId, mode: "advancement" as const, draftId: "draft-1" };
    const intent = {
      turnId: execution.turnId,
      surfacePrincipal: "surface:test",
      turnOrigin: { channel: "rpc", triggeredBy: "surface:test", advancementExecution: marker } as TurnOrigin,
      inputDigest: protocolDigest("AdvancementOriginalTaskInput", 1, execution.input),
    };
    const confirmEvent = (admissionIntent: typeof intent): AdvancementControlEvent =>
      ({ type: "rubric_confirmed", timestamp: NOW, sessionId, confirmedRubric: confirmed(), admissionIntent });
    expect(() => assertAdvancementEventBatchLegal(awaiting, [confirmEvent(intent)])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(awaiting, [confirmEvent({ ...intent, turnId: "turn-1" })])).toThrow(/execution identity/);
    expect(() => assertAdvancementEventBatchLegal(awaiting, [confirmEvent({
      ...intent, inputDigest: protocolDigest("AdvancementOriginalTaskInput", 1, task("原任务")),
    })])).toThrow(/bind task content/);
    // 执行标记：提议会话必须带，且会话、模式、草案逐项一致
    for (const turnOrigin of [
      { channel: "rpc", triggeredBy: "surface:test" },
      { channel: "rpc", triggeredBy: "surface:test", advancementExecution: { ...marker, sessionId: "other-session" } },
      { channel: "rpc", triggeredBy: "surface:test", advancementExecution: { ...marker, draftId: "draft-2" } },
      { channel: "rpc", triggeredBy: "surface:test", advancementExecution: { sessionId, mode: "direct" as const } },
    ] as TurnOrigin[]) {
      expect(() => assertAdvancementEventBatchLegal(awaiting, [confirmEvent({ ...intent, turnOrigin })])).toThrow(/advancement execution/);
    }
    const direct = advancementProposalExecution({ originalTurnId: "turn-1", mode: "direct" });
    const directOrigin = { channel: "rpc", triggeredBy: "surface:test", advancementExecution: { sessionId, mode: "direct" as const } } as TurnOrigin;
    const directed: AdvancementControlEvent = {
      type: "original_task_directed",
      timestamp: NOW,
      sessionId,
      exit: { reason: "user-cancelled", message: "直接执行", occurredAt: NOW },
      admissionIntent: { ...intent, turnId: direct.turnId, turnOrigin: directOrigin, inputDigest: protocolDigest("AdvancementOriginalTaskInput", 1, direct.input) },
    };
    for (const fold of [foldOf(accepted), foldOf(accepted, attempt("invoking"), attempt("failed")), awaiting]) {
      expect(() => assertAdvancementEventBatchLegal(fold, [directed])).not.toThrow();
    }
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [{ ...directed, admissionIntent: { ...intent } }])).toThrow(/original task and principal/);
    expect(() => assertAdvancementEventBatchLegal(foldOf(accepted), [{
      ...directed, admissionIntent: { ...directed.admissionIntent, turnOrigin: { channel: "rpc", triggeredBy: "surface:test" } },
    } as AdvancementControlEvent])).toThrow(/advancement execution/);
  });

  it("提议阶段的两种回执绑定原始输入与修订数", () => {
    const open = foldOf(accepted);
    expect(() => assertAdvancementEventBatchLegal(open, [receipt({ kind: "proposal-kept", sessionId, originalTurnId: "turn-1" })])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(open, [receipt({ kind: "proposal-kept", sessionId, originalTurnId: "turn-2" })])).toThrow(/open proposal/);
    expect(() => assertAdvancementEventBatchLegal(open, [supplement, receipt({ kind: "proposal-supplemented", sessionId, originalTurnId: "turn-1", revision: 1 })])).not.toThrow();
    expect(() => assertAdvancementEventBatchLegal(open, [supplement, receipt({ kind: "proposal-supplemented", sessionId, originalTurnId: "turn-1", revision: 2 })])).toThrow(/open proposal/);
    const awaiting = foldOf(accepted, attempt("invoking"), attempt("consumed"), drafted());
    expect(() => assertAdvancementEventBatchLegal(awaiting, [receipt({ kind: "proposal-kept", sessionId, originalTurnId: "turn-1" })])).toThrow(/open proposal/);
  });
});
