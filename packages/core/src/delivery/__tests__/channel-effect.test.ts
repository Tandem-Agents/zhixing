import { describe, expect, it, vi } from "vitest";
import type {
  ChannelAdapter,
  DeliveryResult,
} from "../../channels/types.js";
import {
  createChannelDeliveryEffect,
  type ChannelDeliveryEffectSource,
} from "../channel-effect.js";
import type { OutboxEvent } from "../outbox-types.js";

const ENDPOINT = {
  kind: "channel" as const,
  target: { channelId: "feishu", to: "user-1" },
};

function source(input: {
  readonly adapter?: Pick<ChannelAdapter, "send">;
  readonly state?: "connected" | "connecting" | "disconnected" | "error";
}): ChannelDeliveryEffectSource {
  return {
    get: () => input.adapter,
    getStatus: () => input.state ? { state: input.state } : undefined,
  };
}

function meta(overrides: Record<string, unknown> = {}) {
  return {
    itemId: "delivery:item-1",
    idempotencyKey: "delivery-key-1",
    attempt: 1,
    ...overrides,
  };
}

describe("Channel Delivery effect", () => {
  it("reports readiness and response-loss evidence without owning a Delivery outcome", () => {
    const send = vi.fn(async (): Promise<DeliveryResult> => ({
      success: true,
      retryable: false,
    }));
    const connected = createChannelDeliveryEffect(source({
      adapter: { send },
      state: "connected",
    }));
    const disconnected = createChannelDeliveryEffect(source({
      adapter: { send },
      state: "connecting",
    }));
    const missing = createChannelDeliveryEffect(source({ state: "connected" }));

    expect(connected.transport.isReady(ENDPOINT)).toBe(true);
    expect(disconnected.transport.isReady(ENDPOINT)).toBe(false);
    expect(missing.transport.isReady(ENDPOINT)).toBe(false);
    expect(connected.transport.responseLossEvidence(ENDPOINT)).toEqual({
      kind: "unverified",
    });
  });

  it("preserves idempotency, source and after-slot evidence while returning finite send evidence", async () => {
    const events: OutboxEvent[] = [];
    const send = vi.fn(async (): Promise<DeliveryResult> => ({
      success: true,
      retryable: false,
      messageId: "platform-message-1",
    }));
    const effect = createChannelDeliveryEffect(source({
      adapter: { send },
      state: "connected",
    }), { onEvent: (event) => events.push(event) });

    const result = await effect.transport.send(
      ENDPOINT,
      { text: "scheduled" },
      meta({
        source: {
          kind: "scheduler",
          taskId: "task-1",
          taskName: "Task",
          createdInTurn: "turn-1",
        },
      }),
    );

    expect(result).toEqual({
      success: true,
      retryable: false,
      messageId: "platform-message-1",
    });
    expect(send).toHaveBeenCalledWith(
      ENDPOINT.target,
      { text: "scheduled" },
      { idempotencyKey: "delivery-key-1" },
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "entry:enqueued",
      entry: expect.objectContaining({
        idempotencyKey: "delivery-key-1",
        afterSlot: "turn-1",
        source: {
          kind: "scheduled-task",
          taskId: "task-1",
          createdInTurn: "turn-1",
        },
      }),
    }));
    await effect.outboxRegistry.dispose();
  });

  it("fills the existing agent slot instead of creating a parallel send path", async () => {
    const order: string[] = [];
    const send = vi.fn(async (_target, content): Promise<DeliveryResult> => {
      order.push(content.text);
      return { success: true, retryable: false };
    });
    const effect = createChannelDeliveryEffect(source({
      adapter: { send },
      state: "connected",
    }));
    const outbox = effect.outboxRegistry.of(ENDPOINT.target);
    outbox.openSlot({ slotId: "turn-1" });
    const later = outbox.post({
      target: ENDPOINT.target,
      content: { text: "later" },
      source: { kind: "scheduled-task", taskId: "task-1" },
      afterSlot: "turn-1",
    });

    await effect.transport.send(
      ENDPOINT,
      { text: "reply" },
      meta({
        source: {
          kind: "agent",
          conversationId: "conversation-1",
          turnSlotId: "turn-1",
        },
      }),
    );
    await later;

    expect(order).toEqual(["reply", "later"]);
    await effect.outboxRegistry.dispose();
  });

  it("reports a reconnect race as retryable finite effect evidence", async () => {
    let adapter: Pick<ChannelAdapter, "send"> | undefined = {
      send: async () => ({ success: true, retryable: false }),
    };
    const channels: ChannelDeliveryEffectSource = {
      get: () => adapter,
      getStatus: () => ({ state: "connected" }),
    };
    const effect = createChannelDeliveryEffect(channels);
    expect(effect.transport.isReady(ENDPOINT)).toBe(true);
    adapter = undefined;

    await expect(effect.transport.send(
      ENDPOINT,
      { text: "race" },
      meta(),
    )).resolves.toEqual({
      success: false,
      error: "Delivery transport rejected the request",
      retryable: true,
    });
    await effect.outboxRegistry.dispose();
  });
});
