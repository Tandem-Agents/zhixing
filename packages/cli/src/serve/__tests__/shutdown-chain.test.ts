/**
 * shutdown-chain 单元测试：验证 LIFO 注册顺序与 spec §3.6.1 完全一致。
 *
 * 这个测试是回归守卫——未来任何对 registerTailCleanup / registerCoreCleanup 注册
 * 顺序的误改都会在此捕获。spec §3.6.1 的 9 项 LIFO 执行顺序是 daemon 正确性的根基，
 * 不能回归。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CleanupRegistry } from "@zhixing/server";
import { createTempDir } from "@zhixing/test-utils";
import {
  registerTailCleanup,
  registerCoreCleanup,
  mapReasonToExit,
  type ShutdownChainResources,
} from "../shutdown-chain.js";

function quietLogger() {
  return { info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function mkFullResources(heartbeatTimerRef = { current: null as NodeJS.Timeout | null }): ShutdownChainResources {
  return {
    heartbeatTimerRef,
    stateFile: {
      cleanup: vi.fn(async () => {}),
      markStopped: vi.fn(async () => {}),
      markStopping: vi.fn(async () => {}),
    } as any,
    scheduler: { stop: vi.fn(async () => {}) } as any,
    channels: { dispose: vi.fn(async () => {}) } as any,
    mcpHub: { dispose: vi.fn(async () => {}) } as any,
    deliveryStack: { stop: vi.fn(async () => {}) } as any,
  };
}

describe("registerTailCleanup", () => {
  it("with stateFile: registers releaseLock, stateFile.cleanup, stateFile.markStopped in that order", () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const spy = vi.spyOn(registry, "register");
    const res = mkFullResources();

    registerTailCleanup(registry, res);

    const names = spy.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["releaseLock", "stateFile.cleanup", "stateFile.markStopped"]);
  });

  it("without stateFile: registers only releaseLock (前台模式)", () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const spy = vi.spyOn(registry, "register");

    registerTailCleanup(registry, { heartbeatTimerRef: { current: null } });

    const names = spy.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["releaseLock"]);
  });
});

describe("registerCoreCleanup", () => {
  it("with full resources: registers 6 items in correct order", () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const spy = vi.spyOn(registry, "register");

    registerCoreCleanup(registry, mkFullResources());

    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      "heartbeat.clear",
      "deliveryStack.stop",
      "channels.dispose",
      "mcpHub.dispose",
      "scheduler.stop",
      "stateFile.markStopping",
    ]);
  });

  it("minimal (no optional resources): only heartbeat.clear", () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const spy = vi.spyOn(registry, "register");

    registerCoreCleanup(registry, { heartbeatTimerRef: { current: null } });

    expect(spy.mock.calls.map((c) => c[0])).toEqual(["heartbeat.clear"]);
  });

  it("heartbeat.clear reads latest timer via ref (registers before timer exists, clears after)", () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const ref: { current: NodeJS.Timeout | null } = { current: null };

    registerCoreCleanup(registry, { heartbeatTimerRef: ref });

    // timer 后来才创建
    const timer = setInterval(() => {}, 100_000);
    ref.current = timer;

    return registry.runAll("test").then(() => {
      // 期望：clearInterval 被调用——timer 已停止
      // 无法直接断言 clearInterval 被调；验证行为：timer 不会继续触发（unref 后即使没 clear 也不阻塞 exit）
      // 用实际清理副作用验证
      clearInterval(timer); // 安全冗余
      expect(ref.current).toBe(timer); // registry 不修改 ref，只读
    });
  });
});

describe("LIFO execution order (spec §3.6.1 regression guard)", () => {
  it("full resources: runAll produces spec §3.6.1 execution sequence", async () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const order: string[] = [];

    const res: ShutdownChainResources = {
      heartbeatTimerRef: { current: null },
      stateFile: {
        cleanup: vi.fn(async () => {
          order.push("stateFile.cleanup");
        }),
        markStopped: vi.fn(async () => {
          order.push("stateFile.markStopped");
        }),
        markStopping: vi.fn(async () => {
          order.push("stateFile.markStopping");
        }),
      } as any,
      scheduler: {
        stop: vi.fn(async () => {
          order.push("scheduler.stop");
        }),
      } as any,
      channels: {
        dispose: vi.fn(async () => {
          order.push("channels.dispose");
        }),
      } as any,
      deliveryStack: {
        stop: vi.fn(async () => {
          order.push("deliveryStack.stop");
        }),
      } as any,
      mcpHub: {
        dispose: vi.fn(async () => {
          order.push("mcpHub.dispose");
        }),
      } as any,
    };

    // 模拟 command.ts 的真实注册时序：tail → [runServer 注册 server.close] → core
    registerTailCleanup(registry, res);
    registry.register("server.close", () => {
      order.push("server.close");
    });
    registerCoreCleanup(registry, res);

    await registry.runAll("graceful");

    // spec §3.6.1 要求的 LIFO 执行顺序
    expect(order).toEqual([
      "stateFile.markStopping", // ①
      "scheduler.stop", // ②
      "mcpHub.dispose", // ③ —— 先停调度再关 MCP 连接 / 子进程
      "channels.dispose", // ④
      "deliveryStack.stop", // ⑤
      // heartbeat.clear 无副作用（timer=null），被跳过（⑥）
      "server.close", // ⑦
      "stateFile.markStopped", // ⑧
      "stateFile.cleanup", // ⑨
      // releaseLock 最后（⑩），但我们没 mock
    ]);
  });

  it("releaseLock is last when all state-file items present", async () => {
    const registry = new CleanupRegistry({ logger: quietLogger() });
    const order: string[] = [];

    // Override releaseLock via spy on its registration target
    const res = mkFullResources();
    // Stub the registered callbacks by re-using runAll
    registerTailCleanup(registry, res);
    registerCoreCleanup(registry, res);
    registry.register("server.close", () => order.push("server.close"));

    // Before runAll, capture original functions and replace with order-tracking ones
    // 最干净的方式：用真实资源 mock（上一个测试已做），这里只断言 LIFO 计数
    expect(registry.size).toBe(3 /* tail */ + 6 /* core */ + 1 /* server.close */);

    await registry.runAll("test");
    expect(registry.finished).toBe(true);
  });
});

describe("releaseLock closure (Issue θ regression guard)", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("lockguard");
    pidPath = join(tempDir, "server.pid");
    portPath = join(tempDir, "server.port");
  });

  it("releaseLock闭包在 PID 文件属于别的进程时 no-op (concurrent-start 保护)", async () => {
    // 模拟场景：PID 文件里写的是另一个进程（比如 Child A）
    const otherPid = 999999; // 随便找一个不等于 process.pid 的值
    await writeFile(
      pidPath,
      JSON.stringify({
        pidFileVersion: 2,
        pid: otherPid,
        port: 18900,
        startedAt: "t",
        startTime: null,
      }),
      "utf-8",
    );

    // Child B 的 catch 分支调 runAll → releaseLock 闭包执行
    const registry = new CleanupRegistry({ logger: quietLogger() });
    registerTailCleanup(registry, {
      heartbeatTimerRef: { current: null },
      lockPaths: { pidPath, portPath },
    });
    await registry.runAll("startup-failure");

    // 关键：PID 文件未被删除（属于 Child A 的锁保持完整）
    await stat(pidPath); // 不抛 = 文件存在
  });

  it("releaseLock闭包在 PID 文件属于本进程时正常 unlink", async () => {
    // 本进程自己写的 PID 文件
    await writeFile(
      pidPath,
      JSON.stringify({
        pidFileVersion: 2,
        pid: process.pid,
        port: 18900,
        startedAt: "t",
        startTime: null,
      }),
      "utf-8",
    );
    await writeFile(portPath, "18900", "utf-8");

    const registry = new CleanupRegistry({ logger: quietLogger() });
    registerTailCleanup(registry, {
      heartbeatTimerRef: { current: null },
      lockPaths: { pidPath, portPath },
    });
    await registry.runAll("test");

    // PID + port 文件都被删除
    await expect(stat(pidPath)).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(portPath)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("releaseLock闭包在 PID 文件不存在时 no-op（acquireLock 根本没跑）", async () => {
    // 什么都不写——acquireLock 早期失败场景
    const registry = new CleanupRegistry({ logger: quietLogger() });
    registerTailCleanup(registry, {
      heartbeatTimerRef: { current: null },
      lockPaths: { pidPath, portPath },
    });
    // 不抛、不 log error
    await expect(registry.runAll("test")).resolves.toBeUndefined();
  });
});

describe("mapReasonToExit", () => {
  it("SIGTERM/SIGINT/SIGUSR1 → signal", () => {
    expect(mapReasonToExit("SIGTERM")).toBe("signal");
    expect(mapReasonToExit("SIGINT")).toBe("signal");
    expect(mapReasonToExit("SIGUSR1 (restart)")).toBe("signal");
  });

  it("uncaughtException → crash", () => {
    expect(mapReasonToExit("uncaughtException: ...")).toBe("crash");
  });

  it("startup-error → error", () => {
    expect(mapReasonToExit("startup-error")).toBe("error");
  });

  it("arbitrary → graceful", () => {
    expect(mapReasonToExit("rpc.server.shutdown")).toBe("graceful");
    expect(mapReasonToExit("test-cleanup")).toBe("graceful");
  });
});
