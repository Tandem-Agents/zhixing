import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import type { CommitEnvelope, JsonValue } from "../../contracts/index.js";
import { AuthorityCacheIntegrity, normalizeProjectionMutationsInSlices, type DurableLogCheckpoint, type DurableProjectionMutation, type DurableProjectionReadContext } from "../index.js";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";

// 从源头部起步的投影：不回放既有历史，在已验头部写下初始行；迁移结果经锁内发布写入，不推进投影位置。
const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 93));
const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); });

async function history(frames: number) {
  const root = await createTempDir("projection-source-start");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const writer = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { integrity });
  for (let n = 1; n <= frames; n++) await writer.append([{ stream: n % 2 ? "run:odd" : "run:even", body: { n } }]);
  await writer.stopStorageMaintenance();
  return { root, artifacts };
}

function open(fixture: { root: string; artifacts: FileArtifactStore }) {
  const log = new FileAuthorityCommitLog(path.join(fixture.root, "log"), fixture.artifacts, { integrity });
  logs.push(log);
  return log;
}

function definition(seen: number[], startAtSource: (head: DurableLogCheckpoint) => boolean) {
  return {
    projectionId: "source-start", reducerVersion: 1, authenticated: true, inputs: { streams: ["run:odd", "run:even"] }, startAtSource,
    seedAtSource: (head: DurableLogCheckpoint): DurableProjectionMutation[] => [{ kind: "put", key: "~start", value: head.lsn }],
    async reduce(envelope: CommitEnvelope<JsonValue>, _current: DurableProjectionReadContext): Promise<DurableProjectionMutation[]> {
      const n = (envelope.entries[0]!.body as { n: number }).n;
      seen.push(n);
      return [{ kind: "put", key: "last", value: n }];
    },
  };
}

async function get(log: FileAuthorityCommitLog, key: string): Promise<JsonValue | null> {
  return (await log.transactDurableProjection<never, JsonValue | null>("source-start",
    async view => ({ kind: "return", value: await view.get(key) ?? null }))).value;
}

it("starts an empty projection at the verified source head without replaying history and seeds its start rows once", async () => {
  const fixture = await history(40);
  const seen: number[] = [];
  const log = open(fixture);
  log.durableProjection(definition(seen, head => head.lsn > 10));
  expect(await get(log, "~start")).toBe(40);
  expect(await get(log, "last")).toBeNull();
  expect(seen).toEqual([]);
  // 起步之后的新事实照常逐个归约。
  await log.append([{ stream: "run:odd", body: { n: 41 } }]);
  expect(await get(log, "last")).toBe(41);
  expect(seen).toEqual([41]);
  await log.stopStorageMaintenance();

  // 重开沿用已落盘的投影：既不回放，也不再写初始行。
  const reopenedSeen: number[] = [];
  const reopened = open(fixture);
  reopened.durableProjection(definition(reopenedSeen, head => head.lsn > 10));
  expect(await get(reopened, "~start")).toBe(40);
  expect(await get(reopened, "last")).toBe(41);
  expect(reopenedSeen).toEqual([]);
}, 120_000);

/** 投影目录里当前生效的清单内容。 */
async function manifests(root: string): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name === "manifest.json") found.push(JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>);
    }
  };
  await visit(path.join(root, "log", "projections"));
  return found;
}

it("never exposes a caught-up empty state without its start rows after a crash before the first flush", async () => {
  const fixture = await history(40);
  const log = open(fixture);
  log.durableProjection(definition([], () => true));
  expect(await get(log, "~start")).toBe(40);
  // 起步清单已耐久、初始行尚在覆盖层：此刻磁盘上的目录就是崩溃现场。
  const crashed = await createTempDir("projection-source-start-crash");
  // 崩溃不会留下仍被持有的进程锁：复制现场时不带锁文件。
  await cp(fixture.root, crashed, { recursive: true, filter: source => !path.basename(source).includes(".lock") });
  const state = await manifests(crashed);
  expect(state.some(manifest => JSON.stringify(manifest).includes("sourceSeedPending"))).toBe(true);
  await log.stopStorageMaintenance();
  // 重开（写者与只读）都先放回初始行：处于迁移中，而不是“已追平的空状态”。
  const reopened = open({ root: crashed, artifacts: new FileArtifactStore(path.join(crashed, "artifacts")) });
  reopened.durableProjection(definition([], () => true));
  expect(await get(reopened, "~start")).toBe(40);
  await reopened.stopStorageMaintenance();
  // 正常停止写出覆盖层后，标志清除、初始行仍在。
  expect((await manifests(crashed)).some(manifest => JSON.stringify(manifest).includes("sourceSeedPending"))).toBe(false);
  const again = open({ root: crashed, artifacts: new FileArtifactStore(path.join(crashed, "artifacts")) });
  again.durableProjection(definition([], () => true));
  expect(await get(again, "~start")).toBe(40);
}, 120_000);

it("shows the start rows to a read-only opener of a source that has no index yet", async () => {
  const fixture = await history(40);
  const readOnly = new FileAuthorityCommitLog(path.join(fixture.root, "log"), fixture.artifacts, { integrity, readOnly: true });
  logs.push(readOnly);
  readOnly.durableProjection(definition([], () => true));
  expect(await get(readOnly, "~start")).toBe(40);
  // 只读打开不补写磁盘。
  expect((await manifests(fixture.root)).some(manifest => JSON.stringify(manifest).includes("source-start"))).toBe(false);
}, 120_000);

it("writes a large published batch through a segment encoded outside the maintenance step and reads it back after reopening", async () => {
  const fixture = await history(40);
  const log = open(fixture);
  log.durableProjection(definition([], () => true));
  expect(await get(log, "~start")).toBe(40);
  // 超过预编码门槛的整批写入：发布后的落盘先在维护步骤外编码，再在步骤内写字节。
  const rows: DurableProjectionMutation[] = Array.from({ length: 3_000 }, (_, n) =>
    ({ kind: "put", key: "row/" + String(n).padStart(5, "0"), value: { n, text: "value ".repeat(8) + n } }));
  const batch = await normalizeProjectionMutationsInSlices(rows);
  await log.publishProjectionRows!(["source-start"], async () => new Map([["source-start", batch]]));
  expect(await get(log, "row/02999")).toEqual({ n: 2_999, text: "value ".repeat(8) + 2_999 });
  await log.append([{ stream: "run:odd", body: { n: 41 } }]);
  await log.stopStorageMaintenance();
  // 重开后从落盘的段读回（认证模式逐条核对校验和），整批与之后的事实都在。
  const reopened = open(fixture);
  reopened.durableProjection(definition([], () => true));
  const all = (await reopened.transactDurableProjection<never, Map<string, JsonValue>>("source-start", async view => {
    const found = new Map<string, JsonValue>(); let continuation: string | undefined;
    do { const page = await view.scan({ gte: "row/", lt: "row0" }, 256, continuation); for (const entry of page.entries) found.set(entry.key, entry.value); continuation = page.continuation; } while (continuation);
    return { kind: "return", value: found };
  })).value;
  expect(all.size).toBe(3_000);
  for (const n of [0, 1, 1_024, 2_047, 2_999]) expect(all.get("row/" + String(n).padStart(5, "0"))).toEqual({ n, text: "value ".repeat(8) + n });
  expect(await get(reopened, "last")).toBe(41);
  expect(await get(reopened, "~start")).toBe(40);
}, 120_000);

it("rebuilds from the origin when the source is below the start threshold", async () => {
  const fixture = await history(5);
  const seen: number[] = [];
  const log = open(fixture);
  log.durableProjection(definition(seen, head => head.lsn > 10));
  expect(await get(log, "last")).toBe(5);
  expect(await get(log, "~start")).toBeNull();
  expect(seen).toEqual([1, 2, 3, 4, 5]);
}, 120_000);

it("publishes rows computed under the log lock at the current head without moving the projection position", async () => {
  const fixture = await history(40);
  const log = open(fixture);
  log.durableProjection(definition([], () => true));
  const head = await log.publishProjectionRows(["source-start"], async (current, read, source) => {
    expect(await read("source-start").get("~start")).toBe(40);
    // 锁内按流分页读取：只返回所选流，续读位置不漏不重。
    const odd: number[] = [];
    let after = 0, more = true;
    while (more) {
      const page = await source.readStreamEnvelopes(["run:odd"], after, current.lsn, 4);
      expect(page.commits.length).toBeLessThanOrEqual(4);
      odd.push(...page.commits.map(envelope => envelope.lsn));
      const middle = page.checkpoints[1];
      if (middle) expect((await source.readEnvelopeAt(middle)).lsn).toBe(page.commits[1]!.lsn);
      after = page.lastLsn;
      more = page.hasMore;
    }
    expect(odd).toEqual(Array.from({ length: 20 }, (_, i) => 2 * i + 1));
    await expect(source.readStreamEnvelopes(["run:odd"], 0, current.lsn + 1)).rejects.toThrow(RangeError);
    expect(() => read("other")).toThrow(TypeError);
    return new Map([["source-start", [{ kind: "put", key: "migrated/odd", value: odd.length }]]]);
  });
  expect(head.lsn).toBe(40);
  expect(await get(log, "migrated/odd")).toBe(20);
  // 发布之后的新事实照常归约；落盘后重开仍在。
  await log.append([{ stream: "run:even", body: { n: 42 } }]);
  expect(await get(log, "last")).toBe(42);
  await expect(log.publishProjectionRows(["source-start"], async () => new Map([["other", [{ kind: "put", key: "x", value: 1 }]]])))
    .rejects.toThrow(TypeError);
  await expect(log.publishProjectionRows(["missing"], async () => new Map())).rejects.toThrow(TypeError);
  await log.stopStorageMaintenance();
  const reopened = open(fixture);
  reopened.durableProjection(definition([], () => true));
  expect(await get(reopened, "migrated/odd")).toBe(20);
  expect(await get(reopened, "last")).toBe(42);
}, 120_000);

it("defers flushing small re-derivable publications until the overlay half fills or the log stops", async () => {
  const fixture = await history(10);
  const log = open(fixture);
  log.durableProjection(definition([], () => true));
  // 超过覆盖层条数上限的大量小批写入：覆盖层过半时在锁外先落盘，不在锁内触发提交前落盘。
  for (let n = 0; n < 600; n++) {
    await log.publishProjectionRows(["source-start"], async () => new Map([["source-start", [{ kind: "put", key: `deferred/${n}`, value: n }]]]), { deferFlush: true });
  }
  expect(await get(log, "deferred/599")).toBe(599);
  await log.append([{ stream: "run:even", body: { n: 12 } }]);
  expect(await get(log, "last")).toBe(12);
  // 正式停止时补存未落盘的行；重开后全部可读。
  await log.stopStorageMaintenance();
  const reopened = open(fixture);
  reopened.durableProjection(definition([], () => true));
  expect(await get(reopened, "deferred/0")).toBe(0);
  expect(await get(reopened, "deferred/599")).toBe(599);
  expect(await get(reopened, "last")).toBe(12);
}, 120_000);

it("reads stream envelopes in bounded pages outside the lock and lists checkpoint keys by prefix", async () => {
  const fixture = await history(30);
  const log = open(fixture);
  const head = (await log.readProjection<undefined>(undefined, state => state, {})).cursor;
  const first = await log.readStreamEnvelopes(["run:even"], 0, 30, 3);
  expect(first.commits.map(envelope => envelope.lsn)).toEqual([2, 4, 6]);
  expect(first.hasMore).toBe(true);
  const rest = await log.readStreamEnvelopes(["run:even"], first.lastLsn, 30, 256);
  expect(rest.commits.map(envelope => envelope.lsn)).toEqual(Array.from({ length: 12 }, (_, i) => 2 * i + 8));
  expect(rest.hasMore).toBe(false);
  await expect(log.readStreamEnvelopes([], 0, 30)).rejects.toThrow(TypeError);
  await expect(log.readStreamEnvelopes(["run:even"], 0, 30, 257)).rejects.toThrow(RangeError);

  await log.saveProjectionCheckpoint("alpha:two", head, { v: 2 });
  await log.saveProjectionCheckpoint("alpha:one", head, { v: 1 });
  await log.saveProjectionCheckpoint("beta:one", head, { v: 3 });
  expect(await log.listProjectionCheckpointKeys("alpha:")).toEqual(["alpha:one", "alpha:two"]);
  expect(await log.listProjectionCheckpointKeys("gamma:")).toEqual([]);
}, 120_000);
