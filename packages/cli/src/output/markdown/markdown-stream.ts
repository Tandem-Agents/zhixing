/**
 * Markdown 流式渲染主入口——LLM chunk → ANSI 输出协调器。
 *
 * **按 block 类型分路**：
 *   - chunk 累积到 buffer，每 chunk 重新 marked.lexer(buffer) 得到当前 tokens
 *   - **fenced code block**（含 lang）+ 注入 beginReplaceableSegment 时走双态：
 *     流式期 segment.replace(formatStreamingCode) 用 dim 字面占位，闭合时
 *     segment.commit(renderBlock) 切换为 cli-highlight 语法高亮——用户能即时看到
 *     代码字符流入，闭合那一刻整段切色。
 *   - **indented code / 无 lang fenced / 未注入 segment factory（StdoutWriter）**：
 *     退化为严格 hold——等 ``` 闭合后走 `renderBlock` 独立段 ANSI emit。
 *   - **paragraph**：走 `emitInlineTokens` inline 增量 ANSI emit。闭合 paragraph emit
 *     全部 inline tokens 的 ANSI 渲染；末尾未闭合 paragraph emit 已闭合的前 N-1 个
 *     inline，**最后一个 inline 一律 hold**（含 text）——marked 把未闭合的 markdown
 *     起首标记当 text 解析（如 `**bo` 是 text("**bo")），若字面 forward 则后续 chunk
 *     让 marked 重解析为 strong 时已 forward 字符无法被 ANSI 替换。换"末尾未闭合段
 *     不流式（典型 1~2s 等待）"代价得到"闭合后 inline 元素 ANSI 渲染正确"视觉
 *   - **heading / blockquote / hr**：hold 等闭合；闭合后 `renderBlock + line` 整段
 *     ANSI emit。字面 markdown 标记（# / > / ---）不再泄露给用户。多数场景闭合快——
 *     heading / hr 单 \n 即可、blockquote 等待数 chunk 可接受
 *   - **list**：默认 hold；render 模式 + 注入 beginReplaceableSegment 时走 Replaceable
 *     Segment 渐进 replace 整段（与 code block 双态同模式）——长 list 用户能即时看到
 *     items 累积
 *   - **space**：仅当 paragraph 流活跃时 forward `\n\n` 触发段落分隔
 *   - 已 emit 的 block 通过 `paragraphForwardedTo` 单调推进的不变量跳过避免重复
 *
 * **视觉契约**：
 *   - paragraph：◆ 锚 + inline ANSI（**bold** / _italic_ / `code` 中灰底 / 链接 OSC 8 +
 *     虚线下划线 / ~~del~~）+ wrap hanging 4 续行
 *   - code block：流式期 dim 字面 + 列 2 + 起首/末尾空行；闭合后 cli-highlight 语法
 *     高亮（fenced + 受支持 lang）或保持 dim（其他情况）
 *   - heading：列 2 + bold（depth=1 brand cyan）；起首 / 末尾空行
 *   - list：列 2 + dim marker + inline ANSI 文字；嵌套每层多 2 列；起首 / 末尾空行
 *   - blockquote：列 2 + 整段 dim（递归处理子 block）；起首 / 末尾空行
 *   - hr：列 2 + dim 横线 ─ × 40；起首 / 末尾空行
 *
 * **三档 mode**：
 *   - render：完整 markdown 渲染（默认 cli REPL TTY）；fenced + 受支持 lang code
 *     block 走双态（前提：caller 注入 beginReplaceableSegment）
 *   - strip：inline-renderer strip 模式输出纯文本（link 退化 `text (url)`）+ 不经 TextStream
 *     的 ◆ 锚（CI / pipe / 日志，paragraph 直接 appendInline 字面字符）；code block
 *     不走双态（hold 等闭合再 line）
 *   - raw：直接原文 forward 不解析（调试用）
 */

import { marked, type Tokens } from "marked";
import type { ReplaceableSegmentHandle } from "../../screen/screen-controller.js";
import { TextStream } from "../text-stream.js";
import { formatStreamingCode, renderBlock } from "./block-renderer.js";
import { renderInline } from "./inline-renderer.js";
import type { MarkdownMode } from "./types.js";

export interface MarkdownStreamOptions {
  /** 流式 paragraph 内容走 appendInline；闭合 code block 走 line。两路径都注入。 */
  readonly appendInline: (chunk: string) => void;
  readonly line: (text: string) => void;
  /** 终端列宽——TextStream wrap 计算用 */
  readonly columns: number;
  readonly mode?: MarkdownMode;
  /**
   * 可选——开启 code block 双态渲染（流式期 dim 字面占位、闭合时 cli-highlight
   * 语法高亮替换）。
   *
   * 注入时机：仅 cli REPL chrome 模式有意义（ScreenWriter 转发 ScreenController.
   * beginReplaceableSegment）。StdoutWriter / runOnce / 测试场景不注入——code
   * block 退化为现行 hold 路径，行为不变。
   *
   * 启用条件还需：mode === "render" + token 是 fenced（lang !== undefined）。
   * indented code / 无 lang fenced 仍走 hold 路径（避免误把段首带空格的 paragraph
   * 当 indented code 起首 segment）。
   */
  readonly beginReplaceableSegment?: () => ReplaceableSegmentHandle;
}

interface TokenRange {
  readonly start: number;
  readonly end: number;
}

export class MarkdownStream {
  private buffer = "";
  /**
   * buffer 中已 emit 处理的字符末位 offset（含 paragraph inline ANSI emit 与
   * heading/list/blockquote/hr 字面 forward 两条路径）。
   *
   * 关键不变量：buffer[0, paragraphForwardedTo) 已经经过 emit 路径（render 模式
   * 走 TextStream / strip 模式走 appendInline）输出到 stdout。emit 闭合 block 时
   * 如果 block 完全落在 [0, paragraphForwardedTo) 内，跳过避免重复显示。
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
  /**
   * 当前活跃的 fenced code block 的 ReplaceableSegment——双态渲染流式期持有，
   * 闭合时 commit 切换到 highlight 后置 null。仅 render 模式 + caller 注入了
   * beginReplaceableSegment + token 是 fenced (lang !== undefined) 时存在。
   */
  private codeSegment: ReplaceableSegmentHandle | null = null;
  /**
   * 当前活跃的 list ReplaceableSegment——长 list 跨 chunk 时持有，闭合时 commit
   * 整段。仅 render 模式 + caller 注入 beginReplaceableSegment 时存在。与 code
   * segment 互斥（marked 末尾 token 一次只有一个 block）。
   */
  private listSegment: ReplaceableSegmentHandle | null = null;
  private readonly mode: MarkdownMode;
  private readonly appendInline: (chunk: string) => void;
  private readonly line: (text: string) => void;
  private readonly columns: number;
  private readonly beginReplaceableSegment:
    | (() => ReplaceableSegmentHandle)
    | null;

  constructor(options: MarkdownStreamOptions) {
    this.appendInline = options.appendInline;
    this.line = options.line;
    this.columns = options.columns;
    this.mode = options.mode ?? "render";
    this.beginReplaceableSegment = options.beginReplaceableSegment ?? null;
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
    // 防御：流式期 segment 应已在 emitClosedBlock 时 commit 关闭；若仍活跃
    // （解析途中异常 / caller 错误），强制 close 避免残留 hasActiveSegment 状态
    if (this.codeSegment !== null) {
      this.codeSegment.close();
      this.codeSegment = null;
    }
    if (this.listSegment !== null) {
      this.listSegment.close();
      this.listSegment = null;
    }
  }

  /**
   * 闭合 block emit：
   *   - 已被字面 forward（block 完全落在 paragraphForwardedTo 之前）→ 跳过避免重复
   *   - code block → 双态：若有活跃 segment，commit 切换到 highlight；否则走现行
   *     line 独立段 emit
   *   - paragraph → 走 inline 增量 ANSI 路径（emitInlineTokens 闭合 emit 全部 inline
   *     tokens 的 ANSI 渲染；递增推进 paragraphForwardedTo 到 range.end 让 paragraph
   *     末尾换行等残余字符不重复 forward）
   *   - space → 仅当 paragraph 流活跃时 forward `\n\n` 触发段落分隔；流已关闭时（如刚
   *     emit code block 后）跳过，仅推进 forwarded 边界（避免给新 paragraph 流喂 `\n\n`
   *     创建空 ◆ 段）
   *   - heading / list / blockquote / hr → 字面 forward 给 paragraph 流（其 ANSI
   *     行级渲染留待后续 step）
   */
  private emitClosedBlock(token: Tokens.Generic, range: TokenRange): void {
    if (range.end <= this.paragraphForwardedTo) return;

    if (token.type === "code") {
      this.emitClosedCode(token as Tokens.Code);
      this.paragraphForwardedTo = range.end;
      return;
    }

    if (token.type === "list") {
      this.emitClosedList(token as Tokens.List);
      this.paragraphForwardedTo = range.end;
      return;
    }

    if (token.type === "paragraph") {
      this.emitInlineTokens(token as Tokens.Paragraph, range.start, false);
      // paragraph.raw 末尾的换行 / 残余字符不在 inline tokens 累计长度内——直接推到
      // range.end 让后续 space 字符 forward 不重复历经这段空 delta
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

    // heading / list / blockquote / hr —— 闭合时 renderBlock 整段 ANSI emit（独立段
    // 经 line 路径写入 ScreenController）。hold 期间字面字符已由 handleOpenBlock 不
    // 再 forward 给 paragraph 流——用户不会看到 `#` / `-` / `>` / `---` 字面 markdown
    // 标记暴露
    this.closeParagraphStream();
    const ansi = renderBlock(token, this.mode);
    if (ansi.length > 0) this.line(ansi);
  }

  /**
   * 末尾 hold 候选 block 的处理：
   *   - code block：双态（render 模式 + fenced lang + 注入 segment factory）走流式
   *     replace dim 字面占位；其他情况严格 hold 等 ``` 闭合
   *   - paragraph：emitInlineTokens 增量 emit 已闭合的 inline tokens（前面 N-1 个全部
   *     ANSI emit），末尾未闭合的 inline token 全部 hold（含 text）。原因：marked 把
   *     未闭合的 markdown 标记当 text 处理（如 `**bo` 整段是 text），如果按 raw 字面
   *     forward 出去，后续 chunk 来让 marked 把它识别为 strong 起手时——已 forward
   *     的 `**` 字面字符无法用 ANSI bold 替换（stdout 写出去无法撤回）。换"末尾段需
   *     等闭合（如 \n\n）才显示" 的代价（typical LLM 段长几句话，等待 1~2s 可接受）
   *     得到"闭合后 inline 元素 ANSI 渲染正确"的视觉
   *   - space：不 forward（避免给空 buffer 末位创建空 ◆ 段；等下次实质内容 chunk 来再起手）
   *   - heading / blockquote / hr：hold 等闭合（不 forward 字面字符）。理由同 paragraph
   *     末尾 hold——已 forward 的 markdown 标记字符（# / > / ---）无法被闭合时 ANSI
   *     替换。多数场景闭合快（heading / hr 单 \n 即可），blockquote 等待可接受
   *   - list：hold 路径（无 segment factory 时）；render 模式 + 注入 segment factory
   *     时走 handleOpenList 用 ReplaceableSegment 渐进 replace 整段渲染——长 list
   *     用户能即时看到 items 累积（与 code block 双态同模式）
   */
  private handleOpenBlock(token: Tokens.Generic, range: TokenRange): void {
    if (token.type === "code") {
      this.handleOpenCode(token as Tokens.Code);
      return;
    }
    if (token.type === "list") {
      this.handleOpenList(token as Tokens.List);
      return;
    }
    if (token.type === "space") {
      return;
    }
    if (token.type === "paragraph") {
      this.emitInlineTokens(token as Tokens.Paragraph, range.start, true);
      return;
    }
    // heading / blockquote / hr —— hold（不 emit 字面字符），等闭合由
    // emitClosedBlock 整段 ANSI emit
  }

  /**
   * 开启 / 推进 code block 流式期。
   *
   * 双态启用条件：mode === render + token 是 fenced（lang !== undefined）+ caller
   * 注入了 beginReplaceableSegment。任一不满足走 hold 路径（与历史行为一致）。
   *
   * 启用时：首次 begin segment、关 paragraph 流（独立段语义）；每次 chunk 把
   * 当前 token.text（marked 给出的代码累积内容）格式化为 dim 占位整段、调
   * segment.replace 替换 segment 持有内容。
   */
  private handleOpenCode(token: Tokens.Code): void {
    const enableTwoPhase =
      this.mode === "render" &&
      token.lang !== undefined &&
      this.beginReplaceableSegment !== null;

    if (!enableTwoPhase) {
      // 退化 hold：关闭 paragraph 流让 code 起首为独立段；闭合时由 emitClosedCode
      // 走 line 路径——与历史行为完全一致
      this.closeParagraphStream();
      return;
    }

    if (this.codeSegment === null) {
      this.closeParagraphStream();
      this.codeSegment = this.beginReplaceableSegment!();
    }
    this.codeSegment.replace(formatStreamingCode(token.text));
  }

  /**
   * 闭合 code block emit。双态活跃时 commit 切换 dim → highlight；否则走 hold 路径
   * 的 line emit。两路径都已自带前后空行（renderBlock 起首 \n + 末尾 \n）。
   */
  private emitClosedCode(token: Tokens.Code): void {
    if (this.codeSegment !== null) {
      const ansi = renderBlock(token, this.mode);
      this.codeSegment.commit(ansi);
      this.codeSegment = null;
      return;
    }
    this.closeParagraphStream();
    const ansi = renderBlock(token, this.mode);
    if (ansi.length > 0) this.line(ansi);
  }

  /**
   * 开启 / 推进 list 流式期。
   *
   * 启用条件：mode === render + caller 注入 beginReplaceableSegment。任一不满足走
   * hold 路径（不 emit）。启用时：首次 begin segment、关 paragraph 流（独立段语义）；
   * 每次 chunk 把当前 list 整段 renderBlock 后 segment.replace —— marked 已识别的
   * items（含末尾 item 当前累积内容）即时可见，长 list 不再卡 streaming。
   */
  private handleOpenList(list: Tokens.List): void {
    if (this.mode !== "render" || this.beginReplaceableSegment === null) {
      return;
    }
    if (this.listSegment === null) {
      this.closeParagraphStream();
      this.listSegment = this.beginReplaceableSegment();
    }
    this.listSegment.replace(renderBlock(list, this.mode));
  }

  /**
   * 闭合 list emit。双态活跃时 commit 整段；否则走 hold 路径的 line emit。
   */
  private emitClosedList(list: Tokens.List): void {
    if (this.listSegment !== null) {
      const ansi = renderBlock(list, this.mode);
      this.listSegment.commit(ansi);
      this.listSegment = null;
      return;
    }
    this.closeParagraphStream();
    const ansi = renderBlock(list, this.mode);
    if (ansi.length > 0) this.line(ansi);
  }

  /**
   * 增量 emit paragraph 内的 inline tokens（render 模式走 ANSI；strip 模式纯文本；
   * raw 模式不会进入此函数 — feed() 早返回）。
   *
   * 按 inline token 在 buffer 中的累计 [pos, pos+raw.length) 与 paragraphForwardedTo
   * 比较：itEnd <= forwardedTo 视为已 emit 跳过（避免同段已 emit 的闭合 inline 重复
   * forward）；其余 inline 走 `renderInline(it)` 整体 ANSI emit。
   *
   * **末尾未闭合 inline 一律 hold**（含 text）。marked 把未闭合的 markdown 起首标记
   * 当 text 解析（如 `**bo` 是 text("**bo")），后续 chunk 让 marked 重解析为 strong
   * 时——已字面 forward 的 `**` 字符无法被 ANSI bold 替换（stdout 不可撤回）。统一
   * hold 让闭合后 ANSI 渲染正确，代价是末尾未闭合段不流式（典型 LLM 段长几句话，
   * 可接受 1~2s 等待换 inline 元素 ANSI 视觉正确）
   */
  private emitInlineTokens(
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

      const isLastInline = i === inlineTokens.length - 1;
      if (isOpen && isLastInline) {
        // 末尾未闭合 inline → hold 等闭合再 emit
        break;
      }

      // 闭合 inline——整体 ANSI 渲染整体 forward
      this.forwardToParagraphStream(renderInline(it, this.mode));
      this.paragraphForwardedTo = itEnd;
    }
  }

  /**
   * 把任意字符串 forward 给 paragraph 流。
   *
   * render 模式走 TextStream（◆ 锚 + 列 2 + hanging 4 + ANSI-aware wrap + \n\n 段落
   * 分隔自动 hanging 续行无新锚）；strip 模式直接 appendInline 字面字符。
   *
   * 流式段（paragraph inline）与字面段（heading/list/blockquote/hr）共享同一 paragraph
   * 流实例——切换到 hold（末尾 code block）时 closeParagraphStream 关闭，之后非 code
   * 末尾会重新 lazy 创建。
   */
  private forwardToParagraphStream(text: string): void {
    if (text.length === 0) return;

    if (this.mode === "strip") {
      this.appendInline(text);
      return;
    }

    if (this.paragraphStream === null) {
      this.paragraphStream = new TextStream({
        write: this.appendInline,
        columns: this.columns,
      });
    }
    this.paragraphStream.feed(text);
  }

  /**
   * 把 buffer [paragraphForwardedTo, toOffset) 的字符 forward 给 paragraph 流。
   *
   * 用于字面 forward 路径（heading / list / blockquote / hr / space 段落分隔）。
   * paragraph 走 emitInlineTokens 不经此路径——避免 inline 标记字符与 ANSI 重复 emit。
   *
   * 同 chunk 内多次调用通过 paragraphForwardedTo 单调递增保证不重复 forward。
   */
  private forwardBufferRange(toOffset: number): void {
    if (toOffset <= this.paragraphForwardedTo) return;
    const delta = this.buffer.slice(this.paragraphForwardedTo, toOffset);
    this.paragraphForwardedTo = toOffset;
    this.forwardToParagraphStream(delta);
  }

  private closeParagraphStream(): void {
    if (this.paragraphStream !== null) {
      this.paragraphStream.end();
      this.paragraphStream = null;
      return;
    }
    if (this.mode === "strip" && this.paragraphForwardedTo > 0) {
      // strip 模式没有 TextStream 协调末尾 \n，markdown-stream 自补让段独立落地
      // 仅当本流已 emit 过内容时才补 \n（避免空 buffer 写多余空行）
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
