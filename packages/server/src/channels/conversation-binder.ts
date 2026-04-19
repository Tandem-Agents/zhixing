import {
  type ChannelBindingPolicy,
  type InboundMessage,
  DEFAULT_BINDING_POLICY,
} from "@zhixing/core";

/**
 * 根据入站消息和归组策略，确定目标 conversationId。
 *
 * 归组规则（server-gateway.md §6.2）：
 * - thread → per-thread：{channelId}:thread:{threadId}
 * - group  → per-group：{channelId}:group:{groupId}
 *          → per-user-in-group：{channelId}:group:{groupId}:{from}
 * - dm     → per-user：dm:{channelId}:{from}
 *
 * DM 归组当前带 channelId 前缀。跨通道会话漫游需要用户身份联邦，
 * 届时可去掉 channelId 前缀实现漫游（不改签名，只改映射逻辑）。
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

  return `dm:${msg.channelId}:${msg.from}`;
}
