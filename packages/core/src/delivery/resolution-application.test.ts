import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  createDeliveryResolutionProductApiContribution,
  DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET,
  DELIVERY_RESOLVE_UNCERTAIN_COMMAND,
  DeliveryUncertainResolutionApplicationService,
  type DeliveryUncertainResolutionCommand,
} from "./resolution-application.js";

const COMMAND: DeliveryUncertainResolutionCommand = {
  requestId: "resolution-1",
  itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
  attempt: 1,
  anchorEpoch: 2,
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
