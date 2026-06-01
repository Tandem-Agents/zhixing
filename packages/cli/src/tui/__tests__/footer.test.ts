import { describe, expect, it } from "vitest";
import { renderFooter } from "../footer.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

describe("renderFooter", () => {
  it("返回两行：分隔 + 提示", () => {
    const lines = renderFooter({ width: 40, hints: ["A", "B"] });
    expect(lines).toHaveLength(2);
  });

  it("分隔行宽度等于 width", () => {
    const [sep] = renderFooter({ width: 50, hints: ["x"] });
    expect(stripAnsi(sep!)).toHaveLength(50);
  });

  it("提示行用中点分隔", () => {
    const [, hint] = renderFooter({
      width: 40,
      hints: ["↑↓ 选择", "Enter 进入", "Ctrl+C 退出"],
    });
    expect(stripAnsi(hint!)).toContain("↑↓ 选择");
    expect(stripAnsi(hint!)).toContain("·");
    expect(stripAnsi(hint!)).toContain("Ctrl+C 退出");
  });

  it("不传 rightHints:单区左缩进 2(与历史行为 byte-equal)", () => {
    const [, hint] = renderFooter({ width: 40, hints: ["A", "B"] });
    expect(stripAnsi(hint!)).toBe("  A · B");
  });

  it("rightHints 为空数组等价于不传(退化单区)", () => {
    const [, hint] = renderFooter({ width: 40, hints: ["A"], rightHints: [] });
    expect(stripAnsi(hint!)).toBe("  A");
  });

  it("传 rightHints:两端对齐,左区在前、右区贴右末端、整行铺满 width", () => {
    const [sep, hint] = renderFooter({
      width: 50,
      hints: ["↑↓ 导航", "Esc 退出"],
      rightHints: ["p 置顶", "a 归档"],
    });
    const plain = stripAnsi(hint!);
    // 仍单行;左区先于右区
    expect(plain.indexOf("↑↓ 导航")).toBeLessThan(plain.indexOf("p 置顶"));
    expect(plain).toContain("Esc 退出");
    // 右区贴右:行末即右区末元素,无尾随空格
    expect(plain.endsWith("归档")).toBe(true);
    // 两端对齐填满整行,右端与分隔线右端对齐
    expect(stringWidth(plain)).toBe(50);
    expect(stripAnsi(sep!)).toHaveLength(50);
  });

  it("双区放不下时降级回单区平铺,恒 2 行且不超 width(守 alt-screen 不变量)", () => {
    const lines = renderFooter({
      width: 20,
      hints: ["↑↓ 导航", "Esc 退出"],
      rightHints: ["p 置顶", "d 禁用", "m 改 mode", "a 归档"],
    });
    expect(lines).toHaveLength(2); // 行数稳定,不堆叠
    expect(stringWidth(stripAnsi(lines[1]!))).toBeLessThanOrEqual(20);
  });

  it("单区 hint 超宽时 clamp 到 width(守 alt-screen 不变量)", () => {
    const [, hint] = renderFooter({ width: 30, hints: ["x".repeat(100)] });
    expect(stringWidth(stripAnsi(hint!))).toBeLessThanOrEqual(30);
  });
});
