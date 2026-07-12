import type { ConversationManager } from "@zhixing/owner-kernel";
import {
  dispatchAdvancementReviewResult as dispatchOwnerAdvancementReviewResult,
  type AdvancementReviewDispatchInput,
} from "@zhixing/owner-services/advancement/review-dispatch";
import type { SessionBroadcast } from "@zhixing/rpc/session-broadcast";
import {
  createAdvancementEventSink,
  createAdvancementProxyTurnPort,
} from "./adapters.js";

export interface AdvancementReviewDispatchDeps {
  readonly sessionBroadcast: () => SessionBroadcast | null;
  readonly conversations?: () => ConversationManager | null;
  readonly conversationExists?: (conversationId: string) => Promise<boolean>;
}

export async function dispatchAdvancementReviewResult(
  deps: AdvancementReviewDispatchDeps,
  input: AdvancementReviewDispatchInput,
): Promise<void> {
  const broadcast = deps.sessionBroadcast();
  return dispatchOwnerAdvancementReviewResult(
    {
      events: broadcast
        ? createAdvancementEventSink(() => broadcast)
        : undefined,
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
    },
    input,
  );
}

export type { AdvancementReviewDispatchInput };
