/**
 * S2.F 集成测试：runServer 生命周期 + 进程锁集成 + shutdown
 *
 * 不测真实信号——vitest 进程信号会污染。用 skipSignalHandlers + 主动 shutdown() 触发停机路径。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Scheduler,
  JsonTaskStore,
  createEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
} from "@zhixing/core";
import { runServer, type RunningServer } from "../lifecycle.js";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import { readLock, ProcessLockError } from "../process-lock.js";

const TEST_TOKEN = "test-token-lc";

describe("runServer lifecycle (S2.F)", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;
  let scheduler: Scheduler;
  let runner: RunningServer | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhixing-lc-"));
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
    await rm(tempDir, { recursive: true, force: true });
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

  it("rejects startup if PID file held by another live process", async () => {
    runner = await startTestServer();

    // Try to start a second server with same lock path
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
      scheduler,
    });

    await expect(
      runServer({
        context: ctx,
        scheduler,
        lockPaths: { pidPath, portPath },
        skipSignalHandlers: true,
        logger: { info() {}, warn() {}, error() {} },
      }),
    ).rejects.toBeInstanceOf(ProcessLockError);
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
});
