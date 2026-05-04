/**
 * 输入区独立视觉容器——超长输入框内换行（绝不横向滚动）。
 *
 *   ╭────────────────────────────────────────────╮
 *   │  > 用户输入文本                              │
 *   │  超长内容自动换行到下一行                    │
 *   ╰────────────────────────────────────────────╯
 *
 * 与 chrome 的差别：
 *   - 不嵌入标题（标题由外层容器表达，这里只关心可输入区）
 *   - 内容是 buffer 文本，按显示宽度自动换行——CJK 占 2 列
 *   - 空 buffer 也保留至少 1 行高度（让用户知道"这里能输入"）
 */

import { glyph, tone } from "./style.js";
import { stringWidth, wrapToWidth } from "./line-width.js";

export interface InputFrameOptions {
  /** 提示符，如 "> "；缺省 "" */
  prompt?: string;
  /** 用户当前输入 buffer */
  buffer: string;
  /** 容器宽度（含左右边框） */
  width: number;
}

const INDENT = 2;
const RIGHT_INNER_PAD = 1;

export function renderInputFrame(opts: InputFrameOptions): string[] {
  const width = Math.max(4, opts.width);
  const innerWidth = width - 2;
  const contentWidth = Math.max(1, innerWidth - INDENT - RIGHT_INNER_PAD);
  const prompt = opts.prompt ?? "";

  const top =
    tone.dim(glyph.rounded.topLeft) +
    tone.dim(glyph.horizontal.repeat(innerWidth)) +
    tone.dim(glyph.rounded.topRight);
  const bottom =
    tone.dim(glyph.rounded.bottomLeft) +
    tone.dim(glyph.horizontal.repeat(innerWidth)) +
    tone.dim(glyph.rounded.bottomRight);

  const wrapped = wrapToWidth(prompt + opts.buffer, contentWidth);
  const bodyLines = wrapped.length === 0 ? [""] : wrapped;

  const middle = bodyLines.map((line) => {
    const padWidth = Math.max(0, contentWidth - stringWidth(line));
    return (
      tone.dim(glyph.vertical) +
      " ".repeat(INDENT) +
      line +
      " ".repeat(padWidth) +
      " ".repeat(RIGHT_INNER_PAD) +
      tone.dim(glyph.vertical)
    );
  });

  return [top, ...middle, bottom];
}

