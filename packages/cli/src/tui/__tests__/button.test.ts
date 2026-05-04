import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderButton, renderButtonRow } from "../button.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";
import { layout } from "../style.js";

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

  it("selected 注入 bold ANSI——视觉重量加强（不依赖 bg 染色）", () => {
    const [, plain] = renderButton({ label: "完成" });
    const [, selected] = renderButton({ label: "完成", selected: true });
    expect(selected).toContain("\x1b[1m");
    expect(plain).not.toContain("\x1b[1m");
  });

  it("primary 用 success(green) 色——非选中也含 fg color", () => {
    const [, primary] = renderButton({ label: "完成", primary: true });
    expect(primary).toContain("\x1b[32m");
  });

  it("非 primary 非选中 用 dim 色", () => {
    const [, plain] = renderButton({ label: "取消" });
    expect(plain).toContain("\x1b[2m");
  });

  it("不使用 bg 染色——避免跨终端 bg 渲染溢出", () => {
    const [, selected] = renderButton({ label: "完成", selected: true });
    const [, primarySelected] = renderButton({
      label: "完成",
      selected: true,
      primary: true,
    });
    expect(selected).not.toMatch(/\x1b\[4[2-7]m/);
    expect(primarySelected).not.toMatch(/\x1b\[4[2-7]m/);
  });

  it("stripAnsi 后形态稳定——3 行皆为 box 字符", () => {
    const [top, middle, bottom] = renderButton({ label: "完成" });
    expect(stripAnsi(top!)).toBe("┌────────┐");
    expect(stripAnsi(middle!)).toBe("│  完成  │");
    expect(stripAnsi(bottom!)).toBe("└────────┘");
  });
});

describe("renderButtonRow", () => {
  const indentStr = " ".repeat(layout.contentIndent);

  it("返回三行：顶 / 中 / 底", () => {
    const lines = renderButtonRow({ label: "完成" });
    expect(lines).toHaveLength(3);
  });

  it("默认 indent = layout.contentIndent，top/bottom 用空格补齐对齐位", () => {
    const [top, , bottom] = renderButtonRow({ label: "完成" });
    expect(stripAnsi(top!).startsWith(indentStr)).toBe(true);
    expect(stripAnsi(bottom!).startsWith(indentStr)).toBe(true);
  });

  it("自定义 indent 生效", () => {
    const [top] = renderButtonRow({ label: "完成", indent: 6 });
    expect(stripAnsi(top!).startsWith("      ")).toBe(true);
  });

  it("未选中：middle 行左侧是空格不是 cursor", () => {
    const [, middle] = renderButtonRow({ label: "完成" });
    // cursor 占位是空格 + 空格 = 2 列，等同 indent 默认
    expect(stripAnsi(middle!).startsWith("  ")).toBe(true);
    expect(stripAnsi(middle!)).not.toContain("▸");
  });

  it("选中：middle 行左侧出现 ▸ cursor 标记", () => {
    const [, middle] = renderButtonRow({ label: "完成", selected: true });
    expect(stripAnsi(middle!).startsWith("▸ ")).toBe(true);
  });

  it("hint 拼到 middle 行右侧 dim 括号内", () => {
    const [, middle] = renderButtonRow({
      label: "完成",
      hint: "保存并启动",
    });
    expect(stripAnsi(middle!)).toContain("(保存并启动)");
  });

  it("无 hint 时 middle 行不含括号文本", () => {
    const [, middle] = renderButtonRow({ label: "完成" });
    expect(stripAnsi(middle!)).not.toContain("(");
  });

  it("primary 选中态：success 色 + bold（颜色由 renderButton 决定）", () => {
    const [, middle] = renderButtonRow({
      label: "完成",
      primary: true,
      selected: true,
    });
    expect(middle).toContain("\x1b[32m"); // success/green
    expect(middle).toContain("\x1b[1m"); // bold
  });
});
