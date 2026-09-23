import { createHash, randomUUID } from "node:crypto";
import type {
  DeviceCapacityArbiterPort,
  DeviceCapacityBudget,
  DeviceCapacityStepPermit,
} from "../resources/device-capacity.js";
import { LogAppendIndeterminateError } from "./contracts.js";
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
import { projectLogAccess, validLogAccess, type LogRecordAccess } from "./access-projection.js";

export interface LogFileInfo {
  readonly bytes: number;
  readonly identity: string;
}
/** Bound to one private log root. Implementations reject links and operate relative to an open directory. */
export interface LogFileSystem {
  open(readOnly: boolean): Promise<void>;
  list(limit: number): Promise<readonly string[]>;
  stat(name: string): Promise<LogFileInfo>;
  read(name: string, size: number, offset: number, limit: number): Promise<Uint8Array>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  truncate(name: string, identity: string, bytes: number): Promise<void>;
  remove(name: string): Promise<void>;
  sync(): Promise<void>;
  tryLock(): Promise<boolean>;
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
}
const STATE = /^state-(\d{12})\.json$/u;
const HEAD = /^published-(\d{12})\.head$/u;
const RECOVERY_RESERVE = 8192;
const OWNED =
  /^(?:published-\d{12}\.head|segment-[a-f0-9-]{36}\.jsonl|detail-[a-f0-9-]{36}\.json|index-[a-f0-9-]{36}\.json|state-\d{12}\.(?:json|new))$/u;
const CONTROL_FILES = 7;
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
  #closed = false;
  #permit: DeviceCapacityStepPermit | undefined;

  constructor(options: {
    files: LogFileSystem;
    capacity: DeviceCapacityArbiterPort;
    initialPolicy?: LogPolicy;
    now?: () => number;
  }) {
    this.files = meteredFiles(options.files, (dimension, amount) => {
      if (!this.#permit) throw Error("日志物理操作缺少资源许可");
      this.#permit.claim(dimension, amount);
    });
    this.#capacity = options.capacity;
    this.#initial = validateLogPolicy(options.initialPolicy ?? DEFAULT_LOG_POLICY);
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<LogStatus> {
    return this.#step(true, async () => {
      let state = await this.#load(true);
      if (!state) {
        const names = await this.files.list(4096);
        if (names.some((name) => name !== "writer.lock"))
          throw Error("日志存储缺少可信元信息，未重置目录");
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
      await this.#recover(state);
      await this.#maintenance(state);
      return this.#status(state);
    });
  }

  async append(input: readonly LogCapture[]): Promise<LogAppendReceipt> {
    if (input.length > 8) throw Error("日志批次超限");
    let wrote = false,
      committed: LogAppendReceipt | undefined;
    try {
      return await this.#step(true, async () => {
        const state = await this.#required(true);
        await this.#recover(state);
        await this.#maintenance(state);
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
            throw Error("日志记录超过生效限额");
        }
        const tiers: {
          tier: LogTier;
          entries: LogCapture[];
          estimatedBytes: number;
        }[] = [];
        for (const entry of accepted) {
          const estimatedBytes = Buffer.byteLength(JSON.stringify(entry.record)) + 512;
          const last = tiers.at(-1);
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
        let ordinal = state.upper;
        const batches = tiers.map((group) => {
          const name = `segment-${randomUUID()}.jsonl`;
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
          if (bytes.length > policy.segmentBytes) throw Error("日志批次超过分段限额");
          const segment: LogSegment = {
            name,
            bytes: bytes.length,
            start: ordinal + 1,
            end: ordinal + records.length,
            receivedAt: now,
            tier: group.tier,
            recordIds: records.map((record) => record.id),
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
          ordinal += records.length;
          return { segment, records, attachments, bytes };
        });
        const newSegments = batches.map((batch) => batch.segment);
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
          { append: newSegments },
        );
        wrote = true;
        for (const batch of batches) {
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
          await this.files.write(batch.segment.name, bytes);
          batch.segment = {
            ...batch.segment,
            bytes: bytes.length,
            access: projectLogAccess(bytes, batch.segment.recordIds, state.storeId),
            attachments: batch.segment.attachments.filter((item) =>
              batch.records.some((record) => record.detail?.name === item.name),
            ),
          };
        }
        await this.files.sync();
        state.segments.push(...batches.map((batch) => batch.segment));
        state.upper = ordinal;
        // One publication for every tier in this batch. Unknown acknowledgements are never replayed.
        await this.#save(state);
        return (committed = { policy: state.policy });
      });
    } catch (error) {
      if (committed) return { ...committed, storageDegraded: true };
      if (wrote) throw new LogAppendIndeterminateError();
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

  async applyPolicy(desired: LogPolicy, expectedVersion: number): Promise<LogStatus> {
    const validated = validateLogPolicy(desired);
    return this.#step(true, async () => {
      const state = await this.#required(true);
      if (state.policy.version !== expectedVersion) throw Error("日志策略已变化，请重新读取后提交");
      if (state.policy.desired) throw Error("日志策略正在应用");
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
    return this.read((state) => this.#status(state));
  }

  async rebuildIndex(): Promise<boolean> {
    return this.#step(true, async () => {
      const state = await this.#required(true),
        names = new Set(await this.files.list(4096));
      const segment = state.segments.find((item) => !names.has(indexName(item.name)));
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
    await this.files.close();
  }

  async #step<T>(write: boolean, work: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#busy) throw Error("日志存储暂不可用");
    this.#busy = true;
    let releaseLock = false;
    try {
      const admission = await this.#capacity.acquire(
        {
          admissionId: `logging:${randomUUID()}`,
          serviceClass: "storage-background",
          atomic: STEP,
          preferred: STEP,
          maxWaitMs: 250,
        },
        this.#abort.signal,
      );
      if (admission.kind !== "granted") throw Error("日志存储资源暂不可用");
      const step = admission.permit.tryBegin(STEP);
      if (!step) {
        admission.permit.release();
        throw Error("日志存储步骤受阻");
      }
      // Reserve the entire bounded step before taking the cross-process lock.
      try {
        this.#permit = step;
        await this.files.open(!write);
        if (write) {
          releaseLock = await this.files.tryLock();
          if (!releaseLock) throw Error("日志存储正在维护");
        }
        return await work();
      } finally {
        try {
          if (releaseLock) await this.files.unlock();
        } finally {
          this.#permit = undefined;
          step.complete();
          admission.permit.release();
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  async #load(recover = false): Promise<LogStoreSnapshot | undefined> {
    if (recover) await this.#recoverPublication();
    const names = (await this.files.list(4096)).filter((name) => HEAD.test(name)).sort();
    if (!names.length) return undefined;
    return this.#readState(names.at(-1)!.replace("published-", "state-").replace(/head$/u, "json"));
  }
  async #required(recover = false): Promise<LogStoreSnapshot> {
    const state = await this.#load(recover);
    if (!state) throw Error("日志存储尚未初始化");
    return state;
  }
  async #recoverPublication(): Promise<void> {
    const names = await this.files.list(4096);
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
          names.every((entry) => entry === name || entry === "writer.lock");
        if (initialTorn || (published > 0 && name.endsWith(".new"))) {
          await this.#erase(name);
          continue;
        }
        throw error;
      }
      if (published > 0) {
        const previous = await this.#readState(`state-${String(published).padStart(12, "0")}.json`);
        if (candidate.storeId !== previous.storeId || candidate.upper < previous.upper)
          throw Error("日志发布身份或水位回退");
      }
      // Complete candidates preserve observation identity, even if a final namespace barrier failed.
      for (const segment of candidate.segments) {
        for (const file of [{ name: segment.name, bytes: segment.bytes }, ...segment.attachments]) {
          const actual = await this.files.stat(file.name);
          if (actual.bytes !== file.bytes) throw Error("日志发布候选引用不完整");
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
    if (info.bytes > 4 * 1024 * 1024) throw Error("日志治理文件超限");
    const envelope = JSON.parse(
      Buffer.from(await this.files.read(name, info.bytes, 0, info.bytes)).toString("utf8"),
    ) as { digest: string; state: LogStoreSnapshot };
    const state = envelope.state;
    if (
      !state ||
      state.layout !== "zxlog/1" ||
      logDigest(JSON.stringify(state)) !== envelope.digest ||
      !/^[a-f0-9-]{36}$/u.test(state.storeId) ||
      !Number.isSafeInteger(state.generation) ||
      !Number.isSafeInteger(state.upper) ||
      !Array.isArray(state.segments) ||
      !Array.isArray(state.pending) ||
      !Array.isArray(state.retired)
    )
      throw Error("日志治理文件损坏");
    if (
      state.generation !== Number(name.slice(6, 18)) ||
      state.generation < 1 ||
      state.upper < 0 ||
      !Number.isSafeInteger(state.policy.version) ||
      state.policy.version < 1
    )
      throw Error("日志治理代际损坏");
    validateLogPolicy(state.policy.effective);
    if (state.policy.desired) validateLogPolicy(state.policy.desired);
    if (state.segments.length > 4096 || state.pending.length > 4096 || state.retired.length > 64)
      throw Error("日志治理状态超限");
    let previousEnd = 0;
    for (const segment of state.segments) {
      if (
        !/^segment-[a-f0-9-]{36}\.jsonl$/u.test(segment.name) ||
        !Number.isSafeInteger(segment.bytes) ||
        segment.bytes <= 0 ||
        segment.bytes > 8 * 1024 * 1024 ||
        !Number.isSafeInteger(segment.start) ||
        !Number.isSafeInteger(segment.end) ||
        segment.start <= previousEnd ||
        segment.end < segment.start ||
        segment.end > state.upper ||
        !Array.isArray(segment.recordIds) ||
        segment.recordIds.length !== segment.end - segment.start + 1 ||
        segment.recordIds.length > 8 ||
        segment.recordIds.some((id) => !/^[a-f0-9-]{36}$/u.test(id)) ||
        !Array.isArray(segment.attachments) ||
        segment.attachments.length > 8 ||
        !["critical", "detail"].includes(segment.tier) ||
        !Number.isSafeInteger(segment.receivedAt)
      )
        throw Error("日志段元信息损坏");
      for (const detail of segment.attachments)
        if (
          !/^detail-[a-f0-9-]{36}\.json$/u.test(detail.name) ||
          !Number.isSafeInteger(detail.bytes) ||
          detail.bytes <= 0 ||
          detail.bytes > 1024 * 1024
        )
          throw Error("日志详情元信息损坏");
      if (
        segment.access !== undefined &&
        !validLogAccess(segment.access, segment.recordIds.length, segment.bytes)
      )
        throw Error("日志访问投影损坏");
      previousEnd = segment.end;
    }
    for (const item of state.pending)
      if (
        !OWNED.test(item.name) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        typeof item.identity !== "string" ||
        item.identity.length > 128 ||
        typeof item.reclaimed !== "boolean"
      )
        throw Error("日志回收状态损坏");
    return state;
  }
  async #save(state: LogStoreSnapshot): Promise<void> {
    const names = await this.files.list(4096);
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
      throw Error("日志治理预留不足");
    const stem = `state-${String(state.generation).padStart(12, "0")}`;
    const inventory = await this.#inventory();
    if (
      [...inventory.values()].reduce((sum, item) => sum + item.bytes, content.length) >
        state.policy.effective.maxBytes ||
      inventory.size + 2 > state.policy.effective.maxFiles
    )
      throw Error("日志治理发布缺少预算");
    await this.files.write(`${stem}.new`, content);
    await this.files.sync();
    await this.files.rename(`${stem}.new`, `${stem}.json`);
    await this.files.sync();
    // Visibility follows the durability proof; the marker contains no mutable state.
    await this.files.write(stem.replace("state-", "published-") + ".head", new Uint8Array());
    await this.files.sync();
  }

  async #inventory(): Promise<Map<string, LogFileInfo>> {
    const result = new Map<string, LogFileInfo>();
    for (const name of await this.files.list(4096)) {
      if (name !== "writer.lock" && !OWNED.test(name))
        throw Error("日志根含未登记文件，已停止写入");
      result.set(name, await this.files.stat(name));
    }
    return result;
  }
  async #erase(name: string): Promise<void> {
    const info = await this.files.stat(name);
    await this.files.truncate(name, info.identity, 0);
    await this.files.remove(name);
    await this.files.sync();
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
    // An unpublished governance candidate has no evidence rights. Reclaim it first
    // so recovery never needs a fourth full snapshot's unreserved peak.
    for (const [name] of inventory)
      if (/^state-\d{12}\.new$/u.test(name)) {
        await this.#erase(name);
        inventory.delete(name);
        state.gaps++;
      }
    const orphans = [...inventory].filter(
      ([name]) =>
        name !== "writer.lock" && !STATE.test(name) && !HEAD.test(name) && !known.has(name),
    );
    for (const [name, info] of orphans.slice(0, 8)) {
      state.pending.push({ name, ...info, reclaimed: false });
      state.gaps++;
    }
    if (orphans.length) {
      await this.#save(state);
      await this.#reclaimPending(state);
    }
  }
  async #reclaimPending(state: LogStoreSnapshot): Promise<void> {
    for (const item of [...state.pending].slice(0, 16)) {
      if (!item.reclaimed) {
        const actual = await this.files.stat(item.name);
        if (actual.identity !== item.identity) throw Error("待回收日志文件已替换");
        await this.files.truncate(item.name, item.identity, 0);
        item.reclaimed = true;
        item.bytes = 0;
        await this.#save(state);
      }
      const names = await this.files.list(4096);
      if (names.includes(item.name)) {
        const actual = await this.files.stat(item.name);
        if (actual.identity !== item.identity || actual.bytes !== 0)
          throw Error("待回收日志空间未确认");
        await this.files.remove(item.name);
        await this.files.sync();
      }
      state.pending = state.pending.filter((entry) => entry !== item);
      await this.#save(state);
    }
  }
  async #retire(state: LogStoreSnapshot, segment: LogSegment, reason: string): Promise<void> {
    const names = new Set(await this.files.list(4096));
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
    state.retired.push({
      start: segment.start,
      end: segment.end,
      at: this.#now(),
      reason,
    });
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
      access?: { name: string; value: readonly LogRecordAccess[] };
    } = {},
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt++) {
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
              segment.name === changes.access?.name
                ? { ...segment, access: changes.access.value }
                : segment,
            ),
            ...(changes.append ?? []),
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
      const withDetails = state.segments.find((segment) => segment.attachments.length > 0);
      if (withDetails) {
        await this.#retireDetails(state, withDetails);
        continue;
      }
      const next = [...state.segments].sort(
        (a, b) =>
          (a.tier === b.tier ? 0 : a.tier === "detail" ? -1 : 1) || a.receivedAt - b.receivedAt,
      )[0];
      if (!next) throw Error("日志容量已满，空间尚未回收");
      await this.#retire(state, next, "capacity");
    }
    throw Error("日志回收仍在进行");
  }
  async #maintenance(state: LogStoreSnapshot): Promise<void> {
    const now = this.#now(),
      policy = state.policy.desired ?? state.policy.effective;
    for (const segment of [...state.segments]
      .filter(
        (item) =>
          now - item.receivedAt >=
          (item.tier === "critical" ? policy.criticalTtlMs : policy.detailTtlMs),
      )
      .slice(0, 4))
      await this.#retire(state, segment, "retention");
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
      try {
        await this.#makeRoom(state, 0, 0, policy);
        // Metadata's own peak must fit the smaller reserve before confirming the change.
        if (logJson(state).length + 128 > policy.governanceBytes / 3)
          throw Error("治理状态尚未收缩");
        state.policy = { version: state.policy.version + 1, effective: policy };
        await this.#save(state);
      } catch {
        state.policy = { ...state.policy, blocked: "reclaim-pending" };
        await this.#save(state);
      }
    }
  }
  async #status(state: LogStoreSnapshot): Promise<LogStatus> {
    const inventory = await this.#inventory();
    return {
      storeId: state.storeId,
      layout: "zxlog/1",
      policy: state.policy,
      bytes: [...inventory.values()].reduce((sum, item) => sum + item.bytes, 0),
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
    };
  }

  async #retireDetails(state: LogStoreSnapshot, segment: LogSegment): Promise<void> {
    const names = new Set(await this.files.list(4096));
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

function meteredFiles(
  files: LogFileSystem,
  claim: (dimension: "readBytes" | "writeBytes" | "ioOperations", amount: number) => void,
): LogFileSystem {
  const io = (count = 1): void => claim("ioOperations", count);
  return {
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
    read: async (name, size, offset, limit) => {
      io();
      claim("readBytes", limit);
      return files.read(name, size, offset, limit);
    },
    write: async (name, bytes) => {
      io();
      claim("writeBytes", bytes.byteLength);
      await files.write(name, bytes);
    },
    rename: async (from, to) => {
      io();
      await files.rename(from, to);
    },
    truncate: async (name, identity, bytes) => {
      io();
      await files.truncate(name, identity, bytes);
    },
    remove: async (name) => {
      io();
      await files.remove(name);
    },
    sync: async () => {
      io();
      await files.sync();
    },
    tryLock: async () => {
      io();
      return files.tryLock();
    },
    unlock: async () => {
      await files.unlock();
    },
    close: async () => {
      await files.close();
    },
  };
}
