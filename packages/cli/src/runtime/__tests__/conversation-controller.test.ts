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
import type { AgentYield } from "@zhixing/core/loop";
import { RPC_ERROR_CODES, RpcClientError } from "@zhixing/server";
import {
  ConversationController,
  selectInitialConversation,
  type ActiveConversation,
} from "../conversation-controller.js";
import type { RpcConversationFacade } from "../rpc-conversation-facade.js";
import type { RpcWorksceneFacade } from "../rpc-workscene-facade.js";
import { createObservedTurnPresenter } from "../observed-turn-presenter.js";

type Handler<T> = (p: T) => void;

function makeFakes() {
  const handlers = {
    delta: [] as Handler<never>[],
    complete: [] as Handler<never>[],
    final: [] as Handler<never>[],
    status: [] as Handler<never>[],
    activity: [] as Handler<never>[],
    intent: [] as Handler<never>[],
    assignment: [] as Handler<never>[],
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
    onAssignmentStream: (h: Handler<never>) => {
      handlers.assignment.push(h);
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
    tasks: vi.fn(async (_conversationId: string) => [] as Array<{ conversationId: string; runId: string; goal: string }>),
    stopTask: vi.fn(async (_conversationId: string, _target: { conversationId: string; runId: string }, _requestId: string) => {}),
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
    assignment: (p: unknown) => handlers.assignment.forEach((h) => h(p as never)),
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
    onObservedInputs?: import("../conversation-controller.js").ConversationControllerOptions["onObservedInputs"];
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
  it("all three status readers stop at unchanged durable watermarks and retain live delivery", async () => {
    const f = makeFakes();
    const { controller, onYield } = makeController(f);
    let calls = 0;
    const cursor = { conversationId: "conv-1", runId: "run-waiter", afterStatusRevision: 0 };
    f.conversation.send.mockResolvedValueOnce({ conversationId: "conv-1", sessionId: "conv-1", turnId: "turn-waiter", runId: cursor.runId });
    f.conversation.statusHistory.mockImplementation(async (...args: unknown[]) => {
      if (++calls > 3) throw new Error("unexpected repeated status request");
      return { notices: [], next: args[0] } as never;
    });
    try {
      await controller.start();
      const accepted = await controller.beginTurn("用户任务");
      await vi.waitFor(() => expect(f.conversation.statusHistory).toHaveBeenCalledOnce());
      f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId: "run-observed", message: { role: "user", content: [{ type: "text", text: "通信任务" }], inputIdentity: { id: "m", source: { kind: "conversation", conversationId: "a" } } } }] } as never);
      await controller.reattachActiveObserver();
      expect(f.conversation.statusHistory).toHaveBeenCalledTimes(3);
      f.emit.status(statusNotice(cursor.runId, 1, "failed"));
      await expect(accepted.outcome).resolves.toMatchObject({ result: { reason: "error" } });
      f.emit.status(statusNotice("run-observed", 1, "failed"));
      await vi.waitFor(() => expect(JSON.stringify(onYield.mock.calls)).toContain("来信处理未完成：durable failure"));
    } finally { controller.dispose(); }
  });
  it.each(["failed", "cancelled", "expired"] as const)("reconnect reconciles %s communication with and without a previously observed frame", async state => {
    const f = makeFakes(), writer = { line: vi.fn(), ensureSegmentBreak: vi.fn() };
    const presenter = createObservedTurnPresenter({ writer, flushOutput: vi.fn(), isLocalTurn: () => false, width: () => 160 });
    const { controller, onYield } = makeController(f, vi.fn(), {
      onObservedInputs: value => presenter.onObservedInputs(value),
      onObservedTurnDelta: value => presenter.onObservedTurnDelta(value),
      onObservedTurnComplete: value => presenter.onObservedTurnComplete(value),
    });
    const identity = (id: string) => ({ id, source: { kind: "conversation", conversationId: id } });
    const frame = { v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: "seen", ownerEpoch: 1 }, assignmentId: "assignment", streamEpoch: 1, seq: 1,
      meta: { turnOrigin: { channel: "rpc", messageIdentity: identity("source-seen") } }, payload: { kind: "agent-event", event: { event: "agent:run_start", payload: { prompt: "已见的任务" } } } };
    const notices = ["seen", "offline"].map(runId => ({ ...statusNotice(runId, 3, state), reason: "offline terminal" }));
    f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: ["seen", "offline"].map(runId => ({ runId, state, consumed: true, disposition: "consumed",
      message: { role: "user", content: [{ type: "text", text: runId === "seen" ? "已见的任务" : "离线任务" }], inputIdentity: identity(`source-${runId}`) } })) } as never);
    f.conversation.statusHistory.mockResolvedValueOnce({ notices: [notices[0]], next: [{ conversationId: "conv-1", runId: "offline", afterStatusRevision: 1 }] } as never)
      .mockResolvedValueOnce({ notices: [notices[1]], next: [] } as never);
    try {
      await controller.start();
      f.emit.assignment(frame);
      await controller.reattachActiveObserver();
      await vi.waitFor(() => expect(onYield).toHaveBeenCalledTimes(2));
      expect(f.conversation.statusHistory).toHaveBeenNthCalledWith(1, [
        { conversationId: "conv-1", runId: "seen", afterStatusRevision: 0 },
        { conversationId: "conv-1", runId: "offline", afterStatusRevision: 0 },
      ]);
      expect(writer.line).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(writer.line.mock.calls)).toContain("source-offline");
      await controller.reattachActiveObserver();
      for (const notice of notices) f.emit.status(notice);
      f.emit.assignment({ ...frame, seq: 2, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "迟到输出" } } });
      expect(f.conversation.statusHistory).toHaveBeenCalledTimes(2);
      expect(writer.line).toHaveBeenCalledTimes(2);
      expect(onYield).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(onYield.mock.calls)).not.toContain("迟到输出");
    } finally { controller.dispose(); }
  });

  it("does not reconcile another conversation after switching during reconnect history read", async () => {
    const f = makeFakes();
    let finish!: (value: never) => void;
    f.conversation.history.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { controller, onYield } = makeController(f);
    try {
      const reconnect = controller.reattachActiveObserver();
      await vi.waitFor(() => expect(f.conversation.history).toHaveBeenCalled());
      controller.setActive({ conversationId: "other", name: "other", mode: { kind: "main" } });
      finish({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId: "old-run", message: { inputIdentity: { source: { kind: "conversation", conversationId: "a" } } } }] } as never);
      await reconnect;
      expect(f.conversation.statusHistory).not.toHaveBeenCalled();
      expect(onYield).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });

  it.each(["failed", "cancelled", "expired"] as const)("terminal before stream: %s keeps source and terminal once across retries, old revisions and late frames", async (state) => {
    const f = makeFakes(), writer = { line: vi.fn(), ensureSegmentBreak: vi.fn() };
    const presenter = createObservedTurnPresenter({ writer, flushOutput: vi.fn(), isLocalTurn: () => false, width: () => 160 });
    const { controller, onYield } = makeController(f, vi.fn(), {
      onObservedInputs: value => presenter.onObservedInputs(value),
      onObservedTurnDelta: value => presenter.onObservedTurnDelta(value),
      onObservedTurnComplete: value => presenter.onObservedTurnComplete(value),
    });
    const identity = { id: "message", source: { kind: "conversation", conversationId: "source-a" } };
    f.conversation.history.mockRejectedValueOnce(new Error("temporary disconnect"));
    f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId: "peer-run", state, message: { role: "user", content: [{ type: "text", text: "核实任务" }], inputIdentity: identity } }] } as never);
    const ref = { execution: "conversation", conversationId: "conv-1", runId: "peer-run", ownerEpoch: 1 };
    const notice = { v: 1, ref, state, reason: "fixture terminal", statusRevision: 3, at: "2026-09-16T00:00:00Z", actions: [] };
    f.emit.status(notice);
    f.emit.status({ ...notice, state: "running", statusRevision: 1 });
    f.emit.status({ ...notice, state: "cancelled", statusRevision: 2 });
    f.emit.status(notice);
    await vi.waitFor(() => expect(onYield).toHaveBeenCalledOnce());
    expect(f.conversation.history).toHaveBeenCalledTimes(2);
    expect(writer.line).toHaveBeenCalledOnce();
    expect(writer.line.mock.calls[0]?.[0]).toContain("来自对话 source-a: 核实任务");
    expect(onYield.mock.calls[0]?.[0].text).toContain(state === "cancelled" ? "已停止" : "未完成：fixture terminal");
    const base = { v: 1, ref, assignmentId: "assignment", streamEpoch: 1, meta: { turnOrigin: { channel: "rpc", messageIdentity: identity } } };
    f.emit.assignment({ ...base, seq: 1, payload: { kind: "agent-event", event: { event: "agent:run_start", payload: { prompt: "核实任务" } } } });
    f.emit.assignment({ ...base, seq: 2, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "迟到输出" } } });
    f.emit.status(notice);
    expect(onYield).toHaveBeenCalledOnce(); expect(writer.line).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("a terminal status blocks late output even while its source read is unavailable and ignores other conversations", async () => {
    const f = makeFakes(), complete = vi.fn(), inputs = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedTurnComplete: complete, onObservedInputs: inputs });
    let read!: (value: never) => void;
    f.conversation.history.mockImplementation(() => new Promise(resolve => { read = resolve; }));
    const ref = { execution: "conversation", conversationId: "conv-1", runId: "peer-run", ownerEpoch: 1 };
    const notice = { v: 1, ref, state: "failed", statusRevision: 2, at: "2026-09-16T00:00:00Z", actions: [] };
    f.emit.status({ ...notice, ref: { ...ref, conversationId: "other" } });
    expect(f.conversation.history).not.toHaveBeenCalled();
    f.emit.status(notice);
    f.emit.assignment({ v: 1, ref, seq: 1, assignmentId: "assignment", streamEpoch: 1, meta: { turnOrigin: { channel: "rpc", messageIdentity: { id: "m", source: { kind: "conversation", conversationId: "source-a" } } } }, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "不应显示" } } });
    expect(onYield).not.toHaveBeenCalled();
    read({ runs: [], hasMore: false, inputsOutsideHistory: [] } as never);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(JSON.stringify(onYield.mock.calls)).not.toContain("不应显示");
    controller.dispose();
  });

  it.each(["user", "continuation"] as const)("mixed input terminal: %s recovers appended sources without repeating terminal output", async mode => {
    const f = makeFakes(), writer = { line: vi.fn(), ensureSegmentBreak: vi.fn() }, complete = vi.fn();
    const presenter = createObservedTurnPresenter({ writer, flushOutput: vi.fn(), isLocalTurn: () => mode === "user", width: () => 160 });
    const { controller, onYield } = makeController(f, vi.fn(), {
      onObservedInputs: value => presenter.onObservedInputs(value),
      onObservedTurnDelta: value => presenter.onObservedTurnDelta(value),
      onObservedTurnComplete: value => { complete(value); presenter.onObservedTurnComplete(value); },
    });
    try {
      const turn = mode === "user" ? await controller.beginTurn("用户要求") : undefined;
      const runId = turn?.runId ?? "continuation";
      const ref = { execution: "conversation", conversationId: "conv-1", runId, ownerEpoch: 1 };
      const origin = { channel: "rpc", worksceneContinuation: { kind: "result", conversationId: "ws:review:primary", runId: "child" } };
      if (!turn) f.emit.assignment({ v: 1, ref, assignmentId: "assignment", streamEpoch: 1, seq: 1, meta: { turnOrigin: origin }, payload: { kind: "agent-event", event: { event: "agent:run_start", payload: { prompt: "原任务续接" } } } });
      const identity = { id: "append-a", source: { kind: "conversation", conversationId: "source-a" } };
      f.conversation.history.mockRejectedValueOnce(new Error("temporary disconnect"));
      f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId, state: "failed", message: { role: "user", content: [{ type: "text", text: "追加检查要求" }], inputIdentity: identity } }, { runId: "other-run", message: { role: "user", content: [{ type: "text", text: "别的任务" }], inputIdentity: { ...identity, id: "other" } } }] } as never);
      const notice = { v: 1, ref, state: "failed", reason: "fixture failure", statusRevision: 3, at: "2026-09-16T00:00:00Z", actions: [] };
      f.emit.status(notice);
      if (turn) expect((await turn.outcome).result.reason).toBe("error");
      // 终态不等待来源读取，来源瞬断后仍可独立补齐。
      expect(onYield).toHaveBeenCalledTimes(turn ? 0 : 1);
      await vi.waitFor(() => expect(writer.line).toHaveBeenCalledOnce());
      expect(writer.line.mock.calls[0]?.[0]).toContain("来自对话 source-a: 追加检查要求");
      const reads = f.conversation.history.mock.calls.length;
      f.emit.status(notice);
      f.emit.status({ ...notice, state: "running", statusRevision: 2 });
      f.emit.assignment({ v: 1, ref, assignmentId: "assignment", streamEpoch: 1, seq: 2, meta: { turnOrigin: origin }, payload: { kind: "agent-event", event: { event: "agent:input_received", payload: { inputs: [{ text: "追加检查要求", identity }] } } } });
      f.emit.assignment({ v: 1, ref, assignmentId: "assignment", streamEpoch: 1, seq: 3, meta: { turnOrigin: origin }, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "迟到输出" } } });
      expect(writer.line).toHaveBeenCalledOnce();
      expect(f.conversation.history).toHaveBeenCalledTimes(reads);
      expect(onYield).toHaveBeenCalledTimes(turn ? 0 : 1);
      expect(complete).toHaveBeenCalledTimes(turn ? 0 : 1);
      if (!turn) expect(onYield.mock.calls[0]?.[0].text).toContain("任务续接未完成");
    } finally { controller.dispose(); }
  });

  it("does not repeat a local waiter's terminal as an observed communication Run", async () => {
    const f = makeFakes(), complete = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedTurnComplete: complete });
    const turn = await controller.beginTurn("用户输入");
    const notice = { v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: turn.runId, ownerEpoch: 1 }, state: "failed", statusRevision: 2, at: "2026-09-16T00:00:00Z", actions: [] };
    f.emit.status(notice);
    expect((await turn.outcome).result.reason).toBe("error");
    f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId: turn.runId, state: "failed", message: { inputIdentity: { source: { kind: "conversation", conversationId: "source-a" } } } }] } as never);
    f.emit.status(notice);
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled(); expect(onYield).not.toHaveBeenCalled();
    controller.dispose();
  });
  it.each(["conv-1", "ws:review:primary"])("stops an incoming Run from owner facts without local waiter or stream: %s", async (conversationId) => {
    const f = makeFakes();
    const controller = new ConversationController({ conversation: f.conversation as never, workscene: f.workscene as never, onYield: vi.fn() }, { ...initial, conversationId });
    f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId: "peer-run", state: "running", message: { inputIdentity: { id: "m", source: { kind: "conversation", conversationId: "a" } } } }] } as never);
    await controller.abort();
    expect(f.conversation.abort).toHaveBeenCalledWith(conversationId, expect.stringMatching(/^cancel:/), "peer-run");
    expect(f.workscene.stopTask).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not abort stale, uncertain or another conversation's work from historical inputs", async () => {
    const f = makeFakes(); const { controller } = makeController(f);
    for (const state of ["committed", "cancelled", "failed", "expired", "uncertain"]) {
      f.conversation.history.mockResolvedValue({ runs: [], hasMore: false, inputsOutsideHistory: [{ runId: "old", state, message: { inputIdentity: { source: { kind: "conversation", conversationId: "a" } } } }] } as never);
      expect(await controller.abortBackgroundTask()).toBe(false);
    }
    expect(f.conversation.abort).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["stream", "final-only", "user-run", "local-waiter", "no-final-text"])("projects every communication input through the canonical source path: %s", async (mode) => {
    const f = makeFakes(), inputs = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedInputs: inputs });
    const c = { id: "message-c", source: { kind: "conversation", conversationId: "c" } };
    const a = { id: "message-a", source: { kind: "conversation", conversationId: "a" } };
    const messages = [
      { role: "user", content: [{ type: "text", text: "原始要求" }], ...(mode === "user-run" || mode === "local-waiter" ? {} : { inputIdentity: c }) },
      { role: "user", content: [{ type: "text", text: "补充要求" }], inputIdentity: a },
      ...(mode === "no-final-text" ? [] : [{ role: "assistant", content: [{ type: "text", text: "完成" }] }]),
    ];
    let runId = "peer-run";
    let local: Awaited<ReturnType<ConversationController["beginTurn"]>> | undefined;
    if (mode === "local-waiter") { local = await controller.beginTurn("原始要求"); runId = local.runId!; }
    const frame = { v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId }, assignmentId: "a", streamEpoch: 1, meta: { turnOrigin: { channel: "rpc", messageIdentity: c } } };
    if (mode === "stream") {
      f.emit.assignment({ ...frame, seq: 1, payload: { kind: "agent-event", event: { event: "agent:run_start", payload: { prompt: "原始要求" } } } });
      f.emit.assignment({ ...frame, seq: 2, payload: { kind: "agent-event", event: { event: "agent:input_received", payload: { inputs: [{ text: "补充要求", identity: a }] } } } });
      f.emit.assignment({ ...frame, seq: 3, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "完成" } } });
    }
    f.conversation.history.mockResolvedValue({ runs: [{ shardId: "s", record: { type: "run", runId, runIndex: 1, messages } }], hasMore: false } as never);
    f.emit.final({ v: 1, conversationId: "conv-1", runId, commitRevision: 1, digest: `sha256:${"0".repeat(64)}` });
    await vi.waitFor(() => expect(inputs.mock.calls.flatMap(([value]) => value.inputs)).toContainEqual({ text: "补充要求", identity: a }));
    if (mode !== "user-run" && mode !== "local-waiter") expect(inputs.mock.calls.flatMap(([value]) => value.inputs)).toContainEqual({ text: "原始要求", identity: c });
    if (mode === "stream") expect(onYield.mock.calls.filter(([delta]) => delta.type === "text_delta")).toEqual([[{ type: "text_delta", text: "完成" }]]);
    if (local) await local.outcome;
    controller.dispose();
  });
  it.each(["reference", "sequence-gap", "late-subscribe", "replacement-stream"])("restores a contiguous final without duplicated or out-of-order text after %s", async (gap) => {
    const f = makeFakes();
    const complete = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedTurnComplete: complete });
    const origin = { channel: "rpc", worksceneContinuation: { kind: "result", conversationId: "ws:reports:primary", runId: "child" } };
    f.conversation.history.mockResolvedValue({ runs: [{ shardId: "000001", record: { type: "run", runId: "gap", runIndex: 1, worksceneContinuation: origin.worksceneContinuation, timestamp: "2026-09-16T00:00:00Z", messages: [{ role: "assistant", content: [{ type: "text", text: "甲乙丙" }] }] } }], hasMore: false } as never);
    const frame = { v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: "gap" }, assignmentId: "a", streamEpoch: 1, seq: 1, meta: { turnOrigin: origin }, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "甲" } } };
    if (gap !== "late-subscribe") f.emit.assignment(frame);
    if (gap === "reference") f.emit.assignment({ ...frame, seq: 2, payload: { kind: "agent-yield", yield: { ref: { digest: `sha256:${"1".repeat(64)}`, bytes: 3 } } } });
    f.emit.assignment({ ...frame, ...(gap === "replacement-stream" ? { streamEpoch: 2, seq: 1 } : { seq: 3 }), payload: { kind: "agent-yield", yield: { type: "text_delta", text: "丙" } } });
    const final = { v: 1, conversationId: "conv-1", runId: "gap", commitRevision: 1, digest: `sha256:${"0".repeat(64)}` };
    f.emit.final(final);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    f.emit.final(final);
    f.emit.assignment({ ...frame, seq: 4 });
    expect(onYield.mock.calls.map(([item]) => item.text ?? "").join("")).toBe("甲乙丙");
    expect(complete).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("stops the current delegated task after reconnect without a local waiter or any stream", async () => {
    const f = makeFakes();
    const task = { conversationId: "conv-1", runId: "source-run", goal: "交付报告" };
    f.workscene.tasks.mockResolvedValue([task]);
    const { controller } = makeController(f);
    await controller.start();
    await controller.reattachActiveObserver();
    await controller.abort();
    expect(f.workscene.stopTask).toHaveBeenCalledWith("conv-1", task, expect.stringMatching(/^stop-task:/));
    expect(f.conversation.abort).not.toHaveBeenCalled();
    f.workscene.tasks.mockResolvedValue([task, { ...task, runId: "unrelated" }]);
    await expect(controller.abort()).rejects.toThrow("多项委托");
    expect(f.workscene.stopTask).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it("renders a communication Run without a local sender and recovers its final after missing the stream", async () => {
    const f = makeFakes();
    const complete = vi.fn();
    const observed = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedInputs: observed, onObservedTurnComplete: complete });
    const messageIdentity = { id: "message-a", source: { kind: "conversation", conversationId: "other-dialog" } };
    const record = { type: "run", runId: "communication", runIndex: 1, timestamp: "2026-09-16T00:00:00Z", messages: [
      { role: "user", content: [{ type: "text", text: "核实" }], inputIdentity: messageIdentity },
      { role: "assistant", content: [{ type: "text", text: "核实完成" }] },
    ] };
    f.conversation.history.mockResolvedValue({ runs: [{ shardId: "s", record }], hasMore: false } as never);
    f.emit.final({ v: 1, conversationId: "conv-1", runId: "communication", commitRevision: 1, digest: `sha256:${"0".repeat(64)}` });
    await vi.waitFor(() => expect(onYield).toHaveBeenCalledWith({ type: "text_delta", text: "核实完成" }));
    expect(complete).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith({ conversationId: "conv-1", turnId: "communication", inputs: [{ text: "核实", identity: messageIdentity }] });
    expect(controller.current.conversationId).toBe("conv-1");
    controller.dispose();
  });

  it("renders automatic continuation streams once and closes them on durable final", async () => {
    const f = makeFakes();
    const complete = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedTurnComplete: complete });
    const frame = { v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: "auto-result" }, assignmentId: "assignment-return", streamEpoch: 1, seq: 1, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "已核实报告，尚未发布。" } }, meta: { turnOrigin: { channel: "rpc", worksceneContinuation: { kind: "result", conversationId: "ws:reports:primary", runId: "child" } } } };
    f.emit.assignment({ ...frame, ref: { ...frame.ref, conversationId: "other" } });
    f.emit.assignment({ ...frame, meta: {} });
    f.emit.assignment(frame);
    f.emit.assignment(frame);
    expect(onYield).toHaveBeenCalledTimes(1);
    expect(onYield).toHaveBeenCalledWith(frame.payload.yield);
    const final = { v: 1, conversationId: "conv-1", runId: "auto-result", commitRevision: 2, digest: `sha256:${"0".repeat(64)}` };
    f.conversation.history.mockResolvedValue({ runs: [{ shardId: "000001", record: { type: "run", runId: "auto-result", runIndex: 1, timestamp: "2026-09-15T00:00:00Z", messages: [{ role: "assistant", content: [{ type: "text", text: "已核实报告，尚未发布。" }] }] } }], hasMore: false } as never);
    f.emit.final(final);
    f.emit.final(final);
    f.emit.assignment({ ...frame, seq: 2 });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(onYield).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it.each(["reference-only", "partial-then-reference", "final-first", "final-only", "partial-final-late"])("loads the full durable continuation result: %s", async (order) => {
    const f = makeFakes();
    const complete = vi.fn();
    const { controller, onYield } = makeController(f, vi.fn(), { onObservedTurnComplete: complete });
    vi.mocked(f.conversation.history).mockResolvedValue({ runs: [{ shardId: "000001", record: { type: "run", runId: "auto-ref", worksceneContinuation: { kind: "result", conversationId: "ws:reports:primary", runId: "child" }, runIndex: 1, timestamp: "2026-09-15T00:00:00Z", messages: [{ role: "assistant", content: [{ type: "text", text: "完整的最终结果" }] }] } }], hasMore: false } as never);
    vi.mocked(f.conversation.history).mockRejectedValueOnce(new Error("暂时断线"));
    const final = { v: 1, conversationId: "conv-1", runId: "auto-ref", commitRevision: 1, digest: `sha256:${"0".repeat(64)}` };
    if (order === "final-first") f.emit.final(final);
    if (order === "partial-final-late") {
      const partial = { v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: "auto-ref" }, assignmentId: "a", streamEpoch: 1, seq: 1, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "完整的" } }, meta: { turnOrigin: { channel: "rpc", worksceneContinuation: { kind: "result", conversationId: "ws:reports:primary", runId: "child" } } } };
      f.emit.assignment(partial);
      f.emit.final(final);
      f.emit.assignment({ ...partial, seq: 2, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "最终结果" } } });
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      expect(onYield.mock.calls.map(([delta]) => delta.type === "text_delta" ? delta.text : "").join("")).toBe("完整的最终结果");
      controller.dispose();
      return;
    }
    if (order === "partial-then-reference") f.emit.assignment({ v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: "auto-ref" }, assignmentId: "a", streamEpoch: 1, seq: 1, payload: { kind: "agent-yield", yield: { type: "text_delta", text: "正在核对。" } }, meta: { turnOrigin: { channel: "rpc", worksceneContinuation: { kind: "result", conversationId: "ws:reports:primary", runId: "child" } } } });
    if (order !== "final-only") f.emit.assignment({ v: 1, ref: { execution: "conversation", conversationId: "conv-1", runId: "auto-ref" }, assignmentId: "a", streamEpoch: 1, seq: 2, payload: { kind: "agent-yield", yield: { ref: { digest: `sha256:${"0".repeat(64)}`, bytes: 20 } } }, meta: { turnOrigin: { channel: "rpc", worksceneContinuation: { kind: "result", conversationId: "ws:reports:primary", runId: "child" } } } });
    f.emit.final(final);
    await vi.waitFor(() => expect(onYield).toHaveBeenCalledWith({ type: "text_delta", text: "完整的最终结果" }));
    expect(complete).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

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

  it("selectInitialConversation:能力受限时必须先取得一次明确同意", async () => {
    let enabled = false;
    const unavailableCapabilities = ["排程暂不可用"] as const;
    const conversation = {
      list: vi.fn(async () => []),
      pendingContinuationConfirmation: vi.fn(() =>
        enabled ? null : unavailableCapabilities,
      ),
      confirmContinuation: vi.fn(() => {
        enabled = true;
      }),
      resumeIfExists: vi.fn(async () => null),
      newConversation: vi.fn(async () => ({
        conversationId: "conv-local",
        name: "本机对话",
      })),
    };

    await expect(
      selectInitialConversation(conversation, {
        confirmContinuation: async (capabilities) => {
          expect(capabilities).toBe(unavailableCapabilities);
          return false;
        },
      }),
    ).rejects.toThrow("已取消使用受限会话能力");
    expect(conversation.newConversation).not.toHaveBeenCalled();

    await expect(
      selectInitialConversation(conversation, {
        confirmContinuation: async (capabilities) => {
          expect(capabilities).toBe(unavailableCapabilities);
          return true;
        },
      }),
    ).resolves.toMatchObject({
      active: { conversationId: "conv-local" },
    });
    expect(conversation.confirmContinuation).toHaveBeenCalledOnce();
    expect(conversation.newConversation).toHaveBeenCalledOnce();
  });

  it("start / resume / newConversation 维护当前对话 observer 订阅", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-1", 0);

    await controller.resume("conv-2");
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("conv-1");
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-2", 0);

    await controller.newConversation();
    expect(f.conversation.unsubscribe).toHaveBeenCalledWith("conv-2");
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-new", 0);
  });

  it("reattachActiveObserver:宿主换代后强制重挂当前对话 observer", async () => {
    const f = makeFakes();
    const { controller } = makeController(f);

    await controller.start();
    await controller.reattachActiveObserver();

    expect(f.conversation.unsubscribe).not.toHaveBeenCalled();
    expect(f.conversation.subscribe).toHaveBeenCalledTimes(2);
    expect(f.conversation.subscribe).toHaveBeenNthCalledWith(1, "conv-1", 0);
    expect(f.conversation.subscribe).toHaveBeenNthCalledWith(2, "conv-1", 0);
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
    expect(f.conversation.subscribe).toHaveBeenCalledWith("ws:scene-1:conv-9", 0);
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
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-latest", 0);
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
    expect(f.conversation.subscribe).toHaveBeenCalledWith("conv-new", 0);
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
