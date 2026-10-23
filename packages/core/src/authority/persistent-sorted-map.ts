/**
 * 不可变有序映射（持久化 B+ 树）。写入只复制根到叶的路径并返回新映射，旧映射原样可读，
 * 所以读视图持有引用即为快照，无需复制；点查与有序范围遍历均为 O(log n)。
 * 键按 UTF-16 码元顺序比较，与派生索引的段格式一致。只支持写入/覆盖，删除由调用方以墓碑值表达。
 */
const MAX_NODE_ITEMS = 64;

interface Leaf<V> { readonly leaf: true; readonly keys: readonly string[]; readonly values: readonly V[] }
interface Branch<V> { readonly leaf: false; readonly mins: readonly string[]; readonly children: readonly Node<V>[] }
type Node<V> = Leaf<V> | Branch<V>;

function lowerBound(keys: readonly string[], key: string): number {
  let low = 0, high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (keys[middle]! < key) low = middle + 1; else high = middle;
  }
  return low;
}

/** 最后一个最小键不大于 key 的子树；key 小于全部子树时落在第一个。 */
function childIndex(mins: readonly string[], key: string): number {
  let low = 1, high = mins.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (mins[middle]! <= key) low = middle + 1; else high = middle;
  }
  return low - 1;
}

const minKey = <V>(node: Node<V>): string => node.leaf ? node.keys[0]! : node.mins[0]!;

function splitLeaf<V>(keys: string[], values: V[]): [Leaf<V>, Leaf<V>] {
  const half = keys.length >> 1;
  return [{ leaf: true, keys: keys.slice(0, half), values: values.slice(0, half) },
    { leaf: true, keys: keys.slice(half), values: values.slice(half) }];
}

function splitBranch<V>(mins: string[], children: Node<V>[]): [Branch<V>, Branch<V>] {
  const half = children.length >> 1;
  return [{ leaf: false, mins: mins.slice(0, half), children: children.slice(0, half) },
    { leaf: false, mins: mins.slice(half), children: children.slice(half) }];
}

/** 返回替换后的节点（超出容量时为两个），以及是否新增了键。 */
function insert<V>(node: Node<V>, key: string, value: V): { nodes: readonly Node<V>[]; added: boolean } {
  if (node.leaf) {
    const index = lowerBound(node.keys, key);
    const keys = node.keys.slice(), values = node.values.slice();
    if (keys[index] === key) {
      values[index] = value;
      return { nodes: [{ leaf: true, keys, values }], added: false };
    }
    keys.splice(index, 0, key);
    values.splice(index, 0, value);
    return { nodes: keys.length > MAX_NODE_ITEMS ? splitLeaf(keys, values) : [{ leaf: true, keys, values }], added: true };
  }
  const index = childIndex(node.mins, key);
  const result = insert(node.children[index]!, key, value);
  const mins = node.mins.slice(), children = node.children.slice();
  children.splice(index, 1, ...result.nodes);
  mins.splice(index, 1, ...result.nodes.map(minKey));
  return { nodes: children.length > MAX_NODE_ITEMS ? splitBranch(mins, children) : [{ leaf: false, mins, children }], added: result.added };
}

function* valuesFrom<V>(node: Node<V>, key: string | undefined): Generator<readonly [string, V]> {
  if (node.leaf) {
    for (let index = key === undefined ? 0 : lowerBound(node.keys, key); index < node.keys.length; index++) {
      yield [node.keys[index]!, node.values[index]!];
    }
    return;
  }
  const first = key === undefined ? 0 : childIndex(node.mins, key);
  yield* valuesFrom(node.children[first]!, key);
  for (let index = first + 1; index < node.children.length; index++) yield* valuesFrom(node.children[index]!, undefined);
}

export class PersistentSortedMap<V> {
  static empty<V>(): PersistentSortedMap<V> { return new PersistentSortedMap<V>(undefined, 0); }

  private constructor(private readonly root: Node<V> | undefined, readonly size: number) {}

  get(key: string): V | undefined {
    let node = this.root;
    while (node && !node.leaf) node = node.children[childIndex(node.mins, key)];
    if (!node) return undefined;
    const index = lowerBound(node.keys, key);
    return node.keys[index] === key ? node.values[index] : undefined;
  }

  has(key: string): boolean {
    let node = this.root;
    while (node && !node.leaf) node = node.children[childIndex(node.mins, key)];
    return node !== undefined && node.keys[lowerBound(node.keys, key)] === key;
  }

  /** 依次写入（后写覆盖先写），返回新映射；本映射不变。 */
  withEntries(entries: Iterable<readonly [string, V]>): PersistentSortedMap<V> {
    let root = this.root, size = this.size, changed = false;
    for (const [key, value] of entries) {
      changed = true;
      if (!root) { root = { leaf: true, keys: [key], values: [value] }; size = 1; continue; }
      const result = insert(root, key, value);
      root = result.nodes.length === 1 ? result.nodes[0]! : { leaf: false, mins: result.nodes.map(minKey), children: result.nodes };
      if (result.added) size++;
    }
    return changed ? new PersistentSortedMap(root, size) : this;
  }

  /** 从 lowerBound（含）开始按键升序遍历。 */
  *entriesFrom(lowerBoundKey?: string): IterableIterator<[string, V]> {
    if (!this.root) return;
    for (const [key, value] of valuesFrom(this.root, lowerBoundKey)) yield [key, value];
  }

  *values(): IterableIterator<V> { for (const [, value] of this.entriesFrom()) yield value; }
  [Symbol.iterator](): IterableIterator<[string, V]> { return this.entriesFrom(); }
}

