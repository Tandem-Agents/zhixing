/**
 * 调控缺键一次报全：同步判断推演一批调控记录前，静态可得的缺键在一次 GovernorStateRequired 里报全，
 * 装入一次后不再缺；同一次缺键的装入只执行一次（日志后台发起与协调者等待共享同一次）。
 */
import { describe, expect, it } from "vitest";
import type { DurableProjectionReadContext } from "../durable-projection-index.js";
import {
  GovernorStateRequired, GovernorWorkingSet, consumedUsageBlock, loadGovernorNeeds, requireGovernorRecordNeeds, requireGovernorSettlementNeeds,
} from "../resource-governor-index.js";

const empty = {
  get: async () => undefined,
  getMany: async (keys: readonly string[]) => keys.map(() => undefined),
  scan: async () => ({ entries: [] }),
} as unknown as DurableProjectionReadContext;
const records = [{ body: { t: "settle", reservationId: "root-a" } }, { body: { t: "release", reservationId: "root-b" } }];

describe("调控缺键一次报全", () => {
  it("同一批记录的静态缺键在一次错误里报全，装入一次后推演前不再缺", async () => {
    const set = new GovernorWorkingSet("2026-01-01T00:00:00.000Z");
    let loads = 0;
    set.bindLoader(async (needs) => { loads++; await loadGovernorNeeds(set, needs, empty); });
    let first: unknown;
    try { requireGovernorRecordNeeds(set, records); } catch (error) { first = error; }
    expect(first).toBeInstanceOf(GovernorStateRequired);
    const needs = (first as GovernorStateRequired).needs;
    // 两条记录各自的预留键与三类索引页，一次全部报出
    expect(needs.filter((need) => "key" in need)).toHaveLength(2);
    expect(needs.filter((need) => "page" in need)).toHaveLength(6);
    await (first as GovernorStateRequired).prepareOutside!();
    expect(() => requireGovernorRecordNeeds(set, records)).not.toThrow();
    expect(loads).toBe(1);
  });

  it("同一次缺键的装入只执行一次，并发等待者共享结果，失败也共享", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const required = new GovernorStateRequired([{ key: "r:x" }], async () => { calls++; await gate; });
    const background = required.prepareOutside!();
    const waiting = required.prepareOutside!();
    release();
    await Promise.all([background, waiting]);
    expect(calls).toBe(1);
    const failure = new Error("load failed");
    const failing = new GovernorStateRequired([{ key: "r:y" }], async () => { calls++; throw failure; });
    await expect(failing.prepareOutside!()).rejects.toBe(failure);
    await expect(failing.prepareOutside!()).rejects.toBe(failure);
    expect(calls).toBe(2);
  });

  it("完整投影（非按键工作集）不需要装入，直接通过", () => {
    expect(() => requireGovernorRecordNeeds({} as never, records)).not.toThrow();
    expect(() => requireGovernorSettlementNeeds({} as never, "root-a", 1, 3)).not.toThrow();
  });
});

/** 已装入一个顶层根（及其序号键）的工作集。 */
function withRoot(root: string, digest: string): GovernorWorkingSet {
  const set = new GovernorWorkingSet("2026-01-01T00:00:00.000Z");
  const empty = {};
  set.loadStored(`r:${root}`, { rd: digest, p: { lease: { reservationId: root, digest }, rootReservationId: root, depth: 0, used: empty,
    descendantUsed: empty, reservedUsage: empty, descendantReservedUsage: empty, reservedForChildren: empty, settled: false, state: "active" } } as never);
  return set;
}

/** 记下每次扫描的区间；页内条目由 entries 按区间给出。 */
function recordingRead(entries: (range: Record<string, string>) => { key: string; value: { id: string } }[] = () => []) {
  const ranges: Record<string, string>[] = [];
  const read = {
    get: async () => undefined,
    getMany: async (keys: readonly string[]) => keys.map(() => undefined),
    scan: async (range: Record<string, string>) => { ranges.push(range); return { entries: entries(range) }; },
  } as unknown as DurableProjectionReadContext;
  return { read, ranges };
}

describe("用量块页按闭区间 [from, to] 定界", () => {
  it("装页扫描只带含下界与不含上界，上界是 to 的下一个序号，不越出这一段", async () => {
    const set = withRoot("root-a", "digest-a");
    let missing: unknown;
    try { consumedUsageBlock(set, "root-a", 257, 300); } catch (error) { missing = error; }
    expect(missing).toBeInstanceOf(GovernorStateRequired);
    const { read, ranges } = recordingRead();
    await loadGovernorNeeds(set, (missing as GovernorStateRequired).needs, read);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    // 扫描区间只认 gte/gt/lt：闭上界若以 lte 传出会被当作无上界，从这一根扫到投影末尾
    expect(Object.keys(range!).sort()).toEqual(["gte", "lt"]);
    const prefix = range!.gte!.slice(0, -16);
    expect(range!.gte).toBe(`${prefix}0000000000000257`);
    expect(range!.lt).toBe(`${prefix}0000000000000301`);
    expect(consumedUsageBlock(set, "root-a", 257, 300)).toEqual([]);
  });
});

describe("终结结算的确切依赖一次报全", () => {
  it("用量块页与同根终结记录必读的索引页在一次错误里报全，装入一次后两步都不再缺", async () => {
    const set = withRoot("root-a", "digest-a");
    let first: unknown;
    try { requireGovernorSettlementNeeds(set, "root-a", 1, 2); } catch (error) { first = error; }
    expect(first).toBeInstanceOf(GovernorStateRequired);
    const pages = (first as GovernorStateRequired).needs.filter((need) => "page" in need);
    // 子预留、按预留与按根的开放用量三页，加这一段用量块
    expect(pages).toHaveLength(4);
    await loadGovernorNeeds(set, (first as GovernorStateRequired).needs, recordingRead().read);
    expect(consumedUsageBlock(set, "root-a", 1, 2)).toEqual([]);
    expect(() => requireGovernorRecordNeeds(set, [{ body: { t: "settle", reservationId: "root-a" } }, { body: { t: "release", reservationId: "root-a" } }]))
      .not.toThrow();
  });

  it("水位为 0 时不报用量块页（用量终证不读它）", () => {
    const set = withRoot("root-a", "digest-a");
    let first: unknown;
    try { requireGovernorSettlementNeeds(set, "root-a", -255, 0); } catch (error) { first = error; }
    expect((first as GovernorStateRequired).needs.filter((need) => "page" in need)).toHaveLength(3);
  });
});
