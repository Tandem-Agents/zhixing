/**
 * 候选命令的自定义 resort —— spec §6.2 的优先级表实现
 *
 * Fuse.js 返回的 FuseResult 已经按 fuzzy score 排过，但**精确匹配和前缀匹配
 * 在 UX 上应该硬压过纯 fuzzy**。这个模块就是把 Fuse 的结果再按严格的
 * "精确 > 前缀 > 模糊" 优先级重排一遍。
 *
 * 优先级（严格顺序）：
 *   1. 精确 name 匹配
 *   2. 精确 alias 匹配
 *   3. Prefix name 匹配（同为 prefix 时**短名字优先** —— 更接近 exact）
 *   4. Prefix alias 匹配（同为 prefix 时短别名优先）
 *   5. Fuse 分数
 *   6. MRU score 作为 tiebreaker
 *
 * 所有比较都大小写不敏感。query 用 toLowerCase 预处理后传入。
 *
 * 纯函数 —— 不依赖 provider / broker / fuse 实例，只要能提供候选的
 * `SortableCandidate` 即可。便于单独测试所有分支。
 */

// ─── 类型 ───

/**
 * 排序输入的标准形状。caller 负责从 FuseResult 或其他结构 adapt 过来。
 */
export interface SortableCandidate<T = unknown> {
  readonly name: string;
  readonly aliases: readonly string[];
  /** Fuse.js 返回的原始 score（越小越匹配）。无 Fuse 上下文时传 0 */
  readonly fuseScore: number;
  /** MRU usage score（越大越常用）。无 MRU 时传 0 */
  readonly usageScore: number;
  /** 透传数据 —— 通常是 CommandDef 本身 */
  readonly payload: T;
}

// ─── 比较器 ───

/**
 * 构造一个比较器函数，按 spec §6.2 的优先级对 candidate 排序。
 *
 * 设计决策：返回比较器（而不是直接排序整个数组）让调用方能够灵活使用 ——
 * 可以复用到 Array.prototype.sort / toSorted / 外部排序算法。
 *
 * @param lowerQuery 已转小写的 query 字符串；空字符串表示"空 query 场景"
 *                   （注：空 query 不应走这个比较器，应走 empty-query 分类路径）
 */
export function createCandidateComparator<T>(
  lowerQuery: string,
): (a: SortableCandidate<T>, b: SortableCandidate<T>) => number {
  return (a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aAliases = a.aliases.map((al) => al.toLowerCase());
    const bAliases = b.aliases.map((al) => al.toLowerCase());

    // 1. 精确 name 匹配（最高优先级）
    const aExactName = aName === lowerQuery;
    const bExactName = bName === lowerQuery;
    if (aExactName !== bExactName) return aExactName ? -1 : 1;

    // 2. 精确 alias 匹配
    const aExactAlias = aAliases.some((al) => al === lowerQuery);
    const bExactAlias = bAliases.some((al) => al === lowerQuery);
    if (aExactAlias !== bExactAlias) return aExactAlias ? -1 : 1;

    // 3. Prefix name 匹配
    const aPrefixName = lowerQuery !== "" && aName.startsWith(lowerQuery);
    const bPrefixName = lowerQuery !== "" && bName.startsWith(lowerQuery);
    if (aPrefixName !== bPrefixName) return aPrefixName ? -1 : 1;
    // 同为 prefix name 时，**短名字优先**（更接近 exact）
    if (aPrefixName && bPrefixName && aName.length !== bName.length) {
      return aName.length - bName.length;
    }

    // 4. Prefix alias 匹配（取每个候选里命中的最短 alias 做比较）
    const aPrefixAlias =
      lowerQuery !== ""
        ? aAliases.find((al) => al.startsWith(lowerQuery))
        : undefined;
    const bPrefixAlias =
      lowerQuery !== ""
        ? bAliases.find((al) => al.startsWith(lowerQuery))
        : undefined;
    if (!!aPrefixAlias !== !!bPrefixAlias) return aPrefixAlias ? -1 : 1;
    if (
      aPrefixAlias &&
      bPrefixAlias &&
      aPrefixAlias.length !== bPrefixAlias.length
    ) {
      return aPrefixAlias.length - bPrefixAlias.length;
    }

    // 5. Fuse score（越小越好，所以 asc）
    const scoreDiff = a.fuseScore - b.fuseScore;
    // 允许 fuse score 的微小差异（0.02）归并到下一层 tiebreak，
    // 防止"同样好匹配"的条目因为浮点尘埃被错位
    if (Math.abs(scoreDiff) > 0.02) return scoreDiff;

    // 6. MRU usage score（越大越好，所以 desc）
    return b.usageScore - a.usageScore;
  };
}

/**
 * 便利函数：对一组 candidates 按 spec §6.2 顺序排序（稳定、返回新数组）。
 */
export function sortCandidates<T>(
  candidates: readonly SortableCandidate<T>[],
  lowerQuery: string,
): SortableCandidate<T>[] {
  const comparator = createCandidateComparator<T>(lowerQuery);
  return [...candidates].sort(comparator);
}
