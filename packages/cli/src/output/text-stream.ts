/**
 * AI 文字流式输出——列 2 缩进 + 起首 ◆ 锚 + wrap hanging 4。
 *
 * 视觉契约：
 *   起首：`  ◆ <text>`（缩进 2 + 锚 + 1 空格 + 文字）
 *   续行：`    <text>`（hanging 4 = 缩进 2 + 锚 1 + 空格 1）
 *   wrap：撞 maxLineWidth 时插 \n + hanging
 *   chunk 内 `\n` 触发硬换行（不重复锚字符）
 *
 * 当前不识别 markdown——纯文字流，chunk 内若含 ANSI 序列由 caller 自管
 * （wrap 仅按 codePoint 宽度计算，不剥 ANSI；上层若要传染色文字，需保证
 * ANSI 不跨 codePoint 边界）。markdown 流式渲染由后续模块在外层 transform
 * 后再喂入本流。
 */

import { aiTextAnchor } from "./speaker-state.js";
import { charWidth } from "../tui/line-width.js";
import { getTerminalWidth } from "../tui/style.js";

const CONTENT_INDENT = 2;
/** 锚字符 1 列 + 空格 1 列 = 续行缩进比 CONTENT_INDENT 多 2 列 */
const HANGING_INDENT = CONTENT_INDENT + 2;
/** 极窄终端的下界——避免 maxLineWidth 跌至 0 导致 wrap 死循环 */
const MIN_USABLE_WIDTH = 20;

const FIRST_LINE_PREFIX = " ".repeat(CONTENT_INDENT);
const HANGING_PREFIX = " ".repeat(HANGING_INDENT);

export interface TextStreamOptions {
  readonly stdout?: NodeJS.WriteStream;
}

export class TextStream {
  private hasStarted = false;
  private currentColWidth = 0;
  private readonly maxLineWidth: number;
  private readonly stdout: NodeJS.WriteStream;

  constructor(options: TextStreamOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    const termWidth = getTerminalWidth(this.stdout);
    this.maxLineWidth = Math.max(termWidth - HANGING_INDENT, MIN_USABLE_WIDTH);
  }

  /**
   * 喂入 LLM 流式 chunk，立即写入 stdout——不缓冲，保留打字机视觉。
   * 第一次 feed 自动写起首锚 `  ◆ `；后续 feed 仅追加。
   */
  feed(chunk: string): void {
    if (!chunk) return;

    if (!this.hasStarted) {
      this.stdout.write(`${FIRST_LINE_PREFIX}${aiTextAnchor()} `);
      this.hasStarted = true;
      this.currentColWidth = 0;
    }

    const segments = chunk.split("\n");
    for (let i = 0; i < segments.length; i++) {
      this.writeSegment(segments[i]!);
      if (i < segments.length - 1) {
        this.stdout.write(`\n${HANGING_PREFIX}`);
        this.currentColWidth = 0;
      }
    }
  }

  /** turn 末——若已起首，写末尾换行让下一轮回到列 0 起手。未起首时不写。 */
  end(): void {
    if (this.hasStarted) {
      this.stdout.write("\n");
      this.hasStarted = false;
      this.currentColWidth = 0;
    }
  }

  private writeSegment(seg: string): void {
    for (const ch of seg) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      const w = charWidth(cp);
      if (this.currentColWidth + w > this.maxLineWidth && this.currentColWidth > 0) {
        this.stdout.write(`\n${HANGING_PREFIX}`);
        this.currentColWidth = 0;
      }
      this.stdout.write(ch);
      this.currentColWidth += w;
    }
  }
}
