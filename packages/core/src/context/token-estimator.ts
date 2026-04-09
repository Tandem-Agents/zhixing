/**
 * Token 估算器
 *
 * 设计决策（详见 research/design/specifications/context-engine.md）：
 * - 不使用 tiktoken：三个顶级产品（OpenClaw、Claude Code、Cursor）都验证了不需要
 * - CJK 一等公民：中文约 1-2 token/字，Latin chars/4 会严重低估
 * - 自适应校准：每次 API 返回真实 usage 时，用滑动平均更新比率
 *
 * 对比 OpenClaw：闭源 estimateTokens + 固定 20% 余量。
 * 对比 Claude Code：API 锚定 + 保守估算，但未明确处理 CJK。
 * 知行：CJK 主线加权 + 自适应校准，完全自研。
 */

import type { ContentBlock, Message } from "../types/messages.js";
import type { ITokenEstimator } from "./types.js";

// ─── 估算常量 ───

/** Latin/ASCII 字符的 token 权重（约 4 字符 = 1 token） */
const LATIN_WEIGHT = 0.25;

/**
 * CJK 字符的 token 权重。
 * 实测 Claude：中文约 1.2-1.8 token/字，取 1.5 作为经验值。
 * 略高于实际平均值，符合"宁可高估"的安全策略。
 */
const CJK_WEIGHT = 1.5;

/**
 * Emoji 的 token 权重。
 * 多数 tokenizer 对 emoji 需要 2-3 个 token。
 */
const EMOJI_WEIGHT = 2.0;

/**
 * 每条消息的固定开销（role 标记、content 数组结构等）。
 * Anthropic API 约 3-4 token/message overhead。
 */
const MESSAGE_OVERHEAD = 4;

/**
 * 每个 content block 的固定开销（type 标记、字段名等）。
 */
const BLOCK_OVERHEAD = 3;

/**
 * tool_use 块中 JSON 结构的额外开销（大括号、引号、冒号等）。
 * 经验值：JSON.stringify 的结构字符约占 15-25%。
 */
const JSON_STRUCTURE_RATIO = 0.2;

/**
 * 校准的滑动平均权重。
 * 0.85 = 新校准值权重 15%，保留 85% 历史。
 * 这个值使校准平稳收敛，不因单次异常跳变。
 */
const CALIBRATION_SMOOTHING = 0.85;

/** 校准因子的安全范围。防止极端值导致估算偏差。 */
const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 3.0;

// ─── CJK 检测 ───

/**
 * CJK Unified Ideographs 及扩展区间。
 * 覆盖中文、日文汉字、韩文汉字、越南喃字。
 */
function isCJK(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||   // CJK Unified (基本区)
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||   // CJK Extension A
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) || // CJK Extension B
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) || // CJK Extension C
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) || // CJK Extension D
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||   // CJK Compatibility
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f) || // CJK Compatibility Supplement
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||   // CJK Symbols and Punctuation
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||   // Fullwidth Forms
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||   // Hiragana
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||   // Katakana
    (codePoint >= 0xac00 && codePoint <= 0xd7af)      // Hangul Syllables
  );
}

/**
 * 检测 emoji（简化版）。
 * 覆盖常见 emoji 范围，不做完整 Unicode 属性匹配。
 */
function isEmoji(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f600 && codePoint <= 0x1f64f) || // Emoticons
    (codePoint >= 0x1f300 && codePoint <= 0x1f5ff) || // Misc Symbols & Pictographs
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) || // Transport & Map
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) || // Supplemental Symbols
    (codePoint >= 0x2600 && codePoint <= 0x26ff) ||   // Misc Symbols
    (codePoint >= 0x2700 && codePoint <= 0x27bf) ||   // Dingbats
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||   // Variation Selectors
    (codePoint >= 0x1fa00 && codePoint <= 0x1fa6f) || // Chess, extended-A
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff)    // Symbols extended-A
  );
}

// ─── 核心估算函数 ───

/**
 * 估算一段文本的原始 token 数（不含校准因子）。
 *
 * 逐 code point 分类加权：
 * - CJK → 1.5 token/字
 * - Emoji → 2.0 token/字
 * - Latin/其他 → 0.25 token/字（≈ chars/4）
 */
export function estimateTextTokensRaw(text: string): number {
  if (text.length === 0) return 0;

  let tokens = 0;

  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;

    if (isCJK(cp)) {
      tokens += CJK_WEIGHT;
    } else if (isEmoji(cp)) {
      tokens += EMOJI_WEIGHT;
    } else {
      tokens += LATIN_WEIGHT;
    }
  }

  return Math.ceil(tokens);
}

/**
 * 估算单个 ContentBlock 的 token 数（不含校准因子）。
 */
function estimateBlockTokensRaw(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return BLOCK_OVERHEAD + estimateTextTokensRaw(block.text);

    case "thinking":
      return BLOCK_OVERHEAD + estimateTextTokensRaw(block.thinking);

    case "tool_use": {
      const nameTokens = estimateTextTokensRaw(block.name);
      const inputJson = JSON.stringify(block.input);
      const inputTokens = estimateTextTokensRaw(inputJson);
      const structureOverhead = Math.ceil(inputTokens * JSON_STRUCTURE_RATIO);
      return BLOCK_OVERHEAD + nameTokens + inputTokens + structureOverhead;
    }

    case "tool_result":
      return BLOCK_OVERHEAD + estimateTextTokensRaw(block.content);

    case "image":
      // 图片 token 消耗取决于分辨率，Anthropic 文档给出约 1600 token/图
      return 1600;
  }
}

/**
 * 估算单条消息的 token 数（不含校准因子）。
 */
function estimateMessageTokensRaw(message: Message): number {
  let tokens = MESSAGE_OVERHEAD;
  for (const block of message.content) {
    tokens += estimateBlockTokensRaw(block);
  }
  return tokens;
}

// ─── TokenEstimator 类 ───

export class TokenEstimator implements ITokenEstimator {
  private _calibrationFactor: number;

  constructor(initialCalibration = 1.0) {
    this._calibrationFactor = clampCalibration(initialCalibration);
  }

  get calibrationFactor(): number {
    return this._calibrationFactor;
  }

  estimateText(text: string): number {
    return Math.ceil(estimateTextTokensRaw(text) * this._calibrationFactor);
  }

  estimateMessage(message: Message): number {
    return Math.ceil(estimateMessageTokensRaw(message) * this._calibrationFactor);
  }

  estimateMessages(messages: readonly Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += estimateMessageTokensRaw(msg);
    }
    return Math.ceil(total * this._calibrationFactor);
  }

  calibrate(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;

    const observedRatio = actual / estimated;
    const newFactor =
      this._calibrationFactor * CALIBRATION_SMOOTHING +
      observedRatio * (1 - CALIBRATION_SMOOTHING);

    this._calibrationFactor = clampCalibration(newFactor);
  }
}

function clampCalibration(value: number): number {
  return Math.max(MIN_CALIBRATION, Math.min(MAX_CALIBRATION, value));
}

/**
 * 创建 Token 估算器。
 *
 * @example
 * ```ts
 * const estimator = createTokenEstimator();
 * const tokens = estimator.estimateMessage(userMessage("你好世界"));
 * // API 返回后校准
 * estimator.calibrate(tokens, actualUsage.inputTokens);
 * ```
 */
export function createTokenEstimator(
  initialCalibration?: number,
): TokenEstimator {
  return new TokenEstimator(initialCalibration);
}
