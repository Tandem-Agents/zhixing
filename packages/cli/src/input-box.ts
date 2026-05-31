/**
 * renderInputBox —— "带框单行输入区"的单一视觉来源（纯函数原语）。
 *
 * 产品形态（与主输入区 / `/work` 新建场景框一致）：
 *   ▎ <title>                    ← 标题行（brand 章节锚 ▎ + bold，框外缩进 1 格）
 *   ╭──────────────────────────╮ ← 输入框（renderChrome 紧凑形态）
 *   │ <文本，含 reverse SGR 光标>  │ ← 框内输入行（layoutInputBuffer 渲染）
 *   ╰──────────────────────────╯
 *    <hint>                      ← 提示行（dim，可选；框外缩进 1 格）
 *
 * 为什么是纯函数、放这一层：
 *   - 输入框视觉此前在两处各写一套（`tui/inline-text-prompt` 的 chrome inline 框、
 *     技能 AI 编辑屏的手搓 `› {input}`）——重复即债务。提成单一原语后，两个 caller
 *     （inline region + alt-screen 编辑屏）共享，改样式只改这里。
 *   - 纯函数（输入 = 数据，输出 = 行 + 光标坐标，无 I/O / 无状态）——chrome inline
 *     与 alt-screen 两套渲染体系都能用：inline region 用返回的 cursor 坐标定位、
 *     alt-screen 直接画 lines（光标已由 layoutInputBuffer 以 reverse SGR 软件画在
 *     行内，硬件光标在 alt-screen 期间隐藏）。
 *   - 与 `input-layout` 同层（cli/src/，非 tui/）：二者都是"输入区视觉构造"件，
 *     `input-box` 在 `layoutInputBuffer`（布局）之上再装配框 + 标题 + hint。放此层
 *     避免 tui/index → input-box → input-layout → tui/index 的循环依赖（input-layout
 *     自身已依赖 tui/index）。
 *
 * 光标：始终走 `layoutInputBuffer` 的 `paintVisualCursor`（reverse SGR 软件光标）——
 * chrome-mode REPL 的标准做法（硬件光标统一隐藏、输入光标画在内容里），alt-screen
 * 编辑屏 hideCursor 后同样适用。返回的 `cursor` 坐标供 inline region 额外定位用。
 */

import { renderChrome, tone, icon, ANSI } from "./tui/index.js";
import { layoutInputBuffer } from "./input-layout.js";
import { PASTE_TOKEN_PATTERN } from "./paste-registry.js";

export interface InputBoxOptions {
  /** 框上方标题（本函数加 ▎ 锚 + bold）。 */
  readonly title: string;
  /** 当前输入文本（裸，无 ANSI；可含硬换行）。 */
  readonly draft: string;
  /** 光标字符 offset（不是 UTF-16 unit），与 InputBuffer.cursor 同口径。 */
  readonly cursor: number;
  /** 空 draft 时框内的 dim 占位提示；非空时不显示。 */
  readonly placeholder?: string;
  /** 框下方提示行（成品文本，本函数加 dim + 缩进）。省略则不画提示行。 */
  readonly hint?: string;
  /** 框宽（含左右边框）；与 minWidth 取大。 */
  readonly width: number;
  /** 框最小宽度（极窄终端兜底）；缺省 40，与候选面板同款。 */
  readonly minWidth?: number;
}

export interface InputBoxResult {
  /** 成品帧行（标题 + 框 + 可选 hint），caller 直接写出。 */
  readonly lines: string[];
  /**
   * 框内光标 (row, col)，相对 `lines[0]` 起（0-based）。chrome inline 场景用它
   * 定位；alt-screen 软件光标场景可忽略（光标已 reverse SGR 画在 lines 内）。
   */
  readonly cursor: { row: number; col: number };
}

export function renderInputBox(opts: InputBoxOptions): InputBoxResult {
  const frameWidth = Math.max(opts.minWidth ?? 40, opts.width);
  const contentBudget = Math.max(1, frameWidth - 4);
  const suffix =
    opts.draft.length === 0 && opts.placeholder
      ? `${ANSI.dim}${opts.placeholder}${ANSI.reset}`
      : "";

  // 框内输入行：promptPrefix 传空（框内不需要 ❯），软件光标开。边框 / padding /
  // 宽度感知截断委托 renderChrome（CJK 安全）。
  const layout = layoutInputBuffer(
    "",
    opts.draft,
    opts.cursor,
    suffix,
    contentBudget,
    PASTE_TOKEN_PATTERN,
    true,
  );
  const boxLines = renderChrome({
    body: layout.bodyLines,
    width: frameWidth,
    bodyPadding: false,
    indent: 1,
  });

  const lines = [
    ` ${tone.brand.bold(icon.section)}${tone.bold(opts.title)}`,
    ...boxLines,
  ];
  if (opts.hint) lines.push(` ${tone.dim(opts.hint)}`);

  // 标题(1) + box 顶边(1) → cursor 落在第 2 + layout.cursorRow 行；
  // 列 = 左 │(1) + indent(1) + layout.cursorCol。
  return {
    lines,
    cursor: { row: 2 + layout.cursorRow, col: 2 + layout.cursorCol },
  };
}
