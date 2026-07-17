import type { ArtifactRef, AuthorityError } from "../contracts/foundation.js";
import type { PublishRecord } from "../contracts/records.js";
import { assertProtocolIdentifier } from "./validation.js";

export const MAX_AUTHORITY_ERROR_MESSAGE_BYTES = 4 * 1024;

const AUTHORITY_ERROR_CODES: ReadonlySet<AuthorityError["code"]> = new Set([
  "unauthorized",
  "capability-expired",
  "epoch-stale",
  "revision-conflict",
  "fence-rejected",
  "busy",
  "not-found",
  "invalid",
  "lease-exhausted",
  "missing-base",
  "typed-stale",
  "capability-gap",
  "unavailable-offline",
  "idempotency-conflict",
]);

export function validateAuthorityError(
  value: unknown,
  label = "Authority error",
): AuthorityError {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["code", "message", "retryable"], label);
  if (
    typeof value.code !== "string" ||
    !AUTHORITY_ERROR_CODES.has(value.code as AuthorityError["code"])
  ) {
    throw new TypeError(`${label} code is invalid`);
  }
  if (
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    new TextEncoder().encode(value.message).byteLength > MAX_AUTHORITY_ERROR_MESSAGE_BYTES
  ) {
    throw new TypeError(`${label} message must be a non-empty bounded string`);
  }
  if (typeof value.retryable !== "boolean") {
    throw new TypeError(`${label} retryable must be boolean`);
  }
  return value as unknown as AuthorityError;
}

export function validatePublishDecisionRecord(
  value: unknown,
): Extract<PublishRecord, { t: "publish-decision" }> {
  assertPlainRecord(value, "Publish decision");
  assertExactKeys(
    value,
    ["assignmentId", "batch", "globalCount", "outcomes", "sessionCount", "t"],
    "Publish decision",
  );
  if (value.t !== "publish-decision") {
    throw new TypeError("Publish decision type is invalid");
  }
  assertProtocolIdentifier(value.assignmentId, "Publish assignment id");
  validateArtifactReference(value.batch, "Publish mutation batch");
  assertNonNegativeInteger(value.sessionCount, "Publish session count");
  assertNonNegativeInteger(value.globalCount, "Publish global count");
  if (!Array.isArray(value.outcomes)) {
    throw new TypeError("Publish decision outcomes must be an array");
  }
  const expectedCount = (value.sessionCount as number) + (value.globalCount as number);
  if (value.outcomes.length !== expectedCount) {
    throw new TypeError("Publish decision outcomes do not match its declared counts");
  }
  for (const [index, item] of value.outcomes.entries()) {
    assertPlainRecord(item, "Publish outcome");
    assertExactKeys(item, ["outcome", "seq"], "Publish outcome");
    assertPositiveInteger(item.seq, "Publish outcome sequence");
    if (item.seq !== index + 1) {
      throw new TypeError("Publish decision outcomes must be contiguous and ordered");
    }
    assertPlainRecord(item.outcome, "Publish outcome value");
    if (item.outcome.t === "granted") {
      assertExactKeys(item.outcome, ["t", "targetRevision"], "Granted publish outcome");
      assertPositiveInteger(item.outcome.targetRevision, "Granted target revision");
    } else if (item.outcome.t === "conflicted") {
      assertExactKeys(item.outcome, ["error", "t"], "Conflicted publish outcome");
      validateAuthorityError(item.outcome.error, "Publish conflict error");
    } else {
      throw new TypeError("Publish outcome type is invalid");
    }
  }
  return value as unknown as Extract<PublishRecord, { t: "publish-decision" }>;
}

function validateArtifactReference(value: unknown, label: string): ArtifactRef {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["ref"], label);
  assertPlainRecord(value.ref, `${label} reference`);
  assertExactKeys(value.ref, ["bytes", "digest"], `${label} reference`);
  if (
    typeof value.ref.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.ref.digest)
  ) {
    throw new TypeError(`${label} digest is invalid`);
  }
  if (!Number.isSafeInteger(value.ref.bytes) || (value.ref.bytes as number) < 0) {
    throw new TypeError(`${label} byte length is invalid`);
  }
  return value.ref as unknown as ArtifactRef;
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}
