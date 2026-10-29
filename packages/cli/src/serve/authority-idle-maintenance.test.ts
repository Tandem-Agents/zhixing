import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMaintenanceUrgency } from "@zhixing/core/resources";
import { AuthorityIdleMaintenance, type AuthorityIdleMaintenanceLog } from "./authority-idle-maintenance.js";

afterEach(() => { vi.useRealTimers(); });

function log(work: (betweenSteps: () => Promise<void>, signal: AbortSignal) => Promise<void> = async () => undefined) {
  const calls: { signal: AbortSignal; urgency: string }[] = [];
  const entry: AuthorityIdleMaintenanceLog & { calls: typeof calls } = {
    calls,
    async maintainIdleProjections(betweenSteps, signal) {
      calls.push({ signal, urgency: currentMaintenanceUrgency() });
      await work(betweenSteps, signal);
    },
  };
  return entry;
}

describe("授权投影空闲维护调度", () => {
  it("首轮延迟后以后台等级依次维护两本日志，此后按周期续跑", async () => {
    vi.useFakeTimers();
    const authority = log(), executor = log();
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority, executor], whenQuiet: async () => undefined,
      firstDelayMs: 1_000, intervalMs: 5_000 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(authority.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(authority.calls.map((call) => call.urgency)).toEqual(["background"]);
    expect(executor.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(authority.calls).toHaveLength(2);
    await maintenance.stop();
  });

  it("每一步之前等待前台安静，闸门收到的是本次维护的中止信号", async () => {
    vi.useFakeTimers();
    const quiet = vi.fn(async (_signal: AbortSignal) => undefined);
    const authority = log(async (betweenSteps) => { await betweenSteps(); await betweenSteps(); });
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority], whenQuiet: quiet, firstDelayMs: 0 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(quiet).toHaveBeenCalledTimes(2);
    expect(quiet.mock.calls[0]![0]).toBe(authority.calls[0]!.signal);
    await maintenance.stop();
  });

  it("停止时中止进行中的维护、等它停下才返回，之后不再发起", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let observed: AbortSignal | undefined;
    const authority = log((_betweenSteps, signal) => {
      observed = signal;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority], whenQuiet: async () => undefined,
      firstDelayMs: 0, intervalMs: 10 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = maintenance.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed?.aborted).toBe(true);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(authority.calls).toHaveLength(1);
  });

  it("维护失败只上报，下一个周期照常续跑", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let attempt = 0;
    const authority = log(async () => { if (attempt++ === 0) throw new Error("capacity busy"); });
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority], whenQuiet: async () => undefined,
      firstDelayMs: 0, intervalMs: 100, onError: (error) => errors.push(error.message) });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(["capacity busy"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(authority.calls).toHaveLength(2);
    expect(errors).toEqual(["capacity busy"]);
    await maintenance.stop();
  });
});
