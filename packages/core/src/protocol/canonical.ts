import { createHash } from "node:crypto";
import type { Digest } from "../types/distributed.js";

export interface ByteDigestAccumulator {
  update(bytes: Uint8Array): void;
  digest(): Digest;
}

export function canonicalize(value: unknown): string {
  return serialize(value);
}

/** Ordering used by canonical protocol collections and canonical JSON object keys. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function protocolBytes(
  schemaId: string,
  version: number,
  payload: unknown,
): Buffer {
  assertSchema(schemaId, version);
  return Buffer.concat([
    Buffer.from(`zhixing:${schemaId}:v${version}`, "utf8"),
    Buffer.from([0]),
    Buffer.from(canonicalize(payload), "utf8"),
  ]);
}

export function protocolDigest(
  schemaId: string,
  version: number,
  payload: unknown,
): Digest {
  return `sha256:${createHash("sha256")
    .update(protocolBytes(schemaId, version, payload))
    .digest("hex")}`;
}

/**
 * 与 protocolDigest 相同的协议摘要，输入为已按规范顺序串好的片段：调用方已逐段校验并规范化，
 * 不必为求摘要再整体规范化一次。片段拼接必须恰好等于 canonicalize(payload)。
 */
export function protocolDigestOfCanonicalParts(
  schemaId: string,
  version: number,
  parts: readonly string[],
): Digest {
  assertSchema(schemaId, version);
  const hash = createHash("sha256").update(`zhixing:${schemaId}:v${version}`, "utf8").update(Buffer.from([0]));
  for (const part of parts) hash.update(part, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export function byteDigest(bytes: Uint8Array): Digest {
  const accumulator = createByteDigestAccumulator();
  accumulator.update(bytes);
  return accumulator.digest();
}

export function createByteDigestAccumulator(): ByteDigestAccumulator {
  const hash = createHash("sha256");
  let finalized = false;
  return {
    update(bytes) {
      if (finalized) {
        throw new Error("Byte digest accumulator is already finalized");
      }
      hash.update(bytes);
    },
    digest() {
      if (finalized) {
        throw new Error("Byte digest accumulator is already finalized");
      }
      finalized = true;
      return `sha256:${hash.digest("hex")}`;
    },
  };
}

function assertSchema(schemaId: string, version: number): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(schemaId)) {
    throw new TypeError(`Invalid protocol schema id: ${schemaId}`);
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError(`Invalid protocol schema version: ${version}`);
  }
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON only accepts finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = new Array<string>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("Canonical JSON rejects sparse arrays");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Canonical JSON rejects accessor-backed array entries");
      }
      entries[index] = serialize(descriptor.value);
    }
    if (Object.keys(value).length !== value.length) {
      throw new TypeError("Canonical JSON rejects non-index array properties");
    }
    assertNoEnumerableSymbols(value);
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects");
    }
    const record = value as Record<string, unknown>;
    assertNoEnumerableSymbols(record);
    const keys = Object.keys(record).sort();
    const entries = new Array<string>(keys.length);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      assertValidUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`Canonical JSON rejects accessor-backed field: ${key}`);
      }
      if (descriptor.value === undefined) {
        throw new TypeError(`Canonical JSON rejects undefined field: ${key}`);
      }
      entries[index] = `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
    }
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

function assertValidUnicode(value: string): void {
  // Unicode mode treats a valid surrogate pair as one non-surrogate code point.
  // Reject lone UTF-16 units without scanning every character in JavaScript.
  if (/[\uD800-\uDFFF]/u.test(value)) {
    throw new TypeError("Canonical JSON rejects invalid Unicode");
  }
}

function assertNoEnumerableSymbols(value: object): void {
  if (
    Object.getOwnPropertySymbols(value).some(
      (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable,
    )
  ) {
    throw new TypeError("Canonical JSON rejects symbol properties");
  }
}
