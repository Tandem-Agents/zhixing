import type { ResourceLease } from "../contracts/authorization.js";
import { canonicalize, protocolDigest } from "./canonical.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ADMISSION_CLASSES = new Set([
  "interactive",
  "advancement",
  "scheduler",
  "orchestration",
]);
const WORKLOAD_KINDS = new Set([
  "run",
  "job",
  "orchestration-node",
  "control",
  "evidence",
]);
const AUDIENCE_KEYS = ["executorId", "model", "provider"] as const;
const BUDGET_KEYS = ["maxCalls", "maxCostMinor", "maxTokens"] as const;

export interface ResourceLeaseSignatureVerifier {
  verify(
    schemaId: string,
    version: number,
    payload: unknown,
    signature: ResourceLease["signature"],
  ): void;
}

export function assertResourceLeaseBaseContract(
  lease: ResourceLease,
  verifier: ResourceLeaseSignatureVerifier,
  label: string,
): void {
  assertIdentifier(lease.reservationId, `${label} reservationId`);
  if (!ADMISSION_CLASSES.has(String(lease.admissionClass))) {
    throw new TypeError(`${label} admission class is invalid`);
  }

  assertPlainObject(lease.workload, `${label} workload`);
  assertExactKeys(lease.workload, ["attempt", "id", "kind"], `${label} workload`);
  if (!WORKLOAD_KINDS.has(String(lease.workload.kind))) {
    throw new TypeError(`${label} workload kind is invalid`);
  }
  assertIdentifier(lease.workload.id, `${label} workload id`);
  assertPositiveInteger(lease.workload.attempt, `${label} workload attempt`);

  assertScopeBinding(lease.scopeBinding, label);
  assertIdentifierMap(lease.audience, AUDIENCE_KEYS, `${label} audience`);
  assertBudget(lease.budget, `${label} budget`);
  assertDomain(lease.domain, label);

  if (lease.delegation !== undefined) {
    assertPlainObject(lease.delegation, `${label} delegation`);
    assertExactKeys(
      lease.delegation,
      ["executorId", "maxBudget", "maxDepth"],
      `${label} delegation`,
    );
    assertIdentifier(lease.delegation.executorId, `${label} delegation executorId`);
    assertPositiveInteger(lease.delegation.maxDepth, `${label} delegation maxDepth`);
    assertBudget(lease.delegation.maxBudget, `${label} delegation budget`);
  }

  assertCanonicalTime(lease.issuedAt, `${label} issuedAt`);
  assertCanonicalTime(lease.expiry, `${label} expiry`);
  if (Date.parse(lease.expiry) <= Date.parse(lease.issuedAt)) {
    throw new TypeError(`${label} must expire after issuance`);
  }

  assertDigest(lease.digest, `${label} digest`);
  assertSignature(lease.signature, `${label} signature`);
  const unsigned = withoutField(lease, "signature");
  const expectedDigest = protocolDigest(
    "ResourceLease",
    1,
    withoutField(unsigned, "digest"),
  );
  if (lease.digest !== expectedDigest) {
    throw new TypeError(`${label} digest is invalid`);
  }
  verifier.verify("ResourceLease", 1, unsigned, lease.signature);
}

function assertScopeBinding(value: unknown, label: string): void {
  assertPlainObject(value, `${label} scope binding`);
  if (value.kind === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "kind", "ownerEpoch"],
      `${label} scope binding`,
    );
    assertIdentifier(value.conversationId, `${label} scope conversationId`);
    assertPositiveInteger(value.ownerEpoch, `${label} scope ownerEpoch`);
    return;
  }
  if (value.kind === "job") {
    assertExactKeys(
      value,
      ["anchorEpoch", "kind", "taskId"],
      `${label} scope binding`,
    );
    assertIdentifier(value.taskId, `${label} scope taskId`);
    assertPositiveInteger(value.anchorEpoch, `${label} scope anchorEpoch`);
    return;
  }
  if (value.kind === "control") {
    assertExactKeys(value, ["kind", "subject"], `${label} scope binding`);
    assertIdentifier(value.subject, `${label} scope subject`);
    return;
  }
  throw new TypeError(`${label} scope binding kind is invalid`);
}

function assertDomain(value: unknown, label: string): void {
  assertPlainObject(value, `${label} domain`);
  if (value.kind === "anchor") {
    assertExactKeys(value, ["anchorEpoch", "kind"], `${label} domain`);
    assertPositiveInteger(value.anchorEpoch, `${label} domain anchorEpoch`);
    return;
  }
  if (value.kind === "local") {
    assertExactKeys(
      value,
      ["kind", "localDomainId", "localGovernorEpoch"],
      `${label} domain`,
    );
    assertIdentifier(value.localDomainId, `${label} domain localDomainId`);
    assertPositiveInteger(value.localGovernorEpoch, `${label} domain localGovernorEpoch`);
    return;
  }
  throw new TypeError(`${label} domain kind is invalid`);
}

function assertIdentifierMap(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): void {
  assertPlainObject(value, label);
  assertExactKeys(value, allowedKeys, label, true);
  const present = Object.entries(value).filter(([, item]) => item !== undefined);
  if (present.length === 0) {
    throw new TypeError(`${label} must bind at least one value`);
  }
  for (const [key, item] of present) {
    assertIdentifier(item, `${label} ${key}`);
  }
}

function assertBudget(value: unknown, label: string): void {
  assertPlainObject(value, label);
  assertExactKeys(value, BUDGET_KEYS, label, true);
  const present = Object.entries(value).filter(([, item]) => item !== undefined);
  if (present.length === 0) {
    throw new TypeError(`${label} must contain at least one limit`);
  }
  for (const [key, item] of present) {
    assertNonNegativeInteger(item, `${label} ${key}`);
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
  optional = false,
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (optional) {
    if (keys.some((key) => !allowed.includes(key))) {
      throw new TypeError(`${label} contains an unknown field`);
    }
    return;
  }
  if (canonicalize(keys) !== canonicalize(allowed)) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertSignature(
  value: unknown,
  label: string,
): asserts value is ResourceLease["signature"] {
  assertPlainObject(value, label);
  assertExactKeys(value, ["alg", "keyId", "sig"], label);
  assertIdentifier(value.alg, `${label} algorithm`);
  assertIdentifier(value.keyId, `${label} keyId`);
  assertIdentifier(value.sig, `${label} value`);
}

function withoutField<T extends object, K extends keyof T>(
  value: T,
  field: K,
): Omit<T, K> {
  const output = { ...value };
  delete output[field];
  return output;
}
