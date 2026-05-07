import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { MarkdownStream } from "../markdown-stream.js";
import { stripAnsi } from "../../../tui/ansi.js";
import { layout } from "../../../tui/style.js";

// 强制启用 ANSI 染色，与 block-renderer.test.ts 一致——非 TTY 下 chalk 自动降级，
// 通过 chalk.level=3 让 strip 模式的"无 ANSI"断言有意义
chalk.level = 3;

const PREFIX = layout.contentPrefix;

interface Capture {
  appendInline: string[];
  line: string[];
  /** 时序合成视图——按调用顺序拼接 appendInline / line 的内容 */
  combined: string;
}

function makeStream(opts?: { columns?: number; mode?: "render" | "strip" | "raw" }) {
  const out: Capture = { appendInline: [], line: [], combined: "" };
  const stream = new MarkdownStream({
    appendInline: (chunk) => {
      out.appendInline.push(chunk);
      out.combined += chunk;
    },
    line: (text) => {
      out.line.push(text);
      out.combined += text;
    },
    columns: opts?.columns ?? 80,
    mode: opts?.mode ?? "render",
  });
  return { stream, out };
}

describe("MarkdownStream · 段落（paragraph）字符流式", () => {
  it("单段普通文字 chunk 流式 forward 给 TextStream（appendInline）", () => {
    const { stream, out } = makeStream();
    stream.feed("hello ");
    stream.feed("world");
    stream.end();
    // paragraph 走 appendInline 路径（流式接续）
    expect(out.appendInline.length).toBeGreaterThan(0);
    expect(stripAnsi(out.combined)).toContain("hello world");
  });

  it("end() 写末尾 \\n 让段独立落地", () => {
    const { stream, out } = makeStream();
    stream.feed("hello");
    stream.end();
    expect(out.combined.endsWith("\n")).toBe(true);
  });

  it("段落分隔（\\n\\n）切到新段，闭合的前段不重复 emit", () => {
    const { stream, out } = makeStream();
    stream.feed("first paragraph.\n\nsecond paragraph.");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("first paragraph.");
    expect(stripped).toContain("second paragraph.");
    // 不应重复出现
    expect((stripped.match(/first paragraph\./g) ?? []).length).toBe(1);
    expect((stripped.match(/second paragraph\./g) ?? []).length).toBe(1);
  });

  it("多段连续 paragraph 共享一个 ◆ 锚——段间用 \\n\\n hanging 续行（无新锚）", () => {
    const { stream, out } = makeStream();
    stream.feed("段1\n\n段2\n\n段3");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 整个 turn 内只起 1 次 ◆ 锚——多段共享同一 TextStream
    const anchorCount = (stripped.match(/◆/g) ?? []).length;
    expect(anchorCount).toBe(1);
    expect(stripped).toContain("段1");
    expect(stripped).toContain("段2");
    expect(stripped).toContain("段3");
  });

  it("paragraph 之间夹 heading（字面 forward 策略）→ heading 字面字符与段同流，仅一个 ◆ 锚", () => {
    const { stream, out } = makeStream();
    stream.feed("段1\n\n# 标题\n\n段2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 当前策略 heading 字面 forward（避免 hold 卡住），与 paragraph 共享 paragraphStream，
    // ◆ 锚只起一次。heading / list / blockquote / hr 的 ANSI 视觉留给后续 step
    const anchorCount = (stripped.match(/◆/g) ?? []).length;
    expect(anchorCount).toBe(1);
    expect(stripped).toContain("# 标题");
  });

  it("paragraph 之间夹 code block → code block 走 ANSI emit + 关闭 paragraph 流，code 后段重新起锚", () => {
    const { stream, out } = makeStream();
    stream.feed("段1\n\n```\nconst x = 1\n```\n\n段2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 仅 code block 走 hold + ANSI emit + closeParagraphStream → code 后的段是新 paragraph 流
    const anchorCount = (stripped.match(/◆/g) ?? []).length;
    expect(anchorCount).toBe(2);
    expect(stripped).toContain("const x = 1");
    expect(stripped).toContain("段1");
    expect(stripped).toContain("段2");
  });
});

describe("MarkdownStream · 闭合 block 处理", () => {
  it("heading 字面 forward（不走 ANSI emit）—— 与 paragraph 同流，包含 # 标题字面字符", () => {
    const { stream, out } = makeStream();
    stream.feed("# Title\n\nbody.");
    stream.end();
    // 字面 forward 策略：heading 不走 line() 独立段，整体进 appendInline 流
    const headingLines = out.line.filter((s) => stripAnsi(s).includes("Title"));
    expect(headingLines.length).toBe(0);
    expect(stripAnsi(out.combined)).toContain("# Title");
    expect(stripAnsi(out.combined)).toContain("body.");
  });

  it("代码块闭合后 dim 文字独立段输出，line 调用契约：起首 \\n + 列 2 缩进 + 末尾 \\n", () => {
    const { stream, out } = makeStream();
    stream.feed("```\nconst x = 1\n```\n\n");
    stream.end();
    // 找到承载代码内容的 line() 调用（独立段）
    const codeLines = out.line.filter((s) => stripAnsi(s).includes("const x = 1"));
    expect(codeLines.length).toBe(1);
    const stripped = stripAnsi(codeLines[0]!);
    // 契约：起首 \n（用于与上一段拼接成空行分隔）+ 列 2 缩进 + 末尾 \n
    expect(stripped).toMatch(/^\n  const x = 1\n$/);
  });

  it("列表字面 forward（不走 ANSI · 中点）—— 整体字面字符避免 hold 卡住", () => {
    const { stream, out } = makeStream();
    stream.feed("- item1\n- item2\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 字面 forward 策略：列表保留原始 `- item` markdown 标记字符，无 · 中点 ANSI 渲染
    expect(stripped).toContain("- item1");
    expect(stripped).toContain("- item2");
    // 不应出现 ANSI 列表渲染产物
    expect(stripped).not.toContain("· item1");
  });
});

describe("MarkdownStream · 流式跨 chunk 边界", () => {
  it("不闭合的代码块 hold 直到 ``` 出现", () => {
    const { stream, out } = makeStream();
    stream.feed("```\nconst x");
    // 此时代码块未闭合——不应有任何 emit
    expect(out.combined).toBe("");
    stream.feed(" = 1\n```\n\n");
    expect(stripAnsi(out.combined)).toContain("const x = 1");
  });

  it("末尾 heading（非 code）字面 forward——立即可见，不卡 streaming", () => {
    const { stream, out } = makeStream();
    stream.feed("# Title");
    // heading 不再 hold，字面 forward 给 paragraph 流让用户立即看到 "# Title"
    expect(stripAnsi(out.combined)).toContain("# Title");
    stream.end();
  });

  it("末尾 list 字面 forward——立即可见，避免 LLM 写长列表时用户看不到", () => {
    const { stream, out } = makeStream();
    stream.feed("- item1\n- item2");
    expect(stripAnsi(out.combined)).toContain("- item1");
    expect(stripAnsi(out.combined)).toContain("- item2");
    stream.end();
  });

  it("末尾 blockquote 字面 forward", () => {
    const { stream, out } = makeStream();
    stream.feed("> quoted text");
    expect(stripAnsi(out.combined)).toContain("> quoted text");
    stream.end();
  });

  it("paragraph 跨 chunk 字符流式 forward——chunk 之间增量推送", () => {
    const { stream, out } = makeStream();
    stream.feed("Hello ");
    const after1 = out.combined;
    expect(stripAnsi(after1)).toContain("Hello");

    stream.feed("world.");
    const after2 = out.combined;
    expect(stripAnsi(after2)).toContain("Hello world.");
    // chunk 增量不重复发送已 forward 的内容
    expect(stripAnsi(after2.slice(after1.length))).toContain("world.");
    expect(stripAnsi(after2.slice(after1.length))).not.toContain("Hello");
  });
});

describe("MarkdownStream · 三档模式", () => {
  it("strip 模式不输出 ANSI 颜色", () => {
    const { stream, out } = makeStream({ mode: "strip" });
    stream.feed("# Title\n\nbody.\n\n```\ncode\n```\n\n");
    stream.end();
    expect(out.combined).not.toContain("[");
    expect(out.combined).toContain("Title");
    expect(out.combined).toContain("code");
  });

  it("raw 模式直接 forward 原文（不解析）", () => {
    const { stream, out } = makeStream({ mode: "raw" });
    stream.feed("# Title\n\n**bold** text");
    stream.end();
    // raw 模式保留所有 markdown 标记字面
    expect(out.combined).toContain("# Title");
    expect(out.combined).toContain("**bold**");
    expect(out.combined).not.toContain("[");
  });
});

describe("MarkdownStream · 边缘场景", () => {
  it("空 chunk 不触发任何输出", () => {
    const { stream, out } = makeStream();
    stream.feed("");
    expect(out.combined).toBe("");
  });

  it("空 buffer end() 不输出", () => {
    const { stream, out } = makeStream();
    stream.end();
    expect(out.combined).toBe("");
  });

  it("混合内容：标题 + 段落 + 代码块 + 列表 全流程（heading/list 字面，code ANSI）", () => {
    const { stream, out } = makeStream();
    stream.feed("# Heading\n\n");
    stream.feed("Paragraph text.\n\n");
    stream.feed("```\nconst x = 1\n```\n\n");
    stream.feed("- item1\n- item2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // heading 字面（含 # 标记）
    expect(stripped).toContain("# Heading");
    // paragraph 字面文字
    expect(stripped).toContain("Paragraph text.");
    // code block 走 ANSI 渲染（无 ``` 字面字符在输出里——已被 ANSI emit 替换）
    expect(stripped).toContain("const x = 1");
    expect(stripped).not.toContain("```");
    // list 字面（含 - 标记，无 · 中点）
    expect(stripped).toContain("- item1");
    expect(stripped).toContain("- item2");
    expect(stripped).not.toContain("· item1");
  });
});
