import { describe, expect, it } from "vitest";
import type { ControlEnvelope, ControlResult, IngressContext, ConversationRunState } from "../../contracts/index.js";
import { decideConversationStatusNotification, decideConversationControlResponse, conversationControlResponseText } from "../notifications.js";

const ingress: IngressContext = {
  kind: "channel", ingressId: "in-1", surfacePrincipal: "surface:user-1",
  responder: { channelId: "feishu", platformSubject: "user-1", tenant: "tenant-1" },
  deviceId: "device-1", receivedAt: "2026-09-14T00:00:00.000Z",
  replyTarget: { channelId: "feishu", to: "chat-1" },
};

describe("Conversation notification decisions", () => {
  it("owns status selection, failure detail and the channel-only boundary", () => {
    const expected = {
      cancelled: "本次运行已取消。",
      failed: "本次运行失败。",
      expired: "本次请求未能开始执行，已过期。你可以重新发送。",
      uncertain: "本次运行结果不确定，需要你裁决处理方式。",
    };
    const states: ConversationRunState[] = ["queued", "dispatched", "running", "cancel-requested", "committed", "cancelled", "failed", "expired", "uncertain"];
    for (const state of states) {
      const text = (expected as Partial<Record<ConversationRunState, string>>)[state];
      expect(decideConversationStatusNotification({ state, ingress })).toEqual(text ? {
        text, target: ingress.replyTarget, ingressId: "in-1",
      } : undefined);
      expect(decideConversationStatusNotification({ state, ingress: {
        kind: "first-party", surfacePrincipal: ingress.surfacePrincipal,
        deviceId: ingress.deviceId, ingressId: ingress.ingressId, receivedAt: ingress.receivedAt,
      } })).toBeUndefined();
    }
    expect(decideConversationStatusNotification({ state: "failed", reason: "模型不可用", ingress })?.text).toBe("本次运行失败：模型不可用。");
  });

  it("acknowledges only a successful empty cancel batch with an explicit response target", () => {
    const request = { t: "cancel-batch", response: { replyTarget: ingress.replyTarget } } as ControlEnvelope["body"];
    const ok = { status: "ok", body: { t: "cancel-batch", runs: [] } } as ControlResult;
    expect(decideConversationControlResponse(request, ok)).toEqual({
      replyTarget: ingress.replyTarget, response: "empty-cancel-batch",
    });
    expect(conversationControlResponseText("empty-cancel-batch")).toBe("当前没有正在处理的任务。");
    for (const result of [
      { status: "rejected" }, { status: "ok", body: { t: "cancel-batch", runs: ["run-1"] } },
      { status: "ok", body: { t: "other" } },
    ]) expect(decideConversationControlResponse(request, result as ControlResult)).toBeUndefined();
    expect(decideConversationControlResponse({ t: "cancel-batch" } as ControlEnvelope["body"], ok)).toBeUndefined();
  });
});
