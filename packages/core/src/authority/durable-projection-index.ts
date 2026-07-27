import { createHash, randomBytes } from "node:crypto";
import {
  open,
  opendir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import type { Dir } from "node:fs";
import path from "node:path";
import type { CommitEnvelope, JsonValue } from "../contracts/index.js";
import {
  durablyRemoveFile,
  durablyRemoveFiles,
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import {
  claimDeviceCapacity,
  runInMaintenanceContext,
  runStorageMaintenanceTask,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceKind,
  type StorageMaintenanceObligation,
} from "../resources/index.js";
import type { DurableLogCheckpoint } from "./interfaces.js";

const INDEX_FORMAT_VERSION = 3;
const SEGMENT_FORMAT_VERSION = 1;
const DIRECTORY_PAGE_FORMAT_VERSION = 1;
const RETIREMENT_PAGE_FORMAT_VERSION = 1;
const WRITE_INTENT_FORMAT_VERSION = 1;
const SEGMENT_HEADER_BYTES = 52;
const SEGMENT_TOMBSTONE = 1;
const MAX_KEY_BYTES = 2_048;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const DEFAULT_OVERLAY_ENTRIES = 512;
const DEFAULT_OVERLAY_BYTES = 1024 * 1024;
const MAX_DELTA_SEGMENTS = 4;
const BASE_SEGMENT_ENTRIES = 512;
const BASE_SEGMENT_BYTES = 1024 * 1024;
const MAX_SCAN_LIMIT = 256;
const MAX_READ_VIEWS = 16;
const READ_VIEW_LEASE_MS = 60_000;
const MAX_DIRECTORY_HEIGHT = 64;
const MAX_DIRECTORY_CACHE_PAGES = 64;
const MAX_DIRECTORY_PAGE_BYTES = 64 * 1024;
const MAX_RETIREMENT_PAGE_FILES = 64;
const MAX_RETIREMENT_PAGE_BYTES = 64 * 1024;
const MAX_CLEAR_ENTRIES_PER_STEP = 64;

export type DurableProjectionMutation =
  | {
      readonly kind: "put";
      readonly key: string;
      readonly value: JsonValue;
    }
  | {
      readonly kind: "tombstone";
      readonly key: string;
    };

export interface DurableProjectionScanRange {
  readonly gte?: string;
  readonly gt?: string;
  readonly lt?: string;
}

export interface DurableProjectionEntry {
  readonly key: string;
  readonly value: JsonValue;
}

export interface DurableProjectionScanPage {
  readonly entries: readonly DurableProjectionEntry[];
  readonly continuation?: string;
}

export interface DurableProjectionIndex {
  get(key: string): Promise<JsonValue | undefined>;
  scan(
    range: DurableProjectionScanRange,
    limit: number,
    continuation?: string,
  ): Promise<DurableProjectionScanPage>;
  checkpoints(): Promise<DurableProjectionCheckpoints>;
}

export interface RebuildableDurableProjectionIndex
  extends DurableProjectionIndex {
  rebuild(): Promise<void>;
}

export interface DurableProjectionReadContext {
  get(key: string): Promise<JsonValue | undefined>;
  scan(
    range: DurableProjectionScanRange,
    limit: number,
    continuation?: string,
  ): Promise<DurableProjectionScanPage>;
}

export interface DurableProjectionSource {
  readonly checkpoint: DurableLogCheckpoint;
}

export type DurableProjectionReducer<Body = JsonValue> = (
  envelope: CommitEnvelope<Body>,
  current: DurableProjectionReadContext,
  source: DurableProjectionSource,
) =>
  | readonly DurableProjectionMutation[]
  | Promise<readonly DurableProjectionMutation[]>;

export interface DurableProjectionDefinition<Body = JsonValue> {
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly reduce: DurableProjectionReducer<Body>;
}

export interface FileDurableProjectionIndexOptions {
  readonly rootDir: string;
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly overlayEntries?: number;
  readonly overlayBytes?: number;
  readonly clock?: () => number;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

export type DurableProjectionCheckpoints = Readonly<
  Record<string, DurableLogCheckpoint>
>;

interface StoredMutation {
  readonly key: string;
  readonly value?: JsonValue;
  readonly tombstone: boolean;
  readonly bytes: number;
}

interface SegmentDescriptor {
  readonly id: string;
  readonly dataFile: string;
  readonly offsetsFile: string;
  readonly count: number;
  readonly minKey: string;
  readonly maxKey: string;
  readonly level: 0 | 1;
}

interface DirectoryPagePointer {
  readonly id: string;
  readonly minKey: string;
  readonly maxKey: string;
  readonly count: number;
  readonly height: number;
}

interface DirectoryPage {
  readonly formatVersion: 1;
  readonly nonce: string;
  readonly descriptor: SegmentDescriptor;
  readonly left?: DirectoryPagePointer;
  readonly right?: DirectoryPagePointer;
}

interface RetirementPagePointer {
  readonly id: string;
}

interface RetirementPage {
  readonly formatVersion: 1;
  readonly retiredAtGeneration: number;
  readonly files: readonly string[];
  readonly next?: RetirementPagePointer;
}

interface ProjectionCompaction {
  readonly afterKey?: string;
}

interface ProjectionManifest {
  readonly formatVersion: 3;
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly generation: number;
  readonly checkpoints: DurableProjectionCheckpoints;
  readonly deltaSegments: readonly SegmentDescriptor[];
  readonly compaction?: ProjectionCompaction;
  readonly baseRoot?: DirectoryPagePointer;
  readonly retirementRoot?: RetirementPagePointer;
  readonly retirementCleanup?: string;
}

interface ProjectionWriteIntent {
  readonly formatVersion: 1;
  readonly targetGeneration: number;
  readonly createdFiles: readonly string[];
  readonly transientFiles: readonly string[];
  readonly manifestDigest?: string;
}

export interface PreparedProjectionDelta {
  readonly owner: FileDurableProjectionIndex;
  readonly nextActive: ReadonlyMap<string, StoredMutation>;
  readonly nextActiveBytes: number;
  readonly nextMutationCount: number;
  readonly nextMutationBytes: number;
  readonly nextPublicationCount: number;
}

export class DurableProjectionStorageError extends Error {
  readonly code = "projection-corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableProjectionStorageError";
  }
}

export class DurableProjectionRecordBindingError
  extends DurableProjectionStorageError
{
  constructor(message: string) {
    super(message);
    this.name = "DurableProjectionRecordBindingError";
  }
}

const DURABLE_PROJECTION_RECORD_VERSION = 1;

export function bindDurableProjectionMutations(
  mutations: readonly DurableProjectionMutation[],
): readonly DurableProjectionMutation[] {
  return mutations.map((mutation) =>
    mutation.kind === "put"
      ? {
        kind: "put",
        key: mutation.key,
        value: {
          v: DURABLE_PROJECTION_RECORD_VERSION,
          key: mutation.key,
          value: mutation.value,
        },
      }
      : mutation
  );
}

export function createBoundDurableProjectionReadContext(
  current: DurableProjectionReadContext,
): DurableProjectionReadContext {
  return {
    async get(key) {
      const value = await current.get(key);
      return value === undefined
        ? undefined
        : readBoundDurableProjectionValue(key, value);
    },
    async scan(range, limit, continuation) {
      const page = await current.scan(range, limit, continuation);
      return {
        entries: page.entries.map((entry) => ({
          key: entry.key,
          value: readBoundDurableProjectionValue(entry.key, entry.value),
        })),
        ...(page.continuation
          ? { continuation: page.continuation }
          : {}),
      };
    },
  };
}

function readBoundDurableProjectionValue(
  key: string,
  value: JsonValue,
): JsonValue {
  const record = plainRecord(value);
  if (
    record?.v !== DURABLE_PROJECTION_RECORD_VERSION ||
    record.key !== key ||
    !Object.hasOwn(record, "value") ||
    Object.keys(record).length !== 3
  ) {
    throw new DurableProjectionRecordBindingError(
      `Durable projection record is not bound to key ${key}`,
    );
  }
  return record.value as JsonValue;
}

interface ReadView {
  readonly id: string;
  readonly generation: number;
  readonly expiresAt: number;
  readonly active: ReadonlyMap<string, StoredMutation>;
  readonly deltaSegments: readonly SegmentDescriptor[];
  readonly baseRoot?: DirectoryPagePointer;
}

interface SegmentEntry {
  readonly key: string;
  readonly value?: JsonValue;
  readonly tombstone: boolean;
}

interface SegmentCursor {
  readonly descriptor: SegmentDescriptor;
  readonly reader: SegmentReader;
  index: number;
  current?: SegmentEntry;
}

interface NormalizedScanRange {
  readonly gte: string;
  readonly gt?: string;
  readonly lt: string;
}

export class FileDurableProjectionIndex {
  readonly rootDir: string;
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly #overlayEntries: number;
  readonly #overlayBytes: number;
  readonly #clock: () => number;
  #manifest: ProjectionManifest | undefined;
  #active: ReadonlyMap<string, StoredMutation> = new Map();
  #activeBytes = 0;
  #activeMutationCount = 0;
  #activeMutationBytes = 0;
  #activePublicationCount = 0;
  #currentCheckpoints: DurableProjectionCheckpoints | undefined;
  #publicationSequence = 0;
  readonly #readViews = new Map<string, ReadView>();
  readonly #inUseReadViews = new Map<
    string,
    { readonly view: ReadView; users: number }
  >();
  readonly #directoryCache = new Map<string, DirectoryPage>();
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner | undefined;
  /** 清理失败、尚待下一个写意图接管的派生文件名(相对 rootDir)。 */
  readonly #uncleared = new Set<string>();
  #writeIntent: ProjectionWriteIntent | undefined;
  #clearDirectory: Dir | undefined;
  #clearInProgress = false;

  constructor(options: FileDurableProjectionIndexOptions) {
    assertProjectionIdentity(options.projectionId, options.reducerVersion);
    this.rootDir = path.resolve(options.rootDir);
    this.projectionId = options.projectionId;
    this.reducerVersion = options.reducerVersion;
    this.#overlayEntries = options.overlayEntries ?? DEFAULT_OVERLAY_ENTRIES;
    this.#overlayBytes = options.overlayBytes ?? DEFAULT_OVERLAY_BYTES;
    this.#clock = options.clock ?? Date.now;
    this.#maintenanceRunner = options.storageMaintenance
      ? new StorageMaintenanceTaskRunner(options.storageMaintenance)
      : undefined;
    assertPositiveInteger(this.#overlayEntries, "Projection overlay entry budget");
    assertPositiveInteger(this.#overlayBytes, "Projection overlay byte budget");
  }

  async initialize(
    emptyCheckpoints: DurableProjectionCheckpoints,
  ): Promise<void> {
    if (this.#manifest !== undefined) return;
    let initialized = false;
    while (!initialized) {
      initialized = await this.#runMaintenance(
        "projection-scrub",
        { emptyCheckpoints },
        "committed",
        () => this.#initializeStep(emptyCheckpoints),
      );
    }
  }

  async #initializeStep(
    emptyCheckpoints: DurableProjectionCheckpoints,
  ): Promise<boolean> {
    if (this.#manifest !== undefined) return true;
    await ensureDurableDirectory(this.rootDir);
    if (this.#clearInProgress) {
      await this.#clearDerivedStorageStep();
      return false;
    }
    try {
      await this.#recoverWriteIntent();
    } catch {
      // A damaged recovery intent invalidates only derived state. Clearing the
      // index forces the owning authority log to rebuild it from its WAL.
      await this.#clearDerivedStorageStep();
      return false;
    }
    const manifest = await this.#readManifest().catch(() => undefined);
    if (
      manifest &&
      manifest.projectionId === this.projectionId &&
      manifest.reducerVersion === this.reducerVersion &&
      sameCheckpointSources(manifest.checkpoints, emptyCheckpoints)
    ) {
      try {
        await this.#validatePublishedStorage(manifest);
        this.#manifest = manifest;
        this.#currentCheckpoints = manifest.checkpoints;
        await this.#drainRetirement();
        return true;
      } catch {
        // The index is derived state. Invalid storage is replaced and rebuilt
        // from the authority log by the owning commit log.
      }
    }
    if (!(await this.#clearDerivedStorageStep())) return false;
    await this.#installEmptyManifest(emptyCheckpoints);
    return true;
  }

  async reset(
    emptyCheckpoints: DurableProjectionCheckpoints,
  ): Promise<void> {
    let reset = false;
    while (!reset) {
      reset = await this.#runMaintenance(
        "projection-rebuild",
        { emptyCheckpoints, currentGeneration: this.#manifest?.generation },
        "committed",
        () => this.#resetStep(emptyCheckpoints),
      );
    }
  }

  async #resetStep(
    emptyCheckpoints: DurableProjectionCheckpoints,
  ): Promise<boolean> {
    await ensureDurableDirectory(this.rootDir);
    if (!(await this.#clearDerivedStorageStep())) return false;
    await this.#installEmptyManifest(emptyCheckpoints);
    return true;
  }

  async #installEmptyManifest(
    emptyCheckpoints: DurableProjectionCheckpoints,
  ): Promise<void> {
    const checkpoints = validateCheckpoints(emptyCheckpoints);
    const initial: ProjectionManifest = {
      formatVersion: INDEX_FORMAT_VERSION,
      projectionId: this.projectionId,
      reducerVersion: this.reducerVersion,
      generation: (this.#manifest?.generation ?? 0) + 1,
      checkpoints,
      deltaSegments: [],
    };
    await this.#writeManifest(initial);
    this.#manifest = initial;
    this.#active = new Map();
    this.#activeBytes = 0;
    this.#resetActiveProgress();
    this.#currentCheckpoints = checkpoints;
    this.#readViews.clear();
    this.#directoryCache.clear();
    this.#publicationSequence += 1;
  }

  checkpoints(): DurableProjectionCheckpoints {
    const checkpoints = this.#currentCheckpoints;
    if (!checkpoints) {
      throw new Error("Durable projection index is not initialized");
    }
    return cloneCheckpoints(checkpoints);
  }

  async prepare(
    mutations: readonly DurableProjectionMutation[],
  ): Promise<PreparedProjectionDelta> {
    if (!this.#manifest || !this.#currentCheckpoints) {
      throw new Error("Durable projection index is not initialized");
    }
    const normalized = normalizeMutations(mutations);
    let incomingBytes = 0;
    for (const mutation of normalized.values()) incomingBytes += mutation.bytes;
    if (
      this.#hasUnpersistedProgress() &&
      (
        this.#activeMutationCount + mutations.length > this.#overlayEntries ||
        this.#activeMutationBytes + incomingBytes > this.#overlayBytes ||
        this.#activePublicationCount + 1 > this.#overlayEntries
      )
    ) {
      // 覆盖层已装不下本次 delta,当前权威写必须等这次 flush 完成才能继续:
      // 阻塞关系内在固定为前台,与谁触发这次写无关。
      await runInMaintenanceContext("foreground", () =>
        this.#runFlush("pre-commit"),
      );
    }
    const nextActive = new Map(this.#active);
    let nextBytes = this.#activeBytes;
    for (const [key, mutation] of normalized) {
      nextBytes -= nextActive.get(key)?.bytes ?? 0;
      nextActive.set(key, mutation);
      nextBytes += mutation.bytes;
    }
    return {
      owner: this,
      nextActive,
      nextActiveBytes: nextBytes,
      nextMutationCount: this.#activeMutationCount + mutations.length,
      nextMutationBytes: this.#activeMutationBytes + incomingBytes,
      nextPublicationCount: this.#activePublicationCount + 1,
    };
  }

  publish(
    prepared: PreparedProjectionDelta,
    checkpoints: DurableProjectionCheckpoints,
  ): void {
    if (prepared.owner !== this) return;
    this.#active = prepared.nextActive;
    this.#activeBytes = prepared.nextActiveBytes;
    this.#activeMutationCount = prepared.nextMutationCount;
    this.#activeMutationBytes = prepared.nextMutationBytes;
    this.#activePublicationCount = prepared.nextPublicationCount;
    this.#currentCheckpoints = checkpoints;
    this.#publicationSequence += 1;
  }

  async get(key: string): Promise<JsonValue | undefined> {
    assertKey(key);
    this.#expireReadViews();
    await this.#drainRetirement();
    const view = this.#captureReadView();
    this.#retainReadView(view);
    try {
      const active = view.active.get(key);
      if (active) return active.tombstone ? undefined : active.value;
      for (const segment of view.deltaSegments) {
        if (key < segment.minKey || key > segment.maxKey) continue;
        const reader = await SegmentReader.open(this.rootDir, segment);
        try {
          const entry = await reader.get(key);
          if (entry) return entry.tombstone ? undefined : entry.value;
        } finally {
          await reader.close();
        }
      }
      const base = await this.#baseSegmentForKey(view.baseRoot, key);
      if (base && key >= base.minKey && key <= base.maxKey) {
        const reader = await SegmentReader.open(this.rootDir, base);
        try {
          const entry = await reader.get(key);
          if (entry) return entry.tombstone ? undefined : entry.value;
        } finally {
          await reader.close();
        }
      }
      return undefined;
    } finally {
      this.#releaseReadView(view);
      await this.#drainRetirement();
    }
  }

  async scan(
    range: DurableProjectionScanRange,
    limit: number,
    continuation?: string,
  ): Promise<DurableProjectionScanPage> {
    const normalizedRange = normalizeRange(range);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SCAN_LIMIT) {
      throw new RangeError(`Projection scan limit must be 1-${MAX_SCAN_LIMIT}`);
    }
    this.#expireReadViews();
    const resumed = continuation
      ? this.#resumeView(continuation)
      : undefined;
    const view = resumed?.view ?? this.#createReadView();
    const after = resumed?.lastKey;
    this.#retainReadView(view);
    try {
      const entries = await this.#scanView(view, normalizedRange, limit, after);
      const lastKey = entries.at(-1)?.key;
      if (entries.length < limit || lastKey === undefined) {
        this.#readViews.delete(view.id);
        return { entries };
      }
      return {
        entries,
        continuation: encodeContinuation(view.id, lastKey),
      };
    } finally {
      this.#releaseReadView(view);
      await this.#drainRetirement();
    }
  }

  async flush(): Promise<void> {
    // 紧急度继承调用语境,不在这里声明:本方法是被生命周期提交等上层调用的设施,
    // 不是维护任务的所有者。前台请求触发的提交按前台准入,启动恢复触发的按恢复,
    // 周期回收触发的才是后台——谁在等它只有顶层所有者知道。
    await this.#runFlush("committed");
  }

  async #runFlush(obligation: StorageMaintenanceObligation): Promise<void> {
    for (;;) {
      const manifest = this.#requireManifest();
      if (manifest.compaction) {
        const previousGeneration = manifest.generation;
        await this.#runMaintenance(
          "projection-compaction",
          {
            generation: manifest.generation,
            ...(manifest.compaction.afterKey === undefined
              ? {}
              : { afterKey: manifest.compaction.afterKey }),
          },
          obligation,
          () => this.#compactNextRange(),
        );
        if (this.#requireManifest().generation <= previousGeneration) {
          throw new Error("Projection compaction made no durable progress");
        }
        continue;
      }
      if (
        this.#active.size === 0 &&
        sameCheckpoints(this.checkpoints(), manifest.checkpoints)
      ) {
        this.#resetActiveProgress();
        return;
      }
      await this.#runMaintenance(
        "projection-flush",
        {
          generation: manifest.generation,
          checkpoints: this.#currentCheckpoints,
          activeEntries: this.#active.size,
          activeBytes: this.#activeBytes,
        },
        obligation,
        () => this.#flushActive(),
      );
    }
  }

  async #runMaintenance<T>(
    kind: StorageMaintenanceKind,
    inputIdentity: unknown,
    obligation: StorageMaintenanceObligation,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runStorageMaintenanceTask(
      this.#maintenanceRunner,
      storageMaintenanceRequest(
        kind,
        `${this.projectionId}:${this.rootDir}`,
        inputIdentity,
        // 是否零等待由维护执行语境单点决定:在协调器串行段或日志锁内调用时,
        // 建立互斥的原语已标记,准入自动转为零等待——排队会把串行段占死,使同
        // 一投影的其他提交一并停摆;段外调用则按常规等待。背压交由调用方在段外重试。
        { obligation },
      ),
      operation,
    );
  }

  async #flushActive(): Promise<void> {
    await this.#drainRetirement();
    if (this.#writeIntent) {
      await this.#completeWriteIntent(
        isCommittedIntent(this.#writeIntent, this.#requireManifest()),
      );
    }
    const manifest = this.#requireManifest();
    const checkpoints = this.checkpoints();
    if (
      this.#active.size === 0 &&
      sameCheckpoints(checkpoints, manifest.checkpoints)
    ) {
      this.#resetActiveProgress();
      return;
    }
    await this.#beginWriteIntent(manifest.generation + 1);
    let committed = false;
    try {
      let deltaSegments = [...manifest.deltaSegments];
      let baseRoot = manifest.baseRoot;
      const obsoleteFiles = new Set<string>();
      if (this.#active.size > 0) {
        const newest = await this.#writeSegment(
          [...this.#active.values()],
          0,
        );
        deltaSegments = [newest, ...deltaSegments];
      }
      const compaction =
        deltaSegments.length > MAX_DELTA_SEGMENTS
          ? {}
          : manifest.compaction;
      const created = new Set(this.#requireWriteIntent().createdFiles);
      const transientFiles = [...obsoleteFiles].filter((file) =>
        created.has(file)
      );
      const retiredFiles = [...obsoleteFiles].filter((file) =>
        !created.has(file)
      );
      const retirementRoot = await this.#prependRetirementPages(
        retiredFiles,
        manifest.generation + 1,
        manifest.retirementRoot,
      );
      const next: ProjectionManifest = {
        formatVersion: INDEX_FORMAT_VERSION,
        projectionId: manifest.projectionId,
        reducerVersion: manifest.reducerVersion,
        generation: manifest.generation + 1,
        checkpoints,
        deltaSegments,
        ...(compaction === undefined ? {} : { compaction }),
        ...(baseRoot === undefined ? {} : { baseRoot }),
        ...(retirementRoot === undefined ? {} : { retirementRoot }),
        ...(manifest.retirementCleanup === undefined
          ? {}
          : { retirementCleanup: manifest.retirementCleanup }),
      };
      await this.#finalizeWriteIntent(next, transientFiles);
      await this.#writeManifest(next);
      this.#manifest = next;
      committed = true;
      this.#active = new Map();
      this.#activeBytes = 0;
      this.#resetActiveProgress();
      this.#publicationSequence += 1;
    } catch (error) {
      if (!committed) {
        await this.#completeWriteIntent(false);
        throw error;
      }
    }
    if (committed) {
      // The manifest replacement is the projection publication point.
      // Housekeeping remains recoverable from the durable intent and must
      // never turn a successful publication into a false failure.
      await this.#completeWriteIntent(true).catch(() => undefined);
      await this.#drainRetirement().catch(() => undefined);
    } else {
      throw new Error("Projection flush did not publish a manifest");
    }
  }

  #hasUnpersistedProgress(): boolean {
    return (
      this.#activePublicationCount > 0 ||
      !sameCheckpoints(
        this.checkpoints(),
        this.#requireManifest().checkpoints,
      )
    );
  }

  #resetActiveProgress(): void {
    this.#activeMutationCount = 0;
    this.#activeMutationBytes = 0;
    this.#activePublicationCount = 0;
  }

  async #scanView(
    view: ReadView,
    range: NormalizedScanRange,
    limit: number,
    after?: string,
  ): Promise<DurableProjectionEntry[]> {
    const exclusiveAfter = after === undefined
      ? range.gt
      : range.gt === undefined || after > range.gt
      ? after
      : range.gt;
    const lowerBound =
      exclusiveAfter !== undefined && exclusiveAfter > range.gte
        ? exclusiveAfter
        : range.gte;
    const inRange = (key: string): boolean =>
      key >= range.gte &&
      (exclusiveAfter === undefined || key > exclusiveAfter) &&
      key < range.lt;
    const activeEntries = [...view.active.values()]
      .filter((entry) => inRange(entry.key))
      .sort((left, right) => compareKeys(left.key, right.key));
    let activeIndex = 0;
    const deltaCursors: SegmentCursor[] = [];
    let baseDescriptor = await this.#firstBaseSegment(
      view.baseRoot,
      lowerBound,
    );
    let baseCursor: SegmentCursor | undefined;
    const openCursor = async (
      descriptor: SegmentDescriptor,
    ): Promise<SegmentCursor> => {
      const reader = await SegmentReader.open(this.rootDir, descriptor);
      let index = await reader.lowerBound(lowerBound);
      const cursor: SegmentCursor = { descriptor, reader, index };
      cursor.current = await reader.entry(index);
      while (
        cursor.current !== undefined &&
        !inRange(cursor.current.key) &&
        cursor.current.key < range.lt
      ) {
        index += 1;
        cursor.index = index;
        cursor.current = await reader.entry(index);
      }
      return cursor;
    };
    const advanceBase = async (): Promise<void> => {
      while (baseCursor?.current === undefined) {
        if (baseCursor) {
          await baseCursor.reader.close();
          baseCursor = undefined;
        }
        const descriptor = baseDescriptor;
        if (!descriptor) return;
        baseDescriptor = await this.#nextBaseSegment(
          view.baseRoot,
          descriptor.minKey,
        );
        if (descriptor.maxKey < lowerBound) continue;
        if (descriptor.minKey >= range.lt) return;
        baseCursor = await openCursor(descriptor);
      }
    };
    try {
      for (const descriptor of view.deltaSegments) {
        if (descriptor.maxKey < lowerBound || descriptor.minKey >= range.lt) {
          continue;
        }
        deltaCursors.push(await openCursor(descriptor));
      }
      await advanceBase();
      const output: DurableProjectionEntry[] = [];
      while (output.length < limit) {
        let nextKey = activeEntries[activeIndex]?.key;
        for (const cursor of deltaCursors) {
          const key = cursor.current?.key;
          if (key !== undefined && (nextKey === undefined || key < nextKey)) {
            nextKey = key;
          }
        }
        const baseKey = baseCursor?.current?.key;
        if (
          baseKey !== undefined &&
          (nextKey === undefined || baseKey < nextKey)
        ) {
          nextKey = baseKey;
        }
        if (nextKey === undefined || nextKey >= range.lt) break;
        const active = activeEntries[activeIndex]?.key === nextKey
          ? activeEntries[activeIndex++]
          : undefined;
        let selected: SegmentEntry | StoredMutation | undefined = active;
        for (const cursor of deltaCursors) {
          if (cursor.current?.key !== nextKey) continue;
          if (selected === undefined) selected = cursor.current;
          cursor.index += 1;
          cursor.current = await cursor.reader.entry(cursor.index);
        }
        if (baseCursor?.current?.key === nextKey) {
          selected ??= baseCursor.current;
          baseCursor.index += 1;
          baseCursor.current = await baseCursor.reader.entry(baseCursor.index);
          await advanceBase();
        }
        if (selected && !selected.tombstone && selected.value !== undefined) {
          output.push({ key: nextKey, value: selected.value });
        }
      }
      return output;
    } finally {
      await Promise.all(deltaCursors.map(({ reader }) => reader.close()));
      await baseCursor?.reader.close();
    }
  }

  #createReadView(): ReadView {
    this.#expireReadViews();
    while (this.#readViews.size >= MAX_READ_VIEWS) {
      const oldest = [...this.#readViews.keys()].find(
        (id) => !this.#inUseReadViews.has(id),
      );
      if (oldest === undefined) break;
      this.#readViews.delete(oldest);
    }
    if (this.#readViews.size >= MAX_READ_VIEWS) {
      throw new Error("Durable projection read view capacity is exhausted");
    }
    const view = this.#captureReadView();
    this.#readViews.set(view.id, view);
    return view;
  }

  #captureReadView(): ReadView {
    const manifest = this.#requireManifest();
    const id =
      `${manifest.generation}-${this.#publicationSequence}-` +
      randomBytes(8).toString("hex");
    return {
      id,
      generation: manifest.generation,
      expiresAt: this.#clock() + READ_VIEW_LEASE_MS,
      active: new Map(this.#active),
      deltaSegments: manifest.deltaSegments,
      ...(manifest.baseRoot === undefined
        ? {}
        : { baseRoot: manifest.baseRoot }),
    };
  }

  #retainReadView(view: ReadView): void {
    const inUse = this.#inUseReadViews.get(view.id);
    if (inUse) {
      inUse.users += 1;
      return;
    }
    this.#inUseReadViews.set(view.id, { view, users: 1 });
  }

  #releaseReadView(view: ReadView): void {
    const inUse = this.#inUseReadViews.get(view.id);
    if (!inUse) {
      throw new Error("Durable projection read view is not retained");
    }
    if (inUse.users > 1) {
      inUse.users -= 1;
      return;
    }
    this.#inUseReadViews.delete(view.id);
  }

  #resumeView(encoded: string): { view: ReadView; lastKey: string } {
    const continuation = decodeContinuation(encoded);
    const view = this.#readViews.get(continuation.viewId);
    if (!view || view.expiresAt <= this.#clock()) {
      if (view) this.#readViews.delete(view.id);
      throw new Error("Durable projection continuation is stale");
    }
    return { view, lastKey: continuation.lastKey };
  }

  #expireReadViews(): void {
    const now = this.#clock();
    for (const [id, view] of this.#readViews) {
      if (view.expiresAt <= now) this.#readViews.delete(id);
    }
  }

  async #writeSegment(
    mutations: readonly StoredMutation[],
    level: 0 | 1,
  ): Promise<SegmentDescriptor> {
    const latest = new Map<string, StoredMutation>();
    for (const mutation of mutations) latest.set(mutation.key, mutation);
    const sorted = [...latest.values()].sort((left, right) =>
      compareKeys(left.key, right.key)
    );
    if (sorted.length === 0) {
      throw new TypeError("Cannot write an empty projection segment");
    }
    return this.#writeSortedEntries(sorted, level);
  }

  async #writeSortedEntries(
    entries: Iterable<StoredMutation> | AsyncIterable<StoredMutation>,
    level: 0 | 1,
  ): Promise<SegmentDescriptor> {
    const id = randomBytes(16).toString("hex");
    const dataFile = `segment-${id}.data`;
    const offsetsFile = `segment-${id}.offsets`;
    await this.#planCreatedFiles([dataFile, offsetsFile]);
    const dataTemporary = path.join(this.rootDir, `.${dataFile}.tmp`);
    const offsetsTemporary = path.join(this.rootDir, `.${offsetsFile}.tmp`);
    claimStorageIo("ioOperations", 2);
    const data = await open(dataTemporary, "wx", 0o600);
    const offsets = await open(offsetsTemporary, "wx", 0o600);
    let count = 0;
    let position = 0;
    let minKey: string | undefined;
    let maxKey: string | undefined;
    let previousKey: string | undefined;
    try {
      for await (const entry of entries) {
        if (
          previousKey !== undefined &&
          compareKeys(previousKey, entry.key) >= 0
        ) {
          throw new TypeError("Projection segment entries are not strictly ordered");
        }
        const encoded = encodeSegmentEntry(entry, count);
        const offset = Buffer.allocUnsafe(8);
        offset.writeBigUInt64BE(BigInt(position));
        claimStorageIo("writeBytes", offset.byteLength + encoded.byteLength);
        claimStorageIo("temporaryBytes", offset.byteLength + encoded.byteLength);
        claimStorageIo("ioOperations", 2);
        await offsets.writeFile(offset);
        await data.writeFile(encoded);
        position += encoded.byteLength;
        count += 1;
        minKey ??= entry.key;
        maxKey = entry.key;
        previousKey = entry.key;
      }
      if (count === 0 || minKey === undefined || maxKey === undefined) {
        throw new TypeError("Cannot write an empty projection segment");
      }
      claimStorageIo("ioOperations", 2);
      await data.sync();
      await offsets.sync();
    } catch (error) {
      await data.close().catch(() => undefined);
      await offsets.close().catch(() => undefined);
      await unlink(dataTemporary).catch(() => undefined);
      await unlink(offsetsTemporary).catch(() => undefined);
      throw error;
    }
    await data.close();
    await offsets.close();
    claimStorageIo("ioOperations", 2);
    await rename(dataTemporary, path.join(this.rootDir, dataFile));
    await rename(offsetsTemporary, path.join(this.rootDir, offsetsFile));
    claimStorageIo("ioOperations", 1);
    await syncDirectory(this.rootDir);
    return { id, dataFile, offsetsFile, count, minKey, maxKey, level };
  }

  async #compactNextRange(): Promise<void> {
    await this.#drainRetirement();
    if (this.#writeIntent) {
      await this.#completeWriteIntent(
        isCommittedIntent(this.#writeIntent, this.#requireManifest()),
      );
    }
    const manifest = this.#requireManifest();
    if (!manifest.compaction) return;

    await this.#beginWriteIntent(manifest.generation + 1);
    let committed = false;
    try {
      const batch = await this.#nextCompactionBatch(manifest);
      let baseRoot = manifest.baseRoot;
      let deltaSegments = manifest.deltaSegments;
      let compaction: ProjectionCompaction | undefined;
      const obsoleteFiles = new Set<string>();

      if (!batch) {
        deltaSegments = [];
        for (const segment of manifest.deltaSegments) {
          obsoleteFiles.add(segment.dataFile);
          obsoleteFiles.add(segment.offsetsFile);
        }
      } else {
        const replacements: SegmentDescriptor[] = [];
        const obsoletePages = new Set<string>();
        if (batch.base) {
          const values = new Map(
            (await this.#readSegment(batch.base)).map((entry) => [
              entry.key,
              entry,
            ]),
          );
          for (const mutation of batch.mutations) {
            if (mutation.tombstone) values.delete(mutation.key);
            else values.set(mutation.key, mutation);
          }
          replacements.push(
            ...(await this.#writeBaseSegments([...values.values()])),
          );
          baseRoot = await this.#deleteDirectoryDescriptor(
            baseRoot,
            batch.base.minKey,
            obsoletePages,
          );
          obsoleteFiles.add(batch.base.dataFile);
          obsoleteFiles.add(batch.base.offsetsFile);
        } else {
          replacements.push(
            ...(await this.#writeBaseSegments(batch.mutations)),
          );
        }
        for (const replacement of replacements) {
          baseRoot = await this.#setDirectoryDescriptor(
            baseRoot,
            replacement,
            obsoletePages,
          );
        }
        for (const file of obsoletePages) obsoleteFiles.add(file);
        compaction = { afterKey: batch.afterKey };
      }

      const created = new Set(this.#requireWriteIntent().createdFiles);
      const transientFiles = [...obsoleteFiles].filter((file) =>
        created.has(file)
      );
      const retiredFiles = [...obsoleteFiles].filter((file) =>
        !created.has(file)
      );
      const retirementRoot = await this.#prependRetirementPages(
        retiredFiles,
        manifest.generation + 1,
        manifest.retirementRoot,
      );
      const next: ProjectionManifest = {
        formatVersion: INDEX_FORMAT_VERSION,
        projectionId: manifest.projectionId,
        reducerVersion: manifest.reducerVersion,
        generation: manifest.generation + 1,
        checkpoints: manifest.checkpoints,
        deltaSegments,
        ...(compaction === undefined ? {} : { compaction }),
        ...(baseRoot === undefined ? {} : { baseRoot }),
        ...(retirementRoot === undefined ? {} : { retirementRoot }),
        ...(manifest.retirementCleanup === undefined
          ? {}
          : { retirementCleanup: manifest.retirementCleanup }),
      };
      await this.#finalizeWriteIntent(next, transientFiles);
      await this.#writeManifest(next);
      this.#manifest = next;
      committed = true;
      this.#publicationSequence += 1;
    } catch (error) {
      if (!committed) {
        await this.#completeWriteIntent(false);
        throw error;
      }
    }
    if (!committed) {
      throw new Error("Projection compaction did not publish a manifest");
    }
    await this.#completeWriteIntent(true).catch(() => undefined);
    await this.#drainRetirement().catch(() => undefined);
  }

  async #nextCompactionBatch(
    manifest: ProjectionManifest,
  ): Promise<
    | {
        readonly base?: SegmentDescriptor;
        readonly mutations: readonly StoredMutation[];
        readonly afterKey: string;
      }
    | undefined
  > {
    const afterKey = manifest.compaction?.afterKey;
    let firstKey: string | undefined;
    for (const delta of manifest.deltaSegments) {
      const reader = await SegmentReader.open(this.rootDir, delta);
      try {
        let index = afterKey === undefined
          ? 0
          : await reader.lowerBound(afterKey);
        let entry = await reader.entry(index);
        if (entry?.key === afterKey) entry = await reader.entry(++index);
        if (
          entry &&
          (firstKey === undefined || compareKeys(entry.key, firstKey) < 0)
        ) {
          firstKey = entry.key;
        }
      } finally {
        await reader.close();
      }
    }
    if (firstKey === undefined) return undefined;

    const base = await this.#baseSegmentForKey(manifest.baseRoot, firstKey);
    const upperBound = base
      ? (await this.#nextBaseSegment(manifest.baseRoot, base.minKey))?.minKey
      : undefined;
    const latest = new Map<string, StoredMutation>();
    for (const delta of [...manifest.deltaSegments].reverse()) {
      const reader = await SegmentReader.open(this.rootDir, delta);
      try {
        let index = afterKey === undefined
          ? 0
          : await reader.lowerBound(afterKey);
        let entry = await reader.entry(index);
        if (entry?.key === afterKey) entry = await reader.entry(++index);
        while (entry && (upperBound === undefined || entry.key < upperBound)) {
          latest.set(entry.key, storedMutation(entry));
          entry = await reader.entry(++index);
        }
      } finally {
        await reader.close();
      }
    }
    let mutations = [...latest.values()].sort((left, right) =>
      compareKeys(left.key, right.key)
    );
    if (!base) {
      let count = 0;
      let bytes = 0;
      mutations = mutations.filter((mutation) => {
        if (
          count > 0 &&
          (
            count >= BASE_SEGMENT_ENTRIES ||
            bytes + mutation.bytes > BASE_SEGMENT_BYTES
          )
        ) {
          return false;
        }
        count += 1;
        bytes += mutation.bytes;
        return true;
      });
    }
    const last = mutations.at(-1);
    if (!last) {
      throw new Error("Projection compaction range is empty");
    }
    return {
      ...(base === undefined ? {} : { base }),
      mutations,
      afterKey: last.key,
    };
  }

  async #readSegment(
    descriptor: SegmentDescriptor,
  ): Promise<StoredMutation[]> {
    const reader = await SegmentReader.open(this.rootDir, descriptor);
    try {
      const entries: StoredMutation[] = [];
      for (let index = 0; index < descriptor.count; index += 1) {
        const entry = await reader.entry(index);
        if (!entry) {
          throw projectionCorrupt("Projection segment ended before its count");
        }
        entries.push(storedMutation(entry));
      }
      return entries;
    } finally {
      await reader.close();
    }
  }

  async #writeBaseSegments(
    values: readonly StoredMutation[],
  ): Promise<SegmentDescriptor[]> {
    const live = values
      .filter((entry) => !entry.tombstone)
      .sort((left, right) => compareKeys(left.key, right.key));
    const segments: SegmentDescriptor[] = [];
    let batch: StoredMutation[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      segments.push(await this.#writeSortedEntries(batch, 1));
      batch = [];
      bytes = 0;
    };
    for (const entry of live) {
      if (
        batch.length > 0 &&
        (
          batch.length >= BASE_SEGMENT_ENTRIES ||
          bytes + entry.bytes > BASE_SEGMENT_BYTES
        )
      ) {
        await flush();
      }
      batch.push(entry);
      bytes += entry.bytes;
    }
    await flush();
    return segments;
  }

  async #baseSegmentForKey(
    root: DirectoryPagePointer | undefined,
    key: string,
  ): Promise<SegmentDescriptor | undefined> {
    let pointer = root;
    let floor: SegmentDescriptor | undefined;
    while (pointer) {
      const page = await this.#loadDirectoryPage(pointer);
      if (key < page.descriptor.minKey) {
        pointer = page.left;
      } else {
        floor = page.descriptor;
        pointer = page.right;
      }
    }
    if (floor || !root) return floor;
    return this.#minimumDirectoryDescriptor(root);
  }

  async #firstBaseSegment(
    root: DirectoryPagePointer | undefined,
    lowerBound: string,
  ): Promise<SegmentDescriptor | undefined> {
    let pointer = root;
    while (pointer) {
      const page = await this.#loadDirectoryPage(pointer);
      if (page.left && page.left.maxKey >= lowerBound) {
        pointer = page.left;
        continue;
      }
      if (page.descriptor.maxKey >= lowerBound) return page.descriptor;
      pointer = page.right;
    }
    return undefined;
  }

  async #nextBaseSegment(
    root: DirectoryPagePointer | undefined,
    minKey: string,
  ): Promise<SegmentDescriptor | undefined> {
    let pointer = root;
    let successor: SegmentDescriptor | undefined;
    while (pointer) {
      const page = await this.#loadDirectoryPage(pointer);
      if (page.descriptor.minKey > minKey) {
        successor = page.descriptor;
        pointer = page.left;
      } else {
        pointer = page.right;
      }
    }
    return successor;
  }

  async #minimumDirectoryDescriptor(
    root: DirectoryPagePointer,
  ): Promise<SegmentDescriptor> {
    let pointer = root;
    for (;;) {
      const page = await this.#loadDirectoryPage(pointer);
      if (!page.left) return page.descriptor;
      pointer = page.left;
    }
  }

  async #loadDirectoryPage(
    pointer: DirectoryPagePointer,
  ): Promise<DirectoryPage> {
    const cached = this.#directoryCache.get(pointer.id);
    if (cached) {
      this.#cacheDirectoryPage(pointer.id, cached);
      return cached;
    }
    const file = directoryPageFile(pointer.id);
    let handle: FileHandle;
    try {
      claimStorageIo("ioOperations", 1);
      handle = await open(path.join(this.rootDir, file), "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw projectionCorrupt("Projection directory page is missing", error);
      }
      throw error;
    }
    try {
      claimStorageIo("ioOperations", 1);
      const metadata = await handle.stat();
      if (
        metadata.size <= 0 ||
        metadata.size > MAX_DIRECTORY_PAGE_BYTES
      ) {
        throw projectionCorrupt("Projection directory page size is invalid");
      }
      const bytes = Buffer.allocUnsafe(metadata.size);
      claimStorageIo("readBytes", bytes.byteLength);
      claimStorageIo("ioOperations", 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (bytesRead !== bytes.byteLength) {
        throw projectionCorrupt("Projection directory page is truncated");
      }
      const encoded = bytes.toString("utf8");
      if (checksum(bytes).toString("hex") !== pointer.id) {
        throw projectionCorrupt("Projection directory page checksum is invalid");
      }
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch (error) {
        throw projectionCorrupt("Projection directory page is invalid", error);
      }
      if (canonicalize(value) !== encoded) {
        throw projectionCorrupt("Projection directory page is not canonical");
      }
      const page = validateDirectoryPage(value, pointer);
      this.#cacheDirectoryPage(pointer.id, page);
      return page;
    } finally {
      await handle.close();
    }
  }

  async #writeDirectoryPage(
    descriptor: SegmentDescriptor,
    left?: DirectoryPagePointer,
    right?: DirectoryPagePointer,
  ): Promise<DirectoryPagePointer> {
    if (descriptor.level !== 1) {
      throw new TypeError("Projection directory can only contain base segments");
    }
    const page: DirectoryPage = {
      formatVersion: DIRECTORY_PAGE_FORMAT_VERSION,
      nonce: randomBytes(16).toString("hex"),
      descriptor,
      ...(left === undefined ? {} : { left }),
      ...(right === undefined ? {} : { right }),
    };
    const pointer = directoryPointerFor(page);
    const file = directoryPageFile(pointer.id);
    await this.#planCreatedFiles([file]);
    const temporary = path.join(this.rootDir, `.${file}.tmp`);
    const encoded = Buffer.from(canonicalize(page), "utf8");
    claimStorageIo("ioOperations", 1);
    const handle = await open(temporary, "wx", 0o600);
    try {
      claimStorageIo("writeBytes", encoded.byteLength);
      claimStorageIo("temporaryBytes", encoded.byteLength);
      claimStorageIo("ioOperations", 2);
      await handle.writeFile(encoded);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    claimStorageIo("ioOperations", 1);
    await rename(temporary, path.join(this.rootDir, file));
    this.#cacheDirectoryPage(pointer.id, page);
    return pointer;
  }

  #cacheDirectoryPage(id: string, page: DirectoryPage): void {
    this.#directoryCache.delete(id);
    while (this.#directoryCache.size >= MAX_DIRECTORY_CACHE_PAGES) {
      const oldest = this.#directoryCache.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.#directoryCache.delete(oldest);
    }
    this.#directoryCache.set(id, page);
  }

  async #setDirectoryDescriptor(
    root: DirectoryPagePointer | undefined,
    descriptor: SegmentDescriptor,
    obsolete: Set<string>,
  ): Promise<DirectoryPagePointer> {
    if (!root) return this.#writeDirectoryPage(descriptor);
    const page = await this.#loadDirectoryPage(root);
    let left = page.left;
    let right = page.right;
    let current = page.descriptor;
    if (descriptor.minKey < current.minKey) {
      left = await this.#setDirectoryDescriptor(left, descriptor, obsolete);
    } else if (descriptor.minKey > current.minKey) {
      right = await this.#setDirectoryDescriptor(right, descriptor, obsolete);
    } else {
      current = descriptor;
    }
    const updated = await this.#balanceDirectoryPage(
      current,
      left,
      right,
      obsolete,
    );
    if (updated.id !== root.id) obsolete.add(directoryPageFile(root.id));
    return updated;
  }

  async #deleteDirectoryDescriptor(
    root: DirectoryPagePointer | undefined,
    minKey: string,
    obsolete: Set<string>,
  ): Promise<DirectoryPagePointer | undefined> {
    if (!root) return undefined;
    const page = await this.#loadDirectoryPage(root);
    let left = page.left;
    let right = page.right;
    let descriptor = page.descriptor;
    if (minKey < descriptor.minKey) {
      left = await this.#deleteDirectoryDescriptor(left, minKey, obsolete);
    } else if (minKey > descriptor.minKey) {
      right = await this.#deleteDirectoryDescriptor(right, minKey, obsolete);
    } else {
      obsolete.add(directoryPageFile(root.id));
      if (!left) return right;
      if (!right) return left;
      descriptor = await this.#minimumDirectoryDescriptor(right);
      right = await this.#deleteDirectoryDescriptor(
        right,
        descriptor.minKey,
        obsolete,
      );
    }
    const updated = await this.#balanceDirectoryPage(
      descriptor,
      left,
      right,
      obsolete,
    );
    if (updated.id !== root.id) obsolete.add(directoryPageFile(root.id));
    return updated;
  }

  async #balanceDirectoryPage(
    descriptor: SegmentDescriptor,
    left: DirectoryPagePointer | undefined,
    right: DirectoryPagePointer | undefined,
    obsolete: Set<string>,
  ): Promise<DirectoryPagePointer> {
    const balance = directoryHeight(left) - directoryHeight(right);
    if (balance > 1 && left) {
      const leftPage = await this.#loadDirectoryPage(left);
      obsolete.add(directoryPageFile(left.id));
      if (directoryHeight(leftPage.left) >= directoryHeight(leftPage.right)) {
        const nextRight = await this.#writeDirectoryPage(
          descriptor,
          leftPage.right,
          right,
        );
        return this.#writeDirectoryPage(
          leftPage.descriptor,
          leftPage.left,
          nextRight,
        );
      }
      const pivot = await this.#loadDirectoryPage(leftPage.right!);
      obsolete.add(directoryPageFile(leftPage.right!.id));
      const nextLeft = await this.#writeDirectoryPage(
        leftPage.descriptor,
        leftPage.left,
        pivot.left,
      );
      const nextRight = await this.#writeDirectoryPage(
        descriptor,
        pivot.right,
        right,
      );
      return this.#writeDirectoryPage(pivot.descriptor, nextLeft, nextRight);
    }
    if (balance < -1 && right) {
      const rightPage = await this.#loadDirectoryPage(right);
      obsolete.add(directoryPageFile(right.id));
      if (directoryHeight(rightPage.right) >= directoryHeight(rightPage.left)) {
        const nextLeft = await this.#writeDirectoryPage(
          descriptor,
          left,
          rightPage.left,
        );
        return this.#writeDirectoryPage(
          rightPage.descriptor,
          nextLeft,
          rightPage.right,
        );
      }
      const pivot = await this.#loadDirectoryPage(rightPage.left!);
      obsolete.add(directoryPageFile(rightPage.left!.id));
      const nextLeft = await this.#writeDirectoryPage(
        descriptor,
        left,
        pivot.left,
      );
      const nextRight = await this.#writeDirectoryPage(
        rightPage.descriptor,
        pivot.right,
        rightPage.right,
      );
      return this.#writeDirectoryPage(pivot.descriptor, nextLeft, nextRight);
    }
    return this.#writeDirectoryPage(descriptor, left, right);
  }

  async #readManifest(): Promise<ProjectionManifest | undefined> {
    const file = path.join(this.rootDir, "manifest.json");
    let handle: FileHandle;
    try {
      claimStorageIo("ioOperations", 1);
      handle = await open(file, "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      claimStorageIo("ioOperations", 1);
      const metadata = await handle.stat();
      if (metadata.size <= 0 || metadata.size > MAX_VALUE_BYTES) {
        throw new Error("Projection manifest size is invalid");
      }
      const bytes = Buffer.allocUnsafe(metadata.size);
      claimStorageIo("readBytes", bytes.byteLength);
      claimStorageIo("ioOperations", 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (bytesRead !== bytes.byteLength) {
        throw new Error("Projection manifest changed while reading");
      }
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (canonicalize(value) !== bytes.toString("utf8")) {
        throw new Error("Projection manifest is not canonical");
      }
      return validateManifest(value);
    } finally {
      await handle.close();
    }
  }

  async #writeManifest(manifest: ProjectionManifest): Promise<void> {
    const encoded = Buffer.from(canonicalize(manifest), "utf8");
    if (encoded.byteLength > MAX_VALUE_BYTES) {
      throw new RangeError("Projection manifest exceeds its byte budget");
    }
    const temporary = path.join(this.rootDir, ".manifest.tmp");
    await unlink(temporary).catch(() => undefined);
    claimStorageIo("ioOperations", 1);
    const handle = await open(temporary, "wx", 0o600);
    try {
      claimStorageIo("writeBytes", encoded.byteLength);
      claimStorageIo("temporaryBytes", encoded.byteLength);
      claimStorageIo("ioOperations", 2);
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    claimStorageIo("ioOperations", 2);
    await rename(temporary, path.join(this.rootDir, "manifest.json"));
    await syncDirectory(this.rootDir);
  }

  async #validatePublishedStorage(
    manifest: ProjectionManifest,
  ): Promise<void> {
    if (
      manifest.deltaSegments.length >
        MAX_DELTA_SEGMENTS + (manifest.compaction ? 1 : 0)
    ) {
      throw new Error("Projection manifest has too many delta segments");
    }
    for (const segment of manifest.deltaSegments) {
      if (segment.level !== 0) {
        throw new Error("Projection delta segment level is invalid");
      }
      const reader = await SegmentReader.open(this.rootDir, segment);
      try {
        const first = await reader.entry(0);
        const last = await reader.entry(segment.count - 1);
        if (
          first?.key !== segment.minKey ||
          last?.key !== segment.maxKey
        ) {
          throw projectionCorrupt(
            "Projection segment boundaries do not match the manifest",
          );
        }
      } finally {
        await reader.close();
      }
    }
    if (manifest.baseRoot) {
      await this.#loadDirectoryPage(manifest.baseRoot);
    }
    if (manifest.retirementRoot) {
      await this.#loadRetirementPage(manifest.retirementRoot);
    }
  }

  async #prependRetirementPages(
    files: readonly string[],
    retiredAtGeneration: number,
    previous: RetirementPagePointer | undefined,
  ): Promise<RetirementPagePointer | undefined> {
    const unique = [...new Set(files)].sort(compareKeys);
    let next = previous;
    for (let end = unique.length; end > 0; end -= MAX_RETIREMENT_PAGE_FILES) {
      const start = Math.max(0, end - MAX_RETIREMENT_PAGE_FILES);
      const page: RetirementPage = {
        formatVersion: RETIREMENT_PAGE_FORMAT_VERSION,
        retiredAtGeneration,
        files: unique.slice(start, end),
        ...(next === undefined ? {} : { next }),
      };
      next = await this.#writeRetirementPage(page);
    }
    return next;
  }

  async #writeRetirementPage(
    page: RetirementPage,
  ): Promise<RetirementPagePointer> {
    const encoded = Buffer.from(canonicalize(page), "utf8");
    if (encoded.byteLength > MAX_RETIREMENT_PAGE_BYTES) {
      throw new RangeError("Projection retirement page exceeds its byte budget");
    }
    const pointer = { id: checksum(encoded).toString("hex") };
    const file = retirementPageFile(pointer.id);
    try {
      const existing = await this.#loadRetirementPage(pointer);
      if (canonicalize(existing) !== encoded.toString("utf8")) {
        throw projectionCorrupt("Projection retirement page hash collision");
      }
      return pointer;
    } catch (error) {
      if (
        !(error instanceof DurableProjectionStorageError) ||
        !isNodeError(error.cause, "ENOENT")
      ) {
        throw error;
      }
    }
    await this.#planCreatedFiles([file]);
    const temporary = path.join(this.rootDir, `.${file}.tmp`);
    claimStorageIo("ioOperations", 1);
    const handle = await open(temporary, "wx", 0o600);
    try {
      claimStorageIo("writeBytes", encoded.byteLength);
      claimStorageIo("temporaryBytes", encoded.byteLength);
      claimStorageIo("ioOperations", 2);
      await handle.writeFile(encoded);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    claimStorageIo("ioOperations", 1);
    await rename(temporary, path.join(this.rootDir, file));
    return pointer;
  }

  async #loadRetirementPage(
    pointer: RetirementPagePointer,
  ): Promise<RetirementPage> {
    const file = retirementPageFile(pointer.id);
    let handle: FileHandle;
    try {
      claimStorageIo("ioOperations", 1);
      handle = await open(path.join(this.rootDir, file), "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw projectionCorrupt("Projection retirement page is missing", error);
      }
      throw error;
    }
    try {
      claimStorageIo("ioOperations", 1);
      const metadata = await handle.stat();
      if (
        metadata.size <= 0 ||
        metadata.size > MAX_RETIREMENT_PAGE_BYTES
      ) {
        throw projectionCorrupt("Projection retirement page size is invalid");
      }
      const bytes = Buffer.allocUnsafe(metadata.size);
      claimStorageIo("readBytes", bytes.byteLength);
      claimStorageIo("ioOperations", 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (
        bytesRead !== bytes.byteLength ||
        checksum(bytes).toString("hex") !== pointer.id
      ) {
        throw projectionCorrupt("Projection retirement page checksum is invalid");
      }
      const encoded = bytes.toString("utf8");
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch (error) {
        throw projectionCorrupt("Projection retirement page is invalid", error);
      }
      if (canonicalize(value) !== encoded) {
        throw projectionCorrupt("Projection retirement page is not canonical");
      }
      return validateRetirementPage(value);
    } finally {
      await handle.close();
    }
  }

  async #drainRetirement(): Promise<void> {
    const manifest = this.#manifest;
    if (!manifest) return;
    if (manifest.retirementCleanup) {
      await durablyRemoveFile(
        path.join(this.rootDir, manifest.retirementCleanup),
      );
      this.#directoryCache.delete(
        directoryPageIdFromFile(manifest.retirementCleanup) ?? "",
      );
      const next = withoutRetirementCleanup(manifest);
      await this.#writeManifest(next);
      this.#manifest = next;
      return;
    }
    if (!manifest.retirementRoot) return;
    let oldestReadGeneration: number | undefined;
    const observe = (view: ReadView) => {
      oldestReadGeneration = oldestReadGeneration === undefined
        ? view.generation
        : Math.min(oldestReadGeneration, view.generation);
    };
    for (const view of this.#readViews.values()) observe(view);
    for (const { view } of this.#inUseReadViews.values()) observe(view);
    const page = await this.#loadRetirementPage(manifest.retirementRoot);
    if (
      oldestReadGeneration !== undefined &&
      oldestReadGeneration < page.retiredAtGeneration
    ) {
      return;
    }
    await durablyRemoveFiles(
      page.files.map((file) => path.join(this.rootDir, file)),
    );
    for (const file of page.files) {
      this.#directoryCache.delete(directoryPageIdFromFile(file) ?? "");
    }
    const next: ProjectionManifest = {
      ...manifest,
      generation: manifest.generation + 1,
      ...(page.next === undefined
        ? { retirementRoot: undefined }
        : { retirementRoot: page.next }),
      retirementCleanup: retirementPageFile(manifest.retirementRoot.id),
    };
    const normalized = normalizeManifestOptionals(next);
    await this.#writeManifest(normalized);
    this.#manifest = normalized;
  }

  async #beginWriteIntent(targetGeneration: number): Promise<void> {
    if (this.#writeIntent) {
      throw new Error("Projection write intent is already active");
    }
    // 新意图会覆盖磁盘上的旧凭据,必须继承它尚未完成的清理义务,否则孤儿只剩
    // 进程内记录,重启即失去入口。只继承符合退休文件名的对象:它们同时满足
    // created 与 transient 两处校验,retirement 页另有 retirementCleanup 机制。
    const carried = [...this.#uncleared]
      .filter(isRetirableProjectionFile)
      .sort(compareKeys);
    this.#writeIntent = {
      formatVersion: WRITE_INTENT_FORMAT_VERSION,
      targetGeneration,
      createdFiles: carried,
      transientFiles: carried,
    };
    await this.#writeIntentFile(this.#writeIntent);
  }

  async #planCreatedFiles(files: readonly string[]): Promise<void> {
    const intent = this.#requireWriteIntent();
    const createdFiles = [...new Set([...intent.createdFiles, ...files])]
      .sort(compareKeys);
    this.#writeIntent = { ...intent, createdFiles };
    await this.#writeIntentFile(this.#writeIntent);
  }

  async #finalizeWriteIntent(
    manifest: ProjectionManifest,
    transientFiles: readonly string[],
  ): Promise<void> {
    const intent = this.#requireWriteIntent();
    this.#writeIntent = {
      ...intent,
      // 意图初始的 transientFiles 是从上一次继承来的待清理对象,不能被本次结果覆盖。
      transientFiles: [
        ...new Set([...transientFiles, ...intent.transientFiles]),
      ].sort(compareKeys),
      manifestDigest: projectionManifestDigest(manifest),
    };
    await this.#writeIntentFile(this.#writeIntent);
  }

  async #writeIntentFile(intent: ProjectionWriteIntent): Promise<void> {
    const encoded = Buffer.from(canonicalize(intent), "utf8");
    if (encoded.byteLength > MAX_VALUE_BYTES) {
      throw new RangeError("Projection write intent exceeds its byte budget");
    }
    const temporary = path.join(this.rootDir, ".write-intent.tmp");
    await unlink(temporary).catch(() => undefined);
    claimStorageIo("ioOperations", 1);
    const handle = await open(temporary, "wx", 0o600);
    try {
      claimStorageIo("writeBytes", encoded.byteLength);
      claimStorageIo("temporaryBytes", encoded.byteLength);
      claimStorageIo("ioOperations", 2);
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    claimStorageIo("ioOperations", 2);
    await rename(temporary, path.join(this.rootDir, "write-intent.json"));
    await syncDirectory(this.rootDir);
  }

  async #recoverWriteIntent(): Promise<void> {
    const intent = await this.#readWriteIntent();
    if (!intent) {
      await unlink(path.join(this.rootDir, ".write-intent.tmp")).catch(
        () => undefined,
      );
      return;
    }
    const manifest = await this.#readManifest().catch(() => undefined);
    this.#writeIntent = intent;
    await this.#completeWriteIntent(
      manifest !== undefined && isCommittedIntent(intent, manifest),
    );
  }

  async #readWriteIntent(): Promise<ProjectionWriteIntent | undefined> {
    const file = path.join(this.rootDir, "write-intent.json");
    let handle: FileHandle;
    try {
      claimStorageIo("ioOperations", 1);
      handle = await open(file, "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      claimStorageIo("ioOperations", 1);
      const metadata = await handle.stat();
      if (metadata.size <= 0 || metadata.size > MAX_VALUE_BYTES) {
        throw projectionCorrupt("Projection write intent size is invalid");
      }
      const bytes = Buffer.allocUnsafe(metadata.size);
      claimStorageIo("readBytes", bytes.byteLength);
      claimStorageIo("ioOperations", 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (bytesRead !== bytes.byteLength) {
        throw projectionCorrupt("Projection write intent is truncated");
      }
      const encoded = bytes.toString("utf8");
      const value = JSON.parse(encoded) as unknown;
      if (canonicalize(value) !== encoded) {
        throw projectionCorrupt("Projection write intent is not canonical");
      }
      return validateWriteIntent(value);
    } finally {
      await handle.close();
    }
  }

  async #completeWriteIntent(committed: boolean): Promise<void> {
    const intent = this.#requireWriteIntent();
    const files = committed ? intent.transientFiles : intent.createdFiles;
    // 这些对象已被 manifest 取代或从未被它引用,清理不产生任何被下游消费的删除
    // 结论:失败只留孤儿,不得升级为发布失败,也不得阻断进程内状态复位。
    //
    // 写意图是"这批对象仍待清理"的恢复凭据,因此必须与它所描述的对象分阶段删除:
    // 只有对象全部清除后才允许删除凭据。批量原语为保证屏障完整性会在单个文件失败
    // 后继续删完其余文件,若把凭据放进同一批,凭据就会先于对象消失,孤儿从此没有
    // 恢复入口。
    const payload = [
      ...new Set([
        ...files,
        ...intent.createdFiles.map((file) => `.${file}.tmp`),
        ...this.#uncleared,
      ]),
    ];
    let cleared = true;
    try {
      await durablyRemoveFiles(
        payload.map((file) => path.join(this.rootDir, file)),
      );
    } catch {
      cleared = false;
      // 未清除对象转入进程内待清理集合。磁盘凭据供下次打开重试;同进程后续写意图
      // 会覆盖那份凭据,但每个新意图收尾时都会连同本集合一起重删,义务不丢失。
      // 只收意图列出的派生对象:`.tmp` 影子是自建临时文件,残留无下游影响,
      // 而且它们不是合法的派生文件名,不能进入任何按名登记的列表。
      for (const file of files) this.#uncleared.add(file);
    }
    if (cleared) {
      this.#uncleared.clear();
      try {
        await durablyRemoveFiles([
          path.join(this.rootDir, "write-intent.json"),
          path.join(this.rootDir, ".write-intent.tmp"),
        ]);
      } catch {
        // 凭据残留只会让下次打开按同一意图重放一次幂等清理。
      }
    }
    for (const file of files) {
      this.#directoryCache.delete(directoryPageIdFromFile(file) ?? "");
    }
    this.#writeIntent = undefined;
  }

  async #clearDerivedStorageStep(): Promise<boolean> {
    this.#writeIntent = undefined;
    this.#clearInProgress = true;
    if (!this.#clearDirectory) {
      claimStorageIo("ioOperations", 1);
      this.#clearDirectory = await opendir(this.rootDir);
    }
    const files: string[] = [];
    let exhausted = false;
    try {
      for (
        let inspected = 0;
        inspected < MAX_CLEAR_ENTRIES_PER_STEP;
        inspected += 1
      ) {
        claimStorageIo("ioOperations", 1);
        const entry = await this.#clearDirectory.read();
        if (!entry) {
          exhausted = true;
          break;
        }
        if (entry.isFile()) files.push(path.join(this.rootDir, entry.name));
      }
    } catch (error) {
      await this.#clearDirectory.close().catch(() => undefined);
      this.#clearDirectory = undefined;
      this.#clearInProgress = false;
      throw error;
    }
    // 派生存储被整体重建，残留文件不会被新 manifest 引用。单个清理失败只留孤儿，
    // 不得把 housekeeping 失败升级为权威日志不可恢复；游标仍推进到后续固定页。
    try {
      await durablyRemoveFiles(files);
    } catch {
      // 下一次完整重建会再次枚举孤儿；退休回收只处理 manifest 登记的对象。
    }
    if (!exhausted) return false;
    await this.#clearDirectory.close().catch(() => undefined);
    this.#clearDirectory = undefined;
    this.#clearInProgress = false;
    // 整个目录已完成一次有界遍历，按名登记的待清理义务随之作废。
    this.#uncleared.clear();
    this.#directoryCache.clear();
    return true;
  }

  #requireWriteIntent(): ProjectionWriteIntent {
    if (!this.#writeIntent) {
      throw new Error("Projection write intent is not active");
    }
    return this.#writeIntent;
  }

  #requireManifest(): ProjectionManifest {
    if (!this.#manifest) {
      throw new Error("Durable projection index is not initialized");
    }
    return this.#manifest;
  }
}

class SegmentReader {
  private constructor(
    readonly descriptor: SegmentDescriptor,
    readonly data: FileHandle,
    readonly offsets: FileHandle,
  ) {}

  static async open(
    rootDir: string,
    descriptor: SegmentDescriptor,
  ): Promise<SegmentReader> {
    let data: FileHandle;
    try {
      claimStorageIo("ioOperations", 1);
      data = await open(path.join(rootDir, descriptor.dataFile), "r");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw projectionCorrupt("Projection segment data file is missing", error);
      }
      throw error;
    }
    try {
      claimStorageIo("ioOperations", 1);
      const offsets = await open(path.join(rootDir, descriptor.offsetsFile), "r");
      return new SegmentReader(descriptor, data, offsets);
    } catch (error) {
      await data.close();
      if (isNodeError(error, "ENOENT")) {
        throw projectionCorrupt(
          "Projection segment offset table is missing",
          error,
        );
      }
      throw error;
    }
  }

  async get(key: string): Promise<SegmentEntry | undefined> {
    const index = await this.lowerBound(key);
    const entry = await this.entry(index);
    return entry?.key === key ? entry : undefined;
  }

  async lowerBound(key: string): Promise<number> {
    let low = 0;
    let high = this.descriptor.count;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = await this.entry(middle);
      if (!entry) {
        throw projectionCorrupt("Projection segment offset is invalid");
      }
      if (entry.key < key) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  async entry(index: number): Promise<SegmentEntry | undefined> {
    if (index < 0 || index >= this.descriptor.count) return undefined;
    const offsetBytes = Buffer.allocUnsafe(8);
    claimStorageIo("readBytes", offsetBytes.byteLength);
    claimStorageIo("ioOperations", 1);
    const offsetRead = await this.offsets.read(offsetBytes, 0, 8, index * 8);
    if (offsetRead.bytesRead !== 8) {
      throw projectionCorrupt("Projection segment offset table is truncated");
    }
    const offset = offsetBytes.readBigUInt64BE();
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw projectionCorrupt("Projection segment offset exceeds the safe range");
    }
    const header = Buffer.allocUnsafe(SEGMENT_HEADER_BYTES);
    claimStorageIo("readBytes", header.byteLength);
    claimStorageIo("ioOperations", 1);
    const headerRead = await this.data.read(
      header,
      0,
      header.byteLength,
      Number(offset),
    );
    if (headerRead.bytesRead !== header.byteLength) {
      throw projectionCorrupt("Projection segment entry header is truncated");
    }
    const keyBytes = header.readUInt32BE(0);
    const valueBytes = header.readUInt32BE(4);
    const flags = header.readUInt8(8);
    const formatVersion = header.readUInt8(9);
    const ordinal = header.readBigUInt64BE(12);
    if (
      keyBytes <= 0 ||
      keyBytes > MAX_KEY_BYTES ||
      valueBytes > MAX_VALUE_BYTES ||
      (flags !== 0 && flags !== SEGMENT_TOMBSTONE) ||
      (flags === SEGMENT_TOMBSTONE && valueBytes !== 0) ||
      formatVersion !== SEGMENT_FORMAT_VERSION ||
      header.readUInt16BE(10) !== 0 ||
      ordinal !== BigInt(index)
    ) {
      throw projectionCorrupt("Projection segment entry header is invalid");
    }
    const payload = Buffer.allocUnsafe(keyBytes + valueBytes);
    claimStorageIo("readBytes", payload.byteLength);
    claimStorageIo("ioOperations", 1);
    const payloadRead = await this.data.read(
      payload,
      0,
      payload.byteLength,
      Number(offset) + SEGMENT_HEADER_BYTES,
    );
    if (
      payloadRead.bytesRead !== payload.byteLength ||
      !checksum(Buffer.concat([header.subarray(0, 20), payload])).equals(
        header.subarray(20, 52),
      )
    ) {
      throw projectionCorrupt("Projection segment entry checksum is invalid");
    }
    const key = payload.subarray(0, keyBytes).toString("utf8");
    assertKey(key);
    if (flags === SEGMENT_TOMBSTONE) {
      return { key, tombstone: true };
    }
    const encoded = payload.subarray(keyBytes).toString("utf8");
    let value: JsonValue;
    try {
      value = JSON.parse(encoded) as JsonValue;
    } catch (error) {
      throw projectionCorrupt("Projection segment value is invalid", error);
    }
    if (canonicalize(value) !== encoded) {
      throw projectionCorrupt("Projection segment value is not canonical");
    }
    return { key, value, tombstone: false };
  }

  async close(): Promise<void> {
    await Promise.all([this.data.close(), this.offsets.close()]);
  }
}

function normalizeMutations(
  mutations: readonly DurableProjectionMutation[],
): Map<string, StoredMutation> {
  const normalized = new Map<string, StoredMutation>();
  for (const mutation of mutations) {
    assertKey(mutation.key);
    if (mutation.kind === "tombstone") {
      normalized.set(mutation.key, {
        key: mutation.key,
        tombstone: true,
        bytes: Buffer.byteLength(mutation.key, "utf8") + SEGMENT_HEADER_BYTES,
      });
      continue;
    }
    const encoded = canonicalize(mutation.value);
    const valueBytes = Buffer.byteLength(encoded, "utf8");
    if (valueBytes > MAX_VALUE_BYTES) {
      throw new RangeError("Projection value exceeds its byte budget");
    }
    normalized.set(mutation.key, {
      key: mutation.key,
      value: mutation.value,
      tombstone: false,
      bytes:
        Buffer.byteLength(mutation.key, "utf8") +
        valueBytes +
        SEGMENT_HEADER_BYTES,
    });
  }
  return normalized;
}

function encodeSegmentEntry(entry: StoredMutation, ordinal: number): Buffer {
  const key = Buffer.from(entry.key, "utf8");
  const value = entry.tombstone
    ? Buffer.alloc(0)
    : Buffer.from(canonicalize(entry.value), "utf8");
  const payload = Buffer.concat([key, value]);
  const header = Buffer.alloc(SEGMENT_HEADER_BYTES);
  header.writeUInt32BE(key.byteLength, 0);
  header.writeUInt32BE(value.byteLength, 4);
  header.writeUInt8(entry.tombstone ? SEGMENT_TOMBSTONE : 0, 8);
  header.writeUInt8(SEGMENT_FORMAT_VERSION, 9);
  header.writeBigUInt64BE(BigInt(ordinal), 12);
  checksum(Buffer.concat([header.subarray(0, 20), payload])).copy(header, 20);
  return Buffer.concat([header, payload]);
}

function storedMutation(entry: SegmentEntry): StoredMutation {
  const valueBytes = entry.tombstone
    ? 0
    : Buffer.byteLength(canonicalize(entry.value), "utf8");
  return {
    key: entry.key,
    ...(entry.value !== undefined ? { value: entry.value } : {}),
    tombstone: entry.tombstone,
    bytes:
      Buffer.byteLength(entry.key, "utf8") +
      valueBytes +
      SEGMENT_HEADER_BYTES,
  };
}

function validateManifest(value: unknown): ProjectionManifest {
  const record = plainRecord(value);
  if (
    record?.formatVersion !== INDEX_FORMAT_VERSION ||
    typeof record.projectionId !== "string" ||
    !Number.isSafeInteger(record.reducerVersion) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) <= 0 ||
    !Array.isArray(record.deltaSegments)
  ) {
    throw new Error("Projection manifest is invalid");
  }
  assertProjectionIdentity(
    record.projectionId,
    record.reducerVersion as number,
  );
  const checkpoints = validateCheckpoints(record.checkpoints);
  const deltaSegments = record.deltaSegments.map(validateSegmentDescriptor);
  const compaction = record.compaction === undefined
    ? undefined
    : validateProjectionCompaction(record.compaction);
  if (
    deltaSegments.length >
      MAX_DELTA_SEGMENTS + (compaction === undefined ? 0 : 1) ||
    (compaction !== undefined &&
      deltaSegments.length <= MAX_DELTA_SEGMENTS) ||
    deltaSegments.some(({ level }) => level !== 0)
  ) {
    throw new Error("Projection manifest delta segments are invalid");
  }
  const baseRoot = record.baseRoot === undefined
    ? undefined
    : validateDirectoryPagePointer(record.baseRoot);
  const retirementRoot = record.retirementRoot === undefined
    ? undefined
    : validateRetirementPagePointer(record.retirementRoot);
  const retirementCleanup = record.retirementCleanup;
  if (
    retirementCleanup !== undefined &&
    (
      typeof retirementCleanup !== "string" ||
      !/^retirement-[a-f0-9]{64}\.json$/u.test(retirementCleanup)
    )
  ) {
    throw new Error("Projection manifest retirement cleanup is invalid");
  }
  return {
    formatVersion: 3,
    projectionId: record.projectionId,
    reducerVersion: record.reducerVersion as number,
    generation: record.generation as number,
    checkpoints,
    deltaSegments,
    ...(compaction === undefined ? {} : { compaction }),
    ...(baseRoot === undefined ? {} : { baseRoot }),
    ...(retirementRoot === undefined ? {} : { retirementRoot }),
    ...(retirementCleanup === undefined ? {} : { retirementCleanup }),
  };
}

function validateProjectionCompaction(value: unknown): ProjectionCompaction {
  const record = plainRecord(value);
  if (!record) {
    throw new Error("Projection manifest compaction is invalid");
  }
  const keys = Object.keys(record);
  if (
    keys.some((key) => key !== "afterKey") ||
    (record.afterKey !== undefined && typeof record.afterKey !== "string")
  ) {
    throw new Error("Projection manifest compaction is invalid");
  }
  if (record.afterKey !== undefined) assertKey(record.afterKey);
  return record.afterKey === undefined ? {} : { afterKey: record.afterKey };
}

function validateCheckpoint(value: unknown): DurableLogCheckpoint {
  const record = plainRecord(value);
  if (
    typeof record?.logId !== "string" ||
    !Number.isSafeInteger(record.lsn) ||
    (record.lsn as number) < 0 ||
    !Number.isSafeInteger(record.frameEndOffset) ||
    (record.frameEndOffset as number) < 0 ||
    typeof record.prefixDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.prefixDigest)
  ) {
    throw new Error("Projection checkpoint is invalid");
  }
  return {
    logId: record.logId,
    lsn: record.lsn as number,
    frameEndOffset: record.frameEndOffset as number,
    prefixDigest: record.prefixDigest,
  };
}

function validateCheckpoints(value: unknown): DurableProjectionCheckpoints {
  const record = plainRecord(value);
  if (!record || Object.keys(record).length === 0) {
    throw new Error("Projection checkpoint set is invalid");
  }
  const checkpoints: Record<string, DurableLogCheckpoint> = {};
  for (const sourceId of Object.keys(record).sort(compareKeys)) {
    if (
      sourceId.length === 0 ||
      sourceId.length > 240 ||
      /[\u0000-\u001f\u007f]/u.test(sourceId)
    ) {
      throw new Error("Projection checkpoint source id is invalid");
    }
    checkpoints[sourceId] = validateCheckpoint(record[sourceId]);
  }
  return checkpoints;
}

function cloneCheckpoints(
  checkpoints: DurableProjectionCheckpoints,
): DurableProjectionCheckpoints {
  return Object.fromEntries(
    Object.entries(checkpoints).map(([sourceId, checkpoint]) => [
      sourceId,
      { ...checkpoint },
    ]),
  );
}

/**
 * 判断写意图所描述的那次发布是否已经提交。
 *
 * 不能用"当前 manifest 的摘要等于意图记录的摘要"作判据:manifest 在该意图收尾
 * 之后仍会继续演进(退休回收就会紧接着再写一次),摘要因而会失配,把已提交的
 * 意图误判成未提交,进而按回滚语义删除仍被 manifest 引用的新建文件。generation
 * 单调递增,是唯一稳定的判据;`manifestDigest` 仍作为"已进入提交阶段"的标志。
 */
function isCommittedIntent(
  intent: ProjectionWriteIntent,
  manifest: ProjectionManifest,
): boolean {
  return (
    intent.manifestDigest !== undefined &&
    manifest.generation >= intent.targetGeneration
  );
}

function sameCheckpointSources(
  left: DurableProjectionCheckpoints,
  right: DurableProjectionCheckpoints,
): boolean {
  const leftKeys = Object.keys(left).sort(compareKeys);
  const rightKeys = Object.keys(right).sort(compareKeys);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      left[key]?.logId === right[key]?.logId
    )
  );
}

function sameCheckpoints(
  left: DurableProjectionCheckpoints,
  right: DurableProjectionCheckpoints,
): boolean {
  return canonicalize(left) === canonicalize(right);
}

function validateSegmentDescriptor(value: unknown): SegmentDescriptor {
  const record = plainRecord(value);
  if (
    typeof record?.id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(record.id) ||
    typeof record.dataFile !== "string" ||
    typeof record.offsetsFile !== "string" ||
    !Number.isSafeInteger(record.count) ||
    (record.count as number) <= 0 ||
    typeof record.minKey !== "string" ||
    typeof record.maxKey !== "string"
    || (record.level !== 0 && record.level !== 1)
  ) {
    throw new Error("Projection segment descriptor is invalid");
  }
  const expectedData = `segment-${record.id}.data`;
  const expectedOffsets = `segment-${record.id}.offsets`;
  if (
    record.dataFile !== expectedData ||
    record.offsetsFile !== expectedOffsets ||
    record.minKey > record.maxKey
  ) {
    throw new Error("Projection segment descriptor paths are invalid");
  }
  assertKey(record.minKey);
  assertKey(record.maxKey);
  return {
    id: record.id,
    dataFile: record.dataFile,
    offsetsFile: record.offsetsFile,
    count: record.count as number,
    minKey: record.minKey,
    maxKey: record.maxKey,
    level: record.level,
  };
}

function directoryHeight(pointer: DirectoryPagePointer | undefined): number {
  return pointer?.height ?? 0;
}

function directoryPointerFor(page: DirectoryPage): DirectoryPagePointer {
  const { descriptor, left, right } = page;
  if (
    left && left.maxKey >= descriptor.minKey ||
    right && descriptor.maxKey >= right.minKey
  ) {
    throw new TypeError("Projection directory segment ranges overlap");
  }
  const height = 1 + Math.max(directoryHeight(left), directoryHeight(right));
  if (
    height > MAX_DIRECTORY_HEIGHT ||
    Math.abs(directoryHeight(left) - directoryHeight(right)) > 1
  ) {
    throw new TypeError("Projection directory tree is not balanced");
  }
  const count = 1 + (left?.count ?? 0) + (right?.count ?? 0);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError("Projection directory count exceeds the safe range");
  }
  const encoded = Buffer.from(canonicalize(page), "utf8");
  if (encoded.byteLength > MAX_DIRECTORY_PAGE_BYTES) {
    throw new RangeError("Projection directory page exceeds its byte budget");
  }
  return {
    id: checksum(encoded).toString("hex"),
    minKey: left?.minKey ?? descriptor.minKey,
    maxKey: right?.maxKey ?? descriptor.maxKey,
    count,
    height,
  };
}

function validateDirectoryPagePointer(
  value: unknown,
): DirectoryPagePointer {
  const record = plainRecord(value);
  if (
    typeof record?.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.id) ||
    typeof record.minKey !== "string" ||
    typeof record.maxKey !== "string" ||
    !Number.isSafeInteger(record.count) ||
    (record.count as number) <= 0 ||
    !Number.isSafeInteger(record.height) ||
    (record.height as number) <= 0 ||
    (record.height as number) > MAX_DIRECTORY_HEIGHT
  ) {
    throw new Error("Projection directory page pointer is invalid");
  }
  assertKey(record.minKey);
  assertKey(record.maxKey);
  if (record.minKey > record.maxKey) {
    throw new Error("Projection directory page pointer range is invalid");
  }
  return {
    id: record.id,
    minKey: record.minKey,
    maxKey: record.maxKey,
    count: record.count as number,
    height: record.height as number,
  };
}

function validateDirectoryPage(
  value: unknown,
  expected: DirectoryPagePointer,
): DirectoryPage {
  const record = plainRecord(value);
  if (
    record?.formatVersion !== DIRECTORY_PAGE_FORMAT_VERSION ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{32}$/u.test(record.nonce)
  ) {
    throw projectionCorrupt("Projection directory page version is invalid");
  }
  const descriptor = validateSegmentDescriptor(record.descriptor);
  if (descriptor.level !== 1) {
    throw projectionCorrupt("Projection directory page contains a delta segment");
  }
  const left = record.left === undefined
    ? undefined
    : validateDirectoryPagePointer(record.left);
  const right = record.right === undefined
    ? undefined
    : validateDirectoryPagePointer(record.right);
  const page: DirectoryPage = {
    formatVersion: DIRECTORY_PAGE_FORMAT_VERSION,
    nonce: record.nonce,
    descriptor,
    ...(left === undefined ? {} : { left }),
    ...(right === undefined ? {} : { right }),
  };
  let actual: DirectoryPagePointer;
  try {
    actual = directoryPointerFor(page);
  } catch (error) {
    throw projectionCorrupt("Projection directory page metadata is invalid", error);
  }
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw projectionCorrupt("Projection directory page pointer does not match");
  }
  return page;
}

function validateRetirementPagePointer(
  value: unknown,
): RetirementPagePointer {
  const record = plainRecord(value);
  if (
    typeof record?.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.id)
  ) {
    throw new Error("Projection retirement page pointer is invalid");
  }
  return { id: record.id };
}

function validateRetirementPage(value: unknown): RetirementPage {
  const record = plainRecord(value);
  if (
    record?.formatVersion !== RETIREMENT_PAGE_FORMAT_VERSION ||
    !Number.isSafeInteger(record.retiredAtGeneration) ||
    (record.retiredAtGeneration as number) <= 0 ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_RETIREMENT_PAGE_FILES ||
    record.files.some((file) =>
      typeof file !== "string" || !isRetirableProjectionFile(file)
    ) ||
    new Set(record.files).size !== record.files.length
  ) {
    throw projectionCorrupt("Projection retirement page is invalid");
  }
  const next = record.next === undefined
    ? undefined
    : validateRetirementPagePointer(record.next);
  return {
    formatVersion: RETIREMENT_PAGE_FORMAT_VERSION,
    retiredAtGeneration: record.retiredAtGeneration as number,
    files: [...record.files] as string[],
    ...(next === undefined ? {} : { next }),
  };
}

function validateWriteIntent(value: unknown): ProjectionWriteIntent {
  const record = plainRecord(value);
  if (
    record?.formatVersion !== WRITE_INTENT_FORMAT_VERSION ||
    !Number.isSafeInteger(record.targetGeneration) ||
    (record.targetGeneration as number) <= 0 ||
    !Array.isArray(record.createdFiles) ||
    !Array.isArray(record.transientFiles) ||
    record.createdFiles.some((file) =>
      typeof file !== "string" || !isCreatedProjectionFile(file)
    ) ||
    record.transientFiles.some((file) =>
      typeof file !== "string" || !isRetirableProjectionFile(file)
    ) ||
    new Set(record.createdFiles).size !== record.createdFiles.length ||
    new Set(record.transientFiles).size !== record.transientFiles.length ||
    record.transientFiles.some(
      (file) => !(record.createdFiles as unknown[]).includes(file),
    ) ||
    (
      record.manifestDigest !== undefined &&
      (
        typeof record.manifestDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.manifestDigest)
      )
    )
  ) {
    throw projectionCorrupt("Projection write intent is invalid");
  }
  return {
    formatVersion: WRITE_INTENT_FORMAT_VERSION,
    targetGeneration: record.targetGeneration as number,
    createdFiles: [...record.createdFiles] as string[],
    transientFiles: [...record.transientFiles] as string[],
    ...(record.manifestDigest === undefined
      ? {}
      : { manifestDigest: record.manifestDigest as string }),
  };
}

function directoryPageFile(id: string): string {
  return `directory-${id}.json`;
}

function retirementPageFile(id: string): string {
  return `retirement-${id}.json`;
}

function directoryPageIdFromFile(file: string): string | undefined {
  return /^directory-([a-f0-9]{64})\.json$/u.exec(file)?.[1];
}

function isRetirableProjectionFile(file: string): boolean {
  return (
    /^segment-[a-f0-9]{32}\.(?:data|offsets)$/u.test(file) ||
    /^directory-[a-f0-9]{64}\.json$/u.test(file)
  );
}

function isCreatedProjectionFile(file: string): boolean {
  return (
    isRetirableProjectionFile(file) ||
    /^retirement-[a-f0-9]{64}\.json$/u.test(file)
  );
}

function projectionManifestDigest(manifest: ProjectionManifest): string {
  return checksum(Buffer.from(canonicalize(manifest), "utf8")).toString("hex");
}

function normalizeManifestOptionals(
  manifest: ProjectionManifest,
): ProjectionManifest {
  return {
    formatVersion: manifest.formatVersion,
    projectionId: manifest.projectionId,
    reducerVersion: manifest.reducerVersion,
    generation: manifest.generation,
    checkpoints: manifest.checkpoints,
    deltaSegments: manifest.deltaSegments,
    ...(manifest.compaction === undefined
      ? {}
      : { compaction: manifest.compaction }),
    ...(manifest.baseRoot === undefined ? {} : { baseRoot: manifest.baseRoot }),
    ...(manifest.retirementRoot === undefined
      ? {}
      : { retirementRoot: manifest.retirementRoot }),
    ...(manifest.retirementCleanup === undefined
      ? {}
      : { retirementCleanup: manifest.retirementCleanup }),
  };
}

function withoutRetirementCleanup(
  manifest: ProjectionManifest,
): ProjectionManifest {
  return normalizeManifestOptionals({
    ...manifest,
    generation: manifest.generation + 1,
    retirementCleanup: undefined,
  });
}

function normalizeRange(
  range: DurableProjectionScanRange,
): NormalizedScanRange {
  if (range.gte !== undefined && range.gt !== undefined) {
    throw new TypeError("Projection scan range cannot combine gte and gt");
  }
  const gte = range.gte ?? "";
  const gt = range.gt;
  const lt = range.lt ?? "\u{10ffff}";
  if (gte !== "") assertKey(gte);
  if (gt !== undefined) assertKey(gt);
  if (lt !== "\u{10ffff}") assertKey(lt);
  if (gte >= lt || (gt !== undefined && gt >= lt)) {
    throw new RangeError("Projection scan range is empty");
  }
  return { gte, ...(gt === undefined ? {} : { gt }), lt };
}

function encodeContinuation(viewId: string, lastKey: string): string {
  return Buffer.from(canonicalize({ lastKey, viewId }), "utf8").toString(
    "base64url",
  );
}

function decodeContinuation(
  encoded: string,
): { viewId: string; lastKey: string } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    throw new TypeError("Projection continuation is invalid", { cause: error });
  }
  const record = plainRecord(value);
  if (
    typeof record?.viewId !== "string" ||
    typeof record.lastKey !== "string"
  ) {
    throw new TypeError("Projection continuation is invalid");
  }
  assertKey(record.lastKey);
  return { viewId: record.viewId, lastKey: record.lastKey };
}

function assertProjectionIdentity(
  projectionId: string,
  reducerVersion: number,
): void {
  if (
    projectionId.length === 0 ||
    projectionId.length > 240 ||
    /[\u0000-\u001f\u007f]/u.test(projectionId)
  ) {
    throw new TypeError("Projection id is invalid");
  }
  assertPositiveInteger(reducerVersion, "Projection reducer version");
}

function assertKey(key: string): void {
  const bytes = Buffer.byteLength(key, "utf8");
  if (
    key.length === 0 ||
    bytes > MAX_KEY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(key)
  ) {
    throw new TypeError("Projection key is invalid");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function projectionCorrupt(
  message: string,
  cause?: unknown,
): DurableProjectionStorageError {
  return new DurableProjectionStorageError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function checksum(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function claimStorageIo(
  dimension: "readBytes" | "writeBytes" | "ioOperations" | "temporaryBytes",
  amount: number,
): void {
  claimDeviceCapacity(dimension, amount);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function durableProjectionDirectoryName(projectionId: string): string {
  return protocolDigest("DurableProjectionDirectory", 1, { projectionId })
    .slice("sha256:".length);
}
