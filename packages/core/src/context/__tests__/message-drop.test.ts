import { describe, expect, it } from "vitest";
import {
  MessageDropStrategy,
  createMessageDropStrategy,
} from "../strategies/message-drop.js";
import type { Message } from "../../types/messages.js";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
} from "../../types/messages.js";
import type { CompactionContext, ContextBudget } from "../types.js";
import { createTokenEstimator } from "../token-estimator.js";

// ─── 辅助 ───

function buildConversation(turns: number, resultSize = 500): Message[] {
  const messages: Message[] = [userMessage("请帮我分析项目")];

  for (let i = 0; i < turns; i++) {
    const toolId = `t${i}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `执行工具 ${i}` },
        { type: "tool_use", id: toolId, name: `tool_${i}`, input: {} },
      ],
    });
    messages.push(
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: toolId,
          content: "result".repeat(resultSize / 6),
        },
      ]),
    );
  }

  return messages;
}

function makeBudget(overrides?: Partial<ContextBudget>): ContextBudget {
  return {
    contextWindow: 200_000,
    effectiveWindow: 180_000,
    currentTokens: 160_000,
    usageRatio: 0.89,
    status: "compact",
    ...overrides,
  };
}

function makeContext(
  messages: Message[],
  currentTurn = 0,
): CompactionContext {
  return { messages, budget: makeBudget(), currentTurn };
}

// ─── canApply ───

describe("MessageDropStrategy.canApply", () => {
  it("returns false for short conversations", () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 4 });
    const messages = buildConversation(3);
    // 3 turns = 7 messages, keepMessages = 4*2+1 = 9 → 7 < 9+2 = 11, not enough
    expect(strategy.canApply(makeContext(messages))).toBe(false);
  });

  it("returns true for long conversations", () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 4 });
    const messages = buildConversation(20);
    // 20 turns = 41 messages, keepMessages = 9 → 41 > 11
    expect(strategy.canApply(makeContext(messages))).toBe(true);
  });
});

// ─── apply ───

describe("MessageDropStrategy.apply", () => {
  it("preserves first message and recent turns", async () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 3 });
    const messages = buildConversation(10);
    const ctx = makeContext(messages, 10);

    const result = await strategy.apply(ctx);

    expect(result.compacted).toBe(true);

    // 第一条是原始 user 消息
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]).toBe(messages[0]);

    // 第二条是占位消息
    const placeholder = result.messages[1]!;
    expect(placeholder.role).toBe("user");
    const placeholderText = placeholder.content[0]!;
    expect(placeholderText.type === "text" && placeholderText.text).toContain(
      "已省略",
    );

    // 消息数量应大幅减少
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("reduces total messages significantly", async () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 4 });
    const messages = buildConversation(50);
    const ctx = makeContext(messages, 50);

    const result = await strategy.apply(ctx);

    expect(result.compacted).toBe(true);
    // 50 turns = 101 messages → 应该只剩 1(first) + 1(placeholder) + ~8(4 turns) = ~10
    expect(result.messages.length).toBeLessThanOrEqual(12);
  });

  it("reduces token estimate", async () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 3 });
    const estimator = createTokenEstimator();
    const messages = buildConversation(20, 1000);

    const tokensBefore = estimator.estimateMessages(messages);

    const ctx = makeContext(messages, 20);
    const result = await strategy.apply(ctx);

    const tokensAfter = estimator.estimateMessages(result.messages);
    expect(tokensAfter).toBeLessThan(tokensBefore);
    expect(tokensAfter).toBeLessThan(tokensBefore * 0.5);
  });

  it("preserves message references for kept messages", async () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 2 });
    const messages = buildConversation(10);
    const ctx = makeContext(messages, 10);

    const result = await strategy.apply(ctx);

    // 第一条 = 原始引用
    expect(result.messages[0]).toBe(messages[0]);

    // 最后几条 = 原始引用（不是副本）
    const lastOriginal = messages[messages.length - 1]!;
    const lastResult = result.messages[result.messages.length - 1]!;
    expect(lastResult).toBe(lastOriginal);
  });

  it("does not compact when not enough messages", async () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 10 });
    const messages = buildConversation(5);
    const ctx = makeContext(messages, 5);

    const result = await strategy.apply(ctx);
    // Not enough messages to warrant dropping (5 turns = 11 messages, need to keep 10 turns)
    expect(result.compacted).toBe(false);
  });

  it("placeholder mentions correct number of dropped turns", async () => {
    const strategy = createMessageDropStrategy({ keepRecentTurns: 2 });
    const messages = buildConversation(10);
    const ctx = makeContext(messages, 10);

    const result = await strategy.apply(ctx);
    const placeholder = result.messages[1]!;
    const text =
      placeholder.content[0]!.type === "text"
        ? placeholder.content[0]!.text
        : "";

    // 10 轮 - 保留 2 轮 = 丢弃 8 轮
    expect(text).toContain("8");
    expect(text).toContain("2");
  });

  it("respects custom keepRecentTurns", async () => {
    const strategy1 = createMessageDropStrategy({ keepRecentTurns: 2 });
    const strategy2 = createMessageDropStrategy({ keepRecentTurns: 8 });
    const messages = buildConversation(20);

    const result1 = await strategy1.apply(makeContext(messages, 20));
    const result2 = await strategy2.apply(makeContext(messages, 20));

    // 保留更多轮 → 更多消息
    expect(result2.messages.length).toBeGreaterThan(result1.messages.length);
  });
});
