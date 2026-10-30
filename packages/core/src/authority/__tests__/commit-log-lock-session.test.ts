import { expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { spawn } from "node:child_process";
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

async function fixture(lockSessionLingerMs?: number, lockSessionMaxHoldMs?: number) {
  const root = await createTempDir("commit-log-lock-session");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const create = (linger = lockSessionLingerMs) => {
    // 显式保留期的用例默认同时放宽持有上限，断言不受机器负载下单次操作时长影响；检验持有上限的用例显式给出上限。
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts,
      linger === undefined ? {} : { lockSessionLingerMs: linger, ...(linger > 0 ? { lockSessionMaxHoldMs: lockSessionMaxHoldMs ?? 60_000 } : {}) });
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

// 以下用例检验持有上限与保留期的边界逻辑，与默认参数无关：显式配置较长保留期（250 ms）与 500 ms 持有上限。
const LINGER = 250, HOLD = 500;

it("still releases at an operation boundary once the hold limit is reached under a long linger", async () => {
  const { log, create } = await fixture(LINGER, HOLD);
  await log.append([{ stream: "control", body: { value: 0 } }]);
  await create(0).readSnapshot();
  published.locks = 0;
  // 每 120 ms 一次连续操作（间隔小于保留期）、合计超过持有上限：会话按上限在操作边界换新，不会一直独占
  for (let value = 1; value <= 6; value++) {
    await log.append([{ stream: "control", body: { value } }]);
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  expect(published.locks).toBeGreaterThanOrEqual(2);
}, 30_000);

/** 带换锁观测的日志：场景跑完后调用 totals() 刷出工作汇总并累加各类换锁计数（之后不再使用该日志）。 */
async function observedFixture() {
  const root = await createTempDir("commit-log-lock-session");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const records: { event?: string; data?: Record<string, unknown> }[] = [];
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    lockSessionLingerMs: LINGER, lockSessionMaxHoldMs: HOLD,
    records: { record: draft => { records.push(typeof draft === "function" ? draft() : draft); } },
  });
  onTestFinished(() => log.stopStorageMaintenance());
  const totals = async () => {
    await log.stopStorageMaintenance();
    const sum = { lockAcquisitions: 0, lockAfterIdle: 0, lockAfterHoldLimit: 0, lockAfterBoundary: 0, lockAfterHandoff: 0 };
    for (const record of records) if (record.event === "work")
      for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += Number(record.data?.[key] ?? 0);
    return sum;
  };
  return { log, totals };
}

it("does not let a session past its hold limit take a new operation before its idle timer fires", async () => {
  const { log, totals } = await observedFixture();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const original = performance.now.bind(performance);
  let shift = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => original() + shift);
  try {
    published.locks = 0;
    // 会话年龄越过持有上限，而 250 ms 的空闲计时尚未触发：下一次操作必须先放锁再重新取得
    shift = 600;
    await log.append([{ stream: "control", body: { value: 2 } }]);
    expect(published.locks).toBe(1);
  } finally { clock.mockRestore(); }
  expect((await totals()).lockAfterHoldLimit).toBeGreaterThanOrEqual(1);
}, 30_000);

it("caps the idle linger by the remaining hold budget", async () => {
  const { log, create } = await fixture(LINGER, HOLD);
  await log.append([{ stream: "control", body: { value: 1 } }]);
  await create(0).readSnapshot();
  await log.append([{ stream: "control", body: { value: 2 } }]);
  const original = performance.now.bind(performance);
  let shift = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => original() + shift);
  try {
    // 操作开始时会话已持有约 400 ms：结束后只能再保留剩余的持有预算（约百毫秒以内），不能再排满 250 ms
    shift = 400;
    await log.append([{ stream: "control", body: { value: 3 } }]);
  } finally { clock.mockRestore(); }
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(await busy(log)).toBe(false);
}, 30_000);

it("releases at the boundary of a failed operation and counts it as a forced boundary", async () => {
  const { log, totals } = await observedFixture();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const bytes = await readFile(log.logPath);
  bytes[bytes.lastIndexOf(Buffer.from('"value":1'))! + 8] ^= 1;
  await writeFile(log.logPath, bytes);
  await expect(log.readSnapshot()).rejects.toThrow();
  bytes[bytes.lastIndexOf(Buffer.from('"value":0'))! + 8] ^= 1;
  await writeFile(log.logPath, bytes);
  await log.readSnapshot();
  expect((await totals()).lockAfterBoundary).toBeGreaterThanOrEqual(1);
}, 30_000);

it("lets a real other process take the lock while this process keeps operating", async () => {
  const { log } = await fixture(LINGER, HOLD);
  await log.append([{ stream: "control", body: { value: 0 } }]);
  const directory = await createTempDir("commit-log-lock-contender");
  const script = path.join(directory, "contender.mjs");
  await writeFile(script, `
    import { acquireFileLock } from ${JSON.stringify(new URL("../../persistence/file-lock.ts", import.meta.url).href)};
    const started = performance.now();
    const release = await acquireFileLock(${JSON.stringify(lockPath(log))}, { staleMs: 30_000, waitMs: 5_000 });
    const waited = performance.now() - started;
    await release();
    process.stdout.write(JSON.stringify({ waited }));
  `);
  const child = spawn(process.execPath, ["--import=tsx/esm", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  // 本进程一直连续操作（间隔小于保留期），直到外进程取得锁后退出：外进程只能在持有上限的操作边界进入，
  // 循环因外进程退出而结束（而非到达上限）即证明持续本地操作期间外进程仍能取得锁。上限只为防止测试挂起。
  let value = 1;
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline && child.exitCode === null) {
    await log.append([{ stream: "control", body: { value: value++ } }]);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const acquiredWhileOperating = child.exitCode !== null;
  expect(await exited).toBe(0);
  expect(acquiredWhileOperating).toBe(true);
  expect(JSON.parse(output).waited).toBeGreaterThanOrEqual(0);
  await log.append([{ stream: "control", body: { value } }]);
  expect((await log.readStream<{ value: number }>("control")).at(-1)?.body.value).toBe(value);
}, 60_000);

it("keeps releasing after every operation when no session linger is configured", async () => {
  const { log } = await fixture(0);
  await log.append([{ stream: "control", body: { value: 1 } }]);
  expect(await busy(log)).toBe(false);
  published.locks = 0;
  await log.readSnapshot();
  await log.readSnapshot();
  expect(published.locks).toBe(2);
}, 30_000);
