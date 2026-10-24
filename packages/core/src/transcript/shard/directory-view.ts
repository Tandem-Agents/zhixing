/**
 * 只读视图：读者（倒读、字节读者、跨进程降级读面）共用。只读不写，不等待写者。
 *
 * 一次读取先取根，得到 `{ pub, active, tail.size, visible, clear }`，之后只读已发布范围：
 * 活跃片读到 tail.size 为止，封存片读到封片长度。根的两半总有一半有效；只读者读到两半都
 * 无效，说明正好被两次连续发布夹住，有界重读，仍不收敛就报可重试状态，不当作损坏。
 *
 * 已发布范围内的字节必须完整：文件短于已发布长度、或严格区内有不可解析的行，都是损坏，
 * 不能当作“没有更多历史”。只有旧测试格式转换来的字节（严格区之前）沿用旧语义，坏行跳过。
 */

import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { readFileRange, readRange } from "../../persistence/positional-io.js";
import { ROOT_FILE_BYTES, ROOT_FILE_NAME, rootLastClearAt, selectCurrentRoot, type DirectoryRoot } from "./directory-root.js";
import { POSITION_RECORD_BYTES, decodePositionHeader, positionFileName, shardFileName } from "./position-file.js";
import {
  SHARD_FORMAT_VERSION,
  TranscriptDirectoryDamagedError,
  TranscriptViewBusyError,
  type ShardRecordLine,
  type TranscriptIndex,
  type TranscriptShardRef,
  type TranscriptView,
} from "./types.js";

export const LEGACY_INDEX_FILE_NAME = "index.json";
const READ_ATTEMPTS = 3;

export function viewOfRoot(root: DirectoryRoot): TranscriptView {
  const lastClearAt = rootLastClearAt(root);
  return {
    pub: root.pub,
    activeSeq: root.active.seq,
    tailSize: root.tail.size,
    nextRunIndex: root.tail.nextRunIndex,
    fromSeq: root.visible.fromSeq,
    fromRunIndex: root.visible.fromRunIndex,
    clearBoundaryRunIndex: root.clear.boundaryRunIndex,
    ...(lastClearAt !== undefined ? { lastClearAt } : {}),
    ...(root.active.prevSealedSize !== undefined ? { prevSealedSize: root.active.prevSealedSize } : {}),
    ...(root.strictFrom ? { strictFrom: root.strictFrom } : {}),
  };
}

/** 读整份 root.bin；不存在返回 null，其他读取错误照常抛出 */
export async function readRootFile(transcriptDir: string): Promise<Buffer | null> {
  return await readFileRange(path.join(transcriptDir, ROOT_FILE_NAME), 0, ROOT_FILE_BYTES);
}

/**
 * 只读视图。root.bin 缺失时：有 v1 索引则按它在内存里派生（旧测试格式，不写盘），否则返回 null。
 */
export async function readDirectoryView(transcriptDir: string): Promise<TranscriptView | null> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const file = await readRootFile(transcriptDir);
    if (!file) return readLegacyView(transcriptDir);
    const current = selectCurrentRoot(file);
    if (current) return viewOfRoot(current.root);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new TranscriptViewBusyError();
}

async function readLegacyView(transcriptDir: string): Promise<TranscriptView | null> {
  const file = path.join(transcriptDir, LEGACY_INDEX_FILE_NAME);
  let index: TranscriptIndex;
  try {
    index = JSON.parse(await fs.readFile(file, "utf-8")) as TranscriptIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 既无根也无 v1 索引：没有分片是尚未写入的会话；有分片则是损坏，不猜测
      if (await hasShardFiles(transcriptDir)) throw new TranscriptDirectoryDamagedError(`Transcript shards exist without a directory root: ${transcriptDir}`);
      return null;
    }
    if (error instanceof SyntaxError) throw new TranscriptDirectoryDamagedError(`Legacy transcript index is unreadable: ${file}`);
    throw error;
  }
  const seqs = Array.isArray(index.shards)
    ? index.shards.map((meta) => Number.parseInt(meta.id, 10)).filter(Number.isSafeInteger)
    : [];
  const activeSeq = Number.parseInt(index.activeShardId, 10);
  if (index.version !== 1 || seqs.length === 0 || !Number.isSafeInteger(activeSeq)) {
    throw new TranscriptDirectoryDamagedError(`Legacy transcript index has an unknown shape: ${file}`);
  }
  let tailSize = 0;
  try {
    tailSize = (await fs.stat(path.join(transcriptDir, shardFileName(activeSeq)))).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    pub: 0,
    activeSeq,
    tailSize,
    fromSeq: Math.min(...seqs),
    fromRunIndex: 0,
    ...(index.lastClearAt !== undefined ? { lastClearAt: index.lastClearAt } : {}),
  };
}

async function hasShardFiles(transcriptDir: string): Promise<boolean> {
  try {
    return (await fs.readdir(transcriptDir)).some((entry) => /^\d{6}\.jsonl$/.test(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 一片在视图下的已发布字节数：活跃片为 tailSize，前一片取根里记录的封片长度，更早的封存片
 * 读其后继片的位置文件头。undefined：视图没有记录长度（旧测试格式），按文件实际长度读；
 * null：后继片的位置文件已不在（retention 已删到这里），交调用方按缺片处理。
 */
export async function publishedShardSize(
  transcriptDir: string,
  view: TranscriptView,
  seq: number,
): Promise<number | null | undefined> {
  if (seq === view.activeSeq) return view.tailSize;
  if (seq === view.activeSeq - 1) return view.prevSealedSize;
  if (view.prevSealedSize === undefined) return undefined;
  const buf = await readFileRange(path.join(transcriptDir, positionFileName(seq + 1)), 0, POSITION_RECORD_BYTES);
  if (!buf) return null;
  const header = decodePositionHeader(buf, undefined, seq + 1);
  if (!header) throw new TranscriptDirectoryDamagedError(`Transcript position header is unreadable for visible shard ${positionFileName(seq + 1)}`);
  return header.prevSealedSize;
}

/** 该片中严格区的起点字节；整片都在严格区之前时为 Infinity */
export function strictOffsetOf(view: TranscriptView | undefined, seq: number): number {
  const from = view?.strictFrom;
  if (!from || seq < from.seq) return Number.POSITIVE_INFINITY;
  return seq === from.seq ? from.offset : 0;
}

/**
 * 读一片的记录行。带视图时只读已发布范围，文件更短或严格区内有坏行即报损坏；
 * 不带视图时读整个文件、坏行跳过。文件不存在返回 null。
 */
export async function readShardLinesAt(
  transcriptDir: string,
  ref: TranscriptShardRef,
): Promise<ShardRecordLine[] | null> {
  const name = shardFileName(ref.seq);
  const published = ref.view ? await publishedShardSize(transcriptDir, ref.view, ref.seq) : undefined;
  if (published === null) return null;
  let handle: FileHandle;
  try {
    handle = await fs.open(path.join(transcriptDir, name), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const bytes = await readRange(handle, 0, published ?? (await handle.stat()).size);
    if (published !== undefined && bytes.length < published) {
      throw new TranscriptDirectoryDamagedError(`Transcript shard ${name} is shorter than its published size`);
    }
    return parseShardLines(bytes, strictOffsetOf(ref.view, ref.seq), name);
  } finally {
    await handle.close();
  }
}

/** 逐行解析；严格区（strictFrom 之后）的行不完整或不可解析即报损坏，之前的坏行跳过 */
export function parseShardLines(bytes: Buffer, strictFrom = Number.POSITIVE_INFINITY, name = "shard"): ShardRecordLine[] {
  const lines: ShardRecordLine[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline < 0 ? bytes.length : newline;
    const strict = start >= strictFrom;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(start, end).toString("utf-8"));
    } catch {
      parsed = undefined;
    }
    if (isReadableShardLine(parsed) && (newline >= 0 || !strict)) lines.push(parsed);
    else if (strict) throw new TranscriptDirectoryDamagedError(`Transcript shard ${name} has an unreadable published line at byte ${start}`);
    start = end + 1;
  }
  return lines;
}

function isReadableShardLine(value: unknown): value is ShardRecordLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "header") {
    return record.version === SHARD_FORMAT_VERSION && typeof record.conversationId === "string" &&
      typeof record.shardId === "string" && typeof record.createdAt === "string";
  }
  if (record.type === "clear") return typeof record.timestamp === "string";
  if (record.type === "run") {
    return typeof record.runIndex === "number" && typeof record.timestamp === "string" && Array.isArray(record.messages);
  }
  return false;
}
