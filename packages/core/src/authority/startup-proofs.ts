import { createHash, createHmac, createSecretKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import type { DurableLogCheckpoint } from "./interfaces.js";

/** An immutable per-home capability injected by the composition owner. The
 * cache key authenticates derived bytes; it never determines WAL readability. */
export class AuthorityCacheIntegrity {
  // 每次以原始字节建 HMAC 都要重新导入密钥，代价是摘要本身的数倍；导入一次后复用。
  readonly #key: KeyObject;
  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new TypeError("Authority cache integrity key is unavailable");
    this.#key = createSecretKey(Buffer.from(key));
  }
  sign(domain: string, parts: readonly Uint8Array[]): Buffer {
    const hmac = createHmac("sha256", this.#key).update("zhixing-startup-proof\0" + domain + "\0", "utf8");
    for (const part of parts) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(part.byteLength, 0);
      hmac.update(length).update(part);
    }
    return hmac.digest();
  }
}

export interface HostAuthorityLogProfile {
  readonly verifiedViewLimits: { readonly bytes: number; readonly frames: number };
}
export const DEFAULT_HOST_AUTHORITY_LOG_PROFILE: HostAuthorityLogProfile = Object.freeze({
  verifiedViewLimits: Object.freeze({ bytes: 64 * 1024 * 1024, frames: 65_536 }),
});

function mac(domain: string, parts: readonly Uint8Array[], integrity?: AuthorityCacheIntegrity): Buffer | undefined {
  return integrity?.sign(domain, parts);
}
function macMatches(domain: string, parts: readonly Uint8Array[], candidate: Uint8Array,
  integrity?: AuthorityCacheIntegrity): boolean {
  const expected = mac(domain, parts, integrity);
  return expected !== undefined && candidate.byteLength === expected.byteLength && timingSafeEqual(expected, candidate);
}
export function frameIndexMac(domain: "frame-index-page" | "frame-index-seal", parts: readonly Uint8Array[],
  integrity?: AuthorityCacheIntegrity): Buffer | undefined {
  return mac(domain, parts, integrity);
}
export function projectionIndexMac(domain: "manifest" | "segment", parts: readonly Uint8Array[],
  integrity?: AuthorityCacheIntegrity): Buffer | undefined {
  return mac("projection-index-" + domain, parts, integrity);
}
export function frameIndexMacMatches(domain: "frame-index-page" | "frame-index-seal",
  parts: readonly Uint8Array[], candidate: Uint8Array, integrity?: AuthorityCacheIntegrity): boolean {
  return macMatches(domain, parts, candidate, integrity);
}

/**
 * 投影检查点的键：名称 + 归约版本 + 归约相关函数的源码指纹。归约逻辑或状态形状改变时必须
 * 提升版本；直接改动所列函数的函数体也会改变指纹，旧检查点随之不再被采用（只是多回放一次）。
 */
export function projectionCheckpointKey(
  name: string,
  version: number,
  ...reducers: readonly ((...args: never[]) => unknown)[]
): string {
  if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/u.test(name) || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError("Projection checkpoint key name or version is invalid");
  }
  const fingerprint = createHash("sha256").update("zhixing-projection-reducers\0");
  for (const reducer of reducers) fingerprint.update(Function.prototype.toString.call(reducer)).update("\0");
  return `${name}:v${version}:${fingerprint.digest("hex").slice(0, 16)}`;
}

const CHECKPOINT_MAGIC = Buffer.from("ZXPC3\n", "ascii");
/** 单个检查点的上限；超出时不写，读到时视为无效。 */
export const MAX_PROJECTION_CHECKPOINT_BYTES = 64 * 1024 * 1024;

interface CheckpointHeader {
  readonly key: string;
  readonly boundary: DurableLogCheckpoint;
  readonly stateBytes: number;
  readonly stateDigest: string;
  readonly mac: string;
}

function checkpointSealParts(header: Omit<CheckpointHeader, "mac">): Buffer[] {
  return [Buffer.from(JSON.stringify([
    header.key, header.boundary.logId, header.boundary.lsn,
    header.boundary.frameEndOffset, header.boundary.prefixDigest, header.stateBytes, header.stateDigest,
  ]), "utf8")];
}

export function encodeProjectionCheckpoint(
  key: string,
  boundary: DurableLogCheckpoint,
  state: unknown,
  integrity?: AuthorityCacheIntegrity,
): Buffer | undefined {
  if (!integrity) return undefined;
  const payload = serialize(state);
  const unsealed: Omit<CheckpointHeader, "mac"> = {
    key,
    boundary: {
      logId: boundary.logId,
      lsn: boundary.lsn,
      frameEndOffset: boundary.frameEndOffset,
      prefixDigest: boundary.prefixDigest,
    },
    stateBytes: payload.byteLength,
    stateDigest: createHash("sha256").update(payload).digest("hex"),
  };
  const sealed = mac("projection-checkpoint", checkpointSealParts(unsealed), integrity);
  if (!sealed) return undefined;
  const header: CheckpointHeader = { ...unsealed, mac: sealed.toString("hex") };
  const headerBytes = Buffer.from(JSON.stringify(header) + "\n", "utf8");
  const total = CHECKPOINT_MAGIC.byteLength + headerBytes.byteLength + payload.byteLength;
  if (total > MAX_PROJECTION_CHECKPOINT_BYTES) return undefined;
  return Buffer.concat([CHECKPOINT_MAGIC, headerBytes, payload], total);
}

export function decodeProjectionCheckpoint(
  bytes: Buffer,
  key: string,
  integrity?: AuthorityCacheIntegrity,
): { readonly boundary: DurableLogCheckpoint; readonly state: unknown } | undefined {
  try {
    if (bytes.byteLength > MAX_PROJECTION_CHECKPOINT_BYTES) return undefined;
    if (!bytes.subarray(0, CHECKPOINT_MAGIC.byteLength).equals(CHECKPOINT_MAGIC)) return undefined;
    const headerEnd = bytes.indexOf(10, CHECKPOINT_MAGIC.byteLength);
    if (headerEnd < 0 || headerEnd - CHECKPOINT_MAGIC.byteLength > 64 * 1024) return undefined;
    const header = JSON.parse(bytes.subarray(CHECKPOINT_MAGIC.byteLength, headerEnd).toString("utf8")) as CheckpointHeader;
    const payload = bytes.subarray(headerEnd + 1);
    const boundary = header.boundary;
    if (
      header.key !== key ||
      header.stateBytes !== payload.byteLength ||
      typeof header.stateDigest !== "string" ||
      typeof header.mac !== "string" || !/^[a-f0-9]{64}$/u.test(header.mac) ||
      createHash("sha256").update(payload).digest("hex") !== header.stateDigest ||
      !boundary || typeof boundary.logId !== "string" ||
      !Number.isSafeInteger(boundary.lsn) || boundary.lsn <= 0 ||
      !Number.isSafeInteger(boundary.frameEndOffset) || boundary.frameEndOffset <= 0 ||
      typeof boundary.prefixDigest !== "string" ||
      !macMatches("projection-checkpoint", checkpointSealParts(header), Buffer.from(header.mac, "hex"), integrity)
    ) {
      return undefined;
    }
    return { boundary, state: deserialize(payload) };
  } catch {
    return undefined;
  }
}
