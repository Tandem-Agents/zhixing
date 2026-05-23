/**
 * 底部信息行布局 —— 纯函数:左区块左对齐、右区块右对齐、中间空格填充到行宽。
 *
 * 输入是已渲染好(可含 ANSI 颜色)的左 / 右块列表;本函数只管布局,不关心块
 * 内容来自谁、是什么颜色。左右皆空时产出整行空格 —— 信息行始终占位、高度不抖。
 *
 * 超宽(左 + 右 可见宽度 > width):右区优先保留,左区按剩余宽度截断(clampLine
 * 追加省略号),避免破坏行宽触发终端隐式折行。`stringWidth` / `clampLine` 按可见
 * 宽度处理、CJK 安全且不切碎 ANSI 序列。
 */

import { stringWidth, clampLine } from "../tui/line-width.js";

/** 同区多块之间的分隔 —— 当前每区至多一块,分隔暂定两空格,视觉规格后续可调。 */
const BLOCK_SEP = "  ";

export function renderBottomInfoLine(
  left: readonly string[],
  right: readonly string[],
  width: number,
): string {
  if (width <= 0) return "";

  const leftStr = left.join(BLOCK_SEP);
  const rightStr = right.join(BLOCK_SEP);
  const leftW = stringWidth(leftStr);
  const rightW = stringWidth(rightStr);

  // 装得下:左靠左、右靠右、中间空格填满到 width(左右皆空 → 整行空格占位)
  if (leftW + rightW <= width) {
    return leftStr + " ".repeat(width - leftW - rightW) + rightStr;
  }

  // 超宽:右区优先保留。右区单独都放不下 → 截右区
  if (rightW >= width) {
    return clampLine(rightStr, width);
  }
  // 左区截断到剩余宽度,与右区之间补齐空隙(截断后实际宽度可能更小)
  const leftClamped = clampLine(leftStr, width - rightW);
  const gap = Math.max(0, width - stringWidth(leftClamped) - rightW);
  return leftClamped + " ".repeat(gap) + rightStr;
}
