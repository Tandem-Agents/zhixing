import { describe, expect, it } from "vitest";
import {
  charWidth,
  clampLine,
  padEndDisplay,
  stringWidth,
  wrapAnsiLine,
  wrapToWidth,
} from "../line-width.js";

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

describe("padEndDisplay", () => {
  it("纯 ASCII 等价 String.padEnd", () => {
    expect(padEndDisplay("abc", 6)).toBe("abc   ");
    expect(padEndDisplay("hello", 10)).toBe("hello     ");
  });

  it("含 ANSI 色彩转义：按可见宽度算补齐，保留 ANSI 序列不动", () => {
    // \x1b[36m...\x1b[39m 是 chalk.cyan 等效——可见 3 字符，应补 3 空格到宽度 6
    const colored = "\x1b[36mabc\x1b[39m";
    const result = padEndDisplay(colored, 6);
    // 可见 = abc (3) + 3 空格 → 总显示宽度 6
    expect(result.endsWith("   ")).toBe(true);
    expect(result).toContain(colored);
    // 原生 String.padEnd 会因 ANSI 算 char count（10+）→ 完全不补
    expect(colored.padEnd(6)).toBe(colored);
  });

  it("CJK 全角：中文每字 2 列，按显示宽度算", () => {
    // "主模式" 显示宽度 = 6 → padEndDisplay(_, 10) 应补 4 空格
    expect(padEndDisplay("主模式", 10)).toBe("主模式    ");
    // "当前工作场景" 显示宽度 = 12 → 已超 10，不补
    expect(padEndDisplay("当前工作场景", 10)).toBe("当前工作场景");
  });

  it("ANSI + CJK 混合：cli /trust 列表场景", () => {
    // 模拟 chalk.cyan("主模式") + padEnd 到 20 列
    const styled = "\x1b[36m主模式\x1b[39m";
    const result = padEndDisplay(styled, 20);
    // 可见 = "主模式" = 6 cells → 补 14 空格
    expect(result).toBe(styled + " ".repeat(14));
  });

  it("已达或超目标宽度不补、不截断", () => {
    expect(padEndDisplay("abc", 3)).toBe("abc");
    expect(padEndDisplay("abc", 2)).toBe("abc");
    expect(padEndDisplay("abcdef", 3)).toBe("abcdef");
  });

  it("空字符串：补齐到目标宽度", () => {
    expect(padEndDisplay("", 4)).toBe("    ");
    expect(padEndDisplay("", 0)).toBe("");
  });

  it("emoji（2 列宽）：按显示宽度算", () => {
    expect(padEndDisplay("😀", 6)).toBe("😀    ");
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

describe("wrapAnsiLine — ANSI-aware 软折行", () => {
  it("空字符串原样返回，状态保留", () => {
    const r = wrapAnsiLine("", 10);
    expect(r.output).toBe("");
    expect(r.endColumnWidth).toBe(0);
    expect(r.endActiveSgr).toBe("");
  });

  it("maxVisibleWidth ≤ 0 返回原文不折行", () => {
    const r = wrapAnsiLine("hello", 0);
    expect(r.output).toBe("hello");
  });

  it("不超宽的单行原样返回", () => {
    const r = wrapAnsiLine("hello", 10);
    expect(r.output).toBe("hello");
    expect(r.endColumnWidth).toBe(5);
  });

  it("超宽按 code point 软折行", () => {
    const r = wrapAnsiLine("abcdefgh", 3);
    expect(r.output).toBe("abc\ndef\ngh");
    expect(r.endColumnWidth).toBe(2);
  });

  it("续行加 continuationPrefix（其内宽度不计入 maxVisibleWidth）", () => {
    const r = wrapAnsiLine("abcdefgh", 3, { continuationPrefix: "  " });
    // 续行起首 \n + "  "；宽度计数从 0 重新累计——续行可填满 3 字符
    expect(r.output).toBe("abc\n  def\n  gh");
  });

  it("CJK 全角字符按 2 列计宽", () => {
    const r = wrapAnsiLine("中文你好", 2);
    expect(r.output).toBe("中\n文\n你\n好");
    expect(r.endColumnWidth).toBe(2);
  });

  it("CJK 与 ASCII 混排在 wrap 边界", () => {
    // budget = 4：a(1)+b(1)+中(2)=4 刚好；下一字 文(2) 触发 wrap
    const r = wrapAnsiLine("ab中文", 4);
    expect(r.output).toBe("ab中\n文");
  });

  it("ANSI CSI 序列原样透传，宽度 0 不参与折行", () => {
    // \x1b[31m 是 5 字节 SGR 但显示宽度 0
    const r = wrapAnsiLine("\x1b[31mhello\x1b[0m", 10);
    expect(r.output).toBe("\x1b[31mhello\x1b[0m");
    expect(r.endColumnWidth).toBe(5);
  });

  it("OSC 8 超链接原样透传不切碎", () => {
    const link = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\";
    const r = wrapAnsiLine(link, 10);
    expect(r.output).toBe(link);
    // 可见宽度 = "link" = 4
    expect(r.endColumnWidth).toBe(4);
  });

  it("跨 wrap 边界保 SGR 自平衡：续行起首 reset + re-emit active SGR", () => {
    // \x1b[31m red 起手 → 'a','b' 写完后 wrap → 续行 emit reset + \n + active(\x1b[31m)
    const r = wrapAnsiLine("\x1b[31mabcd", 2);
    expect(r.output).toBe("\x1b[31mab\x1b[0m\n\x1b[31mcd");
    expect(r.endActiveSgr).toBe("\x1b[31m");
  });

  it("续行 prefix 不被 active SGR 染色（reset 在 prefix 之前）", () => {
    const r = wrapAnsiLine("\x1b[41mhello world", 5, {
      continuationPrefix: "  ",
    });
    // 'hello'(5) 占满 budget=5；' '触发 wrap 1
    // 续行 ' worl'(5) 占满；'d' 触发 wrap 2 → 共 3 行
    // wrap 序列 = SGR_RESET \n "  " activeSgr = "\x1b[0m\n  \x1b[41m"
    expect(r.output).toBe(
      "\x1b[41mhello\x1b[0m\n  \x1b[41m worl\x1b[0m\n  \x1b[41md",
    );
  });

  it("active SGR 空时不 emit 多余 reset", () => {
    const r = wrapAnsiLine("abcdef", 3);
    // 无 SGR 时 wrap 序列 = "\n"，无 \x1b[0m
    expect(r.output).toBe("abc\ndef");
    expect(r.output).not.toContain("\x1b[0m");
  });

  it("SGR full reset (\\x1b[0m) 清空 active 累积", () => {
    // 起手 red → 'a' → reset → 'b','c'(超 budget,但 active 已空)
    const r = wrapAnsiLine("\x1b[31ma\x1b[0mbc", 1);
    // \x1b[31m a \x1b[0m wrap(无 SGR re-emit)\n b wrap\n c
    expect(r.output).toBe("\x1b[31ma\x1b[0m\nb\nc");
    expect(r.endActiveSgr).toBe("");
  });

  it("非 reset 的 SGR (如 \\x1b[39m 仅关 fg) 累积到 active 不清空", () => {
    // \x1b[31m 起手、\x1b[39m 关 fg — active 仍含两段 SGR（不区分语义，简单累加）
    const r = wrapAnsiLine("\x1b[31ma\x1b[39mbcdef", 2);
    // 第二段 wrap 时 active = "\x1b[31m\x1b[39m"，emit reset + 续行 + active
    expect(r.endActiveSgr).toBe("\x1b[31m\x1b[39m");
  });

  it("startColumnWidth > 0 模拟续接已写部分内容", () => {
    // 起手 columnWidth=8、budget=10——只能再容 2 字符就 wrap
    const r = wrapAnsiLine("abcd", 10, { startColumnWidth: 8 });
    // 'a' col 9, 'b' col 10, 'c' wrap → "ab\ncd"
    expect(r.output).toBe("ab\ncd");
    expect(r.endColumnWidth).toBe(2);
  });

  it("startActiveSgr 影响 wrap 时的 reset / re-emit 行为", () => {
    // 起手已 active red SGR（caller 之前 emit 过），text 内无新 SGR
    const r = wrapAnsiLine("abcd", 2, { startActiveSgr: "\x1b[31m" });
    // wrap 时 emit reset + \n + active red
    expect(r.output).toBe("ab\x1b[0m\n\x1b[31mcd");
    expect(r.endActiveSgr).toBe("\x1b[31m");
  });

  it("单字符宽度大于 budget 时整段 emit 不死循环", () => {
    // CJK 2 列、budget 1——单字超 budget
    const r = wrapAnsiLine("中文", 1);
    // 第 1 字符 '中'：lineHasVisibleContent=false, 不 wrap, emit '中', columnWidth=2
    // 第 2 字符 '文'：lineHasVisibleContent=true, 2+2>1 → wrap, emit \n, '文'
    expect(r.output).toBe("中\n文");
    // 不死循环（最关键）
    expect(r.output.length).toBeLessThan(20);
  });

  it("纯 ANSI 序列（无可见字符）不触发 wrap", () => {
    const r = wrapAnsiLine("\x1b[31m\x1b[1m\x1b[0m", 1);
    expect(r.output).toBe("\x1b[31m\x1b[1m\x1b[0m");
    expect(r.endColumnWidth).toBe(0);
  });

  it("ANSI 序列在 wrap 边界处不被切碎", () => {
    // 'a','b' 占满 budget=2；接 \x1b[31m（0 宽）原样透传，activeSgr 累积
    // 'c' 触发 wrap：emit reset + \n + active("\x1b[31m") → 续行 'cd' 同行
    // 注意：wrap 后 active 会被再次 emit 一遍，与 passthrough 时已 emit 的不去重——
    // 这是 cumulative SGR 简单语义（与 text-stream.ts 行为一致）
    const r = wrapAnsiLine("ab\x1b[31mcd", 2);
    expect(r.output).toBe("ab\x1b[31m\x1b[0m\n\x1b[31mcd");
  });

  it("代理对（surrogate pair）整段处理不切半", () => {
    // 😀 (U+1F600) emoji 2 列；budget 2 应整字 emit
    const r = wrapAnsiLine("😀😀", 2);
    expect(r.output).toBe("😀\n😀");
    // 两个完整 emoji（非 4 个 surrogate 半字符）
    expect([...r.output].length).toBe(3); // 2 emojis + 1 \n
  });

  it("startActiveSgr + 自身 SGR 累积叠加", () => {
    // 起手 active = red、text 内 emit bold → active = red+bold
    const r = wrapAnsiLine("\x1b[1mabcd", 2, { startActiveSgr: "\x1b[31m" });
    // wrap 时 emit reset + \n + (red+bold)
    expect(r.output).toBe("\x1b[1mab\x1b[0m\n\x1b[31m\x1b[1mcd");
    expect(r.endActiveSgr).toBe("\x1b[31m\x1b[1m");
  });

  it("连续多次 wrap 持续维护 active SGR", () => {
    const r = wrapAnsiLine("\x1b[31mabcdefghi", 2);
    expect(r.output).toBe(
      "\x1b[31mab\x1b[0m\n\x1b[31mcd\x1b[0m\n\x1b[31mef\x1b[0m\n\x1b[31mgh\x1b[0m\n\x1b[31mi",
    );
    expect(r.endActiveSgr).toBe("\x1b[31m");
  });
});
