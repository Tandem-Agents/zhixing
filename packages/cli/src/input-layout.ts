/**
 * 输入区行布局——把 promptPrefix + draft + 可选 suffix 按可视宽度 wrap 成多行，
 * 并定位 cursor 到 wrap 后的 (row, col)。
 *
 * 视觉契约：
 *   ╭── ... ──╮
 *   │ ❯ 第一行内容继续往后跨行的部分被 wrap 到下一 │  ← 第一行：promptPrefix + chunk
 *   │   一行，hanging indent 与 prompt 之后对齐 │  ← 续行：等宽空格 + chunk
 *   │   最后一行末尾若有 suffix（ghost / placeh… │  ← suffix 拼到末行（不 wrap）
 *   ╰─────────────────────────────────────────╯
 *
 * 设计取舍：
 *   - hanging indent：续行缩进 promptVisibleWidth 个空格，让 draft 视觉左缘对齐
 *     第一行的 ❯ 之后，多行被锚定为"同一个输入"
 *   - suffix 单行：placeholder / ghost text 通常很短，不参与 wrap；超出由 chrome
 *     的 clampLine 兜底（追加 …）。极端长 suffix 不展开是已知小坑、不阻塞
 *   - cursor 跨行边界归属：cursor === N 且第 N-1 个字符让行刚好满时，cursor 落在
 *     上一行末（col = lineWidth）；下一次按字符自然 wrap 到新行。匹配 readline
 *     在大多数终端上的行为
 *
 * 纯函数：无 I/O、无 ANSI 解析；ANSI 颜色码全部在调用方包装好后传入（promptPrefix
 * 与 suffix 自带 ANSI），算法只 wrap 裸 draft。返回的 bodyLines 直接喂给
 * renderChrome 的 body。
 */

import { charWidth, stringWidth, stripAnsi } from "./tui/index.js";

export interface InputLayoutResult {
  /** 已格式化的多行（首行带 promptPrefix、续行 hanging indent），喂给 renderChrome.body */
  readonly bodyLines: string[];
  /** cursor 落在 bodyLines 的第几行（0-based） */
  readonly cursorRow: number;
  /**
   * cursor 在所属行内的可见列偏移（包含 promptPrefix / hanging 占位）——
   * 即从 chrome 内 body 行起始（左 │ + indent 之后）算起的可见列。
   */
  readonly cursorCol: number;
}

/**
 * @param promptPrefix - 第一行前缀（含 ANSI 颜色，如 brand bold ❯ + space）
 * @param draft - 用户输入的裸文本（无 ANSI）
 * @param cursorChars - cursor 在 draft 中的字符 offset（不是 UTF-16 unit），
 *   等于 `Array.from(draft).slice(0, cursorChars).length`
 * @param suffix - 最后一行末尾追加的提示文本（已含 ANSI dim 包装），不参与 wrap
 * @param contentBudget - chrome body 行的可见内容宽度（chrome 紧凑形态下 = frameWidth - 4）
 */
export function layoutInputBuffer(
  promptPrefix: string,
  draft: string,
  cursorChars: number,
  suffix: string,
  contentBudget: number,
): InputLayoutResult {
  const promptVisibleWidth = stringWidth(stripAnsi(promptPrefix));
  // 续行 hanging indent —— 与 prompt 等宽的空格，让 draft 左缘多行对齐
  const hangingIndent = " ".repeat(promptVisibleWidth);
  // wrap 文字宽度：chrome content 减去 prompt/hanging 占位
  const lineWidth = Math.max(1, contentBudget - promptVisibleWidth);

  const draftChars = Array.from(draft);
  const lines: string[][] = [[]];
  let curWidth = 0;
  let cursorRow = -1;
  let cursorDraftCol = -1;

  for (let i = 0; i < draftChars.length; i++) {
    const ch = draftChars[i]!;
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const w = charWidth(cp);

    // 即将 wrap：先建新行，再处理 cursor 边界
    if (curWidth + w > lineWidth && curWidth > 0) {
      lines.push([]);
      curWidth = 0;
    }

    // cursor 在 i 之前（cursorChars === i）—— 落到当前行 col=curWidth
    if (cursorRow === -1 && cursorChars === i) {
      cursorRow = lines.length - 1;
      cursorDraftCol = curWidth;
    }

    lines[lines.length - 1]!.push(ch);
    curWidth += w;

    // cursor 在 i 之后（cursorChars === i + 1）—— 落到当前行 col=curWidth
    if (cursorRow === -1 && cursorChars === i + 1) {
      cursorRow = lines.length - 1;
      cursorDraftCol = curWidth;
    }
  }

  // cursor 仍未放置——empty draft + cursor=0，或 cursor 越界——落到末行末
  if (cursorRow === -1) {
    cursorRow = lines.length - 1;
    cursorDraftCol = curWidth;
  }

  // 拼装 bodyLines：首行带 promptPrefix，续行 hanging indent；suffix 拼到末行末
  const lastIdx = lines.length - 1;
  const bodyLines = lines.map((chars, i) => {
    const text = chars.join("");
    const prefix = i === 0 ? promptPrefix : hangingIndent;
    const tail = i === lastIdx ? suffix : "";
    return prefix + text + tail;
  });

  return {
    bodyLines,
    cursorRow,
    cursorCol: promptVisibleWidth + cursorDraftCol,
  };
}
