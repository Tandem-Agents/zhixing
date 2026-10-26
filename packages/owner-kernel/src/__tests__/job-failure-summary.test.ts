/**
 * 连续失败摘要的结构对照：随机插入（含同一时间、最早一端）、追加与改值，逐步与按完整次序从头算的参考一致；
 * 每步只读写定位路径上的节点；一次改动多处分散的条目时，按层成批装入，轮数不超过树高加一；
 * 归约前只为可能改动摘要的记录预装定位路径，每层一次读取。
 */
import type { DurableProjectionReadContext } from "@zhixing/core/authority";
import type { JobOccurrence, JsonValue } from "@zhixing/core/contracts";
import { compareJobOccurrences } from "@zhixing/core/protocol";
import { describe, expect, it } from "vitest";
import {
  FAILURE_SUMMARY_NODE_CAPACITY,
  failuresBefore,
  latestFailures,
  missingFailureSummaryNodes,
  requireFailureSummaryPaths,
  setFailureSummaryEntry,
  type FailureSummary,
  type FailureSummaryNode,
  type FailureSummaryPosition,
  type FailureSummaryTree,
} from "../job-failure-summary.js";
import { createJobMainState, jobProjectionView, preloadFailureSummaryPaths } from "../job-assignment.js";
import { JobStateBinding, JobStateSet, KeyedMap, runWithJobState, type JobStateField } from "../job-run-state.js";

const FIELDS = new Map<string, JobStateField>([["nodes", { name: "nodes", kind: "map" }]]);
const PREFIX = "summary/";

interface Item extends FailureSummaryPosition { failed: boolean }

/** 记下按编号读写的节点：一步操作读写了哪些行。 */
class CountingNodes extends KeyedMap<number, FailureSummaryNode> {
  readonly reads = new Set<number>();
  readonly writes = new Set<number>();
  override get(key: number): FailureSummaryNode | undefined {
    this.reads.add(key);
    return super.get(key);
  }
  override set(key: number, value: FailureSummaryNode): this {
    this.writes.add(key);
    return super.set(key, value);
  }
  clear(): void {
    this.reads.clear();
    this.writes.clear();
  }
}

function treeOn(binding: JobStateBinding): FailureSummaryTree & { readonly failureSummaryNodes: CountingNodes } {
  return {
    failureSummaryNodes: new CountingNodes(binding, "nodes"),
    get failureSummaryRoot() { return binding.store.root.root as number | undefined; },
    set failureSummaryRoot(value) { binding.store.root.root = value; },
    get failureSummaryNextNode() { return (binding.store.root.next as number | undefined) ?? 1; },
    set failureSummaryNextNode(value) { binding.store.root.next = value; },
  };
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE = Date.parse("2026-07-15T00:00:00.000Z");

function positionFactory(next: () => number) {
  let latest = 0;
  return {
    /** 已有时间里的一个（大量同一时间），或更晚的新时间（追加）。 */
    at(append: boolean): string {
      if (append) latest += 1;
      return new Date(BASE + (append ? latest : Math.floor(next() * (latest + 1))) * 60_000).toISOString();
    },
    /** 生产格式之外也混入互为前缀的短 id，覆盖码元次序的边界。 */
    id(): string {
      const length = next() < 0.1 ? 1 + Math.floor(next() * 3) : 26;
      let text = "";
      for (let index = 0; index < length; index += 1) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
      return `jobrun-${text}`;
    },
  };
}

/** 参考：严格早于 index 的那些，从最新一端起的连续失败数。 */
function referenceBefore(items: readonly Item[], index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && items[cursor]!.failed; cursor -= 1) count += 1;
  return count;
}

function insertionIndex(items: readonly Item[], position: FailureSummaryPosition): number {
  let index = 0;
  while (index < items.length && compareJobOccurrences(items[index]!, position) < 0) index += 1;
  return index;
}

function summaryOf(failures: readonly boolean[]): FailureSummary {
  let leading = 0;
  while (leading < failures.length && failures[leading]) leading += 1;
  let trailing = 0;
  while (trailing < failures.length && failures[failures.length - 1 - trailing]) trailing += 1;
  return { count: failures.length, allFailed: leading === failures.length, leading, trailing };
}

/** 从根遍历：叶子同深、项有序、容量与最少项数、first 与摘要等于由子树重算，返回全部项与树高。 */
function walk(tree: FailureSummaryTree, set: JobStateSet): { readonly items: Item[]; readonly height: number } {
  const items: Item[] = [];
  const reachable = new Set<number>();
  let leafDepth: number | undefined;
  const visit = (id: number, depth: number, isRoot: boolean): boolean[] => {
    reachable.add(id);
    const node = set.peek("nodes", id)?.value as FailureSummaryNode | undefined;
    expect(node, `node ${id}`).toBeDefined();
    const size = "entries" in node! ? node.entries.length : node!.children.length;
    expect(size).toBeLessThanOrEqual(FAILURE_SUMMARY_NODE_CAPACITY);
    if (!isRoot) expect(size).toBeGreaterThanOrEqual(FAILURE_SUMMARY_NODE_CAPACITY / 2);
    if ("entries" in node!) {
      leafDepth ??= depth;
      expect(depth).toBe(leafDepth);
      items.push(...node.entries.map((entry) => ({ ...entry })));
      return node.entries.map((entry) => entry.failed);
    }
    const failures: boolean[] = [];
    for (const child of node!.children) {
      const start = items.length;
      const below = visit(child.node, depth + 1, false);
      expect(child.first).toEqual({ scheduledFor: items[start]!.scheduledFor, jobRunId: items[start]!.jobRunId });
      expect(child.summary).toEqual(summaryOf(below));
      failures.push(...below);
    }
    return failures;
  };
  if (tree.failureSummaryRoot !== undefined) visit(tree.failureSummaryRoot, 1, true);
  for (let index = 1; index < items.length; index += 1) {
    expect(compareJobOccurrences(items[index - 1]!, items[index]!)).toBeLessThan(0);
  }
  // 没有不可达的节点
  expect(set.allEntries("nodes").map((entry) => Number(entry.subject)).sort((a, b) => a - b))
    .toEqual([...reachable].sort((a, b) => a - b));
  return { items, height: leafDepth ?? 0 };
}

/** 沿最左路径数层数。 */
function heightOf(tree: FailureSummaryTree, set: JobStateSet): number {
  let height = 0;
  let id = tree.failureSummaryRoot;
  while (id !== undefined) {
    height += 1;
    const node = set.peek("nodes", id)?.value as FailureSummaryNode;
    id = "children" in node ? node.children[0]!.node : undefined;
  }
  return height;
}

describe("job failure summary", () => {
  it("matches the full-order reference at every step and touches only the located path", { timeout: 120_000 }, () => {
    const next = random(20261026);
    const make = positionFactory(next);
    const set = new JobStateSet(PREFIX, FIELDS, true);
    const tree = treeOn(new JobStateBinding(set));
    const items: Item[] = [];
    let maxReads = 0;
    let maxWrites = 0;
    for (let step = 0; step < 4000; step += 1) {
      const roll = next();
      const before = heightOf(tree, set);
      tree.failureSummaryNodes.clear();
      if (roll < 0.3 && items.length) {
        const item = items[Math.floor(next() * items.length)]!;
        item.failed = !item.failed;
        setFailureSummaryEntry(tree, item, item.failed);
      } else {
        const position = { scheduledFor: make.at(roll > 0.8), jobRunId: make.id() };
        if (items.some((item) => compareJobOccurrences(item, position) === 0)) continue;
        const item = { ...position, failed: next() < 0.7 };
        items.splice(insertionIndex(items, item), 0, item);
        setFailureSummaryEntry(tree, item, item.failed);
      }
      const writes = tree.failureSummaryNodes.writes.size;
      // 读只在操作前的定位路径上（树高行）；写为路径加上每层至多一次分裂，再加新根
      maxReads = Math.max(maxReads, tree.failureSummaryNodes.reads.size);
      maxWrites = Math.max(maxWrites, writes);
      expect(tree.failureSummaryNodes.reads.size).toBeLessThanOrEqual(before);
      expect(writes).toBeLessThanOrEqual(2 * before + 1);
      const height = heightOf(tree, set);
      if (step % 250 === 0 || step === 3999) {
        expect(walk(tree, set)).toEqual({ items, height });
        items.forEach((item, index) => expect(failuresBefore(tree, item)).toBe(referenceBefore(items, index)));
      } else {
        for (let probe = 0; probe < 6; probe += 1) {
          const index = Math.floor(next() * items.length);
          tree.failureSummaryNodes.reads.clear();
          expect(failuresBefore(tree, items[index]!)).toBe(referenceBefore(items, index));
          expect(tree.failureSummaryNodes.reads.size).toBeLessThanOrEqual(height);
        }
        const outside = { scheduledFor: make.at(false), jobRunId: `${make.id()}-gap` };
        expect(failuresBefore(tree, outside)).toBe(referenceBefore(items, insertionIndex(items, outside)));
      }
      tree.failureSummaryNodes.reads.clear();
      expect(latestFailures(tree)).toBe(referenceBefore(items, items.length));
      expect(tree.failureSummaryNodes.reads.size).toBeLessThanOrEqual(1);
    }
    // 建出了三层以上的树，节点边界与多层合成都走到了
    console.log("FAILURE_SUMMARY_STEPS", JSON.stringify({ items: items.length, height: heightOf(tree, set), maxReads, maxWrites }));
    expect(heightOf(tree, set)).toBeGreaterThanOrEqual(3);
    expect(maxReads).toBe(heightOf(tree, set));
    expect(maxWrites).toBeGreaterThan(heightOf(tree, set));
  });

  it("loads the paths of many scattered changes level by level", async () => {
    const next = random(7);
    const make = positionFactory(next);
    const built = new JobStateSet(PREFIX, FIELDS, true);
    const builder = treeOn(new JobStateBinding(built));
    const items: Item[] = [];
    while (items.length < 3000) {
      const position = { scheduledFor: make.at(next() < 0.5), jobRunId: make.id() };
      if (items.some((item) => compareJobOccurrences(item, position) === 0)) continue;
      const item = { ...position, failed: next() < 0.6 };
      items.splice(insertionIndex(items, item), 0, item);
      setFailureSummaryEntry(builder, item, item.failed);
    }
    const { height } = walk(builder, built);
    expect(height).toBeGreaterThanOrEqual(3);
    // 持久行：完整模式下全部写出的行
    const rows = new Map<string, JsonValue>();
    for (const mutation of built.mutations()) if (mutation.kind === "put") rows.set(mutation.key, mutation.value);
    let batches = 0;
    const read = {
      get: async (key: string) => rows.get(key),
      getMany: async (keys: readonly string[]) => { batches += 1; return keys.map((key) => rows.get(key)); },
      scan: async () => ({ entries: [] }),
    } as unknown as DurableProjectionReadContext;
    const base = new JobStateSet(PREFIX, FIELDS);
    base.loadRoot(rows.get(base.rootKey));
    const binding = new JobStateBinding(base);
    const changed = Array.from({ length: 40 }, () => items[Math.floor(next() * items.length)]!)
      .filter((item, index, all) => all.indexOf(item) === index);
    let rounds = 0;
    await runWithJobState([[binding, base]], read, () => {
      rounds += 1;
      const tree = treeOn(binding);
      requireFailureSummaryPaths(tree, changed);
      for (const item of changed) setFailureSummaryEntry(tree, item, !item.failed);
    });
    for (const item of changed) item.failed = !item.failed;
    console.log("FAILURE_SUMMARY_BATCHED", JSON.stringify({ items: items.length, height, changed: changed.length, batches, rounds }));
    // 每层一次成批读取：读取批次不超过树高，轮数不超过树高加一，与改动条数无关
    expect(batches).toBeLessThanOrEqual(height);
    expect(rounds).toBeLessThanOrEqual(height + 1);
    // 改完的结果：完整装入后逐位置对照
    for (const mutation of binding.store.mutations()) {
      expect(mutation.kind).toBe("put");
      if (mutation.kind === "put") rows.set(mutation.key, mutation.value);
    }
    const after = new JobStateSet(PREFIX, FIELDS, true);
    for (const [key, value] of rows) after.loadStored(key, value);
    const result = treeOn(new JobStateBinding(after));
    expect(walk(result, after).items).toEqual(items);
    items.forEach((item, index) => expect(failuresBefore(result, item)).toBe(referenceBefore(items, index)));
    expect(latestFailures(result)).toBe(referenceBefore(items, items.length));
  });

  it("preloads only the located paths of a batch's failure candidates, level by level, before the reducer runs", async () => {
    const next = random(11);
    const make = positionFactory(next);
    // 真实主投影布局（完整模式）上建摘要；全部行作为持久行
    const complete = createJobMainState("task-preload", true);
    const state = jobProjectionView(new JobStateBinding(complete));
    const items: Item[] = [];
    while (items.length < 3000) {
      const position = { scheduledFor: make.at(next() < 0.5), jobRunId: make.id() };
      // 生产里 jobRunId 唯一：occurrence 按它落行
      if (items.some((item) => item.jobRunId === position.jobRunId)) continue;
      const item = { ...position, failed: false };
      items.splice(insertionIndex(items, item), 0, item);
      state.occurrences.set(item.jobRunId, { ...position, state: "queued" } as JobOccurrence);
      setFailureSummaryEntry(state, item, false);
    }
    const rows = new Map<string, JsonValue>();
    for (const mutation of complete.mutations()) if (mutation.kind === "put") rows.set(mutation.key, mutation.value);
    let batches = 0;
    const read = {
      get: async (key: string) => rows.get(key),
      getMany: async (keys: readonly string[]) => { batches += 1; return keys.map((key) => rows.get(key)); },
      scan: async () => ({ entries: [] }),
    } as unknown as DurableProjectionReadContext;
    const fresh = () => {
      const main = createJobMainState("task-preload");
      main.loadRoot(rows.get(main.rootKey));
      return main;
    };
    const height = (() => {
      let levels = 0;
      let id = state.failureSummaryRoot;
      while (id !== undefined) {
        levels += 1;
        const node = state.failureSummaryNodes.get(id)!;
        id = "children" in node ? node.children[0]!.node : undefined;
      }
      return levels;
    })();
    expect(height).toBeGreaterThanOrEqual(3);
    const failing = Array.from({ length: 40 }, () => items[Math.floor(next() * items.length)]!)
      .filter((item, index, all) => all.indexOf(item) === index);
    const inserted = { scheduledFor: make.at(false), jobRunId: `${make.id()}-new` };
    const bodies = [
      ...failing.map((item) => ({ t: "state", jobRunId: item.jobRunId, state: "failed", statusRevision: 2 })),
      { t: "occurrence", occ: { ...inserted, state: "queued" } },
    ];
    // 按主体预装已把这些 run 的 occurrence 行装入
    const main = fresh();
    for (const item of failing) {
      const key = main.storageKey("occurrences", item.jobRunId);
      main.loadStored(key, rows.get(key));
    }
    await preloadFailureSummaryPaths(main, bodies, read);
    const view = jobProjectionView(new JobStateBinding(main));
    expect(missingFailureSummaryNodes(view, [...failing, inserted])).toEqual([]);
    // 每层一次成批读取
    expect(batches).toBeLessThanOrEqual(height);
    // 普通状态推进与错过的 occurrence 不装摘要节点
    batches = 0;
    const idle = fresh();
    const key = idle.storageKey("occurrences", failing[0]!.jobRunId);
    idle.loadStored(key, rows.get(key));
    await preloadFailureSummaryPaths(idle, [
      { t: "state", jobRunId: failing[0]!.jobRunId, state: "running", statusRevision: 2 },
      { t: "occurrence", occ: { ...inserted, state: "missed" } },
    ], read);
    expect(batches).toBe(0);
  });
});
