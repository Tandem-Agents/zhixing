import { generateTurnId } from "@zhixing/core";
import {
  projectConversationClear,
  type ConversationClearCommitPort,
  type ConversationClearedFact,
} from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel";

/** Anchor Correctness binding for the Conversation-owned clear command. */
export function createAnchorConversationClearCommitPort(input: Readonly<{
  conversations: ConversationManager;
  directory: Readonly<{
    exists(conversationId: string): Promise<boolean>;
    clearStoredView(conversationId: string): Promise<boolean>;
  }>;
  publishFact?: (fact: ConversationClearedFact) => void | Promise<void>;
}>): ConversationClearCommitPort {
  return {
    requiresStableOperationIdentity:
      input.conversations.usesDurableTurnProtocol(),
    createOperationIdentity: () => `session.clear:${generateTurnId()}`,
    commit: async ({ conversationId, operationId, caller }) => {
      if (input.conversations.usesDurableTurnProtocol()) {
        if (caller.kind !== "surface") {
          throw new Error(
            "Durable Conversation clear requires an authenticated surface caller",
          );
        }
        const write = await input.conversations.writeDurableSession({
          conversationId,
          requestId: operationId,
          mutation: { kind: "window-op", op: "clear" },
          principal: input.conversations.durableControlPrincipal({
            surfacePrincipal: caller.surfacePrincipal,
            connectionId: caller.connectionId,
          }),
          conversationExists: async () =>
            input.conversations.has(conversationId) ||
            (await input.directory.exists(conversationId)),
        });
        if (write.status === "busy") {
          return { status: "busy", reason: "pending-lifecycle" } as const;
        }
        if (write.status === "not-found") return write;
        await input.conversations.projectDurableSession({
          conversationId,
          requestId: operationId,
          mutation: "clear",
          domainRevision: write.domainRevision,
        });
        return { status: "cleared" } as const;
      }

      await projectConversationClear({
        conversationId,
        operationId,
        projection: {
          clearStoredView: (id) => input.directory.clearStoredView(id),
          clearRuntimeView: (id, persist) =>
            input.conversations.clear(id, persist),
        },
        ...(input.publishFact ? { publishFact: input.publishFact } : {}),
      });
      return { status: "cleared" } as const;
    },
  };
}
