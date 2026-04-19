import { describe, expect, it } from "vitest";
import { normalizeMessage, type FeishuMessageEvent } from "./events.js";

function makeEvent(overrides?: Partial<{
  senderType: string;
  messageType: string;
  content: string;
  chatType: "p2p" | "group";
  chatId: string;
  openId: string;
  messageId: string;
  mentions: FeishuMessageEvent["message"]["mentions"];
}>): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: overrides?.openId ?? "ou_user1" },
      sender_type: overrides?.senderType ?? "user",
      tenant_key: "t1",
    },
    message: {
      message_id: overrides?.messageId ?? "msg_001",
      create_time: "1700000000000",
      chat_id: overrides?.chatId ?? "oc_chat1",
      chat_type: overrides?.chatType ?? "p2p",
      message_type: overrides?.messageType ?? "text",
      content: overrides?.content ?? JSON.stringify({ text: "hello" }),
      mentions: overrides?.mentions,
    },
  };
}

const CHANNEL_ID = "feishu";

describe("normalizeMessage", () => {
  it("normalizes a DM text message", () => {
    const msg = normalizeMessage(makeEvent(), CHANNEL_ID);
    expect(msg).not.toBeNull();
    expect(msg!.from).toBe("ou_user1");
    expect(msg!.text).toBe("hello");
    expect(msg!.chatType).toBe("dm");
    expect(msg!.channelId).toBe(CHANNEL_ID);
    expect(msg!.groupId).toBeUndefined();
  });

  it("uses the provided channelId", () => {
    const msg = normalizeMessage(makeEvent(), "feishu-work");
    expect(msg!.channelId).toBe("feishu-work");
  });

  it("normalizes a group message", () => {
    const msg = normalizeMessage(makeEvent({ chatType: "group" }), CHANNEL_ID);
    expect(msg!.chatType).toBe("group");
    expect(msg!.groupId).toBe("oc_chat1");
  });

  it("returns null for bot messages", () => {
    expect(normalizeMessage(makeEvent({ senderType: "bot" }), CHANNEL_ID)).toBeNull();
  });

  it("returns null for non-text messages", () => {
    expect(normalizeMessage(makeEvent({ messageType: "image" }), CHANNEL_ID)).toBeNull();
  });

  it("returns null for invalid JSON content", () => {
    expect(normalizeMessage(makeEvent({ content: "not json" }), CHANNEL_ID)).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(
      normalizeMessage(makeEvent({ content: JSON.stringify({ text: "" }) }), CHANNEL_ID),
    ).toBeNull();
  });

  it("strips bot mention from text", () => {
    const botId = "ou_bot1";
    const event = makeEvent({
      chatType: "group",
      content: JSON.stringify({ text: "@_user_1 hello bot" }),
      mentions: [
        { key: "@_user_1", id: { open_id: botId }, name: "Bot", tenant_key: "t1" },
      ],
    });
    const msg = normalizeMessage(event, CHANNEL_ID, botId);
    expect(msg!.text).toBe("hello bot");
  });

  it("keeps non-bot mentions intact", () => {
    const event = makeEvent({
      chatType: "group",
      content: JSON.stringify({ text: "@_user_1 hi @_user_2" }),
      mentions: [
        { key: "@_user_1", id: { open_id: "ou_other" }, name: "Other", tenant_key: "t1" },
        { key: "@_user_2", id: { open_id: "ou_bot1" }, name: "Bot", tenant_key: "t1" },
      ],
    });
    const msg = normalizeMessage(event, CHANNEL_ID, "ou_bot1");
    expect(msg!.text).toBe("@_user_1 hi");
  });

  it("preserves messageId and timestamp", () => {
    const msg = normalizeMessage(makeEvent({ messageId: "msg_xyz" }), CHANNEL_ID);
    expect(msg!.messageId).toBe("msg_xyz");
    expect(msg!.timestamp).toBe("1700000000000");
  });

  it("stores raw event", () => {
    const event = makeEvent();
    const msg = normalizeMessage(event, CHANNEL_ID);
    expect(msg!.raw).toBe(event);
  });

  it("returns null when sender_id.open_id is missing", () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {},
        sender_type: "user",
      },
      message: {
        message_id: "msg_001",
        create_time: "1700000000000",
        chat_id: "oc_chat1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };
    expect(normalizeMessage(event, CHANNEL_ID)).toBeNull();
  });
});
