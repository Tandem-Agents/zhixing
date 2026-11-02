import type { ArtifactJsonIndex, ArtifactJsonNode } from '../authority/artifact-json-index.js';
import type { ArtifactRef, TranscriptToolCallFacts, TranscriptToolFacts } from '../contracts/index.js';
import { TOOL_TARGET_INPUT_KEYS } from '../tool-display-names.js';
import { isToolResultDisposition } from '../types/messages.js';

type Keys = readonly (string | number)[];

/** 调用名、每项目标输入、失败开头各自的字符上限（与实时过程投影的输入上限一致）。 */
export const TOOL_FACT_NAME_CHARS = 256;
export const TOOL_FACT_INPUT_CHARS = 512;
export const TOOL_FACT_HEAD_CHARS = 1024;

/**
 * 一次读取的两本账，计入全部实际读取：每次索引定位记一次查找，每个读出的值记它的字节（大字符串按一个索引片的上限记）。
 * 配对账给“按位置核对、扫描相邻消息”；事实账给“读结果元数据、调用名与目标输入、失败开头”，每次调用都完整可用，
 * 所以一张卡片总能在一次调用里组装完，不会因组装本身永远读不完。
 */
export const TOOL_FACT_PAIRING_BUDGET = { bytes: 14 * 1024, lookups: 448 } as const;
/** 事实账能放下两个索引片（失败开头与一个超长目标输入）加名称与小值 */
export const TOOL_FACT_ASSEMBLY_BUDGET = { bytes: 50 * 1024, lookups: 64 } as const;

const ID_BYTES = 512;
const SMALL_VALUE_BYTES = 4096;
const PIECE_BYTES = 24 * 1024 + 16;
/**
 * 配对进度缓存的上限：条目数与总字节。每个记下的 id 按 UTF-16 字节加固定的映射开销计，正在扫描的条目也计入。
 * 记 id 时先按最久未用淘汰其它条目，仍放不下就不再记（条目从该位置起有遗漏）；被淘汰的条目从头续查。
 * 有遗漏的条目为每个要找的 id 单独续查遗漏区间，这些进度每条目最多 PAIRING_TARGETS 条，字节从总上限里预留。
 */
const PAIRING_ENTRIES = 16;
const PAIRING_BYTES = 2 * 1024 * 1024;
const PAIRING_ID_OVERHEAD = 64;
const PAIRING_TARGETS = 64;
const PAIRING_TARGET_RESERVE = PAIRING_TARGETS * (ID_BYTES * 2 + PAIRING_ID_OVERHEAD);

export type TranscriptToolFactsRead =
  | { readonly kind: 'facts'; readonly facts: TranscriptToolFacts }
  /** 调用块已有结果：卡片在结果块处给出，这里不重复 */
  | { readonly kind: 'skip' }
  /** 配对还没查完（本次预算用尽）：进度已保留，调用方按“准备中”稍后从同一位置重读 */
  | { readonly kind: 'pending'; readonly scanned: number; readonly total: number };

class BudgetExhausted extends Error {}

class Budget {
  constructor(public bytes: number, public lookups: number) {}
  lookup(): void {
    if (this.lookups < 1) throw new BudgetExhausted();
    this.lookups -= 1;
  }
  spend(bytes: number): void {
    if (bytes > this.bytes) throw new BudgetExhausted();
    this.bytes -= bytes;
  }
}

/**
 * 一条相邻消息的扫描进度。[0, next) 已扫过；ids 里每一项都是在该位置实际读到的 id，是命中的位置依据。
 * droppedFrom 之前扫到的 id 全部记下；从它起可能有没记下的 id，所以条目扫完后，未命中的 id 还要按目标核完
 * [droppedFrom, 末尾) 才能判定不存在。targets 记各目标已核过的连续区间 [lo, hi)。
 */
interface PairingScan {
  next: number;
  readonly ids: Map<string, number>;
  droppedFrom?: number;
  readonly targets: Map<string, TargetCoverage>;
  bytes: number;
  /** 同一条目的步骤串行：每一步都受单次调用预算约束，不跨无界搜索持有 */
  tail: Promise<unknown>;
}

interface TargetCoverage { readonly lo: number; readonly hi: number }

interface PairingStep {
  readonly scan: PairingScan;
  /** 记下在 block 处读到的 id；放不下时标记从 block 起有遗漏 */
  remember(id: string, block: number): void;
  /** 记下某个目标已核过的区间；undefined 表示该目标已有结论，删去进度 */
  progress(id: string, coverage: TargetCoverage | undefined): void;
}

/**
 * 配对进度：按（运行记录制品摘要、消息、要找的块种类）记扫描进度与见到的 id → 块序号。
 * 制品不可变，进度只取决于内容，所以进程内共享一份（在线读取器按请求新建也能续查）；可见性由读取器各自复核。
 * 同一条目的步骤按到达顺序串行，不同条目互不等待。被淘汰的条目若还有排队的步骤，它们照常给出本次结果，但不再写回：
 * 之后的读取拿到的是新条目，从头续查。
 */
export class TranscriptToolPairingCache {
  readonly #scans = new Map<string, PairingScan>();
  #bytes = 0;

  /** 在 key 的条目上串行执行一个有界步骤 */
  exclusive<T>(key: string, step: (context: PairingStep) => Promise<T>): Promise<T> {
    let scan = this.#scans.get(key);
    if (scan) {
      this.#scans.delete(key);
      this.#scans.set(key, scan);
    } else {
      scan = { next: 0, ids: new Map(), targets: new Map(), bytes: 0, tail: Promise.resolve() };
      this.#scans.set(key, scan);
      this.#evict(key, 0, PAIRING_BYTES);
    }
    const owned = scan;
    const run = owned.tail.then(() => step({
      scan: owned,
      remember: (id, block) => this.#remember(key, owned, id, block),
      progress: (id, at) => this.#progress(key, owned, id, at),
    }));
    owned.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 当前计入上限的字节（测试与诊断用） */
  get bytes(): number { return this.#bytes; }

  #remember(key: string, scan: PairingScan, id: string, block: number): void {
    if (scan.ids.has(id)) return;
    const cost = id.length * 2 + PAIRING_ID_OVERHEAD;
    const limit = PAIRING_BYTES - PAIRING_TARGET_RESERVE;
    if (this.#scans.get(key) === scan) this.#evict(key, cost, limit);
    if (this.#scans.get(key) !== scan || this.#bytes + cost > limit) {
      scan.droppedFrom = Math.min(scan.droppedFrom ?? block, block);
      return;
    }
    scan.ids.set(id, block);
    this.#charge(scan, cost);
  }

  #progress(key: string, scan: PairingScan, id: string, coverage: TargetCoverage | undefined): void {
    if (this.#scans.get(key) !== scan) return;
    const cost = id.length * 2 + PAIRING_ID_OVERHEAD;
    if (scan.targets.delete(id)) this.#charge(scan, -cost);
    if (coverage === undefined) return;
    if (scan.targets.size >= PAIRING_TARGETS) {
      const [oldest] = scan.targets.keys();
      scan.targets.delete(oldest!);
      this.#charge(scan, -(oldest!.length * 2 + PAIRING_ID_OVERHEAD));
    }
    // 本条目的 id 至多占到总上限减预留，续查进度至多占满预留，所以淘汰其它条目后一定放得下
    this.#evict(key, cost, PAIRING_BYTES);
    scan.targets.set(id, coverage);
    this.#charge(scan, cost);
  }

  #charge(scan: PairingScan, bytes: number): void {
    scan.bytes += bytes;
    this.#bytes += bytes;
  }

  /** 按最久未用淘汰其它条目，直到条目数在上限内、字节加上 cost 不超过 limit */
  #evict(keep: string, cost: number, limit: number): void {
    for (const [key, scan] of this.#scans) {
      if (this.#scans.size <= PAIRING_ENTRIES && this.#bytes + cost <= limit) return;
      if (key === keep) continue;
      this.#scans.delete(key);
      this.#bytes -= scan.bytes;
    }
  }
}

const SHARED_PAIRING = new TranscriptToolPairingCache();

/**
 * 读一个工具块的有界事实。结果块在同一运行记录里按 toolId 到上一条消息找它的调用；调用块若在下一条消息里已有结果则
 * 不给出（卡片在结果块处给出，不重复）。先按两条消息尾部对齐的位置猜并用 id 核对，猜不中再续查扫描；
 * 只有扫完整条相邻消息才判定没有配对，扫描未完时返回 pending，不给出半成品卡片。
 */
export async function readTranscriptToolFacts(
  json: ArtifactJsonIndex,
  ref: ArtifactRef,
  runKeys: Keys,
  message: number,
  block: number,
  type: 'tool_use' | 'tool_result',
  cache: TranscriptToolPairingCache = SHARED_PAIRING,
): Promise<TranscriptToolFactsRead> {
  const pairing = new Budget(TOOL_FACT_PAIRING_BUDGET.bytes, TOOL_FACT_PAIRING_BUDGET.lookups);
  const assembly = new Budget(TOOL_FACT_ASSEMBLY_BUDGET.bytes, TOOL_FACT_ASSEMBLY_BUDGET.lookups);
  const blockKeys = [...runKeys, 'messages', message, 'content', block];
  if (type === 'tool_use') {
    const id = await smallValue(json, ref, [...blockKeys, 'id'], ID_BYTES, assembly);
    if (typeof id === 'string') {
      const found = await locate(json, ref, runKeys, cache, { message, block }, message + 1, 'tool_result', 'toolUseId', id, pairing);
      if (found.kind === 'pending') return found;
      if (found.kind === 'found') return { kind: 'skip' };
    }
    return { kind: 'facts', facts: { kind: 'call', ...await callFacts(json, ref, blockKeys, assembly) } };
  }
  const toolUseId = await smallValue(json, ref, [...blockKeys, 'toolUseId'], ID_BYTES, assembly);
  let callAt: number | undefined;
  if (typeof toolUseId === 'string' && message > 0) {
    const found = await locate(json, ref, runKeys, cache, { message, block }, message - 1, 'tool_use', 'id', toolUseId, pairing);
    if (found.kind === 'pending') return found;
    if (found.kind === 'found') callAt = found.block;
  }
  assembly.lookup();
  const content = await json.node(ref, [...blockKeys, 'content']);
  const isError = await smallValue(json, ref, [...blockKeys, 'isError'], 16, assembly) === true;
  const disposition = await smallValue(json, ref, [...blockKeys, 'disposition'], 1024, assembly);
  const head = isError && content ? await boundedString(json, ref, [...blockKeys, 'content'], content, TOOL_FACT_HEAD_CHARS, assembly) : undefined;
  const call = callAt === undefined ? undefined : {
    ...await callFacts(json, ref, [...runKeys, 'messages', message - 1, 'content', callAt], assembly),
    message: message - 1,
    block: callAt,
  };
  return {
    kind: 'facts',
    facts: {
      kind: 'result',
      ...(call ? { call } : {}),
      length: content?.kind === 'string' ? content.units : 0,
      isError,
      ...(head !== undefined ? { head } : {}),
      ...(isToolResultDisposition(disposition) ? { disposition } : {}),
    },
  };
}

type Located = { readonly kind: 'found'; readonly block: number } | { readonly kind: 'absent' } |
  { readonly kind: 'pending'; readonly scanned: number; readonly total: number };

/**
 * 在相邻消息里找某种块中 field 等于 id 的那一块。先按两条消息尾部对齐猜一个位置并核对（只读不可变内容，不进串行）；
 * 猜不中再在缓存条目上串行执行一个受本次预算约束的步骤：查已记下的 id，否则从条目进度续扫；条目有遗漏区间时，
 * 未命中的目标从猜测位置向两侧交替扩展核对遗漏区间（错位通常只有一两块）。
 * 预算用尽即返回 pending（进度留在条目里），只有整条消息都核过才返回 absent。
 */
async function locate(json: ArtifactJsonIndex, ref: ArtifactRef, runKeys: Keys, cache: TranscriptToolPairingCache,
  from: { readonly message: number; readonly block: number }, target: number, kind: 'tool_use' | 'tool_result',
  field: 'id' | 'toolUseId', id: string, budget: Budget): Promise<Located> {
  let total = 0, guess = -1;
  try {
    budget.lookup();
    const content = await json.node(ref, [...runKeys, 'messages', target, 'content']);
    if (content?.kind !== 'array') return { kind: 'absent' };
    total = content.units;
    budget.lookup();
    const own = await json.node(ref, [...runKeys, 'messages', from.message, 'content']);
    guess = own?.kind === 'array' ? from.block + (total - own.units) : -1;
    if (guess >= 0 && guess < total && await fieldAt(json, ref, runKeys, target, guess, kind, field, budget) === id) {
      return { kind: 'found', block: guess };
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    return { kind: 'pending', scanned: 0, total };
  }
  const read = (at: number) => fieldAt(json, ref, runKeys, target, at, kind, field, budget);
  return cache.exclusive(`${ref.digest}:${runKeys.join('/')}:${target}:${kind}`, async ({ scan, remember, progress }) => {
    let coverage: { lo: number; hi: number } | undefined;
    try {
      const known = scan.ids.get(id);
      if (known !== undefined) return { kind: 'found', block: known };
      while (scan.next < total) {
        const at = scan.next, value = await read(at);
        if (value !== undefined) remember(value, at);
        scan.next = at + 1;
        if (value === id) return { kind: 'found', block: at };
      }
      const floor = scan.droppedFrom;
      if (floor === undefined) return { kind: 'absent' };
      const start = Math.min(Math.max(guess, floor), total);
      coverage = { ...scan.targets.get(id) ?? { lo: start, hi: start } };
      while (coverage.lo > floor || coverage.hi < total) {
        // 先右后左交替扩展，一侧到边界后只扩另一侧
        const right = coverage.hi < total && (coverage.lo <= floor || (coverage.hi - coverage.lo) % 2 === 0);
        const at = right ? coverage.hi : coverage.lo - 1, value = await read(at);
        if (right) coverage.hi += 1; else coverage.lo -= 1;
        if (value === id) { coverage = undefined; progress(id, undefined); return { kind: 'found', block: at }; }
      }
      coverage = undefined;
      progress(id, undefined);
      return { kind: 'absent' };
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      if (coverage !== undefined) progress(id, coverage);
      return { kind: 'pending', scanned: coverage ? (scan.droppedFrom ?? 0) + coverage.hi - coverage.lo : scan.next, total };
    }
  });
}

/** 读相邻消息第 block 块：是 kind 种类时返回它 field 的字符串值，否则 undefined */
async function fieldAt(json: ArtifactJsonIndex, ref: ArtifactRef, runKeys: Keys, message: number, block: number,
  kind: string, field: string, budget: Budget): Promise<string | undefined> {
  const keys = [...runKeys, 'messages', message, 'content', block];
  if (await smallValue(json, ref, [...keys, 'type'], 128, budget) !== kind) return undefined;
  const value = await smallValue(json, ref, [...keys, field], ID_BYTES, budget);
  return typeof value === 'string' ? value : undefined;
}

async function callFacts(json: ArtifactJsonIndex, ref: ArtifactRef, blockKeys: Keys, budget: Budget): Promise<TranscriptToolCallFacts> {
  budget.lookup();
  const nameNode = await json.node(ref, [...blockKeys, 'name']);
  const name = nameNode ? await boundedString(json, ref, [...blockKeys, 'name'], nameNode, TOOL_FACT_NAME_CHARS, budget) : undefined;
  const input: Record<string, string> = {};
  for (const key of TOOL_TARGET_INPUT_KEYS) {
    // 事实账不足时少读目标输入（标题少一个目标），不影响结果判断
    if (budget.lookups < 1) break;
    const keys = [...blockKeys, 'input', key];
    budget.lookup();
    const node = await json.node(ref, keys);
    if (!node) continue;
    const value = await boundedString(json, ref, keys, node, TOOL_FACT_INPUT_CHARS, budget);
    if (value !== undefined) input[key] = value;
  }
  return { name: name ?? '', input };
}

/** 只读不超过上限的小值；更大的值不读，当作不匹配。定位与读出都计入预算。 */
async function smallValue(json: ArtifactJsonIndex, ref: ArtifactRef, keys: Keys, maximum: number, budget: Budget): Promise<unknown> {
  budget.lookup();
  const node = await json.node(ref, keys);
  if (!node || node.hi - node.lo > maximum) return undefined;
  budget.spend(node.hi - node.lo);
  return json.value(ref, keys, maximum);
}

/**
 * 有界读取一个字符串：小值整值读取；大值只读第一个索引片再截到字符上限。读取字节计入预算，
 * 预算不足时不读（返回 undefined）。
 */
async function boundedString(json: ArtifactJsonIndex, ref: ArtifactRef, keys: Keys, node: ArtifactJsonNode, chars: number,
  budget: Budget): Promise<string | undefined> {
  if (node.kind !== 'string') return undefined;
  const bytes = node.hi - node.lo;
  const cost = bytes <= SMALL_VALUE_BYTES ? bytes : PIECE_BYTES;
  if (cost > budget.bytes) return undefined;
  budget.spend(cost);
  const text = bytes <= SMALL_VALUE_BYTES
    ? await json.value(ref, keys, SMALL_VALUE_BYTES) as string
    : (await json.textRange(ref, node, 0)).text;
  return text.length > chars ? text.slice(0, chars) : text;
}
