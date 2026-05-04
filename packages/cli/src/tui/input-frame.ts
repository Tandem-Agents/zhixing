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
import { stringWidth, charWidth } from "./line-width.js";

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

/**
 * 按显示宽度软换行。
 *
 * 不在词边界换——终端输入场景里"半个 URL"可读性不会因换行下降，
 * 而强行词边界会导致很多输入文本断层。CJK 字符按 2 列计算。
 */
function wrapToWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const w = charWidth(cp);
    if (currentWidth + w > maxWidth) {
      lines.push(current);
      current = ch;
      currentWidth = w;
    } else {
      current += ch;
      currentWidth += w;
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}
