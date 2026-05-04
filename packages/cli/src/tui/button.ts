/**
 * 按钮形状——直角 box drawing 边框，与文字行天然区分。
 *
 *   ┌────────┐
 *   │  完成  │
 *   └────────┘
 *
 * Label 仅放短动作名（"完成" / "取消"）；说明性 hint 由调用方拼到按钮外侧。
 *
 * 状态轴（不依赖 bg 染色——bg 在跨终端/字体组合下会"溢出"到边框外，不可靠）：
 *   primary（主按钮）：fg 走 success 色，形成"全部就绪"的视觉路径
 *   secondary（次按钮）：fg dim
 *   selected：在原色基础上加 bold——视觉重量加强；
 *            选中标记 ▸ 由 caller 放在按钮左侧外部（跨行不打扰 box 形态）
 *
 * 三行输出——caller 决定 cursor 位置 / 整体缩进。
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
  const style = pickWholeStyle(opts);

  const horizontal = glyph.horizontal.repeat(innerWidth);
  const top = style(glyph.sharp.topLeft + horizontal + glyph.sharp.topRight);
  const middle = style(
    glyph.vertical +
      " ".repeat(HORIZONTAL_PAD) +
      opts.label +
      " ".repeat(HORIZONTAL_PAD) +
      glyph.vertical,
  );
  const bottom = style(
    glyph.sharp.bottomLeft + horizontal + glyph.sharp.bottomRight,
  );

  return [top, middle, bottom];
}

/**
 * 整个按钮（顶 / 中 / 底三行）共用一个 styler——纯 fg 色 + bold，无 bg。
 * 选中态在原色基础上加粗强调，靠 caller 在外部加 cursor 标识"被选中"。
 */
function pickWholeStyle(opts: ButtonOptions): (s: string) => string {
  if (opts.selected && opts.primary) return tone.success.bold;
  if (opts.selected) return tone.bold;
  if (opts.primary) return tone.success;
  return tone.dim;
}
