/**
 * 段文件身份核对按源操作只做一次：同一操作内反复点查只在首次复用缓存前核对每个段；换一个操作必重核；
 * 非协作写者在两次操作之间替换段文件，下一次操作即发现并拒绝沿用缓存。
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDurableProjectionIndex } from "../index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const checkpoint = (lsn: number) => ({ logId: "segment-operation", lsn, frameEndOffset: 64 + lsn, prefixDigest: `sha256:${String(lsn).padStart(64, "0")}` });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "segment-operation-"));
  roots.push(root);
  const opens: string[] = [];
  let operation: object | undefined;
  const index = new FileDurableProjectionIndex({ rootDir: root, projectionId: "segment-operation", reducerVersion: 1,
    runReadStep: async (step, run) => { opens.push(step); return run(); }, sourceOperation: () => operation });
  await index.initialize({ source: checkpoint(0) });
  // 两个增量段都覆盖键 c（a..z 与 b..y），c 本身不在任何段里：每次点查都要穿过两个段
  for (const [lsn, keys] of [[1, ["a", "z"]], [2, ["b", "y"]]] as const) {
    index.publish(await index.prepare(keys.map((key) => ({ kind: "put" as const, key, value: key }))), { source: checkpoint(lsn) });
    await index.flush();
  }
  const segmentOpens = () => opens.filter((step) => step === "segment-open").length;
  return { root, index, segmentOpens, enter: () => { operation = {}; }, leave: () => { operation = undefined; } };
}

describe("段身份核对按源操作只做一次", () => {
  it("同一操作内反复点查，每个段只在首次复用缓存前核对一次；换操作必重核", async () => {
    const { index, segmentOpens, enter, leave } = await fixture();
    enter();
    await index.get("c");
    const afterFirst = segmentOpens();
    await index.get("c");
    expect(segmentOpens() - afterFirst).toBe(2);
    await index.get("c"); await index.get("c");
    expect(segmentOpens() - afterFirst).toBe(2);
    leave();
    enter();
    const before = segmentOpens();
    await index.get("c");
    expect(segmentOpens() - before).toBe(2);
    leave();
  });

  it("不在源操作内的读取照旧每个读取器各自核对", async () => {
    const { index, segmentOpens } = await fixture();
    await index.get("c");
    const before = segmentOpens();
    await index.get("c"); await index.get("c");
    expect(segmentOpens() - before).toBe(4);
  });

  it("两次操作之间段文件被非协作写者替换，下一次操作发现并不沿用旧缓存", async () => {
    const { root, index, enter, leave } = await fixture();
    enter();
    await index.get("c"); await index.get("c");
    expect(await index.get("a")).toBe("a");
    leave();
    const data = (await readdir(root)).filter((name) => name.startsWith("segment-") && name.endsWith(".data"));
    for (const name of data) await writeFile(path.join(root, name), Buffer.alloc(4096, 7));
    enter();
    await expect(index.get("a")).rejects.toThrow();
    leave();
  });
});
