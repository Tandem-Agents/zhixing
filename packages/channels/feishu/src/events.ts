import type { ChatType, InboundMessage } from "@zhixing/core";

export interface FeishuMessageEvent {
  sender: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string };
      name: string;
      tenant_key?: string;
    }>;
  };
}

export function normalizeMessage(
  event: FeishuMessageEvent,
  channelId: string,
  botOpenId?: string,
): InboundMessage | null {
  const { sender, message } = event;

  if (sender.sender_type === "bot") return null;
  if (message.message_type !== "text") return null;

  const openId = sender.sender_id?.open_id;
  if (!openId) return null;

  let text: string;
  try {
    text = (JSON.parse(message.content) as { text?: string }).text ?? "";
  } catch {
    return null;
  }

  if (botOpenId && message.mentions) {
    for (const m of message.mentions) {
      if (m.id.open_id === botOpenId) {
        text = text.replace(m.key, "").trim();
      }
    }
  }

  if (!text) return null;

  const chatType: ChatType = message.chat_type === "p2p" ? "dm" : "group";

  return {
    from: openId,
    text,
    channelId,
    chatType,
    messageId: message.message_id,
    timestamp: message.create_time,
    groupId: chatType === "group" ? message.chat_id : undefined,
    threadId: message.root_id || undefined,
    raw: event,
  };
}
