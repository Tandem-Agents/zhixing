import { createHash, randomBytes } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "../persistence/index.js";
import { durablyRemoveFiles } from "../persistence/durable-removal.js";
import { frameIndexMac, frameIndexMacMatches, type AuthorityCacheIntegrity } from "./startup-proofs.js";
import { AUTHORITY_WAL_HEADER_BYTES, AUTHORITY_WAL_TRAILER_BYTES, AUTHORITY_WAL_LEGACY_TRAILER_BYTES, AUTHORITY_WAL_MAX_PAYLOAD_BYTES } from "./wal-frame.js";

/**
 * 认证帧索引：权威日志每个已核验帧的一行定长记录（帧尾偏移、载荷长度、载荷摘要、前缀摘要、
 * 流摘要与帧类型），以完整性密钥认证。启动只读封条、核对头边界（legacy还核头帧载荷）并续扫
 * 尾部，不再整段读取、哈希或遍历历史；历史帧在真正被读取时按认证行逐帧核对载荷摘要。
 *
 * 只记录完整核验过的帧（逐帧解码、连续LSN、sidecar/文件身份的前缀链；versioned另核帧尾证明）
 * 或本进程刚写入的帧，因此按行
 * 核对过摘要的载荷与当初核验的字节完全相同。索引是可丢弃的派生缓存：任何一处对不上都放弃
 * 索引、退回完整核验并重建，绝不把索引自身的损坏当作日志损坏。
 *
 * 行按 256 条一页追加到行文件，每页单独认证（绑定日志身份、索引纪元与页号）；未满一页的行与
 * 头部指针保存在封条文件中，整体认证、整体替换。纪元在每次重建时重新生成，旧纪元的页不会被
 * 新封条接受。两类文件都在日志写者锁内写入，行文件先落盘再替换封条。
 */

const ROWS_FILE = "frame-index-v1.rows";
const SEAL_FILE = "frame-index-v1.seal";
// 格式 2：多流信封的行带全部流的布隆位图。旧格式的索引不被采用，完整核验后重建一次。
const FORMAT = 2;
export const FRAME_INDEX_ROWS_PER_PAGE = 256;
export const FRAME_INDEX_ROW_BYTES = 88;
const PAGE_BYTES = FRAME_INDEX_ROWS_PER_PAGE * FRAME_INDEX_ROW_BYTES;
const MAC_BYTES = 32;
const PAGE_RECORD_BYTES = PAGE_BYTES + MAC_BYTES;
const ROWS_HEADER_BYTES = 64;
const SEAL_FIXED_BYTES = 112;
const ROWS_MAGIC = Buffer.from("ZXFI", "ascii");
const SEAL_MAGIC = Buffer.from("ZXFS", "ascii");
const EPOCH_BYTES = 16;
const LEGACY_ROW_FLAG = 4;
const STREAM_FLAGS = 3;
const SOURCE_BINDING_FLAG = 1;
const SOURCE_BINDING_BYTES = 32;
const MAX_SEAL_BYTES = SEAL_FIXED_BYTES + (FRAME_INDEX_ROWS_PER_PAGE - 1) * FRAME_INDEX_ROW_BYTES + SOURCE_BINDING_BYTES + MAC_BYTES;
/** 已认证页的进程内缓存上限（页数）。 */
const PAGE_CACHE_LIMIT = 512;

export interface FrameIndexRow {
  readonly format: "legacy" | "versioned";
  readonly lsn: number;
  readonly frameEndOffset: number;
  readonly payloadBytes: number;
  /** 载荷在日志文件中的起始偏移。 */
  readonly payloadOffset: number;
  readonly payloadDigest: Buffer;
  readonly prefixDigest: string;
  /** 全部记录属于同一流时的流标记。 */
  readonly streamTag?: bigint;
  /** 多流信封全部流的布隆位图（见 `frameStreamBloomMask`）。 */
  readonly streamBloom?: bigint;
}

export interface FrameIndexAppend {
  /** Omitted by existing versioned writers; their FORMAT=2 bytes stay unchanged. */
  readonly format?: "legacy" | "versioned";
  readonly frameEndOffset: number;
  readonly payloadBytes: number;
  readonly payloadDigest: Buffer;
  readonly prefixDigest: string;
  /** 信封记录涉及的全部流（去重）。 */
  readonly streams: readonly string[];
}

/** 流标记：流名摘要的前 64 位，只用于跳过无关帧；碰撞只会多读一帧，不会漏读。 */
export function frameStreamTag(stream: string): bigint {
  return createHash("sha256").update("zhixing-frame-stream\0").update(stream, "utf8").digest().readBigUInt64BE(0);
}

/**
 * 一个流在多流布隆位图中占的位：取流标记的三段 6 位各置一位。多流信封的位图是其全部流的
 * 位并集；某流的位不全在位图里就一定不含该流，全在时可能含（误报只会多读一帧）。
 */
export function frameStreamBloomMask(stream: string): bigint {
  const tag = frameStreamTag(stream);
  return (1n << (tag & 63n)) | (1n << ((tag >> 6n) & 63n)) | (1n << ((tag >> 12n) & 63n));
}

/** 一行原始字节里的流摘要：单流为标记，多流为布隆位图。 */
export function frameIndexRowStreams(row: Buffer): { readonly streamTag: bigint } | { readonly streamBloom: bigint } | undefined {
  const flags = rowFlags(row) & STREAM_FLAGS;
  return flags === 1 ? { streamTag: row.readBigUInt64BE(16) }
    : flags === 2 ? { streamBloom: row.readBigUInt64BE(16) }
      : undefined;
}

/** 解码一行原始字节（第 `lsn` 帧）。 */
export function decodeFrameIndexRow(row: Buffer, lsn: number): FrameIndexRow {
  return decodeRow(row, lsn);
}

export class FrameIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameIndexUnavailableError";
  }
}

function encodeRow(row: FrameIndexAppend): Buffer {
  const bytes = Buffer.alloc(FRAME_INDEX_ROW_BYTES);
  bytes.writeBigUInt64BE(BigInt(row.frameEndOffset), 0);
  bytes.writeUInt32BE(row.payloadBytes, 8);
  const streams = [...new Set(row.streams)];
  const format = row.format === "legacy" ? LEGACY_ROW_FLAG : 0;
  bytes.writeUInt8(format, 12);
  if (streams.length === 1) {
    bytes.writeUInt8(format | 1, 12);
    bytes.writeBigUInt64BE(frameStreamTag(streams[0]!), 16);
  } else if (streams.length > 1) {
    bytes.writeUInt8(format | 2, 12);
    bytes.writeBigUInt64BE(streams.reduce((bits, stream) => bits | frameStreamBloomMask(stream), 0n), 16);
  }
  row.payloadDigest.copy(bytes, 24, 0, 32);
  Buffer.from(row.prefixDigest.slice("sha256:".length), "hex").copy(bytes, 56);
  return bytes;
}

function decodeRow(bytes: Buffer, lsn: number): FrameIndexRow {
  const flags = validateRow(bytes);
  if (!Number.isSafeInteger(lsn) || lsn < 1) throw new FrameIndexUnavailableError("Frame index LSN is invalid");
  const format = flags & LEGACY_ROW_FLAG ? "legacy" : "versioned";
  const frameEndOffset = Number(bytes.readBigUInt64BE(0));
  const payloadBytes = bytes.readUInt32BE(8);
  return {
    format,
    lsn,
    frameEndOffset,
    payloadBytes,
    payloadOffset: frameEndOffset - trailerBytes(format) - payloadBytes,
    payloadDigest: bytes.subarray(24, 56),
    prefixDigest: `sha256:${bytes.subarray(56, 88).toString("hex")}`,
    ...((flags & STREAM_FLAGS) === 1 ? { streamTag: bytes.readBigUInt64BE(16) }
      : (flags & STREAM_FLAGS) === 2 ? { streamBloom: bytes.readBigUInt64BE(16) } : {}),
  };
}

function trailerBytes(format: "legacy" | "versioned"): number {
  return format === "legacy" ? AUTHORITY_WAL_LEGACY_TRAILER_BYTES : AUTHORITY_WAL_TRAILER_BYTES;
}

function rowFlags(bytes: Buffer): number {
  if (bytes.byteLength !== FRAME_INDEX_ROW_BYTES) throw new FrameIndexUnavailableError("Frame index row length is invalid");
  const flags = bytes.readUInt8(12);
  if ((flags & ~(LEGACY_ROW_FLAG | STREAM_FLAGS)) !== 0 || (flags & STREAM_FLAGS) === STREAM_FLAGS ||
      bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0 ||
      ((flags & STREAM_FLAGS) === 0 && bytes.readBigUInt64BE(16) !== 0n)) {
    throw new FrameIndexUnavailableError("Frame index row flags are invalid");
  }
  return flags;
}

function validateRow(bytes: Buffer): number {
  const flags = rowFlags(bytes), end = Number(bytes.readBigUInt64BE(0)), payload = bytes.readUInt32BE(8);
  if (!Number.isSafeInteger(end) || payload < 1 || payload > AUTHORITY_WAL_MAX_PAYLOAD_BYTES ||
      end < AUTHORITY_WAL_HEADER_BYTES + payload + trailerBytes(flags & LEGACY_ROW_FLAG ? "legacy" : "versioned")) {
    throw new FrameIndexUnavailableError("Frame index row offsets are invalid");
  }
  return flags;
}

/** Validate a bounded page without allocating a decoded object for every filtered row. */
function validateRows(rows: Buffer, previousEnd?: number, legacy?: boolean): void {
  for (let offset = 0; offset < rows.byteLength; offset += FRAME_INDEX_ROW_BYTES) {
    const row = rows.subarray(offset, offset + FRAME_INDEX_ROW_BYTES), flags = validateRow(row);
    if (legacy !== undefined && !!(flags & LEGACY_ROW_FLAG) !== legacy) {
      throw new FrameIndexUnavailableError("Frame index row format does not match its source");
    }
    const end = Number(row.readBigUInt64BE(0));
    if (previousEnd !== undefined && end !== previousEnd + AUTHORITY_WAL_HEADER_BYTES + row.readUInt32BE(8) +
        trailerBytes(flags & LEGACY_ROW_FLAG ? "legacy" : "versioned")) {
      throw new FrameIndexUnavailableError("Frame index rows are not contiguous");
    }
    previousEnd = end;
  }
}

/** Physical identity supplements the sidecar logId for a headerless legacy WAL. */
interface FrameIndexSource { readonly dev: bigint; readonly ino: bigint }
function sourceBinding(source: FrameIndexSource | undefined): Buffer | undefined {
  return source && createHash("sha256").update("zhixing-frame-index-source\0")
    .update(source.dev.toString()).update("\0").update(source.ino.toString()).digest();
}

function pageMacInput(logIdBytes: Buffer, epoch: Buffer, page: number, rows: Buffer): Buffer[] {
  const head = Buffer.alloc(8);
  head.writeUInt16BE(FORMAT, 0);
  head.writeUInt32BE(page, 4);
  return [head, logIdBytes, epoch, rows];
}

interface SealContents {
  readonly sourceBinding?: Buffer;
  readonly epoch: Buffer;
  readonly fullPages: number;
  readonly partial: Buffer;
  readonly headLsn: number;
  readonly headFrameEnd: number;
  readonly headPrefix: string;
}

/**
 * 一个日志的认证帧索引视图。实例只在持有日志写者锁的操作内使用；行按 LSN 连续，从 1 开始。
 */
export class AuthenticatedFrameIndex {
  readonly #rowsPath: string;
  readonly #sealPath: string;
  readonly #logIdBytes: Buffer;
  readonly #dataStart: number;
  readonly #emptyPrefix: string;
  readonly #sourceBinding: Buffer | undefined;
  #epoch: Buffer;
  /** 行文件中已认证落盘、且被本实例写过或读过的封条承认的整页数。 */
  #persistedPages: number;
  /** 第 persistedPages 页起、尚未写成整页的行（含封条里的未满页）。 */
  #memoryRows: Buffer[];
  #headLsn: number;
  #headFrameEnd: number;
  #headPrefix: string;
  readonly #pages = new Map<number, Buffer>();
  #dirty = false;
  #sealedLsn = 0;
  #sealedFrameEnd = 0;

  private constructor(
    rootDir: string,
    logId: string,
    dataStart: number,
    emptyPrefix: string,
    seal: SealContents,
    readonly integrity?: AuthorityCacheIntegrity,
  ) {
    this.#rowsPath = path.join(rootDir, ROWS_FILE);
    this.#sealPath = path.join(rootDir, SEAL_FILE);
    this.#logIdBytes = Buffer.from(logId, "base64url");
    this.#dataStart = dataStart;
    this.#emptyPrefix = emptyPrefix;
    this.#sourceBinding = seal.sourceBinding;
    this.#epoch = seal.epoch;
    this.#persistedPages = seal.fullPages;
    this.#memoryRows = [];
    for (let offset = 0; offset < seal.partial.byteLength; offset += FRAME_INDEX_ROW_BYTES) {
      this.#memoryRows.push(Buffer.from(seal.partial.subarray(offset, offset + FRAME_INDEX_ROW_BYTES)));
    }
    this.#headLsn = seal.headLsn;
    this.#headFrameEnd = seal.headFrameEnd;
    this.#headPrefix = seal.headPrefix;
    this.#sealedLsn = seal.headLsn;
    this.#sealedFrameEnd = seal.headFrameEnd;
  }

  /** 新纪元的空索引：覆盖到日志数据区起点。文件在第一次 flush 时写出。 */
  static create(rootDir: string, logId: string, dataStart: number, emptyPrefix: string, integrity?: AuthorityCacheIntegrity, source?: FrameIndexSource): AuthenticatedFrameIndex {
    const index = new AuthenticatedFrameIndex(rootDir, logId, dataStart, emptyPrefix, {
      epoch: randomBytes(EPOCH_BYTES), fullPages: 0, partial: Buffer.alloc(0),
      headLsn: 0, headFrameEnd: dataStart, headPrefix: emptyPrefix,
      ...(source ? { sourceBinding: sourceBinding(source)! } : {}),
    }, integrity);
    index.#dirty = true;
    return index;
  }

  /**
   * 读取并认证封条。封条缺失、认证不过、格式或日志身份不符、行文件短于封条承认的整页时返回
   * undefined；调用方据此完整核验并重建。
   */
  static async open(rootDir: string, logId: string, dataStart: number, emptyPrefix: string, integrity?: AuthorityCacheIntegrity, source?: FrameIndexSource): Promise<AuthenticatedFrameIndex | undefined> {
    const sealPath = path.join(rootDir, SEAL_FILE);
    const bytes = await readSealBytes(sealPath);
    if (!bytes) return undefined;
    const logIdBytes = Buffer.from(logId, "base64url");
    const seal = decodeSeal(bytes, logIdBytes, dataStart, emptyPrefix, integrity, sourceBinding(source));
    if (!seal) return undefined;
    if (seal.fullPages > 0) {
      const rows = await open(path.join(rootDir, ROWS_FILE), "r").catch(missingFile);
      if (!rows) return undefined;
      try {
        const size = Number((await rows.stat({ bigint: true })).size);
        if (size < ROWS_HEADER_BYTES + seal.fullPages * PAGE_RECORD_BYTES) return undefined;
        const header = Buffer.alloc(ROWS_HEADER_BYTES);
        const { bytesRead } = await rows.read(header, 0, ROWS_HEADER_BYTES, 0);
        if (bytesRead !== ROWS_HEADER_BYTES || !rowsHeaderMatches(header, logIdBytes, seal.epoch)) return undefined;
      } finally {
        await rows.close();
      }
    }
    return new AuthenticatedFrameIndex(rootDir, logId, dataStart, emptyPrefix, seal, integrity);
  }

  /** 删除索引文件；下次打开时完整核验并重建。 */
  static async discard(rootDir: string): Promise<void> {
    await durablyRemoveFiles([path.join(rootDir, SEAL_FILE), path.join(rootDir, ROWS_FILE)]).catch(missingFile);
  }

  get headLsn(): number { return this.#headLsn; }
  get headFrameEnd(): number { return this.#headFrameEnd; }
  get headPrefix(): string { return this.#headPrefix; }
  /** 有尚未写出的行或纪元尚未落盘。 */
  get dirty(): boolean { return this.#dirty; }
  get sealedLsn(): number { return this.#sealedLsn; }
  get sealedFrameEnd(): number { return this.#sealedFrameEnd; }

  /** 追加下一帧的行；必须与当前头部首尾相接。 */
  append(row: FrameIndexAppend): void {
    if (row.format !== undefined && row.format !== "legacy" && row.format !== "versioned") throw new FrameIndexUnavailableError("Frame index frame format is invalid");
    if ((row.format === "legacy") !== !!this.#sourceBinding) throw new FrameIndexUnavailableError("Frame index frame format does not match its source");
    const expectedEnd = this.#headFrameEnd + AUTHORITY_WAL_HEADER_BYTES + row.payloadBytes + trailerBytes(row.format ?? "versioned");
    if (!Number.isSafeInteger(row.frameEndOffset) || !Number.isSafeInteger(this.#headLsn + 1) ||
        !Number.isSafeInteger(row.payloadBytes) || row.payloadBytes < 1 || row.payloadBytes > AUTHORITY_WAL_MAX_PAYLOAD_BYTES ||
        row.frameEndOffset !== expectedEnd || row.payloadDigest.byteLength !== 32 ||
        !/^sha256:[a-f0-9]{64}$/u.test(row.prefixDigest)) {
      throw new FrameIndexUnavailableError("Frame index row does not extend its head");
    }
    this.#memoryRows.push(encodeRow(row));
    this.#headLsn += 1;
    this.#headFrameEnd = row.frameEndOffset;
    this.#headPrefix = row.prefixDigest;
    this.#dirty = true;
  }

  /** 第 `lsn` 帧的认证行（1 ≤ lsn ≤ headLsn）。 */
  async row(lsn: number): Promise<FrameIndexRow> {
    if (!Number.isSafeInteger(lsn) || lsn < 1 || lsn > this.#headLsn) {
      throw new FrameIndexUnavailableError(`Frame index has no row for LSN ${lsn}`);
    }
    const index = lsn - 1;
    const page = Math.floor(index / FRAME_INDEX_ROWS_PER_PAGE);
    if (page >= this.#persistedPages) {
      const memoryIndex = index - this.#persistedPages * FRAME_INDEX_ROWS_PER_PAGE;
      return decodeRow(this.#memoryRows[memoryIndex]!, lsn);
    }
    const rows = await this.#page(page);
    const offset = (index % FRAME_INDEX_ROWS_PER_PAGE) * FRAME_INDEX_ROW_BYTES;
    return decodeRow(rows.subarray(offset, offset + FRAME_INDEX_ROW_BYTES), lsn);
  }

  /** 预先认证覆盖 [fromLsn, toLsn] 的落盘索引页，使随后的逐行读取不再因索引不可用而中断。 */
  async ensureRows(fromLsn: number, toLsn: number): Promise<void> {
    const last = Math.min(toLsn, this.#headLsn);
    if (fromLsn > last) return;
    const firstPage = Math.floor((Math.max(1, fromLsn) - 1) / FRAME_INDEX_ROWS_PER_PAGE);
    const lastPage = Math.min(Math.floor((last - 1) / FRAME_INDEX_ROWS_PER_PAGE), this.#persistedPages - 1);
    for (let page = firstPage; page <= lastPage; page += 1) await this.#page(page);
  }

  /**
   * 按页遍历 [fromLsn, toLsn] 的原始行（每行 88 字节的只读视图）：每页只等待一次，页内同步回调；
   * 回调返回 false 时停止。只为调用方真正需要的行解码，筛选不产生逐行分配。
   */
  async scanRows(fromLsn: number, toLsn: number, visit: (lsn: number, row: Buffer) => boolean | void): Promise<void> {
    const last = Math.min(toLsn, this.#headLsn);
    let lsn = Math.max(1, fromLsn);
    while (lsn <= last) {
      const page = Math.floor((lsn - 1) / FRAME_INDEX_ROWS_PER_PAGE);
      const pageEnd = Math.min(last, (page + 1) * FRAME_INDEX_ROWS_PER_PAGE);
      if (page < this.#persistedPages) {
        const rows = await this.#page(page);
        for (; lsn <= pageEnd; lsn += 1) {
          const offset = ((lsn - 1) % FRAME_INDEX_ROWS_PER_PAGE) * FRAME_INDEX_ROW_BYTES;
          if (visit(lsn, rows.subarray(offset, offset + FRAME_INDEX_ROW_BYTES)) === false) return;
        }
      } else {
        const base = this.#persistedPages * FRAME_INDEX_ROWS_PER_PAGE;
        for (; lsn <= pageEnd; lsn += 1) {
          if (visit(lsn, this.#memoryRows[lsn - 1 - base]!) === false) return;
        }
      }
    }
  }

  /** 前一帧边界：LSN 0 为数据区起点与空前缀。 */
  async boundary(lsn: number): Promise<{ readonly frameEndOffset: number; readonly prefixDigest: string }> {
    if (lsn === 0) return { frameEndOffset: this.#dataStart, prefixDigest: this.#emptyPrefix };
    const row = await this.row(lsn);
    return { frameEndOffset: row.frameEndOffset, prefixDigest: row.prefixDigest };
  }

  async #page(page: number): Promise<Buffer> {
    const cached = this.#pages.get(page);
    if (cached) {
      this.#pages.delete(page);
      this.#pages.set(page, cached);
      return cached;
    }
    const handle = await open(this.#rowsPath, "r").catch(missingFile);
    if (!handle) throw new FrameIndexUnavailableError("Frame index rows are missing");
    let record: Buffer;
    try {
      record = Buffer.allocUnsafe(PAGE_RECORD_BYTES);
      const { bytesRead } = await handle.read(record, 0, PAGE_RECORD_BYTES, ROWS_HEADER_BYTES + page * PAGE_RECORD_BYTES);
      if (bytesRead !== PAGE_RECORD_BYTES) throw new FrameIndexUnavailableError("Frame index page is incomplete");
    } finally {
      await handle.close();
    }
    const rows = record.subarray(0, PAGE_BYTES);
    if (!frameIndexMacMatches("frame-index-page", pageMacInput(this.#logIdBytes, this.#epoch, page, rows), record.subarray(PAGE_BYTES), this.integrity)) {
      throw new FrameIndexUnavailableError("Frame index page failed authentication");
    }
    validateRows(rows, page === 0 ? this.#dataStart : undefined, !!this.#sourceBinding);
    if (this.#pages.size >= PAGE_CACHE_LIMIT) this.#pages.delete(this.#pages.keys().next().value!);
    this.#pages.set(page, rows);
    return rows;
  }

  /**
   * 写出整页与新封条（调用方持有日志写者锁）。磁盘上若已有更新或属于其他纪元的封条，本实例
   * 不覆盖它；索引只是缓存，写不成只让下次启动多续扫一段尾部。
   */
  async flush(): Promise<void> {
    if (!this.#dirty) return;
    if (!frameIndexMac("frame-index-seal", [], this.integrity)) return;
    const existing = await readSealBytes(this.#sealPath);
    const disk = existing ? decodeSeal(existing, this.#logIdBytes, this.#dataStart, this.#emptyPrefix, this.integrity, this.#sourceBinding) : undefined;
    let basePages = this.#persistedPages;
    if (disk) {
      // 磁盘上是其他纪元（已被重建）：不在别人的行文件上续写。
      if (!disk.epoch.equals(this.#epoch)) return;
      if (disk.headLsn >= this.#headLsn) {
        if (disk.headLsn !== this.#headLsn || disk.headFrameEnd !== this.#headFrameEnd || disk.headPrefix !== this.#headPrefix) throw new FrameIndexUnavailableError("A newer frame-index publication must be reopened");
        await syncDirectory(path.dirname(this.#sealPath));
        this.#sealedLsn = this.#headLsn; this.#sealedFrameEnd = this.#headFrameEnd;
        this.#dirty = false;
        return;
      }
      if (disk.fullPages < this.#persistedPages) return;
      basePages = disk.fullPages;
    } else if (this.#persistedPages > 0) {
      // 本实例已有落盘页而封条被删除：索引已被放弃，不再续写。
      return;
    }
    const skip = (basePages - this.#persistedPages) * FRAME_INDEX_ROWS_PER_PAGE;
    if (skip > this.#memoryRows.length) return;
    const pending = this.#memoryRows.slice(skip);
    const completePages = Math.floor(pending.length / FRAME_INDEX_ROWS_PER_PAGE);
    if (basePages === 0 && completePages > 0) {
      await writeRowsHeader(this.#rowsPath, this.#logIdBytes, this.#epoch);
    }
    if (completePages > 0) {
      const handle = await open(this.#rowsPath, "r+");
      try {
        await handle.truncate(ROWS_HEADER_BYTES + basePages * PAGE_RECORD_BYTES);
        const records: Buffer[] = [];
        for (let page = 0; page < completePages; page += 1) {
          const rows = Buffer.concat(pending.slice(page * FRAME_INDEX_ROWS_PER_PAGE, (page + 1) * FRAME_INDEX_ROWS_PER_PAGE));
          const pageMac = frameIndexMac("frame-index-page", pageMacInput(this.#logIdBytes, this.#epoch, basePages + page, rows), this.integrity);
          if (!pageMac) return;
          records.push(rows, pageMac);
        }
        await writeAllAt(handle, Buffer.concat(records), ROWS_HEADER_BYTES + basePages * PAGE_RECORD_BYTES);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const fullPages = basePages + completePages;
    const partial = Buffer.concat(pending.slice(completePages * FRAME_INDEX_ROWS_PER_PAGE));
    const sealBytes = encodeSeal(this.#logIdBytes, {
      epoch: this.#epoch, fullPages, partial,
      headLsn: this.#headLsn, headFrameEnd: this.#headFrameEnd, headPrefix: this.#headPrefix,
      ...(this.#sourceBinding ? { sourceBinding: this.#sourceBinding } : {}),
    }, this.integrity);
    if (!sealBytes) return;
    const temporary = `${this.#sealPath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "w", 0o600);
      try {
        await writeAllAt(handle, sealBytes, 0);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#sealPath);
      await syncDirectory(path.dirname(this.#sealPath));
    } catch (error) {
      await rm(temporary, { force: true }).catch(missingFile);
      throw error;
    }
    this.#memoryRows = pending.slice(completePages * FRAME_INDEX_ROWS_PER_PAGE);
    this.#persistedPages = fullPages;
    this.#sealedLsn = this.#headLsn; this.#sealedFrameEnd = this.#headFrameEnd;
    this.#dirty = false;
  }
}

function rowsHeaderMatches(header: Buffer, logIdBytes: Buffer, epoch: Buffer): boolean {
  return header.subarray(0, 4).equals(ROWS_MAGIC) && header.readUInt16BE(4) === FORMAT &&
    header.readUInt16BE(6) === FRAME_INDEX_ROW_BYTES && header.readUInt32BE(8) === FRAME_INDEX_ROWS_PER_PAGE &&
    header.subarray(12, 28).equals(epoch) && header.readUInt32BE(28) === 0 && header.subarray(32, 64).equals(logIdBytes);
}

async function writeRowsHeader(file: string, logIdBytes: Buffer, epoch: Buffer): Promise<void> {
  const header = Buffer.alloc(ROWS_HEADER_BYTES);
  ROWS_MAGIC.copy(header, 0);
  header.writeUInt16BE(FORMAT, 4);
  header.writeUInt16BE(FRAME_INDEX_ROW_BYTES, 6);
  header.writeUInt32BE(FRAME_INDEX_ROWS_PER_PAGE, 8);
  epoch.copy(header, 12);
  logIdBytes.copy(header, 32);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await writeAllAt(handle, header, 0);
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(missingFile);
    throw error;
  }
}

async function writeAllAt(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, position + written);
    written += result.bytesWritten;
  }
}

function encodeSeal(logIdBytes: Buffer, seal: SealContents, integrity?: AuthorityCacheIntegrity): Buffer | undefined {
  const fixed = Buffer.alloc(SEAL_FIXED_BYTES);
  SEAL_MAGIC.copy(fixed, 0);
  fixed.writeUInt16BE(FORMAT, 4);
  if (seal.sourceBinding) fixed.writeUInt16BE(SOURCE_BINDING_FLAG, 6);
  logIdBytes.copy(fixed, 8);
  seal.epoch.copy(fixed, 40);
  fixed.writeUInt32BE(seal.fullPages, 56);
  fixed.writeUInt32BE(seal.partial.byteLength / FRAME_INDEX_ROW_BYTES, 60);
  fixed.writeBigUInt64BE(BigInt(seal.headLsn), 64);
  fixed.writeBigUInt64BE(BigInt(seal.headFrameEnd), 72);
  Buffer.from(seal.headPrefix.slice("sha256:".length), "hex").copy(fixed, 80);
  const body = Buffer.concat([fixed, seal.partial, ...(seal.sourceBinding ? [seal.sourceBinding] : [])]);
  const mac = frameIndexMac("frame-index-seal", [body], integrity);
  return mac && Buffer.concat([body, mac]);
}

function decodeSeal(bytes: Buffer, logIdBytes: Buffer, dataStart: number, emptyPrefix: string, integrity?: AuthorityCacheIntegrity, expectedBinding?: Buffer): SealContents | undefined {
  if (bytes.byteLength < SEAL_FIXED_BYTES + MAC_BYTES) return undefined;
  const body = bytes.subarray(0, bytes.byteLength - MAC_BYTES);
  if (!body.subarray(0, 4).equals(SEAL_MAGIC) || body.readUInt16BE(4) !== FORMAT ||
      !body.subarray(8, 40).equals(logIdBytes)) return undefined;
  const fullPages = body.readUInt32BE(56);
  const partialRows = body.readUInt32BE(60);
  const flags = body.readUInt16BE(6);
  if ((flags & ~SOURCE_BINDING_FLAG) !== 0 || !!(flags & SOURCE_BINDING_FLAG) !== !!expectedBinding) return undefined;
  const partialEnd = SEAL_FIXED_BYTES + partialRows * FRAME_INDEX_ROW_BYTES;
  if (partialRows >= FRAME_INDEX_ROWS_PER_PAGE ||
      body.byteLength !== partialEnd + (expectedBinding ? SOURCE_BINDING_BYTES : 0)) return undefined;
  if (!frameIndexMacMatches("frame-index-seal", [body], bytes.subarray(bytes.byteLength - MAC_BYTES), integrity)) return undefined;
  if (expectedBinding && !body.subarray(partialEnd).equals(expectedBinding)) return undefined;
  const headLsn = Number(body.readBigUInt64BE(64));
  const headFrameEnd = Number(body.readBigUInt64BE(72));
  const headPrefix = `sha256:${body.subarray(80, 112).toString("hex")}`;
  if (!Number.isSafeInteger(headLsn) || headLsn !== fullPages * FRAME_INDEX_ROWS_PER_PAGE + partialRows ||
      !Number.isSafeInteger(headFrameEnd) || headFrameEnd < dataStart) return undefined;
  if (headLsn === 0 && (headFrameEnd !== dataStart || headPrefix !== emptyPrefix)) return undefined;
  const partial = Buffer.from(body.subarray(SEAL_FIXED_BYTES, partialEnd));
  try { validateRows(partial, fullPages === 0 ? dataStart : undefined, !!expectedBinding); }
  catch (error) { if (error instanceof FrameIndexUnavailableError) return undefined; throw error; }
  // 头部指针必须与最后一行一致（最后一行在未满页里时可直接核对）。
  if (partialRows > 0) {
    const last = decodeRow(partial.subarray((partialRows - 1) * FRAME_INDEX_ROW_BYTES), headLsn);
    if (last.frameEndOffset !== headFrameEnd || last.prefixDigest !== headPrefix) return undefined;
  }
  return { epoch: Buffer.from(body.subarray(40, 56)), fullPages, partial, headLsn, headFrameEnd, headPrefix,
    ...(expectedBinding ? { sourceBinding: Buffer.from(expectedBinding) } : {}) };
}

/** A malformed derived seal cannot force an unbounded startup allocation/read. */
async function readSealBytes(file: string): Promise<Buffer | undefined> {
  const handle = await open(file, "r").catch(missingFile);
  if (!handle) return undefined;
  try {
    const size = (await handle.stat()).size;
    if (!Number.isSafeInteger(size) || size < SEAL_FIXED_BYTES + MAC_BYTES || size > MAX_SEAL_BYTES) return undefined;
    const bytes = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(bytes, 0, size, 0);
    return bytesRead === size ? bytes : undefined;
  } finally { await handle.close(); }
}

function missingFile(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  throw error;
}
