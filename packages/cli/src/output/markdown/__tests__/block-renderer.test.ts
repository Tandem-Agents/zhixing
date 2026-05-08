import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { marked, type Tokens } from "marked";
import { renderBlock } from "../block-renderer.js";
import { stripAnsi } from "../../../tui/ansi.js";
import { layout } from "../../../tui/style.js";

/** 用真实 marked.lexer 解析 markdown 取首 token——比手工构造 mock 更稳 */
function lexFirst<T extends Tokens.Generic>(md: string): T {
  return marked.lexer(md)[0] as T;
}

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
  it("无序列表 render 模式用 · 中点 marker（非 - / •）", () => {
    const list = lexFirst<Tokens.List>("- item1\n- item2\n");
    const out = renderBlock(list, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    expect(stripped).not.toContain("- item1");
    expect(stripped).not.toContain("• item1");
  });

  it("有序列表保留数字 marker", () => {
    const list = lexFirst<Tokens.List>("1. a\n2. b\n");
    const out = renderBlock(list, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("1. a");
    expect(stripped).toContain("2. b");
  });

  it("strip 模式 marker 不染色 + 列对齐", () => {
    const list = lexFirst<Tokens.List>("- x\n");
    const out = renderBlock(list, "strip");
    expect(out).toBe(`\n${PREFIX}· x\n`);
  });

  it("起首 / 末尾 \\n 自带（独立段语义）", () => {
    const list = lexFirst<Tokens.List>("- a\n- b\n");
    const out = renderBlock(list, "render");
    expect(out.startsWith("\n")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("list_item 含 inline ANSI（**bold** / `code`）→ inline-renderer 处理", () => {
    const list = lexFirst<Tokens.List>("- **bold** text\n- with `code`\n");
    const out = renderBlock(list, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("· bold text");
    expect(stripped).toContain("· with code");
    // bold 文字含 ANSI（chalk.bold 序列）
    expect(out).toContain("\x1b[1m");
  });

  it("嵌套 list 每层多 2 列起首", () => {
    const list = lexFirst<Tokens.List>("- outer\n  - inner\n");
    const out = renderBlock(list, "render");
    const stripped = stripAnsi(out);
    // 外层 outer 在 PREFIX 列；内层 inner 在 PREFIX + 2 空格列
    expect(stripped).toContain(`${PREFIX}· outer`);
    expect(stripped).toContain(`${PREFIX}${"  "}· inner`);
  });

  it("嵌套 list 三层视觉对齐", () => {
    const list = lexFirst<Tokens.List>("- a\n  - b\n    - c\n");
    const out = renderBlock(list, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain(`${PREFIX}· a`);
    expect(stripped).toContain(`${PREFIX}${"  "}· b`);
    expect(stripped).toContain(`${PREFIX}${"    "}· c`);
  });
});

describe("renderBlock · paragraph", () => {
  it("render 模式 inline ANSI + 列 2 + 起首末尾 \\n", () => {
    const para = lexFirst<Tokens.Paragraph>("normal **bold** text\n\n");
    const out = renderBlock(para, "render");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}normal bold text\n`);
    expect(out).toContain("\x1b[1m"); // bold
  });

  it("strip 模式 inline 退化为纯文本", () => {
    const para = lexFirst<Tokens.Paragraph>("**bold** + `code`\n\n");
    const out = renderBlock(para, "strip");
    expect(out).toBe(`\n${PREFIX}bold + code\n`);
    expect(out).not.toContain("\x1b[");
  });
});

describe("renderBlock · blockquote", () => {
  it("render 模式 dim 文字 + 列 2 起", () => {
    const bq = lexFirst<Tokens.Blockquote>("> quoted\n\n");
    const out = renderBlock(bq, "render");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}quoted\n`);
    expect(out).toContain("\x1b[2m"); // dim
  });

  it("blockquote 嵌套 list：递归渲染", () => {
    const bq = lexFirst<Tokens.Blockquote>("> - item1\n> - item2\n\n");
    const out = renderBlock(bq, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    // 整段 dim
    expect(out).toContain("\x1b[2m");
  });

  it("blockquote 多段 paragraph：递归处理 inline", () => {
    const bq = lexFirst<Tokens.Blockquote>("> first paragraph\n>\n> second **bold**\n\n");
    const out = renderBlock(bq, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("first paragraph");
    expect(stripped).toContain("second bold");
  });

  it("strip 模式不染色", () => {
    const bq = lexFirst<Tokens.Blockquote>("> quoted\n\n");
    const out = renderBlock(bq, "strip");
    expect(out).not.toContain("\x1b[");
    expect(stripAnsi(out)).toBe(`\n${PREFIX}quoted\n`);
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
