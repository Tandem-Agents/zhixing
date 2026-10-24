/**
 * 摘要快照索引：每个会话 `snapshots/` 目录内的派生元数据，只服务“启动时选哪一份摘要”。
 *
 *   index.bin              [0, 512) A 半、[512, 1024) B 半：已发布状态，两半交替发布
 *   entries-000000.bin …   定长项分段，每段 SEGMENT_SLOTS 项、每项 64B，按 slot 直接定位
 *
 * 已登记的项按 slot 顺序在 createdAt 与 coverage 两维都严格递增（写入方保证），所以
 * “coverage < E 中 createdAt 最大的一份”就是“coverage < E 的最后一项”，在可见区间上二分即得。
 * 可见区间 [fromSlot, count)；deletedBelowSlot 以下的快照文件已删，segmentFloor 以下的段已删。
 *
 * 第 count 项兼作登记意图：校验和正确、epoch 一致、slot = count、forPub = pub + 1 才有效。
 * 索引是派生缓存，不是业务事实：缺失或损坏时读者不带摘要，修复由保留期维护另行完成。
 */

import { createHash } from "node:crypto";

export const INDEX_FILE_NAME = "index.bin";
export const INDEX_HALF_BYTES = 512;
export const INDEX_FILE_BYTES = 1024;
export const ENTRY_BYTES = 64;
export const SEGMENT_SLOTS = 256;

const INDEX_MAGIC = 0x5a585331; // "ZXS1"
const ENTRY_MAGIC = 0x5a584531; // "ZXE1"
const INDEX_FORMAT = 1;
const INDEX_SUM_AT = 504;
const ENTRY_SUM_AT = 56;
const SEGMENT_FILE_PATTERN = /^entries-\d{6}\.bin$/u;

export interface SnapshotIndexRoot {
  readonly epoch: Buffer;
  readonly pub: number;
  /** 已登记项数（含已撤可见的） */
  readonly count: number;
  /** 可见下界：小于它的项已撤可见 */
  readonly fromSlot: number;
  /** 小于它的项对应的快照文件已删除 */
  readonly deletedBelowSlot: number;
  /** 小于它的段文件已删除 */
  readonly segmentFloor: number;
}

export interface SnapshotIndexEntry {
  readonly epoch: Buffer;
  readonly slot: number;
  readonly forPub: number;
  readonly createdAtMs: number;
  readonly coverage: number;
}

function checksum(bytes: Buffer, end: number): Buffer {
  return createHash("sha256").update(bytes.subarray(0, end)).digest().subarray(0, 8);
}

function writeU64(buf: Buffer, at: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`snapshot index field out of range: ${value}`);
  buf.writeBigUInt64LE(BigInt(value), at);
}

function readU64(buf: Buffer, at: number): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("snapshot index field exceeds safe integer");
  return Number(value);
}

/** 一半的布局：0 魔数、4 格式、8 epoch、24 pub、32 count、40 fromSlot、48 deletedBelowSlot、56 segmentFloor、504 校验和 */
export function encodeIndexHalf(root: SnapshotIndexRoot): Buffer {
  const buf = Buffer.alloc(INDEX_HALF_BYTES);
  buf.writeUInt32LE(INDEX_MAGIC, 0);
  buf.writeUInt16LE(INDEX_FORMAT, 4);
  root.epoch.copy(buf, 8);
  writeU64(buf, 24, root.pub);
  writeU64(buf, 32, root.count);
  writeU64(buf, 40, root.fromSlot);
  writeU64(buf, 48, root.deletedBelowSlot);
  writeU64(buf, 56, root.segmentFloor);
  checksum(buf, INDEX_SUM_AT).copy(buf, INDEX_SUM_AT);
  return buf;
}

export function decodeIndexHalf(buf: Buffer): SnapshotIndexRoot | undefined {
  if (buf.length < INDEX_HALF_BYTES) return undefined;
  if (buf.readUInt32LE(0) !== INDEX_MAGIC || buf.readUInt16LE(4) !== INDEX_FORMAT) return undefined;
  if (!checksum(buf, INDEX_SUM_AT).equals(buf.subarray(INDEX_SUM_AT, INDEX_SUM_AT + 8))) return undefined;
  try {
    const root = {
      epoch: Buffer.from(buf.subarray(8, 24)),
      pub: readU64(buf, 24),
      count: readU64(buf, 32),
      fromSlot: readU64(buf, 40),
      deletedBelowSlot: readU64(buf, 48),
      segmentFloor: readU64(buf, 56),
    };
    const consistent = root.deletedBelowSlot <= root.fromSlot && root.fromSlot <= root.count &&
      root.segmentFloor * SEGMENT_SLOTS <= root.deletedBelowSlot;
    return consistent ? root : undefined;
  } catch {
    return undefined;
  }
}

/** 当前根 = 两半中校验通过且 pub 较大的那一半 */
export function selectIndexRoot(file: Buffer): { readonly root: SnapshotIndexRoot; readonly half: 0 | 1 } | undefined {
  const a = decodeIndexHalf(file.subarray(0, INDEX_HALF_BYTES));
  const b = decodeIndexHalf(file.subarray(INDEX_HALF_BYTES, INDEX_FILE_BYTES));
  if (a && b) return a.pub >= b.pub ? { root: a, half: 0 } : { root: b, half: 1 };
  if (a) return { root: a, half: 0 };
  if (b) return { root: b, half: 1 };
  return undefined;
}

/** 项布局：0 魔数、8 epoch、24 slot、32 forPub、40 createdAtMs、48 coverage、56 校验和 */
export function encodeIndexEntry(entry: SnapshotIndexEntry): Buffer {
  const buf = Buffer.alloc(ENTRY_BYTES);
  buf.writeUInt32LE(ENTRY_MAGIC, 0);
  entry.epoch.copy(buf, 8);
  writeU64(buf, 24, entry.slot);
  writeU64(buf, 32, entry.forPub);
  writeU64(buf, 40, entry.createdAtMs);
  writeU64(buf, 48, entry.coverage);
  checksum(buf, ENTRY_SUM_AT).copy(buf, ENTRY_SUM_AT);
  return buf;
}

export function decodeIndexEntry(buf: Buffer, epoch: Buffer, slot: number): SnapshotIndexEntry | undefined {
  if (buf.length < ENTRY_BYTES || buf.readUInt32LE(0) !== ENTRY_MAGIC) return undefined;
  if (!checksum(buf, ENTRY_SUM_AT).equals(buf.subarray(ENTRY_SUM_AT, ENTRY_SUM_AT + 8))) return undefined;
  if (!buf.subarray(8, 24).equals(epoch)) return undefined;
  try {
    const entry = {
      epoch: Buffer.from(buf.subarray(8, 24)),
      slot: readU64(buf, 24),
      forPub: readU64(buf, 32),
      createdAtMs: readU64(buf, 40),
      coverage: readU64(buf, 48),
    };
    return entry.slot === slot ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** 已登记项：发布序号不晚于当前根 */
export function isRegisteredEntry(entry: SnapshotIndexEntry | undefined, root: SnapshotIndexRoot): entry is SnapshotIndexEntry {
  return !!entry && entry.forPub <= root.pub && entry.slot < root.count;
}

/** 有效登记意图：slot = count、forPub = pub + 1 */
export function isIntentEntry(entry: SnapshotIndexEntry | undefined, root: SnapshotIndexRoot): entry is SnapshotIndexEntry {
  return !!entry && entry.slot === root.count && entry.forPub === root.pub + 1;
}

export function segmentFileName(segment: number): string {
  return `entries-${String(segment).padStart(6, "0")}.bin`;
}

export function isSegmentFileName(name: string): boolean {
  return SEGMENT_FILE_PATTERN.test(name);
}

export function segmentOf(slot: number): number {
  return Math.floor(slot / SEGMENT_SLOTS);
}

export function offsetInSegment(slot: number): number {
  return (slot % SEGMENT_SLOTS) * ENTRY_BYTES;
}

/** 快照文件名由 createdAt 派生（与早期写法一致）；登记中的临时落点由同一名字确定 */
export function snapshotFileName(createdAtMs: number): string {
  return `${new Date(createdAtMs).toISOString().replace(/[:.]/g, "-")}.json`;
}

export function snapshotTempFileName(createdAtMs: number): string {
  return `${snapshotFileName(createdAtMs)}.tmp`;
}
