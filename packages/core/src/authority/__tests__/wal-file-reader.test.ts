import type { FileHandle } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fileReader } from "../wal-file-reader.js";
import { encodeAuthorityWalFrame, scanAuthorityWalFrames } from "../wal-frame.js";

function source(bytes: Buffer, shortRead = Infinity) {
  const reads: { position: number; length: number }[] = [];
  const handle = {
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      reads.push({ position, length });
      const bytesRead = bytes.copy(buffer, offset, position, position + Math.min(length, shortRead));
      return { bytesRead, buffer };
    },
  } as Pick<FileHandle, "read">;
  return { handle, reads };
}

describe("WAL file read window", () => {
  it("scans many small frames with bounded block reads and preserves every payload", async () => {
    const payloads = Array.from({ length: 2_000 }, (_, index) => Buffer.from(`${index}:${"x".repeat(80)}`));
    const bytes = Buffer.concat(payloads.map((payload) => encodeAuthorityWalFrame(payload)));
    const { handle, reads } = source(bytes);
    const observed: Buffer[] = [];
    const result = await scanAuthorityWalFrames(fileReader(handle, bytes.length), (payload) => {
      observed.push(Buffer.from(payload));
    });
    expect(result).toEqual({ frameCount: payloads.length, validBytes: bytes.length });
    expect(observed).toEqual(payloads);
    expect(reads.length).toBeLessThan(10);
    expect(Math.max(...reads.map((read) => read.length))).toBe(64 * 1024);
  });

  it("handles window crossings, large frames, short reads and a physically incomplete tail", async () => {
    const payloads = [Buffer.alloc(65_500, 1), Buffer.alloc(150_000, 2), Buffer.from("end")];
    const frames = payloads.map((payload) => encodeAuthorityWalFrame(payload));
    const truncated = Buffer.concat(frames).subarray(0, -3);
    const prefix = Buffer.alloc(72, 5);
    const { handle, reads } = source(Buffer.concat([prefix, truncated]), 997);
    const observed: Buffer[] = [];
    const result = await scanAuthorityWalFrames(fileReader(handle, truncated.length, prefix.length), (payload) => {
      observed.push(Buffer.from(payload));
    });
    expect(observed).toEqual(payloads.slice(0, 2));
    expect(result).toEqual({
      frameCount: 2,
      validBytes: frames[0]!.length + frames[1]!.length,
      incompleteTail: frames[2]!.subarray(0, -3),
    });
    expect(reads.every((read) => read.position >= prefix.length && read.position + read.length <= prefix.length + truncated.length)).toBe(true);
  });

  it("does not retain bytes between scans or read beyond the fixed scan extent", async () => {
    const bytes = Buffer.from("before-ignored");
    const { handle, reads } = source(bytes);
    const first = fileReader(handle, 6);
    expect(Buffer.from(await first.read(0, 6)).toString()).toBe("before");
    Buffer.from("after!").copy(bytes);
    expect(Buffer.from(await fileReader(handle, 6).read(0, 20)).toString()).toBe("after!");
    expect(reads).toEqual([{ position: 0, length: 6 }, { position: 0, length: 6 }]);
  });

  it("keeps complete corruption fatal and unexpected short physical files distinguishable", async () => {
    const bytes = encodeAuthorityWalFrame(Buffer.from("corrupt"));
    bytes[bytes.length - 1]! ^= 1;
    const { handle } = source(bytes);
    await expect(scanAuthorityWalFrames(fileReader(handle, bytes.length), () => undefined)).rejects.toThrow("trailer is invalid");
    await expect(scanAuthorityWalFrames(fileReader(source(Buffer.from([1])).handle, 100), () => undefined)).rejects.toThrow();
  });
});
