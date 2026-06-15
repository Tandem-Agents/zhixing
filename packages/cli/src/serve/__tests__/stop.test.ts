import { describe, it, expect, vi } from "vitest";
import { StopRefusedError, runStopCommand } from "../stop.js";

function mkClock() {
  let t = 0;
  const clock = () => t;
  (clock as any).advance = (ms: number) => {
    t += ms;
  };
  return clock as (() => number) & { advance: (ms: number) => void };
}

function mkDeps(overrides: Parameters<typeof runStopCommand>[0] extends infer T
  ? T extends { deps?: infer D }
    ? Partial<D>
    : never
  : never = {} as any) {
  return {
    // 默认 POSIX 分支——避免在 Windows 开发机上测试误入 Windows 分支触发真实 WebSocket 连接
    platform: "linux" as NodeJS.Platform,
    readLockFn: vi.fn(async () => ({
      pidFileVersion: 2,
      pid: 12345,
      port: 18900,
      startTime: 1,
      startedAt: "t",
    })),
    isProcessAliveFn: vi.fn(() => true),
    releaseLockFn: vi.fn(async () => {}),
    killFn: vi.fn(),
    rpcShutdownFn: vi.fn(async () => {
      throw new Error("RPC unavailable");
    }),
    clock: mkClock(),
    sleep: vi.fn(async () => {}),
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statePath: "/tmp/server.state",
    readyMarkerPath: "/tmp/server.ready",
    ...overrides,
  };
}

describe("runStopCommand", () => {
  it("returns nothing-to-stop when no PID file", async () => {
    const deps = mkDeps({ readLockFn: vi.fn(async () => null) });
    const result = await runStopCommand({ deps });
    expect(result.status).toBe("nothing-to-stop");
    expect(deps.killFn).not.toHaveBeenCalled();
  });

  it("cleans up stale PID file (pid not alive)", async () => {
    const deps = mkDeps({
      isProcessAliveFn: vi.fn(() => false),
    });
    const result = await runStopCommand({ deps });
    expect(result.status).toBe("nothing-to-stop");
    expect(deps.killFn).not.toHaveBeenCalled();
    expect(deps.releaseLockFn).toHaveBeenCalled();
  });

  it("expectedLock 不匹配时不停止当前锁指向的新宿主", async () => {
    const deps = mkDeps();
    const result = await runStopCommand({
      expectedLock: {
        pidFileVersion: 2,
        pid: 999,
        port: 18900,
        startTime: 9,
        startedAt: "old",
      },
      deps,
    });

    expect(result.status).toBe("nothing-to-stop");
    expect(deps.killFn).not.toHaveBeenCalled();
    expect(deps.releaseLockFn).not.toHaveBeenCalled();
  });

  it("expectedLock 清理前二次读锁为空时不删除发现文件", async () => {
    const expectedLock = {
      pidFileVersion: 2,
      pid: 12345,
      port: 18900,
      startTime: 1,
      startedAt: "t",
    };
    const readLockFn = vi
      .fn()
      .mockResolvedValueOnce(expectedLock)
      .mockResolvedValueOnce(null);
    const deps = mkDeps({
      readLockFn,
      isProcessAliveFn: vi.fn(() => false),
    });

    const result = await runStopCommand({ expectedLock, deps });

    expect(result.status).toBe("nothing-to-stop");
    expect(readLockFn).toHaveBeenCalledTimes(2);
    expect(deps.releaseLockFn).not.toHaveBeenCalled();
  });

  it("sends SIGTERM and waits for process to exit gracefully", async () => {
    const clock = mkClock();
    // 进程前两次 poll 活着，第三次死掉
    let aliveCalls = 0;
    const deps = mkDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(300)),
      isProcessAliveFn: vi.fn(() => {
        aliveCalls += 1;
        return aliveCalls <= 2; // 第 1 次: readLock 后判定活；第 2 次: 轮询活；第 3 次死
      }),
    });
    const result = await runStopCommand({ timeoutMs: 5000, deps });
    expect(result.status).toBe("stopped");
    expect(deps.rpcShutdownFn).toHaveBeenCalled();
    expect(deps.killFn).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(deps.killFn).not.toHaveBeenCalledWith(12345, "SIGKILL");
    expect(deps.releaseLockFn).toHaveBeenCalled();
  });

  it("POSIX: RPC 拒绝停止时不降级 SIGTERM", async () => {
    const deps = mkDeps({
      rpcShutdownFn: vi.fn(async () => {
        throw new StopRefusedError("还有其他接入面", ["还有 1 个终端连接"]);
      }),
    });

    const result = await runStopCommand({ timeoutMs: 5000, deps });

    expect(result.status).toBe("refused");
    expect(deps.killFn).not.toHaveBeenCalled();
  });

  it("falls back to SIGKILL on timeout", async () => {
    const clock = mkClock();
    const deps = mkDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(500)),
      isProcessAliveFn: vi.fn(() => true), // 永不死
    });
    const result = await runStopCommand({ timeoutMs: 1000, pollMs: 500, deps });
    expect(result.status).toBe("force-killed");
    expect(deps.killFn).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(deps.killFn).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(deps.releaseLockFn).toHaveBeenCalled();
  });

  it("returns error when SIGTERM itself fails", async () => {
    const deps = mkDeps({
      killFn: vi.fn((_pid, sig) => {
        if (sig === "SIGTERM") throw new Error("EPERM");
      }),
    });
    const result = await runStopCommand({ deps });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toMatch(/EPERM/);
    }
  });

  it("continues cleanup even if SIGKILL errors (process may have died between SIGTERM and SIGKILL)", async () => {
    const clock = mkClock();
    const deps = mkDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(500)),
      isProcessAliveFn: vi.fn(() => true),
      killFn: vi.fn((_pid, sig) => {
        if (sig === "SIGKILL") throw new Error("ESRCH");
      }),
    });
    const result = await runStopCommand({ timeoutMs: 1000, pollMs: 500, deps });
    expect(result.status).toBe("force-killed");
    expect(deps.releaseLockFn).toHaveBeenCalled();
  });
});

describe("runStopCommand — Windows path", () => {
  it("Windows: graceful RPC → process exits → stopped path='rpc'", async () => {
    const clock = mkClock();
    let aliveCalls = 0;
    const deps = mkDeps({
      platform: "win32",
      clock,
      sleep: vi.fn(async () => clock.advance(300)),
      isProcessAliveFn: vi.fn(() => {
        aliveCalls += 1;
        return aliveCalls <= 2; // 第 3 次 poll 返回死
      }),
      rpcShutdownFn: vi.fn(async () => {
        /* RPC 成功立即返回 */
      }),
      taskkillFn: vi.fn(),
    });

    const result = await runStopCommand({ timeoutMs: 5000, pollMs: 300, deps });
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.path).toBe("rpc");
    }
    expect(deps.rpcShutdownFn).toHaveBeenCalled();
    expect(deps.taskkillFn).not.toHaveBeenCalled();
  });

  it("Windows: RPC fails → fallback taskkill /T", async () => {
    const clock = mkClock();
    let aliveCalls = 0;
    const deps = mkDeps({
      platform: "win32",
      clock,
      sleep: vi.fn(async () => clock.advance(300)),
      isProcessAliveFn: vi.fn(() => {
        aliveCalls += 1;
        return aliveCalls <= 2;
      }),
      rpcShutdownFn: vi.fn(async () => {
        throw new Error("RPC connection refused");
      }),
      taskkillFn: vi.fn(),
    });

    const result = await runStopCommand({ timeoutMs: 5000, pollMs: 300, deps });
    expect(result.status).toBe("stopped");
    expect(deps.rpcShutdownFn).toHaveBeenCalled();
    expect(deps.taskkillFn).toHaveBeenCalledWith(12345, false); // /T（非强制）
    // 进程早退 → /F /T 不该被调
    expect(deps.taskkillFn).not.toHaveBeenCalledWith(12345, true);
  });

  it("Windows: RPC 拒绝停止时不降级 taskkill", async () => {
    const deps = mkDeps({
      platform: "win32",
      rpcShutdownFn: vi.fn(async () => {
        throw new StopRefusedError("还有其他接入面", ["还有 1 个终端连接"]);
      }),
      taskkillFn: vi.fn(),
    });

    const result = await runStopCommand({ timeoutMs: 5000, deps });

    expect(result.status).toBe("refused");
    expect(deps.taskkillFn).not.toHaveBeenCalled();
  });

  it("Windows: RPC fails + taskkill /T times out → escalate to taskkill /F /T", async () => {
    const clock = mkClock();
    const deps = mkDeps({
      platform: "win32",
      clock,
      sleep: vi.fn(async () => clock.advance(500)),
      isProcessAliveFn: vi.fn(() => true), // 永不死
      rpcShutdownFn: vi.fn(async () => {
        throw new Error("RPC fail");
      }),
      taskkillFn: vi.fn(),
    });

    const result = await runStopCommand({ timeoutMs: 2000, pollMs: 500, deps });
    expect(result.status).toBe("force-killed");
    expect(deps.taskkillFn).toHaveBeenCalledWith(12345, false);
    expect(deps.taskkillFn).toHaveBeenCalledWith(12345, true);
    expect(deps.releaseLockFn).toHaveBeenCalled();
  });

  it("Windows: RPC ack but process doesn't exit → escalate to taskkill", async () => {
    const clock = mkClock();
    const deps = mkDeps({
      platform: "win32",
      clock,
      sleep: vi.fn(async () => clock.advance(500)),
      isProcessAliveFn: vi.fn(() => true), // 永不死
      rpcShutdownFn: vi.fn(async () => {
        /* ack，但进程实际上不退出 */
      }),
      taskkillFn: vi.fn(),
    });

    const result = await runStopCommand({ timeoutMs: 2000, pollMs: 500, deps });
    expect(result.status).toBe("force-killed");
    expect(deps.rpcShutdownFn).toHaveBeenCalled();
    expect(deps.taskkillFn).toHaveBeenCalled();
  });
});
