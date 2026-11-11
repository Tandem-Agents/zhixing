import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMaintenanceUrgency } from "@zhixing-ai/core/resources";
import { AuthorityIdleMaintenance, type AuthorityIdleMaintenanceLog } from "./authority-idle-maintenance.js";

afterEach(() => { vi.useRealTimers(); });

/** 每轮有 steps 个原子步的假日志：每一步执行 work；calls 记每轮开始时的中止信号与维护等级。 */
function log(work: (betweenSteps: () => Promise<void>, signal: AbortSignal) => Promise<void> = async () => undefined, steps = 1) {
  const calls: { signal: AbortSignal; urgency: string }[] = [];
  const entry: AuthorityIdleMaintenanceLog & { calls: typeof calls } = {
    calls,
    beginIdleMaintenance(betweenSteps, signal) {
      calls.push({ signal, urgency: currentMaintenanceUrgency() });
      let remaining = steps;
      return {
        async step() {
          if (remaining <= 0) return false;
          remaining--;
          await work(betweenSteps, signal);
          return true;
        },
        finish() {},
      };
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

  it("每轮整理完两本日志后、前台安静时追平一次；追平失败只报告，下一轮照常", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const authority = log(async () => { order.push("authority"); }), executor = log(async () => { order.push("executor"); });
    const quiet = vi.fn(async (_signal: AbortSignal) => { order.push("quiet"); });
    const errors: string[] = [];
    let rounds = 0;
    const afterRound = vi.fn(async (_signal: AbortSignal) => {
      order.push("catch-up");
      if (++rounds === 1) throw new Error("catch-up failed");
    });
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority, executor], whenQuiet: quiet, afterRound,
      onError: (error) => errors.push(error.message), firstDelayMs: 0, intervalMs: 1_000 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["authority", "executor", "quiet", "catch-up"]);
    expect(afterRound.mock.calls[0]![0]).toBe(authority.calls[0]!.signal);
    expect(errors).toEqual(["catch-up failed"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(afterRound).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(["catch-up failed"]);
    await maintenance.stop();
  });

  it("一本日志有多步工作时另一本在其间得到服务：逐步轮转，不等前一本整轮做完", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const authority = log(async () => { order.push("authority"); }, 4), executor = log(async () => { order.push("executor"); }, 2);
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority, executor], whenQuiet: async () => undefined, firstDelayMs: 0 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["authority", "executor", "authority", "executor", "authority", "authority"]);
    await maintenance.stop();
  });

  it("停止后不再起新步：进行中的一步照常做完", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let started = 0;
    const authority = log(() => { started++; return new Promise<void>((resolve) => { release = resolve; }); }, 3);
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority], whenQuiet: async () => undefined, firstDelayMs: 0 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = maintenance.stop();
    release();
    await stopping;
    expect(started).toBe(1);
  });

  it("停止时不再追平", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const authority = log(() => new Promise<void>((resolve) => { release = resolve; }));
    const afterRound = vi.fn(async () => undefined);
    const maintenance = new AuthorityIdleMaintenance({ logs: [authority], whenQuiet: async () => undefined, afterRound, firstDelayMs: 0 });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = maintenance.stop();
    release();
    await stopping;
    expect(afterRound).not.toHaveBeenCalled();
  });
});
