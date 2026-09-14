import type {
  ConversationRunState, ControlEnvelope, ControlResult, IngressContext,
} from "../contracts/index.js";

const CHANNEL_STATUS_TEXT = {
  cancelled: "本次运行已取消。",
  failed: "本次运行失败。",
  expired: "本次请求未能开始执行，已过期。你可以重新发送。",
  uncertain: "本次运行结果不确定，需要你裁决处理方式。",
} as const satisfies Readonly<Partial<Record<ConversationRunState, string>>>;

/** Only channel-origin runs need a separate status message. Committed results have their own delivery. */
export function decideConversationStatusNotification(input: {
  readonly state: ConversationRunState;
  readonly reason?: string;
  readonly ingress: IngressContext;
}) {
  if (input.ingress.kind !== "channel") return undefined;
  const text = input.state === "failed" && input.reason
    ? `本次运行失败：${input.reason}。`
    : (CHANNEL_STATUS_TEXT as Readonly<Partial<Record<ConversationRunState, string>>>)[input.state];
  return text ? { text, target: input.ingress.replyTarget, ingressId: input.ingress.ingressId } : undefined;
}

export type ConversationControlResponse = "empty-cancel-batch";

/** Nonempty cancellation batches are acknowledged by their per-run cancelled notifications. */
export function decideConversationControlResponse(
  request: ControlEnvelope["body"],
  result: ControlResult,
) {
  if (request.t !== "cancel-batch" || request.response === undefined ||
    result.status !== "ok" || result.body.t !== "cancel-batch" || result.body.runs.length > 0) {
    return undefined;
  }
  return { replyTarget: request.response.replyTarget, response: "empty-cancel-batch" as const };
}

export function conversationControlResponseText(response: ConversationControlResponse): string {
  return ({ "empty-cancel-batch": "当前没有正在处理的任务。" } as const)[response];
}
