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

  it("paragraph 之间夹 heading → heading 走 ANSI emit 独立段，code/heading 后段重新起锚", () => {
    const { stream, out } = makeStream();
    stream.feed("段1\n\n# 标题\n\n段2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // heading 闭合走 line 独立段——关 paragraph 流；段2 重新起 ◆ 锚——共 2 锚
    const anchorCount = (stripped.match(/◆/g) ?? []).length;
    expect(anchorCount).toBe(2);
    // # 字面标记不再泄露——renderBlock 已替换为 ANSI bold
    expect(stripped).not.toContain("# 标题");
    expect(stripped).toContain("标题");
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
  it("heading 闭合走 ANSI emit 独立段 line()——# 字面字符不泄露，文字 bold 染色", () => {
    const { stream, out } = makeStream();
    stream.feed("# Title\n\nbody.");
    stream.end();
    // heading 走 line() 独立段 ANSI emit
    const headingLines = out.line.filter((s) => stripAnsi(s).includes("Title"));
    expect(headingLines.length).toBe(1);
    // # 字面标记被替换；文字仍可读
    expect(stripAnsi(out.combined)).not.toContain("# Title");
    expect(stripAnsi(out.combined)).toContain("Title");
    expect(stripAnsi(out.combined)).toContain("body.");
    // depth=1 brand cyan + bold —— 含 cyan SGR
    expect(headingLines[0]!).toContain("\x1b[36m");
    expect(headingLines[0]!).toContain("\x1b[1m");
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

  it("list 闭合走 ANSI · 中点 marker 独立段——- 字面标记不泄露", () => {
    const { stream, out } = makeStream();
    stream.feed("- item1\n- item2\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // ANSI 渲染：· 中点 marker + 文字
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    // - 字面标记被替换
    expect(stripped).not.toContain("- item1");
    // 走 line 独立段
    const listLines = out.line.filter((s) => stripAnsi(s).includes("· item1"));
    expect(listLines.length).toBe(1);
  });

  it("blockquote 闭合走 ANSI dim 整段—— > 字面标记不泄露", () => {
    const { stream, out } = makeStream();
    stream.feed("> quoted text\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("quoted text");
    expect(stripped).not.toContain("> quoted");
    // dim ANSI 染色
    expect(out.combined).toContain("\x1b[2m");
  });

  it("hr 闭合走 ANSI dim 横线—— --- 字面标记不泄露", () => {
    const { stream, out } = makeStream();
    stream.feed("---\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("─"); // U+2500 box drawing
    expect(stripped).not.toContain("---");
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

  it("末尾未闭合 heading hold——闭合后才 emit ANSI，字面 # 标记不泄露", () => {
    const { stream, out } = makeStream();
    stream.feed("# Title");
    // marked 在 chunk = "# Title" 时识别为 paragraph (text="# Title")—— paragraph
    // 末尾 inline hold 路径覆盖（已不 emit 任何字符）。chunk 加 \n\n 才闭合为 heading
    expect(out.combined).toBe("");
    stream.feed("\n\n");
    expect(stripAnsi(out.combined)).toContain("Title");
    expect(stripAnsi(out.combined)).not.toContain("# Title");
    stream.end();
  });

  it("末尾未闭合 list hold（默认无 segment factory）——闭合后才 ANSI emit", () => {
    const { stream, out } = makeStream();
    stream.feed("- item1\n- item2");
    // 默认无 segment factory —— hold 不 emit
    expect(out.combined).toBe("");
    // 闭合：双 \n 让 list 不再末尾
    stream.feed("\n\nfoo");
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    expect(stripped).not.toContain("- item1");
    stream.end();
  });

  it("末尾未闭合 blockquote hold——闭合后 ANSI emit", () => {
    const { stream, out } = makeStream();
    stream.feed("> quoted text");
    expect(out.combined).toBe("");
    stream.feed("\n\nfoo");
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("quoted text");
    expect(stripped).not.toContain("> quoted");
    stream.end();
  });

  it("paragraph 跨 chunk —— 末尾未闭合 hold（含 text）、闭合后整段 ANSI emit", () => {
    const { stream, out } = makeStream();
    stream.feed("Hello ");
    // 末尾未闭合 paragraph hold——即使是纯 text 也 hold（避免后续 inline 起首
    // 字符与 ANSI 渲染冲突）
    expect(out.combined).toBe("");

    stream.feed("world.");
    // 仍未闭合（无 \n\n）—— 仍 hold
    expect(out.combined).toBe("");

    stream.feed("\n\n");
    // 闭合后整段 emit
    expect(stripAnsi(out.combined)).toContain("Hello world.");
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

  it("混合内容：标题 + 段落 + 代码块 + 列表 全流程 ANSI 渲染—— markdown 标记不泄露", () => {
    const { stream, out } = makeStream();
    stream.feed("# Heading\n\n");
    stream.feed("Paragraph text.\n\n");
    stream.feed("```\nconst x = 1\n```\n\n");
    stream.feed("- item1\n- item2\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 文字内容保留
    expect(stripped).toContain("Heading");
    expect(stripped).toContain("Paragraph text.");
    expect(stripped).toContain("const x = 1");
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    // 字面 markdown 标记全部不泄露
    expect(stripped).not.toContain("# Heading");
    expect(stripped).not.toContain("```");
    expect(stripped).not.toContain("- item1");
  });
});

describe("MarkdownStream · paragraph inline ANSI 渲染", () => {
  it("闭合 paragraph 含 **bold** —— 输出 chalk.bold ANSI 序列、不出现 ** 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("hello **bold** end\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 字面 ** 不应残留——已被 ANSI bold emit 替换
    expect(stripped).not.toContain("**");
    // 视觉文字保留
    expect(stripped).toContain("hello bold end");
    // ANSI bold 序列存在
    expect(out.combined).toContain(chalk.bold("bold"));
  });

  it("闭合 paragraph 含 _italic_ —— 输出 chalk.italic ANSI 序列、不出现 _ 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("see _emphasis_ here\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).not.toContain("_emphasis_");
    expect(stripped).toContain("see emphasis here");
    expect(out.combined).toContain(chalk.italic("emphasis"));
  });

  it("闭合 paragraph 含 `codespan` —— 输出 cyan + bgAnsi256(245) 中灰底 ANSI、不出现 backtick 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("run `npm install` to start\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).not.toContain("`");
    expect(stripped).toContain("run npm install to start");
    expect(out.combined).toContain(chalk.bgAnsi256(245).cyan("npm install"));
  });

  it("闭合 paragraph 含 [text](url) —— OSC 8 + cyan + 虚线下划线、不出现 markdown 链接字面", () => {
    const { stream, out } = makeStream();
    stream.feed("see [docs](https://x.io) for more\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // markdown 链接字面 [docs](url) 不残留
    expect(stripped).not.toContain("[docs]");
    expect(stripped).not.toContain("(https://x.io)");
    // 视觉文字保留
    expect(stripped).toContain("see docs for more");
    // OSC 8 终端超链接序列
    expect(out.combined).toContain("\x1b]8;;https://x.io\x1b\\");
    // 虚线下划线 SGR 4:4 + cyan 文字色
    expect(out.combined).toContain("\x1b[4:4m");
    expect(out.combined).toContain("\x1b[36m");
  });

  it("闭合 paragraph 含 ~~del~~ —— 输出 chalk.strikethrough、不出现 ~~ 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("status ~~old~~ new\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).not.toContain("~~");
    expect(stripped).toContain("status old new");
    expect(out.combined).toContain(chalk.strikethrough("old"));
  });

  it("混合 inline 元素 paragraph —— text + strong + em + codespan + link 全部 ANSI", () => {
    const { stream, out } = makeStream();
    stream.feed(
      "click **here** to see _this_ `code` or [docs](https://x.io)\n\n",
    );
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 字面标记全无
    expect(stripped).not.toContain("**");
    expect(stripped).not.toContain("`");
    expect(stripped).not.toContain("[docs]");
    // 视觉文字全保留
    expect(stripped).toContain("click here to see this code or docs");
    // 各 ANSI 序列存在
    expect(out.combined).toContain(chalk.bold("here"));
    expect(out.combined).toContain(chalk.italic("this"));
    expect(out.combined).toContain(chalk.bgAnsi256(245).cyan("code"));
    expect(out.combined).toContain("\x1b]8;;https://x.io\x1b\\");
    // link 用 dotted 4:4（不是 chalk 单实线 underline 4）
    expect(out.combined).toContain("\x1b[4:4m");
  });

  it("跨 chunk strong 闭合 —— 末尾未闭合 paragraph hold、闭合后整段 ANSI emit", () => {
    const { stream, out } = makeStream();
    stream.feed("hello **bo");
    // 末尾 paragraph 未闭合——marked 把 "hello **bo" 整段当 text（** 不闭合不识别为
    // strong）。按新策略末尾未闭合 inline 一律 hold——不出现任何字符避免后续 ANSI
    // 渲染冲突
    expect(out.combined).toBe("");

    stream.feed("ld** end\n\n");
    stream.end();
    const stripped2 = stripAnsi(out.combined);
    expect(stripped2).toContain("hello bold end");
    expect(stripped2).not.toContain("**");
    // 闭合后 ANSI bold 序列出现
    expect(out.combined).toContain(chalk.bold("bold"));
  });

  it("跨 chunk 纯文本 paragraph —— 末尾未闭合 hold、闭合后整段 emit（与字面 forward 不同）", () => {
    const { stream, out } = makeStream();
    stream.feed("Hello ");
    // 末尾未闭合 paragraph hold——付出"末尾段不流式"的代价换"闭合后 inline ANSI 正确"
    expect(out.combined).toBe("");
    stream.feed("world\n\n");
    expect(stripAnsi(out.combined)).toContain("Hello world");
    stream.end();
  });

  it("中段闭合 + 末尾未闭合 —— 闭合段立即 ANSI、末尾段 hold 直到闭合", () => {
    const { stream, out } = makeStream();
    stream.feed("first **bold** done\n\n");
    // 第一段闭合——立即 ANSI emit
    const stripped1 = stripAnsi(out.combined);
    expect(stripped1).toContain("first bold done");
    expect(stripped1).not.toContain("**");
    expect(out.combined).toContain(chalk.bold("bold"));

    // 起首第二段未闭合——内容 hold（仅 \n\n 段落分隔字符可能在 space token 处理时
    // forward 给 paragraph 流，但段实际文字不 emit）
    const beforeFeed = out.combined.length;
    stream.feed("second start");
    expect(stripAnsi(out.combined.slice(beforeFeed))).not.toContain("second start");

    // 第二段闭合——一次性 emit
    stream.feed(" ok\n\n");
    stream.end();
    expect(stripAnsi(out.combined)).toContain("second start ok");
  });

  it("paragraph + code block 混合 —— paragraph 走 inline ANSI、code 走 block ANSI 独立", () => {
    const { stream, out } = makeStream();
    stream.feed("intro **bold**\n\n```\nconst x = 1\n```\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // paragraph inline ANSI
    expect(stripped).toContain("intro bold");
    expect(stripped).not.toContain("**");
    expect(out.combined).toContain(chalk.bold("bold"));
    // code block 独立段
    expect(stripped).toContain("const x = 1");
  });

  it("strip 模式 paragraph 含 inline —— 文字保留、无 ANSI、链接退化为 `text (url)`", () => {
    const { stream, out } = makeStream({ mode: "strip" });
    stream.feed(
      "**bold** + _em_ + `code` + [docs](https://x.io)\n\n",
    );
    stream.end();
    expect(out.combined).not.toContain("\x1b");
    // 视觉文字（无标记）
    expect(out.combined).toContain("bold");
    expect(out.combined).toContain("em");
    expect(out.combined).toContain("code");
    // link 退化为 text (url)
    expect(out.combined).toContain("docs (https://x.io)");
  });

  it("raw 模式 paragraph 不解析 inline —— ** / ` / [text](url) 字面保留", () => {
    const { stream, out } = makeStream({ mode: "raw" });
    stream.feed("**bold** + `code` + [docs](https://x.io)\n\n");
    stream.end();
    expect(out.combined).toContain("**bold**");
    expect(out.combined).toContain("`code`");
    expect(out.combined).toContain("[docs](https://x.io)");
    expect(out.combined).not.toContain("\x1b");
  });
});

interface SegmentEvent {
  readonly kind: "begin" | "replace" | "commit" | "close";
  readonly text?: string;
}

function makeStreamWithSegment(opts?: {
  columns?: number;
  mode?: "render" | "strip" | "raw";
}) {
  const out: Capture = { appendInline: [], line: [], combined: "" };
  const segments: SegmentEvent[][] = [];
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
    beginReplaceableSegment: () => {
      const events: SegmentEvent[] = [{ kind: "begin" }];
      segments.push(events);
      return {
        replace: (text) => events.push({ kind: "replace", text }),
        commit: (text) => events.push({ kind: "commit", text }),
        close: () => events.push({ kind: "close" }),
      };
    },
  });
  return { stream, out, segments };
}

describe("MarkdownStream · code block 双态渲染", () => {
  it("fenced + lang：流式期 segment.replace 用 dim 占位、闭合时 commit 切 highlight", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("```typescript\nconst x =");
    stream.feed(" 1\nconst y = 2\n```\n\n");
    stream.end();

    expect(segments).toHaveLength(1);
    const events = segments[0]!;
    // 必含 begin → ≥1 次 replace（流式）→ commit
    expect(events[0]!.kind).toBe("begin");
    const replaceCount = events.filter((e) => e.kind === "replace").length;
    const commitCount = events.filter((e) => e.kind === "commit").length;
    expect(replaceCount).toBeGreaterThanOrEqual(1);
    expect(commitCount).toBe(1);
    // 流式期 replace 的内容是 dim（无 highlight 颜色），最后 commit 内容含
    // typescript 关键字色（cli-highlight + 自定义 theme）
    const lastReplace = events.filter((e) => e.kind === "replace").at(-1)!;
    expect(lastReplace.text).toContain("\x1b[2m"); // dim
    const commit = events.find((e) => e.kind === "commit")!;
    expect(commit.text).toContain("const"); // 内容
    expect(commit.text).toMatch(/\x1b\[\d+m/); // 含 SGR
    // commit 不仅是 dim——含其他颜色 SGR
    const commitAnsi = (commit.text!.match(/\x1b\[\d+m/g) ?? []);
    const uniqueParams = new Set(commitAnsi);
    expect(uniqueParams.size).toBeGreaterThan(1);
    // 双态期 line 路径不被调用（segment 替代 line emit）
    expect(out.line.filter((t) => t.includes("const")).length).toBe(0);
  });

  it("indented code（无 lang）退化 hold——不开 segment、走 line 路径", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    // 4 空格缩进的 indented code
    stream.feed("paragraph above\n\n    indented code line 1\n    indented code line 2\n\nparagraph below\n\n");
    stream.end();
    // 不应开 segment——marked 把 indented 识别为 code 但 lang 是 undefined
    expect(segments).toHaveLength(0);
    // 走 line 路径
    expect(out.line.some((t) => t.includes("indented code"))).toBe(true);
  });

  it("无 lang 的 fenced code 退化 hold——避免无差异语法着色", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("```\nplain code\n```\n\n");
    stream.end();
    // marked 把 ``` 后无 lang 的 fenced 仍标记为 code，lang 为空字符串而非
    // undefined——双态启用条件需 lang !== undefined，空字符串属 undefined 之外
    // （实测：marked 给 lang=""）。所以双态应启用——这测试是给 caller 说明
    // 边界：fenced 不带 lang 时 cli-highlight 退化 dim，但仍走双态流式渲染
    if (segments.length > 0) {
      const events = segments[0]!;
      const commit = events.find((e) => e.kind === "commit");
      // commit 内容应含 dim（无 lang fallback）
      expect(commit?.text).toContain("\x1b[2m");
    } else {
      // 若 marked 给的是 lang=undefined（不太可能），走 hold 路径——也接受
      expect(out.line.some((t) => t.includes("plain code"))).toBe(true);
    }
  });

  it("StdoutWriter 场景：未注入 beginReplaceableSegment → 退化 hold", () => {
    // 不传 beginReplaceableSegment 字段，等同 StdoutWriter 模式
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
      columns: 80,
      mode: "render",
      // beginReplaceableSegment 未注入
    });
    stream.feed("```typescript\nconst x = 1\n```\n\n");
    stream.end();
    // 应走 hold 路径——line 被调用 + line 内容含 highlight
    expect(out.line.some((t) => t.includes("const"))).toBe(true);
  });

  it("strip 模式不启用双态——code 走 hold + line（即使 fenced + lang）", () => {
    const { stream, segments, out } = makeStreamWithSegment({ mode: "strip" });
    stream.feed("```typescript\nconst x = 1\n```\n\n");
    stream.end();
    expect(segments).toHaveLength(0);
    // strip 路径走 line/appendInline——code 内容应到达 caller
    expect(stripAnsi(out.combined)).toContain("const x = 1");
  });

  it("raw 模式不启用双态——原文 forward 不解析", () => {
    const { stream, segments, out } = makeStreamWithSegment({ mode: "raw" });
    stream.feed("```typescript\nconst x = 1\n```\n\n");
    stream.end();
    expect(segments).toHaveLength(0);
    expect(out.combined).toContain("```typescript");
    expect(out.combined).toContain("const x = 1");
  });

  it("EOF 时未闭合的 fenced code 仍触发 commit（marked 在 EOF 视作闭合）", () => {
    const { stream, segments } = makeStreamWithSegment();
    // 不闭合 ``` —— end() 触发 EOF
    stream.feed("```typescript\nconst x = ");
    stream.feed("1\n");
    stream.end();
    expect(segments).toHaveLength(1);
    const events = segments[0]!;
    expect(events.some((e) => e.kind === "commit")).toBe(true);
  });

  it("多个连续 fenced code block 各自 begin + commit（跨 chunk 流式）", () => {
    const { stream, segments } = makeStreamWithSegment();
    // 拆 chunk 让 fenced 跨 chunk—— segment 仅在流式中间态时有意义
    stream.feed("```typescript\n");
    stream.feed("const x = 1\n");
    stream.feed("```\n\n```python\n");
    stream.feed("print('y')\n");
    stream.feed("```\n\n");
    stream.end();
    expect(segments).toHaveLength(2);
    expect(segments[0]!.some((e) => e.kind === "commit")).toBe(true);
    expect(segments[1]!.some((e) => e.kind === "commit")).toBe(true);
  });

  it("paragraph → fenced code → paragraph：paragraph 流先关 + segment begin 顺序对", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("hello\n\n");
    stream.feed("```typescript\n");
    stream.feed("const x = 1\n");
    stream.feed("```\n\n");
    stream.feed("world\n\n");
    stream.end();
    expect(segments).toHaveLength(1);
    expect(stripAnsi(out.combined)).toContain("hello");
    expect(stripAnsi(out.combined)).toContain("world");
    // commit 内容含代码
    const commit = segments[0]!.find((e) => e.kind === "commit");
    expect(stripAnsi(commit?.text ?? "")).toContain("const x = 1");
  });

  it("单 chunk 完整闭合的 fenced code 走 hold（无中间态可流式）→ line 路径", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    // 整 chunk 含 ``` 闭合——marked 一次 lex 给 closed code token，
    // 不进入 handleOpenBlock（末尾是 space），走 emitClosedBlock 的 line 路径
    stream.feed("```typescript\nconst x = 1\n```\n\n");
    stream.end();
    expect(segments).toHaveLength(0);
    expect(out.line.some((t) => t.includes("const"))).toBe(true);
  });

  it("流式期多次 replace 反映代码累积——每次 chunk 一次 replace", () => {
    const { stream, segments } = makeStreamWithSegment();
    stream.feed("```typescript\n");
    stream.feed("const x = 1\n");
    stream.feed("const y = 2\n");
    stream.feed("```\n\n");
    stream.end();
    const events = segments[0]!;
    const replaceTexts = events
      .filter((e) => e.kind === "replace")
      .map((e) => stripAnsi(e.text ?? ""));
    // 多次 replace 内容单调累积（后一次 replace 含前一次的内容）
    expect(replaceTexts.length).toBeGreaterThanOrEqual(2);
    // 最后一次 replace 含两行；中间某次至少含 const x = 1
    expect(replaceTexts.at(-1)!).toContain("const x = 1");
    expect(replaceTexts.at(-1)!).toContain("const y = 2");
  });
});

describe("MarkdownStream · list 流式（ReplaceableSegment 复用）", () => {
  it("list 跨 chunk：流式期 segment.replace 整段、闭合时 commit", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("- item 1\n");
    stream.feed("- item 2\n");
    stream.feed("- item 3\n\n");
    stream.end();

    expect(segments).toHaveLength(1);
    const events = segments[0]!;
    expect(events[0]!.kind).toBe("begin");
    const replaceCount = events.filter((e) => e.kind === "replace").length;
    const commitCount = events.filter((e) => e.kind === "commit").length;
    expect(replaceCount).toBeGreaterThanOrEqual(1);
    expect(commitCount).toBe(1);
    // commit 整段含全部 items 的 ANSI 渲染
    const commit = events.find((e) => e.kind === "commit");
    const stripped = stripAnsi(commit?.text ?? "");
    expect(stripped).toContain("· item 1");
    expect(stripped).toContain("· item 2");
    expect(stripped).toContain("· item 3");
    // 双态期 line 路径不被调用（segment 替代）
    expect(out.line.filter((t) => stripAnsi(t).includes("· item")).length).toBe(0);
  });

  it("流式期多次 replace 反映 items 累积——末次 replace 与 commit 共同覆盖全部 items", () => {
    const { stream, segments } = makeStreamWithSegment();
    stream.feed("- a\n");
    stream.feed("- b\n");
    stream.feed("- c\n\nfoo");
    stream.end();
    const events = segments[0]!;
    const replaceTexts = events
      .filter((e) => e.kind === "replace")
      .map((e) => stripAnsi(e.text ?? ""));
    const commit = events.find((e) => e.kind === "commit");
    // 至少 2 次 replace（chunk 1 + chunk 2 list 仍是末尾 token）
    expect(replaceTexts.length).toBeGreaterThanOrEqual(2);
    // 最后一次 replace 累积到 a, b（c 在 chunk 3 中 list 已闭合 → 走 commit 而非 replace）
    expect(replaceTexts.at(-1)!).toContain("· a");
    expect(replaceTexts.at(-1)!).toContain("· b");
    // commit 含全部 items
    expect(stripAnsi(commit?.text ?? "")).toContain("· a");
    expect(stripAnsi(commit?.text ?? "")).toContain("· b");
    expect(stripAnsi(commit?.text ?? "")).toContain("· c");
  });

  it("单 chunk 完整闭合的 list 走 hold（无中间态）→ line 路径", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("- a\n- b\n\n");
    stream.end();
    // 整 chunk 给完整 list + space —— marked 一次 lex 给 closed list token，
    // 不进入 handleOpenBlock（末尾是 space），走 line 路径
    expect(segments).toHaveLength(0);
    expect(out.line.some((t) => stripAnsi(t).includes("· a"))).toBe(true);
  });

  it("StdoutWriter 场景未注入 segment factory → list 退化 hold", () => {
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
      columns: 80,
      mode: "render",
    });
    stream.feed("- a\n");
    stream.feed("- b\n\n");
    stream.end();
    // hold 路径：line 含 ANSI list
    expect(out.line.some((t) => stripAnsi(t).includes("· a"))).toBe(true);
  });

  it("strip 模式不启用 list 双态——走 hold + line", () => {
    const { stream, segments, out } = makeStreamWithSegment({ mode: "strip" });
    stream.feed("- a\n");
    stream.feed("- b\n\n");
    stream.end();
    expect(segments).toHaveLength(0);
    expect(stripAnsi(out.combined)).toContain("· a");
  });

  it("EOF 时未闭合 list 仍触发 commit（marked 在 EOF 视作闭合）", () => {
    const { stream, segments } = makeStreamWithSegment();
    stream.feed("- item 1\n");
    stream.feed("- item 2");
    stream.end();
    expect(segments).toHaveLength(1);
    const events = segments[0]!;
    expect(events.some((e) => e.kind === "commit")).toBe(true);
  });

  it("paragraph → list → paragraph：paragraph 流先关 + list segment 起手 + 关后段重起", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("intro\n\n");
    stream.feed("- a\n");
    stream.feed("- b\n\n");
    stream.feed("outro\n\n");
    stream.end();
    expect(segments).toHaveLength(1);
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("intro");
    expect(stripped).toContain("outro");
    // list 内容在 segment 内（mock 不流到 out.combined），通过 commit 验证
    const commit = segments[0]!.find((e) => e.kind === "commit");
    const commitStripped = stripAnsi(commit?.text ?? "");
    expect(commitStripped).toContain("· a");
    expect(commitStripped).toContain("· b");
  });

  it("嵌套 list 流式整段渲染：内层 items 与外层一同 replace", () => {
    const { stream, segments } = makeStreamWithSegment();
    stream.feed("- outer 1\n");
    stream.feed("  - inner 1\n");
    stream.feed("  - inner 2\n");
    stream.feed("- outer 2\n\n");
    stream.end();
    expect(segments).toHaveLength(1);
    const commit = segments[0]!.find((e) => e.kind === "commit");
    const stripped = stripAnsi(commit?.text ?? "");
    expect(stripped).toContain("· outer 1");
    expect(stripped).toContain("· outer 2");
    expect(stripped).toContain("· inner 1");
    expect(stripped).toContain("· inner 2");
  });

  it("list 流式期 reset（end 提前调）→ segment 强制 close 不残留", () => {
    const { stream, segments } = makeStreamWithSegment();
    stream.feed("- a\n");
    stream.feed("- b");
    // 模拟提前结束 (LLM turn 中断)
    stream.end();
    // EOF 视未闭合 list 为闭合 → commit 触发，无 close 残留事件
    const events = segments[0]!;
    const last = events.at(-1)!.kind;
    expect(["commit", "close"]).toContain(last);
  });
});
