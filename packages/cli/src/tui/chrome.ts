/**
 * 圆角框容器——Welcome / Header / Input 等"独立空间"的视觉边界。
 *
 *   ╭─ Title ──────────────────────────────╮
 *   │                                        │
 *   │   body line 1                          │
 *   │   body line 2                          │
 *   │                                        │
 *   ╰────────────────────────────────────────╯
 *
 * 标题嵌入顶边（不另起一行），缺省 = 纯横线顶边。
 * 宽度自适应；body 行超宽按字符截断（追加 …）。
 */

import { glyph, tone } from "./style.js";
import { stringWidth, clampLine } from "./line-width.js";

export interface ChromeOptions {
  /** 顶边嵌入的标题；缺省 = 纯横线顶边 */
  title?: string;
  /** 内容行——每行已是完整字符串（含 ANSI 颜色） */
  body: readonly string[];
  /** 容器宽度（含左右边框） */
  width: number;
  /** body 内容相对左边框的缩进；缺省 3 */
  indent?: number;
}

const RIGHT_INNER_PAD = 1; // 右边框前的视觉留白

export function renderChrome(opts: ChromeOptions): string[] {
  const indent = opts.indent ?? 3;
  // 至少容下 ╭╮ 和 1 字符空间——更窄就降级为单行
  const width = Math.max(4, opts.width);
  const innerWidth = width - 2;

  const top = renderTopEdge(opts.title, innerWidth);
  const bottom =
    tone.dim(glyph.rounded.bottomLeft) +
    tone.dim(glyph.horizontal.repeat(innerWidth)) +
    tone.dim(glyph.rounded.bottomRight);

  const lines: string[] = [top];
  for (const line of opts.body) {
    lines.push(renderBodyLine(line, innerWidth, indent));
  }
  lines.push(bottom);
  return lines;
}

function renderTopEdge(title: string | undefined, innerWidth: number): string {
  const corners = {
    left: tone.dim(glyph.rounded.topLeft),
    right: tone.dim(glyph.rounded.topRight),
  };

  if (!title) {
    return corners.left + tone.dim(glyph.horizontal.repeat(innerWidth)) + corners.right;
  }

  // 形如：╭─ Title ─────╮——title 前固定 1 dash + 1 空格，后固定 1 空格 + N dashes
  const titleVisibleWidth = stringWidth(title);
  const fixedSegmentWidth = 1 /* dash */ + 1 /* space */ + titleVisibleWidth + 1 /* space */;
  const trailingDashes = innerWidth - fixedSegmentWidth;

  if (trailingDashes < 1) {
    // 终端太窄装不下标题——降级为纯横线
    return corners.left + tone.dim(glyph.horizontal.repeat(innerWidth)) + corners.right;
  }

  return (
    corners.left +
    tone.dim(glyph.horizontal) +
    " " +
    tone.brand(tone.bold(title)) +
    " " +
    tone.dim(glyph.horizontal.repeat(trailingDashes)) +
    corners.right
  );
}

function renderBodyLine(line: string, innerWidth: number, indent: number): string {
  const contentBudget = innerWidth - indent - RIGHT_INNER_PAD;
  const clamped = clampLine(line, contentBudget);
  const padWidth = Math.max(0, contentBudget - stringWidth(clamped));
  return (
    tone.dim(glyph.vertical) +
    " ".repeat(indent) +
    clamped +
    " ".repeat(padWidth) +
    " ".repeat(RIGHT_INNER_PAD) +
    tone.dim(glyph.vertical)
  );
}
