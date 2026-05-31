/**
 * Footer 全宽分隔 + 提示文字。
 *
 *   ──────────────────────────────────────────────────
 *     ↑↓ 选择 · Enter 进入/确认 · Ctrl+C 退出
 *
 * 分隔线 dim 不抢戏；提示 dim + 中点分隔。
 * 调用方按需输出，不假设位置（多数情况在面板末尾）。
 */

import { glyph, tone } from "./style.js";

const HINT_INDENT = 2;
const HINT_SEPARATOR = " · ";

export interface FooterOptions {
  width: number;
  hints: readonly string[];
}

export function renderFooter(opts: FooterOptions): string[] {
  const separator = tone.dim(glyph.horizontal.repeat(opts.width));
  const hintLine = " ".repeat(HINT_INDENT) + tone.dim(opts.hints.join(HINT_SEPARATOR));
  return [separator, hintLine];
}
