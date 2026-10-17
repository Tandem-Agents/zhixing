import { expect, it } from "vitest";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity, frameIndexMac } from "../startup-proofs.js";
import { AuthenticatedFrameIndex, decodeFrameIndexRow, frameIndexRowStreams, FRAME_INDEX_ROW_BYTES } from "../frame-index.js";
import { AUTHORITY_WAL_MAX_PAYLOAD_BYTES } from "../wal-frame.js";

function row(legacy: boolean, streams: number) {
  const value = Buffer.alloc(88);
  value.writeBigUInt64BE(BigInt(16 + 20 + (legacy ? 12 : 84)));
  value.writeUInt32BE(20, 8); value[12] = (legacy ? 4 : 0) | streams;
  if (streams) value.writeBigUInt64BE(123n, 16);
  return value;
}
it.each([false, true])("keeps FORMAT=2 stream bits and derives real payload offsets (legacy=%s)", legacy => {
  for (const streams of [0, 1, 2]) {
    const bytes = row(legacy, streams), decoded = decodeFrameIndexRow(bytes, 1);
    expect(decoded.format).toBe(legacy ? "legacy" : "versioned");
    expect(decoded.payloadOffset).toBe(16);
    expect(frameIndexRowStreams(bytes)).toEqual(streams === 1 ? { streamTag: 123n } : streams === 2 ? { streamBloom: 123n } : undefined);
  }
});
it.each([3, 7, 8, 128, 255])("rejects mixed or unknown row flags %s even during stream filtering", flags => {
  const bytes = row(false, 1); bytes[12] = flags;
  expect(() => decodeFrameIndexRow(bytes, 1)).toThrow(/flags/);
  expect(() => frameIndexRowStreams(bytes)).toThrow(/flags/);
});
it("rejects reserved bytes, unsafe offsets, invalid lengths and LSNs", () => {
  for (const at of [13, 14, 15]) { const bytes = row(true, 1); bytes[at] = 1; expect(() => decodeFrameIndexRow(bytes, 1)).toThrow(); }
  for (const payload of [0, AUTHORITY_WAL_MAX_PAYLOAD_BYTES + 1]) {
    const bytes = row(false, 1); bytes.writeUInt32BE(payload, 8); expect(() => decodeFrameIndexRow(bytes, 1)).toThrow(/offsets/);
  }
  for (const end of [1n, 9007199254740992n]) {
    const bytes = row(false, 1); bytes.writeBigUInt64BE(end); expect(() => decodeFrameIndexRow(bytes, 1)).toThrow(/offsets/);
  }
  expect(() => decodeFrameIndexRow(Buffer.alloc(FRAME_INDEX_ROW_BYTES - 1), 1)).toThrow(/length/);
  for (const lsn of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => decodeFrameIndexRow(row(true, 1), lsn)).toThrow(/LSN/);
});

const key = new AuthorityCacheIntegrity(Buffer.alloc(32, 95)), logIdBytes = Buffer.alloc(32, 47), logId = logIdBytes.toString("base64url");
const empty = "sha256:" + "0".repeat(64), source = { dev: 1n, ino: 2n };
async function indexed(count: number) {
  const root = await createTempDir("b3-frame-index-wire"), index = AuthenticatedFrameIndex.create(root, logId, 0, empty, key, source);
  for (let n = 1; n <= count; n++) index.append({ format: "legacy", frameEndOffset: n * 48,
    payloadBytes: 20, payloadDigest: Buffer.alloc(32, n % 256), prefixDigest: "sha256:" + n.toString(16).padStart(64, "0"), streams: ["control"] });
  await index.flush(); return { root, index };
}
it("authenticates the legacy physical binding, sidecar identity and optional seal extension", async () => {
  const { root } = await indexed(1), file = path.join(root, "frame-index-v1.seal");
  const bytes = await readFile(file);
  expect(bytes.readUInt16BE(4)).toBe(2); expect(bytes.readUInt16BE(6)).toBe(1);
  expect(bytes.length).toBe(112 + 88 + 32 + 32);
  expect(await AuthenticatedFrameIndex.open(root, logId, 0, empty, key, source)).toBeDefined();
  expect(await AuthenticatedFrameIndex.open(root, logId, 0, empty, key, { dev: 1n, ino: 3n })).toBeUndefined();
  expect(await AuthenticatedFrameIndex.open(root, logId, 0, empty, key)).toBeUndefined();
  expect(await AuthenticatedFrameIndex.open(root, Buffer.alloc(32, 48).toString("base64url"), 0, empty, key, source)).toBeUndefined();
  for (const kind of ["binding", "flags"] as const) {
    const body = Buffer.from(bytes.subarray(0, -32));
    if (kind === "binding") body[body.length - 1] ^= 1;
    else body.writeUInt16BE(2, 6);
    await writeFile(file, Buffer.concat([body, frameIndexMac("frame-index-seal", [body], key)!]));
    expect(await AuthenticatedFrameIndex.open(root, logId, 0, empty, key, source)).toBeUndefined();
  }
  await writeFile(file, Buffer.alloc(100_000));
  expect(await AuthenticatedFrameIndex.open(root, logId, 0, empty, key, source)).toBeUndefined();
});
it("rejects unsupported authenticated page rows before a selected reader can skip them", async () => {
  const { root } = await indexed(256), file = path.join(root, "frame-index-v1.rows");
  const bytes = await readFile(file); bytes[64 + 12] = 0x80;
  const header = Buffer.alloc(8); header.writeUInt16BE(2); header.writeUInt32BE(0, 4);
  const rows = bytes.subarray(64, 64 + 256 * 88), epoch = bytes.subarray(12, 28);
  frameIndexMac("frame-index-page", [header, logIdBytes, epoch, rows], key)!.copy(bytes, 64 + rows.length);
  await writeFile(file, bytes);
  const index = await AuthenticatedFrameIndex.open(root, logId, 0, empty, key, source);
  await expect(index!.row(256)).rejects.toThrow(/flags/);
});
it("rejects illegal append geometry without changing the accepted head", async () => {
  const { index } = await indexed(1), common = { format: "legacy" as const, frameEndOffset: 96, payloadBytes: 20, payloadDigest: Buffer.alloc(32), prefixDigest: empty, streams: ["control"] };
  for (const invalid of [{ ...common, payloadBytes: 0 }, { ...common, frameEndOffset: 97 }, { ...common, frameEndOffset: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => index.append(invalid)).toThrow(); expect(index.headLsn).toBe(1);
  }
});
