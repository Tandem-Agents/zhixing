/**
 * Markdown 流式渲染主入口——LLM chunk → ANSI 输出协调器。
 *
 * **流式策略**：
 *   - chunk 累积到 buffer，每 chunk 重新 marked.lexer(buffer) 得到当前 tokens
 *   - 末尾 token 是 code block → 严格 hold 等 ``` 闭合（代码完整性优先；通常 LLM 输出
 *     代码块速度快、长度有限，hold 时间用户可接受）
 *   - 末尾 token 是其他类型（paragraph / list / blockquote / heading / hr / space）→
 *     **按字面字符 forward 给 paragraph 流**，不 hold——避免 LLM 输出长 list / 引用 /
 *     setext heading underline 等结构时用户看不到任何 streaming 输出
 *   - 闭合 block emit 时检查"该 block 在 buffer 中的位置是否已字面 forward 过"，
 *     已 forward 跳过避免重复显示；仅 code block 走 hold 后 ANSI emit 路径
 *
 * **视觉 trade-off（本 step 范围）**：
 *   - paragraph：◆ 锚 + 字面字符 + wrap hanging 4（含 inline markdown 标记字面）
 *   - code block：dim 文字 + 列 2 + 起首空行（闭合后 ANSI 渲染）
 *   - heading / list / blockquote / hr：**字面字符流式**（视觉退化为 `# 标题` / `- item` /
 *     `> quote` / `---` 字面 markdown 标记）。这些 block 的 ANSI 视觉留给后续 step——
 *     需要用 list item 行级流式 / 单行 token 增量渲染才能既不卡又有视觉
 *
 * **三档 mode**：
 *   - render：完整 markdown 渲染（默认 cli REPL TTY）
 *   - strip：不染色 / 不锚（CI / pipe / 日志），paragraph 字面 forward 不经 TextStream
 *   - raw：直接原文 forward，不解析（调试）
 */

import { marked, type Tokens } from "marked";
import { TextStream } from "../text-stream.js";
import { renderBlock } from "./block-renderer.js";
import type { MarkdownMode } from "./types.js";

export interface MarkdownStreamOptions {
  /** 流式段（paragraph 字面）走 appendInline；闭合 code block 走 line。两路径都注入。 */
  readonly appendInline: (chunk: string) => void;
  readonly line: (text: string) => void;
  /** 终端列宽——TextStream wrap 计算用 */
  readonly columns: number;
  readonly mode?: MarkdownMode;
}

interface TokenRange {
  readonly start: number;
  readonly end: number;
}

export class MarkdownStream {
  private buffer = "";
  /**
   * buffer 中已字面 forward 给 paragraph 流的字符末位 offset。
   *
   * 关键不变量：buffer[0, paragraphForwardedTo) 已经经 paragraph 流（render 模式走
   * TextStream）/ appendInline（strip 模式）输出到 stdout。emit 闭合 block 时如果
   * block 完全落在 [0, paragraphForwardedTo) 内，跳过 ANSI emit 避免重复显示。
   */
  private paragraphForwardedTo = 0;
  /** 已 emit 的闭合 block 数（buffer 中前 N 个 token 已处理）。 */
  private emittedBlockCount = 0;
  /**
   * 当前活跃的 paragraph TextStream；仅 render 模式使用。
   * 切换到 hold（末尾 code block）时关闭——之后再来非 code 末尾会重新创建。
   * 多 paragraph 共享同一实例（段落分隔靠 \n\n 字符 + TextStream 内部 hanging 续行
   * 语义实现，无需重新起 ◆ 锚）。
   */
  private paragraphStream: TextStream | null = null;
  private readonly mode: MarkdownMode;
  private readonly appendInline: (chunk: string) => void;
  private readonly line: (text: string) => void;
  private readonly columns: number;

  constructor(options: MarkdownStreamOptions) {
    this.appendInline = options.appendInline;
    this.line = options.line;
    this.columns = options.columns;
    this.mode = options.mode ?? "render";
  }

  feed(chunk: string): void {
    if (chunk.length === 0) return;
    this.buffer += chunk;

    if (this.mode === "raw") {
      this.appendInline(chunk);
      return;
    }

    const tokens = marked.lexer(this.buffer);
    if (tokens.length === 0) return;
    const ranges = computeTokenRanges(tokens);

    // 闭合 blocks（除末尾 hold 候选）逐个处理
    const closedEnd = tokens.length - 1;
    while (this.emittedBlockCount < closedEnd) {
      const i = this.emittedBlockCount;
      this.emitClosedBlock(tokens[i]!, ranges[i]!);
      this.emittedBlockCount++;
    }

    // 末尾 token 决定 hold 还是字面 forward
    const lastIdx = tokens.length - 1;
    this.handleOpenBlock(tokens[lastIdx]!, ranges[lastIdx]!);
  }

  end(): void {
    if (this.buffer.length === 0) return;

    if (this.mode === "raw") {
      this.appendInline("\n");
      this.reset();
      return;
    }

    // EOF 重新解析——marked 在 EOF 上把所有 hold 的 token 视为闭合
    const tokens = marked.lexer(this.buffer);
    const ranges = computeTokenRanges(tokens);

    while (this.emittedBlockCount < tokens.length) {
      const i = this.emittedBlockCount;
      this.emitClosedBlock(tokens[i]!, ranges[i]!);
      this.emittedBlockCount++;
    }

    // 把 buffer 中尚未 forward 的剩余字符（理论上应该都已 forward 或被 emitClosedBlock
    // 处理，此为保险——避免任何字符被吞）forward 出去；然后关闭 paragraph 流落 \n
    this.forwardBufferRange(this.buffer.length);
    this.closeParagraphStream();
    this.reset();
  }

  private reset(): void {
    this.buffer = "";
    this.emittedBlockCount = 0;
    this.paragraphForwardedTo = 0;
    this.paragraphStream = null;
  }

  /**
   * 闭合 block emit：
   *   - 已被字面 forward（block 完全落在 paragraphForwardedTo 之前）→ 跳过避免重复
   *   - code block → ANSI 渲染独立段 emit（唯一走 ANSI 路径的类型）
   *   - space → 仅当 paragraph 流活跃时 forward `\n\n` 触发段落分隔；流已关闭时（如刚
   *     emit code block 后）跳过，仅推进 forwarded 边界（避免给新 paragraph 流喂 `\n\n`
   *     创建空 ◆ 段）
   *   - paragraph / heading / list / blockquote / hr → 字面 forward 给 paragraph 流
   */
  private emitClosedBlock(token: Tokens.Generic, range: TokenRange): void {
    if (range.end <= this.paragraphForwardedTo) return;

    if (token.type === "code") {
      this.closeParagraphStream();
      const ansi = renderBlock(token, this.mode);
      if (ansi.length > 0) this.line(ansi);
      this.paragraphForwardedTo = range.end;
      return;
    }

    if (token.type === "space") {
      if (this.paragraphStream !== null || this.mode === "strip") {
        this.forwardBufferRange(range.end);
      } else {
        this.paragraphForwardedTo = range.end;
      }
      return;
    }

    // paragraph / heading / list / blockquote / hr —— 字面 forward
    this.forwardBufferRange(range.end);
  }

  /**
   * 末尾 hold 候选 block 的处理：
   *   - code block：严格 hold 等 ``` 闭合（保代码完整性 + 通常输出快），关闭 paragraph 流
   *   - space：不 forward（避免给空 buffer 末位创建空 ◆ 段；等下次实质内容 chunk 来再起手）
   *   - 其他类型（paragraph / list / blockquote / heading / hr）：字面 forward 让用户看到
   *     streaming 输出，不卡 LLM 写长 list / 引用 / setext heading underline 等场景
   */
  private handleOpenBlock(token: Tokens.Generic, range: TokenRange): void {
    if (token.type === "code") {
      this.closeParagraphStream();
      return;
    }
    if (token.type === "space") {
      return;
    }
    this.forwardBufferRange(range.end);
  }

  /**
   * 把 buffer [paragraphForwardedTo, toOffset) 的字符 forward 给 paragraph 流。
   *
   * render 模式走 TextStream（◆ 锚 + 列 2 + hanging 4 + ANSI 染色 + \n\n 段落分隔
   * 自动 hanging 续行无新锚）；strip 模式直接 appendInline 字面字符。
   *
   * 同 chunk 内多次调用通过 paragraphForwardedTo 单调递增保证不重复 forward。
   */
  private forwardBufferRange(toOffset: number): void {
    if (toOffset <= this.paragraphForwardedTo) return;
    const delta = this.buffer.slice(this.paragraphForwardedTo, toOffset);
    this.paragraphForwardedTo = toOffset;

    if (this.mode === "strip") {
      this.appendInline(delta);
      return;
    }

    if (this.paragraphStream === null) {
      this.paragraphStream = new TextStream({
        write: this.appendInline,
        columns: this.columns,
      });
    }
    this.paragraphStream.feed(delta);
  }

  private closeParagraphStream(): void {
    if (this.paragraphStream !== null) {
      this.paragraphStream.end();
      this.paragraphStream = null;
      return;
    }
    if (this.mode === "strip" && this.paragraphForwardedTo > 0) {
      // strip 模式没有 TextStream 协调末尾 \n，markdown-stream 自补让段独立落地
      // 仅当本流已字面 forward 过内容时才补 \n（避免空 buffer 写多余空行）
      this.appendInline("\n");
    }
  }
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
