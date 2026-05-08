import { describe, expect, it } from "vitest";
import { ANSI, osc8Hyperlink, splitAnsiLines, stripAnsi } from "../ansi.js";

describe("ANSI constants", () => {
  it("hideCursor / showCursor are the standard VT codes", () => {
    expect(ANSI.hideCursor).toBe("\x1b[?25l");
    expect(ANSI.showCursor).toBe("\x1b[?25h");
  });

  it("clearLine is \\x1b[2K", () => {
    expect(ANSI.clearLine).toBe("\x1b[2K");
  });

  it("moveUp(0) returns empty string (avoid \\x1b[0A ambiguity)", () => {
    expect(ANSI.moveUp(0)).toBe("");
  });

  it("moveUp(n>0) returns CSI n A", () => {
    expect(ANSI.moveUp(1)).toBe("\x1b[1A");
    expect(ANSI.moveUp(10)).toBe("\x1b[10A");
  });

  it("moveDown mirrors moveUp", () => {
    expect(ANSI.moveDown(0)).toBe("");
    expect(ANSI.moveDown(5)).toBe("\x1b[5B");
  });
});

describe("stripAnsi", () => {
  it("removes color sequences", () => {
    expect(stripAnsi("\x1b[33mhello\x1b[0m")).toBe("hello");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2K\x1b[3A\rabc")).toBe("\rabc");
  });

  it("preserves plain text untouched", () => {
    expect(stripAnsi("plain 中文 text")).toBe("plain 中文 text");
  });

  it("removes multiple sequences in one string", () => {
    expect(stripAnsi("\x1b[31ma\x1b[0m\x1b[32mb\x1b[0m")).toBe("ab");
  });

  it("removes OSC 8 hyperlink sequences (ST = ESC \\)", () => {
    const link = "\x1b]8;;https://x.com\x1b\\X\x1b]8;;\x1b\\";
    expect(stripAnsi(link)).toBe("X");
  });

  it("removes OSC sequences with BEL terminator", () => {
    const link = "\x1b]8;;https://x.com\x07X\x1b]8;;\x07";
    expect(stripAnsi(link)).toBe("X");
  });

  it("preserves plain text mixed with OSC + CSI", () => {
    const mix = `\x1b[1mbold\x1b[22m \x1b]8;;https://x.com\x1b\\link\x1b]8;;\x1b\\ tail`;
    expect(stripAnsi(mix)).toBe("bold link tail");
  });
});

describe("osc8Hyperlink", () => {
  it("wraps text in OSC 8 escape sequence", () => {
    const out = osc8Hyperlink("https://example.com", "click");
    expect(out).toBe("\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\");
  });

  it("缺省 text = URL 本身", () => {
    const out = osc8Hyperlink("https://example.com");
    expect(stripAnsi(out)).toBe("https://example.com");
  });
});

describe("splitAnsiLines", () => {
  it("空字符串返回 [\"\"]", () => {
    expect(splitAnsiLines("")).toEqual([""]);
  });

  it("纯文本按 \\n 切，无 ANSI 注入", () => {
    expect(splitAnsiLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("末尾 \\n 切出空末行", () => {
    expect(splitAnsiLines("a\n")).toEqual(["a", ""]);
  });

  it("起首 \\n 切出空首行", () => {
    expect(splitAnsiLines("\nb")).toEqual(["", "b"]);
  });

  it("行内 SGR 已平衡时保持不变", () => {
    const input = "\x1b[1mbold\x1b[22m\nplain";
    expect(splitAnsiLines(input)).toEqual(["\x1b[1mbold\x1b[22m", "plain"]);
  });

  it("跨行 SGR 在续行起首注入 active、上行末尾补 reset", () => {
    // chalk.dim("a\nb") 风格：\x1b[2m a \n b \x1b[22m
    const input = "\x1b[2ma\nb\x1b[22m";
    const lines = splitAnsiLines(input);
    expect(lines).toEqual(["\x1b[2ma\x1b[0m", "\x1b[2mb\x1b[22m"]);
    expect(stripAnsi(lines[0]!)).toBe("a");
    expect(stripAnsi(lines[1]!)).toBe("b");
  });

  it("跨多行 SGR 每行 SGR 自平衡", () => {
    const input = "\x1b[2ma\nb\nc\x1b[22m";
    const lines = splitAnsiLines(input);
    expect(lines).toEqual([
      "\x1b[2ma\x1b[0m",
      "\x1b[2mb\x1b[0m",
      "\x1b[2mc\x1b[22m",
    ]);
  });

  it("末行带 active SGR（未关闭）补 reset 自平衡", () => {
    const input = "\x1b[31mred";
    const lines = splitAnsiLines(input);
    expect(lines).toEqual(["\x1b[31mred\x1b[0m"]);
  });

  it("嵌套 SGR：bold + cyan 跨行", () => {
    const input = "\x1b[1m\x1b[36ma\nb\x1b[39m\x1b[22m";
    const lines = splitAnsiLines(input);
    expect(lines).toEqual([
      "\x1b[1m\x1b[36ma\x1b[0m",
      "\x1b[1m\x1b[36mb\x1b[39m\x1b[22m",
    ]);
  });

  it("SGR reset (\\x1b[0m) 清空 active 状态", () => {
    const input = "\x1b[2ma\x1b[0m\nb";
    const lines = splitAnsiLines(input);
    // 首行内有 reset，活跃状态被清；下一行起首无 active 注入
    expect(lines).toEqual(["\x1b[2ma\x1b[0m", "b"]);
  });

  it("空参数 SGR (\\x1b[m) 视为 reset", () => {
    const input = "\x1b[2ma\x1b[m\nb";
    const lines = splitAnsiLines(input);
    expect(lines).toEqual(["\x1b[2ma\x1b[m", "b"]);
  });

  it("OSC 序列不进 active SGR 累积", () => {
    // OSC 8 hyperlink 跨行不会让续行被染色
    const input = "\x1b]8;;https://x.com\x1b\\a\nb\x1b]8;;\x1b\\";
    const lines = splitAnsiLines(input);
    expect(stripAnsi(lines[0]!)).toBe("a");
    expect(stripAnsi(lines[1]!)).toBe("b");
    // 续行起首不应注入 OSC（OSC 不进 active）
    expect(lines[1]!.startsWith("\x1b]")).toBe(false);
  });

  it("非 SGR 的 CSI（如 \\x1b[2K 清行）不影响 active 状态", () => {
    // \x1b[2K 是 erase line，不是 SGR——不入 active
    const input = "\x1b[2mtext\x1b[2Kmore\nx\x1b[22m";
    const lines = splitAnsiLines(input);
    // active 仍是 [2m（dim）—— erase 序列原样保留
    expect(lines[0]!).toBe("\x1b[2mtext\x1b[2Kmore\x1b[0m");
    expect(lines[1]!).toBe("\x1b[2mx\x1b[22m");
  });

  it("仅 \\n 字符串切两空行", () => {
    expect(splitAnsiLines("\n")).toEqual(["", ""]);
  });

  it("结果与原文 stripAnsi 后逐行对应", () => {
    const input = "\x1b[2m行1\n行2 中文\nthe end\x1b[22m";
    const lines = splitAnsiLines(input);
    expect(lines.map((l) => stripAnsi(l))).toEqual(["行1", "行2 中文", "the end"]);
  });
});
