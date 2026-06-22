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
 *     第一行的 ❯ 之后，多行被锚定为"同一个输入"——无论分行来源是软 wrap 还是
 *     用户粘贴的硬换行 `\n`，续行 prefix 一致
 *   - suffix 单行：placeholder / ghost text 通常很短，不参与 wrap；超出由 chrome
 *     的 clampLine 兜底（追加 …）。极端长 suffix 不展开是已知小坑、不阻塞
 *   - cursor 跨行边界归属：cursor === N 且第 N-1 个字符让行刚好满时，cursor 落在
 *     上一行末（col = lineWidth）；下一次按字符自然 wrap 到新行。匹配 readline
 *     在大多数终端上的行为
 *   - atomicRegions（可选）：识别为不可切碎的整体单元（如粘贴占位符 token）。
 *     atomic 区域整体测量宽度——放不下当前行就整体换到下行，保证占位符渲染完整
 *
 * 纯函数：无 I/O、无 ANSI 解析；ANSI 颜色码全部在调用方包装好后传入（promptPrefix
 * 与 suffix 自带 ANSI），算法只 wrap 裸 draft。返回的 bodyLines 直接喂给
 * renderChrome 的 body。
 */

import { ANSI, charWidth, stringWidth, stripAnsi } from "./tui/index.js";
import {
  collectAtomicStringRanges,
  hasAtomicRegionPatterns,
  type AtomicRegionPatterns,
} from "./tui/atomic-regions.js";

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
 * @param draft - 用户输入的裸文本（无 ANSI；可含 `\n` 硬换行）
 * @param cursorChars - cursor 在 draft 中的字符 offset（不是 UTF-16 unit），
 *   等于 `Array.from(draft).slice(0, cursorChars).length`
 * @param suffix - 最后一行末尾追加的提示文本（已含 ANSI dim 包装），不参与 wrap
 * @param contentBudget - chrome body 行的可见内容宽度（chrome 紧凑形态下 = frameWidth - 4）
 * @param atomicRegions - 可选 regex，识别为不可切碎的整体单元；不传时按字符级 wrap
 * @param paintVisualCursor - 是否在 cursorRow 上把 cursor 位置的字符（或末尾空位）
 *   用反色 SGR 包装，作为**视觉光标**渲染。这是 chrome-mode REPL 的标准做法 ——
 *   硬件光标在 chrome 期间永久隐藏（由 ScreenController 统一管理），输入光标由
 *   本函数以 reverse SGR 形式画在 body 内，解耦"输出区写入" vs "输入区光标可见性"。
 *   默认 false（保留纯布局语义供测试 / 非交互场景使用）。
 */
export function layoutInputBuffer(
  promptPrefix: string,
  draft: string,
  cursorChars: number,
  suffix: string,
  contentBudget: number,
  atomicRegions?: AtomicRegionPatterns,
  paintVisualCursor?: boolean,
): InputLayoutResult {
  const promptVisibleWidth = stringWidth(stripAnsi(promptPrefix));
  // 续行 hanging indent —— 与 prompt 等宽的空格，让 draft 左缘多行对齐
  const hangingIndent = " ".repeat(promptVisibleWidth);
  // wrap 文字宽度：chrome content 减去 prompt/hanging 占位
  const lineWidth = Math.max(1, contentBudget - promptVisibleWidth);

  const draftChars = Array.from(draft);
  const atomics = hasAtomicRegionPatterns(atomicRegions)
    ? findAtomicCharRanges(draft, draftChars, atomicRegions)
    : [];

  const lines: string[][] = [[]];
  let curWidth = 0;
  let cursorRow = -1;
  let cursorDraftCol = -1;
  let i = 0;
  let atomIdx = 0;

  while (i < draftChars.length) {
    // atomic 区域起点
    if (atomIdx < atomics.length && atomics[atomIdx]!.startChar === i) {
      const atom = atomics[atomIdx]!;

      // cursor 在 atomic 起始（cursorChars === atom.startChar）—— 落到当前行 col=curWidth
      if (cursorRow === -1 && cursorChars === atom.startChar) {
        cursorRow = lines.length - 1;
        cursorDraftCol = curWidth;
      }

      // 整体测量：放不下整体换行
      if (curWidth > 0 && curWidth + atom.width > lineWidth) {
        lines.push([]);
        curWidth = 0;
        // wrap 后再判一次 cursor 边界（cursor 紧跟 atomic 起始时落新行 col=0）
        if (cursorRow === -1 && cursorChars === atom.startChar) {
          cursorRow = lines.length - 1;
          cursorDraftCol = 0;
        }
      }

      // cursor 在 atomic 内部（startChar < cursor < endChar）—— 简化版落 atomic 末尾
      // 占位符是整体显示单元，cursor 在中间无法精确定位；用户编辑会破坏 token
      // 触发 orphan 回收，与简化版"占位符破坏后 GC"语义一致
      if (
        cursorRow === -1 &&
        cursorChars > atom.startChar &&
        cursorChars < atom.endChar
      ) {
        cursorRow = lines.length - 1;
        cursorDraftCol = curWidth + atom.width;
      }

      // 整体推 atomic 字符
      for (let k = atom.startChar; k < atom.endChar; k++) {
        lines[lines.length - 1]!.push(draftChars[k]!);
      }
      curWidth += atom.width;

      // cursor === atom.endChar 由下次循环顶端处理
      i = atom.endChar;
      atomIdx++;
      continue;
    }

    const ch = draftChars[i]!;

    // `\n` 硬换行
    if (ch === "\n") {
      // cursor 在 `\n` 之前 —— 落上一行末
      if (cursorRow === -1 && cursorChars === i) {
        cursorRow = lines.length - 1;
        cursorDraftCol = curWidth;
      }
      lines.push([]);
      curWidth = 0;
      // cursor 在 `\n` 之后 —— 落新行 col=0
      if (cursorRow === -1 && cursorChars === i + 1) {
        cursorRow = lines.length - 1;
        cursorDraftCol = 0;
      }
      i++;
      continue;
    }

    const cp = ch.codePointAt(0);
    if (cp === undefined) {
      i++;
      continue;
    }
    const w = charWidth(cp);

    // 软 wrap：当前字符放不下当前行
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
    i++;
  }

  // cursor 仍未放置——empty draft + cursor=0，或 cursor 越界——落到末行末
  if (cursorRow === -1) {
    cursorRow = lines.length - 1;
    cursorDraftCol = curWidth;
  }

  // 拼装 bodyLines：首行带 promptPrefix，续行 hangingIndent；suffix 拼到末行末
  // 可选视觉光标：cursorRow 上的 text 用 reverse SGR 包裹 cursor 位置的字符（或
  // 末位反白空格）；非 cursorRow / 关闭视觉光标时按原样输出。
  const lastIdx = lines.length - 1;
  const bodyLines = lines.map((chars, idx) => {
    const text = chars.join("");
    const prefix = idx === 0 ? promptPrefix : hangingIndent;
    const tail = idx === lastIdx ? suffix : "";
    const decoratedText =
      paintVisualCursor && idx === cursorRow
        ? paintVisualCursorInText(text, cursorDraftCol)
        : text;
    return prefix + decoratedText + tail;
  });

  return {
    bodyLines,
    cursorRow,
    cursorCol: promptVisibleWidth + cursorDraftCol,
  };
}

/**
 * 在 text 中按可见列定位 cursor 字符并用 reverse SGR 包裹，模拟硬件光标的"反白"
 * 视觉效果。chrome-mode 下硬件光标永久隐藏（ScreenController L1），输入光标在此
 * 由 chrome 渲染层独立呈现 —— 与 LLM 输出区写入完全解耦。
 *
 * 行为：
 *   - cursorDraftCol 落在某字符的左边界 → 包裹该字符（CJK 宽字符整体包裹，
 *     视觉宽度不变）
 *   - cursorDraftCol === 总可见宽度（cursor 在文本末尾）→ 末尾追加反白空格
 *     （宽度 +1；若末尾跟随 suffix 视为占用一列在 suffix 之前）
 *   - text 为空 + cursorDraftCol=0 → 仅一个反白空格
 *
 * 不变量：返回值的可见宽度 ≥ 输入 text 的可见宽度（仅在 cursor at end 路径 +1）；
 * cursor 内嵌路径不改变可见宽度。
 */
function paintVisualCursorInText(text: string, cursorDraftCol: number): string {
  const chars = Array.from(text);
  let visibleWidth = 0;
  for (let i = 0; i < chars.length; i++) {
    if (visibleWidth === cursorDraftCol) {
      const before = chars.slice(0, i).join("");
      const cursorChar = chars[i]!;
      const after = chars.slice(i + 1).join("");
      return `${before}${ANSI.reverseOn}${cursorChar}${ANSI.reverseOff}${after}`;
    }
    const cp = chars[i]!.codePointAt(0);
    if (cp === undefined) continue;
    visibleWidth += charWidth(cp);
  }
  return `${text}${ANSI.reverseOn} ${ANSI.reverseOff}`;
}

/**
 * 把 atomicRegions 在 draft 中的 string offset match 转换为 char offset 区间，
 * 供主循环按 char 索引推进。matchAll 顺序天然按 start 升序。
 */
function findAtomicCharRanges(
  draft: string,
  draftChars: string[],
  atomicRegions: AtomicRegionPatterns,
): Array<{ startChar: number; endChar: number; width: number }> {
  // 构建 string offset → char index 映射（包含末位）
  const offToChar = new Map<number, number>();
  let strOff = 0;
  let charIdx = 0;
  for (const c of draftChars) {
    offToChar.set(strOff, charIdx);
    strOff += c.length;
    charIdx++;
  }
  offToChar.set(strOff, charIdx);

  const ranges: Array<{ startChar: number; endChar: number; width: number }> = [];
  for (const range of collectAtomicStringRanges(draft, atomicRegions)) {
    const startStr = range.start;
    const endStr = range.end;
    const startChar = offToChar.get(startStr);
    const endChar = offToChar.get(endStr);
    if (startChar === undefined || endChar === undefined) continue;
    ranges.push({
      startChar,
      endChar,
      width: stringWidth(range.content),
    });
  }
  return ranges;
}
