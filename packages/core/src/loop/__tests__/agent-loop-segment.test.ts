/**
 * agent-loop ↔ SegmentManager 挂接集成测试。
 *
 * 验证：
 *   - 注入 segmentManager + 触发 trigger 决策 → state.messages 被替换为 newSegmentMessages
 *   - 注入 segmentManager + pass 决策 → state.messages 保持原 newMessages
 *   - 不注入 segmentManager → agent-loop 完全不调段切换路径（向后兼容）
 *   - ephemeral 路径（conversationId 缺失）→ SegmentManager 收到 undefined，自然降级 pass
 *   - segmentManager 失败（compress LLM 抛错）→ agent-loop 不抛错，state 用原 newMessages 继续
 *
 * 测试策略：
 *   - 用 MockLLMProvider 模拟 tool-use turn（让 agent-loop 走到 turn 边界挂接点）
 *   - SegmentManager 用真实类（不 mock）+ 注入 fake callLLM / estimator / persistence
 *   - 通过 LoopState 终值（从 yields 推断）和 SegmentManager 调用计数验证集成
 */

import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import { userMessage } from "../../types/messages.js";
import type { Message } from "../../types/messages.js";
import type { ToolDefinition } from "../../types/tools.js";
import {
  createSegmentManager,
  type SegmentPersistence,
  type SegmentSummarizeLLMFn,
  type SegmentSummarizeRequest,
  type SegmentThresholds,
  type TaskListReader,
} from "../../context/segment/index.js";
import type { ITokenEstimator } from "../../context/types.js";
import { drainAgentLoop } from "../agent-loop.js";
import { MockLLMProvider } from "../mock-provider.js";
import type { AgentLoopParams } from "../types.js";

// ─── 测试 fixtures ───

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: "object" as const },
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    call: async () => ({ content: `${name} done` }),
  };
}

function fakeEstimator(perItem: number): ITokenEstimator {
  return {
    estimateMessage: () => perItem,
    estimateMessages: (msgs) => msgs.length * perItem,
    estimateText: (t) => t.length,
    estimateTools: (tools) => tools.length * perItem,
    calibrate: () => {},
    calibrationFactor: 1,
  };
}

function fakePersistence(): SegmentPersistence {
  return {
    appendSegment: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeReader(hasInProgress = false): TaskListReader {
  return { hasInProgress: vi.fn(() => hasInProgress) };
}

const SUMMARY_OK = `<facts>F</facts><state>S</state><active>A</active>`;

/**
 * 模拟一次 "tool-use 然后 pure text" 的 LLM 交互：
 *   turn 1: LLM 返工具调用 → 工具结果 → ... 进入 turn 边界（这里是挂接点）
 *   turn 2: LLM 返纯文本 completed
 */
function makeToolThenTextProvider(toolName: string): MockLLMProvider {
  return new MockLLMProvider([
    {
      toolCalls: [{ id: "u1", name: toolName, input: { x: 1 } }],
    },
    { text: "done" },
  ]);
}

function baseParams(
  provider: MockLLMProvider,
  overrides?: Partial<AgentLoopParams>,
): AgentLoopParams {
  return {
    provider,
    model: "mock-model",
    messages: [userMessage("hi")],
    tools: [makeTool("t")],
    systemPrompt: "sys",
    ...overrides,
  };
}

// ─── 测试用例 ───

describe("agent-loop × SegmentManager 集成", () => {
  // 阈值控制：optimal=10 / risk=20；fakeEstimator(20) 每 msg 20 token
  // turn 1 结束时 newMessages = [user, assistant_with_tool_use, user_with_tool_result]
  // tokens = 3 × 20 + sys 3 + tools 1×20 = 83 → trigger（远超 risk）
  const aggressiveCap: SegmentThresholds = {
    optimalMaxTokens: 10,
    riskMaxTokens: 20,
  };

  // 高阈值：tokens 远低于 optimal，永远 pass
  const lenientCap: SegmentThresholds = {
    optimalMaxTokens: 100_000,
    riskMaxTokens: 200_000,
  };

  it("注入 segmentManager + 触发 trigger → 段切换在 turn 边界执行", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockResolvedValue(SUMMARY_OK);
    const persistence = fakePersistence();

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM,
      persistence,
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      generateSegmentId: () => "seg-test",
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
      }),
    );

    // 段切换共 3 次（aggressiveCap 下每次评估都 trigger）：
    //   1× runTurnBegin —— 首个 LLM 调用前一次性 ②（初始 [user "hi"] 估算即超阈）
    //   2× runTurnEnd  —— turn 1 工具路径 / turn 2 纯文本路径，同走 runTurnEnd 编排
    // turn-begin 与 turn-end 同走 applySegmentSwitch 单点；纯文本路径不再像历史
    // 实现那样漏调段切换（历史 bug：纯文本漏调 → 跨 run 段历史永不收敛）。
    //
    // transcript marker 不走 persistence.writeMarker —— 通过 segment:new_started
    // 事件流向 orchestrator accumulator → run-agent 单点 commit。
    expect(callLLM).toHaveBeenCalledTimes(3);
    expect(persistence.appendSegment).toHaveBeenCalledTimes(3);
  });

  it("runTurnBegin：初始上下文超阈 → 首个 LLM 调用即用压缩后 messages（不先吃超窗口 turn）", async () => {
    // 本测试锁定 runTurnBegin 的核心契约：超阈的起始上下文在**第一次
    // streamLLMCall 之前**就被段切换压缩，而非先吃一个超窗口 turn 再 turn-end
    // 自愈。验证手段：provider.calls[0]（turn 1，即首个 LLM 请求）的首条消息
    // 已含 compose 段切换输出的 <previous-segment-summary>。
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockResolvedValue(SUMMARY_OK);

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM,
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      generateSegmentId: () => "seg-begin",
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, { segmentManager, conversationId: "conv-1" }),
    );

    // 首个 LLM 请求（turn 1）已是 runTurnBegin 压缩后的新段 messages
    expect(provider.calls.length).toBeGreaterThanOrEqual(1);
    const turn1FirstText = (
      provider.calls[0]!.messages[0]!.content[0] as { type: string; text: string }
    ).text;
    expect(turn1FirstText).toContain("<previous-segment-summary>");
    expect(turn1FirstText).toContain("<facts>F</facts>");
  });

  it("runTurnBegin：未超阈 → no-op，首个 LLM 调用用原始 messages、不调压缩 LLM", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockResolvedValue(SUMMARY_OK);

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(1), // tokens 远低于 optimal
      capability: lenientCap,
      callLLM,
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      generateSegmentId: () => "seg-noop",
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, { segmentManager, conversationId: "conv-1" }),
    );

    // 首个 LLM 请求仍是原始 user 输入（无段切换 XML），压缩 LLM 全程未被调用
    const turn1FirstText = (
      provider.calls[0]!.messages[0]!.content[0] as { type: string; text: string }
    ).text;
    expect(turn1FirstText).not.toContain("<previous-segment-summary>");
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("段切换后 turn 2 的 LLM 请求使用新段 messages（state.messages 已替换）", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockResolvedValue(SUMMARY_OK);

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM,
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      generateSegmentId: () => "seg-A",
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
      }),
    );

    // provider.calls[0] = turn 1 请求（user "hi"）
    // provider.calls[1] = turn 2 请求（应包含段切换后的新段 messages）
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    const turn2Msgs = provider.calls[1]!.messages;

    // 新段 messages 起始于 compose 输出 + 用户新输入；compose 输出含
    // <previous-segment-summary> XML 标签
    const turn2FirstText = (turn2Msgs[0]!.content[0] as { type: string; text: string }).text;
    expect(turn2FirstText).toContain("<previous-segment-summary>");
    expect(turn2FirstText).toContain("<facts>F</facts>");
  });

  it("pass 决策 → state.messages 不被替换，turn 2 用原始 messages", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockResolvedValue(SUMMARY_OK);
    const persistence = fakePersistence();

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(1), // tokens 远低于 optimal
      capability: lenientCap,
      callLLM,
      persistence,
      taskListReader: fakeReader(),
      retryBaseMs: 0,
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
      }),
    );

    // pass 路径：callLLM 不被调，persistence 不被调
    expect(callLLM).not.toHaveBeenCalled();
    expect(persistence.appendSegment).not.toHaveBeenCalled();

    // turn 2 的 messages 包含原 user + assistant 配对（未被替换）
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    const turn2Msgs = provider.calls[1]!.messages;
    // 至少包含 turn 1 的完整三条消息（user + assistant + tool_result user）
    expect(turn2Msgs.length).toBeGreaterThanOrEqual(3);
  });

  it("ephemeral 路径（conversationId 缺失）→ 段切换静默 pass，不调 callLLM / persistence", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockResolvedValue(SUMMARY_OK);
    const persistence = fakePersistence();

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20), // 即使 tokens 超 optimal
      capability: aggressiveCap,
      callLLM,
      persistence,
      taskListReader: fakeReader(),
      retryBaseMs: 0,
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: undefined,
      }),
    );

    expect(callLLM).not.toHaveBeenCalled();
    expect(persistence.appendSegment).not.toHaveBeenCalled();
  });

  it("不注入 segmentManager → agent-loop 正常工作，不触段切换路径", async () => {
    const provider = makeToolThenTextProvider("t");
    const { result } = await drainAgentLoop(
      baseParams(provider, {
        segmentManager: undefined,
        conversationId: "conv-1",
      }),
    );

    expect(result.reason).toBe("completed");
    expect(provider.calls).toHaveLength(2); // 仅 LLM 主对话两次
  });

  it("segmentManager 压缩失败 → agent-loop 拿原 newMessages 继续，不抛错", async () => {
    const callLLM = vi
      .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
      .mockRejectedValue(new Error("provider down"));

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM,
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      retries: 1,
    });

    const provider = makeToolThenTextProvider("t");
    const { result } = await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
      }),
    );

    expect(result.reason).toBe("completed");

    // turn 2 用原始 messages（未被替换）—— 段切换失败后 fallback
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    const turn2Msgs = provider.calls[1]!.messages;
    expect(turn2Msgs.length).toBeGreaterThanOrEqual(3);
  });

  it("段切换 emit segment:* 事件流被外部 eventBus 接收", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const segmentEvents: { event: string; payload: unknown }[] = [];
    eventBus.onAny((event, payload) => {
      if (event.startsWith("segment:")) {
        segmentEvents.push({ event, payload });
      }
    });

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM: vi
        .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
        .mockResolvedValue(SUMMARY_OK),
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      eventBus,
      generateSegmentId: () => "seg-evt",
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
        eventBus,
      }),
    );

    const eventNames = segmentEvents.map((e) => e.event);
    expect(eventNames).toContain("segment:evaluation");
    expect(eventNames).toContain("segment:transition_start");
    expect(eventNames).toContain("segment:summarize_complete");
    expect(eventNames).toContain("segment:new_started");
  });

  it("taskListReader 被调用，收到 conversationId", async () => {
    const reader = fakeReader();

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM: vi
        .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
        .mockResolvedValue(SUMMARY_OK),
      persistence: fakePersistence(),
      taskListReader: reader,
      retryBaseMs: 0,
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-XYZ",
      }),
    );

    expect(reader.hasInProgress).toHaveBeenCalledWith("conv-XYZ");
  });

  it("段切换 → windowLifecycle.onChange 收到 segment-transition", async () => {
    const onChange = vi.fn<(reason: string) => Promise<void>>().mockResolvedValue();

    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM: vi
        .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
        .mockResolvedValue(SUMMARY_OK),
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      generateSegmentId: () => "seg-wl",
    });

    const provider = makeToolThenTextProvider("t");
    await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
        windowLifecycle: { onChange },
      }),
    );

    // runTurnBegin（起始超阈）+ turn 1 工具路径 runTurnEnd + turn 2 纯文本末轮
    // runTurnEnd 各触发一次 —— 所有 messages 重构出口都经 turn-end 内部统一触发
    // 换代,一条不漏(纯文本末轮不再漏)。与段切换摘要 callLLM 的 3 次对齐。
    expect(onChange).toHaveBeenCalledWith("segment-transition");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("不注入 windowLifecycle → 段切换照常执行、不抛错", async () => {
    const segmentManager = createSegmentManager({
      estimator: fakeEstimator(20),
      capability: aggressiveCap,
      callLLM: vi
        .fn<(req: SegmentSummarizeRequest) => Promise<string>>()
        .mockResolvedValue(SUMMARY_OK),
      persistence: fakePersistence(),
      taskListReader: fakeReader(),
      retryBaseMs: 0,
      generateSegmentId: () => "seg-nowl",
    });

    const provider = makeToolThenTextProvider("t");
    const { result } = await drainAgentLoop(
      baseParams(provider, {
        segmentManager,
        conversationId: "conv-1",
        windowLifecycle: undefined,
      }),
    );

    expect(result.reason).toBe("completed");
  });

  it("getSystemPrompt：每次 LLM 调用现取其返回值，优先于固定 systemPrompt", async () => {
    const provider = makeToolThenTextProvider("t");
    const getSystemPrompt = vi.fn(() => "DYNAMIC-SYS");

    await drainAgentLoop(
      baseParams(provider, {
        systemPrompt: "STATIC-SYS",
        getSystemPrompt,
        conversationId: "conv-1",
      }),
    );

    // 两次 LLM 调用现取后进入 ChatRequest.systemPrompt —— 固定 systemPrompt 被覆盖。
    expect(getSystemPrompt).toHaveBeenCalled();
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[0]!.systemPrompt).toBe("DYNAMIC-SYS");
    expect(provider.calls[1]!.systemPrompt).toBe("DYNAMIC-SYS");
  });

  it("缺省 getSystemPrompt → 回退到固定 systemPrompt", async () => {
    const provider = makeToolThenTextProvider("t");

    await drainAgentLoop(
      baseParams(provider, {
        systemPrompt: "STATIC-SYS",
        conversationId: "conv-1",
      }),
    );

    expect(provider.calls[0]!.systemPrompt).toBe("STATIC-SYS");
  });
});
