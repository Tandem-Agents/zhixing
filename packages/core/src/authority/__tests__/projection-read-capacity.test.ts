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
import { FileArtifactStore, FileAuthorityCommitLog, FileDurableProjectionIndex, bindDurableProjectionMutations, durableProjectionDirectoryName } from "../index.js";
import { createDefaultDeviceCapacityPolicy, DefaultDeviceCapacityArbiter, DefaultStorageMaintenanceGovernor, runWithDeviceCapacity, withDeviceCapacityStep, currentDeviceCapacityStep, StorageMaintenanceAdmissionError } from "../../resources/index.js";

describe("authority projection physical reads", () => {
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
      const delta = await stored.prepare(bindDurableProjectionMutations([{ kind: "put", key: "skill", value: "saved" }]));
      stored.publish(delta, { authority: await writer.checkpoint() });
      expect(await stored.get("skill")).toMatchObject({ v: 1, value: "saved" });
      expect((await stored.scan({ gte: "skill", lt: "skillz" }, 1)).entries).toMatchObject([{ key: "skill", value: { v: 1, value: "saved" } }]);
      expect(readSteps).toEqual([]);
      await stored.flush();
      const log = new FileAuthorityCommitLog(logRoot, artifacts, { storageMaintenance: storage, runProjectionReadStep: async (_input, operation) => {
        const owner = currentDeviceCapacityStep();
        if (owner?.kind === "physical") return operation();
        const leaf = { occupancy: { memoryReservationBytes: 4096, temporaryBytes: 0, slots: owner?.kind === "workload" ? 0 : 1 }, quantum: { readBytes: 4096, writeBytes: 0, ioOperations: 32 } };
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
});
