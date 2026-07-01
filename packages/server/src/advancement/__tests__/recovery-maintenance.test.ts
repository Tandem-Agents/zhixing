import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AdvancementStore,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type ConfirmedRubricSnapshot,
  type Message,
  type RubricContractDraftSnapshot,
  type RunRecord,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { AdvancementController } from "../controller.js";
import { createAdvancementRecoveryMaintenance } from "../recovery-maintenance.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function task(text: string) {
  return { parts: [{ type: "text" as const, text }] };
}

function draft(): RubricContractDraftSnapshot {
  return {
    draftId: "draft-1",
    originalTurnId: "turn-1",
    source: "generated",
    candidateRubricIds: [],
    title: "测试推进准则",
    description: "用于测试恢复。",
    content: {
      passCriteria: ["测试全绿"],
      evidenceRequirements: [],
      failureHandling: [
        {
          id: "continue",
          scenario: "测试未通过",
          reply: "继续修复测试。",
        },
      ],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function confirmed(): ConfirmedRubricSnapshot {
  return {
    rubricId: "rubric-1",
    rubricVersion: "v1",
    title: "确认版测试推进准则",
    description: "用户确认后的准则。",
    content: draft().content,
    confirmedAt: "2026-01-01T00:01:00.000Z",
    confirmedBy: "user",
  };
}

function failedReview(): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 0,
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: [],
    unmetCriteria: ["测试未通过"],
    selectedFailureHandlingId: "continue",
    proxyMessageId: "proxy-1",
  };
}

function proxyMessage(): AdvancementProxyMessage {
  return {
    id: "proxy-1",
    sessionId: "adv-1",
    reviewId: "review-1",
    content: task("继续修复测试。"),
    rubricFailureHandlingId: "continue",
    variables: {},
    createdAt: "2026-01-01T00:03:00.000Z",
  };
}

async function makeActiveStore(): Promise<AdvancementStore> {
  const store = await makeConfirmedStore();
  await store.appendRunReviewWithProxyMessage(
    "conv-1",
    "adv-1",
    failedReview(),
    proxyMessage(),
  );
  return store;
}

async function makeConfirmedStore(): Promise<AdvancementStore> {
  const root = path.join(await createTempDir("server-advancement-recovery"), "advancement");
  const store = new AdvancementStore(root);
  await store.createSession({
    id: "adv-1",
    conversationId: "conv-1",
    originalUserTask: task("把测试修到全绿"),
    pendingRubricDraft: draft(),
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await store.confirmRubric("conv-1", "adv-1", confirmed());
  return store;
}

function directory(exists: boolean, runs: RunRecord[] = []) {
  return {
    list: vi.fn(async () => [
      {
        id: "conv-1",
        name: "conv-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        isDefault: false,
        archived: false,
      },
    ]),
    exists: vi.fn(async () => exists),
    readRunsReverse: vi.fn(async (_conversationId: string, opts: { limit: number }) => ({
      runs: runs
        .slice()
        .reverse()
        .slice(0, opts.limit)
        .map((record) => ({ record, shardId: "000001" })),
      hasMore: false,
    })),
  };
}

function manager() {
  return {
    getBusySource: vi.fn(() => undefined),
    admitTurn: vi.fn(async (input: {
      conversationId: string;
      exists?: () => Promise<boolean>;
      makeTask: (managed: { turnCount: number }) => { source: string };
    }) => {
      if (input.exists && !(await input.exists())) {
        return { status: "not-found", conversationId: input.conversationId };
      }
      const task = input.makeTask({ turnCount: 3 });
      expect(task.source).toBe("advancement");
      return {
        status: "queued",
        conversationId: input.conversationId,
        managed: {},
        task,
      };
    }),
  };
}

describe("AdvancementRecoveryMaintenance", () => {
  it("恢复 active outstanding proxy 时只重接已确认代理消息", async () => {
    const store = await makeActiveStore();
    const mgr = manager();
    const dir = directory(true);
    const events: unknown[] = [];
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: dir as never,
      sessionBroadcast: () => (_conversationId, method, payload) => {
        expect(method).toBe("session.event");
        events.push(payload);
      },
    });

    const results = await recovery.recoverAllOpenSessions();

    expect(results).toEqual([
      {
        status: "scheduled",
        conversationId: "conv-1",
        advancementSessionId: "adv-1",
        proxyMessageId: "proxy-1",
        scheduleStatus: "queued",
      },
    ]);
    expect(mgr.admitTurn).toHaveBeenCalledTimes(1);
    expect(dir.exists).toHaveBeenCalledWith("conv-1");
    expect(events).toEqual([
      expect.objectContaining({
        scope: "control",
        event: "advancement:proxy_recovered",
        runId: "proxy-1",
      }),
    ]);

    const second = await recovery.recoverConversation("conv-1");
    expect(second).toMatchObject({
      status: "already-scheduled",
      proxyMessageId: "proxy-1",
    });
    expect(mgr.admitTurn).toHaveBeenCalledTimes(1);
  });

  it("恢复时必须通过目录存在性门禁，避免复活已删除对话", async () => {
    const store = await makeActiveStore();
    const mgr = manager();
    const dir = directory(false);
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: dir as never,
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "not-found",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
    });
    expect(mgr.admitTurn).toHaveBeenCalledTimes(1);
    expect(dir.exists).toHaveBeenCalledWith("conv-1");
  });

  it("恢复调度的代理 run 失败后释放占位，允许下次恢复重试", async () => {
    const store = await makeActiveStore();
    const dir = directory(true);
    const mgr = {
      getBusySource: vi.fn(() => undefined),
      setBusy: vi.fn(),
      admitTurn: vi.fn(async (input: {
        conversationId: string;
        exists?: () => Promise<boolean>;
        makeTask: (managed: {
          conversationId: string;
          turnCount: number;
        }) => { source: string; execute: () => Promise<void>; cancel: () => void };
      }) => {
        if (input.exists && !(await input.exists())) {
          return { status: "not-found", conversationId: input.conversationId };
        }
        const managed = { conversationId: input.conversationId, turnCount: 3 };
        const task = input.makeTask(managed);
        expect(task.source).toBe("advancement");
        return {
          status: "immediate",
          conversationId: input.conversationId,
          managed,
          task,
        };
      }),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: dir as never,
    });

    const first = await recovery.recoverConversation("conv-1");
    await flush();
    await flush();
    const second = await recovery.recoverConversation("conv-1");

    expect(first).toMatchObject({
      status: "scheduled",
      scheduleStatus: "immediate",
      proxyMessageId: "proxy-1",
    });
    expect(second).toMatchObject({
      status: "scheduled",
      scheduleStatus: "immediate",
      proxyMessageId: "proxy-1",
    });
    expect(mgr.admitTurn).toHaveBeenCalledTimes(2);
    expect(mgr.setBusy).toHaveBeenCalledWith("conv-1", false);
  });

  it("恢复调度的排队代理被取消后释放占位，允许下次恢复重试", async () => {
    const store = await makeActiveStore();
    const dir = directory(true);
    let cancelQueued: (() => void) | undefined;
    const mgr = {
      getBusySource: vi.fn(() => undefined),
      admitTurn: vi.fn(async (input: {
        conversationId: string;
        exists?: () => Promise<boolean>;
        makeTask: (managed: {
          conversationId: string;
          turnCount: number;
        }) => { source: string; execute: () => Promise<void>; cancel: () => void };
      }) => {
        if (input.exists && !(await input.exists())) {
          return { status: "not-found", conversationId: input.conversationId };
        }
        const task = input.makeTask({
          conversationId: input.conversationId,
          turnCount: 3,
        });
        cancelQueued = task.cancel;
        return {
          status: "queued",
          conversationId: input.conversationId,
          managed: {},
          task,
        };
      }),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: dir as never,
    });

    const first = await recovery.recoverConversation("conv-1");
    const blocked = await recovery.recoverConversation("conv-1");
    cancelQueued?.();
    const second = await recovery.recoverConversation("conv-1");

    expect(first).toMatchObject({
      status: "scheduled",
      scheduleStatus: "queued",
      proxyMessageId: "proxy-1",
    });
    expect(blocked).toMatchObject({
      status: "already-scheduled",
      proxyMessageId: "proxy-1",
    });
    expect(second).toMatchObject({
      status: "scheduled",
      scheduleStatus: "queued",
      proxyMessageId: "proxy-1",
    });
    expect(mgr.admitTurn).toHaveBeenCalledTimes(2);
  });

  it("普通 run 已落盘但未验收时，恢复补跑推进侧验收", async () => {
    const store = await makeConfirmedStore();
    const acceptedRun: RunRecord = {
      type: "run",
      runIndex: 0,
      timestamp: "2026-01-01T00:04:00.000Z",
      messages: [
        userMessage("把测试修到全绿"),
        assistantMessage("测试已全绿。"),
      ],
      source: "interactive",
    };
    const mgr = manager();
    const dir = directory(true, [acceptedRun]);
    const events: Array<{ event?: string }> = [];
    const reviewer = {
      reviewRun: vi.fn(async (input: { runIndex: number }) => ({
        review: {
          id: "review-pass",
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:05:00.000Z",
          decision: "passed" as const,
          evidence: [],
          unmetCriteria: [],
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer }),
      manager: mgr as never,
      directory: dir as never,
      sessionBroadcast: () => (_conversationId, _method, payload) => {
        events.push(payload as { event?: string });
      },
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "accepted-run-recovered",
      advancementSessionId: "adv-1",
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });
    expect(mgr.admitTurn).not.toHaveBeenCalled();
    expect(reviewer.reviewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runIndex: 0,
        priorReviews: [],
      }),
    );
    await expect(store.loadActiveSession("conv-1")).resolves.toBeNull();
    expect(events.map((event) => event.event)).toEqual([
      "advancement:run_reviewed",
      "advancement:completed",
    ]);
  });

  it("同一会话多条 run 已落盘但未验收时，恢复一次追平到终态", async () => {
    const store = await makeConfirmedStore();
    const runs: RunRecord[] = [
      {
        type: "run",
        runIndex: 0,
        timestamp: "2026-01-01T00:04:00.000Z",
        messages: [
          userMessage("把测试修到全绿"),
          assistantMessage("先修了一部分。"),
        ],
        source: "interactive",
      },
      {
        type: "run",
        runIndex: 1,
        timestamp: "2026-01-01T00:05:00.000Z",
        messages: [
          userMessage("继续"),
          assistantMessage("测试已全绿。"),
        ],
        source: "interactive",
      },
    ];
    const reviewer = {
      reviewRun: vi.fn(async (input: { runIndex: number }) => ({
        review: {
          id: `review-${input.runIndex}`,
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: `2026-01-01T00:0${input.runIndex + 6}:00.000Z`,
          decision:
            input.runIndex === 0 ? ("failed" as const) : ("passed" as const),
          evidence: [],
          unmetCriteria:
            input.runIndex === 0 ? ["测试还没有全绿"] : [],
          selectedFailureHandlingId:
            input.runIndex === 0 ? "continue" : undefined,
        },
      })),
    };
    const mgr = manager();
    const events: Array<{ event?: string }> = [];
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({
        store,
        reviewer,
        proxyIdGenerator: () => "proxy-2",
      }),
      manager: mgr as never,
      directory: directory(true, runs) as never,
      sessionBroadcast: () => (_conversationId, _method, payload) => {
        events.push(payload as { event?: string });
      },
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "accepted-run-recovered",
      advancementSessionId: "adv-1",
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });
    expect(reviewer.reviewRun).toHaveBeenCalledTimes(2);
    expect(reviewer.reviewRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runIndex: 0, priorReviews: [] }),
    );
    expect(reviewer.reviewRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runIndex: 1,
        priorReviews: [expect.objectContaining({ id: "review-0" })],
      }),
    );
    expect(mgr.admitTurn).not.toHaveBeenCalled();
    await expect(store.loadActiveSession("conv-1")).resolves.toBeNull();
    expect(events.map((event) => event.event)).toEqual([
      "advancement:run_reviewed",
      "advancement:run_reviewed",
      "advancement:completed",
    ]);
  });

  it("proxy run 已落盘但未验收时，恢复先消费已接受事实而不重复调度", async () => {
    const store = await makeActiveStore();
    const proxyRun: RunRecord = {
      type: "run",
      runIndex: 1,
      timestamp: "2026-01-01T00:04:00.000Z",
      messages: [
        userMessage("继续修复测试。"),
        assistantMessage("测试已全绿。"),
      ],
      source: "advancement",
      advancement: {
        sessionId: "adv-1",
        proxyMessageId: "proxy-1",
        reviewId: "review-1",
        rubricFailureHandlingId: "continue",
      },
    };
    const mgr = manager();
    const dir = directory(true, [proxyRun]);
    const events: Array<{ event?: string }> = [];
    const reviewer = {
      reviewRun: vi.fn(async (input: { runIndex: number }) => ({
        review: {
          id: "review-pass",
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:05:00.000Z",
          decision: "passed" as const,
          evidence: [],
          unmetCriteria: [],
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer }),
      manager: mgr as never,
      directory: dir as never,
      sessionBroadcast: () => (_conversationId, _method, payload) => {
        events.push(payload as { event?: string });
      },
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "accepted-run-recovered",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });
    expect(mgr.admitTurn).not.toHaveBeenCalled();
    expect(reviewer.reviewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runIndex: 1,
        priorReviews: [expect.objectContaining({ id: "review-1" })],
      }),
    );
    await expect(store.loadActiveSession("conv-1")).resolves.toBeNull();
    expect(events.map((event) => event.event)).toEqual([
      "advancement:run_reviewed",
      "advancement:completed",
    ]);
  });

  it("proxy run 已 settle 但未验收时，恢复继续验收而不误判来源", async () => {
    const store = await makeActiveStore();
    await store.settleProxyMessage(
      "conv-1",
      "adv-1",
      "proxy-1",
      "2026-01-01T00:04:30.000Z",
    );
    const proxyRun: RunRecord = {
      type: "run",
      runIndex: 1,
      timestamp: "2026-01-01T00:04:00.000Z",
      messages: [
        userMessage("继续修复测试。"),
        assistantMessage("测试已全绿。"),
      ],
      source: "advancement",
      advancement: {
        sessionId: "adv-1",
        proxyMessageId: "proxy-1",
        reviewId: "review-1",
        rubricFailureHandlingId: "continue",
      },
    };
    const reviewer = {
      reviewRun: vi.fn(async (input: { runIndex: number }) => ({
        review: {
          id: "review-pass",
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:05:00.000Z",
          decision: "passed" as const,
          evidence: [],
          unmetCriteria: [],
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer }),
      manager: manager() as never,
      directory: directory(true, [proxyRun]) as never,
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "accepted-run-recovered",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });
    expect(reviewer.reviewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runIndex: 1,
        priorReviews: [expect.objectContaining({ id: "review-1" })],
      }),
    );
    await expect(store.loadActiveSession("conv-1")).resolves.toBeNull();
  });
});

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}
