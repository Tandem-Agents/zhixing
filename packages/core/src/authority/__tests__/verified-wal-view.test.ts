import { expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { appendFile, mkdir, writeFile, readFile, utimes, stat } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
import { VerifiedWalViews, type VerifiedWalView } from "../verified-wal-view.js";
import * as verified from "../verified-wal-view.js";
import type { LogDraft } from "../../logging/contracts.js";
import type { DurableLogCheckpoint } from "../interfaces.js";

function view(id = "log"): VerifiedWalView {
  return { physicalBytes: Buffer.from("test"), tail: { logId: id, device: 1n, inode: 2n, bytes: 100,
    modifiedAt: 1_700_000_000_000_000_001n, changedAt: 1_700_000_000_000_000_001n,
    lastLsn: 1, prefixDigest: "proof" }, frames: [
    { lsn: 1, frameEndOffset: 100, prefixDigest: "proof", payload: "{}" },
  ] };
}
function metadata(value: VerifiedWalView) {
  return { dev: value.tail.device, ino: value.tail.inode, size: value.tail.bytes,
    mtimeNs: value.tail.modifiedAt!, ctimeNs: value.tail.changedAt! };
}
it("invalidates sub-millisecond changes and different file identities", () => {
  const cache = new VerifiedWalViews();
  const value = view(); const meta = metadata(value);
  for (const change of [{ mtimeNs: meta.mtimeNs + 1n }, { ctimeNs: meta.ctimeNs + 1n },
    { ino: 3n }, { dev: 4n }, { size: 99 }]) {
    cache.put("wal", value);
    expect(cache.get("wal", "log", { ...meta, ...change })).toBeUndefined();
  }
  cache.put("wal", value);
  expect(cache.get("wal", "different", meta)).toBeUndefined();
});
it("bounds retained bytes and paths with least-recently-used eviction", () => {
  const cache = new VerifiedWalViews(1000); const value = view(); const meta = metadata(value);
  cache.put("a", value); cache.put("b", value);
  expect(cache.get("a", "log", meta)).toBe(value);
  cache.put("c", value);
  expect(cache.get("b", "log", meta)).toBeUndefined();
  expect(cache.get("a", "log", meta)).toBe(value);
  cache.put("huge", { ...value, frames: [{ ...value.frames[0]!, payload: "x".repeat(1000) }] });
  expect(cache.get("huge", "log", meta)).toBeUndefined();
  const paths = new VerifiedWalViews();
  for (let i = 0; i < 33; i++) paths.put(String(i), value);
  expect(paths.get("0", "log", meta)).toBeUndefined();
  expect(paths.get("32", "log", meta)).toBe(value);
});
it("shares verified bytes across independent owners, extends durable appends and rejects changed history", async () => {
  const root = await createTempDir("verified-wal-owners");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const entries: LogDraft[] = [];
  const create = () => {
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      records: { record: draft => { entries.push(typeof draft === "function" ? draft() : draft); } },
    });
    onTestFinished(() => log.stopStorageMaintenance()); return log;
  };
  const writer = create();
  await writer.append([{ stream: "control", body: { text: "original", padding: "x".repeat(16000) } }]);
  await writer.readSnapshot();
  const readers = Array.from({ length: 8 }, create);
  for (const reader of readers) {
    const result = await reader.readStream<{ text: string }>("control");
    expect(result[0]!.body.text).toBe("original");
    result[0]!.body.text = "mutated";
  }
  await writer.append([{ stream: "control", body: { text: "second" } }]);
  expect((await readers[0]!.readStream<{ text: string }>("control")).map(r => r.body.text)).toEqual(["original", "second"]);
  for (const reader of readers) await reader.stopStorageMaintenance();
  const reads = entries.filter(d => d.event === "work" && d.data?.operation === "readStream");
  expect(reads.reduce((n, d) => n + Number(d.data!.operations), 0)).toBeGreaterThanOrEqual(8);
  expect(reads.reduce((n, d) => n + Number(d.data!.recoveries), 0)).toBe(0);
  expect(reads.reduce((n, d) => n + Number(d.data!.readBytes), 0)).toBeLessThan(16000 * 12);
  const before = await stat(writer.logPath); const bytes = await readFile(writer.logPath);
  bytes[bytes.indexOf(Buffer.from("original"))] ^= 1;
  await writeFile(writer.logPath, bytes); await utimes(writer.logPath, before.atime, before.mtime);
  await expect(readers[0]!.readSnapshot()).rejects.toThrow();
  await expect(writer.append([{ stream: "control", body: { text: "third" } }])).rejects.toThrow();
}, 20000);

it("checks newly materialized data and writes even when a filesystem reports unchanged metadata", async () => {
  const root = await createTempDir("verified-wal-coarse-clock");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  onTestFinished(() => log.stopStorageMaintenance());
  await log.append([{ stream: "control", body: { text: "original" } }]);
  await log.readSnapshot();
  const version = await verified.readWalVersion(log.logPath);
  const unchanged = vi.spyOn(verified, "readWalVersion").mockResolvedValue(version);
  try {
    const bytes = await readFile(log.logPath);
    bytes[bytes.indexOf(Buffer.from("original"))] ^= 1;
    await writeFile(log.logPath, bytes);
    await expect(log.readSnapshot()).rejects.toThrow();
    await expect(log.readProjection(0, state => state + 1)).rejects.toThrow();
    await expect(log.append([{ stream: "control", body: { text: "second" } }])).rejects.toThrow();
  } finally { unchanged.mockRestore(); }
}, 20000);

it("never turns a durable append into failure when optional view publication fails", async () => {
  const root = await createTempDir("verified-wal-publication");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  onTestFinished(() => log.stopStorageMaintenance());
  await log.append([{ stream: "control", body: { text: "first" } }]);
  await log.readSnapshot();
  const publish = vi.spyOn(verified.verifiedWalViews, "put").mockImplementationOnce(() => { throw Error("cache unavailable"); });
  try {
    await expect(log.append([{ stream: "control", body: { text: "second" } }])).resolves.toMatchObject({ lsn: 2 });
  } finally { publish.mockRestore(); }
  expect((await log.readSnapshot()).commits).toHaveLength(2);
}, 20000);

it("retains a bounded append proof after eviction but rejects damaged history", async () => {
  const root = await createTempDir("verified-wal-eviction");
  const events: LogDraft[] = [];
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")), {
    records: { record: draft => { events.push(typeof draft === "function" ? draft() : draft); } },
  });
  onTestFinished(() => log.stopStorageMaintenance());
  await log.append([{ stream: "control", body: { text: "original" } }]);
  await log.readSnapshot();
  await log.stopStorageMaintenance(); events.length = 0;
  verified.verifiedWalViews.delete(log.logPath);
  await expect(log.append([{ stream: "control", body: { text: "second" } }])).resolves.toMatchObject({ lsn: 2 });
  await log.stopStorageMaintenance();
  expect(events.filter(e => e.event === "work").reduce((n, e) => n + Number(e.data!.recoveries), 0)).toBe(0);
  const bytes = await readFile(log.logPath);
  bytes[bytes.indexOf(Buffer.from("original"))] ^= 1;
  await writeFile(log.logPath, bytes);
  await expect(log.append([{ stream: "control", body: { text: "third" } }])).rejects.toThrow();
}, 20000);

it("observes an append from a separate process and preserves the old cursor boundary", async () => {
  const root = await createTempDir("verified-wal-process");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  onTestFinished(() => log.stopStorageMaintenance());
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const first = await log.readProjection(0, state => state + 1);
  await promisify(execFile)(process.execPath, ["--import=tsx/esm", "--input-type=module", "-e", `
    import path from 'node:path';
    import { FileAuthorityCommitLog } from ${JSON.stringify(new URL("../commit-log.ts", import.meta.url).href)};
    import { FileArtifactStore } from ${JSON.stringify(new URL("../artifact-store.ts", import.meta.url).href)};
    const root = process.argv[1];
    const log = new FileAuthorityCommitLog(path.join(root, 'authority'), new FileArtifactStore(path.join(root, 'artifacts')));
    try { await log.append([{stream: 'control', body: {value: 2}}]); }
    finally { await log.stopStorageMaintenance(); }
  `, root], { timeout: 15000, windowsHide: true });
  expect(await log.readProjection(first.state, state => state + 1, { cursor: first.cursor })).toMatchObject({ state: 2, lastLsn: 2 });
  expect((await log.readStream<{ value: number }>("control")).map(r => r.body.value)).toEqual([1, 2]);
}, 20000);

// The optimization must preserve the public read contract, not just decoded data.
it.each([
  { format: "legacy", cached: false }, { format: "legacy", cached: true },
  { format: "versioned", cached: false }, { format: "versioned", cached: true },
])("preserves pagination and recovery with $format WAL, cached=$cached", async ({ format, cached }) => {
  const root = await createTempDir("verified-wal-read-contract");
  const authority = path.join(root, "authority");
  if (format === "legacy") {
    await mkdir(authority);
    await writeFile(path.join(authority, "authority.log"), Buffer.alloc(0));
  }
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(authority, artifacts);
  onTestFinished(() => log.stopStorageMaintenance());
  const read = async (checkpoint: DurableLogCheckpoint, limit: number) => {
    if (!cached) verified.verifiedWalViews.delete(log.logPath);
    return log.readTail(checkpoint, limit);
  };
  const origin = await log.originCheckpoint();
  await log.readSnapshot();
  expect(await read(origin, 1)).toEqual({ commits: [], checkpoint: origin, hasMore: false });
  for (let value = 1; value <= 3; value++) {
    await log.append([{ stream: "control", body: { value } }]);
  }
  const snapshot = await log.readSnapshot();
  const head = await log.checkpoint();
  const first = await read(origin, 1);
  expect(first.commits).toEqual(snapshot.commits.slice(0, 1));
  expect(first.hasMore).toBe(true);
  expect(await log.readEnvelopeAt(first.checkpoint)).toEqual(first.commits[0]);
  expect(await read(first.checkpoint, 2)).toEqual({
    commits: snapshot.commits.slice(1), checkpoint: head, hasMore: false,
  });
  expect(await read(origin, 256)).toEqual({ commits: snapshot.commits, checkpoint: head, hasMore: false });
  expect(await read(head, 1)).toEqual({ commits: [], checkpoint: head, hasMore: false });
  let cursor = origin;
  const pages = [];
  for (let count = 0; count < 4; count++) {
    const page = await read(cursor, 1);
    pages.push(page.commits.map(commit => commit.lsn));
    cursor = page.checkpoint;
    if (!page.hasMore) break;
  }
  expect(pages).toEqual([[1], [2], [3]]);

  const peer = new FileAuthorityCommitLog(authority, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  const fourth = await peer.append([{ stream: "control", body: { value: 4 } }]);
  const next = await read(head, 1);
  expect(next.commits).toEqual([fourth]);
  expect(next.hasMore).toBe(false);
  expect(await log.readEnvelopeAt(next.checkpoint)).toEqual(fourth);

  // An incomplete physical suffix invalidates the view. A full read recovers it;
  // stopping before it must keep a resumable cursor, then recover on the next page.
  await appendFile(log.logPath, Buffer.from([1]));
  const beforeRecovery = await read(next.checkpoint, 1);
  expect(beforeRecovery).toEqual({ commits: [], checkpoint: next.checkpoint, hasMore: false });
  expect((await stat(log.logPath)).size).toBe(next.checkpoint.frameEndOffset);
  await log.readSnapshot();
  await appendFile(log.logPath, Buffer.from([1]));
  const beforeSuffix = await read(head, 1);
  expect(beforeSuffix).toEqual({ commits: [fourth], checkpoint: next.checkpoint, hasMore: true });
  expect(await read(beforeSuffix.checkpoint, 1)).toEqual(beforeRecovery);
  const fifth = await log.append([{ stream: "control", body: { value: 5 } }]);
  expect((await read(next.checkpoint, 1)).commits).toEqual([fifth]);
}, 20000);

it.each([false, true])("lets pending I/O advance during projection replay, cached=%s", async cached => {
  const root = await createTempDir("verified-wal-replay-io");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  onTestFinished(() => log.stopStorageMaintenance());
  for (let value = 0; value < 24; value++) await log.append([{ stream: "control", body: { value } }]);
  await log.readSnapshot();
  const miss = cached ? undefined : vi.spyOn(verified.verifiedWalViews, "get").mockReturnValue(undefined);
  let pending: NodeJS.Immediate | undefined;
  let ioAdvanced = false;
  let observedDuringReplay = false;
  try {
    const state = await log.rebuildProjection(0, count => {
      if (count === 0) pending = setImmediate(() => { ioAdvanced = true; });
      observedDuringReplay ||= ioAdvanced;
      const end = performance.now() + 1;
      while (performance.now() < end) { /* Same bounded CPU slice as the physical scanner test. */ }
      return count + 1;
    });
    expect(state).toBe(24);
    expect(observedDuringReplay).toBe(true);
  } finally {
    if (pending) clearImmediate(pending);
    miss?.mockRestore();
  }
}, 20000);
