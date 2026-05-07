/**
 * 屏幕区域 ANSI 控制原语——纯函数，输出字符串供 ScreenController 写入。
 *
 * 终端区域控制约定：
 *   - 光标位置由 caller 维护，原语不读光标
 *   - 区域内的"行号"是相对值（0 = 区域起始行）
 *   - 不依赖 stty / tput 等外部工具
 */

const ANSI_ERASE_DOWN = "\x1b[J";
/** 清整行（不依赖光标列）——差分 repaint 用于"行内原地覆盖"避免 \x1b[J 整片清屏闪烁 */
const ANSI_ERASE_LINE = "\x1b[2K";
const ANSI_CARRIAGE_RETURN = "\r";

export { ANSI_ERASE_DOWN, ANSI_ERASE_LINE, ANSI_CARRIAGE_RETURN };

/** 上移 n 行的 ANSI 序列。n ≤ 0 时返回空字符串（不发送序列）。 */
export function ansiCursorUp(n: number): string {
  if (n <= 0) return "";
  return `\x1b[${n}A`;
}

/** 下移 n 行的 ANSI 序列。n ≤ 0 时返回空字符串。 */
export function ansiCursorDown(n: number): string {
  if (n <= 0) return "";
  return `\x1b[${n}B`;
}

/** 向右移动 n 列的 ANSI 序列。n ≤ 0 时返回空字符串。 */
export function ansiCursorForward(n: number): string {
  if (n <= 0) return "";
  return `\x1b[${n}C`;
}

/**
 * 把光标从"区域内某行"擦回"区域起始行行首"，并清除从此处到屏幕末的所有内容。
 *
 * cursorRow = 当前光标在区域内的相对行号（0-based）
 * 上移 cursorRow 行 + 回行首 + 清除下方所有内容（含当前行行尾）
 */
export function eraseRegion(cursorRow: number): string {
  return ansiCursorUp(cursorRow) + ANSI_CARRIAGE_RETURN + ANSI_ERASE_DOWN;
}

/**
 * 从"已写入区域末尾的光标位置"移到"区域内 (row, col)"位置。
 *
 * writtenLines = 区域刚写完的总行数；cursor 当前在最后一行的末尾。
 * targetRow = 0-based 区域内目标行；targetCol = 0-based 目标列。
 *
 * 算法：先 \r 回行首；从最后一行（writtenLines - 1）上移到 targetRow；
 *       右移 targetCol 列。
 */
export function moveCursorWithinRegion(
  writtenLines: number,
  targetRow: number,
  targetCol: number,
): string {
  if (writtenLines <= 0) return "";
  const rowsUp = writtenLines - 1 - targetRow;
  return (
    ANSI_CARRIAGE_RETURN +
    ansiCursorUp(rowsUp) +
    ansiCursorForward(targetCol)
  );
}
