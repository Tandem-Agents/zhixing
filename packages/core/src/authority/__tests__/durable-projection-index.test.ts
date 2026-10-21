import { open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SerialTaskQueue } from "../../persistence/serial-task-queue.js";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { CommitEnvelope, JsonValue } from "../../contracts/index.js";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  StorageMaintenanceTaskRunner, runHoldingMaintenanceExclusion, isHoldingMaintenanceExclusion,
  storageMaintenanceWorkKey,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceKind,
} from "../../resources/index.js";
import {
  bindDurableProjectionMutations,
  createBoundDurableProjectionReadContext,
  durableProjectionDirectoryName,
  DurableProjectionRecordBindingError,
  DurableProjectionStorageError,
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileDurableProjectionIndex,
  type DurableLogCheckpoint,
  type DurableProjectionIndex,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
} from "../index.js";

// 重 IO 组级预算：隔离文件约 63 秒，但根级 Windows 并发 fsync 基线中单项
// 已击穿 120 秒并使文件耗时达到约 252 秒。只把测试外层边界扩到两倍档；
// 生产期限、数据规模和断言失败路径仍保持不变并立即终止。
const DURABLE_IO_TEST_TIMEOUT_MS = 240_000;

function checkpoint(lsn: number): DurableLogCheckpoint {
  return {
    logId: "test-log",
    lsn,
    frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}`,
  };
}

function mutationsFor(
  envelope: CommitEnvelope<JsonValue>,
): readonly DurableProjectionMutation[] {
  return envelope.entries.flatMap((entry) => {
    const body = entry.body as {
      readonly t?: unknown;
      readonly key?: unknown;
      readonly value?: JsonValue;
    };
    if (body.t === "put" && typeof body.key === "string") {
      return [{ kind: "put", key: body.key, value: body.value ?? null }];
    }
    if (body.t === "delete" && typeof body.key === "string") {
      return [{ kind: "tombstone", key: body.key }];
    }
    return [];
  });
}

async function stateReadingMutationsFor(
  envelope: CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations = [...mutationsFor(envelope)];
  for (const entry of envelope.entries) {
    const body = entry.body as {
      readonly t?: unknown;
      readonly key?: unknown;
      readonly sourceKey?: unknown;
    };
    if (
      body.t === "copy" &&
      typeof body.key === "string" &&
      typeof body.sourceKey === "string"
    ) {
      mutations.push({
        kind: "put",
        key: body.key,
        value: (await current.get(body.sourceKey)) ?? null,
      });
    }
  }
  return mutations;
}

async function corruptFirstSegment(rootDir: string): Promise<void> {
  const manifest = await readProjectionManifest(rootDir);
  const segment = manifest.deltaSegments[0] ??
    (await readBaseSegments(rootDir, manifest.baseRoot))[0];
  if (!segment) throw new Error("Projection has no segment to corrupt");
  const segmentPath = path.join(rootDir, segment.dataFile);
  const bytes = await readFile(segmentPath);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
  await writeFile(segmentPath, bytes);
}

interface TestSegmentDescriptor {
  readonly id: string;
  readonly dataFile: string;
  readonly count: number;
  readonly minKey: string;
  readonly maxKey: string;
  readonly level: 0 | 1;
}

interface TestDirectoryPointer {
  readonly id: string;
  readonly height: number;
  readonly count: number;
}

async function readProjectionManifest(rootDir: string): Promise<{
  readonly generation: number;
  readonly checkpoints: Record<string, DurableLogCheckpoint>;
  readonly deltaSegments: TestSegmentDescriptor[];
  readonly compaction?: { readonly afterKey?: string };
  readonly baseRoot?: TestDirectoryPointer;
}> {
  return JSON.parse(
    await readFile(path.join(rootDir, "manifest.json"), "utf8"),
  );
}

async function readBaseSegments(
  rootDir: string,
  pointer: TestDirectoryPointer | undefined,
): Promise<TestSegmentDescriptor[]> {
  if (!pointer) return [];
  const page = JSON.parse(
    await readFile(
      path.join(rootDir, `directory-${pointer.id}.json`),
      "utf8",
    ),
  ) as {
    readonly descriptor: TestSegmentDescriptor;
    readonly left?: TestDirectoryPointer;
    readonly right?: TestDirectoryPointer;
  };
  return [
    ...(await readBaseSegments(rootDir, page.left)),
    page.descriptor,
    ...(await readBaseSegments(rootDir, page.right)),
  ];
}

async function readDirectoryPages(
  rootDir: string,
  pointer: TestDirectoryPointer | undefined,
): Promise<Map<string, {
  readonly descriptor: TestSegmentDescriptor;
  readonly left?: TestDirectoryPointer;
  readonly right?: TestDirectoryPointer;
}>> {
  const pages = new Map<string, {
    readonly descriptor: TestSegmentDescriptor;
    readonly left?: TestDirectoryPointer;
    readonly right?: TestDirectoryPointer;
  }>();
  const visit = async (
    current: TestDirectoryPointer | undefined,
  ): Promise<void> => {
    if (!current || pages.has(current.id)) return;
    const page = JSON.parse(
      await readFile(
        path.join(rootDir, `directory-${current.id}.json`),
        "utf8",
      ),
    ) as {
      readonly descriptor: TestSegmentDescriptor;
      readonly left?: TestDirectoryPointer;
      readonly right?: TestDirectoryPointer;
    };
    pages.set(current.id, page);
    await visit(page.left);
    await visit(page.right);
  };
  await visit(pointer);
  return pages;
}

async function createLaggingCorruptedProjection(
  name: string,
  corrupt = true,
): Promise<{
  readonly writer: FileAuthorityCommitLog;
  readonly log: FileAuthorityCommitLog;
  readonly projection: DurableProjectionIndex;
  readonly projectionRoot: string;
}> {
  const root = await createTempDir(`durable-projection-recovery-${name}`);
  const authorityRoot = path.join(root, "authority");
  const artifactStore = new FileArtifactStore(path.join(root, "artifacts"));
  const createLog = () =>
    new FileAuthorityCommitLog(authorityRoot, artifactStore);
  const writer = createLog();
  await writer.append([
    { stream: "publish", body: { t: "put", key: "seed-a", value: 1 } },
    { stream: "publish", body: { t: "put", key: "seed-z", value: 2 } },
  ]);

  const projectionId = `test.recovery.${name}`;
  const projectionRoot = path.join(
    authorityRoot,
    "projections",
    durableProjectionDirectoryName(projectionId),
  );
  const stored = new FileDurableProjectionIndex({
    rootDir: projectionRoot,
    projectionId,
    reducerVersion: 1,
  });
  await stored.initialize({ authority: await writer.originCheckpoint() });
  const prepared = await stored.prepare(
    bindDurableProjectionMutations([
      { kind: "put", key: "seed-a", value: 1 },
      { kind: "put", key: "seed-z", value: 2 },
    ]),
  );
  stored.publish(prepared, { authority: await writer.checkpoint() });
  await stored.flush();

  const log = createLog();
  const projection = log.durableProjection({
    projectionId,
    reducerVersion: 1,
    reduce: stateReadingMutationsFor,
  });
  await projection.checkpoints();
  if (corrupt) await corruptFirstSegment(projectionRoot);
  return { writer, log, projection, projectionRoot };
}

describe("FileDurableProjectionIndex", () => {
  it("batches physical segment IO while preserving large entries and cold corruption checks", async () => {
    const rootDir = await createTempDir("projection-physical-batches");
    const options = { rootDir, projectionId: "physical-batches", reducerVersion: 1 };
    const index = new FileDurableProjectionIndex(options);
    await index.initialize({ authority: checkpoint(0) });
    const handle = await open(path.join(rootDir, "io-probe"), "w");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const writes = vi.spyOn(prototype, "writeFile");
    const reads = vi.spyOn(prototype, "read");
    const entries = Array.from({ length: 512 }, (_, id) => ({ kind: "put" as const, key: "key-" + id.toString().padStart(4, "0"), value: { id, text: "中文🙂".repeat(id === 511 ? 20_000 : 12) } }));
    try {
      index.publish(await index.prepare(entries), { authority: checkpoint(1) });
      writes.mockClear();
      await index.flush();
      expect(writes.mock.calls.length).toBeLessThan(100);
      const cold = new FileDurableProjectionIndex(options);
      await cold.initialize({ authority: checkpoint(0) });
      reads.mockClear();
      const page = await cold.scan({}, 256);
      expect(page.entries).toEqual(entries.slice(0, 256).map(({ key, value }) => ({ key, value })));
      expect(reads.mock.calls.length).toBeLessThan(400);
      expect(await cold.get("key-0511")).toEqual(entries[511]!.value);
      await corruptFirstSegment(rootDir);
      await expect(cold.get("key-0511")).rejects.toThrow(DurableProjectionStorageError);
      await cold.stopStorageMaintenance();
    } finally {
      writes.mockRestore(); reads.mockRestore();
      await index.stopStorageMaintenance();
    }
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it('reuses verified segment entries for repeated lookups and still detects an out-of-band rewrite', async () => {
    const rootDir = await createTempDir('projection-entry-reuse');
    const options = { rootDir, projectionId: 'entry-reuse', reducerVersion: 1 };
    const writer = new FileDurableProjectionIndex(options);
    await writer.initialize({ authority: checkpoint(0) });
    writer.publish(await writer.prepare(Array.from({ length: 200 }, (_, id) => ({
      kind: 'put' as const, key: 'key-' + id.toString().padStart(3, '0'), value: { id, text: 'value-' + id },
    }))), { authority: checkpoint(1) });
    await writer.flush();
    const steps: string[] = [];
    const reader = new FileDurableProjectionIndex({ ...options, runReadStep: async (step, operation) => { steps.push(step); return operation(); } });
    await reader.initialize({ authority: checkpoint(0) });
    expect(await reader.get('key-123')).toEqual({ id: 123, text: 'value-123' });
    const coldEntries = steps.filter(step => step === 'segment-entry').length;
    expect(coldEntries).toBeGreaterThan(0);
    steps.length = 0;
    // 同一查询再次执行：只核对一次段文件身份，不再打开文件、不再读条目。
    const repeated = await reader.get('key-123') as { id: number };
    expect(repeated).toEqual({ id: 123, text: 'value-123' });
    expect(steps).toEqual(['segment-open']);
    // 返回值每次重新解析：调用方改动不影响后续读取。
    repeated.id = -1;
    expect(await reader.getMany(['key-123', 'key-124'])).toEqual([{ id: 123, text: 'value-123' }, { id: 124, text: 'value-124' }]);
    // 带外改写段文件（末尾条目）：身份变化使缓存失效，回到真实读取，读到被改写的条目即发现损坏。
    expect(await reader.get('key-199')).toEqual({ id: 199, text: 'value-199' });
    await corruptFirstSegment(rootDir);
    steps.length = 0;
    expect(await reader.get('key-123')).toEqual({ id: 123, text: 'value-123' });
    expect(steps.filter(step => step === 'segment-entry').length).toBeGreaterThan(0);
    await expect(reader.get('key-199')).rejects.toThrow(DurableProjectionStorageError);
    await Promise.all([writer.stopStorageMaintenance(), reader.stopStorageMaintenance()]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it('shares bounded multi-key segment reads across base, deltas, tombstones and a cold reopen', async () => {
    const rootDir = await createTempDir('projection-batch-read');
    const options = { rootDir, projectionId: 'batch-read', reducerVersion: 1 };
    const index = new FileDurableProjectionIndex(options);
    await index.initialize({ authority: checkpoint(0) });
    let revision = 0;
    const publish = async (mutations: DurableProjectionMutation[]) => {
      index.publish(await index.prepare(mutations), { authority: checkpoint(++revision) });
      await index.flush();
    };
    for (let page = 0; page < 5; page++) await publish(Array.from({ length: 64 }, (_, offset) => {
      const id = page * 64 + offset;
      return { kind: 'put' as const, key: 'key-' + id.toString().padStart(3, '0'), value: id };
    }));
    await publish([{ kind: 'tombstone', key: 'key-007' }, { kind: 'put', key: 'key-008', value: 'replaced' }]);
    const steps: string[] = [];
    const cold = new FileDurableProjectionIndex({ ...options, runReadStep: async (step, operation) => { steps.push(step); return operation(); } });
    await cold.initialize({ authority: checkpoint(0) });
    cold.publish(await cold.prepare([{ kind: 'put', key: 'key-009', value: 'active' }]), { authority: checkpoint(++revision) });
    steps.length = 0;
    const keys = ['key-008', 'missing', 'key-007', 'key-009', 'key-008', ...Array.from({ length: 240 }, (_, id) => 'key-' + (319 - id).toString().padStart(3, '0'))];
    expect(await cold.getMany(keys)).toEqual(['replaced', undefined, undefined, 'active', 'replaced', ...Array.from({ length: 240 }, (_, id) => 319 - id)]);
    expect(steps.filter(step => step === 'segment-open').length).toBeLessThanOrEqual(7);
    expect(steps.filter(step => step === 'segment-entry').length).toBeLessThan(350);
    expect(await cold.getMany([])).toEqual([]);
    await expect(cold.getMany(Array(257).fill('key-001'))).rejects.toThrow();
    await expect(cold.getMany(Array(1))).rejects.toThrow();
    await corruptFirstSegment(rootDir);
    await expect(cold.getMany(['key-008'])).rejects.toThrow(DurableProjectionStorageError);
    await Promise.all([index.stopStorageMaintenance(), cold.stopStorageMaintenance()]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("coalesces a short verified cold catch-up, saves it on formal stop and still rejects later authority corruption", async () => {
    const root = await createTempDir("projection-cold-checkpoint");
    const artifactStore = new FileArtifactStore(path.join(root, "artifacts"));
    const logRoot = path.join(root, "authority");
    const writer = new FileAuthorityCommitLog(logRoot, artifactStore);
    const definition = { projectionId: "cold-checkpoint", reducerVersion: 1, reduce: mutationsFor };
    const live = writer.durableProjection(definition);
    await expect(live.get("item")).resolves.toBeUndefined();
    for (let value = 0; value < 5; value++) {
      await writer.append([{ stream: "publish", body: { t: "put", key: "item", value } }]);
    }
    // A recovery page publishes its cursor and rows together, so another
    // process never has to pay for the same already completed catch-up again.
    const first = new FileAuthorityCommitLog(logRoot, artifactStore);
    const firstReduce = vi.fn(mutationsFor);
    const firstIndex = first.durableProjection({ ...definition, reduce: firstReduce });
    const flush = vi.spyOn(FileDurableProjectionIndex.prototype, "flush");
    try {
      await expect(firstIndex.get("item")).resolves.toBe(4);
      await expect(firstIndex.get("item")).resolves.toBe(4);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledWith({ compact: false });
    } finally { flush.mockRestore(); }
    expect(firstReduce).toHaveBeenCalledTimes(5);
    const persisted = await readProjectionManifest(path.join(logRoot, "projections", durableProjectionDirectoryName(definition.projectionId) + ".v1"));
    expect(persisted.checkpoints.authority?.lsn).toBe(5);
    await first.stopStorageMaintenance();
    await writer.stopStorageMaintenance();
    const second = new FileAuthorityCommitLog(logRoot, artifactStore);
    const secondReduce = vi.fn(mutationsFor);
    const recovered = second.durableProjection({ ...definition, reduce: secondReduce });
    try {
      await expect(recovered.get("item")).resolves.toBe(4);
      expect(secondReduce).not.toHaveBeenCalled();
      const walPath = path.join(logRoot, "authority.log");
      const wal = await readFile(walPath);
      const position = wal.indexOf(Buffer.from('"value":0'));
      expect(position).toBeGreaterThan(0);
      wal[position + Buffer.byteLength('"value":')] = '9'.charCodeAt(0);
      await writeFile(walPath, wal);
      await expect(recovered.get("item")).rejects.toMatchObject({ code: "invalid-authority-record" });
    } finally { await second.stopStorageMaintenance(); }
  });

  it("retries transient initialize backpressure outside the manifest queue", async () => {
    const root = await createTempDir("durable-projection-initialize-backpressure");
    const governor = new DefaultStorageMaintenanceGovernor({
      capacity: new DefaultDeviceCapacityArbiter({
        policy: createDefaultDeviceCapacityPolicy(),
        probe: () => ({
          cpuBusyRatio: 0,
          availableMemoryBytes: 8 * 1024 * 1024 * 1024,
          processRssBytes: 64 * 1024 * 1024,
          temporaryBytesAvailable: 8 * 1024 * 1024 * 1024,
        }),
      }),
    });
    let scrubAdmissions = 0;
    const interrupted: StorageMaintenanceGovernorPort = {
      acquire: (request, abort) => {
        if (request.kind === "projection-scrub" && ++scrubAdmissions === 1) {
          return Promise.resolve({
            kind: "backpressured",
            blockedBy: "slots",
            retryAfterMs: 1,
          });
        }
        return governor.acquire(request, abort);
      },
      snapshot: () => governor.snapshot(),
    };
    const index = new FileDurableProjectionIndex({
      rootDir: root,
      projectionId: "test.initialize-backpressure",
      reducerVersion: 1,
      storageMaintenance: interrupted,
    });

    await index.initialize({ source: checkpoint(0) });

    expect(scrubAdmissions).toBeGreaterThanOrEqual(2);
    expect(index.checkpoints()).toEqual({ source: checkpoint(0) });
    await index.stopStorageMaintenance();
  });

  it(
    "rejects checksum-valid records copied under another physical key",
    async () => {
      const root = await createTempDir("durable-projection-record-binding");
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.record-binding",
        reducerVersion: 1,
      });
      await index.initialize({ source: checkpoint(0) });
      const [bound] = bindDurableProjectionMutations([
        { kind: "put", key: "identity/b", value: { identity: "b" } },
      ]);
      if (bound?.kind !== "put") throw new Error("Expected a bound put");
      const prepared = await index.prepare([
        { kind: "put", key: "identity/a", value: bound.value },
      ]);
      index.publish(prepared, { source: checkpoint(1) });
      await index.flush();
      const records = createBoundDurableProjectionReadContext(index);

      await expect(records.get("identity/a")).rejects.toBeInstanceOf(
        DurableProjectionRecordBindingError,
      );
      await expect(records.scan({}, 8)).rejects.toBeInstanceOf(
        DurableProjectionRecordBindingError,
      );
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "persists exact lookups, tombstones, ordered paging, and compaction",
    async () => {
      const root = await createTempDir("durable-projection-index");
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.compaction",
        reducerVersion: 1,
        overlayEntries: 1,
        overlayBytes: 1_024,
      });
      await index.initialize({ source: checkpoint(0) });
      const exposedCheckpoints = index.checkpoints() as {
        source: { lsn: number };
      };
      exposedCheckpoints.source.lsn = 99;
      expect(index.checkpoints().source?.lsn).toBe(0);

      for (let value = 0; value < 12; value += 1) {
        const prepared = await index.prepare([
          {
            kind: "put",
            key: `key-${value.toString().padStart(2, "0")}`,
            value,
          },
        ]);
        index.publish(prepared, { source: checkpoint(value + 1) });
      }
      let prepared = await index.prepare([
        { kind: "tombstone", key: "key-03" },
      ]);
      index.publish(prepared, { source: checkpoint(13) });
      await index.flush();

      await expect(index.get("key-03")).resolves.toBeUndefined();
      await expect(index.get("key-11")).resolves.toBe(11);
      const first = await index.scan({ gte: "key-", lt: "key." }, 4);
      expect(first.entries.map(({ key }) => key)).toEqual([
        "key-00",
        "key-01",
        "key-02",
        "key-04",
      ]);
      expect(first.continuation).toBeDefined();

      prepared = await index.prepare([
        { kind: "put", key: "key-025", value: "newer" },
      ]);
      index.publish(prepared, { source: checkpoint(14) });
      const second = await index.scan(
        { gte: "key-", lt: "key." },
        4,
        first.continuation,
      );
      expect(second.entries.map(({ key }) => key)).toEqual([
        "key-05",
        "key-06",
        "key-07",
        "key-08",
      ]);

      const reopened = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.compaction",
        reducerVersion: 1,
      });
      await reopened.initialize({ source: checkpoint(0) });
      await expect(reopened.get("key-11")).resolves.toBe(11);
      await expect(reopened.get("key-03")).resolves.toBeUndefined();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "uses a valid exclusive lower bound for resumable scans",
    async () => {
      const root = await createTempDir("durable-projection-exclusive-range");
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.exclusive-range",
        reducerVersion: 1,
      });
      await index.initialize({ source: checkpoint(0) });
      const prepared = await index.prepare([
        { kind: "put", key: "scope/a", value: 1 },
        { kind: "put", key: "scope/b", value: 2 },
        { kind: "put", key: "scope/c", value: 3 },
      ]);
      index.publish(prepared, { source: checkpoint(1) });

      await expect(
        index.scan({ gt: "scope/a", lt: "scope/\uffff" }, 8),
      ).resolves.toEqual({
        entries: [
          { key: "scope/b", value: 2 },
          { key: "scope/c", value: 3 },
        ],
      });
      await expect(
        index.scan(
          { gte: "scope/", gt: "scope/a", lt: "scope/\uffff" },
          8,
        ),
      ).rejects.toThrow("cannot combine gte and gt");
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "persists checkpoint progress for hot-key and no-op publications",
    async () => {
      const root = await createTempDir("durable-projection-hot-progress");
      const createIndex = () =>
        new FileDurableProjectionIndex({
          rootDir: root,
          projectionId: "test.hot-progress",
          reducerVersion: 1,
          overlayEntries: 2,
          overlayBytes: 1_024,
        });
      const index = createIndex();
      await index.initialize({ source: checkpoint(0) });
      for (let value = 0; value < 8; value += 1) {
        const prepared = await index.prepare([
          { kind: "put", key: "hot", value },
        ]);
        index.publish(prepared, { source: checkpoint(value + 1) });
      }
      expect(
        (await readProjectionManifest(root)).checkpoints.source?.lsn,
      ).toBe(6);

      const reopened = createIndex();
      await reopened.initialize({ source: checkpoint(0) });
      await expect(reopened.get("hot")).resolves.toBe(5);
      for (let lsn = 7; lsn <= 9; lsn += 1) {
        const prepared = await reopened.prepare([]);
        reopened.publish(prepared, { source: checkpoint(lsn) });
      }
      expect(
        (await readProjectionManifest(root)).checkpoints.source?.lsn,
      ).toBe(8);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "compacts only touched base partitions and reclaims tombstones",
    async () => {
      const root = await createTempDir("durable-projection-leveled-compaction");
      const maintenanceKinds: StorageMaintenanceKind[] = [];
      const basePolicy = createDefaultDeviceCapacityPolicy();
      const governor = new DefaultStorageMaintenanceGovernor({
        capacity: new DefaultDeviceCapacityArbiter({
          policy: {
            ...basePolicy,
            quantum: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
            quantumRefillPerSecond: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
          },
          probe: () => ({
            cpuBusyRatio: 0,
            availableMemoryBytes: 8 * 1024 * 1024 * 1024,
            processRssBytes: 64 * 1024 * 1024,
            temporaryBytesAvailable: 8 * 1024 * 1024 * 1024,
          }),
        }),
      });
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: (request, abort) => {
          maintenanceKinds.push(request.kind);
          return governor.acquire(request, abort);
        },
        snapshot: () => governor.snapshot(),
      };
      const createIndex = () =>
        new FileDurableProjectionIndex({
          rootDir: root,
          projectionId: "test.leveled-compaction",
          reducerVersion: 1,
          overlayEntries: 2_048,
          overlayBytes: 4 * 1024 * 1024,
          storageMaintenance,
        });
      const index = createIndex();
      await index.initialize({ source: checkpoint(0) });
      const entries = Array.from({ length: 1_024 }, (_, value) => ({
        kind: "put" as const,
        key: `key-${value.toString().padStart(4, "0")}`,
        value,
      }));
      for (let page = 0; page < 5; page += 1) {
        const start = Math.floor((entries.length * page) / 5);
        const end = Math.floor((entries.length * (page + 1)) / 5);
        const prepared = await index.prepare(entries.slice(start, end));
        index.publish(prepared, { source: checkpoint(page + 1) });
        await index.flush();
      }
      const initialManifest = await readProjectionManifest(root);
      const initialBases = await readBaseSegments(
        root,
        initialManifest.baseRoot,
      );
      expect(initialBases.length).toBeGreaterThan(1);
      const untouched = initialBases.find(({ minKey, maxKey }) =>
        minKey <= "key-0800" && maxKey >= "key-0800"
      );
      expect(untouched).toBeDefined();

      const runObligation = vi.spyOn(
        StorageMaintenanceTaskRunner.prototype,
        "run",
      );
      try {
        for (let page = 0; page < 5; page += 1) {
          if (page === 4) runObligation.mockClear();
          const prepared = await index.prepare(
            page === 4
              ? [{ kind: "tombstone", key: "key-0000" }]
              : [{ kind: "put", key: "key-0000", value: page + 10 }],
          );
          index.publish(prepared, { source: checkpoint(page + 6) });
          await index.flush();
        }
        const retirementWorkKey = storageMaintenanceWorkKey(
          "projection-compaction",
          `test.leveled-compaction:${path.resolve(root)}`,
          { phase: "retirement-cleanup" },
        );
        // The final flush performs multiple compaction transitions. Every
        // transition must re-enter the same fixed retirement obligation; the
        // old bypass only produced the outer start/final pair.
        expect(
          runObligation.mock.calls.filter(
            ([request]) => request.workKey === retirementWorkKey,
          ).length,
        ).toBeGreaterThan(2);
      } finally {
        runObligation.mockRestore();
      }
      const compacted = await readProjectionManifest(root);
      expect(compacted.deltaSegments).toHaveLength(0);
      const compactedBases = await readBaseSegments(root, compacted.baseRoot);
      expect(
        compactedBases.some(({ id }) => id === untouched?.id),
      ).toBe(true);
      await expect(index.get("key-0000")).resolves.toBeUndefined();
      await expect(index.get("key-0800")).resolves.toBe(800);
      await expect(
        index.scan({ gte: "key-0798", lt: "key-0803" }, 5),
      ).resolves.toEqual({
        entries: [
          { key: "key-0798", value: 798 },
          { key: "key-0799", value: 799 },
          { key: "key-0800", value: 800 },
          { key: "key-0801", value: 801 },
          { key: "key-0802", value: 802 },
        ],
        continuation: expect.any(String),
      });
      expect(
        maintenanceKinds.filter((kind) => kind === "projection-compaction")
          .length,
      ).toBeGreaterThan(2);

      const reopened = createIndex();
      await reopened.initialize({ source: checkpoint(0) });
      await expect(reopened.get("key-0000")).resolves.toBeUndefined();
      await expect(reopened.get("key-0800")).resolves.toBe(800);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "resumes a checkpointed compaction after capacity backpressure",
    async () => {
      const root = await createTempDir("durable-projection-resume-compaction");
      const basePolicy = createDefaultDeviceCapacityPolicy();
      const governor = new DefaultStorageMaintenanceGovernor({
        capacity: new DefaultDeviceCapacityArbiter({
          policy: {
            ...basePolicy,
            quantum: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
            quantumRefillPerSecond: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
          },
          probe: () => ({
            cpuBusyRatio: 0,
            availableMemoryBytes: 8 * 1024 * 1024 * 1024,
            processRssBytes: 64 * 1024 * 1024,
            temporaryBytesAvailable: 8 * 1024 * 1024 * 1024,
          }),
        }),
      });
      let compactionAdmissions = 0;
      let interruptCompaction = false;
      const interrupted: StorageMaintenanceGovernorPort = {
        acquire: (request, abort) => {
          if (
            interruptCompaction && request.kind === "projection-compaction" &&
            ++compactionAdmissions === 2
          ) {
            return Promise.resolve({
              kind: "backpressured",
              blockedBy: "ioOperations",
              retryAfterMs: 1,
            });
          }
          return governor.acquire(request, abort);
        },
        snapshot: () => governor.snapshot(),
      };
      const createIndex = (storageMaintenance: StorageMaintenanceGovernorPort) =>
        new FileDurableProjectionIndex({
          rootDir: root,
          projectionId: "test.resume-compaction",
          reducerVersion: 1,
          allowSegmentReclamation: false,
          overlayEntries: 2_048,
          overlayBytes: 4 * 1024 * 1024,
          storageMaintenance,
        });
      const index = createIndex(interrupted);
      await index.initialize({ source: checkpoint(0) });
      const entries = Array.from({ length: 10_240 }, (_, value) => ({
        kind: "put" as const,
        key: `key-${value.toString().padStart(5, "0")}`,
        value,
      }));
      for (let page = 0; page < 20; page += 1) {
        const prepared = await index.prepare(
          entries.slice(page * 512, (page + 1) * 512),
        );
        index.publish(prepared, { source: checkpoint(page + 1) });
        await index.flush();
      }
      expect((await readProjectionManifest(root)).baseRoot?.count).toBeGreaterThanOrEqual(16);
      for (let page = 0; page < 5; page++) {
        index.publish(await index.prepare(Array.from({ length: 20 }, (_, group) => ({
          kind: "put" as const, key: `key-${String(group * 512).padStart(5, "0")}`, value: group * 512,
        }))), { source: checkpoint(21 + page) });
        await index.flush({ compact: false });
      }
      interruptCompaction = true;
      await expect(index.flush()).rejects.toThrow("backpressured");

      const interruptedManifest = await readProjectionManifest(root);
      expect(interruptedManifest.compaction?.afterKey).toBeDefined();
      expect(interruptedManifest.deltaSegments).toHaveLength(5);
      await expect(index.get("key-10239")).resolves.toBe(10_239);
      await index.stopStorageMaintenance();

      const resumed = createIndex(governor);
      await resumed.initialize({ source: checkpoint(0) });
      await resumed.flush();
      const completed = await readProjectionManifest(root);
      expect(completed.compaction).toBeUndefined();
      expect(completed.deltaSegments).toHaveLength(0);
      await expect(resumed.get("key-00000")).resolves.toBe(0);
      await expect(resumed.get("key-10239")).resolves.toBe(10_239);
      await resumed.stopStorageMaintenance();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "publishes a new reset root without enumerating or deleting unproven old files",
    async () => {
      const root = await createTempDir("durable-projection-bounded-reset");
      const basePolicy = createDefaultDeviceCapacityPolicy();
      const governor = new DefaultStorageMaintenanceGovernor({
        capacity: new DefaultDeviceCapacityArbiter({
          policy: {
            ...basePolicy,
            quantum: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
            quantumRefillPerSecond: {
              readBytes: 1024 * 1024 * 1024,
              writeBytes: 1024 * 1024 * 1024,
              ioOperations: 1_000_000,
            },
          },
          probe: () => ({
            cpuBusyRatio: 0,
            availableMemoryBytes: 8 * 1024 * 1024 * 1024,
            processRssBytes: 64 * 1024 * 1024,
            temporaryBytesAvailable: 8 * 1024 * 1024 * 1024,
          }),
        }),
      });
      let rebuildAdmissions = 0;
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: (request, abort) => {
          if (request.kind === "projection-rebuild") rebuildAdmissions += 1;
          return governor.acquire(request, abort);
        },
        snapshot: () => governor.snapshot(),
      };
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.bounded-reset",
        reducerVersion: 1,
        storageMaintenance,
      });
      await index.initialize({ source: checkpoint(0) });
      await Promise.all(
        Array.from({ length: 130 }, (_, item) =>
          writeFile(
            path.join(root, `orphan-${item.toString().padStart(3, "0")}`),
            "orphan",
          ),
        ),
      );

      await index.reset({ source: checkpoint(0) });

      expect(rebuildAdmissions).toBe(1);
      expect(await readdir(root)).toHaveLength(131);
      expect(await readFile(path.join(root, "orphan-000"), "utf8")).toBe("orphan");
      await expect(index.scan({}, 1)).resolves.toEqual({ entries: [] });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps directory metadata paged, path-local, and lazily verified",
    async () => {
      const root = await createTempDir("durable-projection-paged-directory");
      const createIndex = () =>
        new FileDurableProjectionIndex({
          rootDir: root,
          projectionId: "test.paged-directory",
          reducerVersion: 1,
          overlayEntries: 8_192,
          overlayBytes: 16 * 1024 * 1024,
        });
      const index = createIndex();
      await index.initialize({ source: checkpoint(0) });
      const publishRange = async (
        start: number,
        count: number,
        firstLsn: number,
      ): Promise<void> => {
        for (let page = 0; page < 5; page += 1) {
          const from = start + Math.floor((count * page) / 5);
          const to = start + Math.floor((count * (page + 1)) / 5);
          const prepared = await index.prepare(
            Array.from({ length: to - from }, (_, offset) => {
              const value = from + offset;
              return {
                kind: "put" as const,
                key: `key-${value.toString().padStart(5, "0")}`,
                value,
              };
            }),
          );
          index.publish(prepared, {
            source: checkpoint(firstLsn + page),
          });
          await index.flush();
        }
      };

      await publishRange(0, 4_096, 1);
      const firstManifestBytes = await readFile(
        path.join(root, "manifest.json"),
      );
      const firstManifest = await readProjectionManifest(root);
      const firstPages = await readDirectoryPages(
        root,
        firstManifest.baseRoot,
      );
      expect(firstPages.size).toBeGreaterThan(4);

      await publishRange(4_096, 4_096, 6);
      const grownManifestBytes = await readFile(
        path.join(root, "manifest.json"),
      );
      const grownManifest = await readProjectionManifest(root);
      const grownPages = await readDirectoryPages(
        root,
        grownManifest.baseRoot,
      );
      expect(grownPages.size).toBeGreaterThan(firstPages.size);
      expect(
        Math.abs(grownManifestBytes.byteLength - firstManifestBytes.byteLength),
      ).toBeLessThan(96);

      const beforeHotUpdate = new Set(grownPages.keys());
      for (let value = 0; value < 5; value += 1) {
        const prepared = await index.prepare([
          { kind: "put", key: "key-00000", value: 10_000 + value },
        ]);
        index.publish(prepared, { source: checkpoint(11 + value) });
        await index.flush();
      }
      const compactedManifest = await readProjectionManifest(root);
      const compactedPages = await readDirectoryPages(
        root,
        compactedManifest.baseRoot,
      );
      const changedPages = [...compactedPages.keys()].filter(
        (id) => !beforeHotUpdate.has(id),
      );
      expect(changedPages.length).toBeLessThanOrEqual(
        2 * (grownManifest.baseRoot?.height ?? 0) + 4,
      );
      expect(
        [...compactedPages.keys()].some((id) => beforeHotUpdate.has(id)),
      ).toBe(true);

      const healthyReopen = createIndex();
      await healthyReopen.initialize({ source: checkpoint(0) });
      await expect(healthyReopen.get("key-08191")).resolves.toBe(8_191);
      await expect(
        healthyReopen.scan(
          { gte: "key-08188", lt: "key-08192" },
          4,
        ),
      ).resolves.toMatchObject({
        entries: [
          { key: "key-08188", value: 8_188 },
          { key: "key-08189", value: 8_189 },
          { key: "key-08190", value: 8_190 },
          { key: "key-08191", value: 8_191 },
        ],
      });

      const corruptTarget = [...compactedPages.entries()].find(
        ([id]) => id !== compactedManifest.baseRoot?.id,
      );
      expect(corruptTarget).toBeDefined();
      const [corruptId, corruptPage] = corruptTarget!;
      const corruptPath = path.join(root, `directory-${corruptId}.json`);
      const bytes = await readFile(corruptPath);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      await writeFile(corruptPath, bytes);

      const reopened = createIndex();
      await expect(
        reopened.initialize({ source: checkpoint(0) }),
      ).resolves.toBeUndefined();
      await expect(
        reopened.get(corruptPage.descriptor.minKey),
      ).rejects.toBeInstanceOf(DurableProjectionStorageError);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps compacted segments until a fixed read view is released",
    async () => {
      const root = await createTempDir("durable-projection-pinned-compaction");
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.pinned-compaction",
        reducerVersion: 1,
      });
      await index.initialize({ source: checkpoint(0) });
      let prepared = await index.prepare([
        { kind: "put", key: "a", value: 1 },
        { kind: "put", key: "b", value: 2 },
      ]);
      index.publish(prepared, { source: checkpoint(1) });
      await index.flush();

      const first = await index.scan({}, 1);
      expect(first).toMatchObject({ entries: [{ key: "a", value: 1 }] });

      for (let value = 0; value < 4; value += 1) {
        prepared = await index.prepare([
          { kind: "put", key: `z-${value}`, value },
        ]);
        index.publish(prepared, { source: checkpoint(value + 2) });
        await index.flush();
      }

      const second = await index.scan({}, 1, first.continuation);
      expect(second).toMatchObject({ entries: [{ key: "b", value: 2 }] });
      await expect(index.scan({}, 1, second.continuation)).resolves.toEqual({
        entries: [],
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "removes files from an uncommitted write intent before reopening",
    async () => {
      const root = await createTempDir("durable-projection-write-intent");
      const createIndex = () =>
        new FileDurableProjectionIndex({
          rootDir: root,
          projectionId: "test.write-intent",
          reducerVersion: 1,
        });
      const index = createIndex();
      await index.initialize({ source: checkpoint(0) });
      const prepared = await index.prepare([
        { kind: "put", key: "stable", value: 1 },
      ]);
      index.publish(prepared, { source: checkpoint(1) });
      await index.flush();

      const manifest = await readProjectionManifest(root);
      const orphan = `directory-${"a".repeat(64)}.json`;
      await writeFile(path.join(root, orphan), "{}");
      await writeFile(
        path.join(root, "write-intent.json"),
        JSON.stringify({
          createdFiles: [orphan],
          formatVersion: 1,
          targetGeneration: manifest.generation + 1,
          transientFiles: [],
        }),
      );

      const reopened = createIndex();
      await reopened.initialize({ source: checkpoint(0) });
      await expect(reopened.get("stable")).resolves.toBe(1);
      await expect(readFile(path.join(root, orphan))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(path.join(root, "write-intent.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "detects a corrupted segment entry instead of returning silent data",
    async () => {
      const root = await createTempDir("durable-projection-corrupt");
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.corruption",
        reducerVersion: 1,
      });
      await index.initialize({ source: checkpoint(0) });
      const prepared = await index.prepare([
        { kind: "put", key: "asset/a", value: { bytes: 1 } },
      ]);
      index.publish(prepared, { source: checkpoint(1) });
      await index.flush();

      await corruptFirstSegment(root);

      await expect(index.get("asset/a")).rejects.toBeInstanceOf(
        DurableProjectionStorageError,
      );
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "never evicts a read view while its current page is still being read",
    async () => {
      const root = await createTempDir("durable-projection-read-views");
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.read-views",
        reducerVersion: 1,
      });
      await index.initialize({ source: checkpoint(0) });
      const prepared = await index.prepare([
        { kind: "put", key: "a", value: 1 },
        { kind: "put", key: "b", value: 2 },
      ]);
      index.publish(prepared, { source: checkpoint(1) });
      await index.flush();

      const pages = await Promise.allSettled(
        Array.from({ length: 17 }, () => index.scan({}, 1)),
      );
      const fulfilled = pages.flatMap((page) =>
        page.status === "fulfilled" ? [page.value] : []
      );
      const rejected = pages.flatMap((page) =>
        page.status === "rejected" ? [page.reason] : []
      );
      expect(fulfilled).toHaveLength(16);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toEqual(
        new Error("Durable projection read view capacity is exhausted"),
      );
      for (const page of fulfilled) {
        await expect(
          index.scan({}, 1, page.continuation),
        ).resolves.toMatchObject({
          entries: [{ key: "b", value: 2 }],
        });
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds from the authority log and keeps a fixed paging view",
    async () => {
      const root = await createTempDir("durable-projection-log");
      const artifactStore = new FileArtifactStore(path.join(root, "artifacts"));
      const createLog = () =>
        new FileAuthorityCommitLog(path.join(root, "authority"), artifactStore);
      const log = createLog();
      const projection = log.durableProjection({
        projectionId: "test.authority",
        reducerVersion: 1,
        reduce: mutationsFor,
      });
      await log.append([
        { stream: "publish", body: { t: "put", key: "a", value: 1 } },
        { stream: "publish", body: { t: "put", key: "b", value: 2 } },
        { stream: "publish", body: { t: "put", key: "c", value: 3 } },
      ]);

      const first = await projection.scan({}, 2);
      expect(first.entries).toEqual([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      await log.append([
        { stream: "publish", body: { t: "put", key: "bb", value: 22 } },
      ]);
      await expect(
        projection.scan({}, 2, first.continuation),
      ).resolves.toEqual({ entries: [{ key: "c", value: 3 }] });

      const reopened = createLog().durableProjection({
        projectionId: "test.authority",
        reducerVersion: 1,
        reduce: mutationsFor,
      });
      await expect(reopened.get("bb")).resolves.toBe(22);
      await expect(reopened.scan({}, 8)).resolves.toMatchObject({
        entries: [
          { key: "a", value: 1 },
          { key: "b", value: 2 },
          { key: "bb", value: 22 },
          { key: "c", value: 3 },
        ],
      });
      await rm(path.join(root, "authority", "projections"), {
        recursive: true,
        force: true,
      });
      const rebuilt = createLog().durableProjection({
        projectionId: "test.authority",
        reducerVersion: 1,
        reduce: mutationsFor,
      });
      await expect(rebuilt.get("c")).resolves.toBe(3);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "does not append when a registered projection cannot prepare its delta",
    async () => {
      const root = await createTempDir("durable-projection-prepare");
      const artifactStore = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority"),
        artifactStore,
      );
      log.durableProjection({
        projectionId: "test.precommit",
        reducerVersion: 1,
        reduce(envelope) {
          if (
            envelope.entries.some(
              ({ body }) => (body as { t?: unknown }).t === "reject",
            )
          ) {
            throw new Error("projection-rejected");
          }
          return [];
        },
      });

      await expect(
        log.append([{ stream: "publish", body: { t: "reject" } }]),
      ).rejects.toThrow("projection-rejected");
      await expect(log.readAll()).resolves.toEqual([]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "get",
      async (projection: DurableProjectionIndex) => {
        await expect(projection.get("tail")).resolves.toBe(1);
      },
    ],
    [
      "scan",
      async (projection: DurableProjectionIndex) => {
        await expect(projection.scan({}, 8)).resolves.toMatchObject({
          entries: [
            { key: "seed-a", value: 1 },
            { key: "seed-z", value: 2 },
            { key: "tail", value: 1 },
          ],
        });
      },
    ],
    [
      "checkpoints",
      async (projection: DurableProjectionIndex) => {
        await expect(projection.checkpoints()).resolves.toMatchObject({
          authority: { lsn: 2 },
        });
      },
    ],
  ])(
    "rebuilds a lagging corrupted projection before bound %s",
    async (name, inspect) => {
      const { writer, projection } =
        await createLaggingCorruptedProjection(name);
      await writer.append([
        {
          stream: "publish",
          body: { t: "copy", key: "tail", sourceKey: "seed-a" },
        },
      ]);
      const authorityBefore = await writer.readAll();

      await inspect(projection);

      await expect(writer.readAll()).resolves.toEqual(authorityBefore);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "invalidates an old scan continuation when recovery rebuilds the index",
    async () => {
      const { writer, projection, projectionRoot } =
        await createLaggingCorruptedProjection("stale-continuation", false);
      const first = await projection.scan({}, 1);
      expect(first.continuation).toBeDefined();
      await corruptFirstSegment(projectionRoot);
      await writer.append([
        {
          stream: "publish",
          body: { t: "copy", key: "tail", sourceKey: "seed-a" },
        },
      ]);

      await expect(
        projection.scan({}, 1, first.continuation),
      ).rejects.toThrow("Durable projection continuation is stale");
      await expect(projection.scan({}, 8)).resolves.toMatchObject({
        entries: [
          { key: "seed-a", value: 1 },
          { key: "seed-z", value: 2 },
          { key: "tail", value: 1 },
        ],
      });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "recovers a lagging corrupted projection before append",
    async () => {
      const { writer, log, projection } =
        await createLaggingCorruptedProjection("append-sync");
      await writer.append([
        {
          stream: "publish",
          body: { t: "copy", key: "tail", sourceKey: "seed-a" },
        },
      ]);

      await log.append([
        { stream: "publish", body: { t: "put", key: "after", value: 3 } },
      ]);

      await expect(projection.get("after")).resolves.toBe(3);
      await expect(log.readAll()).resolves.toHaveLength(3);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "recovers a corrupted projection when the append reducer reads it",
    async () => {
      const { log, projection } =
        await createLaggingCorruptedProjection("append-reducer");

      await log.append([
        {
          stream: "publish",
          body: { t: "copy", key: "tail", sourceKey: "seed-a" },
        },
      ]);

      await expect(projection.get("tail")).resolves.toBe(1);
      await expect(log.readAll()).resolves.toHaveLength(2);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds at most once when projection recovery keeps failing",
    async () => {
      const root = await createTempDir("durable-projection-retry-bound");
      const artifactStore = new FileArtifactStore(path.join(root, "artifacts"));
      const writer = new FileAuthorityCommitLog(
        path.join(root, "authority"),
        artifactStore,
      );
      await writer.append([
        { stream: "publish", body: { t: "put", key: "seed", value: 1 } },
      ]);
      let attempts = 0;
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority"),
        artifactStore,
      );
      const projection = log.durableProjection({
        projectionId: "test.retry-bound",
        reducerVersion: 1,
        reduce() {
          attempts += 1;
          throw new DurableProjectionStorageError("persistent corruption");
        },
      });
      const authorityBefore = await writer.readAll();

      await expect(projection.get("seed")).rejects.toThrow(
        "persistent corruption",
      );

      expect(attempts).toBe(2);
      await expect(writer.readAll()).resolves.toEqual(authorityBefore);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});

 it('publishes a cold recovery checkpoint without draining readable compaction and resumes it before the next delta', async () => {
  const root = await createTempDir('recovery-checkpoint-compaction');
  const options = { rootDir: root, projectionId: 'checkpoint-compaction', reducerVersion: 1, overlayEntries: 32 };
  const index = new FileDurableProjectionIndex(options);
  try {
    await index.initialize({ source: checkpoint(0) });
    for (let value = 0; value < 5; value++) {
      index.publish(await index.prepare([{ kind: 'put', key: 'key-' + value, value }]), { source: checkpoint(value + 1) });
      await index.flush({ compact: false });
    }
    const published = await readProjectionManifest(root);
    expect(published.deltaSegments).toHaveLength(5); expect(published.compaction).toEqual({});
    const restored = new FileDurableProjectionIndex(options);
    try {
      await restored.initialize({ source: checkpoint(0) });
      await restored.flush({ compact: false });
      expect(await readProjectionManifest(root)).toEqual(published);
      for (let value = 0; value < 5; value++) await expect(restored.get('key-' + value)).resolves.toBe(value);
      restored.publish(await restored.prepare([{ kind: 'put', key: 'key-5', value: 5 }]), { source: checkpoint(6) });
      await restored.flush({ compact: false });
      expect((await readProjectionManifest(root)).deltaSegments.length).toBeLessThanOrEqual(5);
      await expect(restored.get('key-0')).resolves.toBe(0); await expect(restored.get('key-5')).resolves.toBe(5);
      await restored.flush(); expect((await readProjectionManifest(root)).compaction).toBeUndefined();
    } finally { await restored.stopStorageMaintenance(); }
  } finally { await index.stopStorageMaintenance(); }
});

it('coalesces retirement wakeups while a recovery owner holds the source fence', async () => {
  const root=await createTempDir('retirement-recovery-wakeup'), source=new SerialTaskQueue();
  const index=new FileDurableProjectionIndex({rootDir:root,projectionId:'retirement-wakeup',reducerVersion:1,
    withSourceLock:operation=>isHoldingMaintenanceExclusion()?operation():source.run(()=>runHoldingMaintenanceExclusion(operation))});
  await index.initialize({source:checkpoint(0)});
  index.publish(await index.prepare([{kind:'put',key:'retired',value:'old'}]),{source:checkpoint(1)});await index.flush({compact:false});
  await index.reset({source:checkpoint(0)});
  const key=storageMaintenanceWorkKey('projection-compaction',`retirement-wakeup:${root}`,{phase:'retirement-cleanup'});
  const run=vi.spyOn(StorageMaintenanceTaskRunner.prototype,'run');
  try {
    await source.run(()=>runHoldingMaintenanceExclusion(async()=>{
      for(let n=0;n<40;n++){expect(await index.get('absent')).toBeUndefined();await new Promise(resolve=>setTimeout(resolve,3));}
      expect(run.mock.calls.filter(([request])=>request.workKey===key).length).toBe(1);
    }));
  } finally {run.mockRestore();await index.stopStorageMaintenance();}
},10000);