/**
 * 调控缺键一次报全：同步判断推演一批调控记录前，静态可得的缺键在一次 GovernorStateRequired 里报全，
 * 装入一次后不再缺；同一次缺键的装入只执行一次（日志后台发起与协调者等待共享同一次）。
 */
import { describe, expect, it } from "vitest";
import type { DurableProjectionReadContext } from "../durable-projection-index.js";
import { GovernorStateRequired, GovernorWorkingSet, loadGovernorNeeds, requireGovernorRecordNeeds } from "../resource-governor-index.js";

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
  });
});
