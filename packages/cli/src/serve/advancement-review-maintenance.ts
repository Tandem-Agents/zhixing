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
  /**
   * 补审 catch-up 入口（恢复设施的单会话恢复）。turn 提交是三个补审
   * 触发点之一：先补齐当轮之前的欠账（deferred 挂起 / 崩溃漏审），
   * 再验收当轮，保证 review 序列时序完整。
   */
  readonly recoverConversation?: (
    conversationId: string,
    options?: { readonly beforeRunIndex?: number },
  ) => Promise<unknown>;
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
  try {
    await deps.recoverConversation?.(info.conversationId, {
      beforeRunIndex: info.runIndex,
    });
  } catch {
    // catch-up 失败不阻断当轮验收；欠账等下一个补审触发点。
  }
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
