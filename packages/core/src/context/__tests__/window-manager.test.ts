import { describe, expect, it } from "vitest";
import {
  MIN_RETAIN_TURNS,
  defaultIsPinned,
  manageWindow,
} from "../window-manager.js";
import type { WindowConfig } from "../window-manager.js";
import { createTokenEstimator } from "../token-estimator.js";
import type { Message } from "../../types/messages.js";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
} from "../../types/messages.js";
import type { TierThresholds } from "../context-profile.js";
import { detectSystemMetaKind } from "../system-meta.js";

// ─── 测试辅助 ───

const THRESHOLDS: TierThresholds = { T1: 2, T2: 8, T3: 30 };

function makeConversation(turns: number, resultSize = 2000): Message[] {
  const messages: Message[] = [userMessage("开始分析项目")];

  for (let i = 0; i < turns; i++) {
    const toolId = `t${i}`;
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `分析步骤 ${i}` },
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
          content: "x".repeat(resultSize),
        },
      ]),
    );
  }

  return messages;
}

function makeConfig(
  overrides: Partial<WindowConfig> = {},
): WindowConfig {
  return {
    tierThresholds: THRESHOLDS,
    estimator: createTokenEstimator(),
    effectiveWindow: 32_000,
    compactRatio: 0.8,
    isPinned: defaultIsPinned,
    ...overrides,
  };
}

// ─── defaultIsPinned ───

describe("defaultIsPinned", () => {
  it("pins index 0 (first user message)", () => {
    expect(defaultIsPinned(0)).toBe(true);
  });

  it("does not pin other indices", () => {
    expect(defaultIsPinned(1)).toBe(false);
    expect(defaultIsPinned(5)).toBe(false);
    expect(defaultIsPinned(100)).toBe(false);
  });
});

// ─── manageWindow: Tier compression ───

describe("manageWindow tier compression", () => {
  it("applies tier compression to old tool_results", () => {
    const messages = makeConversation(15, 3000);
    const config = makeConfig({ effectiveWindow: 200_000 });

    const result = manageWindow(messages, config);

    expect(result.tierStats).not.toBeNull();
    expect(result.tierStats!.charsSaved).toBeGreaterThan(0);
    expect(result.modified).toBe(true);
  });

  it("skips tier compression when tierThresholds is null", () => {
    const messages = makeConversation(15, 3000);
    const config = makeConfig({
      tierThresholds: null,
      effectiveWindow: 200_000,
    });

    const result = manageWindow(messages, config);

    expect(result.tierStats).toBeNull();
    expect(result.evictedTurnCount).toBe(0);
  });

  it("does not modify messages within Tier 1 range", () => {
    const messages = makeConversation(2, 3000);
    const config = makeConfig({ effectiveWindow: 200_000 });

    const result = manageWindow(messages, config);

    expect(result.tierStats!.charsSaved).toBe(0);
    expect(result.modified).toBe(false);
  });
});

// ─── manageWindow: Turn eviction ───

describe("manageWindow turn eviction", () => {
  it("evicts oldest turns when over compact threshold", () => {
    const messages = makeConversation(20, 2000);
    const config = makeConfig({
      effectiveWindow: 8_000,
      compactRatio: 0.5,
    });

    const result = manageWindow(messages, config);

    expect(result.evictedTurnCount).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.modified).toBe(true);
  });

  it("preserves pinned first user message during eviction", () => {
    const messages = makeConversation(20, 2000);
    const config = makeConfig({
      effectiveWindow: 8_000,
      compactRatio: 0.5,
    });

    const result = manageWindow(messages, config);

    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.content[0]).toHaveProperty("type", "text");
    const firstText = (result.messages[0]!.content[0] as { text: string }).text;
    expect(firstText).toBe("开始分析项目");
  });

  it("inserts placeholder at eviction point", () => {
    const messages = makeConversation(20, 2000);
    const config = makeConfig({
      effectiveWindow: 8_000,
      compactRatio: 0.5,
    });

    const result = manageWindow(messages, config);

    // 占位符统一走 system-meta dropped-turns 格式（结构化断言，不依赖文案）
    const placeholders = result.messages.filter(
      (m) => detectSystemMetaKind(m) === "dropped-turns",
    );
    expect(placeholders.length).toBe(1);
  });

  it("does not evict when under compact threshold", () => {
    const messages = makeConversation(3, 100);
    const config = makeConfig({ effectiveWindow: 200_000 });

    const result = manageWindow(messages, config);

    expect(result.evictedTurnCount).toBe(0);
  });

  it("respects custom isPinned predicate", () => {
    const messages = makeConversation(20, 2000);
    // Pin indices 0 and 1 (first user message + first assistant message)
    const customPin = (idx: number) => idx === 0 || idx === 1;

    const config = makeConfig({
      effectiveWindow: 8_000,
      compactRatio: 0.5,
      isPinned: customPin,
    });

    const result = manageWindow(messages, config);

    // The pinned assistant message (index 1, "分析步骤 0") should still be present
    const hasOriginalAssistant = result.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (b) =>
            b.type === "text" &&
            (b as { text: string }).text === "分析步骤 0",
        ),
    );
    expect(hasOriginalAssistant).toBe(true);
  });

  it("retains at least MIN_RETAIN_TURNS recent turns", () => {
    const messages = makeConversation(20, 2000);
    const config = makeConfig({
      effectiveWindow: 1_000,
      compactRatio: 0.1,
    });

    const result = manageWindow(messages, config);

    // Count remaining assistant messages (turns)
    const remainingTurns = result.messages.filter(
      (m) => m.role === "assistant",
    ).length;
    expect(remainingTurns).toBeGreaterThanOrEqual(MIN_RETAIN_TURNS);
  });
});

// ─── manageWindow: Full cascade ───

describe("manageWindow cascade", () => {
  it("applies both tier compression and eviction when needed", () => {
    const messages = makeConversation(20, 3000);
    const config = makeConfig({
      effectiveWindow: 10_000,
      compactRatio: 0.5,
    });

    const result = manageWindow(messages, config);

    expect(result.tierStats!.charsSaved).toBeGreaterThan(0);
    expect(result.evictedTurnCount).toBeGreaterThan(0);
    expect(result.modified).toBe(true);
  });

  it("returns unmodified messages for short conversations", () => {
    const messages = [
      userMessage("你好"),
      assistantMessage("你好！有什么可以帮你的？"),
    ];
    const config = makeConfig({ effectiveWindow: 200_000 });

    const result = manageWindow(messages, config);

    expect(result.modified).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.evictedTurnCount).toBe(0);
  });
});
