import type {
  AdvancementOriginalTaskExecutionPort,
} from "@zhixing/core/advancement/application";
import type {
  ConversationDirectoryApplication,
} from "@zhixing/core/conversation/application";

/**
 * Anchor-owned cross-domain adapter. Advancement decides whether and when to
 * hand off; Conversation remains the only agent-turn admission application.
 */
export function createAnchorAdvancementOriginalTaskExecutionPort(
  conversations: ConversationDirectoryApplication,
): AdvancementOriginalTaskExecutionPort {
  return Object.freeze({
    async execute(input) {
      const caller = Object.freeze({
        kind: "surface" as const,
        surfacePrincipal: input.surface.caller.surfacePrincipal,
        connectionId: input.surface.caller.connectionId,
      });
      const turnIdentity = conversations.prepareAgentTurnIdentity({
        kind: "prepare-agent-turn-identity",
        turnId: input.originalTurnId,
        identitySource: "provided",
        caller,
      });
      const admitted = await conversations.admitAgentTurn({
        kind: "admit-agent-turn",
        conversationId: input.conversationId,
        input: input.originalUserTask,
        turnIdentity,
        caller,
        ...(input.surface.turnOrigin
          ? { turnOrigin: input.surface.turnOrigin }
          : {}),
        execution: {
          execute: ({ conversationId, turnId }) =>
            input.surface.execute({
              conversationId,
              turnId,
              originalUserTask: input.originalUserTask,
            }),
          cancelPending: (cancelled) =>
            input.surface.cancelPending(cancelled),
          ...(input.surface.onAdmitted
            ? {
                onAdmitted: (result) =>
                  input.surface.onAdmitted!(result),
              }
            : {}),
        },
      });
      return Object.freeze({
        conversationId: admitted.conversationId,
        turnId: admitted.turnId,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        runStatus:
          admitted.status === "replayed" ? "queued" : admitted.status,
      });
    },
  });
}
