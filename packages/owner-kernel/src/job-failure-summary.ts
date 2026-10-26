import { compareJobOccurrences } from "@zhixing/core/protocol";
import { corruptJobJournal } from "./job-run-contracts.js";
import type { KeyedMap } from "./job-run-state.js";

/**
 * 连续失败的可合并摘要。非错过的 occurrence 按完整次序（compareJobOccurrences）排成一棵按键落盘的树：
 * 叶子存每一条是否失败，内部节点存各子树的摘要。插入一条、或一条的失败与否改变，只读写它的定位路径；
 * 最新一端的连续失败数、以及任一位置之前的连续失败数，都由路径上的摘要合成。
 * occurrence 从不删除，节点只分裂不合并：非根节点至少 NODE_CAPACITY / 2 项，树高随条数对数增长。
 */

/** 一段 occurrence 的摘要：条数、是否全部失败、从最早一端与最新一端起的连续失败数。 */
export interface FailureSummary {
  readonly count: number;
  readonly allFailed: boolean;
  readonly leading: number;
  readonly trailing: number;
}

/** 一条 occurrence 在完整次序里的位置。 */
export interface FailureSummaryPosition {
  readonly scheduledFor: string;
  readonly jobRunId: string;
}

interface FailureSummaryEntry extends FailureSummaryPosition {
  readonly failed: boolean;
}

interface FailureSummaryChild {
  readonly node: number;
  /** 子树里最早的一条：下降时据此选子节点。 */
  readonly first: FailureSummaryPosition;
  readonly summary: FailureSummary;
}

export type FailureSummaryNode =
  | { readonly entries: readonly FailureSummaryEntry[] }
  | { readonly children: readonly FailureSummaryChild[] };

/** 摘要所在的投影字段：节点映射与根行里的两个标量。 */
export interface FailureSummaryTree {
  readonly failureSummaryNodes: KeyedMap<number, FailureSummaryNode>;
  failureSummaryRoot: number | undefined;
  failureSummaryNextNode: number;
}

/** 每个节点至多的项数；超过即对半分裂。 */
export const FAILURE_SUMMARY_NODE_CAPACITY = 32;

const EMPTY: FailureSummary = { count: 0, allFailed: true, leading: 0, trailing: 0 };

/** 较早一段与较新一段相接后的摘要。 */
export function combineFailureSummaries(older: FailureSummary, newer: FailureSummary): FailureSummary {
  return {
    count: older.count + newer.count,
    allFailed: older.allFailed && newer.allFailed,
    leading: older.allFailed ? older.count + newer.leading : older.leading,
    trailing: newer.allFailed ? newer.count + older.trailing : newer.trailing,
  };
}

const single = (failed: boolean): FailureSummary =>
  failed ? { count: 1, allFailed: true, leading: 1, trailing: 1 } : { count: 1, allFailed: false, leading: 0, trailing: 0 };

const fold = (parts: readonly FailureSummary[]): FailureSummary => parts.reduce(combineFailureSummaries, EMPTY);

function summarize(node: FailureSummaryNode): FailureSummary {
  return "entries" in node
    ? fold(node.entries.map((entry) => single(entry.failed)))
    : fold(node.children.map((child) => child.summary));
}

function firstOf(node: FailureSummaryNode): FailureSummaryPosition {
  const first = "entries" in node ? node.entries[0] : node.children[0]?.first;
  if (!first) throw corruptJobJournal("Failure summary node is empty");
  return { scheduledFor: first.scheduledFor, jobRunId: first.jobRunId };
}

/** 下降时选的子节点：first 不晚于该位置的最后一个；比全部都早时取第一个。 */
function childIndex(children: readonly FailureSummaryChild[], position: FailureSummaryPosition): number {
  for (let index = children.length - 1; index > 0; index -= 1) {
    if (compareJobOccurrences(children[index]!.first, position) <= 0) return index;
  }
  return 0;
}

/** 叶子里第一条不早于该位置的项。 */
function lowerBound(entries: readonly FailureSummaryEntry[], position: FailureSummaryPosition): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareJobOccurrences(entries[middle]!, position) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nodeAt(tree: Pick<FailureSummaryTree, "failureSummaryNodes">, id: number): FailureSummaryNode {
  const node = tree.failureSummaryNodes.get(id);
  if (!node) throw corruptJobJournal("Failure summary names an unknown node");
  return node;
}

/** 最新一端的连续失败数（错过的不在摘要里，不计也不打断）。读根节点一行。 */
export function latestFailures(tree: Pick<FailureSummaryTree, "failureSummaryNodes" | "failureSummaryRoot">): number {
  const root = tree.failureSummaryRoot;
  return root === undefined ? 0 : summarize(nodeAt(tree, root)).trailing;
}

/**
 * 完整次序里严格早于该位置的那些 occurrence，从最新一端起的连续失败数。
 * 下降时记下每层位于路径左侧的兄弟摘要，再由深到浅与叶子里的前缀合成；只读定位路径。
 */
export function failuresBefore(
  tree: Pick<FailureSummaryTree, "failureSummaryNodes" | "failureSummaryRoot">,
  position: FailureSummaryPosition,
): number {
  if (tree.failureSummaryRoot === undefined) return 0;
  const lefts: FailureSummary[] = [];
  let node = nodeAt(tree, tree.failureSummaryRoot);
  while ("children" in node) {
    const index = childIndex(node.children, position);
    lefts.push(fold(node.children.slice(0, index).map((child) => child.summary)));
    node = nodeAt(tree, node.children[index]!.node);
  }
  let prefix = fold(node.entries.slice(0, lowerBound(node.entries, position)).map((entry) => single(entry.failed)));
  for (let level = lefts.length - 1; level >= 0; level -= 1) prefix = combineFailureSummaries(lefts[level]!, prefix);
  return prefix.trailing;
}

/**
 * 记下一条 occurrence 是否失败：不在摘要里就按次序插入，在就改它的值。
 * 下降到叶子，改完沿路径回写每层的 first 与摘要，溢出即对半分裂（左边留原编号，右边取新编号），根分裂时另建新根。
 */
export function setFailureSummaryEntry(tree: FailureSummaryTree, position: FailureSummaryPosition, failed: boolean): void {
  const entry: FailureSummaryEntry = { scheduledFor: position.scheduledFor, jobRunId: position.jobRunId, failed };
  if (tree.failureSummaryRoot === undefined) {
    const id = allocate(tree);
    tree.failureSummaryNodes.set(id, { entries: [entry] });
    tree.failureSummaryRoot = id;
    return;
  }
  const path: { readonly id: number; readonly children: readonly FailureSummaryChild[]; readonly index: number }[] = [];
  let id = tree.failureSummaryRoot;
  let node = nodeAt(tree, id);
  while ("children" in node) {
    const index = childIndex(node.children, position);
    path.push({ id, children: node.children, index });
    id = node.children[index]!.node;
    node = nodeAt(tree, id);
  }
  const entries = [...node.entries];
  const at = lowerBound(entries, position);
  if (at < entries.length && compareJobOccurrences(entries[at]!, position) === 0) {
    if (entries[at]!.failed === failed) return;
    entries[at] = entry;
  } else {
    entries.splice(at, 0, entry);
  }
  let pieces = writeNodes(tree, id, entries.length > FAILURE_SUMMARY_NODE_CAPACITY
    ? [{ entries: entries.slice(0, entries.length >>> 1) }, { entries: entries.slice(entries.length >>> 1) }]
    : [{ entries }]);
  for (let level = path.length - 1; level >= 0; level -= 1) {
    const parent = path[level]!;
    const children = [...parent.children];
    children.splice(parent.index, 1, ...pieces);
    pieces = writeNodes(tree, parent.id, children.length > FAILURE_SUMMARY_NODE_CAPACITY
      ? [{ children: children.slice(0, children.length >>> 1) }, { children: children.slice(children.length >>> 1) }]
      : [{ children }]);
  }
  if (pieces.length > 1) {
    const root = allocate(tree);
    tree.failureSummaryNodes.set(root, { children: pieces });
    tree.failureSummaryRoot = root;
  }
}

function allocate(tree: FailureSummaryTree): number {
  const id = tree.failureSummaryNextNode;
  tree.failureSummaryNextNode = id + 1;
  return id;
}

/** 写下一个节点（分裂时第二半取新编号），返回父节点里对应的项。 */
function writeNodes(tree: FailureSummaryTree, id: number, nodes: readonly FailureSummaryNode[]): FailureSummaryChild[] {
  return nodes.map((node, index) => {
    const target = index === 0 ? id : allocate(tree);
    tree.failureSummaryNodes.set(target, node);
    return { node: target, first: firstOf(node), summary: summarize(node) };
  });
}

/**
 * 这些位置的定位路径上尚未装入的节点（每条路径只给最浅的一个）。按层成批装入它们，
 * 装入的轮数不超过树高，与位置条数无关。已装入却不存在的节点即摘要损坏。
 */
export function missingFailureSummaryNodes(
  tree: Pick<FailureSummaryTree, "failureSummaryNodes" | "failureSummaryRoot">,
  positions: readonly FailureSummaryPosition[],
): string[] {
  const root = tree.failureSummaryRoot;
  if (root === undefined) return [];
  const set = tree.failureSummaryNodes.binding.store;
  const field = tree.failureSummaryNodes.field;
  const missing = new Set<string>();
  for (const position of positions) {
    let id = root;
    for (;;) {
      const key = set.storageKey(field, id);
      if (!set.complete && !set.isLoaded(key)) {
        missing.add(key);
        break;
      }
      const node = nodeAt(tree, id);
      if (!("children" in node)) break;
      id = node.children[childIndex(node.children, position)]!.node;
    }
  }
  return [...missing];
}

/** 在待装入重做里运行时：路径上缺的节点按层一次报出。 */
export function requireFailureSummaryPaths(
  tree: Pick<FailureSummaryTree, "failureSummaryNodes" | "failureSummaryRoot">,
  positions: readonly FailureSummaryPosition[],
): void {
  tree.failureSummaryNodes.binding.store.requireRows(missingFailureSummaryNodes(tree, positions));
}
