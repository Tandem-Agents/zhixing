import { describe, expect, it } from "vitest";
import { charWidth, clampLine, stringWidth } from "../line-width.js";

describe("charWidth", () => {
  it("ASCII letters are width 1", () => {
    expect(charWidth("a".codePointAt(0)!)).toBe(1);
    expect(charWidth("Z".codePointAt(0)!)).toBe(1);
    expect(charWidth("0".codePointAt(0)!)).toBe(1);
  });

  it("Control chars are width 0", () => {
    expect(charWidth(0x00)).toBe(0);
    expect(charWidth(0x07)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
    expect(charWidth(0x7f)).toBe(0);
  });

  it("CJK ideographs are width 2", () => {
    expect(charWidth("中".codePointAt(0)!)).toBe(2);
    expect(charWidth("日".codePointAt(0)!)).toBe(2);
    expect(charWidth("한".codePointAt(0)!)).toBe(2);
    expect(charWidth("あ".codePointAt(0)!)).toBe(2);
  });

  it("Fullwidth ASCII forms are width 2", () => {
    expect(charWidth("！".codePointAt(0)!)).toBe(2);
    expect(charWidth("Ａ".codePointAt(0)!)).toBe(2);
  });

  it("Misc Symbols / Dingbats 默认按 East Asian Width Neutral = 1 列", () => {
    // 这些符号的 Unicode East Asian Width 是 Neutral——多数终端按文本呈现（1 列）；
    // 我们的代码场景都是文本呈现（无 VS16 选择子），按 1 列计算与实际渲染对齐
    expect(charWidth("⚠".codePointAt(0)!)).toBe(1); // U+26A0 Warning sign
    expect(charWidth("✓".codePointAt(0)!)).toBe(1); // U+2713 Check mark
    expect(charWidth("✦".codePointAt(0)!)).toBe(1); // U+2726 品牌锚（占位）
  });

  it("现代 emoji 块（0x1F300+）保持 2 列", () => {
    expect(charWidth("😀".codePointAt(0)!)).toBe(2); // U+1F600
    expect(charWidth("🌟".codePointAt(0)!)).toBe(2); // U+1F31F
  });
});

describe("stringWidth", () => {
  it("sums widths across ASCII", () => {
    expect(stringWidth("hello")).toBe(5);
  });

  it("handles CJK correctly", () => {
    expect(stringWidth("中文")).toBe(4);
    expect(stringWidth("a中b")).toBe(4);
  });

  it("ignores ANSI escape sequences", () => {
    expect(stringWidth("\x1b[31mhello\x1b[0m")).toBe(5);
    expect(stringWidth("\x1b[33m中文\x1b[0m")).toBe(4);
  });

  it("ignores OSC 8 hyperlink sequences——只算可见 text 部分", () => {
    const link = "\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\";
    expect(stringWidth(link)).toBe(5); // "click"
  });

  it("handles empty string", () => {
    expect(stringWidth("")).toBe(0);
  });

  it("handles surrogate pairs correctly", () => {
    // 😀 is U+1F600 (in emoji range → width 2)
    expect(stringWidth("😀")).toBe(2);
  });
});

describe("clampLine", () => {
  it("returns original if already within budget", () => {
    expect(clampLine("hello", 10)).toBe("hello");
  });

  it("truncates ASCII with ellipsis", () => {
    const result = clampLine("hello world", 8);
    expect(result.startsWith("hello w")).toBe(true);
    expect(result).toContain("…");
  });

  it("clamps CJK at codepoint boundary", () => {
    // 中文字符串 each 2 wide; budget 5 → can fit 2 chars (4 wide) + ellipsis (1 wide) = 5
    const result = clampLine("中文你好世界", 5);
    expect(result).toMatch(/^中文…/);
  });

  it("preserves ANSI sequences while truncating", () => {
    // budget is 5 → visible "hell" + "…" fits
    const result = clampLine("\x1b[31mhello world\x1b[0m", 5);
    expect(result).toContain("\x1b[31m"); // color preserved
    expect(result).toMatch(/hell…/);
    expect(result).toContain("\x1b[0m"); // reset preserved
  });

  it("preserves OSC 8 hyperlink sequences while truncating", () => {
    // 内容 "click here" 共 10 visible，预算 6 → 取 "click" 5 + "…" 1 = 6
    const link = `\x1b]8;;https://x.com\x1b\\click here\x1b]8;;\x1b\\`;
    const result = clampLine(link, 6);
    // OSC 序列原样保留，可见宽度不超
    expect(stringWidth(result)).toBeLessThanOrEqual(6);
    expect(result).toContain("\x1b]8;;https://x.com\x1b\\");
  });

  it("returns empty string on 0 budget", () => {
    expect(clampLine("anything", 0)).toBe("");
  });

  it("never wraps lines visually (stringWidth of output ≤ budget)", () => {
    // "hello world 中文你好" — budget 10 → must not exceed 10 display columns
    const result = clampLine("hello world 中文你好", 10);
    expect(stringWidth(result)).toBeLessThanOrEqual(10);
  });

  it("handles surrogate-pair truncation safely", () => {
    const input = "ab😀cd😀ef";
    const result = clampLine(input, 4);
    // Must not break a surrogate pair mid-codepoint
    expect(result).not.toContain("\uD83D"); // lone high surrogate
    expect(result).not.toContain("\uDE00"); // lone low surrogate
  });
});
