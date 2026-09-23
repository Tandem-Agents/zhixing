import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatsFs } from "node:fs";
import * as filesystem from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { createDefaultDeviceCapacityPolicy } from "@zhixing/core/resources";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { beginRuntimeLogging } from "../logging/runtime.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof filesystem>()),
  statfs: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const budget = {
  occupancy: { memoryReservationBytes: 1, temporaryBytes: 1, slots: 1 },
  quantum: { readBytes: 1, writeBytes: 1, ioOperations: 1 },
};
describe("asynchronous entry capacity sampling", () => {
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
    expect(cold.kind).not.toBe("granted");
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
    expect(Date.now() - started).toBeLessThan(2000);
    expect(probe).toHaveBeenCalledTimes(1);
  }, 5000);

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
