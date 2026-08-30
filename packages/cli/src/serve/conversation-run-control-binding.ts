import { generateTurnId } from "@zhixing/core";
import type {
  ConversationRunControlPort,
  ConversationUncertainResolutionResult,
} from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel";

interface CancelledAdvancementLifecycle {
  settle(input: Readonly<{
    conversationId: string;
    ingressId: string;
  }>): Promise<void>;
  recover(conversationId: string): Promise<void>;
}

/** Anchor binding from Conversation run-control demands to Owner mechanisms. */
export function createAnchorConversationRunControlPort(input: Readonly<{
  conversations: ConversationManager;
  advancement?: CancelledAdvancementLifecycle;
}>): ConversationRunControlPort {
  const durable = input.conversations.usesDurableTurnProtocol();
  return Object.freeze({
    requiresStableCancellationIdentity: durable,
    requiresAuthoritativeRunIdentity: durable,
    emptyCancellationIsSuccess: false,
    createCancellationIdentity: () => `session.abort:${generateTurnId()}`,
    cancel: async ({
      conversationId,
      operationId,
      runId,
      caller,
      occurredAt,
    }) => {
      if (caller.kind !== "surface") {
        throw new Error(
          "Anchor Conversation cancellation requires an authenticated surface caller",
        );
      }
      if (!durable) {
        const result = input.conversations.abort(conversationId, {
          kind: "user-cancel",
          source: "rpc",
          pressedAt: occurredAt,
        });
        return Object.freeze({
          matchedDurableRuns: 0,
          abortedInFlight: result.abortedInFlight,
          cancelledPending: result.cancelledPending,
        });
      }
      const result = await input.conversations.cancelDurableRuns({
        conversationId,
        requestId: operationId,
        ...(runId ? { runId } : {}),
        reason: {
          kind: "user-cancel",
          source: "rpc",
          pressedAt: occurredAt,
        },
        principal: input.conversations.durableControlPrincipal({
          surfacePrincipal: caller.surfacePrincipal,
          connectionId: caller.connectionId,
        }),
      });
      const dependentLifecycleIngressId = result.dispositions.find(
        (item) => item.source === "advancement",
      )?.ingressId;
      return Object.freeze({
        matchedDurableRuns: result.dispositions.length,
        abortedInFlight: result.dispositions.some(
          (item) => item.abortedInFlight,
        ),
        cancelledPending: result.dispositions.reduce(
          (sum, item) => sum + item.cancelledPending,
          0,
        ),
        ...(dependentLifecycleIngressId
          ? { dependentLifecycleIngressId }
          : {}),
      });
    },
    ...(input.advancement
      ? {
          settleDependentCancellation: input.advancement.settle,
          recoverDependentCancellation: input.advancement.recover,
        }
      : {}),
    resolveUncertain: async ({
      conversationId,
      runId,
      operationId,
      ownerEpoch,
      openFactDigest,
      decision,
      caller,
    }): Promise<ConversationUncertainResolutionResult> => {
      if (caller.kind !== "surface") {
        throw new Error(
          "Anchor Conversation resolution requires an authenticated surface caller",
        );
      }
      return input.conversations.resolveDurableUncertain({
        conversationId,
        runId,
        requestId: operationId,
        ownerEpoch,
        openFactDigest,
        decision,
        principal: input.conversations.durableControlPrincipal({
          surfacePrincipal: caller.surfacePrincipal,
          connectionId: caller.connectionId,
        }),
      });
    },
  });
}
