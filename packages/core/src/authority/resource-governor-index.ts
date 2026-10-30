/**
 * 资源调控器的按键持久投影。调控记录按键落在 DPI 上：预留、用量、用量预留、序号、排队、出队与
 * 公平队列各有自己的键，成组判断（同工作负载的活动根、活动子预留、未结用量预留、活动预留集合、
 * 已结用量块）走二级索引。归约原样复用 applyGovernorRecordAt，只是运行在“只装了所需键”的工作集上：
 * 读到未装入的键就抛出待装入，装入后从头重做这一条记录或这一次决定。
 *
 * 保留：终态根（depth=0 的 released/reclaimed）过保留期后在逻辑上不存在。保留前沿由归约按信封时间
 * 派生（前沿 = 已见信封时间的最大值减保留期，只增不减），读取时据此遮蔽；物理清理是另一步，
 * 按页有界进行，失败保留进度。依附在根上的行都带根租约摘要，同名根换代后旧行不会复活。
 */
import { createHash } from "node:crypto";
import type { AdmissionClass, RootResourceWorkload } from "../contracts/authorization.js";
import type { CommitEnvelope, JsonValue, LogicalRecord } from "../contracts/index.js";
import type { GovernorRecord } from "../contracts/records.js";
import { canonicalize } from "../protocol/canonical.js";
import {
  ADMISSION_CLASSES,
  GOVERNOR_TERMINAL_RETENTION_MS,
  applyGovernorRecordAt,
  rootResourceWorkloadKey,
  type GovernorIndexReads,
  type GovernorProjection,
  type ResourceBudgetUsage,
  type ResourceReservationProjection,
} from "../protocol/resource-governor.js";
import type { ResourceLeaseSignatureVerifier } from "../protocol/resource-lease.js";
import type {
  DurableProjectionMutation,
  DurableProjectionReadContext,
  RebuildableDurableProjectionIndex,
} from "./durable-projection-index.js";
import { readDurableProjectionKeys } from "./durable-projection-index.js";
import type { AuthorityCommitLog, ProjectionTransactionContext } from "./interfaces.js";
import { AuthorityPreparationRequired } from "./recovery-work.js";

export const RESOURCE_GOVERNOR_INDEX_PROJECTION_ID = "resource-governor-index-v1";
const REDUCER_VERSION = 2;
const GOVERNOR_STREAM = "governor";
const FAIR_KEY = "fair";
const FRONTIER_KEY = "f";
/** 最后一封调控信封的位置：会话据此判断已装入的键是否仍是最新。 */
const HEAD_KEY = "h";
const PAGE_LIMIT = 256;
/** 复用会话的工作集上限：超过后换新会话，进程内常驻的已装入键有界。 */
const MAX_REUSED_SESSION_KEYS = 4096;

type Acceptance = { readonly leaseDigest: string; readonly acceptedAt: string; readonly validForMs: number };
type UsageEntry = { readonly rootReservationId: string; readonly reservationId: string; readonly usageSeq: number; readonly usage: ResourceBudgetUsage };
type UsageReservationEntry = {
  readonly rootReservationId: string;
  readonly reservationId: string;
  readonly usage: ResourceBudgetUsage;
  state: "reserved" | "consumed";
};
type FairState = { queues: Record<AdmissionClass, string[]>; deficits: Record<AdmissionClass, number>; cursor: number };
type MapName =
  | "reservations" | "leaseAcceptances" | "usages" | "usageReservations" | "nextUsageSeqByRoot"
  | "queued" | "queuedWorkloads" | "queuedByWorkload" | "dequeued" | "dequeuedAt";

/** 一页二级索引：前缀加可选的键区间。 */
interface IndexPage { readonly prefix: string; readonly gte?: string; readonly lte?: string }
type GovernorNeed = { readonly key: string } | { readonly page: IndexPage } | { readonly fair: true };

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const ordinalOf = (lsn: number, item: number) => `${String(lsn).padStart(16, "0")}:${String(item).padStart(6, "0")}`;
const seqKey = (seq: number) => String(seq).padStart(16, "0");
const pageId = (page: IndexPage) => canonicalize(page as unknown as JsonValue);

const keys = {
  reservation: (id: string) => `r:${id}`,
  usage: (id: string) => `u:${id}`,
  usageReservation: (id: string) => `ur:${id}`,
  seq: (root: string) => `s:${root}`,
  queued: (id: string) => `q:${id}`,
  queuedByWorkload: (workload: string) => `qw:${workload}`,
  dequeued: (workload: string) => `d:${workload}`,
  active: (id: string) => `ix:ac:${id}`,
  child: (parent: string, id: string) => `ix:ch:${hash(parent)}:${hash(id)}`,
  workloadRoot: (workload: string, root: string) => `ix:wr:${hash(workload)}:${hash(root)}`,
  openByReservation: (reservation: string, ordinal: string) => `ix:uo:${hash(reservation)}:${ordinal}`,
  openByRoot: (root: string, ordinal: string) => `ix:ur:${hash(root)}:${ordinal}`,
  // 依附在根上的行带根代际（根租约摘要）：同名根换代后两代的行互不相同，清理旧代只碰旧代的行
  usageBlock: (root: string, rd: string, seq: number) => `ix:ub:${hash(root)}:${hash(rd)}:${seqKey(seq)}`,
  rootReservation: (root: string, rd: string, id: string) => `ix:rr:${hash(root)}:${hash(rd)}:${hash(id)}`,
  rootUsage: (root: string, rd: string, id: string) => `ix:ru:${hash(root)}:${hash(rd)}:${hash(id)}`,
  terminalRoot: (at: string, root: string) => `ix:tr:${at}:${hash(root)}`,
  dequeuedAt: (at: string, workload: string) => `ix:td:${at}:${hash(workload)}`,
};
const pages = {
  active: (): IndexPage => ({ prefix: "ix:ac:" }),
  children: (parent: string): IndexPage => ({ prefix: `ix:ch:${hash(parent)}:` }),
  workloadRoots: (workload: string): IndexPage => ({ prefix: `ix:wr:${hash(workload)}:` }),
  openByReservation: (reservation: string): IndexPage => ({ prefix: `ix:uo:${hash(reservation)}:` }),
  openByRoot: (root: string): IndexPage => ({ prefix: `ix:ur:${hash(root)}:` }),
  usageBlock: (root: string, rd: string, from: number, to: number): IndexPage => {
    const prefix = `ix:ub:${hash(root)}:${hash(rd)}:`;
    return { prefix, gte: `${prefix}${seqKey(from)}`, lte: `${prefix}${seqKey(to)}` };
  },
};

/**
 * 保留前沿：信封或本地时间减保留期并向下取整到分钟，与已有前沿取较晚者（时钟回拨也不让已遮蔽的行
 * 回来）。取整只会多保留不足一分钟，同一分钟内的判断与归约用同一前沿。
 */
export function governorRetentionCutoff(at: string, previous?: string): string {
  const instant = Date.parse(at) - GOVERNOR_TERMINAL_RETENTION_MS;
  const cutoff = new Date(instant - instant % 60_000).toISOString();
  return previous !== undefined && previous > cutoff ? previous : cutoff;
}

/**
 * 工作集缺键：同步判断里读到未装入的状态。带的 prepareOutside 在锁外把这些键装入原工作集，
 * 日志与协调层按“准备后重做”的既有口径重跑。
 */
export class GovernorStateRequired extends AuthorityPreparationRequired {
  constructor(readonly needs: readonly GovernorNeed[], load?: () => Promise<void>) {
    super([]);
    this.name = "GovernorStateRequired";
    this.message = "Resource governor state is being loaded";
    // 同一次缺键只装一次：日志在持外层串行权时先在后台发起，协调者随后等待的是同一次装入
    if (load) { let pending: Promise<void> | undefined; this.prepareOutside = () => pending ??= load(); }
  }
}

class WorkingSetIterationError extends TypeError {
  constructor() { super("Resource governor working set is keyed and cannot be enumerated"); }
}

/** 只装已读到键的映射：未装入的键读取即抛出待装入；不能遍历或计数。 */
class LazyMap<V> extends Map<string, V> {
  constructor(readonly name: MapName, readonly owner: GovernorWorkingSet) { super(); }
  override get(key: string): V | undefined { this.owner.require(this.name, key); return super.get(key); }
  override has(key: string): boolean { this.owner.require(this.name, key); return super.has(key); }
  override set(key: string, value: V): this { this.owner?.touch(this.name, key); return super.set(key, value); }
  override delete(key: string): boolean { this.owner.touch(this.name, key); return super.delete(key); }
  /** 装入：不记为改动。 */
  load(key: string, value: V | undefined): void { if (value === undefined) super.delete(key); else super.set(key, value); }
  peek(key: string): V | undefined { return super.get(key); }
  override get size(): number { throw new WorkingSetIterationError(); }
  override keys(): MapIterator<string> { throw new WorkingSetIterationError(); }
  override values(): MapIterator<V> { throw new WorkingSetIterationError(); }
  override entries(): MapIterator<[string, V]> { throw new WorkingSetIterationError(); }
  override forEach(): void { throw new WorkingSetIterationError(); }
  override [Symbol.iterator](): MapIterator<[string, V]> { throw new WorkingSetIterationError(); }
  override clear(): void { throw new WorkingSetIterationError(); }
  /** 内部遍历已装入的条目（复制与比较用）。 */
  loaded(): [string, V][] { return [...super.entries()]; }
}

const MAP_KEY: Record<MapName, (key: string) => string> = {
  reservations: keys.reservation,
  leaseAcceptances: keys.reservation,
  usages: keys.usage,
  usageReservations: keys.usageReservation,
  nextUsageSeqByRoot: keys.seq,
  queued: keys.queued,
  queuedWorkloads: keys.queued,
  queuedByWorkload: keys.queuedByWorkload,
  dequeued: keys.dequeued,
  dequeuedAt: keys.dequeued,
};

interface StoredReservation { readonly p: ResourceReservationProjection; readonly a?: Acceptance; readonly rd: string }
interface StoredUsage { readonly e: UsageEntry; readonly rd: string }
interface StoredUsageReservation { readonly e: UsageReservationEntry; readonly rd: string; readonly o: string }
interface StoredSeq { readonly n: number; readonly rd: string }
interface StoredQueued { readonly c: AdmissionClass; readonly w: RootResourceWorkload }
interface StoredDequeued { readonly r: "cancelled" | "failed" | "expired"; readonly at?: string }

/**
 * 只装入决定所需键的调控投影。映射接口与整份内存投影一致，归约与决定代码不改写法；
 * 成组判断由 index 回答：已装入的索引页加上本工作集内的改动，再按当前状态过滤。
 */
export class GovernorWorkingSet implements GovernorProjection {
  readonly reservations = new LazyMap<ResourceReservationProjection>("reservations", this);
  readonly leaseAcceptances = new LazyMap<Acceptance>("leaseAcceptances", this);
  readonly usages = new LazyMap<UsageEntry>("usages", this);
  readonly nextUsageSeqByRoot = new LazyMap<number>("nextUsageSeqByRoot", this);
  readonly usageReservations = new LazyMap<UsageReservationEntry>("usageReservations", this);
  readonly queued = new LazyMap<AdmissionClass>("queued", this);
  readonly queuedWorkloads = new LazyMap<RootResourceWorkload>("queuedWorkloads", this);
  readonly queuedByWorkload = new LazyMap<string>("queuedByWorkload", this);
  readonly dequeued = new LazyMap<"cancelled" | "failed" | "expired">("dequeued", this);
  readonly dequeuedAt = new LazyMap<string>("dequeuedAt", this);
  readonly index: GovernorIndexReads;
  /** 已装入的键（存在或已知不存在）及其装入时的存储值，比较改动用。 */
  readonly #base = new Map<string, JsonValue | undefined>();
  readonly #dirty = new Set<string>();
  readonly #pages = new Map<string, readonly { readonly key: string; readonly id: string }[]>();
  /** 每条预留所属根的租约摘要；新建的在比较时补算。 */
  readonly #rootDigests = new Map<string, string>();
  readonly #ordinals = new Map<string, string>();
  #fair: FairState | undefined;
  #fairDirty = false;
  #ordinal: string | undefined;
  /** 锁外的会话装入；事务内的复制同样带着它，但事务内的缺键由同一锁会话的视图补齐。 */
  #loader: ((needs: readonly GovernorNeed[]) => Promise<void>) | undefined;

  constructor(readonly cutoff: string) {
    const set = this;
    this.index = {
      activeRootsForWorkload: (workload) => set.#indexed(pages.workloadRoots(workload), "reservations", (id) => {
        const reservation = set.reservations.peek(id);
        return reservation !== undefined && reservation.depth === 0 && isLive(reservation) &&
          rootResourceWorkloadKey(reservation.lease.workload as RootResourceWorkload) === workload;
      }),
      activeChildren: (parent) => set.#indexed(pages.children(parent), "reservations", (id) => {
        const reservation = set.reservations.peek(id);
        return reservation !== undefined && reservation.lease.parentId === parent && isLive(reservation);
      }),
      openUsageByReservation: (reservation) => set.#indexed(pages.openByReservation(reservation), "usageReservations", (id) => {
        const usage = set.usageReservations.peek(id);
        return usage !== undefined && usage.state === "reserved" && usage.reservationId === reservation;
      }),
      openUsageByRoot: (root) => set.#indexed(pages.openByRoot(root), "usageReservations", (id) => {
        const usage = set.usageReservations.peek(id);
        return usage !== undefined && usage.state === "reserved" && usage.rootReservationId === root;
      }),
      openUsageInScope: (scope) => {
        const ids = new Set<string>();
        for (const root of scope.rootReservationIds ?? []) for (const id of this.index.openUsageByRoot(root)) ids.add(id);
        for (const reservation of scope.reservationIds ?? []) for (const id of this.index.openUsageByReservation(reservation)) ids.add(id);
        return [...ids].sort((left, right) => (set.#ordinals.get(left) ?? "").localeCompare(set.#ordinals.get(right) ?? ""));
      },
    };
  }

  get admissionQueues(): Record<AdmissionClass, string[]> { return this.#requireFair().queues; }
  get admissionDeficits(): Record<AdmissionClass, number> { this.#fairDirty = true; return this.#requireFair().deficits; }
  get admissionCursor(): number { return this.#requireFair().cursor; }
  set admissionCursor(value: number) { this.#requireFair().cursor = value; this.#fairDirty = true; }

  #requireFair(): FairState {
    if (!this.#fair) throw this.#missing([{ fair: true }]);
    return this.#fair;
  }

  #missing(needs: readonly GovernorNeed[]): GovernorStateRequired {
    const loader = this.#loader;
    return new GovernorStateRequired(needs, loader && (() => loader(needs)));
  }

  bindLoader(loader: (needs: readonly GovernorNeed[]) => Promise<void>): void { this.#loader = loader; }

  /** 由归约推进的公平队列会原地修改数组：取用即视为改动。 */
  markFairTouched(): void { if (this.#fair) this.#fairDirty = true; }

  require(name: MapName, key: string): void {
    const storage = MAP_KEY[name](key);
    if (!this.#base.has(storage) && !this.#dirty.has(storage)) throw this.#missing([{ key: storage }]);
  }

  touch(name: MapName, key: string): void {
    this.#dirty.add(MAP_KEY[name](key));
  }

  isLoaded(key: string): boolean { return this.#base.has(key) || this.#dirty.has(key); }
  /** 已装入的键数；会话复用时据此限制工作集体量。 */
  get loadedKeys(): number { return this.#base.size + this.#pages.size; }
  satisfies(need: GovernorNeed): boolean {
    return "fair" in need ? this.hasFair() : "key" in need ? this.isLoaded(need.key) : this.hasPage(need.page);
  }
  /** 一次报全给定需求里尚未装入的部分（只抛一次）；全部已装入时不做任何事。 */
  requireNeeds(needs: readonly GovernorNeed[]): void {
    const missing = needs.filter((need) => !this.satisfies(need));
    if (missing.length) throw this.#missing(missing);
  }
  hasPage(page: IndexPage): boolean { return this.#pages.has(pageId(page)); }
  hasFair(): boolean { return this.#fair !== undefined; }

  /** 本条记录的位置序号：新建用量预留的索引键按它排序。 */
  beginRecord(ordinal: string): void { this.#ordinal = ordinal; }

  #indexed(page: IndexPage, mapName: MapName, live: (id: string) => boolean): readonly string[] {
    return this.indexPage(page, mapName).filter(live);
  }

  /**
   * 一页索引的候选：装入时页内的实体，加上本工作集内新建的同类实体（改动过的已装入实体本就在页内）。
   * 调用方再按当前状态过滤。
   */
  indexPage(page: IndexPage, mapName: MapName): string[] {
    const loaded = this.#pages.get(pageId(page));
    if (!loaded) throw this.#missing([{ page }]);
    const candidates = new Set(loaded.map((entry) => entry.id));
    const prefix = MAP_KEY[mapName]("");
    for (const storage of this.#dirty) {
      if (storage.startsWith(prefix) && this.#base.get(storage) === undefined) candidates.add(storage.slice(prefix.length));
    }
    for (const id of candidates) this.require(mapName, id);
    return [...candidates];
  }

  // ---- 装入 ----

  loadStored(key: string, value: JsonValue | undefined): void {
    this.#base.set(key, value);
    if (key === FAIR_KEY) {
      const stored = value as unknown as { q: Record<AdmissionClass, string[]>; d: Record<AdmissionClass, number>; c: number } | undefined;
      this.#fair = stored
        ? { queues: cloneQueues(stored.q), deficits: { ...stored.d }, cursor: stored.c }
        : { queues: emptyQueues(), deficits: emptyCounters(), cursor: 0 };
      return;
    }
    const [prefix] = key.split(":", 1);
    const id = key.slice(prefix!.length + 1);
    switch (prefix) {
      case "r": {
        const stored = value as unknown as StoredReservation | undefined;
        this.reservations.load(id, stored ? cloneReservation(stored.p) : undefined);
        this.leaseAcceptances.load(id, stored?.a ? { ...stored.a } : undefined);
        if (stored) this.#rootDigests.set(id, stored.rd); else this.#rootDigests.delete(id);
        return;
      }
      case "u": {
        const stored = value as unknown as StoredUsage | undefined;
        this.usages.load(id, stored ? { ...stored.e, usage: { ...stored.e.usage } } : undefined);
        return;
      }
      case "ur": {
        const stored = value as unknown as StoredUsageReservation | undefined;
        this.usageReservations.load(id, stored ? { ...stored.e, usage: { ...stored.e.usage } } : undefined);
        if (stored) this.#ordinals.set(id, stored.o);
        return;
      }
      case "s": {
        const stored = value as unknown as StoredSeq | undefined;
        this.nextUsageSeqByRoot.load(id, stored?.n);
        return;
      }
      case "q": {
        const stored = value as unknown as StoredQueued | undefined;
        this.queued.load(id, stored?.c);
        this.queuedWorkloads.load(id, stored ? { ...stored.w } : undefined);
        return;
      }
      case "qw":
        this.queuedByWorkload.load(id, value as string | undefined);
        return;
      case "d": {
        const stored = value as unknown as StoredDequeued | undefined;
        this.dequeued.load(id, stored?.r);
        this.dequeuedAt.load(id, stored?.at);
        return;
      }
      default:
        throw new TypeError(`Unknown resource governor key ${key}`);
    }
  }

  loadPage(page: IndexPage, entries: readonly { readonly key: string; readonly id: string }[]): void {
    this.#pages.set(pageId(page), entries);
  }

  /** 读取已装入的预留，未装入时返回 undefined 而不抛出（清理内存缓存用）。 */
  peekReservation(id: string): { readonly known: boolean; readonly value?: ResourceReservationProjection } {
    const key = keys.reservation(id);
    if (!this.isLoaded(key)) return { known: false };
    const value = this.reservations.peek(id);
    return value === undefined ? { known: true } : { known: true, value };
  }

  peekQueued(id: string): { readonly known: boolean; readonly value?: AdmissionClass } {
    if (!this.isLoaded(keys.queued(id))) return { known: false };
    const value = this.queued.peek(id);
    return value === undefined ? { known: true } : { known: true, value };
  }

  rootDigestOf(id: string): string | undefined { return this.#rootDigests.get(id); }

  // ---- 复制与采纳 ----

  fork(): GovernorWorkingSet {
    const copy = new GovernorWorkingSet(this.cutoff);
    for (const [key, value] of this.#base) copy.#base.set(key, value);
    for (const key of this.#dirty) copy.#dirty.add(key);
    for (const [key, value] of this.#pages) copy.#pages.set(key, value);
    for (const [key, value] of this.#rootDigests) copy.#rootDigests.set(key, value);
    for (const [key, value] of this.#ordinals) copy.#ordinals.set(key, value);
    if (this.#fair) copy.#fair = { queues: cloneQueues(this.#fair.queues), deficits: { ...this.#fair.deficits }, cursor: this.#fair.cursor };
    copy.#fairDirty = this.#fairDirty;
    copy.#ordinal = this.#ordinal;
    copy.#loader = this.#loader;
    for (const [id, value] of this.reservations.loaded()) copy.reservations.load(id, cloneReservation(value));
    for (const [id, value] of this.leaseAcceptances.loaded()) copy.leaseAcceptances.load(id, { ...value });
    for (const [id, value] of this.usages.loaded()) copy.usages.load(id, { ...value, usage: { ...value.usage } });
    for (const [id, value] of this.usageReservations.loaded()) copy.usageReservations.load(id, { ...value, usage: { ...value.usage } });
    for (const [id, value] of this.nextUsageSeqByRoot.loaded()) copy.nextUsageSeqByRoot.load(id, value);
    for (const [id, value] of this.queued.loaded()) copy.queued.load(id, value);
    for (const [id, value] of this.queuedWorkloads.loaded()) copy.queuedWorkloads.load(id, { ...value });
    for (const [id, value] of this.queuedByWorkload.loaded()) copy.queuedByWorkload.load(id, value);
    for (const [id, value] of this.dequeued.loaded()) copy.dequeued.load(id, value);
    for (const [id, value] of this.dequeuedAt.loaded()) copy.dequeuedAt.load(id, value);
    return copy;
  }

  /** 把另一工作集（本工作集的复制加上新装入与改动）的全部内容收为己有。 */
  adopt(other: GovernorWorkingSet): void {
    const replace = <V>(target: LazyMap<V>, source: LazyMap<V>) => {
      for (const [id] of target.loaded()) target.load(id, undefined);
      for (const [id, value] of source.loaded()) target.load(id, value);
    };
    replace(this.reservations, other.reservations);
    replace(this.leaseAcceptances, other.leaseAcceptances);
    replace(this.usages, other.usages);
    replace(this.usageReservations, other.usageReservations);
    replace(this.nextUsageSeqByRoot, other.nextUsageSeqByRoot);
    replace(this.queued, other.queued);
    replace(this.queuedWorkloads, other.queuedWorkloads);
    replace(this.queuedByWorkload, other.queuedByWorkload);
    replace(this.dequeued, other.dequeued);
    replace(this.dequeuedAt, other.dequeuedAt);
    this.#base.clear(); for (const [key, value] of other.#base) this.#base.set(key, value);
    this.#dirty.clear(); for (const key of other.#dirty) this.#dirty.add(key);
    this.#pages.clear(); for (const [key, value] of other.#pages) this.#pages.set(key, value);
    this.#rootDigests.clear(); for (const [key, value] of other.#rootDigests) this.#rootDigests.set(key, value);
    this.#ordinals.clear(); for (const [key, value] of other.#ordinals) this.#ordinals.set(key, value);
    this.#fair = other.#fair;
    this.#fairDirty = other.#fairDirty;
    this.#ordinal = other.#ordinal;
  }

  /**
   * 已提交的改动成为新基线：比较结果写回 #base，改动标记清空；二级索引页已过期，丢弃后按需重读。
   * 用于事务提交后让同一协调期的后续判断看到提交后的状态。
   */
  settle(): void {
    for (const mutation of this.mutations()) {
      if (mutation.key.startsWith("ix:") || mutation.key === FRONTIER_KEY) continue;
      if (mutation.kind === "put") this.#base.set(mutation.key, mutation.value);
      else this.#base.set(mutation.key, undefined);
    }
    for (const key of this.#dirty) if (!this.#base.has(key)) this.#base.set(key, undefined);
    this.#dirty.clear();
    this.#pages.clear();
    this.#fairDirty = false;
  }

  // ---- 比较出持久改动 ----

  /** 本工作集相对装入时的全部持久改动（主键与二级索引）。 */
  mutations(): DurableProjectionMutation[] {
    const out = new Map<string, DurableProjectionMutation>();
    const put = (key: string, value: JsonValue) => out.set(key, { kind: "put", key, value });
    const drop = (key: string) => out.set(key, { kind: "tombstone", key });
    const changed = (key: string, value: JsonValue | undefined) => {
      const before = this.#base.get(key);
      if (value === undefined) {
        // 未装入就删除的键（归约里的盲删）也要落墓碑
        if (before !== undefined || !this.#base.has(key)) drop(key);
      } else if (before === undefined || canonicalize(before) !== canonicalize(value)) {
        put(key, value);
      }
    };
    // 装入后取到的实体可能被归约原地修改：比较全部已装入与改动过的实体键
    const candidates = new Set<string>();
    for (const key of this.#base.keys()) candidates.add(key);
    for (const key of this.#dirty) candidates.add(key);
    for (const storage of candidates) {
      if (storage === FAIR_KEY || storage === FRONTIER_KEY || storage.startsWith("ix:")) continue;
      const [prefix] = storage.split(":", 1);
      const id = storage.slice(prefix!.length + 1);
      const before = this.#base.get(storage);
      switch (prefix) {
        case "r": {
          const reservation = this.reservations.peek(id);
          const acceptance = this.leaseAcceptances.peek(id);
          const rootDigest = reservation ? this.#rootDigestFor(id, reservation) : undefined;
          const value = reservation === undefined ? undefined : {
            p: reservation as unknown as JsonValue,
            ...(acceptance === undefined ? {} : { a: acceptance as unknown as JsonValue }),
            rd: rootDigest!,
          } as unknown as JsonValue;
          changed(storage, value);
          this.#reservationIndex(id, (before as unknown as StoredReservation | undefined)?.p, reservation, rootDigest, put, drop);
          break;
        }
        case "u": {
          const usage = this.usages.peek(id);
          if (usage === undefined) { changed(storage, undefined); break; }
          const rootDigest = this.#rootDigestOfRoot(usage.rootReservationId);
          changed(storage, { e: usage, rd: rootDigest } as unknown as JsonValue);
          if (before === undefined) {
            put(keys.usageBlock(usage.rootReservationId, rootDigest, usage.usageSeq), { id, rd: rootDigest });
            put(keys.rootUsage(usage.rootReservationId, rootDigest, id), { id });
          }
          break;
        }
        case "ur": {
          const reservation = this.usageReservations.peek(id);
          if (reservation === undefined) { changed(storage, undefined); break; }
          const ordinal = this.#ordinals.get(id) ?? this.#ordinal;
          if (ordinal === undefined) throw new TypeError("Resource usage reservation has no source position");
          this.#ordinals.set(id, ordinal);
          const rootDigest = this.#rootDigestOfRoot(reservation.rootReservationId);
          changed(storage, { e: reservation, rd: rootDigest, o: ordinal } as unknown as JsonValue);
          const open = reservation.state === "reserved";
          const wasOpen = (before as unknown as StoredUsageReservation | undefined)?.e.state === "reserved";
          const byReservation = keys.openByReservation(reservation.reservationId, ordinal);
          const byRoot = keys.openByRoot(reservation.rootReservationId, ordinal);
          if (open && !wasOpen) { put(byReservation, { id }); put(byRoot, { id }); }
          if (!open && wasOpen) { drop(byReservation); drop(byRoot); }
          if (before === undefined) put(keys.rootUsage(reservation.rootReservationId, rootDigest, id), { id });
          break;
        }
        case "s": {
          const next = this.nextUsageSeqByRoot.peek(id);
          changed(storage, next === undefined ? undefined : { n: next, rd: this.#rootDigestOfRoot(id) } as unknown as JsonValue);
          break;
        }
        case "q": {
          const admissionClass = this.queued.peek(id);
          const workload = this.queuedWorkloads.peek(id);
          changed(storage, admissionClass === undefined || workload === undefined
            ? undefined : { c: admissionClass, w: workload } as unknown as JsonValue);
          break;
        }
        case "qw":
          changed(storage, this.queuedByWorkload.peek(id));
          break;
        case "d": {
          const reason = this.dequeued.peek(id);
          const at = this.dequeuedAt.peek(id);
          changed(storage, reason === undefined ? undefined : { r: reason, ...(at === undefined ? {} : { at }) } as unknown as JsonValue);
          const previous = before as unknown as StoredDequeued | undefined;
          if (reason !== undefined && at !== undefined && previous?.at !== at) put(keys.dequeuedAt(at, id), { wk: id });
          break;
        }
        default:
          throw new TypeError(`Unknown resource governor key ${storage}`);
      }
    }
    if (this.#fairDirty && this.#fair) {
      changed(FAIR_KEY, { q: this.#fair.queues, d: this.#fair.deficits, c: this.#fair.cursor } as unknown as JsonValue);
    }
    return [...out.values()];
  }

  #rootDigestFor(id: string, reservation: ResourceReservationProjection): string {
    const known = this.#rootDigests.get(id);
    if (known !== undefined) return known;
    const digest = reservation.depth === 0
      ? reservation.lease.digest
      : this.#rootDigestOfRoot(reservation.rootReservationId);
    this.#rootDigests.set(id, digest);
    return digest;
  }

  #rootDigestOfRoot(root: string): string {
    const reservation = this.reservations.peek(root);
    if (!reservation || reservation.depth !== 0) throw new TypeError("Resource governor row has no loaded root reservation");
    return this.#rootDigestFor(root, reservation);
  }

  #reservationIndex(
    id: string,
    before: ResourceReservationProjection | undefined,
    after: ResourceReservationProjection | undefined,
    rootDigest: string | undefined,
    put: (key: string, value: JsonValue) => void,
    drop: (key: string) => void,
  ): void {
    const reservation = after ?? before;
    if (!reservation) return;
    const live = after !== undefined && isLive(after);
    const wasLive = before !== undefined && isLive(before);
    // 只在存活状态变化时写索引，记账类改动（用量、子预算）不重复写
    const index = (key: string) => { if (live && !wasLive) put(key, { id }); else if (!live && wasLive) drop(key); };
    index(keys.active(id));
    if (reservation.depth > 0) {
      index(keys.child(reservation.lease.parentId!, id));
    } else {
      const workload = rootResourceWorkloadKey(reservation.lease.workload as RootResourceWorkload);
      index(keys.workloadRoot(workload, id));
      const terminal = (state: ResourceReservationProjection | undefined) =>
        state !== undefined && (state.state === "released" || state.state === "reclaimed") && state.terminalAt !== undefined;
      if (terminal(after) && !terminal(before)) put(keys.terminalRoot(after!.terminalAt!, id), { id, rd: rootDigest! });
    }
    if (before === undefined && after !== undefined) put(keys.rootReservation(after.rootReservationId, rootDigest!, id), { id });
  }
}

function isLive(reservation: ResourceReservationProjection): boolean {
  return reservation.state === "active" || reservation.state === "settled";
}

function cloneReservation(value: ResourceReservationProjection): ResourceReservationProjection {
  return {
    lease: value.lease,
    rootReservationId: value.rootReservationId,
    depth: value.depth,
    used: { ...value.used },
    descendantUsed: { ...value.descendantUsed },
    reservedUsage: { ...value.reservedUsage },
    descendantReservedUsage: { ...value.descendantReservedUsage },
    reservedForChildren: { ...value.reservedForChildren },
    settled: value.settled,
    state: value.state,
    ...(value.terminalAt === undefined ? {} : { terminalAt: value.terminalAt }),
  };
}

function emptyQueues(): Record<AdmissionClass, string[]> {
  return Object.fromEntries(ADMISSION_CLASSES.map((admissionClass) => [admissionClass, []])) as unknown as Record<AdmissionClass, string[]>;
}

function emptyCounters(): Record<AdmissionClass, number> {
  return Object.fromEntries(ADMISSION_CLASSES.map((admissionClass) => [admissionClass, 0])) as unknown as Record<AdmissionClass, number>;
}

function cloneQueues(queues: Record<AdmissionClass, string[]>): Record<AdmissionClass, string[]> {
  return Object.fromEntries(ADMISSION_CLASSES.map((admissionClass) => [admissionClass, [...(queues[admissionClass] ?? [])]])) as unknown as Record<AdmissionClass, string[]>;
}

// ---- 装入：按需要读键与索引页，并按保留前沿与根摘要遮蔽 ----

/**
 * 把缺的键与索引页装入工作集。终态根过前沿视为不存在；依附在根上的行，根已不在或换代
 * （摘要不符）同样视为不存在。索引页一并装入页内实体，免得逐条再缺一轮。
 */
export async function loadGovernorNeeds(
  set: GovernorWorkingSet,
  needs: readonly GovernorNeed[],
  read: DurableProjectionReadContext,
): Promise<void> {
  const wanted: string[] = [];
  for (const need of needs) {
    if ("fair" in need) {
      if (!set.hasFair()) wanted.push(FAIR_KEY);
    } else if ("key" in need) {
      wanted.push(need.key);
    }
  }
  await loadGovernorKeys(set, wanted, read);
  for (const need of needs) {
    if (!("page" in need) || set.hasPage(need.page)) continue;
    const entries: { key: string; id: string }[] = [];
    let continuation: string | undefined;
    do {
      const page = await read.scan({
        ...(need.page.gte === undefined ? { gte: need.page.prefix } : { gte: need.page.gte }),
        ...(need.page.lte === undefined ? { lt: `${need.page.prefix}￿` } : { lte: need.page.lte }),
      }, PAGE_LIMIT, continuation);
      for (const entry of page.entries) entries.push({ key: entry.key, id: (entry.value as { id: string }).id });
      continuation = page.continuation;
    } while (continuation);
    const reservationPage = /^ix:(ac|ch|wr):/u.test(need.page.prefix);
    await loadGovernorKeys(set, entries.map((entry) => reservationPage ? keys.reservation(entry.id)
      : need.page.prefix.startsWith("ix:ub:") ? keys.usage(entry.id) : keys.usageReservation(entry.id)), read);
    set.loadPage(need.page, entries);
  }
}

/**
 * 成批装入键：锁外的每次读取都要进出一次日志锁，逐键读会让一页索引变成数百次加锁。
 * 先整批读取，依附行判断可见性要用的根先装入，再登记本批，最后补齐连带的键
 * （子预留的父链、排队索引指向的排队项）。
 */
async function loadGovernorKeys(
  set: GovernorWorkingSet,
  wanted: readonly string[],
  read: DurableProjectionReadContext,
): Promise<void> {
  let pending = [...new Set(wanted)].filter((key) => !set.isLoaded(key));
  while (pending.length) {
    const fetched = new Map<string, JsonValue | undefined>();
    for (let offset = 0; offset < pending.length; offset += PAGE_LIMIT) {
      const chunk = pending.slice(offset, offset + PAGE_LIMIT);
      const values = await readDurableProjectionKeys(read, chunk);
      chunk.forEach((key, index) => fetched.set(key, values[index]));
    }
    const roots = new Set<string>();
    for (const [key, value] of fetched) {
      const root = dependentRoot(key, value);
      if (root === undefined) continue;
      const rootKey = keys.reservation(root);
      if (!set.isLoaded(rootKey) && !fetched.has(rootKey)) roots.add(rootKey);
    }
    if (roots.size) await loadGovernorKeys(set, [...roots], read);
    // 本批里的根先登记，依附它的行随后判断
    const ordered = [...fetched].sort(([left, leftValue], [right, rightValue]) =>
      Number(dependentRoot(left, leftValue) !== undefined) - Number(dependentRoot(right, rightValue) !== undefined));
    const next: string[] = [];
    for (const [key, value] of ordered) {
      if (set.isLoaded(key)) continue;
      const shown = visibleRow(set, key, value);
      set.loadStored(key, shown);
      if (shown === undefined) continue;
      if (key.startsWith("r:")) {
        const parent = (shown as unknown as StoredReservation).p.lease.parentId;
        if (parent !== undefined) next.push(keys.reservation(parent));
      } else if (key.startsWith("qw:")) {
        next.push(keys.queued(shown as string));
      }
    }
    pending = [...new Set(next)].filter((key) => !set.isLoaded(key));
  }
}

/** 依附在根上的行所属的根：子预留、用量、用量预留与用量序号。根本身与其他行没有。 */
function dependentRoot(key: string, value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const [prefix] = key.split(":", 1);
  switch (prefix) {
    case "r": {
      const reservation = (value as unknown as StoredReservation).p;
      return reservation.depth === 0 ? undefined : reservation.rootReservationId;
    }
    case "u":
    case "ur":
      return (value as unknown as StoredUsage).e.rootReservationId;
    case "s":
      return key.slice(2);
    default:
      return undefined;
  }
}

/**
 * 同步判断推演一批调控记录之前，一次报全它们归约所需、可从记录本身得出的键与索引页（缺多少报多少，只抛一次），
 * 避免推演中按惰性读取逐键发现、每发现一个就整笔重跑。依赖状态才能发现的键仍由惰性读取逐步补齐。
 * 非按键工作集（完整投影）不需要装入。
 */
export function requireGovernorRecordNeeds(state: GovernorProjection, records: readonly { readonly body: unknown }[]): void {
  if (!(state instanceof GovernorWorkingSet)) return;
  state.requireNeeds(records.flatMap((record) => governorRecordNeeds(record.body)));
}

/** 一条调控记录归约时必读、可从记录本身得出的键与索引页。 */
function governorRecordNeeds(input: unknown): GovernorNeed[] {
  const record = input as Partial<Record<string, unknown>> & { readonly t?: string };
  const id = (value: unknown) => typeof value === "string" ? value : undefined;
  const workloadKey = (value: unknown) => {
    try { return rootResourceWorkloadKey(value as RootResourceWorkload); } catch { return undefined; }
  };
  const needs: GovernorNeed[] = [];
  const key = (value: string | undefined, make: (id: string) => string) => { if (value !== undefined) needs.push({ key: make(value) }); };
  switch (record.t) {
    case "queued": {
      const workload = workloadKey(record.workload);
      key(id(record.reservationId), keys.reservation); key(id(record.reservationId), keys.queued);
      key(workload, keys.queuedByWorkload); key(workload, keys.dequeued); needs.push({ fair: true });
      break;
    }
    case "dequeue": {
      const workload = workloadKey(record.workload);
      key(workload, keys.dequeued); key(workload, keys.queuedByWorkload);
      if (workload !== undefined) needs.push({ page: pages.workloadRoots(workload) });
      needs.push({ fair: true });
      break;
    }
    case "reserve": {
      const lease = (record.lease ?? {}) as { reservationId?: unknown; parentId?: unknown; workload?: unknown };
      key(id(lease.reservationId), keys.reservation); key(id(lease.parentId), keys.reservation);
      if (lease.parentId === undefined) {
        key(id(lease.reservationId), keys.queued); key(workloadKey(lease.workload), keys.dequeued); needs.push({ fair: true });
      }
      break;
    }
    case "usage-reserved":
    case "consume":
      key(id(record.usageId), keys.usage); key(id(record.usageId), keys.usageReservation);
      key(id(record.reservationId), keys.reservation); key(id(record.rootReservationId), keys.reservation);
      key(id(record.rootReservationId), keys.seq);
      break;
    case "settle":
    case "release":
    case "reclaim": {
      const reservation = id(record.reservationId);
      key(reservation, keys.reservation);
      if (reservation !== undefined) {
        needs.push({ page: pages.children(reservation) }, { page: pages.openByReservation(reservation) },
          { page: pages.openByRoot(reservation) });
      }
      break;
    }
    default:
      break;
  }
  return needs;
}

/** 按保留前沿与根摘要判定一行是否仍在逻辑上存在；依附行所属的根已先装入。 */
function visibleRow(
  set: GovernorWorkingSet,
  key: string,
  value: JsonValue | undefined,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  const [prefix] = key.split(":", 1);
  const rootAlive = (root: string, digest: string): boolean => {
    const loaded = set.peekReservation(root).value;
    return loaded !== undefined && loaded.depth === 0 && set.rootDigestOf(root) === digest;
  };
  switch (prefix) {
    case "r": {
      const stored = value as unknown as StoredReservation;
      if (stored.p.depth === 0) {
        return expiredRoot(stored.p, set.cutoff) ? undefined : value;
      }
      return rootAlive(stored.p.rootReservationId, stored.rd) ? value : undefined;
    }
    case "u":
    case "ur":
      return rootAlive((value as unknown as StoredUsage).e.rootReservationId, (value as unknown as StoredUsage).rd)
        ? value : undefined;
    case "s":
      return rootAlive(key.slice(2), (value as unknown as StoredSeq).rd) ? value : undefined;
    case "d": {
      const at = (value as unknown as StoredDequeued).at;
      return at !== undefined && at < set.cutoff ? undefined : value;
    }
    default:
      return value;
  }
}

function expiredRoot(reservation: ResourceReservationProjection, cutoff: string): boolean {
  return (reservation.state === "released" || reservation.state === "reclaimed") &&
    reservation.terminalAt !== undefined && reservation.terminalAt < cutoff;
}

/** 在工作集上运行一段可能缺键的同步逻辑：缺什么装什么，每次都在新的复制上从头重做。 */
export async function runWithGovernorNeeds<Value>(
  set: GovernorWorkingSet,
  read: DurableProjectionReadContext,
  operation: (attempt: GovernorWorkingSet) => Value,
): Promise<{ readonly value: Value; readonly attempt: GovernorWorkingSet }> {
  for (let rounds = 0; ; rounds++) {
    const attempt = set.fork();
    try {
      return { value: operation(attempt), attempt };
    } catch (error) {
      if (!(error instanceof GovernorStateRequired) || rounds >= 64) throw error;
      await loadGovernorNeeds(set, error.needs, read);
    }
  }
}

// ---- 归约 ----

export function registerResourceGovernorIndex(
  log: AuthorityCommitLog,
  verifier: ResourceLeaseSignatureVerifier,
  maxLeaseTtlMs: number,
): RebuildableDurableProjectionIndex {
  return log.durableProjection<GovernorRecord>({
    projectionId: RESOURCE_GOVERNOR_INDEX_PROJECTION_ID,
    reducerVersion: REDUCER_VERSION,
    authenticated: true,
    inputs: { streams: [GOVERNOR_STREAM] },
    reduce: (envelope, current) => reduceGovernorIndex(envelope, current, verifier, maxLeaseTtlMs),
  });
}

async function reduceGovernorIndex(
  envelope: CommitEnvelope<GovernorRecord>,
  current: DurableProjectionReadContext,
  verifier: ResourceLeaseSignatureVerifier,
  maxLeaseTtlMs: number,
): Promise<readonly DurableProjectionMutation[]> {
  const records = envelope.entries
    .map((entry, item) => ({ entry, item }))
    .filter(({ entry }) => entry.stream === GOVERNOR_STREAM);
  if (!records.length) return [];
  const previous = await current.get(FRONTIER_KEY) as string | undefined;
  const cutoff = governorRetentionCutoff(envelope.at, previous);
  const set = new GovernorWorkingSet(cutoff);
  // 先按记录内容装入可静态得出的键，再整封一次应用：大信封不必逐条复制工作集
  await loadGovernorNeeds(set, records.flatMap(({ entry }) => governorRecordNeeds(entry.body)), current);
  const { attempt } = await runWithGovernorNeeds(set, current, (attempt) => {
    for (const { entry, item } of records) {
      attempt.beginRecord(ordinalOf(envelope.lsn, item));
      applyGovernorRecordAt(attempt, entry.body, envelope.at, maxLeaseTtlMs, verifier);
      attempt.markFairTouched();
    }
    return undefined;
  });
  set.adopt(attempt);
  const mutations = set.mutations();
  if (cutoff !== previous) mutations.push({ kind: "put", key: FRONTIER_KEY, value: cutoff });
  mutations.push({ kind: "put", key: HEAD_KEY, value: envelope.lsn });
  return mutations;
}

// ---- 调控器使用的会话 ----

/**
 * 一次协调期的工作集。锁外的同步判断缺键时抛出 GovernorStateRequired，其 prepareOutside 在锁外
 * 读取后装入本会话；调控器自己的事务在持久投影事务里用同一锁会话的视图补齐。
 */
export class GovernorSession {
  #set: GovernorWorkingSet;
  /** 本会话已装入状态所对应的最后一封调控信封；undefined 表示未知（不复用）。 */
  #head: number | undefined;

  constructor(
    readonly store: ResourceGovernorIndexStore,
    cutoff: string,
    head?: number,
  ) {
    this.#set = this.#bind(new GovernorWorkingSet(cutoff));
    this.#head = head;
  }

  get head(): number | undefined { return this.#head; }

  /** 同步判断直接读它：缺键时抛出的待装入错误带着锁外装入本会话的准备动作。 */
  get state(): GovernorWorkingSet { return this.#set; }

  #bind(set: GovernorWorkingSet): GovernorWorkingSet {
    set.bindLoader((needs) => this.load(needs));
    return set;
  }

  /** 锁外装入（会话持有者在协调期内串行，期间没有别的调控写者）。 */
  async load(needs: readonly GovernorNeed[]): Promise<void> {
    await loadGovernorNeeds(this.#set, needs, this.store.index);
  }

  /** 锁外运行一段只读判断，缺什么装什么。 */
  async resolve<Value>(operation: (state: GovernorWorkingSet) => Value): Promise<Value> {
    const { value, attempt } = await runWithGovernorNeeds(this.#set, this.store.index, operation);
    this.#set.adopt(attempt);
    return value;
  }

  /** 事务内用锁会话视图补齐，提交后采纳提交后的状态。 */
  adoptCommitted(set: GovernorWorkingSet, head: number): void {
    set.settle();
    this.#set = this.#bind(set);
    this.#head = head;
  }

  adoptLoaded(set: GovernorWorkingSet, head: number | undefined): void {
    this.#set = this.#bind(set);
    this.#head = head;
  }
}

export type GovernorDecision<Value> =
  | { readonly kind: "return"; readonly value: Value }
  | { readonly kind: "append"; readonly entries: readonly LogicalRecord<GovernorRecord>[]; readonly value: Value };

export class ResourceGovernorIndexStore {
  readonly index: RebuildableDurableProjectionIndex;

  constructor(
    readonly log: AuthorityCommitLog,
    readonly verifier: ResourceLeaseSignatureVerifier,
    readonly maxLeaseTtlMs: number,
    readonly clock: () => string,
  ) {
    this.index = registerResourceGovernorIndex(log, verifier, maxLeaseTtlMs);
  }

  /** 新会话：保留前沿取已持久前沿与本地时间派生值中较晚者。 */
  async session(): Promise<GovernorSession> {
    const [frontier, head] = await this.index.getMany([FRONTIER_KEY, HEAD_KEY]) as [string | undefined, number | undefined];
    return new GovernorSession(this, governorRetentionCutoff(this.clock(), frontier), head);
  }

  /**
   * 协调与调控操作开始时取会话：此后没有新的调控信封、前沿也未变时沿用已装入的键，
   * 否则取新会话。只读两个固定键。
   */
  async refresh(current: GovernorSession | undefined): Promise<GovernorSession> {
    const [frontier, head] = await this.index.getMany([FRONTIER_KEY, HEAD_KEY]) as [string | undefined, number | undefined];
    const cutoff = governorRetentionCutoff(this.clock(), frontier);
    if (current && current.head !== undefined && current.head === head && current.state.cutoff === cutoff &&
        current.state.loadedKeys < MAX_REUSED_SESSION_KEYS) return current;
    return new GovernorSession(this, cutoff, head);
  }

  /** 不读持久前沿的会话（尚未开始协调时的同步判断用）；随后的事务按真实前沿核对。 */
  sessionAt(cutoff: string): GovernorSession {
    return new GovernorSession(this, cutoff);
  }

  /**
   * 在持久投影事务里决定：缺键用同一锁会话的视图补齐后重做；追加的记录先在工作集上按同一归约
   * 验证（与随后同事务里的持久归约一致），提交后会话采纳提交后的状态。
   */
  async transact<Value>(
    session: GovernorSession,
    decide: (state: GovernorWorkingSet) => GovernorDecision<Value>,
  ): Promise<Value> {
    let committed: GovernorWorkingSet | undefined;
    let loaded: GovernorWorkingSet | undefined;
    let observedHead: number | undefined;
    const result = await this.log.transactDurableProjection<GovernorRecord, Value>(
      RESOURCE_GOVERNOR_INDEX_PROJECTION_ID,
      async (view, context: ProjectionTransactionContext) => {
        // 事务与随后同事务里的持久归约用同一前沿；会话前沿不同（跨过分钟边界）或会话之后
        // 又有别的调控信封时重新装入
        const [frontier, head] = await readDurableProjectionKeys(view, [FRONTIER_KEY, HEAD_KEY]) as [string | undefined, number | undefined];
        const cutoff = governorRetentionCutoff(context.at, frontier);
        observedHead = head;
        const base = session.state.cutoff === cutoff && session.head !== undefined && session.head === head
          ? session.state.fork() : new GovernorWorkingSet(cutoff);
        const { value: decision, attempt } = await runWithGovernorNeeds(base, view, (attempt) => {
          const decision = decide(attempt);
          if (decision.kind === "return") return decision;
          // 追加记录归约所需、可静态得出的键一次补齐，不逐键多轮重做
          const missing = decision.entries.flatMap((entry) => governorRecordNeeds(entry.body)).filter((need) => !attempt.satisfies(need));
          if (missing.length) throw new GovernorStateRequired(missing);
          decision.entries.forEach((entry, item) => {
            if (entry.stream !== GOVERNOR_STREAM) throw new TypeError("Resource governor transaction contains a foreign stream");
            attempt.beginRecord(ordinalOf(context.nextLsn, item));
            applyGovernorRecordAt(attempt, entry.body, context.at, this.maxLeaseTtlMs, this.verifier);
            attempt.markFairTouched();
          });
          return decision;
        });
        if (decision.kind === "return") { loaded = attempt; committed = undefined; return decision; }
        committed = attempt; loaded = undefined;
        return { kind: "append", entries: decision.entries, value: decision.value };
      },
    );
    if (committed && result.commit) session.adoptCommitted(committed, result.commit.lsn);
    else if (loaded) session.adoptLoaded(loaded, observedHead);
    return result.value;
  }

  /** 整份逻辑状态（诊断与用例用）：按全部键重建，与原整份内存投影的形态一致。 */
  async snapshot(): Promise<GovernorProjection> {
    const session = await this.session();
    const set = session.state;
    const state: GovernorProjection = {
      reservations: new Map(), leaseAcceptances: new Map(), usages: new Map(), nextUsageSeqByRoot: new Map(),
      usageReservations: new Map(), queued: new Map(), queuedWorkloads: new Map(), queuedByWorkload: new Map(),
      dequeued: new Map(), dequeuedAt: new Map(), admissionQueues: emptyQueues(), admissionDeficits: emptyCounters(), admissionCursor: 0,
    };
    for (const prefix of ["r:", "u:", "ur:", "s:", "q:", "qw:", "d:"]) {
      let continuation: string | undefined;
      do {
        const page = await this.index.scan({ gte: prefix, lt: `${prefix}￿` }, PAGE_LIMIT, continuation);
        await loadGovernorKeys(set, page.entries.map((entry) => entry.key), this.index);
        for (const entry of page.entries) {
          const id = entry.key.slice(prefix.length);
          if (prefix === "r:") {
            const reservation = set.reservations.peek(id);
            if (reservation) state.reservations.set(id, reservation);
            const acceptance = set.leaseAcceptances.peek(id);
            if (reservation && acceptance) state.leaseAcceptances.set(id, acceptance);
          } else if (prefix === "u:") {
            const usage = set.usages.peek(id); if (usage) state.usages.set(id, usage);
          } else if (prefix === "ur:") {
            const usage = set.usageReservations.peek(id); if (usage) state.usageReservations.set(id, usage);
          } else if (prefix === "s:") {
            const next = set.nextUsageSeqByRoot.peek(id); if (next !== undefined) state.nextUsageSeqByRoot.set(id, next);
          } else if (prefix === "q:") {
            const admissionClass = set.queued.peek(id), workload = set.queuedWorkloads.peek(id);
            if (admissionClass !== undefined && workload !== undefined) { state.queued.set(id, admissionClass); state.queuedWorkloads.set(id, workload); }
          } else if (prefix === "qw:") {
            const queued = set.queuedByWorkload.peek(id); if (queued !== undefined) state.queuedByWorkload.set(id, queued);
          } else {
            const reason = set.dequeued.peek(id), at = set.dequeuedAt.peek(id);
            if (reason !== undefined) { state.dequeued.set(id, reason); if (at !== undefined) state.dequeuedAt.set(id, at); }
          }
        }
        continuation = page.continuation;
      } while (continuation);
    }
    await loadGovernorNeeds(set, [{ fair: true }], this.index);
    for (const admissionClass of ADMISSION_CLASSES) state.admissionQueues[admissionClass].push(...set.admissionQueues[admissionClass]);
    Object.assign(state.admissionDeficits, set.admissionDeficits);
    state.admissionCursor = set.admissionCursor;
    return state;
  }

  /**
   * 一步有界的物理清理：删除已过保留前沿的终态根及其全部行，以及过前沿的出队标记。
   * 每步至多处理 limit 行；巨大的根分多步，进度就是尚未删除的行本身。返回是否还有待清理。
   */
  async maintainRetention(limit = PAGE_LIMIT): Promise<boolean> {
    if (!this.log.publishProjectionRows) return false;
    let more = false;
    await this.log.publishProjectionRows([RESOURCE_GOVERNOR_INDEX_PROJECTION_ID], async (_head, read) => {
      const view = read(RESOURCE_GOVERNOR_INDEX_PROJECTION_ID);
      const frontier = await view.get(FRONTIER_KEY) as string | undefined;
      const mutations: DurableProjectionMutation[] = [];
      more = false;
      if (frontier === undefined) return new Map();
      const drop = (key: string) => mutations.push({ kind: "tombstone", key });
      const roots = await view.scan({ gte: "ix:tr:", lt: `ix:tr:${frontier}` }, 16);
      for (const entry of roots.entries) {
        if (mutations.length >= limit) { more = true; break; }
        const { id: root, rd } = entry.value as { id: string; rd: string };
        const removeIfSameRoot = async (key: string) => {
          const value = await view.get(key) as { rd?: string } | undefined;
          if (value?.rd === rd) drop(key);
        };
        let complete = true;
        // 只扫被清理那一代的定位行；同名根的新一代行在另一组键下，主行另按代际核对
        const generation = `${hash(root)}:${hash(rd)}:`;
        for (const prefix of [`ix:rr:${generation}`, `ix:ru:${generation}`, `ix:ub:${generation}`]) {
          const page = await view.scan({ gte: prefix, lt: `${prefix}￿` }, Math.max(1, limit - mutations.length));
          for (const row of page.entries) {
            const id = (row.value as { id: string }).id;
            if (prefix.startsWith("ix:rr:")) await removeIfSameRoot(keys.reservation(id));
            else if (prefix.startsWith("ix:ru:")) { await removeIfSameRoot(keys.usage(id)); await removeIfSameRoot(keys.usageReservation(id)); }
            drop(row.key);
          }
          if (page.continuation) complete = false;
          if (mutations.length >= limit) { complete = false; break; }
        }
        if (!complete) { more = true; break; }
        await removeIfSameRoot(keys.seq(root));
        await removeIfSameRoot(keys.reservation(root));
        drop(entry.key);
      }
      if (roots.continuation) more = true;
      if (mutations.length < limit) {
        const dequeued = await view.scan({ gte: "ix:td:", lt: `ix:td:${frontier}` }, Math.max(1, limit - mutations.length));
        for (const entry of dequeued.entries) {
          const workload = (entry.value as { wk: string }).wk;
          const at = entry.key.slice("ix:td:".length, entry.key.lastIndexOf(":"));
          const stored = await view.get(keys.dequeued(workload)) as StoredDequeued | undefined;
          if (stored?.at === at) drop(keys.dequeued(workload));
          drop(entry.key);
        }
        if (dequeued.continuation) more = true;
      } else {
        more = true;
      }
      return new Map([[RESOURCE_GOVERNOR_INDEX_PROJECTION_ID, mutations]]);
    }, { deferFlush: true });
    return more;
  }
}

// ---- 分配能力的激活事实 ----

/**
 * assignment 资源调用要核对分配时授予的能力与其后的撤销。原先每次调用读整条会话/作业流；
 * 这里按 (流, assignment, 执行方, 预留) 记最后一次授予，按 (流, assignment, capId) 记撤销，调用时精确读取。
 */
export const RESOURCE_CAPABILITY_ACTIVATION_PROJECTION_ID = "resource-capability-activation-v1";

const activationKey = (stream: string, assignmentId: string, executorId: string, reservationId: string) =>
  `ca:${hash(stream)}:${hash(assignmentId)}:${hash(executorId)}:${hash(reservationId)}`;
const revocationPrefix = (stream: string, assignmentId: string) => `cr:${hash(stream)}:${hash(assignmentId)}:`;

const receivedKey = (stream: string, executorId: string, reservationId: string) =>
  `ra:${hash(stream)}:${hash(executorId)}:${hash(reservationId)}`;
const progressKey = (stream: string) => `rp:${hash(stream)}`;
const ASSIGNMENT_TERMINAL_ENTRIES = new Set(["halted", "execution-failed", "bundle_sealed", "acked"]);

export function registerResourceCapabilityActivations(log: AuthorityCommitLog): RebuildableDurableProjectionIndex {
  return log.durableProjection({
    projectionId: RESOURCE_CAPABILITY_ACTIVATION_PROJECTION_ID,
    reducerVersion: 1,
    authenticated: true,
    inputs: { families: ["run:", "job:", "assignment:"] },
    reduce: async (envelope, current) => {
      const mutations: DurableProjectionMutation[] = [];
      const progress = new Map<string, { started?: true; terminal?: true }>();
      for (const entry of envelope.entries) {
        if (entry.stream.startsWith("assignment:")) {
          // 执行端收到的分配：最后一次 received 的能力，以及是否已开始、是否已终结
          const assignmentId = entry.stream.slice("assignment:".length);
          const inner = plainRecord(plainRecord(entry.body)?.body);
          if (!inner) continue;
          const activation = plainRecord(inner.activation);
          if (inner.t === "received" && activation?.assignmentId === assignmentId && typeof activation.executorId === "string" &&
              typeof plainRecord(activation.reservation)?.reservationId === "string" && Array.isArray(activation.capIds) &&
              activation.capIds.every((capId) => typeof capId === "string")) {
            mutations.push({ kind: "put", key: receivedKey(entry.stream, activation.executorId, plainRecord(activation.reservation)!.reservationId as string),
              value: { capIds: activation.capIds as string[], acceptedAt: envelope.at } });
          }
          if (inner.t === "started" || ASSIGNMENT_TERMINAL_ENTRIES.has(String(inner.t))) {
            const key = progressKey(entry.stream);
            const known = progress.get(key) ?? (await current.get(key) as { started?: true; terminal?: true } | undefined) ?? {};
            const next = { ...known, ...(inner.t === "started" ? { started: true as const } : { terminal: true as const }) };
            if (canonicalize(next) !== canonicalize(known)) {
              progress.set(key, next);
              mutations.push({ kind: "put", key, value: next });
            }
          }
          continue;
        }
        if (!entry.stream.startsWith("run:") && !entry.stream.startsWith("job:")) continue;
        const body = plainRecord(entry.body);
        if (!body || typeof body.assignmentId !== "string") continue;
        if (body.t === "assigned") {
          const reservation = plainRecord(body.reservation);
          if (typeof body.executorId !== "string" || typeof reservation?.reservationId !== "string" ||
              !Array.isArray(body.capIds) || !body.capIds.every((capId) => typeof capId === "string")) continue;
          mutations.push({ kind: "put", key: activationKey(entry.stream, body.assignmentId, body.executorId, reservation.reservationId),
            value: { capIds: body.capIds as string[], acceptedAt: envelope.at } });
        } else if (body.t === "capability-revoked" && typeof body.capId === "string") {
          mutations.push({ kind: "put", key: `${revocationPrefix(entry.stream, body.assignmentId)}${hash(body.capId)}`, value: { capId: body.capId } });
        }
      }
      return mutations;
    },
  });
}

/** 某次分配最后一次授予的能力与已撤销的能力；没有授予时返回 undefined。 */
export async function readCapabilityActivation(
  index: DurableProjectionReadContext,
  input: { readonly stream: string; readonly assignmentId: string; readonly executorId: string; readonly reservationId: string },
): Promise<{ readonly capIds: readonly string[]; readonly acceptedAt: string; readonly revoked: ReadonlySet<string> } | undefined> {
  const activation = await index.get(activationKey(input.stream, input.assignmentId, input.executorId, input.reservationId)) as
    { capIds: string[]; acceptedAt: string } | undefined;
  if (!activation) return undefined;
  const revoked = new Set<string>();
  const prefix = revocationPrefix(input.stream, input.assignmentId);
  let continuation: string | undefined;
  do {
    const page = await index.scan({ gte: prefix, lt: `${prefix}￿` }, PAGE_LIMIT, continuation);
    for (const entry of page.entries) revoked.add((entry.value as { capId: string }).capId);
    continuation = page.continuation;
  } while (continuation);
  return { capIds: activation.capIds, acceptedAt: activation.acceptedAt, revoked };
}

/** 执行端收到的分配最后一次授予的能力，以及该分配是否已开始、是否已终结；未收到时返回 undefined。 */
export async function readReceivedCapabilityActivation(
  index: DurableProjectionReadContext,
  input: { readonly assignmentId: string; readonly executorId: string; readonly reservationId: string },
): Promise<{ readonly capIds: readonly string[]; readonly acceptedAt: string; readonly started: boolean; readonly terminal: boolean } | undefined> {
  const stream = `assignment:${input.assignmentId}`;
  const received = await index.get(receivedKey(stream, input.executorId, input.reservationId)) as
    { capIds: string[]; acceptedAt: string } | undefined;
  if (!received) return undefined;
  const progress = await index.get(progressKey(stream)) as { started?: true; terminal?: true } | undefined;
  return { ...received, started: progress?.started === true, terminal: progress?.terminal === true };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 已装入工作集中 active/settled 的预留（任意深度），经索引页定位。 */
export function liveGovernorReservations(state: GovernorProjection): ResourceReservationProjection[] {
  if (state instanceof GovernorWorkingSet) {
    return state.indexPage(pages.active(), "reservations")
      .map((id) => state.reservations.get(id)!)
      .filter((reservation) => reservation !== undefined && isLive(reservation));
  }
  return [...state.reservations.values()].filter(isLive);
}

/** 某根的已结用量中 usageSeq 在 [from, to] 的一段（升序），经索引页定位。 */
export function consumedUsageBlock(state: GovernorProjection, root: string, from: number, to: number): [string, UsageEntry][] {
  if (state instanceof GovernorWorkingSet) {
    // 用量块按根代际定位：先取当前这一代的根
    const reservation = state.reservations.get(root);
    if (reservation === undefined || reservation.depth !== 0) return [];
    return state.indexPage(pages.usageBlock(root, reservation.lease.digest, from, to), "usages")
      .map((id) => [id, state.usages.get(id)] as [string, UsageEntry | undefined])
      .filter((entry): entry is [string, UsageEntry] => entry[1] !== undefined && entry[1].rootReservationId === root &&
        entry[1].usageSeq >= from && entry[1].usageSeq <= to)
      .sort((left, right) => left[1].usageSeq - right[1].usageSeq);
  }
  return [...state.usages.entries()]
    .filter(([, usage]) => usage.rootReservationId === root && usage.usageSeq >= from && usage.usageSeq <= to)
    .sort((left, right) => left[1].usageSeq - right[1].usageSeq);
}
