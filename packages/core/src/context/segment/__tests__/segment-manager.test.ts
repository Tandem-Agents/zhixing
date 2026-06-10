/**
 * SegmentManager 主类测试 —— 编排层完整契约覆盖。
 *
 * 测试策略：
 *   - 用真实 createEventBus（不 mock IEventBus 整个接口）+ 订阅记录 emit
 *   - 用 vi.fn mock callLLM / persistence / taskListReader / hooks
 *   - 用 fake estimator 返回可控 token 数
 *   - retryBaseMs=0 加速重试（不实际 sleep 200/400/800ms）
 *
 * 覆盖：
 *   - 三档决策路径（pass / defer / trigger）→ 正确的事件流 + 行为
 *   - ephemeral conversationId 缺失 → 静默 pass
 *   - trigger 成功路径：完整事件 + 持久化 + 返回 newSegmentMessages
 *   - 压缩 LLM 失败：重试 → 最终失败 → transition_failed
 *   - 摘要解析全空 → 视为失败
 *   - 持久化失败：transition_failed retriesExhausted=false
 *   - hook 任一时点抛错 → transition_failed
 *   - 压缩请求形态：完整 system + tools + (messages + 末尾压缩指令)
 *   - taskListReader 在决策前被调用
 *   - retry 计数：N+1 次尝试（首次 + N 次重试）
 */

import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../../events/event-bus.js";
import type { AgentEventMap } from "../../../types/agent-events.js";
import type { Message } from "../../../types/messages.js";
import type { ToolSpec } from "../../../types/tools.js";
import type { ITokenEstimator } from "../../types.js";
import {
  createSegmentManager,
  type SegmentManagerConfig,
} from "../segment-manager.js";
import { SEGMENT_SUMMARIZE_INSTRUCTION } from "../prompts.js";
import type {
  ParsedSummary,
  SegmentManagerInput,
  SegmentPersistence,
  SegmentSummarizeLLMFn,
  SegmentSummarizeRequest,
  SegmentThresholds,
  SegmentTransitionHook,
  TaskListReader,
} from "../types.js";

// ─── Fixtures ───

const CAP: SegmentThresholds = {
  optimalMaxTokens: 100,
  riskMaxTokens: 200,
};

const SUMMARY_OK = `<facts>F1</facts><state>S1</state><active>A1</active>`;
const TOOLS: ToolSpec[] = [
  { name: "read_file", description: "read", inputSchema: { type: "object" } },
];

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * Fake estimator：text/messages/tools 按"长度返"简化语义。
 * 调用方测试时通过控制 input.messages 长度 / systemPrompt 长度 / tools 数量
 * 直接驱动决策档位。
 */
function fakeEstimator(opts?: {
  msgPerItem?: number;
  textPerChar?: number;
  toolPerItem?: number;
  calibrationFactor?: number;
}): ITokenEstimator {
  const msgPerItem = opts?.msgPerItem ?? 10;
  const textPerChar = opts?.textPerChar ?? 1;
  const toolPerItem = opts?.toolPerItem ?? 0;
  const calibrationFactor = opts?.calibrationFactor ?? 1;
  return {
    estimateMessage: () => msgPerItem,
    estimateMessages: (msgs) => msgs.length * msgPerItem,
    estimateText: (text) => text.length * textPerChar,
    estimateTools: (tools) => tools.length * toolPerItem,
    calibrate: () => {},
    calibrationFactor,
  };
}

function fakePersistence(): SegmentPersistence {
  return {
    appendSegment: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeTaskListReader(hasInProgress = false): TaskListReader {
  return { hasInProgress: vi.fn(() => hasInProgress) };
}

function fakeLLM(returnValue: string | ((req: SegmentSummarizeRequest) => string)) {
  return vi.fn(async (req: SegmentSummarizeRequest) => {
    return typeof returnValue === "string"
      ? returnValue
      : returnValue(req);
  });
}

interface CapturedEvent<K extends keyof AgentEventMap> {
  event: K;
  payload: AgentEventMap[K];
}

function captureSegmentEvents(): {
  bus: ReturnType<typeof createEventBus<AgentEventMap>>;
  events: CapturedEvent<keyof AgentEventMap>[];
} {
  const bus = createEventBus<AgentEventMap>();
  const events: CapturedEvent<keyof AgentEventMap>[] = [];
  bus.onAny((event, payload) => {
    if (event.startsWith("segment:")) {
      events.push({
        event: event as keyof AgentEventMap,
        payload: payload as AgentEventMap[keyof AgentEventMap],
      });
    }
  });
  return { bus, events };
}

function makeConfig(overrides?: Partial<SegmentManagerConfig>): SegmentManagerConfig {
  return {
    estimator: fakeEstimator(),
    capability: CAP,
    callLLM: fakeLLM(SUMMARY_OK),
    persistence: fakePersistence(),
    taskListReader: fakeTaskListReader(),
    retryBaseMs: 0,
    retries: 3,
    bufferTurns: 2,
    generateSegmentId: () => "seg-fixed",
    clock: () => new Date("2026-05-11T10:00:00Z"),
    ...overrides,
  };
}

function makeInput(
  messages: Message[],
  overrides?: Partial<SegmentManagerInput>,
): SegmentManagerInput {
  return {
    messages,
    systemPrompt: "sys",
    tools: TOOLS,
    turnCount: messages.length,
    conversationId: "conv-1",
    ...overrides,
  };
}

// ─── ephemeral 路径 ───

describe("evaluate — ephemeral 路径（窗口保护对一切运行体生效）", () => {
  it("conversationId 缺失 + 超阈值 → 照常切段，产出 windowCompact", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({
        eventBus: bus,
        callLLM: fakeLLM(SUMMARY_OK),
        capability: { optimalMaxTokens: 0, riskMaxTokens: 0 },
      }),
    );

    const result = await sm.evaluate(
      makeInput([userMsg("hi"), assistantMsg("yo")], { conversationId: undefined }),
    );

    expect(result.decision.kind).toBe("trigger");
    expect(result.modified).toBe(true);
    expect(result.windowCompact).toBeDefined();
    // 事件照发（可观测性与持久对话一致）
    expect(events.map((e) => e.event)).toContain("segment:transition_start");
    expect(events.map((e) => e.event)).toContain("segment:new_started");
  });

  it("ephemeral 仅跳过持久化副作用：persistence 不被调、taskListReader 不被调", async () => {
    const callLLM = fakeLLM(SUMMARY_OK);
    const taskListReader = fakeTaskListReader(true);
    const persistence = fakePersistence();
    const sm = createSegmentManager(
      makeConfig({
        callLLM,
        taskListReader,
        persistence,
        capability: { optimalMaxTokens: 0, riskMaxTokens: 0 },
      }),
    );

    const result = await sm.evaluate(
      makeInput([userMsg("hi"), assistantMsg("yo")], { conversationId: undefined }),
    );

    expect(result.modified).toBe(true); // 切段照常发生（LLM 已调用）
    expect(callLLM).toHaveBeenCalled();
    expect(taskListReader.hasInProgress).not.toHaveBeenCalled(); // 无清单可读
    expect(persistence.appendSegment).not.toHaveBeenCalled(); // 唯一的副作用差分
  });

  it("conversationId 缺失 + 阈值内 → pass（below-optimal，与持久对话同判据）", async () => {
    const sm = createSegmentManager(
      makeConfig({ capability: { optimalMaxTokens: 100_000, riskMaxTokens: 200_000 } }),
    );
    const result = await sm.evaluate(
      makeInput([userMsg("hi")], { conversationId: undefined }),
    );
    expect(result.decision).toEqual({ kind: "pass", reason: "below-optimal" });
    expect(result.modified).toBe(false);
  });
});

// ─── 决策路径 ───

describe("evaluate — pass / defer / trigger 决策", () => {
  it("pass：tokens < optimal → segment:evaluation fire + 不切", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(makeConfig({ eventBus: bus }));

    // 5 条消息 × 10 token + systemPrompt "sys" × 1 char = 53 tokens < 100
    const result = await sm.evaluate(makeInput([
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2"),
      assistantMsg("a2"),
      userMsg("q3"),
    ]));

    expect(result.decision.kind).toBe("pass");
    expect(result.modified).toBe(false);
    expect(events.map((e) => e.event)).toEqual(["segment:evaluation"]);
  });

  it("defer：in-progress + 中段 tokens → segment:evaluation fire + 不切", async () => {
    const { bus, events } = captureSegmentEvents();
    const reader = fakeTaskListReader(true);
    const sm = createSegmentManager(
      makeConfig({ eventBus: bus, taskListReader: reader }),
    );

    // 15 条消息 × 10 + sys 3 = 153 tokens（optimal=100 < 153 < risk=200）
    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const result = await sm.evaluate(makeInput(messages));

    expect(result.decision.kind).toBe("defer");
    expect(result.modified).toBe(false);
    expect(reader.hasInProgress).toHaveBeenCalledWith("conv-1");
    expect(events.map((e) => e.event)).toEqual(["segment:evaluation"]);
  });

  it("trigger optimal-exceeded：无 in-progress + 中段 → 进入压缩流程", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(makeConfig({ eventBus: bus }));

    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const result = await sm.evaluate(makeInput(messages));

    expect(result.decision.kind).toBe("trigger");
    expect((result.decision as { reason: string }).reason).toBe(
      "optimal-exceeded",
    );
    expect(result.modified).toBe(true);
    expect(events.map((e) => e.event)).toEqual([
      "segment:evaluation",
      "segment:transition_start",
      "segment:summarize_complete",
      "segment:new_started",
    ]);
  });

  it("trigger risk-exceeded：tokens > risk 即使 in-progress 也强制切", async () => {
    const { bus, events } = captureSegmentEvents();
    const reader = fakeTaskListReader(true);
    const sm = createSegmentManager(
      makeConfig({ eventBus: bus, taskListReader: reader }),
    );

    // 25 × 10 + 3 = 253 > risk=200
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const result = await sm.evaluate(makeInput(messages));

    expect(result.decision.kind).toBe("trigger");
    expect((result.decision as { reason: string }).reason).toBe(
      "risk-exceeded",
    );
    expect(result.modified).toBe(true);
  });
});

// ─── trigger 成功路径详细契约 ───

describe("evaluate — trigger 成功完整契约", () => {
  function makeBigMessages(): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    return messages;
  }

  it("callLLM 接收完整 system + tools + (messages + 末尾压缩指令)", async () => {
    const callLLM = fakeLLM(SUMMARY_OK);
    const sm = createSegmentManager(makeConfig({ callLLM }));

    const messages = makeBigMessages();
    await sm.evaluate(makeInput(messages));

    expect(callLLM).toHaveBeenCalledTimes(1);
    const req = callLLM.mock.calls[0]![0]!;
    expect(req.systemPrompt).toBe("sys");
    expect(req.tools).toBe(TOOLS);
    // 末尾追加压缩指令 user message
    expect(req.messages).toHaveLength(messages.length + 1);
    const lastMsg = req.messages[req.messages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect((lastMsg.content[0] as { type: string; text: string }).text).toBe(
      SEGMENT_SUMMARIZE_INSTRUCTION,
    );
    // 末尾追加前的 messages 与传入完全一致（byte-equal 上一轮的物理实现）
    for (let i = 0; i < messages.length; i++) {
      expect(req.messages[i]).toBe(messages[i]);
    }
  });

  it("segment:new_started 事件 payload 携带完整窗口重构指令（segmentId + structuredSummary）", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({
        eventBus: bus,
        generateSegmentId: () => "seg-test-1",
      }),
    );

    await sm.evaluate(makeInput(makeBigMessages()));

    const newStarted = events.find((e) => e.event === "segment:new_started")!;
    expect(newStarted).toBeDefined();
    const payload = newStarted.payload as AgentEventMap["segment:new_started"];
    const wc = payload.windowCompact;
    expect(wc.segmentId).toBe("seg-test-1");
    expect(wc.structuredSummary).toEqual({
      facts: "F1",
      state: "S1",
      active: "A1",
    });
    expect(wc.pairsCompacted).toBeGreaterThan(0);
    expect(wc.tokensBefore).toBeGreaterThan(0);
  });

  it("evaluate 返回值的 windowCompact 与 segment:new_started 事件载荷一致", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({
        eventBus: bus,
        generateSegmentId: () => "seg-coherent",
      }),
    );

    const result = await sm.evaluate(makeInput(makeBigMessages()));

    expect(result.modified).toBe(true);
    expect(result.windowCompact).toBeDefined();
    const newStarted = events.find((e) => e.event === "segment:new_started")!;
    const payload = newStarted.payload as AgentEventMap["segment:new_started"];
    expect(payload.windowCompact).toEqual(result.windowCompact);
  });

  it("persistence.appendSegment 收到 SegmentMeta（与指令同 segmentId）", async () => {
    const persistence = fakePersistence();
    const sm = createSegmentManager(
      makeConfig({
        persistence,
        generateSegmentId: () => "seg-test-2",
      }),
    );

    await sm.evaluate(makeInput(makeBigMessages()));

    expect(persistence.appendSegment).toHaveBeenCalledTimes(1);
    const [conversationId, meta] = (
      persistence.appendSegment as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(conversationId).toBe("conv-1");
    expect(meta.segmentId).toBe("seg-test-2");
    expect(meta.timestamp).toBe("2026-05-11T10:00:00.000Z");
    expect(meta.tokensBefore).toBeGreaterThan(0);
    expect(meta.tokensAfter).toBeGreaterThan(0);
  });

  it("事件顺序：transition_start → summarize_complete → new_started", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(makeConfig({ eventBus: bus }));

    await sm.evaluate(makeInput(makeBigMessages()));

    const segmentEventNames = events
      .map((e) => e.event)
      .filter((n) => n !== "segment:evaluation");
    expect(segmentEventNames).toEqual([
      "segment:transition_start",
      "segment:summarize_complete",
      "segment:new_started",
    ]);
  });

  it("成功返回 newSegmentMessages + windowCompact", async () => {
    const sm = createSegmentManager(
      makeConfig({ generateSegmentId: () => "seg-X" }),
    );

    const result = await sm.evaluate(makeInput(makeBigMessages()));

    expect(result.modified).toBe(true);
    expect(result.newSegmentMessages).toBeDefined();
    expect(result.newSegmentMessages).toHaveLength(1);
    expect(result.newSegmentMessages![0]!.role).toBe("user");
    expect(result.windowCompact?.segmentId).toBe("seg-X");
  });

  it("new_started 事件 payload 含 bufferTurns / tokens", async () => {
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(makeConfig({ eventBus: bus, bufferTurns: 2 }));

    await sm.evaluate(makeInput(makeBigMessages()));

    const newStarted = events.find((e) => e.event === "segment:new_started")!;
    expect(newStarted).toBeDefined();
    const payload = newStarted.payload as AgentEventMap["segment:new_started"];
    expect(payload.bufferTurns).toBe(2);
    expect(payload.tokensBefore).toBeGreaterThan(0);
    expect(payload.tokensAfter).toBeGreaterThan(0);
  });
});

// ─── 失败路径 ───

describe("evaluate — 压缩失败", () => {
  function bigMessages(): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    return messages;
  }

  it("callLLM 一直抛错 → 重试 N 次后 emit transition_failed retriesExhausted=true", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockRejectedValue(new Error("provider down"));
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({ callLLM, eventBus: bus, retries: 2, retryBaseMs: 0 }),
    );

    const result = await sm.evaluate(makeInput(bigMessages()));

    expect(result.modified).toBe(false);
    expect(callLLM).toHaveBeenCalledTimes(3); // 首次 + 2 重试
    const failedEvent = events.find((e) => e.event === "segment:transition_failed")!;
    expect(failedEvent).toBeDefined();
    const payload =
      failedEvent.payload as AgentEventMap["segment:transition_failed"];
    expect(payload.retriesExhausted).toBe(true);
    expect(payload.error).toContain("provider down");
  });

  it("callLLM 第一次失败、第二次成功 → 切段成功", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(SUMMARY_OK);
    const sm = createSegmentManager(
      makeConfig({ callLLM, retries: 3, retryBaseMs: 0 }),
    );

    const result = await sm.evaluate(makeInput(bigMessages()));

    expect(result.modified).toBe(true);
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it("摘要解析三段全空 → emit transition_failed retriesExhausted=true", async () => {
    const callLLM = fakeLLM("纯文本回复没有 XML 标签");
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(makeConfig({ callLLM, eventBus: bus }));

    const result = await sm.evaluate(makeInput(bigMessages()));

    expect(result.modified).toBe(false);
    const failedEvent = events.find((e) => e.event === "segment:transition_failed")!;
    expect(failedEvent).toBeDefined();
    const payload =
      failedEvent.payload as AgentEventMap["segment:transition_failed"];
    expect(payload.retriesExhausted).toBe(true);
  });

  it("persistence.appendSegment 抛错 → emit 专属 segment:metadata_persist_failed 事件，段切换主流程仍成功", async () => {
    // 关键不变量：segmentMetadata 是独立观测元数据流，与窗口重构指令解耦。
    // 指令通过 segment:new_started 事件流向 orchestrator accumulator 随 RunResult 带出；
    // segmentMetadata 缺失只影响段历史 UI 观测，不影响 LLM 视图正确性。
    //
    // 专属事件设计：避免与 transition_failed（段切换整体失败）语义混淆——订阅方
    // 可以精确区分"段切换没成功"和"段切换成功但元数据未落盘"两种情形。
    const persistence: SegmentPersistence = {
      appendSegment: vi.fn().mockRejectedValue(new Error("meta lock")),
    };
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(makeConfig({ persistence, eventBus: bus }));

    const result = await sm.evaluate(makeInput(bigMessages()));

    // 段切换主流程成功（指令已就绪、newSegmentMessages 已组装）
    expect(result.modified).toBe(true);
    expect(result.newSegmentMessages).toBeDefined();
    expect(result.windowCompact).toBeDefined();

    // 专属 metadata_persist_failed 事件被 emit（warning 性质，与 transition_failed 解耦）
    const metaFailed = events.find(
      (e) => e.event === "segment:metadata_persist_failed",
    );
    expect(metaFailed).toBeDefined();
    const payload =
      metaFailed!.payload as AgentEventMap["segment:metadata_persist_failed"];
    expect(payload.error).toContain("meta lock");

    // segment:transition_failed 不被 emit —— 段切换主流程没失败
    const transitionFailed = events.find(
      (e) => e.event === "segment:transition_failed",
    );
    expect(transitionFailed).toBeUndefined();

    // segment:new_started 仍然 emit（marker 通过事件流出到 orchestrator accumulator）
    const newStarted = events.find((e) => e.event === "segment:new_started");
    expect(newStarted).toBeDefined();
  });
});

// ─── Hook 路径 ───

describe("evaluate — hooks", () => {
  function bigMessages(): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    return messages;
  }

  it("hook 调用顺序：beforeSummarize → afterSummarize → beforeNewSegmentStart", async () => {
    const calls: string[] = [];
    const hook: SegmentTransitionHook = {
      async beforeSummarize() {
        calls.push("before");
      },
      async afterSummarize() {
        calls.push("after");
      },
      async beforeNewSegmentStart() {
        calls.push("newSeg");
      },
    };
    const sm = createSegmentManager(makeConfig({ hooks: [hook] }));

    await sm.evaluate(makeInput(bigMessages()));

    expect(calls).toEqual(["before", "after", "newSeg"]);
  });

  it("hook afterSummarize 收到解析后的 summary", async () => {
    const afterFn = vi.fn(async (_: unknown, summary: ParsedSummary) => {
      expect(summary).toEqual({ facts: "F1", state: "S1", active: "A1" });
    });
    const hook: SegmentTransitionHook = { afterSummarize: afterFn };
    const sm = createSegmentManager(makeConfig({ hooks: [hook] }));

    await sm.evaluate(makeInput(bigMessages()));

    expect(afterFn).toHaveBeenCalled();
  });

  it("beforeSummarize hook 抛错 → emit hook_failed + transition_failed，中止段切换（未花 LLM 成本，安全回滚）", async () => {
    const callLLM = fakeLLM(SUMMARY_OK);
    const hook: SegmentTransitionHook = {
      async beforeSummarize() {
        throw new Error("hook boom");
      },
    };
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({ callLLM, hooks: [hook], eventBus: bus }),
    );

    const result = await sm.evaluate(makeInput(bigMessages()));

    expect(result.modified).toBe(false);
    expect(callLLM).not.toHaveBeenCalled();

    // emit hook_failed (abortedTransition=true)
    const hookFailed = events.find((e) => e.event === "segment:hook_failed");
    expect(hookFailed).toBeDefined();
    const hookPayload =
      hookFailed!.payload as AgentEventMap["segment:hook_failed"];
    expect(hookPayload.hookPhase).toBe("beforeSummarize");
    expect(hookPayload.abortedTransition).toBe(true);
    expect(hookPayload.error).toContain("hook boom");

    // 也 emit transition_failed（与 hook_failed 配对，标识段切换整体失败）
    const transitionFailed = events.find((e) => e.event === "segment:transition_failed");
    expect(transitionFailed).toBeDefined();
  });

  it("afterSummarize hook 抛错 → emit hook_failed(abortedTransition=false) 并继续段切换（不浪费已花费的 LLM 成本）", async () => {
    const persistence = fakePersistence();
    const hook: SegmentTransitionHook = {
      async afterSummarize() {
        throw new Error("after boom");
      },
    };
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({ persistence, hooks: [hook], eventBus: bus }),
    );

    const result = await sm.evaluate(makeInput(bigMessages()));

    // 段切换主流程继续完成
    expect(result.modified).toBe(true);
    expect(result.newSegmentMessages).toBeDefined();
    expect(persistence.appendSegment).toHaveBeenCalled();

    // emit hook_failed (abortedTransition=false)
    const hookFailed = events.find((e) => e.event === "segment:hook_failed");
    expect(hookFailed).toBeDefined();
    const hookPayload =
      hookFailed!.payload as AgentEventMap["segment:hook_failed"];
    expect(hookPayload.hookPhase).toBe("afterSummarize");
    expect(hookPayload.abortedTransition).toBe(false);

    // segment:new_started 仍 emit
    const newStarted = events.find((e) => e.event === "segment:new_started");
    expect(newStarted).toBeDefined();
  });

  it("beforeNewSegmentStart hook 抛错 → 同 afterSummarize 语义（hook_failed + 继续）", async () => {
    const persistence = fakePersistence();
    const hook: SegmentTransitionHook = {
      async beforeNewSegmentStart() {
        throw new Error("newseg boom");
      },
    };
    const { bus, events } = captureSegmentEvents();
    const sm = createSegmentManager(
      makeConfig({ persistence, hooks: [hook], eventBus: bus }),
    );

    const result = await sm.evaluate(makeInput(bigMessages()));

    expect(result.modified).toBe(true);
    const hookFailed = events.find((e) => e.event === "segment:hook_failed");
    expect(hookFailed).toBeDefined();
    const hookPayload =
      hookFailed!.payload as AgentEventMap["segment:hook_failed"];
    expect(hookPayload.hookPhase).toBe("beforeNewSegmentStart");
    expect(hookPayload.abortedTransition).toBe(false);
  });

  it("多 hook 顺序 + 第一个抛错短路", async () => {
    const calls: string[] = [];
    const hookA: SegmentTransitionHook = {
      async beforeSummarize() {
        calls.push("A");
        throw new Error("A boom");
      },
    };
    const hookB: SegmentTransitionHook = {
      async beforeSummarize() {
        calls.push("B");
      },
    };
    const sm = createSegmentManager(makeConfig({ hooks: [hookA, hookB] }));

    await sm.evaluate(makeInput(bigMessages()));

    expect(calls).toEqual(["A"]); // B 不执行
  });
});

// ─── Abort 路径 ───

describe("evaluate — abort 信号", () => {
  function bigMessages(): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    return messages;
  }

  it("abort 在 callLLM 第一次调用前 → 立即失败，不调 callLLM", async () => {
    const callLLM = fakeLLM(SUMMARY_OK);
    const sm = createSegmentManager(
      makeConfig({ callLLM, retries: 3, retryBaseMs: 0 }),
    );

    const controller = new AbortController();
    controller.abort();

    const result = await sm.evaluate(
      makeInput(bigMessages(), { abortSignal: controller.signal }),
    );

    expect(result.modified).toBe(false);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("retry 期间被 abort → 中止后续重试", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockRejectedValue(new Error("provider err"));
    const sm = createSegmentManager(
      makeConfig({ callLLM, retries: 5, retryBaseMs: 50 }),
    );

    const controller = new AbortController();
    // 首次调用后立即 abort —— sleep 期间 reject
    callLLM.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("provider err");
    });

    const result = await sm.evaluate(
      makeInput(bigMessages(), { abortSignal: controller.signal }),
    );

    expect(result.modified).toBe(false);
    expect(callLLM).toHaveBeenCalledTimes(1); // 仅首次（abort 在 sleep 中起效）
  });
});
