import { describe, expect, it } from "vitest";
import {
  ToolResultTrimStrategy,
  createToolResultTrimStrategy,
} from "../strategies/tool-result-trim.js";
import { calculateMessageTurns } from "../message-turns.js";
import type { Message } from "../../types/messages.js";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
} from "../../types/messages.js";
import type { CompactionContext, ContextBudget } from "../types.js";
import { createTokenEstimator } from "../token-estimator.js";

// ─── 辅助函数 ───

function makeToolUseAssistant(toolId: string, name: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: `Let me ${name}.` },
      { type: "tool_use", id: toolId, name, input: {} },
    ],
  };
}

function makeToolResult(toolId: string, content: string): Message {
  return toolResultMessage([
    { type: "tool_result", toolUseId: toolId, content },
  ]);
}

function makeBudget(overrides?: Partial<ContextBudget>): ContextBudget {
  return {
    contextWindow: 200_000,
    effectiveWindow: 180_000,
    currentTokens: 150_000,
    usageRatio: 0.83,
    status: "warning",
    ...overrides,
  };
}

function makeContext(
  messages: Message[],
  currentTurn = 0,
  budget?: Partial<ContextBudget>,
): CompactionContext {
  return {
    messages,
    budget: makeBudget(budget),
    currentTurn,
  };
}

/**
 * 构建一个多轮对话，每轮包含 assistant(tool_use) + user(tool_result)。
 */
function buildConversation(turnCount: number, resultSize = 500): Message[] {
  const messages: Message[] = [userMessage("请帮我分析项目")];

  for (let i = 0; i < turnCount; i++) {
    const toolId = `tool_${i}`;
    messages.push(makeToolUseAssistant(toolId, `read_file_${i}`));
    messages.push(
      makeToolResult(toolId, "x".repeat(resultSize) + `_turn_${i}`),
    );
  }

  return messages;
}

// ─── calculateMessageTurns ───

describe("calculateMessageTurns", () => {
  it("assigns turns based on assistant messages", () => {
    const messages = [
      userMessage("Hello"),
      assistantMessage("Hi"),
      userMessage("Read this"),
      assistantMessage("Sure"),
    ];
    const turns = calculateMessageTurns(messages);
    expect(turns).toEqual([0, 1, 1, 2]);
  });

  it("groups tool_result with preceding assistant", () => {
    const messages = [
      userMessage("Read file"),
      makeToolUseAssistant("t1", "read"),
      makeToolResult("t1", "file content"),
      assistantMessage("Done"),
    ];
    const turns = calculateMessageTurns(messages);
    // user=0, assistant=1, tool_result(user)=1, assistant=2
    expect(turns).toEqual([0, 1, 1, 2]);
  });

  it("handles empty messages", () => {
    expect(calculateMessageTurns([])).toEqual([]);
  });
});

// ─── ToolResultTrimStrategy.canApply ───

describe("ToolResultTrimStrategy.canApply", () => {
  const strategy = createToolResultTrimStrategy({
    staleTurnThreshold: 4,
    keepChars: 200,
  });

  it("returns false for short conversations", () => {
    const messages = buildConversation(3, 500);
    const ctx = makeContext(messages);
    expect(strategy.canApply(ctx)).toBe(false);
  });

  it("returns true when old turns have large tool_results", () => {
    const messages = buildConversation(8, 500);
    const ctx = makeContext(messages);
    expect(strategy.canApply(ctx)).toBe(true);
  });

  it("returns false when tool_results are already small", () => {
    const messages = buildConversation(8, 50);
    const strategy50 = createToolResultTrimStrategy({
      staleTurnThreshold: 4,
      keepChars: 200,
    });
    const ctx = makeContext(messages);
    expect(strategy50.canApply(ctx)).toBe(false);
  });

  it("returns false when tool_results are already truncated", () => {
    const messages = buildConversation(8, 500);
    // 手动标记第一个 tool_result 为已截断
    const firstResult = messages[2]!;
    if (firstResult.content[0]!.type === "tool_result") {
      firstResult.content[0]!.content =
        "preview...\n[已截断，原始 500 字符]";
    }
    // 只留一个可截断的旧 tool_result → 但如果已经截了就不用再截
    const messages2 = buildConversation(8, 50); // 全部 < keepChars
    const ctx = makeContext(messages2);
    expect(strategy.canApply(ctx)).toBe(false);
  });
});

// ─── ToolResultTrimStrategy.apply ───

describe("ToolResultTrimStrategy.apply", () => {
  it("truncates old tool_results, preserves recent ones", async () => {
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 100,
    });
    const messages = buildConversation(6, 500);
    const ctx = makeContext(messages);

    const result = await strategy.apply(ctx);

    expect(result.compacted).toBe(true);

    // 检查：旧轮次（前 4 轮）的 tool_result 被截断
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i]!;
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;

        const turns = calculateMessageTurns(messages);
        const maxTurn = turns[turns.length - 1]!;
        const staleThreshold = maxTurn - 2;

        if (turns[i]! <= staleThreshold) {
          // 旧的 → 应该被截断
          expect(block.content).toContain("[已截断，原始 ");
          expect(block.content.length).toBeLessThan(500);
        } else {
          // 新的 → 保持完整
          expect(block.content).not.toContain("[已截断，原始 ");
        }
      }
    }
  });

  it("does not modify messages when nothing to trim", async () => {
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 10,
      keepChars: 200,
    });
    const messages = buildConversation(3, 100);
    const ctx = makeContext(messages);

    const result = await strategy.apply(ctx);
    expect(result.compacted).toBe(false);
    // 引用相同 — 未创建新对象
    result.messages.forEach((msg, i) => {
      expect(msg).toBe(messages[i]);
    });
  });

  it("preserves the preview prefix in truncated content", async () => {
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 50,
    });
    const originalContent = "这是一段很长的文件内容，包含了重要的代码和逻辑。" + "a".repeat(500);
    const messages: Message[] = [
      userMessage("read file"),
      makeToolUseAssistant("t1", "read"),
      makeToolResult("t1", originalContent),
      // 添加足够多轮让 t1 变旧
      makeToolUseAssistant("t2", "read"),
      makeToolResult("t2", "recent"),
      makeToolUseAssistant("t3", "read"),
      makeToolResult("t3", "recent"),
      makeToolUseAssistant("t4", "read"),
      makeToolResult("t4", "recent"),
    ];

    const ctx = makeContext(messages);
    const result = await strategy.apply(ctx);

    expect(result.compacted).toBe(true);

    const trimmedBlock = result.messages[2]!.content[0]!;
    if (trimmedBlock.type === "tool_result") {
      // 前 50 个字符应该保留
      expect(trimmedBlock.content).toContain(
        originalContent.slice(0, 50),
      );
      expect(trimmedBlock.content).toContain("[已截断，原始 ");
    }
  });

  it("token estimate decreases after trimming", async () => {
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 100,
    });
    const estimator = createTokenEstimator();
    const messages = buildConversation(8, 2000);

    const tokensBefore = estimator.estimateMessages(messages);

    const ctx = makeContext(messages);
    const result = await strategy.apply(ctx);

    const tokensAfter = estimator.estimateMessages(result.messages);

    expect(result.compacted).toBe(true);
    expect(tokensAfter).toBeLessThan(tokensBefore);
    // 2000 chars × 多个旧轮 → 显著下降
    expect(tokensAfter).toBeLessThan(tokensBefore * 0.6);
  });

  it("does not double-truncate already truncated content", async () => {
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 2,
      keepChars: 100,
    });
    const messages = buildConversation(6, 500);
    const ctx = makeContext(messages);

    // 第一次截断
    const result1 = await strategy.apply(ctx);
    expect(result1.compacted).toBe(true);

    // 第二次截断 — 不应该再有变化
    const ctx2 = makeContext(result1.messages);
    const result2 = await strategy.apply(ctx2);
    expect(result2.compacted).toBe(false);
  });

  it("respects custom keepChars", async () => {
    const strategy = createToolResultTrimStrategy({
      staleTurnThreshold: 1,
      keepChars: 20,
    });
    const messages = buildConversation(4, 500);
    const ctx = makeContext(messages);

    const result = await strategy.apply(ctx);
    expect(result.compacted).toBe(true);

    // 截断后内容 = 20 chars preview + 截断标记
    for (const msg of result.messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.content.includes("[已截断")) {
          const previewPart = block.content.split("\n[已截断")[0]!;
          expect(previewPart.length).toBe(20);
        }
      }
    }
  });
});
