import { describe, expect, it, vi } from "vitest";
import {
  AnchorInternalStopLifecycle,
  type AnchorInternalStopGeneration,
} from "./anchor-internal-stop.js";

describe("AnchorInternalStopLifecycle", () => {
  it.each([
    ["managed-role-changed", "immediate"],
    ["idle", "drain"],
    ["device-removed", "immediate"],
  ] as const)(
    "durably prepares %s before triggering Server shutdown",
    async (reason, strategy) => {
      const order: string[] = [];
      const { port } = installedLifecycle({
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
    const { port } = installedLifecycle({
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
    const { port } = installedLifecycle({
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
    const { port } = installedLifecycle({
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

  it("publishes one stable port before activation and fails closed for non-terminal requests", async () => {
    const lifecycle = new AnchorInternalStopLifecycle();
    const port = lifecycle.port;

    await expect(port.requestStop({ reason: "idle", strategy: "drain" }))
      .rejects.toThrow("Anchor internal stop is not ready");
    expect(lifecycle.port).toBe(port);

    lifecycle.install(generation());
    await expect(port.requestStop({ reason: "idle", strategy: "drain" }))
      .resolves.toBeUndefined();
  });

  it("preserves a completed pre-activation device retirement without caching a stop", async () => {
    const lifecycle = new AnchorInternalStopLifecycle();

    await expect(lifecycle.port.requestStop({
      reason: "device-removed",
      strategy: "immediate",
    })).resolves.toBeUndefined();
    expect(() => lifecycle.assertServerStartAllowed()).toThrow(
      "This device has completed local retirement and cannot start normally",
    );
    expect(() => lifecycle.install(generation())).toThrow(
      "This device has completed local retirement and cannot start normally",
    );
  });

  it("rejects duplicate generations and stale releases cannot clear a successor", async () => {
    const lifecycle = new AnchorInternalStopLifecycle();
    const first = lifecycle.install(generation({ requestId: "anchor-stop:first" }));
    expect(() => lifecycle.install(generation({ requestId: "anchor-stop:duplicate" })))
      .toThrow("already installed");

    first.release();
    const prepare = vi.fn(async () => undefined);
    lifecycle.install(generation({ requestId: "anchor-stop:successor", prepare }));
    first.release();
    await lifecycle.port.requestStop({ reason: "idle", strategy: "drain" });

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "anchor-stop:successor",
    }));
  });

  it("closes idempotently and refuses later generations", async () => {
    const lifecycle = new AnchorInternalStopLifecycle();
    lifecycle.install(generation());
    lifecycle.close();
    lifecycle.close();

    await expect(lifecycle.port.requestStop({ reason: "idle", strategy: "drain" }))
      .rejects.toThrow("Anchor internal stop is not ready");
    expect(() => lifecycle.install(generation())).toThrow("lifecycle is closed");
  });
});

function installedLifecycle(generationInput: AnchorInternalStopGeneration): {
  readonly lifecycle: AnchorInternalStopLifecycle;
  readonly port: AnchorInternalStopLifecycle["port"];
} {
  const lifecycle = new AnchorInternalStopLifecycle();
  lifecycle.install(generationInput);
  return { lifecycle, port: lifecycle.port };
}

function generation(
  overrides: Partial<AnchorInternalStopGeneration> = {},
): AnchorInternalStopGeneration {
  return {
    requestId: "anchor-stop:generation",
    timeoutMs: 30_000,
    prepare: async () => undefined,
    requestShutdown: () => undefined,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
