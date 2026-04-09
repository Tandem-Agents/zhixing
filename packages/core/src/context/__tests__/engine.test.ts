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
import { createTokenEstimator } from "../token-estimator.js";
import { createToolResultTrimStrategy } from "../strategies/tool-result-trim.js";
import type { CompactionStrategy, ContextManagerInput } from "../types.js";

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

  it("emits compact_start and compact_end when compacting", async () => {
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
      },
      eventBus,
    );

    const messages = buildLargeConversation(6, 2000);
    await engine.onTurnComplete({ messages, turnCount: 6 });

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.type).toBe("start");
    expect(events[1]!.type).toBe("end");
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
