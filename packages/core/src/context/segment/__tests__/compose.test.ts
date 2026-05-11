/**
 * composeNewSegmentMessages 纯函数测试。
 *
 * 覆盖：summary 三段渲染 / recent-turns 各 block 类型叙述化 / 空兜底 /
 * 多 turn 拼接 / tool_use 入参 JSON 化 / 输出形态稳定。
 */

import { describe, it, expect } from "vitest";
import type { Message } from "../../../types/messages.js";
import { composeNewSegmentMessages } from "../compose.js";
import type { ParsedSummary } from "../types.js";

const baseSummary: ParsedSummary = {
  facts: "facts content",
  state: "state content",
  active: "active content",
};

function extractText(m: Message): string {
  const block = m.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return block.text;
}

describe("composeNewSegmentMessages", () => {
  it("输出单条 user message + 单个 text block", () => {
    const result = composeNewSegmentMessages({
      summary: baseSummary,
      recentTurns: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toHaveLength(1);
    expect(result[0]!.content[0]!.type).toBe("text");
  });

  it("渲染 <previous-segment-summary> 三段 XML", () => {
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns: [] })[0]!,
    );
    expect(text).toContain("<previous-segment-summary>");
    expect(text).toContain("<facts>facts content</facts>");
    expect(text).toContain("<state>state content</state>");
    expect(text).toContain("<active>active content</active>");
    expect(text).toContain("</previous-segment-summary>");
  });

  it("空 summary 三段渲染为空标签（不省略）", () => {
    const text = extractText(
      composeNewSegmentMessages({
        summary: { facts: "", state: "", active: "" },
        recentTurns: [],
      })[0]!,
    );
    expect(text).toContain("<facts></facts>");
    expect(text).toContain("<state></state>");
    expect(text).toContain("<active></active>");
  });

  it("空 recent-turns 渲染为空标签", () => {
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns: [] })[0]!,
    );
    expect(text).toContain("<recent-turns></recent-turns>");
  });

  it("user/assistant text block 叙述化", () => {
    const recentTurns: Message[] = [
      { role: "user", content: [{ type: "text", text: "用户问 A" }] },
      { role: "assistant", content: [{ type: "text", text: "助手答 B" }] },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    expect(text).toContain("[user] 用户问 A");
    expect(text).toContain("[assistant] 助手答 B");
  });

  it("tool_use block 输出工具名 + 入参 JSON", () => {
    const recentTurns: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "调用工具" },
          { type: "tool_use", id: "u1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    expect(text).toContain("[assistant]");
    expect(text).toContain("调用工具");
    expect(text).toContain(`[tool_use read_file({"path":"a.ts"})]`);
  });

  it("tool_result block 输出 toolUseId + 内容；isError 标记", () => {
    const recentTurns: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "u1", content: "ok" }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "u2", content: "boom", isError: true },
        ],
      },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    expect(text).toContain("[tool_result u1] ok");
    expect(text).toContain("[tool_result u2 error] boom");
  });

  it("thinking block 叙述化", () => {
    const recentTurns: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "让我想想" },
          { type: "text", text: "回复" },
        ],
      },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    expect(text).toContain("[thinking] 让我想想");
    expect(text).toContain("回复");
  });

  it("image url 叙述化 / base64 不内联", () => {
    const recentTurns: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/a.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "AAA" },
          },
        ],
      },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    expect(text).toContain("[image https://example.com/a.png]");
    expect(text).toContain("[image <base64-elided>]");
    expect(text).not.toContain("AAA");
  });

  it("多条 messages 按输入顺序拼接", () => {
    const recentTurns: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q1" }] },
      { role: "assistant", content: [{ type: "text", text: "A1" }] },
      { role: "user", content: [{ type: "text", text: "Q2" }] },
      { role: "assistant", content: [{ type: "text", text: "A2" }] },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    const q1Idx = text.indexOf("Q1");
    const a1Idx = text.indexOf("A1");
    const q2Idx = text.indexOf("Q2");
    const a2Idx = text.indexOf("A2");
    expect(q1Idx).toBeGreaterThan(0);
    expect(a1Idx).toBeGreaterThan(q1Idx);
    expect(q2Idx).toBeGreaterThan(a1Idx);
    expect(a2Idx).toBeGreaterThan(q2Idx);
  });

  it("summary 和 recent-turns 在最终文本中按固定顺序", () => {
    const recentTurns: Message[] = [
      { role: "user", content: [{ type: "text", text: "near user" }] },
    ];
    const text = extractText(
      composeNewSegmentMessages({ summary: baseSummary, recentTurns })[0]!,
    );
    const summaryIdx = text.indexOf("<previous-segment-summary>");
    const recentTurnsIdx = text.indexOf("<recent-turns>");
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(recentTurnsIdx).toBeGreaterThan(summaryIdx);
  });
});
