import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TERMINAL_CHUNK_TABLE_MIN_BYTES, verifyTerminalChunkTables } from "./terminal-chunk-check.mjs";

const MIB = 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
// 大于阈值的制品（必须有表），每 4 KiB 一个不同字节：任何错块都会让摘要失配
const content = Buffer.alloc(TERMINAL_CHUNK_TABLE_MIN_BYTES + 3 * MIB + 7);
for (let i = 0; i < content.length; i += 4096) content[i] = (i / 4096) & 0xff;
const artifact = { name: "ui.exe", bytes: content.length, sha256: digest(content) };
const chunkBytes = 8 * MIB;
const table = () => ({
  format: "zhixing-terminal-chunks/1", algorithm: "sha256", asset: "ui.exe", bytes: artifact.bytes, sha256: artifact.sha256, chunkBytes,
  chunks: Array.from({ length: Math.ceil(content.length / chunkBytes) }, (_, index) => {
    const offset = index * chunkBytes, length = Math.min(chunkBytes, content.length - offset);
    return { index, offset, length, sha256: digest(content.subarray(offset, offset + length)) };
  }),
});
const check = (manifest, bytes = content) => verifyTerminalChunkTables("win32-x64", manifest, async () => bytes);

test("accepts a chunk table derived from the packaged bytes", async () => {
  await check({ artifacts: [artifact], chunkTables: [table()] });
});

test("rejects every kind of bad chunk table and a large artifact without one", async () => {
  const tampered = Buffer.from(content); tampered[2 * chunkBytes + 4096] ^= 1;
  const cases = {
    "missing table": [{ artifacts: [artifact] }],
    "tampered chunk digest": [{ artifacts: [artifact], chunkTables: [{ ...table(), chunks: table().chunks.map((chunk, i) => i === 1 ? { ...chunk, sha256: "0".repeat(64) } : chunk) }] }],
    "shifted offset": [{ artifacts: [artifact], chunkTables: [{ ...table(), chunks: table().chunks.map((chunk, i) => i === 2 ? { ...chunk, offset: chunk.offset + 1 } : chunk) }] }],
    "missing last chunk": [{ artifacts: [artifact], chunkTables: [{ ...table(), chunks: table().chunks.slice(0, -1) }] }],
    "unknown format": [{ artifacts: [artifact], chunkTables: [{ ...table(), format: "zhixing-terminal-chunks/2" }] }],
    "unknown algorithm": [{ artifacts: [artifact], chunkTables: [{ ...table(), algorithm: "sha512" }] }],
    "duplicate table": [{ artifacts: [artifact], chunkTables: [table(), table()] }],
    "different whole-file digest": [{ artifacts: [artifact], chunkTables: [{ ...table(), sha256: "1".repeat(64) }] }],
    "asset outside the manifest": [{ artifacts: [artifact], chunkTables: [{ ...table(), asset: "other.exe" }] }],
    "packaged bytes differ from the table": [{ artifacts: [artifact], chunkTables: [table()] }, tampered],
    "not a list": [{ artifacts: [artifact], chunkTables: {} }],
  };
  for (const [name, [manifest, bytes]] of Object.entries(cases)) {
    await assert.rejects(check(manifest, bytes), /块表|第 \d+ 块/u, name);
  }
});
