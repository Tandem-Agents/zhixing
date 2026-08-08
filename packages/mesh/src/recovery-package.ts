import { canonicalize } from "./canonical.js";
import type { CheckpointPackage } from "./checkpoint.js";
import { RecoveryRoot } from "./recovery-root.js";

export interface DecodedRecoveryPackage {
  readonly root: RecoveryRoot;
  readonly legacyCheckpoint?: CheckpointPackage;
}

export function encodeRecoveryPackage(root: RecoveryRoot): string {
  const payload = {
    v: 2 as const,
    recoverySecret: root.exportSecret(),
    rootIdentity: root.publicIdentity(),
  };
  return `zxrp2:${Buffer.from(canonicalize(payload), "utf8").toString("base64url")}`;
}

export function decodeRecoveryPackage(value: string | Uint8Array): DecodedRecoveryPackage {
  const trimmed = typeof value === "string"
    ? value.trim()
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8").trim();
  if (trimmed.startsWith("zxrp2:")) return decodeCurrent(trimmed.slice(6));
  if (trimmed.startsWith("zxrp1:")) return decodeLegacy(trimmed.slice(6));
  throw new TypeError("Recovery package has an unsupported format");
}

function decodeCurrent(encoded: string): DecodedRecoveryPackage {
  const value = decodeCanonicalPayload(encoded);
  if (!isRecord(value) || value.v !== 2 || typeof value.recoverySecret !== "string") {
    throw new TypeError("Recovery package shape is invalid");
  }
  assertExactKeys(value, ["recoverySecret", "rootIdentity", "v"]);
  if (!isRecord(value.rootIdentity)) throw new TypeError("Recovery package identity is invalid");
  assertExactKeys(value.rootIdentity, [
    "backupKeyId",
    "backupPublicKey",
    "rootKeyId",
    "rootPublicKey",
  ]);
  const root = RecoveryRoot.importSecret(value.recoverySecret);
  if (canonicalize(root.publicIdentity()) !== canonicalize(value.rootIdentity)) {
    throw new TypeError("Recovery package secret does not match its root identity");
  }
  return { root };
}

function decodeLegacy(encoded: string): DecodedRecoveryPackage {
  const value = decodeCanonicalPayload(encoded);
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.recoverySecret !== "string" ||
    !isRecord(value.checkpoint)
  ) {
    throw new TypeError("Legacy recovery package shape is invalid");
  }
  assertExactKeys(value, ["checkpoint", "recoverySecret", "v"]);
  assertExactKeys(value.checkpoint, ["chunks", "envelope"]);
  if (!isRecord(value.checkpoint.envelope) || !Array.isArray(value.checkpoint.chunks)) {
    throw new TypeError("Legacy recovery checkpoint is invalid");
  }
  const chunks = value.checkpoint.chunks.map((entry, expectedSeq) => {
    if (!isRecord(entry) || entry.seq !== expectedSeq || typeof entry.bytes !== "string") {
      throw new TypeError("Legacy recovery checkpoint chunk is invalid");
    }
    assertExactKeys(entry, ["bytes", "seq"]);
    const bytes = decodeCanonicalBase64(entry.bytes, "Legacy recovery checkpoint chunk");
    return { seq: expectedSeq, bytes };
  });
  return {
    root: RecoveryRoot.importSecret(value.recoverySecret),
    legacyCheckpoint: {
      envelope: value.checkpoint.envelope as unknown as CheckpointPackage["envelope"],
      chunks,
    },
  };
}

function decodeCanonicalPayload(encoded: string): unknown {
  const bytes = decodeCanonicalBase64(encoded, "Recovery package");
  try {
    const text = bytes.toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new TypeError("Recovery package is not valid JSON");
    }
    if (canonicalize(value) !== text) throw new TypeError("Recovery package is not canonical");
    return value;
  } finally {
    bytes.fill(0);
  }
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== value) {
    throw new TypeError(`${label} is not canonical base64url`);
  }
  return bytes;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (canonicalize(actual) !== canonicalize(sorted)) {
    throw new TypeError("Recovery package contains missing or unknown fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
