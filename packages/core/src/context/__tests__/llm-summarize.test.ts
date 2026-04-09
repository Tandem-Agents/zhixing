import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types/messages.js";
import { TokenEstimator } from "../token-estimator.js";
import { calculateBudget } from "../budget.js";
import {
  LLMSummarizeStrategy,
  type SummarizeLLMFn,
} from "../strategies/llm-summarize.js";
import { REQUIRED_MAIN_SECTIONS } from "../validation.js";

// ─── Fixtures ───

function makeMessages(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: `用户消息 ${i}，这是一段较长的对话内容用于测试 token 估算和压缩策略。` }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `助手回复 ${i}，详细的技术讨论内容，包含代码片段和解释。` }],
      },
    );
  }
  return messages;
}

const VALID_SUMMARY = REQUIRED_MAIN_SECTIONS.map(
  (s) => `${s}\n测试内容`,
).join("\n\n");

const INCOMPLETE_SUMMARY = "## 核心目标\n内容\n\n## 技术上下文\n内容";

function createMockLLM(responses: string[]): SummarizeLLMFn {
  let callIndex = 0;
  return vi.fn(async () => {
    const response = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return response;
  });
}

function createFailingLLM(): SummarizeLLMFn {
  return vi.fn(async () => {
    throw new Error("LLM 调用失败");
  });
}

const estimator = new TokenEstimator();

// ─── Tests ───

describe("LLMSummarizeStrategy", () => {
  describe("canApply", () => {
    it("usageRatio >= triggerRatio 时可应用", () => {
      const strategy = new LLMSummarizeStrategy({
        callLLM: createMockLLM([VALID_SUMMARY]),
        estimator,
        triggerRatio: 0.9,
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        850,
      );

      expect(
        strategy.canApply({ messages, budget, currentTurn: 10 }),
      ).toBe(true);
    });

    it("usageRatio < triggerRatio 时不应用", () => {
      const strategy = new LLMSummarizeStrategy({
        callLLM: createMockLLM([VALID_SUMMARY]),
        estimator,
        triggerRatio: 0.9,
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 10000, maxOutputTokens: 100 },
        500,
      );

      expect(
        strategy.canApply({ messages, budget, currentTurn: 10 }),
      ).toBe(false);
    });

    it("消息太少时不应用", () => {
      const strategy = new LLMSummarizeStrategy({
        callLLM: createMockLLM([VALID_SUMMARY]),
        estimator,
      });

      const messages = makeMessages(2);
      const budget = calculateBudget(
        { contextWindow: 100, maxOutputTokens: 10 },
        85,
      );

      expect(
        strategy.canApply({ messages, budget, currentTurn: 2 }),
      ).toBe(false);
    });
  });

  describe("apply", () => {
    it("成功生成摘要并压缩消息", async () => {
      const mockLLM = createMockLLM([VALID_SUMMARY]);
      const strategy = new LLMSummarizeStrategy({
        callLLM: mockLLM,
        estimator,
        preserveRecentTurns: 2,
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        900,
      );

      const result = await strategy.apply({
        messages,
        budget,
        currentTurn: 10,
      });

      expect(result.compacted).toBe(true);
      // 摘要前缀（2 条）+ 保留的最近 4 条（2 turns × 2）
      expect(result.messages.length).toBeLessThan(messages.length);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      // 第一条消息包含摘要
      expect(result.messages[0]!.content[0]).toHaveProperty("text");
      const firstText = (result.messages[0]!.content[0] as { text: string }).text;
      expect(firstText).toContain("对话已压缩");
    });

    it("首次校验失败时重试一次", async () => {
      const mockLLM = createMockLLM([
        INCOMPLETE_SUMMARY,
        VALID_SUMMARY,
      ]);
      const strategy = new LLMSummarizeStrategy({
        callLLM: mockLLM,
        estimator,
        preserveRecentTurns: 2,
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        900,
      );

      const result = await strategy.apply({
        messages,
        budget,
        currentTurn: 10,
      });

      expect(result.compacted).toBe(true);
      expect(mockLLM).toHaveBeenCalledTimes(2);
    });

    it("两次校验都失败时返回未压缩", async () => {
      const mockLLM = createMockLLM([
        INCOMPLETE_SUMMARY,
        INCOMPLETE_SUMMARY,
      ]);
      const strategy = new LLMSummarizeStrategy({
        callLLM: mockLLM,
        estimator,
        preserveRecentTurns: 2,
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        900,
      );

      const result = await strategy.apply({
        messages,
        budget,
        currentTurn: 10,
      });

      expect(result.compacted).toBe(false);
      expect(mockLLM).toHaveBeenCalledTimes(2);
    });

    it("LLM 调用异常时返回未压缩", async () => {
      const strategy = new LLMSummarizeStrategy({
        callLLM: createFailingLLM(),
        estimator,
        preserveRecentTurns: 2,
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        900,
      );

      const result = await strategy.apply({
        messages,
        budget,
        currentTurn: 10,
      });

      expect(result.compacted).toBe(false);
    });
  });

  describe("CircuitBreaker", () => {
    it("连续失败后熔断，canApply 返回 false", async () => {
      const strategy = new LLMSummarizeStrategy({
        callLLM: createFailingLLM(),
        estimator,
        preserveRecentTurns: 2,
        circuitBreaker: { maxFailures: 2 },
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        900,
      );
      const ctx = { messages, budget, currentTurn: 10 };

      // 第 1 次失败
      await strategy.apply(ctx);
      expect(strategy.canApply(ctx)).toBe(true);

      // 第 2 次失败 → 熔断
      await strategy.apply(ctx);
      expect(strategy.canApply(ctx)).toBe(false);
      expect(strategy.circuitBreakerState).toBe("open");
    });

    it("成功后重置熔断器", async () => {
      let callCount = 0;
      const mockLLM: SummarizeLLMFn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("fail");
        return VALID_SUMMARY;
      });

      const strategy = new LLMSummarizeStrategy({
        callLLM: mockLLM,
        estimator,
        preserveRecentTurns: 2,
        circuitBreaker: { maxFailures: 3 },
      });

      const messages = makeMessages(10);
      const budget = calculateBudget(
        { contextWindow: 1000, maxOutputTokens: 100 },
        900,
      );
      const ctx = { messages, budget, currentTurn: 10 };

      // 第 1 次失败
      await strategy.apply(ctx);
      expect(strategy.circuitBreakerState).toBe("closed");

      // 第 2 次成功 → 重置
      const result = await strategy.apply(ctx);
      expect(result.compacted).toBe(true);
      expect(strategy.circuitBreakerState).toBe("closed");
    });
  });
});
