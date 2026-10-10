import { expect, it, vi, onTestFinished } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { readFile, writeFile, rename, utimes, stat, appendFile, unlink, mkdir } from "node:fs/promises";
import { acquireFileLock, withFileLockProcessIdentity } from "../../persistence/file-lock.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
import { artifactJsonIndex } from "../artifact-json-index.js";
async function fixture() {
  const root = await createTempDir("read-projection");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
  onTestFinished(() => log.stopStorageMaintenance());
  return { log, artifacts };
}
it('retains the Authority and artifact platform owner for later requests from another async root', async () => {
  const read = vi.fn(async () => ({ kind: 'present' as const, birth: 'resource-owner' }));
  const { log, artifacts } = await withFileLockProcessIdentity({ read }, fixture);
  const foreign = { read: async () => { throw Error('foreign platform port used'); } };
  await withFileLockProcessIdentity(foreign, async () => {
    const ref = await artifacts.put(Buffer.from('{"text":"owned artifact"}'));
    await log.append([{ stream: 'control', body: { ref } }]);
    expect((await log.readSnapshot()).commits).toHaveLength(1);
    expect(await artifactJsonIndex(artifacts).prepare(ref)).toMatchObject({ ready: true });
  });
  expect(read).toHaveBeenCalled();
});
it("omits decoding proven unrelated streams but includes mixed commits and independent results", async () => {
  const { log, artifacts } = await fixture();
  await log.append([{ stream: "control", body: { marker: "unrelated-proof-payload" } }]);
  await log.append([{ stream: "extensions", body: { value: 1 } }, { stream: "control", body: { value: 2 } }]);
  await log.readSnapshot(); // Validate all physical bytes before sharing only their proofs.
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  const parse = vi.spyOn(JSON, "parse");
  try {
    const records = await peer.readStream<{ value: number }>("extensions");
    expect(records.map(record => record.body.value)).toEqual([1]);
    expect(parse.mock.calls.some(([input]) => String(input).includes("unrelated-proof-payload"))).toBe(false);
    records[0]!.body.value = 999;
    expect((await log.readStream<{ value: number }>("extensions"))[0]!.body.value).toBe(1);
  } finally { parse.mockRestore(); }
});

it("still validates corrupted unrelated streams and advances filtered projection cursors", async () => {
  const { log, artifacts } = await fixture();
  await log.append([{ stream: "extensions", body: { value: 1 } }]);
  const first = await log.readProjection(0, state => state + 1, { stream: "extensions" });
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  await peer.append([{ stream: "control", body: { marker: "original-filtered-payload" } }]);
  const next = await log.readProjection(first.state, state => state + 1, { stream: "extensions", cursor: first.cursor });
  expect(next).toMatchObject({ state: 1, lastLsn: 2 });
  expect(await log.rebuildProjection(0, state => state + 1, { stream: "extensions" })).toBe(1);
  const bytes = await readFile(log.logPath);
  bytes[bytes.indexOf(Buffer.from("original-filtered-payload"))] ^= 1;
  await writeFile(log.logPath, bytes);
  await expect(log.readStream("extensions")).rejects.toThrow();
  await expect(log.readProjection(0, state => state + 1, { stream: "extensions" })).rejects.toThrow();
});

it("reads an unchanged durable projection without a writer claim and sees the next peer commit", async () => {
  const { log, artifacts } = await fixture();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const reduce = (state: number) => state + 1;
  const first = await log.readProjection(0, reduce, { stream: "control" });
  const transact = vi.spyOn(log, "transactProjection");
  const release = await acquireFileLock(path.join(log.rootDir, ".commit-log.lock"), { staleMs: 30_000, waitMs: 100 });
  try {
    expect(await log.readProjection(first.state, reduce, { stream: "control", cursor: first.cursor })).toMatchObject({ state: 1, lastLsn: 1 });
    expect(transact).not.toHaveBeenCalled();
  } finally { await release(); }
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  await peer.append([{ stream: "control", body: { value: 2 } }]);
  const next = await log.readProjection(first.state, reduce, { stream: "control", cursor: first.cursor });
  expect(next).toMatchObject({ state: 2, lastLsn: 2 });
  expect(transact).toHaveBeenCalledOnce();
  await log.append([{ stream: "control", body: { value: 3 } }]);
  expect(await log.readProjection(next.state, reduce, { stream: "control", cursor: next.cursor })).toMatchObject({ state: 3, lastLsn: 3 });
});
it.each(["corrupt", "replacement", "missing", "partial"])("read-only projection never trusts changed %s bytes", async mode => {
  const { log } = await fixture();
  await log.append([{ stream: "control", body: { text: "original" } }]);
  const first = await log.readProjection(0, state => state + 1);
  const transact = vi.spyOn(log, "transactProjection");
  const metadata = await stat(log.logPath);
  if (mode === "partial") await appendFile(log.logPath, Buffer.from([1, 2, 3]));
  else if (mode === "missing") await unlink(log.logPath);
  else {
    const bytes = await readFile(log.logPath);
    bytes[bytes.indexOf(Buffer.from("original"))] ^= 1;
    if (mode === "replacement") {
      await writeFile(log.logPath + ".replacement", bytes);
      await rename(log.logPath + ".replacement", log.logPath);
    } else await writeFile(log.logPath, bytes);
    await utimes(log.logPath, metadata.atime, metadata.mtime);
  }
  const read = log.readProjection(first.state, state => state + 1, { cursor: first.cursor });
  if (mode === "partial") await expect(read).resolves.toMatchObject({ state: 1, lastLsn: 1 });
  else await expect(read).rejects.toBeInstanceOf(Error);
  expect(transact).toHaveBeenCalledOnce();
});

it.each(["legacy", "versioned"])("validates the entire %s prefix after append without replaying it into the reducer", async format => {
  const { log, artifacts } = await fixture();
  if (format === "legacy") {
    await mkdir(log.rootDir, { recursive: true });
    await writeFile(log.logPath, Buffer.alloc(0));
  }
  await log.append([{ stream: "control", body: { text: "original" } }]);
  const reduce = vi.fn((state: number) => state + 1);
  const first = await log.readProjection(0, reduce);
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  await peer.append([{ stream: "control", body: { text: "second" } }]);
  reduce.mockClear();
  const second = await log.readProjection(first.state, reduce, { cursor: first.cursor });
  expect(second.state).toBe(2);
  expect(reduce).toHaveBeenCalledOnce();
  await peer.append([{ stream: "control", body: { text: "third" } }]);
  const bytes = await readFile(log.logPath);
  Buffer.from("modified").copy(bytes, bytes.indexOf(Buffer.from("original")));
  await writeFile(log.logPath, bytes);
  await expect(log.readProjection(second.state, reduce, { cursor: second.cursor })).rejects.toThrow();
});

it("does not extend a byte proof over a changed prefix when this instance appends", async () => {
  const { log } = await fixture();
  await log.append([{ stream: "control", body: { text: "original" } }]);
  const first = await log.readProjection(0, state => state + 1);
  await log.append([{ stream: "control", body: { text: "second" } }]);
  const bytes = await readFile(log.logPath);
  Buffer.from("modified").copy(bytes, bytes.indexOf(Buffer.from("original")));
  await writeFile(log.logPath, bytes);
  await expect(log.readProjection(first.state, state => state + 1, { cursor: first.cursor })).rejects.toThrow();
});

it("keeps caller mutations out of peer reads that reuse byte validation proofs", async () => {
  const { log, artifacts } = await fixture();
  await log.append([{ stream: "control", body: { text: "original" } }]);
  const first = await log.readStream<{ text: string }>("control");
  first[0]!.body.text = "caller mutation";
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  expect((await peer.readStream<{ text: string }>("control"))[0]!.body.text).toBe("original");
  const bytes = await readFile(log.logPath);
  Buffer.from("modified").copy(bytes, bytes.indexOf(Buffer.from("original")));
  await writeFile(log.logPath, bytes);
  await expect(peer.readStream("control")).rejects.toThrow();
});

it("checks bytes beyond the first read window before accepting an appended tail", async () => {
  const { log, artifacts } = await fixture();
  for (let index = 0; index < 5; index++) {
    await log.append([{ stream: "control", body: { text: "x".repeat(20_000), marker: `record-${index}` } }]);
  }
  const first = await log.readProjection(0, state => state + 1);
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  await peer.append([{ stream: "control", body: { text: "tail" } }]);
  const bytes = await readFile(log.logPath);
  const offset = bytes.indexOf(Buffer.from("record-4"));
  expect(offset).toBeGreaterThan(64 * 1024);
  bytes[offset] ^= 1;
  await writeFile(log.logPath, bytes);
  await expect(log.readProjection(first.state, state => state + 1, { cursor: first.cursor })).rejects.toThrow();
});
