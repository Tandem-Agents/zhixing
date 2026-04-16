/**
 * parseCommandDraft — 解析 `/cmd arg0 arg1 |` 的 token 位置
 *
 * 用于 ArgumentProvider 的 matchTrigger：当 CommandProvider 不再匹配（cursor 已过命令名 + 空格），
 * ArgumentProvider 用这个函数识别"用户在输入第 N 个参数"。
 *
 * 设计要点：
 *   - **字符安全**：用 `Array.from(draft)` 按 code point 处理，CJK / emoji 不撕裂
 *   - **简单空格分词**：Phase 2 不支持引号或转义；Phase 3 可以升级
 *   - **cursor-aware**：只看 `draft[0..cursor]`，draft 里 cursor 后的文本不影响解析
 *   - 返回 null 表示 draft 不是一个合法的命令 + 参数形态
 */

// ─── 类型 ───

export interface ParsedCommandDraft {
  /** 命令名（不含 `/`），如 "elevated" */
  readonly commandName: string;
  /** `/` 在 draft 里的字符位置 */
  readonly commandStart: number;
  /** 命令名结束位置（exclusive，即 `/` + commandName 之后的第一个字符） */
  readonly commandEnd: number;
  /** 已解析的参数值（cursor 前，按空格分词） */
  readonly args: readonly string[];
  /** cursor 落在第几个参数上（0-based）。对 ArgSchema[] 取下标用 */
  readonly argIndex: number;
  /** 当前参数 token 在 draft 里的字符起始位置 */
  readonly currentArgStart: number;
  /** 当前参数 token 在 draft 里的字符终止位置（exclusive） */
  readonly currentArgEnd: number;
  /** 当前参数 token 的文本（用于过滤 dropdown） */
  readonly currentArgValue: string;
}

// ─── 命令名合法字符 ───

const CMD_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

// ─── 实现 ───

/**
 * 解析一个 draft 字符串，提取命令名 + 当前参数上下文。
 *
 * 前置条件：draft 以 `/` 开头（可以有前导空白），cursor ∈ [0, draft.length]。
 *
 * 返回 null 的情况：
 *   - draft 里找不到 `/commandName `（必须有命令名后的空格才算进入参数区）
 *   - 命令名包含非法字符
 *   - cursor 还在命令名范围内（让 CommandProvider 处理）
 */
export function parseCommandDraft(
  draft: string,
  cursor: number,
): ParsedCommandDraft | null {
  const chars = Array.from(draft);
  const clampedCursor = Math.max(0, Math.min(cursor, chars.length));

  // ── 找 `/` 起始位置（跳过前导空白） ──
  let slashPos = -1;
  for (let i = 0; i < chars.length; i++) {
    if (/^\s$/u.test(chars[i]!)) continue;
    if (chars[i] === "/") {
      slashPos = i;
      break;
    }
    // 第一个非空白非 `/` 字符 → 不是命令
    return null;
  }
  if (slashPos === -1) return null;

  // ── 提取命令名 ──
  let nameEnd = slashPos + 1;
  while (nameEnd < chars.length && CMD_NAME_RE.test(chars[nameEnd]!)) {
    nameEnd++;
  }
  const commandName = chars.slice(slashPos + 1, nameEnd).join("");
  if (!commandName) return null;

  // ── 必须有空格分隔命令名和参数区 ──
  // 如果 nameEnd 之后没有字符或第一个字符不是空白 → cursor 还在命令名上
  if (nameEnd >= chars.length || !/^\s$/u.test(chars[nameEnd]!)) {
    return null;
  }

  // ── cursor 必须在参数区（命令名之后） ──
  if (clampedCursor <= nameEnd) {
    return null;
  }

  // ── 取 cursor 前的参数区文本（命令名之后到 cursor） ──
  const argZone = chars.slice(nameEnd + 1, clampedCursor);

  // ── 按空格分词 ──
  // "on off" → ["on", "off"]
  // "on " → ["on", ""]
  // "" → [""]
  const argTokens = splitBySpaces(argZone);

  const argIndex = argTokens.length - 1;
  const currentArgValue = argTokens[argIndex] ?? "";

  // ── 计算当前参数 token 的字符位置 ──
  // 从参数区末尾（cursor）往前推 currentArgValue 的长度
  const currentArgEnd = clampedCursor;
  const currentArgStart = currentArgEnd - Array.from(currentArgValue).length;

  return {
    commandName,
    commandStart: slashPos,
    commandEnd: nameEnd,
    args: argTokens,
    argIndex,
    currentArgStart,
    currentArgEnd,
    currentArgValue,
  };
}

/**
 * 按空格分词。保留尾部空字符串以表示"刚按了空格，新参数还没开始输入"。
 *
 * 例：
 *   "on off" → ["on", "off"]
 *   "on "    → ["on", ""]
 *   ""       → [""]
 *   " "      → ["", ""]
 */
function splitBySpaces(chars: readonly string[]): string[] {
  if (chars.length === 0) return [""];

  const tokens: string[] = [];
  let current = "";
  for (const ch of chars) {
    if (/^\s$/u.test(ch)) {
      tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  tokens.push(current); // 最后一个 token（可能是空字符串）
  return tokens;
}
