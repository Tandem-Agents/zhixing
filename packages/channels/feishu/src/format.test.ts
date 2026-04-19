import { describe, expect, it } from "vitest";
import { toFeishuMarkdown } from "./format.js";

describe("toFeishuMarkdown", () => {
  it("passes plain text through unchanged", () => {
    expect(toFeishuMarkdown("hello world")).toBe("hello world");
  });

  it("converts a markdown table to a bulleted list", () => {
    const input = [
      "| Name | Age |",
      "| --- | --- |",
      "| Alice | 30 |",
      "| Bob | 25 |",
    ].join("\n");

    const expected = [
      "- **Name**: Alice | **Age**: 30",
      "- **Name**: Bob | **Age**: 25",
    ].join("\n");

    expect(toFeishuMarkdown(input)).toBe(expected);
  });

  it("truncates text exceeding maxLength", () => {
    const long = "x".repeat(100);
    const result = toFeishuMarkdown(long, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not truncate text within limit", () => {
    const text = "short message";
    expect(toFeishuMarkdown(text, 100)).toBe(text);
  });

  it("preserves code blocks", () => {
    const input = "```js\nconsole.log('hi');\n```";
    expect(toFeishuMarkdown(input)).toBe(input);
  });

  it("handles mixed content with table", () => {
    const input = [
      "Here is a table:",
      "",
      "| Key | Value |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "End.",
    ].join("\n");

    const result = toFeishuMarkdown(input);
    expect(result).toContain("**Key**: a");
    expect(result).toContain("End.");
  });

  it("does not convert tables inside fenced code blocks", () => {
    const input = [
      "```",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "```",
    ].join("\n");

    expect(toFeishuMarkdown(input)).toBe(input);
  });

  it("does not split a surrogate pair when truncating", () => {
    const emoji = "\ud83e\udd14"; // 🤔 — 2 UTF-16 code units
    const text = "a".repeat(46) + emoji + "bbbbb"; // 53 chars, limit=50, cut at 47 hits surrogate
    const result = toFeishuMarkdown(text, 50);
    expect(result.endsWith("...")).toBe(true);
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(result.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(result.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
  });
});
