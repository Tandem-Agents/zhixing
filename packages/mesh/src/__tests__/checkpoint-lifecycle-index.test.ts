import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { captureFileIo, createTempDir } from "@zhixing/test-utils";
import type { CheckpointStreamRecord, RecoveryCheckpointGeneration } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import { FileAuthorityCommitLog } from "../../../core/src/authority/commit-log.js";
import { FileArtifactStore } from "../../../core/src/authority/artifact-store.js";
import { AuthorityCacheIntegrity } from "../../../core/src/authority/startup-proofs.js";
import { FRAME_INDEX_ROW_BYTES, FRAME_INDEX_ROWS_PER_PAGE } from "../../../core/src/authority/frame-index.js";
import { readCheckpointLifecycle, registerCheckpointLifecycleIndex } from "../checkpoint-service.js";

const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { await Promise.all(logs.splice(0).map((log) => log.stopStorageMaintenance())); });
const at = "2026-10-27T00:00:00.000Z";
const recipient = "recipient-key";
const target = "backup-device:target";
const generation: RecoveryCheckpointGeneration = { rootKeyId: "root-key", recipientKeyId: recipient, trustChainHead: { seq: 7, eventDigest: "a".repeat(64) }, targetId: target };
const id = (n: number) => `01JCHECKPOINT${n.toString().padStart(13, "0")}`;

/** N 次备份：每次 created、replicated、verified，新的一次取代上一次，旧的都已完成目标退役。 */
async function history(backups: number) {
  const root = await createTempDir(`checkpoint-lifecycle-${backups}`);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 41)) });
  logs.push(log);
  registerCheckpointLifecycleIndex(log);
  const purpose = { kind: "periodic" as const };
  // 制品保留按 created 引用的信封认领：每次备份放一份最小的合法信封
  const created = async (n: number): Promise<CheckpointStreamRecord> => ({ t: "checkpoint-created", checkpointId: id(n), recipientKeyId: recipient, purpose,
    envelopeRef: await artifacts.put(Buffer.from(canonicalize({ v: 1, checkpointId: id(n), chunks: [] }))),
    upToLsn: n, envelopeDigest: `d${n}`, targetId: target, generation, request: { kind: "forced", requestId: `request-${n}` } } as CheckpointStreamRecord);
  for (let n = 1; n <= backups; n++) {
    const entries: CheckpointStreamRecord[] = [
      await created(n),
      { t: "checkpoint-replicated", checkpointId: id(n), recipientKeyId: recipient, purpose, targetId: target, envelopeDigest: `d${n}`, at },
      { t: "checkpoint-verified", checkpointId: id(n), recipientKeyId: recipient, purpose, targetId: target, envelopeDigest: `d${n}`, verification: { n } } as unknown as CheckpointStreamRecord,
    ];
    if (n > 1) {
      entries.push({ t: "checkpoint-superseded", checkpointId: id(n - 1), supersededBy: id(n), at });
      entries.push({ t: "checkpoint-cleanup-progress", checkpointId: id(n - 1), supersededBy: id(n), targetId: target, phase: "target-retired", at } as CheckpointStreamRecord);
    }
    await log.append(entries.map((body) => ({ stream: "checkpoint", body })));
  }
  return { root, log, created };
}
const readAll = (log: FileAuthorityCommitLog) => readCheckpointLifecycle(log, async (view) => ({
  current: (await view.currentVerified(recipient)).map((record) => record.checkpointId),
  latest: (await view.latestCreated(generation))?.checkpointId,
  candidate: await view.latestReplicated(generation),
  due: await view.cleanupDue(Date.parse("2030-01-01T00:00:00.000Z")),
  pending: (await view.pendingReplication()).map((record) => record.checkpointId),
  first: (await view.created(id(1)))?.checkpointId,
}));

it("reads current checkpoint state without replaying the backup history", async () => {
  const measured: { reads: number; readBytes: number; log: number; frameIndex: number; appendLog: number; appendFrameIndex: number }[] = [];
  const details: unknown[] = [];
  for (const backups of [4, 64]) {
    const { root, log, created } = await history(backups);
    // 先追平一次（在线维护后只剩有界尾部），再计一次完整的状态类读取
    expect(await readAll(log)).toEqual({ current: [id(backups)], latest: id(backups), candidate: { checkpointId: id(backups), targetId: target },
      due: [], pending: [], first: id(1) });
    const capture = await captureFileIo(root);
    capture.reset();
    await readAll(log);
    const read = capture.snapshot();
    capture.reset();
    // 追加一次新的 created：投影维护只按键读写
    const next = await created(backups + 1);
    capture.reset();
    await log.append([{ stream: "checkpoint", body: next }]);
    const append = capture.snapshot();
    details.push({ backups, read: read.byCategory, append: append.byCategory });
    measured.push({ reads: read.reads, readBytes: read.readBytes, log: read.byCategory.log?.readBytes ?? 0,
      frameIndex: read.byCategory["frame-index"]?.readBytes ?? 0,
      appendLog: append.byCategory.log?.readBytes ?? 0, appendFrameIndex: append.byCategory["frame-index"]?.readBytes ?? 0 });
  }
  const [small, large] = measured as [typeof measured[0], typeof measured[0]];
  // 16 倍备份历史：读取不重放日志与帧索引，读量不按历史比例增长
  expect(large.log).toBeLessThanOrEqual(small.log);
  // 状态读取本身不读帧索引；计量是进程级的，窗口若恰好跨过写入后约 1 秒的后台帧索引刷写（单发定时器），
  // 刷写写新封条前会整读一次磁盘封条（3 路并发时见过 4192B = 112 + 46×88 + 32）。封条最多 255 行未成页，
  // 上界即 frame-index.ts 的 MAX_SEAL_BYTES，不随备份历史增长
  const maxSealBytes = 112 + (FRAME_INDEX_ROWS_PER_PAGE - 1) * FRAME_INDEX_ROW_BYTES + 32 + 32;
  expect(large.frameIndex, JSON.stringify(measured)).toBeLessThanOrEqual(maxSealBytes);
  expect(small.frameIndex, JSON.stringify(measured)).toBeLessThanOrEqual(maxSealBytes);
  expect(large.readBytes).toBeLessThanOrEqual(small.readBytes * 3);
  expect(large.reads).toBeLessThanOrEqual(small.reads * 3);
  // 追加不重放 checkpoint 流：日志只读写本次提交，帧索引不扫；投影目录的写入是耐久投影按覆盖层预算摊销的发布
  // （64 次那一轮恰好触发，约 96KB；4 次那一轮未触发），是按键投影的共同机制，不随单次追加的历史增长
  expect(large.appendLog, JSON.stringify(details)).toBeLessThanOrEqual(small.appendLog);
  expect(large.appendFrameIndex, JSON.stringify(details)).toBe(0);
}, 120_000);

it("keeps only open work in the small indexes and dedupes or rejects appended facts by key", async () => {
  const { log } = await history(3);
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  // 只取代、尚未退役的一项进入待清理；退役后移出
  await log.append([{ stream: "checkpoint", body: { t: "checkpoint-superseded", checkpointId: id(3), supersededBy: id(4), at } }]);
  expect((await readCheckpointLifecycle(log, (view) => view.cleanupDue(now))).map((item) => item.checkpointId)).toEqual([id(3)]);
  expect(await readCheckpointLifecycle(log, (view) => view.currentVerified(recipient))).toEqual([]);
  await log.append([{ stream: "checkpoint", body: { t: "checkpoint-cleanup-progress", checkpointId: id(3), supersededBy: id(4), targetId: target, phase: "target-retired", at } }]);
  expect(await readCheckpointLifecycle(log, (view) => view.cleanupDue(now))).toEqual([]);
  // 同键不同内容是冲突事实：投影拒绝，日志不追加
  await expect(log.append([{ stream: "checkpoint", body: { t: "checkpoint-superseded", checkpointId: id(3), supersededBy: id(9), at } }])).rejects.toThrow();
  // 非生命周期记录不进投影
  await log.append([{ stream: "checkpoint", body: { t: "recovery-activation-committed", commit: { plan: { kind: "establish" } } } }]);
  expect((await readCheckpointLifecycle(log, (view) => view.created(id(1))))?.checkpointId).toBe(id(1));
}, 60_000);

it("orders facts by (LSN, entry) even when an envelope holds more than a thousand entries", async () => {
  const root = await createTempDir("checkpoint-lifecycle-order");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 43)) });
  logs.push(log);
  registerCheckpointLifecycleIndex(log);
  const purpose = { kind: "root-activation" as const, activationDigest: "e".repeat(64) };
  const facts = async (n: number): Promise<CheckpointStreamRecord[]> => [
    { t: "checkpoint-created", checkpointId: id(n), recipientKeyId: recipient, purpose,
      envelopeRef: await artifacts.put(Buffer.from(canonicalize({ v: 1, checkpointId: id(n), chunks: [] }))),
      upToLsn: n, envelopeDigest: `d${n}`, targetId: target, generation } as CheckpointStreamRecord,
    { t: "checkpoint-replicated", checkpointId: id(n), recipientKeyId: recipient, purpose, targetId: target, envelopeDigest: `d${n}`, at },
    { t: "checkpoint-verified", checkpointId: id(n), recipientKeyId: recipient, purpose, targetId: target, envelopeDigest: `d${n}`, verification: { n } } as unknown as CheckpointStreamRecord,
  ];
  // 前一个信封条目很多，checkpoint 1 落在高序号上；下一个信封里 checkpoint 2 落在低序号上，但它更晚
  await log.append([
    ...Array.from({ length: 1100 }, (_, n) => ({ stream: "run:filler", body: { n } })),
    ...(await facts(1)).map((body) => ({ stream: "checkpoint", body })),
  ]);
  await log.append((await facts(2)).map((body) => ({ stream: "checkpoint", body })));
  expect(await readCheckpointLifecycle(log, async (view) => ({
    replicated: (await view.latestReplicated(generation))?.checkpointId,
    current: (await view.currentVerified(recipient)).map((record) => record.checkpointId),
    latest: (await view.latestCreated(generation))?.checkpointId,
    rootActivation: (await view.latestRootActivation(target))?.checkpointId,
  }))).toEqual({ replicated: id(2), current: [id(2), id(1)], latest: id(2), rootActivation: id(2) });
}, 60_000);
