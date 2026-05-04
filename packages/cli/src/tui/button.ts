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
 * 两层 API：
 *   - `renderButton`：纯 box 三行（caller 自管 cursor / hint / indent）
 *   - `renderButtonRow`：完整按钮行——box + 外置 cursor + 右侧 hint + indent，
 *     caller 一次 `writeLines` 即可。多数 panel 用这层。
 */

import { glyph, icon, layout, tone } from "./style.js";
import { stringWidth } from "./line-width.js";

export interface ButtonOptions {
  label: string;
  selected?: boolean;
  /** 主按钮（绿色边框）——通常是"全部就绪"时的主操作 */
  primary?: boolean;
}

const HORIZONTAL_PAD = 2;
const BUTTON_HINT_GAP = "   "; // 按钮与右侧 hint 间的视觉间距（3 空格）

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

// ─── 完整按钮行（含外置 cursor + hint + indent） ───

export interface ButtonRowOptions {
  label: string;
  /** 按钮右侧 dim 提示文本（不含括号——渲染时自动包） */
  hint?: string;
  /** 主按钮（绿色）——通常是"建议动作" */
  primary?: boolean;
  /** 是否选中——选中时左侧外置 cursor + 整体加粗 */
  selected?: boolean;
  /** 左侧缩进字符数；缺省 `layout.contentIndent` */
  indent?: number;
}

/**
 * 完整按钮行——三行布局含 box + 外置 cursor + 右侧 hint。
 *
 *   ┌──────┐
 * ▸ │  完成  │   (保存并启动)
 *   └──────┘
 *
 * cursor 仅放 middle 行外左侧，top/bottom 用 indent 空格补齐对齐位
 * （cursor 占 1 列 + space 1 列 = 与默认 indent 同宽）。
 *
 * 与 `renderButton` 区分：
 *   - `renderButton`：底层 box 原语（不含 cursor / hint / indent，给定制场景用）
 *   - `renderButtonRow`：完整可写入的"一组行"——caller 直接 `writeLines`
 */
export function renderButtonRow(opts: ButtonRowOptions): string[] {
  const indentStr = " ".repeat(opts.indent ?? layout.contentIndent);
  const [top, middle, bottom] = renderButton({
    label: opts.label,
    selected: opts.selected,
    primary: opts.primary,
  });
  const middleWithHint = opts.hint
    ? middle + BUTTON_HINT_GAP + tone.dim(`(${opts.hint})`)
    : middle!;
  const cursorMark = opts.selected ? tone.brand.bold(icon.cursor) : " ";
  return [
    indentStr + top!,
    cursorMark + " " + middleWithHint,
    indentStr + bottom!,
  ];
}
