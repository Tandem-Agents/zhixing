// 过期实例的 reset：另一进程已发布更新代次后，持有旧清单的实例因存储错误重建投影时，不能让清单代次回退，
// 也不能把对方新清单引用的段丢成既不被引用、也不在退役链里的孤儿。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { expect, it, vi } from "vitest";

// 只对清单的只读 open 注入一次 I/O 失败，不改磁盘内容
const fault = vi.hoisted(() => ({ manifestReadFailures: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (fault.manifestReadFailures > 0 && path.basename(String(args[0])) === "manifest.json" && (args[1] === undefined || args[1] === "r")) {
      fault.manifestReadFailures--;
      throw Object.assign(new Error("injected manifest read failure"), { code: "EIO" });
    }
    return actual.open(...args);
  } };
});
import { bindDurableProjectionMutations, FileDurableProjectionIndex, type DurableLogCheckpoint } from "../index.js";

function checkpoint(lsn: number): DurableLogCheckpoint {
  return { logId: "test-log", lsn, frameEndOffset: 64 + lsn, prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}` };
}
const manifest = async (rootDir: string) => JSON.parse(await readFile(path.join(rootDir, "manifest.json"), "utf8")) as
  { generation: number; deltaSegments: { dataFile: string; offsetsFile: string }[]; retirementRoot?: string };
async function publish(index: FileDurableProjectionIndex, lsn: number) {
  index.publish(await index.prepare(bindDurableProjectionMutations([{ kind: "put", key: `k-${lsn}`, value: lsn }])), { authority: checkpoint(lsn) });
  await index.flush();
}

it("keeps the published generation monotonic and retires the newer segments when a stale instance resets", async () => {
  const rootDir = path.join(await createTempDir("projection-reset-generation"), "projection");
  const options = { rootDir, projectionId: "reset-generation", reducerVersion: 1 };
  const stale = new FileDurableProjectionIndex(options);
  await stale.initialize({ authority: checkpoint(0) });
  await publish(stale, 1);
  // 另一进程的实例接着发布了几个代次；stale 仍持有它自己的旧清单
  const current = new FileDurableProjectionIndex(options);
  await current.initialize({ authority: checkpoint(0) });
  for (const lsn of [2, 3, 4]) await publish(current, lsn);
  const before = await manifest(rootDir);
  const newerSegments = before.deltaSegments.flatMap((segment) => [segment.dataFile, segment.offsetsFile]);
  expect(newerSegments.length).toBeGreaterThan(0);

  await stale.reset({ authority: checkpoint(0) }, { authority: checkpoint(4) });
  const after = await manifest(rootDir);
  expect(after.generation).toBeGreaterThan(before.generation);
  // 对方新清单的段进入退役链（之后按既有回收删除），不被丢成孤儿：新清单引用的退役页里能找到它们
  const pages = (await readdir(rootDir)).filter((file) => file.endsWith(".json") && file !== "manifest.json");
  const retirement = (await Promise.all(pages.map((file) => readFile(path.join(rootDir, file), "utf8")))).join("\n");
  expect(after.retirementRoot, JSON.stringify(after)).toBeDefined();
  for (const file of newerSegments) expect(retirement, `${file} in ${pages.join(",")}`).toContain(file);
  // 持有较新代次的实例随后刷新：接纳更高代次的重建清单，不当成损坏
  await expect(current.refreshPublishedState()).resolves.toBeUndefined();
});

it("refuses to reset from a stale manifest when the published one cannot be read", async () => {
  const rootDir = path.join(await createTempDir("projection-reset-read-failure"), "projection");
  const options = { rootDir, projectionId: "reset-read-failure", reducerVersion: 1 };
  const stale = new FileDurableProjectionIndex(options);
  await stale.initialize({ authority: checkpoint(0) });
  await publish(stale, 1);
  const current = new FileDurableProjectionIndex(options);
  await current.initialize({ authority: checkpoint(0) });
  for (const lsn of [2, 3, 4]) await publish(current, lsn);
  const before = await manifest(rootDir);
  // 读不到当前清单（临时 I/O 失败）不等于清单不存在或已损坏：本次 reset 拒绝，已发布代次不变
  fault.manifestReadFailures = 1;
  await expect(stale.reset({ authority: checkpoint(0) }, { authority: checkpoint(4) })).rejects.toThrow("injected manifest read failure");
  fault.manifestReadFailures = 0;
  expect((await manifest(rootDir)).generation).toBe(before.generation);
  // 读取恢复后重做：按已发布的较新代次推进
  await stale.reset({ authority: checkpoint(0) }, { authority: checkpoint(4) });
  expect((await manifest(rootDir)).generation).toBeGreaterThan(before.generation);
});
