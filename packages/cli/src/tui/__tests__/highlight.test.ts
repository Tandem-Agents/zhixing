import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { highlightSelectedRow } from "../highlight.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

chalk.level = 3;

describe("highlightSelectedRow", () => {
  it("连续 2+ 空格被替换为同长度 ░", () => {
    const out = highlightSelectedRow("a   b", 5);
    const visible = stripAnsi(out);
    expect(visible).toBe("a░░░b");
  });

  it("单空格保留——避免 cursor 与 label 视觉粘连", () => {
    const out = highlightSelectedRow("▸ label", 7);
    const visible = stripAnsi(out);
    expect(visible).toBe("▸ label");
  });

  it("尾部补齐到 totalWidth 用 ░", () => {
    const out = highlightSelectedRow("ab", 6);
    const visible = stripAnsi(out);
    expect(visible).toBe("ab░░░░");
  });

  it("行已 >= totalWidth 时不再补齐（不溢出）", () => {
    const out = highlightSelectedRow("abcdef", 4);
    const visible = stripAnsi(out);
    expect(visible).toBe("abcdef");
  });

  it("中段连续空格 + 尾部补齐组合", () => {
    const out = highlightSelectedRow("a   b", 10);
    const visible = stripAnsi(out);
    expect(visible).toBe("a░░░b░░░░░");
  });

  it("可见宽度恰好等于 totalWidth（CJK 不偏移）", () => {
    const out = highlightSelectedRow("中文 内容", 20);
    expect(stringWidth(out)).toBe(20);
  });

  it("空白被 dim 染色（非 plain ░）", () => {
    const out = highlightSelectedRow("a   b", 5);
    expect(stripAnsi(out)).toBe("a░░░b");
    expect(out).not.toBe("a░░░b");
  });

  it("totalWidth=0 边界——返回值不补齐", () => {
    const out = highlightSelectedRow("a   b", 0);
    expect(stripAnsi(out)).toBe("a░░░b");
  });
});
