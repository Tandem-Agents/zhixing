import { rm } from "node:fs/promises";
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
import { createTempDir } from "@zhixing-ai/test-utils";

describe("authority projection physical reads", () => {
  it("does not reserve maintenance capacity while waiting for the source owner", async () => {
    const root = await createTempDir("projection-lock-order");
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
    }
  });
  it("closes a scan cursor when its first entry is refused and preserves the failure", async () => {
    const root = await createTempDir("projection-read-cleanup");
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
    const root = await createTempDir("projection-read-capacity");
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
    const root = await createTempDir("projection-presync");
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

  it.each([
    // 同一锁会话内：其他实例只能持锁发布，本实例持有会话期间不会出现新的发布，后续写入不再逐个重读清单。
    // 持有上限另有合同（到上限即在操作边界关闭）；这里固定为极大值，免得负载下会话恰在最后一次追加的边界关闭。
    { name: "adopts other instances' projection publications once per lock session, not on every write", maxHold: 600_000, readsManifests: false },
    // 会话到持有上限即在操作边界关闭：下一操作开新会话，按合同重新采纳其他实例的发布
    { name: "re-adopts published manifests in the new session after the hold bound closes the old one", maxHold: 0, readsManifests: true },
  ])("$name", async ({ maxHold, readsManifests }) => {
    const root = await createTempDir("projection-session-refresh");
    const arbiter = singleSlotArbiter();
    const steps: string[] = [];
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
      storageMaintenance: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }),
      runProjectionReadStep: leafProjectionReads(arbiter, steps), lockSessionLingerMs: 60_000, lockSessionMaxHoldMs: maxHold });
    try {
      registerCounters(log);
      for (const id of COUNTERS) await log.append([{ stream: `job:${id}`, body: { n: 1 } }]);
      steps.length = 0;
      await log.transactDurableProjection("counter-b", async () => ({
        kind: "append", entries: [{ stream: "job:counter-b", body: { n: 2 } }], value: undefined,
      }), { runPhysicalStep: callerStep(arbiter) });
      const manifests = steps.filter((step) => step === "manifest");
      if (readsManifests) expect(manifests.length).toBeGreaterThan(0);
      else expect(manifests).toEqual([]);
    } finally { await log.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
  });

  it("reads every re-adopted manifest in a new lock session in bounded concurrent batches with unchanged reads and results", async () => {
    // 每次操作都开新会话：每个待重新采纳的投影照旧各读一次当前清单，只是这些读取在同一会话内有界并发；
    // 读完按原顺序采纳，结果与串行相同（单槽下被拒的退回串行，见上一例）
    const root = await createTempDir("projection-readoption-prefetch");
    const defaults = createDefaultDeviceCapacityPolicy();
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: { ...defaults, occupancy: { ...defaults.occupancy, slots: 8, memoryReservationBytes: 1024 ** 3 } },
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 32 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }) });
    const steps: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const leaf = leafProjectionReads(arbiter, steps);
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
      storageMaintenance: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }), lockSessionMaxHoldMs: 0,
      runProjectionReadStep: async (step, operation) => leaf(step, async () => {
        if (step !== "manifest") return operation();
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try { return await operation(); } finally { inFlight--; }
      }) });
    try {
      registerCounters(log);
      for (const id of COUNTERS) await log.append([{ stream: `job:${id}`, body: { n: 1 } }]);
      steps.length = 0; maxInFlight = 0;
      await log.append([{ stream: "job:counter-a", body: { n: 2 } }]);
      // 每个已登记的持久投影各读一次（含日志自带的保留引用投影）
      expect(steps.filter((step) => step === "manifest")).toHaveLength(COUNTERS.length + 1);
      expect(maxInFlight).toBeGreaterThan(1);
      for (const id of COUNTERS) {
        const latest = await log.transactDurableProjection(id, async (view) => ({ kind: "return", value: await view.get("latest") }));
        expect(latest.value).toEqual({ n: id === "counter-a" ? 2 : 1 });
      }
    } finally { await log.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps at most one group of unconsumed re-adoption prefetches and clears the group when adoption fails midway", async () => {
    // 预读按组：一组读完、按原顺序采纳、这一组清理之后才读下一组；未消费的预读不随候选总数累积。
    // 某个采纳中途暂时失败时，本组已开始的读取已收束、预读被清掉，锁外重试照原路径完成
    const root = await createTempDir("projection-readoption-groups");
    const ids = Array.from({ length: 12 }, (_, index) => `group-${String(index).padStart(2, "0")}`);
    const outstanding = new Set<FileDurableProjectionIndex>();
    let peak = 0, failOnce = true;
    const prefetch = FileDurableProjectionIndex.prototype.prefetchPublishedManifest;
    const refresh = FileDurableProjectionIndex.prototype.refreshPublishedState;
    const discard = FileDurableProjectionIndex.prototype.discardPrefetchedManifest;
    vi.spyOn(FileDurableProjectionIndex.prototype, "prefetchPublishedManifest").mockImplementation(async function (this: FileDurableProjectionIndex) {
      await prefetch.call(this);
      outstanding.add(this);
      peak = Math.max(peak, outstanding.size);
    });
    vi.spyOn(FileDurableProjectionIndex.prototype, "refreshPublishedState").mockImplementation(async function (this: FileDurableProjectionIndex) {
      if (failOnce && this.projectionId === "group-05") {
        failOnce = false;
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "slots", retryAfterMs: 1 });
      }
      outstanding.delete(this);
      return refresh.call(this);
    });
    vi.spyOn(FileDurableProjectionIndex.prototype, "discardPrefetchedManifest").mockImplementation(function (this: FileDurableProjectionIndex) {
      outstanding.delete(this);
      return discard.call(this);
    });
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), { lockSessionMaxHoldMs: 0 });
    try {
      for (const id of ids) {
        log.durableProjection({ projectionId: id, reducerVersion: 1, inputs: { streams: [`job:${id}`] },
          reduce: (envelope) => envelope.entries.filter((entry) => entry.stream === `job:${id}`).map((entry) => ({ kind: "put" as const, key: "latest", value: entry.body })) });
      }
      for (const id of ids) await log.append([{ stream: `job:${id}`, body: { n: 1 } }]);
      peak = 0;
      await log.append([{ stream: "job:group-00", body: { n: 2 } }]);
      expect(failOnce).toBe(false);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
      expect(outstanding.size).toBe(0);
      const latest = await log.transactDurableProjection("group-00", async (view) => ({ kind: "return", value: await view.get("latest") }));
      expect(latest.value).toEqual({ n: 2 });
    } finally { vi.restoreAllMocks(); await log.stopStorageMaintenance(); await rm(root, { recursive: true, force: true }); }
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
