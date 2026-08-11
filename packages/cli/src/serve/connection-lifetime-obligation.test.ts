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

  it("releases the borrowed stop listener after every successful obligation", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    for (let index = 0; index < 128; index += 1) {
      await fulfillConnectionLifetimeObligation({
        stopSignal: controller.signal,
        attempt: async () => {},
        shouldRetry: () => false,
      });
    }

    expect(add.mock.calls.filter(([type]) => type === "abort")).toHaveLength(128);
    expect(remove.mock.calls.filter(([type]) => type === "abort")).toHaveLength(128);
  });
});
