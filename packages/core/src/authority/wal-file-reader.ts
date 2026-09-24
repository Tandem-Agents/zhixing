import type { FileHandle } from "node:fs/promises";
import type { AuthorityWalReader } from "./wal-frame.js";

const READ_WINDOW_BYTES = 64 * 1024;

/** One bounded read window, owned by a single locked WAL scan, never shared across scans. */
export function fileReader(
  handle: Pick<FileHandle, "read">,
  size: number,
  baseOffset = 0,
): AuthorityWalReader {
  let windowStart = 0;
  let window: Buffer = Buffer.alloc(0);

  const readPhysical = async (offset: number, length: number): Promise<Buffer> => {
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(
        buffer, total, length - total, baseOffset + offset + total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  };

  return {
    size,
    async read(offset, length) {
      const available = Math.min(length, Math.max(0, size - offset));
      if (available === 0) return Buffer.alloc(0);
      if (offset >= windowStart && offset + available <= windowStart + window.length) {
        return window.subarray(offset - windowStart, offset - windowStart + available);
      }
      // Large frames keep their existing frame-sized bound instead of enlarging the cache.
      if (available > READ_WINDOW_BYTES) return readPhysical(offset, available);
      windowStart = offset;
      window = await readPhysical(offset, Math.min(READ_WINDOW_BYTES, size - offset));
      return window.subarray(0, available);
    },
  };
}
