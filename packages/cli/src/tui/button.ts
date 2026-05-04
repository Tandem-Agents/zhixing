/**
 * 按钮形状——直角 box drawing 边框，与文字行天然区分。
 *
 *   ┌────────────────────┐
 *   │  完成（保存并启动）  │
 *   └────────────────────┘
 *
 * primary（主按钮）：边框 + label 走 success 色，形成"全部就绪"的视觉路径
 * 次按钮：边框 dim
 * 选中：label 反白 + 粗体（与 primary 共存）
 *
 * 三行输出——caller 决定是否前置 cursor / 整体缩进。
 */

import { glyph, tone } from "./style.js";
import { stringWidth } from "./line-width.js";

export interface ButtonOptions {
  label: string;
  selected?: boolean;
  /** 主按钮（绿色边框）——通常是"全部就绪"时的主操作 */
  primary?: boolean;
}

const HORIZONTAL_PAD = 2;

export function renderButton(opts: ButtonOptions): string[] {
  const labelWidth = stringWidth(opts.label);
  const innerWidth = labelWidth + HORIZONTAL_PAD * 2;
  const borderColor = opts.primary ? tone.success : tone.dim;

  const top =
    borderColor(glyph.sharp.topLeft) +
    borderColor(glyph.horizontal.repeat(innerWidth)) +
    borderColor(glyph.sharp.topRight);
  const bottom =
    borderColor(glyph.sharp.bottomLeft) +
    borderColor(glyph.horizontal.repeat(innerWidth)) +
    borderColor(glyph.sharp.bottomRight);

  let label = opts.label;
  if (opts.primary) label = tone.success(label);
  if (opts.selected) label = tone.bold(tone.inverse(label));

  const middle =
    borderColor(glyph.vertical) +
    " ".repeat(HORIZONTAL_PAD) +
    label +
    " ".repeat(HORIZONTAL_PAD) +
    borderColor(glyph.vertical);

  return [top, middle, bottom];
}
