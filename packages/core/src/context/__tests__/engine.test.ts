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
import type { CompactionStrategy, ContextManagerInput } from "../types.js";

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
