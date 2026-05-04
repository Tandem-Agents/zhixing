import { describe, expect, it } from "vitest";
import { renderChrome } from "../chrome.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

describe("renderChrome", () => {
  it("无标题时顶边是 ╭─...─╮ 纯横线", () => {
    const lines = renderChrome({ body: ["x"], width: 20 });
    expect(stripAnsi(lines[0]!)).toBe("╭" + "─".repeat(18) + "╮");
  });

  it("有标题时标题嵌入顶边（前置单空格无 dash）", () => {
    const [top] = renderChrome({
      title: "知行 · 首次配置",
      body: ["x"],
      width: 60,
    });
    const visible = stripAnsi(top!);
    expect(visible).toMatch(/^╭ 知行 · 首次配置 ─+╮$/);
  });

  it("body 上下各加 1 空行 padding（呼吸）", () => {
    const lines = renderChrome({ body: ["内容"], width: 30 });
    // top + topBlank + content + bottomBlank + bottom = 5
    expect(lines).toHaveLength(5);
    // 顶/底 padding 行——左右 │ 之间全为空格
    expect(stripAnsi(lines[1]!)).toMatch(/^│\s+│$/);
    expect(stripAnsi(lines[3]!)).toMatch(/^│\s+│$/);
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
    // [0]=top, [1]=topBlank, [2]=hello, [3]=bottomBlank, [4]=bottom
    const bodyLine = stripAnsi(lines[2]!);
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

  it("brandAnchor 模式：锚左偏，前 4 dash + 1 空格的距离感", () => {
    const [top] = renderChrome({
      brandAnchor: "*",
      body: ["x"],
      width: 21,
    });
    // innerWidth = 19；fixed = 4 dash + 1 space + 1 (*) + 1 space = 7；trailing = 12
    // 形态：╭──── * ────────────╮
    expect(stripAnsi(top!)).toBe(
      "╭" + "─".repeat(4) + " * " + "─".repeat(12) + "╮",
    );
  });

  it("brandAnchor 比 title 优先（同顶边只承载一种语义）", () => {
    const [top] = renderChrome({
      brandAnchor: "*",
      title: "should-be-ignored",
      body: ["x"],
      width: 30,
    });
    expect(stripAnsi(top!)).not.toContain("should-be-ignored");
    expect(stripAnsi(top!)).toContain("*");
  });

  it("brandAnchor 在窄终端无尾随 dash 空间时降级纯横线", () => {
    const [top] = renderChrome({
      brandAnchor: "*",
      body: ["x"],
      width: 8,
    });
    // innerWidth=6，fixed=7 → trailing < 1 → 降级
    expect(stripAnsi(top!)).toBe("╭" + "─".repeat(6) + "╮");
  });

  it("BrandAnchor 对象形式：anchor body 紧贴顶边，分层空行后才是用户 body", () => {
    const lines = renderChrome({
      brandAnchor: {
        topEdge: "*",
        bodyLines: [" ▄▄▄", "▌●●▐", " ▀▀"],
      },
      body: ["body content"],
      width: 30,
    });
    // 顶边含 topEdge 字符
    expect(stripAnsi(lines[0]!)).toContain("*");
    // 锚 body 紧接顶边——不再在前面塞 padding 空行
    expect(stripAnsi(lines[1]!)).toContain("▄▄▄");
    expect(stripAnsi(lines[2]!)).toContain("▌●●▐");
    expect(stripAnsi(lines[3]!)).toContain("▀▀");
    // 锚与用户内容之间留 1 空行做分层
    expect(stripAnsi(lines[4]!)).toMatch(/^│\s+│$/);
    expect(stripAnsi(lines[5]!)).toContain("body content");
  });

  it("BrandAnchor 列对齐：topEdge 关键字符与 bodyLines 字符列对齐", () => {
    const lines = renderChrome({
      brandAnchor: {
        topEdge: "╲",
        bodyLines: [" ▄▄▄"],
      },
      body: [],
      width: 30,
    });
    // 顶边 ╲ 落在 chrome col 6（0-based）：╭(0) + 4 dashes + 1 space + ╲(6)
    const top = stripAnsi(lines[0]!);
    expect(top.indexOf("╲")).toBe(6);
    // 锚 body 紧贴顶边——lines[1] 即 " ▄▄▄"
    // 渲染为 │(0) + 3 spaces + " ▄▄▄"——▄ visible col = 1 + 3 + 1 = 5（即 ╲ 左 1 列）
    const body = stripAnsi(lines[1]!);
    expect(body.indexOf("▄")).toBe(5);
  });

  it("CJK body 行右边框对齐（不偏移）", () => {
    const lines = renderChrome({ body: ["中文内容测试"], width: 30 });
    const body = lines[2]!; // [0]=top [1]=topBlank [2]=content
    expect(stringWidth(body)).toBe(30);
    expect(stripAnsi(body).endsWith("│")).toBe(true);
  });

  it("body 超宽时被截断 + …", () => {
    const longLine = "a".repeat(100);
    const lines = renderChrome({ body: [longLine], width: 20 });
    const body = lines[2]!;
    expect(stripAnsi(body)).toContain("…");
    expect(stringWidth(body)).toBe(20);
  });
});
