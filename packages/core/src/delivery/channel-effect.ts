import type {
  ChannelState,
  DeliveryAdapterSendMeta,
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../channels/types.js";
import type { DeliveryEndpointDto } from "../contracts/index.js";
import { OutboxRegistry } from "./outbox-registry.js";
import type {
  EmissionSource,
  OutboxRegistryOptions,
} from "./outbox-types.js";
import type {
  AuthorityDeliverySendMeta,
  DeliveryEndpointTransport,
  DeliverySource,
} from "./types.js";

const SAFE_REJECTED_EFFECT = "Delivery transport rejected the request";
const SAFE_UNKNOWN_EFFECT = "Authority delivery transport failed";

/** The finite Channel capability observed by the Delivery effect adapter. */
export interface ChannelDeliveryEffectSource {
  status(channelId: string): ChannelState | undefined;
  send(
    target: DeliveryTarget,
    content: OutboundContent,
    meta?: DeliveryAdapterSendMeta,
  ): Promise<DeliveryResult | undefined>;
}

export interface ChannelDeliveryEffect {
  readonly outboxRegistry: OutboxRegistry;
  readonly transport: DeliveryEndpointTransport;
}

/**
 * Binds the Delivery-owned effect port to the shared per-target Channel Outbox.
 * It reports only readiness and finite send evidence; Delivery keeps every
 * claim, retry, unknown-outcome and terminal decision.
 */
export function createChannelDeliveryEffect(
  channels: ChannelDeliveryEffectSource,
  options?: OutboxRegistryOptions,
): ChannelDeliveryEffect {
  const outboxRegistry = new OutboxRegistry(
    async (target, content, meta) => {
      try {
        const result = meta
          ? await channels.send(target, content, meta)
          : await channels.send(target, content);
        if (!result) {
          return {
            success: false as const,
            error: SAFE_REJECTED_EFFECT,
            retryable: true,
          };
        }
        return result.success
          ? result
          : {
              success: false as const,
              error: SAFE_REJECTED_EFFECT,
              retryable: result.retryable,
            };
      } catch {
        throw new Error(SAFE_UNKNOWN_EFFECT);
      }
    },
    options,
  );
  const transport: DeliveryEndpointTransport = Object.freeze({
    endpointKind: "channel" as const,
    isReady(endpoint: DeliveryEndpointDto): boolean {
      return endpoint.kind === "channel" &&
        channels.status(endpoint.target.channelId) === "connected";
    },
    responseLossEvidence(): { readonly kind: "unverified" } {
      return { kind: "unverified" };
    },
    async send(
      endpoint: DeliveryEndpointDto,
      content: OutboundContent,
      meta: AuthorityDeliverySendMeta,
    ): Promise<DeliveryResult> {
      if (endpoint.kind !== "channel") {
        throw new TypeError("Channel delivery effect received another endpoint kind");
      }
      const target = endpoint.target;
      const outbox = outboxRegistry.of(target);
      const entry = {
        target,
        content,
        idempotencyKey: meta.idempotencyKey,
        source: mapSource(meta.source),
        afterSlot: deriveAfterSlot(meta.source),
      };
      if (meta.source?.kind === "agent" && meta.source.turnSlotId) {
        const result = await outbox.fillSlot(meta.source.turnSlotId, entry);
        if (!result) {
          throw new Error("Filling an agent delivery slot did not enqueue its entry");
        }
        return result;
      }
      return outbox.post(entry);
    },
  });
  return Object.freeze({ outboxRegistry, transport });
}

function mapSource(source?: DeliverySource): EmissionSource {
  if (!source) {
    return { kind: "system", handler: "delivery-pipeline" };
  }
  switch (source.kind) {
    case "scheduler":
      return {
        kind: "scheduled-task",
        taskId: source.taskId,
        ...(source.createdInTurn !== undefined
          ? { createdInTurn: source.createdInTurn }
          : {}),
      };
    case "agent":
      return { kind: "llm-reply", conversationId: source.conversationId };
    case "system":
      return { kind: "system", handler: source.reason };
  }
}

function deriveAfterSlot(source?: DeliverySource): string | undefined {
  return source?.kind === "scheduler" ? source.createdInTurn : undefined;
}
