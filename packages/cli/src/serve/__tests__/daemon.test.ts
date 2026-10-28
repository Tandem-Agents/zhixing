/**
 * Daemon spawn + startup handshake 单测。
 *
 * 全量 mock：spawnFn / readLockFn / isProcessAliveFn / httpGetFn /
 * clock / sleep / console / readLogsFn。不真的 spawn 子进程、不真的写磁盘、不打真网络。
 *
 * 覆盖路径：
 * 1. Happy path：spawn 成功 + PID 立即出现 + health 200 → ok:true
 * 2. Handshake 超时（PID 永不出现）→ ok:false
 * 3. Handshake 超时（PID 有但进程死）→ ok:false，具体原因
 * 4. Handshake 超时（PID 活但 health 挂）→ ok:false，具体原因
 * 5. UnsupportedSelfExecError → ok:false，不 spawn
 */

import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import { spawnDaemon } from "../daemon.js";
import { DEFAULT_LOG_POLICY, LogRecorder, type LogCapture, type LogDraft, type LogRecordPort, type LogSink, type LogStatus } from "@zhixing/core/logging";
import { RUNTIME_LOG_SOURCE } from "../../logging/runtime-source.js";

// 不作为 child 识别，避免 resolveSelfExec 受父进程 env 影响
const baseEnv = { HOME: "/h", PATH: "/bin" };

function makeFakeChild(pid = 99999) {
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const child = {
    unref: vi.fn(),
    pid,
    once: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === "exit") exitHandlers.push(handler);
      return child;
    }),
    emitExit(code: number | null = 1, signal: NodeJS.Signals | null = null) {
      for (const handler of exitHandlers) handler(code, signal);
    },
  } as any;
  return child;
}

function makeDeps(overrides: Partial<Parameters<typeof spawnDaemon>[0]["deps"]> = {}) {
  return {
    spawnFn: vi.fn(() => makeFakeChild()),
    clock: mkFakeClock(),
    sleep: vi.fn(async () => {}),
    console: { log: vi.fn(), error: vi.fn() },
    readLogsFn: vi.fn(async () => ({ records: [] })),
    checkReadyMarkerFn: vi.fn(async () => true), // 默认认为 ready marker 存在
    readRestrictionFn: vi.fn(async () => undefined), // 默认没有受限状态标记，不读任何真实 home
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
  const recordingRuntime = () => {
    const stored: LogCapture[] = [];
    const status = (): LogStatus => ({ layout: "zxlog/1", storeId: "synthetic-daemon-exit",
      policy: { version: 1, effective: DEFAULT_LOG_POLICY }, bytes: 0, files: 0, retainedSegments: 0,
      pendingReclaims: 0, overdue: false, upper: 0 });
    const sink: LogSink = { initialize: async () => status(), maintain: async () => status(), close: async () => {},
      append: async records => { stored.push(...structuredClone(records)); return status(); } };
    const recorder = new LogRecorder(sink);
    return { stored, recorder, records: recorder.bind(RUNTIME_LOG_SOURCE, { scope: "storage" }) };
  };

  it.each([
    { code: 0, signal: null, mode: "on-demand", event: "childExited", result: "failure", data: { pid: 99999, exitCode: 0 } },
    { code: 19, signal: null, mode: "on-demand", event: "childExited", result: "failure", data: { pid: 99999, exitCode: 19 } },
    { code: null, signal: "SIGTERM", mode: "on-demand", event: "childExited", result: "failure", data: { pid: 99999, signal: "SIGTERM" } },
    { code: 0, signal: null, mode: "managed", event: "coordinatorExited", result: "success", data: { pid: 99999, exitCode: 0, launchMode: "managed" } },
  ] as const)("captures real exit fields through the strict recorder ($mode/$code/$signal)", async sample => {
    const { stored, recorder, records } = recordingRuntime();
    const clock = mkFakeClock(), child = Object.assign(new EventEmitter(), { pid: 99999, unref() {} });
    try {
      await spawnDaemon({ records, automatic: true, forwardedArgs: ["serve"], deadlineAt: 10000, reportFailure: false,
        deps: makeDeps({ clock, spawnFn: () => child as any,
          readLockFn: async () => clock() >= 4000 ? { pid: 55555, port: 23456 } as any : null,
          isProcessAliveFn: () => true, httpGetFn: async () => 200,
          sleep: async ms => {
            clock.advance(ms);
            if (clock() === 200) { child.emit("message", { type: "host-launch-plan", mode: sample.mode }); child.emit("exit", sample.code, sample.signal); }
          },
        }) });
      await recorder.flush();
      const exits = stored.filter(value => value.record.event === sample.event);
      expect(exits).toHaveLength(1);
      expect(exits[0]!.record).toMatchObject({ result: sample.result, data: sample.data });
      expect(exits[0]!.record.data).toEqual(sample.data);
      expect(exits[0]!.record.refs).toEqual(stored.find(value => value.record.event === "hostSpawnRequested")!.record.refs);
      expect(recorder.health().captureFailures).toBe(0);
      expect(stored.some(value => value.record.event === "degraded")).toBe(false);
    } finally { await recorder.close(); }
  });

  it("keeps rejecting null exit scalars in the actual runtime schema", async () => {
    const { stored, recorder, records } = recordingRuntime();
    try {
      records.record({ event: "childExited", data: { pid: 99999, exitCode: 0, signal: null } });
      records.record({ event: "childExited", data: { pid: 99999, exitCode: null, signal: "SIGTERM" } });
      await recorder.flush();
      expect(recorder.health().captureFailures).toBe(2);
      expect(stored.some(value => value.record.event === "childExited")).toBe(false);
      expect(stored).toContainEqual(expect.objectContaining({ record: expect.objectContaining({ event: "degraded",
        data: expect.objectContaining({ reason: "capture-failed", captureFailures: 2 }) }) }));
    } finally { await recorder.close(); }
  });

  it.each([false, true])("retains spawn failure evidence without pretending a child started (sync=%s)", async synchronous => {
    const entries: LogDraft[] = [];
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
    const error = Object.assign(Error("private executable path"), { code: "ENOENT" });
    const clock = mkFakeClock();
    const result = spawnDaemon({ forwardedArgs: ["serve"], reportFailure: false, deadlineAt: 5000,
      records: { record: value => { entries.push(typeof value === "function" ? value() : value); } },
      deps: makeDeps({ clock, readLockFn: async () => null, sleep: async ms => { clock.advance(ms); },
        spawnFn: () => { if (synchronous) throw error; queueMicrotask(() => child.emit("error", error)); return child as any; } }),
    });
    if (synchronous) await expect(result).rejects.toBe(error);
    else expect(await result).toMatchObject({ status: "failed" });
    expect(entries).toContainEqual(expect.objectContaining({ event: "hostSpawnFailed", result: "failure", data: { failure: { category: "system", code: "ENOENT" } } }));
    expect(entries.some(item => item.event === "hostSpawned")).toBe(false);
    expect(JSON.stringify(entries)).not.toContain("private executable path");
  });

  it.each((["managed", "on-demand", "none"] as const).flatMap(mode => [false, true].map(delegated => ({ mode, delegated }))))("honors the child launch plan $mode within the original deadline (delegated=$delegated)", async ({ mode, delegated }) => {
    const events: LogDraft[] = [];
    const records: LogRecordPort = { record: value => { events.push(typeof value === "function" ? value() : value); } };
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn() });
    const deps = makeDeps({
      clock,
      spawnFn: vi.fn(() => child as any),
      sleep: async ms => {
        clock.advance(ms);
        if (clock() === 200) {
          child.emit("message", { type: "host-launch-plan", mode });
          if (mode !== "on-demand") child.emit("exit", 0, null);
        }
      },
      // Managed handoff takes longer than the exited-child grace period.
      readLockFn: async () => clock() >= 4000 ? { pid: 55555, port: 23456 } as any : null,
      isProcessAliveFn: () => true,
      httpGetFn: async () => 200,
    });
    const startAutomatic = vi.fn(async () => child);
    const result = await spawnDaemon({ records, automatic: true, forwardedArgs: ["serve"], deadlineAt: 10_000, reportFailure: false, deps,
      ...(delegated ? { startAutomatic: startAutomatic as any } : {}) });
    if (delegated) { expect(startAutomatic).toHaveBeenCalledWith(expect.any(String), 10_000, undefined); expect(deps.spawnFn).not.toHaveBeenCalled(); }
    expect(events.some(event => event.result === "failure")).toBe(false);
    if (mode === "managed") {
      expect(events).toContainEqual(expect.objectContaining({ event: "coordinatorExited", result: "success" }));
      const ready = events.find(event => event.event === "hostReady")!;
      expect(ready.data).toMatchObject({ pid: 55555, spawnedPid: 99999 });
      expect(ready.refs).toEqual(events.find(event => event.event === "hostSpawnRequested")!.refs);
    }
    expect(result).toMatchObject({ ok: mode !== "none", launchMode: mode });
    if (mode === "none") expect(result.reason).toBe("这台设备不需要后台运行");
    else expect(result).toMatchObject({ status: "ready", pid: 55555 });
    if (!delegated) expect(deps.spawnFn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["serve", "--auto-start"]), expect.objectContaining({ windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
    expect(child.listenerCount("message")).toBe(0);
  });

  it("returns the spawned host's device restriction at once instead of waiting for the readiness deadline", async () => {
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref: vi.fn() });
    let marker: { pid: number; startTime: number | null; publishedAt: number; restriction: { kind: "removal-retrieving" } } | undefined;
    const result = await spawnDaemon({ automatic: true, forwardedArgs: ["serve"], deadlineAt: 60_000, reportFailure: false, deps: makeDeps({
      clock, spawnFn: () => child as any, readLockFn: async () => null,
      // 宿主在第二轮轮询前写下“取回中”：它拥有这个 home，但不提供普通服务（出生时间读不到时按本次子进程认）
      readRestrictionFn: async () => marker,
      sleep: async ms => { clock.advance(ms); marker ??= { pid: 4321, startTime: null, publishedAt: clock(), restriction: { kind: "removal-retrieving" } }; },
    }) });
    expect(result).toMatchObject({ ok: false, status: "restricted", restriction: { kind: "removal-retrieving" } });
    expect(result.reason).toContain("正在联系值班设备");
    expect(clock()).toBeLessThan(1_000);
  });

  it("ignores another process's stale restriction and does not spawn a second host while retrieval is live", async () => {
    const stale = await spawnDaemon({ forwardedArgs: ["serve"], deadlineAt: 10_000, reportFailure: false, deps: makeDeps({
      readRestrictionFn: async () => ({ pid: 1111, startTime: 5, publishedAt: -30_000, restriction: { kind: "removed" } }),
      readLockFn: async () => ({ pid: 99999, port: 3000 } as any), isProcessAliveFn: () => true, httpGetFn: async () => 200,
    }) });
    expect(stale).toMatchObject({ ok: true, status: "ready" });
    const retrieving = { pid: 2222, startTime: 77, publishedAt: -1_000, restriction: { kind: "removal-retrieving" } } as const;
    const spawnFn = vi.fn(() => makeFakeChild());
    const live = await spawnDaemon({ automatic: true, forwardedArgs: ["serve"], deadlineAt: 10_000, reportFailure: false, deps: makeDeps({
      spawnFn, readRestrictionFn: async () => retrieving,
      readProcessBirthFn: async (pid: number) => pid === 2222 ? { kind: "present", startTime: 77 } : { kind: "absent" },
    }) });
    expect(live).toMatchObject({ ok: false, status: "restricted", restriction: { kind: "removal-retrieving" } });
    expect(spawnFn).not.toHaveBeenCalled();
    // PID 被别的进程复用（出生时间不同）或读不到出生时间：不冒称正在取回，照常拉起
    for (const birth of [{ kind: "present", startTime: 78 }, { kind: "unknown" }] as const) {
      const reused = vi.fn(() => makeFakeChild());
      await spawnDaemon({ forwardedArgs: ["serve"], deadlineAt: 10_000, reportFailure: false, deps: makeDeps({
        spawnFn: reused, readRestrictionFn: async () => retrieving, readProcessBirthFn: async () => birth,
        readLockFn: async () => ({ pid: 99999, port: 3000 } as any), isProcessAliveFn: () => true, httpGetFn: async () => 200,
      }) });
      expect(reused).toHaveBeenCalledOnce();
    }
  });

  it("recognizes the restriction of the real managed host after the launch coordinator exits", async () => {
    const run = async (marker: { pid: number; startTime: number | null; publishedAt: number }) => {
      const clock = mkFakeClock();
      const child = Object.assign(new EventEmitter(), { pid: 90001, unref: vi.fn() });
      let published: unknown;
      return spawnDaemon({ automatic: true, forwardedArgs: ["serve"], deadlineAt: 3_000, reportFailure: false, deps: makeDeps({
        clock, spawnFn: () => child as any, readLockFn: async () => null, readRestrictionFn: async () => published as never,
        sleep: async ms => {
          clock.advance(ms);
          if (!published) {
            // 协调者交给系统服务后正常退出；真正宿主 90002 随后发布受限
            child.emit("message", { type: "host-launch-plan", mode: "managed" }); child.emit("exit", 0, null);
            published = { ...marker, restriction: { kind: "removed-lost", cleanup: "not-started" } };
          }
        },
      }) });
    };
    expect(await run({ pid: 90002, startTime: 150, publishedAt: 190 })).toMatchObject({ ok: false, status: "restricted", restriction: { kind: "removed-lost" } });
    // 出生早于本次拉起的旧宿主留下的标记、出生时间未知且不是本次子进程的标记：都不当作本次结果
    expect(await run({ pid: 90002, startTime: -50_000, publishedAt: -40_000 })).toMatchObject({ ok: false, status: "starting" });
    expect(await run({ pid: 90002, startTime: null, publishedAt: 190 })).toMatchObject({ ok: false, status: "starting" });
  });

  it("does not treat a failed managed coordinator as a successful handoff", async () => {
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn() });
    const result = await spawnDaemon({ automatic: true, forwardedArgs: ["serve"], deadlineAt: 10_000, reportFailure: false, deps: makeDeps({
      clock, spawnFn: () => child as any, readLockFn: async () => null,
      sleep: async ms => {
        clock.advance(ms);
        if (clock() === 200) {
          child.emit("message", { type: "host-launch-plan", mode: "managed" });
          child.emit("exit", 1, null);
        }
      },
    }) });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(result.reason).toContain("退出码 1");
    expect(clock()).toBeLessThan(3000);
  });

  it("observes a real process exiting after five seconds without a blind recovery wait", async () => {
    const started = Date.now();
    const result = await spawnDaemon({
      forwardedArgs: ["serve"], deadlineAt: started + 30_000, reportFailure: false,
      deps: {
        spawnFn: () => spawnProcess(process.execPath, ["-e", "setTimeout(() => process.exit(19), 5100)"], { stdio: "ignore", windowsHide: true }),
        readLockFn: async () => null,
        console: { log: vi.fn(), error: vi.fn() },
      },
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(result.reason).toContain("退出码 19");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 12_000);

  it("observes exit after the old handshake window and releases the attempt without querying discarded logs", async () => {
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn() });
    const deps = makeDeps({
      clock,
      spawnFn: vi.fn(() => child as any),
      sleep: async (ms) => {
        clock.advance(ms);
        if (clock() === 6000) child.emit("exit", 19, null);
      },
      readLockFn: async () => null,
    });
    const result = await spawnDaemon({ forwardedArgs: ["serve"], deadlineAt: 30000, reportFailure: false, deps });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(result.reason).toContain("退出码 19");
    expect(clock()).toBe(7000);
    expect(deps.readLogsFn).not.toHaveBeenCalled();
    expect(child.listenerCount("exit") + child.listenerCount("error")).toBe(0);
  });

  it("accepts a healthy concurrent owner after the spawned process exits", async () => {
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn() });
    const result = await spawnDaemon({
      forwardedArgs: ["serve"], deadlineAt: 30000, reportFailure: false,
      deps: makeDeps({
        clock, spawnFn: () => child as any,
        sleep: async (ms) => { clock.advance(ms); if (clock() === 6000) child.emit("exit", 1, null); },
        readLockFn: async () => clock() < 6400 ? null : { pid: 12345, port: 18900, startedAt: "t" },
        isProcessAliveFn: () => true, httpGetFn: async () => 200,
      }),
    });
    expect(result).toMatchObject({ ok: true, pid: 12345 });
    expect(clock()).toBe(6400);
  });

  it("keeps waiting for a live concurrent owner that becomes ready well after the spawned process yields", async () => {
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn() });
    const result = await spawnDaemon({
      forwardedArgs: ["serve"], deadlineAt: 30000, reportFailure: false,
      deps: makeDeps({
        clock, spawnFn: () => child as any,
        sleep: async (ms) => { clock.advance(ms); if (clock() === 6000) child.emit("exit", 1, null); },
        readLockFn: async () => clock() < 6400 ? null : { pid: 12345, port: 18900, startedAt: "t" },
        checkReadyMarkerFn: async () => clock() >= 9000,
        isProcessAliveFn: () => true, httpGetFn: async () => 200,
      }),
    });
    expect(result).toMatchObject({ ok: true, pid: 12345 });
    expect(clock()).toBe(9000);
  });

  it("does not wait on a concurrent owner whose process is gone", async () => {
    const clock = mkFakeClock();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn() });
    const result = await spawnDaemon({
      forwardedArgs: ["serve"], deadlineAt: 30000, reportFailure: false,
      deps: makeDeps({
        clock, spawnFn: () => child as any,
        sleep: async (ms) => { clock.advance(ms); if (clock() === 6000) child.emit("exit", 1, null); },
        readLockFn: async () => ({ pid: 12345, port: 18900, startedAt: "t" }),
        checkReadyMarkerFn: async () => false,
        isProcessAliveFn: (pid) => pid !== 12345, httpGetFn: async () => 200,
      }),
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(clock()).toBeLessThan(8000);
  });

  it("cancels observation without killing the shared host or leaving child listeners", async () => {
    const abort = new AbortController();
    const child = Object.assign(new EventEmitter(), { pid: 99999, unref: vi.fn(), kill: vi.fn() });
    await expect(spawnDaemon({
      forwardedArgs: ["serve"], signal: abort.signal, reportFailure: false,
      deps: makeDeps({ spawnFn: () => child as any, readLockFn: async () => null, sleep: async () => abort.abort() }),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("exit") + child.listenerCount("error")).toBe(0);
  });

  it("binds logs, child environment and handshake to one home before asynchronous preparation", async () => {
    const home = path.resolve("daemon-home-a");
    const other = path.resolve("daemon-home-b");
    const deps = makeDeps({
      spawnFn: vi.fn(() => { vi.stubEnv("ZHIXING_HOME", other); return makeFakeChild(); }),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 200),
    });
    try {
      const result = await spawnDaemon({ zhixingHome: home, forwardedArgs: ["serve"], deps });
      expect(result.ok).toBe(true);
      expect(result.logPath).toBe(path.join(home, "logs", "runtime"));
      expect(deps.spawnFn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
        expect.objectContaining({ env: expect.objectContaining({ ZHIXING_HOME: home }) }));
      expect(deps.readLockFn).toHaveBeenCalledWith({
        pidPath: path.join(home, "server.pid"),
        portPath: path.join(home, "server.port"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
      handshakeTimeoutMs: 5000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(true);
    expect(r.pid).toBe(12345);
    expect(r.port).toBe(18900);
    expect(deps.spawnFn).toHaveBeenCalledOnce();
  });

  it("keeps daemon stdio out of private files", async () => {
    const deps = makeDeps({ readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })), isProcessAliveFn: vi.fn(() => true), httpGetFn: vi.fn(async () => 200) });
    const result = await spawnDaemon({ zhixingHome: path.resolve("isolated-home"), forwardedArgs: ["serve"], deps });
    expect(result.ok).toBe(true);
    expect(deps.spawnFn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ stdio: "ignore" }));
    expect(result.logPath).toBe(path.resolve("isolated-home/logs/runtime"));
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
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe("starting");
    expect(r.reason).toContain("暂未进入可连接状态");
  });

  it("fails when child pid is no longer alive", async () => {
    const clock = mkFakeClock();
    const child = makeFakeChild(12345);
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      spawnFn: vi.fn(() => child),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "t" })),
      isProcessAliveFn: vi.fn(() => false),
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("已退出");
  });

  it("treats stale PID from an old process as starting, not child failure", async () => {
    const clock = mkFakeClock();
    const child = makeFakeChild(99999);
    const deps = makeDeps({
      clock,
      sleep: vi.fn(async () => clock.advance(200)),
      spawnFn: vi.fn(() => child),
      readLockFn: vi.fn(async () => ({ pid: 12345, port: 18900, startedAt: "old" })),
      isProcessAliveFn: vi.fn(() => false),
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe("starting");
    expect(r.reason).toContain("旧的服务状态已失效");
    expect(r.reason).not.toContain("12345 在就绪前退出");
  });

  it("fails when spawned child exits and no healthy service appears", async () => {
    const clock = mkFakeClock();
    const child = makeFakeChild(99999);
    const deps = makeDeps({
      clock,
      spawnFn: vi.fn(() => child),
      sleep: vi.fn(async () => {
        child.emitExit(1, null);
        clock.advance(200);
      }),
      readLockFn: vi.fn(async () => null),
      isProcessAliveFn: vi.fn(() => true),
      httpGetFn: vi.fn(async () => 200),
    });

    const r = await spawnDaemon({
      forwardedArgs: ["serve"],
      handshakeTimeoutMs: 2000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("99999");
    expect(r.reason).toContain("没有发现可用服务");
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
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe("starting");
    expect(r.reason).toContain("暂未进入可连接状态");
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
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(r.ok).toBe(false);
    expect(r.status).toBe("starting");
    expect(r.reason).toContain("暂时还不能连接");
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
      handshakeTimeoutMs: 1000,
      pollIntervalMs: 200,
      deps,
    });

    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("does NOT spawn when resolveSelfExec fails (bundled binary scenario)", async () => {
    // 把 argv 改成非 .js 以触发 UnsupportedSelfExecError
    const origArgv = process.argv;
    process.argv = [process.execPath, "/opt/bundled-bin"];
    try {
      const deps = makeDeps();
      const r = await spawnDaemon({
        forwardedArgs: ["serve"],
        handshakeTimeoutMs: 100,
        pollIntervalMs: 50,
        deps,
      });

      expect(r.ok).toBe(false);
      expect(r.reason).toContain("Cannot resolve the physical CLI entry for self-exec");
      expect(deps.spawnFn).not.toHaveBeenCalled();
    } finally {
      process.argv = origArgv;
    }
  });
});
