import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { advancementLogPath } from "../paths.js";
import { AdvancementStore } from "../store.js";
import type {
  AdvancementExit,
  AdvancementRunReview,
  AdvancementWindowState,
  ConfirmedRubricSnapshot,
  CreateAdvancementSessionInput,
  RubricContractDraftSnapshot,
} from "../types.js";
import type { Message } from "../../types/messages.js";
import { protocolDigest } from "../../protocol/index.js";

function task(text: string) {
  return { parts: [{ type: "text" as const, text }] };
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
      evidenceRequirements: [
        {
          id: "tests",
          kind: "test-result",
          description: "测试结果需要通过",
          required: true,
        },
      ],
      failureHandling: [
        {
          id: "fix-tests",
          scenario: "测试失败",
          reply: "请修复失败测试后再继续。",
        },
      ],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function confirmed(): ConfirmedRubricSnapshot {
  const content = draft().content;
  return {
    source: {
      kind: "library",
      rubricId: "rubric-code-review",
      rubricVersion: "v1",
    },
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
    confirmedAt: "2026-01-01T00:01:00.000Z",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function originalTaskAdmissionIntent() {
  return {
    turnId: "turn-1",
    surfacePrincipal: "surface:test",
    turnOrigin: { channel: "rpc" as const, triggeredBy: "surface:test" },
    inputDigest: protocolDigest(
      "AdvancementOriginalTaskInput",
      1,
      createInput().originalUserTask,
    ),
  };
}

function review(extra: Partial<AdvancementRunReview> = {}): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 0,
    runRecordRef: { shardId: "000001", runIndex: 0 },
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: [
      {
        id: "evidence-1",
        requirementId: "tests",
        kind: "test-result",
        summary: "仍有 1 个测试失败",
        source: "independent",
        passed: false,
      },
    ],
    attribution: {
      criteria: [
        {
          criterionId: "pc-1",
          verdict: "unmet",
          reason: "仍有 1 个测试失败",
          evidenceExcerpt: "vitest: 1 failed",
        },
        { criterionId: "pc-2", verdict: "met", reason: "实现已覆盖需求点" },
      ],
    },
    unmetCriteria: ["测试通过"],
    selectedFailureHandlingId: "fix-tests",
    ...extra,
  };
}

function exit(reason: AdvancementExit["reason"]): AdvancementExit {
  return {
    reason,
    message: "验收通过",
    occurredAt: "2026-01-01T00:05:00.000Z",
  };
}

function message(role: Message["role"], text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

function windowState(): AdvancementWindowState {
  return {
    source: "advancement-window",
    reviewCount: 1,
    updatedAt: "2026-01-01T00:02:30.000Z",
    entries: [
      {
        kind: "review",
        reviewId: "review-1",
        runIndex: 0,
        messages: [
          message("user", "review-1 未满足测试通过"),
          message("assistant", "继续要求修复失败测试"),
        ],
      },
    ],
    lastSnapshot: {
      source: "advancement-window",
      priorReviewCount: 0,
      inputMessageCount: 0,
      outputMessageCount: 0,
      decision: { kind: "pass", reason: "test" },
    },
  };
}

async function makeStore() {
  const root = path.join(await createTempDir("advancement-store"), "advancement");
  return { root, store: new AdvancementStore(root) };
}

describe("AdvancementStore", () => {
  it("重放控制日志得到草案、确认、review、proxy 与完成状态", async () => {
    const { root, store } = await makeStore();

    let session = await store.createSession(createInput());
    expect(session.status).toBe("awaiting-rubric-confirmation");
    expect(session.pendingRubricDraft?.title).toBe("代码审查推进准则");
    expect(session.confirmedRubric).toBeUndefined();

    session = await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
      "2026-01-01T00:01:00.000Z",
    );
    expect(session.status).toBe("active");
    expect(session.pendingRubricDraft).toBeUndefined();
    expect(session.confirmedRubric?.source).toEqual({
      kind: "library",
      rubricId: "rubric-code-review",
      rubricVersion: "v1",
    });

    session = await store.appendRunReview(
      "conv-1",
      "session-1",
      review({ proxyMessageId: "proxy-1" }),
      "2026-01-01T00:02:00.000Z",
    );
    expect(session.runs).toHaveLength(1);

    session = await store.enqueueProxyMessage(
      "conv-1",
      "session-1",
      {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-1",
        content: task("请修复失败测试后再继续。"),
        rubricFailureHandlingId: "fix-tests",
        variables: { failedTests: "1" },
        attribution: review().attribution,
        createdAt: "2026-01-01T00:03:00.000Z",
      },
      "2026-01-01T00:03:00.000Z",
    );
    expect(session.outstandingProxyMessageId).toBe("proxy-1");

    session = await store.settleProxyMessage(
      "conv-1",
      "session-1",
      "proxy-1",
      "2026-01-01T00:04:00.000Z",
    );
    expect(session.outstandingProxyMessageId).toBeUndefined();
    const settledReplay = await store.settleProxyMessage(
      "conv-1",
      "session-1",
      "proxy-1",
      "2026-01-01T00:04:30.000Z",
    );
    expect(settledReplay.outstandingProxyMessageId).toBeUndefined();

    session = await store.appendRunReview("conv-1", "session-1", {
      id: "review-2",
      runIndex: 1,
      runRecordRef: { shardId: "000001", runIndex: 1 },
      reviewedAt: "2026-01-01T00:04:45.000Z",
      decision: "passed",
      evidence: [],
      attribution: {
        criteria: confirmed().content.passCriteria.map((criterion) => ({
          criterionId: criterion.id,
          verdict: "met",
          reason: "验收通过",
        })),
      },
      unmetCriteria: [],
    });

    session = await store.completeSession(
      "conv-1",
      "session-1",
      exit("passed"),
      "2026-01-01T00:05:00.000Z",
    );
    expect(session.status).toBe("completed");
    expect(await store.loadActiveSession("conv-1")).toBeNull();
    expect(
      (
        await store.settleProxyMessage(
          "conv-1",
          "session-1",
          "proxy-1",
          "2026-01-01T00:05:30.000Z",
        )
      ).status,
    ).toBe("completed");

    const reopened = new AdvancementStore(root);
    const replayed = await reopened.loadSession("conv-1", "session-1");
    expect(replayed?.status).toBe("completed");
    expect(replayed?.runs[0]?.runRecordRef).toEqual({
      shardId: "000001",
      runIndex: 0,
    });
    expect(replayed?.proxyMessages[0]?.content).toEqual(
      task("请修复失败测试后再继续。"),
    );
    expect(await reopened.readEvents("conv-1")).toHaveLength(7);
  });

  it("拒绝同一 conversation 同时存在多个 open session", async () => {
    const { store } = await makeStore();
    await store.createSession(createInput());

    await expect(
      store.createSession(
        createInput({
          id: "session-2",
          pendingRubricDraft: draft("draft-2"),
        }),
      ),
    ).rejects.toThrow(/open advancement session/);
  });

  it("同一 active session 同时只能有一条 outstanding proxy", async () => {
    const { store } = await makeStore();
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
      review({ proxyMessageId: "proxy-1" }),
      {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-1",
        content: task("继续修复"),
        rubricFailureHandlingId: "fix-tests",
        variables: {},
        attribution: review().attribution,
        createdAt: "2026-01-01T00:03:00.000Z",
      },
    );

    await expect(
      store.enqueueProxyMessage("conv-1", "session-1", {
        id: "proxy-2",
        sessionId: "session-1",
        reviewId: "review-2",
        content: task("再次继续"),
        rubricFailureHandlingId: "fix-tests",
        variables: {},
        attribution: review().attribution,
        createdAt: "2026-01-01T00:04:00.000Z",
      }),
    ).rejects.toThrow(/outstanding proxy/);
  });

  it("失败 review 与代理消息作为同一个推进结果原子写入", async () => {
    const { store } = await makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );

    const session = await store.appendRunReviewWithProxyMessage(
      "conv-1",
      "session-1",
      review({ proxyMessageId: "proxy-1" }),
      {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-1",
        content: task("请修复失败测试后再继续。"),
        rubricFailureHandlingId: "fix-tests",
        variables: { unmet_criteria: "测试通过" },
        attribution: review().attribution,
        createdAt: "2026-01-01T00:03:00.000Z",
      },
      "2026-01-01T00:02:00.000Z",
    );

    expect(session.runs[0]?.proxyMessageId).toBe("proxy-1");
    expect(session.outstandingProxyMessageId).toBe("proxy-1");
    expect((await store.readEvents("conv-1")).map((event) => event.type)).toEqual([
      "session_created",
      "rubric_confirmed",
      "run_reviewed",
      "proxy_enqueued",
    ]);
  });

  it("review 与推进窗口状态作为同一个验收结果持久化并可重放", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );
    const advancementWindow = windowState();

    const session = await store.appendRunReviewWithProxyMessage(
      "conv-1",
      "session-1",
      review({ proxyMessageId: "proxy-1" }),
      {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-1",
        content: task("请修复失败测试后再继续。"),
        rubricFailureHandlingId: "fix-tests",
        variables: { unmet_criteria: "测试通过" },
        attribution: review().attribution,
        createdAt: "2026-01-01T00:03:00.000Z",
      },
      "2026-01-01T00:02:00.000Z",
      advancementWindow,
    );

    expect(session.advancementWindow).toEqual(advancementWindow);
    expect((await store.readEvents("conv-1")).map((event) => event.type)).toEqual([
      "session_created",
      "rubric_confirmed",
      "run_reviewed",
      "window_updated",
      "proxy_enqueued",
    ]);

    const replayed = await new AdvancementStore(root).loadSession(
      "conv-1",
      "session-1",
    );
    expect(replayed?.advancementWindow).toEqual(advancementWindow);
  });

  it("终态 review 与 completed/exited 作为同一个验收结果写入", async () => {
    const { store } = await makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );

    const session = await store.appendTerminalRunReview(
      "conv-1",
      "session-1",
      review({ decision: "passed", unmetCriteria: [] }),
      {
        type: "completed",
        exit: exit("passed"),
        timestamp: "2026-01-01T00:05:00.000Z",
      },
      "2026-01-01T00:02:00.000Z",
    );

    expect(session.status).toBe("completed");
    expect(session.runs).toHaveLength(1);
    expect(await store.loadActiveSession("conv-1")).toBeNull();
    expect((await store.readEvents("conv-1")).map((event) => event.type)).toEqual([
      "session_created",
      "rubric_confirmed",
      "run_reviewed",
      "completed",
    ]);
  });

  it("拒绝终态事件与 review decision 不一致", async () => {
    const { store } = await makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );

    await expect(
      store.appendTerminalRunReview(
        "conv-1",
        "session-1",
        review({ decision: "failed" }),
        { type: "completed", exit: exit("passed") },
      ),
    ).rejects.toThrow(/completed review/);

    await expect(
      store.appendTerminalRunReview(
        "conv-1",
        "session-1",
        review({ decision: "passed", unmetCriteria: [] }),
        { type: "exited", exit: exit("system-error") },
      ),
    ).rejects.toThrow(/exited review/);
  });

  it("待确认 session 可以被取消且不再作为 active session 返回", async () => {
    const { store } = await makeStore();
    await store.createSession(createInput());

    const cancelled = await store.cancelSession("conv-1", "session-1", {
      reason: "user-cancelled",
      message: "用户取消 Rubric 确认",
      occurredAt: "2026-01-01T00:01:00.000Z",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.exit?.reason).toBe("user-cancelled");
    expect(await store.loadActiveSession("conv-1")).toBeNull();
  });

  it("待确认 session 可以修订 Rubric 草案并在重放后保留最新版", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());

    const revised = await store.reviseRubricDraft(
      "conv-1",
      "session-1",
      {
        ...draft("draft-revised"),
        title: "修订后的推进准则",
        content: {
          ...draft().content,
          passCriteria: ["测试通过", "文档说明已更新"],
        },
      },
      "2026-01-01T00:01:00.000Z",
    );

    expect(revised.status).toBe("awaiting-rubric-confirmation");
    expect(revised.rubricDraftVersion).toBe(1);
    expect(revised.pendingRubricDraft?.draftId).toBe("draft-revised");
    expect(revised.pendingRubricDraft?.content.passCriteria).toContain(
      "文档说明已更新",
    );

    const reopened = new AdvancementStore(root);
    const replayed = await reopened.loadSession("conv-1", "session-1");
    expect(replayed?.rubricDraftVersion).toBe(1);
    expect(replayed?.pendingRubricDraft?.title).toBe("修订后的推进准则");
  });

  it("拒绝在非 active session 上记录验收、代理消息和结束事件", async () => {
    const { store } = await makeStore();
    await store.createSession(createInput());

    await expect(
      store.appendRunReview("conv-1", "session-1", review()),
    ).rejects.toThrow(/not active/);
    await expect(
      store.enqueueProxyMessage("conv-1", "session-1", {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-1",
        content: task("继续修复"),
        rubricFailureHandlingId: "fix-tests",
        variables: {},
        createdAt: "2026-01-01T00:03:00.000Z",
      }),
    ).rejects.toThrow(/not active/);
    await expect(
      store.completeSession("conv-1", "session-1", exit("passed")),
    ).rejects.toThrow(/not active/);
    await expect(
      store.exitSession("conv-1", "session-1", exit("dead-end")),
    ).rejects.toThrow(/not active/);
    await expect(
      store.appendTerminalRunReview("conv-1", "session-1", review(), {
        type: "exited",
        exit: exit("system-error"),
      }),
    ).rejects.toThrow(/not active/);
  });

  it("重放时隔离坏行和不完整事件", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());

    await fs.appendFile(
      advancementLogPath(root, "conv-1"),
      [
        "{bad json",
        JSON.stringify({
          type: "run_reviewed",
          timestamp: "2026-01-01T00:02:00.000Z",
          sessionId: "session-1",
        }),
        "",
      ].join("\n"),
    );

    const replayed = await new AdvancementStore(root).loadSession(
      "conv-1",
      "session-1",
    );
    expect(replayed?.status).toBe("awaiting-rubric-confirmation");
    expect(replayed?.runs).toEqual([]);
    expect(await store.readEvents("conv-1")).toHaveLength(1);
  });

  it("removeConversation 删除整个控制日志目录且幂等", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());
    const dir = path.dirname(advancementLogPath(root, "conv-1"));
    await expect(fs.stat(dir)).resolves.toBeDefined();

    await store.removeConversation("conv-1");
    await expect(fs.stat(dir)).rejects.toThrow();
    await expect(store.removeConversation("conv-1")).resolves.toBeUndefined();
    expect(await store.loadSession("conv-1", "session-1")).toBeNull();
  });

  it("只提供有限孤儿候选枚举和单候选删除机制", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());
    await store.createSession(
      createInput({ id: "session-2", conversationId: "conv-2" }),
    );

    await expect(store.listConversationDataCandidates()).resolves.toEqual([
      "conv-1",
      "conv-2",
    ]);
    await store.removeConversationDataCandidate("conv-2");
    expect(await store.loadSession("conv-1", "session-1")).not.toBeNull();
    expect(await store.loadSession("conv-2", "session-2")).toBeNull();
    await expect(
      store.removeConversationDataCandidate("../foreign"),
    ).rejects.toThrow("single path segment");
  });

  it("重放时隔离未条目化的旧形状 rubric_confirmed，会话干净退回待确认", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());

    const legacyRubric = {
      rubricId: "rubric-legacy",
      rubricVersion: "v0",
      title: "旧版准则",
      description: "升级前确认的准则",
      content: {
        passCriteria: ["测试通过", "实现满足需求"],
        evidenceRequirements: [],
        failureHandling: [
          { id: "fix", scenario: "测试失败", reply: "请修复。" },
        ],
      },
      confirmedAt: "2026-01-01T00:01:00.000Z",
      confirmedBy: "user",
    };
    await fs.appendFile(
      advancementLogPath(root, "conv-1"),
      `${JSON.stringify({
        type: "rubric_confirmed",
        timestamp: "2026-01-01T00:01:00.000Z",
        sessionId: "session-1",
        confirmedRubric: legacyRubric,
      })}\n`,
    );

    const replayed = await new AdvancementStore(root).loadSession(
      "conv-1",
      "session-1",
    );
    expect(replayed?.status).toBe("awaiting-rubric-confirmation");
    expect(replayed?.confirmedRubric).toBeUndefined();
    expect(replayed?.pendingRubricDraft).toBeDefined();
  });

  it("重放时隔离缺少归因的旧形状 review 与 proxy 事件", async () => {
    const { root, store } = await makeStore();
    await store.createSession(createInput());
    await store.confirmRubric(
      "conv-1",
      "session-1",
      confirmed(),
      originalTaskAdmissionIntent(),
    );

    const { attribution: _dropReview, ...legacyReview } = review();
    const legacyProxy = {
      id: "proxy-legacy",
      sessionId: "session-1",
      reviewId: "review-1",
      content: task("继续修复。"),
      rubricFailureHandlingId: "fix-tests",
      variables: {},
      createdAt: "2026-01-01T00:03:00.000Z",
    };
    await fs.appendFile(
      advancementLogPath(root, "conv-1"),
      [
        JSON.stringify({
          type: "run_reviewed",
          timestamp: "2026-01-01T00:02:00.000Z",
          sessionId: "session-1",
          review: legacyReview,
        }),
        JSON.stringify({
          type: "proxy_enqueued",
          timestamp: "2026-01-01T00:03:00.000Z",
          sessionId: "session-1",
          proxyMessage: legacyProxy,
        }),
        "",
      ].join("\n"),
    );

    const replayed = await new AdvancementStore(root).loadSession(
      "conv-1",
      "session-1",
    );
    expect(replayed?.runs).toEqual([]);
    expect(replayed?.proxyMessages).toEqual([]);
    expect(replayed?.outstandingProxyMessageId).toBeUndefined();
  });
});
