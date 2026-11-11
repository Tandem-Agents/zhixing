import { expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { AuthorityCacheIntegrity, FileDurableProjectionIndex } from "../index.js";
import { runWithMaintenanceUrgency } from "../../resources/index.js";

/**
 * 空闲轮转的一步：每次 maintenanceStep 至多做一个原子维护步（挂起的段整理优先，其后落盘），照原路径发布进度；
 * 中途停下、由新实例按已发布清单续做，结果与一次做完整次 flush 相同。
 */
const key = (n: number) => `k-${n.toString().padStart(4, "0")}`;
const SAMPLE = [0, 1, 129, 1027, 1920, 2047].map(key);

/** 基础段覆盖多个区间、四个增量段分散在这些区间里，挂着跨多个区间的段整理；最后一次写入（lsn 6）留在覆盖层未落盘。 */
async function fixture() {
  const root = await createTempDir("projection-maintenance-step");
  const checkpoint = (lsn: number) => ({ source: { logId: "maintenance-step", lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as const } });
  const open = () => new FileDurableProjectionIndex({ rootDir: root, projectionId: "maintenance-step", reducerVersion: 1,
    authenticated: true, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 43)), allowSegmentReclamation: false });
  const writeAt = async (target: FileDurableProjectionIndex, lsn: number, keys: readonly number[], value: (n: number) => number) => {
    target.publish(await target.prepare(keys.map((n) => ({ kind: "put" as const, key: key(n), value: value(n) }))), checkpoint(lsn));
  };
  /** 源日志尾部的最后一次写入：重开的实例在已发布位置之后照样回放它 */
  const tail = (target: FileDurableProjectionIndex) => writeAt(target, 6, [2047], () => 99_999);
  const index = open();
  await index.initialize(checkpoint(0));
  await writeAt(index, 1, Array.from({ length: 2048 }, (_, n) => n), (n) => n);
  await index.flush({ compact: true });
  for (let delta = 0; delta < 4; delta++) {
    await writeAt(index, 2 + delta, Array.from({ length: 16 }, (_, i) => i * 128 + delta), (n) => 10_000 + n);
    await index.flush({ compact: false });
  }
  await tail(index);
  return { index, open, checkpoint, tail };
}

const background = <T>(work: () => Promise<T>) => runWithMaintenanceUrgency(() => "background", new AbortController().signal, work);
// 前台一直“有活动”：段整理每步只合并一个区间
const step = (index: FileDurableProjectionIndex, allowFlush: boolean, gate: () => Promise<void> = async () => undefined) =>
  background(() => index.maintenanceStep({ allowFlush, betweenSteps: gate, yieldRequested: () => true }));

it("每次只做一个原子段整理步；中途停下由新实例按已发布清单续做，结果与整次 flush 相同", async () => {
  const plain = await fixture();
  let plainValues: unknown[];
  try {
    expect(plain.index.hasPendingCompaction()).toBe(true);
    await background(() => plain.index.flush({ compact: true, singleFlush: true }));
    expect(plain.index.hasPendingCompaction()).toBe(false);
    plainValues = await plain.index.getMany(SAMPLE);
  } finally { await plain.index.stopStorageMaintenance(); }

  const stepped = await fixture();
  let current = stepped.index, gates = 0, steps = 0;
  const gate = async () => { gates++; };
  try {
    for (let n = 0; n < 2; n++) {
      const before = gates;
      expect(await step(current, false, gate)).toBe("compaction");
      // 一步至多经过一次步间闸门，做完仍挂着段整理：进度已随这一步发布
      expect(gates - before).toBeLessThanOrEqual(1);
      expect(current.hasPendingCompaction()).toBe(true);
      steps++;
    }
    await current.stopStorageMaintenance();
    current = stepped.open();
    await current.initialize(stepped.checkpoint(5));
    await stepped.tail(current);
    expect(current.hasPendingCompaction()).toBe(true);
    for (let guard = 0; guard < 64; guard++) {
      const kind = await step(current, false, gate);
      if (kind === undefined) break;
      expect(kind).toBe("compaction");
      steps++;
    }
    expect(current.hasPendingCompaction()).toBe(false);
    expect(await step(current, true, gate)).toBe("flush");
    expect(steps).toBeGreaterThan(2);
    expect(await current.getMany(SAMPLE)).toEqual(plainValues);
    expect(plainValues).toEqual([10_000, 10_001, 10_129, 11_027, 11_920, 99_999]);
  } finally { await current.stopStorageMaintenance(); }
}, 120_000);

it("挂着段整理时一步只做段整理，不顺带落盘；本轮不允许落盘时未落盘的行留在覆盖层，允许时一步落盘", async () => {
  const { index } = await fixture();
  try {
    expect(index.hasPendingCompaction()).toBe(true);
    expect(index.hasUnflushedRows()).toBe(true);
    expect(await step(index, true)).toBe("compaction");
    expect(index.hasUnflushedRows()).toBe(true);
    for (let guard = 0; guard < 64 && index.hasPendingCompaction(); guard++) expect(await step(index, false)).toBe("compaction");
    expect(index.hasPendingCompaction()).toBe(false);
    expect(await step(index, false)).toBeUndefined();
    expect(index.hasUnflushedRows()).toBe(true);
    expect(await step(index, true)).toBe("flush");
    expect(index.hasUnflushedRows()).toBe(false);
    expect(await index.getMany(SAMPLE)).toEqual([10_000, 10_001, 10_129, 11_027, 11_920, 99_999]);
  } finally { await index.stopStorageMaintenance(); }
}, 120_000);
