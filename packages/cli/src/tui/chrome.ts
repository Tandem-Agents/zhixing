/**
 * 圆角框容器——Welcome / Header / Input 等"独立空间"的视觉边界。
 *
 * 顶边三种模式（互斥）：
 *
 *   1) 品牌锚 string——左偏嵌入单字符图腾（前 4 dash + 1 空格）：
 *      `╭──── ✦ ──────────...─╮`
 *
 *   2) 品牌锚 BrandAnchor 对象——支持多行：顶边嵌入 topEdge 字符，bodyLines
 *      注入 body 顶部，按列与 topEdge 对齐——视觉上像锚"从顶边垂下"：
 *      `╭──── ╲ ──────...─╮
 *       │   ▄▄▄              │
 *       │  ▌●●▐              │
 *       │   ▀▀               │`
 *
 *   3) 标题（title）——左对齐紧贴前角，作为工作面板的导向：
 *      `╭ Title ─────────────────...─╮`
 *
 *   都不传 = 纯横线顶边，安静无修饰。
 *
 * 形态意图：title 是"信息"（这是什么页），brandAnchor 是"身份"（这是谁的产品）。
 * 同时传则 brandAnchor 优先——同一顶边只能承载一种语义。
 *
 * 列对齐规约：BrandAnchor 的 topEdge 字符落在 chrome col 6（0-based）；body 默认
 * indent 让 body 内容起始也在 col 4。差 2 col——anchor 设计若把 topEdge 关键字符
 * 放在 row 0 相对 col 2（即前 2 个空格），bodyLines 直接写自然布局即可对齐。
 *
 * body 上下各 1 空行作呼吸，避免文字贴边框；内容超宽按字符截断（追加 …）。
 */

import { glyph, tone } from "./style.js";
import { stringWidth, clampLine } from "./line-width.js";
import { highlightSelectedRow } from "./highlight.js";

/**
 * Body 行 —— 普通字符串 = chrome 自动 indent + 右内边距空格；
 * `{ highlight: "dotted-row" }` = 整行点阵纹理覆盖（含 indent 与右内边距），用于
 * 候选列表等"选中行"语义。chrome 只识别 highlight 字面标记、不参与"为何高亮"的
 * 业务判断——保留纯渲染原语属性。
 */
export type BodyLine =
  | string
  | { readonly content: string; readonly highlight: "dotted-row" };

/**
 * 多行品牌锚——顶边一个字符 + body 顶部多行，用于"门面"面板的身份签名。
 * bodyLines 紧接 topEdge 之下，列与 topEdge 对齐（见上方"列对齐规约"）。
 */
export interface BrandAnchor {
  /** 顶边嵌入的字符——通常 1 个图腾符号 */
  topEdge: string;
  /**
   * body 顶部注入的多行——已是完整字符串（caller 自己上色 / 加粗）。
   * chrome 不再自动套品牌色，是为了让 caller 在锚右侧拼接其他色调的文本。
   */
  bodyLines: readonly string[];
}

export interface ChromeOptions {
  /**
   * 顶边嵌入的品牌锚——welcome 类"门面"面板用。
   * 单字符（string）= 仅顶边；对象（BrandAnchor）= 顶边 + body 注入。
   * 与 title 互斥；同时提供则 brandAnchor 胜出。
   */
  brandAnchor?: string | BrandAnchor;
  /** 顶边左对齐嵌入的标题；缺省 = 纯横线顶边 */
  title?: string;
  /**
   * 内容行——string 是普通行（已含 ANSI 颜色），`{ highlight }` 对象触发选中
   * 态点阵纹理覆盖（chrome 内 indent 与右内边距全部参与点阵化）。
   */
  body: readonly BodyLine[];
  /** 容器宽度（含左右边框） */
  width: number;
  /** body 内容相对左边框的缩进；缺省 3 */
  indent?: number;
  /**
   * body 上下是否加 1 空行 padding（呼吸）；缺省 true 维持"展示区" chrome
   * 的舒展气质（welcome / config-editor 等门面面板）。传 false 走"工作区"
   * 紧凑形态（input box 等）—— 顶边紧贴 body、底边紧贴 body，3 行高度起步。
   *
   * 锚 body 与用户内容之间的分层空行不受此选项影响——那是身份与内容的语义分层，
   * 与上下呼吸空间无关。
   */
  bodyPadding?: boolean;
}

const RIGHT_INNER_PAD = 1; // 右边框前的视觉留白
const BRAND_ANCHOR_PAD = 1; // 品牌锚两侧的呼吸空间（` ✦ `）
const BRAND_ANCHOR_LEFT_DASHES = 4; // 锚前的 dash 数——和左角点拉开距离

export function renderChrome(opts: ChromeOptions): string[] {
  const indent = opts.indent ?? 3;
  const bodyPadding = opts.bodyPadding ?? true;
  // 至少容下 ╭╮ 和 1 字符空间——更窄就降级为单行
  const width = Math.max(4, opts.width);
  const innerWidth = width - 2;

  const { topEdgeChar, bodyLines: anchorBodyLines } = unpackBrandAnchor(
    opts.brandAnchor,
  );

  const top = renderTopEdge(opts, innerWidth, topEdgeChar);
  const bottom =
    tone.dim(glyph.rounded.bottomLeft) +
    tone.dim(glyph.horizontal.repeat(innerWidth)) +
    tone.dim(glyph.rounded.bottomRight);

  const blank = renderBodyLine("", innerWidth, indent);
  const hasAnchorBody = anchorBodyLines.length > 0;
  const hasUserBody = opts.body.length > 0;
  const hasAnyBody = hasAnchorBody || hasUserBody;
  const lines: string[] = [top];

  // 顶部 padding 行——仅在无锚 body 时需要（锚 body 紧贴顶边作为"天线-身体"连贯整体）
  if (bodyPadding && hasUserBody && !hasAnchorBody) lines.push(blank);

  // 锚 body：caller 自带样式（让锚色与右侧 inline 文字色调可分离）
  for (const aLine of anchorBodyLines) {
    lines.push(renderBodyLine(aLine, innerWidth, indent));
  }

  // 锚 body 与用户内容之间留 1 空行——视觉分层"身份"与"内容"，与 bodyPadding 无关
  if (hasAnchorBody && hasUserBody) lines.push(blank);

  for (const line of opts.body) {
    lines.push(renderBodyLine(line, innerWidth, indent));
  }

  if (bodyPadding && hasAnyBody) lines.push(blank);
  lines.push(bottom);
  return lines;
}

function unpackBrandAnchor(
  anchor: string | BrandAnchor | undefined,
): { topEdgeChar: string | undefined; bodyLines: readonly string[] } {
  if (!anchor) return { topEdgeChar: undefined, bodyLines: [] };
  if (typeof anchor === "string") {
    return { topEdgeChar: anchor, bodyLines: [] };
  }
  return { topEdgeChar: anchor.topEdge, bodyLines: anchor.bodyLines };
}

function renderTopEdge(
  opts: ChromeOptions,
  innerWidth: number,
  topEdgeChar: string | undefined,
): string {
  const corners = {
    left: tone.dim(glyph.rounded.topLeft),
    right: tone.dim(glyph.rounded.topRight),
  };
  const plain = (): string =>
    corners.left + tone.dim(glyph.horizontal.repeat(innerWidth)) + corners.right;

  // 品牌锚胜出——同顶边只承载一种语义
  if (topEdgeChar) {
    return renderBrandTopEdge(topEdgeChar, innerWidth, corners, plain);
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

function renderBodyLine(line: BodyLine, innerWidth: number, indent: number): string {
  if (typeof line === "string") {
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
  // 点阵高亮行：│ 与 │ 之间整体送 highlightSelectedRow——indent / 内容 / 尾部
  // padding 全部参与替换。单空格保留规则让 indent=1 紧凑形态左侧自然留 1 单元
  // 呼吸；indent>=2 时左侧也参与点阵覆盖（与无框 entry row 行为一致）。
  const contentBudget = innerWidth - indent;
  const clamped = clampLine(line.content, contentBudget);
  const innerRow =
    " ".repeat(indent) +
    clamped +
    " ".repeat(Math.max(0, contentBudget - stringWidth(clamped)));
  const dotted = highlightSelectedRow(innerRow, innerWidth);
  return tone.dim(glyph.vertical) + dotted + tone.dim(glyph.vertical);
}
