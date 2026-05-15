import { describe, expect, it } from "vitest";
import { emptyUsage, mergeUsage, getTotalInputTokens } from "./llm.js";
import type { StreamEvent, TokenUsage } from "./llm.js";

describe("TokenUsage 辅助函数", () => {
  describe("emptyUsage", () => {
    it("应创建全零的 TokenUsage", () => {
      const usage = emptyUsage();

      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
      expect(usage.cacheReadTokens).toBeUndefined();
      expect(usage.cacheWriteTokens).toBeUndefined();
    });
  });

  describe("mergeUsage", () => {
    it("应累加基本 token 数", () => {
      const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
      const b: TokenUsage = { inputTokens: 200, outputTokens: 80 };

      const merged = mergeUsage(a, b);

      expect(merged.inputTokens).toBe(300);
      expect(merged.outputTokens).toBe(130);
    });

    it("双方都没有缓存字段时结果也不应包含缓存字段", () => {
      const a: TokenUsage = { inputTokens: 10, outputTokens: 5 };
      const b: TokenUsage = { inputTokens: 20, outputTokens: 10 };

      const merged = mergeUsage(a, b);

      expect(merged.cacheReadTokens).toBeUndefined();
      expect(merged.cacheWriteTokens).toBeUndefined();
    });

    it("任一方有缓存字段时应正确累加", () => {
      const a: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 80,
      };
      const b: TokenUsage = {
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 150,
        cacheWriteTokens: 30,
      };

      const merged = mergeUsage(a, b);

      expect(merged.cacheReadTokens).toBe(230);
      expect(merged.cacheWriteTokens).toBe(30);
    });

    it("只有一方有缓存字段时应正确处理", () => {
      const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
      const b: TokenUsage = {
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 150,
      };

      const merged = mergeUsage(a, b);

      expect(merged.cacheReadTokens).toBe(150);
      expect(merged.cacheWriteTokens).toBeUndefined();
    });

    it("totalInputTokens 按 canonical 口径累加，inputTokens 累加正交不变", () => {
      // a 走 fallback（无 totalInputTokens → 取 inputTokens=100）
      const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
      // b 显式归一（Anthropic 风格：inputTokens=200 但全量=900）
      const b: TokenUsage = {
        inputTokens: 200,
        totalInputTokens: 900,
        outputTokens: 80,
      };

      const merged = mergeUsage(a, b);

      // 既有读 inputTokens 的消费方逐字节不变
      expect(merged.inputTokens).toBe(300);
      // canonical 全量 = 100(fallback) + 900
      expect(merged.totalInputTokens).toBe(1000);
      expect(getTotalInputTokens(merged)).toBe(1000);
    });
  });

  describe("getTotalInputTokens", () => {
    it("未设 totalInputTokens 时 fallback 回 inputTokens（OpenAI 兼容族 / emptyUsage）", () => {
      expect(getTotalInputTokens({ inputTokens: 8000, outputTokens: 200 })).toBe(
        8000,
      );
      expect(getTotalInputTokens(emptyUsage())).toBe(0);
    });

    it("设了 totalInputTokens 时取规范全量（Anthropic 含 cache）", () => {
      const u: TokenUsage = {
        inputTokens: 300,
        totalInputTokens: 49_500,
        outputTokens: 50,
        cacheReadTokens: 48_000,
        cacheWriteTokens: 1_200,
      };
      expect(getTotalInputTokens(u)).toBe(49_500);
      // 不变量：total ≥ input，且 ≥ cacheRead+cacheWrite
      expect(getTotalInputTokens(u)).toBeGreaterThanOrEqual(u.inputTokens);
      expect(getTotalInputTokens(u)).toBeGreaterThanOrEqual(
        (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      );
    });
  });
});

describe("StreamEvent 类型判别", () => {
  it("switch 语句应能穷尽匹配所有 StreamEvent 类型", () => {
    const events: StreamEvent[] = [
      { type: "message_start" },
      { type: "text_delta", text: "hello" },
      { type: "thinking_delta", thinking: "hmm" },
      { type: "tool_call_start", id: "1", name: "bash" },
      { type: "tool_call_delta", id: "1", argsFragment: '{"cmd":' },
      { type: "tool_call_end", id: "1" },
      {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { type: "error", error: new Error("test") },
    ];

    const types: string[] = [];
    for (const event of events) {
      switch (event.type) {
        case "message_start":
          types.push("message_start");
          break;
        case "text_delta":
          types.push("text_delta");
          break;
        case "thinking_delta":
          types.push("thinking_delta");
          break;
        case "tool_call_start":
          types.push("tool_call_start");
          break;
        case "tool_call_delta":
          types.push("tool_call_delta");
          break;
        case "tool_call_end":
          types.push("tool_call_end");
          break;
        case "message_end":
          types.push("message_end");
          break;
        case "error":
          types.push("error");
          break;
      }
    }

    expect(types).toEqual([
      "message_start",
      "text_delta",
      "thinking_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "message_end",
      "error",
    ]);
  });
});
