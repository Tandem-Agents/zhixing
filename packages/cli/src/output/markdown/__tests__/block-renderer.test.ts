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
  it("无 lang 走 dim 退化：render 模式 dim 文字 + 起首空行 + 列 2 缩进", () => {
    const t = {
      type: "code",
      text: "const x = 1\nconst y = 2",
      raw: "```\nconst x = 1\nconst y = 2\n```",
    } as Tokens.Code;
    const out = renderBlock(t, "render");
    // stripAnsi 后内容结构稳定（PREFIX + 行 + \n）
    expect(stripAnsi(out)).toBe(
      `\n${PREFIX}const x = 1\n${PREFIX}const y = 2\n`,
    );
    // 含 dim ANSI（无 lang 退化路径）
    expect(out).toContain("\x1b[2m");
    // 复制（去 ANSI）后是纯代码 + 前导 padding——无装饰字符污染
    expect(stripAnsi(out)).not.toMatch(/[▎│┃]/);
  });

  it("已知 lang (typescript) 走 cli-highlight：含 keyword 颜色 SGR", () => {
    const t = {
      type: "code",
      lang: "typescript",
      text: "const x = 1",
      raw: "```typescript\nconst x = 1\n```",
    } as Tokens.Code;
    const out = renderBlock(t, "render");
    // stripAnsi 后内容结构稳定
    expect(stripAnsi(out)).toBe(`\n${PREFIX}const x = 1\n`);
    // 含 SGR 染色（hl.js + chalk 给 keyword "const" 上色）—— 不强加具体颜色
    expect(out).toMatch(/\x1b\[\d+m/);
    // 不应是单 dim 路径——而是丰富的 SGR（多个不同序号的 SGR）
    const sgrSeqs = out.match(/\x1b\[\d+m/g) ?? [];
    const uniqueParams = new Set(sgrSeqs);
    expect(uniqueParams.size).toBeGreaterThan(1);
  });

  it("不支持的 lang 退化为 dim", () => {
    const t = {
      type: "code",
      lang: "xyz-non-existing",
      text: "anything",
      raw: "```xyz-non-existing\nanything\n```",
    } as Tokens.Code;
    const out = renderBlock(t, "render");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}anything\n`);
    expect(out).toContain("\x1b[2m"); // dim
  });

  it("跨行 SGR token 经 splitAnsiLines 自平衡：续行 PREFIX 不被染色", () => {
    // Python 多行字符串：hl.js 给整段套 SGR，跨多行
    const t = {
      type: "code",
      lang: "python",
      text: 'x = """line 1\nline 2\nline 3"""',
      raw: "```python\n...```",
    } as Tokens.Code;
    const out = renderBlock(t, "render");
    // 末尾不应有未闭合 SGR 泄露——整段以 \n 结尾、最后一行的 SGR 已被 reset 平衡
    // 检查方法：split 取每行，stripAnsi 后逐行分析；render 末尾不应有 active SGR
    const lines = out.split("\n");
    for (const line of lines) {
      // 每行起首应是 PREFIX（空格）或空——不被前一行的 SGR 影响
      // 由 splitAnsiLines 保证：行末 reset、行起首再 inject active
      expect(line.startsWith(PREFIX) || line === "").toBe(true);
    }
  });

  it("strip 模式不染色，仅缩进——无 ANSI", () => {
    const t = { type: "code", text: "code", raw: "```\ncode\n```" } as Tokens.Code;
    const out = renderBlock(t, "strip");
    expect(out).toBe(`\n${PREFIX}code\n`);
    expect(out).not.toContain("\x1b[");
  });

  it("strip 模式即使有 lang 也不染色", () => {
    const t = {
      type: "code",
      lang: "typescript",
      text: "const x = 1",
      raw: "```typescript\nconst x = 1\n```",
    } as Tokens.Code;
    const out = renderBlock(t, "strip");
    expect(out).toBe(`\n${PREFIX}const x = 1\n`);
    expect(out).not.toContain("\x1b[");
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
