import { describe, expect, it } from "vitest";
import { renderInputFrame } from "../input-frame.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

describe("renderInputFrame", () => {
  it("空 buffer 仍渲染最少一行内容（保留可见性）", () => {
    const lines = renderInputFrame({ buffer: "", width: 30 });
    // top + 1 body + bottom
    expect(lines).toHaveLength(3);
  });

  it("含 prompt + 短 buffer 单行容纳", () => {
    const lines = renderInputFrame({
      prompt: "> ",
      buffer: "hello",
      width: 30,
    });
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1]!)).toContain("> hello");
  });

  it("超长 buffer 自动换行（多个 body 行）", () => {
    const lines = renderInputFrame({
      buffer: "a".repeat(100),
      width: 20,
    });
    expect(lines.length).toBeGreaterThan(3);
  });

  it("所有行可见宽度等于 width", () => {
    const lines = renderInputFrame({
      buffer: "中文输入测试 with English mixed",
      width: 40,
    });
    for (const line of lines) {
      expect(stringWidth(line)).toBe(40);
    }
  });

  it("CJK 字符不会被切半（按显示宽度换行）", () => {
    // contentWidth = 20 - 2 - 2 - 1 = 15 列；CJK 字符 2 列
    // 7 个 CJK = 14 列 fits；第 8 个超出 15 → 换行
    const lines = renderInputFrame({
      buffer: "一二三四五六七八九十",
      width: 20,
    });
    // 至少两个 body 行
    const bodyLines = lines.slice(1, -1);
    expect(bodyLines.length).toBeGreaterThanOrEqual(2);
  });

  it("顶底用圆角 box drawing", () => {
    const lines = renderInputFrame({ buffer: "x", width: 20 });
    expect(stripAnsi(lines[0]!)).toMatch(/^╭─+╮$/);
    expect(stripAnsi(lines.at(-1)!)).toMatch(/^╰─+╯$/);
  });
});
