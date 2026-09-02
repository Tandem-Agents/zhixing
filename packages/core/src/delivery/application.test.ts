import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  createDeliveryResolutionProductApiContribution,
  DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET,
  DELIVERY_RESOLVE_UNCERTAIN_COMMAND,
  DeliveryLifecycleApplicationService,
  DeliveryObligationApplicationService,
  DeliveryProjectionInvariantError,
  DeliveryUncertainResolutionApplicationService,
  type DeliveryObligation,
  type DeliveryObligationDecide,
  type DeliveryResolutionFence,
  type DeliveryUncertainResolutionCommand,
} from "./application.js";
import {
  emptyDeliveryProjection,
  projectDeliveryApplicationProjection,
  projectDeliveryLifecycleRecords,
} from "./authority.js";
import type { DeliveryEnqueueInput } from "./types.js";

const COMMAND: DeliveryUncertainResolutionCommand = {
  requestId: "resolution-1",
  itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
  attempt: 1,
  resolutionFence: "opaque-correctness-fence" as DeliveryResolutionFence,
  openFactDigest: `sha256:${"a".repeat(64)}`,
  decision: "abandon",
  principal: {
    surfacePrincipal: "rpc:desktop",
    deviceId: "anchor-device",
    connectionId: "7",
  },
};

describe("Delivery uncertain-resolution application", () => {
  it("owns one immutable command and contributes it without Product API facts", async () => {
    const resolve = vi.fn(async (_command, decide) => {
      expect(typeof decide).toBe("function");
      return {
        kind: "applied" as const,
        canonicalRequestId: COMMAND.requestId,
        result: {
          v: 1 as const,
          status: "ok" as const,
          body: { t: "delivery-resolve" as const, applied: true },
        },
        authorityRevision: 4,
      };
    });
    const application = new DeliveryUncertainResolutionApplicationService({ resolve });
    const dispatcher = new ProductApiDispatcher(
      DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET,
      [createDeliveryResolutionProductApiContribution(application)],
    );

    await expect(dispatcher.command(DELIVERY_RESOLVE_UNCERTAIN_COMMAND, COMMAND))
      .resolves.toEqual({
        result: expect.objectContaining({ kind: "applied", authorityRevision: 4 }),
        facts: [],
      });
    expect(resolve).toHaveBeenCalledOnce();
    const delivered = resolve.mock.calls[0]![0];
    expect(delivered).toEqual(COMMAND);
    expect(delivered).not.toHaveProperty("anchorEpoch");
    expect(delivered).not.toBe(COMMAND);
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(Object.isFrozen(delivered.principal)).toBe(true);
    expect(dispatcher.supports(DELIVERY_RESOLVE_UNCERTAIN_COMMAND)).toBe(true);
  });

  it("fails closed when the sealed catalog omits the Delivery contribution", () => {
    expect(() => new ProductApiDispatcher(
      DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET,
      [],
    )).toThrow(
      "Missing Product API operation contribution: delivery.command.resolve-uncertain",
    );
  });
});

describe("Delivery obligation application", () => {
  const NOW = "2026-08-29T00:00:00.000Z";
  const OBLIGATION: DeliveryObligation = {
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
      createdAt: NOW,
    },
  };

  it("owns retry policy and the sole enqueue decision while Correctness supplies projection", () => {
    const prepare = vi.fn(
      (
        inputs: readonly DeliveryEnqueueInput[],
        _commitAt: string,
        decide: DeliveryObligationDecide,
      ) => decide({
        projection: emptyDeliveryProjection(),
        lifecycleAdmission: undefined,
      }),
    );
    const application = new DeliveryObligationApplicationService(
      {
        coordinate: (operation) => operation(),
        prepare,
      },
      { maxAttempts: 5 },
    );

    const result = application.prepare([OBLIGATION], NOW);

    expect(result.accepted).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({ maxAttempts: 5 }),
      }),
    ]);
    expect(prepare.mock.calls[0]![1]).toBe(NOW);
    expect("maxAttempts" in OBLIGATION.intent).toBe(false);
    if (!result.accepted) throw new Error("expected accepted fixture");
    expect(result.records).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });

  it("rejects an invalid Delivery-owned retry policy before publication", () => {
    expect(() => new DeliveryObligationApplicationService(
      {
        coordinate: (operation) => operation(),
        prepare: vi.fn(),
      },
      { maxAttempts: 0 },
    )).toThrow("Delivery max attempts must be a positive safe integer");
  });

  it("reports a Delivery-owned invariant signal for a malformed lifecycle projection", async () => {
    let projection = emptyDeliveryProjection();
    const prepare = (
      inputs: readonly DeliveryEnqueueInput[],
      _commitAt: string,
      decide: DeliveryObligationDecide,
    ) => {
      const decision = decide({
        projection: emptyDeliveryProjection(),
        lifecycleAdmission: undefined,
      });
      if (decision.accepted) {
        projection = projectDeliveryLifecycleRecords(
          emptyDeliveryProjection(),
          decision.records,
          NOW,
        );
      }
      return decision;
    };
    const obligation = new DeliveryObligationApplicationService({
      coordinate: (operation) => operation(),
      prepare,
    }).prepare([OBLIGATION], NOW);
    if (!obligation.accepted) throw new Error("expected accepted fixture");
    const itemId = obligation.items[0]!.itemId;
    const item = projection.items.get(itemId);
    if (!item) throw new Error("expected projected delivery item");
    item.state = "attempting";
    item.currentAttempt = 1;
    item.automaticAttemptsUsed = 1;

    const application = new DeliveryLifecycleApplicationService({
      snapshot: () => [],
      transact: async (decide) => {
        const decision = decide({
          projection: projectDeliveryApplicationProjection(projection),
          transactionAt: NOW,
        });
        return {
          value: decision.value,
          projection: projectDeliveryApplicationProjection(projection),
        };
      },
      transactAdmission: (decide) => Promise.resolve(decide({
        projection: projectDeliveryApplicationProjection(projection),
        admission: undefined,
      }).value),
    });

    await expect(application.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    })).rejects.toEqual(expect.objectContaining({
      name: "DeliveryProjectionInvariantError",
      kind: "delivery-projection-invariant",
      message: "Open delivery attempt has no start fact",
    } satisfies Partial<DeliveryProjectionInvariantError>));
  });
});
