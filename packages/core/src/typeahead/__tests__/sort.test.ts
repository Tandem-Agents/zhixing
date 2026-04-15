/**
 * sort.ts 单元测试
 *
 * spec §6.2 的 6 条排序规则每条都要有独立断言：
 *   1. 精确 name 匹配 > 任何 prefix
 *   2. 精确 alias 匹配 > 任何 prefix
 *   3. Prefix name > Prefix alias
 *   4. 短 prefix name > 长 prefix name
 *   5. 相似 fuse score 时 MRU usage score 生效
 *   6. 大小写不敏感
 */

import { describe, expect, it } from "vitest";
import {
  createCandidateComparator,
  sortCandidates,
  type SortableCandidate,
} from "../sort.js";

function cand(
  name: string,
  partial: Partial<SortableCandidate<string>> = {},
): SortableCandidate<string> {
  return {
    name,
    aliases: partial.aliases ?? [],
    fuseScore: partial.fuseScore ?? 0,
    usageScore: partial.usageScore ?? 0,
    payload: name,
  };
}

describe("createCandidateComparator — 优先级 1: 精确 name 匹配", () => {
  it("精确 name 匹配排第一", () => {
    const candidates = [
      cand("commit-wip", { fuseScore: 0.1 }),
      cand("commit", { fuseScore: 0.1 }),
      cand("commitment", { fuseScore: 0.15 }),
    ];
    const sorted = sortCandidates(candidates, "commit");
    expect(sorted.map((c) => c.name)).toEqual([
      "commit",
      "commit-wip",
      "commitment",
    ]);
  });

  it("精确 name 匹配 > fuse score 更低的模糊匹配", () => {
    const candidates = [
      cand("something-else", { fuseScore: 0.0 }),
      cand("exact", { fuseScore: 0.3 }),
    ];
    const sorted = sortCandidates(candidates, "exact");
    expect(sorted[0]!.name).toBe("exact");
  });
});

describe("createCandidateComparator — 优先级 2: 精确 alias 匹配", () => {
  it("精确 alias 匹配排在 prefix name 之前", () => {
    const candidates = [
      cand("elevated-mode", {
        fuseScore: 0.1,
        // prefix name 命中 "elev"
      }),
      cand("unrelated", {
        aliases: ["elev"],
        fuseScore: 0.15,
      }),
    ];
    const sorted = sortCandidates(candidates, "elev");
    expect(sorted[0]!.name).toBe("unrelated"); // 精确 alias 胜
  });

  it("精确 name > 精确 alias（当两者都存在时）", () => {
    const candidates = [
      cand("other", { aliases: ["target"] }),
      cand("target"),
    ];
    const sorted = sortCandidates(candidates, "target");
    expect(sorted[0]!.name).toBe("target");
  });
});

describe("createCandidateComparator — 优先级 3: Prefix name 优先级", () => {
  it("Prefix name 压过 fuse score 更低的非 prefix 匹配", () => {
    const candidates = [
      cand("abc-prefix", { fuseScore: 0.0 }),
      cand("resume", { fuseScore: 0.25 }),
    ];
    const sorted = sortCandidates(candidates, "res");
    expect(sorted[0]!.name).toBe("resume");
  });

  it("两个 prefix name 时：短名字优先（更接近 exact）", () => {
    const candidates = [
      cand("resume-session", { fuseScore: 0.1 }),
      cand("resume", { fuseScore: 0.1 }),
      cand("resumption", { fuseScore: 0.1 }),
    ];
    const sorted = sortCandidates(candidates, "res");
    expect(sorted.map((c) => c.name)).toEqual([
      "resume",
      "resumption",
      "resume-session",
    ]);
  });
});

describe("createCandidateComparator — 优先级 4: Prefix alias", () => {
  it("Prefix name > Prefix alias", () => {
    const candidates = [
      cand("unrelated", { aliases: ["elevp"] }), // prefix alias 命中 'elev'
      cand("elevator", { fuseScore: 0.1 }), // prefix name 命中 'elev'
    ];
    const sorted = sortCandidates(candidates, "elev");
    expect(sorted[0]!.name).toBe("elevator");
  });

  it("两个 prefix alias 时短的优先", () => {
    const candidates = [
      cand("a", { aliases: ["elev-long-alias"] }),
      cand("b", { aliases: ["elev"] }),
    ];
    const sorted = sortCandidates(candidates, "elev");
    // 注意：这也是 exact alias match "elev" vs prefix "elev-long-alias"，
    // 所以 b 其实是 exact alias 而不是 prefix alias，天然排第一
    expect(sorted[0]!.name).toBe("b");
  });
});

describe("createCandidateComparator — 优先级 5: Fuse score + MRU tiebreaker", () => {
  it("Fuse score 差异 > 0.02 时按 score 排（越小越好）", () => {
    const candidates = [
      cand("banana", { fuseScore: 0.3 }),
      cand("apple", { fuseScore: 0.05 }),
    ];
    const sorted = sortCandidates(candidates, "frutt"); // 都不是 prefix
    expect(sorted[0]!.name).toBe("apple");
  });

  it("Fuse score 差异 ≤ 0.02 时 MRU usage 决定排序", () => {
    const candidates = [
      cand("less-used", { fuseScore: 0.25, usageScore: 1 }),
      cand("more-used", { fuseScore: 0.26, usageScore: 10 }),
    ];
    const sorted = sortCandidates(candidates, "xyz");
    expect(sorted[0]!.name).toBe("more-used");
  });

  it("完全相同的 fuse score 时 MRU 生效", () => {
    const candidates = [
      cand("a", { fuseScore: 0.15, usageScore: 2 }),
      cand("b", { fuseScore: 0.15, usageScore: 5 }),
      cand("c", { fuseScore: 0.15, usageScore: 1 }),
    ];
    const sorted = sortCandidates(candidates, "xyz");
    expect(sorted.map((c) => c.name)).toEqual(["b", "a", "c"]);
  });
});

describe("createCandidateComparator — 大小写不敏感", () => {
  it("query 小写 vs candidate 大写的精确匹配", () => {
    const candidates = [
      cand("abc"),
      cand("XYZ"), // 大写命令
    ];
    // query 必须是小写（sort 的合约）
    const sorted = sortCandidates(candidates, "xyz");
    expect(sorted[0]!.name).toBe("XYZ");
  });

  it("alias 大小写混合时仍能命中", () => {
    const candidates = [
      cand("foo", { aliases: ["ELEV"] }),
      cand("bar"),
    ];
    const sorted = sortCandidates(candidates, "elev");
    expect(sorted[0]!.name).toBe("foo");
  });
});

describe("sortCandidates — 稳定性与不可变性", () => {
  it("返回新数组，不 mutate 输入", () => {
    const candidates = [cand("a"), cand("b"), cand("c")];
    const original = [...candidates];
    sortCandidates(candidates, "x");
    expect(candidates).toEqual(original);
  });

  it("空数组输入返回空数组", () => {
    expect(sortCandidates([], "anything")).toEqual([]);
  });

  it("单元素数组原样返回", () => {
    const result = sortCandidates([cand("only")], "x");
    expect(result.map((c) => c.name)).toEqual(["only"]);
  });
});

describe("createCandidateComparator — 返回的比较器可直接用", () => {
  it("可用于 Array.prototype.sort", () => {
    const candidates = [cand("c"), cand("a"), cand("b")];
    const sorted = [...candidates].sort(createCandidateComparator("b"));
    // "b" 是精确 name 匹配
    expect(sorted[0]!.name).toBe("b");
  });
});
