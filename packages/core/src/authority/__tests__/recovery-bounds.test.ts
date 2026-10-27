import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import { AUTHORITY_RECOVERY_BUDGET, AuthorityPreparationRequired, maximumAuthorityRecoveryTailBytes } from "../recovery-work.js";
import { authorityWalMaximumFrameBytes } from "../wal-frame.js";
import { durableProjectionDirectoryName, durableProjectionVersionDirectoryName, FileDurableProjectionIndex } from "../durable-projection-index.js";
import { SerialTaskQueue } from "../../persistence/serial-task-queue.js";
import type { AuthorityTailConsumer, DurableLogCheckpoint } from "../interfaces.js";

const logs: FileAuthorityCommitLog[] = [];
const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 91));
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); vi.restoreAllMocks(); });
function open(root: string) {
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
    { integrity, lockSessionLingerMs: 0 });
  logs.push(log);
  return log;
}
const definition = (projectionId = "bounds-test", reducerVersion = 1) => ({
  projectionId, reducerVersion, authenticated: true, inputs: { streams: ["control"] },
  reduce: vi.fn((envelope: { lsn: number; entries: readonly { stream: string }[] }) =>
    envelope.entries.some(entry => entry.stream === "control") ? [{ kind: "put" as const, key: "last", value: envelope.lsn }] : []),
});
async function publishedLsn(root: string, projectionId: string, version = 1): Promise<number> {
  const manifest = JSON.parse(await readFile(path.join(root, "authority", "projections",
    durableProjectionVersionDirectoryName(projectionId, version), "manifest.json"), "utf8"));
  return manifest.checkpoints.authority.lsn;
}
/** 由多条不超过内联上限的记录组成的一个合法大帧。 */
function largeEnvelope(totalBytes: number) {
  const chunk = "x".repeat(30 * 1024);
  return Array.from({ length: Math.ceil(totalBytes / chunk.length) }, (_, n) => ({ stream: "control", body: { n, chunk } }));
}

it("derives the abnormal-exit tail bound from the legal frame format and admits an oversized frame only with zero prior debt", async () => {
  expect(maximumAuthorityRecoveryTailBytes()).toBe(Math.max(AUTHORITY_RECOVERY_BUDGET.hardBytes, authorityWalMaximumFrameBytes()));
  expect(authorityWalMaximumFrameBytes()).toBe(16 + 16 * 1024 * 1024 + 84);
  expect(authorityWalMaximumFrameBytes("legacy")).toBe(16 + 16 * 1024 * 1024 + 12);
  const root = await createTempDir("b2-oversized");
  const log = open(root), def = definition();
  log.durableProjection(def);
  for (let n = 0; n < 3; n++) await log.append([{ stream: "control", body: { n } }]);
  // 先前三帧尚未发布；超过 Kb 的合法大帧只能在欠账为零后接纳。
  const big = await log.append(largeEnvelope(AUTHORITY_RECOVERY_BUDGET.hardBytes + 64 * 1024));
  expect(await publishedLsn(root, def.projectionId)).toBe(3);
  // 大帧本身已占满硬界：下一次追加之前必须先发布它。
  await log.append([{ stream: "control", body: { after: true } }]);
  expect(await publishedLsn(root, def.projectionId)).toBe(big.lsn);
}, 60_000);

it("keeps published debt within the hard bounds across a crash and publishes idle coverage on a normal stop", async () => {
  const root = await createTempDir("b2-stop-coverage");
  const first = open(root), def = definition();
  first.durableProjection(def);
  await first.append([{ stream: "control", body: { n: 0 } }]);
  await first.stopStorageMaintenance();
  const second = open(root);
  second.durableProjection(definition());
  for (let n = 0; n < 10; n++) await second.append([{ stream: "job:unrelated", body: { n } }]);
  await second.stopStorageMaintenance();
  // 正常停止发布闲置投影越过无关输入的覆盖位置：下一个实例无需再扫这些帧。
  expect(await publishedLsn(root, def.projectionId)).toBe(11);
  const third = open(root), thirdDef = definition();
  expect(await third.durableProjection(thirdDef).get("last")).toBe(1);
  expect(thirdDef.reduce).not.toHaveBeenCalled();
}, 60_000);

it("resets every current version before installing a WAL and changes the identity-cache source even when logId is retained", async () => {
  const source = open(await createTempDir("b2-install-source"));
  await source.append([{ stream: "control", body: { source: true } }]);
  const sourceHead = await source.checkpoint();
  const records = await source.readAll();
  const root = await createTempDir("b2-install-target"), target = open(root);
  const first = target.durableProjection(definition("install-a", 2));
  const second = target.durableProjection(definition("install-b", 7));
  await target.append([{ stream: "control", body: { old: 1 } }]);
  await target.append([{ stream: "control", body: { old: 2 } }]);
  const oldHead = await target.checkpoint(), oldIdentity = target.sourceIdentity();
  const oldWal = await readFile(target.logPath);
  const input = () => ({ source: (async function* () { yield* records; })(), sourceHead,
    installationEntries: [{ stream: "job:installation", body: { installed: true } }], candidateReferences: [] });
  const reset = vi.spyOn(FileDurableProjectionIndex.prototype, "reset");
  reset.mockRejectedValueOnce(new Error("injected prepublication cache failure"));
  await expect(target.installPlannedAnchorPrefix(input())).rejects.toThrow("prepublication cache failure");
  expect(await readFile(target.logPath)).toEqual(oldWal);
  reset.mockRestore();
  const original = FileDurableProjectionIndex.prototype.reset;
  const versions: number[] = [];
  const beforePublication = vi.spyOn(FileDurableProjectionIndex.prototype, "reset").mockImplementation(async function(this: FileDurableProjectionIndex, ...args) {
    if (this.projectionId.startsWith("install-")) {
      expect(await readFile(target.logPath)).toEqual(oldWal);
      versions.push(this.reducerVersion);
    }
    return original.apply(this, args);
  });
  await target.installPlannedAnchorPrefix(input());
  beforePublication.mockRestore();
  expect(versions.sort()).toEqual([2, 7]);
  expect((await target.checkpoint()).logId).toBe(oldHead.logId);
  expect(target.sourceIdentity()).not.toBe(oldIdentity);
  expect(await first.get("last")).toBe(1);
  expect(await second.get("last")).toBe(1);
  const installed = await target.installPlannedAnchorPrefix(input());
  expect(installed.lsn).toBe(2);
}, 60_000);

it("releases the physical WAL lock between candidate pages even when ordinary operations retain their lock session", async () => {
  const root = await createTempDir("b2-candidate-lock-release");
  const writer = open(root);
  for (let n = 0; n < 130; n++) await writer.append([{ stream: "control", body: { n } }]);
  await writer.stopStorageMaintenance();
  const recovering = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
    { integrity, lockSessionLingerMs: 60_000, lockSessionMaxHoldMs: 60_000 });
  logs.push(recovering);
  const def = definition("page-lock-release");
  recovering.durableProjection(def);
  const tokens: string[] = [];
  // 每页结束时观察锁令牌：重建进度可能只留在内存，页尾不一定落盘，但页与页之间必须换锁。
  const original = FileDurableProjectionIndex.prototype.checkpointRecovery;
  const flush = vi.spyOn(FileDurableProjectionIndex.prototype, "checkpointRecovery").mockImplementation(async function(this: FileDurableProjectionIndex) {
    if (this.projectionId === def.projectionId && this.checkpoints().authority!.lsn > 0) {
      tokens.push(JSON.parse(await readFile(path.join(root, "authority", ".commit-log.lock"), "utf8")).token);
    }
    return original.call(this);
  });
  const finishing = FileDurableProjectionIndex.prototype.finishRebuild;
  const finish = vi.spyOn(FileDurableProjectionIndex.prototype, "finishRebuild").mockImplementation(async function(this: FileDurableProjectionIndex, checkpoints) {
    if (this.projectionId === def.projectionId) tokens.push(JSON.parse(await readFile(path.join(root, "authority", ".commit-log.lock"), "utf8")).token);
    return finishing.call(this, checkpoints);
  });
  try {
    await recovering.prepareProjections([def.projectionId]);
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tokens).size).toBe(tokens.length);
  } finally { flush.mockRestore(); finish.mockRestore(); }
}, 60_000);

it("keeps bounded healthy catch-up in the transaction but waits for new candidates outside domain serial sections", async () => {
  const root = await createTempDir("b2-nested-preparation");
  const writer = open(root);
  for (let n = 0; n < 70; n++) await writer.append([{ stream: "control", body: { n } }]);
  await writer.stopStorageMaintenance();
  const log = open(root), def = definition("nested-new");
  const index = log.durableProjection(def);
  const domain = new SerialTaskQueue();
  // The source starts recovery, but the domain turn does not wait for it.
  await expect(domain.run(() => index.get("last"))).rejects.toBeInstanceOf(AuthorityPreparationRequired);
  await log.prepareProjections([def.projectionId]);
  expect(await domain.run(() => index.get("last"))).toBe(70);
  await domain.run(() => log.append([{ stream: "control", body: { n: 70 } }]));
  expect(await index.get("last")).toBe(71);
  expect(def.reduce).toHaveBeenCalledTimes(71);
}, 60_000);

it("reclaims a retired projection version by pages, refuses directories in use or of another version, and resumes after stop", async () => {
  const root = await createTempDir("b2-retired-version");
  const log = open(root);
  await log.append([{ stream: "control", body: {} }]);
  const legacy = path.join(root, "authority", "projections", durableProjectionDirectoryName("retired-copy"));
  await mkdir(path.join(legacy, "nested"), { recursive: true });
  await writeFile(path.join(legacy, "manifest.json"), JSON.stringify({ projectionId: "retired-copy", reducerVersion: 1 }));
  for (let n = 0; n < 150; n++) await writeFile(path.join(legacy, n % 3 ? `segment-${n}.data` : path.join("nested", `node-${n}`)), "copy");
  // 当前版本正在使用的目录与另一个版本的目录都不能回收。
  log.durableProjection(definition("in-use", 1));
  await expect(log.reclaimRetiredProjectionVersion("in-use", 1)).rejects.toThrow("in use");
  await expect(log.reclaimRetiredProjectionVersion("retired-copy", 2)).rejects.toThrow("retired version");
  expect((await readdir(legacy)).length).toBeGreaterThan(1);

  log.durableProjection(definition("retired-copy", 2));
  const work = vi.spyOn(log, "reclaimRetiredProjectionVersion");
  await expect(log.reclaimRetiredProjectionVersion("retired-copy", 1)).resolves.toBe("removed");
  await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(log.reclaimRetiredProjectionVersion("retired-copy", 1)).resolves.toBe("absent");
  expect(work).toHaveBeenCalledTimes(2);

  // 停止维护后在页边界停下，下一实例接续并以目录消失完成。
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "manifest.json"), JSON.stringify({ projectionId: "retired-copy", reducerVersion: 1 }));
  const stopping = open(root);
  stopping.durableProjection(definition("retired-copy", 2));
  await stopping.stopStorageMaintenance();
  await expect(stopping.reclaimRetiredProjectionVersion("retired-copy", 1)).resolves.toBe("stopped");
  await expect(stat(path.join(legacy, "manifest.json"))).resolves.toBeDefined();
  const resumed = open(root);
  resumed.durableProjection(definition("retired-copy", 2));
  await expect(resumed.reclaimRetiredProjectionVersion("retired-copy", 1)).resolves.toBe("removed");
  await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
}, 60_000);

/** 外部尾部消费者的替身：覆盖位置由测试控制，追平即读到当前 head。 */
function tailConsumer(log: FileAuthorityCommitLog, covered: DurableLogCheckpoint | undefined) {
  const state = { covered, catchUps: 0, refreshes: 0, failure: undefined as Error | undefined };
  const consumer: AuthorityTailConsumer = {
    coveredThrough: () => state.covered,
    publishCoverage: async () => {
      state.catchUps++;
      if (state.failure) throw state.failure;
      // 锁外调用：若仍在追加的日志锁内，这里取当前 head 会与该锁互等。
      state.covered = await log.checkpoint();
    },
    refresh: () => { state.refreshes++; },
  };
  return { state, unregister: log.registerTailConsumer(consumer) };
}

it("keeps an external tail consumer within the hard frame bound by catching it up outside the log lock", async () => {
  const root = await createTempDir("b2-tail-consumer-bound");
  const log = open(root);
  const consumer = tailConsumer(log, await log.checkpoint());
  let worst = 0;
  for (let n = 0; n < AUTHORITY_RECOVERY_BUDGET.hardFrames * 2 + 3; n++) {
    await log.append([{ stream: "control", body: { n } }]);
    const head = await log.checkpoint();
    worst = Math.max(worst, head.lsn - consumer.state.covered!.lsn);
  }
  // 刷新只是提示（替身不追平）；硬界由追加前的准入保证，越界的那次追加在锁外追平后成功。
  expect(worst).toBeLessThanOrEqual(AUTHORITY_RECOVERY_BUDGET.hardFrames);
  expect(consumer.state.catchUps).toBe(2);
  expect(consumer.state.refreshes).toBeGreaterThan(0);
  // 登记撤销后不再核它。
  consumer.unregister();
  for (let n = 0; n < AUTHORITY_RECOVERY_BUDGET.hardFrames + 1; n++) await log.append([{ stream: "control", body: { after: n } }]);
  expect(consumer.state.catchUps).toBe(2);
}, 120_000);

it("returns ordinary backpressure to a writer holding a domain queue and admits its retry once the consumer caught up", async () => {
  const root = await createTempDir("b2-tail-consumer-queue");
  const log = open(root);
  const origin = await log.checkpoint();
  for (let n = 0; n < AUTHORITY_RECOVERY_BUDGET.hardFrames; n++) await log.append([{ stream: "control", body: { n } }]);
  const consumer = tailConsumer(log, origin);
  const queue = new SerialTaskQueue();
  // 持有领域串行区：不在区内等待追平，按背压上抛，追平在后台进行。
  await expect(queue.run(() => log.append([{ stream: "control", body: { queued: true } }])))
    .rejects.toBeInstanceOf(AuthorityPreparationRequired);
  expect((await log.checkpoint()).lsn).toBe(AUTHORITY_RECOVERY_BUDGET.hardFrames);
  await vi.waitFor(() => expect(consumer.state.covered!.lsn).toBe(AUTHORITY_RECOVERY_BUDGET.hardFrames));
  await expect(queue.run(() => log.append([{ stream: "control", body: { queued: true } }]))).resolves.toBeDefined();
}, 120_000);

it("fails an over-budget append without committing when the tail consumer cannot catch up", async () => {
  const root = await createTempDir("b2-tail-consumer-failure");
  const log = open(root);
  const origin = await log.checkpoint();
  for (let n = 0; n < AUTHORITY_RECOVERY_BUDGET.hardFrames; n++) await log.append([{ stream: "control", body: { n } }]);
  const consumer = tailConsumer(log, origin);
  consumer.state.failure = new Error("lifecycle catch-up failed");
  await expect(log.append([{ stream: "control", body: { over: true } }])).rejects.toThrow("lifecycle catch-up failed");
  expect((await log.checkpoint()).lsn).toBe(AUTHORITY_RECOVERY_BUDGET.hardFrames);
  // 未知覆盖位置同样先追平，不按“无欠账”放行。
  consumer.state.failure = undefined;
  consumer.state.covered = undefined;
  await expect(log.append([{ stream: "control", body: { over: true } }])).resolves.toBeDefined();
  expect(consumer.state.catchUps).toBe(2);
}, 120_000);
