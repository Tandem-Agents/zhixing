import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { canonicalize, protocolDigest } from "../../protocol/canonical.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
import { AuthorityCacheIntegrity, frameIndexMac } from "../startup-proofs.js";
import { AuthenticatedFrameIndex, frameStreamTag, frameStreamBloomMask } from "../frame-index.js";
import * as frames from "../wal-frame.js";
import { verifiedWalViews } from "../verified-wal-view.js";
import type { DurableLogCheckpoint } from "../interfaces.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 91));
const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function open(root: string, options: { readOnly?: boolean; key?: AuthorityCacheIntegrity | null; strict?: boolean } = {}) {
  const directory = path.join(root, "authority");
  verifiedWalViews.delete(path.join(directory, "authority.log"));
  const log = new FileAuthorityCommitLog(directory, new FileArtifactStore(path.join(root, "artifacts")), {
    integrity: options.key === null ? undefined : options.key ?? integrity,
    readOnly: options.readOnly, owner: options.readOnly ? false : undefined,
    startupProofs: !options.strict, lockSessionLingerMs: 0,
  });
  logs.push(log); return log;
}
async function fixture(count: number, format: "legacy" | "versioned" = "legacy", textBytes = 128) {
  const root = await createTempDir("b3-legacy-proof"), directory = path.join(root, "authority");
  await fs.mkdir(directory);
  const logIdBytes = Buffer.alloc(32, 37), logId = logIdBytes.toString("base64url");
  const chunks: Buffer[] = format === "versioned" ? [frames.encodeAuthorityWalFileHeader(logIdBytes)] : [];
  let end = format === "versioned" ? frames.AUTHORITY_WAL_FILE_HEADER_BYTES : 0;
  let prefix = protocolDigest("AuthorityLogPrefix", 1, { logId });
  const checkpoints: DurableLogCheckpoint[] = [{ logId, lsn: 0, frameEndOffset: end, prefixDigest: prefix }];
  for (let lsn = 1; lsn <= count; lsn++) {
    const body = { b3Fixture: true, n: lsn, text: "x".repeat(textBytes) };
    const entries = lsn % 3 === 0 ? [{ stream: "run:fixture", body }]
      : lsn % 3 === 1 ? [{ stream: "control", body }]
      : [{ stream: "control", body }, { stream: "governor", body }];
    const unsigned = { v: 1, lsn, at: "2026-10-17T00:00:00.000Z", entries };
    const envelope = { ...unsigned, envelopeDigest: protocolDigest("CommitEnvelope", 1, unsigned) };
    prefix = protocolDigest("AuthorityLogPrefix", 1, { logId, previousDigest: prefix, lsn, envelopeDigest: envelope.envelopeDigest });
    const frame = frames.encodeAuthorityWalFrame(Buffer.from(canonicalize(envelope)), format === "versioned" ? { lsn, prefixDigest: prefix } : undefined);
    chunks.push(frame); end += frame.length;
    checkpoints.push({ logId, lsn, frameEndOffset: end, prefixDigest: prefix });
  }
  const bytes = Buffer.concat(chunks), wal = path.join(directory, "authority.log");
  await fs.writeFile(wal, bytes);
  if (format === "legacy") await fs.writeFile(path.join(directory, "authority.log.identity"), frames.encodeAuthorityWalFileHeader(logIdBytes));
  return { root, directory, wal, bytes, checkpoints, logId, logIdBytes };
}
function observeScans() {
  const sizes: number[] = [], original = frames.scanAuthorityWalFrames;
  vi.spyOn(frames, "scanAuthorityWalFrames").mockImplementation((reader, ...rest) => {
    sizes.push(reader.size); return original(reader, ...rest);
  });
  return sizes;
}
async function fingerprint(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(entries.map(async e => {
    const file = path.join(e.parentPath, e.name);
    return path.relative(root, file) + ":" + (e.isDirectory() ? "directory" : hash(await fs.readFile(file)));
  })).then(rows => rows.sort());
}

it("builds legacy proofs once, then opens and materializes a fixed tail at two history sizes", async () => {
  const work = [];
  for (const count of [512, 4096]) {
    const f = await fixture(count, "legacy", 1024), scans = observeScans();
    const first = open(f.root);
    expect(await first.checkpoint()).toEqual(f.checkpoints[count]);
    expect(scans[0]).toBe(f.bytes.length);
    await first.stopStorageMaintenance(); vi.restoreAllMocks();
    expect(hash(await fs.readFile(f.wal))).toBe(hash(f.bytes));
    const coldScans = observeScans(), rows = vi.spyOn(AuthenticatedFrameIndex.prototype, "row");
    let materialized = 0;
    const original = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes('"b3Fixture":true')) materialized++;
      return original(text, reviver);
    });
    const cold = open(f.root);
    expect(await cold.checkpoint()).toEqual(f.checkpoints[count]);
    const tail = await cold.readTail(f.checkpoints[count - 3]!, 3);
    expect(tail.commits.map(c => c.lsn)).toEqual([count - 2, count - 1, count]);
    expect(coldScans).toEqual([0]);
    expect(materialized).toBe(4); // One authenticated head plus three requested envelopes.
    expect(rows.mock.calls.length).toBeLessThanOrEqual(10);
    work.push({ count, initialWalBytes: f.bytes.length, laterScannedBytes: coldScans.reduce((a, b) => a + b, 0), materialized, rowLookups: rows.mock.calls.length });
    await cold.stopStorageMaintenance(); vi.restoreAllMocks();
    expect(await fs.readFile(f.wal)).toEqual(f.bytes);
  }
  console.info("B3 legacy cold work " + JSON.stringify(work));
}, 90_000);

it("retains single-stream and multi-stream Bloom selection with the legacy format bit", async () => {
  const f = await fixture(310), first = open(f.root);
  await first.checkpoint(); await first.stopStorageMaintenance();
  const log = open(f.root), all = Array.from({ length: 310 }, (_, i) => i + 1);
  expect((await log.readStream<{ n: number }>("control")).map(r => r.body.n)).toEqual(all.filter(n => n % 3 !== 0));
  expect((await log.readStream<{ n: number }>("governor")).map(r => r.body.n)).toEqual(all.filter(n => n % 3 === 2));
  expect((await log.readStream<{ n: number }>("run:fixture")).map(r => r.body.n)).toEqual(all.filter(n => n % 3 === 0));
  const combined = frameStreamBloomMask("control") | frameStreamBloomMask("governor");
  let absent = "run:absent", suffix = 0;
  while ((combined & frameStreamBloomMask(absent)) === frameStreamBloomMask(absent)) absent = "run:absent-" + ++suffix;
  let materialized = 0;
  const original = JSON.parse, parsing = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (typeof text === "string" && text.includes('"b3Fixture":true')) materialized++;
    return original(text, reviver);
  });
  try { expect(await log.readStream(absent)).toEqual([]); expect(materialized).toBe(0); }
  finally { parsing.mockRestore(); }
  expect((await log.readSnapshot()).commits).toHaveLength(310);
}, 45_000);

it("extends only a strict legacy writer's new tail, without rewriting the old WAL prefix", async () => {
  const f = await fixture(270), initial = open(f.root);
  await initial.checkpoint(); await initial.stopStorageMaintenance();
  const existing = open(f.root); await existing.checkpoint();
  const oldWriter = open(f.root, { strict: true });
  for (let n = 271; n <= 273; n++) await oldWriter.append([{ stream: "control", body: { b3Fixture: true, n } }]);
  await oldWriter.stopStorageMaintenance();
  const bytes = await fs.readFile(f.wal); expect(bytes.subarray(0, f.bytes.length)).toEqual(f.bytes);
  const scans = observeScans();
  expect((await existing.checkpoint()).lsn).toBe(273);
  expect(scans).toEqual([bytes.length - f.bytes.length]);
  await existing.stopStorageMaintenance(); vi.restoreAllMocks();
  const coldScans = observeScans(), cold = open(f.root);
  expect((await cold.checkpoint()).lsn).toBe(273); expect(coldScans).toEqual([0]);
  expect((await cold.readTail(f.checkpoints[270]!, 3)).commits.map(c => c.lsn)).toEqual([271, 272, 273]);
  for (let at = 0; at < bytes.length;) {
    const frame = frames.decodeAuthorityWalFrame(bytes, at); expect(frame.kind).toBe("complete");
    if (frame.kind !== "complete") throw Error("incomplete fixture");
    expect(frame.metadata).toBeUndefined(); at = frame.nextOffset;
  }
}, 45_000);

it.each(["sidecar", "replacement", "truncation"].flatMap(kind => [false, true].map(cold => ({ kind, cold }))))("invalidates legacy proof after $kind (cold=$cold) and persists the rebuilt epoch", async ({ kind, cold }) => {
  const f = await fixture(270), first = open(f.root);
  await first.checkpoint(); await first.stopStorageMaintenance();
  let existing = open(f.root); await existing.checkpoint();
  if (cold) await existing.stopStorageMaintenance();
  if (kind === "sidecar") await fs.writeFile(path.join(f.directory, "authority.log.identity"), frames.encodeAuthorityWalFileHeader(Buffer.alloc(32, 38)));
  if (kind === "replacement") { await fs.rename(f.wal, f.wal + ".saved"); await fs.writeFile(f.wal, f.bytes); }
  if (kind === "truncation") await fs.truncate(f.wal, f.checkpoints[269]!.frameEndOffset);
  if (cold) existing = open(f.root);
  const scans = observeScans(), result = await existing.checkpoint();
  expect(result.lsn).toBe(kind === "truncation" ? 269 : 270);
  expect(scans.some(size => size > f.bytes.length * 0.95)).toBe(true);
  if (kind === "sidecar") await expect(existing.readEnvelopeAt(f.checkpoints[1]!)).rejects.toThrow(/another log/u);
  await existing.stopStorageMaintenance(); vi.restoreAllMocks();
  const secondScans = observeScans(); expect(await open(f.root).checkpoint()).toEqual(result); expect(secondScans).toEqual([0]);
}, 45_000);

it("measures an old writer's tail beyond K as new work and seals it before a new writer appends", async () => {
  const small = await fixture(512), longer = await fixture(812), first = open(small.root);
  await first.checkpoint(); await first.stopStorageMaintenance();
  expect(longer.bytes.subarray(0, small.bytes.length)).toEqual(small.bytes);
  const suffix = longer.bytes.subarray(small.bytes.length); await fs.appendFile(small.wal, suffix);
  const scans = observeScans(), reader = open(small.root);
  expect((await reader.checkpoint()).lsn).toBe(812); expect(scans).toEqual([suffix.length]);
  expect((await reader.append([{ stream: "control", body: { b3Fixture: true, n: 813 } }])).lsn).toBe(813);
  await reader.stopStorageMaintenance(); vi.restoreAllMocks();
  const later = observeScans(); expect((await open(small.root).checkpoint()).lsn).toBe(813); expect(later).toEqual([0]);
  expect((await fs.readFile(small.wal)).subarray(0, small.bytes.length)).toEqual(small.bytes);
}, 45_000);

it("refuses incomplete legacy tails in read-only mode and lets the owner quarantine only the new suffix", async () => {
  const f = await fixture(270), longer = await fixture(271), writer = open(f.root);
  await writer.checkpoint(); await writer.stopStorageMaintenance();
  const incomplete = longer.bytes.subarray(f.bytes.length, longer.bytes.length - 5);
  await fs.appendFile(f.wal, incomplete);
  const before = await fingerprint(f.root), scans = observeScans(), readonly = open(f.root, { readOnly: true });
  await expect(readonly.checkpoint()).rejects.toThrow(/incomplete tail/);
  await readonly.stopStorageMaintenance(); expect(await fingerprint(f.root)).toEqual(before);
  const owner = open(f.root); expect(await owner.checkpoint()).toEqual(f.checkpoints[270]); await owner.stopStorageMaintenance();
  expect(await fs.readFile(f.wal)).toEqual(f.bytes);
  expect(scans.every(size => size === incomplete.length)).toBe(true);
  const names = await fs.readdir(owner.quarantineDir);
  expect(names).toHaveLength(1); expect(await fs.readFile(path.join(owner.quarantineDir, names[0]!))).toEqual(incomplete);
});

it.each(["same-key", "no-key", "different-key", "no-seal", "no-sidecar"] as const)("keeps legacy read-only access strictly non-mutating (%s)", async kind => {
  const f = await fixture(270), first = open(f.root); await first.checkpoint(); await first.stopStorageMaintenance();
  if (kind === "no-seal") await fs.unlink(path.join(f.directory, "frame-index-v1.seal"));
  if (kind === "no-sidecar") await fs.unlink(path.join(f.directory, "authority.log.identity"));
  const before = await fingerprint(f.root), scans = observeScans();
  const reader = open(f.root, { readOnly: true, key: kind === "no-key" ? null : kind === "different-key" ? new AuthorityCacheIntegrity(Buffer.alloc(32, 92)) : integrity });
  expect((await reader.checkpoint()).lsn).toBe(270);
  expect((await reader.readStream("governor")).length).toBe(90);
  if (kind === "same-key") expect(scans).toEqual([0]);
  else expect(scans.some(size => size === f.bytes.length)).toBe(true);
  await reader.stopStorageMaintenance();
  expect(await fingerprint(f.root)).toEqual(before);
}, 45_000);

it.each(["header", "payload", "trailer"] as const)("rejects changed legacy historical %s on exact read and audit", async part => {
  const f = await fixture(270), first = open(f.root); await first.checkpoint(); await first.stopStorageMaintenance();
  const bytes = Buffer.from(f.bytes), start = f.checkpoints[9]!.frameEndOffset, end = f.checkpoints[10]!.frameEndOffset;
  const at = part === "header" ? start : part === "trailer" ? end - frames.AUTHORITY_WAL_LEGACY_TRAILER_BYTES : bytes.indexOf(Buffer.from('"text":"x'), start) + 8;
  bytes[at] = bytes[at]! ^ 1; await fs.writeFile(f.wal, bytes);
  const reader = open(f.root); expect((await reader.checkpoint()).lsn).toBe(270);
  await expect(reader.readEnvelopeAt(f.checkpoints[10]!)).rejects.toThrow();
  await expect(reader.auditFrameIndex()).rejects.toThrow();
  await expect(reader.checkpoint()).rejects.toThrow();
}, 45_000);

it.each(["rows", "seal", "key"] as const)("rebuilds corrupt or incompatible legacy cache (%s), then really reuses the new publication", async kind => {
  const f = await fixture(512), first = open(f.root); await first.checkpoint(); await first.stopStorageMaintenance();
  if (kind !== "key") {
    const file = path.join(f.directory, "frame-index-v1." + kind), bytes = await fs.readFile(file);
    bytes[kind === "rows" ? 64 + 9 : bytes.length - 1] ^= 1; await fs.writeFile(file, bytes);
  }
  const key = kind === "key" ? new AuthorityCacheIntegrity(Buffer.alloc(32, 93)) : integrity;
  const scans = observeScans(), reader = open(f.root, { key });
  expect((await reader.readEnvelopeAt(f.checkpoints[10]!)).lsn).toBe(10);
  expect(scans.some(size => size === f.bytes.length)).toBe(true);
  await reader.stopStorageMaintenance(); vi.restoreAllMocks();
  const later = observeScans(); expect((await open(f.root, { key }).checkpoint()).lsn).toBe(512); expect(later).toEqual([0]);
}, 45_000);

it.each(["rows", "seal"] as const)("propagates %s I/O failures rather than treating them as absent cache", async suffix => {
  const f = await fixture(512), first = open(f.root); await first.checkpoint(); await first.stopStorageMaintenance();
  const scans = observeScans(), original = fs.open;
  const failure = Object.assign(new Error("synthetic cache I/O error"), { code: "EIO" });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("frame-index-v1." + suffix)) throw failure;
    return original(...args);
  });
  await expect(open(f.root).checkpoint()).rejects.toBe(failure); expect(scans).toEqual([]);
}, 30_000);

it("does not discard a valid legacy head proof to accept a rehashed in-place authority mutation", async () => {
  const f = await fixture(3), first = open(f.root); await first.checkpoint(); await first.stopStorageMaintenance();
  const start = f.checkpoints[2]!.frameEndOffset, last = frames.decodeAuthorityWalFrame(f.bytes, start);
  if (last.kind !== "complete") throw Error("fixture");
  const parsed = JSON.parse(last.payload.toString("utf8")); parsed.entries[0].body.text = "y".repeat(128);
  const { envelopeDigest: _digest, ...unsigned } = parsed;
  const payload = Buffer.from(canonicalize({ ...unsigned, envelopeDigest: protocolDigest("CommitEnvelope", 1, unsigned) }));
  const changed = Buffer.concat([f.bytes.subarray(0, start), frames.encodeAuthorityWalFrame(payload)]);
  expect(changed.length).toBe(f.bytes.length); await fs.writeFile(f.wal, changed);
  const sealPath = path.join(f.directory, "frame-index-v1.seal"), seal = await fs.readFile(sealPath);
  const scans = observeScans(), reader = open(f.root);
  await expect(reader.checkpoint()).rejects.toThrow(/does not match its authenticated index/);
  expect(scans).toEqual([]); await reader.stopStorageMaintenance();
  expect(await fs.readFile(sealPath)).toEqual(seal);
});

it("checks the legacy envelope LSN even when a malformed producer authenticated its payload digest", async () => {
  const f = await fixture(3), first = open(f.root); await first.checkpoint(); await first.stopStorageMaintenance();
  const start = f.checkpoints[2]!.frameEndOffset, last = frames.decodeAuthorityWalFrame(f.bytes, start);
  if (last.kind !== "complete") throw Error("fixture");
  const { envelopeDigest: _digest, ...unsigned } = JSON.parse(last.payload.toString("utf8")); unsigned.lsn = 4;
  const payload = Buffer.from(canonicalize({ ...unsigned, envelopeDigest: protocolDigest("CommitEnvelope", 1, unsigned) }));
  const changed = Buffer.concat([f.bytes.subarray(0, start), frames.encodeAuthorityWalFrame(payload)]);
  expect(changed.length).toBe(f.bytes.length); await fs.writeFile(f.wal, changed);
  const file = path.join(f.directory, "frame-index-v1.seal"), seal = await fs.readFile(file), body = Buffer.from(seal.subarray(0, -32));
  createHash("sha256").update(payload).digest().copy(body, 112 + 2 * 88 + 24);
  await fs.writeFile(file, Buffer.concat([body, frameIndexMac("frame-index-seal", [body], integrity)!]));
  await expect(open(f.root).checkpoint()).rejects.toThrow(/envelope LSN/);
});

it.each(["canonical", "digest", "lsn", "frame-format"] as const)("refuses invalid legacy source %s before certifying it", async kind => {
  const f = await fixture(3), start = f.checkpoints[2]!.frameEndOffset, last = frames.decodeAuthorityWalFrame(f.bytes, start);
  if (last.kind !== "complete") throw Error("fixture");
  let payload = last.payload;
  if (kind === "canonical") payload = Buffer.concat([payload, Buffer.from(" ")]);
  if (kind === "digest") { payload = Buffer.from(payload); const at = payload.indexOf(Buffer.from('"text":"x')) + 8; payload[at] ^= 1; }
  if (kind === "lsn") {
    const { envelopeDigest: _digest, ...unsigned } = JSON.parse(payload.toString("utf8")); unsigned.lsn = 9;
    payload = Buffer.from(canonicalize({ ...unsigned, envelopeDigest: protocolDigest("CommitEnvelope", 1, unsigned) }));
  }
  const changed = Buffer.concat([f.bytes.subarray(0, start), frames.encodeAuthorityWalFrame(payload,
    kind === "frame-format" ? { lsn: 3, prefixDigest: f.checkpoints[3]!.prefixDigest } : undefined)]);
  await fs.writeFile(f.wal, changed);
  await expect(open(f.root).checkpoint()).rejects.toThrow();
  expect(await fs.readFile(f.wal)).toEqual(changed);
});

it("reads an independently encoded pre-B3 FORMAT=2 versioned seal without rebuilding or rewriting it", async () => {
  const f = await fixture(1, "versioned"), cp = f.checkpoints[1]!, physical = frames.decodeAuthorityWalFrame(f.bytes, 72);
  if (physical.kind !== "complete") throw Error("bad fixture");
  const fixed = Buffer.alloc(112), row = Buffer.alloc(88);
  fixed.write("ZXFS"); fixed.writeUInt16BE(2, 4); f.logIdBytes.copy(fixed, 8); Buffer.alloc(16, 14).copy(fixed, 40);
  fixed.writeUInt32BE(1, 60); fixed.writeBigUInt64BE(1n, 64); fixed.writeBigUInt64BE(BigInt(cp.frameEndOffset), 72);
  Buffer.from(cp.prefixDigest.slice(7), "hex").copy(fixed, 80);
  row.writeBigUInt64BE(BigInt(cp.frameEndOffset)); row.writeUInt32BE(physical.payload.length, 8); row[12] = 1;
  row.writeBigUInt64BE(frameStreamTag("control"), 16); createHash("sha256").update(physical.payload).digest().copy(row, 24);
  Buffer.from(cp.prefixDigest.slice(7), "hex").copy(row, 56);
  const body = Buffer.concat([fixed, row]), seal = Buffer.concat([body, frameIndexMac("frame-index-seal", [body], integrity)!]);
  const file = path.join(f.directory, "frame-index-v1.seal"); await fs.writeFile(file, seal);
  const scans = observeScans(), reader = open(f.root);
  expect(await reader.checkpoint()).toEqual(cp); expect(scans).toEqual([0]);
  expect((await reader.readEnvelopeAt(cp)).lsn).toBe(1); await reader.stopStorageMaintenance();
  expect(await fs.readFile(file)).toEqual(seal); expect(await fs.readFile(f.wal)).toEqual(f.bytes);
});
