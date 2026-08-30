import { randomUUID } from "node:crypto";
import type {
  ConversationTaskListMutationDecision,
  ConversationTaskListPort,
} from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import type { TaskListService } from "@zhixing/tools-builtin";

/** Anchor Correctness adapter; Conversation owns every task-list decision. */
export function createAnchorConversationTaskListPort(input: Readonly<{
  conversations: ConversationManager;
  exists(conversationId: string): Promise<boolean>;
  taskLists: TaskListService;
}>): ConversationTaskListPort {
  return Object.freeze({
    requiresStableOperationIdentity: false,
    createOperationIdentity: () => `task-list:${randomUUID()}`,
    createTaskIdentity: () => randomUUID(),
    read: async (conversationId: string) => {
      await input.taskLists.prime(conversationId);
      return input.taskLists.getCached(conversationId);
    },
    maintain: async (
      request: Parameters<ConversationTaskListPort["maintain"]>[0],
    ) => {
      const outcome = await input.conversations.runMaintenanceExisting(
        request.conversationId,
        () => input.exists(request.conversationId),
        async () => {
          await input.taskLists.prime(request.conversationId);
          const current = input.taskLists.getCached(request.conversationId) ?? {
            items: [],
          };
          const decision = request.decide(current);
          const taskList = hasTaskListWrite(decision)
            ? await input.taskLists.set(
                request.conversationId,
                decision.next.items,
              )
            : current;
          return Object.freeze({ decision, taskList });
        },
      );
      if (outcome.status !== "done") return outcome;
      return Object.freeze({ status: "done" as const, ...outcome.value });
    },
  });
}

function hasTaskListWrite(
  decision: ConversationTaskListMutationDecision,
): decision is Extract<
  ConversationTaskListMutationDecision,
  { readonly next: unknown }
> {
  return "next" in decision;
}
