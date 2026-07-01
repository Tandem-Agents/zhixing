import {
  dispatchAdvancementReviewResult,
  type AdvancementController,
  type ConversationManager,
  type SessionBroadcast,
  type TurnCommittedInfo,
} from "@zhixing/server";

export interface AdvancementReviewMaintenanceDeps {
  readonly advancement?: AdvancementController;
  readonly sessionBroadcast: () => SessionBroadcast | null;
  readonly conversations?: () => ConversationManager | null;
  readonly conversationExists?: (conversationId: string) => Promise<boolean>;
}

export function createAdvancementReviewMaintenance(
  deps: AdvancementReviewMaintenanceDeps,
): (info: TurnCommittedInfo) => void {
  const chains = new Map<string, Promise<void>>();

  return (info) => {
    if (!deps.advancement) return;
    if (info.ephemeral) return;
    const previous = chains.get(info.conversationId) ?? Promise.resolve();
    const current = previous.then(() => reviewAcceptedTurn(deps, info));
    const tail = current.catch(() => {});
    chains.set(info.conversationId, tail);
    void tail.finally(() => {
      if (chains.get(info.conversationId) === tail) {
        chains.delete(info.conversationId);
      }
    });
  };
}

async function reviewAcceptedTurn(
  deps: AdvancementReviewMaintenanceDeps,
  info: TurnCommittedInfo,
): Promise<void> {
  const advancement = deps.advancement;
  if (!advancement) return;
  const result = await advancement.afterTurnCommitted({
    conversationId: info.conversationId,
    runIndex: info.runIndex,
    runRecord: info.runRecord,
    runRecordRef: info.runRecordRef,
  });
  await dispatchAdvancementReviewResult({
    sessionBroadcast: deps.sessionBroadcast,
    conversations: deps.conversations,
    conversationExists: deps.conversationExists,
  }, {
    conversationId: info.conversationId,
    runId: info.turnId,
    result,
  });
}
