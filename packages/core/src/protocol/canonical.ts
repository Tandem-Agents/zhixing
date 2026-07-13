import { createHash } from "node:crypto";
import type { Digest } from "../types/distributed.js";

export function canonicalize(value: unknown): string {
  return serialize(value);
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

export function byteDigest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
    for (const key of keys) {
      assertValidUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`Canonical JSON rejects accessor-backed field: ${key}`);
      }
      if (descriptor.value === undefined) {
        throw new TypeError(`Canonical JSON rejects undefined field: ${key}`);
      }
    }
    return `{${keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
        return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}`);
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        throw new TypeError("Canonical JSON rejects invalid Unicode");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical JSON rejects invalid Unicode");
    }
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
