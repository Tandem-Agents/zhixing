import type { ConversationStatusNotice, FinalFrame, StreamFrame } from "@zhixing/core/contracts";
import type { SessionDeltaPayload } from "@zhixing/rpc";
import type { SessionProcessProjection } from "@zhixing/rpc/session-wire";

export interface ConversationOutputIdentity {
  readonly conversationId: string;
  readonly turnId?: string;
  readonly runId?: string;
}

/** 保留实际来源；没有 turnId 的耐久通知只携 runId，不能替造 turn 身份。 */
export type ConversationOutputSource = ConversationOutputIdentity & (
  | { readonly kind: "delta"; readonly notification: SessionDeltaPayload }
  | { readonly kind: "stream"; readonly frame: StreamFrame }
  | { readonly kind: "process"; readonly projection: SessionProcessProjection }
  | { readonly kind: "status"; readonly notice: ConversationStatusNotice }
  | { readonly kind: "history"; readonly final: FinalFrame }
);

export function sameConversationOutput(left: ConversationOutputIdentity, right: ConversationOutputIdentity): boolean {
  if (left.conversationId !== right.conversationId) return false;
  if (left.runId && right.runId) return left.runId === right.runId;
  if (left.turnId && right.turnId) return left.turnId === right.turnId;
  return !left.runId && !right.runId && !left.turnId && !right.turnId;
}
