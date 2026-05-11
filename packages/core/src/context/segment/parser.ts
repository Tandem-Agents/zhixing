/**
 * <facts>/<state>/<active> 三段 XML 解析器 —— 纯函数。
 *
 * 容错设计（LLM 偶发输出不规范时不应让段切换硬失败）：
 *   - 单段缺失 → 该段空字符串（不抛错，让对话仍可继续）
 *   - 标签大小写不敏感（兼容 <Facts> / <STATE> 等输出）
 *   - 标签内首尾空白裁掉（避免渲染时出现多余换行）
 *   - 不强制顺序 —— LLM 可能在标签前后插入解释 / 问候（忽略）
 *   - 重复标签取第一组（非贪婪匹配）—— 保守策略，避免拼接错位
 *
 * 解析后全段为空时调用方应视为压缩失败 emit 失败事件并降级不切。
 * 这层判断由 SegmentManager 编排层负责，parser 只做语法层提取不做语义判断。
 */

import type { ParsedSummary } from "./types.js";

export function parseSummary(text: string): ParsedSummary {
  return {
    facts: extractTagBody(text, "facts"),
    state: extractTagBody(text, "state"),
    active: extractTagBody(text, "active"),
  };
}

/**
 * 提取 <tag>...</tag> 体内文本。匹配失败返空字符串。
 *
 * 正则要点：
 *   - `[\s\S]*?` 跨行非贪婪匹配（避免吞掉下一个标签）
 *   - `i` flag 大小写不敏感
 */
function extractTagBody(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = text.match(re);
  if (!match) return "";
  const body = match[1] ?? "";
  return body.trim();
}
