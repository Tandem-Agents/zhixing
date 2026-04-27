import { describe, expect, it } from "vitest";
import { assemblePartialMessage } from "../assemble.js";

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
