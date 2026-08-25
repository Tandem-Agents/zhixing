import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { CommitEnvelope, JsonValue } from "../../contracts/index.js";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  StorageMaintenanceTaskRunner,
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
      const interrupted: StorageMaintenanceGovernorPort = {
        acquire: (request, abort) => {
          if (
            request.kind === "projection-compaction" &&
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
          overlayEntries: 2_048,
          overlayBytes: 4 * 1024 * 1024,
          storageMaintenance,
        });
      const index = createIndex(interrupted);
      await index.initialize({ source: checkpoint(0) });
      const entries = Array.from({ length: 1_024 }, (_, value) => ({
        kind: "put" as const,
        key: `key-${value.toString().padStart(4, "0")}`,
        value,
      }));
      for (let page = 0; page < 4; page += 1) {
        const prepared = await index.prepare(
          entries.slice(page * 205, (page + 1) * 205),
        );
        index.publish(prepared, { source: checkpoint(page + 1) });
        await index.flush();
      }
      const prepared = await index.prepare(entries.slice(820));
      index.publish(prepared, { source: checkpoint(5) });
      await expect(index.flush()).rejects.toThrow("backpressured");

      const interruptedManifest = await readProjectionManifest(root);
      expect(interruptedManifest.compaction?.afterKey).toBeDefined();
      expect(interruptedManifest.deltaSegments).toHaveLength(5);
      await expect(index.get("key-1023")).resolves.toBe(1_023);

      const resumed = createIndex(governor);
      await resumed.initialize({ source: checkpoint(0) });
      await resumed.flush();
      const completed = await readProjectionManifest(root);
      expect(completed.compaction).toBeUndefined();
      expect(completed.deltaSegments).toHaveLength(0);
      await expect(resumed.get("key-0000")).resolves.toBe(0);
      await expect(resumed.get("key-1023")).resolves.toBe(1_023);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "clears derived storage in bounded governed steps",
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

      expect(rebuildAdmissions).toBeGreaterThanOrEqual(3);
      expect((await readdir(root)).sort()).toEqual(["manifest.json"]);
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
