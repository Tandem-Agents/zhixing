import { generateTurnId } from "@zhixing/core";
import {
  projectConversationDelete,
  type ConversationDeleteCommitPort,
  type ConversationDeletedFact,
  type ConversationDeleteProjectionPort,
  type ConversationCommandCaller,
} from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel";

interface AnchorConversationDeleteStorage {
  exists(conversationId: string): Promise<boolean>;
  deleteStoredConversation(conversationId: string): Promise<boolean>;
}

interface AnchorConversationDeleteRelatedProjection {
  cancelDependentLifecycle?(conversationId: string): Promise<void>;
  removeDependentData?(conversationId: string): Promise<void>;
}

export function createAnchorConversationDeleteProjectionPort(input: Readonly<{
  conversations: ConversationManager;
  storage: AnchorConversationDeleteStorage;
  related?: AnchorConversationDeleteRelatedProjection;
}>): ConversationDeleteProjectionPort {
  const related = input.related;
  return {
    deleteRuntimeAndStorage: async ({
      conversationId,
      deletionAlreadyCommitted,
      onDeleted,
    }) => {
      const hadRuntime = input.conversations.has(conversationId);
      let removedStoredConversation = false;
      const outcome = await input.conversations.delete(conversationId, {
        removeDisk: async () => {
          removedStoredConversation =
            await input.storage.deleteStoredConversation(conversationId);
          return deletionAlreadyCommitted || removedStoredConversation;
        },
        onDeleted: () => {
          if (
            !deletionAlreadyCommitted ||
            hadRuntime ||
            removedStoredConversation
          ) {
            onDeleted();
          }
        },
      });
      if (outcome === "busy") return "busy";
      return outcome ? "deleted" : "not-found";
    },
    ...(related?.cancelDependentLifecycle
      ? {
          cancelDependentLifecycle: (conversationId: string) =>
            related.cancelDependentLifecycle!(conversationId),
        }
      : {}),
    ...(related?.removeDependentData
      ? {
          removeDependentData: (conversationId: string) =>
            related.removeDependentData!(conversationId),
        }
      : {}),
  };
}

export function createAnchorConversationDeleteCommitPort(input: Readonly<{
  conversations: ConversationManager;
  storage: AnchorConversationDeleteStorage;
  related?: AnchorConversationDeleteRelatedProjection;
  publishFact?: (fact: ConversationDeletedFact) => void;
}>): ConversationDeleteCommitPort {
  const projection = createAnchorConversationDeleteProjectionPort({
    conversations: input.conversations,
    storage: input.storage,
    ...(input.related ? { related: input.related } : {}),
  });
  return {
    requiresStableOperationIdentity:
      input.conversations.usesDurableTurnProtocol(),
    createOperationIdentity: () => `session.delete:${generateTurnId()}`,
    commit: async ({ conversationId, operationId, caller }) => {
      let durableCaller: Extract<
        ConversationCommandCaller,
        Readonly<{ kind: "surface" }>
      > | null = null;
      if (input.conversations.usesDurableTurnProtocol()) {
        if (caller.kind !== "surface") {
          throw new Error(
            "Durable Conversation delete requires an authenticated surface caller",
          );
        }
        durableCaller = caller;
      }
      if (durableCaller) {
        const write = await input.conversations.writeDurableSession({
          conversationId,
          requestId: operationId,
          mutation: { kind: "conversation-delete" },
          principal: input.conversations.durableControlPrincipal({
            surfacePrincipal: durableCaller.surfacePrincipal,
            connectionId: durableCaller.connectionId,
          }),
          conversationExists: async () =>
            input.conversations.has(conversationId) ||
            (await input.storage.exists(conversationId)),
        });
        if (write.status === "busy") {
          return { status: "busy", reason: "pending-lifecycle" } as const;
        }
        if (write.status === "not-found") return write;
        await input.conversations.projectDurableSession({
          conversationId,
          requestId: operationId,
          mutation: "delete",
          domainRevision: write.domainRevision,
        });
        return { status: "deleted" } as const;
      }

      await projectConversationDelete({
        conversationId,
        operationId,
        deletionAlreadyCommitted: false,
        dependentFailure: "best-effort",
        projection,
        ...(input.publishFact ? { publishFact: input.publishFact } : {}),
        onDependentFailure: (step, error) => {
          if (step === "cancel-lifecycle") {
            console.error("[session.delete] advancement cleanup failed:", error);
          } else {
            console.error(
              "[session.delete] advancement data removal failed:",
              error,
            );
          }
        },
      });
      return { status: "deleted" } as const;
    },
  };
}
