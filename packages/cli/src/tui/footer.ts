/**
 * Footer 全宽分隔 + 提示文字。
 *
 *   ──────────────────────────────────────────────────
 *     ↑↓ 导航 · Esc 退出            p 置顶 · d 禁用 · a 归档
 *
 * 分隔线 dim 不抢戏；提示 dim + 中点分隔。左区（`hints`）贴左、缩进对齐
 * `layout.contentPrefix`（与列表行 / 正文同列）；可选右区（`rightHints`）贴右、
 * 末端与分隔线右端对齐——用于「左基础 / 导航操作、右功能 / 变更操作」两端对齐。
 * 不传 `rightHints` 时退化为单区（仅左），与历史行为 byte-equal、现有 caller 零影响。
 *
 * **alt-screen 行宽不变量**：输出每行恒 ≤ `width`（由 `clampLine` 兜底）。Renderer
 * 不对写入行做截断（render.ts「无任何渲染语义」），一旦行宽超过终端 columns，终端会
 * 自动折行、打乱「清除 N 行」的光标数学（line-width.ts docstring）。故 footer 与
 * renderListRow / chrome 一样自守此不变量：窄终端放不下双区时优雅降级回单区平铺并
 * 截断。**恒返回 2 行**——行数稳定，caller 可放心做布局计算。
 * 调用方按需输出，不假设位置（多数情况在面板末尾）。
 */

import { glyph, tone, layout } from "./style.js";
import { clampLine, stringWidth } from "./line-width.js";

const HINT_SEPARATOR = " · ";

export interface FooterOptions {
  width: number;
  /** 左区提示——基础 / 导航操作（↑↓ 导航、Esc 退出等），贴左、缩进对齐内容列。 */
  hints: readonly string[];
  /**
   * 右区提示——功能 / 变更操作，贴右、末端与分隔线右端对齐。省略 / 空数组 =
   * 单区布局（仅左区），与历史行为 byte-equal、现有 caller 零影响。窄终端放不下
   * 双区时优雅降级回单区平铺（左右 hint 合并）并截断到 `width`。
   */
  rightHints?: readonly string[];
}

export function renderFooter(opts: FooterOptions): string[] {
  const separator = tone.dim(glyph.horizontal.repeat(opts.width));
  const left = layout.contentPrefix + tone.dim(opts.hints.join(HINT_SEPARATOR));

  if (opts.rightHints && opts.rightHints.length > 0) {
    const right = tone.dim(opts.rightHints.join(HINT_SEPARATOR));
    const leftW = stringWidth(left);
    const rightW = stringWidth(right);
    // 放得下（左 + 至少 1 列间隔 + 右 ≤ width）：单行两端对齐。gap 按可见宽度
    // （含 ANSI 染色，故用 stringWidth）精确填满，右端齐分隔线右端。
    if (leftW + 1 + rightW <= opts.width) {
      const gap = opts.width - leftW - rightW;
      return [separator, left + " ".repeat(gap) + right];
    }
    // 放不下：优雅降级回单区平铺，交下方同一 clamp 兜底守住行宽不变量。
    const merged =
      layout.contentPrefix +
      tone.dim([...opts.hints, ...opts.rightHints].join(HINT_SEPARATOR));
    return [separator, clampLine(merged, opts.width)];
  }

  // 单区：clamp 兜底保证 ≤ width（正常不超宽时 clampLine 原样返回 → byte-equal 历史行为）。
  return [separator, clampLine(left, opts.width)];
}
