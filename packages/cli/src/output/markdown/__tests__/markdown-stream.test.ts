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
  /** segment lifecycle events (render 模式) */
  segmentEvents: Array<{
    kind: "begin" | "replace" | "commit" | "close";
    content?: string;
  }>;
  /** segment.commit / segment.close 时把最终持有内容追加；strip / raw 走 appendInline */
  line: string[];
  /** 时序合成视图——含 appendInline 累计 + segment.commit/close 持有内容 */
  combined: string;
  /** segment.replace 最新持有内容（流式中间态，用于 hold 视觉断言） */
  segmentPending: string;
}

function makeSpySegment(out: Capture) {
  let currentContent = "";
  let closed = false;
  out.segmentEvents.push({ kind: "begin" });
  return {
    replace(t: string) {
      if (closed) return;
      currentContent = t;
      out.segmentPending = t;
      out.segmentEvents.push({ kind: "replace", content: t });
    },
    commit(t: string) {
      if (closed) return;
      currentContent = t;
      closed = true;
      out.segmentPending = "";
      out.segmentEvents.push({ kind: "commit", content: t });
      out.line.push(t);
      out.combined += t;
    },
    close() {
      if (closed) return;
      closed = true;
      out.segmentEvents.push({ kind: "close", content: currentContent });
      if (currentContent.length > 0) {
        out.line.push(currentContent);
        out.combined += currentContent;
      }
      out.segmentPending = "";
    },
  };
}

function makeStream(opts?: {
  columns?: number;
  mode?: "render" | "strip" | "raw";
  /** render 模式默认注入 segment factory；strip / raw 模式默认不注入；可显式覆盖 */
  withSegment?: boolean;
}) {
  const out: Capture = {
    appendInline: [],
    segmentEvents: [],
    line: [],
    combined: "",
    segmentPending: "",
  };
  const mode = opts?.mode ?? "render";
  const withSegment = opts?.withSegment ?? mode === "render";
  const stream = new MarkdownStream({
    appendInline: (chunk) => {
      out.appendInline.push(chunk);
      out.combined += chunk;
    },
    beginReplaceableSegment: withSegment ? () => makeSpySegment(out) : undefined,
    columns: opts?.columns ?? 80,
    mode,
  });
  return { stream, out };
}

describe("MarkdownStream · 段落（paragraph）字符流式", () => {
  it("单段普通文字 chunk 流式——render 模式经 segment，闭合 commit 含内容", () => {
    const { stream, out } = makeStream();
    stream.feed("hello ");
    stream.feed("world");
    stream.end();
    // render 模式经 segment.replace / commit，闭合后 combined 含内容
    expect(stripAnsi(out.combined)).toContain("hello world");
    // segment lifecycle：begin 1 + commit 1
    expect(out.segmentEvents.filter((e) => e.kind === "begin")).toHaveLength(1);
    expect(out.segmentEvents.filter((e) => e.kind === "commit")).toHaveLength(1);
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

  it("paragraph 之间夹 heading → heading 走 ANSI emit 独立段, ◆ 锚 turn 内仅 1 次(产品契约)", () => {
    const { stream, out } = makeStream();
    stream.feed("段1\n\n# 标题\n\n段2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 产品契约:一个 turn 一个 ◆ 锚(markdown-stream 跟踪 anchorEmittedThisStream
    // 状态,paragraph stream 重建时不再重 emit ◆,只 emit hanging 4 空格 prefix)
    const anchorCount = (stripped.match(/◆/g) ?? []).length;
    expect(anchorCount).toBe(1);
    // hash 字面保留(行业事实标准,参考 marked-terminal showSectionPrefix 默认)
    expect(stripped).toContain("# 标题");
    expect(stripped).toContain("段1");
    expect(stripped).toContain("段2");
  });

  it("paragraph 之间夹 code block → code 走独立段, ◆ 锚 turn 内仅 1 次", () => {
    const { stream, out } = makeStream();
    stream.feed("段1\n\n```\nconst x = 1\n```\n\n段2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 产品契约:一个 turn 一个 ◆ 锚
    const anchorCount = (stripped.match(/◆/g) ?? []).length;
    expect(anchorCount).toBe(1);
    expect(stripped).toContain("const x = 1");
    expect(stripped).toContain("段1");
    expect(stripped).toContain("段2");
  });
});

describe("MarkdownStream · 闭合 block 处理", () => {
  it("heading 闭合走 ANSI emit 独立段 line()——保留原生 # 前缀(dim), 文字 bold 染色", () => {
    const { stream, out } = makeStream();
    stream.feed("# Title\n\nbody.");
    stream.end();
    // heading 走 line() 独立段 ANSI emit
    const headingLines = out.line.filter((s) => stripAnsi(s).includes("Title"));
    expect(headingLines.length).toBe(1);
    // 行业事实标准: hash 前缀保留(marked-terminal showSectionPrefix 默认),
    // dim 着色让文本主体突出
    expect(stripAnsi(out.combined)).toContain("# Title");
    expect(stripAnsi(out.combined)).toContain("body.");
    // depth=1 brand cyan + bold —— 含 cyan SGR
    expect(headingLines[0]!).toContain("\x1b[36m");
    expect(headingLines[0]!).toContain("\x1b[1m");
    // dim 前缀 SGR(2 = dim)
    expect(headingLines[0]!).toContain("\x1b[2m");
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
    expect(stripped).toContain("╌"); // U+2500 box drawing
    expect(stripped).not.toContain("---");
  });
});

describe("MarkdownStream · 流式跨 chunk 边界", () => {
  it("不闭合代码块——流式期 segment 占位不暴露 ``` 字面，闭合后 commit 含内容", () => {
    const { stream, out } = makeStream();
    stream.feed("```\nconst x");
    // 流式期 segment 持有内容不暴露 fence 字面标记
    expect(stripAnsi(out.segmentPending)).not.toContain("```");
    stream.feed(" = 1\n```\n\n");
    stream.end();
    expect(stripAnsi(out.combined)).toContain("const x = 1");
  });

  it("末尾未闭合 heading hold——不暴露 # 字面，闭合后渲染保留 # 前缀", () => {
    const { stream, out } = makeStream();
    stream.feed("# Title");
    // 末位未闭合 heading hold——segment 持有内容不暴露 "# Title" 字面
    expect(stripAnsi(out.segmentPending)).not.toContain("# Title");
    stream.feed("\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("Title");
    // 行业事实标准: hash 前缀保留(dim 着色)
    expect(stripped).toContain("# Title");
  });

  it("末尾未闭合 list——闭合后渲染 · 中点 marker，不暴露 - 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("- item1\n- item2");
    stream.feed("\n\nfoo");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("· item1");
    expect(stripped).toContain("· item2");
    expect(stripped).not.toContain("- item1");
  });

  it("末尾未闭合 blockquote hold——闭合后渲染，不暴露 > 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("> quoted text");
    expect(stripAnsi(out.segmentPending)).not.toContain("> quoted");
    stream.feed("\n\nfoo");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("quoted text");
    expect(stripped).not.toContain("> quoted");
  });

  it("paragraph 跨 chunk —— 末位未闭合 inline hold、闭合后整段 ANSI emit", () => {
    const { stream, out } = makeStream();
    stream.feed("Hello ");
    // 末位未闭合 paragraph 仅 1 个 text inline → hold（跳过末位）→ segment 持有空
    expect(stripAnsi(out.segmentPending)).not.toContain("Hello");

    stream.feed("world.");
    expect(stripAnsi(out.segmentPending)).not.toContain("world.");

    stream.feed("\n\n");
    stream.end();
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

  it("混合内容: heading 保留 # 前缀, 其他 markdown 标记不泄露", () => {
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
    // heading: 行业事实标准 hash 前缀保留
    expect(stripped).toContain("# Heading");
    // code/list 字面 markdown 标记不泄露(它们走 ANSI 替换路径)
    expect(stripped).not.toContain("```");
    expect(stripped).not.toContain("- item1");
  });
});

/**
 * Space token 塌缩归一化 —— LLM 输出多空行（模型 artifact）在 markdown-stream
 * 层归一化为单空行（CommonMark spec 下 `\n\n+` 与 `\n\n` 语义等价）。
 *
 * 架构契约：space token 的 emit 形态由 markdown-stream 强制为 1 个 `\n\n`，
 * 与原始字节数无关；超额 `\n+` 字节通过 paragraphForwardedTo 推进被"标记为已处理"
 * 但实际不 forward 给输出层。详见 markdown-stream.ts space token 处理点的注释。
 *
 * 这是 design language P1（安静而非热闹·少即是多）的协议层实现：跨模型给
 * 用户提供一致的视觉节奏。
 */
describe("MarkdownStream · space token 塌缩归一化", () => {
  /**
   * 测量两段内容之间的换行字符数 —— 反映视觉空行数。
   * 标准段落分隔 `\n\n` 产生 2 个 \n（= 1 空行）；多空行 bug 会产生 ≥3 个 \n。
   */
  const countNewlinesBetween = (
    s: string,
    after: string,
    before: string,
  ): number => {
    const i1 = s.indexOf(after);
    const i2 = s.indexOf(before);
    if (i1 < 0 || i2 < 0) {
      throw new Error(`markers not found: "${after}" / "${before}" in ${JSON.stringify(s)}`);
    }
    const between = s.substring(i1 + after.length, i2);
    return (between.match(/\n/g) ?? []).length;
  };

  it("基线（回归屏障）：正常 \\n\\n 段落分隔 —— 视觉单空行 = 间隔 2 个 \\n", () => {
    // 该断言锁定"未受 bug 影响的正常输入"的 baseline，让后续多空行断言能复用同一参考值
    const { stream, out } = makeStream();
    stream.feed("p1\n\np2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(countNewlinesBetween(stripped, "p1", "p2")).toBe(2);
  });

  it("单 chunk 内 LLM 多空行 `\\n\\n\\n\\n` 塌缩为单空行（与正常 \\n\\n 视觉等价）", () => {
    const ref = makeStream();
    ref.stream.feed("p1\n\np2");
    ref.stream.end();
    const refBlankCount = countNewlinesBetween(stripAnsi(ref.out.combined), "p1", "p2");

    const { stream, out } = makeStream();
    stream.feed("p1\n\n\n\np2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(countNewlinesBetween(stripped, "p1", "p2")).toBe(refBlankCount);
    // 强声明：与 baseline 严格相等 —— bug 修复后视觉行为与正常输入完全一致
    expect(countNewlinesBetween(stripped, "p1", "p2")).toBe(2);
  });

  it("极端多空行 `\\n\\n\\n\\n\\n\\n\\n\\n` 仍塌缩为单空行（任意数量都归一化）", () => {
    const { stream, out } = makeStream();
    stream.feed("p1\n\n\n\n\n\n\n\np2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(countNewlinesBetween(stripped, "p1", "p2")).toBe(2);
  });

  it("跨 chunk 多空行边界 —— 第一 chunk 末尾 `\\n\\n`、第二 chunk 起首 `\\n\\nparagraph2` 仍塌缩为单空行", () => {
    // 这是流式期最容易踩到 bug 的场景：space token 在 chunk N 时是末尾 hold
    // 候选（不 emit），chunk N+1 拼出更多 `\n` 后才进入 emitClosedBlock。
    // 必须验证跨 chunk 重 lex 时归一化仍生效（依赖 emittedBlockCount 单调推进保证只 emit 一次）。
    const { stream, out } = makeStream();
    stream.feed("p1\n\n");
    stream.feed("\n\np2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(countNewlinesBetween(stripped, "p1", "p2")).toBe(2);
  });

  it("strip 模式多空行同样塌缩 —— render / strip 行为对称", () => {
    const ref = makeStream({ mode: "strip" });
    ref.stream.feed("p1\n\np2");
    ref.stream.end();
    const refBlankCount = countNewlinesBetween(ref.out.combined, "p1", "p2");

    const { stream, out } = makeStream({ mode: "strip" });
    stream.feed("p1\n\n\n\np2");
    stream.end();
    expect(countNewlinesBetween(out.combined, "p1", "p2")).toBe(refBlankCount);
  });

  it("heading 与 paragraph 之间多空行 —— heading 的 \\n envelope + space token 跳过 emit 共同保证视觉 1 空行", () => {
    // 此场景验证 paragraphStream === null 路径（heading emit 后流被关闭）下的
    // 多空行归一化：space token 走 skip 分支（不重复给已用 envelope 分隔的 block
    // 之间再加 \n\n），但 forwardedTo 仍正确推进。
    const ref = makeStream();
    ref.stream.feed("# heading\n\np2");
    ref.stream.end();
    const refBlankCount = countNewlinesBetween(stripAnsi(ref.out.combined), "heading", "p2");

    const { stream, out } = makeStream();
    stream.feed("# heading\n\n\n\np2");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(countNewlinesBetween(stripped, "heading", "p2")).toBe(refBlankCount);
  });

  /**
   * ─── lookahead-based feed gate ───
   *
   * space token 在 paragraph→非 paragraph 转移时**不应** feed `\n\n` 给 TextStream。
   * 否则 TextStream.feed(`\n\n`) + closeParagraphStream.end(`\n`) + 下一 block 的
   * envelope `\n{content}\n` 前导 `\n` 三层叠加（共 4 个 `\n`）→ 视觉 3 空行 bug。
   *
   * 修复：仅当 `nextTokenType === "paragraph"` 时 feed `\n\n`；其他情况
   * （heading / code / hr / list / blockquote 等）由 next block 自治分隔。
   */
  describe("paragraph → 非 paragraph 转移仅产生 1 空行（lookahead gate）", () => {
    it("paragraph + hr", () => {
      const { stream, out } = makeStream();
      stream.feed("p1\n\n---\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      // p1 与 hr 之间应仅 2 个 \n（= 1 空行）
      expect(countNewlinesBetween(stripped, "p1", "╌")).toBe(2);
    });

    it("paragraph + heading", () => {
      const { stream, out } = makeStream();
      stream.feed("p1\n\n# heading\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect(countNewlinesBetween(stripped, "p1", "heading")).toBe(2);
    });

    it("paragraph + fenced code block", () => {
      const { stream, out } = makeStream();
      stream.feed("p1\n\n```\ncode\n```\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect(countNewlinesBetween(stripped, "p1", "code")).toBe(2);
    });

    it("paragraph + list", () => {
      const { stream, out } = makeStream();
      stream.feed("p1\n\n- item1\n- item2\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      // list 渲染为 `· item`，找第一个 item 字符
      expect(countNewlinesBetween(stripped, "p1", "item1")).toBe(2);
    });

    it("paragraph + blockquote", () => {
      const { stream, out } = makeStream();
      stream.feed("p1\n\n> quoted\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect(countNewlinesBetween(stripped, "p1", "quoted")).toBe(2);
    });

    it("paragraph + 多空行 + hr —— 既归一化多空行又消除叠加", () => {
      // 双重保护：LLM 输出多空行（应归一化为 \n\n）+ 后接非 paragraph block
      // （应跳过 feed 避免叠加）。两条修复同时生效。
      const { stream, out } = makeStream();
      stream.feed("p1\n\n\n\n\n\n---\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect(countNewlinesBetween(stripped, "p1", "╌")).toBe(2);
    });
  });

  /**
   * ─── 非 paragraph → paragraph 对称分隔 ───
   *
   * paragraph→非 paragraph 已通过 closeParagraphStream + envelope leading `\n`
   * 共同提供 1 空行分隔。**反方向**（非 paragraph→paragraph）需 space handler
   * emit 1 个 `\n` 配合前 block envelope trailing `\n` 得到对称的 1 空行。
   *
   * 该 emit 由 `lastEmittedWasParagraph === false` 分支触发——`paragraphStream`
   * 在 render / strip 模式语义不一致（strip 恒为 null），用语义真值字段而非
   * 实现细节作分流条件，render/strip 行为对称。
   */
  describe("非 paragraph → paragraph 转移产生 1 空行（对称分隔）", () => {
    it("hr → paragraph", () => {
      const { stream, out } = makeStream();
      stream.feed("p1\n\n---\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      // hr 与 p2 之间应有 2 个 \n（= 1 空行），对称于 p1 与 hr 之间的 1 空行
      expect(countNewlinesBetween(stripped, "╌", "p2")).toBe(2);
    });

    it("heading → paragraph", () => {
      const { stream, out } = makeStream();
      stream.feed("# heading\n\nparagraph content");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect(countNewlinesBetween(stripped, "heading", "paragraph content")).toBe(2);
    });

    it("code block → paragraph", () => {
      const { stream, out } = makeStream();
      stream.feed("```\ncode\n```\n\nafter code");
      stream.end();
      const stripped = stripAnsi(out.combined);
      // code 内容 与 "after code" paragraph 之间应有 1 空行
      expect(countNewlinesBetween(stripped, "code", "after code")).toBe(2);
    });

    it("list → paragraph", () => {
      const { stream, out } = makeStream();
      stream.feed("- item1\n- item2\n\nafter list");
      stream.end();
      const stripped = stripAnsi(out.combined);
      // list 最后一项与 "after list" paragraph 之间应有 1 空行
      expect(countNewlinesBetween(stripped, "item2", "after list")).toBe(2);
    });

    it("blockquote → paragraph", () => {
      const { stream, out } = makeStream();
      stream.feed("> quoted\n\nafter quote");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect(countNewlinesBetween(stripped, "quoted", "after quote")).toBe(2);
    });

    it("paragraph → hr → paragraph 全对称（前后各 1 空行）", () => {
      // 综合验证：rule 前后空行数相等且均为 1。这是 CommonMark 标准渲染契约
      // 在我们渲染器上的具体表达。
      const { stream, out } = makeStream();
      stream.feed("p1\n\n---\n\np2");
      stream.end();
      const stripped = stripAnsi(out.combined);
      const before = countNewlinesBetween(stripped, "p1", "╌");
      const after = countNewlinesBetween(stripped, "╌", "p2");
      expect(before).toBe(2);
      expect(after).toBe(2);
      expect(before).toBe(after); // 显式对称声明
    });

    it("首个 block 是 paragraph 时不引入文档起首空行", () => {
      // 边界：emittedBlockCount === 0 时跳过 emit—— 避免文档起首平白多 1 空行。
      // 通过断言起首字符是 paragraph 的 ◆ 锚（无前置空行）来验证。
      const { stream, out } = makeStream();
      stream.feed("first paragraph");
      stream.end();
      const stripped = stripAnsi(out.combined);
      // 起首应是 paragraph 的 ◆ 锚（前面只有 indent，无 \n）
      expect(stripped.match(/^\s*◆/)).not.toBeNull();
    });

    it("strip 模式 hr → paragraph 也产生 1 空行（render / strip 对称）", () => {
      // 防御性补强：strip 模式与 render 模式走同一 lastEmittedWasParagraph
      // 分支逻辑。该测试封口 strip 模式非 paragraph→paragraph 路径，确保
      // 修复后该路径行为与 render 模式对称、未来重构不破坏。
      //
      // 注意：strip 模式之前对此路径输出 2 空行（feed `\n\n` 被原代码 `|| strip`
      // 条件触发 + envelope trailing `\n` 叠加），属于 pre-existing bug；本次
      // 修复将其纠正为 1 空行，符合 CommonMark 标准。
      const { stream, out } = makeStream({ mode: "strip" });
      stream.feed("p1\n\n---\n\np2");
      stream.end();
      // strip 模式无 ANSI，直接用 combined。hr 渲染为 ─ 字符序列。
      expect(countNewlinesBetween(out.combined, "╌", "p2")).toBe(2);
    });

    it("strip 模式 heading → paragraph 也产生 1 空行（render / strip 对称）", () => {
      const { stream, out } = makeStream({ mode: "strip" });
      stream.feed("# heading\n\nparagraph content");
      stream.end();
      expect(countNewlinesBetween(out.combined, "heading", "paragraph content")).toBe(2);
    });
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

  it("闭合 paragraph 含 `codespan` —— 输出 bgAnsi256(238) 中深灰底 + 默认前景、不出现 backtick 字面", () => {
    const { stream, out } = makeStream();
    stream.feed("run `npm install` to start\n\n");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).not.toContain("`");
    expect(stripped).toContain("run npm install to start");
    // 视觉契约：bg 块给"内容引用"视觉锚 + 默认前景给所有终端配色最高对比;
    // 不叠 cyan（brand cyan 仅留给选中 / 品牌 / 主操作 / 链接）
    expect(out.combined).toContain(chalk.bgAnsi256(238)("npm install"));
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
    expect(out.combined).toContain(chalk.bgAnsi256(238)("code"));
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

  it("跨 chunk 纯文本 paragraph —— 末位未闭合 hold、闭合后整段 emit", () => {
    const { stream, out } = makeStream();
    stream.feed("Hello ");
    expect(stripAnsi(out.segmentPending)).not.toContain("Hello");
    stream.feed("world\n\n");
    stream.end();
    expect(stripAnsi(out.combined)).toContain("Hello world");
  });

  it("中段闭合 + 末位未闭合 —— 闭合段渲染 ANSI、末位段 hold 直到闭合", () => {
    const { stream, out } = makeStream();
    stream.feed("first **bold** done\n\n");
    // 第一段闭合——segment.replace 含 ANSI bold（流式期持有内容可见）
    const pending1 = stripAnsi(out.segmentPending);
    expect(pending1).toContain("first bold done");
    expect(pending1).not.toContain("**");
    expect(out.segmentPending).toContain(chalk.bold("bold"));

    // 起首第二段未闭合——内容 hold（segment 持有内容不含第二段文字）
    stream.feed("second start");
    expect(stripAnsi(out.segmentPending)).not.toContain("second start");

    // 第二段闭合——commit 一次性含全部
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
  withSegment?: boolean;
}) {
  const out: Capture = {
    appendInline: [],
    segmentEvents: [],
    line: [],
    combined: "",
    segmentPending: "",
  };
  const segments: SegmentEvent[][] = [];
  const mode = opts?.mode ?? "render";
  const withSegment = opts?.withSegment ?? mode === "render";
  const stream = new MarkdownStream({
    appendInline: (chunk) => {
      out.appendInline.push(chunk);
      out.combined += chunk;
    },
    columns: opts?.columns ?? 80,
    mode,
    beginReplaceableSegment: withSegment
      ? () => {
          const events: SegmentEvent[] = [{ kind: "begin" }];
          segments.push(events);
          let currentContent = "";
          let closed = false;
          return {
            replace: (text) => {
              if (closed) return;
              currentContent = text;
              out.segmentPending = text;
              events.push({ kind: "replace", text });
            },
            commit: (text) => {
              if (closed) return;
              currentContent = text;
              closed = true;
              out.segmentPending = "";
              events.push({ kind: "commit", text });
              out.line.push(text);
              out.combined += text;
            },
            close: () => {
              if (closed) return;
              closed = true;
              events.push({ kind: "close", text: currentContent });
              if (currentContent.length > 0) {
                out.line.push(currentContent);
                out.combined += currentContent;
              }
              out.segmentPending = "";
            },
          };
        }
      : undefined,
  });
  return { stream, out, segments };
}

describe("MarkdownStream · code block 双态渲染", () => {
  it("fenced + lang：流式期 segment.replace 用 dim 占位、闭合时 commit 切 highlight", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("```typescript\nconst x =");
    stream.feed(" 1\nconst y = 2\n```\n\n");
    stream.end();

    // 一段 markdown 一个 segment
    expect(segments).toHaveLength(1);
    const events = segments[0]!;
    expect(events[0]!.kind).toBe("begin");
    const replaceCount = events.filter((e) => e.kind === "replace").length;
    const commitCount = events.filter((e) => e.kind === "commit").length;
    expect(replaceCount).toBeGreaterThanOrEqual(1);
    expect(commitCount).toBe(1);
    // 流式期至少一次 replace 是 dim 占位（code 未闭合时 formatStreamingCode）
    const replaces = events.filter((e) => e.kind === "replace");
    expect(replaces.some((e) => e.text!.includes("\x1b[2m"))).toBe(true);
    // commit 内容含代码 + 多色 SGR（cli-highlight + 自定义 theme，非纯 dim）
    const commit = events.find((e) => e.kind === "commit")!;
    expect(commit.text).toContain("const");
    const commitAnsi = commit.text!.match(/\x1b\[\d+m/g) ?? [];
    expect(new Set(commitAnsi).size).toBeGreaterThan(1);
  });

  it("indented code（无 lang）—— render 模式整段 segment，dim 占位 + 内容完整", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("paragraph above\n\n    indented code line 1\n    indented code line 2\n\nparagraph below\n\n");
    stream.end();
    // render 模式整段一个 segment
    expect(segments).toHaveLength(1);
    expect(stripAnsi(out.combined)).toContain("indented code line 1");
    expect(stripAnsi(out.combined)).toContain("paragraph above");
    expect(stripAnsi(out.combined)).toContain("paragraph below");
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

  it("render 模式未注入 segment factory → fail-fast 抛错（不 silent 退化）", () => {
    const stream = new MarkdownStream({
      appendInline: () => {},
      columns: 80,
      mode: "render",
      // beginReplaceableSegment 未注入——render 模式核心依赖缺失
    });
    expect(() => stream.feed("```typescript\nconst x = 1\n```\n\n")).toThrow(
      /requires beginReplaceableSegment/,
    );
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

  it("多个连续 fenced code block —— 一段 markdown 一 segment，commit 含全部代码", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("```typescript\n");
    stream.feed("const x = 1\n");
    stream.feed("```\n\n```python\n");
    stream.feed("print('y')\n");
    stream.feed("```\n\n");
    stream.end();
    // 一段 markdown（整 turn 连续 text）一个 segment
    expect(segments).toHaveLength(1);
    const commit = segments[0]!.find((e) => e.kind === "commit");
    const stripped = stripAnsi(commit?.text ?? "");
    expect(stripped).toContain("const x = 1");
    expect(stripped).toContain("print('y')");
  });

  it("paragraph → fenced code → paragraph：单 segment 内全部内容完整", () => {
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
    const commit = segments[0]!.find((e) => e.kind === "commit");
    expect(stripAnsi(commit?.text ?? "")).toContain("const x = 1");
  });

  it("单 chunk 完整闭合 fenced code —— render 模式仍经 segment，commit 含内容", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("```typescript\nconst x = 1\n```\n\n");
    stream.end();
    expect(segments).toHaveLength(1);
    expect(stripAnsi(out.combined)).toContain("const x = 1");
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
    // 一段 markdown 一个 segment（render 模式不走独立 line 路径）
    expect(segments).toHaveLength(1);
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

  it("单 chunk 完整闭合 list —— render 模式仍经 segment，commit 含 · 中点 marker", () => {
    const { stream, segments, out } = makeStreamWithSegment();
    stream.feed("- a\n- b\n\n");
    stream.end();
    expect(segments).toHaveLength(1);
    expect(stripAnsi(out.combined)).toContain("· a");
    expect(stripAnsi(out.combined)).toContain("· b");
  });

  it("render 模式未注入 segment factory + list → fail-fast 抛错", () => {
    const stream = new MarkdownStream({
      appendInline: () => {},
      columns: 80,
      mode: "render",
    });
    expect(() => stream.feed("- a\n")).toThrow(
      /requires beginReplaceableSegment/,
    );
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

describe("MarkdownStream · table（hold 等闭合 + 整段 ANSI emit）", () => {
  it("流式期 hold 不暴露字面——首行 `|` 字符在闭合前不 forward", () => {
    const { stream, out } = makeStream();
    // 喂入半截表格（仅 header + 分隔行，未到数据行）
    stream.feed("| 项 | 内容 |\n|---|---|\n");
    // 未闭合时主路径不应 emit 字面 `|---|`（hold 行为）
    // 注：marked 在 buffer 末尾未闭合 table 时 token 是 paragraph 或 table,
    //   handleOpenBlock 走 default hold 路径不 forward 字面
    const earlyStripped = stripAnsi(out.combined);
    expect(earlyStripped).not.toContain("|---|");

    // 喂入数据行 + 末尾 \n\n 闭合表格
    stream.feed("| 名称 | foo |\n| 版本 | 1.0 |\n\n");
    stream.end();

    const finalStripped = stripAnsi(out.combined);
    // 闭合后表格内容渲染为 minimal markdown 风格（无 `|` 字面）
    expect(finalStripped).not.toContain("|---|");
    expect(finalStripped).not.toContain("| 名称 | foo |");
    // 表格内容可见
    expect(finalStripped).toContain("项");
    expect(finalStripped).toContain("内容");
    expect(finalStripped).toContain("名称");
    expect(finalStripped).toContain("foo");
    expect(finalStripped).toContain("版本");
    // 分隔行 ─ 字符存在 (table header / column 分隔,与 hr 的 ╌ 不同)
    expect(finalStripped).toContain("─");
  });

  it("闭合后整段 emit 走 line() 路径（独立段语义）", () => {
    const { stream, out } = makeStream();
    stream.feed("| a | b |\n|---|---|\n| 1 | 2 |\n\n");
    stream.end();
    // table 是独立块——走 line() 路径整段写入（而非 appendInline 流式接续）
    expect(out.line.length).toBeGreaterThan(0);
    const lineContent = out.line.join("");
    expect(stripAnsi(lineContent)).toContain("a");
    expect(stripAnsi(lineContent)).toContain("b");
    expect(stripAnsi(lineContent)).toContain("1");
    expect(stripAnsi(lineContent)).toContain("2");
  });

  it("table 与前后 paragraph 共存——段间分隔正确，不粘连", () => {
    const { stream, out } = makeStream();
    stream.feed("前导文字。\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n后续文字。");
    stream.end();
    const stripped = stripAnsi(out.combined);
    expect(stripped).toContain("前导文字");
    expect(stripped).toContain("a");
    expect(stripped).toContain("1");
    expect(stripped).toContain("后续文字");
    // 段间至少有一个空行分隔（paragraph→table 或 table→paragraph）
    const lines = stripped.split("\n");
    expect(lines.length).toBeGreaterThan(5);
  });

  it("strip 模式——表格 layout 保留但去 ANSI（CI / pipe 友好）", () => {
    const { stream, out } = makeStream({ mode: "strip" });
    stream.feed("| 项 | 内容 |\n|---|---|\n| 名称 | foo |\n\n");
    stream.end();
    const combined = out.combined;
    expect(combined).toBe(stripAnsi(combined)); // strip 模式无 ANSI
    expect(combined).toContain("项");
    expect(combined).toContain("foo");
    expect(combined).toContain("─");
  });

  it("raw 模式——直接 forward 字面字符（不解析）", () => {
    const { stream, out } = makeStream({ mode: "raw" });
    const raw = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    stream.feed(raw);
    stream.end();
    // raw 模式整段字面 forward + 末尾 \n
    expect(out.combined).toBe(raw + "\n");
  });
});

// ─── REPRODUCER: 嵌套 list + heading + hr 多 block 场景乱序 ───
// 实际 LLM 输出片段(transcript T4 第 67-89 行,用户截图渲染乱序的位置)。
// 锁 markdown-stream 状态机在含嵌套 list 的复杂 markdown 下的 emit 顺序。
describe("REPRODUCER · 嵌套 list 触发乱序", () => {
  const FIXTURE = "### 五、网页抓取\n\n- 抓取指定 URL 的 HTML 内容\n- 两种模式：\n  - **带 prompt** — 由辅助模型提取\n  - **不带 prompt** — 返回完整 Markdown 原文\n- 预授权白名单\n- **我不会自己编造 URL**\n\n---\n\n### 六、子代理并行调研\n\n- 一次性派出最多 3 个子代理\n- 适用场景：\n  - 对比多个技术方案\n  - 多角度代码审查\n  - 大规模资料收集\n\n子代理返回结果后我负责整合汇报。\n\n---\n";

  it("一次性 feed: 章节顺序保持 + 嵌套 list 内容正确出现一次", () => {
    const { stream, out } = makeStream();
    stream.feed(FIXTURE);
    stream.end();
    const stripped = stripAnsi(out.combined);
    // 五在前,六在后
    const idxFive = stripped.indexOf("五、网页抓取");
    const idxSix = stripped.indexOf("六、子代理并行调研");
    expect(idxFive).toBeGreaterThan(-1);
    expect(idxSix).toBeGreaterThan(-1);
    expect(idxFive).toBeLessThan(idxSix);
    // 第六章嵌套 list 内容应在第六章标题之后
    const idxNestedSix = stripped.indexOf("对比多个技术方案");
    expect(idxNestedSix).toBeGreaterThan(idxSix);
    // 第五章嵌套 list 内容应在第六章标题之前
    const idxNestedFive = stripped.indexOf("带 prompt");
    expect(idxNestedFive).toBeGreaterThan(idxFive);
    expect(idxNestedFive).toBeLessThan(idxSix);
    // 末段不应跑到第六章标题之前
    const idxFinal = stripped.indexOf("子代理返回结果后");
    expect(idxFinal).toBeGreaterThan(idxNestedSix);
  });

  function feedByChunks(stream: MarkdownStream, text: string, chunkSize: number): void {
    for (let i = 0; i < text.length; i += chunkSize) {
      stream.feed(text.slice(i, i + chunkSize));
    }
  }

  function assertOrder(combined: string, label: string): void {
    const stripped = stripAnsi(combined);
    const idxFive = stripped.indexOf("五、网页抓取");
    const idxSix = stripped.indexOf("六、子代理并行调研");
    const idxNestedFive = stripped.indexOf("带 prompt");
    const idxNestedSix = stripped.indexOf("对比多个技术方案");
    const idxFinal = stripped.indexOf("子代理返回结果后");
    expect(idxFive, `[${label}] 五标题缺失`).toBeGreaterThan(-1);
    expect(idxSix, `[${label}] 六标题缺失`).toBeGreaterThan(-1);
    expect(idxNestedFive, `[${label}] 五嵌套 list 缺失`).toBeGreaterThan(-1);
    expect(idxNestedSix, `[${label}] 六嵌套 list 缺失`).toBeGreaterThan(-1);
    expect(idxFinal, `[${label}] 末段缺失`).toBeGreaterThan(-1);
    expect(idxFive, `[${label}] 五标题应在 五嵌套之前`).toBeLessThan(idxNestedFive);
    expect(idxNestedFive, `[${label}] 五嵌套应在 六标题之前`).toBeLessThan(idxSix);
    expect(idxSix, `[${label}] 六标题应在 六嵌套之前`).toBeLessThan(idxNestedSix);
    expect(idxNestedSix, `[${label}] 六嵌套应在 末段之前`).toBeLessThan(idxFinal);
  }

  for (const chunkSize of [1, 3, 5, 10, 20, 50, 100]) {
    it(`chunk 化 feed (chunkSize=${chunkSize}): 章节 + 嵌套 list 顺序保持`, () => {
      const { stream, out } = makeStream();
      feedByChunks(stream, FIXTURE, chunkSize);
      stream.end();
      assertOrder(out.combined, `chunkSize=${chunkSize}`);
    });
  }

  // 诊断输出: 给失败 case 一个完整 dump 看 emit 到底缺什么
  it("DIAGNOSTIC chunkSize=10 完整 dump", () => {
    const { stream, out } = makeStream();
    feedByChunks(stream, FIXTURE, 10);
    stream.end();
    const stripped = stripAnsi(out.combined);
    // eslint-disable-next-line no-console
    console.log("=== chunkSize=10 OUTPUT ===\n" + stripped + "\n=== END ===");
    // 此测试始终通过(只 dump 不断言),用于跑测试时看 console
    expect(stripped.length).toBeGreaterThan(0);
  });
});

// 重设计核心契约专项：行数单调性（ScrollRegion.replaceSegment 硬约束承接）、
// ◆ 锚定位、renderFullMarkdown 纯函数等价、paragraph 续行 hanging 4。这些不变量
// 缺测试会让未来重构静默回归。
describe("MarkdownStream · 重设计核心契约", () => {
  function feedByChunk(fixture: string, chunkSize: number) {
    const { stream, segments } = makeStreamWithSegment();
    for (let i = 0; i < fixture.length; i += chunkSize) {
      stream.feed(fixture.slice(i, i + chunkSize));
    }
    stream.end();
    return segments[0]!;
  }

  describe("行数单调性（render 主路径硬不变量）", () => {
    const fixtures: Array<{ name: string; md: string }> = [
      {
        name: "典型 markdown（paragraph + heading + hr）",
        md: "# 标题\n\n第一段内容。\n\n---\n\n第二段内容结尾。\n\n",
      },
      {
        name: "嵌套 list（token 振荡场景）",
        md: "- 顶层一\n- 两种模式：\n  - 带 prompt 子项\n  - 不带 prompt 子项\n- 顶层二\n\n",
      },
      {
        name: "paragraph 末位 inline 闭合切换",
        md: "前缀文字 **加粗内容** 后缀文字结束。\n\n",
      },
      {
        name: "code block 流式 → 闭合切换",
        md: "```typescript\nconst x = 1\nconst y = 2\n```\n\n收尾段落。\n\n",
      },
      {
        name: "混合（heading + nested list + code + paragraph）",
        md: "## 章节\n\n- 列表项\n  - 嵌套项\n\n```js\nfoo()\n```\n\n正文段落。\n\n",
      },
    ];

    for (const { name, md } of fixtures) {
      for (const cs of [1, 3, 5, 10, 50]) {
        it(`${name} · chunk=${cs} 输出行数单调非减`, () => {
          const events = feedByChunk(md, cs);
          const widths = events
            .filter((e) => e.kind === "replace" || e.kind === "commit")
            .map((e) => (e.text ?? "").split("\n").length);
          for (let i = 1; i < widths.length; i++) {
            expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
          }
        });
      }
    }
  });

  describe("◆ 锚定位", () => {
    it("buffer 起首是 paragraph → 渲染含 ◆", () => {
      const { stream, out } = makeStream();
      stream.feed("一段普通文字。\n\n");
      stream.end();
      expect(stripAnsi(out.combined)).toContain("◆");
    });

    it("buffer 起首是 heading（无 paragraph）→ 渲染不含 ◆", () => {
      const { stream, out } = makeStream();
      stream.feed("# 仅标题\n\n");
      stream.end();
      expect(stripAnsi(out.combined)).not.toContain("◆");
    });

    it("先 heading 再 paragraph → ◆ 出现在 paragraph 起首，全程仅 1 个", () => {
      const { stream, out } = makeStream();
      stream.feed("# 标题\n\n正文段落内容。\n\n");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect((stripped.match(/◆/g) ?? []).length).toBe(1);
      // ◆ 在标题之后、正文之前
      expect(stripped.indexOf("◆")).toBeGreaterThan(stripped.indexOf("标题"));
      expect(stripped.indexOf("◆")).toBeLessThan(stripped.indexOf("正文"));
    });

    it("多段 paragraph → 仅首段含 ◆，后续段回到内容基准列（无 ◆ 无额外缩进）", () => {
      const { stream, out } = makeStream();
      stream.feed("第一段。\n\n第二段。\n\n第三段。\n\n");
      stream.end();
      const stripped = stripAnsi(out.combined);
      expect((stripped.match(/◆/g) ?? []).length).toBe(1);
      expect(stripped.indexOf("◆")).toBeLessThan(stripped.indexOf("第一段"));
      // 后续段起首 = contentPrefix（列 2），内容紧跟，非 hanging 4 凭空缩进
      const lines = stripped.split("\n");
      const p2 = lines.find((l) => l.includes("第二段"))!;
      const p3 = lines.find((l) => l.includes("第三段"))!;
      expect(p2.startsWith(`${PREFIX}第二段`)).toBe(true);
      expect(p3.startsWith(`${PREFIX}第三段`)).toBe(true);
    });
  });

  describe("多 block 混排左对齐（heading / list / 后续 paragraph 同列）", () => {
    it("heading 之后的正文 paragraph 与 heading marker 同列（contentPrefix），不凭空缩进", () => {
      const { stream, out } = makeStream();
      stream.feed("首段引言。\n\n");
      stream.feed("## 文件与代码\n\n");
      stream.feed("我可以直接操作你的工作区文件。\n\n");
      stream.feed("- 列表项一\n- 列表项二\n\n");
      stream.feed("这意味着我可以帮你重构代码。\n\n");
      stream.end();
      const lines = stripAnsi(out.combined)
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const heading = lines.find((l) => l.includes("文件与代码"))!;
      const listItem = lines.find((l) => l.includes("列表项一"))!;
      const para1 = lines.find((l) => l.includes("我可以直接操作"))!;
      const para2 = lines.find((l) => l.includes("这意味着"))!;
      // heading marker `#` 在列 2（contentPrefix 之后）
      expect(heading.startsWith(`${PREFIX}#`)).toBe(true);
      // list marker `·` 在列 2
      expect(listItem.startsWith(`${PREFIX}·`)).toBe(true);
      // 后续 paragraph 内容也在列 2（与 heading/list marker 左边缘对齐）——
      // 不再是凭空 hanging 4 缩进
      expect(para1.startsWith(`${PREFIX}我可以直接操作`)).toBe(true);
      expect(para2.startsWith(`${PREFIX}这意味着`)).toBe(true);
    });
  });

  describe("renderFullMarkdown 纯函数等价", () => {
    const md = "# 标题\n\n段落 **加粗** 文字。\n\n- 项一\n- 项二\n\n```js\nx()\n```\n\n结尾。\n\n";

    it("分多次 feed（不同 chunkSize）vs 一次 feed → 最终 commit ANSI 完全一致", () => {
      const oneShot = feedByChunk(md, md.length);
      const oneCommit = oneShot.find((e) => e.kind === "commit")?.text ?? "";
      for (const cs of [1, 2, 7, 13, 30]) {
        const events = feedByChunk(md, cs);
        const commit = events.find((e) => e.kind === "commit")?.text ?? "";
        expect(commit).toBe(oneCommit);
      }
    });
  });

  describe("paragraph 续行 hanging 4（视觉契约）", () => {
    it("长 paragraph wrap → 续行起首 4 空格（与 ◆ 锚后内容对齐），不退化列 2", () => {
      const { stream, out } = makeStream({ columns: 40 });
      stream.feed("a".repeat(120) + "\n\n");
      stream.end();
      const lines = stripAnsi(out.combined)
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(1);
      // 首行：contentPrefix(2) + ◆ + space = 4 列后是内容
      expect(lines[0]!.startsWith(`${PREFIX}◆ `)).toBe(true);
      // 续行：hanging 4 空格后直接内容（非列 2）
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i]!.startsWith("    ")).toBe(true);
        expect(lines[i]![4]).not.toBe(" ");
      }
    });

    it("softbreak（单 \n）续行也 hanging 4", () => {
      const { stream, out } = makeStream({ columns: 80 });
      stream.feed("第一行内容\n第二行内容\n\n");
      stream.end();
      const lines = stripAnsi(out.combined)
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(2);
      expect(lines[0]!.startsWith(`${PREFIX}◆ `)).toBe(true);
      expect(lines[1]!.startsWith("    ")).toBe(true);
      expect(lines[1]![4]).not.toBe(" ");
    });
  });
});
