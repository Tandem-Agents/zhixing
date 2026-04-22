/**
 * Daemon spawn + startup handshake 单测。
 *
 * 全量 mock：spawnFn / readLockFn / isProcessAliveFn / httpGetFn / openFn / mkdirFn /
 * clock / sleep / console / readFileFn。不真的 spawn 子进程、不真的写磁盘、不打真网络。
 *
 * 覆盖路径：
 * 1. Happy path：spawn 成功 + PID 立即出现 + health 200 → ok:true
 * 2. Handshake 超时（PID 永不出现）→ ok:false
 * 3. Handshake 超时（PID 有但进程死）→ ok:false，具体原因
 * 4. Handshake 超时（PID 活但 health 挂）→ ok:false，具体原因
 * 5. UnsupportedSelfExecError → ok:false，不 spawn
 */

import { describe, it, expect, vi } from "vitest";
import { spawnDaemon } from "../daemon.js";

// 不作为 child 识别，避免 resolveSelfExec 受父进程 env 影响
const baseEnv = { HOME: "/h", PATH: "/bin" };

function makeFakeChild() {
  return {
    unref: vi.fn(),
    pid: 99999,
  } as any;
}

function makeDeps(overrides: Partial<Parameters<typeof spawnDaemon>[0]["deps"]> = {}) {
  return {
    spawnFn: vi.fn(() => makeFakeChild()),
    mkdirFn: vi.fn(async () => undefined),
    openFn: vi.fn(async () => ({ fd: 42, close: vi.fn(async () => {}) })),
    clock: mkFakeClock(),
    sleep: vi.fn(async () => {}),
    console: { log: vi.fn(), error: vi.fn() },
    readFileFn: vi.fn(async () => ""),
    checkReadyMarkerFn: vi.fn(async () => true), // 默认认为 ready marker 存在
    ...overrides,
  };
}

function mkFakeClock() {
  let t = 0;
  const clock = () => t;
  (clock as any).advance = (ms: number) => {
    t += ms;
  };
  return clock as (() => number) & { advance: (ms: number) => void };
}

// 避免真的去 process.argv[1]——mock resolveSelfExec 的依赖通过 process.argv patching
// 但 resolveSelfExec 默认用 process.argv，我们没直接入口。改用：在 deps 里直接
// 让 sleep 推进 clock、让 readLockFn 立即返回可用值——这样不需要 mock self-exec。
// 前提：测试进程的 process.argv[1] 是有效的 .js（vitest 跑的话确实是）。

describe("spawnDaemon", () => {
  it("happy path: PID appears + health 200 → ok:true", async () => {
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 5000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(true);
    expect(r.pid).toBe(12345);
    expect(r.port).toBe(18900);
    expect(deps.spawnFn).toHaveBeenCalledOnce();
    expect(deps.openFn).toHaveBeenCalledOnce();
  });

  it("times out when PID never appears", async () => {
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      readLockFn: vi.fn(async () => null),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PID file never appeared/);
  });

  it("fails when child pid is no longer alive", async () => {
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => false),
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exited before becoming ready/);
  });

  it("fails when .ready marker never appears", async () => {
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => true),
      checkReadyMarkerFn: vi.fn(async () => false), // 永远没 marker
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\.ready marker never appeared/);
  });

  it("fails when health endpoint never returns 200", async () => {
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 500),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Health endpoint never returned 200/);
  });

  it("calls child.unref() after spawn", async () => {
    const child = makeFakeChild();
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      spawnFn: vi.fn(() => child),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 200),
    });

    await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("closes log fd after spawn (so fd doesn't leak in parent)", async () => {
    const closeFn = vi.fn(async () => {});
    const clock = mkFakeClock();
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      openFn: vi.fn(async () => ({ fd: 42, close: closeFn })),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 200),
    });

    await spawnDaemon({
      forwardedArgs: ["serve"],
      logPath: "/tmp/server.log",
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(closeFn).toHaveBeenCalledOnce();
  });

  it("does NOT spawn when resolveSelfExec fails (bundled binary scenario)", async () => {
    // 把 argv 改成非 .js 以触发 UnsupportedSelfExecError
    const origArgv = process.argv;
    process.argv = [process.execPath, "/opt/bundled-bin"];
    try {
      const deps = makeDeps();
      const r = await spawnDaemon({
        forwardedArgs: ["serve"],
        logPath: "/tmp/server.log",
        handshakeTimeoutMs: 100,
        pollIntervalMs: 50,
        deps,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not a JavaScript file/);
      expect(deps.spawnFn).not.toHaveBeenCalled();
      expect(deps.openFn).not.toHaveBeenCalled();
    } finally {
      process.argv = origArgv;
    }
  });
});
