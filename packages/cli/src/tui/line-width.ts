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

import {
  ansiEscapeLengthAt,
  isFullSgrReset,
  isSgrSeq,
  SGR_RESET,
  stripAnsi,
} from "./ansi.js";
import {
  collectAtomicStringRanges,
  hasAtomicRegionPatterns,
  type AtomicRegionPatterns,
} from "./atomic-regions.js";

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
 * Unicode 格式控制字符（General Category `Cf`）—— 不可见但占字符位的字符：
 * BOM (U+FEFF) / ZWS (U+200B) / ZWNJ (U+200C) / ZWJ (U+200D) / LRM (U+200E) /
 * RLM (U+200F) / bidi 控制 (U+202A-202E) / word joiner (U+2060) /
 * soft hyphen (U+00AD) 等。Unicode 标准持续扩展此类，用 `\p{Cf}` 一次覆盖
 * 当前及未来所有 Cf 字符，无须维护字符列表。
 */
const FORMAT_CONTROL = /\p{Cf}/u;

/**
 * 单个 Unicode code point 的显示宽度——cli 终端宽度判断的单一事实源。
 *
 * - 控制字符（C0/C1）→ 0
 * - 格式控制字符（Cf）→ 0 —— 包括 BOM / 零宽空格 / ZWJ / bidi 控制 / soft hyphen 等
 * - CJK / 全角 / emoji → 2
 * - 其它 → 1
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20) return 0; // C0 控制符
  if (cp >= 0x7f && cp < 0xa0) return 0; // DEL + C1
  if (FORMAT_CONTROL.test(String.fromCodePoint(cp))) return 0;
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
 * 按显示宽度右补空格 —— 列对齐场景的 String.padEnd 替代品。
 *
 * JS 原生 String.padEnd 按 char count 算，对含 ANSI 色彩转义 / CJK 全角 / emoji
 * 的字符串无法对齐。本函数：
 *   1. stringWidth 内部已剥 ANSI + 按 CJK-aware 累计（全角 2 列）
 *   2. 用 `targetCols - 可见宽度` 补空格，保留原 ANSI 转义不动
 *
 * 已显示宽度 ≥ targetCols 时不补（不截断 —— 截断由 caller 按需另行处理，
 * 例如 wrapToWidth / 按需 slice）。
 *
 * 任何需要列对齐渲染的场景（/trust 面板、/security 概览、未来表格 UI 等）
 * 都应走此函数，避免每个 caller 自己组合 stripAnsi + stringWidth + repeat。
 */
export function padEndDisplay(s: string, targetCols: number): string {
  const visible = stringWidth(s);
  if (visible >= targetCols) return s;
  return s + " ".repeat(targetCols - visible);
}

/**
 * 按显示宽度软换行——不在词边界换，按 code point 粒度切。
 *
 * CJK 字符按 2 列、emoji 按 2 列、控制符按 0 列计算。空文本返回 [""]——
 * 让 caller 能用 wrapped[0] 不会拿到 undefined。
 *
 * 不识别 ANSI 转义码——caller 应在 wrap 之前剥色（或对 raw text 调用），
 * 否则 ANSI 序列会被切碎。颜色应在 wrap 之后整段套上。
 *
 * 可选 `atomicRegions`：识别为不可切碎的整体单元（如粘贴占位符 token）。一旦传入
 * 启用增强算法：按 `\n` 先 split 成段独立 wrap（硬换行）；atomic 区域整体测量
 * 宽度，放不下当前行整体换到下行不被切碎中间字符。不传时保持原算法（含 `\n` 时
 * 按 0 宽控制符处理），与现有 caller 兼容。
 */
export function wrapToWidth(
  text: string,
  maxWidth: number,
  atomicRegions?: AtomicRegionPatterns,
): string[] {
  if (maxWidth <= 0) return [text];
  if (!hasAtomicRegionPatterns(atomicRegions)) {
    return wrapPlain(text, maxWidth);
  }
  const segments = text.split("\n");
  const result: string[] = [];
  for (const segment of segments) {
    result.push(...wrapWithAtomic(segment, maxWidth, atomicRegions));
  }
  return result;
}

/** 原算法——按 code point 粒度 char-by-char，不识别 atomic 也不硬换行 `\n`。 */
function wrapPlain(text: string, maxWidth: number): string[] {
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
 * 单段（不含 `\n`）+ atomic-aware wrap。atomic 区域整体测量宽度——
 * 放不下当前行整体换到下行，不被 char-by-char 算法切碎中间字符。
 */
function wrapWithAtomic(
  segment: string,
  maxWidth: number,
  atomicRegions: AtomicRegionPatterns,
): string[] {
  if (segment.length === 0) return [""];

  const atomics = collectAtomicStringRanges(segment, atomicRegions).map(
    (range) => ({
      ...range,
      width: stringWidth(range.content),
    }),
  );

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let pos = 0;
  let atomIdx = 0;

  while (pos < segment.length) {
    // atomic 起点：整体测量 + 必要时整体换行
    if (atomIdx < atomics.length && atomics[atomIdx]!.start === pos) {
      const atom = atomics[atomIdx]!;
      if (currentWidth > 0 && currentWidth + atom.width > maxWidth) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      current += atom.content;
      currentWidth += atom.width;
      pos = atom.end;
      atomIdx++;
      continue;
    }

    // 普通 code point
    const cp = segment.codePointAt(pos);
    if (cp === undefined) {
      pos++;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (currentWidth + w > maxWidth && currentWidth > 0) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
    pos += ch.length;
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

/** wrapAnsiLine 的可选参数——支持增量调用维护续状态 */
export interface WrapAnsiLineOptions {
  /**
   * 续行（wrap 后的非首行）起首注入的视觉缩进字串。**其内宽度不计入
   * `maxVisibleWidth`**——caller 自行确保 prefix 显示宽度 + 续行内容宽度
   * ≤ 终端列宽，避免续行触发终端自动换行。空字串表示续行无缩进。
   */
  readonly continuationPrefix?: string;
  /**
   * 起手 cursor 已占用的列宽——caller 用来支持"已写部分内容、本次接续"语义。
   * 默认 0 = 起手在新行行首；> 0 = 已在行内位 N 列处续写。
   */
  readonly startColumnWidth?: number;
  /**
   * 起手时已 active 的 SGR 序列累积——caller 跨调用维持染色状态用。
   * wrap 续行时会 emit `SGR_RESET` 关掉染色让 prefix 不继承，再 emit
   * `activeSgr` 让续行可见字符恢复染色。
   */
  readonly startActiveSgr?: string;
}

/** wrapAnsiLine 的返回值——含输出 + 末态供 caller 续接维护 */
export interface WrapAnsiLineResult {
  /** wrap 后的字符串，行间用 `\n` 分隔；含原 ANSI 序列原样透传 + 续行 prefix */
  readonly output: string;
  /** 输出末尾 cursor 的列宽（视觉宽度）——caller 续接时作下次 startColumnWidth */
  readonly endColumnWidth: number;
  /** 输出末尾 active 的 SGR 序列累积——caller 续接时作下次 startActiveSgr */
  readonly endActiveSgr: string;
}

/**
 * ANSI-aware 软折行——把含 ANSI 染色的单逻辑行按显示宽度拆成多段，
 * 行间用 `\n` 连接，跨 wrap 边界的 SGR 染色状态自动平衡（不会让 hanging
 * prefix 继承上行 bg 染色、不会让续行内容失色）。
 *
 * 行为契约：
 *   - 逐 code point 扫描，用 `charWidth` 累计可见宽度（CJK 2 列、ASCII 1 列、
 *     控制符 0 列、Cf 类格式控制 0 列）
 *   - ANSI CSI / OSC 序列原样透传、宽度 0、不参与折行决策
 *   - SGR 序列累积到 active SGR 状态；full reset (`\x1b[0m` / `\x1b[m` /
 *     `\x1b[0;0m`) 清空 active；其它 SGR (`\x1b[31m` / `\x1b[1m` 等) append
 *   - 累计宽度 + 当前字符 > `maxVisibleWidth` 时插 wrap：
 *     active 非空 → emit `SGR_RESET + \n + continuationPrefix + activeSgr`
 *     active 空 → emit `\n + continuationPrefix`
 *   - wrap 后 columnWidth 重置为 0（即 `maxVisibleWidth` 是续行**内容**预算，
 *     不含 continuationPrefix——caller 自负 prefix 宽度）
 *   - "至少一个可见字符" 才允许 wrap——单字符宽度大于 maxVisibleWidth 时整段
 *     原位 emit，避免死循环
 *   - input 不应含 `\n`（caller 应先按 `\n` 切段、对每段独立调本函数）；含 `\n`
 *     时按 0 宽控制符透传，不做特殊换行处理
 *
 * 用例：
 *   - block-renderer 一次性调用：`const { output } = wrapAnsiLine(line, columns - 1, { continuationPrefix: indent });`
 *   - text-stream 增量调用：传入 startColumnWidth / startActiveSgr 维护跨 chunk
 *     状态、用 endColumnWidth / endActiveSgr 更新自身 state
 */
export function wrapAnsiLine(
  text: string,
  maxVisibleWidth: number,
  options: WrapAnsiLineOptions = {},
): WrapAnsiLineResult {
  const continuationPrefix = options.continuationPrefix ?? "";
  let columnWidth = options.startColumnWidth ?? 0;
  let activeSgr = options.startActiveSgr ?? "";

  if (maxVisibleWidth <= 0 || text.length === 0) {
    return { output: text, endColumnWidth: columnWidth, endActiveSgr: activeSgr };
  }

  let out = "";
  let lineHasVisibleContent = columnWidth > 0;
  let i = 0;

  while (i < text.length) {
    const ansiLen = ansiEscapeLengthAt(text, i);
    if (ansiLen > 0) {
      const seq = text.slice(i, i + ansiLen);
      out += seq;
      if (isSgrSeq(seq)) {
        if (isFullSgrReset(seq)) {
          activeSgr = "";
        } else {
          activeSgr += seq;
        }
      }
      i += ansiLen;
      continue;
    }

    const cp = text.codePointAt(i);
    if (cp === undefined) {
      i++;
      continue;
    }
    const charStr = String.fromCodePoint(cp);
    const w = charWidth(cp);

    if (lineHasVisibleContent && columnWidth + w > maxVisibleWidth) {
      out +=
        activeSgr.length > 0
          ? `${SGR_RESET}\n${continuationPrefix}${activeSgr}`
          : `\n${continuationPrefix}`;
      columnWidth = 0;
      lineHasVisibleContent = false;
    }

    out += charStr;
    columnWidth += w;
    if (w > 0) lineHasVisibleContent = true;
    i += charStr.length;
  }

  return { output: out, endColumnWidth: columnWidth, endActiveSgr: activeSgr };
}
