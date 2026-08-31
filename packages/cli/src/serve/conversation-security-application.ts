import type { ConversationSecurityProjectionPort } from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";

/** Anchor Correctness adapter; Conversation owns query/error/result semantics. */
export function createAnchorConversationSecurityProjectionPort(input: Readonly<{
  conversations: ConversationManager;
  exists(conversationId: string): Promise<boolean>;
}>): ConversationSecurityProjectionPort {
  return Object.freeze({
    inspectSecurityExisting: async (conversationId: string) =>
      input.conversations.inspectSecurityExisting(
        conversationId,
        () => input.exists(conversationId),
      ),
  });
}
