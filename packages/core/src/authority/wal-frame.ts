import { createHash } from "node:crypto";
import { AuthorityStorageError } from "./errors.js";

const FILE_MAGIC = 0x5a584148;
const FILE_FORMAT_VERSION = 2;
const HEADER_MAGIC = 0x5a58414c;
const TRAILER_MAGIC = 0x4c41585a;
const LEGACY_FRAME_VERSION = 1;
const FRAME_VERSION = 2;

export const AUTHORITY_WAL_FILE_HEADER_BYTES = 72;
export const AUTHORITY_WAL_HEADER_BYTES = 16;
export const AUTHORITY_WAL_TRAILER_BYTES = 84;
export const AUTHORITY_WAL_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const LEGACY_TRAILER_BYTES = 12;
const PREFIX_BYTES = 32;

export interface AuthorityWalFileHeader {
  readonly formatVersion: 2;
  readonly logId: string;
}

export interface AuthorityWalFrameMetadata {
  readonly lsn: number;
  readonly prefixDigest: string;
}

export type DecodedAuthorityWalFrame =
  | {
      readonly kind: "complete";
      readonly payload: Buffer;
      readonly nextOffset: number;
      readonly metadata?: AuthorityWalFrameMetadata;
    }
  | { readonly kind: "incomplete" };

export interface AuthorityWalReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface AuthorityWalScanResult {
  readonly frameCount: number;
  readonly validBytes: number;
  readonly incompleteTail?: Buffer;
  readonly stopped?: true;
}

export function encodeAuthorityWalFileHeader(logIdBytes: Uint8Array): Buffer {
  if (logIdBytes.byteLength !== 32) {
    throw new TypeError("Authority WAL log id must contain exactly 32 bytes");
  }
  const header = Buffer.alloc(AUTHORITY_WAL_FILE_HEADER_BYTES);
  header.writeUInt32BE(FILE_MAGIC, 0);
  header.writeUInt16BE(FILE_FORMAT_VERSION, 4);
  header.writeUInt16BE(AUTHORITY_WAL_FILE_HEADER_BYTES, 6);
  Buffer.from(logIdBytes).copy(header, 8);
  checksum(header.subarray(0, 40)).copy(header, 40);
  return header;
}

export interface AuthorityWalFrameBoundary {
  readonly frameStartOffset: number;
  /**
   * 帧级锚点。仅 versioned 帧携带:legacy 帧的 trailer 只有 magic、长度与补码,
   * 没有 lsn 与前缀摘要,因此按 checkpoint 定位后无法再做帧级身份复验。
   */
  readonly metadata?: AuthorityWalFrameMetadata;
}

export function decodeAuthorityWalFileHeader(
  bytes: Uint8Array,
): AuthorityWalFileHeader {
  if (bytes.byteLength !== AUTHORITY_WAL_FILE_HEADER_BYTES) {
    throw corruptFrame("Authority WAL file header length is invalid");
  }
  const header = Buffer.from(bytes);
  if (
    header.readUInt32BE(0) !== FILE_MAGIC ||
    header.readUInt16BE(4) !== FILE_FORMAT_VERSION ||
    header.readUInt16BE(6) !== AUTHORITY_WAL_FILE_HEADER_BYTES ||
    !checksum(header.subarray(0, 40)).equals(header.subarray(40, 72))
  ) {
    throw corruptFrame("Authority WAL file header is invalid");
  }
  return {
    formatVersion: 2,
    logId: header.subarray(8, 40).toString("base64url"),
  };
}

export function encodeAuthorityWalFrame(
  payload: Uint8Array,
  metadata?: AuthorityWalFrameMetadata,
): Buffer {
  if (payload.byteLength === 0 || payload.byteLength > AUTHORITY_WAL_MAX_PAYLOAD_BYTES) {
    throw new TypeError(
      `Authority WAL payload must contain 1-${AUTHORITY_WAL_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  if (metadata !== undefined) assertFrameMetadata(metadata);
  const length = payload.byteLength;
  const complement = lengthComplement(length);
  const trailerBytes =
    metadata === undefined ? LEGACY_TRAILER_BYTES : AUTHORITY_WAL_TRAILER_BYTES;
  const frame = Buffer.allocUnsafe(
    AUTHORITY_WAL_HEADER_BYTES + length + trailerBytes,
  );
  frame.writeUInt32BE(HEADER_MAGIC, 0);
  frame.writeUInt16BE(metadata === undefined ? LEGACY_FRAME_VERSION : FRAME_VERSION, 4);
  frame.writeUInt16BE(AUTHORITY_WAL_HEADER_BYTES, 6);
  frame.writeUInt32BE(length, 8);
  frame.writeUInt32BE(complement, 12);
  Buffer.from(payload).copy(frame, AUTHORITY_WAL_HEADER_BYTES);
  const trailerOffset = AUTHORITY_WAL_HEADER_BYTES + length;
  frame.writeUInt32BE(TRAILER_MAGIC, trailerOffset);
  frame.writeUInt32BE(length, trailerOffset + 4);
  frame.writeUInt32BE(complement, trailerOffset + 8);
  if (metadata !== undefined) {
    frame.writeBigUInt64BE(BigInt(metadata.lsn), trailerOffset + 12);
    Buffer.from(metadata.prefixDigest.slice("sha256:".length), "hex").copy(
      frame,
      trailerOffset + 20,
    );
    checksum(frame.subarray(trailerOffset, trailerOffset + 52)).copy(
      frame,
      trailerOffset + 52,
    );
  }
  return frame;
}

export function decodeAuthorityWalFrame(
  data: Uint8Array,
  offset: number,
): DecodedAuthorityWalFrame {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.byteLength) {
    throw new TypeError("Authority WAL frame offset is invalid");
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const remaining = bytes.byteLength - offset;
  if (remaining < AUTHORITY_WAL_HEADER_BYTES) return { kind: "incomplete" };

  const { payloadBytes, payloadComplement, version } =
    decodeFrameHeader(bytes, offset);

  const payloadStart = offset + AUTHORITY_WAL_HEADER_BYTES;
  const trailerOffset = payloadStart + payloadBytes;
  const trailerBytes =
    version === LEGACY_FRAME_VERSION
      ? LEGACY_TRAILER_BYTES
      : AUTHORITY_WAL_TRAILER_BYTES;
  const nextOffset = trailerOffset + trailerBytes;
  if (nextOffset > bytes.byteLength) return { kind: "incomplete" };

  const trailerMagic = bytes.readUInt32BE(trailerOffset);
  const trailerPayloadBytes = bytes.readUInt32BE(trailerOffset + 4);
  const trailerComplement = bytes.readUInt32BE(trailerOffset + 8);
  if (
    trailerMagic !== TRAILER_MAGIC ||
    trailerPayloadBytes !== payloadBytes ||
    trailerComplement !== payloadComplement ||
    (
      version === FRAME_VERSION &&
      !checksum(bytes.subarray(trailerOffset, trailerOffset + 52)).equals(
        bytes.subarray(trailerOffset + 52, trailerOffset + 84),
      )
    )
  ) {
    throw corruptFrame(`Authority WAL frame trailer is invalid at byte ${trailerOffset}`);
  }

  if (version === FRAME_VERSION) {
    const rawLsn = bytes.readBigUInt64BE(trailerOffset + 12);
    if (rawLsn > BigInt(Number.MAX_SAFE_INTEGER) || rawLsn === 0n) {
      throw corruptFrame(`Authority WAL frame LSN is invalid at byte ${trailerOffset}`);
    }
    return {
      kind: "complete",
      payload: bytes.subarray(payloadStart, trailerOffset),
      nextOffset,
      metadata: {
        lsn: Number(rawLsn),
        prefixDigest:
          `sha256:${bytes.subarray(trailerOffset + 20, trailerOffset + 20 + PREFIX_BYTES).toString("hex")}`,
      },
    };
  }
  return {
    kind: "complete",
    payload: bytes.subarray(payloadStart, trailerOffset),
    nextOffset,
  };
}

export async function scanAuthorityWalFrames(
  reader: AuthorityWalReader,
  visit: (
    payload: Buffer,
    offset: number,
    metadata: AuthorityWalFrameMetadata | undefined,
    nextOffset: number,
  ) => boolean | void | Promise<boolean | void>,
): Promise<AuthorityWalScanResult> {
  if (!Number.isSafeInteger(reader.size) || reader.size < 0) {
    throw new TypeError("Authority WAL reader size is invalid");
  }

  let offset = 0;
  let frameCount = 0;
  while (offset < reader.size) {
    const remaining = reader.size - offset;
    const headerLength = Math.min(AUTHORITY_WAL_HEADER_BYTES, remaining);
    const header = await readExact(reader, offset, headerLength);
    if (headerLength < AUTHORITY_WAL_HEADER_BYTES) {
      return { frameCount, validBytes: offset, incompleteTail: header };
    }

    const { payloadBytes, version } = decodeFrameHeader(header, 0, offset);
    const trailerBytes =
      version === LEGACY_FRAME_VERSION
        ? LEGACY_TRAILER_BYTES
        : AUTHORITY_WAL_TRAILER_BYTES;
    const frameBytes =
      AUTHORITY_WAL_HEADER_BYTES + payloadBytes + trailerBytes;
    const remainderLength = Math.min(
      frameBytes - AUTHORITY_WAL_HEADER_BYTES,
      remaining - AUTHORITY_WAL_HEADER_BYTES,
    );
    const remainder = await readExact(
      reader,
      offset + AUTHORITY_WAL_HEADER_BYTES,
      remainderLength,
    );
    const frame = Buffer.concat([header, remainder], headerLength + remainderLength);
    if (remaining < frameBytes) {
      return { frameCount, validBytes: offset, incompleteTail: frame };
    }

    const decoded = decodeAuthorityWalFrame(frame, 0);
    if (decoded.kind !== "complete" || decoded.nextOffset !== frameBytes) {
      throw corruptFrame(`Authority WAL frame is incomplete at byte ${offset}`);
    }
    const shouldContinue = await visit(
      decoded.payload,
      offset,
      decoded.metadata,
      offset + frameBytes,
    );
    offset += frameBytes;
    frameCount += 1;
    if (shouldContinue === false && offset < reader.size) {
      return { frameCount, validBytes: offset, stopped: true };
    }
  }
  return { frameCount, validBytes: offset };
}

function decodeFrameHeader(
  bytes: Buffer,
  offset: number,
  reportedOffset = offset,
): {
  payloadBytes: number;
  payloadComplement: number;
  version: 1 | 2;
} {
  const magic = bytes.readUInt32BE(offset);
  const version = bytes.readUInt16BE(offset + 4);
  const headerBytes = bytes.readUInt16BE(offset + 6);
  const payloadBytes = bytes.readUInt32BE(offset + 8);
  const payloadComplement = bytes.readUInt32BE(offset + 12);
  if (
    magic !== HEADER_MAGIC ||
    (version !== LEGACY_FRAME_VERSION && version !== FRAME_VERSION) ||
    headerBytes !== AUTHORITY_WAL_HEADER_BYTES ||
    payloadBytes === 0 ||
    payloadBytes > AUTHORITY_WAL_MAX_PAYLOAD_BYTES ||
    payloadComplement !== lengthComplement(payloadBytes)
  ) {
    throw corruptFrame(`Authority WAL frame header is invalid at byte ${reportedOffset}`);
  }
  return {
    payloadBytes,
    payloadComplement,
    version: version as 1 | 2,
  };
}

export async function verifyAuthorityWalFrameBoundary(
  reader: AuthorityWalReader,
  frameEndOffset: number,
): Promise<AuthorityWalFrameBoundary> {
  if (
    !Number.isSafeInteger(frameEndOffset) ||
    frameEndOffset > reader.size ||
    frameEndOffset < AUTHORITY_WAL_HEADER_BYTES + LEGACY_TRAILER_BYTES
  ) {
    throw corruptFrame("Authority WAL checkpoint boundary is invalid");
  }
  // 写侧按格式分支写两种 trailer,读侧必须对称:先按完整 trailer 认 versioned,
  // 不成立再按短 trailer 认 legacy。顺序不能反——legacy 帧的 84 字节回看会落进
  // payload,而 versioned 帧的末 12 字节是校验和片段,反过来试会把它误判成 legacy。
  const versioned = await tryFrameBoundary(
    reader,
    frameEndOffset,
    AUTHORITY_WAL_TRAILER_BYTES,
    FRAME_VERSION,
  );
  if (versioned) return versioned;
  const legacy = await tryFrameBoundary(
    reader,
    frameEndOffset,
    LEGACY_TRAILER_BYTES,
    LEGACY_FRAME_VERSION,
  );
  if (legacy) return legacy;
  throw corruptFrame("Authority WAL checkpoint trailer is invalid");
}

async function tryFrameBoundary(
  reader: AuthorityWalReader,
  frameEndOffset: number,
  trailerBytes: number,
  expectedVersion: number,
): Promise<AuthorityWalFrameBoundary | undefined> {
  const trailerOffset = frameEndOffset - trailerBytes;
  if (trailerOffset < AUTHORITY_WAL_HEADER_BYTES) return undefined;
  const trailer = await readExact(reader, trailerOffset, trailerBytes);
  const trailerMagic = trailer.readUInt32BE(0);
  const payloadBytes = trailer.readUInt32BE(4);
  const payloadComplement = trailer.readUInt32BE(8);
  if (
    trailerMagic !== TRAILER_MAGIC ||
    payloadBytes === 0 ||
    payloadBytes > AUTHORITY_WAL_MAX_PAYLOAD_BYTES ||
    payloadComplement !== lengthComplement(payloadBytes)
  ) {
    return undefined;
  }
  if (
    trailerBytes === AUTHORITY_WAL_TRAILER_BYTES &&
    !checksum(trailer.subarray(0, 52)).equals(trailer.subarray(52, 84))
  ) {
    return undefined;
  }
  const frameStartOffset =
    trailerOffset - payloadBytes - AUTHORITY_WAL_HEADER_BYTES;
  if (frameStartOffset < 0) return undefined;
  const header = await readExact(
    reader,
    frameStartOffset,
    AUTHORITY_WAL_HEADER_BYTES,
  );
  let decoded;
  try {
    decoded = decodeFrameHeader(header, 0, frameStartOffset);
  } catch {
    return undefined;
  }
  if (
    decoded.version !== expectedVersion ||
    decoded.payloadBytes !== payloadBytes ||
    decoded.payloadComplement !== payloadComplement
  ) {
    return undefined;
  }
  if (trailerBytes === LEGACY_TRAILER_BYTES) {
    return { frameStartOffset };
  }
  const rawLsn = trailer.readBigUInt64BE(12);
  if (rawLsn > BigInt(Number.MAX_SAFE_INTEGER) || rawLsn === 0n) {
    throw corruptFrame("Authority WAL checkpoint LSN is invalid");
  }
  return {
    frameStartOffset,
    metadata: {
      lsn: Number(rawLsn),
      prefixDigest: `sha256:${trailer.subarray(20, 52).toString("hex")}`,
    },
  };
}

function assertFrameMetadata(metadata: AuthorityWalFrameMetadata): void {
  if (!Number.isSafeInteger(metadata.lsn) || metadata.lsn <= 0) {
    throw new TypeError("Authority WAL frame LSN must be a positive safe integer");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(metadata.prefixDigest)) {
    throw new TypeError("Authority WAL frame prefix digest is invalid");
  }
}

function checksum(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

async function readExact(
  reader: AuthorityWalReader,
  offset: number,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.from(await reader.read(offset, length));
  if (bytes.byteLength !== length) {
    throw corruptFrame(`Authority WAL changed while reading at byte ${offset}`);
  }
  return bytes;
}

function lengthComplement(length: number): number {
  return (length ^ 0xffff_ffff) >>> 0;
}

function corruptFrame(message: string): AuthorityStorageError {
  return new AuthorityStorageError("commit-log-corrupt", message);
}
