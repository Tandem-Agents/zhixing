import type {
  ServerConfirmationBinding,
  ServerConversationBinding,
} from "@zhixing/server";
import type {
  ConfirmationHub,
  ConversationManager,
} from "@zhixing/owner-kernel";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";

/** Adapts the Conversation owner without exposing ManagedSession or owner internals. */
export function createServerConversationBinding(
  manager: ConversationManager,
): ServerConversationBinding {
  const binding: ServerConversationBinding = {
    usesDurableTurnProtocol: () => manager.usesDurableTurnProtocol(),
    has: (conversationId) => manager.has(conversationId),
    addObserver: (conversationId, connectionId, options) =>
      manager.addObserver(conversationId, connectionId, options),
    removeObserver: (conversationId, connectionId) =>
      manager.removeObserver(conversationId, connectionId),
    getObserverConnectionIds: (conversationId) =>
      new Set(manager.getObserverConnectionIds(conversationId)),
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
      manager.list().map(({ conversationId, busy, pendingCount }) =>
        Object.freeze({ conversationId, busy, pendingCount }),
      ),
    durablePrincipal: (input) =>
      Object.freeze(manager.durableControlPrincipal(input)),
    removeObserverFromAll: (connectionId) =>
      manager.removeObserverFromAll(connectionId),
    disposeAll: () => manager.disposeAll(),
  };
  return Object.freeze(binding);
}

/** Adapts Confirmation ownership without exposing the hub implementation. */
export function createServerConfirmationBinding(
  hub: ConfirmationHub,
): ServerConfirmationBinding {
  const project = (
    entry: ReturnType<ConfirmationHub["findEntry"]>,
  ): ReturnType<ServerConfirmationBinding["findPending"]> =>
    entry
      ? Object.freeze({
          request: entry.request,
          ...(entry.conversationId
            ? { conversationId: entry.conversationId }
            : {}),
        })
      : undefined;
  const binding: ServerConfirmationBinding = {
    listPending: () =>
      Object.freeze(hub.listAllPending().map((entry) => project(entry)!)),
    findPending: (requestId) => project(hub.findEntry(requestId)),
    resolve: (requestId, decision) => hub.resolveDurably(requestId, decision),
  };
  return Object.freeze(binding);
}
