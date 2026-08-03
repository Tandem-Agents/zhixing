import {
  dispatchAdvancementReviewResult,
  type AdvancementController,
  type AdvancementReviewDispatchDeps,
} from "@zhixing/owner-services";
import type {
  ConversationManager,
  TurnCommittedInfo,
} from "@zhixing/owner-kernel";
import type { SessionBroadcast } from "@zhixing/rpc";
import {
  createAdvancementEventSink,
  createAdvancementProxyTurnPort,
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
  const dispatchDeps: AdvancementReviewDispatchDeps = {
    events: createAdvancementEventSink(deps.sessionBroadcast),
    proxyTurns: () => {
      const manager = deps.conversations?.();
      return manager
        ? createAdvancementProxyTurnPort({
            manager,
            sessionBroadcast: deps.sessionBroadcast,
            conversationExists: deps.conversationExists,
          })
        : null;
    },
  };

  return (info) => {
    if (!deps.advancement) return;
    if (info.ephemeral) return;
    const previous = chains.get(info.conversationId) ?? Promise.resolve();
    const current = previous.then(() =>
      reviewAcceptedTurn(deps, dispatchDeps, info),
    );
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
  dispatchDeps: AdvancementReviewDispatchDeps,
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
    runId: info.turnId,
    runIndex: info.runIndex,
    runRecord: info.runRecord,
    runRecordRef: info.runRecordRef,
  });
  await dispatchAdvancementReviewResult(dispatchDeps, {
    conversationId: info.conversationId,
    runId: info.turnId,
    result,
  });
}
