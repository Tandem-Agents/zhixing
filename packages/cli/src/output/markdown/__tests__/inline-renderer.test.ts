import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { renderInline, renderInlines } from "../inline-renderer.js";
import { stripAnsi } from "../../../tui/ansi.js";

// 强制启用 ANSI 染色——vitest non-TTY 下 chalk 默认降级，让 chalk.bold 等输出
// 真实 ANSI 序列才能验证 render vs strip 模式的差异
chalk.level = 3;

/** 把一段 markdown 文本解析为 inline tokens（取首段 paragraph 的 tokens）。 */
function parseInline(text: string) {
  const tokens = marked.lexer(text);
  const first = tokens[0];
  if (first && first.type === "paragraph" && first.tokens) {
    return first.tokens;
  }
  return [];
}

describe("renderInline · text", () => {
  it("plain text 字面输出（不染色）", () => {
    const tokens = parseInline("hello world");
    const out = renderInlines(tokens, "render");
    expect(out).toBe("hello world");
  });
});

describe("renderInline · strong", () => {
  it("**bold** 走 chalk.bold", () => {
    const tokens = parseInline("**bold**");
    const out = renderInlines(tokens, "render");
    expect(out).toBe(chalk.bold("bold"));
    expect(stripAnsi(out)).toBe("bold");
  });

  it("strong 内嵌 em 递归渲染", () => {
    const tokens = parseInline("**bold _and italic_**");
    const out = renderInlines(tokens, "render");
    // strip 后等价于嵌套文本
    expect(stripAnsi(out)).toBe("bold and italic");
    // 含粗体 ANSI
    expect(out).toContain("\x1b[1m");
  });

  it("strip 模式仅原文不染色", () => {
    const tokens = parseInline("**bold**");
    const out = renderInlines(tokens, "strip");
    expect(out).toBe("bold");
  });
});

describe("renderInline · em", () => {
  it("_italic_ 走 chalk.italic", () => {
    const tokens = parseInline("_italic_");
    const out = renderInlines(tokens, "render");
    expect(out).toBe(chalk.italic("italic"));
  });
});

describe("renderInline · codespan", () => {
  it("`code` 走中深灰底（bgAnsi256(238)）+ **默认前景**——路径 / 命令最大可读性", () => {
    const tokens = parseInline("`some code`");
    const out = renderInlines(tokens, "render");
    // 视觉契约：bg 块给"内容引用"视觉锚 + 默认前景给所有终端配色高对比。
    // 不再用 chalk.cyan—— brand cyan 仅用于选中 / 品牌 / 主操作（design language P5），
    // codespan 是事实引用、属信息内容，按 tone.dim 注释原则"路径用 dim 系"。
    expect(out).toBe(chalk.bgAnsi256(238)("some code"));
    expect(stripAnsi(out)).toBe("some code");
    // 反向断言：codespan 前景不应叠 cyan（brand 误用回归屏障）
    expect(out).not.toContain("\x1b[36m"); // chalk.cyan 起手 SGR
  });

  it("codespan 与 historyEcho（bgAnsi256(236)）同灰族但不同值——视觉同源 + 可辨识", () => {
    // historyEcho 是行级 bg（用户消息锚），codespan 是 token 级 bg（内容引用）;
    // 同 ansi-256 灰族但差 0x14 让两种 bg 在视觉上能被区分（避免混淆为同一语义）
    const tokens = parseInline("`x`");
    const out = renderInlines(tokens, "render");
    expect(out).not.toBe(chalk.bgAnsi256(236)("x"));
  });

  it("codespan 内部不递归 inline——backticks 内是字面字符", () => {
    // marked 把 `**not bold**` 整体当字面 codespan 文字
    const tokens = parseInline("`**not bold**`");
    const out = renderInlines(tokens, "render");
    expect(stripAnsi(out)).toBe("**not bold**");
  });

  it("strip 模式 codespan 不加底色", () => {
    const tokens = parseInline("`code`");
    const out = renderInlines(tokens, "strip");
    expect(out).toBe("code");
  });
});

describe("renderInline · link", () => {
  it("[text](url) 走 OSC 8 超链接，visible text 叠 cyan + 虚线下划线（dotted SGR 4:4）", () => {
    const tokens = parseInline("[example](https://example.com)");
    const out = renderInlines(tokens, "render");
    // OSC 8 起首 / 终结序列
    expect(out).toContain("\x1b]8;;https://example.com\x1b\\");
    expect(out).toContain("\x1b]8;;\x1b\\");
    // 虚线下划线 SGR `4:4`（区别于 chalk 单实线 `4`）
    expect(out).toContain("\x1b[4:4m");
    expect(out).toContain("\x1b[24m");
    // cyan 文字色（chalk.cyan 起手 \x1b[36m）
    expect(out).toContain("\x1b[36m");
    // 文字未消失
    expect(stripAnsi(out)).toBe("example");
  });

  it("link 装饰用扩展 SGR 4:4（dotted）而非 chalk 单实线 underline 4", () => {
    const tokens = parseInline("[x](https://x.io)");
    const out = renderInlines(tokens, "render");
    expect(out).toContain("\x1b[4:4m");
    // 不应出现 chalk.underline 的单实线序列（独立 4 不带 `:`）
    expect(out).not.toContain("\x1b[4mx");
  });

  it("strip 模式 link 输出 `text (url)` plain", () => {
    const tokens = parseInline("[example](https://example.com)");
    const out = renderInlines(tokens, "strip");
    expect(out).toBe("example (https://example.com)");
  });

  it("text == url 时 strip 模式不重复输出", () => {
    const tokens = parseInline("[https://example.com](https://example.com)");
    const out = renderInlines(tokens, "strip");
    expect(out).toBe("https://example.com");
  });
});

describe("renderInline · del", () => {
  it("~~del~~ 走 chalk.strikethrough", () => {
    const tokens = parseInline("~~deleted~~");
    const out = renderInlines(tokens, "render");
    expect(out).toBe(chalk.strikethrough("deleted"));
  });
});

describe("renderInline · br", () => {
  it("强制 \\n 起手——markdown 双空格 + \\n 软换行", () => {
    // marked 的 br 来自双空格 + \n
    const tokens = parseInline("line1  \nline2");
    const out = renderInlines(tokens, "render");
    expect(stripAnsi(out)).toContain("line1");
    expect(stripAnsi(out)).toContain("\n");
    expect(stripAnsi(out)).toContain("line2");
  });
});

describe("renderInline · 混合 + 整段", () => {
  it("text + strong + em + codespan + link 混合", () => {
    const tokens = parseInline(
      "click **here** to see _this_ `code` or [docs](https://x.io)",
    );
    const out = renderInlines(tokens, "render");
    const stripped = stripAnsi(out);
    expect(stripped).toContain("click ");
    expect(stripped).toContain("here");
    expect(stripped).toContain("this");
    expect(stripped).toContain("code");
    expect(stripped).toContain("docs");
  });

  it("strip 模式整段无 ANSI", () => {
    const tokens = parseInline(
      "click **here** to see _this_ `code` or [docs](https://x.io)",
    );
    const out = renderInlines(tokens, "strip");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("here");
    expect(out).toContain("docs (https://x.io)");
  });
});

describe("renderInline · raw 模式", () => {
  it("raw 模式直接返回 token.raw", () => {
    const tokens = parseInline("**bold**");
    const out = renderInlines(tokens, "raw");
    expect(out).toBe("**bold**");
  });

  it("raw 模式整段保留原 markdown 标记", () => {
    const tokens = parseInline(
      "click **here** [docs](https://x.io)",
    );
    const out = renderInlines(tokens, "raw");
    expect(out).toContain("**here**");
    expect(out).toContain("[docs](https://x.io)");
  });
});

describe("renderInline · 未识别类型 fallback", () => {
  it("未知 token 类型 fallback 到 token.raw 不丢失内容", () => {
    const fakeToken = {
      type: "image" as const,
      raw: "![alt](pic.png)",
      href: "pic.png",
      title: null,
      text: "alt",
    };
    const out = renderInline(fakeToken as never, "render");
    expect(out).toBe("![alt](pic.png)");
  });
});
