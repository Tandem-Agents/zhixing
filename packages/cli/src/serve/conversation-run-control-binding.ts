import { generateTurnId } from "@zhixing/core";
import {
  ConversationCancellationResponseEffect,
  type ConversationRunControlPort,
  type ConversationUncertainResolutionResult,
} from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel";
import { parseConversationResolutionFence } from "@zhixing/owner-kernel/conversation-control";

type ConversationCancellationInput = Parameters<
  ConversationRunControlPort["cancel"]
>[0];
type ConversationUncertainResolutionInput = Parameters<
  ConversationRunControlPort["resolveUncertain"]
>[0];

interface CancelledAdvancementLifecycle {
  settle(input: Readonly<{
    conversationId: string;
    ingressId: string;
  }>): Promise<void>;
  recover(conversationId: string): Promise<void>;
}

type ChannelCancellationReplyTarget = Readonly<{
  channelId: string;
  to: string;
  threadId?: string;
}>;

class ChannelCancellationResponseEffect extends ConversationCancellationResponseEffect {
  readonly #replyTarget: ChannelCancellationReplyTarget;

  constructor(replyTarget: ChannelCancellationReplyTarget) {
    super();
    this.#replyTarget = Object.freeze({
      channelId: replyTarget.channelId,
      to: replyTarget.to,
      ...(replyTarget.threadId !== undefined
        ? { threadId: replyTarget.threadId }
        : {}),
    });
    Object.freeze(this);
  }

  authorityResponse(): Readonly<{ replyTarget: ChannelCancellationReplyTarget }> {
    return Object.freeze({ replyTarget: this.#replyTarget });
  }
}

/** Creates the finite Channel effect consumed only by the Anchor Correctness adapter. */
export function createChannelCancellationResponseEffect(
  replyTarget: ChannelCancellationReplyTarget,
): ConversationCancellationResponseEffect {
  return new ChannelCancellationResponseEffect(replyTarget);
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
    cancel: async (request: ConversationCancellationInput) => {
      const { conversationId, operationId, runId, caller, occurredAt } =
        request;
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
        ...(request.response
          ? { response: requireChannelCancellationResponse(request.response) }
          : {}),
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
        ...(request.response ? { authoritativeResponse: true } : {}),
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
    resolveUncertain: async (
      request: ConversationUncertainResolutionInput,
    ): Promise<ConversationUncertainResolutionResult> => {
      const {
        conversationId,
        runId,
        operationId,
        resolutionFence,
        openFactDigest,
        decision,
        caller,
      } = request;
      if (caller.kind !== "surface") {
        throw new Error(
          "Anchor Conversation resolution requires an authenticated surface caller",
        );
      }
      return input.conversations.resolveDurableUncertain({
        conversationId,
        runId,
        requestId: operationId,
        ownerEpoch: parseConversationResolutionFence(resolutionFence),
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

function requireChannelCancellationResponse(
  effect: ConversationCancellationResponseEffect,
): Readonly<{ replyTarget: ChannelCancellationReplyTarget }> {
  if (!(effect instanceof ChannelCancellationResponseEffect)) {
    throw new Error("Conversation cancellation response effect is not owned by the Channel binding");
  }
  return effect.authorityResponse();
}
