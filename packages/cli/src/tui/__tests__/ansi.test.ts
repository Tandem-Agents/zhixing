import { describe, expect, it } from "vitest";
import { ANSI, osc8Hyperlink, stripAnsi } from "../ansi.js";

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
