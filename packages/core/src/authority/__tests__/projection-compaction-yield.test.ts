import { expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { AuthorityCacheIntegrity, FileDurableProjectionIndex } from "../index.js";
import { runWithMaintenanceUrgency } from "../../resources/index.js";

/**
 * 基础段覆盖多个区间、四个增量段的更新分散在这些区间里：后台落盘带出的段整理要合并多个区间。
 * yieldRequested 为真时，每一步只合并一个区间就发布已完成部分，下一步之前照常经步间闸门；结果与不让步时相同。
 */
async function compactAcrossRanges(yieldRequested?: () => boolean) {
  const root = await createTempDir("projection-compaction-yield");
  let lsn = 0;
  const checkpoint = () => ({ source: { logId: "compaction-yield", lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as const } });
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "compaction-yield", reducerVersion: 1,
    authenticated: true, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 43)), allowSegmentReclamation: false });
  const key = (n: number) => `k-${n.toString().padStart(4, "0")}`;
  const write = async (keys: readonly number[], value: (n: number) => number) => {
    lsn++;
    index.publish(await index.prepare(keys.map((n) => ({ kind: "put" as const, key: key(n), value: value(n) }))), checkpoint());
  };
  try {
    await index.initialize(checkpoint());
    await write(Array.from({ length: 2048 }, (_, n) => n), (n) => n);
    await index.flush({ compact: true });
    for (let delta = 0; delta < 4; delta++) {
      await write(Array.from({ length: 16 }, (_, i) => i * 128 + delta), (n) => 10_000 + n);
      await index.flush({ compact: false });
    }
    await write([2047], () => 99_999);
    let steps = 0;
    await runWithMaintenanceUrgency(() => "background", new AbortController().signal,
      () => index.flush({ compact: true, betweenSteps: async () => { steps++; }, ...(yieldRequested ? { yieldRequested } : {}) }));
    return { steps, compactionPending: index.hasPendingCompaction(),
      values: await index.getMany([key(0), key(1), key(129), key(1027), key(1920), key(2047)]) };
  } finally { await index.stopStorageMaintenance(); }
}

it("前台有活动时段整理每步只合并一个区间、发布后让路，结果与不让步时相同", async () => {
  const yielding = await compactAcrossRanges(() => true);
  const plain = await compactAcrossRanges();
  expect(yielding.compactionPending).toBe(false);
  expect(plain.compactionPending).toBe(false);
  expect(yielding.values).toEqual(plain.values);
  expect(yielding.values).toEqual([10_000, 10_001, 10_129, 11_027, 11_920, 99_999]);
  expect(yielding.steps).toBeGreaterThan(plain.steps);
}, 120_000);
