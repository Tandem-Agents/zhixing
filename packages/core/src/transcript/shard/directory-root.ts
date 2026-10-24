/**
 * 分片目录的根 `root.bin`：A / B 两半交替发布已发布状态，第三段是 clear / retire 的意图区。
 *
 *   [0, 512)      A 半
 *   [512, 1024)   B 半
 *   [1024, 1536)  意图区
 *
 * 每一半是一份已发布状态（定长二进制 + 截断 sha256 校验和）。当前根 = 两半中校验通过且
 * pub 较大的那一半；发布 pub = k + 1 时写另一半并 fsync，这就是提交点。写撕裂时新的一半
 * 校验失败，旧的一半仍是当前根。
 */

import { createHash } from "node:crypto";

export const ROOT_FILE_NAME = "root.bin";
export const ROOT_HALF_BYTES = 512;
export const ROOT_INTENT_OFFSET = 1024;
export const ROOT_FILE_BYTES = 1536;

const ROOT_MAGIC = 0x5a585231; // "ZXR1"
const INTENT_MAGIC = 0x5a584931; // "ZXI1"
const ROOT_FORMAT = 2;
const SUM_AT = 504;

/** 已发布状态 —— 只表达已经发布的稳定状态，不含进行中的物化 */
export interface DirectoryRoot {
  /** 128 位随机代际，转换或新建时生成 */
  readonly epoch: Buffer;
  readonly pub: number;
  /** prevSealedSize：活跃片之前那一片封片时的字节数；未记录时读者按文件实际长度读取 */
  readonly active: { readonly seq: number; readonly createdAtMs: number; readonly firstRunIndex: number; readonly prevSealedSize?: number };
  /** 已发布前缀：活跃片中 size 之前全是完整行 */
  readonly tail: { readonly size: number; readonly nextRunIndex: number };
  /** 最近发布的 run 的精确位置，重驱快路 */
  readonly last?: PublishedRunPosition;
  readonly clear: { readonly generation: number; readonly boundaryRunIndex: number; readonly lastClearAtMs?: number };
  /** 序号前缀可见：fromSeq 以下的片已撤可见，deletedBelowSeq 以下的片已物理删除 */
  readonly visible: { readonly fromSeq: number; readonly fromRunIndex: number; readonly deletedBelowSeq: number };
  /**
   * 严格区起点：(seq, offset) 之后的字节都由当前格式写出，已发布范围内不可解析即为损坏；
   * 之前的字节来自旧测试格式转换，按旧语义容忍坏行。未记录时整体按容忍处理。
   */
  readonly strictFrom?: { readonly seq: number; readonly offset: number };
}

/** 一条已发布 run 的位置与来源摘要（位置项与根的 last 共用） */
export interface PublishedRunPosition {
  readonly runIndex: number;
  readonly seq: number;
  readonly offset: number;
  readonly length: number;
  readonly lineSha256: Buffer;
  readonly source: RunSourceDigest;
}

/** 来源摘要：owner 物化绑定 assignmentId / commitRevision / digest；local-turn 无 runId 时摘要全零 */
export interface RunSourceDigest {
  readonly kind: "owner" | "local" | "legacy";
  readonly runIdSha256: Buffer;
  readonly assignmentSha256: Buffer;
  readonly digestSha256: Buffer;
  readonly commitRevision: number;
}

/**
 * clear 的意图。run 的意图由位置项承担；retention 撤可见只改根，是一次原子发布，无需意图。
 * offset / length / sha256 覆盖本次写入的全部字节（换片时含 header）。
 */
export interface RootIntent {
  readonly kind: "clear";
  readonly forPub: number;
  readonly seq: number;
  readonly offset: number;
  readonly length: number;
  readonly sha256: Buffer;
  /** 换片：目标为新片（offset 为 0） */
  readonly newShard?: { readonly createdAtMs: number; readonly firstRunIndex: number };
}

const KIND_CODE = { owner: 1, local: 2, legacy: 3 } as const;
const KIND_NAME = { 1: "owner", 2: "local", 3: "legacy" } as const;

export const ZERO_SHA256 = Buffer.alloc(32);

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

function checksum(bytes: Buffer, end: number): Buffer {
  return createHash("sha256").update(bytes.subarray(0, end)).digest().subarray(0, 8);
}

function writeU64(buf: Buffer, at: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`transcript directory field out of range: ${value}`);
  buf.writeBigUInt64LE(BigInt(value), at);
}

function readU64(buf: Buffer, at: number): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("transcript directory field exceeds safe integer");
  return Number(value);
}

export function encodeSourceDigest(buf: Buffer, at: number, source: RunSourceDigest): void {
  buf.writeUInt8(KIND_CODE[source.kind], at);
  source.runIdSha256.copy(buf, at + 8);
  source.assignmentSha256.copy(buf, at + 40);
  source.digestSha256.copy(buf, at + 72);
  writeU64(buf, at + 104, source.commitRevision);
}

export function decodeSourceDigest(buf: Buffer, at: number): RunSourceDigest | undefined {
  const kind = KIND_NAME[buf.readUInt8(at) as 1 | 2 | 3];
  if (!kind) return undefined;
  return {
    kind,
    runIdSha256: Buffer.from(buf.subarray(at + 8, at + 40)),
    assignmentSha256: Buffer.from(buf.subarray(at + 40, at + 72)),
    digestSha256: Buffer.from(buf.subarray(at + 72, at + 104)),
    commitRevision: readU64(buf, at + 104),
  };
}

/**
 * 一半的布局：0 魔数、4 格式、8 epoch、24 pub、32 active、56 tail、72 last、264 clear、296 visible、
 * 312 strictFrom（seq + 1，0 表示未记录）、320 strictFrom.offset、328 active.prevSealedSize（值 + 1，0 表示未记录）、
 * 504 校验和
 */
export function encodeRootHalf(root: DirectoryRoot): Buffer {
  const buf = Buffer.alloc(ROOT_HALF_BYTES);
  buf.writeUInt32LE(ROOT_MAGIC, 0);
  buf.writeUInt16LE(ROOT_FORMAT, 4);
  root.epoch.copy(buf, 8);
  writeU64(buf, 24, root.pub);
  buf.writeUInt32LE(root.active.seq, 32);
  writeU64(buf, 40, root.active.createdAtMs);
  writeU64(buf, 48, root.active.firstRunIndex);
  writeU64(buf, 56, root.tail.size);
  writeU64(buf, 64, root.tail.nextRunIndex);
  if (root.last) {
    buf.writeUInt8(1, 72);
    writeU64(buf, 80, root.last.runIndex);
    buf.writeUInt32LE(root.last.seq, 88);
    writeU64(buf, 96, root.last.offset);
    writeU64(buf, 104, root.last.length);
    root.last.lineSha256.copy(buf, 112);
    encodeSourceDigest(buf, 144, root.last.source);
  }
  writeU64(buf, 264, root.clear.generation);
  writeU64(buf, 272, root.clear.boundaryRunIndex);
  writeU64(buf, 280, root.clear.lastClearAtMs ?? 0);
  buf.writeUInt32LE(root.visible.fromSeq, 296);
  buf.writeUInt32LE(root.visible.deletedBelowSeq, 300);
  writeU64(buf, 304, root.visible.fromRunIndex);
  if (root.strictFrom) {
    buf.writeUInt32LE(root.strictFrom.seq + 1, 312);
    writeU64(buf, 320, root.strictFrom.offset);
  }
  if (root.active.prevSealedSize !== undefined) writeU64(buf, 328, root.active.prevSealedSize + 1);
  checksum(buf, SUM_AT).copy(buf, SUM_AT);
  return buf;
}

export function decodeRootHalf(buf: Buffer): DirectoryRoot | undefined {
  if (buf.length < ROOT_HALF_BYTES) return undefined;
  if (buf.readUInt32LE(0) !== ROOT_MAGIC || buf.readUInt16LE(4) !== ROOT_FORMAT) return undefined;
  if (!checksum(buf, SUM_AT).equals(buf.subarray(SUM_AT, SUM_AT + 8))) return undefined;
  try {
    const hasLast = buf.readUInt8(72) === 1;
    const source = hasLast ? decodeSourceDigest(buf, 144) : undefined;
    const lastClearAtMs = readU64(buf, 280);
    const strictSeq = buf.readUInt32LE(312);
    const prevSealed = readU64(buf, 328);
    return {
      epoch: Buffer.from(buf.subarray(8, 24)),
      pub: readU64(buf, 24),
      active: {
        seq: buf.readUInt32LE(32),
        createdAtMs: readU64(buf, 40),
        firstRunIndex: readU64(buf, 48),
        ...(prevSealed > 0 ? { prevSealedSize: prevSealed - 1 } : {}),
      },
      ...(strictSeq > 0 ? { strictFrom: { seq: strictSeq - 1, offset: readU64(buf, 320) } } : {}),
      tail: { size: readU64(buf, 56), nextRunIndex: readU64(buf, 64) },
      ...(hasLast && source ? {
        last: {
          runIndex: readU64(buf, 80),
          seq: buf.readUInt32LE(88),
          offset: readU64(buf, 96),
          length: readU64(buf, 104),
          lineSha256: Buffer.from(buf.subarray(112, 144)),
          source,
        },
      } : {}),
      clear: {
        generation: readU64(buf, 264),
        boundaryRunIndex: readU64(buf, 272),
        ...(lastClearAtMs > 0 ? { lastClearAtMs } : {}),
      },
      visible: { fromSeq: buf.readUInt32LE(296), deletedBelowSeq: buf.readUInt32LE(300), fromRunIndex: readU64(buf, 304) },
    };
  } catch {
    return undefined;
  }
}

/** 意图区布局：0 魔数、4 类别、8 epoch、24 forPub，其后按类别；504 校验和 */
export function encodeIntent(epoch: Buffer, intent: RootIntent): Buffer {
  const buf = Buffer.alloc(ROOT_HALF_BYTES);
  buf.writeUInt32LE(INTENT_MAGIC, 0);
  epoch.copy(buf, 8);
  writeU64(buf, 24, intent.forPub);
  buf.writeUInt8(1, 4);
  buf.writeUInt32LE(intent.seq, 32);
  writeU64(buf, 40, intent.offset);
  writeU64(buf, 48, intent.length);
  intent.sha256.copy(buf, 56);
  if (intent.newShard) {
    buf.writeUInt8(1, 88);
    writeU64(buf, 96, intent.newShard.createdAtMs);
    writeU64(buf, 104, intent.newShard.firstRunIndex);
  }
  checksum(buf, SUM_AT).copy(buf, SUM_AT);
  return buf;
}

/** 意图仅在校验和正确、epoch 一致、forPub 等于当前 pub + 1 时有效 */
export function decodeIntent(buf: Buffer, root: DirectoryRoot): RootIntent | undefined {
  if (buf.length < ROOT_HALF_BYTES || buf.readUInt32LE(0) !== INTENT_MAGIC) return undefined;
  if (!checksum(buf, SUM_AT).equals(buf.subarray(SUM_AT, SUM_AT + 8))) return undefined;
  if (!buf.subarray(8, 24).equals(root.epoch)) return undefined;
  const forPub = readU64(buf, 24);
  if (forPub !== root.pub + 1 || buf.readUInt8(4) !== 1) return undefined;
  return {
    kind: "clear",
    forPub,
    seq: buf.readUInt32LE(32),
    offset: readU64(buf, 40),
    length: readU64(buf, 48),
    sha256: Buffer.from(buf.subarray(56, 88)),
    ...(buf.readUInt8(88) === 1 ? { newShard: { createdAtMs: readU64(buf, 96), firstRunIndex: readU64(buf, 104) } } : {}),
  };
}

/** 从整份 root.bin 选出当前根：两半中校验通过且 pub 较大的那一半 */
export function selectCurrentRoot(file: Buffer): { readonly root: DirectoryRoot; readonly half: 0 | 1 } | undefined {
  const a = decodeRootHalf(file.subarray(0, ROOT_HALF_BYTES));
  const b = decodeRootHalf(file.subarray(ROOT_HALF_BYTES, ROOT_HALF_BYTES * 2));
  if (a && b) return a.pub >= b.pub ? { root: a, half: 0 } : { root: b, half: 1 };
  if (a) return { root: a, half: 0 };
  if (b) return { root: b, half: 1 };
  return undefined;
}

/** 下一次发布写入的那一半（非当前半） */
export function nextHalfOffset(currentHalf: 0 | 1): number {
  return currentHalf === 0 ? ROOT_HALF_BYTES : 0;
}

export function rootLastClearAt(root: DirectoryRoot): string | undefined {
  return root.clear.lastClearAtMs === undefined ? undefined : new Date(root.clear.lastClearAtMs).toISOString();
}
