/**
 * Footer 全宽分隔 + 提示文字。
 *
 *   ──────────────────────────────────────────────────
 *     导航 ↑↓  退出 Esc            置顶 p  禁用 d  归档 a
 *
 * 分隔线 dim 不抢戏。提示行支持两种 hint 形态：
 *   - **扁平 `string[]`**（旧）：整体 dim + 中点 ` · ` 分隔——config-editor 等沿用。
 *   - **结构化 `KeyHint[]`**（新）：「说明亮 + 按键暗」，委托 `renderHintBar`——skill 页面用。
 * 左区贴左、可选右区贴右两端对齐；不传 `rightHints` 时仅左区。
 *
 * **alt-screen 行宽不变量**：输出每行恒 ≤ `width`（`clampLine` / `renderHintBar` 兜底）。
 * Renderer 不截断写入行（render.ts），超 columns 会触发终端折行、打乱清行光标数学
 * （line-width.ts docstring）。窄终端放不下双区时优雅降级回单区平铺并截断。**恒返回 2 行**
 * ——行数稳定，caller 可放心做布局计算。调用方按需输出，不假设位置。
 */

import { glyph, tone, layout } from "./style.js";
import { clampLine, stringWidth } from "./line-width.js";
import { renderHintBar, type KeyHint } from "./hints.js";

const HINT_SEPARATOR = " · ";

/** hint 项：扁平字符串（旧样式，整体 dim）或结构化 KeyHint（新样式，说明亮 + 按键暗）。 */
export type FooterHint = string | KeyHint;

export interface FooterOptions {
  width: number;
  /** 左区提示——基础 / 导航操作，贴左、缩进对齐内容列。 */
  hints: readonly FooterHint[];
  /**
   * 右区提示——功能 / 变更操作，贴右、两端对齐。省略 / 空数组 = 单区布局（仅左区）。
   * 与 `hints` 同质：要么全 string（旧样式），要么全 KeyHint（新样式）。
   */
  rightHints?: readonly FooterHint[];
}

/** 任一区含结构化 KeyHint → 走新样式（renderHintBar）；否则旧 string 样式。 */
function isKeyed(opts: FooterOptions): boolean {
  const has = (xs?: readonly FooterHint[]): boolean =>
    (xs ?? []).some((h) => typeof h === "object");
  return has(opts.hints) || has(opts.rightHints);
}

export function renderFooter(opts: FooterOptions): string[] {
  const separator = tone.dim(glyph.horizontal.repeat(opts.width));

  // 新样式（KeyHint）：整条提示行委托共享原语 renderHintBar，footer 只加分隔线。
  if (isKeyed(opts)) {
    return [
      separator,
      renderHintBar({
        width: opts.width,
        hints: opts.hints as readonly KeyHint[],
        rightHints: opts.rightHints as readonly KeyHint[] | undefined,
      }),
    ];
  }

  // 旧样式（string）：整体 dim + 中点分隔，clamp 兜底保证 ≤ width（不超宽时 byte-equal）。
  const hints = opts.hints as readonly string[];
  const left = layout.contentPrefix + tone.dim(hints.join(HINT_SEPARATOR));
  if (opts.rightHints && opts.rightHints.length > 0) {
    const rightHints = opts.rightHints as readonly string[];
    const right = tone.dim(rightHints.join(HINT_SEPARATOR));
    const leftW = stringWidth(left);
    const rightW = stringWidth(right);
    if (leftW + 1 + rightW <= opts.width) {
      const gap = opts.width - leftW - rightW;
      return [separator, left + " ".repeat(gap) + right];
    }
    const merged =
      layout.contentPrefix + tone.dim([...hints, ...rightHints].join(HINT_SEPARATOR));
    return [separator, clampLine(merged, opts.width)];
  }
  return [separator, clampLine(left, opts.width)];
}
