import type {
  ArtifactRef,
  ContentAssetRef,
  Digest,
  Signature,
  SurfaceAssetGrant,
  SurfaceAssetScope,
} from "../contracts/index.js";
import {
  MAX_SURFACE_ASSET_BYTES,
  MAX_CONTROL_INPUT_ATTACHMENTS,
  MAX_SURFACE_ASSET_GRANT_BYTES,
  MAX_SURFACE_ASSET_GRANT_REFS,
  MAX_SURFACE_ASSET_GRANT_TTL_MS,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";
import {
  assertPrefixedUlid,
  assertProtocolIdentifier,
} from "./validation.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type UnsignedSurfaceAssetGrant = SurfaceAssetGrant extends infer Grant
  ? Grant extends SurfaceAssetGrant
    ? Omit<Grant, "signature">
    : never
  : never;

interface SurfaceAssetGrantOperationBase {
  readonly scope: SurfaceAssetScope;
  readonly surfacePrincipal: string;
}

export type SurfaceAssetGrantOperationBinding =
  | (SurfaceAssetGrantOperationBase & {
      readonly kind: "asset-upload";
      readonly payloadDigest: Digest;
    })
  | (SurfaceAssetGrantOperationBase & {
      readonly kind: "asset-download";
      readonly payloadDigest?: never;
    });

export type SurfaceAssetGrantUse = SurfaceAssetGrantOperationBinding & {
  readonly ref: ArtifactRef;
  readonly at: string;
};

interface SurfaceAssetGrantIssueBase {
  readonly scope: SurfaceAssetScope;
  readonly requestId: string;
  readonly assets: readonly ArtifactRef[];
}

export type SurfaceAssetGrantIssueBinding =
  | (SurfaceAssetGrantIssueBase & {
      readonly kind: "asset-upload";
      readonly payloadDigest: Digest;
    })
  | (SurfaceAssetGrantIssueBase & {
      readonly kind: "asset-download";
      readonly payloadDigest?: never;
    });

export function validateSurfaceAssetGrantIssueBinding(
  input: unknown,
): SurfaceAssetGrantIssueBinding {
  const request = clone(
    input,
    "Surface asset grant issue binding",
  ) as SurfaceAssetGrantIssueBinding;
  assertPlainObject(request, "Surface asset grant issue binding");
  if (
    request.kind !== "asset-upload" &&
    request.kind !== "asset-download"
  ) {
    throw new TypeError("Surface asset grant issue kind is invalid");
  }
  assertExactKeys(
    request,
    request.kind === "asset-upload"
      ? ["assets", "kind", "payloadDigest", "requestId", "scope"]
      : ["assets", "kind", "requestId", "scope"],
    "Surface asset grant issue binding",
  );
  validateScope(request.scope, "Surface asset grant issue scope");
  assertProtocolIdentifier(
    request.requestId,
    "Surface asset grant issue requestId",
  );
  const assets = validateAssets(
    request.assets,
    "Surface asset grant issue assets",
    true,
  );
  if (request.kind === "asset-upload") {
    assertDigest(
      request.payloadDigest,
      "Surface asset grant issue payload digest",
    );
    return { ...request, assets };
  }
  return { ...request, assets };
}

export function createSignedSurfaceAssetGrant(
  input: UnsignedSurfaceAssetGrant,
  signer: ProtocolSigner,
): SurfaceAssetGrant {
  const payload = validateUnsignedGrant(input, false);
  return {
    ...payload,
    signature: signer.sign("SurfaceAssetGrant", 1, payload),
  } as SurfaceAssetGrant;
}

export function validateSurfaceAssetGrant(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): SurfaceAssetGrant {
  const grant = clone(input, "Surface asset grant") as SurfaceAssetGrant;
  assertPlainObject(grant, "Surface asset grant");
  assertSignature(grant.signature, "Surface asset grant signature");
  const { signature, ...unsigned } = grant;
  const payload = validateUnsignedGrant(
    unsigned as UnsignedSurfaceAssetGrant,
    true,
  );
  verifier.verify("SurfaceAssetGrant", 1, payload, signature);
  return grant;
}

export function surfaceAssetGrantDigest(grant: SurfaceAssetGrant): Digest {
  const { signature: _, ...payload } = grant;
  return protocolDigest("SurfaceAssetGrant", 1, payload) as Digest;
}

export function assertSurfaceAssetGrantUse(
  grant: SurfaceAssetGrant,
  use: SurfaceAssetGrantUse,
): void {
  validateScope(use.scope, "Surface asset use scope");
  assertProtocolIdentifier(
    use.surfacePrincipal,
    "Surface asset use principal",
  );
  assertArtifactRef(use.ref, "Surface asset use reference");
  const at = parseCanonicalTime(use.at, "Surface asset use time");
  const issuedAt = parseCanonicalTime(
    grant.issuedAt,
    "Surface asset grant issuedAt",
  );
  const expiry = parseCanonicalTime(
    grant.expiry,
    "Surface asset grant expiry",
  );
  if (
    canonicalize(grant.scope) !== canonicalize(use.scope) ||
    grant.surfacePrincipal !== use.surfacePrincipal ||
    grant.kind !== use.kind ||
    (use.kind === "asset-download" && use.payloadDigest !== undefined)
  ) {
    throw new TypeError("Surface asset grant does not bind the requested operation");
  }
  if (at < issuedAt || at >= expiry) {
    throw new TypeError("Surface asset grant is not active at the requested time");
  }
  if (
    grant.kind === "asset-upload" &&
    use.payloadDigest !== grant.payloadDigest
  ) {
    throw new TypeError("Surface asset grant does not bind the control payload");
  }
  if (!grant.assets.some((asset) => sameRef(asset, use.ref))) {
    throw new TypeError("Surface asset grant does not contain the requested asset");
  }
}

export function assertSurfaceAssetGrantIssueBinding(
  grant: SurfaceAssetGrant,
  request: SurfaceAssetGrantIssueBinding,
): void {
  const validated = validateSurfaceAssetGrantIssueBinding(request);
  if (
    grant.kind !== validated.kind ||
    canonicalize(grant.scope) !== canonicalize(validated.scope) ||
    grant.requestId !== validated.requestId ||
    canonicalize(grant.assets) !== canonicalize(validated.assets) ||
    (grant.kind === "asset-upload" &&
      validated.kind === "asset-upload" &&
      grant.payloadDigest !== validated.payloadDigest)
  ) {
    throw new TypeError("Surface asset grant does not bind the issue request");
  }
}

export function validateContentAssetRefs(
  input: unknown,
  options: { readonly allowEmpty?: boolean; readonly label?: string } = {},
): ContentAssetRef[] {
  const label = options.label ?? "Content asset references";
  if (
    !Array.isArray(input) ||
    (!options.allowEmpty && input.length === 0) ||
    input.length > MAX_CONTROL_INPUT_ATTACHMENTS
  ) {
    throw new TypeError(`${label} count is outside its bounded range`);
  }
  const assets = input.map((value) => {
    assertPlainObject(value, label);
    assertExactKeys(value, ["bytes", "digest", "kind"], label);
    assertArtifactRef(
      { digest: value.digest, bytes: value.bytes },
      label,
    );
    if (
      value.kind !== "image" &&
      value.kind !== "file" &&
      value.kind !== "tool-output" &&
      value.kind !== "window-snapshot"
    ) {
      throw new TypeError(`${label} kind is invalid`);
    }
    if ((value.bytes as number) > MAX_SURFACE_ASSET_BYTES) {
      throw new TypeError(`${label} contains an asset above its byte bound`);
    }
    return {
      digest: value.digest,
      bytes: value.bytes,
      kind: value.kind,
    } as ContentAssetRef;
  });
  const normalized = [...assets].sort((left, right) =>
    left.digest.localeCompare(right.digest) || left.bytes - right.bytes
  );
  if (canonicalize(assets) !== canonicalize(normalized)) {
    throw new TypeError(`${label} must be in canonical order`);
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.digest === normalized[index]!.digest) {
      throw new TypeError(`${label} contains duplicate digests`);
    }
  }
  return assets;
}

function validateUnsignedGrant(
  input: UnsignedSurfaceAssetGrant,
  requireCanonicalOrder: boolean,
): UnsignedSurfaceAssetGrant {
  const grant = clone(input, "Unsigned surface asset grant") as
    UnsignedSurfaceAssetGrant;
  assertPlainObject(grant, "Unsigned surface asset grant");
  const baseKeys = [
    "assets",
    "expiry",
    "grantId",
    "issuedAt",
    "kind",
    "requestId",
    "scope",
    "surfacePrincipal",
    "v",
  ];
  assertExactKeys(
    grant,
    grant.kind === "asset-upload"
      ? [...baseKeys, "payloadDigest"]
      : baseKeys,
    "Unsigned surface asset grant",
  );
  if (grant.v !== 1) {
    throw new TypeError("Surface asset grant version must be 1");
  }
  if (grant.kind !== "asset-upload" && grant.kind !== "asset-download") {
    throw new TypeError("Surface asset grant kind is invalid");
  }
  assertPrefixedUlid(grant.grantId, "grt-", "Surface asset grant id");
  validateScope(grant.scope, "Surface asset grant scope");
  assertProtocolIdentifier(
    grant.surfacePrincipal,
    "Surface asset grant principal",
  );
  assertProtocolIdentifier(grant.requestId, "Surface asset grant requestId");
  if (grant.kind === "asset-upload") {
    assertDigest(grant.payloadDigest, "Surface asset grant payload digest");
  }
  const assets = validateAssets(
    grant.assets,
    "Surface asset grant assets",
    requireCanonicalOrder,
  );
  const issuedAt = parseCanonicalTime(
    grant.issuedAt,
    "Surface asset grant issuedAt",
  );
  const expiry = parseCanonicalTime(
    grant.expiry,
    "Surface asset grant expiry",
  );
  if (expiry <= issuedAt) {
    throw new TypeError("Surface asset grant expiry must follow issuedAt");
  }
  if (expiry - issuedAt > MAX_SURFACE_ASSET_GRANT_TTL_MS) {
    throw new TypeError("Surface asset grant TTL exceeds its bound");
  }
  return { ...grant, assets } as UnsignedSurfaceAssetGrant;
}

function validateAssets(
  input: unknown,
  label: string,
  requireCanonicalOrder: boolean,
): ArtifactRef[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_SURFACE_ASSET_GRANT_REFS
  ) {
    throw new TypeError(`${label} count is outside its bounded range`);
  }
  const assets = input.map((value) => {
    assertArtifactRef(value, label);
    if (value.bytes > MAX_SURFACE_ASSET_BYTES) {
      throw new TypeError(`${label} contains an asset above its byte bound`);
    }
    return { digest: value.digest, bytes: value.bytes } as ArtifactRef;
  });
  const sorted = [...assets].sort(compareRefs);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.digest === sorted[index]!.digest) {
      throw new TypeError(`${label} contains duplicate digests`);
    }
  }
  const total = sorted.reduce((sum, asset) => sum + asset.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_SURFACE_ASSET_GRANT_BYTES) {
    throw new TypeError(`${label} exceeds its aggregate byte bound`);
  }
  if (
    requireCanonicalOrder &&
    canonicalize(assets) !== canonicalize(sorted)
  ) {
    throw new TypeError(`${label} must be in canonical order`);
  }
  return sorted;
}

function validateScope(
  value: unknown,
  label: string,
): asserts value is SurfaceAssetScope {
  assertPlainObject(value, label);
  if (value.domain === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "domain", "ownerEpoch"],
      label,
    );
    assertProtocolIdentifier(value.conversationId, `${label} conversationId`);
    assertPositiveInteger(value.ownerEpoch, `${label} ownerEpoch`);
    return;
  }
  if (value.domain === "global") {
    assertExactKeys(value, ["anchorEpoch", "domain"], label);
    assertPositiveInteger(value.anchorEpoch, `${label} anchorEpoch`);
    return;
  }
  throw new TypeError(`${label} domain is invalid`);
}

function assertArtifactRef(
  value: unknown,
  label: string,
): asserts value is ArtifactRef {
  assertPlainObject(value, label);
  assertExactKeys(value, ["bytes", "digest"], label);
  assertDigest(value.digest, `${label} digest`);
  if (
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    throw new TypeError(`${label} bytes must be a non-negative safe integer`);
  }
}

function assertSignature(
  value: unknown,
  label: string,
): asserts value is Signature {
  assertPlainObject(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertProtocolIdentifier(value.alg, `${label} algorithm`);
  assertProtocolIdentifier(value.keyId, `${label} keyId`);
  assertProtocolIdentifier(value.sig, `${label} bytes`);
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function parseCanonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...expected].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
  return left.digest.localeCompare(right.digest) || left.bytes - right.bytes;
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.digest === right.digest && left.bytes === right.bytes;
}

function clone(value: unknown, label: string): unknown {
  try {
    return JSON.parse(canonicalize(value));
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, {
      cause: error,
    });
  }
}
