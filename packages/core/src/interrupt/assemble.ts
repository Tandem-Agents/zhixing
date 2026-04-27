/**
 * `assemblePartialMessage` —— abort 路径的 partial assistant message 构造器。
 *
 * 与正常路径 `llm-call.ts assembleMessage` 严格区别:
 * - assembleMessage 走完整路径,包含 thinking + text + tool_use
 * - assemblePartialMessage 走 abort 路径,**仅 text + thinking,绝不携带 tool_use**
 *
 * 丢弃 partial tool_use 的代价:用户中断后看 transcript 看不到 LLM 在那一刻
 * 准备调用什么工具。换来的收益:协议规则简单 + 实现确定性。流式 tool_use args
 * 完整性判断不可靠(tool_call_end 事件可能未到达;argsJson 表面完整但语义残缺),
 * 区分"完整 tool_use 保留 + 残缺 tool_use 丢弃"需要引入"判定 args 完整性"的
 * 脆弱启发式——统一丢弃换来 partial assistant 永远不会出现"orphan tool_use"
 * 协议违规风险。何时反转:产品反馈"中断后看不到 LLM 想做什么"是关键缺失时,
 * 需独立设计完整性判定 + 强制 placeholder 配对机制。
 *
 * `[interrupted]` 标记必出:
 * - text 非空 → 在 text block 末尾追加 `\n\n[interrupted]`
 * - thinking-only(无 text)→ 追加独立 text block,内容为 `[interrupted]`,
 *   保证用户读 transcript 时能识别"中断的 thinking",而不是误以为"已结束"
 * - text 与 thinking 都为空 → return null,不 yield assistant_message
 */

import type { ContentBlock, Message } from "../types/messages.js";

const INTERRUPTED_MARKER = "[interrupted]";

export function assemblePartialMessage(
  text: string,
  thinking: string,
): Message | null {
  if (!text && !thinking) return null;

  const blocks: ContentBlock[] = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  if (text) {
    blocks.push({ type: "text", text: `${text}\n\n${INTERRUPTED_MARKER}` });
  } else {
    // thinking-only:独立 text block 承载标记,让用户能识别"中断的 thinking"
    blocks.push({ type: "text", text: INTERRUPTED_MARKER });
  }
  return { role: "assistant", content: blocks };
}

/**
 * 安全 assistant message 构造器 —— 仅 text + thinking,跳过任何 tool_use blocks。
 *
 * 与 `assemblePartialMessage` 共享"跳过残缺 tool_use 防协议违规"的核心保证 ——
 * 残缺 tool_use 进入 next-turn LLM 调用会因缺配对 tool_result 报 400。
 *
 * 区别于 assemblePartialMessage:**不加 [interrupted] 标记**,适用于非用户中断场景:
 *   - provider error (LLM SDK / API 错误中断 stream)
 *   - 其他非 abort 触发的不完整 stream 场景
 * 加 [interrupted] 会误导用户以为是主动中断,语义不符。
 *
 * 调用方:llm-call.ts 的 provider error 出口;abort 路径走 assemblePartialMessage (经 cleanup)。
 *
 * 返回 null 当 text 与 thinking 都为空(无内容可 yield)。
 */
export function assembleSafeMessage(
  text: string,
  thinking: string,
): Message | null {
  if (!text && !thinking) return null;

  const blocks: ContentBlock[] = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  if (text) blocks.push({ type: "text", text });
  return { role: "assistant", content: blocks };
}
