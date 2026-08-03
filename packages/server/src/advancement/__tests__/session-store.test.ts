import { describe, expect, it } from "vitest";
import {
  advancementHeadSession,
  applyAdvancementEvent,
  assertAdvancementEventBatchLegal,
  freezeAdvancementSessions,
  type AdvancementControlEvent,
  type AdvancementExit,
  type AdvancementFoldMap,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type ConfirmedRubricSnapshot,
  type CreateAdvancementSessionInput,
  type RubricContractDraftSnapshot,
  type UserTurnInput,
} from "@zhixing/core";
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
  return { port, writes };
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

function makeStore(): { store: AdvancementSessionStore; writes: unknown[] } {
  const { port, writes } = createFakePort();
  return {
    store: new SessionAdvancementStore({ port: () => port, now: () => NOW }),
    writes,
  };
}

describe("SessionAdvancementStore", () => {
  it("构造与文件控制日志一致的事件序列", async () => {
    const { store, writes } = makeStore();
    await store.createSession(createInput());
    await store.confirmRubric("conv-1", "session-1", confirmed());
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
      review({ id: "review-2", decision: "passed", proxyMessageId: undefined }),
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

  it("settle 幂等早退：已结算的 proxy 不再产生写入", async () => {
    const { store, writes } = makeStore();
    await store.createSession(createInput());
    await store.confirmRubric("conv-1", "session-1", confirmed());
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

  it("removeConversation 与 sweepOrphanDirs 不再承载独立清理对象", async () => {
    const { store } = makeStore();
    await expect(store.removeConversation("conv-1")).resolves.toBeUndefined();
    await expect(
      store.sweepOrphanDirs(async () => false),
    ).resolves.toEqual({ scanned: 0, removed: 0, warnings: [] });
  });
});
