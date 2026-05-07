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
  /** 清除从光标到屏幕末尾（含当前行的光标右侧 + 下方所有行） */
  clearBelow: "\x1b[J",
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

  // ── 同步输出（Synchronized Output mode） ──
  /**
   * 告诉终端在 BSU..ESU 之间累积所有输出后一次性 render，避免分段刷新带来的
   * 视觉抖动（光标短暂跳到 col 0 / 旧帧 / 新帧的中间状态）。不支持的终端忽略
   * 此序列等同无优化。行业标准：iTerm2 / kitty / Windows Terminal / mintty 等
   * 现代终端均支持。
   */
  syncBegin: "\x1b[?2026h",
  syncEnd: "\x1b[?2026l",

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
 * ANSI 转义序列正则——同时覆盖 CSI 与 OSC 两族。
 *
 * CSI: `\x1b[<参数><终结>`——色彩、游标、擦除、私有模式（`\x1b[?25l` 等）。
 *   参数字节范围按 ECMA-48 标准为 `0x30-0x3F`（数字 + `:` + `;` + `<` + `=` + `>`
 *   + `?`）；`:` 是子参数分隔符，用于扩展 SGR 如 dotted underline `\x1b[4:4m` /
 *   RGB 颜色 `\x1b[38:2:R:G:Bm`——必须识别避免 stripAnsi 漏掉这类序列让 `4:4m`
 *   字面字符暴露在视觉文本里。
 * OSC: `\x1b]<参数><ST>`——超链接（OSC 8 `\x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\`）、
 *      标题设置等。ST 终结符可以是 `\x1b\\` 或 `\x07`（BEL）——两者都识别。
 *
 * 不识别会导致 stringWidth 把转义码当可见字符计入——chrome body 含超链接时
 * 右边框对不齐，clampLine 截断时切碎序列。
 */
const ANSI_RE =
  /\x1b\[[0-9;:?=<>]*[A-Za-z]|\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/g;

/**
 * 从字符串中剥离所有 ANSI 转义序列（CSI + OSC）。
 * 用于可视宽度计算——颜色、游标、超链接转义码不占显示列。
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * 同 ANSI_RE，但用 sticky flag 让 exec 严格从 lastIndex 起匹配——避免按字符
 * 遍历字符串时每次调 stripAnsi / s.slice 触发整串扫描。
 */
const ANSI_AT_RE =
  /\x1b\[[0-9;:?=<>]*[A-Za-z]|\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/y;

/**
 * 检查字符串第 `i` 位是否为 ANSI 转义序列（CSI 或 OSC）起首。
 *
 * 是——返回该序列字符长度（caller 可整段跳过）；否——返回 0。
 *
 * 用例：按 code point 遍历字符串做 wrap / 宽度计算时，遇到 ANSI 起首字符
 * (`\x1b`) 整段 skip 序列长度，避免序列内字符（如 `[1m` 三个字符）被当
 * 可见字符计入列宽，破坏 wrap 边界。
 */
export function ansiEscapeLengthAt(s: string, i: number): number {
  if (s.charCodeAt(i) !== 0x1b) return 0;
  ANSI_AT_RE.lastIndex = i;
  const m = ANSI_AT_RE.exec(s);
  return m ? m[0].length : 0;
}

/**
 * 构造 OSC 8 超链接转义字符串——支持的终端渲染为可点击链接，不支持的终端
 * 显示原文（fallback 安全）。`text` 缺省 = 显示 URL 本身。
 */
export function osc8Hyperlink(url: string, text?: string): string {
  return `\x1b]8;;${url}\x1b\\${text ?? url}\x1b]8;;\x1b\\`;
}

/**
 * 虚线下划线（dotted）—— SGR 扩展子参数 `4:4`，与 chalk 的单实线 `4` 区分。
 *
 * `\x1b[4:4m` 起开 dotted underline，`\x1b[24m` 关闭所有下划线状态。SGR 扩展
 * 子参数（"4:N"）是 ECMA-48 标准的子参数语法，在现代终端（Windows Terminal
 * 1.16+ / iTerm2 / Kitty / WezTerm / Alacritty）支持；不支持的旧终端忽略 `:4`
 * 参数 fallback 为单实线下划线（最差是不显示下划线，文字仍可读）。
 *
 * 用途：markdown 链接装饰——cyan 文字 + 虚线下划线让链接在文本中明显可见，
 * 与 inline `code`（bg 块）/ `**bold**`（字体粗）形成层次区分。
 */
export function dottedUnderline(text: string): string {
  return `\x1b[4:4m${text}\x1b[24m`;
}
