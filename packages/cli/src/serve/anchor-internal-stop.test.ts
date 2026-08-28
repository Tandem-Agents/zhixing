import { describe, expect, it, vi } from "vitest";
import { createAnchorInternalStopPort } from "./anchor-internal-stop.js";

describe("createAnchorInternalStopPort", () => {
  it.each([
    ["managed-role-changed", "immediate"],
    ["idle", "drain"],
    ["device-removed", "immediate"],
  ] as const)(
    "durably prepares %s before triggering Server shutdown",
    async (reason, strategy) => {
      const order: string[] = [];
      const port = createAnchorInternalStopPort({
        requestId: "anchor-stop:generation",
        timeoutMs: 30_000,
        prepare: vi.fn(async (request) => {
          order.push("prepare");
          expect(request).toEqual({
            requestId: "anchor-stop:generation",
            reason,
            strategy,
            timeoutMs: 30_000,
          });
        }),
        requestShutdown: vi.fn(() => {
          order.push("shutdown");
        }),
      });

      await expect(port.requestStop({ reason, strategy })).resolves.toBeUndefined();
      expect(order).toEqual(["prepare", "shutdown"]);
    },
  );

  it("coalesces concurrent and repeated sources into one durable operation and shutdown", async () => {
    const prepared = deferred<void>();
    const prepare = vi.fn(() => prepared.promise);
    const requestShutdown = vi.fn();
    const port = createAnchorInternalStopPort({
      requestId: "anchor-stop:generation",
      timeoutMs: 30_000,
      prepare,
      requestShutdown,
    });

    const managed = port.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    });
    const idle = port.requestStop({ reason: "idle", strategy: "drain" });
    const removed = port.requestStop({ reason: "device-removed", strategy: "immediate" });

    expect(managed).toBe(idle);
    expect(managed).toBe(removed);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(requestShutdown).not.toHaveBeenCalled();

    prepared.resolve();
    await Promise.all([managed, idle, removed]);
    await port.requestStop({ reason: "idle", strategy: "drain" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith("managed-role-changed");
  });

  it("does not shutdown after prepare fails and retries the same frozen identity", async () => {
    const failure = new Error("durable flush failed");
    const prepare = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const requestShutdown = vi.fn();
    const port = createAnchorInternalStopPort({
      requestId: "anchor-stop:generation",
      timeoutMs: 30_000,
      prepare,
      requestShutdown,
    });

    await expect(port.requestStop({
      reason: "idle",
      strategy: "drain",
    })).rejects.toBe(failure);
    expect(requestShutdown).not.toHaveBeenCalled();

    await expect(port.requestStop({
      reason: "device-removed",
      strategy: "immediate",
    })).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenLastCalledWith({
      requestId: "anchor-stop:generation",
      reason: "idle",
      strategy: "drain",
      timeoutMs: 30_000,
    });
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith("idle");
  });

  it("preserves a shutdown trigger failure and retries without a second identity", async () => {
    const failure = new Error("shutdown binding unavailable");
    const prepare = vi.fn(async () => undefined);
    const requestShutdown = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const port = createAnchorInternalStopPort({
      requestId: "anchor-stop:generation",
      timeoutMs: 30_000,
      prepare,
      requestShutdown,
    });

    await expect(port.requestStop({
      reason: "device-removed",
      strategy: "immediate",
    })).rejects.toBe(failure);
    await expect(port.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    })).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]?.[0]).toEqual(prepare.mock.calls[1]?.[0]);
    expect(requestShutdown).toHaveBeenCalledTimes(2);
    expect(requestShutdown).toHaveBeenLastCalledWith("device-removed");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
