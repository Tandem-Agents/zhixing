import { userTurnInputFromText, type TurnContext } from "@zhixing/core";
import {
  CONVERSATION_ABORT_COMMAND,
  CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
  CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
  ConversationApplicationError,
  type ConversationAgentTurnExecutionPort,
  type ConversationPreparedAgentTurnIdentity,
} from "@zhixing/core/conversation/application";
import { protocolDigest } from "@zhixing/core/protocol";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
import {
  channelSurfacePrincipal,
  type ConversationManager,
} from "@zhixing/owner-kernel";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";
import type {
  InboundConversationApplicationPort,
  InboundConversationTurnOutcome,
} from "@zhixing/server";
import { createChannelCancellationResponseEffect } from "./conversation-run-control-binding.js";

type ProductApiWaiter = Readonly<{
  resolve(productApi: ProductApiDispatcher): void;
  reject(error: Error): void;
}>;

/**
 * Host composition binding from the Channel Surface to the one sealed Product
 * API dispatcher and the finite Owner execution mechanism.
 */
export class ChannelConversationProductBinding
  implements InboundConversationApplicationPort
{
  readonly #manager: ConversationManager;
  readonly #delivery: "authoritative" | "surface";
  readonly #waiters = new Set<ProductApiWaiter>();
  #productApi: ProductApiDispatcher | undefined;
  #closed = false;

  constructor(manager: ConversationManager) {
    this.#manager = manager;
    this.#delivery = manager.usesDurableTurnProtocol()
      ? "authoritative"
      : "surface";
  }

  bind(productApi: ProductApiDispatcher): void {
    if (this.#closed) {
      throw new Error("Channel Conversation Product API binding is closed");
    }
    if (this.#productApi) {
      throw new Error("Channel Conversation Product API is already bound");
    }
    for (const descriptor of [
      CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
      CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
      CONVERSATION_ABORT_COMMAND,
    ]) {
      if (!productApi.supports(descriptor)) {
        throw new Error(
          `Channel Conversation Product API contribution is missing: ${descriptor.identity}`,
        );
      }
    }
    this.#productApi = productApi;
    for (const waiter of this.#waiters) waiter.resolve(productApi);
    this.#waiters.clear();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Channel Conversation Product API binding is closed");
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  async prepareAgentTurn(input: Readonly<{
    channelId: string;
    platformSubject: string;
    messageId?: string;
  }>): Promise<ConversationPreparedAgentTurnIdentity> {
    const productApi = await this.#requireProductApi();
    const dispatch = await productApi.command(
      CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND,
      {
        kind: "prepare-agent-turn-identity",
        ...(input.messageId
          ? {
              turnId: `channel:${input.channelId}:${input.messageId}`,
              identitySource: "provided" as const,
            }
          : { identitySource: "legacy-generated" as const }),
        caller: channelCaller(input.channelId, input.platformSubject),
      },
    );
    return dispatch.result;
  }

  async admitAgentTurn(
    input: Parameters<InboundConversationApplicationPort["admitAgentTurn"]>[0],
  ): Promise<
    Awaited<ReturnType<InboundConversationApplicationPort["admitAgentTurn"]>>
  > {
    const productApi = await this.#requireProductApi();
    const execution = this.#execution(input);
    try {
      const dispatch = await productApi.command(
        CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
        {
          kind: "admit-agent-turn",
          preallocatedConversationId: input.conversationId,
          input: userTurnInputFromText(input.text),
          turnIdentity: input.turnIdentity,
          source: "channel",
          caller: channelCaller(input.channelId, input.platformSubject),
          turnOrigin: input.turnContext.turnOrigin,
          execution,
        },
      );
      return Object.freeze({
        status: dispatch.result.status,
        conversationId: dispatch.result.conversationId,
        turnId: dispatch.result.turnId,
      });
    } catch (error) {
      if (error instanceof ConversationApplicationError) {
        if (error.reason === "turn-conversation-not-found") {
          return frozenAdmissionFailure("not-found", input);
        }
        if (error.reason === "turn-queue-full") {
          return frozenAdmissionFailure("queue-full", input);
        }
        if (error.reason === "turn-lifecycle-busy") {
          return frozenAdmissionFailure("lifecycle-busy", input);
        }
      }
      throw error;
    }
  }

  async abort(
    input: Parameters<InboundConversationApplicationPort["abort"]>[0],
  ): Promise<Awaited<ReturnType<InboundConversationApplicationPort["abort"]>>> {
    const productApi = await this.#requireProductApi();
    const dispatch = await productApi.command(CONVERSATION_ABORT_COMMAND, {
      kind: "abort",
      conversationId: input.conversationId,
      ...(input.messageId
        ? {
            operationId: `cancel:${protocolDigest("ChannelConversationCancel", 1, {
              channelId: input.channelId,
              messageId: input.messageId,
            })}`,
          }
        : {}),
      caller: channelCaller(input.channelId, input.platformSubject),
      response: createChannelCancellationResponseEffect(input.replyTarget),
    });
    return dispatch.result;
  }

  #execution(
    input: Parameters<InboundConversationApplicationPort["admitAgentTurn"]>[0],
  ): ConversationAgentTurnExecutionPort {
    return Object.freeze({
      execute: async (
        { conversationId, turnId }:
          Parameters<ConversationAgentTurnExecutionPort["execute"]>[0],
      ) => {
        const managed = this.#manager.getSession(conversationId);
        if (!managed) {
          throw new Error(
            `Channel Conversation execution session is missing: ${conversationId}`,
          );
        }
        input.onStarted();
        try {
          const projection = await projectSessionTurn({
            manager: this.#manager,
            managed,
            text: input.text,
            turnId,
            runOptions: {
              turnContext: cloneTurnContext(input.turnContext),
              turnIndex: managed.turnCount,
              source: "channel",
            },
            hooks: {
              onCommitFailure: input.onCommitFailure,
              onFinalPublishFailure: input.onFinalPublishFailure,
            },
            notify: input.onProtocolEvent,
          });
          await input.onOutcome(toInboundOutcome(projection), this.#delivery);
        } finally {
          this.#manager.setBusy(conversationId, false);
          input.onSettled(this.#delivery);
        }
      },
      cancelPending: () => input.onPendingCancelled(),
    });
  }

  #requireProductApi(): Promise<ProductApiDispatcher> {
    if (this.#closed) {
      return Promise.reject(
        new Error("Channel Conversation Product API binding is closed"),
      );
    }
    if (this.#productApi) return Promise.resolve(this.#productApi);
    return new Promise((resolve, reject) => {
      this.#waiters.add(Object.freeze({ resolve, reject }));
    });
  }
}

function channelCaller(channelId: string, platformSubject: string) {
  return Object.freeze({
    kind: "surface" as const,
    surfacePrincipal: channelSurfacePrincipal({ channelId, platformSubject }),
    connectionId: `channel:${channelId}`,
  });
}

function frozenAdmissionFailure(
  status: "queue-full" | "lifecycle-busy" | "not-found",
  input: Parameters<InboundConversationApplicationPort["admitAgentTurn"]>[0],
) {
  return Object.freeze({
    status,
    conversationId: input.conversationId,
    turnId: input.turnIdentity.turnId,
  });
}

function cloneTurnContext(input: TurnContext): TurnContext {
  return {
    turnId: input.turnId,
    ...(input.turnOrigin ? { turnOrigin: structuredClone(input.turnOrigin) } : {}),
    ...(input.emissionTarget
      ? { emissionTarget: structuredClone(input.emissionTarget) }
      : {}),
    ...(input.commitToUser ? { commitToUser: input.commitToUser } : {}),
    ...(input.userIntent ? { userIntent: input.userIntent } : {}),
  };
}

function toInboundOutcome(
  projection: Awaited<ReturnType<typeof projectSessionTurn>>,
): InboundConversationTurnOutcome {
  switch (projection.kind) {
    case "settled":
      return Object.freeze({
        kind: "settled" as const,
        result: projection.runResult.agentResult,
      });
    case "aborted":
      return Object.freeze({ kind: "aborted" as const });
    case "error":
      return Object.freeze({ kind: "error" as const, error: projection.error });
  }
}
