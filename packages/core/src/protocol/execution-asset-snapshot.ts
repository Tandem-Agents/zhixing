import type {
  ExecutionAssetSnapshot,
  ExecutionAssetSnapshotV2,
} from "../contracts/state.js";
import { protocolDigest } from "./canonical.js";
import { validateGlobalQueryResult } from "./global-query-validation.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";

export type UnsignedExecutionAssetSnapshot = Omit<
  ExecutionAssetSnapshot,
  "digest" | "signature" | "v"
>;

export type UnsignedExecutionAssetSnapshotV2 = Omit<
  ExecutionAssetSnapshotV2,
  "digest" | "signature" | "v"
>;

export function createSignedExecutionAssetSnapshot(
  input: UnsignedExecutionAssetSnapshot,
  signer: ProtocolSigner,
): ExecutionAssetSnapshot {
  const unsigned = normalize({ v: 1 as const, ...input });
  const payload = {
    ...unsigned,
    digest: protocolDigest("ExecutionAssetSnapshot", 1, unsigned),
  };
  return validateExecutionAssetSnapshot({
    ...payload,
    signature: signer.sign("ExecutionAssetSnapshot", 1, payload),
  });
}

export function createSignedExecutionAssetSnapshotV2(
  input: UnsignedExecutionAssetSnapshotV2,
  signer: ProtocolSigner,
): ExecutionAssetSnapshotV2 {
  const unsigned = normalizeV2({ v: 2 as const, ...input });
  const payload = {
    ...unsigned,
    digest: protocolDigest("ExecutionAssetSnapshot", 2, unsigned),
  };
  return validateExecutionAssetSnapshotV2({
    ...payload,
    signature: signer.sign("ExecutionAssetSnapshot", 2, payload),
  });
}

export function validateExecutionAssetSnapshot(
  input: unknown,
  verifier?: ProtocolSignatureVerifier,
): ExecutionAssetSnapshot {
  const value = clone(input) as ExecutionAssetSnapshot;
  assertRecord(value, "Execution asset snapshot");
  assertExactKeys(value, [
    "digest",
    "generatedAt",
    "promptAssets",
    "rubrics",
    "signature",
    "skillCatalogRevision",
    "skills",
    "snapshotRevision",
    "v",
  ], "Execution asset snapshot");
  if (value.v !== 1) throw new TypeError("Execution asset snapshot version must be 1");
  assertPositiveInteger(value.snapshotRevision, "Execution asset snapshot revision");
  assertNonNegativeInteger(value.skillCatalogRevision, "Skill catalog revision");
  assertCanonicalTime(value.generatedAt, "Execution asset snapshot generatedAt");

  const skills = validateGlobalQueryResult(
    { kind: "skill-catalog", includeDisabled: true },
    {
      kind: "skill-catalog",
      catalogRevision: value.skillCatalogRevision,
      entries: value.skills,
    },
  );
  const rubrics = validateGlobalQueryResult(
    { kind: "asset-index", asset: "rubrics" },
    { kind: "asset-index", entries: value.rubrics },
  );
  const promptAssets = validateGlobalQueryResult(
    { kind: "asset-index", asset: "prompt-assets" },
    { kind: "asset-index", entries: value.promptAssets },
  );
  value.skills = skills.kind === "skill-catalog" ? skills.entries : [];
  value.rubrics = rubrics.kind === "asset-index" ? rubrics.entries : [];
  value.promptAssets = promptAssets.kind === "asset-index" ? promptAssets.entries : [];

  assertDigest(value.digest, "Execution asset snapshot digest");
  const { digest: _digest, signature: _signature, ...digestPayload } = value;
  if (value.digest !== protocolDigest("ExecutionAssetSnapshot", 1, digestPayload)) {
    throw new TypeError("Execution asset snapshot digest is invalid");
  }
  validateSignature(value.signature);
  const { signature: _ignored, ...signedPayload } = value;
  verifier?.verify(
    "ExecutionAssetSnapshot",
    1,
    signedPayload,
    value.signature,
  );
  return value;
}

export function validateExecutionAssetSnapshotV2(
  input: unknown,
  verifier?: ProtocolSignatureVerifier,
): ExecutionAssetSnapshotV2 {
  const value = clone(input) as ExecutionAssetSnapshotV2;
  assertRecord(value, "Execution asset snapshot");
  assertExactKeys(value, [
    "digest",
    "generatedAt",
    "promptAssets",
    "rubrics",
    "signature",
    "skillCatalogRevision",
    "skills",
    "snapshotRevision",
    "v",
  ], "Execution asset snapshot");
  if (value.v !== 2) throw new TypeError("Execution asset snapshot version must be 2");
  assertPositiveInteger(value.snapshotRevision, "Execution asset snapshot revision");
  assertNonNegativeInteger(value.skillCatalogRevision, "Skill catalog revision");
  assertCanonicalTime(value.generatedAt, "Execution asset snapshot generatedAt");

  const skills = validateGlobalQueryResult(
    { kind: "skill-catalog-v2", includeDisabled: true },
    {
      kind: "skill-catalog-v2",
      catalogRevision: value.skillCatalogRevision,
      entries: value.skills,
    },
  );
  const rubrics = validateGlobalQueryResult(
    { kind: "asset-index", asset: "rubrics" },
    { kind: "asset-index", entries: value.rubrics },
  );
  const promptAssets = validateGlobalQueryResult(
    { kind: "asset-index", asset: "prompt-assets" },
    { kind: "asset-index", entries: value.promptAssets },
  );
  value.skills = skills.kind === "skill-catalog-v2" ? skills.entries : [];
  value.rubrics = rubrics.kind === "asset-index" ? rubrics.entries : [];
  value.promptAssets = promptAssets.kind === "asset-index" ? promptAssets.entries : [];

  assertDigest(value.digest, "Execution asset snapshot digest");
  const { digest: _digest, signature: _signature, ...digestPayload } = value;
  if (value.digest !== protocolDigest("ExecutionAssetSnapshot", 2, digestPayload)) {
    throw new TypeError("Execution asset snapshot digest is invalid");
  }
  validateSignature(value.signature);
  const { signature: _ignored, ...signedPayload } = value;
  verifier?.verify(
    "ExecutionAssetSnapshot",
    2,
    signedPayload,
    value.signature,
  );
  return value;
}

function normalize(
  input: { readonly v: 1 } & UnsignedExecutionAssetSnapshot,
): { readonly v: 1 } & UnsignedExecutionAssetSnapshot {
  return {
    ...clone(input),
    // Skill catalog order is an Authority fact: the Skill-owned Kernel projection
    // applies its top-N window before appending builtins.  The signed snapshot must
    // therefore preserve that order instead of canonicalizing it by id.  Rubric and
    // prompt indexes do not carry this ordering contract and remain canonicalized.
    skills: [...input.skills],
    rubrics: [...input.rubrics].sort((left, right) => left.id.localeCompare(right.id, "en-US")),
    promptAssets: [...input.promptAssets].sort((left, right) => left.id.localeCompare(right.id, "en-US")),
  };
}

function normalizeV2(
  input: { readonly v: 2 } & UnsignedExecutionAssetSnapshotV2,
): { readonly v: 2 } & UnsignedExecutionAssetSnapshotV2 {
  return {
    ...clone(input),
    skills: [...input.skills],
    rubrics: [...input.rubrics].sort((left, right) => left.id.localeCompare(right.id, "en-US")),
    promptAssets: [...input.promptAssets].sort((left, right) => left.id.localeCompare(right.id, "en-US")),
  };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validateSignature(value: unknown): void {
  assertRecord(value, "Execution asset snapshot signature");
  assertExactKeys(value, ["alg", "keyId", "sig"], "Execution asset snapshot signature");
  for (const key of ["alg", "keyId", "sig"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new TypeError("Execution asset snapshot signature is invalid");
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
