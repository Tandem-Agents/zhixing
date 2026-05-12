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
import type { ContextManagerHook, ContextManagerOutput } from "../../context/types.js";
import { AgentError } from "../../types/errors.js";
import { emptyUsage, type TokenUsage } from "../../types/llm.js";
import { userMessage, assistantMessage } from "../../types/messages.js";
import type { Message } from "../../types/messages.js";
import type { SegmentManager } from "../../context/segment/segment-manager.js";
import type {
  SegmentManagerInput,
  SegmentManagerOutput,
} from "../../context/segment/types.js";
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
