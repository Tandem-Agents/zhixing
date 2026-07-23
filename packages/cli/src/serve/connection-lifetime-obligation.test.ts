import { describe, expect, it, vi } from "vitest";
import { fulfillConnectionLifetimeObligation } from "./connection-lifetime-obligation.js";

describe("connection lifetime obligation", () => {
  it("retries an uncertain failure and stops after success", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("durable store temporarily unavailable"))
      .mockResolvedValueOnce(undefined);

    await fulfillConnectionLifetimeObligation({
      connectionClosed: new Promise(() => {}),
      attempt,
      shouldRetry: () => true,
    });

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry a stable rejection", async () => {
    const attempt = vi.fn().mockRejectedValue(new TypeError("invalid obligation"));

    await fulfillConnectionLifetimeObligation({
      connectionClosed: new Promise(() => {}),
      attempt,
      shouldRetry: (error) => !(error instanceof TypeError),
    });

    expect(attempt).toHaveBeenCalledOnce();
  });
});
