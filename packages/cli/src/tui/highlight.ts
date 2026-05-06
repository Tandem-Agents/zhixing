/**
 * 选中行点阵纹理高亮——把行内空白带替换为 dim ░ 字符 + 尾部补齐到 totalWidth。
 *
 * 替换策略：
 *   - 2+ 连续空格 → 同长度 dim ░（左右区之间的 padding 等"空白带"）
 *   - 单空格保留——避免视觉粘连（cursor 与 label 之间等内容分隔符）
 *   - 尾部补齐 totalWidth 也用 dim ░
 *
 * 不依赖 bg ANSI 颜色码——纯字符纹理。视觉是"印刷品/点阵屏"质感，
 * 与 SaaS 风格的 bg color 选中态明显区分。
 *
 * caller 责任：传入的 row 必须是**裸文本行**（无 chrome 边框字符），
 * 输出长度恰好 totalWidth（按可见宽度计算）。
 */

import { tone } from "./style.js";
import { stringWidth } from "./line-width.js";

export function highlightSelectedRow(row: string, totalWidth: number): string {
  const dotted = row.replace(/ {2,}/g, (m) => tone.dim("░".repeat(m.length)));
  const visibleWidth = stringWidth(dotted);
  const padCount = Math.max(0, totalWidth - visibleWidth);
  return padCount > 0 ? dotted + tone.dim("░".repeat(padCount)) : dotted;
}
