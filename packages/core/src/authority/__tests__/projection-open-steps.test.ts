/**
 * 投影正常打开的只读快路径：每个容量步骤只预留自己的最坏读量（projection-open），不再一次预留 256 MiB/16384；
 * 内存预留覆盖各步同时存活的数据（清单读、单条段条目、目录页，加跨步留存的小部分）；
 * 最大值边界照常打开；有写意图时回退原单步；核验中途另一写者发布新代时丢弃候选、不拼两代；
 * 步骤被背压时不留半初始化。
 */
import { open, readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity, durableProjectionReadBudget, FileDurableProjectionIndex } from "../index.js";
import {
  createDefaultDeviceCapacityPolicy, DefaultDeviceCapacityArbiter, DefaultStorageMaintenanceGovernor, runHoldingMaintenanceExclusion,
  type DeviceCapacityDimension, type StorageMaintenanceGovernorPort, type StorageMaintenanceRequest,
} from "../../resources/index.js";

type Step = { kind: string; used: Partial<Record<DeviceCapacityDimension, number>>; atomic: StorageMaintenanceRequest["atomic"] };

function metered(intercept?: (request: StorageMaintenanceRequest) => ReturnType<StorageMaintenanceGovernorPort["acquire"]> | undefined) {
  const policy = createDefaultDeviceCapacityPolicy();
  const capacity = new DefaultDeviceCapacityArbiter({
    policy,
    probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 64 * 1024 ** 2, temporaryBytesAvailable: 8 * 1024 ** 3 }),
  });
  const delegate = new DefaultStorageMaintenanceGovernor({ capacity });
  const steps: Step[] = [];
  const governor: StorageMaintenanceGovernorPort = {
    snapshot: () => delegate.snapshot(),
    acquire: async (request, abort) => {
      const injected = intercept?.(request);
      if (injected) return injected;
      const result = await delegate.acquire(request, abort);
      if (result.kind !== "granted") return result;
      const permit = result.permit;
      return { kind: "granted", permit: {
        granted: permit.granted, release: () => permit.release(),
        tryBegin: bound => {
          const real = permit.tryBegin(bound);
          if (!real) return undefined;
          const row: Step = { kind: request.kind, used: {}, atomic: request.atomic };
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

const options = (root: string, projectionId: string) => ({ rootDir: root, projectionId, reducerVersion: 1, authenticated: true,
  integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 43)), allowSegmentReclamation: false });
let lsn = 0;
const checkpoint = () => ({ source: { logId: "open-source", lsn, frameEndOffset: 64 + lsn, prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as const } });
const key = (n: number) => `key-${String(n).padStart(4, "0")}`;
// 跨步留存（至多 5 个段描述符、目录页指针与清单摘要）的结构上界
const RETAINED_BYTES = 64 * 1024;
/** 每个打开步骤的内存预留不小于它可能执行的任一读取的物理估算加跨步留存。 */
function expectOpenMemoryCovers(atomic: StorageMaintenanceRequest["atomic"]) {
  for (const step of ["manifest", "segment-entry", "directory-page"] as const) {
    expect(atomic.occupancy.memoryReservationBytes).toBeGreaterThanOrEqual(durableProjectionReadBudget(step).memoryReservationBytes + RETAINED_BYTES);
  }
}

/** 写出若干增量段（不整理），返回最后一批的值。 */
async function seed(root: string, projectionId: string, batches: number, value: (n: number, batch: number) => unknown) {
  const index = new FileDurableProjectionIndex(options(root, projectionId));
  await index.initialize(checkpoint());
  for (let batch = 0; batch < batches; batch++) {
    lsn++;
    index.publish(await index.prepare(Array.from({ length: 4 }, (_, n) => ({ kind: "put" as const, key: key(n + batch * 4), value: value(n, batch) }))), checkpoint());
    await index.flush({ compact: false });
  }
  await index.stopStorageMaintenance();
}

it("opens a published projection through bounded read-only steps instead of one oversized reservation", async () => {
  const root = await createTempDir("projection-open-steps");
  await seed(root, "open-steps", 3, (n, batch) => ({ n, batch }));
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  expect(manifest.deltaSegments.length).toBeGreaterThan(0);
  const { capacity, governor, steps } = metered();
  const index = new FileDurableProjectionIndex({ ...options(root, "open-steps"), storageMaintenance: governor });
  try {
    await index.initialize(checkpoint());
    expect(await index.get(key(9))).toEqual({ n: 1, batch: 2 });
    const opening = steps.filter(row => row.kind === "projection-open");
    // 探测 + 每段一步 + 确认（无基础目录时没有目录页步骤）
    expect(opening.length).toBe(manifest.deltaSegments.length + 2 + (manifest.baseRoot ? 1 : 0));
    expect(steps.some(row => row.kind === "projection-scrub")).toBe(false);
    for (const row of opening) {
      expect(row.atomic.quantum.readBytes).toBe(40 * 1024 ** 2);
      expect(row.atomic.quantum.ioOperations).toBe(64);
      expectOpenMemoryCovers(row.atomic);
      expect(row.used.writeBytes ?? 0).toBe(0);
      expect(row.used.temporaryBytes ?? 0).toBe(0);
    }
    expect(capacity.snapshot().lastViolation).toBeUndefined();
  } finally { await index.stopStorageMaintenance(); }
});

it("opens segments whose boundary entries carry the largest values within the open budget", async () => {
  const root = await createTempDir("projection-open-worst");
  // 每段首尾都是接近单值上限的大值：核验读两条，仍在 40 MiB 内
  const large = "y".repeat(15 * 1024 * 1024);
  await seed(root, "open-worst", 2, n => (n === 0 || n === 3 ? { large } : { n }));
  const { capacity, governor, steps } = metered();
  const index = new FileDurableProjectionIndex({ ...options(root, "open-worst"), storageMaintenance: governor });
  try {
    await index.initialize(checkpoint());
    expect(await index.get(key(0))).toEqual({ large });
    const segmentSteps = steps.filter(row => row.kind === "projection-open" && (row.used.readBytes ?? 0) > 16 * 1024 ** 2);
    expect(segmentSteps.length).toBeGreaterThan(0);
    for (const row of segmentSteps) {
      expect(row.used.readBytes).toBeLessThanOrEqual(40 * 1024 ** 2);
      // 两条大值在同一步内依次读：预留须覆盖一条大值条目的物理估算加跨步留存，而不只是读量不越界
      expectOpenMemoryCovers(row.atomic);
    }
    expect(capacity.snapshot().lastViolation).toBeUndefined();
  } finally { await index.stopStorageMaintenance(); }
}, 60_000);

it("falls back to the original single initialization step when a write intent is left behind", async () => {
  const root = await createTempDir("projection-open-intent");
  await seed(root, "open-intent", 2, (n, batch) => ({ n, batch }));
  await writeFile(path.join(root, ".write-intent.tmp"), "torn");
  const { governor, steps } = metered();
  const index = new FileDurableProjectionIndex({ ...options(root, "open-intent"), storageMaintenance: governor });
  try {
    await index.initialize(checkpoint());
    expect(steps.some(row => row.kind === "projection-scrub")).toBe(true);
    await expect(readFile(path.join(root, ".write-intent.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await index.get(key(5))).toEqual({ n: 1, batch: 1 });
  } finally { await index.stopStorageMaintenance(); }
});

it("discards a candidate when another writer publishes between the probe and the confirmation", async () => {
  const root = await createTempDir("projection-open-race");
  await seed(root, "open-race", 2, (n, batch) => ({ n, batch }));
  const writer = new FileDurableProjectionIndex(options(root, "open-race"));
  await writer.initialize(checkpoint());
  let opens = 0, published = false;
  const { governor, steps } = metered();
  // 第一次探测之后、第一次段核验准入之前，另一写者发布新代
  const ordered: StorageMaintenanceGovernorPort = {
    snapshot: () => governor.snapshot(),
    acquire: async (request, abort) => {
      if (request.kind === "projection-open" && ++opens === 2 && !published) {
        published = true;
        lsn++;
        writer.publish(await writer.prepare([{ kind: "put", key: key(0), value: { replaced: true } }]), checkpoint());
        await writer.flush({ compact: false });
      }
      return governor.acquire(request, abort);
    },
  };
  const index = new FileDurableProjectionIndex({ ...options(root, "open-race"), storageMaintenance: ordered });
  try {
    await index.initialize({ source: { logId: "open-source", lsn: 0, frameEndOffset: 64, prefixDigest: `sha256:${"0".repeat(64)}` } });
    // 采用的是新代：读到另一写者刚发布的值，没有拼接旧代的结果
    expect(await index.get(key(0))).toEqual({ replaced: true });
    const probes = steps.filter(row => row.kind === "projection-open").length;
    expect(probes).toBeGreaterThan(2);
  } finally {
    await index.stopStorageMaintenance();
    await writer.stopStorageMaintenance();
  }
});

it.each([
  ["rewritten in place", async (file: string) => {
    // 同一文件对象内改动一个字节：文件身份与路径绑定不变，只有复读内容能发现
    const handle = await open(file, "r+");
    try {
      const bytes = await handle.readFile();
      const at = bytes.indexOf(Buffer.from('"integrity":"')) + 13;
      await handle.write(Buffer.from(bytes[at] === 0x30 ? "1" : "0"), 0, 1, at);
    } finally { await handle.close(); }
  }],
  ["truncated in place", async (file: string) => { await truncate(file, 16); }],
] as const)("does not adopt the probed candidate when the manifest is %s between the probe and the confirmation", async (_name, change) => {
  const root = await createTempDir("projection-open-inplace");
  await seed(root, "open-inplace", 2, (n, batch) => ({ n, batch }));
  const file = path.join(root, "manifest.json");
  let opens = 0;
  const { governor, steps } = metered();
  const ordered: StorageMaintenanceGovernorPort = {
    snapshot: () => governor.snapshot(),
    acquire: async (request, abort) => {
      if (request.kind === "projection-open" && ++opens === 2) await change(file);
      return governor.acquire(request, abort);
    },
  };
  const index = new FileDurableProjectionIndex({ ...options(root, "open-inplace"), storageMaintenance: ordered });
  try {
    // 候选已在探测时通过核验；改动之后不能沿用它：快路径放弃，交原单步初始化（它照原样拒绝损坏的清单）
    const outcome = await index.initialize(checkpoint()).then(() => "initialized", (error: unknown) => error);
    expect(steps.filter(row => row.kind === "projection-open").length).toBeGreaterThan(2);
    if (outcome === "initialized") expect(steps.some(row => row.kind === "projection-scrub")).toBe(true);
    else expect(String(outcome)).toMatch(/manifest/i);
  } finally { await index.stopStorageMaintenance(); }
});

it("leaves no half-initialized state when a verification step is backpressured inside an exclusion", async () => {
  const root = await createTempDir("projection-open-backpressure");
  await seed(root, "open-backpressure", 2, (n, batch) => ({ n, batch }));
  const before = await readFile(path.join(root, "manifest.json"), "utf8");
  let opens = 0;
  const { governor } = metered(request => request.kind === "projection-open" && ++opens === 2
    ? Promise.resolve({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 }) : undefined);
  const index = new FileDurableProjectionIndex({ ...options(root, "open-backpressure"), storageMaintenance: governor });
  try {
    // 持锁段内零等待：这一次打开以可重试背压失败，不写任何文件、不采用候选
    await expect(runHoldingMaintenanceExclusion(() => index.initialize(checkpoint()))).rejects.toThrow(/backpressured/);
    expect(await readFile(path.join(root, "manifest.json"), "utf8")).toBe(before);
    // 锁外再次打开：从头核验并采用
    await index.initialize(checkpoint());
    expect(await index.get(key(5))).toEqual({ n: 1, batch: 1 });
  } finally { await index.stopStorageMaintenance(); }
});
