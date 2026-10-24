/**
 * 分片位置文件 `<seq>.pos`：每片一个，与分片同生同退。
 *
 *   [0, 256)                      文件头：epoch、seq、firstRunIndex、分片创建时刻、前一片的封片长度
 *   [256 + i·256, 256 + (i+1)·256) 第 i 项 = runIndex 为 firstRunIndex + i 的 run 的位置
 *
 * 位置项先于正文落盘，本身就是 run 的意图：只有校验和正确、epoch 一致、forPub = 当前
 * pub + 1 且 runIndex = nextRunIndex 的项才是有效意图；runIndex < nextRunIndex 的项是已发布
 * 位置，只读不改。被放弃的意图项由下一次尝试原位覆盖。
 */

import { createHash } from "node:crypto";
import {
  decodeSourceDigest,
  encodeSourceDigest,
  type DirectoryRoot,
  type PublishedRunPosition,
  type RunSourceDigest,
} from "./directory-root.js";

export const POSITION_RECORD_BYTES = 256;
const HEADER_MAGIC = 0x5a585030; // "ZXP0"
const ENTRY_MAGIC = 0x5a585031; // "ZXP1"
const SUM_AT = 248;

export interface PositionFileHeader {
  readonly epoch: Buffer;
  readonly seq: number;
  readonly firstRunIndex: number;
  readonly createdAtMs: number;
  /** 前一片封片时的字节数（本片由换片创建时记录）；读者据此核对封存片的长度 */
  readonly prevSealedSize?: number;
}

export interface PositionEntry extends PublishedRunPosition {
  readonly epoch: Buffer;
  readonly forPub: number;
  /** 换片：本项所在分片是本次新建的，正文前有 header */
  readonly newShard: boolean;
}

export function positionFileName(seq: number): string {
  return `${String(seq).padStart(6, "0")}.pos`;
}

export function shardFileName(seq: number): string {
  return `${String(seq).padStart(6, "0")}.jsonl`;
}

export function entryOffset(index: number): number {
  return POSITION_RECORD_BYTES * (index + 1);
}

function checksum(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes.subarray(0, SUM_AT)).digest().subarray(0, 8);
}

function writeU64(buf: Buffer, at: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`transcript position field out of range: ${value}`);
  buf.writeBigUInt64LE(BigInt(value), at);
}

function readU64(buf: Buffer, at: number): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("transcript position field exceeds safe integer");
  return Number(value);
}

/** 文件头布局：0 魔数、8 epoch、24 seq、32 firstRunIndex、40 创建时刻、48 前一片封片长度（值 + 1，0 表示未记录）、248 校验和 */
export function encodePositionHeader(header: PositionFileHeader): Buffer {
  const buf = Buffer.alloc(POSITION_RECORD_BYTES);
  buf.writeUInt32LE(HEADER_MAGIC, 0);
  header.epoch.copy(buf, 8);
  buf.writeUInt32LE(header.seq, 24);
  writeU64(buf, 32, header.firstRunIndex);
  writeU64(buf, 40, header.createdAtMs);
  if (header.prevSealedSize !== undefined) writeU64(buf, 48, header.prevSealedSize + 1);
  checksum(buf).copy(buf, SUM_AT);
  return buf;
}

/**
 * epoch 为 undefined 时不核对代际：只读者只读已发布范围内的位置文件，它们都由当前代际写出
 * （新片的位置文件随换片新建，早于该片可见）。
 */
export function decodePositionHeader(buf: Buffer, epoch: Buffer | undefined, seq: number): PositionFileHeader | undefined {
  if (buf.length < POSITION_RECORD_BYTES || buf.readUInt32LE(0) !== HEADER_MAGIC) return undefined;
  if (!checksum(buf).equals(buf.subarray(SUM_AT, SUM_AT + 8))) return undefined;
  if ((epoch && !buf.subarray(8, 24).equals(epoch)) || buf.readUInt32LE(24) !== seq) return undefined;
  try {
    const prevSealed = readU64(buf, 48);
    return {
      epoch: Buffer.from(buf.subarray(8, 24)),
      seq,
      firstRunIndex: readU64(buf, 32),
      createdAtMs: readU64(buf, 40),
      ...(prevSealed > 0 ? { prevSealedSize: prevSealed - 1 } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 项布局：0 魔数、4 标志、8 epoch、24 forPub、32 runIndex、40 offset、48 length、56 行 sha256、88 来源摘要、248 校验和 */
export function encodePositionEntry(entry: PositionEntry): Buffer {
  const buf = Buffer.alloc(POSITION_RECORD_BYTES);
  buf.writeUInt32LE(ENTRY_MAGIC, 0);
  buf.writeUInt8(entry.newShard ? 1 : 0, 4);
  entry.epoch.copy(buf, 8);
  writeU64(buf, 24, entry.forPub);
  writeU64(buf, 32, entry.runIndex);
  writeU64(buf, 40, entry.offset);
  writeU64(buf, 48, entry.length);
  entry.lineSha256.copy(buf, 56);
  encodeSourceDigest(buf, 88, entry.source);
  checksum(buf).copy(buf, SUM_AT);
  return buf;
}

export function decodePositionEntry(buf: Buffer, seq: number): PositionEntry | undefined {
  if (buf.length < POSITION_RECORD_BYTES || buf.readUInt32LE(0) !== ENTRY_MAGIC) return undefined;
  if (!checksum(buf).equals(buf.subarray(SUM_AT, SUM_AT + 8))) return undefined;
  try {
    const source = decodeSourceDigest(buf, 88);
    if (!source) return undefined;
    return {
      newShard: buf.readUInt8(4) === 1,
      epoch: Buffer.from(buf.subarray(8, 24)),
      forPub: readU64(buf, 24),
      runIndex: readU64(buf, 32),
      seq,
      offset: readU64(buf, 40),
      length: readU64(buf, 48),
      lineSha256: Buffer.from(buf.subarray(56, 88)),
      source,
    };
  } catch {
    return undefined;
  }
}

/** 已发布位置：epoch 一致、发布序号不晚于视图、序号吻合 */
export function isPublishedEntry(entry: PositionEntry | undefined, root: DirectoryRoot, runIndex: number): entry is PositionEntry {
  return !!entry && entry.epoch.equals(root.epoch) && entry.forPub <= root.pub && entry.runIndex === runIndex && runIndex < root.tail.nextRunIndex;
}

/** 有效意图：epoch 一致、forPub = 当前 pub + 1、runIndex = nextRunIndex */
export function isIntentEntry(entry: PositionEntry | undefined, root: DirectoryRoot): entry is PositionEntry {
  return !!entry && entry.epoch.equals(root.epoch) && entry.forPub === root.pub + 1 && entry.runIndex === root.tail.nextRunIndex;
}

export function sourceDigestEquals(a: RunSourceDigest, b: RunSourceDigest): boolean {
  return a.kind === b.kind && a.commitRevision === b.commitRevision &&
    a.runIdSha256.equals(b.runIdSha256) && a.assignmentSha256.equals(b.assignmentSha256) && a.digestSha256.equals(b.digestSha256);
}
