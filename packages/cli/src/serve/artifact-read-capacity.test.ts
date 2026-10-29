import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "@zhixing/core/authority";
import { AssignmentStreamSpool } from '@zhixing/executor';
import {
  claimDeviceCapacity,
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
import { artifactReadCapacity, projectionReadCapacity } from "./artifact-read-capacity.js";
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
  it('子任务流发布及重启核验共享Host读取准入，不消耗零I/O的外层预算', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'artifact-read-capacity-')); roots.push(home);
    const runtime = createDeviceCapacityRuntime(home, { activityDriven: true });
    const arbiter = runtime.arbiter;
    const store = new FileArtifactStore(path.join(home, 'artifacts'), { runReadStep: artifactReadCapacity(arbiter) });
    const root = path.join(home, 'stream-spool');
    // 与宿主装配相同：制品读取与投影读取各自取得 Host 读取准入。
    const options = { runReadStep: artifactReadCapacity(arbiter), runProjectionReadStep: projectionReadCapacity(arbiter), storageMaintenance: runtime.storage };
    const spool = new AssignmentStreamSpool(root, store, options);
    const restarted = new AssignmentStreamSpool(root, store, options);
    try {
      await runWithDeviceCapacity(arbiter, runtime.workload('workload-interactive'), abort, async () => {
        const ref = { execution: 'conversation' as const, conversationId: 'parent', runId: 'run', ownerEpoch: 0 };
        await spool.open('child', ref);
        await spool.append({ assignmentId: 'child', ref, payload: { kind: 'agent-yield', yield: { type: 'text_delta', text: 'child-output' } } });
        expect((await restarted.snapshot('child')).lastSeq).toBeGreaterThan(0);
      });
      expect(arbiter.snapshot().lastViolation).toBeUndefined();
      expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    } finally {
      await Promise.all([spool.stopStorageMaintenance(), restarted.stopStorageMaintenance(), spool.closeAssignmentScan(), restarted.closeAssignmentScan()]);
      runtime.close();
    }
  });
  it("publishes and verifies artifacts from an occupancy-only workload", async () => {
    const { store, arbiter } = await fixture();
    const bytes = Buffer.from("new job assignment");
    await runWithDeviceCapacity(arbiter, {
      serviceClass: "workload-interactive", atomic: workload, preferred: workload, maxWaitMs: 0,
    }, abort, async () => {
      const ref = await store.put(bytes);
      expect(await store.put(bytes)).toEqual(ref);
      expect(await store.get(ref)).toEqual(bytes);
    });
    expect(arbiter.snapshot().lastViolation).toBeUndefined();
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
  });

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


describe("projection read capacity", () => {
  it("borrows the actual workload slot, meters physical reads and returns its reservation", async () => {
    const defaults = createDefaultDeviceCapacityPolicy();
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy, slots: 1 } },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: MIB, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
    const acquire = vi.spyOn(arbiter, "acquire");
    await runWithDeviceCapacity(arbiter, { serviceClass: "workload-interactive", atomic: workload, preferred: workload, maxWaitMs: 0 }, abort, async () => {
      const before = currentDeviceCapacityStep();
      const read = projectionReadCapacity(arbiter)!;
      expect(await read("segment-entry", async () => {
        expect(currentDeviceCapacityStep()?.kind).toBe("physical");
        claimDeviceCapacity("readBytes", 73); claimDeviceCapacity("ioOperations", 2);
        return "saved";
      })).toBe("saved");
      expect(currentDeviceCapacityStep()).toBe(before);
      expect(arbiter.snapshot().occupancyInUse).toEqual(workload.occupancy);
    });
    expect(acquire.mock.calls[1]![0]).toMatchObject({ serviceClass: "workload-interactive", maxWaitMs: 0, atomic: { occupancy: { slots: 0 } } });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    expect(arbiter.snapshot().lastViolation).toBeUndefined();
  });

  it("returns lock-retryable pressure without reading when a physical projection leaf cannot enter", async () => {
    const { arbiter } = await fixture();
    const read = projectionReadCapacity(arbiter)!;
    const operation = vi.fn();
    await expect(runHoldingMaintenanceExclusion(() => read("segment-entry", operation))).rejects.toMatchObject({ name: "StorageMaintenanceAdmissionError", admission: { kind: "capacity-gap" } });
    expect(operation).not.toHaveBeenCalled();
  });
});


it("retries projection reads after real slot pressure is released and never reads after cancellation", async () => {
  const defaults = createDefaultDeviceCapacityPolicy();
  const arbiter = new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy, slots: 1 } },
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: MIB, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
  const held = await arbiter.acquire({ admissionId: "other-reader", serviceClass: "storage-foreground", atomic: workload, preferred: workload, maxWaitMs: 0 }, abort);
  if (held.kind !== "granted") throw Error("fixture admission failed");
  const read = projectionReadCapacity(arbiter)!, operation = vi.fn(async () => { claimDeviceCapacity("ioOperations", 1); return "read"; });
  try {
    await expect(runHoldingMaintenanceExclusion(() => read("segment-entry", operation))).rejects.toMatchObject({ name: "StorageMaintenanceAdmissionError", admission: { kind: "backpressured", blockedBy: "slots" } });
    expect(operation).not.toHaveBeenCalled();
  } finally { held.permit.release(); }
  expect(await read("segment-entry", operation)).toBe("read");
  expect(operation).toHaveBeenCalledTimes(1);
  operation.mockClear();
  const cancelled = new AbortController(); cancelled.abort();
  await expect(runWithMaintenanceUrgency(() => "foreground", cancelled.signal, () => read("segment-entry", operation))).rejects.toMatchObject({ admission: { kind: "cancelled" } });
  expect(operation).not.toHaveBeenCalled();
  expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
});

describe('explicit read leaves inside a write workload', () => {
  const write: DeviceCapacityBudget = { ...workload, quantum: { readBytes: 0, writeBytes: 256, ioOperations: 8 } };
  const request = { serviceClass: 'workload-interactive' as const, atomic: write, preferred: write, maxWaitMs: 0, separateReadAdmission: true as const };

  it('uses the only real slot, meters file reads once and preserves the write budget', async () => {
    const { store, bytes, ref, arbiter, acquire } = await fixture();
    await runWithDeviceCapacity(arbiter, request, abort, async () => {
      const owner = currentDeviceCapacityStep();
      claimDeviceCapacity('writeBytes', 17); claimDeviceCapacity('ioOperations', 2);
      expect(await store.get(ref)).toEqual(bytes);
      await projectionReadCapacity(arbiter)!('segment-open', async () => claimDeviceCapacity('ioOperations', 2));
      expect(currentDeviceCapacityStep()).toBe(owner); expect(arbiter.snapshot().occupancyInUse).toEqual(write.occupancy);
    });
    expect(acquire).toHaveBeenCalledTimes(3);
    for (const [leaf] of acquire.mock.calls.slice(1)) expect(leaf).toMatchObject({ maxWaitMs: 0,
      atomic: { occupancy: { slots: 0 }, quantum: { writeBytes: 0 } } });
    expect(arbiter.snapshot().quantumAvailable).toEqual({ readBytes: MIB - ref.bytes, writeBytes: MIB - 17, ioOperations: 95 });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0); expect(arbiter.snapshot().lastViolation).toBeUndefined();
  });

  it('does not let a read leaf spend its parent write allocation', async () => {
    const { arbiter } = await fixture();
    await runWithDeviceCapacity(arbiter, request, abort, async () => {
      const owner = currentDeviceCapacityStep();
      await expect(projectionReadCapacity(arbiter)!('segment-open', async () => claimDeviceCapacity('writeBytes', 1)))
        .rejects.toThrow('exceeded writeBytes');
      expect(currentDeviceCapacityStep()).toBe(owner); claimDeviceCapacity('writeBytes', 17);
    });
    expect(arbiter.snapshot().lastViolation).toMatchObject({ dimension: 'writeBytes', limit: 0, requested: 1 });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
  });

  it.each(['pressure', 'cancel'] as const)('does no file IO when the read leaf meets %s', async reason => {
    const { store, ref, arbiter, physicalPath } = await fixture();
    if (reason === 'pressure') {
      const consumed = { ...workload, quantum: { readBytes: MIB - ref.bytes + 1, writeBytes: 0, ioOperations: 0 } };
      const admission = await arbiter.acquire({ admissionId: 'prior-read-work', serviceClass: 'storage-foreground', atomic: consumed, preferred: consumed, maxWaitMs: 0 }, abort);
      if (admission.kind !== 'granted') throw Error('Prior admitted read must fit');
      try { await withDeviceCapacityStep(admission.permit, consumed, async () => claimDeviceCapacity('readBytes', consumed.quantum.readBytes)); }
      finally { admission.permit.release(); }
    }
    const cancelled = new AbortController();
    await runWithDeviceCapacity(arbiter, request, cancelled.signal, async () => {
      const owner = currentDeviceCapacityStep(); if (reason === 'cancel') cancelled.abort();
      await expect(store.get(ref)).rejects.toMatchObject({ name: 'DeviceCapacityAdmissionError', admission: { kind: reason === 'cancel' ? 'cancelled' : 'backpressured' } });
      expect(physicalPath).not.toHaveBeenCalled(); expect(currentDeviceCapacityStep()).toBe(owner);
      expect(arbiter.snapshot().occupancyInUse.slots).toBe(1);
    });
    expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
  });

  it('requires a real additional slot when the read belongs to another arbiter', async () => {
    const first = await fixture(), second = await fixture();
    const held = await second.arbiter.acquire({ admissionId: 'other-occupant', serviceClass: 'storage-foreground', atomic: workload, preferred: workload, maxWaitMs: 0 }, abort);
    if (held.kind !== 'granted') throw Error('Other occupant must fit');
    try { await runWithDeviceCapacity(first.arbiter, request, abort, async () => {
      await expect(second.store.get(second.ref)).rejects.toMatchObject({ admission: { kind: 'backpressured', blockedBy: 'slots' } });
      expect(second.physicalPath).not.toHaveBeenCalled();
      expect(second.acquire.mock.calls.at(-1)![0]).toMatchObject({ atomic: { occupancy: { slots: 1 } }, maxWaitMs: 0 });
    }); } finally { held.permit.release(); }
    expect(first.arbiter.snapshot().occupancyInUse.slots).toBe(0); expect(second.arbiter.snapshot().occupancyInUse.slots).toBe(0);
  });

  it('retains the default explicit workload read plan without another admission', async () => {
    const { store, bytes, ref, arbiter, acquire } = await fixture();
    const planned = { ...workload, quantum: { readBytes: ref.bytes, writeBytes: 0, ioOperations: 1 } };
    await runWithDeviceCapacity(arbiter, { serviceClass: 'workload-interactive', atomic: planned, preferred: planned, maxWaitMs: 0 }, abort,
      async () => expect(await store.get(ref)).toEqual(bytes));
    expect(acquire).toHaveBeenCalledTimes(1); expect(arbiter.snapshot().lastViolation).toBeUndefined();
  });
});
