import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity, FileDurableProjectionIndex } from "../index.js";
import {
  createDefaultDeviceCapacityPolicy, DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor, maintenanceRetryDelayMs,
  type DeviceCapacityDimension, type StorageMaintenanceGovernorPort,
} from "../../resources/index.js";

function meteredSingleSlot() {
  const policy = createDefaultDeviceCapacityPolicy();
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: { ...policy, occupancy: { ...policy.occupancy, slots: 1 } },
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3,
      processRssBytes: 64 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }),
  });
  const delegate = new DefaultStorageMaintenanceGovernor({ capacity });
  const steps: Array<{ kind: string; used: Partial<Record<DeviceCapacityDimension, number>> }> = [];
  const governor: StorageMaintenanceGovernorPort = {
    snapshot: () => delegate.snapshot(),
    acquire: async (request, abort) => {
      const result = await delegate.acquire(request, abort);
      if (result.kind !== "granted") return result;
      const permit = result.permit;
      return { kind: "granted", permit: {
        granted: permit.granted, release: () => permit.release(),
        tryBegin: bound => {
          const real = permit.tryBegin(bound);
          if (!real) return undefined;
          const row = { kind: request.kind, used: {} as Partial<Record<DeviceCapacityDimension, number>> };
          steps.push(row);
          return { complete: () => real.complete(), claim: (dimension, amount) => {
            real.claim(dimension, amount);
            row.used[dimension] = (row.used[dimension] ?? 0) + amount;
          } };
        },
      } };
    },
  };
  return { capacity, governor, steps };
}

it("publishes completed ranges before a real single-slot compaction exhausts its original read budget", async () => {
  const root = await createTempDir("compaction-real-quantum");
  const options = { rootDir: root, projectionId: "actual-budget", reducerVersion: 1,
    authenticated: true, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 41)),
    allowSegmentReclamation: false };
  let lsn = 0;
  const checkpoint = () => ({ source: { logId: "capacity-source", lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as const } });
  const key = (n: number) => `key-${String(n).padStart(4, "0")}`;
  const payload = "x".repeat(3 * 1024 * 1024);
  const seed = new FileDurableProjectionIndex(options);
  await seed.initialize(checkpoint());
  for (let batch = 0; batch < 10; batch++) {
    lsn++;
    seed.publish(await seed.prepare(Array.from({ length: 8 }, (_, n) => ({
      kind: "put" as const, key: key(n), value: { n, batch, payload },
    }))), checkpoint());
    await seed.flush({ compact: batch < 5 });
  }
  await seed.stopStorageMaintenance();
  const manifest = async () => JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const before = await manifest();
  expect(before.baseRoot.count).toBe(8);
  expect(before.compaction).toBeDefined();
  const { capacity, governor, steps } = meteredSingleSlot();
  const index = new FileDurableProjectionIndex({ ...options, storageMaintenance: governor });
  const generations: number[] = [];
  const deadline = Date.now() + 30_000;
  try {
    await index.initialize(checkpoint());
    for (;;) {
      try { await index.flush(); break; }
      catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || Date.now() >= deadline) throw error;
        generations.push((await manifest()).generation);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    const after = await manifest();
    expect(after.compaction).toBeUndefined();
    // Eight ranges no longer share an oversized step. The persisted prefix
    // advances in several admitted steps instead of rolling the same batch back.
    expect(after.generation - before.generation).toBeGreaterThan(1);
    expect(after.generation - before.generation).toBeLessThanOrEqual(9);
    const compactions = steps.filter(row => row.kind === "projection-compaction");
    expect(compactions.length).toBeGreaterThan(1);
    expect(compactions.some(row => (row.used.readBytes ?? 0) > 128 * 1024 ** 2)).toBe(true);
    for (const row of compactions) {
      expect(row.used.readBytes).toBeLessThanOrEqual(256 * 1024 ** 2);
      expect(row.used.writeBytes ?? 0).toBeLessThanOrEqual(256 * 1024 ** 2);
      expect(row.used.temporaryBytes ?? 0).toBeLessThanOrEqual(256 * 1024 ** 2);
      expect(row.used.ioOperations).toBeLessThanOrEqual(16_384);
    }
    expect(capacity.snapshot().lastViolation).toBeUndefined();
    expect(capacity.snapshot().occupancyInUse.slots).toBe(0);
    console.log(JSON.stringify({ ranges: 8, generations: after.generation - before.generation, steps: compactions, backpressureGenerations: generations }));
  } finally { await index.stopStorageMaintenance(); }
  const cold = new FileDurableProjectionIndex({ ...options, readOnly: true });
  try {
    await cold.initialize(checkpoint());
    for (let n = 0; n < 8; n++) expect(await cold.get(key(n))).toEqual({ n, batch: 9, payload });
  } finally { await cold.stopStorageMaintenance(); }
}, 60_000);
