/**
 * 显示宽度计算与行截断
 *
 * 核心需求：防止行被终端自动换行——一旦行宽超过 stdout.columns，终端会折行，
 * 我们的 "clear N lines above" 数学就会崩掉（spec §6.4 陷阱 1）。
 *
 * 策略：所有写入前先按 `columns - 2` clamp；CJK 全角字符占 2 列。
 *
 * 不处理：
 *   - 复杂 emoji / ZWJ 序列（如 👨‍👩‍👧）——工程复杂度极高，个人助手场景极少遇到
 *   - 双宽控制符（如 tab 在不同列对齐位置宽度不同）——我们不支持 tab 展示
 *   - 组合字符（如 e+́）——按 Unicode 简化模型处理：组合字符作为 0 宽
 *
 * 这些不足在 spec §11.1 的次要风险里已经注明；发生时视觉上可能略微溢出，
 * 但 clampLine 会从后面补 reset，不会让 cursor 数学崩掉。
 */

import { stripAnsi } from "./ansi.js";

// ── CJK + 全角字符范围 ──
// 来源：Unicode East_Asian_Width=F/W + 常用 CJK blocks。
// 不追求 100% 覆盖，保证常见的中日韩字符正确即可。
const DOUBLE_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals + Kangxi
  [0x3041, 0x33ff], // Hiragana / Katakana / Bopomofo / Hangul compat
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compat Ideographs
  [0xfe30, 0xfe4f], // CJK Compat Forms
  [0xff00, 0xff60], // Fullwidth ASCII forms（！、？等全角）
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x20000, 0x2fffd], // CJK Extension B-F
  [0x30000, 0x3fffd], // CJK Extension G
];

// 现代 emoji 块——确定 2 列。
//
// 故意**不**包括 0x2600-0x27BF（Misc Symbols + Dingbats）：
// 这一段里的 ✓ ✦ ⚠ ⚡ 等符号在 Unicode East Asian Width 标准中是 "Neutral"（1 列），
// 多数终端按文本呈现（1 列）而非 emoji 呈现（2 列）。把整段当 2 列会让我们的
// 宽度计算与终端实际渲染脱节，chrome 边框、entry pill 都会因此错位。
//
// 若要让某符号显式按 2 列渲染（emoji 呈现），需在符号后加 VS16（U+FE0F）选择子；
// 我们当前代码无此场景。
const EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f300, 0x1faff], // Misc symbols + pictographs + emoticons + transport...
];

function inRanges(
  cp: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  // 注意：数组不保证有序（EMOJI_RANGES 的 0x1f300 > 0x2600）。
  // 线性扫描，不做二分也不做提前退出——数组很小（<20 条），代价可忽略。
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * 单个 Unicode code point 的显示宽度。
 * - 控制字符（C0/C1）→ 0
 * - CJK / 全角 / emoji → 2
 * - 其它 → 1
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20) return 0; // C0 控制符
  if (cp >= 0x7f && cp < 0xa0) return 0; // DEL + C1
  if (inRanges(cp, DOUBLE_WIDTH_RANGES)) return 2;
  if (inRanges(cp, EMOJI_RANGES)) return 2;
  return 1;
}

/**
 * 字符串的可视宽度——先剥 ANSI 再按 code point 累计。
 */
export function stringWidth(s: string): number {
  const stripped = stripAnsi(s);
  let w = 0;
  // for...of 会按 code point 迭代（正确处理代理对）
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    w += charWidth(cp);
  }
  return w;
}

/**
 * 按显示宽度软换行——不在词边界换，按 code point 粒度切。
 *
 * CJK 字符按 2 列、emoji 按 2 列、控制符按 0 列计算。空文本返回 [""]——
 * 让 caller 能用 wrapped[0] 不会拿到 undefined。
 *
 * 不识别 ANSI 转义码——caller 应在 wrap 之前剥色（或对 raw text 调用），
 * 否则 ANSI 序列会被切碎。颜色应在 wrap 之后整段套上。
 */
export function wrapToWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const w = charWidth(cp);
    if (currentWidth + w > maxWidth) {
      lines.push(current);
      current = ch;
      currentWidth = w;
    } else {
      current += ch;
      currentWidth += w;
    }
  }
  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

/**
 * 把一行（可能含 ANSI 转义 + 全角字符）截断到最多 `maxVisibleWidth` 个显示列。
 *
 * - 保留 ANSI 转义序列（它们占 0 宽）
 * - 在 code point 边界截断（不破代理对）
 * - 截断时追加 "…" + ANSI reset，防止颜色溢出到后续行
 * - 如果原本就不超宽，原样返回
 */
export function clampLine(s: string, maxVisibleWidth: number): string {
  if (maxVisibleWidth <= 0) return "";
  if (stringWidth(s) <= maxVisibleWidth) return s;

  const budget = Math.max(0, maxVisibleWidth - 1); // 为 "…" 预留 1 列
  const ellipsis = "…";

  let out = "";
  let visibleWidth = 0;
  let i = 0;
  while (i < s.length) {
    // 识别 ANSI 转义（0 宽，原样拷贝）——CSI 与 OSC 都要处理
    if (s[i] === "\x1b") {
      const rest = s.slice(i);
      // CSI: ESC[ ... <terminator>
      let m = rest.match(/^\x1b\[[0-9;?=<>]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
      // OSC: ESC] ... ST（超链接等）
      m = rest.match(/^\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    // 普通字符（含代理对）
    const cp = s.codePointAt(i);
    if (cp === undefined) {
      i++;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (visibleWidth + w > budget) break;
    out += ch;
    visibleWidth += w;
    i += ch.length;
  }

  return `${out}${ellipsis}\x1b[0m`;
}
