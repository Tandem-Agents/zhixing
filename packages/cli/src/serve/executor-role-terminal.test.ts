import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { waitForExecutorRoleTerminal } from "./executor-role-terminal.js";

describe("waitForExecutorRoleTerminal", () => {
  it("wakes the executor role only after an RPC-driven Server reaches terminal", async () => {
    const terminal = deferred<void>();
    const deviceRemoved = deferred<void>();
    const signals = new EventEmitter();
    const server = {
      shutdown: vi.fn(async () => undefined),
      waitForShutdown: vi.fn(() => terminal.promise),
    };
    let settled = false;

    const roleTerminal = waitForExecutorRoleTerminal({
      server,
      deviceRemoved: deviceRemoved.promise,
      prepareSignalStop: vi.fn(async () => undefined),
      signalSource: signals,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(server.shutdown).not.toHaveBeenCalled();

    terminal.resolve();
    await roleTerminal;
    expect(settled).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("prepares a signal stop once and waits for the real Server terminal", async () => {
    const terminal = deferred<void>();
    const deviceRemoved = deferred<void>();
    const prepare = deferred<void>();
    const signals = new EventEmitter();
    const server = {
      shutdown: vi.fn(async () => undefined),
      waitForShutdown: vi.fn(() => terminal.promise),
    };
    const prepareSignalStop = vi.fn(() => prepare.promise);
    let settled = false;

    const roleTerminal = waitForExecutorRoleTerminal({
      server,
      deviceRemoved: deviceRemoved.promise,
      prepareSignalStop,
      signalSource: signals,
    }).then(() => {
      settled = true;
    });

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await Promise.resolve();
    expect(prepareSignalStop).toHaveBeenCalledTimes(1);
    expect(server.shutdown).not.toHaveBeenCalled();

    prepare.resolve();
    await Promise.resolve();
    expect(server.shutdown).toHaveBeenCalledTimes(1);
    expect(server.shutdown).toHaveBeenCalledWith("executor-signal");
    expect(settled).toBe(false);

    terminal.resolve();
    await roleTerminal;
    expect(settled).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("routes permanent device removal through the same Server terminal", async () => {
    const terminal = deferred<void>();
    const deviceRemoved = deferred<void>();
    const signals = new EventEmitter();
    const server = {
      shutdown: vi.fn(async () => undefined),
      waitForShutdown: vi.fn(() => terminal.promise),
    };
    let settled = false;

    const roleTerminal = waitForExecutorRoleTerminal({
      server,
      deviceRemoved: deviceRemoved.promise,
      prepareSignalStop: vi.fn(async () => undefined),
      signalSource: signals,
    }).then(() => {
      settled = true;
    });

    deviceRemoved.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(server.shutdown).toHaveBeenCalledTimes(1);
    expect(server.shutdown).toHaveBeenCalledWith("executor-device-removed");
    expect(settled).toBe(false);

    terminal.resolve();
    await roleTerminal;
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("coalesces concurrent signal, removal and Server terminal sources", async () => {
    const terminal = deferred<void>();
    const deviceRemoved = deferred<void>();
    const prepare = deferred<void>();
    const signals = new EventEmitter();
    const server = {
      shutdown: vi.fn(async () => undefined),
      waitForShutdown: vi.fn(() => terminal.promise),
    };
    const prepareSignalStop = vi.fn(() => prepare.promise);

    const roleTerminal = waitForExecutorRoleTerminal({
      server,
      deviceRemoved: deviceRemoved.promise,
      prepareSignalStop,
      signalSource: signals,
    });

    signals.emit("SIGINT");
    deviceRemoved.resolve();
    signals.emit("SIGTERM");
    await Promise.resolve();
    expect(prepareSignalStop).toHaveBeenCalledTimes(1);

    prepare.resolve();
    await Promise.resolve();
    expect(server.shutdown).toHaveBeenCalledTimes(1);

    terminal.resolve();
    await roleTerminal;
    expect(server.shutdown).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("preserves a signal preparation failure and removes listeners", async () => {
    const terminal = deferred<void>();
    const deviceRemoved = deferred<void>();
    const signals = new EventEmitter();
    const failure = new Error("durable stop blocked");
    const server = {
      shutdown: vi.fn(async () => undefined),
      waitForShutdown: vi.fn(() => terminal.promise),
    };

    const roleTerminal = waitForExecutorRoleTerminal({
      server,
      deviceRemoved: deviceRemoved.promise,
      prepareSignalStop: vi.fn(async () => {
        throw failure;
      }),
      signalSource: signals,
    });

    signals.emit("SIGINT");
    await expect(roleTerminal).rejects.toBe(failure);
    expect(server.shutdown).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
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
