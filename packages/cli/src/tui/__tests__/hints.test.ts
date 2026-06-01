import { describe, it, expect } from "vitest";
import { renderHintBar } from "../hints.js";
import { stripAnsi, stringWidth, tone } from "../index.js";

describe("renderHintBar", () => {
  it("说明在前、按键在后(文本顺序),缺省缩进 2 列", () => {
    const line = renderHintBar({ width: 40, hints: [{ label: "置顶", key: "p" }] });
    expect(stripAnsi(line)).toBe("  置顶 p");
  });

  it("说明亮(裸前景) + 按键暗(dim):精确结构「裸 label 空格 dim(key)」", () => {
    const line = renderHintBar({ width: 40, hints: [{ label: "置顶", key: "p" }] });
    // 用同一 tone.dim 实例构造期望段——环境无关(染色→含 ANSI、无色→裸,line 必含此段);
    // 含此段即证明:说明「置顶」未被 dim 包裹(亮)、按键「p」被 dim 包裹(暗)。
    expect(line).toContain(`置顶 ${tone.dim("p")}`);
  });

  it("多个 hint 用双空格分隔", () => {
    const line = stripAnsi(
      renderHintBar({
        width: 60,
        hints: [
          { label: "置顶", key: "p" },
          { label: "禁用", key: "d" },
        ],
      }),
    );
    expect(line).toBe("  置顶 p  禁用 d");
  });

  it("左右两端对齐:左贴左、右贴右、整行铺满 width", () => {
    const line = stripAnsi(
      renderHintBar({
        width: 40,
        hints: [{ label: "导航", key: "↑↓" }],
        rightHints: [{ label: "归档", key: "a" }],
      }),
    );
    expect(line.startsWith("  导航 ↑↓")).toBe(true);
    expect(line.endsWith("归档 a")).toBe(true);
    expect(stringWidth(line)).toBe(40);
  });

  it("放不下时降级回单区平铺并 clamp ≤ width(守 alt-screen 行宽不变量)", () => {
    const line = renderHintBar({
      width: 16,
      hints: [
        { label: "导航", key: "↑↓" },
        { label: "退出", key: "Esc" },
      ],
      rightHints: [
        { label: "置顶", key: "p" },
        { label: "禁用", key: "d" },
        { label: "归档", key: "a" },
      ],
    });
    expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(16);
  });

  it("自定义 indent(inputBox 框下提示用 1 列)", () => {
    const line = stripAnsi(
      renderHintBar({ width: 40, indent: " ", hints: [{ label: "提交", key: "Enter" }] }),
    );
    expect(line).toBe(" 提交 Enter");
  });
});
