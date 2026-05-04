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

export type PillKind = "ready" | "pending" | "disabled";

export function renderStatusPill(kind: PillKind, text: string): string {
  switch (kind) {
    case "ready":
      return tone.success(`${ic.ready} ${text}`);
    case "pending":
      return tone.warn(`${ic.pending} ${text}`);
    case "disabled":
      return tone.dim(`${ic.disabled} ${text}`);
  }
}
