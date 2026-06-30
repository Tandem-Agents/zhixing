import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AdvancementStore } from "@zhixing/core";
import type {
  AdvancementRunReview,
  ConfirmedRubricSnapshot,
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
  it("active session 的 accepted run 会被验收并持久化 review", async () => {
    const store = await makeStore();
    await makeActive(store);
    const reviewer = {
      reviewRun: vi.fn(async () => review()),
    };
    const controller = new AdvancementController({ store, reviewer });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });

    expect(result.kind).toBe("reviewed");
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
  });

  it("passed 结论会完成推进会话", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      reviewer: { reviewRun: vi.fn(async () => review({ decision: "passed", unmetCriteria: [] })) },
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

  it("exit 结论会退出推进会话", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      reviewer: {
        reviewRun: vi.fn(async () =>
          review({
            decision: "exit",
            exitReason: "dead-end",
            unmetCriteria: ["继续推进没有收益"],
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
    const reviewer = { reviewRun: vi.fn(async () => review()) };
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
        reviewer: { reviewRun: vi.fn(async () => badReview) },
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
