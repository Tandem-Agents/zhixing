import {
  AdvancementOriginalTaskAdmissionError,
  type AdvancementConfirmedOriginalTaskAdmissionPort,
  type AdvancementOriginalTaskExecutionPort,
} from "@zhixing/core/advancement/application";
import {
  ConversationApplicationError,
  type ConversationDirectoryApplication,
} from "@zhixing/core/conversation/application";
import { DurableConversationAdmissionRejectedError } from "@zhixing/owner-kernel/run-turn";

/**
 * Anchor-owned cross-domain adapter. Advancement decides whether and when to
 * hand off; Conversation remains the only agent-turn admission application.
 */
export function createAnchorAdvancementOriginalTaskExecutionPort(
  conversations: ConversationDirectoryApplication,
): AdvancementOriginalTaskExecutionPort {
  return Object.freeze({
    async execute(
      input: Parameters<AdvancementOriginalTaskExecutionPort["execute"]>[0],
    ) {
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

/**
 * Confirmation-specific adapter. The committed Advancement intent supplies the
 * stable durable identity; Conversation remains the only admission owner.
 */
export function createAnchorAdvancementConfirmedOriginalTaskAdmissionPort(
  conversations: ConversationDirectoryApplication,
): AdvancementConfirmedOriginalTaskAdmissionPort {
  return Object.freeze({
    async admit(
      input: Parameters<
        AdvancementConfirmedOriginalTaskAdmissionPort["admit"]
      >[0],
    ) {
      const caller = Object.freeze({
        kind: "surface" as const,
        surfacePrincipal: input.admissionIntent.surfacePrincipal,
        connectionId: input.surface.caller.connectionId,
      });
      try {
        const turnIdentity = conversations.prepareAgentTurnIdentity({
          kind: "prepare-agent-turn-identity",
          turnId: input.admissionIntent.turnId,
          identitySource: "provided",
          caller,
        });
        const admitted = await conversations.admitAgentTurn({
          kind: "admit-agent-turn",
          conversationId: input.conversationId,
          input: input.originalUserTask,
          turnIdentity,
          caller,
          turnOrigin: input.admissionIntent.turnOrigin,
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
              ? { onAdmitted: input.surface.onAdmitted }
              : {}),
          },
        });
        return Object.freeze({
          conversationId: admitted.conversationId,
          turnId: admitted.turnId,
          ...(admitted.runId ? { runId: admitted.runId } : {}),
          status: admitted.status,
        });
      } catch (error) {
        if (error instanceof DurableConversationAdmissionRejectedError) {
          throw new AdvancementOriginalTaskAdmissionError(error.code, error);
        }
        if (error instanceof ConversationApplicationError) {
          const reason =
            error.reason === "turn-conversation-not-found"
              ? "conversation-not-found"
              : error.reason === "turn-queue-full"
                ? "queue-full"
                : error.reason === "turn-lifecycle-busy"
                  ? "lifecycle-busy"
                  : error.reason === "turn-identity-invalid" ||
                      error.reason === "turn-identity-required"
                    ? "turn-identity-invalid"
                    : undefined;
          if (reason) {
            throw new AdvancementOriginalTaskAdmissionError(reason, error);
          }
        }
        throw error;
      }
    },
  });
}
