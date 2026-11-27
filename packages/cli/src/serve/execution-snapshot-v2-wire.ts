import type { ArtifactRef, ExecutionAssetSnapshotV2 } from "@zhixing-ai/core/contracts";
import {
  byteDigest,
  canonicalize,
  validateExecutionAssetSnapshotV2,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";

export const MAX_EXECUTION_ASSET_CHUNK_BYTES = 262_144;
export const MAX_EXECUTION_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_META_BYTES = 16 * 1024 * 1024;
export const MAX_RECONCILE_PAGE_REFS = 1024;
export const MAX_VERIFIED_SNAPSHOTS = 8;

export type ExecutionSnapshotV2Request =
  | {
      readonly v: 2;
      readonly method: "stage-snapshot-meta-v2";
      readonly metaRef: ArtifactRef;
      readonly offset: number;
      readonly chunkBase64: string;
    }
  | {
      readonly v: 2;
      readonly method: "reconcile-assets-v2";
      readonly snapshotDigest: string;
      readonly cursor?: number;
      readonly limit?: number;
    }
  | {
      readonly v: 2;
      readonly method: "reconcile-assets-v2";
      readonly snapshot: ExecutionAssetSnapshotV2;
      readonly indexRefs?: readonly ArtifactRef[];
      readonly cursor?: number;
      readonly limit?: number;
    }
  | {
      readonly v: 2;
      readonly method: "upload-asset-chunk-v2";
      readonly snapshotDigest: string;
      readonly ref: ArtifactRef;
      readonly offset: number;
      readonly chunkBase64: string;
    }
  | {
      readonly v: 2;
      readonly method: "commit-assets-v2";
      readonly snapshotDigest: string;
    }
  | {
      readonly v: 2;
      readonly method: "commit-assets-v2";
      readonly snapshot: ExecutionAssetSnapshotV2;
    };

export type StageSnapshotMetaV2Response =
  | {
      readonly v: 2;
      readonly receivedBytes: number;
      readonly complete: false;
    }
  | {
      readonly v: 2;
      readonly receivedBytes: number;
      readonly complete: true;
      readonly snapshotDigest: string;
      readonly totalRefs: number;
    };

export interface ReconcileAssetsV2Response {
  readonly v: 2;
  readonly missingRefs: readonly {
    readonly ref: ArtifactRef;
    readonly receivedBytes: number;
  }[];
  readonly nextCursor?: number;
}

export interface UploadAssetChunkV2Response {
  readonly v: 2;
  readonly receivedBytes: number;
  readonly complete: boolean;
}

export function encodeSnapshotMetaEnvelope(
  snapshot: ExecutionAssetSnapshotV2,
  indexRefs?: readonly ArtifactRef[],
): { readonly bytes: Uint8Array; readonly ref: ArtifactRef } {
  const envelope = {
    v: 2 as const,
    snapshot,
    ...(indexRefs?.length ? { indexRefs } : {}),
  };
  const bytes = Buffer.from(canonicalize(envelope), "utf8");
  return {
    bytes,
    ref: { digest: byteDigest(bytes), bytes: bytes.byteLength },
  };
}

export function decodeSnapshotMetaEnvelope(
  bytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): {
  readonly snapshot: ExecutionAssetSnapshotV2;
  readonly expectedRefs: readonly ArtifactRef[];
} {
  const parsed = decodeJsonPayload(bytes);
  if (!isRecord(parsed) || parsed.v !== 2) {
    throw new TypeError("Execution snapshot v2 metadata envelope is invalid");
  }
  assertKeys(
    parsed,
    "indexRefs" in parsed ? ["indexRefs", "snapshot", "v"] : ["snapshot", "v"],
  );
  const snapshot = validateExecutionAssetSnapshotV2(parsed.snapshot, verifier);
  const indexRefs =
    "indexRefs" in parsed ? decodeArtifactRefArray(parsed.indexRefs) : undefined;
  return {
    snapshot,
    expectedRefs: collectExpectedRefsFromSnapshot(snapshot, indexRefs),
  };
}

export function collectExpectedRefsFromSnapshot(
  snapshot: ExecutionAssetSnapshotV2,
  indexRefs?: readonly ArtifactRef[],
): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const skill of snapshot.skills) {
    refs.set(skill.contentRef.digest, skill.contentRef);
    if (skill.packageRef) refs.set(skill.packageRef.digest, skill.packageRef);
  }
  if (indexRefs?.length) {
    const allowed = new Set([
      ...snapshot.rubrics.map((item) => item.digest),
      ...snapshot.promptAssets.map((item) => item.digest),
    ]);
    for (const ref of indexRefs) {
      if (!allowed.has(ref.digest)) {
        throw new TypeError(
          `Execution asset v2 index ref is not declared in snapshot: ${ref.digest}`,
        );
      }
      refs.set(ref.digest, ref);
    }
  }
  return [...refs.values()].sort((left, right) =>
    left.digest.localeCompare(right.digest, "en-US"),
  );
}

export function decodeV2Request(
  raw: unknown,
  verifier: ProtocolSignatureVerifier,
): ExecutionSnapshotV2Request {
  if (!isRecord(raw) || raw.v !== 2) {
    throw new TypeError("Execution snapshot v2 request is invalid");
  }
  if (raw.method === "stage-snapshot-meta-v2") {
    assertKeys(raw, ["chunkBase64", "metaRef", "method", "offset", "v"]);
    if (
      !Number.isSafeInteger(raw.offset) ||
      (raw.offset as number) < 0 ||
      typeof raw.chunkBase64 !== "string"
    ) {
      throw new TypeError("Execution snapshot v2 metadata stage request is invalid");
    }
    return {
      v: 2,
      method: "stage-snapshot-meta-v2",
      metaRef: decodeArtifactRef(raw.metaRef, "Execution snapshot v2 metaRef"),
      offset: raw.offset as number,
      chunkBase64: raw.chunkBase64,
    };
  }
  if (raw.method === "reconcile-assets-v2") {
    return decodeReconcileRequest(raw, verifier);
  }
  if (raw.method === "commit-assets-v2") {
    if ("snapshotDigest" in raw) {
      assertKeys(raw, ["method", "snapshotDigest", "v"]);
      if (!isSha256Digest(raw.snapshotDigest)) {
        throw new TypeError("Execution asset v2 commit snapshotDigest is invalid");
      }
      return { v: 2, method: "commit-assets-v2", snapshotDigest: raw.snapshotDigest };
    }
    assertKeys(raw, ["method", "snapshot", "v"]);
    return {
      v: 2,
      method: "commit-assets-v2",
      snapshot: validateExecutionAssetSnapshotV2(raw.snapshot, verifier),
    };
  }
  if (raw.method === "upload-asset-chunk-v2") {
    assertKeys(raw, ["chunkBase64", "method", "offset", "ref", "snapshotDigest", "v"]);
    if (
      !isSha256Digest(raw.snapshotDigest) ||
      !Number.isSafeInteger(raw.offset) ||
      (raw.offset as number) < 0 ||
      typeof raw.chunkBase64 !== "string"
    ) {
      throw new TypeError("Execution asset chunk request is invalid");
    }
    return {
      v: 2,
      method: "upload-asset-chunk-v2",
      snapshotDigest: raw.snapshotDigest,
      ref: decodeArtifactRef(raw.ref, "Execution asset chunk ref"),
      offset: raw.offset as number,
      chunkBase64: raw.chunkBase64,
    };
  }
  throw new TypeError("Execution snapshot method is unsupported");
}

function decodeReconcileRequest(
  raw: Record<string, unknown>,
  verifier: ProtocolSignatureVerifier,
): Extract<ExecutionSnapshotV2Request, { readonly method: "reconcile-assets-v2" }> {
  const cursor =
    "cursor" in raw ? decodeNonNegInt(raw.cursor, "reconcile cursor") : undefined;
  const limit =
    "limit" in raw ? decodePositiveInt(raw.limit, "reconcile limit") : undefined;
  if ("snapshotDigest" in raw) {
    const keys = ["method", "snapshotDigest", "v"];
    if ("cursor" in raw) keys.push("cursor");
    if ("limit" in raw) keys.push("limit");
    assertKeys(raw, keys);
    if (!isSha256Digest(raw.snapshotDigest)) {
      throw new TypeError("Execution asset v2 reconcile snapshotDigest is invalid");
    }
    return {
      v: 2,
      method: "reconcile-assets-v2",
      snapshotDigest: raw.snapshotDigest,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }
  const keys = ["method", "snapshot", "v"];
  if ("indexRefs" in raw) keys.push("indexRefs");
  if ("cursor" in raw) keys.push("cursor");
  if ("limit" in raw) keys.push("limit");
  assertKeys(raw, keys);
  const snapshot = validateExecutionAssetSnapshotV2(raw.snapshot, verifier);
  const indexRefs =
    "indexRefs" in raw ? decodeArtifactRefArray(raw.indexRefs) : undefined;
  return {
    v: 2,
    method: "reconcile-assets-v2",
    snapshot,
    ...(indexRefs ? { indexRefs } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function validateStageMetaResponse(raw: unknown): StageSnapshotMetaV2Response {
  if (
    !isRecord(raw) ||
    raw.v !== 2 ||
    !Number.isSafeInteger(raw.receivedBytes) ||
    (raw.receivedBytes as number) < 0 ||
    typeof raw.complete !== "boolean"
  ) {
    throw new TypeError("Execution snapshot v2 metadata stage response is invalid");
  }
  if (raw.complete) {
    if (
      !isSha256Digest(raw.snapshotDigest) ||
      !Number.isSafeInteger(raw.totalRefs) ||
      (raw.totalRefs as number) < 0
    ) {
      throw new TypeError("Execution snapshot v2 metadata completion response is invalid");
    }
  }
  return raw as unknown as StageSnapshotMetaV2Response;
}

export function validateReconcileResponse(raw: unknown): ReconcileAssetsV2Response {
  if (!isRecord(raw) || raw.v !== 2 || !Array.isArray(raw.missingRefs)) {
    throw new TypeError("Execution asset v2 reconcile response is invalid");
  }
  if (
    raw.nextCursor !== undefined &&
    (!Number.isSafeInteger(raw.nextCursor) || (raw.nextCursor as number) < 0)
  ) {
    throw new TypeError("Execution asset v2 reconcile nextCursor is invalid");
  }
  for (const item of raw.missingRefs) {
    if (
      !isRecord(item) ||
      !isRecord(item.ref) ||
      typeof item.ref.digest !== "string" ||
      !Number.isSafeInteger(item.ref.bytes) ||
      !Number.isSafeInteger(item.receivedBytes) ||
      (item.receivedBytes as number) < 0
    ) {
      throw new TypeError("Execution asset v2 missing ref entry is invalid");
    }
  }
  return raw as unknown as ReconcileAssetsV2Response;
}

export function decodeExactBase64(encoded: string, label: string): Uint8Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new TypeError(`${label} base64 encoding is invalid`);
  }
  return bytes;
}

export function encodeJsonPayload(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

export function decodeJsonPayload(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) {
    throw new TypeError("Execution snapshot payload is not canonical");
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeArtifactRefArray(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Execution asset v2 indexRefs must be an array");
  }
  return value.map((entry) => decodeArtifactRef(entry, "Execution asset v2 indexRef"));
}

function decodeArtifactRef(value: unknown, label: string): ArtifactRef {
  if (
    !isRecord(value) ||
    !isSha256Digest(value.digest) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return { digest: value.digest, bytes: value.bytes as number };
}

function decodeNonNegInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as number;
}

function decodePositiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as number;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new TypeError("Execution snapshot request fields are invalid");
  }
}
