import { expect, it, onTestFinished } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing-ai/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import type { LogDraft, LogRecordPort } from "../../logging/contracts.js";

it("认证日志按条数读尾部时只读所需的帧，不为其后的帧读满整个读窗口", async () => {
  const root = await createTempDir("commit-log-tail-window");
  const entries: LogDraft[] = [];
  const records: LogRecordPort = { record: (value) => { entries.push(typeof value === "function" ? value() : value); } };
  // 关掉已验证视图：视图命中时不读盘，测不到物理读取
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
    startupProofs: true,
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 29)),
    verifiedViewLimits: { bytes: 0, frames: 0 },
    records,
  });
  onTestFinished(() => log.stopStorageMaintenance());
  const filler = "x".repeat(30 * 1024);
  for (let index = 0; index < 20; index += 1) {
    await log.append([{ stream: "control", body: { index, filler } }]);
  }
  const origin = await log.originCheckpoint();
  // 与真实宿主同一把尺子：日志自己的工作汇总里 readTail 的读字节
  const tailReadBytes = () => entries
    .filter((entry) => entry.event === "work" && entry.data?.operation === "readTail")
    .reduce((total, entry) => total + Number(entry.data!.readBytes), 0);

  const before = tailReadBytes();
  const first = await log.readTail(origin, 1);
  await log.stopStorageMaintenance();
  const bytes = tailReadBytes() - before;
  expect(first.commits).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  expect(bytes).toBeGreaterThan(0);
  // 一个提交约 30 KB；读满窗口时会读入全部 20 个（约 600 KB）
  expect(bytes).toBeLessThan(64 * 1024);
}, 60_000);

it("逐条续读尾部与一次读多条得到同样的提交、续读检查点与结束状态", async () => {
  const root = await createTempDir("commit-log-tail-steps");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
    startupProofs: true,
    integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 31)),
    verifiedViewLimits: { bytes: 0, frames: 0 },
  });
  onTestFinished(() => log.stopStorageMaintenance());
  for (let index = 0; index < 12; index += 1) {
    await log.append([{ stream: "control", body: { index } }]);
  }
  const origin = await log.originCheckpoint();
  const stepped: number[] = [];
  let cursor = origin;
  for (;;) {
    const page = await log.readTail(cursor, 1);
    stepped.push(...page.commits.map((commit) => commit.lsn));
    cursor = page.checkpoint;
    if (!page.hasMore) break;
  }
  const whole = await log.readTail(origin, 256);
  expect(stepped).toEqual(whole.commits.map((commit) => commit.lsn));
  expect(cursor).toEqual(whole.checkpoint);
  expect(whole.hasMore).toBe(false);
  // 恰好读到末尾的一页视为读完
  const last = await log.readTail(whole.checkpoints[whole.checkpoints.length - 2]!, 1);
  expect(last.commits.map((commit) => commit.lsn)).toEqual([12]);
  expect(last.hasMore).toBe(false);
}, 60_000);
