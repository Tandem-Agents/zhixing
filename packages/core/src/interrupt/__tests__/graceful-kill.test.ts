import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gracefulKill } from "../graceful-kill.js";

/**
 * 创建一个最小化的 ChildProcess 替身, 满足 gracefulKill 用到的所有 surface:
 * - pid / exitCode / signalCode 属性
 * - once / on / removeListener (来自 EventEmitter)
 * - kill(signal?) 方法 (记录调用, 不真实发信号)
 *
 * 通过 simulateExit() 触发 'exit' 事件, 测试可精确控制子进程退出时机。
 */
function createMockChild(opts: { pid?: number } = {}): {
  child: import("node:child_process").ChildProcess;
  killCalls: (string | number | undefined)[];
  simulateExit: (code?: number, signal?: NodeJS.Signals) => void;
} {
  const emitter = new EventEmitter();
  const killCalls: (string | number | undefined)[] = [];
  const child = Object.assign(emitter, {
    pid: opts.pid ?? 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: (signal?: string | number) => {
      killCalls.push(signal);
      return true;
    },
  }) as unknown as import("node:child_process").ChildProcess;

  return {
    child,
    killCalls,
    simulateExit: (code = 0, signal: NodeJS.Signals | null = null) => {
      (child as unknown as { exitCode: number | null }).exitCode = code;
      (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = signal;
      emitter.emit("exit", code, signal);
    },
  };
}

/**
 * 锚定 process.kill —— 单测路径必须 mock,避免:
 *   - linux 本机: process.kill(-12345, SIGTERM) 可能 friendly-fire 到 PID 复用的进程组
 *   - windows 本机: process.kill 不存在 SIGTERM 概念,行为不可预测
 * 默认 mock 模拟"进程组不存在",让 gracefulKill 走降级到 child.kill 路径(可被 mock 观察)。
 */
function mockProcessKill(behavior: "group-exists" | "group-missing" = "group-missing"): {
  spy: ReturnType<typeof vi.spyOn>;
  calls: { pid: number; signal: string | number | undefined }[];
} {
  const calls: { pid: number; signal: string | number | undefined }[] = [];
  const spy = vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal?: string | number,
  ) => {
    calls.push({ pid, signal });
    if (pid < 0 && behavior === "group-missing") {
      const err = new Error("ESRCH: no such process group") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }
    return true;
  }) as never);
  return { spy, calls };
}

// ─── POSIX 路径 ───

describe("gracefulKill: POSIX 路径", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("子进程已退出 → 立即 resolve, 不发任何信号", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    simulateExit(0);
    const { calls: pkCalls } = mockProcessKill();

    await gracefulKill(child, { getPlatform: () => "linux" });

    expect(killCalls).toEqual([]);
    expect(pkCalls).toEqual([]);
  });

  it("SIGTERM 在 grace 期内退出 → resolve 不升级到 SIGKILL", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    const { calls: pkCalls } = mockProcessKill();

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 1000 });

    // 推 500ms 模拟子进程正常响应 SIGTERM
    await vi.advanceTimersByTimeAsync(500);
    simulateExit(0, "SIGTERM");

    await promise;

    // 进程组 SIGTERM 失败 → 降级到 child.kill("SIGTERM"); 子进程已退, 不发 SIGKILL
    expect(killCalls).toEqual(["SIGTERM"]);
    expect(pkCalls.map((c) => c.signal)).toEqual(["SIGTERM"]);
  });

  it("SIGTERM 不响应 → grace 期满后升级 SIGKILL → resolve", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    const { calls: pkCalls } = mockProcessKill();

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 1000 });

    // 推 1000ms 子进程不响应 SIGTERM → 升级 SIGKILL
    await vi.advanceTimersByTimeAsync(1000);
    // SIGKILL 后子进程被 OS 杀死, 模拟 exit 事件
    simulateExit(null, "SIGKILL");

    await promise;

    expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pkCalls.map((c) => c.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("graceMs=0 → 跳过 grace 期,立即 SIGKILL", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    const { calls: pkCalls } = mockProcessKill();

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 0 });

    await vi.advanceTimersByTimeAsync(0);
    simulateExit(null, "SIGKILL");
    await promise;

    expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pkCalls.map((c) => c.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("进程组存在 → SIGTERM 直接到进程组, 不降级 child.kill", async () => {
    const { child, killCalls, simulateExit } = createMockChild({ pid: 99999 });
    const { calls: pkCalls } = mockProcessKill("group-exists");

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 1000 });
    await vi.advanceTimersByTimeAsync(100);
    simulateExit(0, "SIGTERM");
    await promise;

    expect(pkCalls).toEqual([{ pid: -99999, signal: "SIGTERM" }]);
    expect(killCalls).toEqual([]);
  });

  it("race 完成后立即清理 grace setTimeout (无 phantom timer)", async () => {
    const { child, simulateExit } = createMockChild();
    mockProcessKill();

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 1000 });

    // 子进程在 100ms 退出 (grace 期内)
    await vi.advanceTimersByTimeAsync(100);
    simulateExit(0, "SIGTERM");
    await promise;

    // grace setTimeout 被 race 后清理, 不悬挂
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Windows 路径 ───

describe("gracefulKill: Windows 路径", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Windows → 通过 tree-kill 终止进程树, 不发 SIGTERM, 不走 grace 期", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    const { calls: pkCalls } = mockProcessKill();
    const killWindowsProcessTree = vi.fn(async (pid: number) => {
      expect(pid).toBe(child.pid);
      simulateExit(null, "SIGTERM");
    });

    const promise = gracefulKill(child, {
      getPlatform: () => "win32",
      graceMs: 1000,
      killWindowsProcessTree,
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(killWindowsProcessTree).toHaveBeenCalledTimes(1);
    expect(killWindowsProcessTree).toHaveBeenCalledWith(child.pid);
    expect(killCalls).toEqual([]);
    // 不调 process.kill (没有进程组语义)
    expect(pkCalls).toEqual([]);
  });

  it("Windows tree-kill 失败 → 降级 child.kill()", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const killWindowsProcessTree = vi.fn(async () => {
      throw new Error("taskkill failed");
    });

    const promise = gracefulKill(child, {
      getPlatform: () => "win32",
      killWindowsProcessTree,
    });
    await Promise.resolve();
    await Promise.resolve();
    simulateExit(null, "SIGTERM");
    await promise;

    expect(killWindowsProcessTree).toHaveBeenCalledTimes(1);
    expect(killCalls).toEqual([undefined]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Windows process tree kill failed"),
    );
  });

  it("Windows + 子进程已退出 → 立即 resolve, 不调 kill", async () => {
    const { child, killCalls, simulateExit } = createMockChild();
    simulateExit(0);
    const { calls: pkCalls } = mockProcessKill();
    const killWindowsProcessTree = vi.fn(async () => {});

    await gracefulKill(child, { getPlatform: () => "win32", killWindowsProcessTree });

    expect(killWindowsProcessTree).not.toHaveBeenCalled();
    expect(killCalls).toEqual([]);
    expect(pkCalls).toEqual([]);
  });
});

// ─── 错误吞噬 ───

describe("gracefulKill: 错误吞噬 (永不 reject)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("child.kill 抛 EPERM → 不传播, gracefulKill 仍 resolve", async () => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error("EPERM: operation not permitted");
      },
    }) as unknown as import("node:child_process").ChildProcess;
    mockProcessKill();

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    // 模拟 OS 兜底 SIGKILL 后子进程退出
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
    emitter.emit("exit", null, "SIGKILL");

    await expect(promise).resolves.toBeUndefined();
  });

  it("子进程没有 pid (spawn 失败场景) → 直接走 child.kill", async () => {
    const emitter = new EventEmitter();
    const killCalls: (string | undefined)[] = [];
    const child = Object.assign(emitter, {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: (signal?: string) => {
        killCalls.push(signal);
        return true;
      },
    }) as unknown as import("node:child_process").ChildProcess;
    const { calls: pkCalls } = mockProcessKill();

    const promise = gracefulKill(child, { getPlatform: () => "linux", graceMs: 100 });
    await vi.advanceTimersByTimeAsync(50);
    (child as unknown as { exitCode: number | null }).exitCode = 0;
    emitter.emit("exit", 0, null);
    await promise;

    // 没 pid 时不调 process.kill, 直接 child.kill
    expect(pkCalls).toEqual([]);
    expect(killCalls).toEqual(["SIGTERM"]);
  });
});
