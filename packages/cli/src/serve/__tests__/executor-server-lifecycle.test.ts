import {
  bindServer,
  DEFAULT_SERVER_CONFIG,
  type BoundZhixingServer,
  type RunningServer,
  type ServerStateFile,
} from "@zhixing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTOR_SERVER_LIFECYCLE_DESCRIPTORS,
  ExecutorServerLifecycle,
} from "../executor-server-lifecycle.js";

describe("ExecutorServerLifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes the five staged Server/state/timer identities", () => {
    expect(EXECUTOR_SERVER_LIFECYCLE_DESCRIPTORS).toEqual([
      { owner: "executor-server", id: "inactiveBinding.close" },
      { owner: "executor-server", id: "runningServer.shutdown" },
      { owner: "executor-server", id: "serverState.lifecycle" },
      { owner: "executor-server", id: "heartbeatTimer.clear" },
      { owner: "executor-server", id: "idleTimer.clearAndSettle" },
    ]);
  });

  it("owns and closes an inactive binding when setup fails before Server transfer", async () => {
    const order: string[] = [];
    const lifecycle = new ExecutorServerLifecycle();
    const bound = binding(order);
    const state = stateFile(order);
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(state);

    await lifecycle.stop();
    await lifecycle.cleanupState();
    await lifecycle.stop();
    await lifecycle.cleanupState();

    expect(order).toEqual([
      "state.markStopping",
      "binding.close",
      "state.markStopped",
      "state.cleanup",
    ]);
  });

  it("closes the real inactive endpoint when setup fails before runServer", async () => {
    const lifecycle = new ExecutorServerLifecycle();
    const bound = await bindServer({
      config: { ...DEFAULT_SERVER_CONFIG, host: "127.0.0.1", port: 0 },
    });
    lifecycle.acquireBinding(bound);
    expect((await fetch(`http://${bound.host}:${bound.port}/health`)).status).toBe(503);

    await lifecycle.stop();

    await expect(fetch(`http://${bound.host}:${bound.port}/health`)).rejects.toThrow();
  });

  it("transfers only the same bound endpoint and never retains a direct binding owner", async () => {
    const order: string[] = [];
    const lifecycle = new ExecutorServerLifecycle();
    const bound = binding(order);
    const state = stateFile(order);
    const active = runningServer(bound, order);
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(state);

    expect(() => lifecycle.transferToRunningServer(runningServer(binding([]), [])))
      .toThrow("does not own the acquired endpoint");
    lifecycle.transferToRunningServer(active);
    lifecycle.assertRunningServer(active);
    expect(() => lifecycle.transferToRunningServer(active)).toThrow("not available for transfer");

    await lifecycle.stop();
    await lifecycle.cleanupState();
    expect(order).toEqual([
      "state.markStopping",
      "server.shutdown:executor-role-stop",
      "state.markStopped",
      "state.cleanup",
    ]);
    expect(bound.close).not.toHaveBeenCalled();
  });

  it("clears timers, settles an in-flight idle check, then stops state and Server", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const lifecycle = activeLifecycle(order);
    const idle = deferred();
    const onError = vi.fn();
    lifecycle.startHeartbeat(10);
    lifecycle.startIdleTimer(async () => {
      order.push("idle.check");
      await idle.promise;
      order.push("idle.settled");
    }, onError, 10);

    await vi.advanceTimersByTimeAsync(10);
    const stopping = lifecycle.stop();
    await Promise.resolve();
    expect(order).toContain("idle.check");
    expect(order).not.toContain("state.markStopping");
    idle.resolve();
    await stopping;
    await lifecycle.cleanupState();

    expect(order).toEqual([
      "state.heartbeat",
      "idle.check",
      "idle.settled",
      "state.markStopping",
      "server.shutdown:executor-role-stop",
      "state.markStopped",
      "state.cleanup",
    ]);
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues through state failures after the endpoint reaches terminal", async () => {
    const order: string[] = [];
    const lifecycle = new ExecutorServerLifecycle();
    const bound = binding(order);
    const state = stateFile(order, {
      markStopping: new Error("stopping failed"),
      markStopped: new Error("stopped failed"),
    });
    const active = runningServer(bound, order);
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(state);
    lifecycle.transferToRunningServer(active);

    const error = await lifecycle.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "stopping failed" }),
      expect.objectContaining({ message: "stopped failed" }),
    ]);
    expect(order).toEqual([
      "state.markStopping",
      "server.shutdown:executor-role-stop",
      "state.markStopped",
    ]);

    await lifecycle.cleanupState();
    expect(order.at(-1)).toBe("state.cleanup");
  });

  it("does not publish stopped when an inactive binding fails to close", async () => {
    const order: string[] = [];
    const lifecycle = new ExecutorServerLifecycle();
    const bound = binding(order, new Error("binding failed"));
    const state = stateFile(order);
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(state);

    const error = await lifecycle.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "binding failed" }),
    ]);
    expect(order).toEqual(["state.markStopping", "binding.close"]);
    expect(state.markStopped).not.toHaveBeenCalled();

    await lifecycle.cleanupState();
    expect(order.at(-1)).toBe("state.cleanup");
  });

  it("does not publish stopped when RunningServer shutdown fails", async () => {
    const order: string[] = [];
    const lifecycle = new ExecutorServerLifecycle();
    const bound = binding(order);
    const state = stateFile(order);
    const active = runningServer(bound, order, new Error("server failed"));
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(state);
    lifecycle.transferToRunningServer(active);

    const error = await lifecycle.stop().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "server failed" }),
    ]);
    expect(order).toEqual(["state.markStopping", "server.shutdown:executor-role-stop"]);
    expect(state.markStopped).not.toHaveBeenCalled();

    await lifecycle.cleanupState();
    expect(order.at(-1)).toBe("state.cleanup");
  });

  it("keeps timer admission and state cleanup fail closed", async () => {
    const lifecycle = new ExecutorServerLifecycle();
    expect(() => lifecycle.startHeartbeat()).toThrow("requires a running endpoint");
    await expect(lifecycle.cleanupState()).rejects.toThrow("requires a stop attempt");

    const order: string[] = [];
    const bound = binding(order);
    const active = runningServer(bound, order);
    lifecycle.acquireBinding(bound);
    lifecycle.acquireStateFile(stateFile(order));
    lifecycle.transferToRunningServer(active);
    lifecycle.startHeartbeat(60_000);
    expect(() => lifecycle.startHeartbeat()).toThrow("already active");
    await lifecycle.stop();
    expect(() => lifecycle.startIdleTimer(async () => {}, () => {}))
      .toThrow("cannot start during shutdown");
  });
});

function activeLifecycle(order: string[]): ExecutorServerLifecycle {
  const lifecycle = new ExecutorServerLifecycle();
  const bound = binding(order);
  lifecycle.acquireBinding(bound);
  lifecycle.acquireStateFile(stateFile(order));
  lifecycle.transferToRunningServer(runningServer(bound, order));
  return lifecycle;
}

function binding(order: string[], closeFailure?: Error): Pick<
  BoundZhixingServer,
  "close" | "host" | "httpServer" | "port"
> {
  return {
    host: "127.0.0.1",
    port: 3210,
    httpServer: {} as BoundZhixingServer["httpServer"],
    close: vi.fn(async () => {
      order.push("binding.close");
      if (closeFailure) throw closeFailure;
    }),
  };
}

function runningServer(
  bound: Pick<BoundZhixingServer, "host" | "httpServer" | "port">,
  order: string[],
  shutdownFailure?: Error,
): RunningServer {
  const shutdown = vi.fn(async (reason?: string) => {
    order.push(`server.shutdown:${reason}`);
    if (shutdownFailure) throw shutdownFailure;
  });
  return {
    server: {
      host: bound.host,
      port: bound.port,
      httpServer: bound.httpServer,
    } as RunningServer["server"],
    shutdown,
    waitForShutdown: vi.fn(() => shutdown()),
  };
}

function stateFile(
  order: string[],
  failures: {
    readonly markStopped?: Error;
    readonly markStopping?: Error;
  } = {},
): Pick<
  ServerStateFile,
  "cleanup" | "heartbeat" | "markReady" | "markRunning" | "markStopped" | "markStopping"
> {
  return {
    cleanup: vi.fn(async () => {
      order.push("state.cleanup");
    }),
    heartbeat: vi.fn(async () => {
      order.push("state.heartbeat");
    }),
    markReady: vi.fn(async () => {}),
    markRunning: vi.fn(async () => {}),
    markStopping: vi.fn(async () => {
      order.push("state.markStopping");
      if (failures.markStopping) throw failures.markStopping;
    }),
    markStopped: vi.fn(async () => {
      order.push("state.markStopped");
      if (failures.markStopped) throw failures.markStopped;
    }),
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
