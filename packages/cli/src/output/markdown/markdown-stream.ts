/**
 * Markdown 流式渲染主入口——LLM chunk → ANSI 输出协调器。
 *
 * 三档模式由本类内部分发，单一入口契约：
 *
 *   - **render**（默认 TTY 完整渲染）—— "buffer + 单 segment + 整段 re-render"
 *     主路径。每 chunk 累积到 buffer，调 marked.lexer 重 parse 整段、把所有 token
 *     渲染为 ANSI、整段 `segment.replace` 覆盖。`end()` 时 `segment.commit` 切到
 *     immutable 固化进 scrollback。
 *
 *     这条路径与 marked 行为脱钩：黑盒输入字符 → 输出 ANSI；不依赖 token 边界稳定。
 *     marked 在嵌套 list 流式期 token 边界振荡（list↔space 振荡 / setext heading
 *     误识别等）由整段 re-render 自然吸收——已闭合 block 渲染稳定（marked 对已
 *     闭合 block 的 raw 稳定），末位 token "hold → 渲染" 单调，整段 ANSI 行数随
 *     buffer 单调追加而单调非减少（承接 ScrollRegion.replaceSegment 的硬约束：
 *     newText 行数 < committedLogicalRows 时抛错）。
 *
 *     ◆ 锚位置由 `renderFullMarkdown` 内嵌算法动态判定（第一个可见 paragraph 起首），
 *     无跨 chunk 状态字段；一段 markdown 至多一个 ◆，turn 内可能因 thinking / tool
 *     卡片中断产生多段，每段独立 ◆。
 *
 *   - **strip**（CI / pipe / 日志）—— 保留增量 emit 状态机（append-only sink 决定，
 *     不可整段 re-render）。闭合 block 经 `renderBlock(ctx with mode=strip)` 拿到
 *     无染色但保留 block 结构（hashes / markers / 缩进 / wrap）的 ANSI，
 *     `appendInline` 增量 forward；paragraph 经 `renderInline` 逐 inline token
 *     emit；末位未闭合 token hold。
 *
 *   - **raw**（调试）—— `appendInline(chunk)` 原文转发，不解析。
 *
 *   render 主路径与 strip 旁路是两套独立状态机，仅共享 `buffer` 累积与 `marked.lexer`
 *   解析结果；通过 `feed()` 入口的 `mode` 分流，互不耦合。架构简化承诺（render 路径
 *   状态 2 字段、emit 路径 1 条）仅适用 render 主路径——append-only sink 的物理约束
 *   决定 strip 必须保留增量状态机。
 *
 * 视觉契约（render 模式）：
 *   - paragraph：首行 `"  ◆ "`（含锚）或 `TEXT_STREAM_HANGING_PREFIX`（4 空格无锚），
 *     续行恒为 hanging 4 空格（与 ◆ 锚之后内容对齐）；末位未闭合 inline hold（不
 *     输出字面 markdown 标记，闭合后整段切到 ANSI）
 *   - heading / hr / blockquote：闭合时 `renderBlock` 整段 ANSI；末位未闭合 hold
 *   - fenced code + lang：未闭合走 `formatStreamingCode` dim 字面占位，闭合那一刻
 *     切到 `renderBlock`（cli-highlight 高亮）
 *   - 其他 code / list / table：闭合时 `renderBlock` 整段；末位 list 也走 renderBlock
 *     （末位 item 已被 marked 解析进 list.items，整段 replace 覆盖无错位）
 */

import { marked, type Tokens } from "marked";
import type { ReplaceableSegmentHandle } from "../../screen/screen-controller.js";
import { aiTextAnchor } from "../speaker-state.js";
import { TEXT_STREAM_HANGING_PREFIX } from "../text-stream.js";
import { layout } from "../../tui/style.js";
import {
  formatStreamingCode,
  renderBlock,
  renderParagraph,
  type ParagraphPrefix,
  type RenderContext,
} from "./block-renderer.js";
import { renderInline } from "./inline-renderer.js";
import type { MarkdownMode } from "./types.js";

export interface MarkdownStreamOptions {
  /**
   * 字面 forward 通道——strip / raw 模式使用，render 模式不经此路径。本字段是
   * markdown-stream 作为渲染**单一入口**的契约组件——让三档模式共享 API，caller
   * 不必感知模式差异。
   */
  readonly appendInline: (chunk: string) => void;
  /**
   * ReplaceableSegment 工厂——render 模式必需，整段一 segment 模型的核心依赖。
   * strip / raw 模式可不注入。
   */
  readonly beginReplaceableSegment?: () => ReplaceableSegmentHandle;
  /** 终端列宽，传给 block-renderer / inline-renderer wrap 计算 */
  readonly columns: number;
  /** 渲染模式，默认 render */
  readonly mode?: MarkdownMode;
}

interface TokenRange {
  readonly start: number;
  readonly end: number;
}

export class MarkdownStream {
  private buffer = "";

  // render 主路径状态
  private segment: ReplaceableSegmentHandle | null = null;
  /**
   * 上一次 segment.replace 的 ANSI——行数单调性兜底用。
   *
   * marked 在 token 振荡时（如 `abc\n---` 瞬时被当 setext heading、闭合 block
   * 瞬时退回未闭合 hold）会让 renderFullMarkdown 输出行数短暂下降。而
   * ScrollRegion.replaceSegment 在长 markdown 触发 partial commit 后，要求后续
   * newText 行数 ≥ 已固化行数（否则抛错）。行数下降时保留上一次稳定 ANSI——
   * 振荡通常 1 chunk 内解决，下一 chunk 行数回升后恢复最新内容；这 1 chunk 的
   * "内容不更新"在 30~50ms chunk 间隔下视觉无感。
   */
  private lastRenderedAnsi = "";

  // strip 旁路状态——append-only sink 必须用增量 emit 状态机
  private emittedBlockCount = 0;
  private paragraphForwardedTo = 0;
  private lastEmittedWasParagraph = false;

  private readonly mode: MarkdownMode;
  private readonly appendInline: (chunk: string) => void;
  private readonly beginReplaceableSegment:
    | (() => ReplaceableSegmentHandle)
    | null;
  private readonly columns: number;
  private readonly blockCtx: RenderContext;

  constructor(options: MarkdownStreamOptions) {
    this.mode = options.mode ?? "render";
    this.appendInline = options.appendInline;
    this.beginReplaceableSegment = options.beginReplaceableSegment ?? null;
    this.columns = options.columns;
    this.blockCtx = {
      mode: this.mode,
      indentLevel: 0,
      columns: this.columns,
    };
  }

  feed(chunk: string): void {
    if (chunk.length === 0) return;
    this.buffer += chunk;

    if (this.mode === "raw") {
      this.appendInline(chunk);
      return;
    }
    if (this.mode === "strip") {
      this.feedStrip();
      return;
    }
    this.feedRender();
  }

  end(): void {
    if (this.mode === "render") {
      if (this.segment !== null) {
        // EOF: 所有 token 视为闭合（含末位）；末位 paragraph 全 inline 渲染，
        // 末位 heading / hr / blockquote / code 等切到 renderBlock 整段 ANSI
        const ansi = this.renderFullMarkdown(true);
        this.segment.commit(ansi);
        this.segment = null;
      }
      this.reset();
      return;
    }
    if (this.mode === "strip") {
      this.endStrip();
      this.reset();
      return;
    }
    if (this.mode === "raw" && this.buffer.length > 0) {
      this.appendInline("\n");
    }
    this.reset();
  }

  private reset(): void {
    if (this.segment !== null) {
      this.segment.close();
      this.segment = null;
    }
    this.buffer = "";
    this.lastRenderedAnsi = "";
    this.emittedBlockCount = 0;
    this.paragraphForwardedTo = 0;
    this.lastEmittedWasParagraph = false;
  }

  // ─── render 主路径 ───────────────────────────────────────────────

  private feedRender(): void {
    if (this.segment === null) {
      if (this.beginReplaceableSegment === null) {
        throw new Error(
          "MarkdownStream: render mode requires beginReplaceableSegment factory",
        );
      }
      this.segment = this.beginReplaceableSegment();
    }
    const ansi = this.renderFullMarkdown();
    // 行数单调性兜底：token 振荡导致行数短暂下降时保留上个稳定态
    const finalAnsi =
      lineCount(ansi) >= lineCount(this.lastRenderedAnsi)
        ? ansi
        : this.lastRenderedAnsi;
    this.lastRenderedAnsi = finalAnsi;
    this.segment.replace(finalAnsi);
  }

  /**
   * 整段 buffer → ANSI 纯函数（仅依赖 buffer + 构造时确定的 columns / mode）。
   *
   * ◆ 锚位置由本函数内嵌算法决定——遍历 tokens 时第一个可见 paragraph 的 prefix
   * 注入含锚版本（"  ◆ "），后续 paragraph 退化为 hanging 4 空格无锚，与续行对齐。
   * "可见"判定：renderParagraph 返回非空字符串——空 paragraph（如 isOpen=true 且
   * 仅 1 个 inline 时跳过末位等于全跳过）不算可见，◆ 锚不落在它身上。
   */
  private renderFullMarkdown(isEnd = false): string {
    const tokens = marked.lexer(this.buffer);
    if (tokens.length === 0) return "";

    let ansi = "";
    let anchorEmitted = false;
    const lastIdx = tokens.length - 1;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      // 流式期末位 token 视为未闭合；EOF 时所有 token 闭合
      const treatAsOpen = i === lastIdx && !isEnd;

      if (token.type === "space") continue;

      if (token.type === "paragraph") {
        const prefix = this.paragraphPrefix(anchorEmitted);
        const rendered = renderParagraph(
          token as Tokens.Paragraph,
          this.blockCtx,
          prefix,
          treatAsOpen,
        );
        if (rendered.length > 0) {
          ansi += rendered;
          anchorEmitted = true;
        }
        continue;
      }

      if (token.type === "code") {
        const code = token as Tokens.Code;
        if (treatAsOpen && isCodeOpen(code)) {
          ansi += formatStreamingCode(code.text, this.columns);
        } else {
          ansi += renderBlock(token, this.blockCtx);
        }
        continue;
      }

      if (token.type === "list") {
        ansi += renderBlock(token, this.blockCtx);
        continue;
      }

      if (treatAsOpen) {
        // heading / blockquote / hr / table 末位未闭合 → hold，等闭合后整段切 ANSI
        continue;
      }

      ansi += renderBlock(token, this.blockCtx);
    }

    return ansi;
  }

  private paragraphPrefix(anchorEmitted: boolean): ParagraphPrefix {
    if (anchorEmitted) {
      // turn 内后续 paragraph（非首段）—— 与 heading / list / hr 等 block 的
      // marker 同列（contentPrefix 列 2）左对齐。◆ 是 turn 级发言标识只出现在
      // 首段；后续段无 marker，应回到全局内容基准列，而非缩进到 ◆ 之后（旧
      // TextStream 单段续行逻辑在多 block 混排时会让正文凭空比 heading/list
      // 多缩 2 列，视觉割裂）。
      return {
        firstLinePrefix: layout.contentPrefix,
        continuationPrefix: layout.contentPrefix,
      };
    }
    // turn 首段 —— ◆ 锚是该段 marker（列 2 ◆ + 空格），内容缩进到列 4；
    // wrap / softbreak 续行 hanging 4 与 ◆ 之后内容对齐（同 marker block 的
    // 续行对齐 marker 后内容）
    return {
      firstLinePrefix: `${layout.contentPrefix}${aiTextAnchor()} `,
      continuationPrefix: TEXT_STREAM_HANGING_PREFIX,
    };
  }

  // ─── strip 旁路（增量 emit 状态机） ────────────────────────────────

  private feedStrip(): void {
    const tokens = marked.lexer(this.buffer);
    if (tokens.length === 0) return;
    const ranges = computeTokenRanges(tokens);
    const closedEnd = tokens.length - 1;

    while (this.emittedBlockCount < closedEnd) {
      const i = this.emittedBlockCount;
      const nextType =
        i + 1 < tokens.length ? tokens[i + 1]!.type : null;
      this.emitClosedBlockStrip(tokens[i]!, ranges[i]!, nextType);
      this.emittedBlockCount++;
    }

    const lastIdx = tokens.length - 1;
    this.handleOpenBlockStrip(tokens[lastIdx]!, ranges[lastIdx]!);
  }

  private endStrip(): void {
    if (this.buffer.length === 0) return;

    const tokens = marked.lexer(this.buffer);
    const ranges = computeTokenRanges(tokens);

    while (this.emittedBlockCount < tokens.length) {
      const i = this.emittedBlockCount;
      const nextType =
        i + 1 < tokens.length ? tokens[i + 1]!.type : null;
      this.emitClosedBlockStrip(tokens[i]!, ranges[i]!, nextType);
      this.emittedBlockCount++;
    }

    this.appendInline("\n");
  }

  private emitClosedBlockStrip(
    token: Tokens.Generic,
    range: TokenRange,
    nextType: string | null,
  ): void {
    if (range.end <= this.paragraphForwardedTo) return;

    if (token.type === "paragraph") {
      this.emitInlineTokensStrip(
        token as Tokens.Paragraph,
        range.start,
        false,
      );
      this.paragraphForwardedTo = range.end;
      this.lastEmittedWasParagraph = true;
      return;
    }

    if (token.type === "space") {
      // 段间空行塌缩归一化：CommonMark spec 下 \n\n 与 \n\n\n+ 语义等价。
      // 下一 block 是 paragraph 时按前 block 类型分流：
      //   prev=paragraph → 两段共享 inline 流，emit \n\n 触发段落分隔
      //   prev=非 paragraph → 前 block envelope 已含 \n，再补 1 个 \n 跨 1 空行
      //   首 block 是 paragraph（emittedBlockCount === 0）→ 跳过避免起首空行
      const nextIsParagraph = nextType === "paragraph";
      if (nextIsParagraph && this.emittedBlockCount > 0) {
        if (this.lastEmittedWasParagraph) {
          this.appendInline("\n\n");
        } else {
          this.appendInline("\n");
        }
      }
      this.paragraphForwardedTo = range.end;
      return;
    }

    const ansi = renderBlock(token, this.blockCtx);
    if (ansi.length > 0) this.appendInline(ansi);
    this.paragraphForwardedTo = range.end;
    this.lastEmittedWasParagraph = false;
  }

  private handleOpenBlockStrip(
    token: Tokens.Generic,
    range: TokenRange,
  ): void {
    if (token.type === "paragraph") {
      this.emitInlineTokensStrip(
        token as Tokens.Paragraph,
        range.start,
        true,
      );
      return;
    }
    // heading / list / blockquote / hr / code / table 末位未闭合 → hold（不 emit
    // 字面 markdown 标记，等闭合后整段切 ANSI）
  }

  /**
   * 增量 emit paragraph 内的闭合 inline tokens。末位 inline 在 `isOpen=true` 时
   * hold——marked 把未闭合的 markdown 起首标记当 text 解析（如 `**bo` 是
   * text("**bo")），append-only 模式下已 forward 的字符无法被后续 ANSI 替换，
   * 必须 hold 等闭合再一次性 emit。
   */
  private emitInlineTokensStrip(
    paragraph: Tokens.Paragraph,
    paragraphStart: number,
    isOpen: boolean,
  ): void {
    const inlineTokens = paragraph.tokens ?? [];
    let pos = paragraphStart;
    for (let i = 0; i < inlineTokens.length; i++) {
      const it = inlineTokens[i]!;
      const itEnd = pos + (it.raw?.length ?? 0);
      pos = itEnd;

      if (itEnd <= this.paragraphForwardedTo) continue;

      const isLast = i === inlineTokens.length - 1;
      if (isOpen && isLast) break;

      this.appendInline(renderInline(it, "strip"));
      this.paragraphForwardedTo = itEnd;
    }
  }
}

/** Fenced code block 是否未闭合——`token.raw` trim 后不以闭合 ``` 结尾即视为未闭合 */
function isCodeOpen(token: Tokens.Code): boolean {
  const raw = (token.raw ?? "").trimEnd();
  // marked 把未闭合 fenced code 的 raw 设为 "```lang\n...content"（无闭合 fence）
  // 闭合 fenced 的 raw 末尾必含 ```
  return !raw.endsWith("```");
}

/** ANSI 字符串的物理行数（与 ScrollRegion 的 newText.split("\n").length 对齐） */
function lineCount(ansi: string): number {
  if (ansi.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < ansi.length; i++) {
    if (ansi[i] === "\n") n++;
  }
  return n;
}

function computeTokenRanges(tokens: Tokens.Generic[]): TokenRange[] {
  let pos = 0;
  return tokens.map((t) => {
    const start = pos;
    const end = pos + (t.raw?.length ?? 0);
    pos = end;
    return { start, end };
  });
}
