import { ANSI } from "./ansi.js";
import { charWidth, clampLine, stringWidth } from "./line-width.js";
import { tone } from "./style.js";

/** 单行追加式输入的可视窗口。只裁显示，保留草稿末尾与真实／视觉光标的共同位置。 */
export function renderInputTail(
  prefix: string,
  draft: string,
  width: number,
): { line: string; cursorCol: number } {
  const budget = Math.max(1, Math.floor(width));
  const head = clampLine(prefix, Math.max(0, budget - Math.min(12, budget)));
  const available = budget - stringWidth(head) - 1;
  const chars = Array.from(draft);
  const clipped = stringWidth(draft) > available;
  const tailBudget = Math.max(0, available - (clipped ? 1 : 0));
  let start = chars.length;
  let used = 0;
  while (start > 0) {
    const nextWidth = charWidth(chars[start - 1]!.codePointAt(0)!);
    if (used + nextWidth > tailBudget) break;
    used += nextWidth;
    start--;
  }
  const tail = `${clipped && available > 0 ? "…" : ""}${chars.slice(start).join("")}`;
  return {
    line: `${head}${tone.brand(tail)}${ANSI.reverseOn} ${ANSI.reverseOff}`,
    cursorCol: stringWidth(head) + stringWidth(tail),
  };
}
