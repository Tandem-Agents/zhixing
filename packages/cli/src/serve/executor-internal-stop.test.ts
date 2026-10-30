import { describe, expect, it, vi } from "vitest";
import {
  createExecutorIdleCheck,
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

describe("createExecutorIdleCheck", () => {
  // 可控的在场与工作状态；本地已接纳工作查询可在某一次挂起，模拟查询期间的交错
  function idleWorld() {
    const state = { connections: 0, changes: 0, anchor: false, localWork: false, remoteWork: false };
    let hold: ReturnType<typeof deferred<void>> | undefined;
    const requestStop = vi.fn(async () => undefined);
    const check = createExecutorIdleCheck({
      connectionChanges: () => state.changes,
      localConnectionCount: () => state.connections,
      anchorConnected: () => state.anchor,
      hasLocalAcceptedWork: async () => { const pending = hold; hold = undefined; if (pending) await pending.promise; return state.localWork; },
      hasRemoteAcceptedWork: async () => state.remoteWork,
      requestStop,
    });
    return { state, check, requestStop, holdNextQuery: () => { hold = deferred<void>(); return hold; } };
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  it("does not stop when a connection arrives while the accepted-work query is pending", async () => {
    const world = idleWorld();
    await world.check();
    const held = world.holdNextQuery();
    const second = world.check();
    await settle();
    // 查询挂起期间新终端连上：连接数 1、变动计数 +1
    world.state.connections = 1; world.state.changes = 1;
    held.resolve();
    await second;
    expect(world.requestStop).not.toHaveBeenCalled();
  });

  it("does not stop when the anchor comes online while the queries are pending", async () => {
    const world = idleWorld();
    await world.check();
    const held = world.holdNextQuery();
    const second = world.check();
    await settle();
    world.state.anchor = true;
    held.resolve();
    await second;
    expect(world.requestStop).not.toHaveBeenCalled();
  });

  it("stops once after two consecutive idle checks without connection activity, and an abandoned check restarts the count", async () => {
    const world = idleWorld();
    await world.check();
    await world.check();
    expect(world.requestStop).toHaveBeenCalledTimes(1);
    const fresh = idleWorld();
    await fresh.check();
    // 一条连接加入又断开（+2）：上一次空闲判定作废，需要重新连续两次
    fresh.state.changes = 2;
    await fresh.check();
    expect(fresh.requestStop).not.toHaveBeenCalled();
    await fresh.check();
    expect(fresh.requestStop).toHaveBeenCalledTimes(1);
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
