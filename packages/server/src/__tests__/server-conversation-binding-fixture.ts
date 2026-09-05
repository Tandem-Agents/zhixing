import type { ConversationManager } from "@zhixing/owner-kernel";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";
import type { ServerConversationBinding } from "../context.js";

/** Test-only bridge for Server integration tests that exercise a real owner. */
export function bindTestConversationManager(
  manager: ConversationManager,
): ServerConversationBinding {
  return {
    usesDurableTurnProtocol: () => manager.usesDurableTurnProtocol(),
    has: (conversationId) => manager.has(conversationId),
    addObserver: (conversationId, connectionId, options) =>
      manager.addObserver(conversationId, connectionId, options),
    removeObserver: (conversationId, connectionId) =>
      manager.removeObserver(conversationId, connectionId),
    getObserverConnectionIds: (conversationId) =>
      manager.getObserverConnectionIds(conversationId),
    drainLifecycleDiagnostics: (conversationId) =>
      manager.drainLifecycleDiagnostics(conversationId),
    setBusy: (conversationId, busy) => manager.setBusy(conversationId, busy),
    findDurableInteractionOutcome: (conversationId, requestId) =>
      manager.findDurableInteractionOutcome(conversationId, requestId),
    executeTurn: async (input) => {
      const managed = manager.getSession(input.conversationId);
      if (!managed) {
        throw new Error(
          `Admitted Conversation runtime is missing: ${input.conversationId}`,
        );
      }
      await projectSessionTurn({
        manager,
        managed,
        input: input.userInput,
        turnId: input.turnId,
        runOptions: {
          abortSignal: input.abortSignal,
          turnContext: input.turnContext,
          surfacePrincipal: input.surfacePrincipal,
          turnIndex: managed.turnCount,
          source: "interactive",
        },
        notify: input.notify,
        abortSignal: input.abortSignal,
        onPostTurnControlIntent: input.onPostTurnControlIntent,
        ...(input.environment ? { environment: input.environment } : {}),
      });
    },
    list: () =>
      manager.list().map(({ conversationId, busy, pendingCount }) => ({
        conversationId,
        busy,
        pendingCount,
      })),
    durablePrincipal: (input) => manager.durableControlPrincipal(input),
    removeObserverFromAll: (connectionId) =>
      manager.removeObserverFromAll(connectionId),
    disposeAll: () => manager.disposeAll(),
  };
}
