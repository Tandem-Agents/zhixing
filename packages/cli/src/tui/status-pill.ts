/**
 * 状态 pill：icon + 文本双通道，不依赖颜色识别。
 *
 *   ✓ 已配齐         （绿）
 *   ⚠ 待补 API Key   （黄）
 *   · 未启用         （灰）
 *
 * 色弱用户看 icon、正常用户看色 + icon 双通道确认。
 */

import { tone, icon as ic } from "./style.js";
import { wrapToWidth } from "./line-width.js";

export type PillKind = "ready" | "pending" | "disabled";

const ICONS = {
  ready: ic.ready,
  pending: ic.pending,
  disabled: ic.disabled,
} as const;

const COLORS = {
  ready: tone.success,
  pending: tone.warn,
  disabled: tone.dim,
} as const;

export function renderStatusPill(kind: PillKind, text: string): string {
  return COLORS[kind](`${ICONS[kind]} ${text}`);
}

/**
 * 按可见宽度自动换行的 pill——长文本超出 maxWidth 时拆多行，每段保持配色。
 *
 * 实现：先 wrap raw 文本（含 icon），再对每行套色。这样 ANSI 不会被切碎、
 * 每行颜色完整。续行不会重复 icon——icon 只在第一行（因为 raw 文本只有 1 个 icon）。
 */
export function renderStatusPillWrapped(
  kind: PillKind,
  text: string,
  maxWidth: number,
): string[] {
  const raw = `${ICONS[kind]} ${text}`;
  const wrapped = wrapToWidth(raw, maxWidth);
  return wrapped.map((line) => COLORS[kind](line));
}
