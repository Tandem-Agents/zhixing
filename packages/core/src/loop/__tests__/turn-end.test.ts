/**
 * runTurnEnd 钩子单测。
 *
 * 测试边界：钩子是 agent-loop 内部副作用编排器，只验证编排行为本身——
 *   - 副作用顺序（contextManager → segmentManager）
 *   - messages 链式传递
 *   - terminal 短路语义
 *   - 可选依赖缺省退化
 *
 * 不重复测 ContextManager / SegmentManager 自身行为（各自有独立测试），
 * 通过 stub / fake 验证钩子如何调度它们即可。
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ContextManagerHook,
  ContextManagerOutput,
  ITokenEstimator,
} from "../../context/types.js";
import { AgentError } from "../../types/errors.js";
import { emptyUsage, type TokenUsage } from "../../types/llm.js";
import { userMessage, assistantMessage } from "../../types/messages.js";
import type { Message } from "../../types/messages.js";
import type { SegmentManager } from "../../context/segment/segment-manager.js";
import type {
  SegmentManagerInput,
  SegmentManagerOutput,
} from "../../context/segment/types.js";
import { createEventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import { runTurnEnd } from "../turn-end.js";

// ─── Fixtures ───

function msg(text: string): Message {
  return text.startsWith("a:")
    ? assistantMessage(text.slice(2))
    : userMessage(text);
}

const baseUsage: TokenUsage = emptyUsage();

function makeCtx(
  output: ContextManagerOutput | (() => Promise<ContextManagerOutput>) | (() => Promise<never>),
): ContextManagerHook {
  return {
    onTurnComplete: typeof output === "function"
      ? (output as () => Promise<ContextManagerOutput>)
      : vi.fn().mockResolvedValue(output),
  };
}

function makeSeg(
  result: SegmentManagerOutput,
): SegmentManager {
  // SegmentManager 是 class，钩子只用到 evaluate；测试用 minimal 实现满足结构子集
  return {
    evaluate: vi.fn().mockResolvedValue(result),
  } as unknown as SegmentManager;
}

function baseParams(overrides?: Partial<Parameters<typeof runTurnEnd>[0]>) {
  return {
    messages: [msg("hi")] as Message[],
    turnCount: 1,
    usage: baseUsage,
    abortSignal: new AbortController().signal,
    systemPrompt: "sys",
    tools: [],
    ...overrides,
  };
}

// ─── 编排顺序 ───

describe("runTurnEnd · 副作用串行编排", () => {
  it("contextManager modified → segmentManager 收到改写后的 messages", async () => {
    const ctxOut: Message[] = [msg("ctx-changed"), msg("a:reply")];
    const ctx = makeCtx({ messages: ctxOut, modified: true });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    await runTurnEnd(baseParams({
      messages: [msg("original")],
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect(seg.evaluate).toHaveBeenCalledTimes(1);
    expect((seg.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0].messages).toEqual(ctxOut);
  });

  it("contextManager unmodified → segmentManager 收到 caller 原始 messages", async () => {
    const original = [msg("original"), msg("a:reply")];
    const ctx = makeCtx({ messages: [], modified: false });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    await runTurnEnd(baseParams({
      messages: original,
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect((seg.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0].messages).toEqual(original);
  });

  it("segmentManager modified → 钩子返回 newSegmentMessages", async () => {
    const segOut: Message[] = [msg("a:summary"), msg("post")];
    const ctx = makeCtx({ messages: [], modified: false });
    const seg = makeSeg({
      decision: { kind: "trigger", reason: "optimal-exceeded", currentTokens: 50_000, threshold: 32_000 },
      modified: true,
      newSegmentMessages: segOut,
    });

    const outcome = await runTurnEnd(baseParams({
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.messages).toEqual(segOut);
    }
  });

  it("两步都未修改 → 钩子返回 caller 原 messages", async () => {
    const original = [msg("original")];
    const ctx = makeCtx({ messages: [], modified: false });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    const outcome = await runTurnEnd(baseParams({
      messages: original,
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.messages).toEqual(original);
    }
  });
});

// ─── Terminal 短路 ───

describe("runTurnEnd · terminal 短路", () => {
  it("contextManager output.failed + 非 abort → terminal error，segmentManager 不被调", async () => {
    const ctx = makeCtx({ messages: [], modified: false, failed: true });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    const outcome = await runTurnEnd(baseParams({
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.result.reason).toBe("error");
    }
    expect(seg.evaluate).not.toHaveBeenCalled();
  });

  it("contextManager 抛错 + 非 abort → terminal error", async () => {
    const ctx = makeCtx(async () => {
      throw new AgentError("boom", "unknown", false);
    });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    const outcome = await runTurnEnd(baseParams({
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.result.reason).toBe("error");
    }
    expect(seg.evaluate).not.toHaveBeenCalled();
  });

  it("contextManager output.failed + abort 已触发 → terminal aborted（abort 优先）", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ messages: [], modified: false, failed: true });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    const outcome = await runTurnEnd(baseParams({
      abortSignal: controller.signal,
      contextManager: ctx,
      segmentManager: seg,
    }));

    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.result.reason).toBe("aborted");
    }
    expect(seg.evaluate).not.toHaveBeenCalled();
  });
});

// ─── 可选依赖缺省 ───

describe("runTurnEnd · 可选依赖缺省", () => {
  it("无 contextManager → budget 步骤 no-op，messages 直传给 segmentManager", async () => {
    const original = [msg("original")];
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });

    await runTurnEnd(baseParams({
      messages: original,
      segmentManager: seg,
    }));

    expect((seg.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0].messages).toEqual(original);
  });

  it("无 segmentManager → 段切换步骤 no-op，返 contextManager 处理后 messages", async () => {
    const ctxOut: Message[] = [msg("ctx-changed")];
    const ctx = makeCtx({ messages: ctxOut, modified: true });

    const outcome = await runTurnEnd(baseParams({
      contextManager: ctx,
    }));

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.messages).toEqual(ctxOut);
    }
  });

  it("两个都无 → messages 原样返回", async () => {
    const original = [msg("original")];

    const outcome = await runTurnEnd(baseParams({
      messages: original,
    }));

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.messages).toEqual(original);
    }
  });
});

// ─── 参数透传 ───

describe("runTurnEnd · 参数透传", () => {
  it("segmentManager.evaluate 接收完整 input（systemPrompt / tools / turnCount / conversationId / abortSignal）", async () => {
    const ctx = makeCtx({ messages: [], modified: false });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "below-optimal" },
      modified: false,
    });
    const controller = new AbortController();

    await runTurnEnd(baseParams({
      turnCount: 7,
      abortSignal: controller.signal,
      contextManager: ctx,
      segmentManager: seg,
      systemPrompt: "system-x",
      tools: [],
      conversationId: "conv-xyz",
    }));

    const input = (seg.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0] as SegmentManagerInput;
    expect(input.systemPrompt).toBe("system-x");
    expect(input.tools).toEqual([]);
    expect(input.turnCount).toBe(7);
    expect(input.conversationId).toBe("conv-xyz");
    expect(input.abortSignal).toBe(controller.signal);
  });

  it("ephemeral 路径（conversationId 缺失）→ 透传 undefined 给 segmentManager", async () => {
    const ctx = makeCtx({ messages: [], modified: false });
    const seg = makeSeg({
      decision: { kind: "pass", reason: "no-conversation" },
      modified: false,
    });

    await runTurnEnd(baseParams({
      contextManager: ctx,
      segmentManager: seg,
      conversationId: undefined,
    }));

    const input = (seg.evaluate as ReturnType<typeof vi.fn>).mock.calls[0][0] as SegmentManagerInput;
    expect(input.conversationId).toBeUndefined();
  });
});

// ─── ③ tokens 快照 emit ───

/** 固定增量的伪 estimator：每条消息 / 系统 / 工具集都按固定函数返 token 数，便于断言。 */
function fakeEstimator(opts: {
  text?: (s: string) => number;
  messages?: (m: readonly Message[]) => number;
  tools?: (t: readonly unknown[]) => number;
}): ITokenEstimator {
  return {
    estimateMessage: () => 0,
    estimateMessages: opts.messages ?? ((m) => m.length * 10),
    estimateText: opts.text ?? ((s) => s.length),
    estimateTools: opts.tools ?? ((t) => t.length * 5),
    calibrate: () => {},
    calibrationFactor: 1.0,
  };
}

describe("runTurnEnd · ③ context:tokens_snapshot emit", () => {
  it("estimator + eventBus 同时提供 → emit 一次，payload = sys + final messages + tools", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seenPayloads: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => {
      seenPayloads.push(p);
    });

    const estimator = fakeEstimator({
      text: (s) => s.length, // "system-7" => 8
      messages: (m) => m.length * 10, // 2 messages => 20
      tools: (t) => t.length * 5, // 0 tools => 0
    });

    await runTurnEnd(
      baseParams({
        messages: [msg("hi"), msg("a:hello")],
        turnCount: 3,
        tokenEstimator: estimator,
        eventBus: bus,
        systemPrompt: "system-7",
      }),
    );

    expect(seenPayloads).toHaveLength(1);
    expect(seenPayloads[0]!.totalTokens).toBe(8 + 20 + 0);
    expect(seenPayloads[0]!.turnCount).toBe(3);
  });

  it("快照消费 segmentManager 切段后的 messages（非 caller 原 messages）", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    // estimator 把 messages 估算成"条数 * 10"，便于断言"切段后" vs "切段前"
    const estimator = fakeEstimator({
      text: () => 0,
      messages: (m) => m.length * 10,
      tools: () => 0,
    });

    // segmentManager 切段把 [msg1, msg2, msg3] (30) 缩成 [summary] (10)
    const segOut: Message[] = [msg("a:summary")];
    const seg = makeSeg({
      decision: {
        kind: "trigger",
        reason: "optimal-exceeded",
        currentTokens: 30,
        threshold: 20,
      },
      modified: true,
      newSegmentMessages: segOut,
    });

    await runTurnEnd(
      baseParams({
        messages: [msg("m1"), msg("m2"), msg("m3")], // caller 原 messages: 3 条
        tokenEstimator: estimator,
        eventBus: bus,
        segmentManager: seg,
      }),
    );

    // 切段后 messages 是 1 条 → 10 tokens（不是 30，否则就是切段前快照）
    expect(seen[0]!.totalTokens).toBe(10);
  });

  it("缺 estimator → 不 emit", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    await runTurnEnd(baseParams({ eventBus: bus }));

    expect(seen).toHaveLength(0);
  });

  it("缺 eventBus → 不 emit（estimator 不调用，避免无意义计算）", async () => {
    const estimateMessages = vi.fn().mockReturnValue(100);
    const estimator: ITokenEstimator = {
      estimateMessage: () => 0,
      estimateMessages,
      estimateText: () => 0,
      estimateTools: () => 0,
      calibrate: () => {},
      calibrationFactor: 1.0,
    };

    await runTurnEnd(baseParams({ tokenEstimator: estimator }));

    expect(estimateMessages).not.toHaveBeenCalled();
  });

  it("terminal 短路时不 emit（contextManager 失败路径）", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    const ctx = makeCtx({ messages: [], modified: false, failed: true });
    const estimator = fakeEstimator({});

    const outcome = await runTurnEnd(
      baseParams({
        contextManager: ctx,
        tokenEstimator: estimator,
        eventBus: bus,
      }),
    );

    expect(outcome.kind).toBe("terminal");
    expect(seen).toHaveLength(0); // 短路 → ③ 未执行
  });
});

// ─── ③ Anchor + Delta 路径 ───

describe("runTurnEnd · ③ Anchor + Delta 优先路径", () => {
  it("anchor 可用且 messages 是延伸 → totalTokens = anchor.inputTokens + estimateMessages(delta)", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    // estimator 用于校验 anchor 路径不调 estimateText/estimateTools
    const estimateText = vi.fn().mockReturnValue(9999);
    const estimateTools = vi.fn().mockReturnValue(9999);
    const estimator: ITokenEstimator = {
      estimateMessage: () => 0,
      estimateMessages: (m) => m.length * 10, // delta=2条 → 20
      estimateText,
      estimateTools,
      calibrate: () => {},
      calibrationFactor: 1.0,
    };

    await runTurnEnd(
      baseParams({
        // baseline=3 时 LLM 看到的 inputTokens=6500
        anchor: { inputTokens: 6500, baselineMessageCount: 3 },
        // 当前 messages=5 条 → delta = 后 2 条
        messages: [msg("m1"), msg("m2"), msg("m3"), msg("m4"), msg("a:reply")],
        tokenEstimator: estimator,
        eventBus: bus,
      }),
    );

    // 6500 (anchor) + 20 (delta 2 条 × 10) = 6520
    expect(seen[0]!.totalTokens).toBe(6520);
    // anchor 路径不调 system / tools 估算
    expect(estimateText).not.toHaveBeenCalled();
    expect(estimateTools).not.toHaveBeenCalled();
  });

  it("anchor 失效（messages.length < baseline）→ fallback 字符估算（段切段场景）", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    const estimator = fakeEstimator({
      text: (s) => s.length, // "sys" = 3
      messages: (m) => m.length * 10, // 1 条 = 10
      tools: () => 0,
    });

    await runTurnEnd(
      baseParams({
        // baseline=5 但 messages 缩到 1 条（如 segmentManager 切段）→ anchor 失效
        anchor: { inputTokens: 6500, baselineMessageCount: 5 },
        messages: [msg("a:summary")],
        tokenEstimator: estimator,
        eventBus: bus,
        systemPrompt: "sys",
      }),
    );

    // fallback: estimateText("sys")=3 + estimateMessages([summary])=10 + tools=0 = 13
    expect(seen[0]!.totalTokens).toBe(13);
  });

  it("anchor 缺失 → fallback 字符估算（首次 LLM call 之前）", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    const estimator = fakeEstimator({
      text: () => 100,
      messages: () => 200,
      tools: () => 50,
    });

    await runTurnEnd(
      baseParams({
        // 无 anchor —— 首次 LLM call 前 state.anchor=undefined
        messages: [msg("hi")],
        tokenEstimator: estimator,
        eventBus: bus,
      }),
    );

    // fallback: 100 + 200 + 50 = 350
    expect(seen[0]!.totalTokens).toBe(350);
  });

  it("anchor.baselineMessageCount === messages.length → delta 为空数组 → 仅 anchor.inputTokens", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    const estimator = fakeEstimator({
      messages: (m) => m.length * 10, // 空数组 → 0
    });

    await runTurnEnd(
      baseParams({
        anchor: { inputTokens: 6500, baselineMessageCount: 2 },
        messages: [msg("m1"), msg("m2")], // 与 baseline 完全相等
        tokenEstimator: estimator,
        eventBus: bus,
      }),
    );

    expect(seen[0]!.totalTokens).toBe(6500);
  });

  it("contextManager 修改 messages 后 anchor 仍按修改后的 length 算 delta", async () => {
    const bus = createEventBus<AgentEventMap>();
    const seen: AgentEventMap["context:tokens_snapshot"][] = [];
    bus.on("context:tokens_snapshot", (p) => seen.push(p));

    // contextManager 把 5 条压缩到 3 条 → anchor.baseline=4 > messages.length=3 → fallback
    const ctx = makeCtx({
      messages: [msg("compacted-1"), msg("compacted-2"), msg("a:new")],
      modified: true,
    });

    const estimator = fakeEstimator({
      text: () => 50,
      messages: (m) => m.length * 10, // 3 条 = 30
      tools: () => 0,
    });

    await runTurnEnd(
      baseParams({
        anchor: { inputTokens: 6500, baselineMessageCount: 4 },
        messages: [msg("m1"), msg("m2"), msg("m3"), msg("m4"), msg("a:r")],
        contextManager: ctx,
        tokenEstimator: estimator,
        eventBus: bus,
        systemPrompt: "x".repeat(10),
      }),
    );

    // contextManager 处理后 messages=3 条 < baseline=4 → fallback
    // = 50 (sys) + 30 (3 msgs) + 0 (tools) = 80
    expect(seen[0]!.totalTokens).toBe(80);
  });
});
