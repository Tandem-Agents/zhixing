import { describe, expect, it } from "vitest";
import { assemblePartialMessage, assembleSafeMessage } from "../assemble.js";

describe("assemblePartialMessage", () => {
  it("text 与 thinking 都为空 → null(无内容可携带)", () => {
    expect(assemblePartialMessage("", "")).toBeNull();
  });

  it("仅 text → 唯一 text block,末尾追加 [interrupted]", () => {
    const m = assemblePartialMessage("hello world", "");
    expect(m).not.toBeNull();
    expect(m!.role).toBe("assistant");
    expect(m!.content).toEqual([
      { type: "text", text: "hello world\n\n[interrupted]" },
    ]);
  });

  it("仅 thinking(无 text)→ thinking + 独立 text block 含 [interrupted] 标记(标记必出)", () => {
    const m = assemblePartialMessage("", "I am pondering...");
    expect(m).not.toBeNull();
    expect(m!.content).toEqual([
      { type: "thinking", thinking: "I am pondering..." },
      { type: "text", text: "[interrupted]" },
    ]);
  });

  it("text + thinking 都有 → 顺序为 thinking, text(text 末尾追加标记)", () => {
    const m = assemblePartialMessage("answer text", "deep thought");
    expect(m).not.toBeNull();
    expect(m!.content).toEqual([
      { type: "thinking", thinking: "deep thought" },
      { type: "text", text: "answer text\n\n[interrupted]" },
    ]);
  });

  it("[interrupted] 标记位置是 text 末尾,不是中间(防 regex 误改)", () => {
    const m = assemblePartialMessage("已经写了一段话", "");
    expect(m!.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/\[interrupted\]$/),
    });
  });
});

describe("assembleSafeMessage (provider error 等非中断场景)", () => {
  it("text 与 thinking 都为空 → null(无内容可携带)", () => {
    expect(assembleSafeMessage("", "")).toBeNull();
  });

  it("仅 text → text block,不加 [interrupted] 标记(非用户中断,语义不同)", () => {
    const m = assembleSafeMessage("partial response", "");
    expect(m).not.toBeNull();
    expect(m!.content).toEqual([{ type: "text", text: "partial response" }]);
    // 不含 [interrupted] —— 这是 provider error 与 abort 的关键差异
    const textBlock = m!.content[0];
    if (textBlock?.type === "text") {
      expect(textBlock.text).not.toContain("[interrupted]");
    }
  });

  it("仅 thinking → thinking block,无独立 [interrupted] text block", () => {
    const m = assembleSafeMessage("", "thought process");
    expect(m).not.toBeNull();
    expect(m!.content).toEqual([{ type: "thinking", thinking: "thought process" }]);
    // 不会注入独立 text block 承载标记
    expect(m!.content.find((b) => b.type === "text")).toBeUndefined();
  });

  it("text + thinking 都有 → 顺序为 thinking, text;均不带标记", () => {
    const m = assembleSafeMessage("answer", "thought");
    expect(m).not.toBeNull();
    expect(m!.content).toEqual([
      { type: "thinking", thinking: "thought" },
      { type: "text", text: "answer" },
    ]);
  });

  it("永不返回含 tool_use blocks 的 message (类型层 + 实现层双保护协议合规)", () => {
    // assembleSafeMessage 不接 pendingToolCalls 参数,根本无法构造 tool_use blocks
    const m = assembleSafeMessage("text", "thinking");
    expect(m).not.toBeNull();
    const toolUseBlocks = m!.content.filter((b) => b.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(0);
  });
});
