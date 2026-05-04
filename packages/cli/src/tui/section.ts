/**
 * 章节头 + 入口行——主面板的层级骨架。
 *
 *   ◆ 对话模型
 *     主模型必填，辅助模型可选——预留给后续轻量子任务用，未配则沿用主模型
 *
 *   ▸ 主模型             siliconflow · MiniMax-M2.5    ⚠ 待补 API Key
 *     辅助模型                                          · 未启用
 *
 * Section 头：◆ + 粗体 + 主色；描述紧贴下方 dim 行
 * Entry 行：左 cursor + label + 右 status pill；选中时 label 粗体
 */

import { tone, icon as ic } from "./style.js";
import { stringWidth } from "./line-width.js";
import { renderStatusPill, type PillKind } from "./status-pill.js";

const DEFAULT_INDENT = 2;
const MIN_GAP = 2; // entry 行 label 与 status 之间的最小间隔

export interface SectionHeadOptions {
  title: string;
  description?: string;
  indent?: number;
}

export function renderSectionHead(opts: SectionHeadOptions): string[] {
  const indent = " ".repeat(opts.indent ?? DEFAULT_INDENT);
  const head = `${indent}${tone.brand(ic.section)} ${tone.bold(opts.title)}`;
  if (!opts.description) return [head];
  // 描述左对齐 ◆ 之后的列：indent + "◆ "（2 列）
  return [head, `${indent}  ${tone.dim(opts.description)}`];
}

export interface EntryRowOptions {
  label: string;
  status: { kind: PillKind; text: string };
  selected?: boolean;
  /** 行总宽——决定 status 右对齐位置 */
  width: number;
  indent?: number;
}

export function renderEntryRow(opts: EntryRowOptions): string {
  const indent = opts.indent ?? DEFAULT_INDENT;
  const cursor = opts.selected ? tone.brand(ic.cursor) : " ";
  const labelText = opts.selected ? tone.bold(opts.label) : opts.label;
  const left = " ".repeat(indent) + cursor + " " + labelText;

  const pill = renderStatusPill(opts.status.kind, opts.status.text);
  const leftWidth = stringWidth(left);
  const pillWidth = stringWidth(pill);
  const padWidth = Math.max(MIN_GAP, opts.width - leftWidth - pillWidth);
  return left + " ".repeat(padWidth) + pill;
}
