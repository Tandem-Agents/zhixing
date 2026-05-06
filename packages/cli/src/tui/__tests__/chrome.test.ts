import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderChrome } from "../chrome.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

chalk.level = 3;

describe("renderChrome", () => {
  it("无标题时顶边是 ╭─...─╮ 纯横线", () => {
    const lines = renderChrome({ body: ["x"], width: 20 });
    expect(stripAnsi(lines[0]!)).toBe("╭" + "─".repeat(18) + "╮");
  });

  it("有标题时标题嵌入顶边（前置单空格无 dash）", () => {
    const [top] = renderChrome({
      title: "面板标题",
      body: ["x"],
      width: 60,
    });
    const visible = stripAnsi(top!);
    expect(visible).toMatch(/^╭ 面板标题 ─+╮$/);
  });

  it("body 上下各加 1 空行 padding（呼吸）", () => {
    const lines = renderChrome({ body: ["内容"], width: 30 });
    // top + topBlank + content + bottomBlank + bottom = 5
    expect(lines).toHaveLength(5);
    // 顶/底 padding 行——左右 │ 之间全为空格
    expect(stripAnsi(lines[1]!)).toMatch(/^│\s+│$/);
    expect(stripAnsi(lines[3]!)).toMatch(/^│\s+│$/);
  });

  it("bodyPadding=false 紧凑形态：顶/底 padding 空行被省略，box 高度 3 行", () => {
    const lines = renderChrome({
      body: ["内容"],
      width: 30,
      bodyPadding: false,
    });
    // top + content + bottom = 3 行
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[0]!).startsWith("╭")).toBe(true);
    expect(stripAnsi(lines[1]!)).toContain("内容");
    expect(stripAnsi(lines[2]!).startsWith("╰")).toBe(true);
  });

  it("bodyPadding=false 不影响锚 body 与用户 body 之间的分层空行", () => {
    const lines = renderChrome({
      brandAnchor: { topEdge: "*", bodyLines: ["▌●●▐"] },
      body: ["内容"],
      width: 30,
      bodyPadding: false,
    });
    // top + anchor body + 分层 blank + user body + bottom = 5 行
    // 不再有顶部 padding（紧贴顶边）和底部 padding（紧贴底边）
    expect(lines).toHaveLength(5);
    expect(stripAnsi(lines[0]!)).toContain("*");
    expect(stripAnsi(lines[1]!)).toContain("●●");
    expect(stripAnsi(lines[2]!)).toMatch(/^│\s+│$/); // 分层 blank
    expect(stripAnsi(lines[3]!)).toContain("内容");
    expect(stripAnsi(lines[4]!).startsWith("╰")).toBe(true);
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

  describe("highlight: dotted-row 选中行", () => {
    it("行宽与普通行一致 = width", () => {
      const lines = renderChrome({
        body: [{ content: "▸ /new", highlight: "dotted-row" }],
        width: 30,
        bodyPadding: false,
        indent: 1,
      });
      // 紧凑模式 + 单 body：lines = [top, body, bottom]
      expect(lines).toHaveLength(3);
      expect(stringWidth(lines[1]!)).toBe(30);
    });

    it("行内尾部 padding 被替换为 ░ 点阵纹理", () => {
      const lines = renderChrome({
        body: [{ content: "▸ /new", highlight: "dotted-row" }],
        width: 30,
        bodyPadding: false,
        indent: 1,
      });
      const visible = stripAnsi(lines[1]!);
      expect(visible).toContain("░");
      // 左 │ + 1 空格(indent=1 单空格保留) + ▸ /new + 尾部点阵 + 右 │
      expect(visible).toMatch(/^│ ▸ \/new░+│$/);
    });

    it("紧凑模式 indent=1：左侧单空格呼吸保留（不点阵化）", () => {
      const lines = renderChrome({
        body: [{ content: "▸ x", highlight: "dotted-row" }],
        width: 20,
        bodyPadding: false,
        indent: 1,
      });
      const visible = stripAnsi(lines[1]!);
      // 第 2 列是 indent 单空格，第 3 列起是 content
      expect(visible[0]).toBe("│");
      expect(visible[1]).toBe(" ");
      expect(visible[2]).toBe("▸");
    });

    it("默认 indent=3：左侧 3 个空格被点阵化（连续空格规则）", () => {
      const lines = renderChrome({
        body: [{ content: "x", highlight: "dotted-row" }],
        width: 20,
        bodyPadding: false,
        // indent 缺省 = 3
      });
      const visible = stripAnsi(lines[1]!);
      // │ + ░░░（indent=3 三个连续空格被点阵化）+ x + 点阵 + │
      expect(visible.startsWith("│░░░x")).toBe(true);
    });

    it("content 内单空格保留（cursor 与 label 之间不点阵化）", () => {
      const lines = renderChrome({
        body: [{ content: "▸ /new", highlight: "dotted-row" }],
        width: 30,
        bodyPadding: false,
        indent: 1,
      });
      const visible = stripAnsi(lines[1]!);
      // ▸ 与 /new 之间的单空格保留
      expect(visible).toContain("▸ /new");
    });

    it("content 内连续多空格被点阵化（双区布局的 pad 段）", () => {
      const lines = renderChrome({
        body: [{ content: "▸ /new     desc", highlight: "dotted-row" }],
        width: 40,
        bodyPadding: false,
        indent: 1,
      });
      const visible = stripAnsi(lines[1]!);
      // /new 与 desc 之间的 5 连续空格被替换为 ░░░░░
      expect(visible).toContain("/new░░░░░desc");
    });

    it("highlight 行与普通 string 行混合，分别使用各自渲染规则", () => {
      const lines = renderChrome({
        body: [
          "first",
          { content: "▸ second", highlight: "dotted-row" },
          "third",
        ],
        width: 30,
        bodyPadding: false,
        indent: 1,
      });
      // top + 3 body + bottom = 5 行
      expect(lines).toHaveLength(5);
      // 普通行不含 ░
      expect(stripAnsi(lines[1]!)).not.toContain("░");
      // highlight 行含 ░
      expect(stripAnsi(lines[2]!)).toContain("░");
      // 普通行不含 ░
      expect(stripAnsi(lines[3]!)).not.toContain("░");
      // 三行宽度相同
      expect(stringWidth(lines[1]!)).toBe(30);
      expect(stringWidth(lines[2]!)).toBe(30);
      expect(stringWidth(lines[3]!)).toBe(30);
    });

    it("content 超宽时先被 clampLine 截断（追加 …）然后参与点阵", () => {
      const lines = renderChrome({
        body: [{ content: "a".repeat(100), highlight: "dotted-row" }],
        width: 20,
        bodyPadding: false,
        indent: 1,
      });
      const visible = stripAnsi(lines[1]!);
      expect(visible).toContain("…");
      expect(stringWidth(lines[1]!)).toBe(20);
    });

    it("body padding=true 模式下 highlight 行依然正确（顶/底 blank 不受影响）", () => {
      const lines = renderChrome({
        body: [{ content: "▸ x", highlight: "dotted-row" }],
        width: 20,
      });
      // top + topBlank + body + bottomBlank + bottom = 5
      expect(lines).toHaveLength(5);
      // body 行（lines[2]）含 ░；padding 行（lines[1] / lines[3]）是空格
      expect(stripAnsi(lines[2]!)).toContain("░");
      expect(stripAnsi(lines[1]!)).toMatch(/^│\s+│$/);
      expect(stripAnsi(lines[3]!)).toMatch(/^│\s+│$/);
    });
  });
});
