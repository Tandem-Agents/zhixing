/**
 * renderInputBox —— 标题、输入框与真实编辑光标的纯渲染原语。
 *
 * 产品形态（与主输入区 / `/work` 新建场景框一致）：
 *   ▎ <title>                    ← 标题行（brand 章节锚 ▎ + bold，框外缩进 1 格）
 *   ╭──────────────────────────╮ ← 输入框（renderChrome 紧凑形态）
 *   │ <文本，含 reverse SGR 光标>  │ ← 框内输入行（layoutInputBuffer 渲染）
 *   ╰──────────────────────────╯
 *
 * 场景说明与操作提示由调用方通过 BottomInfoScope 组合，输入框不另设页脚。
 * 它只在 layoutInputBuffer 之上装配标题和框体，不读场景、不管理提示生命周期。
 *
 * 光标：始终走 `layoutInputBuffer` 的 `paintVisualCursor`（reverse SGR 软件光标）——
 * chrome-mode REPL 的标准做法（硬件光标统一隐藏、输入光标画在内容里），alt-screen
 * 编辑屏 hideCursor 后同样适用。返回的 `cursor` 坐标供 inline region 额外定位用。
 */

import { renderChrome, tone, icon } from "./tui/index.js";
import { layoutInputBuffer } from "./input-layout.js";
import { INPUT_HANDLE_TOKEN_PATTERNS } from "./input-handle-tokens.js";
import { clampLine } from "./tui/line-width.js";

export interface InputBoxOptions {
  /** 框上方标题（本函数加 bold）。 */
  readonly title: string;
  /** 标题行前缀字符(已染色);缺省 ▎章节锚。调用方可传别的字符(如动效帧)替换标题行而不动框。 */
  readonly titleGlyph?: string;
  /** 当前输入文本（裸，无 ANSI；可含硬换行）。 */
  readonly draft: string;
  /** 光标字符 offset（不是 UTF-16 unit），与 InputBuffer.cursor 同口径。 */
  readonly cursor: number;
  /** 可用框宽（含左右边框）；调用者为终端末列预留空间。 */
  readonly width: number;
}

export interface InputBoxResult {
  /** 成品帧行（标题 + 框），caller 与公共信息行组合。 */
  readonly lines: string[];
  /**
   * 框内光标 (row, col)，相对 `lines[0]` 起（0-based）。chrome inline 场景用它
   * 定位；alt-screen 软件光标场景可忽略（光标已 reverse SGR 画在 lines 内）。
   */
  readonly cursor: { row: number; col: number };
}

export function renderInputBox(opts: InputBoxOptions): InputBoxResult {
  const frameWidth = Math.max(5, opts.width);
  const contentBudget = Math.max(1, frameWidth - 5);

  // 框内输入行：promptPrefix 传空（框内不需要 ❯），软件光标开。边框 / padding /
  // 宽度感知截断委托 renderChrome（CJK 安全）。
  const layout = layoutInputBuffer(
    "",
    opts.draft,
    opts.cursor,
    contentBudget,
    INPUT_HANDLE_TOKEN_PATTERNS,
    true,
  );
  const boxLines = renderChrome({
    body: layout.bodyLines,
    width: frameWidth,
    bodyPadding: false,
    indent: 1,
  });

  const lines = [
    ` ${opts.titleGlyph ?? tone.brand.bold(icon.section)}${tone.bold(opts.title)}`,
    ...boxLines,
  ];
  // 标题(1) + box 顶边(1) → cursor 落在第 2 + layout.cursorRow 行；
  // 列 = 左 │(1) + indent(1) + layout.cursorCol。
  return {
    lines: lines.map(line => clampLine(line, frameWidth)),
    cursor: { row: 2 + layout.cursorRow, col: 2 + layout.cursorCol },
  };
}
