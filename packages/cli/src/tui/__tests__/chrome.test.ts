import { describe, expect, it } from "vitest";
import { renderChrome } from "../chrome.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

describe("renderChrome", () => {
  it("无标题时顶边是 ╭─...─╮ 纯横线", () => {
    const lines = renderChrome({ body: ["x"], width: 20 });
    expect(stripAnsi(lines[0]!)).toBe("╭" + "─".repeat(18) + "╮");
  });

  it("有标题时标题嵌入顶边", () => {
    const [top] = renderChrome({
      title: "知行 · 首次配置",
      body: ["x"],
      width: 60,
    });
    const visible = stripAnsi(top!);
    expect(visible).toMatch(/^╭─ 知行 · 首次配置 ─+╮$/);
  });

  it("所有行可见宽度等于 width", () => {
    const lines = renderChrome({
      title: "测试",
      body: ["", "短", "长一点的内容 with English mix", ""],
      width: 60,
    });
    for (const line of lines) {
      expect(stringWidth(line)).toBe(60);
    }
  });

  it("body 行用 │ 包裹", () => {
    const lines = renderChrome({ body: ["hello"], width: 20 });
    const bodyLine = stripAnsi(lines[1]!);
    expect(bodyLine.startsWith("│")).toBe(true);
    expect(bodyLine.endsWith("│")).toBe(true);
    expect(bodyLine).toContain("hello");
  });

  it("底边是 ╰─...─╯", () => {
    const lines = renderChrome({ body: ["x"], width: 20 });
    expect(stripAnsi(lines.at(-1)!)).toBe("╰" + "─".repeat(18) + "╯");
  });

  it("标题超长时降级为纯横线顶边", () => {
    const [top] = renderChrome({
      title: "一个非常非常非常非常非常长的标题超出窄终端",
      body: ["x"],
      width: 12,
    });
    expect(stripAnsi(top!)).toBe("╭" + "─".repeat(10) + "╮");
  });

  it("CJK body 行右边框对齐（不偏移）", () => {
    const [, body] = renderChrome({ body: ["中文内容测试"], width: 30 });
    expect(stringWidth(body!)).toBe(30);
    expect(stripAnsi(body!).endsWith("│")).toBe(true);
  });

  it("body 超宽时被截断 + …", () => {
    const longLine = "a".repeat(100);
    const [, body] = renderChrome({ body: [longLine], width: 20 });
    expect(stripAnsi(body!)).toContain("…");
    expect(stringWidth(body!)).toBe(20);
  });
});
