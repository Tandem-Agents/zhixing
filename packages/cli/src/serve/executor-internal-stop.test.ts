import { describe, expect, it, vi } from "vitest";
import {
  ExecutorInternalStopLifecycle,
  type ExecutorInternalStopGeneration,
  shouldExecutorIdleExit,
} from "./executor-internal-stop.js";

describe("ExecutorInternalStopPort", () => {
  it("prepares durably before shutdown and waits for the real Server terminal", async () => {
    const order: string[] = [];
    const terminal = deferred<void>();
    const { port } = installedLifecycle({
      requestId: "executor-host:generation-1",
      timeoutMs: 30_000,
      prepare: async (request) => {
        order.push(`prepare:${request.reason}:${request.strategy}:${request.requestId}`);
      },
      shutdown: async (reason) => {
        order.push(`shutdown:${reason}`);
      },
      waitForShutdown: () => terminal.promise,
    });
    let settled = false;

    const stopping = port.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(order).toEqual([
      "prepare:managed-role-changed:immediate:executor-host:generation-1",
      "shutdown:managed-role-changed",
    ]);
    expect(settled).toBe(false);

    terminal.resolve();
    await stopping;
    expect(settled).toBe(true);
  });

  it("coalesces concurrent trust and idle requests into one frozen operation", async () => {
    const terminal = deferred<void>();
    const prepare = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined);
    const { port } = installedLifecycle({
      requestId: "executor-host:generation-1",
      timeoutMs: 30_000,
      prepare,
      shutdown,
      waitForShutdown: () => terminal.promise,
    });

    const trust = port.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    });
    const idle = port.requestStop({ reason: "idle", strategy: "drain" });
    expect(trust).toBe(idle);
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith({
      requestId: "executor-host:generation-1",
      reason: "managed-role-changed",
      strategy: "immediate",
      timeoutMs: 30_000,
    });
    expect(shutdown).toHaveBeenCalledTimes(1);

    terminal.resolve();
    await Promise.all([trust, idle]);
    await port.requestStop({ reason: "idle", strategy: "drain" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not trigger shutdown when durable preparation fails and retries the same identity", async () => {
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error("durable stop blocked"))
      .mockResolvedValue(undefined);
    const shutdown = vi.fn(async () => undefined);
    const waitForShutdown = vi.fn(async () => undefined);
    const { port } = installedLifecycle({
      requestId: "executor-host:generation-1",
      timeoutMs: 30_000,
      prepare,
      shutdown,
      waitForShutdown,
    });

    await expect(port.requestStop({ reason: "idle", strategy: "drain" }))
      .rejects.toThrow("durable stop blocked");
    expect(shutdown).not.toHaveBeenCalled();

    await expect(port.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    })).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]?.[0]).toEqual(prepare.mock.calls[1]?.[0]);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith("idle");
    expect(waitForShutdown).toHaveBeenCalledOnce();
  });

  it("retries the same identity after a shutdown trigger failure", async () => {
    const prepare = vi.fn(async () => undefined);
    const shutdown = vi.fn()
      .mockRejectedValueOnce(new Error("shutdown trigger blocked"))
      .mockResolvedValue(undefined);
    const waitForShutdown = vi.fn(async () => undefined);
    const { port } = installedLifecycle({
      requestId: "executor-host:generation-1",
      timeoutMs: 30_000,
      prepare,
      shutdown,
      waitForShutdown,
    });

    await expect(port.requestStop({
      reason: "managed-role-changed",
      strategy: "immediate",
    })).rejects.toThrow("shutdown trigger blocked");
    expect(waitForShutdown).not.toHaveBeenCalled();

    await expect(port.requestStop({ reason: "idle", strategy: "drain" }))
      .resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]?.[0]).toEqual(prepare.mock.calls[1]?.[0]);
    expect(shutdown).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenLastCalledWith("managed-role-changed");
    expect(waitForShutdown).toHaveBeenCalledOnce();
  });

  it("publishes one stable port before activation and fails closed until installed", async () => {
    const lifecycle = new ExecutorInternalStopLifecycle();
    const port = lifecycle.port;

    await expect(port.requestStop({ reason: "idle", strategy: "drain" }))
      .rejects.toThrow("Executor internal stop is not ready");
    expect(lifecycle.port).toBe(port);

    lifecycle.install(generation());
    await expect(port.requestStop({ reason: "idle", strategy: "drain" }))
      .resolves.toBeUndefined();
  });

  it("rejects duplicate generations and stale releases cannot clear a successor", async () => {
    const lifecycle = new ExecutorInternalStopLifecycle();
    const first = lifecycle.install(generation({ requestId: "executor-stop:first" }));
    expect(() => lifecycle.install(generation({ requestId: "executor-stop:duplicate" })))
      .toThrow("already installed");

    first.release();
    const prepare = vi.fn(async () => undefined);
    lifecycle.install(generation({ requestId: "executor-stop:successor", prepare }));
    first.release();
    await lifecycle.port.requestStop({ reason: "idle", strategy: "drain" });

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "executor-stop:successor",
    }));
  });

  it("closes idempotently and refuses later generations", async () => {
    const lifecycle = new ExecutorInternalStopLifecycle();
    lifecycle.install(generation());
    lifecycle.close();
    lifecycle.close();

    await expect(lifecycle.port.requestStop({ reason: "idle", strategy: "drain" }))
      .rejects.toThrow("Executor internal stop is not ready");
    expect(() => lifecycle.install(generation())).toThrow("lifecycle is closed");
  });
});

describe("shouldExecutorIdleExit", () => {
  it("exits only when local, Mesh and accepted-work presence are all absent", () => {
    expect(shouldExecutorIdleExit({
      localConnectionCount: 0,
      currentAnchorConnected: false,
      hasLocalAcceptedWork: false,
      hasRemoteAcceptedWork: false,
    })).toBe(true);
  });

  it.each([
    ["local RPC", { localConnectionCount: 1 }],
    ["current Anchor Mesh", { currentAnchorConnected: true }],
    ["local conversation", { hasLocalAcceptedWork: true }],
    ["remote assignment", { hasRemoteAcceptedWork: true }],
  ] as const)("keeps the Host alive for %s presence", (_label, override) => {
    expect(shouldExecutorIdleExit({
      localConnectionCount: 0,
      currentAnchorConnected: false,
      hasLocalAcceptedWork: false,
      hasRemoteAcceptedWork: false,
      ...override,
    })).toBe(false);
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

function installedLifecycle(generationInput: ExecutorInternalStopGeneration): {
  readonly lifecycle: ExecutorInternalStopLifecycle;
  readonly port: ExecutorInternalStopLifecycle["port"];
} {
  const lifecycle = new ExecutorInternalStopLifecycle();
  lifecycle.install(generationInput);
  return { lifecycle, port: lifecycle.port };
}

function generation(
  overrides: Partial<ExecutorInternalStopGeneration> = {},
): ExecutorInternalStopGeneration {
  return {
    requestId: "executor-stop:generation",
    timeoutMs: 30_000,
    prepare: async () => undefined,
    shutdown: () => undefined,
    waitForShutdown: async () => undefined,
    ...overrides,
  };
}
