/**
 * 按偏移读写文件的耐久原语：转录分片目录与摘要索引共用。
 *
 * 单次 write / read 可能只完成一部分（不抛错，只返回较小的字节数）。这里循环到写满或读满，
 * 写入完成后才 fsync；某次写入没有任何进展即报错，交调用方的恢复处理，不无限重试。
 */

import fs, { type FileHandle } from "node:fs/promises";

/** 在 offset 写满全部字节并 fsync；create 时新建（截断）文件 */
export async function writeAt(file: string, offset: number, bytes: Buffer, create: boolean): Promise<void> {
  const handle = await fs.open(file, create ? "w+" : "r+");
  try {
    let done = 0;
    while (done < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, offset + done);
      if (bytesWritten <= 0) throw new Error("Positional write made no progress");
      done += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 从 offset 起读满 length 字节；读到文件尾提前结束时返回实际读到的部分 */
export async function readRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/** 读文件的 [offset, offset + length)；文件不存在返回 null，其他错误照常抛出 */
export async function readFileRange(file: string, offset: number, length: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return await readRange(handle, offset, length);
  } finally {
    await handle.close();
  }
}
