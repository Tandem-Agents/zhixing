import { generateTurnId } from "@zhixing/core";
import type { ConversationAgentTurnAdmissionPort } from "@zhixing/core/conversation/application";
import {
  ConversationManager,
  WorksceneBusyError,
} from "./conversation-manager.js";

/**
 * Owner/Authority Correctness adapter for the Conversation agent-turn command.
 * Manager sessions, queue tasks and durable-journal callbacks never cross the
 * domain boundary.
 */
export function createConversationAgentTurnAdmissionPort(input: Readonly<{
  manager: ConversationManager;
}>): ConversationAgentTurnAdmissionPort {
  return Object.freeze({
    requiresStableTurnIdentity: input.manager.usesDurableTurnProtocol(),
    createTurnIdentity: generateTurnId,
    async admit(
      request: Parameters<ConversationAgentTurnAdmissionPort["admit"]>[0],
    ) {
      const identity = request.identity;
      let admitted: Awaited<ReturnType<ConversationManager["admitTurn"]>>;
      try {
        admitted = await input.manager.admitTurn({
          ...(identity.kind === "existing"
            ? {
                conversationId: identity.conversationId,
                exists: identity.exists,
              }
            : { createConversation: identity.create }),
          connectionId: request.caller.connectionId,
          source: "interactive",
          beforeEnqueue: (managed) =>
            input.manager.admitDurableTurn({
              conversationId: managed.conversationId,
              input: request.input,
              invocation: { kind: "agent", source: "interactive" },
              ...(request.environment
                ? { environment: structuredClone(request.environment) }
                : {}),
              options: {
                turnContext: {
                  turnId: request.turnId,
                  ...(request.turnOrigin
                    ? { turnOrigin: structuredClone(request.turnOrigin) }
                    : {}),
                },
                source: "interactive",
                surfacePrincipal: request.caller.surfacePrincipal,
              },
              surfacePrincipal: request.caller.surfacePrincipal,
            }),
          makeTask: (managed) => ({
            source: "interactive",
            execute: () =>
              request.execution.execute({
                conversationId: managed.conversationId,
                turnId: request.turnId,
              }),
            cancel: () =>
              request.execution.cancelPending({
                conversationId: managed.conversationId,
                turnId: request.turnId,
              }),
          }),
        });
      } catch (error) {
        if (
          error instanceof WorksceneBusyError ||
          (error instanceof Error &&
            "code" in error &&
            (error as Error & { code?: unknown }).code === "WORKSCENE_BUSY")
        ) {
          return {
            status: "lifecycle-busy" as const,
            conversationId:
              identity.kind === "existing"
                ? identity.conversationId
                : "conversation-pending",
          };
        }
        throw error;
      }
      switch (admitted.status) {
        case "not-found":
        case "full":
          return {
            status: admitted.status,
            conversationId: admitted.conversationId,
          };
        case "replayed":
        case "queued":
          return {
            status: admitted.status,
            conversationId: admitted.conversationId,
            ...(admitted.runId ? { runId: admitted.runId } : {}),
          };
        case "immediate":
          return {
            status: "immediate" as const,
            conversationId: admitted.conversationId,
            ...(admitted.runId ? { runId: admitted.runId } : {}),
            start: admitted.task.execute,
          };
      }
    },
  });
}
