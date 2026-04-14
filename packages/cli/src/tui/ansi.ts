/**
 * ANSI 转义码常量集 — 零依赖的 TTY 控制原语
 *
 * 只包含我们用到的子集；不追求完整的 VT100 覆盖。
 * 所有字符串都是合法的 VT 序列（含 ESC = \x1b）。
 *
 * 对比 `chalk`：chalk 只做颜色，不做游标。我们用 chalk 处理颜色时不冲突——
 * chalk 写在 stdout 的颜色序列在此文件里不需要解析，只要 line-width.ts
 * 的 stripAnsi 正则能识别就行。
 */

export const ANSI = {
  ESC: "\x1b",

  // ── 游标控制 ──
  /** 隐藏光标——渲染面板时使用，避免光标闪烁干扰视觉 */
  hideCursor: "\x1b[?25l",
  /** 显示光标——面板退出时恢复 */
  showCursor: "\x1b[?25h",

  // ── 行控制 ──
  /** 清除整行（不改变光标位置） */
  clearLine: "\x1b[2K",
  /** 清除从光标到行尾 */
  clearToEndOfLine: "\x1b[K",
  /** 光标回到行首（carriage return） */
  col0: "\r",

  /** 光标上移 n 行；n=0 时返回空串（VT 规范里 `\x1b[0A` 表示 1 行）避免歧义 */
  moveUp(n: number): string {
    return n > 0 ? `\x1b[${n}A` : "";
  },
  /** 光标下移 n 行 */
  moveDown(n: number): string {
    return n > 0 ? `\x1b[${n}B` : "";
  },

  // ── 样式 ──
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",

  // ── 前景色 ──
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

/**
 * 匹配任意 ANSI CSI 转义序列的正则。
 * - `\x1b\[` = CSI 起始
 * - `[0-9;?=<>]*` = 参数字节（数字 / 分号 + 私有模式标记 `?`、`=`、`<`、`>`）
 * - `[A-Za-z]` = 终止字符
 *
 * 覆盖色彩、游标、擦除 **以及 `\x1b[?25l`/`\x1b[?25h`（显隐光标）等私有模式序列**。
 * 不覆盖 OSC (`\x1b]...`) 等其它族。
 *
 * 注意：原始版本漏掉 `?` 会把 `\x1b[?25l` 当成 5 个可见字符计入 stringWidth，
 * 导致 clampLine 低估行宽，最终让窄终端里的面板行实际溢出。
 */
const ANSI_CSI_RE = /\x1b\[[0-9;?=<>]*[A-Za-z]/g;

/**
 * 从字符串中剥离所有 ANSI CSI 转义序列。
 * 用于可视宽度计算——颜色和游标不占显示列。
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI_RE, "");
}
