/**
 * 文本净化原语 — 纯函数,零依赖。
 *
 * 处理外部不可信文本(网页抓取/用户输入/MCP 工具结果等)在进入 LLM 上下文前的清洗:
 * 1. Unicode 归一化(NFC 默认),消除视觉等价但 codepoint 不同的字符差异
 * 2. 剥离零宽字符与 bidi 控制码,封堵不可见 prompt 注入
 * 3. 字符级长度截断 + 截断标记(避免 LLM 上下文超限)
 *
 * 操作顺序固定: normalize → strip → truncate(顺序变化会导致截断长度不准)。
 */

import type { SanitizeOptions } from "./types.js";

/**
 * 零宽与不可见格式字符:
 * - U+200B–U+200F: ZWSP / ZWNJ / ZWJ / LRM / RLM
 * - U+2060–U+206F: WORD JOINER / 不可见运算符 / Bidi 标记 / 弃用格式控制
 * - U+FEFF:        ZWNBSP / BOM
 */
const ZERO_WIDTH_PATTERN = /[​-‏⁠-⁯﻿]/g;

const DEFAULT_TRUNCATION_MARKER = "[... truncated]";

/**
 * 净化外部不可信文本,返回安全的字符串。
 *
 * @param text  原始文本
 * @param opts  可选配置(详见 SanitizeOptions)
 * @returns 处理后文本
 */
export function sanitizeUntrustedText(text: string, opts?: SanitizeOptions): string {
  const form = opts?.normalizeForm ?? "NFC";
  const marker = opts?.truncationMarker ?? DEFAULT_TRUNCATION_MARKER;

  let result = text.normalize(form);
  result = result.replace(ZERO_WIDTH_PATTERN, "");

  const maxChars = opts?.maxChars;
  if (maxChars !== undefined && result.length > maxChars) {
    if (marker.length >= maxChars) {
      result = marker.slice(0, maxChars);
    } else {
      result = result.slice(0, maxChars - marker.length) + marker;
    }
  }

  return result;
}
