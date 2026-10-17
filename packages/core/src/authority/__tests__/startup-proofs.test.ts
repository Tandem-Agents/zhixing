import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { serialize } from "node:v8";
import type { LogDraft } from "../../logging/contracts.js";

const INTEGRITY_KEY = Buffer.alloc(32, 7);

// 每次重新导入一份模块，进程内的核验视图与索引随之清空，等同一次冷启动。
// 组合入口在打开日志前按实例注入缓存密钥；`null` 表示这次没有可用密钥。
async function coldStart(integrityKey: Uint8Array | null = INTEGRITY_KEY) {
  vi.resetModules();
  const proofs = await import("../startup-proofs.js");
  const frames = await import("../wal-frame.js");
  const { FileAuthorityCommitLog } = await import("../commit-log.js");
  const { FileArtifactStore } = await import("../artifact-store.js");
  const integrity = integrityKey === null ? undefined : new proofs.AuthorityCacheIntegrity(integrityKey);
  // 记录每次物理逐帧扫描覆盖的字节数：认证模式下冷启动只扫尾部。
  const scans: number[] = [];
  const original = frames.scanAuthorityWalFrames;
  vi.spyOn(frames, "scanAuthorityWalFrames").mockImplementation((reader, ...rest) => {
    scans.push(reader.size);
    return original(reader, ...rest);
  });
  const records: LogDraft[] = [];
  return {
    proofs,
    scans,
    records,
    open: (root: string, startupProofs = true) =>
      new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
        startupProofs,
        ...(integrity ? { integrity } : {}),
        records: { record: (draft) => { records.push(typeof draft === "function" ? draft() : draft); } },
      }),
  };
}

function walPath(root: string): string {
  return path.join(root, "authority", "authority.log");
}

async function flipByte(file: string, marker: string, delta = 0): Promise<void> {
  const bytes = await readFile(file);
  const at = bytes.indexOf(Buffer.from(marker));
  expect(at).toBeGreaterThanOrEqual(0);
  bytes[at + delta] ^= 1;
  await writeFile(file, bytes);
}

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

it("opens an authenticated log from its seal and scans only the tail appended since", async () => {
  const root = await createTempDir("startup-frame-index");
  const writer = (await coldStart()).open(root);
  for (let index = 0; index < 300; index += 1) await writer.append([{ stream: index % 2 ? "control" : "governor", body: { index } }]);
  await writer.stopStorageMaintenance();
  // 跨越一整页：整页落在行文件里，未满页与头部指针在封条里。
  expect((await stat(path.join(root, "authority", "frame-index-v1.rows"))).size).toBeGreaterThan(256 * 88);

  // 冷启动：只核对封条头部那一帧并续扫尾部（长度为零），不读取或哈希历史。
  const reopened = await coldStart();
  const log = reopened.open(root);
  expect((await log.checkpoint()).lsn).toBe(300);
  expect(reopened.scans).toEqual([0]);
  // 历史在读取时按认证索引逐帧核对；按流读取只取被选中的帧。
  const governor = await log.readStream<{ index: number }>("governor");
  expect(governor.map((record) => record.body.index)).toEqual(Array.from({ length: 150 }, (_, n) => n * 2));
  expect((await log.readSnapshot()).commits).toHaveLength(300);
  await log.stopStorageMaintenance();

  // 未开启启动证明的写者在其后追加：下次冷启动只逐帧核验这两帧。
  const strict = (await coldStart()).open(root, false);
  await strict.append([{ stream: "governor", body: { index: 300 } }]);
  await strict.append([{ stream: "governor", body: { index: 301 } }]);
  await strict.stopStorageMaintenance();
  const extended = await coldStart();
  const grown = extended.open(root);
  expect((await grown.checkpoint()).lsn).toBe(302);
  expect(extended.scans).toHaveLength(1);
  expect(extended.scans[0]).toBeGreaterThan(0);
  expect(extended.scans[0]).toBeLessThan(1024);
  expect((await grown.readSnapshot()).commits.map((commit) => commit.lsn).slice(-3)).toEqual([300, 301, 302]);
  await grown.stopStorageMaintenance();
}, 90_000);

it("selects multi-stream envelopes by their stream summary without losing any record", async () => {
  const root = await createTempDir("startup-frame-index-multi-stream");
  const writer = (await coldStart()).open(root);
  for (let index = 0; index < 600; index += 1) {
    const entries = index % 3 === 0
      ? [{ stream: "control", body: { index } }, { stream: "governor", body: { index } }]
      : index % 3 === 1
        ? [{ stream: `run:conv-${index % 7}`, body: { index } }, { stream: "governor", body: { index } }]
        : [{ stream: "publish", body: { index } }];
    await writer.append(entries);
  }
  await writer.stopStorageMaintenance();
  // 冷启动后从认证索引按流读取：多流信封按布隆位图筛选，每个流的记录一条不少。
  const log = (await coldStart()).open(root);
  const indexes = async (stream: string) => (await log.readStream<{ index: number }>(stream)).map((record) => record.body.index);
  const expected = (predicate: (index: number) => boolean) => Array.from({ length: 600 }, (_, index) => index).filter(predicate);
  expect(await indexes("control")).toEqual(expected((index) => index % 3 === 0));
  expect(await indexes("governor")).toEqual(expected((index) => index % 3 !== 2));
  expect(await indexes("publish")).toEqual(expected((index) => index % 3 === 2));
  expect(await indexes("run:conv-3")).toEqual(expected((index) => index % 3 === 1 && index % 7 === 3));
  expect(await indexes("run:conv-unknown")).toEqual([]);
  await log.stopStorageMaintenance();
}, 90_000);

it("never serves tampered history: reads and the background audit reject it like a full verification", async () => {
  const root = await createTempDir("startup-frame-index-tamper");
  const writer = (await coldStart()).open(root);
  for (let index = 0; index < 20; index += 1) await writer.append([{ stream: "control", body: { value: `original-${index}` } }]);
  await writer.stopStorageMaintenance();
  await flipByte(walPath(root), "original-3");

  const started = await coldStart();
  const log = started.open(root);
  // 启动不读历史，所以仍能打开；被改写的帧一旦读取即被拒绝，未改写的帧照常读取。
  expect((await log.checkpoint()).lsn).toBe(20);
  await expect(log.readSnapshot()).rejects.toThrow(/does not match its authenticated index/u);
  expect((await log.readStream<{ value: string }>("control").catch(() => [])).length).toBe(0);
  // 改写位于第 4 帧：只读前 3 帧的尾部读取照常成功，读到第 4 帧即被拒绝。
  expect((await log.readTail(await log.originCheckpoint(), 3)).commits).toHaveLength(3);
  await expect(log.readTail(await log.originCheckpoint(), 5)).rejects.toThrow(/does not match its authenticated index/u);
  // 巡检发现改写：记录损坏并放弃索引，此后的操作完整核验，与严格模式一样拒绝。
  await expect(log.auditFrameIndex()).rejects.toThrow(/does not match its authenticated index/u);
  expect(started.records.some((record) => record.event === "corrupted")).toBe(true);
  await expect(log.checkpoint()).rejects.toThrow();
  await log.stopStorageMaintenance();
  await expect(stat(path.join(root, "authority", "frame-index-v1.seal"))).rejects.toThrow();
}, 60_000);

it.each(["header", "trailer"])("rejects authenticated history with a damaged frame %s even when its payload is unchanged", async (part) => {
  const root = await createTempDir("startup-frame-structure");
  const writer = (await coldStart()).open(root);
  for (let index = 0; index < 3; index += 1) await writer.append([{ stream: "control", body: { index } }]);
  await writer.stopStorageMaintenance();
  const frames = await import("../wal-frame.js");
  const bytes = await readFile(walPath(root));
  const first = frames.decodeAuthorityWalFrame(bytes, frames.AUTHORITY_WAL_FILE_HEADER_BYTES);
  if (first.kind !== "complete") throw new Error("fixture frame is incomplete");
  const offset = part === "header" ? frames.AUTHORITY_WAL_FILE_HEADER_BYTES : first.nextOffset - frames.AUTHORITY_WAL_TRAILER_BYTES;
  bytes[offset] = bytes[offset]! ^ 1;
  await writeFile(walPath(root), bytes);
  const log = (await coldStart()).open(root);
  try {
    expect((await log.checkpoint()).lsn).toBe(3);
    await expect(log.readStream("control")).rejects.toThrow(/frame|magic/iu);
  } finally { await log.stopStorageMaintenance(); }
}, 30_000);

it("audits every historical frame and stops when maintenance stops", async () => {
  const root = await createTempDir("startup-frame-index-audit");
  const writer = (await coldStart()).open(root);
  for (let index = 0; index < 600; index += 1) await writer.append([{ stream: "control", body: { index } }]);
  expect(await writer.auditFrameIndex()).toBe(600);
  const aborted = new AbortController();
  aborted.abort();
  expect(await writer.auditFrameIndex(aborted.signal)).toBe(0);
  await writer.stopStorageMaintenance();

  // 打开后安排的巡检在停止维护后不再运行。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const started = await coldStart();
    const log = started.open(root);
    const audit = vi.spyOn(log, "auditFrameIndex");
    expect((await log.checkpoint()).lsn).toBe(600);
    await log.stopStorageMaintenance();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(audit).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
}, 90_000);

it("rebuilds from a full verification when the index is forged, keyed differently or describes other bytes", async () => {
  const root = await createTempDir("startup-frame-index-fallback");
  const writer = (await coldStart()).open(root);
  for (let index = 0; index < 300; index += 1) await writer.append([{ stream: "control", body: { index } }]);
  await writer.stopStorageMaintenance();
  const fullSize = (await stat(walPath(root))).size;
  const sealPath = path.join(root, "authority", "frame-index-v1.seal");
  const rowsPath = path.join(root, "authority", "frame-index-v1.rows");
  const seal = await readFile(sealPath);
  const rows = await readFile(rowsPath);

  // 换一把密钥：封条认证不过，完整核验并以新纪元重建，结果正确。
  const otherKey = await coldStart(Buffer.alloc(32, 9));
  const keyed = otherKey.open(root);
  expect((await keyed.readSnapshot()).commits).toHaveLength(300);
  expect(otherKey.scans[0]).toBeGreaterThan(fullSize - 200);
  await keyed.stopStorageMaintenance();
  await writeFile(sealPath, seal);
  await writeFile(rowsPath, rows);

  // 行文件被改写：整页认证不过，放弃索引、完整核验后照常读取。
  const forgedRows = Buffer.from(rows);
  forgedRows[64 + 10] ^= 1;
  await writeFile(rowsPath, forgedRows);
  const forged = await coldStart();
  const forgedLog = forged.open(root);
  expect((await forgedLog.readSnapshot()).commits).toHaveLength(300);
  expect(forged.scans.some((size) => size > fullSize - 200)).toBe(true);
  await forgedLog.stopStorageMaintenance();
  await writeFile(sealPath, seal);
  await writeFile(rowsPath, rows);

  // 封条里未满页的某一行被篡改（结构自洽，只有认证能发现）：不被采用。
  const forgedSeal = Buffer.from(seal);
  forgedSeal[112 + 30] ^= 1;
  await writeFile(sealPath, forgedSeal);
  const sealed = await coldStart();
  const sealedLog = sealed.open(root);
  expect((await sealedLog.checkpoint()).lsn).toBe(300);
  expect(sealed.scans[0]).toBeGreaterThan(fullSize - 200);
  await sealedLog.stopStorageMaintenance();
  await writeFile(sealPath, seal);
  await writeFile(rowsPath, rows);

  // 封条头部的那一帧被截掉：头部不在当前日志上，完整核验（截断处的不完整帧被隔离）。
  const bytes = await readFile(walPath(root));
  await writeFile(walPath(root), bytes.subarray(0, bytes.byteLength - 10));
  const truncated = await coldStart();
  const truncatedLog = truncated.open(root);
  expect((await truncatedLog.checkpoint()).lsn).toBe(299);
  expect(truncated.records.some((record) => record.event === "recovered" && (record.data as { incompleteTail?: boolean }).incompleteTail)).toBe(true);
  expect((await truncatedLog.readSnapshot()).commits).toHaveLength(299);
  await truncatedLog.stopStorageMaintenance();
}, 120_000);

it("keeps strict per-operation byte comparison when no integrity key is available", async () => {
  const root = await createTempDir("startup-strict-without-key");
  const started = await coldStart(null);
  const verified = await import("../verified-wal-view.js");
  const log = started.open(root);
  await log.append([{ stream: "control", body: { value: "original" } }]);
  expect((await log.readSnapshot()).commits).toHaveLength(1);
  // 固定元数据、只改字节：没有密钥时不按间隔复用，下一次操作立即发现改写。
  const version = await verified.readWalVersion(log.logPath);
  const unchanged = vi.spyOn(verified, "readWalVersion").mockResolvedValue(version);
  try {
    await flipByte(log.logPath, "original");
    await expect(log.readSnapshot()).rejects.toThrow();
  } finally {
    unchanged.mockRestore();
    await log.stopStorageMaintenance();
  }
  await expect(stat(path.join(root, "authority", "frame-index-v1.seal"))).rejects.toThrow();
}, 30_000);

it("runs strictly without an instance key and authenticates only after the owner injects a sufficient key", async () => {
  const root = await createTempDir("startup-proof-key");
  const sealPath = path.join(root, "authority", "frame-index-v1.seal");
  const started = await coldStart(null);
  // 不足长度的密钥不能被当作已认证：构造即拒绝，组合入口随之按严格模式打开。
  expect(() => new started.proofs.AuthorityCacheIntegrity(Buffer.alloc(16, 1))).toThrow();
  for (let round = 0; round < 2; round++) {
    const log = started.open(root);
    await log.append([{ stream: "control", body: { value: round } }]);
    expect((await log.readSnapshot()).commits.length).toBeGreaterThan(0);
    await log.stopStorageMaintenance();
    await expect(readFile(sealPath)).rejects.toThrow();
  }
  // 下一次打开时注入密钥：首次操作完整核验并建立认证索引。
  const keyed = (await coldStart()).open(root);
  expect((await keyed.readSnapshot()).commits).toHaveLength(2);
  await keyed.stopStorageMaintenance();
  expect((await readFile(sealPath)).byteLength).toBeGreaterThan(0);
}, 60_000);

it("restores a projection checkpoint across restarts only under the same key and on this log's verified chain", async () => {
  const root = await createTempDir("startup-projection-checkpoint");
  const count = (state: number) => state + 1;
  const started = await coldStart();
  const key = started.proofs.projectionCheckpointKey("counted-projection", 1, count);
  const writer = started.open(root);
  for (let index = 0; index < 3; index += 1) await writer.append([{ stream: "governor", body: { index } }]);
  await writer.append([{ stream: "control", body: { ignored: true } }]);
  const replayed = await writer.readProjection(0, count, { stream: "governor" });
  expect(replayed.state).toBe(3);
  await writer.saveProjectionCheckpoint(key, replayed.cursor, replayed.state);
  // 调用方发起保存后立即原地推进同一份状态：写下的仍是与游标对应的那一刻。
  const mutable = { count: replayed.state };
  const saving = writer.saveProjectionCheckpoint("mutable-projection", replayed.cursor, mutable);
  mutable.count = 99;
  await saving;
  for (let index = 3; index < 5; index += 1) await writer.append([{ stream: "governor", body: { index } }]);
  await writer.stopStorageMaintenance();

  // 重启（包括升级后的首次启动）：同一键、同一密钥下恢复，只续算尾部。
  const reader = (await coldStart()).open(root);
  const restored = await reader.loadProjectionCheckpoint<number>(key);
  expect(restored?.state).toBe(3);
  let visited = 0;
  const caught = await reader.readProjection(restored!.state, (state: number) => { visited += 1; return state + 1; },
    { stream: "governor", cursor: restored!.cursor });
  expect(caught.state).toBe(5);
  expect(visited).toBe(2);
  expect(await reader.loadProjectionCheckpoint("another-projection")).toBeUndefined();
  expect((await reader.loadProjectionCheckpoint<{ count: number }>("mutable-projection"))?.state).toEqual({ count: 3 });
  await reader.deleteProjectionCheckpoint("mutable-projection");
  expect(await reader.loadProjectionCheckpoint("mutable-projection")).toBeUndefined();
  // 不持有完整性密钥者改写状态并补齐状态摘要：认证不过，检查点不被采用。
  const checkpointFile = path.join(root, "authority", "checkpoints", createHash("sha256").update(key).digest("hex").slice(0, 40) + ".bin");
  const original = await readFile(checkpointFile);
  const headerEnd = original.indexOf(10, 6);
  const forgedState = serialize(99);
  const forgedHeader = { ...JSON.parse(original.subarray(6, headerEnd).toString("utf8")), stateBytes: forgedState.byteLength,
    stateDigest: createHash("sha256").update(forgedState).digest("hex") };
  await writeFile(checkpointFile, Buffer.concat([original.subarray(0, 6), Buffer.from(JSON.stringify(forgedHeader) + "\n"), forgedState]));
  expect(await reader.loadProjectionCheckpoint(key)).toBeUndefined();
  await writeFile(checkpointFile, original);
  await reader.stopStorageMaintenance();

  // 归约函数体改变：键随指纹改变，旧检查点不再被采用；版本提升同理。
  const changedReducer = (state: number) => state + 2;
  expect(started.proofs.projectionCheckpointKey("counted-projection", 1, changedReducer)).not.toBe(key);
  expect(started.proofs.projectionCheckpointKey("counted-projection", 2, count)).not.toBe(key);
  // 换一把密钥：不采用。
  const otherKey = (await coldStart(Buffer.alloc(32, 9))).open(root);
  expect(await otherKey.loadProjectionCheckpoint(key)).toBeUndefined();
  await otherKey.stopStorageMaintenance();

  // 检查点边界不在本日志的帧链上（同一日志身份下前缀被改写为另一条链）：不采用。
  const replaced = (await coldStart()).open(root);
  const boundary = JSON.parse(original.subarray(6, headerEnd).toString("utf8")).boundary as { lsn: number };
  expect(boundary.lsn).toBe(4);
  await replaced.stopStorageMaintenance();
  const bytes = await readFile(walPath(root));
  await writeFile(walPath(root), bytes.subarray(0, bytes.indexOf(Buffer.from('"index":2'))));
  const shortened = (await coldStart()).open(root);
  expect(await shortened.loadProjectionCheckpoint(key)).toBeUndefined();
  await shortened.stopStorageMaintenance();
}, 60_000);

it("flushes registered projection checkpoints when a host log stops", async () => {
  const root = await createTempDir("startup-checkpoint-flush");
  const started = await coldStart();
  for (const startupProofs of [false, true]) {
    const log = started.open(path.join(root, String(startupProofs)), startupProofs);
    await log.append([{ stream: "governor", body: { index: 0 } }]);
    const replayed = await log.readProjection(0, (state: number) => state + 1, { stream: "governor" });
    let flushed = 0;
    log.registerCheckpointFlush(async () => { flushed += 1; await log.saveProjectionCheckpoint("flushed-projection", replayed.cursor, replayed.state); });
    await log.stopStorageMaintenance();
    // 只有开启启动证明的宿主日志在停止前补存。
    expect(flushed).toBe(startupProofs ? 1 : 0);
    const reopened = (await coldStart()).open(path.join(root, String(startupProofs)), startupProofs);
    expect((await reopened.loadProjectionCheckpoint<number>("flushed-projection"))?.state).toBe(startupProofs ? 1 : undefined);
    await reopened.stopStorageMaintenance();
  }
}, 60_000);

it("saves short durable-index activity on stop without opening unused indices or replaying history", async () => {
  const root = await createTempDir("startup-index-stop");
  const writer = (await coldStart()).open(root);
  const reduce = vi.fn(async (envelope: { lsn: number }) => [
    { kind: "put" as const, key: "latest", value: envelope.lsn },
  ]);
  writer.durableProjection({ projectionId: "active", reducerVersion: 1, authenticated: true, reduce });
  for (let i = 0; i < 3; i++) await writer.append([{ stream: "run:one", body: { i } }]);
  const unused = vi.fn(async () => []);
  writer.durableProjection({ projectionId: "unused", reducerVersion: 1, reduce: unused });
  const beforeStop = reduce.mock.calls.length;
  await writer.stopStorageMaintenance();
  expect(reduce).toHaveBeenCalledTimes(beforeStop);
  expect(unused).not.toHaveBeenCalled();

  const reader = (await coldStart()).open(root);
  const replay = vi.fn(reduce.getMockImplementation()!);
  const projection = reader.durableProjection({ projectionId: "active", reducerVersion: 1, authenticated: true, reduce: replay });
  expect(await projection.get("latest")).toBe(3);
  expect(replay).not.toHaveBeenCalled();
  await reader.stopStorageMaintenance();
}, 60_000);
