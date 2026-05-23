import { describe, expect, it } from "vitest";
import { toToolResult } from "../result.js";

describe("toToolResult", () => {
  it("拼接单个 text 块", () => {
    expect(toToolResult({ content: [{ type: "text", text: "hello" }] })).toEqual({
      content: "hello",
      isError: false,
    });
  });

  it("多个 text 块以换行拼接", () => {
    expect(
      toToolResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }).content,
    ).toBe("a\nb");
  });

  it("透传 isError", () => {
    expect(
      toToolResult({ content: [{ type: "text", text: "boom" }], isError: true })
        .isError,
    ).toBe(true);
  });

  it("非文本块降级为占位标记", () => {
    const r = toToolResult({
      content: [{ type: "image" }, { type: "text", text: "caption" }],
    });
    expect(r.content).toBe("[image content omitted]\ncaption");
  });

  it("空 content 数组 → 空串", () => {
    expect(toToolResult({ content: [] }).content).toBe("");
  });

  it("无标准 content 时序列化 toolResult 兜底", () => {
    expect(toToolResult({ toolResult: { ok: 1 } }).content).toBe('{"ok":1}');
  });

  it("既无 content 也无 toolResult → 空串", () => {
    expect(toToolResult({}).content).toBe("");
  });
});
