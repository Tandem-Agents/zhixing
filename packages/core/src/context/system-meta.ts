/**
 * System-Meta —— 对话中系统元信息标签的单一事实源
 *
 * 问题背景：
 *   Compact / 消息丢弃 / transcript load 在 6 个不同文件各自构造 placeholder
 *   字符串（"[对话已压缩]..." / "[前 X 轮对话已省略]"）。任一处改动漏同步，
 *   LLM 看到的占位符格式就分裂，stripSummaryPlaceholderPair 识别就失败。
 *
 * 本模块是生成、识别、剥离 `<system-meta kind="...">` 元信息标签的唯一入口。
 * 所有插入占位符的代码（llm-summarize / message-drop / transcript/store /
 * prompts）都必须调用这里的 buildXxx() 构造。
 *
 * 格式：
 *   `<system-meta kind="<kind>">...</system-meta>`
 *
 * 常见 kind：
 *   - compact-summary: LLM 生成的压缩摘要，替代早期消息
 *   - ack: 机制插入的 assistant 回执，用于保持角色交替
 *   - dropped-turns: 非摘要型省略占位（应急地板机械截断时）
 *   - startup-bootstrap: 启动 / 恢复时倒读装填的近期上下文
 *   - workscene-digest: 工作场景退出时注入的交接纪要
 *
 * 为什么用 XML-like 标签：
 *   - LLM 训练数据中 system-* 标签常见，自动识别为元信息
 *   - system prompt 额外告知（SYSTEM_META_PROMPT_SECTION）进一步强化
 *   - 便于正则识别（detectSystemMetaKind）
 */

import type { Message } from "../types/messages.js";

// ─── 需被压缩/丢弃生命周期识别的 kind 类型 ───

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
 * 构造 dropped-turns 占位消息（应急地板机械截断时使用）。
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

/**
 * 构造启动装填对 —— 重启 / 切换对话时，owner 把"此前对话的摘要 + 最近原文"
 * 渲染为一条机制插入的 user/assistant 对，作为注意力窗口的起始条目。
 *
 * 角色形态与 compact summaryPair 同模式：user 承载装填内容（标签明确标记
 * 为机制插入、不冒充用户原话）、assistant 回执保角色交替合法。
 *
 * **刻意只提供构造、不进 SystemMetaKind / detectSystemMetaKind /
 * stripSummaryPlaceholderPair**（与 workscene-digest 同决策）：装填对不属于
 * 压缩 / 丢弃生命周期——折叠时它作为窗口条目被摘要对整体取代，是窗口的
 * 结构操作、不靠标签识别；SYSTEM_META_PROMPT_SECTION 的通用框架已覆盖
 * 任意 kind，不需要为每个 kind 维护独立枚举。
 */
export function buildStartupBootstrapPair(
  content: string,
): readonly [Message, Message] {
  const escaped = escapeSystemMetaPayload(content);
  const bootstrapMsg: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<system-meta kind="startup-bootstrap">${escaped}</system-meta>`,
      },
    ],
  };
  const ackMsg: Message = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `<system-meta kind="ack">已接续此前对话</system-meta>`,
      },
    ],
  };
  return [bootstrapMsg, ackMsg] as const;
}

/**
 * 构造工作场景退出纪要消息 —— power 退出工作模式时生成的一段交接，append 到
 * 主对话运行态消息末尾，让主对话知道工作场景里做了什么。
 *
 * 角色 user：与 dropped-turns 同理，LLM 视角下"系统补充的上下文"以 user 发言
 * 承载最自然（连续 user 消息 Anthropic API 允许）。payload 走同款 escape 防止
 * 内容里的 `</system-meta>` 破坏标签识别。
 *
 * **刻意只提供构造、不进 SystemMetaKind / detectSystemMetaKind /
 * stripSummaryPlaceholderPair / SYSTEM_META_PROMPT_SECTION**：
 *   - 纪要是“持久交接上下文”，不属于压缩/丢弃生命周期。detectSystemMetaKind
 *     对它返回 null 即正确行为 —— 它该像普通消息一样随对话老化被摘要，绝不
 *     被当作 summary pair 剥离或当作 dropped 标记特殊保留。
 *   - SYSTEM_META_PROMPT_SECTION 的通用框架（“对话历史中可能出现
 *     <system-meta kind="..."> ……机制插入的元信息，不是用户原话；不要回应
 *     标签本身；将其中内容作为上下文使用”）已泛化覆盖任意 kind，主对话据此
 *     即把纪要识别为机制插入而非自己原话。
 * 仍走本模块构造：单一事实源 + escape 保护是本模块的职责，ad-hoc 拼串会重蹈
 * “多处各自构造 placeholder”的回归。
 */
export function buildWorksceneDigestMessage(digest: string): Message {
  const escaped = escapeSystemMetaPayload(digest);
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<system-meta kind="workscene-digest">${escaped}</system-meta>`,
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
 * 用途：段切换在切分前判断 toSummarize 开头是否有前次压缩的 pair，
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
 * 由 system-prompt 组装方注入到静态前缀（identity 之后），
 * 确保 LLM 始终知道 `<system-meta>` 是机制层占位，
 * 不是用户原话、无需回应本身。
 */
export const SYSTEM_META_PROMPT_SECTION = `[系统元信息标签]
对话历史中可能出现 <system-meta kind="..."> 标签，这是运行时机制插入的上下文，不是用户原话。

遇到这些标签时：
- 读取标签内容作为上下文，不要回应标签本身
- compact-summary 表示早期对话压缩摘要；dropped-turns 表示若干轮对话被省略
- 其他 kind 也按机制上下文处理，直接利用标签内容继续当前任务
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
