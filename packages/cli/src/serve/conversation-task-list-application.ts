import { createHash } from "node:crypto";
import type { SessionStatePort, TaskListState } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import type {
  ConversationTaskListMutationDecision,
  ConversationTaskListPort,
} from "@zhixing/core/conversation/application";
import {
  ConversationApplicationError,
  ConversationTaskListToolApplicationService,
  type ConversationTaskListToolApplication,
  type TaskListService,
} from "@zhixing/core/conversation/application";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";

/**
 * Anchor Correctness adapter for the agent-facing replacement command. The
 * Conversation application owns identity derivation and replacement semantics;
 * this edge only maps its finite staged-write demand to the active assignment.
 */
export function createAnchorConversationTaskListToolApplication(): ConversationTaskListToolApplication {
  return new ConversationTaskListToolApplicationService({
    async stage(input) {
      const assignment = runContextStorage.getStore()?.assignmentMutations;
      if (!assignment) {
        throw new ConversationApplicationError(
          "invalid-input",
          "Task list updates require an active durable turn.",
          "task-list-assignment-required",
        );
      }
      await assignment.stage({
        domain: "session",
        mutation: {
          kind: "task-list-op",
          op: { op: "set", state: input.taskList },
        },
        operationId: input.operationId,
      });
    },
  });
}

/** Anchor Correctness adapter; Conversation owns every task-list decision. */
export function createAnchorConversationTaskListPort(input: Readonly<{
  conversations: ConversationManager;
  exists(conversationId: string): Promise<boolean>;
  taskLists: TaskListService;
  sessionState: Pick<SessionStatePort, "readTaskList" | "mutate">;
  readMutationBase(conversationId: string, requestId: string): Promise<TaskListState | undefined>;
}>): ConversationTaskListPort {
  const context = (requestId: string) => ({
    principal: { kind: "host" as const, component: "conversation-task-list" }, requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  });
  return Object.freeze({
    requiresStableOperationIdentity: true,
    createOperationIdentity: () => { throw new Error("Task-list command requires a stable operation identity"); },
    createTaskIdentity: ({ operationId, content }: Parameters<ConversationTaskListPort["createTaskIdentity"]>[0]) =>
      createHash("sha256").update(canonicalize({ requestId: operationId, content })).digest("hex").slice(0, 32),
    read: async (conversationId: string) => {
      const state = await input.sessionState.readTaskList(conversationId, context(`task-list-read:${conversationId}`));
      input.taskLists.acceptCommitted(conversationId, state);
      return state;
    },
    maintain: async (
      request: Parameters<ConversationTaskListPort["maintain"]>[0],
    ) => {
      const outcome = await input.conversations.runMaintenanceExisting(
        request.conversationId,
        () => input.exists(request.conversationId),
        async () => {
          const current = await input.sessionState.readTaskList(request.conversationId, context(`read:${request.operationId}`));
          const base = await input.readMutationBase(request.conversationId, request.operationId);
          const decision = request.decide(base ?? current);
          // A no-effect decision also needs a receipt: a late retry must not act on a new list.
          await input.sessionState.mutate(request.conversationId,
            { kind: "task-list-op", op: { op: "set", state: hasTaskListWrite(decision) ? decision.next : base ?? current } }, context(request.operationId));
          const taskList = await input.sessionState.readTaskList(request.conversationId, context(`committed:${request.operationId}`));
          input.taskLists.acceptCommitted(request.conversationId, taskList);
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
