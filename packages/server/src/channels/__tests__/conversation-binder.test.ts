import { describe, it, expect } from "vitest";
import { resolveConversationId } from "../conversation-binder.js";
import type { ChannelBindingPolicy, InboundMessage } from "@zhixing/core";

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
  describe("DM (per-user)", () => {
    it("uses channel + user for DM", () => {
      const id = resolveConversationId(dm("dingtalk", "user-1"));
      expect(id).toBe("dm:dingtalk:user-1");
    });

    it("different users get different conversations", () => {
      const a = resolveConversationId(dm("dingtalk", "user-1"));
      const b = resolveConversationId(dm("dingtalk", "user-2"));
      expect(a).not.toBe(b);
    });

    it("same user on different channels get different conversations (no roaming yet)", () => {
      const a = resolveConversationId(dm("dingtalk", "user-1"));
      const b = resolveConversationId(dm("feishu", "user-1"));
      expect(a).not.toBe(b);
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
      dm: "per-user",
      group: "per-user-in-group",
      thread: "per-thread",
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
      expect(id).toBe("dm:ch:u");
    });

    it("thread without threadId falls back to DM", () => {
      const msg: InboundMessage = { channelId: "ch", from: "u", text: "hi", chatType: "thread" };
      const id = resolveConversationId(msg);
      expect(id).toBe("dm:ch:u");
    });
  });
});
