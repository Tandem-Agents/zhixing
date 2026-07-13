import { AuthorityStorageError } from "./errors.js";

const HEADER_MAGIC = 0x5a58414c;
const TRAILER_MAGIC = 0x4c41585a;
const FRAME_VERSION = 1;

export const AUTHORITY_WAL_HEADER_BYTES = 16;
export const AUTHORITY_WAL_TRAILER_BYTES = 12;
export const AUTHORITY_WAL_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export type DecodedAuthorityWalFrame =
  | { readonly kind: "complete"; readonly payload: Buffer; readonly nextOffset: number }
  | { readonly kind: "incomplete" };

export interface AuthorityWalReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface AuthorityWalScanResult {
  readonly frameCount: number;
  readonly validBytes: number;
  readonly incompleteTail?: Buffer;
}

export function encodeAuthorityWalFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength === 0 || payload.byteLength > AUTHORITY_WAL_MAX_PAYLOAD_BYTES) {
    throw new TypeError(
      `Authority WAL payload must contain 1-${AUTHORITY_WAL_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  const length = payload.byteLength;
  const complement = lengthComplement(length);
  const frame = Buffer.allocUnsafe(
    AUTHORITY_WAL_HEADER_BYTES + length + AUTHORITY_WAL_TRAILER_BYTES,
  );
  frame.writeUInt32BE(HEADER_MAGIC, 0);
  frame.writeUInt16BE(FRAME_VERSION, 4);
  frame.writeUInt16BE(AUTHORITY_WAL_HEADER_BYTES, 6);
  frame.writeUInt32BE(length, 8);
  frame.writeUInt32BE(complement, 12);
  Buffer.from(payload).copy(frame, AUTHORITY_WAL_HEADER_BYTES);
  const trailerOffset = AUTHORITY_WAL_HEADER_BYTES + length;
  frame.writeUInt32BE(TRAILER_MAGIC, trailerOffset);
  frame.writeUInt32BE(length, trailerOffset + 4);
  frame.writeUInt32BE(complement, trailerOffset + 8);
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

  const { payloadBytes, payloadComplement } = decodeFrameHeader(bytes, offset);

  const payloadStart = offset + AUTHORITY_WAL_HEADER_BYTES;
  const trailerOffset = payloadStart + payloadBytes;
  const nextOffset = trailerOffset + AUTHORITY_WAL_TRAILER_BYTES;
  if (nextOffset > bytes.byteLength) return { kind: "incomplete" };

  const trailerMagic = bytes.readUInt32BE(trailerOffset);
  const trailerBytes = bytes.readUInt32BE(trailerOffset + 4);
  const trailerComplement = bytes.readUInt32BE(trailerOffset + 8);
  if (
    trailerMagic !== TRAILER_MAGIC ||
    trailerBytes !== payloadBytes ||
    trailerComplement !== payloadComplement
  ) {
    throw corruptFrame(`Authority WAL frame trailer is invalid at byte ${trailerOffset}`);
  }

  return {
    kind: "complete",
    payload: bytes.subarray(payloadStart, trailerOffset),
    nextOffset,
  };
}

export async function scanAuthorityWalFrames(
  reader: AuthorityWalReader,
  visit: (payload: Buffer, offset: number) => void | Promise<void>,
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

    const { payloadBytes } = decodeFrameHeader(header, 0, offset);
    const frameBytes =
      AUTHORITY_WAL_HEADER_BYTES + payloadBytes + AUTHORITY_WAL_TRAILER_BYTES;
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
    await visit(decoded.payload, offset);
    offset += frameBytes;
    frameCount += 1;
  }
  return { frameCount, validBytes: offset };
}

function decodeFrameHeader(
  bytes: Buffer,
  offset: number,
  reportedOffset = offset,
): { payloadBytes: number; payloadComplement: number } {
  const magic = bytes.readUInt32BE(offset);
  const version = bytes.readUInt16BE(offset + 4);
  const headerBytes = bytes.readUInt16BE(offset + 6);
  const payloadBytes = bytes.readUInt32BE(offset + 8);
  const payloadComplement = bytes.readUInt32BE(offset + 12);
  if (
    magic !== HEADER_MAGIC ||
    version !== FRAME_VERSION ||
    headerBytes !== AUTHORITY_WAL_HEADER_BYTES ||
    payloadBytes === 0 ||
    payloadBytes > AUTHORITY_WAL_MAX_PAYLOAD_BYTES ||
    payloadComplement !== lengthComplement(payloadBytes)
  ) {
    throw corruptFrame(`Authority WAL frame header is invalid at byte ${reportedOffset}`);
  }
  return { payloadBytes, payloadComplement };
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
