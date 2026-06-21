/**
 * Paste 占位符原子单元操作 — 纯函数。
 *
 * 占位符（PASTE_TOKEN_PATTERN match 的字符串段）在交互层视为原子单元：
 *   - backspace / delete 一次删整段
 *   - cursor left / right 整段跨过
 *   - 再次粘贴时旧占位符整体移除，由新粘贴内容按当前产品语义替换
 *
 * 不修改 InputBuffer 内部模型——chars[] 仍是字符序列；原子语义在上层（typeahead-input
 * 的 keypress handler / paste 入口）拦截：
 *   - 原子命中（cursor 在/紧贴占位符边界）→ 返回新 draft + 新 cursor，caller setDraft
 *   - 不命中 → 返回 null，caller 走 buffer 原方法（普通字符级编辑）
 */

import { PASTE_TOKEN_PATTERN } from "./paste-registry.js";

export interface TokenRange {
  /** 占位符在 draft 中的 char 起始（不是 string offset） */
  readonly start: number;
  /** 占位符在 draft 中的 char 结束（exclusive） */
  readonly end: number;
}

/**
 * 找出 draft 中所有占位符的 char-level 范围。
 *
 * regex matchAll 返回 string offset；本函数把它转成 char offset 让 caller 与
 * cursor（char offset）可对比。
 */
export function findTokenCharRanges(draft: string): TokenRange[] {
  if (draft.length === 0) return [];
  const draftChars = Array.from(draft);

  // 构建 string offset → char offset 映射
  const offToChar = new Map<number, number>();
  let strOff = 0;
  let charIdx = 0;
  for (const c of draftChars) {
    offToChar.set(strOff, charIdx);
    strOff += c.length;
    charIdx++;
  }
  offToChar.set(strOff, charIdx);

  const ranges: TokenRange[] = [];
  for (const m of draft.matchAll(PASTE_TOKEN_PATTERN)) {
    const startStr = m.index!;
    const endStr = startStr + m[0].length;
    const startChar = offToChar.get(startStr);
    const endChar = offToChar.get(endStr);
    if (startChar === undefined || endChar === undefined) continue;
    ranges.push({ start: startChar, end: endChar });
  }
  return ranges;
}

export type AtomicEditKind = "backspace" | "delete" | "left" | "right";

export interface AtomicEditResult {
  readonly draft: string;
  readonly cursor: number;
}

/**
 * 尝试对编辑操作做原子化处理。命中返回新 draft + cursor；不命中返回 null。
 *
 * 原子规则（cursor 在 char 范围内表示）：
 *   - backspace：cursor 紧跟占位符末尾（cursor === range.end）→ 整段删，cursor 落 range.start
 *               cursor 落在占位符内部（range.start < cursor < range.end）→ 整段删
 *   - delete：cursor 紧贴占位符起始（cursor === range.start）→ 整段删，cursor 不变
 *            cursor 落在占位符内部 → 整段删，cursor 落 range.start
 *   - left：cursor === range.end → 整段跨过，cursor 落 range.start
 *          cursor 在占位符内部 → cursor 落 range.start
 *   - right：cursor === range.start → 整段跨过，cursor 落 range.end
 *           cursor 在占位符内部 → cursor 落 range.end
 */
export function tryAtomicEdit(
  draft: string,
  cursor: number,
  kind: AtomicEditKind,
): AtomicEditResult | null {
  const ranges = findTokenCharRanges(draft);
  if (ranges.length === 0) return null;

  for (const r of ranges) {
    const inside = cursor > r.start && cursor < r.end;

    if (kind === "backspace") {
      if (cursor === r.end || inside) {
        return {
          draft: removeCharRange(draft, r.start, r.end),
          cursor: r.start,
        };
      }
    } else if (kind === "delete") {
      if (cursor === r.start || inside) {
        return {
          draft: removeCharRange(draft, r.start, r.end),
          cursor: r.start,
        };
      }
    } else if (kind === "left") {
      if (cursor === r.end || inside) {
        return { draft, cursor: r.start };
      }
    } else if (kind === "right") {
      if (cursor === r.start || inside) {
        return { draft, cursor: r.end };
      }
    }
  }

  return null;
}

/**
 * 把 draft 中所有占位符整体删除，调整 cursor 跟随长度变化。
 *
 * 用于 finalizePaste 入口——已有占位符时第二次粘贴走"替换"语义：删除旧占位符
 * + insertText(新内容)。旧 registry entry 在下次 syncBroker 触发的
 * cleanup(extractAliveIds) 自然 GC。
 *
 * 用户编辑的非粘贴文本（占位符前后的字符）原样保留。
 */
export function removeAllPasteTokens(
  draft: string,
  cursor: number,
): AtomicEditResult | null {
  const ranges = findTokenCharRanges(draft);
  if (ranges.length === 0) return null;

  // 倒序构造新 draft：未处理 ranges 的 char index 不被前面删除扰动
  const draftChars = Array.from(draft);
  let resultChars = draftChars.slice();
  let cursorAfter = cursor;

  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    resultChars = [
      ...resultChars.slice(0, r.start),
      ...resultChars.slice(r.end),
    ];
    const lengthDelta = -(r.end - r.start);
    if (cursorAfter > r.end) {
      cursorAfter += lengthDelta;
    } else if (cursorAfter > r.start) {
      // cursor 落在原 range 内部 → 落到 range 起始（删除点）
      cursorAfter = r.start;
    }
  }

  return {
    draft: resultChars.join(""),
    cursor: cursorAfter,
  };
}

/** 删除 draft 中 [start, end) char 范围，返回新 draft。 */
function removeCharRange(draft: string, start: number, end: number): string {
  const chars = Array.from(draft);
  return [...chars.slice(0, start), ...chars.slice(end)].join("");
}
