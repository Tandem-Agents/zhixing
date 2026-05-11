import { describe, expect, it } from "vitest";
import {
  TIER2_MAX_CHARS,
  TIER3_MAX_CHARS,
  applyTierCompression,
  determineTier,
} from "../tier-compressor.js";
import type { TierThresholds } from "../types.js";
import type { Message } from "../../types/messages.js";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
} from "../../types/messages.js";

// ─── 测试辅助 ───

const THRESHOLDS: TierThresholds = { T1: 2, T2: 8, T3: 30 };

function makeToolConversation(turns: number, resultSize = 3000): Message[] {
  const messages: Message[] = [userMessage("开始分析项目")];

  for (let i = 0; i < turns; i++) {
    const toolId = `t${i}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `执行 read_file_${i}` },
        {
          type: "tool_use",
          id: toolId,
          name: "read",
          input: { file_path: `file_${i}.ts` },
        },
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

// ─── determineTier ───

describe("determineTier", () => {
  it("returns Tier 1 for distance within T1", () => {
    expect(determineTier(0, THRESHOLDS)).toBe(1);
    expect(determineTier(1, THRESHOLDS)).toBe(1);
    expect(determineTier(2, THRESHOLDS)).toBe(1);
  });

  it("returns Tier 2 for distance between T1 and T2", () => {
    expect(determineTier(3, THRESHOLDS)).toBe(2);
    expect(determineTier(5, THRESHOLDS)).toBe(2);
    expect(determineTier(8, THRESHOLDS)).toBe(2);
  });

  it("returns Tier 3 for distance between T2 and T3", () => {
    expect(determineTier(9, THRESHOLDS)).toBe(3);
    expect(determineTier(20, THRESHOLDS)).toBe(3);
    expect(determineTier(30, THRESHOLDS)).toBe(3);
  });

  it("returns Tier 4 for distance beyond T3", () => {
    expect(determineTier(31, THRESHOLDS)).toBe(4);
    expect(determineTier(100, THRESHOLDS)).toBe(4);
  });

  it("works with autonomous thresholds (tighter)", () => {
    const autonomousThresholds: TierThresholds = { T1: 1, T2: 3, T3: 12 };
    expect(determineTier(1, autonomousThresholds)).toBe(1);
    expect(determineTier(2, autonomousThresholds)).toBe(2);
    expect(determineTier(4, autonomousThresholds)).toBe(3);
    expect(determineTier(13, autonomousThresholds)).toBe(4);
  });
});

// ─── applyTierCompression ───

describe("applyTierCompression", () => {
  it("preserves Tier 1 messages completely", () => {
    const messages = makeToolConversation(3, 5000);
    const { messages: result, stats } = applyTierCompression(
      messages,
      THRESHOLDS,
    );

    // 3 turns → maxTurn=3, all within T1(2) distance
    // Turn 1: distance=2, Turn 2: distance=1, Turn 3: distance=0
    expect(stats.tier1Count).toBe(3);
    expect(stats.charsSaved).toBe(0);
    expect(result).toBe(messages);
  });

  it("trims Tier 2 tool_results to TIER2_MAX_CHARS", () => {
    const messages = makeToolConversation(10, 5000);
    const { messages: result, stats } = applyTierCompression(
      messages,
      THRESHOLDS,
    );

    expect(stats.tier2Count).toBeGreaterThan(0);
    expect(stats.charsSaved).toBeGreaterThan(0);

    // Check a Tier 2 tool_result was trimmed
    for (const msg of result) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.content.includes("已截断至")) {
          expect(block.content.length).toBeLessThan(5000);
          expect(block.content).toContain(`已截断至 ${TIER2_MAX_CHARS} 字符`);
          return;
        }
      }
    }
    expect.fail("Expected at least one Tier 2 truncated result");
  });

  it("trims Tier 3 tool_results to TIER3_MAX_CHARS", () => {
    const messages = makeToolConversation(15, 5000);
    const { stats } = applyTierCompression(messages, THRESHOLDS);

    expect(stats.tier3Count).toBeGreaterThan(0);
  });

  it("reduces Tier 4 to skeleton", () => {
    const messages = makeToolConversation(35, 5000);
    const { messages: result, stats } = applyTierCompression(
      messages,
      THRESHOLDS,
    );

    expect(stats.tier4Count).toBeGreaterThan(0);

    // Find a Tier 4 skeleton
    let foundSkeleton = false;
    for (const msg of result) {
      for (const block of msg.content) {
        if (
          block.type === "tool_result" &&
          block.content.startsWith("[tool=")
        ) {
          expect(block.content).toMatch(/^\[tool=\w+ bytes=\d+, recallable\]$/);
          foundSkeleton = true;
        }
      }
    }
    expect(foundSkeleton).toBe(true);
  });

  it("preserves tool_use blocks in assistant messages", () => {
    const messages = makeToolConversation(35, 5000);
    const { messages: result } = applyTierCompression(messages, THRESHOLDS);

    // All assistant messages should retain their tool_use blocks
    for (const msg of result) {
      if (msg.role !== "assistant") continue;
      const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
      expect(toolUseBlocks.length).toBeGreaterThan(0);
    }
  });

  it("is idempotent (no double truncation)", () => {
    const messages = makeToolConversation(15, 5000);
    const { messages: first, stats: stats1 } = applyTierCompression(
      messages,
      THRESHOLDS,
    );
    const { messages: second, stats: stats2 } = applyTierCompression(
      first,
      THRESHOLDS,
    );

    expect(stats2.charsSaved).toBe(0);
    expect(second).toBe(first);
  });

  it("handles messages without tool_results", () => {
    const messages = [
      userMessage("你好"),
      assistantMessage("你好！"),
      userMessage("再见"),
    ];

    const { messages: result, stats } = applyTierCompression(
      messages,
      THRESHOLDS,
    );

    expect(result).toBe(messages);
    expect(stats.charsSaved).toBe(0);
  });

  it("handles short tool_results that don't need trimming", () => {
    const messages = makeToolConversation(10, 100);
    const { messages: result, stats } = applyTierCompression(
      messages,
      THRESHOLDS,
    );

    expect(stats.charsSaved).toBe(0);
    expect(result).toBe(messages);
  });

  it("includes tool name in Tier 4 skeleton", () => {
    const toolId = "t1";
    const messages: Message[] = [
      userMessage("开始"),
      // 35 turns of filler to push turn 1 to Tier 4
      ...Array.from({ length: 34 }, (_, i) => [
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "filler" },
            {
              type: "tool_use" as const,
              id: `filler_${i}`,
              name: "glob",
              input: {},
            },
          ],
        },
        toolResultMessage([
          {
            type: "tool_result",
            toolUseId: `filler_${i}`,
            content: "ok",
          },
        ]),
      ]).flat(),
    ];

    // Insert the target turn at position 1-2 (oldest non-first)
    messages.splice(
      1,
      0,
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: toolId, name: "read", input: {} },
        ],
      },
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: toolId,
          content: "x".repeat(5000),
        },
      ]),
    );

    const { messages: result } = applyTierCompression(messages, THRESHOLDS);

    // Find the skeleton for our target tool
    const targetResult = result[2]!;
    const toolBlock = targetResult.content.find(
      (b) => b.type === "tool_result",
    );
    expect(toolBlock).toBeDefined();
    expect((toolBlock as { content: string }).content).toContain("tool=read");
  });
});
