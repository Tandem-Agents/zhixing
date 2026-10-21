import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  open,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import type { CommitEnvelope, JsonValue } from "../contracts/index.js";
import {
  durablyRemoveFile,
  durablyRemoveFiles,
  ensureDurableDirectory,
  SerialTaskQueue,
  syncDirectory,
  replaceFile,
} from "../persistence/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import {
  claimDeviceCapacity,
  currentMaintenanceAbortSignal,
  currentDeviceCapacityStep,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  runDetachedMaintenanceContext,
  runInMaintenanceContext,
  runStorageMaintenanceStep,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  StorageMaintenanceCancelledError,
  waitForMaintenanceRetry,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceKind,
  type StorageMaintenanceObligation,
} from "../resources/index.js";
import type { DurableLogCheckpoint } from "./interfaces.js";
import { projectionIndexMac, type AuthorityCacheIntegrity } from "./startup-proofs.js";

const INDEX_FORMAT_VERSION = 3;
const SEGMENT_FORMAT_VERSION = 1;
const DIRECTORY_PAGE_FORMAT_VERSION = 1;
const RETIREMENT_PAGE_FORMAT_VERSION = 1;
const WRITE_INTENT_FORMAT_VERSION = 1;
const SEGMENT_HEADER_BYTES = 52;
const SEGMENT_IO_BATCH_BYTES = 64 * 1024;
const SEGMENT_IO_BATCH_ENTRIES = 128;
const SEGMENT_TOMBSTONE = 1;
const MAX_KEY_BYTES = 2_048;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const DEFAULT_OVERLAY_ENTRIES = 512;
const DEFAULT_OVERLAY_BYTES = 1024 * 1024;
const PROJECTION_ADMISSION_DEADLINE_MS = 5_000;
const MAX_DELTA_SEGMENTS = 4;
const BASE_SEGMENT_ENTRIES = 512;
const SEGMENT_OFFSET_BATCH_BYTES = BASE_SEGMENT_ENTRIES * 8;
const BASE_SEGMENT_BYTES = 1024 * 1024;
const MAX_SCAN_LIMIT = 256;
const MAX_READ_VIEWS = 16;
const READ_VIEW_LEASE_MS = 60_000;
const MAX_DIRECTORY_HEIGHT = 64;
const MAX_DIRECTORY_CACHE_PAGES = 64;
const MAX_DIRECTORY_PAGE_BYTES = 64 * 1024;
const MAX_RETIREMENT_PAGE_FILES = 64;
const MAX_RETIREMENT_PAGE_BYTES = 64 * 1024;
const MAX_RETIREMENT_TRANSITIONS_PER_TRIGGER = 2;
const RETIREMENT_CONTINUATION_DELAY_MS = 1;

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
  /** 保存有界覆盖层；若必须先合并历史段则保留尾部待重放，不在此完成整轮合并。 */
  flushCheckpoint?(): Promise<void>;
  /** One verified authority view, in input order; missing/tombstoned keys are undefined.
   * At most 256 keys, including duplicates. An empty list performs no I/O. */
  getMany(keys: readonly string[]): Promise<readonly (JsonValue | undefined)[]>;
  rebuild(): Promise<void>;
}

export interface DurableProjectionReadContext {
  get(key: string): Promise<JsonValue | undefined>;
  /** Same verified view, in input order; at most 256 keys including duplicates. */
  getMany?(keys: readonly string[]): Promise<readonly (JsonValue | undefined)[]>;
  scan(
    range: DurableProjectionScanRange,
    limit: number,
    continuation?: string,
  ): Promise<DurableProjectionScanPage>;
}

/** Preserve the existing batch read bound through scoped/legacy read views. */
export async function readDurableProjectionKeys(
  current: DurableProjectionReadContext, keys: readonly string[],
): Promise<readonly (JsonValue | undefined)[]> {
  const selected = validateReadKeys(keys);
  if (!selected.length) return [];
  if (current.getMany) return current.getMany(selected);
  const values: (JsonValue | undefined)[] = [];
  for (const key of selected) values.push(await current.get(key));
  return values;
}

/** A finite candidate envelope can touch the same namespace several times.
 * Reducers own the source fence; scans merge those uncommitted mutations with
 * the fixed source view instead of silently ignoring earlier entries. */
export function createDurableProjectionOverlay(
  current: DurableProjectionReadContext,
  changes: ReadonlyMap<string, JsonValue | undefined>,
): DurableProjectionReadContext {
  return {
    get: async key => changes.has(key) ? changes.get(key) : current.get(key),
    async getMany(keys) {
      const selected = validateReadKeys(keys);
      const missing = selected.filter(key => !changes.has(key));
      const values = await readDurableProjectionKeys(current, missing);
      let cursor = 0;
      return selected.map(key => changes.has(key) ? changes.get(key) : values[cursor++]);
    },
    async scan(range, limit, continuation) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN_LIMIT) throw new RangeError("Projection overlay scan limit is invalid");
      const identity = canonicalize(range);
      let after: string | undefined;
      if (continuation !== undefined) {
        const cursor = JSON.parse(Buffer.from(continuation, "base64url").toString("utf8")) as { range?: unknown; after?: unknown };
        if (cursor.range !== identity || typeof cursor.after !== "string" ||
            (range.gte !== undefined && cursor.after < range.gte) ||
            (range.gt !== undefined && cursor.after <= range.gt) ||
            (range.lt !== undefined && cursor.after >= range.lt)) throw new TypeError("Projection overlay continuation is invalid");
        after = cursor.after;
      }
      const included = (key: string) => (range.gte === undefined || key >= range.gte) &&
        (range.gt === undefined || key > range.gt) && (range.lt === undefined || key < range.lt) &&
        (after === undefined || key > after);
      const pending = [...changes].filter(([key]) => included(key));
      const selected = new Map<string, JsonValue>();
      let readAfter = after;
      for (;;) {
        const page = await current.scan({ ...range, ...(readAfter === undefined ? {} : { gt: readAfter }) }, limit);
        const boundary = page.entries.at(-1)?.key;
        if (page.continuation && boundary === undefined) throw new DurableProjectionStorageError("Projection overlay base scan made no progress");
        for (const entry of page.entries) {
          const value = changes.has(entry.key) ? changes.get(entry.key) : entry.value;
          if (value !== undefined) selected.set(entry.key, value);
        }
        for (const [key, value] of pending) {
          if ((readAfter === undefined || key > readAfter) && (!page.continuation || (boundary !== undefined && key <= boundary)) && value !== undefined) {
            selected.set(key, value);
          }
        }
        const entries = [...selected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value }));
        if (entries.length >= limit || !page.continuation) {
          const result = entries.slice(0, limit), last = result.at(-1)?.key;
          const more = last !== undefined && (entries.length > limit || page.continuation !== undefined || pending.some(([key, value]) => value !== undefined && key > last));
          return { entries: result, ...(more ? { continuation: Buffer.from(JSON.stringify({ range: identity, after: last })).toString("base64url") } : {}) };
        }
        readAfter = boundary;
      }
    },
  };
}

export interface DurableProjectionSource {
  readonly checkpoint: DurableLogCheckpoint;
  readonly originCheckpoint?: DurableLogCheckpoint;
  readonly candidate?: true;
  /** Prepared dependency in this locked source. Historical reducers must use
   * their own checkpoint to select immutable position-bound rows from it. */
  readonly readPreparedProjection?: (projectionId: string) => DurableProjectionReadContext;
  /** Exact prior source reads within this reducer's verified, live log scope. */
  readonly readEnvelopeAt?: (checkpoint: DurableLogCheckpoint) => Promise<CommitEnvelope<unknown>>;
}

export type DurableProjectionReducer<Body = JsonValue> = (
  envelope: CommitEnvelope<Body>,
  current: DurableProjectionReadContext,
  source: DurableProjectionSource,
) =>
  | readonly DurableProjectionMutation[]
  | Promise<readonly DurableProjectionMutation[]>;

/** Complete source declaration, independent of a transaction's read set.
 * Omitting it conservatively consumes every stream. Families are the existing
 * parameterized WAL stream prefixes (for example run:), never arbitrary globs. */
export interface DurableProjectionInputs {
  readonly streams?: readonly string[];
  readonly families?: readonly string[];
}

export interface DurableProjectionDefinition<Body = JsonValue> {
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly reduce: DurableProjectionReducer<Body>;
  readonly inputs?: DurableProjectionInputs;
  /** 可信业务快路径须认证磁盘缓存；无密钥时只接受本实例从权威源重建的状态。 */
  readonly authenticated?: boolean;
}

export type DurableProjectionReadStep = "manifest" | "segment-open" | "segment-entry" | "directory-page";

/** Physical read bounds stay beside the format constants that determine them. */
export function durableProjectionReadBudget(step: DurableProjectionReadStep): {
  memoryReservationBytes: number; readBytes: number; ioOperations: number;
} {
  switch (step) {
    case "manifest": return { memoryReservationBytes: 4 * MAX_VALUE_BYTES, readBytes: MAX_VALUE_BYTES, ioOperations: 3 };
    case "segment-open": return { memoryReservationBytes: 0, readBytes: 0, ioOperations: 2 };
    case "directory-page": return { memoryReservationBytes: 4 * MAX_DIRECTORY_PAGE_BYTES, readBytes: MAX_DIRECTORY_PAGE_BYTES, ioOperations: 3 };
    case "segment-entry": return { memoryReservationBytes: 2 * MAX_VALUE_BYTES + SEGMENT_OFFSET_BATCH_BYTES, readBytes: MAX_VALUE_BYTES + MAX_KEY_BYTES + SEGMENT_HEADER_BYTES + SEGMENT_OFFSET_BATCH_BYTES, ioOperations: 3 };
  }
}

export interface FileDurableProjectionIndexOptions {
  readonly integrity?: AuthorityCacheIntegrity;
  readonly readOnly?: boolean;
  readonly managedRecovery?: boolean;
  readonly legacyRootDir?: string;
  readonly allowSegmentReclamation?: boolean;
  readonly withSourceLock?: <T>(operation: () => Promise<T>, abort?: AbortSignal) => Promise<T>;
  readonly runDetached?: <T>(operation: () => T) => T;
  readonly authenticated?: boolean;
  readonly rootDir: string;
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly overlayEntries?: number;
  readonly overlayBytes?: number;
  readonly clock?: () => number;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  /**
   * Governs caller-owned data reads only. Projection-owned housekeeping runs
   * outside this step so the two maintenance owners never nest capacity permits.
   */
  readonly runReadStep?: <T>(
    step: DurableProjectionReadStep,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export type DurableProjectionCheckpoints = Readonly<
  Record<string, DurableLogCheckpoint>
>;

interface StoredMutation {
  readonly key: string;
  readonly value?: JsonValue;
  /** A canonical payload already verified against its immutable source row. */
  readonly encoded?: string;
  readonly tombstone: boolean;
  readonly bytes: number;
}

interface SegmentDescriptor {
  readonly authenticated?: true;
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
  /** An abandoned base tree is expanded one page at a time after readers leave. */
  readonly tree?: DirectoryPagePointer;
}

interface ProjectionCompaction {
  readonly afterKey?: string;
}
class CompactionDirectoryBudgetFull extends Error {}
class CompactionBatchBudgetFull extends Error {}
type CompactionIoDimension = "readBytes" | "writeBytes" | "temporaryBytes" | "ioOperations";
// Local accounting only selects the publication boundary. The device permit
// remains the authority and still charges every physical effect beforehand.
const compactionStepUsage = new AsyncLocalStorage<{
  readonly limit: Record<CompactionIoDimension, number>;
  readonly used: Record<CompactionIoDimension, number>;
  guardNextRange: boolean;
}>();
const COMPACTION_RANGES_PER_STEP = 8;
const COMPACTION_DIRECTORY_BYTES = 2 * 1024 * 1024;
const COMPACTION_DIRECTORY_PAGES = 256;

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
  readonly rebuilding?: true;
  readonly recoveryTarget?: DurableProjectionCheckpoints;
  readonly unrelatedThrough?: DurableProjectionCheckpoints;
}

interface ProjectionRetirementIdentity {
  readonly manifestGeneration: number;
  readonly manifestCheckpoints: DurableProjectionCheckpoints;
  readonly retirementRoot?: string;
  readonly retirementCleanup?: string;
}

type ProjectionRetirementStepResult =
  | { readonly kind: "progressed" }
  | { readonly kind: "blocked"; readonly retryAt?: number }
  | { readonly kind: "stale" };

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
  current: DurableProjectionReadContext & Partial<Pick<RebuildableDurableProjectionIndex, "getMany">>,
): DurableProjectionReadContext & Pick<RebuildableDurableProjectionIndex, "getMany"> {
  return {
    async get(key) {
      const value = await current.get(key);
      return value === undefined
        ? undefined
        : readBoundDurableProjectionValue(key, value);
    },
    async getMany(keys) {
      const selected = validateReadKeys(keys);
      const values = current.getMany ? await current.getMany(selected) : await (async () => {
        const result: (JsonValue | undefined)[] = [];
        for (const key of selected) result.push(await current.get(key));
        return result;
      })();
      return values.map((value, index) => value === undefined ? undefined : readBoundDurableProjectionValue(selected[index]!, value));
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

/** 已核验段条目：值以核验过的规范编码保存，过大的值只记键，命中时重新读取。 */
interface VerifiedSegmentEntry {
  readonly key: string;
  readonly tombstone: boolean;
  readonly encoded?: string;
}

const SEGMENT_ENTRY_CACHE_BYTES = 4 * 1024 * 1024;
const SEGMENT_ENTRY_CACHE_ENTRIES = 16_384;
const SEGMENT_ENTRY_CACHE_VALUE_BYTES = 64 * 1024;

/** 段数据文件的身份：任何改写、替换或删除都会使其变化。 */
function segmentFileIdentity(value: BigIntStats): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}

/**
 * 段文件不可变且文件名唯一：条目首读时完成序号、校验和与规范编码核验，之后的点查与
 * 二分探测直接复用核验结果，不再为同一条目重复打开文件、准入与读盘。复用前按段核对
 * 数据文件身份，带外改写或删除即丢弃该段缓存、回到真实读取并由它发现损坏。按段整体
 * 淘汰；段文件删除或派生存储重建时失效。返回给调用方的值每次重新解析，缓存不会被改动。
 */
class SegmentEntryCache {
  readonly #segments = new Map<string, Map<number, VerifiedSegmentEntry>>();
  readonly #segmentBytes = new Map<string, number>();
  readonly #identities = new Map<string, string>();
  #bytes = 0;
  #entries = 0;

  identity(file: string): string | undefined {
    return this.#identities.get(file);
  }

  /** 登记本段条目所属的文件身份；身份变化时丢弃此前的条目。 */
  bind(file: string, identity: string): void {
    if (this.#identities.get(file) === identity) return;
    this.forget([file]);
    this.#identities.set(file, identity);
  }

  get(file: string, index: number): VerifiedSegmentEntry | undefined {
    return this.#segments.get(file)?.get(index);
  }

  put(file: string, index: number, entry: VerifiedSegmentEntry): void {
    const bytes = 64 + entry.key.length * 2 + (entry.encoded?.length ?? 0) * 2;
    if (!this.#identities.has(file) || this.#segments.get(file)?.has(index)) return;
    while (
      this.#segments.size > 0 &&
      (this.#bytes + bytes > SEGMENT_ENTRY_CACHE_BYTES || this.#entries + 1 > SEGMENT_ENTRY_CACHE_ENTRIES)
    ) {
      const oldest = this.#segments.keys().next().value!;
      if (oldest === file) break;
      this.forget([oldest]);
    }
    if (this.#bytes + bytes > SEGMENT_ENTRY_CACHE_BYTES || this.#entries + 1 > SEGMENT_ENTRY_CACHE_ENTRIES) return;
    let segment = this.#segments.get(file);
    if (!segment) {
      segment = new Map();
      this.#segments.set(file, segment);
    }
    segment.set(index, entry);
    this.#segmentBytes.set(file, (this.#segmentBytes.get(file) ?? 0) + bytes);
    this.#bytes += bytes;
    this.#entries += 1;
  }

  forget(files: Iterable<string>): void {
    for (const file of files) {
      this.#identities.delete(file);
      const segment = this.#segments.get(file);
      if (!segment) continue;
      this.#entries -= segment.size;
      this.#bytes -= this.#segmentBytes.get(file) ?? 0;
      this.#segments.delete(file);
      this.#segmentBytes.delete(file);
    }
  }

  clear(): void {
    this.#segments.clear();
    this.#segmentBytes.clear();
    this.#identities.clear();
    this.#bytes = 0;
    this.#entries = 0;
  }
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
  readonly #requiresAuthentication: boolean;
  readonly #integrity: AuthorityCacheIntegrity | undefined;
  readonly #readOnly: boolean;
  readonly #managedRecovery: boolean;
  readonly #legacyRootDir: string | undefined;
  readonly #sourceLock: FileDurableProjectionIndexOptions["withSourceLock"];
  readonly #runDetached: NonNullable<FileDurableProjectionIndexOptions["runDetached"]>;
  #allowReclamation: boolean;
  #directorySelected = false;
  #persistent: boolean;
  #rebuilding = false;
  #recoveryTarget: DurableProjectionCheckpoints | undefined;
  #unrelatedThrough: DurableProjectionCheckpoints | undefined;
  #hasPublishedManifest = false;
  #rootDir: string;
  get rootDir(): string { return this.#rootDir; }
  #authenticated: boolean | undefined;
  readonly projectionId: string;
  readonly reducerVersion: number;
  readonly #overlayEntries: number;
  readonly #overlayBytes: number;
  readonly #clock: () => number;
  #initialized = false;
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
  readonly #segmentEntries = new SegmentEntryCache();
  readonly #manifestQueue = new SerialTaskQueue();
  readonly #maintenanceRunner: StorageMaintenanceTaskRunner;
  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  readonly #runReadStep: FileDurableProjectionIndexOptions["runReadStep"];
  #retirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #retirementRetryAt: number | undefined;
  #retirementRetryRunning = false;
  #retirementRetryRequestedAt: number | undefined;
  #retirementCleanupFailure: { readonly error: unknown } | undefined;
  #maintenanceStopped = false;
  readonly #maintenanceAbort = new AbortController();
  /** 清理失败、尚待下一个写意图接管的派生文件名(相对 rootDir)。 */
  readonly #uncleared = new Set<string>();
  #writeIntent: ProjectionWriteIntent | undefined;
  #initializing: Promise<void> | undefined;
  #stagedDirectory: Map<string, { page: DirectoryPage; bytes: Buffer }> | undefined;
  #stagedDirectoryBytes = 0;

  /** Under the source writer fence, observe a publication made by another log
   * instance. Any local unflushed facts are replayed from the newly published
   * checkpoint by that source owner; they are never another authority. */
  async refreshPublishedState(): Promise<void> {
    await this.#serializeManifest(async () => undefined);
  }

  async #refreshFromDisk(): Promise<void> {
    if (!this.#initialized || !this.#manifest) return;
    if (this.#requiresAuthentication && !this.#integrity) return;
    // A read-only fallback has deliberately rejected the disk root. Re-reading
    // that same unusable root must not erase its strictly recovered memory page.
    if (this.#readOnly && !this.#hasPublishedManifest) return;
      if (this.#writeIntent) await this.#recoverWriteIntent();
      const current = this.#requireManifest();
      const published = await this.#readManifest();
      if (!published && !this.#hasPublishedManifest) return;
      if (!published || published.projectionId !== this.projectionId || published.reducerVersion !== this.reducerVersion ||
          !sameCheckpointSources(published.checkpoints, current.checkpoints) || (this.#hasPublishedManifest && published.generation < current.generation)) {
        throw projectionCorrupt("Projection publication changed identity or moved backwards");
      }
      if (this.#hasPublishedManifest && published.generation === current.generation) {
        if (canonicalize(published) !== canonicalize(current)) throw projectionCorrupt("Projection publication conflicts at the same generation");
        return;
      }
      await this.#validatePublishedStorage(published);
      this.#manifest = published;
      this.#hasPublishedManifest = true;
      this.#currentCheckpoints = cloneCheckpoints(published.checkpoints);
      this.#rebuilding = published.rebuilding === true;
      this.#recoveryTarget = published.recoveryTarget;
      this.#unrelatedThrough = published.unrelatedThrough;
      this.#active = new Map();
      this.#activeBytes = 0;
      this.#resetActiveProgress();
      this.#directoryCache.clear();
      this.#publicationSequence++;
  }

  constructor(options: FileDurableProjectionIndexOptions) {
    this.#requiresAuthentication = options.authenticated === true;
    this.#integrity = options.integrity;
    this.#readOnly = options.readOnly === true;
    this.#managedRecovery = options.managedRecovery === true;
    this.#legacyRootDir = options.legacyRootDir && path.resolve(options.legacyRootDir);
    this.#sourceLock = options.withSourceLock;
    this.#runDetached = options.runDetached ?? (operation => operation());
    this.#allowReclamation = options.allowSegmentReclamation !== false;
    this.#persistent = !this.#readOnly && (!this.#requiresAuthentication || this.#integrity !== undefined);
    assertProjectionIdentity(options.projectionId, options.reducerVersion);
    this.#rootDir = path.resolve(options.rootDir);
    this.projectionId = options.projectionId;
    this.reducerVersion = options.reducerVersion;
    this.#overlayEntries = options.overlayEntries ?? DEFAULT_OVERLAY_ENTRIES;
    this.#overlayBytes = options.overlayBytes ?? DEFAULT_OVERLAY_BYTES;
    this.#clock = options.clock ?? Date.now;
    this.#maintenanceRunner = new StorageMaintenanceTaskRunner(
      options.storageMaintenance,
    );
    this.#storageMaintenance = options.storageMaintenance;
    this.#runReadStep = options.runReadStep;
    assertPositiveInteger(this.#overlayEntries, "Projection overlay entry budget");
    assertPositiveInteger(this.#overlayBytes, "Projection overlay byte budget");
  }

  async #selectDirectory(): Promise<void> {
    if (this.#directorySelected) return;
    if (this.#legacyRootDir && this.#legacyRootDir !== this.rootDir) {
      const present = await stat(this.rootDir).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return undefined; throw error; });
      if (!present) {
        const legacy = await this.#readManifest(this.#legacyRootDir).catch((error: unknown) => {
          if (error instanceof DurableProjectionStorageError) return undefined;
          throw error;
        });
        if (legacy?.projectionId === this.projectionId && legacy.reducerVersion === this.reducerVersion) {
          this.#rootDir = this.#legacyRootDir;
          // C8 readers did not register version-directory lifetimes.
          this.#allowReclamation = false;
        }
      }
    }
    this.#directorySelected = true;
  }

  readiness(): "building" | "ready" { return this.#rebuilding ? "building" : "ready"; }
  recoveryTarget(): DurableProjectionCheckpoints | undefined { return this.#recoveryTarget && cloneCheckpoints(this.#recoveryTarget); }
  unrelatedThrough(): DurableProjectionCheckpoints { return cloneCheckpoints(this.#unrelatedThrough ?? this.#currentCheckpoints!); }
  coverRecoveryGap(checkpoints: DurableProjectionCheckpoints): void { this.#unrelatedThrough = checkpoints; this.#activePublicationCount++; }
  extendRecoveryTarget(checkpoints: DurableProjectionCheckpoints): void { this.#recoveryTarget = checkpoints; this.#unrelatedThrough = checkpoints; this.#activePublicationCount++; }
  publishedCheckpoints(): DurableProjectionCheckpoints { return cloneCheckpoints(this.#requireManifest().checkpoints); }
  publishedRecoveryCoverage(): DurableProjectionCheckpoints {
    const manifest = this.#requireManifest();
    return cloneCheckpoints(manifest.unrelatedThrough ?? manifest.checkpoints);
  }
  isPersistent(): boolean { return this.#persistent; }
  #recoveryMatches(manifest: ProjectionManifest): boolean {
    return this.#rebuilding === (manifest.rebuilding === true) &&
      sameOptionalCheckpoints(this.#recoveryTarget, manifest.recoveryTarget) &&
      sameOptionalCheckpoints(this.#unrelatedThrough, manifest.unrelatedThrough);
  }
  async finishRebuild(checkpoints?: DurableProjectionCheckpoints): Promise<void> {
    if (this.#writeIntent) await this.refreshPublishedState();
    this.#rebuilding = false;
    if (checkpoints) this.#currentCheckpoints = checkpoints;
    this.#recoveryTarget = undefined;
    this.#unrelatedThrough = undefined;
    await this.flush({ compact: false });
  }

  async initialize(
    emptyCheckpoints: DurableProjectionCheckpoints,
    recoveryTarget: DurableProjectionCheckpoints = emptyCheckpoints,
  ): Promise<void> {
    if (this.#initialized) return;
    // A detached opener can be queued on the source fence held by this caller.
    // Do the required initialization in the current fence instead of joining
    // that promise. Physical steps remain serialized and recheck the manifest.
    if (isHoldingMaintenanceExclusion()) return this.#initializeOnce(emptyCheckpoints, recoveryTarget);
    // 同一实例的并发打开共享一次初始化，不重复申请维护准入。
    this.#initializing ??= this.#initializeOnce(emptyCheckpoints, recoveryTarget)
      .finally(() => { this.#initializing = undefined; });
    return this.#initializing;
  }

  async #initializeOnce(
    emptyCheckpoints: DurableProjectionCheckpoints,
    recoveryTarget: DurableProjectionCheckpoints,
  ): Promise<void> {
    if (this.#initialized) return;
    this.#authenticated ??= this.#requiresAuthentication && this.#integrity !== undefined;
    if (this.#requiresAuthentication && !this.#integrity) {
      await this.#installEmptyManifest(emptyCheckpoints, recoveryTarget);
      this.#initialized = true;
      return;
    }
    await this.#runInitialStep("select-directory", () => this.#selectDirectory());
    if (this.#readOnly) {
      await this.#runInitialStep("readonly-open", async () => {
      const manifest = await this.#readManifest().catch((error: unknown) => {
        if (error instanceof DurableProjectionStorageError) return undefined;
        throw error;
      });
      if (manifest && manifest.projectionId === this.projectionId && manifest.reducerVersion === this.reducerVersion && sameCheckpointSources(manifest.checkpoints, emptyCheckpoints)) {
        try {
          await this.#validatePublishedStorage(manifest);
          this.#manifest = manifest; this.#hasPublishedManifest = true; this.#currentCheckpoints = cloneCheckpoints(manifest.checkpoints); this.#rebuilding = manifest.rebuilding === true;
          this.#recoveryTarget = manifest.recoveryTarget; this.#unrelatedThrough = manifest.unrelatedThrough;
        } catch (error) { if (!(error instanceof DurableProjectionStorageError)) throw error; }
      }
      if (!this.#manifest) await this.#installEmptyManifest(emptyCheckpoints, recoveryTarget);
      });
      this.#initialized = true;
      return;
    }
    const frozenInput = { emptyCheckpoints };
    await this.#runMaintenanceObligation(
      "projection-scrub",
      frozenInput,
      "committed",
      async () => {
        const admissionDeadline = Date.now() + PROJECTION_ADMISSION_DEADLINE_MS;
        let initialized = false;
        while (!initialized) {
          try {
            initialized = await this.#runMaintenanceStep(
                "projection-scrub",
                { frozenInput, step: "initialize" },
                "committed",
                () => this.#initializeStep(emptyCheckpoints, recoveryTarget),
            );
          } catch (error) {
            const retryAfterMs = maintenanceRetryDelayMs(error);
            // manifestQueue 已释放后才可等待；若调用方仍持更外层互斥区，必须
            // 把重驱交还给那个 owner，不能把等待重新藏进外层锁。
            if (
              retryAfterMs === undefined ||
              isHoldingMaintenanceExclusion() ||
              Date.now() >= admissionDeadline
            ) {
              throw error;
            }
            await waitForMaintenanceRetry(
              Math.min(
                retryAfterMs,
                Math.max(0, admissionDeadline - Date.now()),
              ),
            );
          }
        }
      },
    );
    await this.#runRetirementCleanup();
    this.#initialized = true;
  }

  async #runInitialStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + PROJECTION_ADMISSION_DEADLINE_MS;
    for (;;) {
      try { return await this.#runMaintenanceStep("projection-scrub", { step }, "committed", operation); }
      catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || Date.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, Math.max(0, deadline - Date.now())));
      }
    }
  }

  async #initializeStep(
    emptyCheckpoints: DurableProjectionCheckpoints,
    recoveryTarget: DurableProjectionCheckpoints,
  ): Promise<boolean> {
    if (this.#manifest !== undefined) return true;
    await ensureDurableDirectory(this.rootDir);
    try {
      await this.#recoverWriteIntent();
    } catch (error) {
      if (!(error instanceof DurableProjectionStorageError)) throw error;
      // A damaged recovery intent invalidates only derived state. Clearing the
      // index forces the owning authority log to rebuild it from its WAL.
      this.#writeIntent = undefined;
      await this.#installEmptyManifest(emptyCheckpoints, recoveryTarget);
      return true;
    }
    const manifest = await this.#readManifest().catch((error: unknown) => {
      if (error instanceof DurableProjectionStorageError) return undefined;
      throw error;
    });
    if (
      manifest &&
      (!this.#requiresAuthentication || this.#authenticated) &&
      manifest.projectionId === this.projectionId &&
      manifest.reducerVersion === this.reducerVersion &&
      sameCheckpointSources(manifest.checkpoints, emptyCheckpoints)
    ) {
      try {
        await this.#validatePublishedStorage(manifest);
        this.#manifest = manifest;
        this.#hasPublishedManifest = true;
        this.#currentCheckpoints = manifest.checkpoints;
        this.#rebuilding = manifest.rebuilding === true;
        this.#recoveryTarget = manifest.recoveryTarget; this.#unrelatedThrough = manifest.unrelatedThrough;
        return true;
      } catch (error) {
        if (!(error instanceof DurableProjectionStorageError)) throw error;
        this.#manifest = manifest;
        // The index is derived state. Invalid storage is replaced and rebuilt
        // from the authority log by the owning commit log.
      }
    }
    await this.#installEmptyManifest(emptyCheckpoints, recoveryTarget);
    return true;
  }

  async reset(
    emptyCheckpoints: DurableProjectionCheckpoints,
    recoveryTarget: DurableProjectionCheckpoints = emptyCheckpoints,
  ): Promise<void> {
    const frozenInput = {
      emptyCheckpoints,
      ...(this.#manifest === undefined
        ? {}
        : {
            currentGeneration: this.#manifest.generation,
            currentCheckpoints: this.#manifest.checkpoints,
          }),
    };
    await this.#runMaintenanceObligation(
      "projection-rebuild",
      frozenInput,
      "committed",
      async () => {
        let reset = false;
        while (!reset) {
          reset = await this.#runMaintenanceStep(
              "projection-rebuild",
              { frozenInput, step: "reset" },
              "committed",
              () => this.#resetStep(emptyCheckpoints, recoveryTarget),
            );
        }
      },
    );
  }

  async #resetStep(
    emptyCheckpoints: DurableProjectionCheckpoints,
    recoveryTarget: DurableProjectionCheckpoints,
  ): Promise<boolean> {
    if (this.#persistent) await ensureDurableDirectory(this.rootDir);
    await this.#installEmptyManifest(emptyCheckpoints, recoveryTarget);
    return true;
  }

  async #installEmptyManifest(
    emptyCheckpoints: DurableProjectionCheckpoints,
    recoveryTarget: DurableProjectionCheckpoints,
  ): Promise<void> {
    const checkpoints = validateCheckpoints(emptyCheckpoints);
    const old = this.#manifest;
    const generation = (old?.generation ?? 0) + 1;
    let retirementRoot = old?.retirementRoot;
    if (this.#persistent && old && (old.baseRoot || old.deltaSegments.length)) {
      if (this.#writeIntent) await this.#recoverWriteIntent();
      await this.#beginWriteIntent(generation);
      retirementRoot = await this.#prependRetirementPages(old.deltaSegments.flatMap(segment => [segment.dataFile, segment.offsetsFile]), generation, retirementRoot);
      if (old.baseRoot) retirementRoot = await this.#writeRetirementPage({
        formatVersion: 1, retiredAtGeneration: generation, files: [], tree: old.baseRoot,
        ...(retirementRoot ? { next: retirementRoot } : {}),
      });
    }
    const initial: ProjectionManifest = {
      formatVersion: INDEX_FORMAT_VERSION,
      projectionId: this.projectionId,
      reducerVersion: this.reducerVersion,
      generation,
      checkpoints,
      deltaSegments: [],
      ...(retirementRoot ? { retirementRoot } : {}),
      ...(old?.retirementCleanup ? { retirementCleanup: old.retirementCleanup } : {}),
      ...(this.#managedRecovery ? { rebuilding: true as const, recoveryTarget: cloneCheckpoints(recoveryTarget), unrelatedThrough: cloneCheckpoints(recoveryTarget) } : {}),
    };
    if (this.#persistent) {
      if (this.#writeIntent) await this.#finalizeWriteIntent(initial, []);
      await this.#writeManifest(initial);
    }
    this.#rebuilding = initial.rebuilding === true;
    this.#recoveryTarget = initial.recoveryTarget; this.#unrelatedThrough = initial.unrelatedThrough;
    this.#manifest = initial;
    this.#hasPublishedManifest = this.#persistent;
    this.#active = new Map();
    this.#activeBytes = 0;
    this.#resetActiveProgress();
    this.#currentCheckpoints = checkpoints;
    // A reset discards corrupt snapshots, but active physical reads retain their
    // separate in-use protection until the owning operation leaves its fence.
    this.#readViews.clear();
    this.#directoryCache.clear();
    this.#retirementCleanupFailure = undefined;
    this.#clearRetirementRetry();
    this.#publicationSequence += 1;
    if (this.#persistent && this.#writeIntent) await this.#completeWriteIntent(true).catch(() => undefined);
  }

  checkpoints(): DurableProjectionCheckpoints {
    const checkpoints = this.#currentCheckpoints;
    if (!checkpoints) {
      throw new Error("Durable projection index is not initialized");
    }
    return cloneCheckpoints(checkpoints);
  }

  releaseContinuation(encoded: string): void {
    const { viewId } = decodeContinuation(encoded);
    if (!this.#inUseReadViews.has(viewId)) this.#readViews.delete(viewId);
  }

  async prepare(
    mutations: readonly DurableProjectionMutation[],
  ): Promise<PreparedProjectionDelta> {
    if (this.#writeIntent) await this.refreshPublishedState();
    if (!this.#manifest || !this.#currentCheckpoints) {
      throw new Error("Durable projection index is not initialized");
    }
    const normalized = normalizeMutations(mutations);
    let incomingBytes = 0;
    for (const mutation of normalized.values()) incomingBytes += mutation.bytes;
    if (
      this.#persistent && this.#hasUnpersistedProgress() &&
      (
        this.#activeMutationCount + mutations.length > this.#overlayEntries ||
        this.#activeMutationBytes + incomingBytes > this.#overlayBytes ||
        this.#activePublicationCount + 1 > this.#overlayEntries
      )
    ) {
      // 覆盖层已装不下本次 delta,当前权威写必须等这次 flush 完成才能继续:
      // 阻塞关系内在固定为前台,与谁触发这次写无关。
      await runInMaintenanceContext("foreground", () => this.#runFlush("pre-commit"));
    }
    // Most envelopes do not touch this projection. Published overlays are
    // immutable; only a real mutation needs a new key table.
    const changedActive = normalized.size > 0 ? new Map(this.#active) : undefined;
    const nextActive = changedActive ?? this.#active;
    let nextBytes = this.#activeBytes;
    for (const [key, mutation] of normalized) {
      nextBytes -= nextActive.get(key)?.bytes ?? 0;
      changedActive!.set(key, mutation);
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

  /** Caller has proved, under the source writer fence, that the intervening
   * source range contains no input for this projection. This creates no replay
   * empty mutation batch. After a crash the owner replays from the published
   * checkpoint through the existing verified WAL path. */
  coverUnchangedSource(checkpoints: DurableProjectionCheckpoints): void {
    this.#currentCheckpoints = checkpoints;
    this.#publicationSequence += 1;
  }

  async get(key: string): Promise<JsonValue | undefined> {
    assertKey(key);
    this.#expireReadViews();
    await this.#runRetirementCleanup();
    const view = this.#captureReadView();
    this.#retainReadView(view);
    try {
      const active = view.active.get(key);
      if (active) return active.tombstone ? undefined : active.value;
      for (const segment of view.deltaSegments) {
        if (key < segment.minKey || key > segment.maxKey) continue;
        const reader = await SegmentReader.open(this.rootDir, segment, this.#runReadStep, this.#segmentEntries, this.#integrity);
        try {
          const entry = await reader.get(key);
          if (entry) return entry.tombstone ? undefined : entry.value;
        } finally {
          await reader.close();
        }
      }
      const base = await this.#baseSegmentForKey(view.baseRoot, key);
      if (base && key >= base.minKey && key <= base.maxKey) {
        const reader = await SegmentReader.open(this.rootDir, base, this.#runReadStep, this.#segmentEntries, this.#integrity);
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
      await this.#runRetirementCleanup();
    }
  }

  /** One retained view and one reader at a time; nothing survives this batch. */
  async getMany(keys: readonly string[]): Promise<readonly (JsonValue | undefined)[]> {
    const selected = validateReadKeys(keys);
    if (!selected.length) return [];
    this.#expireReadViews();
    await this.#runRetirementCleanup();
    const view = this.#captureReadView();
    this.#retainReadView(view);
    try {
      const pending = new Set(selected);
      const values = new Map<string, JsonValue | undefined>();
      for (const key of pending) {
        const active = view.active.get(key);
        if (active) { values.set(key, active.tombstone ? undefined : active.value); pending.delete(key); }
      }
      const read = async (segment: SegmentDescriptor, candidates: readonly string[]) => {
        if (!candidates.length) return;
        const reader = await SegmentReader.open(this.rootDir, segment, this.#runReadStep, this.#segmentEntries, this.#integrity);
        try {
          for (const [key, entry] of await reader.getMany(candidates)) {
            values.set(key, entry.tombstone ? undefined : entry.value); pending.delete(key);
          }
        } finally { await reader.close(); }
      };
      for (const segment of view.deltaSegments) {
        await read(segment, [...pending].filter(key => key >= segment.minKey && key <= segment.maxKey));
        if (!pending.size) break;
      }
      const bases = new Map<string, { segment: SegmentDescriptor; keys: string[] }>();
      for (const key of pending) {
        const segment = await this.#baseSegmentForKey(view.baseRoot, key);
        if (!segment || key < segment.minKey || key > segment.maxKey) continue;
        const group = bases.get(segment.id) ?? { segment, keys: [] };
        group.keys.push(key); bases.set(segment.id, group);
      }
      for (const { segment, keys } of bases.values()) await read(segment, keys);
      return selected.map(key => values.get(key));
    } finally {
      this.#releaseReadView(view);
      await this.#runRetirementCleanup();
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
      const entries = await this.#scanView(
        view,
        normalizedRange,
        limit,
        after,
      );
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
      await this.#runRetirementCleanup();
    }
  }

  async flush(options: { readonly compact?: boolean } = {}): Promise<void> {
    if (!this.#persistent) return;
    if (this.#writeIntent) await this.refreshPublishedState();
    // 紧急度继承调用语境,不在这里声明:前台请求触发的提交按前台准入,
    // 启动恢复触发的按恢复,周期回收触发的才是后台。
    await this.#runFlush("committed", options.compact !== false);
  }

  async flushCheckpoint(): Promise<void> {
    if (!this.#persistent) return;
    if (this.#writeIntent) await this.refreshPublishedState();
    await this.#runFlush("committed", false, true);
  }

  /** 进程停机时取消尚未跨过安全检查点的投影维护义务。 */
  async stopStorageMaintenance(): Promise<void> {
    this.#maintenanceStopped = true;
    this.#maintenanceAbort.abort(new StorageMaintenanceCancelledError());
    this.#clearRetirementRetry();
    await this.#maintenanceRunner.stop();
    await this.#initializing?.catch(() => undefined);
    await this.#manifestQueue.run(async () => undefined);
  }

  async #runFlush(obligation: StorageMaintenanceObligation, compact = true, checkpointOnly = false): Promise<void> {
    await this.#runRetirementCleanup();
    for (;;) {
      const manifest = this.#requireManifest();
      // 退出/启动检查点不承担与历史规模成正比的合并；未落盘覆盖层由权威尾部恢复。
      if (checkpointOnly && manifest.compaction && this.#active.size > 0) {
        await this.#consolidateSmallDelta(obligation);
        return;
      }
      if (obligation === 'pre-commit' && manifest.deltaSegments.length === MAX_DELTA_SEGMENTS && this.#active.size > 0 &&
          await this.#consolidateSmallDelta(obligation)) continue;
      // A recovery checkpoint need not finish a compaction whose durable
      // manifest already makes all values readable. A new delta must still
      // preserve the existing five-segment read bound.
      if (!compact && this.#active.size === 0 && sameCheckpoints(this.checkpoints(), manifest.checkpoints) && this.#recoveryMatches(manifest)) {
        this.#resetActiveProgress(); return;
      }
      if (manifest.compaction && (compact || this.#active.size > 0)) {
        if ((!compact || obligation === 'pre-commit') && await this.#consolidateSmallDelta(obligation)) continue;
        const frozenInput = {
          checkpoints: manifest.checkpoints,
          deltaSegments: manifest.deltaSegments.map(({ id }) => id),
        };
        await this.#runMaintenanceObligation(
          "projection-compaction",
          frozenInput,
          obligation,
          async () => {
            let staged = true;
            while (this.#requireManifest().compaction) {
              const stepManifest = this.#requireManifest();
              const previousGeneration = stepManifest.generation;
              try {
                await this.#runMaintenanceStep(
                  "projection-compaction",
                  {
                    frozenInput,
                    generation: stepManifest.generation,
                    ...(stepManifest.compaction?.afterKey === undefined
                      ? {}
                      : { afterKey: stepManifest.compaction.afterKey }),
                  },
                  obligation,
                  () => this.#compactRanges(staged),
                );
              } catch (error) {
                if (!(error instanceof CompactionDirectoryBudgetFull) || !staged) throw error;
                // Rollback has completed. The single-range fallback must get a
                // fresh permit, never reuse capacity spent on the failed batch.
                staged = false;
                continue;
              }
              if (this.#requireManifest().generation <= previousGeneration) {
                throw new Error("Projection compaction made no durable progress");
              }
              // Retirement debt has one stable owner independent of whichever
              // compaction produced it. The owner layer holds no permit, so
              // joining it here preserves both ownership and leaf-step locking.
              await this.#runRetirementCleanup();
            }
          },
        );
        await this.#runRetirementCleanup();
        continue;
      }
      if (
        this.#active.size === 0 &&
        sameCheckpoints(this.checkpoints(), manifest.checkpoints) && this.#recoveryMatches(manifest)
      ) {
        this.#resetActiveProgress();
        return;
      }
      const frozenInput = {
        manifestGeneration: manifest.generation,
        manifestCheckpoints: manifest.checkpoints,
        ...(this.#currentCheckpoints === undefined
          ? {}
          : { targetCheckpoints: this.#currentCheckpoints }),
      };
      await this.#runMaintenanceObligation(
        "projection-flush",
        frozenInput,
        obligation,
        () =>
          this.#runMaintenanceStep(
              "projection-flush",
              {
                frozenInput,
                activeEntries: this.#active.size,
                activeBytes: this.#activeBytes,
              },
              obligation,
              () => this.#flushActive(),
            ),
      );
      await this.#runRetirementCleanup();
    }
  }

  /** Checkpoint count alone must not force a rewrite of scattered history.
   * A bounded tail can become fewer immutable deltas without touching the base.
   * Larger inputs retain the ordinary, paged base-compaction path. */
  async #consolidateSmallDelta(obligation: StorageMaintenanceObligation): Promise<boolean> {
    const manifest = this.#requireManifest();
    // Preserve initial paged-base construction. This optimization avoids
    // rewriting an existing historical base; it does not replace that base.
    if (!manifest.baseRoot) return false;
    const entryLimit = Math.min(this.#overlayEntries, DEFAULT_OVERLAY_ENTRIES);
    const byteLimit = Math.min(this.#overlayBytes, DEFAULT_OVERLAY_BYTES);
    // Keep headroom for subsequent checkpoints instead of repeatedly rewriting
    // a nearly full delta window. Dense tails retain leveled compaction.
    const packedLimit = Math.floor(MAX_DELTA_SEGMENTS / 2);
    if (this.#active.size > entryLimit || manifest.deltaSegments.some(segment => segment.count > entryLimit) ||
        this.#activeBytes > byteLimit) return false;
    const input = { phase: 'bounded-delta-consolidation', generation: manifest.generation, checkpoints: this.checkpoints() };
    return this.#runMaintenanceObligation('projection-flush', input, obligation, () =>
      this.#runMaintenanceStep('projection-flush', input, obligation, async () => {
        const current = this.#requireManifest();
        if ((!current.compaction && current.deltaSegments.length !== MAX_DELTA_SEGMENTS) || this.#active.size > entryLimit ||
            current.deltaSegments.some(segment => segment.count > entryLimit)) return false;
        let bytes = 0;
        for (const segment of current.deltaSegments) {
          claimStorageIo('ioOperations', 1);
          const metadata = await stat(path.join(this.rootDir, segment.dataFile)).catch((error: unknown) => {
            if (isNodeError(error, 'ENOENT')) throw projectionCorrupt('Projection segment data file is missing', error);
            throw error;
          });
          bytes += metadata.size;
          if (bytes > byteLimit * (MAX_DELTA_SEGMENTS + 1)) return false;
        }
        const merged = new Map<string, StoredMutation>();
        for (const segment of [...current.deltaSegments].reverse()) {
          for (const entry of await this.#readSegment(segment)) merged.set(entry.key, entry);
          if (merged.size > entryLimit * packedLimit) return false;
        }
        for (const [key, value] of this.#active) merged.set(key, value);
        const batches: StoredMutation[][] = [];
        let batch: StoredMutation[] = [], batchBytes = 0;
        for (const entry of [...merged.values()].sort((a, b) => compareKeys(a.key, b.key))) {
          if (entry.bytes > byteLimit) return false;
          if (batch.length && (batch.length >= entryLimit || batchBytes + entry.bytes > byteLimit)) {
            batches.push(batch); batch = []; batchBytes = 0;
          }
          batch.push(entry); batchBytes += entry.bytes;
          if (batches.length >= packedLimit) return false;
        }
        if (batch.length) batches.push(batch);
        await this.#flushActive(batches);
        return true;
      }));
  }

  #runMaintenanceObligation<T>(
    kind: StorageMaintenanceKind,
    inputIdentity: unknown,
    obligation: StorageMaintenanceObligation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const resourceId = `${this.projectionId}:${this.rootDir}`;
    const request = storageMaintenanceObligation(
        kind,
        resourceId,
        inputIdentity,
        { owner: "durable-projection-index", obligation },
      );
    // A source owner may have to meet a hard checkpoint before its write.
    // The detached owner is still queued on that fence: satisfy the same
    // derived work synchronously, using the usual fenced/charged leaf steps.
    // Its later turn rechecks the manifest and observes the completed progress.
    if (isHoldingMaintenanceExclusion() && this.#maintenanceRunner.hasPending(request.workKey)) return operation();
    return this.#maintenanceRunner.run(
      request,
      currentMaintenanceAbortSignal(),
      operation,
    );
  }

  #runMaintenanceStep<T>(
    kind: StorageMaintenanceKind,
    inputIdentity: unknown,
    obligation: StorageMaintenanceObligation,
    operation: () => Promise<T>,
    maxWaitMs?: number,
  ): Promise<T> {
    const resourceId = `${this.projectionId}:${this.rootDir}`;
    // Acquire the source fence and manifest queue before reserving capacity.
    // A background permit waiting for the source owner can otherwise consume
    // the very slot/quantum that owner needs to finish and release its fence.
    return this.#serializeManifest(() => {
      const request = storageMaintenanceRequest(
        kind, resourceId, inputIdentity,
        { obligation, ...(maxWaitMs === undefined ? {} : { maxWaitMs }) },
      );
      return runStorageMaintenanceStep(
        this.#storageMaintenance,
        request,
        async () => {
          const run = async () => {
            if (kind !== "projection-rebuild") await this.#refreshFromDisk();
            return operation();
          };
          if (kind !== "projection-compaction") return run();
          return compactionStepUsage.run({
            limit: { ...request.atomic.quantum, temporaryBytes: request.atomic.occupancy.temporaryBytes },
            used: { readBytes: 0, writeBytes: 0, temporaryBytes: 0, ioOperations: 0 },
            guardNextRange: false,
          }, run);
        },
      );
    }, false);
  }

  #serializeManifest<T>(operation: () => Promise<T>, refresh = true): Promise<T> {
    const abort = AbortSignal.any([currentMaintenanceAbortSignal(), this.#maintenanceAbort.signal]);
    const run = () => this.#manifestQueue.run(async () => {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      if (refresh) await this.#refreshFromDisk();
      return operation();
    }, abort);
    return this.#sourceLock ? this.#sourceLock(run, abort) : run();
  }

  #readStep<T>(
    inputIdentity: DurableProjectionReadStep,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runProjectionReadStep(this.#runReadStep, inputIdentity, operation);
  }

  async #runRetirementCleanup(
    options: {
      readonly drain?: boolean;
      readonly surfaceFailure?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.#persistent || !this.#allowReclamation) return;
    if (this.#retirementCleanupFailure?.error instanceof DurableProjectionStorageError) return;
    if (
      options.surfaceFailure !== false &&
      this.#retirementCleanupFailure !== undefined
    ) {
      const failure = this.#retirementCleanupFailure;
      this.#retirementCleanupFailure = undefined;
      throw failure.error;
    }
    // Retired files are already durably queued and no longer publish values.
    // Do not repeatedly reclaim them under a caller's source/owner exclusion
    // (a single append may perform hundreds of indexed reads). The existing
    // bounded background owner acquires the source fence for its own steps.
    if (!options.drain && isHoldingMaintenanceExclusion()) {
      if (this.#retirementIdentity()) this.#scheduleRetirementRetry(this.#clock() + RETIREMENT_CONTINUATION_DELAY_MS);
      return;
    }
    try { await this.#runMaintenanceObligation(
      "projection-compaction",
      { phase: "retirement-cleanup" },
      "committed",
      () =>
        this.#drainRetirementDebt(
          (inputIdentity, operation) =>
            this.#runMaintenanceStep(
                "projection-compaction",
                inputIdentity,
                "committed",
                operation,
                0,
            ),
          options.drain ? undefined : MAX_RETIREMENT_TRANSITIONS_PER_TRIGGER,
        ),
    ); } catch (error) {
      if (!(error instanceof DurableProjectionStorageError)) throw error;
      this.#retirementCleanupFailure = { error };
      this.#clearRetirementRetry();
    }
  }

  async #drainRetirementDebt(
    transition: (
      inputIdentity: unknown,
      operation: () => Promise<ProjectionRetirementStepResult>,
    ) => Promise<ProjectionRetirementStepResult>,
    maxTransitions: number | undefined,
  ): Promise<void> {
    let transitions = 0;
    for (;;) {
      const frozenInput = this.#retirementIdentity();
      if (!frozenInput) {
        this.#retirementCleanupFailure = undefined;
        this.#clearRetirementRetry();
        return;
      }
      if (
        maxTransitions !== undefined &&
        transitions >= maxTransitions
      ) {
        // A caller pays only a fixed amount of housekeeping. The durable
        // manifest remains the retry credential and the background pump owns
        // the rest, so foreground latency never grows with historical debt.
        this.#scheduleRetirementRetry(
          this.#clock() + RETIREMENT_CONTINUATION_DELAY_MS,
        );
        return;
      }
      const inputIdentity = {
        phase: "retirement-cleanup-step",
        ...frozenInput,
      };
      let result: ProjectionRetirementStepResult;
      try {
        result = await transition(
          inputIdentity,
          () => this.#drainRetirementStep(frozenInput),
        );
      } catch (error) {
        // The manifest is the durable retry credential. Temporary pressure
        // pauses at this safe boundary; another trigger resumes from it.
        const retryDelayMs = maintenanceRetryDelayMs(error);
        if (retryDelayMs !== undefined) {
          this.#scheduleRetirementRetry(
            this.#clock() + Math.max(1, retryDelayMs),
          );
          return;
        }
        throw error;
      }
      if (result.kind === "blocked") {
        if (result.retryAt !== undefined) {
          this.#scheduleRetirementRetry(result.retryAt);
        }
        return;
      }
      if (result.kind === "progressed") transitions += 1;
      // "stale" means another serialized manifest writer advanced the
      // transition first; re-read without charging the bounded work budget.
    }
  }

  #scheduleRetirementRetry(retryAt: number): void {
    // A recovery page may release thousands of read views while holding its
    // source fence. Keep one detached waiter until it actually finishes; a
    // timer firing is not completion. Otherwise every read adds another abort
    // listener to the same blocked obligation (quadratic registration work).
    if (this.#retirementRetryRunning) {
      this.#retirementRetryRequestedAt = Math.min(this.#retirementRetryRequestedAt ?? retryAt, retryAt);
      return;
    }
    if (
      this.#maintenanceStopped ||
      (
        this.#retirementRetryTimer !== undefined &&
        this.#retirementRetryAt !== undefined &&
        this.#retirementRetryAt <= retryAt
      )
    ) {
      return;
    }
    this.#clearRetirementRetry();
    const delayMs = Math.max(
      1,
      Math.min(2_147_483_647, retryAt - this.#clock()),
    );
    const timer = setTimeout(() => {
      if (this.#retirementRetryTimer !== timer) return;
      this.#retirementRetryTimer = undefined;
      this.#retirementRetryAt = undefined;
      this.#retirementRetryRunning = true;
      let failed = false;
      void this.#runDetached(() => runDetachedMaintenanceContext("background", () =>
        this.#runRetirementCleanup({ surfaceFailure: false })
      )).catch((error: unknown) => {
        failed = true;
        if (!this.#maintenanceStopped) this.#retirementCleanupFailure = { error };
      }).finally(() => {
        this.#retirementRetryRunning = false;
        const next = this.#retirementRetryRequestedAt;
        this.#retirementRetryRequestedAt = undefined;
        if (!failed && !(this.#retirementCleanupFailure?.error instanceof DurableProjectionStorageError) &&
            next !== undefined && this.#retirementIdentity()) this.#scheduleRetirementRetry(next);
      });
    }, delayMs);
    timer.unref();
    this.#retirementRetryTimer = timer;
    this.#retirementRetryAt = retryAt;
  }

  #clearRetirementRetry(): void {
    this.#retirementRetryRequestedAt = undefined;
    if (this.#retirementRetryTimer !== undefined) {
      clearTimeout(this.#retirementRetryTimer);
    }
    this.#retirementRetryTimer = undefined;
    this.#retirementRetryAt = undefined;
  }

  async #flushActive(consolidated?: readonly (readonly StoredMutation[])[]): Promise<void> {
    if (this.#writeIntent) {
      await this.#completeWriteIntent(
        isCommittedIntent(this.#writeIntent, this.#requireManifest()),
      );
    }
    const manifest = this.#requireManifest();
    const checkpoints = this.checkpoints();
    if (
      !consolidated && this.#active.size === 0 &&
      sameCheckpoints(checkpoints, manifest.checkpoints) && this.#recoveryMatches(manifest)
    ) {
      this.#resetActiveProgress();
      return;
    }
    if (!consolidated && this.#active.size === 0) {
      // Only the verified cursor/readiness changes. All referenced files are
      // unchanged, so the atomic manifest is the complete publication: there
      // are no new files for a separate write intent to protect or reclaim.
      const { rebuilding: _rebuilding, recoveryTarget: _target, unrelatedThrough: _coverage, ...existing } = manifest;
      const next: ProjectionManifest = {
        ...existing, generation: manifest.generation + 1, checkpoints,
        ...(this.#rebuilding ? { rebuilding: true as const, recoveryTarget: this.#recoveryTarget!, unrelatedThrough: this.#unrelatedThrough! } : {}),
      };
      await this.#writeManifest(next);
      this.#manifest = next;
      this.#hasPublishedManifest = true;
      this.#resetActiveProgress();
      this.#publicationSequence++;
      return;
    }
    await this.#beginWriteIntent(manifest.generation + 1);
    let committed = false;
    try {
      let deltaSegments = [...manifest.deltaSegments];
      let baseRoot = manifest.baseRoot;
      const obsoleteFiles = new Set<string>();
      if (consolidated) {
        for (const segment of deltaSegments) {
          obsoleteFiles.add(segment.dataFile);
          obsoleteFiles.add(segment.offsetsFile);
        }
        deltaSegments = [];
      }
      if (consolidated) {
        // These sorted ranges are disjoint, so their relative precedence is
        // immaterial. Tombstones remain in the tail and still mask the base.
        for (const entries of consolidated) deltaSegments.push(await this.#writeSortedEntries(entries, 0));
      } else if (this.#active.size > 0) {
        const newest = await this.#writeSegment(
          [...this.#active.values()],
          0,
        );
        deltaSegments = [newest, ...deltaSegments];
      }
      const compaction = consolidated ? undefined : manifest.compaction ??
        (deltaSegments.length > MAX_DELTA_SEGMENTS ? {} : undefined);
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
        ...(this.#rebuilding ? { rebuilding: true as const, recoveryTarget: this.#recoveryTarget!, unrelatedThrough: this.#unrelatedThrough! } : {}),
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
        const outcome = await this.#publicationOutcome();
        if (outcome?.committed) {
          try { await syncDirectory(this.rootDir); } catch { throw error; }
          this.#manifest = outcome.manifest;
          this.#currentCheckpoints = cloneCheckpoints(outcome.manifest.checkpoints);
          this.#active = new Map(); this.#activeBytes = 0; this.#resetActiveProgress();
          this.#publicationSequence++;
          committed = true;
        } else {
          if (outcome) await this.#completeWriteIntent(false);
          // An unreadable outcome keeps its intent and files for recovery.
          throw error;
        }
      }
    }
    if (committed) {
      // The manifest replacement is the projection publication point.
      // Housekeeping remains recoverable from the durable intent and must
      // never turn a successful publication into a false failure.
      await this.#completeWriteIntent(true).catch(() => undefined);
    } else {
      throw new Error("Projection flush did not publish a manifest");
    }
  }

  #hasUnpersistedProgress(): boolean {
    return (
      this.#activePublicationCount > 0 ||
      !this.#recoveryMatches(this.#requireManifest()) ||
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
      const reader = await SegmentReader.open(this.rootDir, descriptor, this.#runReadStep, this.#segmentEntries, this.#integrity);
      try {
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
      } catch (error) {
        // Until the cursor is returned, this reader has no outer owner.
        await reader.close().catch(() => undefined);
        throw error;
      }
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
    if (this.#retirementIdentity()) {
      // Releasing the last user is the ownership event that unblocks retired
      // files. Register an independent wakeup before caller cleanup: the
      // caller may already be cancelled, but committed debt must still resume.
      this.#scheduleRetirementRetry(
        this.#clock() + RETIREMENT_CONTINUATION_DELAY_MS,
      );
    }
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
    const dataBatch: Buffer[] = [];
    const offsetBatch: Buffer[] = [];
    let batchBytes = 0;
    const writeBatch = async () => {
      if (dataBatch.length === 0) return;
      claimStorageIo("ioOperations", 2);
      await offsets.writeFile(Buffer.concat(offsetBatch));
      await data.writeFile(dataBatch.length === 1 ? dataBatch[0]! : Buffer.concat(dataBatch, batchBytes));
      dataBatch.length = 0;
      offsetBatch.length = 0;
      batchBytes = 0;
    };
    try {
      for await (const entry of entries) {
        if (
          previousKey !== undefined &&
          compareKeys(previousKey, entry.key) >= 0
        ) {
          throw new TypeError("Projection segment entries are not strictly ordered");
        }
        const encoded = encodeSegmentEntry(entry, count, dataFile, this.#authenticated === true, this.#integrity);
        const offset = Buffer.allocUnsafe(8);
        offset.writeBigUInt64BE(BigInt(position));
        claimStorageIo("writeBytes", offset.byteLength + encoded.byteLength);
        claimStorageIo("temporaryBytes", offset.byteLength + encoded.byteLength);
        // Bound small-record batching; one oversized record follows the same
        // direct write path and does not require a second payload allocation.
        if (dataBatch.length && batchBytes + encoded.byteLength > SEGMENT_IO_BATCH_BYTES) await writeBatch();
        dataBatch.push(encoded);
        offsetBatch.push(offset);
        batchBytes += encoded.byteLength;
        if (batchBytes >= SEGMENT_IO_BATCH_BYTES || dataBatch.length >= SEGMENT_IO_BATCH_ENTRIES) await writeBatch();
        position += encoded.byteLength;
        count += 1;
        minKey ??= entry.key;
        maxKey = entry.key;
        previousKey = entry.key;
      }
      if (count === 0 || minKey === undefined || maxKey === undefined) {
        throw new TypeError("Cannot write an empty projection segment");
      }
      await writeBatch();
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
    return { id, dataFile, offsetsFile, count, minKey, maxKey, level,
      ...(this.#authenticated ? { authenticated: true as const } : {}) };
  }

  async #compactRanges(staged: boolean): Promise<void> {
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
      this.#stagedDirectory = staged ? new Map() : undefined;
      this.#stagedDirectoryBytes = 0;
      let baseRoot = manifest.baseRoot;
      let deltaSegments = manifest.deltaSegments;
      let compaction: ProjectionCompaction | undefined = manifest.compaction;
      const obsoleteFiles = new Set<string>();

      for (let range = 0; range < (staged ? COMPACTION_RANGES_PER_STEP : 1); range++) {
        const priorRoot = baseRoot;
        const priorCompaction = compaction;
        const priorObsolete = new Set(obsoleteFiles);
        const createdBefore = this.#requireWriteIntent().createdFiles.length;
        const usage = compactionStepUsage.getStore();
        // The first range keeps the original single-range contract. Before
        // another range consumes the remaining permit, reserve a quarter for
        // publishing the completed prefix and cleaning this intent.
        if (usage) usage.guardNextRange = range > 0;
        try {
          const batch = await this.#nextCompactionBatch({ ...manifest, baseRoot, deltaSegments, compaction });
          if (!batch) {
            deltaSegments = [];
            compaction = undefined;
            for (const segment of manifest.deltaSegments) {
              obsoleteFiles.add(segment.dataFile);
              obsoleteFiles.add(segment.offsetsFile);
            }
            break;
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
              // Most updates retain the range's first key. Replace its descriptor
              // directly; deleting and reinserting it rebuilds unchanged branches
              // and creates extra write intents, directory syncs and retirement debt.
              if (replacements[0]?.minKey !== batch.base.minKey) {
                baseRoot = await this.#deleteDirectoryDescriptor(
                  baseRoot,
                  batch.base.minKey,
                  obsoletePages,
                );
              }
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
        } catch (error) {
          if (range === 0 || !(error instanceof CompactionBatchBudgetFull || error instanceof CompactionDirectoryBudgetFull)) throw error;
          baseRoot = priorRoot;
          compaction = priorCompaction;
          obsoleteFiles.clear();
          for (const file of priorObsolete) obsoleteFiles.add(file);
          // A partially written next range is never referenced by this root.
          // Its planned files remain owned by this intent until cleanup.
          for (const file of this.#requireWriteIntent().createdFiles.slice(createdBefore)) obsoleteFiles.add(file);
          break;
        } finally { if (usage) usage.guardNextRange = false; }
      }

      if (this.#stagedDirectory) {
        // Intermediate path copies were never published or written. Only the
        // final reachable directory pages enter the original durable intent.
        for (const id of this.#stagedDirectory.keys()) obsoleteFiles.delete(directoryPageFile(id));
        const reachable = new Map<string, { page: DirectoryPage; bytes: Buffer }>();
        const visit = (pointer?: DirectoryPagePointer): void => {
          if (!pointer || reachable.has(pointer.id)) return;
          const item = this.#stagedDirectory!.get(pointer.id);
          if (!item) return;
          visit(item.page.left); visit(item.page.right); reachable.set(pointer.id, item);
        };
        visit(baseRoot);
        await this.#planCreatedFiles([...reachable.keys()].map(directoryPageFile));
        for (const [id, item] of reachable) await this.#persistDirectoryPage(id, item.page, item.bytes, true);
        if (reachable.size) { claimStorageIo("ioOperations", 1); await syncDirectory(this.rootDir); }
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
        ...(manifest.rebuilding ? { rebuilding: true as const, recoveryTarget: manifest.recoveryTarget!, unrelatedThrough: manifest.unrelatedThrough! } : {}),
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
        const outcome = await this.#publicationOutcome();
        if (outcome?.committed) {
          try { await syncDirectory(this.rootDir); } catch { throw error; }
          this.#manifest = outcome.manifest;
          this.#publicationSequence++;
          committed = true;
        } else {
          if (outcome) await this.#completeWriteIntent(false);
          throw error;
        }
      }
    } finally { this.#stagedDirectory = undefined; this.#stagedDirectoryBytes = 0; }
    if (!committed) {
      throw new Error("Projection compaction did not publish a manifest");
    }
    await this.#completeWriteIntent(true).catch(() => undefined);
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
      // Descriptor ranges are already bound by the manifest. Completed ranges
      // need no reader, and an untouched segment already names its first key.
      if (afterKey !== undefined && delta.maxKey <= afterKey) continue;
      if (afterKey === undefined || afterKey < delta.minKey) {
        if (firstKey === undefined || delta.minKey < firstKey) firstKey = delta.minKey;
        continue;
      }
      const reader = await SegmentReader.open(this.rootDir, delta, this.#runReadStep, this.#segmentEntries, this.#integrity);
      try {
        let index = afterKey === undefined || afterKey < delta.minKey
          ? 0
          : await reader.lowerBound(afterKey);
        let entry = await reader.storedEntry(index);
        if (entry?.key === afterKey) entry = await reader.storedEntry(++index);
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
      if ((afterKey !== undefined && delta.maxKey <= afterKey) ||
          (upperBound !== undefined && delta.minKey >= upperBound)) continue;
      const reader = await SegmentReader.open(this.rootDir, delta, this.#runReadStep, this.#segmentEntries, this.#integrity);
      try {
        let index = afterKey === undefined || afterKey < delta.minKey
          ? 0
          : await reader.lowerBound(afterKey);
        let entry = await reader.storedEntry(index);
        if (entry?.key === afterKey) entry = await reader.storedEntry(++index);
        while (entry && (upperBound === undefined || entry.key < upperBound)) {
          latest.set(entry.key, entry);
          entry = await reader.storedEntry(++index);
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
    const reader = await SegmentReader.open(this.rootDir, descriptor, this.#runReadStep, this.#segmentEntries, this.#integrity);
    try {
      const entries: StoredMutation[] = [];
      for (let index = 0; index < descriptor.count; index += 1) {
        const entry = await reader.storedEntry(index);
        if (!entry) {
          throw projectionCorrupt("Projection segment ended before its count");
        }
        entries.push(entry);
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
    const staged = this.#stagedDirectory?.get(pointer.id);
    if (staged) return staged.page;
    const cached = this.#directoryCache.get(pointer.id);
    if (cached) {
      this.#cacheDirectoryPage(pointer.id, cached);
      return cached;
    }
    return this.#readStep("directory-page", () => this.#readDirectoryPage(pointer));
  }

  async #readDirectoryPage(pointer: DirectoryPagePointer): Promise<DirectoryPage> {
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
    const encoded = Buffer.from(canonicalize(page), "utf8");
    if (this.#stagedDirectory) {
      if (this.#stagedDirectory.size >= COMPACTION_DIRECTORY_PAGES ||
          this.#stagedDirectoryBytes + encoded.byteLength > COMPACTION_DIRECTORY_BYTES) {
        throw new CompactionDirectoryBudgetFull();
      }
      this.#stagedDirectory.set(pointer.id, { page, bytes: encoded });
      this.#stagedDirectoryBytes += encoded.byteLength;
      return pointer;
    }
    await this.#persistDirectoryPage(pointer.id, page, encoded);
    return pointer;
  }

  async #persistDirectoryPage(id: string, page: DirectoryPage, encoded: Buffer, planned = false): Promise<void> {
    const file = directoryPageFile(id);
    if (!planned) await this.#planCreatedFiles([file]);
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
    this.#cacheDirectoryPage(id, page);
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

  async #readManifest(directory = this.rootDir): Promise<ProjectionManifest | undefined> {
    return this.#readStep("manifest", () => this.#readManifestBytes(directory));
  }

  async #readManifestBytes(directory: string): Promise<ProjectionManifest | undefined> {
    const file = path.join(directory, "manifest.json");
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
        throw projectionCorrupt("Projection manifest size is invalid");
      }
      const bytes = Buffer.allocUnsafe(metadata.size);
      claimStorageIo("readBytes", bytes.byteLength);
      claimStorageIo("ioOperations", 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (bytesRead !== bytes.byteLength) {
        throw projectionCorrupt("Projection manifest changed while reading");
      }
      try {
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (canonicalize(value) !== bytes.toString("utf8")) {
        throw projectionCorrupt("Projection manifest is not canonical");
      }
      const stored = plainRecord(value);
      if (!stored) throw projectionCorrupt("Projection manifest is invalid");
      const { integrity, ...contents } = stored;
      if (this.#authenticated) {
        const expected = projectionIndexMac("manifest", [Buffer.from(canonicalize(contents), "utf8")], this.#integrity);
        if (!expected || typeof integrity !== "string" || !/^[a-f0-9]{64}$/u.test(integrity) ||
            !timingSafeEqual(expected, Buffer.from(integrity, "hex"))) {
          throw projectionCorrupt("Projection manifest authentication is invalid");
        }
      }
      return validateManifest(contents);
      } catch (error) {
        if (error instanceof DurableProjectionStorageError) throw error;
        throw projectionCorrupt("Projection manifest contents are invalid", error);
      }
    } finally {
      await handle.close();
    }
  }

  async #writeManifest(manifest: ProjectionManifest): Promise<void> {
    const contents = Buffer.from(canonicalize(manifest), "utf8");
    const signature = this.#authenticated ? projectionIndexMac("manifest", [contents], this.#integrity) : undefined;
    if (this.#authenticated && !signature) throw projectionCorrupt("Projection integrity key is unavailable");
    const encoded = signature ? Buffer.from(canonicalize({ ...manifest, integrity: signature.toString("hex") }), "utf8") : contents;
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
    await replaceFile(temporary, path.join(this.rootDir, "manifest.json"), {
      signal: currentMaintenanceAbortSignal(),
      beforeAttempt: () => claimStorageIo("ioOperations", 1),
    });
    claimStorageIo("ioOperations", 1);
    await syncDirectory(this.rootDir);
  }

  async #validatePublishedStorage(
    manifest: ProjectionManifest,
  ): Promise<void> {
    if (
      manifest.deltaSegments.length >
        MAX_DELTA_SEGMENTS + (manifest.compaction ? 1 : 0)
    ) {
      throw projectionCorrupt("Projection manifest has too many delta segments");
    }
    for (const segment of manifest.deltaSegments) {
      if (segment.level !== 0) {
        throw projectionCorrupt("Projection delta segment level is invalid");
      }
      const reader = await SegmentReader.open(this.rootDir, segment, this.#runReadStep, this.#segmentEntries, this.#integrity);
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
    // Retirement storage is independent of the current data root. A damaged
    // cleanup page preserves old files; it must not erase healthy business rows.
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

  #retirementIdentity(): ProjectionRetirementIdentity | undefined {
    const manifest = this.#manifest;
    if (
      !manifest ||
      (!manifest.retirementRoot && !manifest.retirementCleanup)
    ) {
      return undefined;
    }
    return {
      manifestGeneration: manifest.generation,
      manifestCheckpoints: manifest.checkpoints,
      ...(manifest.retirementRoot
        ? { retirementRoot: manifest.retirementRoot.id }
        : {}),
      ...(manifest.retirementCleanup
        ? { retirementCleanup: manifest.retirementCleanup }
        : {}),
    };
  }

  async #drainRetirementStep(
    expected: ProjectionRetirementIdentity,
  ): Promise<ProjectionRetirementStepResult> {
    const manifest = this.#manifest;
    if (!manifest) return { kind: "stale" };
    const current = this.#retirementIdentity();
    if (!current || !sameRetirementIdentity(current, expected)) {
      return { kind: "stale" };
    }
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
      return { kind: "progressed" };
    }
    if (!manifest.retirementRoot) return { kind: "stale" };
    this.#expireReadViews();
    const page = await this.#loadRetirementPage(manifest.retirementRoot);
    let blocked = false;
    let retryAt: number | undefined;
    for (const [id, view] of this.#readViews) {
      if (view.generation >= page.retiredAtGeneration) continue;
      blocked = true;
      if (this.#inUseReadViews.has(id)) continue;
      retryAt = retryAt === undefined
        ? view.expiresAt
        : Math.min(retryAt, view.expiresAt);
    }
    for (const { view } of this.#inUseReadViews.values()) {
      if (view.generation < page.retiredAtGeneration) blocked = true;
    }
    if (blocked) {
      return {
        kind: "blocked",
        ...(retryAt === undefined ? {} : { retryAt }),
      };
    }
    if (page.tree) {
      const tree = await this.#loadDirectoryPage(page.tree);
      await this.#beginWriteIntent(manifest.generation + 1);
      let next = page.next;
      for (const child of [tree.left, tree.right]) if (child) {
        next = await this.#writeRetirementPage({ formatVersion: 1, retiredAtGeneration: page.retiredAtGeneration,
          files: [], tree: child, ...(next ? { next } : {}) });
      }
      next = await this.#prependRetirementPages([
        ...page.files, directoryPageFile(page.tree.id), tree.descriptor.dataFile, tree.descriptor.offsetsFile,
      ], page.retiredAtGeneration, next);
      const updated = normalizeManifestOptionals({ ...manifest, generation: manifest.generation + 1,
        retirementRoot: next, retirementCleanup: retirementPageFile(manifest.retirementRoot.id) });
      await this.#finalizeWriteIntent(updated, []);
      await this.#writeManifest(updated);
      this.#manifest = updated;
      await this.#completeWriteIntent(true).catch(() => undefined);
      return { kind: "progressed" };
    }
    await durablyRemoveFiles(
      page.files.map((file) => path.join(this.rootDir, file)),
    );
    this.#segmentEntries.forget(page.files);
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
    return { kind: "progressed" };
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
    await replaceFile(temporary, path.join(this.rootDir, "write-intent.json"), {
      signal: currentMaintenanceAbortSignal(),
      beforeAttempt: () => claimStorageIo("ioOperations", 1),
    });
    claimStorageIo("ioOperations", 1);
    await syncDirectory(this.rootDir);
  }

  async #recoverWriteIntent(): Promise<void> {
    const intent = await this.#readWriteIntent();
    if (!intent) {
      this.#writeIntent = undefined;
      await unlink(path.join(this.rootDir, ".write-intent.tmp")).catch(
        () => undefined,
      );
      return;
    }
    const manifest = await this.#readManifest().catch((error: unknown) => {
      if (error instanceof DurableProjectionStorageError) return undefined;
      throw error;
    });
    this.#writeIntent = intent;
    const committed = manifest !== undefined && isCommittedIntent(intent, manifest);
    if (committed) await syncDirectory(this.rootDir);
    await this.#completeWriteIntent(committed);
  }

  async #publicationOutcome(): Promise<{ readonly manifest: ProjectionManifest; readonly committed: boolean } | undefined> {
    if (!this.#writeIntent) return;
    try {
      const manifest = await this.#readManifest();
      if (!manifest || manifest.projectionId !== this.projectionId || manifest.reducerVersion !== this.reducerVersion ||
          !sameCheckpointSources(manifest.checkpoints, this.#requireManifest().checkpoints)) return;
      return { manifest, committed: isCommittedIntent(this.#writeIntent, manifest) };
    } catch { return; }
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
      try {
      const value = JSON.parse(encoded) as unknown;
      if (canonicalize(value) !== encoded) {
        throw projectionCorrupt("Projection write intent is not canonical");
      }
      return validateWriteIntent(value);
      } catch (error) {
        if (error instanceof DurableProjectionStorageError) throw error;
        throw projectionCorrupt("Projection write intent contents are invalid", error);
      }
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
    this.#segmentEntries.forget(files);
    for (const file of files) {
      this.#directoryCache.delete(directoryPageIdFromFile(file) ?? "");
    }
    this.#writeIntent = undefined;
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

function runProjectionReadStep<T>(
  runner: FileDurableProjectionIndexOptions["runReadStep"],
  step: DurableProjectionReadStep,
  operation: () => Promise<T>,
): Promise<T> {
  // Maintenance already owns a physical plan. Charge its claims without
  // acquiring a second permit (which would deadlock a single-slot device).
  if (currentDeviceCapacityStep()?.kind === "physical") return operation();
  return runner ? runner(step, operation) : operation();
}

class SegmentReader {
  // A single bounded read-ahead buffer belongs to this open immutable segment,
  // never to the index or a later read view. Every returned entry still checks
  // its ordinal, digest and canonical payload before use.
  #dataWindow: { readonly start: number; readonly bytes: Buffer } | undefined;
  #offsetWindow: { readonly startIndex: number; readonly bytes: Buffer } | undefined;
  #sequentialOffsets = false;
  #cacheChecked = false;
  #files: { readonly data: FileHandle; readonly offsets: FileHandle } | undefined;
  #opening: Promise<{ readonly data: FileHandle; readonly offsets: FileHandle }> | undefined;
  private constructor(
    readonly descriptor: SegmentDescriptor,
    readonly rootDir: string,
    readonly runReadStep: FileDurableProjectionIndexOptions["runReadStep"],
    readonly cache: SegmentEntryCache | undefined,
    readonly integrity: AuthorityCacheIntegrity | undefined,
  ) {}

  /** 文件按需打开：条目全部命中已核验缓存时不打开、不准入、不读盘。 */
  static async open(
    rootDir: string,
    descriptor: SegmentDescriptor,
    runReadStep?: FileDurableProjectionIndexOptions["runReadStep"],
    cache?: SegmentEntryCache,
    integrity?: AuthorityCacheIntegrity,
  ): Promise<SegmentReader> {
    const reader = new SegmentReader(descriptor, rootDir, runReadStep, cache, integrity);
    if (!cache) await reader.#handles();
    return reader;
  }

  #handles(): Promise<{ readonly data: FileHandle; readonly offsets: FileHandle }> {
    if (this.#files) return Promise.resolve(this.#files);
    this.#opening ??= runProjectionReadStep(this.runReadStep, "segment-open", async () => {
      const files = await SegmentReader.openFiles(this.rootDir, this.descriptor);
      if (this.cache) {
        try {
          // 以已打开句柄的身份登记，之后缓存的条目都来自这一份文件。
          this.cache.bind(this.descriptor.dataFile, segmentFileIdentity(await files.data.stat({ bigint: true })));
        } catch (error) {
          await Promise.all([files.data.close(), files.offsets.close()]);
          throw error;
        }
        this.#cacheChecked = true;
      }
      return files;
    }).then((files) => {
      this.#files = files;
      return files;
    }, (error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  private static async openFiles(
    rootDir: string,
    descriptor: SegmentDescriptor,
  ): Promise<{ readonly data: FileHandle; readonly offsets: FileHandle }> {
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
      return { data, offsets };
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
    const verified = await this.#verified(index);
    return verified?.key === key ? this.#materialize(index, verified) : undefined;
  }

  async getMany(keys: readonly string[]): Promise<ReadonlyMap<string, SegmentEntry>> {
    const sorted = [...new Set(keys)].sort();
    const values = new Map<string, SegmentEntry>();
    const pending = [{ low: 0, high: this.descriptor.count, from: 0, to: sorted.length }];
    while (pending.length) {
      const { low, high, from, to } = pending.pop()!;
      if (low >= high || from >= to) continue;
      const middle = low + Math.floor((high - low) / 2);
      const entry = await this.#verified(middle);
      if (!entry) throw projectionCorrupt('Projection segment offset is invalid');
      let left = from, right = to;
      while (left < right) {
        const pivot = left + Math.floor((right - left) / 2);
        if (sorted[pivot]! < entry.key) left = pivot + 1; else right = pivot;
      }
      const matched = left < to && sorted[left] === entry.key;
      if (matched) values.set(entry.key, await this.#materialize(middle, entry));
      pending.push({ low: middle + 1, high, from: left + Number(matched), to });
      pending.push({ low, high: middle, from, to: left });
    }
    return values;
  }

  async lowerBound(key: string): Promise<number> {
    let low = 0;
    let high = this.descriptor.count;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const entry = await this.#verified(middle);
      if (!entry) {
        throw projectionCorrupt("Projection segment offset is invalid");
      }
      if (entry.key < key) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  async entry(index: number): Promise<SegmentEntry | undefined> {
    const verified = await this.#verified(index);
    return verified && this.#materialize(index, verified);
  }

  /** Compaction preserves canonical bytes; consumers still receive fresh values. */
  async storedEntry(index: number): Promise<StoredMutation | undefined> {
    this.#sequentialOffsets = true;
    const entry = await this.#verified(index);
    if (!entry) return undefined;
    const encoded = entry.tombstone ? undefined : entry.encoded ?? (await this.#read(index))?.encoded;
    if (!entry.tombstone && encoded === undefined) throw projectionCorrupt('Projection segment value is unavailable');
    return { key: entry.key, tombstone: entry.tombstone, ...(encoded === undefined ? {} : { encoded }),
      bytes: Buffer.byteLength(entry.key, 'utf8') + (encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8')) + SEGMENT_HEADER_BYTES };
  }

  /** 读取并核验一个条目；已核验的条目直接复用，只用于比较键时不解析值。 */
  async #verified(index: number): Promise<VerifiedSegmentEntry | undefined> {
    if (index < 0 || index >= this.descriptor.count) return undefined;
    if (this.cache && !this.#cacheChecked) await this.#checkCache();
    const cached = this.cache?.get(this.descriptor.dataFile, index);
    if (cached) return cached;
    const entry = await this.#read(index);
    if (entry) {
      this.cache?.put(
        this.descriptor.dataFile,
        index,
        entry.encoded !== undefined && entry.encoded.length > SEGMENT_ENTRY_CACHE_VALUE_BYTES
          ? { key: entry.key, tombstone: entry.tombstone }
          : entry,
      );
    }
    return entry;
  }

  /** 本读取器首次复用缓存前核对数据文件身份；不符或文件已不在则丢弃该段缓存。 */
  async #checkCache(): Promise<void> {
    const file = this.descriptor.dataFile;
    if (this.cache!.identity(file) !== undefined) {
      const current = await runProjectionReadStep(this.runReadStep, "segment-open", async () => {
        claimStorageIo("ioOperations", 1);
        return stat(path.join(this.rootDir, file), { bigint: true }).then(segmentFileIdentity, () => undefined);
      });
      if (current !== this.cache!.identity(file)) this.cache!.forget([file]);
    }
    this.#cacheChecked = true;
  }

  async #materialize(index: number, entry: VerifiedSegmentEntry): Promise<SegmentEntry> {
    if (entry.tombstone) return { key: entry.key, tombstone: true };
    // 过大的值只缓存了键：重新读取并核验一次。
    const encoded = entry.encoded ?? (await this.#read(index))?.encoded;
    if (encoded === undefined) throw projectionCorrupt("Projection segment value is unavailable");
    return { key: entry.key, value: JSON.parse(encoded) as JsonValue, tombstone: false };
  }

  async #read(index: number): Promise<VerifiedSegmentEntry | undefined> {
    await this.#handles();
    const operation = () => this.readEntry(index);
    return runProjectionReadStep(this.runReadStep, "segment-entry", operation);
  }

  private async readEntry(index: number): Promise<VerifiedSegmentEntry | undefined> {
    const { offsets } = this.#files!;
    let window = this.#offsetWindow;
    if (!window || index < window.startIndex || (index - window.startIndex + 1) * 8 > window.bytes.length) {
      // Only the sequential maintenance path pays for an offsets page.
      // A point lookup must not prefetch unrelated historical positions.
      const limit = this.#sequentialOffsets ? SEGMENT_OFFSET_BATCH_BYTES : 8;
      const startIndex = index - index % (limit / 8);
      const bytes = Buffer.allocUnsafe(Math.min(limit, (this.descriptor.count - startIndex) * 8));
      claimStorageIo("readBytes", bytes.byteLength);
      claimStorageIo("ioOperations", 1);
      const read = await offsets.read(bytes, 0, bytes.length, startIndex * 8);
      if (read.bytesRead !== bytes.length) throw projectionCorrupt("Projection segment offset table is truncated");
      window = this.#offsetWindow = { startIndex, bytes };
    }
    const offset = window.bytes.readBigUInt64BE((index - window.startIndex) * 8);
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw projectionCorrupt("Projection segment offset exceeds the safe range");
    }
    const header = Buffer.allocUnsafe(SEGMENT_HEADER_BYTES);
    const headerRead = await this.#readData(header, Number(offset), false);
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
    const payloadRead = await this.#readData(payload, Number(offset) + SEGMENT_HEADER_BYTES, true);
    if (
      payloadRead.bytesRead !== payload.byteLength ||
      !timingSafeEqual(segmentEntryChecksum(this.descriptor.dataFile, this.descriptor.authenticated === true,
        header.subarray(0, 20), payload, this.integrity), header.subarray(20, 52))
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
    return { key, encoded, tombstone: false };
  }

  async #readData(target: Buffer, position: number, readAhead: boolean): Promise<{ bytesRead: number }> {
    const window = this.#dataWindow;
    if (window && position >= window.start && position + target.length <= window.start + window.bytes.length) {
      window.bytes.copy(target, 0, position - window.start, position - window.start + target.length);
      return { bytesRead: target.length };
    }
    // Read the exact header first. Only a validated small payload may prefetch,
    // so the largest legal entry still fits the unchanged per-entry IO budget.
    if (!readAhead || target.length > SEGMENT_IO_BATCH_BYTES) {
      claimStorageIo("readBytes", target.length);
      claimStorageIo("ioOperations", 1);
      return this.#files!.data.read(target, 0, target.length, position);
    }
    const bytes = Buffer.allocUnsafe(SEGMENT_IO_BATCH_BYTES);
    claimStorageIo("readBytes", bytes.length);
    claimStorageIo("ioOperations", 1);
    const read = await this.#files!.data.read(bytes, 0, bytes.length, position);
    this.#dataWindow = { start: position, bytes: bytes.subarray(0, read.bytesRead) };
    bytes.copy(target, 0, 0, Math.min(target.length, read.bytesRead));
    return { bytesRead: Math.min(target.length, read.bytesRead) };
  }

  async close(): Promise<void> {
    this.#dataWindow = undefined;
    this.#offsetWindow = undefined;
    const files = this.#files ?? await this.#opening?.catch(() => undefined);
    this.#files = undefined;
    this.#opening = undefined;
    if (files) await Promise.all([files.data.close(), files.offsets.close()]);
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

function encodeSegmentEntry(entry: StoredMutation, ordinal: number, dataFile: string, authenticated: boolean, integrity?: AuthorityCacheIntegrity): Buffer {
  const key = Buffer.from(entry.key, "utf8");
  const value = entry.tombstone
    ? Buffer.alloc(0)
    : Buffer.from(entry.encoded ?? canonicalize(entry.value), "utf8");
  const payload = Buffer.concat([key, value]);
  const header = Buffer.alloc(SEGMENT_HEADER_BYTES);
  header.writeUInt32BE(key.byteLength, 0);
  header.writeUInt32BE(value.byteLength, 4);
  header.writeUInt8(entry.tombstone ? SEGMENT_TOMBSTONE : 0, 8);
  header.writeUInt8(SEGMENT_FORMAT_VERSION, 9);
  header.writeBigUInt64BE(BigInt(ordinal), 12);
  segmentEntryChecksum(dataFile, authenticated, header.subarray(0, 20), payload, integrity).copy(header, 20);
  return Buffer.concat([header, payload]);
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
  if (record.rebuilding !== undefined && record.rebuilding !== true) throw new Error("Projection recovery state is invalid");
  const recoveryTarget = record.rebuilding ? validateCheckpoints(record.recoveryTarget) : undefined;
  const unrelatedThrough = record.rebuilding ? validateCheckpoints(record.unrelatedThrough) : undefined;
  if (!record.rebuilding && (record.recoveryTarget !== undefined || record.unrelatedThrough !== undefined)) throw new Error("Projection recovery fields require building state");
  if (recoveryTarget && unrelatedThrough) {
    if (!sameCheckpointSources(recoveryTarget, checkpoints) || !sameCheckpointSources(unrelatedThrough, checkpoints)) throw new Error("Projection recovery sources changed");
    for (const [source, point] of Object.entries(checkpoints)) {
      if (point.lsn > recoveryTarget[source]!.lsn || recoveryTarget[source]!.lsn > unrelatedThrough[source]!.lsn ||
          point.frameEndOffset > recoveryTarget[source]!.frameEndOffset || recoveryTarget[source]!.frameEndOffset > unrelatedThrough[source]!.frameEndOffset) {
        throw new Error("Projection recovery coverage is out of order");
      }
    }
  }
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
    ...(record.rebuilding === true ? { rebuilding: true as const, recoveryTarget: recoveryTarget!, unrelatedThrough: unrelatedThrough! } : {}),
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

function sameOptionalCheckpoints(left: DurableProjectionCheckpoints | undefined, right: DurableProjectionCheckpoints | undefined): boolean {
  return left === undefined || right === undefined ? left === right : sameCheckpoints(left, right);
}

function sameCheckpoints(
  left: DurableProjectionCheckpoints,
  right: DurableProjectionCheckpoints,
): boolean {
  return canonicalize(left) === canonicalize(right);
}

function sameRetirementIdentity(
  left: ProjectionRetirementIdentity,
  right: ProjectionRetirementIdentity,
): boolean {
  return (
    left.manifestGeneration === right.manifestGeneration &&
    sameCheckpoints(left.manifestCheckpoints, right.manifestCheckpoints) &&
    left.retirementRoot === right.retirementRoot &&
    left.retirementCleanup === right.retirementCleanup
  );
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
    || (record.authenticated !== undefined && record.authenticated !== true)
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
    ...(record.authenticated === true ? { authenticated: true as const } : {}),
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
    (record.files.length === 0 && record.tree === undefined) ||
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
    ...(record.tree === undefined ? {} : { tree: validateDirectoryPagePointer(record.tree) }),
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
    ...(manifest.rebuilding ? { rebuilding: true as const, recoveryTarget: manifest.recoveryTarget!, unrelatedThrough: manifest.unrelatedThrough! } : {}),
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

function segmentEntryChecksum(dataFile: string, authenticated: boolean, header: Uint8Array, payload: Uint8Array, integrity?: AuthorityCacheIntegrity): Buffer {
  if (!authenticated) return checksum(Buffer.concat([header, payload]));
  // 随机不可变段身份、ordinal与物理键均进入认证，旧段的合法条目不能替换新段。
  const signed = projectionIndexMac("segment", [Buffer.from(dataFile, "utf8"), header, payload], integrity);
  if (!signed) throw projectionCorrupt("Projection integrity key is unavailable");
  return signed;
}

function checksum(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function claimStorageIo(
  dimension: "readBytes" | "writeBytes" | "ioOperations" | "temporaryBytes",
  amount: number,
): void {
  const usage = compactionStepUsage.getStore();
  if (usage?.guardNextRange && usage.used[dimension] + amount > usage.limit[dimension] * 3 / 4) {
    throw new CompactionBatchBudgetFull();
  }
  claimDeviceCapacity(dimension, amount);
  if (usage) usage.used[dimension] += amount;
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

/** 当前版本目录：projectionId 与显式归约版本共同决定；同版本的旧（无版本后缀）目录可原地复用。 */
export function durableProjectionVersionDirectoryName(projectionId: string, reducerVersion: number): string {
  return durableProjectionDirectoryName(projectionId) + ".v" + reducerVersion;
}

function validateReadKeys(keys: readonly string[]): string[] {
  if (!Array.isArray(keys) || keys.length > 256) throw new TypeError('Projection multi-key read requires at most 256 string keys');
  const selected = [...keys];
  for (const key of selected) assertKey(key);
  return selected;
}
