import { describe, expect, it } from "vitest";
import {
  AUTHORITY_WAL_FILE_HEADER_BYTES,
  AUTHORITY_WAL_HEADER_BYTES,
  AUTHORITY_WAL_TRAILER_BYTES,
  decodeAuthorityWalFileHeader,
  decodeAuthorityWalFrame,
  encodeAuthorityWalFileHeader,
  encodeAuthorityWalFrame,
  scanAuthorityWalFrames,
} from "../wal-frame.js";

describe("authority WAL frame", () => {
  it("classifies every physically incomplete suffix as an incomplete tail", () => {
    const payload = Buffer.from('{"v":1,"lsn":1}', "utf8");
    const metadata = frameMetadata(1);
    const frame = encodeAuthorityWalFrame(payload, metadata);

    for (let length = 0; length < frame.byteLength; length += 1) {
      expect(decodeAuthorityWalFrame(frame.subarray(0, length), 0)).toEqual({
        kind: "incomplete",
      });
    }
    expect(decodeAuthorityWalFrame(frame, 0)).toEqual({
      kind: "complete",
      payload,
      metadata,
      nextOffset:
        AUTHORITY_WAL_HEADER_BYTES +
        payload.byteLength +
        AUTHORITY_WAL_TRAILER_BYTES,
    });
  });

  it("fails closed when a complete header or trailer is corrupted", () => {
    const frame = encodeAuthorityWalFrame(
      Buffer.from("payload", "utf8"),
      frameMetadata(1),
    );
    const headerCorrupt = Buffer.from(frame);
    headerCorrupt[12] ^= 0xff;
    expect(() => decodeAuthorityWalFrame(headerCorrupt, 0)).toThrow(
      "frame header is invalid",
    );

    const trailerCorrupt = Buffer.from(frame);
    trailerCorrupt[trailerCorrupt.byteLength - 1] ^= 0xff;
    expect(() => decodeAuthorityWalFrame(trailerCorrupt, 0)).toThrow(
      "frame trailer is invalid",
    );
  });

  it("scans a growing WAL with memory bounded by one frame", async () => {
    const payloads = Array.from({ length: 64 }, (_, index) =>
      Buffer.from(JSON.stringify({ index, value: "x".repeat(index + 1) }), "utf8"),
    );
    const frames = payloads.map((payload, index) =>
      encodeAuthorityWalFrame(payload, frameMetadata(index + 1))
    );
    const wal = Buffer.concat(frames);
    const reads: number[] = [];
    const visited: Buffer[] = [];

    const result = await scanAuthorityWalFrames(
      {
        size: wal.byteLength,
        async read(offset, length) {
          reads.push(length);
          return wal.subarray(offset, offset + length);
        },
      },
      (payload) => visited.push(Buffer.from(payload)),
    );

    expect(result).toEqual({
      frameCount: frames.length,
      validBytes: wal.byteLength,
    });
    expect(visited).toEqual(payloads);
    expect(Math.max(...reads)).toBeLessThan(Math.max(...frames.map((frame) => frame.byteLength)));
    expect(Math.max(...reads)).toBeLessThan(wal.byteLength);

    const truncated = wal.subarray(0, wal.byteLength - 3);
    const incomplete = await scanAuthorityWalFrames(
      {
        size: truncated.byteLength,
        async read(offset, length) {
          return truncated.subarray(offset, offset + length);
        },
      },
      () => undefined,
    );
    expect(incomplete.frameCount).toBe(frames.length - 1);
    expect(incomplete.validBytes).toBe(wal.byteLength - frames.at(-1)!.byteLength);
    expect(incomplete.incompleteTail?.byteLength).toBe(frames.at(-1)!.byteLength - 3);
  });

  it("binds a fixed durable file header to its random log identity", () => {
    const rawId = Buffer.alloc(32, 0x5a);
    const encoded = encodeAuthorityWalFileHeader(rawId);

    expect(encoded).toHaveLength(AUTHORITY_WAL_FILE_HEADER_BYTES);
    expect(decodeAuthorityWalFileHeader(encoded)).toEqual({
      formatVersion: 2,
      logId: rawId.toString("base64url"),
    });

    encoded[40] ^= 0xff;
    expect(() => decodeAuthorityWalFileHeader(encoded)).toThrow(
      "file header is invalid",
    );
  });
});

function frameMetadata(lsn: number) {
  return {
    lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}`,
  };
}
