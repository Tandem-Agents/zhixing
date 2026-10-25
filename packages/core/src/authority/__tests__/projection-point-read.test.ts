/**
 * 段条目的点查与扫描读量：二分定位与按键取值只读探测到的条目本身（收尾时探测常落在相邻序号上，
 * 那不是顺序访问），区间扫描的顺序读取才成批预读。
 */
import path from "node:path";
import { captureFileIo, createTempDir } from "@zhixing/test-utils";
import { expect, it } from "vitest";
import { FileDurableProjectionIndex, type DurableLogCheckpoint } from "../index.js";

const checkpoint = (lsn: number): DurableLogCheckpoint => ({
  logId: "point-read", lsn, frameEndOffset: 64 + lsn, prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}`,
});
const key = (n: number) => `row:${String(n).padStart(4, "0")}`;
const ROWS = 400;
const VALUE = "v".repeat(2_000);

it("reads only probed entries for point lookups and batches sequential scan reads", async () => {
  const root = await createTempDir("projection-point-read");
  const options = { rootDir: path.join(root, "index"), projectionId: "point-read", reducerVersion: 1 };
  const writer = new FileDurableProjectionIndex(options);
  await writer.initialize({ source: checkpoint(0) });
  writer.publish(await writer.prepare(Array.from({ length: ROWS }, (_, n) => ({ kind: "put" as const, key: key(n), value: VALUE }))), { source: checkpoint(1) });
  await writer.flush();
  await writer.stopStorageMaintenance();

  const io = await captureFileIo(root, relative => relative.endsWith(".data") ? "data" : "other");
  const cold = new FileDurableProjectionIndex({ ...options, readOnly: true });
  try {
    await cold.initialize({ source: checkpoint(0) });
    // 一次点查至多探测 log2(400)+1 个条目，每条约 2KB；成批预读一次就是 64KB
    const entryBytes = VALUE.length + 64;
    let largest = 0;
    for (let n = 0; n < ROWS; n += 7) {
      io.reset();
      expect(await cold.get(key(n))).toBe(VALUE);
      largest = Math.max(largest, io.snapshot().byCategory.data?.readBytes ?? 0);
    }
    expect(largest).toBeLessThanOrEqual(10 * entryBytes);
    io.reset();
    expect(await cold.getMany([key(3), key(150), key(151), key(398)])).toEqual([VALUE, VALUE, VALUE, VALUE]);
    expect(io.snapshot().byCategory.data?.readBytes ?? 0).toBeLessThanOrEqual(4 * 10 * entryBytes);

    // 扫描 64 条：逐条读取是 128 次（头与载荷），成批预读远少于此
    io.reset();
    const page = await cold.scan({ gte: key(100), lt: key(164) }, 64);
    expect(page.entries.map(entry => entry.key)).toEqual(Array.from({ length: 64 }, (_, n) => key(100 + n)));
    expect(io.snapshot().byCategory.data?.reads ?? 0).toBeLessThan(40);
  } finally { await cold.stopStorageMaintenance(); }
}, 60_000);
