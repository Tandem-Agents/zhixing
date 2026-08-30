import type { ConversationCompactPort } from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";

/** Anchor Correctness adapter; Conversation owns compact admission and result semantics. */
export function createAnchorConversationCompactPort(input: Readonly<{
  conversations: ConversationManager;
  exists(conversationId: string): Promise<boolean>;
}>): ConversationCompactPort {
  return Object.freeze({
    compactExisting: async (conversationId: string) => {
      const result = await input.conversations.compactExisting(
        conversationId,
        () => input.exists(conversationId),
      );
      if (result.status !== "done") return result;
      const windowCompact = result.outcome.windowCompact;
      return Object.freeze({
        status: "done" as const,
        outcome: Object.freeze({
          runtimeModified: result.outcome.modified,
          windowApplied: windowCompact !== undefined,
          ...(windowCompact
            ? {
                tokensBefore: windowCompact.tokensBefore,
                tokensAfter: windowCompact.tokensAfter,
              }
            : {}),
          ...(result.outcome.emergencyFloor
            ? {
                emergencyFloor: Object.freeze({
                  droppedTurns: result.outcome.emergencyFloor.droppedTurns,
                  error: result.outcome.emergencyFloor.error,
                }),
              }
            : {}),
        }),
      });
    },
  });
}
