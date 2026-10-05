import { open } from 'node:fs/promises';

/** The size check and reads use the same handle. A file growing after stat can
 * consume only the fixed buffer plus one sentinel byte, never readFile's
 * unbounded allocation. The caller owns the returned buffer. */
export async function readBoundedInputFile(file: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error('不是普通文件');
    if (stat.size > maximum) throw Error('文件过大');
    const bytes = Buffer.allocUnsafe(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) return bytes.subarray(0, length);
      length += read.bytesRead;
    }
    throw Error('文件过大');
  } finally { await handle.close(); }
}
