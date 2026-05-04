/**
 * 设计 token 单一来源——所有颜色、图标、box 字符走这里。
 *
 * 切换主色 / 替换图标只改一处；调用点全部用语义角色名（success / warn / dim 等），
 * 不直接 import chalk。这层封装让换主题、加 NO_COLOR 兜底等改动都局部化。
 */

import chalk from "chalk";

// ── 颜色语义（Tone）────────────────────────────────────────

/**
 * 颜色按"角色"暴露——而非按色值。
 *
 *   tone.brand   品牌主色（青绿系），用于选中、品牌标识、主操作
 *   tone.success 已就绪 / 完成
 *   tone.warn    待办 / 警示 / 阻塞
 *   tone.error   错误 / 失败
 *   tone.dim     弱化文本：路径、提示、未启用项
 *   tone.bold    权重叠加，通常与颜色叠用
 *   tone.inverse 选中反白——终端按主题渲染，浅深色都自适应
 */
export const tone = {
  brand: chalk.cyan,
  success: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  dim: chalk.dim,
  bold: chalk.bold,
  inverse: chalk.inverse,
  /**
   * 选中态高亮（主操作）——整块绿底黑字 + 粗体。
   * 用 bgColor 而非 inverse：inverse 在 padding 空格上某些终端不渲染背景；
   * bgColor 显式画 bg 块，所有终端一致。
   */
  highlightPrimary: chalk.bgGreen.black.bold,
  /** 选中态高亮（通用）——整块青底黑字 + 粗体 */
  highlightBrand: chalk.bgCyan.black.bold,
} as const;

// ── 布局常量 ──────────────────────────────────────────────

/**
 * 主面板共享 indent——章节头 / 入口行 / 按钮等"外部内容"的左边距。
 * chrome 内部 indent 与此独立（chrome 自有内边距体系）。
 */
export const layout = {
  contentIndent: 2,
} as const;

// ── 图标 ──────────────────────────────────────────────────

export const icon = {
  /** 状态：已就绪 */
  ready: "✓",
  /** 状态：待办 / 阻塞 */
  pending: "⚠",
  /** 状态：未启用 / 不需要 */
  disabled: "·",
  /** 光标 / 选中标记——选中行的"我在这里" */
  cursor: "▸",
  /** 默认可选标记——未选中行的"此行可被选中"提示，dim 渲染、不抢戏 */
  selectable: "›",
  /** 品牌标识 */
  brand: "✦",
  /** 章节头——竖条 accent，做"section 标记"而非装饰星形 */
  section: "▎",
} as const;

// ── Box drawing 字符 ──────────────────────────────────────

/**
 * 圆角与直角分两组——容器（chrome / input frame）用圆角，按钮用直角。
 * 视觉差让"操作"与"空间"在同一页面上不混淆。
 */
export const glyph = {
  rounded: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
  },
  sharp: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
  },
  horizontal: "─",
  vertical: "│",
} as const;

// ── 终端宽度 ──────────────────────────────────────────────

/**
 * 获取终端可用列数。
 *
 * 优先级：stdout.columns（TTY 时）→ env.COLUMNS（CI 等场景常提供）→ 80（兜底）。
 * 不读 stty / process.env.TERM——这些在跨平台不可靠。
 */
export function getTerminalWidth(stream?: NodeJS.WritableStream): number {
  const stdout = stream ?? process.stdout;
  const cols = (stdout as NodeJS.WriteStream).columns;
  if (typeof cols === "number" && cols > 0) return cols;
  const envCols = parseInt(process.env["COLUMNS"] ?? "", 10);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  return 80;
}
