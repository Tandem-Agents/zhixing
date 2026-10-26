import { createHash } from "node:crypto";
import {
  AuthorityPreparationRequired,
  readDurableProjectionKeys,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
} from "@zhixing/core/authority";
import type { JsonValue } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";

/**
 * 作业域状态按键落盘的工作集。投影的每个映射/集合字段逐条各占一行，按需装入；
 * 读到未装入的键时抛出 JobStateRequired，由调用方装入后在新的复制上重做——
 * 缺载从不当作不存在。完整模式（从零重放、对照用例）把未装入视为不存在。
 */

/**
 * 缺的一行（存储键）、缺的一个可列出字段（该字段的存储前缀），或有序字段的一段区间
 * （存储键区间 [from, to)，limit 表示只需从 from 起的若干条）。
 */
export type JobStateNeed =
  | { readonly key: string }
  | { readonly page: string }
  | { readonly range: string; readonly from: string; readonly to: string; readonly limit?: number };

export class JobStateRequired extends AuthorityPreparationRequired {
  constructor(readonly needs: readonly JobStateNeed[], load?: () => Promise<void>) {
    super([]);
    this.name = "JobStateRequired";
    this.message = "Job state is being loaded";
    if (load) {
      // 日志层可能已在后台启动同一次装入：同一个错误只装一次
      let loading: Promise<void> | undefined;
      this.prepareOutside = () => (loading ??= load());
    }
  }
}

class JobStateEnumerationError extends TypeError {
  constructor(field: string) { super(`Job state field ${field} is keyed and cannot be enumerated`); }
}

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);

/** 存储键里的主体摘要：数字与字符串不会撞到同一行。 */
export function jobStateSubject(key: string | number): string {
  return hash(typeof key === "number" ? `n:${key}` : `s:${key}`);
}

export function jobStateTaskBase(taskId: string): string {
  return `job/${hash(taskId)}/`;
}

// 复合值逐层带标签编码，用户数据里的对象不会被误认成内部的 Set/Map。
export function encodeJobState(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Set) return { t: "set", v: [...value].map(encodeJobState) };
  if (value instanceof Map) return { t: "map", v: [...value].map(([key, item]) => [encodeJobState(key), encodeJobState(item)]) };
  if (Array.isArray(value)) return { t: "array", v: value.map(encodeJobState) };
  if (value && typeof value === "object") {
    return { t: "object", v: Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).map(([key, item]) => [key, encodeJobState(item)])) };
  }
  throw new TypeError("Invalid job state value");
}

export function decodeJobState(value: JsonValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) throw new TypeError("Invalid job state encoding");
  const payload = value.v;
  if (value.t === "object" && payload && typeof payload === "object" && !Array.isArray(payload)) {
    return Object.fromEntries(Object.entries(payload).map(([key, item]) => [key, decodeJobState(item)]));
  }
  if (!Array.isArray(payload)) throw new TypeError("Invalid job state encoding");
  if (value.t === "set") return new Set(payload.map(decodeJobState));
  if (value.t === "array") return payload.map(decodeJobState);
  if (value.t === "map") {
    return new Map(payload.map((item) => {
      if (!Array.isArray(item) || item.length !== 2) throw new TypeError("Invalid job state map encoding");
      return [decodeJobState(item[0]!), decodeJobState(item[1]!)];
    }));
  }
  throw new TypeError("Invalid job state tag");
}

/** 一行：原始主体与值（集合成员只有主体，有序字段另带排序键）。 */
interface StoredRow { readonly k: string | number; readonly v?: JsonValue; readonly s?: string }

interface Entry {
  readonly field: string;
  /** 原始主体；按键装入且不存在的行在第一次按主体访问时补上。 */
  subject: string | number;
  /** 有序字段的排序键。 */
  readonly sortKey?: string;
  present: boolean;
  value: unknown;
  /** 装入时的规范编码；undefined 表示装入时不存在。 */
  base: string | undefined;
  /** 是否装入过（未装入就写的行只能整行覆盖）。 */
  known: boolean;
}

export interface JobStateField {
  readonly name: string;
  /** 映射、集合，或按排序键有序的集合（只能按区间读取）。 */
  readonly kind: "map" | "set" | "order";
  /** 只含当前义务、可整体列出的字段（目录、未完集合）。 */
  readonly enumerable?: boolean;
}

/** 有序字段已装入的存储键区间 [from, to)。 */
interface Coverage { readonly from: string; readonly to: string }

/**
 * 一个作业在一种投影（主投影或提交守卫）下的工作集。根行保存标量字段，
 * 其余字段逐条装入。复制只复制已装入的行。
 */
export class JobStateSet {
  readonly #entries = new Map<string, Entry>();
  readonly #pages = new Set<string>();
  readonly #coverage = new Map<string, Coverage[]>();
  #root: { value: Record<string, unknown>; base: string | undefined } | undefined;
  #loader: ((needs: readonly JobStateNeed[]) => Promise<void>) | undefined;

  constructor(
    /** 本投影全部行的公共前缀，例如 job/<任务摘要>/m/。 */
    readonly prefix: string,
    readonly fields: ReadonlyMap<string, JobStateField>,
    /** 从零重放：未装入即不存在。 */
    readonly complete = false,
  ) {}

  get rootKey(): string { return `${this.prefix}root`; }

  fieldPrefix(field: string): string { return `${this.prefix}${field}/`; }

  storageKey(field: string, subject: string | number, sortKey?: string): string {
    return sortKey === undefined
      ? `${this.fieldPrefix(field)}${jobStateSubject(subject)}`
      : `${this.fieldPrefix(field)}${sortKey}/${jobStateSubject(subject)}`;
  }

  bindLoader(loader: ((needs: readonly JobStateNeed[]) => Promise<void>) | undefined): void { this.#loader = loader; }

  #missing(needs: readonly JobStateNeed[]): JobStateRequired {
    const loader = this.#loader;
    return new JobStateRequired(needs, loader && (() => loader(needs)));
  }

  // ---- 根行 ----

  get root(): Record<string, unknown> {
    if (!this.#root) {
      if (!this.complete) throw this.#missing([{ key: this.rootKey }]);
      this.#root = { value: {}, base: undefined };
    }
    return this.#root.value;
  }

  // ---- 行 ----

  entry(field: string, subject: string | number): Entry {
    const key = this.storageKey(field, subject);
    const found = this.#entries.get(key);
    if (found) {
      found.subject = subject;
      return found;
    }
    if (!this.complete) throw this.#missing([{ key }]);
    const created: Entry = { field, subject, present: false, value: undefined, base: undefined, known: true };
    this.#entries.set(key, created);
    return created;
  }

  peek(field: string, subject: string | number): Entry | undefined {
    return this.#entries.get(this.storageKey(field, subject));
  }

  /** 写入一行；未装入的行按整行覆盖处理（映射值与集合成员不依赖原值）。 */
  write(field: string, subject: string | number, present: boolean, value: unknown, sortKey?: string): void {
    const key = this.storageKey(field, subject, sortKey);
    const found = this.#entries.get(key);
    if (found) {
      found.subject = subject;
      found.present = present;
      found.value = present ? value : undefined;
      return;
    }
    // 删除要知道原先是否存在；有序字段的行只是索引，删除可以不看原值
    if (!present && !this.complete && sortKey === undefined) throw this.#missing([{ key }]);
    this.#entries.set(key, {
      field, subject, ...(sortKey === undefined ? {} : { sortKey }), present,
      value: present ? value : undefined, base: undefined, known: this.complete,
    });
  }

  isLoaded(key: string): boolean { return key === this.rootKey ? this.#root !== undefined : this.#entries.has(key); }

  hasPage(field: string): boolean { return this.complete || this.#pages.has(field); }

  /** 这条需要是否落在本投影的行里。 */
  owns(need: JobStateNeed): boolean {
    return ("key" in need ? need.key : "page" in need ? need.page : need.range).startsWith(this.prefix);
  }

  /** 一次报出多行待装入：逐层定位多条路径时，同一层缺的行一并装入，轮数不随条数增长。完整模式下没有缺行。 */
  requireRows(keys: readonly string[]): void {
    if (this.complete) return;
    const missing = [...new Set(keys)].filter((key) => !this.isLoaded(key));
    if (missing.length) throw this.#missing(missing.map((key) => ({ key })));
  }

  satisfies(need: JobStateNeed): boolean {
    if ("key" in need) return this.isLoaded(need.key);
    if ("page" in need) return this.hasPage(need.page.slice(this.prefix.length, -1));
    return this.#covers(need.range.slice(this.prefix.length, -1), need.from, need.to, need.limit);
  }

  /** 可列出字段的当前成员：装入时页内的行，加上本工作集内新增的行。 */
  members(field: string): (string | number)[] {
    const spec = this.fields.get(field);
    if (!spec?.enumerable) throw new JobStateEnumerationError(field);
    if (!this.hasPage(field)) throw this.#missing([{ page: this.fieldPrefix(field) }]);
    const result: (string | number)[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.field === field && entry.present) result.push(entry.subject);
    }
    return result;
  }

  /**
   * 有序字段在排序键区间 (after, through] 内的行，按排序键升序；limit 只要求前若干条。
   * 区间未装入时抛出待装入。
   */
  range(field: string, after: string | undefined, through: string | undefined, limit?: number):
    { readonly sortKey: string; readonly subject: string | number }[] {
    const prefix = this.fieldPrefix(field);
    const from = after === undefined ? prefix : `${prefix}${after}/￿`;
    const to = through === undefined ? `${prefix}￿` : `${prefix}${through}/￿`;
    // 空区间（例如前沿已在观察时刻之后）没有行，不必读取
    if (from >= to) return [];
    if (!this.#covers(field, from, to, limit)) {
      throw this.#missing([{ range: prefix, from, to, ...(limit === undefined ? {} : { limit }) }]);
    }
    const rows = [...this.#entries].filter(([key, entry]) =>
      entry.field === field && entry.present && key >= from && key < to)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, entry]) => ({ sortKey: entry.sortKey!, subject: entry.subject }));
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  #covers(field: string, from: string, to: string, limit: number | undefined): boolean {
    if (this.complete) return true;
    for (const covered of this.#coverage.get(field) ?? []) {
      if (covered.from > from) continue;
      if (covered.to >= to) return true;
      if (limit !== undefined) {
        let count = 0;
        for (const [key, entry] of this.#entries) {
          if (entry.field === field && entry.present && key >= from && key < covered.to) count += 1;
        }
        if (count >= limit) return true;
      }
    }
    return false;
  }

  /** 完整模式下一个字段的全部现存行（核对用）；按需装入的工作集没有全集，不可用。 */
  allEntries(field: string): { readonly subject: string | number; readonly sortKey?: string; readonly value: unknown }[] {
    if (!this.complete) throw new JobStateEnumerationError(field);
    return [...this.#entries.values()]
      .filter((entry) => entry.field === field && entry.present)
      .map((entry) => ({ subject: entry.subject, ...(entry.sortKey === undefined ? {} : { sortKey: entry.sortKey }), value: entry.value }));
  }

  /** 已装入的行数：会话复用时据此限制工作集体量。 */
  get loadedRows(): number { return this.#entries.size; }

  // ---- 装入 ----

  loadRoot(stored: JsonValue | undefined): void {
    if (this.#root) return;
    if (stored !== undefined && (stored === null || typeof stored !== "object" || Array.isArray(stored))) {
      throw new TypeError("Job state root is invalid");
    }
    const value = stored === undefined ? {} : decodeJobState(stored as JsonValue) as Record<string, unknown>;
    this.#root = { value, base: stored === undefined ? undefined : canonicalize(stored) };
  }

  loadStored(key: string, stored: JsonValue | undefined): void {
    if (key === this.rootKey) { this.loadRoot(stored); return; }
    if (this.#entries.has(key)) return;
    if (!key.startsWith(this.prefix)) throw new TypeError("Job state row belongs to another projection");
    const rest = key.slice(this.prefix.length);
    const separator = rest.indexOf("/");
    const field = rest.slice(0, separator);
    const spec = this.fields.get(field);
    if (separator <= 0 || !spec) throw new TypeError(`Unknown job state field in ${key}`);
    if (stored === undefined) {
      if (spec.kind === "order") return;
      // 不存在的行：主体在第一次按主体访问时补上
      this.#entries.set(key, { field, subject: rest.slice(separator + 1), present: false, value: undefined, base: undefined, known: true });
      return;
    }
    const row = stored as unknown as StoredRow;
    if (!row || typeof row !== "object" || (typeof row.k !== "string" && typeof row.k !== "number") ||
        (spec.kind === "order" ? typeof row.s !== "string" : row.s !== undefined) ||
        this.storageKey(field, row.k, row.s) !== key) {
      throw new TypeError("Job state key binding is invalid");
    }
    const value = spec.kind === "map" ? decodeJobState(row.v as JsonValue) : true;
    this.#entries.set(key, {
      field, subject: row.k, ...(row.s === undefined ? {} : { sortKey: row.s }),
      present: true, value, base: canonicalize(stored), known: true,
    });
  }

  loadPage(field: string): void { this.#pages.add(field); }

  loadCoverage(field: string, from: string, to: string): void {
    const covered = this.#coverage.get(field) ?? [];
    covered.push({ from, to });
    this.#coverage.set(field, covered);
  }

  // ---- 复制、采纳与改动 ----

  fork(): JobStateSet {
    const copy = new JobStateSet(this.prefix, this.fields, this.complete);
    copy.#loader = this.#loader;
    for (const [key, entry] of this.#entries) {
      copy.#entries.set(key, { ...entry, value: entry.present ? structuredClone(entry.value) : undefined });
    }
    for (const page of this.#pages) copy.#pages.add(page);
    for (const [field, covered] of this.#coverage) copy.#coverage.set(field, [...covered]);
    if (this.#root) copy.#root = { value: structuredClone(this.#root.value), base: this.#root.base };
    return copy;
  }

  /** 采纳一次成功尝试的结果（含它装入的行）。 */
  adopt(attempt: JobStateSet): void {
    this.#entries.clear();
    for (const [key, entry] of attempt.#entries) this.#entries.set(key, entry);
    for (const page of attempt.#pages) this.#pages.add(page);
    for (const [field, covered] of attempt.#coverage) this.#coverage.set(field, [...covered]);
    this.#root = attempt.#root;
  }

  #stored(entry: Entry): StoredRow {
    const kind = this.fields.get(entry.field)!.kind;
    return kind === "map"
      ? { k: entry.subject, v: encodeJobState(entry.value) }
      : kind === "order" ? { k: entry.subject, s: entry.sortKey! } : { k: entry.subject };
  }

  #changed(entry: Entry): boolean {
    if (!entry.known) return true;
    if (!entry.present) return entry.base !== undefined;
    return canonicalize(this.#stored(entry) as unknown as JsonValue) !== entry.base;
  }

  /** 与装入时比较得出的持久改动。 */
  mutations(): DurableProjectionMutation[] {
    const result: DurableProjectionMutation[] = [];
    for (const [key, entry] of this.#entries) {
      if (!this.#changed(entry)) continue;
      result.push(entry.present
        ? { kind: "put", key, value: this.#stored(entry) as unknown as JsonValue }
        : { kind: "tombstone", key });
    }
    if (this.#root) {
      const value = encodeJobState(this.#root.value);
      if (canonicalize(value) !== this.#root.base) result.push({ kind: "put", key: this.rootKey, value });
    }
    return result;
  }

  /** 改动已持久：当前值成为新的装入基准。 */
  settle(): void {
    for (const [key, entry] of this.#entries) {
      if (!entry.present && entry.sortKey !== undefined) {
        // 已删除的索引行不再需要占位
        this.#entries.delete(key);
        continue;
      }
      entry.base = entry.present ? canonicalize(this.#stored(entry) as unknown as JsonValue) : undefined;
      entry.known = true;
    }
    if (this.#root) this.#root.base = canonicalize(encodeJobState(this.#root.value));
  }

  /** 本工作集里与装入时不同（或未装入就写过）的行的主体。 */
  changedSubjects(field: string): (string | number)[] {
    const result: (string | number)[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.field === field && this.#changed(entry)) result.push(entry.subject);
    }
    return result;
  }

  /** 装入时的值：present 表示原先是否存在。未装入的行视为未知，返回 undefined。 */
  baseOf(field: string, subject: string | number): { readonly present: boolean; readonly value?: unknown } | undefined {
    const entry = this.peek(field, subject);
    if (!entry?.known) return undefined;
    if (entry.base === undefined) return { present: false };
    const row = JSON.parse(entry.base) as StoredRow;
    return { present: true, ...(row.v === undefined ? {} : { value: decodeJobState(row.v) }) };
  }
}

/**
 * 投影对象与工作集之间的一层绑定：重做时换上新的复制，已交给别处（例如日志事务）
 * 的投影对象随之指向新的工作集。
 */
export class JobStateBinding {
  constructor(public store: JobStateSet) {}
}

/** 按键读写的映射：没有遍历与大小，读到未装入的键抛出待装入。 */
export class KeyedMap<K extends string | number, V> {
  constructor(readonly binding: JobStateBinding, readonly field: string) {}

  get(key: K): V | undefined {
    const entry = this.binding.store.entry(this.field, key);
    return entry.present ? entry.value as V : undefined;
  }

  has(key: K): boolean { return this.binding.store.entry(this.field, key).present; }

  set(key: K, value: V): this {
    this.binding.store.write(this.field, key, true, value);
    return this;
  }

  delete(key: K): boolean {
    const had = this.binding.store.entry(this.field, key).present;
    this.binding.store.write(this.field, key, false, undefined);
    return had;
  }

  /** 已装入时的值；未装入返回 undefined，不抛出。 */
  peek(key: K): V | undefined {
    const entry = this.binding.store.peek(this.field, key);
    return entry?.present ? entry.value as V : undefined;
  }

  /** 只用于可列出字段：当前全部主体。 */
  keys(): K[] { return this.binding.store.members(this.field) as K[]; }
}

export class KeyedSet<K extends string | number> {
  constructor(readonly binding: JobStateBinding, readonly field: string) {}

  has(key: K): boolean { return this.binding.store.entry(this.field, key).present; }

  add(key: K): this {
    // 加入前必须知道原先是否已在：目录成员要计入未完义务计数
    this.binding.store.entry(this.field, key);
    this.binding.store.write(this.field, key, true, true);
    return this;
  }

  delete(key: K): boolean {
    const had = this.binding.store.entry(this.field, key).present;
    this.binding.store.write(this.field, key, false, undefined);
    return had;
  }

  /** 只用于可列出字段：当前全部成员。 */
  values(): K[] { return this.binding.store.members(this.field) as K[]; }
}

/** 按排序键有序的主体集合：只能按区间读取。排序键不得含 “/”。 */
export class KeyedOrder<K extends string | number> {
  constructor(readonly binding: JobStateBinding, readonly field: string) {}

  add(sortKey: string, subject: K): void {
    assertSortKey(sortKey);
    this.binding.store.write(this.field, subject, true, true, sortKey);
  }

  remove(sortKey: string, subject: K): void {
    assertSortKey(sortKey);
    this.binding.store.write(this.field, subject, false, undefined, sortKey);
  }

  /** 排序键在 (after, through] 内的主体，按排序键升序；limit 只取前若干条。 */
  range(options: { readonly after?: string; readonly through?: string; readonly limit?: number } = {}):
    { readonly sortKey: string; readonly subject: K }[] {
    return this.binding.store.range(this.field, options.after, options.through, options.limit) as
      { readonly sortKey: string; readonly subject: K }[];
  }
}

function assertSortKey(sortKey: string): void {
  if (!sortKey || sortKey.includes("/") || sortKey.includes("￿")) throw new TypeError("Job state sort key is invalid");
}

/**
 * 把缺的行、可列出字段与有序区间装入工作集。键成批读取：锁外的每次读取都要进出一次日志锁。
 */
export async function loadJobState(
  set: JobStateSet,
  needs: readonly JobStateNeed[],
  read: DurableProjectionReadContext,
): Promise<void> {
  const owned = needs.filter((need) => set.owns(need) && !set.satisfies(need));
  const keys = [...new Set(owned.flatMap((need) => "key" in need ? [need.key] : []))];
  for (let offset = 0; offset < keys.length; offset += 256) {
    const chunk = keys.slice(offset, offset + 256);
    const values = await readDurableProjectionKeys(read, chunk);
    chunk.forEach((key, index) => set.loadStored(key, values[index]));
  }
  for (const prefix of new Set(owned.flatMap((need) => "page" in need ? [need.page] : []))) {
    let continuation: string | undefined;
    do {
      const page = await read.scan({ gte: prefix, lt: `${prefix}￿` }, 256, continuation);
      for (const entry of page.entries) set.loadStored(entry.key, entry.value);
      continuation = page.continuation;
    } while (continuation);
    set.loadPage(prefix.slice(set.prefix.length, -1));
  }
  for (const need of owned) {
    if (!("range" in need)) continue;
    const field = need.range.slice(set.prefix.length, -1);
    let continuation: string | undefined;
    let loaded = 0;
    let last: string | undefined;
    do {
      const pageLimit = need.limit === undefined ? 256 : Math.min(256, need.limit - loaded);
      const page = await read.scan({ gte: need.from, lt: need.to }, pageLimit, continuation);
      for (const entry of page.entries) set.loadStored(entry.key, entry.value);
      loaded += page.entries.length;
      last = page.entries.at(-1)?.key ?? last;
      continuation = page.continuation;
    } while (continuation && (need.limit === undefined || loaded < need.limit));
    // 只取了前若干条：覆盖到最后一条之后为止
    set.loadCoverage(field, need.from, continuation && last !== undefined ? `${last}\u0000` : need.to);
  }
}

/** 装入重做的轮数上限。 */
export const MAX_JOB_STATE_ROUNDS = 64;

/** 缺行所在的字段：作业域存储键 job/<任务摘要>/<m|g>/<字段>/… 里的投影与字段。 */
function needField(need: JobStateNeed): string {
  const parts = ("key" in need ? need.key : "page" in need ? need.page : need.range).split("/");
  return parts[0] === "job" && parts.length > 3 ? `${parts[2]}:${parts[3]}` : parts.slice(0, 2).join("/");
}

/** 按字段计数缺行。 */
export function tallyJobStateNeeds(needs: readonly JobStateNeed[], into: Record<string, number> = {}): Record<string, number> {
  for (const need of needs) {
    const field = needField(need);
    into[field] = (into[field] ?? 0) + 1;
  }
  return into;
}

const describeTally = (tally: Readonly<Record<string, number>>) =>
  Object.entries(tally).map(([field, count]) => `${field} ${count}`).join(", ") || "none";

/**
 * 装入重做的轮数耗尽，或缺行属于本组工作集却装入后仍缺：不是可准备的缺键，不进入任何自动重试
 * （不是准备、背压、重建或损坏类错误），由调用方照常失败。带轮数、各字段累计装入的行数与最后仍缺的行。
 */
export class JobStateExhausted extends Error {
  readonly code = "job-state-exhausted";
  readonly missing: Readonly<Record<string, number>>;
  constructor(
    readonly reason: "rounds" | "no-progress",
    readonly rounds: number,
    readonly loaded: Readonly<Record<string, number>>,
    missing: readonly JobStateNeed[],
  ) {
    const tally = tallyJobStateNeeds(missing);
    super(`Job state could not be assembled (${reason}) after ${rounds} rounds; loaded ${describeTally(loaded)}; ` +
      `still missing ${missing.length} (${describeTally(tally)})`);
    this.name = "JobStateExhausted";
    this.missing = tally;
  }
}

/**
 * 在工作集上运行一段可能缺键的逻辑：每一轮给各绑定换上基准的新复制，缺什么装入基准，
 * 再从头重做。成功时各绑定持有这一轮的结果。缺行都不属于本组工作集时原样抛出，由拥有它们的一层装入；
 * 轮数耗尽，或缺行都属于本组却已装入（装了还缺），抛出 JobStateExhausted。
 */
export async function runWithJobState<Value>(
  pairs: readonly (readonly [JobStateBinding, JobStateSet])[],
  read: DurableProjectionReadContext,
  operation: () => Value | Promise<Value>,
): Promise<Value> {
  const loaded: Record<string, number> = {};
  for (let rounds = 0; ; rounds++) {
    for (const [binding, base] of pairs) binding.store = base.fork();
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof JobStateRequired)) throw error;
      const owned = error.needs.filter((need) => pairs.some(([, base]) => base.owns(need)));
      const pending = owned.filter((need) => pairs.some(([, base]) => base.owns(need) && !base.satisfies(need)));
      if (!pending.length) {
        if (owned.length < error.needs.length) throw error;
        throw new JobStateExhausted("no-progress", rounds + 1, loaded, owned);
      }
      if (rounds >= MAX_JOB_STATE_ROUNDS) throw new JobStateExhausted("rounds", rounds + 1, loaded, pending);
      for (const [, base] of pairs) {
        if (!error.needs.some((need) => base.owns(need) && !base.satisfies(need))) continue;
        await loadJobState(base, error.needs, read);
      }
      tallyJobStateNeeds(pending, loaded);
    }
  }
}
