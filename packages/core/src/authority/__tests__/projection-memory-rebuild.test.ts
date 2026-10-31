import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import type { CommitEnvelope, JsonValue } from "../../contracts/index.js";
import { AuthorityCacheIntegrity, FileDurableProjectionIndex, durableProjectionVersionDirectoryName,
  type DurableProjectionMutation, type DurableProjectionReadContext } from "../index.js";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog, type FileAuthorityCommitLogOptions } from "../commit-log.js";

const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 91));
const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); });

async function history(frames: number) {
  const root = await createTempDir("projection-memory-rebuild");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const writer = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { integrity });
  for (let n = 1; n <= frames; n++) await writer.append([{ stream: "control", body: { n } }]);
  await writer.stopStorageMaintenance();
  return { root, artifacts };
}

function open(fixture: { root: string; artifacts: FileArtifactStore }, options: FileAuthorityCommitLogOptions = {}) {
  const log = new FileAuthorityCommitLog(path.join(fixture.root, "log"), fixture.artifacts, { integrity, ...options });
  logs.push(log);
  return log;
}

/** 每个事实读取前序状态：计数、一个从不存在的键、一个前缀范围，再写入宽值并删除旧值。 */
function definition(seen: number[] = []) {
  return {
    projectionId: "memory-rebuild", reducerVersion: 1, authenticated: true, inputs: { streams: ["control"] },
    async reduce(envelope: CommitEnvelope<JsonValue>, current: DurableProjectionReadContext): Promise<DurableProjectionMutation[]> {
      const n = (envelope.entries[0]!.body as { n: number }).n;
      seen.push(n);
      expect(await current.get("count") ?? 0).toBe(n - 1);
      expect(await current.get("never")).toBeUndefined();
      const live = (await current.scan({ gte: "item/", lt: "item/￿" }, 256)).entries;
      expect(live.map(row => row.key)).toEqual(Array.from({ length: Math.min(n - 1, 20) }, (_, i) => "item/" + String(Math.max(0, n - 1 - 20) + i + 1).padStart(5, "0")));
      return [{ kind: "put", key: "count", value: n }, { kind: "put", key: "item/" + String(n).padStart(5, "0"), value: { n, pad: "x".repeat(300) } },
        ...(n > 20 ? [{ kind: "tombstone" as const, key: "item/" + String(n - 20).padStart(5, "0") }] : [])];
    },
  };
}

async function dump(log: FileAuthorityCommitLog): Promise<unknown[]> {
  return (await log.transactDurableProjection("memory-rebuild", async view => {
    const rows: unknown[] = []; let continuation: string | undefined;
    do { const page = await view.scan({}, 256, continuation); rows.push(...page.entries); continuation = page.continuation; } while (continuation);
    return { kind: "return", value: rows };
  })).value;
}

async function manifest(root: string) {
  return JSON.parse(await readFile(path.join(root, "log", "projections", durableProjectionVersionDirectoryName("memory-rebuild", 1), "manifest.json"), "utf8"));
}

it("converges to the same authenticated state whether the rebuild fits in memory or spills to segments", async () => {
  const fixture = await history(300);
  const inMemory = open(fixture);
  inMemory.durableProjection(definition());
  await inMemory.prepareProjections(["memory-rebuild"]);
  const expected = await dump(inMemory);
  expect(expected).toHaveLength(21);
  expect((await manifest(fixture.root)).deltaSegments).toEqual([]);
  await inMemory.stopStorageMaintenance();

  const spilled = await history(300);
  const physical: string[] = [];
  const small = open(spilled, { projectionRebuildOverlayBytes: 4 * 1024, runProjectionReadStep: (step, operation) => { physical.push(step); return operation(); } });
  small.durableProjection(definition());
  await small.prepareProjections(["memory-rebuild"]);
  // 放不下时照常经过段读取，并保持既有的增量段上界。
  expect(physical.filter(step => step === "segment-entry").length).toBeGreaterThan(0);
  expect((await manifest(spilled.root)).deltaSegments.length).toBeLessThanOrEqual(5);
  expect(await dump(small)).toEqual(expected);
}, 120_000);

it("resumes an interrupted rebuild from its last durable checkpoint instead of from the origin", async () => {
  const fixture = await history(400);
  const first = open(fixture, { projectionRebuildOverlayBytes: 16 * 1024 });
  let stopping: Promise<void> | undefined;
  const firstSeen: number[] = [];
  const interrupted = definition(firstSeen);
  first.durableProjection({ ...interrupted, async reduce(envelope, current) {
    if ((envelope.entries[0]!.body as { n: number }).n === 300) { stopping = first.stopStorageMaintenance(); throw new Error("interrupted"); }
    return interrupted.reduce(envelope, current);
  } });
  await expect(first.prepareProjections(["memory-rebuild"])).rejects.toThrow();
  await stopping;
  const durable = (await manifest(fixture.root)).checkpoints.authority.lsn as number;
  expect(durable).toBeGreaterThan(0);
  expect(durable).toBeLessThan(300);

  const resumedSeen: number[] = [];
  const resumed = open(fixture);
  resumed.durableProjection(definition(resumedSeen));
  await resumed.prepareProjections(["memory-rebuild"]);
  expect(resumedSeen[0]).toBe(durable + 1);
  expect(resumedSeen.at(-1)).toBe(400);
  const fresh = await history(400);
  const reference = open(fresh);
  reference.durableProjection(definition());
  await reference.prepareProjections(["memory-rebuild"]);
  expect(await dump(resumed)).toEqual(await dump(reference));
}, 120_000);

it("rebases a complete in-memory rebuild instead of compacting when timed checkpoints fill the delta window", async () => {
  const fixture = await history(420);
  const physical: string[] = [];
  const log = open(fixture, { runProjectionReadStep: (step, operation) => { physical.push(step); return operation(); } });
  // 每页约推进 6 秒：每个页尾都到期落盘，增量段很快填满。
  let offset = 0;
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
  const timed = definition();
  log.durableProjection({ ...timed, async reduce(envelope, current) { offset += 100; return timed.reduce(envelope, current); } });
  const flushes = vi.spyOn(FileDurableProjectionIndex.prototype, "flush");
  await log.prepareProjections(["memory-rebuild"]);
  expect(flushes.mock.calls.length).toBeGreaterThanOrEqual(5);
  // 读取全部来自内存；清单从未越过增量段上界（否则重新打开会判为损坏）。
  expect(physical.filter(step => step !== "manifest")).toEqual([]);
  const published = await manifest(fixture.root);
  expect(published.deltaSegments).toEqual([]);
  expect(published.rebuilding).toBeUndefined();
  vi.restoreAllMocks();
  const fresh = await history(420);
  const reference = open(fresh);
  reference.durableProjection(definition());
  await reference.prepareProjections(["memory-rebuild"]);
  expect(await dump(log)).toEqual(await dump(reference));
}, 120_000);

/** 每帧多条事实：写一个宽值并删除 20 条之前的那个，重建期的墓碑随历史增长。 */
async function churnHistory(frames: number, perFrame: number) {
  const root = await createTempDir("projection-rebuild-structure");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const writer = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { integrity });
  for (let frame = 0; frame < frames; frame++) {
    await writer.append(Array.from({ length: perFrame }, (_, i) => ({ stream: "control", body: { n: frame * perFrame + i + 1 } })));
  }
  await writer.stopStorageMaintenance();
  return { root, artifacts };
}

const item = (n: number) => "item/" + String(n).padStart(6, "0");

function churn(seen: number[] = []) {
  return {
    projectionId: "memory-rebuild", reducerVersion: 1, authenticated: true, inputs: { streams: ["control"] },
    async reduce(envelope: CommitEnvelope<JsonValue>): Promise<DurableProjectionMutation[]> {
      return envelope.entries.flatMap((entry) => {
        const n = (entry.body as { n: number }).n;
        seen.push(n);
        return [{ kind: "put" as const, key: item(n), value: { n, pad: "x".repeat(200) } },
          ...(n > 20 ? [{ kind: "tombstone" as const, key: item(n - 20) }] : [])];
      });
    },
  };
}

async function liveItems(log: FileAuthorityCommitLog) {
  return (await log.transactDurableProjection("memory-rebuild", async view =>
    ({ kind: "return", value: (await view.scan({ gte: "item/", lt: "item/￿" }, 64)).entries.map(row => row.key) }))).value;
}

async function churnReference() {
  const reference = open(await churnHistory(120, 50));
  reference.durableProjection(churn());
  await reference.prepareProjections(["memory-rebuild"]);
  return dump(reference);
}

it("finishes a spilled rebuild inside its own recovery pages so ordinary reads start within the normal delta budget", async () => {
  const fixture = await churnHistory(120, 50);
  const physical: string[] = [];
  const log = open(fixture, { projectionRebuildOverlayBytes: 256 * 1024, runProjectionReadStep: (step, operation) => { physical.push(step); return operation(); } });
  log.durableProjection(churn());
  await log.prepareProjections(["memory-rebuild"]);
  const published = await manifest(fixture.root);
  expect(published.rebuilding).toBeUndefined();
  // 就绪时每个增量段都在普通覆盖层上限内：重建期按重建预算写下的大段连同其中的墓碑已并入只含存活值的基础段
  for (const segment of published.deltaSegments) expect(segment.count).toBeLessThanOrEqual(512);
  physical.length = 0;
  expect(await liveItems(log)).toEqual(Array.from({ length: 20 }, (_, i) => item(6000 - 19 + i)));
  // 小范围读取不再扫过重建期累积的上千条墓碑：至多一个普通增量段加存活条目
  expect(physical.filter(step => step === "segment-entry").length).toBeLessThanOrEqual(512 + 64);
  expect(await dump(log)).toEqual(await churnReference());
}, 300_000);

it("resumes an interrupted rebuild finish from its durable structure progress without replaying the source", async () => {
  const fixture = await churnHistory(120, 50);
  const first = open(fixture, { projectionRebuildOverlayBytes: 256 * 1024 });
  first.durableProjection(churn());
  const original = FileDurableProjectionIndex.prototype.completeRebuild;
  let steps = 0;
  let stopping: Promise<void> | undefined;
  vi.spyOn(FileDurableProjectionIndex.prototype, "completeRebuild").mockImplementation(async function (this: FileDurableProjectionIndex, checkpoints, step) {
    if (step && ++steps === 4) { stopping = first.stopStorageMaintenance(); throw new Error("interrupted"); }
    return original.call(this, checkpoints, step);
  });
  await expect(first.prepareProjections(["memory-rebuild"])).rejects.toThrow();
  await stopping;
  vi.restoreAllMocks();
  const interrupted = await manifest(fixture.root);
  expect(interrupted.rebuilding).toBe(true);
  expect(interrupted.compaction).toBeDefined();

  const seen: number[] = [];
  const resumed = open(fixture, { projectionRebuildOverlayBytes: 256 * 1024 });
  resumed.durableProjection(churn(seen));
  await resumed.prepareProjections(["memory-rebuild"]);
  // 源头已追平并落盘：续做只推进结构收尾，不重放任何事实
  expect(seen).toEqual([]);
  const published = await manifest(fixture.root);
  expect(published.rebuilding).toBeUndefined();
  for (const segment of published.deltaSegments) expect(segment.count).toBeLessThanOrEqual(512);
  expect(await dump(resumed)).toEqual(await churnReference());
}, 300_000);
