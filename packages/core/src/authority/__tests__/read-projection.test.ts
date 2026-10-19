import { expect, it, vi, onTestFinished } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { readFile, writeFile, rename, utimes, stat, appendFile, unlink, mkdir } from "node:fs/promises";
import { acquireFileLock, withFileLockProcessIdentity } from "../../persistence/file-lock.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
import { artifactJsonIndex } from "../artifact-json-index.js";
import { StorageMaintenanceAdmissionError } from "../../resources/index.js";
async function fixture() {
  const root = await createTempDir("read-projection");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
  onTestFinished(() => log.stopStorageMaintenance());
  return { log, artifacts };
}
it.each([false, true])('starts the bounded backpressure window after prior work, without renewing it (persistent=%s)', async persistent => {
  const { log } = await fixture();
  await log.checkpoint();
  const realNow = Date.now.bind(Date);
  let elapsed = 0, attempts = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + elapsed);
  const pressure = () => new StorageMaintenanceAdmissionError({ kind: 'backpressured', blockedBy: 'ioOperations', retryAfterMs: 1 });
  try {
    const operation = log.transactProjection(0, (state: number) => state + 1, () => {
      attempts++;
      // A real preparation page can take longer than the retry window before
      // its first transient failure; that work must not spend the wait budget.
      if (attempts === 1 || persistent) { elapsed += 6_000; throw pressure(); }
      return { kind: 'append' as const, entries: [{ stream: 'extensions', body: { value: 1 } }], value: 'accepted' };
    }, { stream: 'extensions' });
    if (persistent) await expect(operation).rejects.toBeInstanceOf(StorageMaintenanceAdmissionError);
    else expect((await operation).value).toBe('accepted');
    expect(attempts).toBe(2);
  } finally { clock.mockRestore(); }
  expect((await log.checkpoint()).lsn).toBe(persistent ? 0 : 1);
});
it('returns the indexed transaction prefix for a separately prepared finite projection', async () => {
  const { log } = await fixture();
  log.durableProjection<{ value: number }>({ projectionId: 'finite-view', reducerVersion: 1, inputs: { streams: ['extensions'] },
    reduce: envelope => envelope.entries.filter(entry => entry.stream === 'extensions').map(entry => ({ kind: 'put', key: 'value', value: entry.body.value })) });
  await log.append([{ stream: 'extensions', body: { value: 7 } }]);
  const basis = await log.transactDurableProjection('finite-view', async current => ({ kind: 'return', value: await current.get('value') }));
  expect(basis.cursor.lsn).toBe(1);
  const reduce = vi.fn((state: number, record: { body: { value: number } }) => state + record.body.value);
  const next = await log.transactProjection(basis.value as number, reduce,
    () => ({ kind: 'append', entries: [{ stream: 'extensions', body: { value: 2 } }], value: 'accepted' }),
    { stream: 'extensions', cursor: basis.cursor });
  expect(next.state).toBe(9); expect(reduce).toHaveBeenCalledOnce();
  const updated = await log.transactDurableProjection('finite-view', () => ({ kind: 'append', entries: [{ stream: 'extensions', body: { value: 11 } }], value: undefined }));
  expect(updated.cursor.lsn).toBe(updated.commit!.lsn);
});
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

it('keeps an independently verifiable boundary for every frame in a bounded tail page', async () => {
  const {log} = await fixture();
  const origin = await log.originCheckpoint();
  for (let value = 0; value < 4; value++) await log.append([{stream:'control',body:{value}}]);
  const page = await log.readTail(origin, 3);
  expect(page.checkpoints).toHaveLength(3);
  for (let index = 0; index < 3; index++) expect(await log.readEnvelopeAt(page.checkpoints[index]!)).toEqual(page.commits[index]);
  expect((await log.readTail(page.checkpoints[0]!, 3)).commits.map(e => e.lsn)).toEqual([2,3,4]);
});

it('limits projection source readers to their verified prefix and live reduction', async () => {
  const { log } = await fixture();
  let previous: import('../index.js').DurableLogCheckpoint | undefined;
  let escaped: import('../index.js').DurableProjectionSource['readEnvelopeAt'];
  const projection = log.durableProjection({ projectionId: 'test.scoped-replay-source', reducerVersion: 1,
    async reduce(envelope, _current, source) {
      const read = source.readEnvelopeAt!;
      if (previous) expect((await read(previous)).lsn).toBe(envelope.lsn - 1);
      expect((await read(source.checkpoint)).envelopeDigest).toBe(envelope.envelopeDigest);
      await expect(read({ ...source.checkpoint, lsn: envelope.lsn + 1 })).rejects.toThrow('outside');
      await expect(read({ ...source.checkpoint, prefixDigest: 'sha256:' + '0'.repeat(64) })).rejects.toThrow('bind');
      previous = source.checkpoint; escaped = read;
      return [{ kind: 'put', key: 'head', value: envelope.lsn }];
    } });
  await log.append([{ stream: 'control', body: { value: 1 } }]);
  await log.append([{ stream: 'control', body: { value: 2 } }]);
  expect(await projection.get('head')).toBe(2);
  await expect(escaped!(previous!)).rejects.toThrow('outside');
});

it.each(['legacy', 'versioned'] as const)('reads sparse verified envelope batches without separate writer turns: %s', async format => {
  const {log} = await fixture();
  if (format === 'legacy') { await mkdir(log.rootDir,{recursive:true}); await writeFile(log.logPath,Buffer.alloc(0)); }
  const origin = await log.originCheckpoint();
  for (let value=0;value<5;value++) await log.append([{stream:'control',body:{text:'original',value}}]);
  const page = await log.readTail<{text:string;value:number}>(origin,5);
  const checkpoints = [page.checkpoints[0]!,page.checkpoints[2]!,page.checkpoints[4]!];
  const single = vi.spyOn(log,'readEnvelopeAt').mockRejectedValue(Error('separate writer turn forbidden'));
  const selected = await log.readEnvelopesAt<{text:string;value:number}>(checkpoints);
  expect(selected.map(e=>e.lsn)).toEqual([1,3,5]);
  selected[0]!.entries[0]!.body.text='caller mutation';
  expect((await log.readEnvelopesAt<{text:string}>(checkpoints))[0]!.entries[0]!.body.text).toBe('original');
  expect(single).not.toHaveBeenCalled();
  await expect(log.readEnvelopesAt([{...checkpoints[0]!,prefixDigest:'sha256:'+'0'.repeat(64)}])).rejects.toThrow();
  await expect(log.readEnvelopesAt([{...checkpoints[0]!,logId:'another-log'}])).rejects.toThrow();
  await expect(log.readEnvelopesAt([{...checkpoints[0]!,frameEndOffset:checkpoints[0]!.frameEndOffset+1}])).rejects.toThrow();
  await expect(log.readEnvelopesAt([checkpoints[1]!,checkpoints[0]!])).rejects.toThrow();
  await expect(log.readEnvelopesAt(Array.from({length:65},(_,i)=>({...checkpoints[0]!,lsn:i+1})))).rejects.toThrow();
  const bytes=await readFile(log.logPath); bytes[bytes.indexOf(Buffer.from('original'),bytes.indexOf(Buffer.from('original'))+1)]^=1; await writeFile(log.logPath,bytes);
  await expect(log.readEnvelopesAt(checkpoints)).rejects.toThrow();
  single.mockRestore();
});

// Exercise the actual durable-index get used by conversation recovery, not readProjection.
it.each(["legacy", "versioned"] as const)("reuses a byte-proven durable index above the WAL view budget: %s", async format => {
  const { log, artifacts } = await fixture();
  if (format === "legacy") { await mkdir(log.rootDir, { recursive: true }); await writeFile(log.logPath, Buffer.alloc(0)); }
  await log.append(Array.from({ length: 300 }, (_, i) => ({ stream: "control", body: { marker: "large-proof-" + i, text: "x".repeat(30000) } })));
  const projection = log.durableProjection<{value:number}>({ projectionId: "test.large-recovery", reducerVersion: 1,
    reduce: commit => commit.entries.filter(e => e.stream === "extensions").map(e => ({ kind: "put" as const, key: "value", value: e.body.value })) });
  await log.append([{ stream: "extensions", body: { value: 1 } }]);
  expect(await projection.get("value")).toBe(1);
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(await projection.get("value")).toBe(1);
    expect(parse.mock.calls.some(([input]) => String(input).includes("large-proof-"))).toBe(false);
  } finally { parse.mockRestore(); }
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  await peer.append([{ stream: "extensions", body: { value: 2 } }]);
  expect(await projection.get("value")).toBe(2);
  const metadata = await stat(log.logPath);
  const bytes = await readFile(log.logPath);
  bytes[bytes.indexOf(Buffer.from("large-proof-299"))] ^= 1;
  await writeFile(log.logPath, bytes); await utimes(log.logPath, metadata.atime, metadata.mtime);
  await expect(projection.get("value")).rejects.toThrow();
}, 30000);
