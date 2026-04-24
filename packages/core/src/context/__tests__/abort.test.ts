/**
 * abort 契约测试 —— Phase 2 S1 abortSignal 透传 + B2 修复的端到端保护
 *
 * 覆盖三层契约：
 *   1. LLMSummarize.apply：abort 时静默退出，不计 CircuitBreaker 失败
 *   2. MemoryFlush.apply：abort 时不污染 _lastResult.errors
 *   3. ContextEngine.onTurnComplete：abort 时整体不抛错（保护 agent-loop 链路）
 *
 * 这是 Phase 4 critical 硬挡（P0-L force-apply LLMSummarize）的前提：
 * abort 必须能传到 LLM 调用但不破坏 engine 链路。
 */

import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types/messages.js";
import { TokenEstimator } from "../token-estimator.js";
import type {
  CompactLLMFn,
  CompactionContext,
  ContextBudget,
} from "../types.js";
import { ContextEngine } from "../engine.js";
import { LLMSummarizeStrategy } from "../strategies/llm-summarize.js";
import { MemoryFlushStrategy } from "../../memory/flush-engine.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import { REQUIRED_MAIN_SECTIONS } from "../validation.js";

// ─── Fixtures ───

const MODEL_INFO = { contextWindow: 1000, maxOutputTokens: 100 };

/**
 * 模拟 provider：检查 abortSignal.aborted 时抛 AbortError。
 * 真实 provider（@anthropic-ai/sdk / openai）的行为也是这样。
 */
function makeAbortingLLM(): CompactLLMFn {
  return async (_msgs, opts) => {
    if (opts?.abortSignal?.aborted) {
      const err = new Error("Request aborted");
      err.name = "AbortError";
      throw err;
    }
    // 不 abort 时返回一个有效的 summary（满足 validateSummary 必需章节）
    return REQUIRED_MAIN_SECTIONS.map((s) => `${s}\n测试内容`).join("\n\n");
  };
}

/**
 * 模拟一个总是失败的 provider（非 abort 失败）。
 * 用于对比验证：真失败会计 breaker，而 abort 不会。
 */
function makeFailingLLM(): CompactLLMFn {
  return async () => {
    throw new Error("provider down");
  };
}

function makeMessages(userAssistantPairs: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < userAssistantPairs; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `问题 ${i}` }] });
    msgs.push({
      role: "assistant",
      content: [{ type: "text", text: `回答 ${i}` }],
    });
  }
  return msgs;
}

function makeContext(
  messages: Message[],
  usageRatio: number,
  abortSignal?: AbortSignal,
): CompactionContext {
  const budget: ContextBudget = {
    contextWindow: 1000,
    effectiveWindow: 900,
    currentTokens: Math.floor(900 * usageRatio),
    usageRatio,
    status: usageRatio >= 0.9 ? "critical" : usageRatio >= 0.85 ? "compact" : "warning",
  };
  return { messages, budget, currentTurn: 10, abortSignal };
}

function makeAbortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function makeMockStore(): MemoryStore {
  return {
    save: vi.fn(),
    load: vi.fn(),
  } as unknown as MemoryStore;
}

// ─── LLMSummarize · abort 契约 ───

describe("abort 契约 · LLMSummarize", () => {
  it("abort 触发时 apply 静默返回 compacted:false 且不抛错", async () => {
    const strategy = new LLMSummarizeStrategy({
      callLLM: makeAbortingLLM(),
      estimator: new TokenEstimator(),
      triggerRatio: 0.5,
      preserveRecentTurns: 1,
    });

    const messages = makeMessages(5);
    const context = makeContext(messages, 0.9, makeAbortedSignal());

    // 不抛错
    const result = await strategy.apply(context);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("abort 连续 N 次不计 CircuitBreaker 失败（避免误熔断）", async () => {
    const strategy = new LLMSummarizeStrategy({
      callLLM: makeAbortingLLM(),
      estimator: new TokenEstimator(),
      triggerRatio: 0.5,
      preserveRecentTurns: 1,
      circuitBreaker: { maxFailures: 1 }, // 1 次失败就熔断
    });

    const abortedSignal = makeAbortedSignal();
    const messages = makeMessages(5);
    const context = makeContext(messages, 0.9, abortedSignal);

    // 连续 abort 3 次
    await strategy.apply(context);
    await strategy.apply(context);
    await strategy.apply(context);

    // breaker 仍然 closed（未被 abort 误熔断）
    expect(strategy.circuitBreakerState).toBe("closed");
  });

  it("真实 LLM 失败计入 CircuitBreaker（与 abort 形成对比保护）", async () => {
    const strategy = new LLMSummarizeStrategy({
      callLLM: makeFailingLLM(),
      estimator: new TokenEstimator(),
      triggerRatio: 0.5,
      preserveRecentTurns: 1,
      circuitBreaker: { maxFailures: 1 },
    });

    const messages = makeMessages(5);
    const context = makeContext(messages, 0.9); // 无 abortSignal

    await strategy.apply(context);

    // 真失败应该熔断
    expect(strategy.circuitBreakerState).toBe("open");
  });
});

// ─── MemoryFlush · abort 契约 ───

describe("abort 契约 · MemoryFlush", () => {
  it("abort 触发时 apply 不抛错且不污染 _lastResult", async () => {
    const strategy = new MemoryFlushStrategy({
      callLLM: makeAbortingLLM(),
      store: makeMockStore(),
      minMessages: 1,
      minBudgetRatio: 0,
    });

    const messages = makeMessages(5);
    const context = makeContext(messages, 0.9, makeAbortedSignal());

    const result = await strategy.apply(context);
    expect(result.compacted).toBe(false);
    // abort 不污染 _lastResult —— 保持初始 null（不写入 "flush failed"）
    expect(strategy.lastResult).toBeNull();
  });

  it("真实 Flush 失败时 _lastResult.errors 记录错误（对比保护）", async () => {
    const strategy = new MemoryFlushStrategy({
      callLLM: makeFailingLLM(),
      store: makeMockStore(),
      minMessages: 1,
      minBudgetRatio: 0,
    });

    const messages = makeMessages(5);
    const context = makeContext(messages, 0.9); // 无 abortSignal

    await strategy.apply(context);

    expect(strategy.lastResult).toEqual({
      extracted: 0,
      saved: 0,
      errors: ["flush failed"],
    });
  });

  it("abort 不覆盖之前的成功 _lastResult（保留诊断信息）", async () => {
    // 先成功一次
    let abortMode = false;
    const conditionalLLM: CompactLLMFn = async (_msgs, opts) => {
      if (abortMode && opts?.abortSignal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return "[]"; // 空提取，合法 JSON
    };

    const strategy = new MemoryFlushStrategy({
      callLLM: conditionalLLM,
      store: makeMockStore(),
      minMessages: 1,
      minBudgetRatio: 0,
    });

    const messages = makeMessages(5);

    // 第一次：非 abort，成功
    await strategy.apply(makeContext(messages, 0.9));
    expect(strategy.lastResult).toEqual({ extracted: 0, saved: 0, errors: [] });

    // 第二次：abort
    abortMode = true;
    await strategy.apply(makeContext(messages, 0.9, makeAbortedSignal()));

    // _lastResult 保留上次的成功结果（不被 abort 污染成 "flush failed"）
    expect(strategy.lastResult).toEqual({ extracted: 0, saved: 0, errors: [] });
  });
});

// ─── ContextEngine.onTurnComplete · abort 契约 ───

describe("abort 契约 · ContextEngine.onTurnComplete", () => {
  it("abort 触发时 onTurnComplete 不抛错（保护 agent-loop 链路）", async () => {
    const estimator = new TokenEstimator();
    const strategies = [
      new LLMSummarizeStrategy({
        callLLM: makeAbortingLLM(),
        estimator,
        triggerRatio: 0.5,
        preserveRecentTurns: 1,
      }),
      new MemoryFlushStrategy({
        callLLM: makeAbortingLLM(),
        store: makeMockStore(),
        minMessages: 1,
        minBudgetRatio: 0,
      }),
    ];

    const engine = new ContextEngine(estimator, strategies, {
      modelInfo: MODEL_INFO,
      thresholds: { warning: 0.1, compact: 0.5, critical: 0.9 },
      // 不激活 Tier 层，隔离测试 strategies
      profile: {
        name: "interactive",
        includeProfile: true,
        layer2Mode: "basic",
        toolCategories: [],
        budgetThresholds: { warning: 0.1, compact: 0.5, critical: 0.9 },
        tierThresholds: null,
        onExhausted: "yield-error-to-user",
      },
    });

    const messages = makeMessages(10);

    // 核心契约：onTurnComplete 不抛错
    await expect(
      engine.onTurnComplete({
        messages,
        turnCount: 5,
        abortSignal: makeAbortedSignal(),
      }),
    ).resolves.toBeDefined();
  });
});
