import type {
  EvidenceKind,
  EvidenceLocator,
} from "../advancement/types.js";
import { isObjectiveEvidenceKind } from "../advancement/types.js";
import type {
  Digest,
  EvidenceBundle,
  EvidenceRequest,
  Signature,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import { validateReservableResourceLease } from "./resource-governor.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";
import { assertProtocolIdentifier } from "./validation.js";

/**
 * 取证请求与证据包整体规范 JSON 字节上限——与权威控制流内联记录同一上限，
 * 两类型都随控制流内联传输，不得溢出为有界日志无法承载的形态。
 */
export const MAX_EVIDENCE_DOCUMENT_BYTES = 32 * 1024;
/** 单项证据摘要上限——与权威合同结构事实文本（错误消息 4 KiB）同一边界。 */
export const MAX_EVIDENCE_SUMMARY_BYTES = 4 * 1024;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type UnsignedEvidenceRequest = Omit<EvidenceRequest, "signature">;
export type UnsignedEvidenceBundle = Omit<EvidenceBundle, "signature">;

/**
 * 观测状态指纹——同一 locator 集合按请求顺序逐项承载 {kind, locator, state}，
 * 读取前后各计算一次；前后不等即观测不一致（consistent=false），该证据包
 * 不得作为可采信证据。
 */
export function evidenceObservationStateFingerprint(
  items: readonly {
    kind: EvidenceKind;
    locator: EvidenceLocator;
    state:
      | { kind: "missing" }
      | { kind: "present"; contentDigest: Digest };
  }[],
): Digest {
  return protocolDigest("EvidenceObservationState", 1, { items: [...items] });
}

export function createSignedEvidenceRequest(
  input: UnsignedEvidenceRequest,
  verifier: ProtocolSignatureVerifier,
  signer: ProtocolSigner,
): EvidenceRequest {
  const payload = validateUnsignedEvidenceRequest(input, verifier);
  const request = {
    ...payload,
    signature: signer.sign("EvidenceRequest", 1, payload),
  };
  assertDocumentBytes(request, "Evidence request");
  return request;
}

export function validateEvidenceRequest(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): EvidenceRequest {
  const value = clone(input, "Evidence request");
  assertPlainObject(value, "Evidence request");
  assertDocumentBytes(value, "Evidence request");
  assertExactKeys(
    value,
    [
      "conversationId",
      "executorId",
      "expiry",
      "issuedAt",
      "items",
      "lease",
      "ownerEpoch",
      "requestId",
      "reviewId",
      "runId",
      "signature",
      "v",
      "workspace",
    ],
    "Evidence request",
  );
  assertSignature(value.signature, "Evidence request signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedEvidenceRequest(
    unsigned as UnsignedEvidenceRequest,
    verifier,
  );
  verifier.verify("EvidenceRequest", 1, payload, signature);
  return value as unknown as EvidenceRequest;
}

export function evidenceRequestDigest(request: EvidenceRequest): Digest {
  const { signature: _, ...payload } = request;
  return protocolDigest("EvidenceRequest", 1, payload);
}

export function createSignedEvidenceBundle(
  input: UnsignedEvidenceBundle,
  signer: ProtocolSigner,
): EvidenceBundle {
  const payload = validateUnsignedEvidenceBundle(input);
  const bundle = {
    ...payload,
    signature: signer.sign("EvidenceBundle", 1, payload),
  };
  assertDocumentBytes(bundle, "Evidence bundle");
  return bundle;
}

export function validateEvidenceBundle(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): EvidenceBundle {
  const value = clone(input, "Evidence bundle");
  assertPlainObject(value, "Evidence bundle");
  assertDocumentBytes(value, "Evidence bundle");
  assertExactKeys(
    value,
    [
      "executorId",
      "items",
      "observation",
      "requestDigest",
      "requestId",
      "signature",
      "v",
    ],
    "Evidence bundle",
  );
  assertSignature(value.signature, "Evidence bundle signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedEvidenceBundle(
    unsigned as UnsignedEvidenceBundle,
  );
  verifier.verify("EvidenceBundle", 1, payload, signature);
  return value as unknown as EvidenceBundle;
}

function validateUnsignedEvidenceRequest(
  input: UnsignedEvidenceRequest,
  verifier: ProtocolSignatureVerifier,
): UnsignedEvidenceRequest {
  const value = clone(input, "Unsigned evidence request");
  assertPlainObject(value, "Unsigned evidence request");
  assertExactKeys(
    value,
    [
      "conversationId",
      "executorId",
      "expiry",
      "issuedAt",
      "items",
      "lease",
      "ownerEpoch",
      "requestId",
      "reviewId",
      "runId",
      "v",
      "workspace",
    ],
    "Unsigned evidence request",
  );
  if (value.v !== 1) {
    throw new TypeError("Evidence request version must be 1");
  }
  assertProtocolIdentifier(value.requestId, "Evidence request requestId");
  assertProtocolIdentifier(value.reviewId, "Evidence request reviewId");
  assertProtocolIdentifier(value.runId, "Evidence request runId");
  assertProtocolIdentifier(
    value.conversationId,
    "Evidence request conversationId",
  );
  assertProtocolIdentifier(value.executorId, "Evidence request executorId");
  assertPositiveInteger(value.ownerEpoch, "Evidence request ownerEpoch");
  assertWorkspace(value.workspace, "Evidence request workspace");
  assertItems(value.items, "Evidence request");
  const lease = validateReservableResourceLease(value.lease, verifier);
  if (
    lease.workload.kind !== "evidence" ||
    lease.workload.id !== value.requestId ||
    lease.admissionClass !== "advancement" ||
    lease.audience.executorId !== value.executorId ||
    lease.scopeBinding.kind !== "conversation" ||
    lease.scopeBinding.conversationId !== value.conversationId ||
    lease.scopeBinding.ownerEpoch !== value.ownerEpoch
  ) {
    throw new TypeError(
      "Evidence resource lease does not bind the evidence request",
    );
  }
  const issuedAt = parseCanonicalTime(
    value.issuedAt,
    "Evidence request issuedAt",
  );
  const expiry = parseCanonicalTime(value.expiry, "Evidence request expiry");
  if (expiry <= issuedAt) {
    throw new TypeError("Evidence request expiry must follow issuedAt");
  }
  return value as unknown as UnsignedEvidenceRequest;
}

function validateUnsignedEvidenceBundle(
  input: UnsignedEvidenceBundle,
): UnsignedEvidenceBundle {
  const value = clone(input, "Unsigned evidence bundle");
  assertPlainObject(value, "Unsigned evidence bundle");
  assertExactKeys(
    value,
    [
      "executorId",
      "items",
      "observation",
      "requestDigest",
      "requestId",
      "v",
    ],
    "Unsigned evidence bundle",
  );
  if (value.v !== 1) {
    throw new TypeError("Evidence bundle version must be 1");
  }
  assertProtocolIdentifier(value.requestId, "Evidence bundle requestId");
  assertProtocolIdentifier(value.executorId, "Evidence bundle executorId");
  assertDigest(value.requestDigest, "Evidence bundle request digest");
  assertObservation(value.observation);
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new TypeError("Evidence bundle items must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const label = `Evidence bundle item ${index}`;
    assertPlainObject(item, label);
    assertExactKeys(
      item,
      ["contentDigest", "kind", "locator", "source", "summary"],
      label,
    );
    assertEvidenceKind(item.kind, label);
    assertLocator(item.locator, label);
    assertDigest(item.contentDigest, `${label} content digest`);
    if (item.source !== "independent") {
      throw new TypeError(`${label} source must be independent`);
    }
    if (
      typeof item.summary !== "string" ||
      item.summary.length === 0 ||
      Buffer.byteLength(item.summary, "utf8") > MAX_EVIDENCE_SUMMARY_BYTES
    ) {
      throw new TypeError(`${label} summary is empty or exceeds the limit`);
    }
    const identity = canonicalize([item.kind, item.locator]);
    if (seen.has(identity)) {
      throw new TypeError("Evidence bundle items must not contain duplicates");
    }
    seen.add(identity);
  }
  return value as unknown as UnsignedEvidenceBundle;
}

function assertDocumentBytes(value: unknown, label: string): void {
  if (
    Buffer.byteLength(canonicalize(value), "utf8") > MAX_EVIDENCE_DOCUMENT_BYTES
  ) {
    throw new TypeError(`${label} exceeds the inline byte limit`);
  }
}

function assertItems(
  input: unknown,
  parentLabel: string,
): void {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(`${parentLabel} items must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    const label = `${parentLabel} item ${index}`;
    assertPlainObject(item, label);
    const keys = ["kind", "locator", ...(item.digestHint !== undefined ? ["digestHint"] : [])];
    assertExactKeys(item, keys, label);
    assertEvidenceKind(item.kind, label);
    assertLocator(item.locator, label);
    if (item.digestHint !== undefined) {
      assertDigest(item.digestHint, `${label} digest hint`);
    }
    const identity = canonicalize([item.kind, item.locator]);
    if (seen.has(identity)) {
      throw new TypeError(`${parentLabel} items must not contain duplicates`);
    }
    seen.add(identity);
  }
}

function assertEvidenceKind(value: unknown, label: string): void {
  if (typeof value !== "string" || !isObjectiveEvidenceKind(value as EvidenceKind)) {
    throw new TypeError(`${label} kind is not a collectible evidence kind`);
  }
}

function assertWorkspace(value: unknown, label: string): void {
  assertPlainObject(value, label);
  assertExactKeys(value, ["bindingRef", "workspaceBindingRevision"], label);
  const workspace = value as Record<string, unknown>;
  assertProtocolIdentifier(workspace.bindingRef, `${label} bindingRef`);
  assertPositiveInteger(
    workspace.workspaceBindingRevision,
    `${label} workspace binding revision`,
  );
}

function assertLocator(value: unknown, label: string): void {
  assertPlainObject(value, label);
  const locator = value as Record<string, unknown>;
  assertExactKeys(
    locator,
    locator.paths !== undefined ? ["paths"] : [],
    `${label} locator`,
  );
  if (locator.paths === undefined) return;
  if (!Array.isArray(locator.paths) || locator.paths.length === 0) {
    throw new TypeError(`${label} locator paths must be a non-empty array`);
  }
  for (const entry of locator.paths) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${label} locator path must be a non-empty string`);
    }
    // 定位是契约级 workspace 相对路径——绝对路径既泄漏设备布局又越出契约边界。
    if (
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      entry.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(entry)
    ) {
      throw new TypeError(`${label} locator path must be workspace-relative`);
    }
  }
}

function assertObservation(value: unknown): void {
  const label = "Evidence bundle observation";
  assertPlainObject(value, label);
  const observation = value as Record<string, unknown>;
  assertExactKeys(
    observation,
    ["consistent", "observedAt", "postStateFingerprint", "preStateFingerprint"],
    label,
  );
  parseCanonicalTime(observation.observedAt, `${label} observedAt`);
  assertDigest(observation.preStateFingerprint, `${label} pre-state fingerprint`);
  assertDigest(
    observation.postStateFingerprint,
    `${label} post-state fingerprint`,
  );
  if (typeof observation.consistent !== "boolean") {
    throw new TypeError(`${label} consistent must be a boolean`);
  }
}

function clone(input: unknown, label: string): Record<string, unknown> {
  try {
    return JSON.parse(canonicalize(input)) as Record<string, unknown>;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON data`, {
      cause: error,
    });
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
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
      canonicalize([...keys].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
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

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function parseCanonicalTime(value: unknown, label: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return time;
}
