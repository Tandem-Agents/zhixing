import { expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity, FileDurableProjectionIndex } from "../index.js";
import { runWithMaintenanceUrgency } from "../../resources/index.js";

/**
 * 已有四个增量段、覆盖层里还有一行：后台落盘先写出第五段，随之挂上段整理；在段整理的步间闸门里前台
 * 写入一行（两步之间到达，与日志里新行只能在两次持锁之间到达相同）。
 */
async function flushWithArrival(singleFlush: boolean) {
  const root = await createTempDir("projection-single-flush");
  let lsn = 0;
  const checkpoint = () => ({ source: { logId: "single-flush", lsn, frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` as const } });
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "single-flush", reducerVersion: 1,
    authenticated: true, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 41)), allowSegmentReclamation: false });
  const write = async (key: string) => {
    lsn++;
    index.publish(await index.prepare([{ kind: "put" as const, key, value: lsn }]), checkpoint());
  };
  try {
    await index.initialize(checkpoint());
    for (let n = 0; n < 4; n++) {
      await write(`seed-${n}`);
      await index.flush({ compact: false });
    }
    expect(index.hasPendingCompaction()).toBe(false);
    await write("pending");
    let gates = 0;
    const gate = async () => { if (gates++ === 0) await write("arrived"); };
    await runWithMaintenanceUrgency(() => "background", new AbortController().signal,
      () => index.flush({ compact: true, betweenSteps: gate, singleFlush }));
    return { gates, compactionPending: index.hasPendingCompaction(), unflushed: index.hasUnflushedRows(),
      values: await index.getMany(["pending", "arrived"]) };
  } finally { await index.stopStorageMaintenance(); }
}

it("至多落盘一次：两步之间到达的行留在覆盖层给之后的落盘，段整理照常完成", async () => {
  const result = await flushWithArrival(true);
  expect(result.gates).toBeGreaterThan(0);
  expect(result.compactionPending).toBe(false);
  expect(result.unflushed).toBe(true);
  expect(result.values).toEqual([5, 6]);
});

it("默认落盘会接着把两步之间到达的行也落下", async () => {
  const result = await flushWithArrival(false);
  expect(result.gates).toBeGreaterThan(0);
  expect(result.unflushed).toBe(false);
  expect(result.values).toEqual([5, 6]);
});
