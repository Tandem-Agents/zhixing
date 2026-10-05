import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatsFs } from "node:fs";
import * as filesystem from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { createDefaultDeviceCapacityPolicy } from "@zhixing/core/resources";
import { createDeviceCapacityRuntime as createRuntime } from "./device-capacity-runtime.js";
import { beginRuntimeLogging } from "../logging/runtime.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof filesystem>()),
  statfs: vi.fn(),
}));
const runtimes: ReturnType<typeof createRuntime>[] = [];
function createDeviceCapacityRuntime(...args: Parameters<typeof createRuntime>) {
  const runtime = createRuntime(...args); runtimes.push(runtime); return runtime;
}
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); vi.resetAllMocks(); });
const budget = {
  occupancy: { memoryReservationBytes: 1, temporaryBytes: 1, slots: 1 },
  quantum: { readBytes: 1, writeBytes: 1, ioOperations: 1 },
};
describe("asynchronous entry capacity sampling", () => {
  it('keeps the Host default sampling across unrelated owner recovery prefixes', async () => {
    const home = await createTempDir('capacity-host-default');
    vi.mocked(filesystem.statfs).mockResolvedValue({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs);
    const logging = beginRuntimeLogging(home, 'on-demand');
    try {
      await new Promise(resolve => setTimeout(resolve, 750));
      const admission = await logging.capacity.arbiter.acquire({ admissionId: 'host-slow-prefix', serviceClass: 'storage-recovery', atomic: budget, preferred: budget, maxWaitMs: 0 }, new AbortController().signal);
      expect(admission.kind).toBe('granted');
      if (admission.kind === 'granted') admission.permit.release();
    } finally { await logging.finish('success', 'host-prefix-complete', 1000); }
  });

  it('stops physical polling while idle and covers a slow owner prefix plus its outstanding permit', async () => {
    const home = await createTempDir('capacity-activity');
    const probe = vi.mocked(filesystem.statfs).mockResolvedValue({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs);
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false, activityDriven: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(probe).not.toHaveBeenCalled();
    const finishPrefix = runtime.retainActivity();
    await new Promise(resolve => setTimeout(resolve, 750));
    const admission = await runtime.arbiter.acquire({ admissionId: 'owned-prefix', serviceClass: 'storage-recovery', atomic: budget, preferred: budget, maxWaitMs: 0 }, new AbortController().signal);
    expect(admission.kind).toBe('granted');
    if (admission.kind !== 'granted') throw Error('Expected admission');
    finishPrefix();
    const activeCount = probe.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(probe.mock.calls.length).toBeGreaterThan(activeCount);
    const step = admission.permit.tryBegin(budget); expect(step).toBeDefined(); step!.complete();
    admission.permit.release();
    const idleCount = probe.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(probe).toHaveBeenCalledTimes(idleCount);
    expect(runtime.arbiter.snapshot().devicePressure).toBeNull();
    runtime.close();
  });

  it("shares an entry's existing capacity without closing it when its logger drains", async () => {
    const home = await createTempDir("capacity-shared-owner");
    vi.mocked(filesystem.statfs).mockResolvedValue({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs);
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

  it("keeps cold zero-wait requests nonblocking and cancellation does not duplicate an in-flight probe", async () => {
    const home = await createTempDir("capacity-async");
    let complete!: (value: StatsFs) => void;
    const pending = new Promise<StatsFs>((resolve) => {
      complete = resolve;
    });
    const probe = vi.mocked(filesystem.statfs).mockImplementation(() => pending);
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false });
    const request = {
      admissionId: "logging-test-1",
      serviceClass: "storage-background" as const,
      atomic: budget,
      preferred: budget,
      maxWaitMs: 0,
    };
    const cold = await runtime.arbiter.acquire(request, new AbortController().signal);
    expect(cold).toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
    expect(runtime.arbiter.snapshot().devicePressure).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    const abort = new AbortController();
    const waiting = runtime.arbiter.acquire(
      { ...request, admissionId: "logging-test-2", maxWaitMs: 250 },
      abort.signal,
    );
    abort.abort();
    expect((await waiting).kind).toBe("cancelled");
    expect(probe).toHaveBeenCalledTimes(1);
    complete({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ready = await runtime.arbiter.acquire(
      { ...request, admissionId: "logging-test-3" },
      new AbortController().signal,
    );
    expect(ready.kind).toBe("granted");
    if (ready.kind === "granted") ready.permit.release();
  });

  it("does not block the runtime entry on a disk probe and returns from close within its deadline", async () => {
    const home = await createTempDir("capacity-entry");
    const probe = vi
      .mocked(filesystem.statfs)
      .mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const runtime = beginRuntimeLogging(home, "probe-fixture");
    expect(Date.now() - started).toBeLessThan(100);
    await runtime.finish("failure", "fixture-stop");
    expect(Date.now() - started).toBeLessThan(6000);
    expect(probe).toHaveBeenCalledTimes(1);
  }, 7000);

  it.each([true, false])("refreshes independently across a slow recovery prefix (createDirectory=%s)", async (createDirectory) => {
    const home = await createTempDir("capacity-progress");
    const probe = vi.mocked(filesystem.statfs).mockResolvedValue({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs);
    const runtime = createDeviceCapacityRuntime(home, { createDirectory });
    await new Promise(resolve => setTimeout(resolve, 750));
    const admission = await runtime.arbiter.acquire({ admissionId: "after-slow-prefix", serviceClass: "storage-recovery", atomic: budget, preferred: budget, maxWaitMs: 0 }, new AbortController().signal);
    expect(admission.kind).toBe("granted");
    if (admission.kind === "granted") admission.permit.release();
    expect(probe.mock.calls.length).toBeGreaterThan(2);
    runtime.close();
    const count = probe.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(probe).toHaveBeenCalledTimes(count);
  });

  it("keeps failed and late probes unknown, cancels queued work and ignores completion after close", async () => {
    const home = await createTempDir("capacity-probe-failure");
    let resolve!: (value: StatsFs) => void;
    const pending = new Promise<StatsFs>(done => { resolve = done; });
    const probe = vi.mocked(filesystem.statfs).mockRejectedValueOnce(Error("unavailable")).mockImplementation(() => pending);
    const runtime = createDeviceCapacityRuntime(home);
    await new Promise(done => setTimeout(done, 150));
    const request = { admissionId: "probe-close", serviceClass: "storage-recovery" as const, atomic: budget, preferred: budget, maxWaitMs: 5000 };
    const queued = runtime.arbiter.acquire(request, new AbortController().signal);
    runtime.close();
    expect(await queued).toEqual({ kind: "cancelled" });
    resolve({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs);
    await pending;
    await new Promise(done => setTimeout(done, 300));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(runtime.arbiter.snapshot().devicePressure).toBeNull();
    expect(await runtime.arbiter.acquire(request, new AbortController().signal)).toEqual({ kind: "cancelled" });
  });

  it("expires samples even when the wall clock moves backwards", async () => {
    const home = await createTempDir("capacity-clock");
    vi.mocked(filesystem.statfs)
      .mockResolvedValueOnce({ bavail: 1024 * 1024, bsize: 4096 } as StatsFs)
      .mockImplementation(() => new Promise(() => undefined));
    const runtime = createDeviceCapacityRuntime(home);
    const request = { admissionId: "clock-sample", serviceClass: "storage-recovery" as const, atomic: budget, preferred: budget, maxWaitMs: 250 };
    const ready = await runtime.arbiter.acquire(request, new AbortController().signal);
    expect(ready.kind).toBe("granted");
    if (ready.kind === "granted") ready.permit.release();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000);
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(await runtime.arbiter.acquire({ ...request, admissionId: "clock-expired", maxWaitMs: 0 }, new AbortController().signal))
        .toMatchObject({ kind: "backpressured", blockedBy: "probe-unavailable" });
    } finally { clock.mockRestore(); }
  });

  it("refreshes expired disk pressure for an already queued request without another acquire", async () => {
    const home = await createTempDir("capacity-queued");
    const sample = { bavail: 1024 * 1024, bsize: 4096 } as StatsFs;
    let complete!: (value: StatsFs) => void;
    const pending = new Promise<StatsFs>((resolve) => {
      complete = resolve;
    });
    const probe = vi
      .mocked(filesystem.statfs)
      .mockResolvedValueOnce(sample)
      .mockImplementation(() => pending);
    const runtime = createDeviceCapacityRuntime(home, { createDirectory: false });
    const exclusive = {
      ...budget,
      occupancy: {
        ...budget.occupancy,
        slots: createDefaultDeviceCapacityPolicy().occupancy.slots,
      },
    };
    const request = {
      admissionId: "logging-queued-1",
      serviceClass: "storage-background" as const,
      atomic: exclusive,
      preferred: exclusive,
      maxWaitMs: 1500,
    };
    const abort = new AbortController();
    const held = await runtime.arbiter.acquire(request, abort.signal);
    expect(held.kind).toBe("granted");
    if (held.kind !== "granted") return;
    let settled = false;
    const queued = runtime.arbiter
      .acquire({ ...request, admissionId: "logging-queued-2" }, abort.signal)
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      held.permit.release();
      expect(settled).toBe(false);
      expect(probe).toHaveBeenCalledTimes(2);
      complete(sample);
      const resumed = await queued;
      expect(resumed.kind).toBe("granted");
      if (resumed.kind === "granted") resumed.permit.release();
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      held.permit.release();
      abort.abort();
      complete(sample);
      await queued;
    }
  }, 5000);
});
