import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
} from "../../types/messages.js";
import type { Message } from "../../types/messages.js";
import { ContextEngine, createContextEngine } from "../engine.js";
import { INTERACTIVE_PROFILE } from "../context-profile.js";
import { createTokenEstimator } from "../token-estimator.js";
import { createToolResultTrimStrategy } from "../strategies/tool-result-trim.js";
import type {
  CompactStrategyContribution,
  CompactionContext,
  CompactionStrategy,
  ContextManagerInput,
} from "../types.js";

/**
 * 构造一个禁用 Tier 压缩的 profile 克隆。
 *
 * 很多 strategy 层的断言（比如"strategies 执行顺序"/"发 compact_start 事件"）
 * 需要把 context 引入 compact 阈值。但默认 profile 的 Tier 压缩会先把大部分
 * tool_result trim 掉，反而让预算回到 normal，strategies 永远跑不到。
 *
 * 这些测试关心的是"strategies 层行为"，因此隔离掉 Tier 层的干扰更符合测试意图。
 * 真实生产下 Tier 先跑是期望行为（见 context-profile.ts / window-manager.ts 的设计）。
 */
const STRATEGY_ONLY_PROFILE = {
  ...INTERACTIVE_PROFILE,
  tierThresholds: null,
} as const;

// ─── 测试辅助 ───

function buildLargeConversation(turns: number, resultSize = 2000): Message[] {
  const messages: Message[] = [userMessage("开始分析项目")];

  for (let i = 0; i < turns; i++) {
    const toolId = `t${i}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `执行 read_file_${i}` },
        { type: "tool_use", id: toolId, name: "read", input: { path: `file_${i}.ts` } },
      ],
    });
    messages.push(
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: toolId,
          content: "x".repeat(resultSize) + `_file_${i}`,
        },
      ]),
    );
  }

  return messages;
}

const SMALL_MODEL = { contextWindow: 32_000, maxOutputTokens: 4_096 };
const LARGE_MODEL = { contextWindow: 200_000, maxOutputTokens: 8_192 };

// ─── ContextEngine.checkBudget ───

describe("ContextEngine.checkBudget", () => {
  it("returns normal status for small conversations", () => {
    const estimator = createTokenEstimator();
    const engine = createContextEngine(estimator, [], {
      modelInfo: LARGE_MODEL,
    });

    const messages = [userMessage("Hello"), assistantMessage("Hi!")];
    const budget = engine.checkBudget(messages);

    expect(budget.status).toBe("normal");
    expect(budget.usageRatio).toBeLessThan(0.01);
  });

  it("reflects token growth as conversation grows", () => {
    const estimator = createTokenEstimator();
    const engine = createContextEngine(estimator, [], {
      modelInfo: SMALL_MODEL,
    });

    const small = buildLargeConversation(2, 500);
    const large = buildLargeConversation(20, 500);

    const budgetSmall = engine.checkBudget(small);
    const budgetLarge = engine.checkBudget(large);

    expect(budgetLarge.usageRatio).toBeGreaterThan(budgetSmall.usageRatio);
  });
});

// ─── ContextEngine.onTurnComplete ───

describe("ContextEngine.onTurnComplete", () => {
  it("does not modify messages when budget is normal", async () => {
    const estimator = createTokenEstimator();
    const strategy = createToolResultTrimStrategy();
    const engine = createContextEngine(estimator, [strategy], {
      modelInfo: LARGE_MODEL,
    });

    const messages = [userMessage("Hello"), assistantMessage("Hi!")];
    const result = await engine.onTurnComplete({ messages, turnCount: 1 });

    expect(result.modified).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("triggers compaction when budget exceeds compact threshold", async () => {
    const estimator = createTokenEstimator();
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 100,
    });

    // 用极低阈值确保超过 compact，或用大数据量
    const engine = createContextEngine(estimator, [strategy], {
      modelInfo: SMALL_MODEL,
      thresholds: { warning: 0.05, compact: 0.10, critical: 0.9 },
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(10, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 10 });

    expect(result.modified).toBe(true);

    const tokensBefore = estimator.estimateMessages(messages);
    const tokensAfter = estimator.estimateMessages(result.messages);
    expect(tokensAfter).toBeLessThan(tokensBefore);
  });

  it("executes strategies in priority order", async () => {
    const executionOrder: string[] = [];

    const strategy1: CompactionStrategy = {
      name: "low_priority",
      priority: 10,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => {
        executionOrder.push("low_priority");
        return {
          messages: ctx.messages as Message[],
          tokensBefore: 0,
          tokensAfter: 0,
          compacted: false,
        };
      },
    };

    const strategy2: CompactionStrategy = {
      name: "high_priority",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => {
        executionOrder.push("high_priority");
        return {
          messages: ctx.messages as Message[],
          tokensBefore: 0,
          tokensAfter: 0,
          compacted: false,
        };
      },
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(estimator, [strategy1, strategy2], {
      modelInfo: SMALL_MODEL,
      thresholds: { warning: 0.005, compact: 0.01, critical: 0.9 },
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(3, 500);
    await engine.onTurnComplete({ messages, turnCount: 3 });

    expect(executionOrder[0]).toBe("high_priority");
    expect(executionOrder[1]).toBe("low_priority");
  });

  it("stops executing strategies once budget returns to safe zone", async () => {
    const executionOrder: string[] = [];

    const effectiveStrategy: CompactionStrategy = {
      name: "effective",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => {
        executionOrder.push("effective");
        // 大幅截断消息：只保留前两条
        return {
          messages: (ctx.messages as Message[]).slice(0, 2),
          tokensBefore: 0,
          tokensAfter: 0,
          compacted: true,
        };
      },
    };

    const expensiveStrategy: CompactionStrategy = {
      name: "expensive",
      priority: 10,
      requiresLLM: true,
      canApply: () => true,
      apply: async (ctx) => {
        executionOrder.push("expensive");
        return {
          messages: ctx.messages as Message[],
          tokensBefore: 0,
          tokensAfter: 0,
          compacted: false,
        };
      },
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [effectiveStrategy, expensiveStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
    );

    const messages = buildLargeConversation(5, 1000);
    await engine.onTurnComplete({ messages, turnCount: 5 });

    expect(executionOrder).toEqual(["effective"]);
    // expensive 不应被执行
  });

  it("skips strategies that canApply returns false", async () => {
    const skippedStrategy: CompactionStrategy = {
      name: "skipped",
      priority: 0,
      requiresLLM: false,
      canApply: () => false,
      apply: vi.fn(async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: 0,
        tokensAfter: 0,
        compacted: false,
      })),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(estimator, [skippedStrategy], {
      modelInfo: SMALL_MODEL,
      thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(3, 500);
    await engine.onTurnComplete({ messages, turnCount: 3 });

    expect(skippedStrategy.apply).not.toHaveBeenCalled();
  });
});

// ─── ContextEngine events ───

describe("ContextEngine events", () => {
  it("emits budget_check event on every onTurnComplete", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const budgetChecks: unknown[] = [];
    eventBus.on("context:budget_check", (data) => budgetChecks.push(data));

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [],
      { modelInfo: LARGE_MODEL },
      eventBus,
    );

    const messages = [userMessage("Hello"), assistantMessage("Hi!")];
    await engine.onTurnComplete({ messages, turnCount: 1 });

    expect(budgetChecks).toHaveLength(1);
    expect(budgetChecks[0]).toHaveProperty("status", "normal");
    expect(budgetChecks[0]).toHaveProperty("usageRatio");
  });

  it("emits compact_start and compact_end when compacting (事务化后正好 2 个事件)", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const events: { type: string; data: unknown }[] = [];
    eventBus.on("context:compact_start", (data) =>
      events.push({ type: "start", data }),
    );
    eventBus.on("context:compact_end", (data) =>
      events.push({ type: "end", data }),
    );

    const estimator = createTokenEstimator();
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 100,
    });

    const engine = createContextEngine(
      estimator,
      [strategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // 事务化：每次 compact 仅 1 start + 1 end（不再按 strategy 逐个 fire）
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("start");
    expect(events[1]!.type).toBe("end");

    // end payload 结构：strategies[] + 汇总字段
    const endPayload = events[1]!.data as {
      strategies: Array<{ name: string; success: boolean }>;
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(endPayload.strategies).toHaveLength(1);
    expect(endPayload.strategies[0]!.name).toBe("tool_result_trim");
    expect(endPayload.strategies[0]!.success).toBe(true);
  });

  it("多 strategy 跑：end.strategies 列出每个贡献，tokensBefore/After 覆盖整个事务", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const events: { type: string; data: unknown }[] = [];
    eventBus.on("context:compact_start", (data) =>
      events.push({ type: "start", data }),
    );
    eventBus.on("context:compact_end", (data) =>
      events.push({ type: "end", data }),
    );

    // 两个 mock strategy：都 canApply=true，都 compacted=true 但不改 messages
    // → budget 不变，engine 不会 break，两个都跑
    const strategyA: CompactionStrategy = {
      name: "strategy_a",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
      }),
    };
    const strategyB: CompactionStrategy = {
      name: "strategy_b",
      priority: 1,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
      }),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [strategyA, strategyB],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // 仍是 1 start + 1 end（事务化）
    expect(events.length).toBe(2);

    const endPayload = events[1]!.data as {
      strategies: Array<{ name: string; success: boolean }>;
      tokensBefore: number;
      tokensAfter: number;
    };
    expect(endPayload.strategies.map((s) => s.name)).toEqual([
      "strategy_a",
      "strategy_b",
    ]);
    expect(endPayload.strategies.every((s) => s.success)).toBe(true);
  });

  it("所有 canApply 返回 false：不 fire 任何 compact 事件", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const events: { type: string }[] = [];
    eventBus.on("context:compact_start", () => events.push({ type: "start" }));
    eventBus.on("context:compact_end", () => events.push({ type: "end" }));

    const skippedStrategy: CompactionStrategy = {
      name: "skipped",
      priority: 0,
      requiresLLM: false,
      canApply: () => false,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: 0,
        tokensAfter: 0,
        compacted: false,
      }),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [skippedStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // 没 strategy 跑 → 不 fire compact 事件（budget_check 仍 fire，但那是另一事件）
    expect(events.length).toBe(0);
  });

  it("strategy 抛错时 try-finally 保证 compact_end 仍 fire（契约保护）", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const events: { type: string }[] = [];
    eventBus.on("context:compact_start", () => events.push({ type: "start" }));
    eventBus.on("context:compact_end", () => events.push({ type: "end" }));

    const throwingStrategy: CompactionStrategy = {
      name: "boom",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async () => {
        throw new Error("strategy internal error");
      },
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [throwingStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await expect(
      engine.onTurnComplete({ messages, turnCount: 6 }),
    ).rejects.toThrow("strategy internal error");

    // 事务契约：start fire 了，end 也必须 fire（即使中间抛错）
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("start");
    expect(events[1]!.type).toBe("end");
  });

  it("summary + turnsCompacted 聚合：单摘要型策略时汇总字段 = 该策略值", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    let endPayload: AgentEventMap["context:compact_end"] | undefined;
    eventBus.on("context:compact_end", (data) => {
      endPayload = data;
    });

    // 模拟一个摘要型策略 —— 产生 summary + turnsCompacted
    const mockSummarizer: CompactionStrategy = {
      name: "mock_summarizer",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: Math.floor(ctx.budget.currentTokens / 2),
        compacted: true,
        summary: "real llm summary",
        turnsCompacted: 5,
      }),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [mockSummarizer],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(endPayload).toBeDefined();
    expect(endPayload!.summary).toBe("real llm summary");
    expect(endPayload!.turnsCompacted).toBe(5);
    expect(endPayload!.strategies).toHaveLength(1);
    expect(endPayload!.strategies[0]!.summary).toBe("real llm summary");
    expect(endPayload!.strategies[0]!.turnsCompacted).toBe(5);
  });

  it("summary + turnsCompacted 聚合：双摘要型策略时 summary 取最新、turnsCompacted 求和", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    let endPayload: AgentEventMap["context:compact_end"] | undefined;
    eventBus.on("context:compact_end", (data) => {
      endPayload = data;
    });

    // 两个摘要型策略 —— 都 compacted=true 但不改 messages（让两个都跑）
    const summarizerA: CompactionStrategy = {
      name: "summarizer_a",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
        summary: "first summary",
        turnsCompacted: 3,
      }),
    };
    const summarizerB: CompactionStrategy = {
      name: "summarizer_b",
      priority: 1,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
        summary: "second summary",
        turnsCompacted: 4,
      }),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [summarizerA, summarizerB],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // summary: 取 contributions 中最后一个非空（.pop()）→ summarizer_b
    expect(endPayload!.summary).toBe("second summary");
    // turnsCompacted: 所有非空求和（reduce）→ 3 + 4 = 7
    expect(endPayload!.turnsCompacted).toBe(7);
    // strategies 数组里两条贡献都在
    expect(endPayload!.strategies).toHaveLength(2);
    expect(endPayload!.strategies[0]!.summary).toBe("first summary");
    expect(endPayload!.strategies[1]!.summary).toBe("second summary");
  });

  it("summary + turnsCompacted 聚合：混合摘要与非摘要策略时只聚合摘要", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    let endPayload: AgentEventMap["context:compact_end"] | undefined;
    eventBus.on("context:compact_end", (data) => {
      endPayload = data;
    });

    const nonSummarizer: CompactionStrategy = {
      name: "non_summarizer",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
        // 无 summary / turnsCompacted —— 模拟 ToolResultTrim / MessageDrop
      }),
    };
    const summarizer: CompactionStrategy = {
      name: "summarizer",
      priority: 1,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
        summary: "llm summary",
        turnsCompacted: 2,
      }),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [nonSummarizer, summarizer],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(endPayload!.summary).toBe("llm summary");   // 只有摘要策略的 summary
    expect(endPayload!.turnsCompacted).toBe(2);         // 非摘要 undefined 被 reduce 跳过
  });

  it("summary + turnsCompacted 聚合：全是非摘要策略时汇总字段 = undefined", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    let endPayload: AgentEventMap["context:compact_end"] | undefined;
    eventBus.on("context:compact_end", (data) => {
      endPayload = data;
    });

    const nonSummarizer: CompactionStrategy = {
      name: "tool_result_trim_like",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async (ctx) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: true,
      }),
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [nonSummarizer],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(endPayload!.summary).toBeUndefined();
    // turnsCompacted 聚合: sum=0 → undefined（engine 的 `> 0 ? raw : undefined` 分支）
    expect(endPayload!.turnsCompacted).toBeUndefined();
  });

  it("post-compact budget_check 在 strategy 抛错时仍 fire（观测链契约）", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const budgetChecks: Array<{ phase: string }> = [];
    eventBus.on("context:budget_check", (data) =>
      budgetChecks.push({ phase: data.phase }),
    );

    const throwingStrategy: CompactionStrategy = {
      name: "boom",
      priority: 0,
      requiresLLM: false,
      canApply: () => true,
      apply: async () => {
        throw new Error("strategy internal error");
      },
    };

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [throwingStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);

    // strategy 抛错会 rethrow，但 post-compact budget_check 必须已在 rethrow 前 fire
    await expect(
      engine.onTurnComplete({ messages, turnCount: 6 }),
    ).rejects.toThrow("strategy internal error");

    expect(budgetChecks.map((b) => b.phase)).toEqual([
      "pre-compact",
      "post-compact",
    ]);
  });

  it("实际进入 strategies 循环时 fire pre-compact + post-compact 两次 budget_check", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const budgetChecks: Array<{ phase: string }> = [];
    eventBus.on("context:budget_check", (data) =>
      budgetChecks.push({ phase: data.phase }),
    );

    const estimator = createTokenEstimator();
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 100,
    });

    const engine = createContextEngine(
      estimator,
      [strategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: { warning: 0.01, compact: 0.02, critical: 0.9 },
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // 进入循环路径：pre-compact + post-compact
    expect(budgetChecks).toHaveLength(2);
    expect(budgetChecks[0]!.phase).toBe("pre-compact");
    expect(budgetChecks[1]!.phase).toBe("post-compact");
  });

  it("早退（normal）路径：仅 fire pre-compact 一次 budget_check", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const budgetChecks: Array<{ phase: string }> = [];
    eventBus.on("context:budget_check", (data) =>
      budgetChecks.push({ phase: data.phase }),
    );

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [],
      { modelInfo: LARGE_MODEL },
      eventBus,
    );

    const messages = [userMessage("Hello"), assistantMessage("Hi!")];
    await engine.onTurnComplete({ messages, turnCount: 1 });

    expect(budgetChecks).toHaveLength(1);
    expect(budgetChecks[0]!.phase).toBe("pre-compact");
  });

  it("emits calibrate event", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const calibrations: unknown[] = [];
    eventBus.on("context:calibrate", (data) => calibrations.push(data));

    const estimator = createTokenEstimator();
    const engine = createContextEngine(
      estimator,
      [],
      { modelInfo: LARGE_MODEL },
      eventBus,
    );

    engine.calibrate(100, 130);

    expect(calibrations).toHaveLength(1);
    expect(calibrations[0]).toHaveProperty("estimated", 100);
    expect(calibrations[0]).toHaveProperty("actual", 130);
    expect(calibrations[0]).toHaveProperty("newRatio");
  });
});

// ─── ContextEngine P0-L critical force-apply 契约（Phase 4 S3） ───

describe("ContextEngine critical force-apply 契约（Phase 4 S3）", () => {
  /**
   * 构造一个可 mock 的 llm-summarize strategy。
   *
   * 用于覆盖 force-apply 路径：通过控制 canApply / apply 分别模拟：
   *   - canApply=false：正常 strategies 循环被挡，只有 force-apply 能触达 apply
   *   - canApply=true：循环内 apply 会跑一次，force-apply 是否触达取决于 budget 是否仍 critical
   *   - apply 返 compacted=true/false：模拟 LLM 成功 / 失败
   *
   * name 必须是 "llm-summarize" —— engine 通过 name 匹配识别摘要型策略。
   */
  function makeMockLLMSummarize(opts: {
    canApply: boolean;
    apply: import("vitest").Mock;
    name?: string;
  }): CompactionStrategy {
    return {
      name: opts.name ?? "llm-summarize",
      kind: "summarize",
      priority: 200,
      requiresLLM: true,
      canApply: () => opts.canApply,
      apply: opts.apply,
    };
  }

  /**
   * 强制 critical 的阈值组合。
   * warning < compact < critical 都设得很低，保证 buildLargeConversation 直接 critical。
   */
  const FORCE_CRITICAL_THRESHOLDS = {
    warning: 0.01,
    compact: 0.02,
    critical: 0.05,
  };

  it("critical + canApply=false → force-apply 触达 apply, contribution.phase='force-apply'", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const compactEndPayloads: Array<{
      strategies: readonly CompactStrategyContribution[];
      tokensBefore: number;
      tokensAfter: number;
    }> = [];
    eventBus.on("context:compact_end", (data) =>
      compactEndPayloads.push({
        strategies: data.strategies,
        tokensBefore: data.tokensBefore,
        tokensAfter: data.tokensAfter,
      }),
    );

    const estimator = createTokenEstimator();
    // force-apply 模拟 LLM 调用失败（compacted=false）—— 最纯粹的 force-apply 触达验证
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    const mockStrategy = makeMockLLMSummarize({ canApply: false, apply: applyFn });

    const engine = createContextEngine(
      estimator,
      [mockStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // canApply=false 挡了正常循环 → apply 只在 force-apply 里被调 1 次
    expect(applyFn).toHaveBeenCalledTimes(1);

    // compact_end fire 过一次, strategies[] 只有 force-apply 的贡献
    expect(compactEndPayloads).toHaveLength(1);
    const contributions = compactEndPayloads[0]!.strategies;
    expect(contributions).toHaveLength(1);
    // name 保持纯策略 ID, phase 标记阶段(P0-γ 修复: 取代 "(force-apply)" name 后缀)
    expect(contributions[0]!.name).toBe("llm-summarize");
    expect(contributions[0]!.phase).toBe("force-apply");
    expect(contributions[0]!.success).toBe(false);
  });

  it("force-apply 成功压到 non-critical → ContextManagerOutput.failed 为 undefined", async () => {
    const estimator = createTokenEstimator();
    // apply 返回极小消息 → 下一次 checkBudget 回到 normal
    const tinyMessages: Message[] = [userMessage("ok")];
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: tinyMessages,
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: 10,
      compacted: true,
      summary: "[Previous conversation summarized]",
      turnsCompacted: 4,
    }));
    const mockStrategy = makeMockLLMSummarize({ canApply: false, apply: applyFn });

    const engine = createContextEngine(estimator, [mockStrategy], {
      modelInfo: SMALL_MODEL,
      thresholds: FORCE_CRITICAL_THRESHOLDS,
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(applyFn).toHaveBeenCalledTimes(1);
    expect(result.modified).toBe(true);
    // 压到 normal 不触发 failed 契约
    expect(result.failed).toBeUndefined();
  });

  it("force-apply 失败（apply 返 compacted=false 不改 messages）→ failed: true", async () => {
    const estimator = createTokenEstimator();
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    const mockStrategy = makeMockLLMSummarize({ canApply: false, apply: applyFn });

    const engine = createContextEngine(estimator, [mockStrategy], {
      modelInfo: SMALL_MODEL,
      thresholds: FORCE_CRITICAL_THRESHOLDS,
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(applyFn).toHaveBeenCalledTimes(1);
    // critical → force-apply 失败 → failed 契约触发
    expect(result.failed).toBe(true);
  });

  it("没有 llm-summarize 策略 → critical 时跳过 force-apply, failed: true", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const compactStartCount = { n: 0 };
    eventBus.on("context:compact_start", () => {
      compactStartCount.n++;
    });

    const estimator = createTokenEstimator();
    // 用真实 ToolResultTrim（非摘要型），但低 staleTurnThreshold 让它 canApply=true
    // 即便如此它只 trim tool_result 文本，大对话仍会留在 critical
    const trimStrategy = createToolResultTrimStrategy({
      staleTurnThreshold: 999,  // 大到不会 trim 任何 turn，确保 critical 保留
      keepChars: 100,
    });

    const engine = createContextEngine(
      estimator,
      [trimStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // 没有 llm-summarize → force-apply 不触发（strategies.find 返 undefined）
    // 仅 strategies 循环本身可能 fire compact_start（取决于 trim canApply）
    expect(result.failed).toBe(true);
  });

  it("策略循环内正常 compacted 成功 → 不进 force-apply 分支", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const compactEndPayloads: Array<{
      strategies: readonly CompactStrategyContribution[];
    }> = [];
    eventBus.on("context:compact_end", (data) =>
      compactEndPayloads.push({ strategies: data.strategies }),
    );

    const estimator = createTokenEstimator();
    const tinyMessages: Message[] = [userMessage("ok")];
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: tinyMessages,
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: 10,
      compacted: true,
    }));
    // canApply=true → 循环内被调 + 压到 normal → break 循环, 不进 force-apply
    const mockStrategy = makeMockLLMSummarize({ canApply: true, apply: applyFn });

    const engine = createContextEngine(
      estimator,
      [mockStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // apply 只在循环内被调 1 次；未再调 force-apply
    expect(applyFn).toHaveBeenCalledTimes(1);

    // contributions 只有 1 条, phase="normal" 标记循环内正常执行
    const contributions = compactEndPayloads[0]!.strategies;
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.name).toBe("llm-summarize");
    expect(contributions[0]!.phase).toBe("normal");
    expect(result.failed).toBeUndefined();
  });

  it("循环内 apply 失败（compacted=false）仍 critical → force-apply 再调一次", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const compactEndPayloads: Array<{
      strategies: readonly CompactStrategyContribution[];
    }> = [];
    eventBus.on("context:compact_end", (data) =>
      compactEndPayloads.push({ strategies: data.strategies }),
    );

    const estimator = createTokenEstimator();
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    // canApply=true → 循环内被调，但 compacted=false 没降 critical → force-apply 再调
    const mockStrategy = makeMockLLMSummarize({ canApply: true, apply: applyFn });

    const engine = createContextEngine(
      estimator,
      [mockStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // 循环内 + force-apply 各调一次 = 2 次
    expect(applyFn).toHaveBeenCalledTimes(2);

    // contributions 2 条：都是 "llm-summarize",phase 分别为 normal / force-apply
    const contributions = compactEndPayloads[0]!.strategies;
    expect(contributions).toHaveLength(2);
    expect(contributions[0]!.name).toBe("llm-summarize");
    expect(contributions[0]!.phase).toBe("normal");
    expect(contributions[1]!.name).toBe("llm-summarize");
    expect(contributions[1]!.phase).toBe("force-apply");
    // 两次都没降 critical → failed
    expect(result.failed).toBe(true);
  });

  it("非 critical（仅 compact）时不触发 force-apply", async () => {
    const estimator = createTokenEstimator();
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    const mockStrategy = makeMockLLMSummarize({ canApply: false, apply: applyFn });

    const engine = createContextEngine(estimator, [mockStrategy], {
      modelInfo: SMALL_MODEL,
      // compact 触发但不到 critical：warn=0.01 / compact=0.02 / critical=0.999
      thresholds: { warning: 0.01, compact: 0.02, critical: 0.999 },
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // budget 在 compact 区间不在 critical → force-apply 分支不进
    expect(applyFn).toHaveBeenCalledTimes(0);
    expect(result.failed).toBeUndefined();
  });

  // ─── P0-β: kind 匹配（去字符串硬编码） ───

  it("force-apply 按 kind=summarize 识别而非 name 字符串（P0-β）", async () => {
    // 策略名改成 "custom-summarizer-v2"（模拟改名 / 多摘要策略场景）,
    // 但 kind 保持 "summarize" → engine 仍能正确识别并 force-apply。
    // 若仍按 name === "llm-summarize" 硬匹配则会静默漏触发。
    const estimator = createTokenEstimator();
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    const customNamedStrategy: CompactionStrategy = {
      name: "custom-summarizer-v2",
      kind: "summarize",
      priority: 200,
      requiresLLM: true,
      canApply: () => false,
      apply: applyFn,
    };

    const engine = createContextEngine(estimator, [customNamedStrategy], {
      modelInfo: SMALL_MODEL,
      thresholds: FORCE_CRITICAL_THRESHOLDS,
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // 即便 name 不再是 "llm-summarize",force-apply 仍触达
    expect(applyFn).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(true);
  });

  it("非 summarize kind 的策略（flush/trim/drop）不作 force-apply 候选（P0-β）", async () => {
    // kind=flush 策略注册也不应被选作 force-apply 候选 ——
    // 只有 summarize 能"替代 turn"产生 token 显著削减
    const estimator = createTokenEstimator();
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    const flushStrategy: CompactionStrategy = {
      name: "memory_flush",
      kind: "flush",
      priority: 3,
      requiresLLM: true,
      canApply: () => false,
      apply: applyFn,
    };

    const engine = createContextEngine(estimator, [flushStrategy], {
      modelInfo: SMALL_MODEL,
      thresholds: FORCE_CRITICAL_THRESHOLDS,
      profile: STRATEGY_ONLY_PROFILE,
    });

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // flush 策略不被 force-apply
    expect(applyFn).toHaveBeenCalledTimes(0);
    // 无 summarize 候选 → failed
    expect(result.failed).toBe(true);
  });

  // ─── 多 summarize 策略：force-apply 按 priority ASC 逐个尝试 ───

  it("多 summarize 策略：force-apply 按优先级 ASC 逐个尝试，降到 non-critical 就 break", async () => {
    // 场景：用户注册 fast-summarize (priority=100) + llm-summarize (priority=200)
    // fast 在 critical 下失败（compacted=false），llm 成功 → force-apply 先调 fast 再调 llm
    const estimator = createTokenEstimator();

    const fastApply = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    const fastSummarize: CompactionStrategy = {
      name: "fast-summarize",
      kind: "summarize",
      priority: 100,
      requiresLLM: true,
      canApply: () => false,
      apply: fastApply,
    };

    const tinyMessages: Message[] = [userMessage("ok")];
    const llmApply = vi.fn(async (ctx: CompactionContext) => ({
      messages: tinyMessages,
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: 10,
      compacted: true,
      summary: "[summarized by llm]",
      turnsCompacted: 3,
    }));
    const llmSummarize: CompactionStrategy = {
      name: "llm-summarize",
      kind: "summarize",
      priority: 200,
      requiresLLM: true,
      canApply: () => false,
      apply: llmApply,
    };

    const eventBus = new EventBus<AgentEventMap>();
    const compactEndPayloads: Array<{
      strategies: readonly CompactStrategyContribution[];
    }> = [];
    eventBus.on("context:compact_end", (data) =>
      compactEndPayloads.push({ strategies: data.strategies }),
    );

    // 策略传入顺序故意反一下，验证 engine 构造时的 priority 排序
    const engine = createContextEngine(
      estimator,
      [llmSummarize, fastSummarize],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    // force-apply 先调 fast (失败) 再调 llm (成功) → 各调 1 次
    expect(fastApply).toHaveBeenCalledTimes(1);
    expect(llmApply).toHaveBeenCalledTimes(1);

    // contributions 按执行顺序：fast-summarize → llm-summarize，都 phase="force-apply"
    const contributions = compactEndPayloads[0]!.strategies;
    expect(contributions).toHaveLength(2);
    expect(contributions[0]!.name).toBe("fast-summarize");
    expect(contributions[0]!.phase).toBe("force-apply");
    expect(contributions[0]!.success).toBe(false);
    expect(contributions[1]!.name).toBe("llm-summarize");
    expect(contributions[1]!.phase).toBe("force-apply");
    expect(contributions[1]!.success).toBe(true);

    // llm 成功把 budget 降回 non-critical → failed 未触发
    expect(result.failed).toBeUndefined();
  });

  it("多 summarize 策略：第一个成功即 break，后续的不再尝试", async () => {
    const estimator = createTokenEstimator();

    const tinyMessages: Message[] = [userMessage("ok")];
    const fastApply = vi.fn(async (ctx: CompactionContext) => ({
      messages: tinyMessages,
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: 10,
      compacted: true,
      summary: "[summarized by fast]",
      turnsCompacted: 3,
    }));
    const fastSummarize: CompactionStrategy = {
      name: "fast-summarize",
      kind: "summarize",
      priority: 100,
      requiresLLM: true,
      canApply: () => false,
      apply: fastApply,
    };

    const llmApply = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const llmSummarize: CompactionStrategy = {
      name: "llm-summarize",
      kind: "summarize",
      priority: 200,
      requiresLLM: true,
      canApply: () => false,
      apply: llmApply,
    };

    const engine = createContextEngine(
      estimator,
      [fastSummarize, llmSummarize],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
    );

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(fastApply).toHaveBeenCalledTimes(1);
    // fast 一次成功 → budget 离开 critical → llm 不再尝试
    expect(llmApply).toHaveBeenCalledTimes(0);
    expect(result.failed).toBeUndefined();
    expect(result.modified).toBe(true);
  });

  it("多 summarize 策略：全部失败 → contributions 含所有尝试记录 + failed=true", async () => {
    const estimator = createTokenEstimator();

    const makeFailingStrategy = (
      name: string,
      priority: number,
    ): { strategy: CompactionStrategy; apply: import("vitest").Mock } => {
      const apply = vi.fn(async (ctx: CompactionContext) => ({
        messages: ctx.messages as Message[],
        tokensBefore: ctx.budget.currentTokens,
        tokensAfter: ctx.budget.currentTokens,
        compacted: false,
      }));
      return {
        strategy: {
          name,
          kind: "summarize",
          priority,
          requiresLLM: true,
          canApply: () => false,
          apply,
        },
        apply,
      };
    };

    const s1 = makeFailingStrategy("summarize-a", 100);
    const s2 = makeFailingStrategy("summarize-b", 150);
    const s3 = makeFailingStrategy("summarize-c", 200);

    const eventBus = new EventBus<AgentEventMap>();
    const compactEndPayloads: Array<{
      strategies: readonly CompactStrategyContribution[];
    }> = [];
    eventBus.on("context:compact_end", (data) =>
      compactEndPayloads.push({ strategies: data.strategies }),
    );

    const engine = createContextEngine(
      estimator,
      [s1.strategy, s2.strategy, s3.strategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    const result = await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(s1.apply).toHaveBeenCalledTimes(1);
    expect(s2.apply).toHaveBeenCalledTimes(1);
    expect(s3.apply).toHaveBeenCalledTimes(1);

    // 三次 force-apply 贡献全部记录（诊断 / 审计完整）
    const contributions = compactEndPayloads[0]!.strategies;
    expect(contributions).toHaveLength(3);
    expect(contributions.map((c) => c.name)).toEqual([
      "summarize-a",
      "summarize-b",
      "summarize-c",
    ]);
    expect(contributions.every((c) => c.phase === "force-apply")).toBe(true);
    expect(contributions.every((c) => c.success === false)).toBe(true);

    expect(result.failed).toBe(true);
  });

  // ─── strategy.apply 抛错：贡献仍被记录 + rethrow ───

  it("strategy.apply 抛错 → contribution 仍被记录（success:false）后 rethrow 到外层", async () => {
    // 契约：strategies 内部应捕获异常并返 compacted:false；rethrow 仅在 programming bug 路径。
    // 为保诊断/审计不丢，compact_end 事件必须包含这个失败记录。
    const eventBus = new EventBus<AgentEventMap>();
    const compactEndPayloads: Array<{
      strategies: readonly CompactStrategyContribution[];
    }> = [];
    eventBus.on("context:compact_end", (data) =>
      compactEndPayloads.push({ strategies: data.strategies }),
    );

    const estimator = createTokenEstimator();
    const bugError = new Error("programming bug: strategy forgot try-catch");
    const applyFn = vi.fn(async () => {
      throw bugError;
    });
    const buggyStrategy: CompactionStrategy = {
      name: "buggy-summarize",
      kind: "summarize",
      priority: 200,
      requiresLLM: true,
      canApply: () => true,
      apply: applyFn,
    };

    const engine = createContextEngine(
      estimator,
      [buggyStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);

    // engine onTurnComplete 应 rethrow 原错误（agent-loop / pre-flight 由
    // resolveContextManager 把它归一化成 AgentError）
    await expect(
      engine.onTurnComplete({ messages, turnCount: 6 }),
    ).rejects.toBe(bugError);

    // rethrow 前必须 fire compact_end 且含贡献记录
    expect(compactEndPayloads).toHaveLength(1);
    const contributions = compactEndPayloads[0]!.strategies;
    // 循环内 apply 抛 → 记录一条；force-apply 不再尝试（caughtError 已中断）
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.name).toBe("buggy-summarize");
    expect(contributions[0]!.phase).toBe("normal");
    expect(contributions[0]!.success).toBe(false);
  });

  // ─── P1-ζ: compact_start 事务幂等 ───

  it("compact_start 只 fire 一次(force-apply 加入事务不重复 fire, P1-ζ)", async () => {
    const eventBus = new EventBus<AgentEventMap>();
    const startCount = { n: 0 };
    const endCount = { n: 0 };
    eventBus.on("context:compact_start", () => {
      startCount.n++;
    });
    eventBus.on("context:compact_end", () => {
      endCount.n++;
    });

    const estimator = createTokenEstimator();
    const applyFn = vi.fn(async (ctx: CompactionContext) => ({
      messages: ctx.messages as Message[],
      tokensBefore: ctx.budget.currentTokens,
      tokensAfter: ctx.budget.currentTokens,
      compacted: false,
    }));
    // canApply=true + compacted=false 触发循环内 + force-apply 两次 apply
    const mockStrategy = makeMockLLMSummarize({ canApply: true, apply: applyFn });

    const engine = createContextEngine(
      estimator,
      [mockStrategy],
      {
        modelInfo: SMALL_MODEL,
        thresholds: FORCE_CRITICAL_THRESHOLDS,
        profile: STRATEGY_ONLY_PROFILE,
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    // 即便有两次 apply(loop + force-apply),事务级事件各只 fire 一次
    expect(startCount.n).toBe(1);
    expect(endCount.n).toBe(1);
    // 且 apply 被调 2 次
    expect(applyFn).toHaveBeenCalledTimes(2);
  });
});
