import type { ConversationUsageProjectionPort } from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";

/** Anchor Correctness adapter; Conversation owns query/error/result semantics. */
export function createAnchorConversationUsageProjectionPort(input: Readonly<{
  conversations: ConversationManager;
  exists(conversationId: string): Promise<boolean>;
}>): ConversationUsageProjectionPort {
  return Object.freeze({
    inspectContextBudgetExisting: async (conversationId: string) => {
      const result = await input.conversations.inspectContextBudgetExisting(
        conversationId,
        () => input.exists(conversationId),
      );
      if (result.status !== "done") return result;
      return Object.freeze({
        status: "done" as const,
        outcome: Object.freeze({
          budget: result.budget,
          turnCount: result.turnCount,
          calibrationFactor: result.calibrationFactor,
        }),
      });
    },
    inspectUsageExisting: async (conversationId: string) => {
      const result = await input.conversations.inspectUsageExisting(
        conversationId,
        () => input.exists(conversationId),
      );
      if (result.status !== "done") return result;
      return Object.freeze({
        status: "done" as const,
        outcome: Object.freeze({
          budget: result.budget,
          turnCount: result.turnCount,
          calibrationFactor: result.calibrationFactor,
          subUsages: result.subUsages,
        }),
      });
    },
  });
}
