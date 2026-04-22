import { describe, it, expect, vi } from "vitest";
import { runStatusCommand } from "../status.js";

const baseLock = {
  pidFileVersion: 2,
  pid: 12345,
  port: 18900,
  host: "127.0.0.1",
  startedAt: "2026-04-22T10:00:00.000Z",
  startTime: 1000,
  logPath: "/tmp/server.log",
};

function mkDeps(overrides: Parameters<typeof runStatusCommand>[0] extends infer T
  ? T extends { deps?: infer D }
    ? Partial<D>
    : never
  : never = {} as any) {
  return {
    readLockFn: vi.fn(async () => baseLock),
    isProcessAliveFn: vi.fn(() => true),
    httpGetFn: vi.fn(async () => 200),
    readStateFn: vi.fn(async () => ({
      phase: "running" as const,
      pid: 12345,
      startedAt: baseLock.startedAt,
      lastHeartbeat: "2026-04-22T10:10:00.000Z",
      port: 18900,
    })),
    clock: () => new Date("2026-04-22T10:10:30.000Z"),
    console: { log: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("runStatusCommand", () => {
  it("reports stopped when no PID file", async () => {
    const deps = mkDeps({ readLockFn: vi.fn(async () => null) });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("stopped");
  });

  it("reports stale when PID file present but process is dead", async () => {
    const deps = mkDeps({ isProcessAliveFn: vi.fn(() => false) });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("stale");
    expect(r.pid).toBe(12345);
    expect(r.reason).toMatch(/not alive/);
  });

  it("reports running when PID alive + health 200 + heartbeat fresh", async () => {
    const deps = mkDeps();
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("running");
    expect(r.pid).toBe(12345);
    expect(r.port).toBe(18900);
    expect(r.phase).toBe("running");
  });

  it("reports running-unhealthy when health endpoint fails", async () => {
    const deps = mkDeps({ httpGetFn: vi.fn(async () => 500) });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("running-unhealthy");
    expect(r.reason).toMatch(/health/);
  });

  it("reports running-unhealthy when heartbeat stale (>2min old)", async () => {
    const deps = mkDeps({
      clock: () => new Date("2026-04-22T10:15:00.000Z"), // 5min 后
      readStateFn: vi.fn(async () => ({
        phase: "running" as const,
        pid: 12345,
        startedAt: baseLock.startedAt,
        lastHeartbeat: "2026-04-22T10:10:00.000Z", // 5min 前
        port: 18900,
      })),
    });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("running-unhealthy");
    expect(r.reason).toMatch(/heartbeat stale/);
  });

  it("reports running-unhealthy when phase=stopping", async () => {
    const deps = mkDeps({
      readStateFn: vi.fn(async () => ({
        phase: "stopping" as const,
        pid: 12345,
        startedAt: baseLock.startedAt,
        lastHeartbeat: "2026-04-22T10:10:00.000Z",
        port: 18900,
      })),
    });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("running-unhealthy");
    expect(r.reason).toMatch(/stopping/);
  });

  it("reports running-unhealthy when phase=unhealthy", async () => {
    const deps = mkDeps({
      readStateFn: vi.fn(async () => ({
        phase: "unhealthy" as const,
        pid: 12345,
        startedAt: baseLock.startedAt,
        lastHeartbeat: "2026-04-22T10:10:00.000Z",
        port: 18900,
      })),
    });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("running-unhealthy");
  });

  it("reports running when state file missing but PID alive + health OK", async () => {
    // state 文件读失败（null）→ phase 不可知，但 health 200 → 视为 running
    const deps = mkDeps({ readStateFn: vi.fn(async () => null) });
    const r = await runStatusCommand({ deps });
    expect(r.status).toBe("running");
    expect(r.phase).toBeUndefined();
  });

  it("prints JSON when json:true", async () => {
    const log = vi.fn();
    const deps = mkDeps({ console: { log, error: vi.fn() } });
    await runStatusCommand({ json: true, deps });
    expect(log).toHaveBeenCalledOnce();
    const output = log.mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("running");
    expect(parsed.pid).toBe(12345);
  });

  it("computes uptime correctly", async () => {
    const deps = mkDeps();
    const r = await runStatusCommand({ deps });
    // startedAt 10:00:00, clock 10:10:30 → 630s
    expect(r.uptimeSec).toBe(630);
  });
});
