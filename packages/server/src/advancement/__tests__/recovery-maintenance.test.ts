import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AdvancementStore,
  advancementLogPath,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type ConfirmedRubricSnapshot,
  type Message,
  type RubricContractDraftSnapshot,
  type RunRecord,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import {
  AdvancementController,
  buildAdvancementProxyMessage,
  createAdvancementRecoveryMaintenance as createOwnerAdvancementRecoveryMaintenance,
  type AdvancementConversationDirectory,
  type AdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import type { SessionBroadcast } from "@zhixing/rpc";
import type {
  ImmediateRootResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";

function fakeResources(): ResourceReservationPort {
  const leaseFor = (id: string): ImmediateRootResourceLease => ({
    v: 1,
    reservationId: `rsv-${id}`,
    admissionClass: "advancement",
    workload: { kind: "control", id, attempt: 1 },
    scopeBinding: { kind: "control", subject: id },
    audience: {},
    budget: { maxCalls: 8 },
    domain: { kind: "anchor", anchorEpoch: 1 },
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiry: "2026-01-01T01:00:00.000Z",
    digest: "sha256:" + "0".repeat(64),
    signature: { alg: "test", keyId: "test", sig: "sha256:" + "0".repeat(64) },
  });
  return {
    enqueueRoot: async () => {},
    prepareAssignmentRoot: async () => {
      throw new Error("unused");
    },
    prepareSystemJobRoot: async () => {
      throw new Error("unused");
    },
    acquireRoot: async (workload) => leaseFor(String(workload.id)),
    acquireChild: async () => {
      throw new Error("unused");
    },
    reserveUsage: async () => {},
    consume: async () => {},
    settle: async () => {},
    release: async () => {},
  };
}
import {
  createAdvancementEventSink,
  createAdvancementProxyTurnPort,
  type AdvancementProxyTurnAdapterOptions,
} from "../adapters.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createAdvancementRecoveryMaintenance(options: {
  readonly advancement: AdvancementController;
  readonly manager: AdvancementProxyTurnAdapterOptions["manager"];
  readonly directory: AdvancementConversationDirectory;
  readonly sessionBroadcast?: () => SessionBroadcast | null;
  readonly logger?: Pick<Console, "warn">;
}): AdvancementRecoveryMaintenance {
  const sessionBroadcast = options.sessionBroadcast ?? (() => null);
  return createOwnerAdvancementRecoveryMaintenance({
    advancement: options.advancement,
    directory: options.directory,
    proxyTurns: createAdvancementProxyTurnPort({
      manager: options.manager,
      sessionBroadcast,
      conversationExists: (conversationId) =>
        options.directory.exists(conversationId),
    }),
    events: createAdvancementEventSink(sessionBroadcast),
    logger: options.logger,
  });
}

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
  const content = draft().content;
  return {
    source: {
      kind: "library",
      rubricId: "rubric-1",
      rubricVersion: "v1",
    },
    title: "确认版测试推进准则",
    description: "用户确认后的准则。",
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

function failedReview(): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 0,
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: [],
    attribution: {
      criteria: [
        { criterionId: "pc-1", verdict: "unmet", reason: "测试未通过。" },
      ],
    },
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
    attribution: failedReview().attribution,
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
  return (await makeConfirmedStoreWithRoot()).store;
}

async function makeConfirmedStoreWithRoot(): Promise<{
  store: AdvancementStore;
  root: string;
}> {
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
  return { store, root };
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
    // 缺省表达 legacy(未启用耐久协议):无耐久 run 日志,claim 显式 unclaimed。
    // durable 场景由用例覆盖 usesDurableTurnProtocol + findDurableRunByIngress。
    usesDurableTurnProtocol: vi.fn(() => false),
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

  it.each([
    "queued",
    "dispatched",
    "running",
    "cancel-requested",
    "uncertain",
    "committed",
  ] as const)("耐久 %s run 已拥有 proxy ingress 时不建立第二个调度任务", async (state) => {
    const store = await makeActiveStore();
    const base = manager();
    const mgr = {
      ...base,
      usesDurableTurnProtocol: vi.fn(() => true),
      findDurableRunByIngress: vi.fn(async () => ({
        runId: "run-durable",
        state,
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: directory(true) as never,
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toEqual({
      status: "durable-run-owned",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
      runId: "run-durable",
    });
    expect(mgr.findDurableRunByIngress).toHaveBeenCalledWith(
      "conv-1",
      "proxy-1",
      "advancement",
    );
    expect(mgr.admitTurn).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed", "expired"] as const)(
    "耐久 %s run 已关闭时由恢复器幂等收束 outstanding proxy",
    async (state) => {
    const store = await makeActiveStore();
    const base = manager();
    const mgr = {
      ...base,
      usesDurableTurnProtocol: vi.fn(() => true),
      findDurableRunByIngress: vi.fn(async () => ({
        runId: "run-closed",
        state,
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: directory(true) as never,
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toEqual({
      status: "closed-run-recovered",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
      runId: "run-closed",
    });
    expect((await store.loadActiveSession("conv-1"))?.outstandingProxyMessageId)
      .toBeUndefined();
    expect(mgr.admitTurn).not.toHaveBeenCalled();
    },
  );

  it("耐久所有权查询失败时不重复调度并返回可重试失败", async () => {
    const store = await makeActiveStore();
    const base = manager();
    const mgr = {
      ...base,
      usesDurableTurnProtocol: vi.fn(() => true),
      findDurableRunByIngress: vi.fn(async () => {
        throw new Error("authority projection unavailable");
      }),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: directory(true) as never,
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "failed",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
      message: "authority projection unavailable",
    });
    expect(mgr.admitTurn).not.toHaveBeenCalled();
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
      usesDurableTurnProtocol: vi.fn(() => false),
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
      usesDurableTurnProtocol: vi.fn(() => false),
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
      review: vi.fn(async (input: { runIndex: number }) => ({
        kind: "reviewed" as const,
        review: {
          id: "review-pass",
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:05:00.000Z",
          decision: "passed" as const,
          evidence: [],
          attribution: {
            criteria: [
              {
                criterionId: "pc-1",
                verdict: "met" as const,
                reason: "测试已全绿。",
              },
            ],
          },
          unmetCriteria: [],
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer, resources: fakeResources() }),
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
    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        runIndex: 0,
        priorReviews: [],
      }),
      expect.anything(),
      expect.anything(),
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
      review: vi.fn(async (input: { runIndex: number }) => ({
        kind: "reviewed" as const,
        review: {
          id: `review-${input.runIndex}`,
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: `2026-01-01T00:0${input.runIndex + 6}:00.000Z`,
          decision:
            input.runIndex === 0 ? ("failed" as const) : ("passed" as const),
          evidence: [],
          attribution: {
            criteria: [
              {
                criterionId: "pc-1",
                verdict:
                  input.runIndex === 0 ? ("unmet" as const) : ("met" as const),
                reason:
                  input.runIndex === 0 ? "测试还没有全绿。" : "测试已全绿。",
              },
            ],
          },
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
        resources: fakeResources(),        reviewer,
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
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    expect(reviewer.review).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runIndex: 0, priorReviews: [] }),
      expect.anything(),
      expect.anything(),
    );
    expect(reviewer.review).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runIndex: 1,
        priorReviews: [expect.objectContaining({ id: "review-0" })],
      }),
      expect.anything(),
      expect.anything(),
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
      review: vi.fn(async (input: { runIndex: number }) => ({
        kind: "reviewed" as const,
        review: {
          id: "review-pass",
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:05:00.000Z",
          decision: "passed" as const,
          evidence: [],
          attribution: {
            criteria: [
              {
                criterionId: "pc-1",
                verdict: "met" as const,
                reason: "测试已全绿。",
              },
            ],
          },
          unmetCriteria: [],
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer, resources: fakeResources() }),
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
    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        runIndex: 1,
        priorReviews: [expect.objectContaining({ id: "review-1" })],
      }),
      expect.anything(),
      expect.anything(),
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
      review: vi.fn(async (input: { runIndex: number }) => ({
        kind: "reviewed" as const,
        review: {
          id: "review-pass",
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:05:00.000Z",
          decision: "passed" as const,
          evidence: [],
          attribution: {
            criteria: [
              {
                criterionId: "pc-1",
                verdict: "met" as const,
                reason: "测试已全绿。",
              },
            ],
          },
          unmetCriteria: [],
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer, resources: fakeResources() }),
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
    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        runIndex: 1,
        priorReviews: [expect.objectContaining({ id: "review-1" })],
      }),
      expect.anything(),
      expect.anything(),
    );
    await expect(store.loadActiveSession("conv-1")).resolves.toBeNull();
  });

  it("missing-proxy 自愈：从已持久化 review 确定性重建 byte 等价代理消息并入队调度", async () => {
    const { store, root } = await makeConfirmedStoreWithRoot();
    const review = failedReview();
    const handling = confirmed().content.failureHandling[0]!;
    const original = buildAdvancementProxyMessage({
      id: "proxy-1",
      sessionId: "adv-1",
      review,
      handling,
      rubric: confirmed(),
      createdAt: "2026-01-01T00:02:30.000Z",
    });
    await store.appendRunReviewWithProxyMessage("conv-1", "adv-1", review, original);

    // 模拟 review + proxy 双事件写入被中断：日志掉尾丢 proxy_enqueued 行
    const file = advancementLogPath(root, "conv-1");
    const lines = (await fs.readFile(file, "utf-8")).split("\n").filter(Boolean);
    expect(JSON.parse(lines[lines.length - 1]!).type).toBe("proxy_enqueued");
    await fs.writeFile(file, `${lines.slice(0, -1).join("\n")}\n`);
    const broken = await store.loadActiveSession("conv-1");
    expect(broken?.outstandingProxyMessageId).toBeUndefined();
    expect(broken?.proxyMessages).toHaveLength(0);
    expect(broken?.runs[0]?.proxyMessageId).toBe("proxy-1");

    const mgr = manager();
    const events: Array<{ event?: string }> = [];
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store }),
      manager: mgr as never,
      directory: directory(true) as never,
      sessionBroadcast: () => (_conversationId, _method, payload) => {
        events.push(payload as { event?: string });
      },
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "scheduled",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      proxyMessageId: "proxy-1",
    });
    const healed = await store.loadActiveSession("conv-1");
    expect(healed?.outstandingProxyMessageId).toBe("proxy-1");
    const rebuilt = healed?.proxyMessages[0];
    expect(rebuilt?.id).toBe("proxy-1");
    expect(rebuilt?.content).toEqual(original.content);
    expect(rebuilt?.variables).toEqual(original.variables);
    expect(rebuilt?.rubricFailureHandlingId).toBe(original.rubricFailureHandlingId);
    expect(rebuilt?.attribution).toEqual(original.attribution);
    expect(events.map((event) => event.event)).toEqual([
      "advancement:proxy_enqueued",
      "advancement:proxy_recovered",
    ]);

    // 再恢复一次：谓词不再命中（实体已在），不循环重建
    const again = await recovery.recoverConversation("conv-1");
    expect(again.status).toBe("already-scheduled");
    const enqueued = (await store.readEvents("conv-1")).filter(
      (event) => event.type === "proxy_enqueued",
    );
    expect(enqueued).toHaveLength(1);
  });

  it("补审 transient 挂起时中断本次恢复：不落盘、不空转、发 review_deferred", async () => {
    const store = await makeConfirmedStore();
    const run: RunRecord = {
      type: "run",
      runIndex: 0,
      timestamp: "2026-01-01T00:04:00.000Z",
      messages: [
        userMessage("把测试修到全绿"),
        assistantMessage("改了一部分。"),
      ],
      source: "interactive",
    };
    const reviewer = {
      review: vi.fn(async () => ({
        kind: "deferred" as const,
        cause: "infrastructure" as const,
        reason: "rate limited",
      })),
    };
    const events: Array<{ event?: string }> = [];
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({ store, reviewer, resources: fakeResources() }),
      manager: manager() as never,
      directory: directory(true, [run]) as never,
      sessionBroadcast: () => (_conversationId, _method, payload) => {
        events.push(payload as { event?: string });
      },
    });

    const result = await recovery.recoverConversation("conv-1");

    expect(result).toMatchObject({
      status: "review-deferred",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      cause: "infrastructure",
      message: "rate limited",
    });
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    const session = await store.loadActiveSession("conv-1");
    expect(session?.runs).toHaveLength(0);
    expect(events.map((event) => event.event)).toEqual([
      "advancement:review_deferred",
    ]);
  });

  it("catch-up 上界排除当轮：只补审 beforeRunIndex 之前的欠账", async () => {
    const store = await makeConfirmedStore();
    const runs: RunRecord[] = [0, 1].map((runIndex) => ({
      type: "run",
      runIndex,
      timestamp: `2026-01-01T00:0${runIndex + 4}:00.000Z`,
      messages: [
        userMessage("继续"),
        assistantMessage(`第 ${runIndex} 轮完成。`),
      ],
      source: "interactive",
    }));
    const reviewer = {
      review: vi.fn(async (input: { runIndex: number }) => ({
        kind: "reviewed" as const,
        review: {
          id: `review-${input.runIndex}`,
          runIndex: input.runIndex,
          runRecordRef: { shardId: "000001", runIndex: input.runIndex },
          reviewedAt: "2026-01-01T00:06:00.000Z",
          decision: "failed" as const,
          evidence: [],
          attribution: {
            criteria: [
              {
                criterionId: "pc-1",
                verdict: "unmet" as const,
                reason: "测试还没有全绿。",
              },
            ],
          },
          unmetCriteria: ["测试还没有全绿"],
          selectedFailureHandlingId: "continue",
        },
      })),
    };
    const recovery = createAdvancementRecoveryMaintenance({
      advancement: new AdvancementController({
        store,
        resources: fakeResources(),        reviewer,
        proxyIdGenerator: () => "proxy-catchup",
      }),
      manager: manager() as never,
      directory: directory(true, runs) as never,
    });

    const result = await recovery.recoverConversation("conv-1", {
      beforeRunIndex: 1,
    });

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({ runIndex: 0 }),
      expect.anything(),
      expect.anything(),
    );
    expect(result).toMatchObject({
      status: "scheduled",
      proxyMessageId: "proxy-catchup",
    });
  });
});

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}
