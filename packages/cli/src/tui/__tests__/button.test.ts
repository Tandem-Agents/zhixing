import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderButton } from "../button.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

// vitest stdout 非 TTY，chalk 默认不染色——强开以验证选中态等颜色相关结构
chalk.level = 3;

describe("renderButton", () => {
  it("返回三行：顶 / 中 / 底", () => {
    const lines = renderButton({ label: "完成" });
    expect(lines).toHaveLength(3);
  });

  it("三行可见宽度一致", () => {
    const lines = renderButton({ label: "完成（保存并启动）" });
    const widths = lines.map((l) => stringWidth(l));
    expect(widths[0]).toBe(widths[1]);
    expect(widths[1]).toBe(widths[2]);
  });

  it("顶底是直角 box drawing", () => {
    const [top, , bottom] = renderButton({ label: "x" });
    expect(stripAnsi(top!)).toMatch(/^┌─+┐$/);
    expect(stripAnsi(bottom!)).toMatch(/^└─+┘$/);
  });

  it("label 居中（两侧各 2 空格内边距）", () => {
    const [, middle] = renderButton({ label: "确认" });
    expect(stripAnsi(middle!)).toBe("│  确认  │");
  });

  it("primary 与 secondary 形态结构相同（语义颜色由调用方观察）", () => {
    const primary = renderButton({ label: "完成", primary: true });
    const secondary = renderButton({ label: "完成" });
    // 形状与可见字符相同
    expect(primary.map(stripAnsi)).toEqual(secondary.map(stripAnsi));
  });

  it("selected 在中间行注入反白 ANSI", () => {
    const [, plain] = renderButton({ label: "完成" });
    const [, selected] = renderButton({ label: "完成", selected: true });
    // 反白码 \x1b[7m 出现在 selected
    expect(selected).toContain("\x1b[7m");
    expect(plain).not.toContain("\x1b[7m");
  });
});
