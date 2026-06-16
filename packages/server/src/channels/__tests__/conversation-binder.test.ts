import { describe, it, expect } from "vitest";
import { resolveConversationId } from "../conversation-binder.js";
import {
  DEFAULT_CONVERSATION_ID,
  type ChannelBindingPolicy,
  type InboundMessage,
} from "@zhixing/core";

function dm(channelId: string, from: string): InboundMessage {
  return { channelId, from, text: "hi", chatType: "dm" };
}

function group(channelId: string, from: string, groupId: string): InboundMessage {
  return { channelId, from, text: "hi", chatType: "group", groupId };
}

function thread(channelId: string, from: string, threadId: string): InboundMessage {
  return { channelId, from, text: "hi", chatType: "thread", threadId };
}

describe("resolveConversationId", () => {
  describe("DM (user main conversation)", () => {
    it("uses the user's main conversation for DM", () => {
      const id = resolveConversationId(dm("dingtalk", "user-1"));
      expect(id).toBe(DEFAULT_CONVERSATION_ID);
    });

    it("different DM senders share the same personal conversation", () => {
      const a = resolveConversationId(dm("dingtalk", "user-1"));
      const b = resolveConversationId(dm("dingtalk", "user-2"));
      expect(a).toBe(b);
    });

    it("same DM sender on different channels still maps to the same conversation", () => {
      const a = resolveConversationId(dm("dingtalk", "user-1"));
      const b = resolveConversationId(dm("feishu", "user-1"));
      expect(a).toBe(b);
    });
  });

  describe("group (per-group)", () => {
    it("uses channel + groupId", () => {
      const id = resolveConversationId(group("dingtalk", "user-1", "grp-x"));
      expect(id).toBe("dingtalk:group:grp-x");
    });

    it("different users in same group share conversation", () => {
      const a = resolveConversationId(group("dingtalk", "user-1", "grp-x"));
      const b = resolveConversationId(group("dingtalk", "user-2", "grp-x"));
      expect(a).toBe(b);
    });
  });

  describe("group (per-user-in-group)", () => {
    const policy: ChannelBindingPolicy = {
      group: "per-user-in-group",
    };

    it("uses channel + groupId + user", () => {
      const id = resolveConversationId(group("dingtalk", "user-1", "grp-x"), policy);
      expect(id).toBe("dingtalk:group:grp-x:user-1");
    });

    it("different users in same group get different conversations", () => {
      const a = resolveConversationId(group("dingtalk", "user-1", "grp-x"), policy);
      const b = resolveConversationId(group("dingtalk", "user-2", "grp-x"), policy);
      expect(a).not.toBe(b);
    });
  });

  describe("thread (per-thread)", () => {
    it("uses channel + threadId", () => {
      const id = resolveConversationId(thread("dingtalk", "user-1", "thr-42"));
      expect(id).toBe("dingtalk:thread:thr-42");
    });

    it("different users in same thread share conversation", () => {
      const a = resolveConversationId(thread("dingtalk", "user-1", "thr-42"));
      const b = resolveConversationId(thread("dingtalk", "user-2", "thr-42"));
      expect(a).toBe(b);
    });
  });

  describe("fallback for missing groupId/threadId", () => {
    it("group without groupId falls back to DM", () => {
      const msg: InboundMessage = { channelId: "ch", from: "u", text: "hi", chatType: "group" };
      const id = resolveConversationId(msg);
      expect(id).toBe(DEFAULT_CONVERSATION_ID);
    });

    it("thread without threadId falls back to DM", () => {
      const msg: InboundMessage = { channelId: "ch", from: "u", text: "hi", chatType: "thread" };
      const id = resolveConversationId(msg);
      expect(id).toBe(DEFAULT_CONVERSATION_ID);
    });
  });
});
