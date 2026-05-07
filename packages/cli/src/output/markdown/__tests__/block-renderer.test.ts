import chalk from "chalk";
import { describe, expect, it } from "vitest";
import type { Tokens } from "marked";
import { renderBlock } from "../block-renderer.js";
import { stripAnsi } from "../../../tui/ansi.js";
import { layout } from "../../../tui/style.js";

// 强制启用 ANSI 染色——vitest non-TTY 环境下 chalk 默认降级，让 chalk.cyan(x) 输出
// 真实 ANSI 序列才能验证 render vs strip 模式的差异
chalk.level = 3;

const PREFIX = layout.contentPrefix;

describe("renderBlock · heading", () => {
  it("一级标题 render 模式：起首空行 + brand cyan + bold + 列 2 缩进", () => {
    const t = { type: "heading", depth: 1, text: "Title", raw: "# Title" } as Tokens.Heading;
    const out = renderBlock(t, "render");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}Title\n`);
    expect(out).toContain(chalk.cyan.bold("Title"));
  });

  it("二级标题 render 模式：起首空行 + default bold（不染色）", () => {
    const t = { type: "heading", depth: 2, text: "Sub", raw: "## Sub" } as Tokens.Heading;
    const out = renderBlock(t, "render");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}Sub\n`);
    expect(out).toContain(chalk.bold("Sub"));
  });

  it("strip 模式仅缩进 + 文本，不染色不加粗", () => {
    const t = { type: "heading", depth: 1, text: "Title", raw: "# Title" } as Tokens.Heading;
    const out = renderBlock(t, "strip");
    expect(out).toBe(`\n${PREFIX}Title\n`);
    expect(out).not.toContain("\x1b[");
  });
});

describe("renderBlock · code", () => {
  it("render 模式 dim 文字 + 起首空行 + 列 2 缩进，无装饰字符", () => {
    const t = {
      type: "code",
      text: "const x = 1\nconst y = 2",
      raw: "```\nconst x = 1\nconst y = 2\n```",
    } as Tokens.Code;
    const out = renderBlock(t, "render");
    expect(stripAnsi(out)).toBe(
      `\n${PREFIX}const x = 1\n${PREFIX}const y = 2\n`,
    );
    expect(out).toContain(chalk.dim(`${PREFIX}const x = 1`));
    // 复制（去 ANSI）后是纯代码 + 前导 padding——无装饰字符（▎ 等）污染
    expect(stripAnsi(out)).not.toMatch(/[▎│┃]/);
  });

  it("strip 模式不染色，仅缩进", () => {
    const t = { type: "code", text: "code", raw: "```\ncode\n```" } as Tokens.Code;
    const out = renderBlock(t, "strip");
    expect(out).toBe(`\n${PREFIX}code\n`);
  });
});

describe("renderBlock · list", () => {
  function makeList(items: string[], ordered = false): Tokens.List {
    return {
      type: "list",
      ordered,
      start: ordered ? 1 : "",
      loose: false,
      raw: items.join("\n"),
      items: items.map((t) => ({
        type: "list_item",
        text: t,
        raw: `- ${t}`,
        task: false,
        loose: false,
        tokens: [],
      })) as Tokens.ListItem[],
    } as Tokens.List;
  }

  it("无序列表 render 模式用 · 中点 marker（非 - / •）", () => {
    const out = renderBlock(makeList(["item1", "item2"]), "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    expect(stripped).not.toContain("- item1");
    expect(stripped).not.toContain("• item1");
  });

  it("有序列表保留数字 marker", () => {
    const out = renderBlock(makeList(["a", "b"], true), "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("1. a");
    expect(stripped).toContain("2. b");
  });

  it("strip 模式 marker 不染色", () => {
    const out = renderBlock(makeList(["x"]), "strip");
    expect(out).toBe(`${PREFIX}· x\n`);
  });
});

describe("renderBlock · blockquote", () => {
  it("render 模式 dim 文字 + 列 2 起", () => {
    const t = { type: "blockquote", text: "quoted", raw: "> quoted" } as Tokens.Blockquote;
    const out = renderBlock(t, "render");
    expect(stripAnsi(out)).toBe(`${PREFIX}quoted\n`);
    expect(out).toContain(chalk.dim(`${PREFIX}quoted`));
  });
});

describe("renderBlock · hr", () => {
  it("render 模式 dim 横线 + 起首空行", () => {
    const t = { type: "hr", raw: "---" } as Tokens.Hr;
    const out = renderBlock(t, "render");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}${"─".repeat(40)}\n`);
  });
});

describe("renderBlock · raw 模式", () => {
  it("raw 模式直接返回 token.raw 不渲染", () => {
    const t = { type: "heading", depth: 1, text: "Title", raw: "# Title" } as Tokens.Heading;
    expect(renderBlock(t, "raw")).toBe("# Title");
  });
});

describe("renderBlock · space token", () => {
  it("space token 返回空字符串（段落分隔不重复 emit）", () => {
    const t = { type: "space", raw: "\n\n" } as Tokens.Space;
    expect(renderBlock(t, "render")).toBe("");
  });
});
