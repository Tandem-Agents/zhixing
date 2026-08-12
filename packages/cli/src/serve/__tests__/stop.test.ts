import { describe, expect, it, vi } from "vitest";
import { StopRefusedError, runStopCommand, type StopDeps } from "../stop.js";

const LOCK = {
  pid: 12345,
  port: 18900,
  host: "127.0.0.1",
  startTime: 77,
  startedAt: "2026-08-12T00:00:00.000Z",
};

function deps(overrides: Partial<StopDeps> = {}): StopDeps {
  return {
    readLockFn: vi.fn(async () => LOCK),
    isProcessAliveFn: vi.fn(() => true),
    releaseLockFn: vi.fn(async () => undefined),
    rpcShutdownFn: vi.fn(async () => undefined),
    killFn: vi.fn(),
    taskkillFn: vi.fn(async () => undefined),
    clock: (() => {
      let now = 0;
      return () => now++ * 100;
    })(),
    sleep: vi.fn(async () => undefined),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statePath: "state.json",
    readyMarkerPath: "ready",
    ...overrides,
  };
}

describe("runStopCommand durable safety boundary", () => {
  it("returns nothing-to-stop without creating lifecycle effects", async () => {
    const input = deps({ readLockFn: vi.fn(async () => null) });
    await expect(runStopCommand({ deps: input })).resolves.toEqual({ status: "nothing-to-stop" });
    expect(input.rpcShutdownFn).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "%s only uses the authenticated RPC stop operation and never force-kills",
    async (platform) => {
      let alive = true;
      const input = deps({
        platform,
        isProcessAliveFn: vi.fn(() => alive),
        rpcShutdownFn: vi.fn(async () => { alive = false; }),
      });
      const result = await runStopCommand({ timeoutMs: 1_000, deps: input });
      expect(result).toMatchObject({ status: "stopped", path: "rpc" });
      expect(input.killFn).not.toHaveBeenCalled();
      expect(input.taskkillFn).not.toHaveBeenCalled();
    },
  );

  it("keeps the exact instance and runtime markers when safe stop times out", async () => {
    const input = deps();
    const result = await runStopCommand({ timeoutMs: 250, pollMs: 100, deps: input });
    expect(result).toMatchObject({ status: "error" });
    expect(input.killFn).not.toHaveBeenCalled();
    expect(input.taskkillFn).not.toHaveBeenCalled();
    expect(input.releaseLockFn).not.toHaveBeenCalled();
  });

  it("does not downgrade an authenticated blocker refusal", async () => {
    const input = deps({
      rpcShutdownFn: vi.fn(async () => {
        throw new StopRefusedError("当前还有工作", ["还有 1 项运行中的工作"]);
      }),
    });
    const result = await runStopCommand({ respectBlockers: true, deps: input });
    expect(result).toEqual({
      status: "refused",
      pid: LOCK.pid,
      reason: "当前还有工作",
      blockers: ["还有 1 项运行中的工作"],
    });
    expect(input.killFn).not.toHaveBeenCalled();
    expect(input.taskkillFn).not.toHaveBeenCalled();
  });

  it("does not touch a successor when expectedLock no longer matches", async () => {
    const input = deps();
    const result = await runStopCommand({
      expectedLock: { ...LOCK, startTime: 88 },
      deps: input,
    });
    expect(result).toEqual({ status: "nothing-to-stop" });
    expect(input.rpcShutdownFn).not.toHaveBeenCalled();
    expect(input.releaseLockFn).not.toHaveBeenCalled();
  });
});
