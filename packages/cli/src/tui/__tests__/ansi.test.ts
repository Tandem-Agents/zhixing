import { describe, expect, it } from "vitest";
import { ANSI, stripAnsi } from "../ansi.js";

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
});
