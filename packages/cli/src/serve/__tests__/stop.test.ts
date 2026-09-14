import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { writeFile, access } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
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
  it("keeps endpoint reads and cleanup on the selected home after an environment change", async () => {
    const home = await createTempDir("stop-home-a");
    const other = await createTempDir("stop-home-b");
    for (const root of [home, other]) {
      await writeFile(path.join(root, "server.state"), "{}");
      await writeFile(path.join(root, "server.ready"), "");
    }
    let alive = true;
    const input = deps({
      statePath: undefined,
      readyMarkerPath: undefined,
      isProcessAliveFn: vi.fn(() => alive),
      rpcShutdownFn: vi.fn(async () => {
        vi.stubEnv("ZHIXING_HOME", other);
        alive = false;
      }),
    });
    try {
      expect(await runStopCommand({ zhixingHome: home, deps: input }))
        .toMatchObject({ status: "stopped" });
      const paths = { pidPath: path.join(home, "server.pid"), portPath: path.join(home, "server.port") };
      expect(input.readLockFn).toHaveBeenCalledWith(paths);
      expect(input.releaseLockFn).toHaveBeenCalledWith(paths);
      await expect(access(path.join(home, "server.ready"))).rejects.toThrow();
      await expect(access(path.join(other, "server.ready"))).resolves.toBeUndefined();
      await expect(access(path.join(other, "server.state"))).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it("captures the managed projection before RPC and exact-stops it only after ready-to-stop", async () => {
    const order: string[] = [];
    let alive = true;
    const input = deps({
      readLockFn: vi.fn(async () => ({ ...LOCK, kind: "managed" })),
      isProcessAliveFn: vi.fn(() => alive),
      prepareManagedExactStopFn: vi.fn(async () => {
        order.push("capture");
        return async () => {
          order.push("exact-stop");
          alive = false;
        };
      }),
      rpcShutdownFn: vi.fn(async () => { order.push("ready-to-stop"); }),
    });

    await expect(runStopCommand({ timeoutMs: 1_000, deps: input }))
      .resolves.toMatchObject({ status: "stopped" });
    expect(order).toEqual(["capture", "ready-to-stop", "exact-stop"]);
  });

  it("treats an exact endpoint successor as the old host exit without cleaning the successor", async () => {
    const successor = { ...LOCK, pid: LOCK.pid + 1, startTime: 88 };
    let reads = 0;
    const input = deps({
      readLockFn: vi.fn(async () => reads++ === 0 ? LOCK : successor),
      isProcessAliveFn: vi.fn(() => true),
    });

    await expect(runStopCommand({ timeoutMs: 1_000, deps: input }))
      .resolves.toMatchObject({ status: "stopped", pid: LOCK.pid });
    expect(input.releaseLockFn).not.toHaveBeenCalled();
  });

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
