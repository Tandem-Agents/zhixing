/**
 * System-Meta —— 对话中系统元信息标签的单一事实源
 *
 * 问题背景：
 *   Compact / 消息丢弃 / transcript load 在 6 个不同文件各自构造 placeholder
 *   字符串（"[对话已压缩]..." / "[前 X 轮对话已省略]"）。任一处改动漏同步，
 *   LLM 看到的占位符格式就分裂，stripSummaryPlaceholderPair 识别就失败。
 *
 * 本模块是生成、识别、剥离 `<system-meta kind="...">` 元信息标签的唯一入口。
 * 所有插入占位符的代码（llm-summarize / message-drop / window-manager /
 * transcript/store / prompts）都必须调用这里的 buildXxx() 构造。
 *
 * 格式：
 *   `<system-meta kind="<kind>">...</system-meta>`
 *
 * 三种 kind：
 *   - compact-summary: LLM 生成的压缩摘要，替代早期消息
 *   - ack: 紧跟 compact-summary 的 assistant 回执
 *   - dropped-turns: 非摘要型省略占位（MessageDrop / WindowManager 淘汰时）
 *
 * 为什么用 XML-like 标签：
 *   - LLM 训练数据中 system-* 标签常见，自动识别为元信息
 *   - system prompt 额外告知（SYSTEM_META_PROMPT_SECTION）进一步强化
 *   - 便于正则识别（detectSystemMetaKind）
 */

import type { Message } from "../types/messages.js";

// ─── Kind 类型 ───

export type SystemMetaKind = "compact-summary" | "ack" | "dropped-turns";

// ─── 常量 ───

const ACK_TEXT = "已阅读摘要";
const DROPPED_TURNS_TEXT_PREFIX = "前 ";
const DROPPED_TURNS_TEXT_SUFFIX = " 轮对话已省略";

/**
 * 识别正则：从 text block 开头严格匹配 `<system-meta kind="...">` 标签。
 *
 * 只匹配开头（^） —— 只有作为 message 首个 text block 首字符出现的标签才被
 * 识别为 system-meta。防止 LLM 生成的正文中偶然出现标签被误识别。
 */
const SYSTEM_META_TAG_REGEX = /^<system-meta kind="([a-z][a-z-]*)"/;

// ─── 构造器 ───

/**
 * 构造 compact-summary + ack pair。
 *
 * summary 内任何 `</system-meta>` 会被 escape 为视觉等价的 Unicode 字符，
 * 防止 summary 内容意外嵌入结束标签破坏格式识别。这是 bullet-proof 的
 * 元信息保护 —— 系统层不能被数据层污染。
 */
export function buildCompactSummaryPair(
  summary: string,
): readonly [Message, Message] {
  const escaped = escapeSystemMetaPayload(summary);
  const summaryMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<system-meta kind="compact-summary">${escaped}</system-meta>`,
      },
    ],
  };
  const ackMsg: Message = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `<system-meta kind="ack">${ACK_TEXT}</system-meta>`,
      },
    ],
  };
  return [summaryMsg, ackMsg] as const;
}

/**
 * 构造 dropped-turns 占位消息（MessageDrop / WindowManager 淘汰时使用）。
 *
 * 角色设定为 user —— LLM 视角下，省略的历史对话"补丁"以用户发言承载
 * 是自然的（Anthropic API 允许连续 user 消息，LLM 理解为"系统层补充"）。
 */
export function buildDroppedTurnsMessage(count: number): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<system-meta kind="dropped-turns" count="${count}">${DROPPED_TURNS_TEXT_PREFIX}${count}${DROPPED_TURNS_TEXT_SUFFIX}</system-meta>`,
      },
    ],
  };
}

// ─── 识别 ───

/**
 * 识别单条消息是否为 system-meta 占位符，返回 kind 或 null。
 *
 * 识别规则（严格）：
 *   1. 消息必须至少有一个 content block
 *   2. 首个 block 必须是 type === "text"
 *   3. 文本必须以 `<system-meta kind="..."` 开头（正则严格匹配开头）
 *
 * 只看首 block 首字符是为了防止 LLM 生成的正文文本被误识别。
 */
export function detectSystemMetaKind(msg: Message): SystemMetaKind | null {
  const firstBlock = msg.content[0];
  if (!firstBlock || firstBlock.type !== "text") return null;
  const match = SYSTEM_META_TAG_REGEX.exec(firstBlock.text);
  if (!match) return null;
  const kind = match[1];
  if (
    kind === "compact-summary" ||
    kind === "ack" ||
    kind === "dropped-turns"
  ) {
    return kind;
  }
  return null;
}

// ─── 剥离 ───

/**
 * 如果 messages 以 compact-summary + ack pair 开头，返回去掉 pair 后的数组；
 * 否则返回原数组。
 *
 * 用途：LLMSummarize.apply 前判断 toSummarize 开头是否有前次压缩的 pair，
 * 有则去掉（不把 placeholder 当实际对话计入"替代轮数"）。
 *
 * 严格只剥 compact-summary + ack —— 不剥 dropped-turns（后者是独立的
 * 驱逐标记，不代表"文件 Turn 被摘要替代"，保留能让下次 LLM summary 看到
 * "前面还省略了 X 轮"的上下文）。
 */
export function stripSummaryPlaceholderPair(
  messages: readonly Message[],
): Message[] {
  if (messages.length < 2) return [...messages] as Message[];
  const firstKind = detectSystemMetaKind(messages[0]!);
  const secondKind = detectSystemMetaKind(messages[1]!);
  if (firstKind === "compact-summary" && secondKind === "ack") {
    return messages.slice(2) as Message[];
  }
  return [...messages] as Message[];
}

// ─── system prompt 告知段 ───

/**
 * 系统提示中告知 LLM 对话历史中会出现的 system-meta 标签格式。
 *
 * 由 layer-assembler 注入到 Layer 0（identity 之后），确保 LLM 始终知道
 * `<system-meta>` 是机制层占位，不是用户原话、无需回应本身。
 */
export const SYSTEM_META_PROMPT_SECTION = `[系统元信息标签]
对话历史中可能出现 <system-meta kind="..."> 标签，这是上下文管理机制插入的元信息，不是用户原话：
- kind="compact-summary": 之前对话的压缩摘要，已替代早期消息
- kind="ack": 紧跟摘要的阅读回执（由你先前发出）
- kind="dropped-turns" count="N": 已省略 N 轮对话的占位标记

遇到这些标签时：
- 按 kind 字段理解含义，将其中内容作为上下文使用
- 不要回应标签本身（它们不是用户提问）
- 基于可见的信息继续对话`;

// ─── 内部辅助 ───

/**
 * 对嵌入 system-meta 的 payload 做最小 escape。
 *
 * 当前只处理一种情况：payload 内的 `</system-meta>` 会被替换为视觉等价的
 * Unicode 字符（连字符换成非断开连字符 U+2011），这样识别正则不会提前匹配
 * 到嵌入的结束标签、LLM 也不会把嵌入内容当成标签结束。
 *
 * 不用 backslash 转义：LLM 可能看不懂 `<\/system-meta>` 等字面转义。
 * 用 Unicode 字符替换 —— 视觉几乎等同，但字节串不同，parser/regex 不会混淆。
 */
function escapeSystemMetaPayload(payload: string): string {
  return payload.replace(/<\/system-meta>/gi, "</system‑meta>");
}
