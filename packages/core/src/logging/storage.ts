import { LogRequestError, LogStoreNotInitializedError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  DeviceCapacityArbiterPort,
  DeviceCapacityBudget,
  DeviceCapacityStepPermit,
} from "../resources/device-capacity.js";
import { LogAppendIndeterminateError, LogStorageError } from "./contracts.js";
import type {
  LogAppendReceipt,
  LogCapture,
  LogPolicy,
  LogPolicyState,
  LogRecord,
  LogSink,
  LogStatus,
  LogTier,
} from "./contracts.js";
import { DEFAULT_LOG_POLICY, validateLogPolicy } from "./policy.js";
import { fitLogCapture } from "./limits.js";
import { logFailureEvidence, logStorageFailure } from "./failure.js";
import { projectLogAccess, validLogAccess, type LogRecordAccess } from "./access-projection.js";
import { isLegacyFile, validateWriterObservation, type LegacyLogEntry, type LogMigration, type LogWriterIdentity, type LogWriterObservation } from "./legacy.js";
export type { LegacyLogEntry, LogMigration, LogWriterIdentity, LogWriterObservation } from "./legacy.js";

export interface LogFileInfo {
  readonly legacyPath?: string;
  readonly bytes: number;
  readonly identity: string;
}
/** Bound to one private log root. Implementations reject links and operate relative to an open directory. */
export interface LogFileSystem {
  open(readOnly: boolean): Promise<void>;
  list(limit: number): Promise<readonly string[]>;
  stat(name: string): Promise<LogFileInfo>;
  /** Optional transport batch; same ordered, per-file proof as stat, never cached across transactions. */
  statMany?(names: readonly string[]): Promise<readonly LogFileInfo[]>;
  read(name: string, size: number, offset: number, limit: number, identity?: string, prefix?: boolean): Promise<Uint8Array>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  /** Append only to the exact admitted object and durable length; synchronize before returning. */
  append?(name: string, identity: string, offset: number, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  truncate(name: string, identity: string, bytes: number): Promise<void>;
  remove(name: string, identity?: string): Promise<void>;
  sync(): Promise<void>;
  tryLock(): Promise<boolean>;
  /** Shared OS lock on the existing control file; never creates or modifies files. */
  tryReadLock(): Promise<boolean>;
  unlock(): Promise<void>;
  close(): Promise<void>;
}
export interface LogSegment {
  readonly name: string;
  readonly bytes: number;
  readonly start: number;
  readonly end: number;
  readonly receivedAt: number;
  readonly tier: LogTier;
  readonly recordIds: readonly string[];
  readonly access?: readonly LogRecordAccess[];
  readonly attachments: readonly { name: string; bytes: number }[];
  /** v2 writers retain independent active segments per tier. Legacy segments stay sealed. */
  readonly ordinals?: readonly number[];
  readonly identity?: string;
  readonly sealed?: boolean;
}
interface RetiredFile {
  name: string;
  identity: string;
  bytes: number;
  reclaimed: boolean;
}
export interface LogRetirement {
  readonly start: number;
  readonly end: number;
  readonly at: number;
  readonly reason: string;
}
export interface LogStoreSnapshot {
  readonly layout: "zxlog/1";
  readonly storeId: string;
  generation: number;
  upper: number;
  policy: LogPolicyState;
  segments: LogSegment[];
  retired: LogRetirement[];
  pending: RetiredFile[];
  gaps: number;
  lastRecoveryAt?: number;
  legacy?: LegacyLogEntry[];
  writers?: (LogWriterIdentity & { protocol: 1 | 2; registeredAt?: number })[];
  migration?: LogMigration;
  legacyRetired?: number;
}
const STATE = /^state-(\d{12})\.json$/u;
const HEAD = /^published-(\d{12})\.head$/u;
const RECOVERY_RESERVE = 8192;
const OWNED =
  /^(?:published-\d{12}\.head|segment-[a-f0-9-]{36}\.jsonl|detail-[a-f0-9-]{36}\.json|index-[a-f0-9-]{36}\.json|state-\d{12}\.(?:json|new))$/u;
const CONTROL_FILES = 7;
function storageFault(code: string, message: string): LogStorageError {
  return new LogStorageError("storage-unavailable", message, { category: "store", code });
}
/** Expected bounded reclamation work; never use this category for physical I/O failures. */
class LogReclaimPendingError extends LogStorageError {
  constructor(message: string) { super("reclaim-pending", message); }
}
const STEP: DeviceCapacityBudget = {
  occupancy: {
    memoryReservationBytes: 32 * 1024 * 1024,
    temporaryBytes: 32 * 1024 * 1024,
    slots: 1,
  },
  quantum: {
    readBytes: 32 * 1024 * 1024,
    writeBytes: 32 * 1024 * 1024,
    ioOperations: 16384,
  },
};
export const logDigest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const logJson = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);

/** One Store protocol across processes. Snapshots are governance, never business authority. */
export class LocalLogStore implements LogSink {
  readonly files: LogFileSystem;
  readonly #capacity: DeviceCapacityArbiterPort;
  readonly #initial: LogPolicy;
  readonly #now: () => number;
  readonly #abort = new AbortController();
  #busy = false;
  #idle: Promise<void> | undefined;
  #closed = false;
  #permit: DeviceCapacityStepPermit | undefined;
  #inventoryLocked = false;
  #metadataLocked = false;
  #inventoryCache: Map<string, LogFileInfo> | undefined;
  #namesCache: readonly string[] | undefined;
  readonly #inventoryDirty = new Set<string>();
  readonly #observeWriters: ((signal: AbortSignal) => Promise<LogWriterObservation>) | undefined;
  #writersObserved: LogWriterObservation | undefined;
  #ioClaims = 0;

  constructor(options: {
    files: LogFileSystem;
    capacity: DeviceCapacityArbiterPort;
    initialPolicy?: LogPolicy;
    now?: () => number;
    observeWriters?: (signal: AbortSignal) => Promise<LogWriterObservation>;
  }) {
    this.files = meteredFiles(options.files, (dimension, amount) => {
      if (!this.#permit) throw storageFault("resource-permit-missing", "日志物理操作缺少资源许可");
      this.#permit.claim(dimension, amount);
      if (dimension === "ioOperations") this.#ioClaims += amount;
    }, (...names) => {
      this.#namesCache = undefined;
      for (const name of names) this.#inventoryDirty.add(name);
    });
    this.#capacity = options.capacity;
    this.#initial = validateLogPolicy(options.initialPolicy ?? DEFAULT_LOG_POLICY);
    this.#now = options.now ?? Date.now;
    this.#observeWriters = options.observeWriters;
  }

  async initialize(): Promise<LogStatus> {
    return this.#step(true, async () => {
      let state = await this.#load(true);
      if (!state) {
        const names = await this.#list();
        if (names.some((name) => name !== "writer.lock" && !isLegacyFile(name)))
          throw storageFault("metadata-missing", "日志存储缺少可信元信息，未重置目录");
        state = {
          layout: "zxlog/1",
          storeId: randomUUID(),
          generation: 0,
          upper: 0,
          policy: { version: 1, effective: this.#initial },
          segments: [],
          retired: [],
          pending: [],
          gaps: 0,
        };
        await this.#save(state);
      }
      await this.#refreshMigration(state);
      await this.#recover(state);
      await this.#maintenance(state);
      return this.#status(state);
    });
  }

  async append(input: readonly LogCapture[]): Promise<LogAppendReceipt> {
    if (input.length > 8) throw storageFault("batch-limit", "日志批次超限");
    let wrote = false,
      committed: LogAppendReceipt | undefined;
    try {
      return await this.#step(true, async () => {
        const state = await this.#required(true);
        await this.#recover(state);
        await this.#maintenance(state);
        if (state.migration && state.migration.state !== "confirmed") {
          const reason = state.migration.reason ?? "migration-pending";
          const writers = reason === "old-or-unknown-writer" ? this.#unprovenWriters(state) : undefined;
          throw new LogStorageError("migration-blocked", "旧日志切换尚未完成，已暂停新增日志",
            reason === "writer-inventory-unavailable" && this.#writersObserved?.failure
              ? { ...this.#writersObserved.failure, operation: "writers.inventory" }
              : { category: "writer-admission", operation: "writers.admission", code: reason,
                  ...(writers ? { writerCount: writers.length, writerPids: writers.slice(0, 8).map(writer => writer.pid) } : {}) });
        }
        const policy = state.policy.effective;
        const published = new Set(state.segments.flatMap((segment) => segment.recordIds));
        const accepted = input
          .filter(({ record }) => {
            if (published.has(record.id)) return false;
            published.add(record.id);
            return true;
          })
          .map((entry) => fitLogCapture(entry, policy));
        if (!accepted.length) return (committed = { policy: state.policy });
        for (const { record, detail } of accepted) {
          if (
            record.schema !== 1 ||
            !/^[a-f0-9-]{36}$/u.test(record.id) ||
            !Number.isSafeInteger(record.seq) ||
            record.seq < 1 ||
            Buffer.byteLength(JSON.stringify(record)) + 512 > policy.recordBytes ||
            (detail && Buffer.byteLength(detail) > policy.attachmentBytes)
          )
            throw storageFault("record-limit", "日志记录超过生效限额");
        }
        const tiers: {
          tier: LogTier;
          entries: LogCapture[];
          estimatedBytes: number;
        }[] = [];
        for (const entry of accepted) {
          const estimatedBytes = Buffer.byteLength(JSON.stringify(entry.record)) + 512;
          const last = tiers.findLast(group => group.tier === entry.record.tier && group.estimatedBytes + estimatedBytes <= policy.segmentBytes);
          if (
            last &&
            last.tier === entry.record.tier &&
            last.estimatedBytes + estimatedBytes <= policy.segmentBytes
          ) {
            last.entries.push(entry);
            last.estimatedBytes += estimatedBytes;
          } else
            tiers.push({
              tier: entry.record.tier,
              entries: [entry],
              estimatedBytes,
            });
        }
        const now = this.#now();
        const ordinal = state.upper + accepted.length;
        const entryOrdinals = new Map(accepted.map((entry, index) => [entry.record.id, state.upper + index + 1]));
        const extended = new Set<string>();
        const batches = tiers.map((group) => {
          const prior = this.files.append ? state.segments.findLast(segment => !extended.has(segment.name) && segment.tier === group.tier && segment.ordinals && segment.access && segment.identity && !segment.sealed &&
            now - segment.receivedAt < policy.segmentAgeMs && segment.bytes + group.estimatedBytes <= policy.segmentBytes && segment.recordIds.length + group.entries.length <= 4096 && segment.attachments.length + group.entries.filter(entry => entry.detail).length <= 8) : undefined;
          if (prior) extended.add(prior.name);
          const attachments: {
            name: string;
            bytes: number;
            content: Buffer;
          }[] = [];
          const records: LogRecord[] = group.entries.map(({ record, detail }) => {
            if (!detail) return { ...record, storeId: state.storeId, receivedAt: now };
            const content = Buffer.from(detail),
              attachmentName = `detail-${randomUUID()}.json`;
            attachments.push({
              name: attachmentName,
              bytes: content.length,
              content,
            });
            return {
              ...record,
              storeId: state.storeId,
              receivedAt: now,
              detail: {
                name: attachmentName,
                bytes: content.length,
                sha256: logDigest(content),
              },
            };
          });
          const bytes = Buffer.concat(records.map(logJson));
          if (bytes.length > policy.segmentBytes) throw storageFault("segment-limit", "日志批次超过分段限额");
          const added: LogSegment = {
            name: `segment-${randomUUID()}.jsonl`,
            bytes: bytes.length,
            start: entryOrdinals.get(records[0]!.id)!,
            end: entryOrdinals.get(records.at(-1)!.id)!,
            receivedAt: now,
            tier: group.tier,
            recordIds: records.map((record) => record.id),
            ordinals: records.map(record => entryOrdinals.get(record.id)!),
            sealed: false,
            access: projectLogAccess(
              bytes,
              records.map((record) => record.id),
              state.storeId,
            ),
            attachments: attachments.map(({ name: child, bytes: length }) => ({
              name: child,
              bytes: length,
            })),
          };
          return { segment: prior ? extendSegment(prior, added) : added, added, prior, records, attachments, bytes };
        });
        await this.#makeRoom(
          state,
          batches.reduce(
            (sum, batch) =>
              sum +
              batch.bytes.length +
              batch.attachments.reduce((total, item) => total + item.bytes, 0),
            0,
          ),
          batches.reduce((sum, batch) => sum + 1 + batch.attachments.length, 0),
          policy,
          { append: batches.map(batch => batch.added), extend: batches.flatMap(batch => batch.prior ? [{ name: batch.prior.name, addition: batch.added }] : []) },
        );
        wrote = true;
        for (const batch of batches) {
          // Reclamation may retire the previous active segment to make room.
          if (batch.prior) {
            batch.prior = state.segments.find(segment => segment.name === batch.prior!.name);
            if (!batch.prior) batch.segment = batch.added;
          }
          for (const attachment of batch.attachments) {
            try {
              await this.files.write(attachment.name, attachment.content);
            } catch {
              const index = batch.records.findIndex(
                (record) => record.detail?.name === attachment.name,
              );
              const { detail: _detail, ...record } = batch.records[index]!;
              batch.records[index] = {
                ...record,
                gaps: [{ kind: "unavailable", reason: "detail-write-failed" }],
              };
            }
          }
          const bytes = Buffer.concat(batch.records.map(logJson));
          const added = {
            ...batch.added,
            bytes: bytes.length,
            access: projectLogAccess(bytes, batch.added.recordIds, state.storeId),
            attachments: batch.added.attachments.filter((item) =>
              batch.records.some((record) => record.detail?.name === item.name),
            ),
          };
          if (batch.prior) {
            await this.files.append!(batch.prior.name, batch.prior.identity!, batch.prior.bytes, bytes);
            batch.segment = extendSegment(batch.prior, added);
          } else {
            await this.files.write(added.name, bytes);
            batch.segment = { ...added, identity: (await this.files.stat(added.name)).identity };
          }
        }
        await this.files.sync();
        for (const batch of batches) {
          state.segments = state.segments.filter(segment => segment.name !== batch.segment.name).map(segment =>
            segment.tier === batch.segment.tier && segment.ordinals && !segment.sealed ? { ...segment, sealed: true } : segment);
          state.segments.push(batch.segment);
        }
        state.segments.sort((a, b) => a.start - b.start);
        state.upper = ordinal;
        // One publication for every tier in this batch. Unknown acknowledgements are never replayed.
        await this.#save(state);
        return (committed = { policy: state.policy });
      });
    } catch (error) {
      if (committed) return { ...committed, storageDegraded: true, storageFailure: logFailureEvidence(error) };
      if (wrote) throw new LogAppendIndeterminateError(logFailureEvidence(error));
      throw error;
    }
  }

  async maintain(): Promise<LogStatus> {
    return this.#step(true, async () => {
      const state = await this.#required(true);
      await this.#recover(state);
      await this.#maintenance(state);
      return this.#status(state);
    });
  }

  async applyPolicy(desired: LogPolicy, expectedVersion: number, assertAuthorized?: () => void): Promise<LogStatus> {
    const validated = validateLogPolicy(desired);
    return this.#step(true, async () => {
      const state = await this.#required(true);
      assertAuthorized?.();
      if (state.policy.version !== expectedVersion) throw new LogRequestError("日志策略已变化，请重新读取后提交");
      if (state.policy.desired) throw new LogRequestError("日志策略正在应用");
      state.policy = { ...state.policy, desired: validated };
      await this.#save(state);
      await this.#maintenance(state);
      return this.#status(state);
    });
  }

  /** All readers, including offline CLI, share this resource-bounded read-only boundary. */
  async read<T>(
    work: (
      snapshot: LogStoreSnapshot,
      files: LogFileSystem,
      current: () => Promise<LogStoreSnapshot>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#step(false, async () =>
      work(await this.#required(), this.files, () => this.#required()),
    );
  }
  async status(): Promise<LogStatus> {
    return this.#step(false, () => this.#metadata(async () => this.#status(await this.#required())));
  }

  /** Local legacy discovery has no fabricated Store identity or effective policy. */
  async inspectLegacy<T>(work: (
    state: LogStoreSnapshot | undefined,
    files: LogFileSystem,
    unregistered: readonly string[],
    current: () => Promise<{ state: LogStoreSnapshot | undefined; names: readonly string[] }>,
  ) => Promise<T>): Promise<T> {
    return this.#step(false, async () => {
      const current = async () => {
        const state = await this.#load();
        if (state) return { state, names: [] };
        const names = await this.#list();
        if (names.some((name) => !isLegacyFile(name) && name !== "writer.lock")) throw new LogRequestError("日志存在未完成的初始化状态，请启动产品接续；离线读取未改动文件");
        return { state, names: names.filter(isLegacyFile).sort() };
      };
      const { state, names } = await current();
      return work(state, this.files, names, current);
    });
  }

  async rebuildIndex(): Promise<boolean> {
    return this.#step(true, async () => {
      const state = await this.#required(true),
        names = new Set(await this.#list());
      const segment = state.segments.find((item) => (!item.ordinals || item.sealed) && !names.has(indexName(item.name)));
      if (state.migration && state.migration.state !== "confirmed") return false;
      if (!segment) return false;
      const bytes = await this.files.read(segment.name, segment.bytes, 0, segment.bytes);
      const offsets: number[] = [];
      let offset = 0;
      for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
        if (line) {
          JSON.parse(line);
          offsets.push(offset);
        }
        offset += Buffer.byteLength(line) + 1;
      }
      const index = logJson({ schema: 1, sha256: logDigest(bytes), offsets });
      await this.#makeRoom(state, index.length, 1);
      if (!state.segments.includes(segment)) return false;
      await this.files.write(indexName(segment.name), index);
      await this.files.sync();
      return true;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    await Promise.all([this.files.close(), this.#idle]);
  }

  async #step<T>(write: boolean, work: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new LogStorageError("owner-unavailable", "日志存储已关闭");
    if (this.#busy) throw new LogStorageError("writer-busy", "日志存储正在维护");
    this.#busy = true;
    this.#ioClaims = 0;
    const started = performance.now();
    let admissionMs = 0, lockWaitMs = 0;
    let settle!: () => void;
    this.#idle = new Promise<void>((resolve) => { settle = resolve; });
    let releaseLock = false;
    const budget = this.#observeWriters && write ? { ...STEP, occupancy: { ...STEP.occupancy, memoryReservationBytes: 96 * 1024 * 1024 } } : STEP;
    try {
      const admission = await this.#capacity.acquire(
        {
          admissionId: `logging:${randomUUID()}`,
          serviceClass: "storage-background",
          atomic: budget,
          preferred: budget,
          maxWaitMs: 250,
        },
        this.#abort.signal,
      );
      admissionMs = performance.now() - started;
      if (admission.kind !== "granted") throw new LogStorageError(
        admission.kind === "capacity-gap" ? "resource-gap" : admission.kind === "backpressured" && admission.blockedBy === "probe-unavailable" ? "probe-unavailable" : "resource-wait",
        "日志存储资源暂不可用",
        { category: "capacity", operation: "capacity.acquire", code: admission.kind === "backpressured" ? admission.blockedBy : admission.kind },
      );
      const step = admission.permit.tryBegin(budget);
      if (!step) {
        admission.permit.release();
        throw new LogStorageError("resource-wait", "日志存储步骤受阻");
      }
      // Reserve the entire bounded step before taking the cross-process lock.
      let failed = false, primary: unknown;
      try {
        this.#permit = step;
        await this.files.open(!write);
        if (write) {
          this.#writersObserved = undefined;
          if (this.#observeWriters) {
            try {
              const value = await this.#observeWriters(this.#abort.signal);
              if (validateWriterObservation(value)) this.#writersObserved = value;
            } catch (error) {
              // Missing proof still blocks migration; retain why it was unavailable.
              this.#writersObserved = { complete: false, at: this.#now(), candidates: [], failure: logFailureEvidence(error) };
            }
          }
          if (this.#closed) throw new LogStorageError("owner-unavailable", "日志存储已关闭");
          const waiting = performance.now();
          try { releaseLock = await this.files.tryLock(); }
          finally { lockWaitMs = performance.now() - waiting; }
          if (!releaseLock) throw new LogStorageError("writer-busy", "日志存储正在维护");
          this.#inventoryLocked = true;
        }
        return await work();
      } catch (error) { failed = true; primary = error; throw error;
      } finally {
        this.#inventoryLocked = false;
        this.#inventoryCache = undefined;
        this.#namesCache = undefined;
        this.#inventoryDirty.clear();
        try {
          if (releaseLock) await this.files.unlock();
        } catch (error) {
          if (failed) throw new AggregateError([primary, error], "日志事务与释放均未完成", { cause: primary });
          throw error;
        } finally {
          this.#permit = undefined;
          step.complete();
          admission.permit.release();
        }
      }
    } catch (error) {
      if (!write || error instanceof LogRequestError || error instanceof LogStoreNotInitializedError) throw error;
      throw new LogStorageError(logStorageFailure(error), error instanceof Error ? error.message : "日志事务未完成", {
        ...logFailureEvidence(error), durationMs: Math.round(performance.now() - started), admissionMs: Math.round(admissionMs), lockWaitMs: Math.round(lockWaitMs), ioClaims: this.#ioClaims,
      });
    } finally {
      this.#busy = false;
      settle();
      this.#idle = undefined;
    }
  }

  async #list(): Promise<readonly string[]> {
    // Reuse only an unchanged namespace inside this write transaction. The
    // mutation hook invalidates before I/O, including a rejected partial write.
    if (this.#inventoryLocked && this.#namesCache) return this.#namesCache;
    const names = await this.files.list(4096);
    if (this.#inventoryLocked) this.#namesCache = names;
    return names;
  }

  async #load(recover = false): Promise<LogStoreSnapshot | undefined> {
    if (recover) await this.#recoverPublication();
    return this.#metadata(async () => {
      const names = (await this.#list()).filter(name => HEAD.test(name)).sort();
      if (!names.length) return undefined;
      return this.#readState(names.at(-1)!.replace("published-", "state-").replace(/head$/u, "json"));
    }, () => undefined);
  }

  /** Pin only governance and inventory, never a query's records, pages or consumers. */
  async #metadata<T>(work: () => Promise<T>, absent?: () => T): Promise<T> {
    if (this.#inventoryLocked || this.#metadataLocked) return work();
    // Legacy/uninitialized offline reads must not create a root or a control file.
    const names = await this.#list();
    if (!names.includes("writer.lock")) {
      if (names.some(name => HEAD.test(name))) throw storageFault("control-file-missing", "日志治理控制文件缺失");
      // Observe the absence at this point, rather than racing first publication.
      // Callers below must not read a newly published state without exclusion.
      if (absent) return absent();
      throw new LogStoreNotInitializedError();
    }
    if (!await this.files.tryReadLock()) throw new LogStorageError("writer-busy", "日志状态暂忙，请稍后重查");
    this.#metadataLocked = true;
    try { return await work(); }
    finally { this.#metadataLocked = false; await this.files.unlock(); }
  }
  async #required(recover = false): Promise<LogStoreSnapshot> {
    const state = await this.#load(recover);
    if (!state) throw new LogStoreNotInitializedError();
    if (recover) await this.#refreshMigration(state);
    return state;
  }
  async #recoverPublication(): Promise<void> {
    const names = await this.#list();
    const heads = names.filter((name) => HEAD.test(name)).sort();
    const published = Number(heads.at(-1)?.slice(10, 22) ?? 0);
    const candidates = names
      .filter(
        (name) =>
          /^state-\d{12}\.(?:json|new)$/u.test(name) && Number(name.slice(6, 18)) > published,
      )
      .sort()
      .reverse();
    for (const name of candidates) {
      let candidate: LogStoreSnapshot;
      try {
        candidate = await this.#readState(name);
      } catch (error) {
        const initialTorn =
          name === "state-000000000001.new" &&
          names.every((entry) => entry === name || entry === "writer.lock" || isLegacyFile(entry));
        if (initialTorn || (published > 0 && name.endsWith(".new"))) {
          await this.#erase(name);
          continue;
        }
        throw error;
      }
      if (published > 0) {
        const previous = await this.#readState(`state-${String(published).padStart(12, "0")}.json`);
        if (candidate.storeId !== previous.storeId || candidate.upper < previous.upper)
          throw storageFault("publication-regressed", "日志发布身份或水位回退");
      }
      // Complete candidates preserve observation identity, even if a final namespace barrier failed.
      for (const segment of candidate.segments) {
        for (const file of [{ name: segment.name, bytes: segment.bytes }, ...segment.attachments]) {
          const actual = await this.files.stat(file.name);
          if (actual.bytes !== file.bytes) throw storageFault("publication-incomplete", "日志发布候选引用不完整");
          await this.files.truncate(file.name, actual.identity, actual.bytes);
        }
      }
      const actual = await this.files.stat(name);
      await this.files.truncate(name, actual.identity, actual.bytes);
      await this.files.sync();
      if (name.endsWith(".new")) {
        await this.files.rename(name, name.replace(/new$/u, "json"));
        await this.files.sync();
      }
      const head = `published-${String(candidate.generation).padStart(12, "0")}.head`;
      await this.files.write(head, new Uint8Array());
      await this.files.sync();
      break;
    }
  }
  async #readState(name: string): Promise<LogStoreSnapshot> {
    const info = await this.files.stat(name);
    if (info.bytes > 4 * 1024 * 1024) throw storageFault("metadata-size-limit", "日志治理文件超限");
    const content = Buffer.from(await this.files.read(name, info.bytes, 0, info.bytes, info.identity)).toString("utf8");
    let envelope: { digest: string; state: LogStoreSnapshot };
    try { envelope = JSON.parse(content); }
    catch { throw storageFault("metadata-json-invalid", "日志治理文件损坏"); }
    const state = envelope.state;
    if (
      !state ||
      state.layout !== "zxlog/1" ||
      logDigest(JSON.stringify(state)) !== envelope.digest ||
      !/^[a-f0-9-]{36}$/u.test(state.storeId) ||
      !Number.isSafeInteger(state.generation) ||
      !Number.isSafeInteger(state.upper) ||
      !Number.isSafeInteger(state.gaps) || state.gaps < 0 ||
      (state.lastRecoveryAt !== undefined && !Number.isSafeInteger(state.lastRecoveryAt)) ||
      !Array.isArray(state.segments) ||
      !Array.isArray(state.pending) ||
      !Array.isArray(state.retired)
    )
      throw storageFault("metadata-corrupt", "日志治理文件损坏");
    if (
      state.generation !== Number(name.slice(6, 18)) ||
      state.generation < 1 ||
      state.upper < 0 ||
      !Number.isSafeInteger(state.policy.version) ||
      state.policy.version < 1
    )
      throw storageFault("generation-corrupt", "日志治理代际损坏");
    validateLogPolicy(state.policy.effective);
    if (state.policy.desired) validateLogPolicy(state.policy.desired);
    if (state.segments.length > 4096 || state.pending.length > 4096 || state.retired.length > 64)
      throw storageFault("metadata-count-limit", "日志治理状态超限");
    const ordinals = new Set<number>(), segmentNames = new Set<string>();
    for (const segment of state.segments) {
      if (
        !/^segment-[a-f0-9-]{36}\.jsonl$/u.test(segment.name) ||
        !Number.isSafeInteger(segment.bytes) ||
        segment.bytes <= 0 ||
        segment.bytes > 8 * 1024 * 1024 ||
        !Number.isSafeInteger(segment.start) ||
        !Number.isSafeInteger(segment.end) ||
        segment.start < 1 ||
        segment.end < segment.start ||
        segment.end > state.upper ||
        !Array.isArray(segment.recordIds) ||
        segment.recordIds.length !== (segment.ordinals?.length ?? segment.end - segment.start + 1) ||
        segment.recordIds.length > 4096 ||
        segment.recordIds.some((id) => !/^[a-f0-9-]{36}$/u.test(id)) ||
        !Array.isArray(segment.attachments) ||
        segment.attachments.length > 4096 ||
        !["critical", "detail"].includes(segment.tier) ||
        !Number.isSafeInteger(segment.receivedAt)
      )
        throw storageFault("segment-metadata-corrupt", "日志段元信息损坏");
      for (const detail of segment.attachments)
        if (
          !/^detail-[a-f0-9-]{36}\.json$/u.test(detail.name) ||
          !Number.isSafeInteger(detail.bytes) ||
          detail.bytes <= 0 ||
          detail.bytes > 1024 * 1024
        )
          throw storageFault("detail-metadata-corrupt", "日志详情元信息损坏");
      if (
        segment.access !== undefined &&
        !validLogAccess(segment.access, segment.recordIds.length, segment.bytes)
      )
        throw storageFault("access-projection-corrupt", "日志访问投影损坏");
      if (segmentNames.has(segment.name)) throw storageFault("duplicate-segment", "日志段身份重复");
      segmentNames.add(segment.name);
      if (segment.ordinals && (!Array.isArray(segment.ordinals) || !segment.ordinals.length ||
        segment.ordinals[0] !== segment.start || segment.ordinals.at(-1) !== segment.end ||
        typeof segment.identity !== "string" || segment.identity.length > 128 || typeof segment.sealed !== "boolean" || !segment.access)) throw storageFault("active-segment-corrupt", "日志活动段元信息损坏");
      let prior = 0;
      for (let index = 0; index < segment.recordIds.length; index++) {
        const ordinal = segment.ordinals?.[index] ?? segment.start + index;
        if (!Number.isSafeInteger(ordinal) || ordinal <= prior || ordinal > state.upper || ordinals.has(ordinal)) throw storageFault("ordinal-corrupt", "日志序号损坏或重复");
        ordinals.add(ordinal); prior = ordinal;
      }
    }
    for (const item of state.pending)
      if (
        (!OWNED.test(item.name) && !isLegacyFile(item.name)) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        typeof item.identity !== "string" ||
        item.identity.length > 128 ||
        typeof item.reclaimed !== "boolean"
      )
        throw storageFault("retirement-corrupt", "日志回收状态损坏");
    if (state.legacy !== undefined && (!Array.isArray(state.legacy) || state.legacy.length > 4096 || state.legacy.some((entry) =>
      !isLegacyFile(entry.name) || !/^[a-f0-9]{64}$/u.test(entry.id) || typeof entry.identity !== "string" || entry.identity.length > 128 ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !Number.isSafeInteger(entry.registeredAt) || !Number.isSafeInteger(entry.generation)))) throw storageFault("legacy-metadata-corrupt", "旧日志登记损坏");
    if (state.writers !== undefined && (!Array.isArray(state.writers) || state.writers.length > 256 || state.writers.some((entry) =>
      ![1, 2].includes(entry.protocol) || (entry.registeredAt !== undefined && !Number.isSafeInteger(entry.registeredAt)) ||
      !validateWriterObservation({ complete: true, at: 0, candidates: [entry] })))) throw storageFault("writer-metadata-corrupt", "日志写者登记损坏");
    if (state.migration !== undefined && (!["pending", "blocked", "confirmed"].includes(state.migration.state) || !Number.isSafeInteger(state.migration.checkedAt))) throw storageFault("migration-metadata-corrupt", "日志切换状态损坏");
    return state;
  }
  async #save(state: LogStoreSnapshot): Promise<void> {
    const names = await this.#list();
    // Keep one fallback plus the candidate, with a third snapshot's peak reserved.
    const old = names.filter((name) => STATE.test(name)).sort();
    for (const name of old.slice(0, -1)) {
      const head = name.replace("state-", "published-").replace(/json$/u, "head");
      if (names.includes(head)) await this.#erase(head);
      await this.#erase(name);
    }
    state.generation =
      Math.max(
        state.generation,
        ...names
          .filter((name) => /^state-\d{12}\.(?:json|new)$/u.test(name))
          .map((name) => Number(name.slice(6, 18))),
      ) + 1;
    const content = logJson({
      digest: logDigest(JSON.stringify(state)),
      state,
    });
    if (content.length > Math.floor(state.policy.effective.governanceBytes / 3))
      throw storageFault("governance-reserve", "日志治理预留不足");
    const stem = `state-${String(state.generation).padStart(12, "0")}`;
    const inventory = await this.#inventory();
    // Adoption may start above the new limit. Only bounded governance can grow then;
    // ordinary records remain fenced until all historical bytes fit the same policy.
    const budgetInventory = [...inventory].filter(([name]) => state.migration?.state === "confirmed" || !isLegacyFile(name));
    if (
      budgetInventory.reduce((sum, [, item]) => sum + item.bytes, content.length) >
        state.policy.effective.maxBytes ||
      budgetInventory.length + 2 > state.policy.effective.maxFiles
    )
      throw storageFault("publication-budget", "日志治理发布缺少预算");
    await this.files.write(`${stem}.new`, content);
    await this.files.sync();
    await this.files.rename(`${stem}.new`, `${stem}.json`);
    await this.files.sync();
    // Visibility follows the durability proof; the marker contains no mutable state.
    await this.files.write(stem.replace("state-", "published-") + ".head", new Uint8Array());
    await this.files.sync();
  }

  async #inventory(refreshLegacy = false): Promise<Map<string, LogFileInfo>> {
    const result = new Map<string, LogFileInfo>();
    // Only one physical writer can change managed files while this mutex is held.
    // Namespace reuse ends at any mutation; restat changed/new files, including rejected partial writes.
    const cached = this.#inventoryLocked ? this.#inventoryCache : undefined;
    const missing: string[] = [];
    for (const name of await this.#list()) {
      if (name !== "writer.lock" && !OWNED.test(name) && !isLegacyFile(name))
        throw storageFault("unmanaged-file", "日志根含未登记文件，已停止写入");
      const prior = cached?.get(name);
      if (prior && !(refreshLegacy && isLegacyFile(name)) && !this.#inventoryDirty.has(name)) result.set(name, prior);
      else missing.push(name);
    }
    const observed = !missing.length ? [] : this.files.statMany
      ? await this.files.statMany(missing)
      : await sequentialStats(this.files, missing);
    if (observed.length !== missing.length) throw storageFault("inventory-incomplete", "日志文件清点不完整");
    missing.forEach((name, index) => result.set(name, observed[index]!));
    if (this.#inventoryLocked) {
      this.#inventoryCache = result;
      this.#inventoryDirty.clear();
    }
    return new Map(result);
  }
  async #erase(name: string): Promise<void> {
    const info = await this.files.stat(name);
    await this.files.truncate(name, info.identity, 0);
    await this.files.remove(name, info.identity);
    await this.files.sync();
  }
  #unprovenWriters(state: LogStoreSnapshot): readonly LogWriterIdentity[] {
    const proof = this.#writersObserved;
    return proof?.candidates.filter(entry =>
      !state.writers?.some(writer => writer.protocol === 2 && writer.pid === entry.pid && writer.birth === entry.birth) &&
      !proof.compatible?.some(writer => writer.pid === entry.pid && writer.birth === entry.birth)) ?? [];
  }
  async #refreshMigration(state: LogStoreSnapshot): Promise<void> {
    // Legacy may still have an incompatible writer; registration always observes it afresh.
    const inventory = await this.#inventory(true);
    const historical = [...inventory].filter(([name]) => isLegacyFile(name));
    if (!this.#observeWriters && !historical.length && !state.migration) return;
    const before = JSON.stringify({ writers: state.writers, legacy: state.legacy, migration: state.migration });
    const proof = this.#writersObserved;
    const complete = proof?.complete === true && proof.self !== undefined &&
      proof.candidates.some((entry) => entry.pid === proof.self!.pid && entry.birth === proof.self!.birth);
    // Register before judging other writers, so simultaneous new processes can converge.
    let writers = state.writers ?? [];
    // The scan runs before taking the store lock. It cannot retire a writer
    // whose registration is newer than the scan (including cached scans).
    if (complete) writers = writers.filter((writer) =>
      (writer.registeredAt !== undefined && writer.registeredAt >= proof.at) ||
      proof.candidates.some((entry) => entry.pid === writer.pid && entry.birth === writer.birth));
    if (proof?.self) {
      const current = writers.find(writer => writer.pid === proof.self!.pid && writer.birth === proof.self!.birth);
      if (current) current.protocol = 2;
      else if (writers.length < 256) writers.push({ ...proof.self, protocol: 2, registeredAt: this.#now() });
    }
    state.writers = writers;
    const compatible = complete && this.#unprovenWriters(state).length === 0;
    const previous = state.migration;
    const migration = { state: compatible ? previous?.state === "confirmed" ? "confirmed" : "pending" : "blocked", checkedAt: previous?.checkedAt ?? proof?.at ?? this.#now(), ...(compatible ? {} : { reason: complete ? "old-or-unknown-writer" : "writer-inventory-unavailable" }) } as LogMigration;
    state.migration = migration;
    const prior = state.legacy ?? [];
    const priorLegacy = JSON.stringify(prior);
    state.legacy = prior.filter((entry) => inventory.get(entry.name)?.identity === entry.identity)
      .map((entry) => ({ ...entry, bytes: inventory.get(entry.name)!.bytes }));
    const known = new Set([...state.legacy.map((entry) => entry.name), ...state.pending.map((entry) => entry.name)]);
    for (const [name, info] of historical.filter(([name]) => !known.has(name)).slice(0, 8)) {
      state.legacy.push({ name, ...info, id: logDigest(`${name}:${info.identity}`), registeredAt: this.#now(), generation: state.generation + 1 });
    }
    if (compatible && (JSON.stringify(state.legacy) !== priorLegacy || historical.some(([name]) => !known.has(name))))
      state.migration = { ...state.migration, state: "pending" };
    if (before !== JSON.stringify({ writers: state.writers, legacy: state.legacy, migration: state.migration })) {
      state.migration = { ...state.migration, checkedAt: proof?.at ?? this.#now() };
      // Registration must survive a blocked append so simultaneous writers can
      // discover each other. Unchanged observations never publish a heartbeat.
      await this.#save(state);
    }
  }
  async #retireLegacy(state: LogStoreSnapshot, entry: LegacyLogEntry): Promise<void> {
    if (state.migration?.state === "blocked") throw storageFault("legacy-writer-live", "旧日志写者尚未退出");
    const actual = await this.files.stat(entry.name);
    if (actual.identity !== entry.identity || actual.bytes !== entry.bytes) throw storageFault("legacy-changed", "旧日志在切换期间发生变化");
    state.pending.push({ name: entry.name, ...actual, reclaimed: false });
    state.legacy = state.legacy!.filter((item) => item !== entry);
    state.legacyRetired = Math.min(Number.MAX_SAFE_INTEGER, (state.legacyRetired ?? 0) + 1);
    await this.#save(state);
    await this.#reclaimPending(state);
  }
  async #recover(state: LogStoreSnapshot): Promise<void> {
    await this.#reclaimPending(state);
    const known = new Set(
      state.segments.flatMap((segment) => [
        segment.name,
        indexName(segment.name),
        ...segment.attachments.map((item) => item.name),
      ]),
    );
    const inventory = await this.#inventory();
    // Only unpublished tails may be truncated. Published candidates were recovered first.
    for (const segment of state.segments.filter(item => item.ordinals && !item.sealed)) {
      const actual = inventory.get(segment.name);
      if (!actual || actual.identity !== segment.identity || actual.bytes < segment.bytes) throw storageFault("published-prefix-corrupt", "日志活动段已发布前缀损坏");
      if (actual.bytes > segment.bytes) {
        await this.files.truncate(segment.name, actual.identity, segment.bytes);
        state.gaps++;
        state.lastRecoveryAt = this.#now();
        await this.#save(state);
      }
    }
    // An unpublished governance candidate has no evidence rights. Reclaim it first
    // so recovery never needs a fourth full snapshot's unreserved peak.
    for (const [name] of inventory)
      if (/^state-\d{12}\.new$/u.test(name)) {
        await this.#erase(name);
        inventory.delete(name);
        state.gaps++;
        state.lastRecoveryAt = this.#now();
      }
    const orphans = [...inventory].filter(
      ([name]) =>
        name !== "writer.lock" && !STATE.test(name) && !HEAD.test(name) && !isLegacyFile(name) && !known.has(name),
    );
    for (const [name, info] of orphans.slice(0, 8)) {
      state.pending.push({ name, ...info, reclaimed: false });
      state.gaps++;
      state.lastRecoveryAt = this.#now();
    }
    if (orphans.length) {
      await this.#save(state);
      await this.#reclaimPending(state);
    }
  }
  async #reclaimPending(state: LogStoreSnapshot): Promise<void> {
    const batch = state.pending.filter(item => !isLegacyFile(item.name) || state.migration?.state !== "blocked").slice(0, 16);
    if (!batch.length) return;
    for (const item of batch) {
      if (!item.reclaimed) {
        const actual = await this.files.stat(item.name);
        if (actual.identity !== item.identity) throw storageFault("retirement-file-replaced", "待回收日志文件已替换");
        await this.files.truncate(item.name, item.identity, 0);
        item.reclaimed = true;
        item.bytes = 0;
      }
    }
    await this.#save(state);
    const names = await this.#list();
    for (const item of batch) {
      if (names.includes(item.name)) {
        const actual = await this.files.stat(item.name);
        if (actual.identity !== item.identity || actual.bytes !== 0)
          throw storageFault("retirement-unconfirmed", "待回收日志空间未确认");
        await this.files.remove(item.name, item.identity);
      }
      state.pending = state.pending.filter((entry) => entry !== item);
    }
    await this.files.sync();
    await this.#save(state);
  }
  async #retireSegments(state: LogStoreSnapshot, segments: readonly LogSegment[], reason: string): Promise<void> {
    const names = new Set(await this.#list());
    for (const segment of segments) {
    for (const name of [
      segment.name,
      ...segment.attachments.map((item) => item.name),
      indexName(segment.name),
    ]) {
      if (names.has(name))
        state.pending.push({
          name,
          ...(await this.files.stat(name)),
          reclaimed: false,
        });
    }
    state.segments = state.segments.filter((item) => item !== segment);
    for (const range of segmentRanges(segment)) state.retired.push({ ...range, at: this.#now(), reason });
    }
    state.retired = state.retired.slice(-64);
    await this.#save(state);
    await this.#reclaimPending(state);
  }
  async #makeRoom(
    state: LogStoreSnapshot,
    bytes: number,
    count: number,
    target = state.policy.effective,
    changes: {
      append?: readonly LogSegment[];
      extend?: readonly { name: string; addition: LogSegment }[];
      access?: { name: string; value: readonly LogRecordAccess[] };
    } = {},
  ): Promise<boolean> {
    if (state.migration?.state === "blocked") throw storageFault("migration-incomplete", "旧日志写者尚未完成切换");
    for (let attempt = 0; attempt <= 8; attempt++) {
      const inventory = await this.#inventory();
      const payload = [...inventory].filter(
        ([name]) => !name.startsWith("state-") && !HEAD.test(name) && name !== "writer.lock",
      );
      const total = payload.reduce((sum, [, info]) => sum + info.bytes, 0);
      const metadata =
        logJson({
          ...state,
          segments: [
            ...state.segments.map((segment) =>
              changes.extend?.some(item => item.name === segment.name)
                ? extendSegment(segment, changes.extend.find(item => item.name === segment.name)!.addition)
                : segment.name === changes.access?.name
                ? { ...segment, access: changes.access.value }
                : segment,
            ),
            ...(changes.append ?? []).filter(segment => !changes.extend?.some(extension => extension.addition === segment && state.segments.some(old => old.name === extension.name))),
          ],
        }).length + 256;
      // 8 KiB covers one retirement (10 files), eight orphan descriptors, policy intent,
      // and a bounded retirement-range update before the next ordinary admission.
      if (
        total + bytes + target.governanceBytes <= target.maxBytes &&
        payload.length + count + CONTROL_FILES <= target.maxFiles &&
        metadata <= Math.floor(target.governanceBytes / 3) - RECOVERY_RESERVE
      )
        return true;
      if (attempt === 8) break;
      const withDetails = state.segments.find((segment) => segment.attachments.length > 0);
      if (withDetails) {
        await this.#retireDetails(state, withDetails);
        continue;
      }
      const historical = state.legacy?.[0];
      if (historical) { await this.#retireLegacy(state, historical); continue; }
      const candidates = [...state.segments].sort(
        (a, b) =>
          (a.tier === b.tier ? 0 : a.tier === "detail" ? -1 : 1) || a.receivedAt - b.receivedAt,
      );
      if (!candidates.length) throw new LogReclaimPendingError("日志容量已满，空间尚未回收");
      const selected: LogSegment[] = [];
      let reclaimedBytes = 0, reclaimedFiles = 0, metadataBytes = 0;
      for (const candidate of candidates.slice(0, 8 - attempt)) {
        selected.push(candidate);
        for (const name of [candidate.name, indexName(candidate.name), ...candidate.attachments.map(item => item.name)]) {
          const info = inventory.get(name);
          if (info) { reclaimedBytes += info.bytes; reclaimedFiles++; }
        }
        metadataBytes += logJson(candidate).length;
        if (total - reclaimedBytes + bytes + target.governanceBytes <= target.maxBytes &&
          payload.length - reclaimedFiles + count + CONTROL_FILES <= target.maxFiles &&
          metadata - metadataBytes <= Math.floor(target.governanceBytes / 3) - RECOVERY_RESERVE) break;
      }
      await this.#retireSegments(state, selected, "capacity");
      attempt += selected.length - 1;
    }
    throw new LogReclaimPendingError("日志回收仍在进行");
  }
  async #maintenance(state: LogStoreSnapshot): Promise<void> {
    if (state.migration?.state === "blocked") {
      const reason = state.migration.reason ?? "writer-unknown";
      if (state.policy.desired && state.policy.blocked !== reason) {
        state.policy = { ...state.policy, blocked: reason };
        await this.#save(state);
      }
      return;
    }
    const now = this.#now(),
      policy = state.policy.desired ?? state.policy.effective;
    if (state.segments.some(segment => segment.ordinals && !segment.sealed && (segment.bytes >= policy.segmentBytes || now - segment.receivedAt >= policy.segmentAgeMs))) {
      state.segments = state.segments.map(segment => segment.ordinals && !segment.sealed && (segment.bytes >= policy.segmentBytes || now - segment.receivedAt >= policy.segmentAgeMs) ? { ...segment, sealed: true } : segment);
      await this.#save(state);
    }
    for (const entry of [...(state.legacy ?? [])].filter((entry) => now - entry.registeredAt >= policy.detailTtlMs).slice(0, 4))
      await this.#retireLegacy(state, entry);
    const expired = [...state.segments]
      .filter(
        (item) =>
          now - item.receivedAt >=
          (item.tier === "critical" ? policy.criticalTtlMs : policy.detailTtlMs),
      )
      .slice(0, 4);
    if (expired.length) await this.#retireSegments(state, expired, "retention");
    for (const segment of [...state.segments]
      .filter((item) => item.attachments.length && now - item.receivedAt >= policy.attachmentTtlMs)
      .slice(0, 4))
      await this.#retireDetails(state, segment);
    // Upgrade one retained old segment per bounded maintenance step; readers never repair files.
    const legacy = state.segments.find((segment) => segment.access === undefined);
    if (legacy) {
      let access: readonly LogRecordAccess[] | undefined;
      try {
        const bytes = await this.files.read(legacy.name, legacy.bytes, 0, legacy.bytes);
        access = projectLogAccess(bytes, legacy.recordIds, state.storeId);
      } catch {
        // Preserve damaged evidence and fail closed for restricted readers, but do not
        // let optional access repair prevent healthy writes or ordinary retention.
      }
      if (access) {
        await this.#makeRoom(state, 0, 0, state.policy.effective, {
          access: { name: legacy.name, value: access },
        });
        const index = state.segments.findIndex((segment) => segment.name === legacy.name);
        if (index >= 0) {
          // makeRoom may have retired attachments; preserve its current governance state.
          state.segments[index] = { ...state.segments[index]!, access };
          await this.#save(state);
        }
      }
    }
    if (state.policy.desired) {
      let fits = false;
      try {
        await this.#makeRoom(state, 0, 0, policy);
        // Metadata's own peak must fit the smaller reserve before confirming the change.
        if (logJson(state).length + 128 > policy.governanceBytes / 3)
          throw new LogReclaimPendingError("治理状态尚未收缩");
        fits = true;
      } catch (error) {
        if (!(error instanceof LogReclaimPendingError)) throw error;
        if (state.policy.blocked !== "reclaim-pending") {
          state.policy = { ...state.policy, blocked: "reclaim-pending" };
          await this.#save(state);
        }
      }
      if (fits) {
        state.policy = { version: state.policy.version + 1, effective: policy };
        // A failed publication ends this transaction. Recovery alone decides
        // whether the prepared generation became durable; never publish over it.
        await this.#save(state);
      }
    }
    if (state.migration) {
      const before = JSON.stringify(state.migration);
      try {
        await this.#makeRoom(state, 0, 0);
        const inventory = await this.#inventory();
        const registered = new Set([...(state.legacy ?? []).map((entry) => entry.name), ...state.pending.map((entry) => entry.name)]);
        const allRegistered = [...inventory.keys()].filter(isLegacyFile).every((name) => registered.has(name));
        state.migration = { state: allRegistered && !state.pending.some((entry) => isLegacyFile(entry.name)) ? "confirmed" : "pending", checkedAt: state.migration.checkedAt, ...(allRegistered ? {} : { reason: "inventory-pending" }) };
      } catch (error) {
        if (!(error instanceof LogReclaimPendingError)) throw error;
        state.migration = { state: "pending", checkedAt: state.migration.checkedAt, reason: "reclaim-pending" };
      }
      if (JSON.stringify(state.migration) !== before) await this.#save(state);
    }
  }
  async #status(state: LogStoreSnapshot): Promise<LogStatus> {
    const inventory = await this.#inventory(true);
    const bytes = [...inventory.values()].reduce((sum, item) => sum + item.bytes, 0);
    const changedLegacy = [...inventory].some(([name, info]) => isLegacyFile(name) && !state.legacy?.some((entry) => entry.name === name && entry.identity === info.identity && entry.bytes === info.bytes));
    const migration = state.migration?.state === "confirmed" && (changedLegacy || bytes > state.policy.effective.maxBytes || inventory.size > state.policy.effective.maxFiles)
      ? { ...state.migration, state: "pending" as const, reason: "inventory-changed" } : state.migration;
    return {
      storeId: state.storeId,
      layout: "zxlog/1",
      policy: state.policy,
      bytes,
      files: inventory.size,
      retainedSegments: state.segments.length,
      pendingReclaims: state.pending.length,
      overdue: state.segments.some(
        (segment) =>
          this.#now() - segment.receivedAt >=
          (segment.tier === "critical"
            ? state.policy.effective.criticalTtlMs
            : state.policy.effective.detailTtlMs),
      ),
      upper: state.upper,
      ...(state.gaps ? { recovery: { unconfirmedFiles: state.gaps, ...(state.lastRecoveryAt !== undefined ? { lastObservedAt: state.lastRecoveryAt } : {}) } } : {}),
      ...(migration ? { migration: { ...migration, legacyFiles: state.legacy?.length ?? 0, catalog: `zxlog://${state.storeId}/legacy/catalog`, lastObserved: true as const } } : {}),
    };
  }

  async #retireDetails(state: LogStoreSnapshot, segment: LogSegment): Promise<void> {
    const names = new Set(await this.#list());
    for (const detail of segment.attachments)
      if (names.has(detail.name))
        state.pending.push({
          name: detail.name,
          ...(await this.files.stat(detail.name)),
          reclaimed: false,
        });
    state.segments = state.segments.map((item) =>
      item === segment ? { ...item, attachments: [] } : item,
    );
    await this.#save(state);
    await this.#reclaimPending(state);
  }
}

export function indexName(segment: string): string {
  return segment.replace(/^segment-/u, "index-").replace(/jsonl$/u, "json");
}

function extendSegment(prior: LogSegment, addition: LogSegment): LogSegment {
  return { ...prior, bytes: prior.bytes + addition.bytes, end: addition.end,
    recordIds: [...prior.recordIds, ...addition.recordIds], ordinals: [...prior.ordinals!, ...addition.ordinals!],
    access: [...prior.access!, ...addition.access!.map(entry => ({ ...entry, offset: prior.bytes + entry.offset }))],
    attachments: [...prior.attachments, ...addition.attachments] };
}

function segmentRanges(segment: LogSegment): { start: number; end: number }[] {
  if (!segment.ordinals) return [{ start: segment.start, end: segment.end }];
  const ranges: { start: number; end: number }[] = [];
  for (const ordinal of segment.ordinals) {
    const last = ranges.at(-1);
    if (last?.end === ordinal - 1) last.end = ordinal;
    else ranges.push({ start: ordinal, end: ordinal });
  }
  return ranges;
}

async function sequentialStats(files: LogFileSystem, names: readonly string[]): Promise<LogFileInfo[]> {
  const result: LogFileInfo[] = [];
  for (const name of names) result.push(await files.stat(name));
  return result;
}

function meteredFiles(
  files: LogFileSystem,
  claim: (dimension: "readBytes" | "writeBytes" | "ioOperations", amount: number) => void,
  changed: (...names: string[]) => void,
): LogFileSystem {
  const io = (count = 1): void => claim("ioOperations", count);
  const measured: LogFileSystem = {
    open: async (readOnly) => {
      io(8);
      await files.open(readOnly);
    },
    list: async (limit) => {
      io();
      return files.list(limit);
    },
    stat: async (name) => {
      io();
      return files.stat(name);
    },
    ...(files.statMany ? { statMany: async (names: readonly string[]) => {
      io(names.length);
      return files.statMany!(names);
    } } : {}),
    read: async (name, size, offset, limit, identity, prefix) => {
      io();
      claim("readBytes", limit);
      return files.read(name, size, offset, limit, identity, prefix);
    },
    ...(files.append ? { append: async (name: string, identity: string, offset: number, bytes: Uint8Array) => {
      io(); claim("writeBytes", bytes.byteLength); changed(name);
      await files.append!(name, identity, offset, bytes);
    } } : {}),
    write: async (name, bytes) => {
      io();
      claim("writeBytes", bytes.byteLength);
      changed(name);
      await files.write(name, bytes);
    },
    rename: async (from, to) => {
      io();
      changed(from, to);
      await files.rename(from, to);
    },
    truncate: async (name, identity, bytes) => {
      io();
      changed(name);
      await files.truncate(name, identity, bytes);
    },
    remove: async (name, identity) => {
      io();
      changed(name);
      await files.remove(name, identity);
    },
    sync: async () => {
      io();
      await files.sync();
    },
    tryLock: async () => {
      io();
      return files.tryLock();
    },
    tryReadLock: async () => {
      io();
      return files.tryReadLock();
    },
    unlock: async () => {
      await files.unlock();
    },
    close: async () => {
      await files.close();
    },
  };
  // Preserve the physical operation and finite native cause at the first trusted boundary.
  return Object.fromEntries(Object.entries(measured).map(([operation, method]) => [operation, async (...args: unknown[]) => {
    try { return await Reflect.apply(method, measured, args); }
    catch (error) {
      throw new LogStorageError(logStorageFailure(error), error instanceof Error ? error.message : `日志文件操作 ${operation} 未完成`, { ...logFailureEvidence(error), operation: `files.${operation}` });
    }
  }])) as unknown as LogFileSystem;
}
