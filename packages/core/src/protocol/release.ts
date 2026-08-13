import { Buffer } from "node:buffer";
import type { Signature } from "../contracts/index.js";
import { byteDigest, canonicalize } from "./canonical.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";
import { assertProtocolIdentifier, validateProtocolVersion } from "./validation.js";

export const STABLE_RELEASE_TARGETS = [
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
] as const;

export type StableReleaseTarget = (typeof STABLE_RELEASE_TARGETS)[number];

export interface ReleaseArtifactRef {
  readonly digest: string;
  readonly bytes: number;
}

export interface DurableSchemaCompatibility {
  readonly schemaId: string;
  readonly readMin: string;
  readonly readMax: string;
  readonly writeVersion: string;
}

export interface UnsignedReleaseManifest {
  readonly v: 1;
  readonly releaseVersion: string;
  readonly releaseSequence: string;
  readonly channel: "stable";
  readonly target: StableReleaseTarget;
  readonly nodeVersion: string;
  readonly sourceTreeDigest: string;
  readonly packageGraphDigest: string;
  readonly artifact: ReleaseArtifactRef;
  readonly protocolRange: {
    readonly readMin: string;
    readonly readMax: string;
    readonly writeVersion: string;
  };
  readonly durableSchemas: readonly DurableSchemaCompatibility[];
  readonly minimumRollbackVersion: string;
  readonly keyId: string;
}

export type ReleaseManifest = UnsignedReleaseManifest & { readonly signature: Signature };

export interface StableReleaseTargetEntry {
  readonly target: StableReleaseTarget;
  readonly manifest: ReleaseArtifactRef & { readonly url: string };
  readonly artifactUrl: string;
}

export interface UnsignedStableReleaseIndex {
  readonly v: 1;
  readonly channel: "stable";
  readonly releaseVersion: string;
  readonly releaseSequence: string;
  readonly targets: readonly StableReleaseTargetEntry[];
  readonly keyId: string;
}

export type StableReleaseIndex = UnsignedStableReleaseIndex & { readonly signature: Signature };

export type ProgramUpdatePhase = "idle" | "checking" | "downloading" | "staged" | "handed-off";
export type ProgramUpdateNotice = "none" | "updated" | "failed-safe" | "restored" | "action-required";
export type ProgramUpdateAction = "retry-update" | "restore-previous" | "contact-support";

export interface ProgramUpdateReceipt {
  readonly v: 1;
  readonly currentManifestDigest: string;
  readonly target: StableReleaseTarget;
  readonly candidateManifestDigest?: string;
  readonly phase: ProgramUpdatePhase;
  readonly operationId?: string;
  readonly notice: ProgramUpdateNotice;
  readonly code?: string;
  readonly action?: ProgramUpdateAction;
}

export interface ProgramArtifactFile {
  readonly path: string;
  readonly mode: 420 | 493;
  readonly digest: string;
  readonly bytes: number;
  readonly data: string;
}

export interface ProgramArtifact {
  readonly v: 1;
  readonly target: StableReleaseTarget;
  readonly releaseVersion: string;
  readonly files: readonly ProgramArtifactFile[];
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UINT64_MAX = (1n << 64n) - 1n;

export function createSignedReleaseManifest(
  input: UnsignedReleaseManifest,
  signer: ProtocolSigner,
): ReleaseManifest {
  const payload = validateUnsignedReleaseManifest(input);
  const signature = signer.sign("ReleaseManifest", 1, payload);
  if (signature.keyId !== payload.keyId) throw new TypeError("Release manifest signer key does not match keyId");
  return Object.freeze({ ...payload, signature });
}

export function validateReleaseManifest(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ReleaseManifest {
  const value = object(input, "Release manifest");
  exact(value, [...RELEASE_MANIFEST_FIELDS, "signature"], "Release manifest");
  const signature = validateSignature(value.signature, "Release manifest signature");
  const { signature: _signature, ...unsigned } = value;
  const payload = validateUnsignedReleaseManifest(unsigned as unknown as UnsignedReleaseManifest);
  if (signature.keyId !== payload.keyId) throw new TypeError("Release manifest signature key does not match keyId");
  verifier.verify("ReleaseManifest", 1, payload, signature);
  return Object.freeze({ ...payload, signature });
}

export function createSignedStableReleaseIndex(
  input: UnsignedStableReleaseIndex,
  signer: ProtocolSigner,
): StableReleaseIndex {
  const payload = validateUnsignedStableReleaseIndex(input);
  const signature = signer.sign("StableReleaseIndex", 1, payload);
  if (signature.keyId !== payload.keyId) throw new TypeError("Stable release index signer key does not match keyId");
  return Object.freeze({ ...payload, signature });
}

export function validateStableReleaseIndex(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): StableReleaseIndex {
  const value = object(input, "Stable release index");
  exact(value, [...STABLE_RELEASE_INDEX_FIELDS, "signature"], "Stable release index");
  const signature = validateSignature(value.signature, "Stable release index signature");
  const { signature: _signature, ...unsigned } = value;
  const payload = validateUnsignedStableReleaseIndex(unsigned as unknown as UnsignedStableReleaseIndex);
  if (signature.keyId !== payload.keyId) throw new TypeError("Stable release index signature key does not match keyId");
  verifier.verify("StableReleaseIndex", 1, payload, signature);
  return Object.freeze({ ...payload, signature });
}

export function decodeAndValidateStableReleaseIndex(
  bytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): StableReleaseIndex {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new TypeError("Stable release index must be canonical UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new TypeError("Stable release index is not valid JSON");
  }
  const index = validateStableReleaseIndex(decoded, verifier);
  if (canonicalize(index) !== text) throw new TypeError("Stable release index bytes are not canonical JSON");
  return index;
}

export function decodeAndValidateReleaseManifest(
  bytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): ReleaseManifest {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new TypeError("Release manifest must be canonical UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new TypeError("Release manifest is not valid JSON");
  }
  const manifest = validateReleaseManifest(decoded, verifier);
  if (canonicalize(manifest) !== text) throw new TypeError("Release manifest bytes are not canonical JSON");
  return manifest;
}

export function assertStableReleaseBinding(
  index: StableReleaseIndex,
  target: StableReleaseTarget,
  manifestBytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): ReleaseManifest {
  const entry = index.targets.find((candidate) => candidate.target === target);
  if (!entry) throw new TypeError("Stable release target is missing");
  if (entry.manifest.bytes !== manifestBytes.byteLength || entry.manifest.digest !== byteDigest(manifestBytes)) {
    throw new TypeError("Stable release manifest bytes do not match index binding");
  }
  const manifest = decodeAndValidateReleaseManifest(manifestBytes, verifier);
  if (
    manifest.channel !== index.channel ||
    manifest.releaseVersion !== index.releaseVersion ||
    manifest.releaseSequence !== index.releaseSequence ||
    manifest.target !== target
  ) {
    throw new TypeError("Stable release index and manifest identity do not match");
  }
  return manifest;
}

export function assertReleaseAdvance(
  current: ReleaseManifest,
  candidate: ReleaseManifest,
): "replay" | "advance" {
  const sameIdentity = current.releaseVersion === candidate.releaseVersion &&
    current.releaseSequence === candidate.releaseSequence;
  if (sameIdentity) {
    if (canonicalize(current) !== canonicalize(candidate)) {
      throw new TypeError("A release identity cannot be rewritten with different bytes");
    }
    return "replay";
  }
  if (
    compareReleaseSemver(candidate.releaseVersion, current.releaseVersion) <= 0 ||
    BigInt(candidate.releaseSequence) <= BigInt(current.releaseSequence)
  ) {
    throw new TypeError("A new release must strictly advance SemVer and release sequence together");
  }
  return "advance";
}

export function validateProgramUpdateReceipt(input: unknown): ProgramUpdateReceipt {
  const value = object(input, "Program update receipt");
  const optional = ["candidateManifestDigest", "operationId", "code", "action"] as const;
  exact(value, ["v", "currentManifestDigest", "target", "phase", "notice", ...optional.filter((field) => value[field] !== undefined)], "Program update receipt");
  if (value.v !== 1) throw new TypeError("Program update receipt version must be 1");
  digest(value.currentManifestDigest, "Current manifest digest");
  target(value.target);
  const phase = enumValue(value.phase, ["idle", "checking", "downloading", "staged", "handed-off"] as const, "Program update phase");
  const notice = enumValue(value.notice, ["none", "updated", "failed-safe", "restored", "action-required"] as const, "Program update notice");
  const requiresCandidate = phase === "downloading" || phase === "staged" || phase === "handed-off";
  if (requiresCandidate !== (value.candidateManifestDigest !== undefined)) {
    throw new TypeError("Program update candidate digest does not match phase");
  }
  if (value.candidateManifestDigest !== undefined) digest(value.candidateManifestDigest, "Candidate manifest digest");
  if ((phase === "handed-off") !== (value.operationId !== undefined)) {
    throw new TypeError("Program update operationId is only valid for handed-off phase");
  }
  if (value.operationId !== undefined) assertProtocolIdentifier(value.operationId, "Program update operationId");
  if (notice === "failed-safe") {
    stableCode(value.code, "Program update failure code");
    if (value.action !== "retry-update") throw new TypeError("Failed-safe update must offer retry-update");
  } else if (notice === "action-required") {
    stableCode(value.code, "Program update action-required code");
    if (value.action !== "restore-previous" && value.action !== "contact-support") {
      throw new TypeError("Action-required update has an invalid action");
    }
  } else if (value.code !== undefined || value.action !== undefined) {
    throw new TypeError("Successful update notices cannot contain code or action");
  }
  return Object.freeze(value) as unknown as ProgramUpdateReceipt;
}

export function decodeProgramArtifact(bytes: Uint8Array): ProgramArtifact {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new TypeError("Program artifact must be canonical UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new TypeError("Program artifact is not valid JSON");
  }
  const artifact = validateProgramArtifact(decoded);
  if (canonicalize(artifact) !== text) throw new TypeError("Program artifact bytes are not canonical JSON");
  return artifact;
}

export function validateProgramArtifact(input: unknown): ProgramArtifact {
  const value = object(input, "Program artifact");
  exact(value, ["files", "releaseVersion", "target", "v"], "Program artifact");
  if (value.v !== 1) throw new TypeError("Program artifact version must be 1");
  target(value.target);
  semver(value.releaseVersion, "Program artifact release version");
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 20_000) {
    throw new TypeError("Program artifact files must be a finite non-empty list");
  }
  let totalBytes = 0;
  const files = value.files.map((inputFile, index) => {
    const file = object(inputFile, `Program artifact file ${index}`);
    exact(file, ["bytes", "data", "digest", "mode", "path"], `Program artifact file ${index}`);
    const filePath = programArtifactPath(file.path, index);
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new TypeError(`Program artifact file ${index} mode is invalid`);
    }
    digest(file.digest, `Program artifact file ${index} digest`);
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > 512 * 1024 * 1024) {
      throw new TypeError(`Program artifact file ${index} bytes are invalid`);
    }
    if (typeof file.data !== "string" || !/^[A-Za-z0-9_-]*$/u.test(file.data)) {
      throw new TypeError(`Program artifact file ${index} data is not canonical base64url`);
    }
    const decodedFile = Buffer.from(file.data as string, "base64url");
    if (
      decodedFile.toString("base64url") !== file.data ||
      decodedFile.byteLength !== file.bytes ||
      byteDigest(decodedFile) !== file.digest
    ) {
      throw new TypeError(`Program artifact file ${index} bytes do not match their binding`);
    }
    totalBytes += decodedFile.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 2 * 1024 * 1024 * 1024) {
      throw new TypeError("Program artifact expanded bytes exceed the limit");
    }
    return Object.freeze({
      path: filePath,
      mode: file.mode,
      digest: file.digest,
      bytes: file.bytes,
      data: file.data,
    }) as ProgramArtifactFile;
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length || paths.some((filePath, index) => index > 0 && paths[index - 1]! >= filePath)) {
    throw new TypeError("Program artifact paths must be unique and canonically sorted");
  }
  return Object.freeze({
    v: 1,
    target: value.target,
    releaseVersion: value.releaseVersion,
    files: Object.freeze(files),
  }) as ProgramArtifact;
}

const RELEASE_MANIFEST_FIELDS = [
  "artifact", "channel", "durableSchemas", "keyId", "minimumRollbackVersion", "nodeVersion",
  "packageGraphDigest", "protocolRange", "releaseSequence", "releaseVersion", "sourceTreeDigest", "target", "v",
] as const;
const STABLE_RELEASE_INDEX_FIELDS = ["channel", "keyId", "releaseSequence", "releaseVersion", "targets", "v"] as const;

function validateUnsignedReleaseManifest(input: UnsignedReleaseManifest): UnsignedReleaseManifest {
  const value = object(input, "Unsigned release manifest");
  exact(value, RELEASE_MANIFEST_FIELDS, "Unsigned release manifest");
  if (value.v !== 1 || value.channel !== "stable") throw new TypeError("Release manifest version/channel is invalid");
  semver(value.releaseVersion, "Release version");
  sequence(value.releaseSequence);
  target(value.target);
  if (typeof value.nodeVersion !== "string" || !/^22(?:\.[0-9]+){0,2}$/u.test(value.nodeVersion)) {
    throw new TypeError("Release Node version must identify Node 22");
  }
  digest(value.sourceTreeDigest, "Source tree digest");
  digest(value.packageGraphDigest, "Package graph digest");
  const artifact = artifactRef(value.artifact, "Release artifact");
  const protocolRange = compatibility(value.protocolRange, "Protocol range");
  if (!Array.isArray(value.durableSchemas)) throw new TypeError("Durable schemas must be an array");
  const durableSchemas = value.durableSchemas.map((item, index) => {
    const row = compatibility(item, `Durable schema ${index}`);
    assertProtocolIdentifier((item as Record<string, unknown>).schemaId, `Durable schema ${index} id`);
    return Object.freeze({ schemaId: (item as Record<string, unknown>).schemaId as string, ...row });
  });
  const ids = durableSchemas.map((row) => row.schemaId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    throw new TypeError("Durable schemas must be unique and canonically sorted");
  }
  semver(value.minimumRollbackVersion, "Minimum rollback version");
  assertProtocolIdentifier(value.keyId, "Release keyId");
  return Object.freeze({ ...(value as unknown as UnsignedReleaseManifest), artifact, protocolRange, durableSchemas });
}

function validateUnsignedStableReleaseIndex(input: UnsignedStableReleaseIndex): UnsignedStableReleaseIndex {
  const value = object(input, "Unsigned stable release index");
  exact(value, STABLE_RELEASE_INDEX_FIELDS, "Unsigned stable release index");
  if (value.v !== 1 || value.channel !== "stable") throw new TypeError("Stable release index version/channel is invalid");
  semver(value.releaseVersion, "Stable release version");
  sequence(value.releaseSequence);
  assertProtocolIdentifier(value.keyId, "Stable release keyId");
  if (!Array.isArray(value.targets) || value.targets.length !== STABLE_RELEASE_TARGETS.length) {
    throw new TypeError("Stable release index must contain the exact target set");
  }
  const targets = value.targets.map((inputTarget, index) => {
    const row = object(inputTarget, `Stable release target ${index}`);
    exact(row, ["artifactUrl", "manifest", "target"], `Stable release target ${index}`);
    target(row.target);
    https(row.artifactUrl, `Stable release target ${index} artifact URL`);
    const manifest = object(row.manifest, `Stable release target ${index} manifest`);
    exact(manifest, ["bytes", "digest", "url"], `Stable release target ${index} manifest`);
    const ref = artifactRef(manifest, `Stable release target ${index} manifest`);
    https(manifest.url, `Stable release target ${index} manifest URL`);
    return Object.freeze({ target: row.target, artifactUrl: row.artifactUrl, manifest: { ...ref, url: manifest.url } }) as StableReleaseTargetEntry;
  });
  if (targets.some((row, index) => row.target !== STABLE_RELEASE_TARGETS[index])) {
    throw new TypeError("Stable release targets must be the canonical exact set");
  }
  return Object.freeze({ ...(value as unknown as UnsignedStableReleaseIndex), targets });
}

function compatibility(input: unknown, label: string): { readMin: string; readMax: string; writeVersion: string } {
  const value = object(input, label);
  const fields = value.schemaId === undefined ? ["readMax", "readMin", "writeVersion"] : ["readMax", "readMin", "schemaId", "writeVersion"];
  exact(value, fields, label);
  const readMin = validateProtocolVersion(value.readMin);
  const readMax = validateProtocolVersion(value.readMax);
  const writeVersion = validateProtocolVersion(value.writeVersion);
  if (BigInt(readMin) > BigInt(writeVersion) || BigInt(writeVersion) > BigInt(readMax)) {
    throw new TypeError(`${label} write version must be inside read range`);
  }
  return { readMin, readMax, writeVersion };
}

function artifactRef(input: unknown, label: string): ReleaseArtifactRef {
  const value = object(input, label);
  digest(value.digest, `${label} digest`);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) throw new TypeError(`${label} bytes must be positive`);
  return Object.freeze({ digest: value.digest as string, bytes: value.bytes as number });
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return input as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} contains incomplete or unknown fields`);
  }
}

function validateSignature(input: unknown, label: string): Signature {
  const value = object(input, label);
  exact(value, ["alg", "keyId", "sig"], label);
  for (const field of ["alg", "keyId", "sig"] as const) assertProtocolIdentifier(value[field], `${label} ${field}`);
  return value as unknown as Signature;
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new TypeError(`${label} must be a sha256 digest`);
}

function sequence(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > UINT64_MAX) {
    throw new TypeError("Release sequence must be a canonical uint64 decimal string");
  }
}

function semver(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) throw new TypeError(`${label} must be canonical SemVer`);
}

function target(value: unknown): asserts value is StableReleaseTarget {
  if (!STABLE_RELEASE_TARGETS.includes(value as StableReleaseTarget)) throw new TypeError("Release target is unsupported");
}

function https(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must use HTTPS`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError(`${label} must use HTTPS`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new TypeError(`${label} must use HTTPS without credentials`);
}

function stableCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) throw new TypeError(`${label} is invalid`);
}

function programArtifactPath(value: unknown, index: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    throw new TypeError(`Program artifact file ${index} path is invalid`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`Program artifact file ${index} path is invalid`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

export function compareReleaseSemver(left: string, right: string): number {
  semver(left, "Left release version");
  semver(right, "Right release version");
  const parse = (value: string) => value.split(/[+-]/u, 1)[0]!.split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return left === right ? 0 : left.includes("-") ? -1 : right.includes("-") ? 1 : left < right ? -1 : 1;
}
