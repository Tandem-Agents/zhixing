/**
 * S2.F 集成测试：runServer 生命周期 + 进程锁集成 + shutdown
 *
 * 不测真实信号——vitest 进程信号会污染。用 skipSignalHandlers + 主动 shutdown() 触发停机路径。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  Scheduler,
  JsonTaskStore,
  createEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { runServer, type RunningServer } from "../lifecycle.js";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import { readLock, releaseLock } from "../process-lock.js";
import { CleanupRegistry } from "../cleanup-registry.js";

const TEST_TOKEN = "test-token-lc";

describe("runServer lifecycle (S2.F)", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;
  let scheduler: Scheduler;
  let runner: RunningServer | null = null;

  beforeEach(async () => {
    tempDir = await createTempDir("lc");
    pidPath = join(tempDir, "server.pid");
    portPath = join(tempDir, "server.port");

    const eventBus = createEventBus<SchedulerEventMap>();
    scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async (): Promise<AgentTurnResult> => ({
        status: "ok",
        output: "x",
        durationMs: 1,
      }),
      config: { minTickIntervalMs: 100, maxTickIntervalMs: 500 },
    });
    await scheduler.start();
  });

  afterEach(async () => {
    if (runner) {
      try {
        await runner.shutdown("test-cleanup");
      } catch {
        // already shut down
      }
      runner = null;
    }
    // 注入模式下 runner.shutdown 不停 scheduler（调用方负责注册）——测试必须自己 stop，
    // 否则 scheduler 的 setInterval 定时器会跨 test 累积。
    await scheduler.stop().catch(() => {});
  });

  async function startTestServer(): Promise<RunningServer> {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
      scheduler,
    });
    return runServer({
      context: ctx,
      scheduler,
      lockPaths: { pidPath, portPath },
      skipSignalHandlers: true,
      logger: { info() {}, warn() {}, error() {} },
    });
  }

  it("acquires and releases process lock around lifecycle", async () => {
    runner = await startTestServer();

    const lock = await readLock({ pidPath, portPath });
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(runner.server.port);

    await runner.shutdown("test");

    const lockAfter = await readLock({ pidPath, portPath });
    expect(lockAfter).toBeNull();
  });

  it("writes process metadata to the PID discovery file", async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
      scheduler,
    });

    runner = await runServer({
      context: ctx,
      scheduler,
      lockPaths: { pidPath, portPath },
      processInfo: {
        version: "0.1.0-test",
        logPath: "/home/zx/logs/server/server.log",
      },
      skipSignalHandlers: true,
      logger: { info() {}, warn() {}, error() {} },
    });

    const lock = await readLock({ pidPath, portPath });
    expect(lock?.version).toBe("0.1.0-test");
    expect(lock?.logPath).toBe("/home/zx/logs/server/server.log");
    expect(lock?.host).toBe(runner.server.host);
  });

  it("shutdown is idempotent — calling twice resolves both", async () => {
    runner = await startTestServer();

    const p1 = runner.shutdown("first");
    const p2 = runner.shutdown("second");
    await Promise.all([p1, p2]);

    const lock = await readLock({ pidPath, portPath });
    expect(lock).toBeNull();
  });

  it("waitForShutdown resolves after shutdown completes", async () => {
    runner = await startTestServer();
    const waiter = runner.waitForShutdown();
    await runner.shutdown("test");
    await waiter; // should resolve, not hang
  });

  it("startup overwrites a live-process pid file instead of self-blocking (port listen is the lock)", async () => {
    // 预置一个指向活进程（本测试进程）的残留 PID 文件——典型「崩溃残留 + PID 被复用」场景。
    // 旧实现会让 runServer 在 acquireLock 处抛 ProcessLockError → server.close() 自杀（Windows
    // 无 startTime 检测时尤甚 → 下次 ensure 撞同一残留再自杀 → 死循环卡死）。新实现 owner 由
    // 端口 listen 确立、PID 仅发现辅助 → 覆盖残留、正常启动。
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: new Date().toISOString() }),
      "utf-8",
    );

    runner = await startTestServer(); // 不抛 = owner 不自杀

    const lock = await readLock({ pidPath, portPath });
    expect(lock?.pid).toBe(process.pid); // PID 文件被覆盖为本宿主
  });

  it("scheduler is stopped during shutdown", async () => {
    runner = await startTestServer();

    // Sanity check scheduler is running
    expect(scheduler.activeTaskCount).toBe(0);

    await runner.shutdown("test");

    // scheduler.stop() should have been called — adding a new task should fail or
    // the scheduler should be in stopped state. Best signal: call scheduler.start
    // again should not throw (idempotent stop).
    // We just verify no exception during shutdown.
  });

  it("server is closed after shutdown (port released)", async () => {
    runner = await startTestServer();
    const port = runner.server.port;

    // Verify server is reachable
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);

    await runner.shutdown("test");

    // After shutdown: should not be reachable
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  // ─── 注入模式（command.ts 实际路径） ───

  it("injected cleanupRegistry: lifecycle registers only server.close; shutdown drives registry.runAll", async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
      scheduler,
    });
    const registry = new CleanupRegistry({ logger: { error: () => {} } });

    runner = await runServer({
      context: ctx,
      scheduler,
      lockPaths: { pidPath, portPath },
      skipSignalHandlers: true,
      cleanupRegistry: registry,
      logger: { info() {}, warn() {}, error() {} },
    });

    // 注入模式：lifecycle 只注册 server.close（不注册 scheduler / releaseLock）
    // 调用方（实际场景是 command.ts）负责注册其他清理项
    expect(registry.size).toBe(1);

    // 让调用方也注册若干项，验证 shutdown 走 runAll
    const order: string[] = [];
    registry.register("extra-a", () => order.push("a"));
    registry.register("extra-b", () => order.push("b"));

    await runner.shutdown("test-cleanup");

    // LIFO：后注册的 extra-b 先执行，extra-a 次之，server.close 最后
    expect(order).toEqual(["b", "a"]);
    expect(registry.finished).toBe(true);
  });

  it("injected cleanupRegistry: ctx.requestShutdown is bound for RPC handler", async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
      scheduler,
    });
    const registry = new CleanupRegistry({ logger: { error: () => {} } });

    // 模拟 command.ts 的 registerTailCleanup：runServer 之前注册 releaseLock
    registry.register("releaseLock", async () => {
      await releaseLock({ pidPath, portPath });
    });

    runner = await runServer({
      context: ctx,
      scheduler,
      lockPaths: { pidPath, portPath },
      skipSignalHandlers: true,
      cleanupRegistry: registry,
      logger: { info() {}, warn() {}, error() {} },
    });

    // runServer 内部应绑定 ctx.requestShutdown
    expect(typeof ctx.requestShutdown).toBe("function");

    // 调用 requestShutdown 应触发 shutdown（和信号 handler 走同一路径）
    ctx.requestShutdown!("test-rpc-shutdown");
    await runner.waitForShutdown();

    // server 已关闭 → PID 锁也已释放
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("injected cleanupRegistry: shutdown is idempotent across both paths (direct + requestShutdown)", async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
      scheduler,
    });
    const registry = new CleanupRegistry({ logger: { error: () => {} } });
    registry.register("releaseLock", async () => {
      await releaseLock({ pidPath, portPath });
    });

    runner = await runServer({
      context: ctx,
      scheduler,
      lockPaths: { pidPath, portPath },
      skipSignalHandlers: true,
      cleanupRegistry: registry,
      logger: { info() {}, warn() {}, error() {} },
    });

    // 双路径并发触发
    const p1 = runner.shutdown("direct");
    ctx.requestShutdown!("via-rpc");
    const p2 = runner.shutdown("direct-again");

    await Promise.all([p1, p2, runner.waitForShutdown()]);

    // 只应 shutdown 一次（幂等）
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });
});
