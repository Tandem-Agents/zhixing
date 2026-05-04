/**
 * 圆角框容器——Welcome / Header / Input 等"独立空间"的视觉边界。
 *
 * 顶边三种模式（互斥）：
 *
 *   1) 品牌锚（brandAnchor）——左偏嵌入图腾（前置 4 dash + 2 空格留距离感），
 *      作为"门面"面板（welcome 等）的身份签名：
 *      `╭──── ✦ ──────────...─╮`
 *
 *   2) 标题（title）——左对齐紧贴前角，作为"工作"面板（list / entity / input）的导向：
 *      `╭ Title ─────────────────...─╮`
 *
 *   3) 都不传 = 纯横线顶边，安静无修饰。
 *
 * 形态意图：title 是"信息"（这是什么页），brandAnchor 是"身份"（这是谁的产品）。
 * 锚比 title 更靠右，避免顶边一上来就贴框，给身份图腾留呼吸空间。
 * 同时传则 brandAnchor 优先——同一顶边只能承载一种语义。
 *
 * body 上下各 1 空行作呼吸，避免文字贴边框；内容超宽按字符截断（追加 …）。
 */

import { glyph, tone } from "./style.js";
import { stringWidth, clampLine } from "./line-width.js";

export interface ChromeOptions {
  /**
   * 顶边居中嵌入的品牌锚（图腾符号）——welcome 类"门面"面板用。
   * 与 title 互斥；同时提供则 brandAnchor 胜出。
   */
  brandAnchor?: string;
  /** 顶边左对齐嵌入的标题；缺省 = 纯横线顶边 */
  title?: string;
  /** 内容行——每行已是完整字符串（含 ANSI 颜色） */
  body: readonly string[];
  /** 容器宽度（含左右边框） */
  width: number;
  /** body 内容相对左边框的缩进；缺省 3 */
  indent?: number;
}

const RIGHT_INNER_PAD = 1; // 右边框前的视觉留白
const BRAND_ANCHOR_PAD = 1; // 品牌锚两侧的呼吸空间（` ✦ `）
const BRAND_ANCHOR_LEFT_DASHES = 4; // 锚前的 dash 数——和左角点拉开距离

export function renderChrome(opts: ChromeOptions): string[] {
  const indent = opts.indent ?? 3;
  // 至少容下 ╭╮ 和 1 字符空间——更窄就降级为单行
  const width = Math.max(4, opts.width);
  const innerWidth = width - 2;

  const top = renderTopEdge(opts, innerWidth);
  const bottom =
    tone.dim(glyph.rounded.bottomLeft) +
    tone.dim(glyph.horizontal.repeat(innerWidth)) +
    tone.dim(glyph.rounded.bottomRight);

  const blank = renderBodyLine("", innerWidth, indent);
  const lines: string[] = [top];
  // body 顶部 padding 行，让首行内容不贴顶边
  if (opts.body.length > 0) lines.push(blank);
  for (const line of opts.body) {
    lines.push(renderBodyLine(line, innerWidth, indent));
  }
  if (opts.body.length > 0) lines.push(blank);
  lines.push(bottom);
  return lines;
}

function renderTopEdge(opts: ChromeOptions, innerWidth: number): string {
  const corners = {
    left: tone.dim(glyph.rounded.topLeft),
    right: tone.dim(glyph.rounded.topRight),
  };
  const plain = (): string =>
    corners.left + tone.dim(glyph.horizontal.repeat(innerWidth)) + corners.right;

  // 品牌锚胜出——同顶边只承载一种语义
  if (opts.brandAnchor) {
    return renderBrandTopEdge(opts.brandAnchor, innerWidth, corners, plain);
  }
  if (opts.title) {
    return renderTitleTopEdge(opts.title, innerWidth, corners, plain);
  }
  return plain();
}

interface CornerPair {
  left: string;
  right: string;
}

/** 品牌锚顶边：`╭──── ANCHOR ─...──╮`——锚左偏（前固定 dash + 空格），尾随 dash 填满。 */
function renderBrandTopEdge(
  anchor: string,
  innerWidth: number,
  corners: CornerPair,
  fallback: () => string,
): string {
  const anchorVisibleWidth = stringWidth(anchor);
  const fixedSegmentWidth =
    BRAND_ANCHOR_LEFT_DASHES +
    BRAND_ANCHOR_PAD +
    anchorVisibleWidth +
    BRAND_ANCHOR_PAD;
  const trailingDashes = innerWidth - fixedSegmentWidth;

  // 至少留 1 dash 收尾——否则降级纯横线
  if (trailingDashes < 1) return fallback();

  return (
    corners.left +
    tone.dim(glyph.horizontal.repeat(BRAND_ANCHOR_LEFT_DASHES)) +
    " ".repeat(BRAND_ANCHOR_PAD) +
    tone.brand(tone.bold(anchor)) +
    " ".repeat(BRAND_ANCHOR_PAD) +
    tone.dim(glyph.horizontal.repeat(trailingDashes)) +
    corners.right
  );
}

/** 标题顶边：`╭ Title ─────...─╮`——title 左对齐，前置单空格无 dash 装饰。 */
function renderTitleTopEdge(
  title: string,
  innerWidth: number,
  corners: CornerPair,
  fallback: () => string,
): string {
  const titleVisibleWidth = stringWidth(title);
  const fixedSegmentWidth = 1 /* space */ + titleVisibleWidth + 1 /* space */;
  const trailingDashes = innerWidth - fixedSegmentWidth;

  if (trailingDashes < 1) return fallback();

  return (
    corners.left +
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
