import { describe, expect, it } from "vitest";
import { charWidth, clampLine, stringWidth, wrapToWidth } from "../line-width.js";

const ATOM = /\[ATOM\]/g; // 6 chars 模拟不可切碎的原子单元

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

  it("Unicode 格式控制字符 (\\p{Cf}) are width 0—— BOM / 零宽 / bidi / soft hyphen 等不可见字符", () => {
    expect(charWidth(0x00ad)).toBe(0); // soft hyphen
    expect(charWidth(0x200b)).toBe(0); // zero-width space
    expect(charWidth(0x200c)).toBe(0); // zero-width non-joiner
    expect(charWidth(0x200d)).toBe(0); // zero-width joiner
    expect(charWidth(0x200e)).toBe(0); // LRM (left-to-right mark)
    expect(charWidth(0x200f)).toBe(0); // RLM (right-to-left mark)
    expect(charWidth(0x202a)).toBe(0); // LRE
    expect(charWidth(0x202c)).toBe(0); // PDF
    expect(charWidth(0x202e)).toBe(0); // RLO
    expect(charWidth(0x2060)).toBe(0); // word joiner
    expect(charWidth(0xfeff)).toBe(0); // BOM
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

describe("wrapToWidth — 默认模式（不传 atomicRegions，向后兼容）", () => {
  it("空字符串返回 [\"\"]", () => {
    expect(wrapToWidth("", 10)).toEqual([""]);
  });

  it("不超宽的单行原样返回", () => {
    expect(wrapToWidth("hello", 10)).toEqual(["hello"]);
  });

  it("超宽按字符级 wrap", () => {
    expect(wrapToWidth("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("CJK 按 2 列计算", () => {
    expect(wrapToWidth("中文换行", 4)).toEqual(["中文", "换行"]);
  });

  it("含 \\n 时旧行为：当 0 宽控制符不换行（向后兼容）", () => {
    // 旧行为：\n charWidth=0，与其他 0 宽字符一同累积进 current
    const lines = wrapToWidth("abc\ndef", 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("abc\ndef");
  });
});

describe("wrapToWidth — 启用 atomicRegions（atomic + \\n 硬换行）", () => {
  it("atomic 整体放不下当前行时整体换行", () => {
    expect(wrapToWidth("abcd[ATOM]", 8, ATOM)).toEqual(["abcd", "[ATOM]"]);
  });

  it("atomic 完整放当前行时不换行", () => {
    expect(wrapToWidth("ab[ATOM]", 8, ATOM)).toEqual(["ab[ATOM]"]);
  });

  it("\\n 硬换行：text 含 \\n 时按段独立 wrap", () => {
    expect(wrapToWidth("abc\ndef", 80, ATOM)).toEqual(["abc", "def"]);
  });

  it("混合：\\n 段内含 atomic", () => {
    expect(wrapToWidth("a\n[ATOM]", 8, ATOM)).toEqual(["a", "[ATOM]"]);
  });

  it("段内 atomic 跨行边界整体换行", () => {
    // 段 = "abc[ATOM]def"，atomic 6 chars，lineWidth=8
    // 'a','b','c'(3) + atomic 6 = 9 > 8 → atomic 整体换行
    // 行 1 起：atomic 6 + "de" 2 = 8 刚满；"f" 软 wrap 到行 2
    expect(wrapToWidth("abc[ATOM]def", 8, ATOM)).toEqual(["abc", "[ATOM]de", "f"]);
  });

  it("末尾 \\n 产生空段（末段 [\"\"]）", () => {
    expect(wrapToWidth("a\n", 80, ATOM)).toEqual(["a", ""]);
  });

  it("不带 g flag 的 regex 也能工作（内部强制 g）", () => {
    const noG = /\[ATOM\]/;
    expect(wrapToWidth("[ATOM][ATOM]", 8, noG)).toEqual(["[ATOM]", "[ATOM]"]);
  });

  it("多个 atomic 区域分别整体处理", () => {
    expect(wrapToWidth("[ATOM][ATOM]", 8, ATOM)).toEqual(["[ATOM]", "[ATOM]"]);
  });
});
