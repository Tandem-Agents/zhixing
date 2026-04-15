/**
 * findTriggerToken — cursor-aware trigger 检测的通用工具
 *
 * 设计要点（spec §5.7）：
 *   - 基于 cursor 位置查 `draft.slice(0, cursor)`，不看整个 draft
 *   - Unicode-safe：token 字符类默认用 `\p{L}\p{N}`，支持中文命令名
 *   - `requireBoundary=true` 时触发字符前必须是空白或字符串开头
 *   - `requireBoundary=false` 允许 mid-input（Phase 3 Step 9）
 *   - 返回**字符**位置（不是字节），CJK 全角字符不会撕裂
 *
 * 用于 providers 内部 —— 不直接导出给 core 的最终 API，但 providers 都应该
 * 用这个工具而非自行写正则。
 */

// ─── 类型 ───

export interface TriggerTokenMatch {
  /** Token 在 draft 里的字符起始位置 */
  readonly tokenStart: number;
  /** Token 在 draft 里的字符终止位置（exclusive） */
  readonly tokenEnd: number;
  /** 完整 token 文本，含触发字符 */
  readonly token: string;
  /** 去掉触发字符后的 query 部分 */
  readonly query: string;
}

export interface FindTriggerTokenOptions {
  /**
   * 触发字符（单字符）。`/`、`@`、`#` 等。
   * 不支持多字符触发 —— 如有需要 provider 自己 post-process。
   */
  readonly triggerChar: string;
  /**
   * Token 允许的字符类 —— 作为 regex character class 的内容（不含方括号）。
   * 默认 `\p{L}\p{N}_\-:` 允许 Unicode 字母数字 + 下划线/连字符/冒号。
   * 不要在 class 里放 `/`、`@`、`#`（它们是触发字符）。
   */
  readonly tokenCharClass?: string;
  /**
   * 是否要求 trigger 字符前必须是空白或字符串开头（即"独立的词"）。
   * - true：不允许 mid-word 触发（对 `/` 避免匹配 Unix 路径如 `/usr/bin`）
   * - false：允许 mid-input 触发（对写长文时中间插 `@file` 有用）
   */
  readonly requireBoundary: boolean;
}

const DEFAULT_TOKEN_CLASS = "\\p{L}\\p{N}_\\-:";

// ─── 实现 ───

/**
 * 从 cursor 位置往前扫，找第一个 trigger token。
 *
 * **关键**：`draft` 按 code point 迭代（不是 UTF-16 code unit）。对于 BMP
 * 之外的 emoji 和高代理对，字符位置是按 `Array.from(draft)` 的逻辑字符计数。
 * 但 JS 字符串的 `.length` 和 `.slice(i, j)` 是按 UTF-16 code unit 的，所以
 * 我们内部转成 code point 数组处理，最后也按 code point 返回位置。
 *
 * @returns TriggerTokenMatch 命中 | null 不命中
 */
export function findTriggerToken(
  draft: string,
  cursor: number,
  options: FindTriggerTokenOptions,
): TriggerTokenMatch | null {
  const { triggerChar, tokenCharClass = DEFAULT_TOKEN_CLASS, requireBoundary } =
    options;

  // 按 code point 拆分 —— 这样 cursor 和 position 都以字符计数
  const chars = Array.from(draft);
  const clampedCursor = Math.max(0, Math.min(cursor, chars.length));

  // 从 cursor-1 往前扫，找最近的 triggerChar
  // 扫描时必须保持"扫描范围内的字符都是合法 token 字符"的不变量，
  // 否则 `foo /` 里的 /foo 会被误认为是 /foo 的 token —— 一旦遇到非 token 字符
  // （比如空格）就应该停止。但 trigger 字符本身不是 token 字符类的一员，
  // 所以遇到 trigger 字符就是命中条件。

  // 构造 token 字符的正则（单字符匹配）
  const tokenRe = new RegExp(`^[${tokenCharClass}]$`, "u");

  let triggerPos = -1;
  for (let i = clampedCursor - 1; i >= 0; i--) {
    const ch = chars[i]!;
    if (ch === triggerChar) {
      triggerPos = i;
      break;
    }
    if (!tokenRe.test(ch)) {
      // 遇到非 token / 非 trigger 字符 → 当前位置不在一个 trigger token 里
      return null;
    }
    // 否则继续往前扫
  }
  if (triggerPos === -1) return null;

  // 边界检查：requireBoundary=true 时 trigger 前必须是空白或开头
  if (requireBoundary && triggerPos > 0) {
    const prev = chars[triggerPos - 1]!;
    if (!/^\s$/u.test(prev)) {
      return null;
    }
  }

  // Token 结束位置：从 triggerPos+1 向后扫到第一个非 token 字符（或字符串末尾）
  let tokenEnd = triggerPos + 1;
  while (tokenEnd < chars.length && tokenRe.test(chars[tokenEnd]!)) {
    tokenEnd++;
  }

  // 要求 cursor 落在 token 范围内（允许恰好在 tokenEnd，代表"在 token 右边界"）
  if (clampedCursor < triggerPos || clampedCursor > tokenEnd) {
    return null;
  }

  const token = chars.slice(triggerPos, tokenEnd).join("");
  const query = chars.slice(triggerPos + 1, tokenEnd).join("");

  return {
    tokenStart: triggerPos,
    tokenEnd,
    token,
    query,
  };
}
