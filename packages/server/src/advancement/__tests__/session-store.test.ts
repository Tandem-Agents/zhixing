import { describe, expect, it } from "vitest";
import {
  advancementHeadSession,
  advancementReviewAttemptId,
  advancementReviewLineageId,
  applyAdvancementEvent,
  assertAdvancementEventBatchLegal,
  freezeAdvancementSessions,
  type AdvancementControlEvent,
  type AdvancementExit,
  type AdvancementFoldMap,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type AdvancementReviewAttempt,
  type ConfirmedRubricSnapshot,
  type CreateAdvancementSessionInput,
  type RubricContractDraftSnapshot,
  type UserTurnInput,
} from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import type {
  AuthorityCallContext,
  SessionControlMutation,
  SessionStatePort,
  SessionStagedMutation,
} from "@zhixing/core/contracts";
import {
  SessionAdvancementStore,
  type AdvancementSessionStore,
} from "@zhixing/owner-services";

const NOW = "2026-08-02T00:00:00.000Z";

/** 内存权威——与权威日志同一折叠与批次谓词，不含存储与签名层。 */
function createFakePort() {
  const folds = new Map<string, AdvancementFoldMap>();
  const writes: Array<{ conversationId: string; events: readonly AdvancementControlEvent[] }> = [];
  let failNextResponse = false;
  const port: SessionStatePort = {
    async readAdvancementState(conversationId) {
      const fold = folds.get(conversationId) ?? new Map();
      return advancementHeadSession(freezeAdvancementSessions(fold));
    },
    async mutate(
      conversationId: string,
      mutation: SessionControlMutation | SessionStagedMutation,
      _ctx: AuthorityCallContext,
    ) {
      if (mutation.kind !== "advancement-event") {
        throw new Error("unsupported mutation");
      }
      const fold = folds.get(conversationId) ?? new Map();
      assertAdvancementEventBatchLegal(fold, mutation.events);
      for (const event of mutation.events) {
        applyAdvancementEvent(fold, event);
      }
      folds.set(conversationId, fold);
      writes.push({ conversationId, events: mutation.events });
      if (failNextResponse) {
        failNextResponse = false;
        throw new Error("simulated committed response loss");
      }
      return { revision: writes.length };
    },
    readSessionMeta() {
      throw new Error("unimplemented");
    },
    readTranscriptTail() {
      throw new Error("unimplemented");
    },
    readTaskList() {
      throw new Error("unimplemented");
    },
  };
  return {
    port,
    writes,
    failNextResponse() {
      failNextResponse = true;
    },
  };
}

function task(text: string): UserTurnInput {
  return { parts: [{ type: "text", text }] };
}

function draft(id = "draft-1"): RubricContractDraftSnapshot {
  return {
    draftId: id,
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title: "代码审查推进准则",
    description: "用于判断开发任务是否完成",
    content: {
      passCriteria: ["测试通过", "实现满足需求"],
      evidenceRequirements: [],
      failureHandling: [
        { id: "fix-tests", scenario: "测试失败", reply: "请修复失败测试。" },
      ],
    },
    createdAt: NOW,
  };
}

function confirmed(): ConfirmedRubricSnapshot {
  const content = draft().content;
  return {
    source: { kind: "library", rubricId: "rubric-1", rubricVersion: "v1" },
    title: "代码审查推进准则",
    description: "用于判断开发任务是否完成",
    content: {
      passCriteria: content.passCriteria.map((text, index) => ({
        id: `pc-${index + 1}`,
        text,
      })),
      evidenceRequirements: content.evidenceRequirements,
      failureHandling: content.failureHandling,
    },
    confirmedAt: NOW,
    confirmedBy: "user",
  };
}

function createInput(
  extra: Partial<CreateAdvancementSessionInput> = {},
): CreateAdvancementSessionInput {
  return {
    id: "session-1",
    conversationId: "conv-1",
    originalUserTask: task("把测试修到全绿"),
    pendingRubricDraft: draft(),
    createdAt: NOW,
    ...extra,
  };
}

function originalTaskAdmissionIntent() {
  return {
    turnId: "turn-1",
    surfacePrincipal: "surface:user-1",
    turnOrigin: { channel: "rpc" as const, triggeredBy: "surface:user-1" },
    inputDigest: protocolDigest(
      "AdvancementOriginalTaskInput",
      1,
      createInput().originalUserTask,
    ),
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
    selectedFailureHandlingId: "fix-tests",
    proxyMessageId: "proxy-1",
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as AdvancementRunReview;
}

function proxyMessage(
  extra: Partial<AdvancementProxyMessage> = {},
): AdvancementProxyMessage {
  return {
    id: "proxy-1",
    sessionId: "session-1",
    reviewId: "review-1",
    content: task("请继续修复失败测试"),
    rubricFailureHandlingId: "fix-tests",
    variables: {},
    attribution: { criteria: [] },
    createdAt: NOW,
    ...extra,
  };
}

function exit(reason: AdvancementExit["reason"]): AdvancementExit {
  return { reason, message: "收场", occurredAt: NOW };
}

function makeStore(): {
  store: AdvancementSessionStore;
  writes: unknown[];
  failNextResponse(): void;
} {
  const { port, writes, failNextResponse } = createFakePort();
  return {
    store: new SessionAdvancementStore({ port: () => port, now: () => NOW }),
    writes,
    failNextResponse,
  };
}

function reviewAttempt(
  phase: AdvancementReviewAttempt["phase"],
): AdvancementReviewAttempt {
  const runRecordRef = { shardId: "shard-1", runIndex: 0 };
  const lineageId = advancementReviewLineageId("session-1", runRecordRef);
  const id = advancementReviewAttemptId(lineageId, 1);
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
  return {
    lineageId,
    generation: 1,
    runId: "accepted-run:shard-1:0",
    runIndex: 0,
    runRecordRef,
    phase,
    root,
    ...(phase === "started"
      ? {}
      : {
          rootLease: {
            ...unsignedLease,
            digest: protocolDigest("ResourceLease", 1, unsignedLease),
            signature: { alg: "test", keyId: "test", sig: "test" },
          },
        }),
  };
}

describe("SessionAdvancementStore", () => {
  it("原任务准入意向与结清 runId 由同一 owner 日志耐久投影", async () => {
    const { store } = makeStore();
    const original = createInput();
    await store.createSession(original);
    const inputDigest = protocolDigest(
      "AdvancementOriginalTaskInput",
      1,
      original.originalUserTask,
    );
    const active = await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      {
        turnId: "turn-1",
        surfacePrincipal: "surface:user-1",
        turnOrigin: { channel: "rpc", triggeredBy: "surface:user-1" },
        inputDigest,
      },
      NOW,
    );
    expect(active.originalTaskAdmission).toEqual({
      status: "pending",
      intent: expect.objectContaining({ inputDigest, turnId: "turn-1" }),
    });

    const settled = await store.settleOriginalTaskAdmission(
      "conv-1",
      "session-1",
      { turnId: "turn-1", inputDigest, runId: "run-1" },
    );
    expect(settled.originalTaskAdmission).toEqual({
      status: "admitted",
      intent: expect.objectContaining({ inputDigest, turnId: "turn-1" }),
      runId: "run-1",
    });
  });

  it("构造与文件控制日志一致的事件序列", async () => {
    const { store, writes } = makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );
    await store.appendRunReviewWithProxyMessage(
      "conv-1",
      "session-1",
      review(),
      proxyMessage(),
    );
    await store.settleProxyMessage("conv-1", "session-1", "proxy-1");
    await store.appendTerminalRunReview(
      "conv-1",
      "session-1",
      review({
        id: "review-2",
        runIndex: 1,
        decision: "passed",
        proxyMessageId: undefined,
      }),
      { type: "completed", exit: exit("passed") },
    );

    const types = (writes as Array<{ events: Array<{ type: string }> }>).flatMap(
      (write) => write.events.map((event) => event.type),
    );
    expect(types).toEqual([
      "session_created",
      "rubric_confirmed",
      "run_reviewed",
      "proxy_enqueued",
      "proxy_settled",
      "run_reviewed",
      "completed",
    ]);
  });

  it("稳定 review-attempt 写在提交响应丢失后以权威投影确认", async () => {
    const { store, failNextResponse } = makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );

    const started = reviewAttempt("started");
    failNextResponse();
    const afterStarted = await store.transitionReviewAttempt(
      "conv-1",
      "session-1",
      started,
    );
    expect(afterStarted.reviewAttempts?.[0]?.phase).toBe("started");

    const invoking = reviewAttempt("invoking");
    failNextResponse();
    const afterInvoking = await store.transitionReviewAttempt(
      "conv-1",
      "session-1",
      invoking,
    );
    expect(afterInvoking.reviewAttempts?.[0]?.phase).toBe("invoking");

    const consumed = reviewAttempt("consumed");
    failNextResponse();
    const completed = await store.appendTerminalRunReview(
      "conv-1",
      "session-1",
      review({
        decision: "passed",
        unmetCriteria: [],
        selectedFailureHandlingId: undefined,
        proxyMessageId: undefined,
        runRecordRef: { shardId: "shard-1", runIndex: 0 },
      }),
      { type: "completed", exit: exit("passed") },
      NOW,
      undefined,
      undefined,
      consumed,
    );
    expect(completed.status).toBe("completed");
    expect(completed.reviewAttempts?.[0]?.phase).toBe("consumed");
  });

  it("settle 幂等早退：已结算的 proxy 不再产生写入", async () => {
    const { store, writes } = makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );
    await store.appendRunReviewWithProxyMessage(
      "conv-1",
      "session-1",
      review(),
      proxyMessage(),
    );
    const before = (writes as unknown[]).length;
    await store.settleProxyMessage("conv-1", "session-1", "proxy-1");
    expect((writes as unknown[]).length).toBe(before + 1);
    const session = await store.settleProxyMessage("conv-1", "session-1", "proxy-1");
    expect((writes as unknown[]).length).toBe(before + 1);
    expect(session.outstandingProxyMessageId).toBeUndefined();
  });

  it("读取头状态：open 优先、latest 兜底、loadSession 按 id 精确", async () => {
    const { store } = makeStore();
    expect(await store.loadActiveSession("conv-1")).toBeNull();
    expect(await store.loadConversationSessions("conv-1")).toEqual([]);

    await store.createSession(createInput());
    expect((await store.loadActiveSession("conv-1"))?.id).toBe("session-1");
    expect(await store.loadSession("conv-1", "session-2")).toBeNull();

    await store.cancelSession("conv-1", "session-1", exit("user-cancelled"));
    const latest = await store.loadConversationSessions("conv-1");
    expect(latest).toHaveLength(1);
    expect(latest[0]?.status).toBe("cancelled");
    expect(await store.loadActiveSession("conv-1")).toBeNull();
  });

  it("removeConversation 与孤儿候选机制不再承载独立清理对象", async () => {
    const { store } = makeStore();
    await expect(store.removeConversation("conv-1")).resolves.toBeUndefined();
    await expect(store.listConversationDataCandidates()).resolves.toEqual([]);
    await expect(
      store.removeConversationDataCandidate("candidate-1"),
    ).resolves.toBeUndefined();
  });
});
