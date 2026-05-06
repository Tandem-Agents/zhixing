/**
 * 章节头 + 入口行——主面板的层级骨架。
 *
 *   ▎ 对话模型
 *     主模型必填，辅助模型可选——预留给后续轻量子任务用，未配则沿用主模型
 *
 *     ▸ 主模型             siliconflow · MiniMax-M2.5    ⚠ 待补 API Key
 *       辅助模型                                          · 未启用
 *
 * 层级 indent：
 *   - Section 头 ▎ 在 col 0（最外层），title 文字落在 col 2
 *   - 描述 / entry 内容文字落在 col 4——视觉上"内容比标题更内嵌"，层级清晰
 *
 * Section 头右侧可挂 status pill（如"操作 ⚠ 待补充 N 项"）——紧挨标题、不右对齐，
 * 因为这是"标题的状态修饰"语义，不是表格列。
 */

import { tone, icon as ic, layout } from "./style.js";
import { stringWidth, wrapToWidth } from "./line-width.js";
import { highlightSelectedRow } from "./highlight.js";
import {
  renderStatusPill,
  renderStatusPillWrapped,
  type PillKind,
} from "./status-pill.js";

const ENTRY_INDENT = layout.contentIndent;
// title 比 entry label 少 1 列——半个 CJK 字宽的层级落差，足够区分但不过分
const TITLE_INDENT = 1;
// 描述行文字与 entry label 同列：cursor + space 两列让位 → 2 + 2 = 4 spaces
const DESCRIPTION_PREFIX = " ".repeat(layout.contentIndent + 2);
// 状态 pill 紧挨 title 的间距——非右对齐，让 pill 看起来是"标题的修饰"
const STATUS_GAP = "   ";

export interface SectionHeadOptions {
  title: string;
  description?: string;
  /** 标题右侧的状态 pill——典型场景是"操作 ⚠ 待补充 N 项" */
  status?: { kind: PillKind; text: string };
}

export function renderSectionHead(opts: SectionHeadOptions): string[] {
  // ▎ 与 title 同字重——与欢迎区"知行"色调一致，作为统一品牌锚色
  const titlePart =
    " ".repeat(TITLE_INDENT) +
    `${tone.brand.bold(ic.section)} ${tone.bold(opts.title)}`;

  let head = titlePart;
  if (opts.status) {
    const pill = renderStatusPill(opts.status.kind, opts.status.text);
    head = titlePart + STATUS_GAP + pill;
  }

  if (!opts.description) return [head];
  // title 与 desc 之间空一行——让标题"独立"于描述，描述"独立"于内容
  return [head, "", `${DESCRIPTION_PREFIX}${tone.dim(opts.description)}`];
}

export interface EntryRowOptions {
  label: string;
  status: { kind: PillKind; text: string };
  selected?: boolean;
  /** 行总宽——左右两区按对半分 */
  width: number;
  indent?: number;
}

/**
 * Entry 行——双区布局：
 *   左区（0 到 width/2）：cursor + label，左对齐
 *   右区（width/2 到 width）：pill（icon + text），左对齐；超宽自动换行
 *
 * 选中态：cursor 换成品牌色 ▸ + 整行 bg 高亮（含右侧补齐到 width 的 padding）。
 * 未选中：左侧默认 dim › 标记表明"此行可选"，不抢戏。
 *
 * 多行返回——pill 短时长度 1，长时多行（续行的左区为空格、右区从 width/2 起）。
 */
export function renderEntryRow(opts: EntryRowOptions): string[] {
  const indent = opts.indent ?? ENTRY_INDENT;
  const cursor = opts.selected
    ? tone.brand.bold(ic.cursor)
    : tone.dim(ic.selectable);
  const labelText = opts.selected ? tone.bold(opts.label) : opts.label;
  const left = " ".repeat(indent) + cursor + " " + labelText;

  const leftZoneWidth = Math.floor(opts.width / 2);
  const rightZoneWidth = Math.max(1, opts.width - leftZoneWidth);

  const pillLines = renderStatusPillWrapped(
    opts.status.kind,
    opts.status.text,
    rightZoneWidth,
  );

  const rows = layoutTwoColumn(left, pillLines, leftZoneWidth);
  return opts.selected ? rows.map((row) => highlightSelectedRow(row, opts.width)) : rows;
}

export interface ListRowOptions {
  label: string;
  /** 右区辅助描述——纯展示文本，dim 渲染（无 icon、无 level） */
  description?: string;
  /** 用户当前已选项——左侧 cursor 之后加绿色 ● 标记；不传 = 列表无 current 概念 */
  current?: boolean;
  selected?: boolean;
  /** 行总宽——左右两区按对半分 */
  width: number;
  indent?: number;
}

/**
 * 列表行——双区布局，与 EntryRow 同结构但右区是纯描述（不是带 level 的状态 pill）。
 *
 *   左区：cursor + 可选 ● current 标记 + label
 *   右区：description（dim），超宽自动换行
 *
 * 当 list 整体有 current 概念（model-list 等）时，所有行共享 marker 槽位让 label
 * 起始列对齐——避免"current 行多缩进 2 列、其他行不缩进"的视觉抖动。
 */
export function renderListRow(opts: ListRowOptions): string[] {
  const indent = opts.indent ?? ENTRY_INDENT;
  const cursor = opts.selected
    ? tone.brand.bold(ic.cursor)
    : tone.dim(ic.selectable);
  const labelText = opts.selected ? tone.bold(opts.label) : opts.label;

  // current 字段被显式传入（无论 true/false）= 此 list 有 current 概念
  // → 始终保留 marker 槽位（` ● ` 或 `   `），让 label 起始列在所有行对齐
  let left: string;
  if (opts.current === undefined) {
    left = " ".repeat(indent) + cursor + " " + labelText;
  } else {
    const marker = opts.current ? tone.success("●") : " ";
    left = " ".repeat(indent) + cursor + " " + marker + " " + labelText;
  }

  let rows: string[];
  if (!opts.description) {
    rows = [left];
  } else {
    const leftZoneWidth = Math.floor(opts.width / 2);
    const rightZoneWidth = Math.max(1, opts.width - leftZoneWidth);
    const wrapped = wrapToWidth(opts.description, rightZoneWidth);
    const colored = wrapped.map((line) => tone.dim(line));
    rows = layoutTwoColumn(left, colored, leftZoneWidth);
  }

  return opts.selected ? rows.map((row) => highlightSelectedRow(row, opts.width)) : rows;
}

/**
 * 左右双区布局组合子——给 left 行追加 right 多行内容。
 *
 *   首行 = left + leftPadding + rightLines[0]
 *   续行 = rightZoneIndent + rightLines[i]   (i > 0)
 *
 * left 含 ANSI 颜色码也能正确填充（按可见宽度计算 padding）。
 */
function layoutTwoColumn(
  left: string,
  rightLines: readonly string[],
  leftZoneWidth: number,
): string[] {
  const leftVisibleWidth = stringWidth(left);
  const leftPadding = " ".repeat(Math.max(0, leftZoneWidth - leftVisibleWidth));
  const rightZoneIndent = " ".repeat(leftZoneWidth);
  return rightLines.map((rightLine, i) =>
    i === 0 ? left + leftPadding + rightLine : rightZoneIndent + rightLine,
  );
}

