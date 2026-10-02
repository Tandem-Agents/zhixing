/**
 * 底部信息行布局 —— 两侧统一内容留白，左区左对齐、右区右对齐。
 *
 * 输入是已渲染好(可含 ANSI 颜色)的左 / 右块列表;本函数只管布局,不关心块
 * 内容来自谁、是什么颜色。左右皆空时产出整行空格 —— 信息行始终占位、高度不抖。
 *
 * 超宽(左 + 右 可见宽度 > width):右区优先保留,左区按剩余宽度截断(clampLine
 * 追加省略号),避免破坏行宽触发终端隐式折行。`stringWidth` / `clampLine` 按可见
 * 宽度处理、CJK 安全且不切碎 ANSI 序列。
 */

import { stringWidth, clampLine } from "../tui/line-width.js";
import { layout } from "../tui/style.js";

/** 同区多块之间的分隔。 */
const BLOCK_SEP = "  ";

export function renderBottomInfoLine(
  left: readonly string[],
  right: readonly string[],
  width: number,
): string {
  if (!Number.isFinite(width) || width < 1) return "";
  width = Math.floor(width);

  // 与 CLI 内容基线同源。极窄视口对称收缩留白，至少保留一列内容；
  // 调用方只提供整行预算，场景与消息不拥有缩进或额外宽度扣减。
  const inset = Math.min(layout.contentIndent, Math.floor((width - 1) / 2));
  const padding = " ".repeat(inset);
  const contentWidth = width - inset * 2;

  const leftStr = left.join(BLOCK_SEP);
  const rightStr = clampLine(right.join(BLOCK_SEP), contentWidth);
  const leftW = stringWidth(leftStr);
  const rightW = stringWidth(rightStr);
  const separatorWidth = leftW > 0 && rightW > 0 ? 2 : 0;

  // 先保右侧操作，再给左侧说明预算；CJK 截短不足一列时仍补齐，
  // 不让右侧锚点漂移。空内容同样输出完整一行，不影响输入区高度。
  const leftClamped = clampLine(leftStr, Math.max(0, contentWidth - rightW - separatorWidth));
  const gap = contentWidth - stringWidth(leftClamped) - rightW;
  return padding + leftClamped + " ".repeat(gap) + rightStr + padding;
}
