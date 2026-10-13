import { expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { acquireFileLock } from "../../persistence/file-lock.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
import * as verified from "../verified-wal-view.js";

const published = vi.hoisted(() => ({ locks: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      if (String(args[1]).endsWith(".commit-log.lock")) published.locks += 1;
    },
  };
});

async function fixture(lockSessionLingerMs?: number) {
  const root = await createTempDir("commit-log-lock-session");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const create = (linger = lockSessionLingerMs) => {
    // 显式保留期的用例同时放宽持有上限，断言不受机器负载下单次操作时长影响。
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts,
      linger === undefined ? {} : { lockSessionLingerMs: linger, ...(linger > 0 ? { lockSessionMaxHoldMs: 60_000 } : {}) });
    onTestFinished(() => log.stopStorageMaintenance());
    return log;
  };
  return { log: create(), create };
}

const lockPath = (log: FileAuthorityCommitLog) => path.join(log.rootDir, ".commit-log.lock");
const busy = async (log: FileAuthorityCommitLog) => {
  try { await (await acquireFileLock(lockPath(log), { staleMs: 30_000, waitMs: 0 }))(); return false; }
  catch (error) { if (error instanceof Error && /busy/.test(error.message)) return true; throw error; }
};

it("keeps one writer lock across consecutive operations and still verifies bytes on every operation", async () => {
  const { log, create } = await fixture(5_000);
  await log.append([{ stream: "control", body: { value: 1 } }]);
  // 由同进程实例收回初始化期间的会话，从一把新锁开始计数。
  await create(0).readSnapshot();
  published.locks = 0;
  await log.append([{ stream: "control", body: { value: 2 } }]);
  expect((await log.readSnapshot()).commits).toHaveLength(2);
  expect((await log.readStream<{ value: number }>("control")).map(record => record.body.value)).toEqual([1, 2]);
  await log.checkpoint();
  await log.readSnapshot();
  // 逐次取锁会发布 5 次；同一会话内只取一次。
  expect(published.locks).toBe(1);
  expect(await busy(log)).toBe(true);

  // 同一会话内：元数据不变而字节被非协作写者改动，下一次操作仍要发现。
  const version = await verified.readWalVersion(log.logPath);
  const unchanged = vi.spyOn(verified, "readWalVersion").mockResolvedValue(version);
  try {
    const bytes = await readFile(log.logPath);
    bytes[bytes.lastIndexOf(Buffer.from('"value":2'))! + 8] ^= 1;
    await writeFile(log.logPath, bytes);
    await expect(log.readSnapshot()).rejects.toThrow();
  } finally { unchanged.mockRestore(); }
  // 失败的操作立即放锁，不在保留期内继续独占。
  expect(await busy(log)).toBe(false);
}, 30_000);

it("releases an idle session promptly for writers in other processes", async () => {
  const { log } = await fixture();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const started = performance.now();
  const release = await acquireFileLock(lockPath(log), { staleMs: 30_000, waitMs: 2_000 });
  await release();
  expect(performance.now() - started).toBeLessThan(1_000);
  await log.append([{ stream: "control", body: { value: 2 } }]);
  expect((await log.readSnapshot()).commits).toHaveLength(2);
}, 30_000);

it("lets another instance in the same process take over an idle session without waiting for it", async () => {
  const { log, create } = await fixture(5_000);
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const peer = create(0);
  const started = performance.now();
  await peer.append([{ stream: "control", body: { value: 2 } }]);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(await busy(log)).toBe(false);
  expect((await log.readStream<{ value: number }>("control")).map(record => record.body.value)).toEqual([1, 2]);
}, 30_000);

it("keeps releasing after every operation when no session linger is configured", async () => {
  const { log } = await fixture(0);
  await log.append([{ stream: "control", body: { value: 1 } }]);
  expect(await busy(log)).toBe(false);
  published.locks = 0;
  await log.readSnapshot();
  await log.readSnapshot();
  expect(published.locks).toBe(2);
}, 30_000);
