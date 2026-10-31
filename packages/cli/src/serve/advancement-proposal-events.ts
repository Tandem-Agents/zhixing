import type { AdvancementProposalFact } from "@zhixing/core/advancement";
import type { AdvancementPresentationEvent } from "@zhixing/owner-services/advancement";

/**
 * 提议阶段的结果沿现有推进事件出口推送：草案就绪为 contract_draft（发起端据此拉起确认面），
 * 起草失败或结果不明为 proposal_draft_failed；断线重连按会话读取当前状态。
 */
export function advancementProposalEvent(fact: AdvancementProposalFact): AdvancementPresentationEvent {
  return fact.kind === "advancement-proposal-drafted"
    ? {
        conversationId: fact.conversationId, runId: fact.originalTurnId, seq: 0, event: "advancement:contract_draft",
        payload: { advancementSessionId: fact.advancementSessionId, rubricDraftId: fact.rubricDraft.draftId, rubricDraft: fact.rubricDraft },
      }
    : {
        conversationId: fact.conversationId, runId: fact.originalTurnId, seq: 0, event: "advancement:proposal_draft_failed",
        payload: { advancementSessionId: fact.advancementSessionId, outcome: fact.outcome, message: fact.message },
      };
}
