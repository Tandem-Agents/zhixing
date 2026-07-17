import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChannelRegistry, deliveryRecord } from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("setupDelivery authority shadow", () => {
  let home: string;
  let stack: DeliveryStack | null = null;

  beforeEach(async () => {
    home = await createTempDir("delivery");
  });

  afterEach(async () => {
    if (stack) {
      await stack.stop().catch(() => {});
      stack = null;
    }
  });

  it("assembles a valid DeliveryStack with an empty channel registry", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({ channels, zhixingHome: home, logger: quietLogger });
    expect(stack).toBeDefined();
    expect(stack.delivery).toBeDefined();
    expect(stack.authorityDelivery).toBeDefined();
    expect(stack.authority).toBeDefined();
    expect(stack.authorityLog).toBeDefined();
    expect(stack.artifacts).toBeDefined();
    expect(stack.participant).toBeDefined();
    expect(stack.controlAdmission).toBeDefined();
    expect(stack.outboxRegistry).toBeDefined();
    expect(typeof stack.statusHistory).toBe("function");
    expect(typeof stack.resolve).toBe("function");
    expect(typeof stack.stop).toBe("function");
  });

  it("publishes a revisioned resolved notice through the production control path", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({ channels, zhixingHome: home, logger: quietLogger });
    const sourceRef = await stack.artifacts.put(Buffer.from("resolution-source", "utf8"));
    const prepared = await stack.authority.coordinate(() =>
      stack!.authorityLog.transactProjection(
        {},
        (state) => state,
        (_state, context) => {
          const enqueues = stack!.authority.prepareEnqueues([
            {
              keyBody: {
                kind: "conversation-final-delivery",
                conversationId: "conversation-resolution",
                runId: "run-resolution",
                commitRevision: 1,
              },
              intent: {
                endpoint: {
                  kind: "channel",
                  target: { channelId: "feishu", to: "chat-1" },
                },
                content: { text: "resolve me" },
                priority: "normal",
                createdAt: context.at,
                maxAttempts: 3,
              },
            },
          ], context.at);
          if (!enqueues.accepted) throw new Error(enqueues.error.message);
          return {
            kind: "append" as const,
            entries: [
              {
                stream: "run:conversation-resolution",
                body: {
                  t: "committed",
                  runId: "run-resolution",
                  assignmentId: "assignment-resolution",
                  bundle: { ref: sourceRef },
                  commitRevision: 1,
                },
              },
              ...enqueues.records.map(deliveryRecord),
            ],
            value: enqueues.items[0]!.itemId,
          };
        },
        { candidateReferences: [sourceRef] },
      ),
    );
    const claim = await stack.authority.claim({
      itemId: prepared.value,
      outcomePolicy: { kind: "manual-resolution" },
    });
    expect(claim.kind).toBe("send");
    await stack.authority.claim({ itemId: prepared.value });
    const uncertain = await stack.authority.get(prepared.value);
    expect(uncertain?.state).toBe("uncertain");
    const listener = vi.fn();
    stack.onStatus(() => {
      throw new Error("simulated status consumer failure");
    });
    stack.onStatus(listener);

    await stack.resolve({
      requestId: "request:delivery-resolution",
      source: {
        principal: {
          surfacePrincipal: "surface:user-1",
          deviceId: "device-1",
          connectionId: "connection-1",
        },
      },
      body: {
        t: "delivery-resolve",
        itemId: prepared.value,
        attempt: uncertain!.currentAttempt,
        anchorEpoch: 1,
        openFactDigest: uncertain!.openFact!.openFactDigest,
        decision: "abandon",
      },
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { execution: "delivery", itemId: prepared.value },
        state: "delivery-resolved",
        decision: "abandon",
      }),
    );
    await expect(stack.statusHistory({ [prepared.value]: 0 })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "delivery-resolved" }),
      ]),
    );
  }, 15_000);

  it("rebuilds queued delivery authority from the shared durable log", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({ channels, zhixingHome: home, logger: quietLogger });
    const authority = stack.authority;
    const sourceRef = await stack.artifacts.put(Buffer.from("rebuild-source", "utf8"));
    const transaction = await authority.coordinate(() => stack!.authorityLog.transactProjection(
      {},
      (state) => state,
      (_state, context) => {
        const prepared = authority.prepareEnqueues([
          {
            keyBody: {
              kind: "conversation-final-delivery",
              conversationId: "conversation-1",
              runId: "run-1",
              commitRevision: 1,
            },
            intent: {
              endpoint: {
                kind: "channel",
                target: { channelId: "feishu", to: "chat-1" },
              },
              content: { text: "done" },
              priority: "normal",
              source: { kind: "agent", conversationId: "conversation-1" },
              createdAt: context.at,
              maxAttempts: 3,
            },
          },
        ], context.at);
        if (!prepared.accepted) throw new Error(prepared.error.message);
        return {
          kind: "append" as const,
          entries: [
            {
              stream: "run:conversation-1",
              body: {
                t: "committed",
                runId: "run-1",
                assignmentId: "assignment-1",
                bundle: { ref: sourceRef },
                commitRevision: 1,
              },
            },
            ...prepared.records.map(deliveryRecord),
          ],
          value: prepared.items[0]!.itemId,
        };
      },
      { candidateReferences: [sourceRef] },
    ));
    expect((await authority.get(transaction.value))?.state).toBe("queued");

    await stack.stop();
    stack = await setupDelivery({ channels, zhixingHome: home, logger: quietLogger });
    expect((await stack.authority.get(transaction.value))?.state).toBe("queued");
  }, 15_000);
});
