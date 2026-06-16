import {
  type ChannelBindingPolicy,
  type InboundMessage,
  DEFAULT_BINDING_POLICY,
  DEFAULT_CONVERSATION_ID,
} from "@zhixing/core";

/**
 * 根据入站消息和归组策略，确定目标 conversationId。
 *
 * 归组规则：
 * - thread → per-thread：{channelId}:thread:{threadId}
 * - group  → per-group：{channelId}:group:{groupId}
 *          → per-user-in-group：{channelId}:group:{groupId}:{from}
 * - dm     → 用户主对话：default
 *
 * 私聊来源是回复和权限边界，不是对话边界。这样用户从 CLI、飞书、
 * 微信等入口进入时，仍感觉自己一直在和同一个知行说话。
 */
export function resolveConversationId(
  msg: InboundMessage,
  policy?: ChannelBindingPolicy,
): string {
  const p = policy ?? DEFAULT_BINDING_POLICY;

  if (msg.chatType === "thread" && msg.threadId) {
    return `${msg.channelId}:thread:${msg.threadId}`;
  }

  if ((msg.chatType === "group" || msg.chatType === "channel") && msg.groupId) {
    if (p.group === "per-user-in-group") {
      return `${msg.channelId}:group:${msg.groupId}:${msg.from}`;
    }
    return `${msg.channelId}:group:${msg.groupId}`;
  }

  return DEFAULT_CONVERSATION_ID;
}
