import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "@zhixing/core/authority";
import {
  createDefaultDeviceCapacityPolicy,
  currentDeviceCapacityStep,
  DefaultDeviceCapacityArbiter,
  maintenanceRetryDelayMs,
  runHoldingMaintenanceExclusion,
  runInMaintenanceContext,
  runWithDeviceCapacity,
  runWithMaintenanceUrgency,
  withDeviceCapacityStep,
  type DeviceCapacityBudget,
} from "@zhixing/core/resources";
import { artifactReadCapacity } from "./artifact-read-capacity.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";

const MIB = 1024 * 1024;
const roots: string[] = [];
const abort = new AbortController().signal;
const workload: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: MIB, temporaryBytes: 0, slots: 1 },
  quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-read-capacity-"));
  roots.push(root);
  const defaults = createDefaultDeviceCapacityPolicy();
  const arbiter = new DefaultDeviceCapacityArbiter({
    policy: {
      ...defaults,
      occupancy: { ...defaults.occupancy, memoryReservationBytes: 16 * MIB,
        memorySafetyReserveBytes: 0, temporarySafetyReserveBytes: 0, slots: 1 },
      quantum: { readBytes: MIB, writeBytes: MIB, ioOperations: 100 },
      quantumRefillPerSecond: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
      pressure: { maxCpuBusyRatio: 1, minimumAvailableMemoryBytes: 0 },
    },
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 64 * MIB,
      processRssBytes: MIB, temporaryBytesAvailable: 64 * MIB }),
  });
  const store = new FileArtifactStore(root, { runReadStep: artifactReadCapacity(arbiter) });
  const bytes = Buffer.from("正文 中文🙂");
  const ref = await store.put(bytes);
  const physicalPath = vi.spyOn(store, "pathFor");
  const acquire = vi.spyOn(arbiter, "acquire");
  return { store, bytes, ref, physicalPath, arbiter, acquire };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("artifact read capacity", () => {
  it("reads through the real Host arbiter and permit wrappers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "artifact-read-capacity-")); roots.push(root);
    const runtime = createDeviceCapacityRuntime(root, { activityDriven: true });
    try {
      const store = new FileArtifactStore(path.join(root, "artifacts"), { runReadStep: artifactReadCapacity(runtime.arbiter) });
      const bytes = Buffer.from("actual wrapped Host read"), ref = await store.put(bytes);
      await runWithDeviceCapacity(runtime.arbiter, runtime.workload("workload-interactive"), abort, async () => {
        const before = runtime.arbiter.snapshot().occupancyInUse;
        expect(await store.get(ref)).toEqual(bytes);
        expect(runtime.arbiter.snapshot().occupancyInUse).toEqual(before);
      });
      expect(runtime.arbiter.snapshot().occupancyInUse.slots).toBe(0);
    } finally { runtime.close(); }
  });

  it("reads with all workload slots occupied, charges once and restores the workload owner", async () => {
    const { store, ref, bytes, arbiter, acquire } = await fixture();
    await runWithDeviceCapacity(arbiter, {
      serviceClass: "workload-interactive", atomic: workload, preferred: workload, maxWaitMs: 0,
    }, abort, async () => {
      const owner = currentDeviceCapacityStep();
      expect(arbiter.snapshot().occupancyInUse.slots).toBe(1);
      expect(await store.get(ref)).toEqual(bytes);
      expect(currentDeviceCapacityStep()).toBe(owner);
      expect(arbiter.snapshot().occupancyInUse).toEqual(workload.occupancy);
    });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[1]![0]).toMatchObject({
      serviceClass: "workload-interactive", maxWaitMs: 0,
      atomic: { occupancy: { slots: 0 }, quantum: { readBytes: ref.bytes, ioOperations: 1 } },
    });
    expect(arbiter.snapshot()).toMatchObject({
      occupancyInUse: { slots: 0, memoryReservationBytes: 0 },
      quantumAvailable: { readBytes: MIB - ref.bytes, ioOperations: 99 },
    });
    expect(arbiter.snapshot().lastViolation).toBeUndefined();
  });

  it("uses an existing physical read plan under an exclusion without another admission", async () => {
    const { store, ref, bytes, arbiter, acquire } = await fixture();
    const bound = { ...workload, quantum: { readBytes: ref.bytes, writeBytes: 0, ioOperations: 1 } };
    const admitted = await arbiter.acquire({ admissionId: "planned-read", serviceClass: "storage-recovery",
      atomic: bound, preferred: bound, maxWaitMs: 0 }, abort);
    if (admitted.kind !== "granted") throw Error("fixture admission failed");
    try {
      await withDeviceCapacityStep(admitted.permit, bound, () =>
        runHoldingMaintenanceExclusion(async () => expect(await store.get(ref)).toEqual(bytes)));
    } finally { admitted.permit.release(); }
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot().quantumAvailable).toMatchObject({ readBytes: MIB - ref.bytes, ioOperations: 99 });
  });

  it("preserves recovery priority and returns retryable backpressure before I/O under a lock", async () => {
    const { store, ref, arbiter, acquire, physicalPath } = await fixture();
    const held = await arbiter.acquire({ admissionId: "other-owner", serviceClass: "workload-interactive",
      atomic: workload, preferred: workload, maxWaitMs: 0 }, abort);
    if (held.kind !== "granted") throw Error("fixture admission failed");
    try {
      await runInMaintenanceContext("recovery", () => runHoldingMaintenanceExclusion(async () => {
        try { await store.get(ref); throw Error("read should be backpressured"); }
        catch (error) { expect(maintenanceRetryDelayMs(error)).toBeGreaterThan(0); }
      }));
    } finally { held.permit.release(); }
    expect(acquire.mock.calls[1]![0]).toMatchObject({ serviceClass: "storage-recovery", maxWaitMs: 0 });
    expect(physicalPath).not.toHaveBeenCalled();
  });

  it("rejects cancellation, capacity gap and malformed references before filesystem access", async () => {
    const { store, ref, physicalPath, acquire } = await fixture();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(runWithMaintenanceUrgency(() => "background", cancelled.signal,
      () => store.get(ref))).rejects.toMatchObject({ admission: { kind: "cancelled" } });
    await expect(store.get({ ...ref, bytes: 32 * MIB })).rejects.toMatchObject({ admission: { kind: "capacity-gap" } });
    const admitted = acquire.mock.calls.length;
    await expect(store.get({ ...ref, bytes: -1 })).rejects.toThrow("ArtifactRef");
    expect(acquire).toHaveBeenCalledTimes(admitted);
    expect(physicalPath).not.toHaveBeenCalled();
  });

  it.each(["missing", "digest", "oversized", "short"] as const)("preserves %s rejection and releases the read reservation", async (corruption) => {
    const { store, ref, arbiter, bytes } = await fixture();
    const file = store.pathFor(ref);
    if (corruption === "missing") await rm(file);
    else await writeFile(file, corruption === "digest" ? Buffer.alloc(bytes.length)
      : corruption === "oversized" ? Buffer.alloc(bytes.length + 1) : bytes.subarray(1));
    await expect(store.get(ref)).rejects.toMatchObject({ code: corruption === "missing" ? "artifact-missing" : "artifact-corrupt" });
    expect(arbiter.snapshot().occupancyInUse).toMatchObject({ memoryReservationBytes: 0, slots: 0 });
  });
});
