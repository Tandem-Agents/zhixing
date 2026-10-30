import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createDefaultDeviceCapacityPolicy } from "@zhixing/core/resources";
import { createDeviceCapacityRuntime as createRuntime } from "./device-capacity-runtime.js";
import { diskSampleCount, threadDiskSampler, writeDiskSample, type DiskSamplerStarter } from "./disk-pressure-sampler.js";
import { beginRuntimeLogging } from "../logging/runtime.js";

const runtimes: ReturnType<typeof createRuntime>[] = [];
function createDeviceCapacityRuntime(...args: Parameters<typeof createRuntime>) {
  const runtime = createRuntime(...args); runtimes.push(runtime); return runtime;
}
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); vi.restoreAllMocks(); });
const budget = {
  occupancy: { memoryReservationBytes: 1, temporaryBytes: 1, slots: 1 },
  quantum: { readBytes: 1, writeBytes: 1, ioOperations: 1 },
};
const read = { occupancy: { memoryReservationBytes: 1, temporaryBytes: 0, slots: 1 }, quantum: { readBytes: 1, writeBytes: 0, ioOperations: 1 } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 由用例决定何时写入样本的采样替身。 */
function manualSampler() {
  let cells: BigInt64Array | undefined;
  let sampled: (() => void) | undefined;
  const counts = { starts: 0, stops: 0 };
  const starter: DiskSamplerStarter = (shared, _options, wake) => {
    cells = shared; sampled = wake; counts.starts++;
    return { stop() { counts.stops++; } };
  };
  return {
    starter, counts,
    sample: () => { writeDiskSample(cells!, { bavail: 1024 * 1024, bsize: 4096 }); sampled!(); },
    fail: () => { writeDiskSample(cells!, undefined); sampled!(); },
  };
}

/** 真实采样线程，同时把共享单元交给用例观察采样次数。 */
function observedThreadSampler() {
  const observed: { cells?: BigInt64Array } = {};
  const starter: DiskSamplerStarter = (shared, options, sampled) => { observed.cells = shared; return threadDiskSampler(shared, options, sampled); };
  return { starter, observed, count: () => observed.cells ? diskSampleCount(observed.cells) : 0 };
}

describe("device capacity disk sampling", () => {
  it("keeps the disk sample fresh while the main thread is blocked longer than the freshness window", async () => {
    const home = await createTempDir("capacity-blocked-loop");
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false });
    const request = { admissionId: "blocked-loop", serviceClass: "storage-foreground" as const, atomic: budget, preferred: budget, maxWaitMs: 0 };
    await vi.waitFor(async () => {
      const ready = await runtime.arbiter.acquire(request, new AbortController().signal);
      if (ready.kind !== "granted") throw Error("disk sample not ready yet");
      ready.permit.release();
    }, { timeout: 5_000, interval: 20 });
    // 主线程整段占满，长于 250ms 新鲜度窗口：采样在独立线程里照常进行
    const until = performance.now() + 600;
    while (performance.now() < until) { /* 模拟繁忙的事件循环 */ }
    const admitted = await runtime.arbiter.acquire({ ...request, admissionId: "after-blocked-loop" }, new AbortController().signal);
    expect(admitted.kind).toBe("granted");
    if (admitted.kind === "granted") admitted.permit.release();
  });

  it("keeps the Host default sampling across unrelated owner recovery prefixes", async () => {
    const home = await createTempDir("capacity-host-default");
    const logging = beginRuntimeLogging(home, "on-demand");
    try {
      await sleep(750);
      const admission = await logging.capacity.arbiter.acquire({ admissionId: "host-slow-prefix", serviceClass: "storage-recovery", atomic: budget, preferred: budget, maxWaitMs: 0 }, new AbortController().signal);
      expect(admission.kind).toBe("granted");
      if (admission.kind === "granted") admission.permit.release();
    } finally { await logging.finish("success", "host-prefix-complete", 1000); }
  });

  it("samples only while active when activity-driven and covers an outstanding permit", async () => {
    const home = await createTempDir("capacity-activity");
    const disk = observedThreadSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, activityDriven: true, diskSampler: disk.starter });
    await sleep(300);
    expect(disk.observed.cells).toBeUndefined();
    const finishPrefix = runtime.retainActivity();
    await vi.waitFor(() => expect(disk.count()).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
    const admission = await runtime.arbiter.acquire({ admissionId: "owned-prefix", serviceClass: "storage-recovery", atomic: budget, preferred: budget, maxWaitMs: 250 }, new AbortController().signal);
    if (admission.kind !== "granted") throw Error("Expected admission");
    finishPrefix();
    // 前缀结束后，未释放的许可仍算活动
    const active = disk.count();
    await sleep(300);
    expect(disk.count()).toBeGreaterThan(active);
    const step = admission.permit.tryBegin(budget); expect(step).toBeDefined(); step!.complete();
    admission.permit.release();
    await sleep(200);
    const idle = disk.count();
    await sleep(350);
    expect(disk.count()).toBe(idle);
    expect(runtime.arbiter.snapshot().occupancyCapacity.temporaryBytes).toBe(0);
  });

  it("shares an entry's existing capacity without closing it when its logger drains", async () => {
    const home = await createTempDir("capacity-shared-owner");
    const capacity = createDeviceCapacityRuntime(home, { createDirectory: false });
    const close = vi.spyOn(capacity, "close");
    const logging = beginRuntimeLogging(home, "probe-shared", undefined, undefined, capacity);
    expect(logging.capacity).toBe(capacity);
    await logging.finish("success", "logger-drained", 1000);
    expect(close).not.toHaveBeenCalled();
    const result = await capacity.arbiter.acquire({ admissionId: "owner-after-logger", serviceClass: "storage-recovery", atomic: budget, preferred: budget, maxWaitMs: 250 }, new AbortController().signal);
    expect(result.kind).toBe("granted");
    if (result.kind === "granted") result.permit.release();
  }, 5000);

  it("keeps cold zero-wait requests nonblocking and a cancelled wait returns at once", async () => {
    const home = await createTempDir("capacity-cold");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, diskSampler: disk.starter });
    const request = { admissionId: "cold-1", serviceClass: "storage-background" as const, atomic: budget, preferred: budget, maxWaitMs: 0 };
    expect(await runtime.arbiter.acquire(request, new AbortController().signal)).toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
    expect(runtime.arbiter.snapshot().occupancyCapacity.temporaryBytes).toBe(0);
    const abort = new AbortController();
    const waiting = runtime.arbiter.acquire({ ...request, admissionId: "cold-2", maxWaitMs: 250 }, abort.signal);
    abort.abort();
    expect((await waiting).kind).toBe("cancelled");
    disk.sample();
    const ready = await runtime.arbiter.acquire({ ...request, admissionId: "cold-3" }, new AbortController().signal);
    expect(ready.kind).toBe("granted");
    if (ready.kind === "granted") ready.permit.release();
    expect(disk.counts.starts).toBe(1);
  });

  it("wakes a waiting request as soon as a sample arrives, without advancing timers", async () => {
    const home = await createTempDir("capacity-wake");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, diskSampler: disk.starter });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      const waiting = runtime.arbiter.acquire({ admissionId: "wake", serviceClass: "storage-foreground",
        atomic: budget, preferred: budget, maxWaitMs: 1_000 }, new AbortController().signal);
      await Promise.resolve();
      disk.sample();
      const admitted = await waiting;
      expect(admitted.kind).toBe("granted");
      if (admitted.kind === "granted") admitted.permit.release();
    } finally { vi.useRealTimers(); }
  });

  it("admits zero-wait reads that reserve no temporary space while the disk sample is stale", async () => {
    const home = await createTempDir("capacity-stale");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, diskSampler: disk.starter });
    disk.sample();
    await sleep(300);
    const admitted = await runtime.arbiter.acquire({ admissionId: "stale-read", serviceClass: "storage-foreground",
      atomic: read, preferred: read, maxWaitMs: 0 }, new AbortController().signal);
    expect(admitted.kind).toBe("granted");
    if (admitted.kind === "granted") admitted.permit.release();
    // 要预留临时空间的请求仍须新鲜样本
    expect(await runtime.arbiter.acquire({ admissionId: "stale-disk", serviceClass: "storage-foreground",
      atomic: budget, preferred: budget, maxWaitMs: 0 }, new AbortController().signal))
      .toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
  });

  it("does not wait for a disk sample before a temporary-free request, while a temporary request still waits for a fresh one", async () => {
    const home = await createTempDir("capacity-no-sample-wait");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, diskSampler: disk.starter });
    // 从未采到样本：不要临时空间的请求有等待额度也立即受理，不等那一轮采样
    const started = performance.now();
    const admitted = await runtime.arbiter.acquire({ admissionId: "no-sample-read", serviceClass: "storage-foreground",
      atomic: read, preferred: read, maxWaitMs: 1_000 }, new AbortController().signal);
    expect(admitted.kind).toBe("granted");
    expect(performance.now() - started).toBeLessThan(200);
    if (admitted.kind === "granted") admitted.permit.release();
    // 要临时空间的请求照旧等新鲜样本：样本到达之前不受理
    let settled = false;
    const waiting = runtime.arbiter.acquire({ admissionId: "no-sample-disk", serviceClass: "storage-foreground",
      atomic: budget, preferred: budget, maxWaitMs: 1_000 }, new AbortController().signal).finally(() => { settled = true; });
    await sleep(50);
    expect(settled).toBe(false);
    disk.sample();
    const granted = await waiting;
    expect(granted.kind).toBe("granted");
    if (granted.kind === "granted") granted.permit.release();
  });

  it("does not block the runtime entry on a disk probe and returns from close within its deadline", async () => {
    const home = await createTempDir("capacity-entry");
    const started = Date.now();
    const runtime = beginRuntimeLogging(home, "probe-fixture");
    expect(Date.now() - started).toBeLessThan(100);
    await runtime.finish("failure", "fixture-stop");
    expect(Date.now() - started).toBeLessThan(6000);
    // 采样一直没有结果时，关闭立即返回并让采样停下
    const disk = manualSampler();
    const silent = createDeviceCapacityRuntime(home, { createDirectory: false, diskSampler: disk.starter });
    const closing = performance.now();
    silent.close();
    expect(performance.now() - closing).toBeLessThan(50);
    expect(disk.counts.stops).toBe(1);
  }, 7000);

  it.each([true, false])("samples independently across a slow recovery prefix and stops after close (createDirectory=%s)", async (createDirectory) => {
    const home = await createTempDir("capacity-progress");
    const disk = observedThreadSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory, diskSampler: disk.starter });
    await sleep(750);
    const admission = await runtime.arbiter.acquire({ admissionId: "after-slow-prefix", serviceClass: "storage-recovery", atomic: budget, preferred: budget, maxWaitMs: 0 }, new AbortController().signal);
    expect(admission.kind).toBe("granted");
    if (admission.kind === "granted") admission.permit.release();
    expect(disk.count()).toBeGreaterThan(2);
    runtime.close();
    await sleep(100);
    const count = disk.count();
    await sleep(300);
    expect(disk.count()).toBe(count);
  });

  it("keeps failed samples unknown, cancels queued work and ignores samples after close", async () => {
    const home = await createTempDir("capacity-probe-failure");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { diskSampler: disk.starter });
    disk.fail();
    const request = { admissionId: "probe-close", serviceClass: "storage-recovery" as const, atomic: budget, preferred: budget, maxWaitMs: 5000 };
    const queued = runtime.arbiter.acquire(request, new AbortController().signal);
    await sleep(50);
    runtime.close();
    expect(await queued).toEqual({ kind: "cancelled" });
    disk.sample();
    expect(runtime.arbiter.snapshot().occupancyCapacity.temporaryBytes).toBe(0);
    expect(await runtime.arbiter.acquire(request, new AbortController().signal)).toEqual({ kind: "cancelled" });
    expect(disk.counts.stops).toBe(1);
  });

  it("expires samples on the monotonic clock even when the wall clock moves backwards", async () => {
    const home = await createTempDir("capacity-clock");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { diskSampler: disk.starter });
    disk.sample();
    const request = { admissionId: "clock-sample", serviceClass: "storage-recovery" as const, atomic: budget, preferred: budget, maxWaitMs: 250 };
    const ready = await runtime.arbiter.acquire(request, new AbortController().signal);
    expect(ready.kind).toBe("granted");
    if (ready.kind === "granted") ready.permit.release();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000);
    await sleep(300);
    expect(await runtime.arbiter.acquire({ ...request, admissionId: "clock-expired", maxWaitMs: 0 }, new AbortController().signal))
      .toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
  });

  it("grants an already queued request once a fresh sample arrives, without another acquire", async () => {
    const home = await createTempDir("capacity-queued");
    const disk = manualSampler();
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, diskSampler: disk.starter });
    disk.sample();
    const exclusive = { ...budget, occupancy: { ...budget.occupancy, slots: createDefaultDeviceCapacityPolicy().occupancy.slots } };
    const request = { admissionId: "queued-1", serviceClass: "storage-background" as const, atomic: exclusive, preferred: exclusive, maxWaitMs: 3000 };
    const abort = new AbortController();
    const held = await runtime.arbiter.acquire(request, abort.signal);
    if (held.kind !== "granted") throw Error("Expected admission");
    let settled = false;
    const queued = runtime.arbiter.acquire({ ...request, admissionId: "queued-2" }, abort.signal).then((result) => { settled = true; return result; });
    try {
      await sleep(300);
      held.permit.release();
      await sleep(100);
      // 槽位已空，但样本已过期：仍在排队
      expect(settled).toBe(false);
      disk.sample();
      const resumed = await queued;
      expect(resumed.kind).toBe("granted");
      if (resumed.kind === "granted") resumed.permit.release();
    } finally {
      held.permit.release();
      abort.abort();
      await queued;
    }
  }, 5000);
});
