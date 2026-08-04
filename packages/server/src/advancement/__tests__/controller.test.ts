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
import { AdvancementController } from "@zhixing/owner-services";
import type {
  ImmediateRootResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import { protocolDigest } from "@zhixing/core/protocol";

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

function task(text: string) {
  return { parts: [{ type: "text" as const, text }] };
}

function originalTaskAdmissionIntent() {
  return {
    turnId: "turn-1",
    surfacePrincipal: "surface:test",
    turnOrigin: { channel: "rpc" as const, triggeredBy: "surface:test" },
    inputDigest: protocolDigest(
      "AdvancementOriginalTaskInput",
      1,
      task("把测试修到全绿"),
    ),
  };
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
    attribution: {
      criteria: [
        {
          criterionId: "pc-1",
          verdict: "unmet",
          reason: "测试仍未全绿。",
          evidenceExcerpt: "vitest: 1 failed",
        },
        { criterionId: "pc-2", verdict: "met", reason: "实现已覆盖需求点。" },
      ],
    },
    unmetCriteria: ["测试仍未全绿"],
    selectedFailureHandlingId: "fix-tests",
    ...extra,
  };
}

function passedAttribution() {
  return {
    criteria: [
      {
        criterionId: "pc-1",
        verdict: "met" as const,
        reason: "测试已全绿。",
        evidenceExcerpt: "vitest: all passed",
      },
      { criterionId: "pc-2", verdict: "met" as const, reason: "实现已覆盖需求点。" },
    ],
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
  await store.confirmRubric(
    "conv-1",
    "session-1",
    confirmed(),
    originalTaskAdmissionIntent(),
  );
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
    if (result.kind !== "active-session-taken-over") return;
    // 有推进事实的接管归 exited 并交付收场；cancelled 只留给无执行事实的关闭。
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.exit?.reason).toBe("user-took-over");
    expect(result.closure.synthesized).toBe(false);
    expect(result.closure.summary).toContain("任务推进已退出");
    expect(result.closure.facts.sessionId).toBe("session-1");
  });

  it("failed review 会生成 Rubric 固定代理消息并保持 active", async () => {
    const store = await makeStore();
    await makeActive(store);
    const reviewer = {
      review: vi.fn(async () => ({ kind: "reviewed" as const, review: review() })),
    };
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer,
      proxyIdGenerator: () => "proxy-1",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });

    expect(result.kind).toBe("proxy-enqueued");
    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        runIndex: 0,
        priorReviews: [],
      }),
      expect.anything(),
      expect.anything(),
    );
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("active");
    expect(session?.runs).toHaveLength(1);
    expect(session?.runs[0]?.proxyMessageId).toBe("proxy-1");
    expect(session?.outstandingProxyMessageId).toBe("proxy-1");
    const proxy = session?.proxyMessages[0];
    expect(proxy?.attribution).toEqual(review().attribution);
    const contentText =
      proxy?.content.parts[0]?.type === "text" ? proxy.content.parts[0].text : "";
    expect(contentText).toContain("请修复失败测试后再继续。");
    expect(contentText).toContain("【验收判定】");
    expect(contentText).toContain("测试通过：未满足。测试仍未全绿。");
    expect(contentText).toContain("证据：vitest: 1 failed");
    expect(contentText).toContain("实现满足需求：已满足。实现已覆盖需求点。");
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
      review: vi.fn(async () => ({
        kind: "reviewed" as const,
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
      resources: fakeResources(),      reviewer,
      proxyIdGenerator: () => "proxy-1",
    });

    await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 1,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });

    expect(reviewer.review).toHaveBeenCalledWith(
      expect.objectContaining({
        priorReviews: [expect.objectContaining({ id: "review-previous" })],
        advancementWindow: previousWindow,
      }),
      expect.anything(),
      expect.anything(),
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
      resources: fakeResources(),      reviewer: {
        review: vi.fn(async () => ({
          kind: "reviewed" as const,
          review: review({
            decision: "passed",
            unmetCriteria: [],
            attribution: passedAttribution(),
          }),
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
    await store.appendRunReviewWithProxyMessage(
      "conv-1",
      "session-1",
      review({
        id: "review-0",
        proxyMessageId: "proxy-1",
      }),
      {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-0",
        content: task("请修复失败测试后再继续。"),
        rubricFailureHandlingId: "fix-tests",
        variables: {},
        attribution: review().attribution,
        createdAt: "2026-01-01T00:02:30.000Z",
      },
    );
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer: {
        review: vi.fn(async () =>
          ({
            kind: "reviewed" as const,
            review: review({
              runIndex: 1,
              runRecordRef: { shardId: "000001", runIndex: 1 },
              decision: "passed",
              unmetCriteria: [],
              attribution: passedAttribution(),
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
      "run_reviewed",
      "proxy_enqueued",
      "proxy_settled",
      "run_reviewed",
      "completed",
    ]);
  });

  it("advancement 来源 run 缺少匹配 metadata 时退出推进", async () => {
    const store = await makeStore();
    await makeActive(store);
    await store.appendRunReviewWithProxyMessage(
      "conv-1",
      "session-1",
      review({
        id: "review-0",
        proxyMessageId: "proxy-1",
      }),
      {
        id: "proxy-1",
        sessionId: "session-1",
        reviewId: "review-0",
        content: task("请修复失败测试后再继续。"),
        rubricFailureHandlingId: "fix-tests",
        variables: {},
        attribution: review().attribution,
        createdAt: "2026-01-01T00:02:30.000Z",
      },
    );
    const reviewer = { review: vi.fn(async () => ({ kind: "reviewed" as const, review: review() })) };
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer,
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
    expect(reviewer.review).not.toHaveBeenCalled();
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.exit?.reason).toBe("system-error");
  });

  it("exit 结论会退出推进会话", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer: {
        review: vi.fn(async () =>
          ({
            kind: "reviewed" as const,
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

  it("准入判断携带最近会话投影并记录耗时", async () => {
    const store = await makeStore();
    const decide = vi.fn(async () => ({
      kind: "question" as const,
      action: "run-direct" as const,
      reason: "test",
    }));
    const timings: number[] = [];
    const controller = new AdvancementController({
      store,
      admissionStrategy: { decide },
      recentContextProvider: async () => "用户：把配置迁移到新格式",
      onAdmissionTiming: (ms) => timings.push(ms),
    });

    await controller.prepareUserTurn({
      conversationId: "conv-projection",
      turnId: "turn-projection",
      userInput: task("继续把它弄完"),
    });

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        recentContext: "用户：把配置迁移到新格式",
      }),
    );
    expect(timings).toHaveLength(1);
    expect(timings[0]).toBeGreaterThanOrEqual(0);
  });

  it("投影 provider 失败时按无投影降级，准入照常进行", async () => {
    const store = await makeStore();
    const decide = vi.fn(async () => ({
      kind: "question" as const,
      action: "run-direct" as const,
      reason: "test",
    }));
    const controller = new AdvancementController({
      store,
      admissionStrategy: { decide },
      recentContextProvider: async () => {
        throw new Error("history unavailable");
      },
    });

    const result = await controller.prepareUserTurn({
      conversationId: "conv-projection-fail",
      turnId: "turn-projection-fail",
      userInput: task("继续"),
    });

    expect(result.kind).toBe("run-direct");
    expect(decide.mock.calls.at(-1)?.[0]?.recentContext).toBeUndefined();
  });

  it("没有 active session 时跳过且不调用 reviewer", async () => {
    const store = await makeStore();
    const reviewer = { review: vi.fn(async () => ({ kind: "reviewed" as const, review: review() })) };
    const controller = new AdvancementController({ store, reviewer });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
    });

    expect(result).toEqual({ kind: "skipped", reason: "no-active-session" });
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("累计 usage 触达保险丝阈值时审前退出为 budget-exceeded 并交付收场", async () => {
    const store = await makeStore();
    await makeActive(store);
    await store.appendRunReview(
      "conv-1",
      "session-1",
      review({
        usage: {
          judge: { inputTokens: 500, outputTokens: 300 },
          run: { inputTokens: 400, outputTokens: 200 },
        },
      }),
      "2026-01-01T00:03:00.000Z",
    );
    const reviewer = {
      review: vi.fn(async () => ({ kind: "reviewed" as const, review: review() })),
    };
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer,
      sessionTokenBudget: 1000,
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 1,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 1 },
    });

    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.exit.reason).toBe("budget-exceeded");
    expect(result.exit.message).toContain("成本上限");
    expect(result.closure.facts.usage.totalTokens).toBeGreaterThanOrEqual(1400);
    expect(reviewer.review).not.toHaveBeenCalled();
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.exit?.reason).toBe("budget-exceeded");
  });

  it("本轮 usage 落账打穿保险丝时不再入队续推，就地 budget-exceeded 终局", async () => {
    const store = await makeStore();
    await makeActive(store);
    const reviewer = {
      // 本轮 failed review 自带打穿阈值的 usage——审前（既往为 0）放行，
      // 审后必须拦住下一轮执行。
      review: vi.fn(async () => ({
        kind: "reviewed" as const,
        review: review({
          usage: {
            judge: { inputTokens: 400, outputTokens: 200 },
            run: { inputTokens: 500, outputTokens: 300 },
          },
        }),
      })),
    };
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer,
      sessionTokenBudget: 1000,
      proxyIdGenerator: () => "proxy-should-not-exist",
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
      runRecordRef: { shardId: "000001", runIndex: 0 },
    });

    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.exit.reason).toBe("budget-exceeded");
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("exited");
    expect(session?.proxyMessages).toHaveLength(0);
    expect(session?.outstandingProxyMessageId).toBeUndefined();
    // 本轮验收事实保留在终局 review 上（归因与 usage 不丢）
    expect(session?.runs[0]).toMatchObject({
      decision: "exit",
      exitReason: "budget-exceeded",
      unmetCriteria: ["测试仍未全绿"],
      usage: { run: { inputTokens: 500 } },
    });
    // 转化轮裁判选了策略但续推未发出——收场不把「本打算尝试」投影成「已尝试」
    expect(result.closure.facts.attemptedStrategies).toEqual([]);
  });

  it("revise-rubric 走契约再生：旧契约 superseded 收场、新草案从反投影预填生成", async () => {
    const store = await makeStore();
    await makeActive(store);
    const reviseDraft = vi.fn(
      async (input: { currentDraft: RubricContractDraftSnapshot }) => ({
        ...input.currentDraft,
        draftId: "draft-regen",
        content: {
          ...input.currentDraft.content,
          passCriteria: [
            ...input.currentDraft.content.passCriteria,
            "文档同步更新",
          ],
        },
        createdAt: "2026-01-01T00:06:00.000Z",
      }),
    );
    const controller = new AdvancementController({
      store,
      admissionStrategy: {
        decide: vi.fn(async () => ({
          kind: "direct-task" as const,
          action: "revise-rubric" as const,
          reason: "用户修正验收标准",
        })),
      },
      contractBuilder: { reviseDraft } as never,
      now: () => "2026-01-01T00:05:00.000Z",
    });

    const result = await controller.prepareUserTurn({
      conversationId: "conv-1",
      turnId: "turn-revise",
      userInput: task("验收标准加一条：文档同步更新"),
    });

    expect(result.kind).toBe("rubric-regenerated");
    if (result.kind !== "rubric-regenerated") return;
    expect(result.exit.reason).toBe("superseded");
    expect(result.exitedSession.status).toBe("exited");
    expect(result.closure.summary).toContain("任务推进已退出");
    expect(result.draft.content.passCriteria).toEqual([
      "测试通过",
      "实现满足需求",
      "文档同步更新",
    ]);
    // 反投影预填：reviseDraft 收到的当前草案来自旧契约（自然列表、素材保留）
    expect(reviseDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        currentDraft: expect.objectContaining({
          title: "代码审查推进准则",
          content: expect.objectContaining({
            passCriteria: ["测试通过", "实现满足需求"],
          }),
        }),
        userFeedback: "验收标准加一条：文档同步更新",
      }),
    );
    const old = await store.loadSession("conv-1", "session-1");
    expect(old?.status).toBe("exited");
    const next = await store.loadActiveSession("conv-1");
    expect(next?.id).toBe("adv_draft-regen");
    expect(next?.status).toBe("awaiting-rubric-confirmation");
    expect(next?.originalUserTask).toEqual(task("把测试修到全绿"));
  });

  it("契约再生的草案修订失败时旧契约保持 active 不受损", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      admissionStrategy: {
        decide: vi.fn(async () => ({
          kind: "direct-task" as const,
          action: "revise-rubric" as const,
          reason: "用户修正验收标准",
        })),
      },
      contractBuilder: {
        reviseDraft: vi.fn(async () => {
          throw new Error("revision provider down");
        }),
      } as never,
    });

    const result = await controller.prepareUserTurn({
      conversationId: "conv-1",
      turnId: "turn-revise",
      userInput: task("验收标准加一条"),
    });

    expect(result.kind).toBe("contract-failed");
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("active");
  });

  it("closureSynthesizer 成功时收场用合成文本，失败时降级结构化直出", async () => {
    for (const synthesizer of [
      {
        synthesize: vi.fn(async () => "推进 1 轮后验收通过，测试全绿。"),
        expectSynthesized: true,
      },
      {
        synthesize: vi.fn(async () => {
          throw new Error("synth down");
        }),
        expectSynthesized: false,
      },
    ]) {
      const store = await makeStore();
      await makeActive(store);
      const controller = new AdvancementController({
        store,
        resources: fakeResources(),        reviewer: {
          review: vi.fn(async () => ({
            kind: "reviewed" as const,
            review: review({
              decision: "passed",
              unmetCriteria: [],
              attribution: passedAttribution(),
            }),
          })),
        },
        closureSynthesizer: { synthesize: synthesizer.synthesize },
        now: () => "2026-01-01T00:04:00.000Z",
      });

      const result = await controller.afterTurnCommitted({
        conversationId: "conv-1",
        runIndex: 0,
        runRecord: runRecord(),
        runRecordRef: { shardId: "000001", runIndex: 0 },
      });

      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(synthesizer.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-1" }),
      );
      expect(result.closure.synthesized).toBe(synthesizer.expectSynthesized);
      if (synthesizer.expectSynthesized) {
        expect(result.closure.summary).toBe("推进 1 轮后验收通过，测试全绿。");
      } else {
        expect(result.closure.summary).toContain("任务推进已验收通过");
      }
      expect(result.closure.facts.criteria).toHaveLength(2);
    }
  });

  it("同一 runIndex 已有结论时幂等跳过，不重复验收", async () => {
    const store = await makeStore();
    await makeActive(store);
    await store.appendRunReview(
      "conv-1",
      "session-1",
      review(),
      "2026-01-01T00:03:00.000Z",
    );
    const reviewer = {
      review: vi.fn(async () => ({ kind: "reviewed" as const, review: review() })),
    };
    const controller = new AdvancementController({ store, reviewer });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
    });

    expect(result).toEqual({ kind: "skipped", reason: "already-reviewed" });
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("reviewer 返回 deferred 时挂起本轮验收，session 保持 active 且不落盘 review", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer: {
        review: vi.fn(async () => ({
          kind: "deferred" as const,
          cause: "infrastructure" as const,
          reason: "推进侧裁判调用出错：rate limited",
        })),
      },
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
    });

    expect(result).toMatchObject({
      kind: "review-deferred",
      cause: "infrastructure",
      reason: "推进侧裁判调用出错：rate limited",
    });
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("active");
    expect(session?.runs).toHaveLength(0);
  });

  it("reviewer 意外抛错按基础设施挂起，不误落终局", async () => {
    const store = await makeStore();
    await makeActive(store);
    const controller = new AdvancementController({
      store,
      resources: fakeResources(),      reviewer: { review: vi.fn(async () => { throw new Error("judge down"); }) },
      now: () => "2026-01-01T00:04:00.000Z",
    });

    const result = await controller.afterTurnCommitted({
      conversationId: "conv-1",
      runIndex: 0,
      runRecord: runRecord(),
    });

    expect(result).toMatchObject({
      kind: "review-deferred",
      cause: "infrastructure",
    });
    const session = await store.loadSession("conv-1", "session-1");
    expect(session?.status).toBe("active");
    expect(session?.runs).toHaveLength(0);
  });

  it("reviewer 输出与 accepted run 绑定不符时抛一致性错误，不落盘任何结论", async () => {
    for (const badReview of [
      review({ runIndex: 9 }),
      review({ runRecordRef: { shardId: "000999", runIndex: 0 } }),
    ]) {
      const store = await makeStore();
      await makeActive(store);
      const controller = new AdvancementController({
        store,
        resources: fakeResources(),        reviewer: {
          review: vi.fn(async () => ({ kind: "reviewed" as const, review: badReview })),
        },
        now: () => "2026-01-01T00:04:00.000Z",
      });

      await expect(
        controller.afterTurnCommitted({
          conversationId: "conv-1",
          runIndex: 0,
          runRecord: runRecord(),
          runRecordRef: { shardId: "000001", runIndex: 0 },
        }),
      ).rejects.toThrow(/does not match accepted/);
      const session = await store.loadSession("conv-1", "session-1");
      expect(session?.status).toBe("active");
      expect(session?.runs).toHaveLength(0);
    }
  });
});
