import { describe, expect, it } from "vitest";
import {
  ansiCursorUp,
  ansiCursorDown,
  ansiCursorForward,
  eraseRegion,
  moveCursorWithinRegion,
} from "../region-painter.js";

describe("ansiCursorUp", () => {
  it("正数 n 输出 \\x1b[nA", () => {
    expect(ansiCursorUp(3)).toBe("\x1b[3A");
  });
  it("0 / 负数返回空字符串（避免发送无效序列）", () => {
    expect(ansiCursorUp(0)).toBe("");
    expect(ansiCursorUp(-1)).toBe("");
  });
});

describe("ansiCursorDown", () => {
  it("正数 n 输出 \\x1b[nB", () => {
    expect(ansiCursorDown(2)).toBe("\x1b[2B");
  });
  it("0 / 负数返回空字符串", () => {
    expect(ansiCursorDown(0)).toBe("");
  });
});

describe("ansiCursorForward", () => {
  it("正数 n 输出 \\x1b[nC", () => {
    expect(ansiCursorForward(5)).toBe("\x1b[5C");
  });
  it("0 / 负数返回空字符串", () => {
    expect(ansiCursorForward(0)).toBe("");
  });
});

describe("eraseRegion", () => {
  it("cursorRow 0：仅 \\r + clear-down", () => {
    expect(eraseRegion(0)).toBe("\r\x1b[J");
  });
  it("cursorRow 3：上移 3 行 + \\r + clear-down", () => {
    expect(eraseRegion(3)).toBe("\x1b[3A\r\x1b[J");
  });
});

describe("moveCursorWithinRegion", () => {
  it("writtenLines 0 返回空字符串", () => {
    expect(moveCursorWithinRegion(0, 0, 0)).toBe("");
  });
  it("移到当前最后一行的列 0：仅 \\r", () => {
    expect(moveCursorWithinRegion(3, 2, 0)).toBe("\r");
  });
  it("移到第一行第 5 列：\\r + 上移 N-1 行 + 右移 5", () => {
    expect(moveCursorWithinRegion(3, 0, 5)).toBe("\r\x1b[2A\x1b[5C");
  });
});
