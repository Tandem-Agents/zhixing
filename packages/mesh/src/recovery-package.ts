import type { CheckpointPackage } from "./checkpoint.js";
import { assertCheckpointEnvelopeShape } from "./checkpoint.js";
import { byteDigest, canonicalize } from "./canonical.js";
import { RecoveryRoot } from "./recovery-root.js";

export type DecodedRecoveryPackage =
  | {
      readonly version: 2;
      readonly root: RecoveryRoot;
    }
  | {
      readonly version: 1;
      readonly root: RecoveryRoot;
      readonly checkpoint: CheckpointPackage;
    };

export type CurrentRecoveryPackage = Extract<DecodedRecoveryPackage, { version: 2 }>;

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

export function requireCurrentRecoveryPackage(
  decoded: DecodedRecoveryPackage,
): CurrentRecoveryPackage {
  if (decoded.version !== 2) {
    throw new TypeError("Legacy recovery packages are valid only for initial root activation");
  }
  return decoded;
}

function decodeCurrent(encoded: string): CurrentRecoveryPackage {
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
  return { version: 2, root };
}

function decodeLegacy(encoded: string): Extract<DecodedRecoveryPackage, { version: 1 }> {
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
  if (!Array.isArray(value.checkpoint.chunks)) {
    throw new TypeError("Legacy recovery checkpoint is invalid");
  }
  assertCheckpointEnvelopeShape(value.checkpoint.envelope);
  const envelope = value.checkpoint.envelope;
  if (
    envelope.manifest.purpose.kind !== "root-activation" ||
    canonicalize(envelope.manifest.scope) !== canonicalize(["trust"])
  ) {
    throw new TypeError("Legacy recovery checkpoint is not trust-only root activation");
  }
  const root = RecoveryRoot.importSecret(value.recoverySecret);
  const identity = root.publicIdentity();
  const plan = envelope.manifest.purpose.plan;
  const rootEvent = isRecord(plan) ? plan.rootEvent : undefined;
  const rootBody = isRecord(rootEvent) ? rootEvent.body : undefined;
  if (
    envelope.recipientKeyId !== identity.backupKeyId ||
    !isRecord(rootBody) ||
    rootBody.t !== "recovery-root" ||
    rootBody.op !== "establish" ||
    rootBody.rootPublicKey !== identity.rootPublicKey ||
    rootBody.backupPublicKey !== identity.backupPublicKey
  ) {
    throw new TypeError("Legacy recovery package secret does not match its checkpoint root");
  }
  if (
    value.checkpoint.chunks.length === 0 ||
    value.checkpoint.chunks.length !== envelope.chunks.length
  ) {
    throw new TypeError("Legacy recovery checkpoint chunk set is incomplete");
  }
  const chunks: Array<{ readonly seq: number; readonly bytes: Buffer }> = [];
  try {
    for (const [expectedSeq, entry] of value.checkpoint.chunks.entries()) {
      if (!isRecord(entry) || entry.seq !== expectedSeq || typeof entry.bytes !== "string") {
        throw new TypeError("Legacy recovery checkpoint chunk is invalid");
      }
      assertExactKeys(entry, ["bytes", "seq"]);
      const bytes = decodeCanonicalBase64(entry.bytes, "Legacy recovery checkpoint chunk");
      const descriptor = envelope.chunks[expectedSeq];
      if (
        !descriptor ||
        descriptor.seq !== expectedSeq ||
        descriptor.bytes !== bytes.byteLength ||
        descriptor.digest !== byteDigest(bytes)
      ) {
        bytes.fill(0);
        throw new TypeError("Legacy recovery checkpoint chunk does not match its envelope");
      }
      chunks.push({ seq: expectedSeq, bytes });
    }
    return {
      version: 1,
      root,
      checkpoint: { envelope, chunks },
    };
  } catch (error) {
    for (const chunk of chunks) chunk.bytes.fill(0);
    throw error;
  }
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
