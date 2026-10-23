import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FileHandle } from "node:fs/promises";

const opened = vi.hoisted(() => [] as FileHandle[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    opened.push(handle);
    return handle;
  } };
});
import { FileArtifactStore, FileAuthorityCommitLog, FileDurableProjectionIndex, bindDurableProjectionMutations, durableProjectionDirectoryName, durableProjectionReadBudget } from "../index.js";
import { createDefaultDeviceCapacityPolicy, DefaultDeviceCapacityArbiter, DefaultStorageMaintenanceGovernor, runWithDeviceCapacity, withDeviceCapacityStep, currentDeviceCapacityStep, StorageMaintenanceAdmissionError } from "../../resources/index.js";
import { SerialTaskQueue } from "../../persistence/serial-task-queue.js";

describe("authority projection physical reads", () => {
  it("does not reserve maintenance capacity while waiting for the source owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "projection-lock-order-"));
    const defaults = createDefaultDeviceCapacityPolicy();
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy, slots: 1 } },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
    const source = new SerialTaskQueue(), requested = Promise.withResolvers<void>();
    let foreground: string | undefined;
    const bound = { occupancy: { memoryReservationBytes: 4096, temporaryBytes: 0, slots: 1 },
      quantum: { readBytes: 65536, writeBytes: 0, ioOperations: 4 } };
    const owner = source.run(async () => {
      await requested.promise;
      const result = await arbiter.acquire({ admissionId: "source-control", serviceClass: "storage-foreground",
        atomic: bound, preferred: bound, maxWaitMs: 0 }, new AbortController().signal);
      foreground = result.kind;
      if (result.kind === "granted") result.permit.release();
    });
    const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "lock-order", reducerVersion: 1,
      storageMaintenance: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }),
      withSourceLock: operation => { requested.resolve(); return source.run(operation); } });
    try {
      await Promise.all([owner, index.initialize({ source: { logId: "lock-order", lsn: 0,
        frameEndOffset: 64, prefixDigest: `sha256:${"0".repeat(64)}` } })]);
      expect(foreground).toBe("granted");
      expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    } finally {
      requested.resolve(); await owner; await index.stopStorageMaintenance();
      if (path.dirname(path.resolve(root)).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()) throw Error("Unexpected test directory");
      await rm(root, { recursive: true, force: true });
    }
  });
  it("closes a scan cursor when its first entry is refused and preserves the failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "projection-read-cleanup-"));
    const checkpoint = { logId: "cleanup", lsn: 0, frameEndOffset: 64, prefixDigest: "sha256:" + "0".repeat(64) };
    const refused = new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 1 });
    let rejectEntry = false;
    const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "cleanup", reducerVersion: 1,
      runReadStep: async (step, operation) => { if (rejectEntry && step === "segment-entry") throw refused; return operation(); } });
    try {
      await index.initialize({ source: checkpoint });
      const delta = await index.prepare([{ kind: "put", key: "entry", value: "durable" }]);
      index.publish(delta, { source: checkpoint });
      await index.flush();
      const before = opened.length;
      rejectEntry = true;
      await expect(index.scan({}, 1)).rejects.toBe(refused);
      const scanHandles = opened.slice(before);
      expect(scanHandles).toHaveLength(2);
      expect(scanHandles.every((handle) => handle.fd === -1)).toBe(true);
      rejectEntry = false;
      await expect(index.scan({}, 1)).resolves.toMatchObject({ entries: [{ key: "entry", value: "durable" }] });
    } finally { await index.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
  });

  it("reads a persisted projection inside an occupancy-only workload on a single-slot device", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "projection-read-capacity-"));
    const defaults = createDefaultDeviceCapacityPolicy();
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy, slots: 1 } },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
    const storage = new DefaultStorageMaintenanceGovernor({ capacity: arbiter });
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const logRoot = path.join(root, "authority");
    const writer = new FileAuthorityCommitLog(logRoot, artifacts);
    const id = "read-capacity-fixture";
    try {
      await writer.append([{ stream: "publish", body: { t: "put", key: "skill", value: "saved" } }]);
      const readSteps: string[] = [];
      const stored = new FileDurableProjectionIndex({ rootDir: path.join(logRoot, "projections", durableProjectionDirectoryName(id)), projectionId: id, reducerVersion: 1, runReadStep: async (step, operation) => { readSteps.push(step); return operation(); } });
      await stored.initialize({ authority: await writer.originCheckpoint() });
      const initializationReads = readSteps.length;
      const delta = await stored.prepare(bindDurableProjectionMutations([{ kind: "put", key: "skill", value: "saved" }]));
      stored.publish(delta, { authority: await writer.checkpoint() });
      expect(await stored.get("skill")).toMatchObject({ v: 1, value: "saved" });
      expect((await stored.scan({ gte: "skill", lt: "skillz" }, 1)).entries).toMatchObject([{ key: "skill", value: { v: 1, value: "saved" } }]);
      expect(readSteps.slice(initializationReads)).toEqual([]);
      await stored.flush();
      // 叶级预算与生产相同（durableProjectionReadBudget），覆盖条目读取的有界预读。
      const log = new FileAuthorityCommitLog(logRoot, artifacts, { storageMaintenance: storage, runProjectionReadStep: async (step, operation) => {
        const owner = currentDeviceCapacityStep();
        if (owner?.kind === "physical") return operation();
        const budget = durableProjectionReadBudget(step);
        const leaf = { occupancy: { memoryReservationBytes: budget.memoryReservationBytes, temporaryBytes: 0, slots: owner?.kind === "workload" ? 0 : 1 }, quantum: { readBytes: budget.readBytes, writeBytes: 0, ioOperations: budget.ioOperations } };
        const admission = await arbiter.acquire({ admissionId: "projection-leaf", serviceClass: owner?.kind === "workload" ? owner.serviceClass : "storage-foreground", atomic: leaf, preferred: leaf, maxWaitMs: 0 }, new AbortController().signal);
        if (admission.kind !== "granted") throw new Error(admission.kind);
        try { return await withDeviceCapacityStep(admission.permit, leaf, operation); } finally { admission.permit.release(); }
      } });
      const index = log.durableProjection({ projectionId: id, reducerVersion: 1, reduce: () => [] });
      await index.checkpoints();
      const bound = { occupancy: { memoryReservationBytes: 32 * 1024 ** 2, temporaryBytes: 0, slots: 1 }, quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 } };
      const value = await runWithDeviceCapacity(arbiter, { serviceClass: "workload-interactive", atomic: bound, preferred: bound, maxWaitMs: 0 }, new AbortController().signal, () => index.get("skill"));
      expect(value).toBe("saved");
      expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
      await log.stopStorageMaintenance();
      await stored.stopStorageMaintenance();
    } finally { await writer.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
  });

  it("synchronizes registered projections before the caller's physical step on a single-slot device", async () => {
    // 打开投影、采纳其他实例的发布是日志自身的工作，成本随登记的投影数增长；调用方按业务估算的
    // 物理计划只承担自己的读写。每次操作都是新锁会话，投影都须重新采纳发布。
    const root = await mkdtemp(path.join(os.tmpdir(), "projection-presync-"));
    const arbiter = singleSlotArbiter();
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
      storageMaintenance: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }),
      runProjectionReadStep: leafProjectionReads(arbiter), lockSessionLingerMs: 0 });
    try {
      registerCounters(log);
      for (const id of COUNTERS) await log.append([{ stream: `job:${id}`, body: { n: 1 } }]);
      const result = await log.transactDurableProjection("counter-a", async () => ({
        kind: "append", entries: [{ stream: "job:counter-a", body: { n: 2 } }], value: "appended",
      }), { runPhysicalStep: callerStep(arbiter) });
      expect(result.value).toBe("appended");
      expect(arbiter.snapshot().occupancyInUse.slots).toBe(0);
    } finally { await log.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
  });

  it("adopts other instances' projection publications once per lock session, not on every write", async () => {
    // 其他实例只能持锁发布：本实例持有锁会话期间不会出现新的发布，后续写入不再逐个重读清单。
    const root = await mkdtemp(path.join(os.tmpdir(), "projection-session-refresh-"));
    const arbiter = singleSlotArbiter();
    const steps: string[] = [];
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
      storageMaintenance: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }),
      runProjectionReadStep: leafProjectionReads(arbiter, steps), lockSessionLingerMs: 60_000 });
    try {
      registerCounters(log);
      for (const id of COUNTERS) await log.append([{ stream: `job:${id}`, body: { n: 1 } }]);
      steps.length = 0;
      await log.transactDurableProjection("counter-b", async () => ({
        kind: "append", entries: [{ stream: "job:counter-b", body: { n: 2 } }], value: undefined,
      }), { runPhysicalStep: callerStep(arbiter) });
      expect(steps.filter((step) => step === "manifest")).toEqual([]);
    } finally { await log.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
  });
});

const COUNTERS = ["counter-a", "counter-b", "counter-c", "counter-d"] as const;

function registerCounters(log: FileAuthorityCommitLog): void {
  for (const id of COUNTERS) {
    log.durableProjection({ projectionId: id, reducerVersion: 1, inputs: { streams: [`job:${id}`] },
      reduce: (envelope) => envelope.entries.filter((entry) => entry.stream === `job:${id}`)
        .map((entry) => ({ kind: "put" as const, key: "latest", value: entry.body })) });
  }
}

function singleSlotArbiter(): DefaultDeviceCapacityArbiter {
  const defaults = createDefaultDeviceCapacityPolicy();
  return new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy, slots: 1 } },
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
}

/** 与生产同形的叶级投影读取准入：物理计划内直接记在计划上，计划外各自零等待取得准入。 */
function leafProjectionReads(arbiter: DefaultDeviceCapacityArbiter, steps?: string[]) {
  return async <T>(step: Parameters<typeof durableProjectionReadBudget>[0], operation: () => Promise<T>): Promise<T> => {
    steps?.push(step);
    if (currentDeviceCapacityStep()?.kind === "physical") return operation();
    const budget = durableProjectionReadBudget(step);
    const leaf = { occupancy: { memoryReservationBytes: budget.memoryReservationBytes, temporaryBytes: 0, slots: 1 },
      quantum: { readBytes: budget.readBytes, writeBytes: 0, ioOperations: budget.ioOperations } };
    const admission = await arbiter.acquire({ admissionId: "projection-leaf", serviceClass: "storage-foreground",
      atomic: leaf, preferred: leaf, maxWaitMs: 0 }, new AbortController().signal);
    if (admission.kind !== "granted") throw new Error(admission.kind);
    try { return await withDeviceCapacityStep(admission.permit, leaf, operation); } finally { admission.permit.release(); }
  };
}

/** 调用方按业务估算的物理计划：只够它自己的一次读写，占用设备唯一的槽位。 */
function callerStep(arbiter: DefaultDeviceCapacityArbiter) {
  const bound = { occupancy: { memoryReservationBytes: 4096, temporaryBytes: 0, slots: 1 },
    quantum: { readBytes: 65536, writeBytes: 65536, ioOperations: 1 } };
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const admission = await arbiter.acquire({ admissionId: "caller-step", serviceClass: "storage-foreground",
      atomic: bound, preferred: bound, maxWaitMs: 0 }, new AbortController().signal);
    if (admission.kind !== "granted") throw new Error(admission.kind);
    try { return await withDeviceCapacityStep(admission.permit, bound, operation); } finally { admission.permit.release(); }
  };
}
