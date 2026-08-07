/**
 * ConversationController —— 当前对话指针 + turn 编排的行为锚。
 *
 * 锁住:
 *   - beginTurn/sendTurn:complete waiter 先于 send 挂上(loopback 下推送可先于
 *     request 响应到达);post-turn 控制意图暂存随 complete 带出;
 *     send 失败撤 waiter 不泄漏
 *   - 主通道按当前对话过滤喂 onYield(旁观其它对话的帧不进渲染)
 *   - 场景进出 / resume / new 的指针变化与模式派生
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentYield } from "@zhixing/core";
import { RPC_ERROR_CODES, RpcClientError } from "@zhixing/server";
import {
  ConversationController,
  selectInitialConversation,
  type ActiveConversation,
} from "../conversation-controller.js";
import type { RpcConversationFacade } from "../rpc-conversation-facade.js";
import type { RpcWorksceneFacade } from "../rpc-workscene-facade.js";

type Handler<T> = (p: T) => void;

function makeFakes() {
  const handlers = {
    delta: [] as Handler<never>[],
    complete: [] as Handler<never>[],
    final: [] as Handler<never>[],
    status: [] as Handler<never>[],
    activity: [] as Handler<never>[],
    intent: [] as Handler<never>[],
  };
  const conversation = {
    send: vi.fn(async (_text: string, _id: string, turnId: string) => ({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      runId: `run:${turnId}`,
    })),
    confirmAdvancement: vi.fn(async (_id: string, _advancementSessionId: string) => ({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-confirmed",
      status: "confirmed",
      advancementSessionId: "adv-1",
      runStatus: "immediate",
    })),
    cancelAdvancement: vi.fn(
      async (
        _id: string,
        _advancementSessionId: string,
        opts: { executeOriginal?: boolean } = {},
      ) =>
        opts.executeOriginal
          ? {
              conversationId: "conv-1",
              sessionId: "conv-1",
              turnId: "turn-direct",
              status: "direct-execution",
              advancementSessionId: "adv-1",
              runStatus: "immediate",
            }
          : {
              conversationId: "conv-1",
              sessionId: "conv-1",
              status: "cancelled",
              advancementSessionId: "adv-1",
            },
    ),
    reviseAdvancement: vi.fn(
      async (_id: string, _advancementSessionId: string, _feedback: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        status: "revised",
        advancementSessionId: "adv-1",
        rubricDraftId: "draft-revised",
        rubricDraft: {
          ...rubricDraft("turn-rubric"),
          draftId: "draft-revised",
          title: "修订后的推进准则",
        },
      }),
    ),
    onDelta: (h: Handler<never>) => {
      handlers.delta.push(h);
      return () => {};
    },
    onComplete: (h: Handler<never>) => {
      handlers.complete.push(h);
      return () => {};
    },
    onFinal: (h: Handler<never>) => {
      handlers.final.push(h);
      return () => {};
    },
    onStatus: (h: Handler<never>) => {
      handlers.status.push(h);
      return () => {};
    },
    onActivity: (h: Handler<never>) => {
      handlers.activity.push(h);
      return () => {};
    },
    onPostTurnControlIntent: (h: Handler<never>) => {
      handlers.intent.push(h);
      return () => {};
    },
    resume: vi.fn(async (id: string) => ({
      conversationId: id,
      name: id === "conv-1" ? "主对话" : `名-${id}`,
      active: false,
      busy: false,
    })),
    resumeIfExists: vi.fn(async (id: string) => conversation.resume(id)),
    list: vi.fn(async () => []),
    newConversation: vi.fn(async () => ({
      conversationId: "conv-new",
      name: "conv-new",
    })),
    subscribe: vi.fn(async () => true),
    unsubscribe: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    history: vi.fn(async () => ({ runs: [], hasMore: false })),
    statusHistory: vi.fn(async () => ({ notices: [], next: [] })),
  };
  const workscene = {
    enter: vi.fn(async (sceneId: string) => ({
      conversationId: `ws:${sceneId}:conv-9`,
      scene: { sceneId, name: "写作场景" },
    })),
    setWorkdir: vi.fn(async (
      sceneId: string,
      workspace: { deviceId: string; bindingRef: string } | null,
    ) => ({
      sceneId,
      revision: 2,
      name: "写作场景",
      ...(workspace ? { workspace } : {}),
    })),
    exit: vi.fn(async () => {}),
  };
  const emit = {
    delta: (p: unknown) => handlers.delta.forEach((h) => h(p as never)),
    complete: (p: unknown) => handlers.complete.forEach((h) => h(p as never)),
    final: (p: unknown) => handlers.final.forEach((h) => h(p as never)),
    status: (p: unknown) => handlers.status.forEach((h) => h(p as never)),
    activity: (p: unknown) => handlers.activity.forEach((h) => h(p as never)),
    intent: (p: unknown) => handlers.intent.forEach((h) => h(p as never)),
  };
  return { conversation, workscene, emit };
}

const initial: ActiveConversation = {
  conversationId: "conv-1",
  name: "主对话",
  mode: { kind: "main" },
};

function conversationEntry(
  conversationId: string,
  name = conversationId,
) {
  return {
    conversationId,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-03T00:00:00.000Z",
    active: false,
    busy: false,
    observerCount: 0,
    pendingCount: 0,
  };
}

function rubricDraft(turnId: string) {
  return {
    draftId: "draft-1",
    originalTurnId: turnId,
    source: "generated" as const,
    candidateRubricIds: [],
    title: "代码审查",
    description: "确认开发结果是否满足需求。",
    content: {
      passCriteria: ["测试通过"],
      evidenceRequirements: [
        {
          id: "evidence-tests",
          kind: "test-result" as const,
          description: "测试结果",
          required: true,
        },
      ],
      failureHandling: [
        {
          id: "retry",
          scenario: "测试失败",
          reply: "请修复失败测试后继续。",
        },
      ],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function statusNotice(
  runId: string,
  statusRevision: number,
  state: "running" | "failed",
) {
  return {
    v: 1 as const,
    ref: { execution: "conversation" as const, conversationId: "conv-1", runId },
    state,
    ...(state === "failed" ? { reason: "durable failure" } : {}),
    statusRevision,
    actions: [] as [],
    at: "2026-07-18T00:00:00.000Z",
  };
}

function makeController(
  f: ReturnType<typeof makeFakes>,
  onYield = vi.fn(),
  observed: {
    onObservedTurnDelta?: (turn: {
      conversationId: string;
      turnId?: string;
    }) => void;
    onObservedTurnComplete?: (turn: {
      conversationId: string;
      turnId?: string;
    }) => void;
    onActivity?: (activity: unknown) => void;
  } = {},
) {
  const controller = new ConversationController(
    {
      conversation: f.conversation as unknown as RpcConversationFacade,
      workscene: f.workscene as unknown as RpcWorksceneFacade,
      onYield,
      ...observed,
    },
    initial,
  );
  return { controller, onYield };
}

describe("ConversationController", () => {
  it("selectInitialConversation:启动恢复跳过 list/resume 之间被删除的 stale 候选", async () => {
    const conversation = {
      list: vi.fn(async () => [
        conversationEntry("conv-stale", "刚被删的对话"),
        conversationEntry("conv-latest", "最近对话"),
      ]),
      resumeIfExists: vi.fn(async (id: string) =>
        id === "conv-latest"
          ? {
              conversationId: id,
              name: "最近对话",
              active: false,
              busy: false,
            }
          : null,
      ),
      newConversation: vi.fn(async () => ({
        conversationId: "conv-new",
        name: "新对话",
      })),
    };

    const selected = await selectInitialConversation(conversation);

    expect(selected).toEqual({
      active: {
        conversationId: "conv-latest",
        name: "最近对话",
        mode: { kind: "main" },
      },
      resumedConversationName: "最近对话",
    });
    expect(conversation.resumeIfExists).toHaveBeenCalledWith("conv-stale");
    expect(conversation.resumeIfExists).toHaveBeenCalledWith("conv-latest");
    expect(conversation.newConversation).not.toHaveBeenCalled();
  });

  it("selectInitialConversation:跳过工作场景候选;main 候选全失效时新建主对话", async () => {
    const conversation = {
      list: vi.fn(async () => [
        conversationEntry("ws:scene-1:conv-9", "写作场景对话"),
        conversationEntry("conv-stale", "刚被删的对话"),
      ]),
      resumeIfExists: vi.fn(async () => null),
      newConversation: vi.fn(async () => ({
        conversationId: "conv-new",
        name: "新对话",
      })),
    };

    await expect(selectInitialConversation(conversation)).resolves.toEqual({
      active: {
        conversationId: "conv-new",
        name: "新对话",
        mode: { kind: "main" },
      },
      resumedConversationName: null,
    });
    expect(conversation.resumeIfExists).toHaveBeenCalledTimes(1);
    expect(conversation.resumeIfExists).toHaveBeenCalledWith("conv-stale");
  });

  it("start / resume / newConversation 维护当前对话 observer 订阅", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-1");

    await controller.resume("conv-2");
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("conv-1");
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-2");

    await controller.newConversation();
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("conv-2");
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-new");
  });

  it("reattachActiveObserver:宿主换代后强制重挂当前对话 observer", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    await controller.reattachActiveObserver();

    expect(f.conversation.unsubscribe).not.toHaveBeenCalled();
    expect(f.conversation.subscribe).toHaveBeenCalledTimes(2);
    expect(f.conversation.subscribe).toHaveBeenNthCalledWith(1, "conv-1");
    expect(f.conversation.subscribe).toHaveBeenNthCalledWith(2, "conv-1");
  });

  it("uses the authority run id for an explicit durable abort", async () => {
    const f = makeFakes();
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        runId: "authority-run-1",
      }),
    );
    const { controller } = makeController(f);

    const accepted = await controller.beginTurn("long task");
    await controller.abort();

    expect(f.conversation.abort).toHaveBeenCalledWith(
      "conv-1",
      expect.stringMatching(/^cancel:turn_/u),
      "authority-run-1",
    );
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: accepted.turnId,
      result: { reason: "aborted" },
    });
    await accepted.outcome;
  });

  it("defers abort until the send response supplies the authority run id", async () => {
    const f = makeFakes();
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => {
        await responseGate;
        return {
          conversationId: "conv-1",
          sessionId: "conv-1",
          turnId,
          runId: "authority-run-delayed",
        };
      },
    );
    const { controller } = makeController(f);

    const accepting = controller.beginTurn("cancel before response");
    await vi.waitFor(() => expect(f.conversation.send).toHaveBeenCalledOnce());
    const aborting = controller.abort();
    expect(f.conversation.abort).not.toHaveBeenCalled();

    release();
    const accepted = await accepting;
    await aborting;
    expect(f.conversation.abort).toHaveBeenCalledWith(
      "conv-1",
      expect.stringMatching(/^cancel:turn_/u),
      "authority-run-delayed",
    );

    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: accepted.turnId,
      result: { reason: "aborted" },
    });
    await accepted.outcome;
  });

  it("settles a queued abort when durable admission fails before returning a run id", async () => {
    const f = makeFakes();
    let rejectSend!: (error: unknown) => void;
    f.conversation.send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );
    const { controller } = makeController(f);

    const accepting = controller.beginTurn("admission fails");
    await vi.waitFor(() => expect(f.conversation.send).toHaveBeenCalledOnce());
    const aborting = controller.abort();
    rejectSend(new Error("admission rejected"));

    await expect(accepting).rejects.toThrow("admission rejected");
    await expect(aborting).resolves.toBeUndefined();
    expect(f.conversation.abort).not.toHaveBeenCalled();
  });

  it("binds a final received before the send response to the returned authority run", async () => {
    const f = makeFakes();
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => {
        await responseGate;
        return {
          conversationId: "conv-1",
          sessionId: "conv-1",
          turnId,
          runId: "authority-run-final",
        };
      },
    );
    f.conversation.history.mockResolvedValue({
      runs: [
        {
          shardId: "shard-1",
          record: {
            runId: "authority-run-final",
            runIndex: 1,
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [
              { role: "assistant", content: [{ type: "text", text: "durable final" }] },
            ],
            usage: { inputTokens: 2, outputTokens: 3 },
          },
        },
      ],
      hasMore: false,
    });
    const { controller } = makeController(f);

    const accepting = controller.beginTurn("response may be lost");
    await vi.waitFor(() => expect(f.conversation.send).toHaveBeenCalledOnce());
    f.emit.final({
      v: 1,
      conversationId: "conv-1",
      runId: "authority-run-final",
      commitRevision: 1,
      digest: `sha256:${"a".repeat(64)}`,
    });
    release();
    const accepted = await accepting;

    await expect(accepted.outcome).resolves.toMatchObject({
      result: {
        reason: "completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "durable final" }],
        },
        usage: { inputTokens: 2, outputTokens: 3 },
      },
    });
  });

  it("reconciles a replayed committed run even when its live final was missed", async () => {
    const f = makeFakes();
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        runId: "authority-run-replayed",
      }),
    );
    f.conversation.history.mockResolvedValue({
      runs: [
        {
          shardId: "shard-1",
          record: {
            runId: "authority-run-replayed",
            runIndex: 1,
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [
              { role: "assistant", content: [{ type: "text", text: "already committed" }] },
            ],
            usage: { inputTokens: 1, outputTokens: 2 },
          },
        },
      ],
      hasMore: false,
    });
    const { controller } = makeController(f);

    const accepted = await controller.beginTurn("retry after response loss");

    await expect(accepted.outcome).resolves.toMatchObject({
      result: {
        reason: "completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "already committed" }],
        },
      },
    });
  });

  it("retries final history after transient projection misses and link failure", async () => {
    const f = makeFakes();
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        runId: "authority-run-lagging-history",
      }),
    );
    f.conversation.history
      .mockRejectedValueOnce(new Error("projection unavailable"))
      .mockResolvedValueOnce({ runs: [], hasMore: false })
      .mockResolvedValueOnce({
        runs: [
          {
            shardId: "shard-1",
            record: {
              runId: "authority-run-lagging-history",
              runIndex: 1,
              timestamp: "2026-07-18T00:00:00.000Z",
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "projection caught up" }],
                },
              ],
              usage: { inputTokens: 1, outputTokens: 2 },
            },
          },
        ],
        hasMore: false,
      });
    const { controller } = makeController(f);

    const accepted = await controller.beginTurn("wait for projection");
    f.emit.final({
      v: 1,
      conversationId: "conv-1",
      runId: "authority-run-lagging-history",
      commitRevision: 1,
      digest: `sha256:${"b".repeat(64)}`,
    });

    await expect(accepted.outcome).resolves.toMatchObject({
      result: {
        reason: "completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "projection caught up" }],
        },
      },
    });
    expect(f.conversation.history).toHaveBeenCalledTimes(3);
  });

  it("consumes every paged status notice after reconnect", async () => {
    const f = makeFakes();
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        runId: "authority-run-status",
      }),
    );
    f.conversation.statusHistory
      .mockResolvedValueOnce({
        notices: [statusNotice("authority-run-status", 1, "running")],
        next: [
          {
            conversationId: "conv-1",
            runId: "authority-run-status",
            afterStatusRevision: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        notices: [statusNotice("authority-run-status", 2, "failed")],
        next: [],
      });
    const { controller } = makeController(f);
    const accepted = await controller.beginTurn("reconnect me");

    await controller.reattachActiveObserver();

    await expect(accepted.outcome).resolves.toMatchObject({
      result: { reason: "error", error: { name: "RunFailed" } },
    });
    expect(f.conversation.statusHistory).toHaveBeenCalledTimes(2);
  });

  it("sendTurn:等待该对话 complete 落定;意图先于 complete 到达、随 outcome 带出", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    const turn = controller.sendTurn("帮我进写作场景");
    await Promise.resolve();
    const turnId = f.conversation.send.mock.calls[0]![2] as string;
    f.emit.intent({
      conversationId: "conv-1",
      turnId,
      intent: { kind: "enter", sceneId: "scene-1" },
      conflict: { kindsSeen: ["exit", "enter"] },
    });
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      result: { reason: "completed" },
    });

    const outcome = await turn;
    expect(outcome.result.reason).toBe("completed");
    expect(outcome.postTurnControl).toEqual({
      intent: { kind: "enter", sceneId: "scene-1" },
      conflict: { kindsSeen: ["exit", "enter"] },
    });
    expect(f.conversation.send).toHaveBeenCalledWith(
      "帮我进写作场景",
      "conv-1",
      turnId,
    );
  });

  it("beginTurn:send 接受后返回 turn 边界;outcome 仍等待 complete 落定", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);
    const onAccepted = vi.fn();

    const acceptedTurn = await controller.beginTurn("queued turn", {
      onAccepted,
    });
    const turnId = f.conversation.send.mock.calls[0]![2] as string;
    let settled = false;
    void acceptedTurn.outcome.then(() => {
      settled = true;
    });

    expect(acceptedTurn).toMatchObject({
      conversationId: "conv-1",
      turnId,
    });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({
      conversationId: "conv-1",
      turnId,
    });
    expect(settled).toBe(false);
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      result: { reason: "completed" },
    });
    await expect(acceptedTurn.outcome).resolves.toMatchObject({
      result: { reason: "completed" },
    });
  });

  it("beginUserTurn:多视角 engage 透传给宿主 send", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    const result = await controller.beginUserTurn("@ 审查方案", {
      engage: { kind: "perspectives", question: "审查方案" },
    });

    expect(result.kind).toBe("accepted");
    const turnId = f.conversation.send.mock.calls[0]![2] as string;
    expect(f.conversation.send).toHaveBeenCalledWith(
      "@ 审查方案",
      "conv-1",
      turnId,
      { engage: { kind: "perspectives", question: "审查方案" } },
    );
  });

  it("beginUserTurn:Rubric 待确认是控制面结果,不等待 complete", async () => {
    const f = makeFakes();
    const onAccepted = vi.fn();
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        status: "awaiting-rubric-confirmation",
        advancementSessionId: "adv-1",
        rubricDraftId: "draft-1",
        rubricDraft: rubricDraft(turnId),
      }),
    );
    const { controller } = makeController(f);

    const result = await controller.beginUserTurn("审查开发结果", {
      onAccepted,
    });

    expect(result).toMatchObject({
      kind: "awaiting-rubric-confirmation",
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      rubricDraftId: "draft-1",
    });
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("beginUserTurn:Rubric 草案失败是受控结果,不等待 complete", async () => {
    const f = makeFakes();
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => ({
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        status: "contract-failed",
        error: { message: "草案生成失败" },
      }),
    );
    const { controller } = makeController(f);

    await expect(controller.beginUserTurn("审查开发结果")).resolves.toEqual(
      expect.objectContaining({
        kind: "contract-failed",
        error: { message: "草案生成失败" },
      }),
    );
  });

  it("confirmRubricContract:确认后用原 turnId 等待执行 complete", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);
    const onAccepted = vi.fn();
    const pending = {
      kind: "awaiting-rubric-confirmation" as const,
      conversationId: "conv-1",
      turnId: "turn-rubric",
      advancementSessionId: "adv-1",
      rubricDraftId: "draft-1",
      rubricDraft: rubricDraft("turn-rubric"),
    };
    f.conversation.confirmAdvancement.mockResolvedValueOnce({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-rubric",
      status: "confirmed",
      advancementSessionId: "adv-1",
      runStatus: "immediate",
      rubricPublicationMessage: "已用于本任务，连接值班设备后保存",
    });

    const acceptedTurn = await controller.confirmRubricContract(pending, {
      onAccepted,
    });
    let settled = false;
    void acceptedTurn.outcome.then(() => {
      settled = true;
    });

    // 携带发起端所见草案版本——宿主据此拒绝「确认到没看过的修订」
    expect(f.conversation.confirmAdvancement).toHaveBeenCalledWith(
      "conv-1",
      "adv-1",
      "draft-1",
      undefined,
    );
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({
      conversationId: "conv-1",
      turnId: "turn-rubric",
    });
    expect(settled).toBe(false);
    expect(acceptedTurn.rubricPublicationMessage).toBe(
      "已用于本任务，连接值班设备后保存",
    );

    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-rubric",
      result: { reason: "completed" },
    });
    await expect(acceptedTurn.outcome).resolves.toMatchObject({
      result: { reason: "completed" },
    });
  });

  it("cancelRubricContract:降级直接执行时复用原 turnId 等待 complete", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);
    const pending = {
      kind: "awaiting-rubric-confirmation" as const,
      conversationId: "conv-1",
      turnId: "turn-rubric",
      advancementSessionId: "adv-1",
      rubricDraftId: "draft-1",
      rubricDraft: rubricDraft("turn-rubric"),
    };
    f.conversation.cancelAdvancement.mockResolvedValueOnce({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-rubric",
      status: "direct-execution",
      advancementSessionId: "adv-1",
      runStatus: "immediate",
    });

    const result = await controller.cancelRubricContract(pending, {
      executeOriginal: true,
    });

    expect(f.conversation.cancelAdvancement).toHaveBeenCalledWith(
      "conv-1",
      "adv-1",
      { executeOriginal: true },
    );
    expect(result.kind).toBe("direct-execution");
    if (result.kind !== "direct-execution") throw new Error("unexpected result");
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-rubric",
      result: { reason: "completed" },
    });
    await expect(result.turn.outcome).resolves.toMatchObject({
      result: { reason: "completed" },
    });
  });

  it("reviseRubricContract:按用户反馈取得新版待确认草案", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);
    const pending = {
      kind: "awaiting-rubric-confirmation" as const,
      conversationId: "conv-1",
      turnId: "turn-rubric",
      advancementSessionId: "adv-1",
      rubricDraftId: "draft-1",
      rubricDraft: rubricDraft("turn-rubric"),
    };

    const revised = await controller.reviseRubricContract(
      pending,
      "请增加文档验收",
    );

    expect(f.conversation.reviseAdvancement).toHaveBeenCalledWith(
      "conv-1",
      "adv-1",
      "请增加文档验收",
    );
    expect(revised).toMatchObject({
      kind: "awaiting-rubric-confirmation",
      turnId: "turn-rubric",
      rubricDraftId: "draft-revised",
      rubricDraft: { title: "修订后的推进准则" },
    });
  });

  it("reviseRubricContract:拒绝服务端返回不匹配的原始 turn", async () => {
    const f = makeFakes();
    f.conversation.reviseAdvancement.mockResolvedValueOnce({
      conversationId: "conv-1",
      sessionId: "conv-1",
      status: "revised",
      advancementSessionId: "adv-1",
      rubricDraftId: "draft-revised",
      rubricDraft: {
        ...rubricDraft("turn-other"),
        draftId: "draft-revised",
      },
    });
    const { controller } = makeController(f);

    await expect(
      controller.reviseRubricContract(
        {
          kind: "awaiting-rubric-confirmation",
          conversationId: "conv-1",
          turnId: "turn-rubric",
          advancementSessionId: "adv-1",
          rubricDraftId: "draft-1",
          rubricDraft: rubricDraft("turn-rubric"),
        },
        "请增加文档验收",
      ),
    ).rejects.toThrow("unexpected turnId");
  });

  it("beginTurn:本地 delta 早于 send 响应时先触发 accepted 再交给渲染", async () => {
    const f = makeFakes();
    let releaseSend = () => {
      throw new Error("send 未开始");
    };
    f.conversation.send.mockImplementationOnce(
      async (_text: string, _id: string, turnId: string) => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        return {
          conversationId: "conv-1",
          sessionId: "conv-1",
          turnId,
        };
      },
    );
    const order: string[] = [];
    const onAccepted = vi.fn(() => {
      order.push("accepted");
    });
    const onYield = vi.fn(() => {
      order.push("yield");
    });
    const { controller } = makeController(f, onYield);

    const acceptedPromise = controller.beginTurn("queued turn", { onAccepted });
    await Promise.resolve();
    const turnId = f.conversation.send.mock.calls[0]![2] as string;
    const frame: AgentYield = { type: "text_delta", text: "hi" };
    f.emit.delta({
      conversationId: "conv-1",
      turnId,
      delta: frame,
    });

    expect(order).toEqual(["accepted", "yield"]);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({
      conversationId: "conv-1",
      turnId,
    });
    expect(onYield).toHaveBeenCalledWith(frame);

    releaseSend();
    const acceptedTurn = await acceptedPromise;
    expect(acceptedTurn.turnId).toBe(turnId);
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      result: { reason: "completed" },
    });
    await expect(acceptedTurn.outcome).resolves.toMatchObject({
      result: { reason: "completed" },
    });
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it("sendTurn:同一对话的其它 turn complete 不会误唤醒本地等待", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    const turn = controller.sendTurn("queued turn");
    await Promise.resolve();
    const turnId = f.conversation.send.mock.calls[0]![2] as string;
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn_previous",
      result: { reason: "completed" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      result: { reason: "completed" },
    });
    await expect(turn).resolves.toMatchObject({
      result: { reason: "completed" },
    });
  });

  it("send 失败(BUSY 等):waiter 撤除并原样抛出", async () => {
    const f = makeFakes();
    f.conversation.send.mockRejectedValueOnce(new Error("BUSY"));
    const { controller } = makeController(f);

    await expect(controller.sendTurn("hi")).rejects.toThrow("BUSY");
    // 后续 complete 不该 resolve 任何东西(waiter 已撤)——不抛即可
    f.emit.complete({
      conversationId: "conv-1",
      turnId: "turn-ignored",
      result: { reason: "completed" },
    });
  });

  it("主通道按当前对话过滤喂 onYield;旁观其它对话的帧不进渲染", () => {
    const f = makeFakes();
    const onYield = vi.fn();
    makeController(f, onYield);

    const frame: AgentYield = { type: "text_delta", text: "hi" };
    f.emit.delta({
      conversationId: "conv-1",
      turnId: "turn-observed",
      delta: frame,
    });
    f.emit.delta({
      conversationId: "conv-other",
      turnId: "turn-other",
      delta: frame,
    });

    expect(onYield).toHaveBeenCalledTimes(1);
    expect(onYield).toHaveBeenCalledWith(frame);
  });

  it("activity 只通知非当前对话,不进入主渲染", () => {
    const f = makeFakes();
    const onYield = vi.fn();
    const onActivity = vi.fn();
    makeController(f, onYield, { onActivity });

    f.emit.activity({
      conversationId: "conv-1",
      source: "feishu",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      unreadHint: true,
      listInvalidated: true,
    });
    f.emit.activity({
      conversationId: "conv-other",
      source: "feishu",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      unreadHint: true,
      listInvalidated: true,
    });

    expect(onYield).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenCalledWith({
      conversationId: "conv-other",
      source: "feishu",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      unreadHint: true,
      listInvalidated: true,
    });
  });

  it("同一当前对话的非本地 turn 会标记为旁观 turn", () => {
    const f = makeFakes();
    const onYield = vi.fn();
    const onObservedTurnDelta = vi.fn();
    const onObservedTurnComplete = vi.fn();
    makeController(f, onYield, {
      onObservedTurnDelta,
      onObservedTurnComplete,
    });

    const frame: AgentYield = { type: "text_delta", text: "remote" };
    f.emit.delta({
      conversationId: "conv-1",
      turnId: "turn-remote",
      delta: frame,
    });
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-remote",
      result: { reason: "completed" },
    });

    expect(onYield).toHaveBeenCalledWith(frame);
    expect(onObservedTurnDelta).toHaveBeenCalledWith({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });
    expect(onObservedTurnComplete).toHaveBeenCalledWith({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });
  });

  it("本地 turn 不触发旁观 turn 通知", async () => {
    const f = makeFakes();
    const onObservedTurnDelta = vi.fn();
    const onObservedTurnComplete = vi.fn();
    const { controller } = makeController(f, vi.fn(), {
      onObservedTurnDelta,
      onObservedTurnComplete,
    });

    const turn = controller.sendTurn("local turn");
    await Promise.resolve();
    const turnId = f.conversation.send.mock.calls[0]![2] as string;

    f.emit.delta({
      conversationId: "conv-1",
      turnId,
      delta: { type: "text_delta", text: "own" },
    });
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      result: { reason: "completed" },
    });

    await turn;
    expect(onObservedTurnDelta).not.toHaveBeenCalled();
    expect(onObservedTurnComplete).not.toHaveBeenCalled();
  });

  it("sendTurn:本地等待期间只渲染本 turn 的 delta,不混入同对话上一轮输出", async () => {
    const f = makeFakes();
    const onYield = vi.fn();
    const { controller } = makeController(f, onYield);

    const turn = controller.sendTurn("queued turn");
    await Promise.resolve();
    const turnId = f.conversation.send.mock.calls[0]![2] as string;
    const previousFrame: AgentYield = { type: "text_delta", text: "old" };
    const ownFrame: AgentYield = { type: "text_delta", text: "own" };

    f.emit.delta({
      conversationId: "conv-1",
      turnId: "turn_previous",
      delta: previousFrame,
    });
    f.emit.delta({ conversationId: "conv-1", turnId, delta: ownFrame });
    f.emit.complete({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId,
      result: { reason: "completed" },
    });

    await turn;
    expect(onYield).toHaveBeenCalledTimes(1);
    expect(onYield).toHaveBeenCalledWith(ownFrame);
  });

  it("enterScene 切指针到场景对话(模式由全域键派生);exitScene 经宿主确认后切回 main 目标", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    const entered = await controller.enterScene("scene-1");
    expect(entered.active.conversationId).toBe("ws:scene-1:conv-9");
    expect(entered.active.mode).toEqual({
      kind: "workscene",
      sceneId: "scene-1",
      sceneName: "写作场景",
    });
    expect(controller.current).toBe(entered.active);

    const exited = await controller.exitScene(initial);
    expect(exited).toEqual({ kind: "returned", active: initial });
    expect(f.conversation.resumeIfExists).toHaveBeenCalledWith("conv-1");
    expect(f.workscene.exit).toHaveBeenCalledWith(
      "scene-1",
      "ws:scene-1:conv-9",
    );
    expect(controller.current).toEqual(initial);
  });

  it("setCurrentSceneWorkdirAndReenter:撤 observer 后落盘并按新工作区重进", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    await controller.enterScene("scene-1");
    f.conversation.unsubscribe.mockClear();
    f.conversation.subscribe.mockClear();

    const result = await controller.setCurrentSceneWorkdirAndReenter(
      "scene-1",
      { deviceId: "device-a", bindingRef: "binding-a" },
    );

    expect(result.kind).toBe("reentered");
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("ws:scene-1:conv-9");
    expect(f.workscene.setWorkdir).toHaveBeenCalledWith(
      "scene-1",
      { deviceId: "device-a", bindingRef: "binding-a" },
    );
    expect(f.workscene.enter).toHaveBeenLastCalledWith("scene-1");
    expect(controller.current.mode).toEqual({
      kind: "workscene",
      sceneId: "scene-1",
      sceneName: "写作场景",
    });
  });

  it("setCurrentSceneWorkdirAndReenter:setWorkdir 失败时重挂原 observer，不切指针", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    await controller.enterScene("scene-1");
    f.workscene.setWorkdir.mockRejectedValueOnce(new Error("BUSY"));
    f.conversation.unsubscribe.mockClear();
    f.conversation.subscribe.mockClear();

    const result = await controller.setCurrentSceneWorkdirAndReenter(
      "scene-1",
      null,
    );

    expect(result.kind).toBe("set-failed");
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("ws:scene-1:conv-9");
    expect(f.conversation.subscribe).toHaveBeenCalledWith("ws:scene-1:conv-9");
    expect(controller.current.conversationId).toBe("ws:scene-1:conv-9");
  });

  it("setCurrentSceneWorkdirAndReenter:场景并发删除时不重挂旧 observer，交给接入面回主对话", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    await controller.enterScene("scene-1");
    f.workscene.setWorkdir.mockRejectedValueOnce(
      new RpcClientError(RPC_ERROR_CODES.NOT_FOUND, "Workscene not found"),
    );
    f.conversation.unsubscribe.mockClear();
    f.conversation.subscribe.mockClear();

    const result = await controller.setCurrentSceneWorkdirAndReenter(
      "scene-1",
      { deviceId: "device-a", bindingRef: "binding-a" },
    );

    expect(result.kind).toBe("scene-missing");
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("ws:scene-1:conv-9");
    expect(f.conversation.subscribe).not.toHaveBeenCalled();
    expect(controller.current.conversationId).toBe("ws:scene-1:conv-9");
  });

  it("exitScene:进场前主对话已被其它接入面删除时,跳过 stale 候选并回退到宿主最新 main 对话", async () => {
    const f = makeFakes();
    f.conversation.resumeIfExists
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    f.conversation.list.mockResolvedValueOnce([
      {
        conversationId: "conv-stale",
        name: "刚被删的主对话",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-03T00:00:00.000Z",
        active: false,
        busy: false,
        observerCount: 0,
        pendingCount: 0,
      },
      {
        conversationId: "ws:scene-2:conv-scene",
        name: "另一个工作场景",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-02T12:00:00.000Z",
        active: false,
        busy: false,
        observerCount: 0,
        pendingCount: 0,
      },
      {
        conversationId: "conv-latest",
        name: "最近主对话",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-02T00:00:00.000Z",
        active: false,
        busy: false,
        observerCount: 0,
        pendingCount: 0,
      },
    ]);
    const { controller } = makeController(f);

    await controller.enterScene("scene-1");
    const exited = await controller.exitScene(initial);

    expect(exited.kind).toBe("fallback-latest");
    expect(controller.current).toEqual({
      conversationId: "conv-latest",
      name: "名-conv-latest",
      mode: { kind: "main" },
    });
    expect(f.conversation.resumeIfExists).toHaveBeenCalledWith("conv-stale");
    expect(f.conversation.resumeIfExists).not.toHaveBeenCalledWith(
      "ws:scene-2:conv-scene",
    );
    expect(f.conversation.resumeIfExists).toHaveBeenCalledWith("conv-latest");
    expect(f.conversation.resume).toHaveBeenCalledWith("conv-latest");
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-latest");
  });

  it("exitScene:无可用 main 对话时新建一个,不保留悬挂返回指针", async () => {
    const f = makeFakes();
    f.conversation.resumeIfExists.mockResolvedValueOnce(null);
    f.conversation.list.mockResolvedValueOnce([]);
    const { controller } = makeController(f);

    await controller.enterScene("scene-1");
    const exited = await controller.exitScene(initial);

    expect(exited.kind).toBe("fallback-new");
    expect(controller.current).toEqual({
      conversationId: "conv-new",
      name: "conv-new",
      mode: { kind: "main" },
    });
    expect(f.conversation.newConversation).toHaveBeenCalled();
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-new");
  });

  it("isWatching 在切换型 RPC 期间放行目标对话，完成后收敛回当前对话", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);
    expect(controller.isWatching("conv-1")).toBe(true);
    expect(controller.isWatching("conv-2")).toBe(false);

    // resume 期间：恢复事件的通知帧先于 RPC 响应到达，目标对话必须放行
    let observedDuringSwitch: boolean | undefined;
    f.conversation.resume.mockImplementationOnce(async (id: string) => {
      observedDuringSwitch = controller.isWatching(id);
      return { conversationId: id, name: `名-${id}`, mode: { kind: "main" } };
    });
    await controller.resume("conv-2");
    expect(observedDuringSwitch).toBe(true);
    expect(controller.isWatching("conv-2")).toBe(true); // 已是 current
    expect(controller.isWatching("conv-1")).toBe(false); // 切换窗口已关闭

    // enterScene 期间：目标 id 由宿主决定，按场景全域键前缀放行
    let scenePrefixWatched: boolean | undefined;
    f.workscene.enter.mockImplementationOnce(async (sceneId: string) => {
      scenePrefixWatched = controller.isWatching(`ws:${sceneId}:conv_main`);
      return {
        conversationId: `ws:${sceneId}:conv_main`,
        scene: { sceneId, name: "场景", createdAt: "t", lastActiveAt: "t" },
      };
    });
    await controller.enterScene("scene-9");
    expect(scenePrefixWatched).toBe(true);

    // 切换失败也要收敛：finally 清除切换窗口
    f.conversation.resume.mockRejectedValueOnce(new Error("down"));
    await expect(controller.resume("conv-ghost")).rejects.toThrow("down");
    expect(controller.isWatching("conv-ghost")).toBe(false);

    // exitScene 期间：窗口收敛到当次精确目标，不按整个 main 域放行
    let exitTargetWatched: boolean | undefined;
    let exitOtherMainWatched: boolean | undefined;
    f.conversation.resumeIfExists.mockImplementationOnce(async (id: string) => {
      exitTargetWatched = controller.isWatching(id);
      exitOtherMainWatched = controller.isWatching("conv-unrelated-main");
      return { conversationId: id, name: `名-${id}`, mode: { kind: "main" } };
    });
    const exited = await controller.exitScene({
      conversationId: "conv-2",
      name: "名-conv-2",
      mode: { kind: "main" },
    });
    expect(exited.kind).toBe("returned");
    expect(exitTargetWatched).toBe(true);
    expect(exitOtherMainWatched).toBe(false);
  });

  it("resume / newConversation 移动指针并返回新身份", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    const resumed = await controller.resume("conv-2");
    expect(resumed.active.name).toBe("名-conv-2");
    expect(controller.current.conversationId).toBe("conv-2");

    const created = await controller.newConversation();
    expect(created.conversationId).toBe("conv-new");
    expect(controller.current.mode).toEqual({ kind: "main" });
  });

  it("applySessionChanged 只响应当前对话的 renamed / cleared / deleted", () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    expect(
      controller.applySessionChanged({
        conversationId: "conv-other",
        change: "deleted",
      }),
    ).toEqual({ kind: "ignored" });
    expect(
      controller.applySessionChanged({
        conversationId: "conv-1",
        change: "taskList",
        taskList: null,
      }),
    ).toEqual({ kind: "ignored" });

    expect(
      controller.applySessionChanged({
        conversationId: "conv-1",
        change: "renamed",
        name: "新名字",
      }),
    ).toEqual({ kind: "renamed", name: "新名字" });
    expect(controller.current.name).toBe("新名字");

    expect(
      controller.applySessionChanged({
        conversationId: "conv-1",
        change: "cleared",
      }),
    ).toEqual({ kind: "cleared" });
    expect(
      controller.applySessionChanged({
        conversationId: "conv-1",
        change: "deleted",
      }),
    ).toEqual({ kind: "deleted" });
  });
});
