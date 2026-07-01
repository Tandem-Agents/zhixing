import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AdvancementStore } from "@zhixing/core";
import type {
  AdvancementRunReview,
  AdvancementWindowState,
  ConfirmedRubricSnapshot,
  Message,
  RubricContractDraftSnapshot,
  RunRecordInput,
} from "@zhixing/core";
import { AdvancementController } from "../controller.js";

function task(text: string) {
  return { parts: [{ type: "text" as const, text }] };
}

function draft(): RubricContractDraftSnapshot {
  return {
    draftId: "draft-1",
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
  return {
    rubricId: "rubric-code-review",
    rubricVersion: "v1",
    title: "代码审查推进准则",
    description: "用于判断开发任务是否完成",
    content: draft().content,
    confirmedAt: "2026-01-01T00:01:00.000Z",
    confirmedBy: "user",
  };
}

function runRecord(): RunRecordInput {
  return {
    timestamp: "2026-01-01T00:02:00.000Z",
    messages: [
      { role: "user", content: [{ type: "text", text: "修测试" }] },
      { role: "assistant", content: [{ type: "text", text: "已修复" }] },
    ],
  };
}

function review(extra: Partial<AdvancementRunReview> = {}): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 0,
    runRecordRef: { shardId: "000001", runIndex: 0 },
    reviewedAt: "2026-01-01T00:03:00.000Z",
    decision: "failed",
    evidence: [],
    unmetCriteria: ["测试仍未全绿"],
    selectedFailureHandlingId: "fix-tests",
    ...extra,
  };
}

function message(role: Message["role"], text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

function windowState(
  reviewCount: number,
  reviewId = `review-${reviewCount}`,
): AdvancementWindowState {
  return {
    source: "advancement-window",
    reviewCount,
    updatedAt: "2026-01-01T00:03:30.000Z",
    entries: [
      {
        kind: "review",
        reviewId,
        runIndex: reviewCount - 1,
        messages: [
          message("user", reviewId),
          message("assistant", `window-${reviewCount}`),
        ],
      },
    ],
  };
}

async function makeActive(store: AdvancementStore): Promise<void> {
  await store.createSession({
    id: "session-1",
    conversationId: "conv-1",
    originalUserTask: task("把测试修到全绿"),
    pendingRubricDraft: draft(),
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await store.confirmRubric("conv-1", "session-1", confirmed());
}

async function makeStore() {
  const root = path.join(await createTempDir("server-advancement-controller"), "advancement");
  return new AdvancementStore(root);
}

describe("AdvancementController.afterTurnCommitted", () => {
  it("active 推进会话中用户接管会退出原推进闭环", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      admissionStrategy: {
        decide: vi.fn(async () => ({
          kind: "direct-task",
          action: "take-over-active",
          reason: "用户改变目标",
        })),
      },
      now: () => "2026-01-01T00:05:00.000Z",
    });

    const result = await controller.prepareUserTurn({
      conversationId: "conv-1",
      turnId: "turn-user",
      userInput: task("停掉这个推进，换成发布说明"),
    });

    expect(result.kind).toBe("active-session-taken-over");
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("cancelled");
    expect(session?.exit?.reason).toBe("user-took-over");
  });

  it("failed review 会生成 Rubric 固定代理消息并保持 active", async () => {
    const store = await makeStore();
    await makeActive(store);
    const reviewer = {
      reviewRun: vi.fn(async () => ({ review: review() })),
    };
    const controller = new AdvancementController({
      store,
      reviewer,
      proxyIdGenerator: () => "proxy-1",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });

    expect(result.kind).toBe("proxy-enqueued");
    expect(reviewer.reviewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        runIndex: 0,
        priorReviews: [],
      }),
    );
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("active");
    expect(session?.runs).toHaveLength(1);
    expect(session?.runs[0]?.proxyMessageId).toBe("proxy-1");
    expect(session?.outstandingProxyMessageId).toBe("proxy-1");
    expect(session?.proxyMessages[0]?.content).toEqual(
      task("请修复失败测试后再继续。"),
    );
  });

  it("验收运行体复用并持久化推进侧窗口状态", async () => {
    const store = await makeStore();
    await makeActive(store);
    const previousWindow = windowState(1);
    await store.appendRunReview(
      "conv-1",
      "session-1",
      review({ id: "review-previous" }),
      "2026-01-01T00:02:00.000Z",
      previousWindow,
    );
    const nextWindow = windowState(2, "review-next");
    const reviewer = {
      reviewRun: vi.fn(async () => ({
        review: review({
          id: "review-next",
          runIndex: 1,
          runRecordRef: { shardId: "000001", runIndex: 1 },
        }),
        advancementWindow: nextWindow,
      })),
    };
    const controller = new AdvancementController({
      store,
      reviewer,
      proxyIdGenerator: () => "proxy-1",
    });

    await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 1,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });

    expect(reviewer.reviewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        priorReviews: [expect.objectContaining({ id: "review-previous" })],
        advancementWindow: previousWindow,
      }),
    );
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.advancementWindow?.entries[0]).toMatchObject({
      kind: "review",
      reviewId: "review-next",
    });
    const assistant = session?.advancementWindow?.entries[0]?.messages[1];
    expect(assistant?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("proxy-1"),
    });
  });

  it("passed 结论会完成推进会话", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      reviewer: {
        reviewRun: vi.fn(async () => ({
          review: review({ decision: "passed", unmetCriteria: [] }),
        })),
      },
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });

    expect(result.kind).toBe("completed");
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("completed");
    expect(session?.exit?.reason).toBe("passed");
  });

  it("accepted proxy run 会先清理 outstanding，再按本轮验收继续推进", async () => {
    const store = await makeStore();
    await makeActive(store);
    await store.enqueueProxyMessage("conv-1", "session-1", {
      id: "proxy-1",
      sessionId: "session-1",
      reviewId: "review-0",
      content: task("请修复失败测试后再继续。"),
      rubricFailureHandlingId: "fix-tests",
      variables: {},
      createdAt: "2026-01-01T00:02:30.000Z",
    });
    const controller = new AdvancementController({
      store,
      reviewer: {
        reviewRun: vi.fn(async () =>
          ({
            review: review({
              runIndex: 1,
              runRecordRef: { shardId: "000001", runIndex: 1 },
              decision: "passed",
              unmetCriteria: [],
            }),
          }),
        ),
      },
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 1,
      runRecord: {
        ...runRecord(),
        source: "advancement",
        advancement: {
          sessionId: "session-1",
          proxyMessageId: "proxy-1",
          reviewId: "review-0",
          rubricFailureHandlingId: "fix-tests",
        },
      },
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });

    expect(result.kind).toBe("completed");
    const events = await store.readEvents("conv-1");
    expect(events.map((event) => event.type)).toEqual([
      "session_created",
      "rubric_confirmed",
      "proxy_enqueued",
      "proxy_settled",
      "run_reviewed",
      "completed",
    ]);
  });

  it("advancement 来源 run 缺少匹配 metadata 时退出推进", async () => {
    const store = await makeStore();
    await makeActive(store);
    await store.enqueueProxyMessage("conv-1", "session-1", {
      id: "proxy-1",
      sessionId: "session-1",
      reviewId: "review-0",
      content: task("请修复失败测试后再继续。"),
      rubricFailureHandlingId: "fix-tests",
      variables: {},
      createdAt: "2026-01-01T00:02:30.000Z",
    });
    const reviewer = { reviewRun: vi.fn(async () => ({ review: review() })) };
    const controller = new AdvancementController({
      store,
      reviewer,
      now: () => "2026-01-01T00:04:00.000Z",
      reviewIdGenerator: () => "review-system-error",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 1,
      runRecord: {
        ...runRecord(),
        source: "advancement",
      },
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });

    expect(result.kind).toBe("exited");
    expect(reviewer.reviewRun).not.toHaveBeenCalled();
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.exit?.reason).toBe("system-error");
  });

  it("exit 结论会退出推进会话", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      reviewer: {
        reviewRun: vi.fn(async () =>
          ({
            review: review({
              decision: "exit",
              exitReason: "dead-end",
              unmetCriteria: ["继续推进没有收益"],
            }),
          }),
        ),
      },
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });

    expect(result.kind).toBe("exited");
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.exit?.reason).toBe("dead-end");
  });

  it("没有 active session 时跳过且不调用 reviewer", async () => {
    const store = await makeStore();
    const reviewer = { reviewRun: vi.fn(async () => ({ review: review() })) };
    const controller = new AdvancementController({ store, reviewer });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
    });

    expect(result).toEqual({ kind: "skipped", reason: "no-active-session" });
    expect(reviewer.reviewRun).not.toHaveBeenCalled();
  });

  it("reviewer 抛错时转为 system-error exit，不让 active session 悬空", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      reviewer: { reviewRun: vi.fn(async () => { throw new Error("judge down"); }) },
      now: () => "2026-01-01T00:04:00.000Z",
      reviewIdGenerator: () => "review-system-error",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
    });

    expect(result.kind).toBe("exited");
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.runs[0]?.id).toBe("review-system-error");
    expect(session?.exit?.reason).toBe("system-error");
  });

  it("reviewer 输出必须绑定当前 accepted run，否则转为 system-error exit", async () => {
    for (const badReview of [
      review({ runIndex: 9 }),
      review({ runRecordRef: { shardId: "000999", runIndex: 0 } }),
    ]) {
      const store = await makeStore();
      await makeActive(store);
      const controller = new AdvancementController({
        store,
        reviewer: { reviewRun: vi.fn(async () => ({ review: badReview })) },
        now: () => "2026-01-01T00:04:00.000Z",
        reviewIdGenerator: () => "review-system-error",
      });

      const result = await controller.afterTurnCommitted({
        conversationId: "conv-1",
        runIndex: 0,
        runRecord: runRecord(),
        runRecordRef: { shardId: "000001", runIndex: 0 },
      });

      expect(result.kind).toBe("exited");
      const session = await store.loadSession("conv-1", "session-1");
      expect(session?.status).toBe("exited");
      expect(session?.runs[0]).toMatchObject({
        id: "review-system-error",
        runIndex: 0,
        runRecordRef: { shardId: "000001", runIndex: 0 },
        decision: "exit",
        exitReason: "system-error",
      });
    }
  });
});
