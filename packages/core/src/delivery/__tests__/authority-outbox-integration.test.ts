import { createEventBus } from "../../events/event-bus.js";
import type { DeliveryResult, DeliveryTarget, OutboundContent } from "../../channels/types.js";
import { describe, expect, it, vi } from "vitest";
import { deliveryIdempotencyKey } from "../authority.js";
import { OutboxRegistry } from "../outbox-registry.js";
import { createOutboxSender } from "../outbox-sender.js";
import type { OutboxDoSend, OutboxEvent } from "../outbox-types.js";
import { AuthorityDeliveryPipeline } from "../authority-pipeline.js";
import type { AuthorityDeliveryEventMap } from "../types.js";
import {
  createDeliveryTestHarness,
  deliveryTestInput,
} from "./delivery-test-harness.js";

const TARGET: DeliveryTarget = { channelId: "feishu", to: "user-1" };

vi.setConfig({ testTimeout: 15_000 });

async function integrationHarness(
  send: OutboxDoSend,
  events: OutboxEvent[] = [],
  logs: unknown[] = [],
) {
  const fixture = await createDeliveryTestHarness();
  const registry = new OutboxRegistry(send, {
    onEvent: (event) => events.push(event),
    sendTimeoutMs: 0,
    logger: {
      debug: (message, data) => logs.push({ message, data }),
      info: (message, data) => logs.push({ message, data }),
      warn: (message, data) => logs.push({ message, data }),
      error: (message, data) => logs.push({ message, data }),
    },
  });
  const pipeline = new AuthorityDeliveryPipeline({
    authority: fixture.authority,
    artifacts: fixture.artifacts,
    sender: createOutboxSender(registry, { isReady: () => true }),
    eventBus: createEventBus<AuthorityDeliveryEventMap>(),
    config: { baseRetryDelayMs: 1_000, flushIntervalMs: 0 },
    now: fixture.now,
  });
  await pipeline.start();
  return { ...fixture, registry, pipeline, events, logs };
}

describe("delivery authority to outbox integration", () => {
  it("routes authority facts through the outbox and preserves source metadata", async () => {
    const sent: Array<{ content: OutboundContent; idempotencyKey?: string }> = [];
    const fixture = await integrationHarness(async (_target, content, meta) => {
      sent.push({ content, idempotencyKey: meta?.idempotencyKey });
      return { success: true, retryable: false };
    });
    await fixture.enqueue(
      deliveryTestInput({
        endpoint: { kind: "channel", target: TARGET },
        content: { text: "scheduled result" },
        source: {
          kind: "scheduler",
          taskId: "task-1",
          taskName: "Reminder",
          createdInTurn: "turn-1",
        },
      }),
    );
    const outbox = fixture.registry.of(TARGET);
    outbox.openSlot({ slotId: "turn-1" });
    await outbox.fillSlot("turn-1");

    await fixture.pipeline.flush();
    await outbox.waitIdle();

    expect(sent).toEqual([{
      content: { text: "scheduled result" },
      idempotencyKey: deliveryIdempotencyKey({
        kind: "conversation-final-delivery",
        conversationId: "conversation-1",
        runId: "run-1",
        commitRevision: 1,
      }),
    }]);
    const enqueued = fixture.events.find(
      (event): event is Extract<OutboxEvent, { type: "entry:enqueued" }> =>
        event.type === "entry:enqueued",
    );
    expect(enqueued?.entry).toMatchObject({
      afterSlot: "turn-1",
      source: {
        kind: "scheduled-task",
        taskId: "task-1",
        createdInTurn: "turn-1",
      },
      idempotencyKey: sent[0]!.idempotencyKey,
    });
    await fixture.pipeline.stop();
    await fixture.registry.dispose();
  });

  it("keeps retry authority in the delivery stream rather than the outbox", async () => {
    let calls = 0;
    const fixture = await integrationHarness(async () => {
      calls += 1;
      return calls === 1
        ? { success: false, error: "busy", retryable: true }
        : { success: true, retryable: false };
    });
    const created = await fixture.enqueue();
    if (!created.accepted) throw new Error("fixture enqueue failed");

    await fixture.pipeline.flush();
    expect(await fixture.authority.get(created.items[0]!.itemId)).toMatchObject({
      state: "retry-wait",
    });
    fixture.setNow("2026-07-17T02:00:01.000Z");
    await fixture.pipeline.flush();

    expect(calls).toBe(2);
    expect(fixture.events.filter((event) => event.type === "entry:enqueued")).toHaveLength(2);
    await fixture.pipeline.stop();
    await fixture.registry.dispose();
  });

  it.each(["returned-failure", "thrown-failure"] as const)(
    "sanitizes authority-origin adapter diagnostics before Outbox events and logs: %s",
    async (mode) => {
      const secret = "Authorization: Bearer secret-token https://private.invalid/body";
      const fixture = await integrationHarness(async () => {
        if (mode === "thrown-failure") throw new Error(secret);
        return { success: false, error: secret, retryable: false };
      });
      const created = await fixture.enqueue();
      if (!created.accepted) throw new Error("fixture enqueue failed");

      await fixture.pipeline.flush();

      const diagnostics = JSON.stringify({ events: fixture.events, logs: fixture.logs });
      expect(diagnostics).not.toContain("secret-token");
      expect(diagnostics).not.toContain("private.invalid");
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "entry:failed",
          error: mode === "thrown-failure"
            ? "Authority delivery transport failed"
            : "Delivery transport rejected the request",
        }),
      );
      await fixture.pipeline.stop();
      await fixture.registry.dispose();
    },
  );
});
