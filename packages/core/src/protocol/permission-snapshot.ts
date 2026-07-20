import type { Digest, Signature } from "../contracts/index.js";
import type {
  PermissionContextId,
  PermissionRule,
  PortableTrustRule,
  TrustRuleSnapshot,
} from "../security/types.js";
import {
  canonicalize,
  compareCanonicalStrings,
  protocolDigest,
} from "./canonical.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./assignment.js";
import { assertProtocolIdentifier } from "./validation.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function createSignedTrustRuleSnapshot(
  input: Omit<TrustRuleSnapshot, "digest" | "signature" | "v">,
  signer: ProtocolSigner,
): TrustRuleSnapshot {
  const rules = normalizeTrustRulesForSnapshot(input.rules);
  const unsigned = clone({ v: 1 as const, ...input, rules });
  const payload = {
    ...unsigned,
    digest: protocolDigest("TrustRuleSnapshot", 1, unsigned),
  };
  return validateTrustRuleSnapshot({
    ...payload,
    signature: signer.sign("TrustRuleSnapshot", 1, payload),
  });
}

/** Canonical policy content used by both version allocation and signed snapshot creation. */
export function normalizeTrustRulesForSnapshot(
  input: readonly (PermissionRule | PortableTrustRule)[],
): PortableTrustRule[] {
  const rules = input.map(projectPortableTrustRule)
    .sort((a, b) => compareCanonicalStrings(a.id, b.id));
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    validatePortableTrustRule(rule);
    if (ruleIds.has(rule.id)) throw new TypeError("Trust rule ids must be unique");
    ruleIds.add(rule.id);
  }
  return rules;
}

export function validateTrustRuleSnapshot(
  input: unknown,
  verifier?: ProtocolSignatureVerifier,
): TrustRuleSnapshot {
  const value = clone(input) as TrustRuleSnapshot;
  assertPlainRecord(value, "Trust rule snapshot");
  assertExactKeys(
    value,
    ["digest", "generatedAt", "rules", "signature", "snapshotVersion", "v"],
    "Trust rule snapshot",
  );
  if (value.v !== 1) throw new TypeError("Trust rule snapshot version must be 1");
  assertPositiveInteger(value.snapshotVersion, "Trust rule snapshot version");
  assertCanonicalTime(value.generatedAt, "Trust rule snapshot generatedAt");
  assertDenseArray(value.rules, "Trust rule snapshot rules");
  const ruleIds = new Set<string>();
  for (const rule of value.rules) {
    validatePortableTrustRule(rule);
    if (ruleIds.has(rule.id)) throw new TypeError("Trust rule ids must be unique");
    ruleIds.add(rule.id);
  }
  assertSorted(value.rules, (rule) => rule.id, "Trust rules");
  assertDigest(value.digest, "Trust rule snapshot digest");
  const { digest: _, signature: __, ...digestPayload } = value;
  if (value.digest !== protocolDigest("TrustRuleSnapshot", 1, digestPayload)) {
    throw new TypeError("Trust rule snapshot digest is invalid");
  }
  validateSignature(value.signature, "Trust rule snapshot signature");
  const { signature: ___, ...signedPayload } = value;
  verifier?.verify(
    "TrustRuleSnapshot",
    1,
    signedPayload,
    value.signature,
  );
  return value;
}

function projectPortableTrustRule(
  input: PermissionRule | PortableTrustRule,
): PortableTrustRule {
  const projected: PortableTrustRule = {
    id: input.id,
    pattern: {
      tool: input.pattern.tool,
      argument: input.pattern.argument,
    },
    decision: input.decision,
    scope: input.scope,
    createdAt: input.createdAt,
  };
  if (input.contextId !== undefined) {
    projected.contextId = clone(input.contextId);
  }
  if (input.contributors !== undefined) {
    projected.contributors = clone(input.contributors);
  }
  validatePortableTrustRule(projected);
  return projected;
}

function validatePortableTrustRule(input: unknown): asserts input is PortableTrustRule {
  assertPlainRecord(input, "Trust rule");
  assertAllowedKeys(
    input,
    [
      "contextId",
      "contributors",
      "createdAt",
      "decision",
      "id",
      "pattern",
      "scope",
    ],
    "Trust rule",
  );
  for (const key of [
    "createdAt",
    "decision",
    "id",
    "pattern",
    "scope",
  ] as const) {
    if (!(key in input)) throw new TypeError("Trust rule is incomplete");
  }
  assertProtocolIdentifier(input.id, "Trust rule id");
  assertPlainRecord(input.pattern, "Trust rule pattern");
  assertExactKeys(input.pattern, ["argument", "tool"], "Trust rule pattern");
  assertBoundedString(input.pattern.tool, "Trust rule tool pattern");
  assertBoundedString(input.pattern.argument, "Trust rule argument pattern", 8_192);
  if (input.decision !== "allow" && input.decision !== "deny") {
    throw new TypeError("Trust rule decision is invalid");
  }
  if (!["builtin", "context", "global", "session"].includes(input.scope as string)) {
    throw new TypeError("Trust rule scope is invalid");
  }
  assertNonNegativeInteger(input.createdAt, "Trust rule createdAt");
  if (input.scope === "context") {
    if (input.contextId === undefined) {
      throw new TypeError("Context trust rule requires contextId");
    }
    validatePermissionContextId(input.contextId);
  } else if (input.contextId !== undefined) {
    throw new TypeError("Non-context trust rule cannot carry context identity");
  }
  if (input.contributors !== undefined) {
    assertDenseArray(input.contributors, "Trust rule contributors");
    for (const contribution of input.contributors) {
      assertPlainRecord(contribution, "Trust contribution");
      assertExactKeys(contribution, ["origin", "timestamp"], "Trust contribution");
      if (contribution.origin !== "user" && contribution.origin !== "steward") {
        throw new TypeError("Trust contribution origin is invalid");
      }
      assertNonNegativeInteger(contribution.timestamp, "Trust contribution timestamp");
    }
  }
}

function validatePermissionContextId(input: unknown): asserts input is PermissionContextId {
  assertPlainRecord(input, "Trust rule contextId");
  if (input.kind === "main") {
    assertExactKeys(input, ["kind"], "Trust rule contextId");
    return;
  }
  if (input.kind === "workspace") {
    assertExactKeys(input, ["hash", "kind"], "Trust rule contextId");
    assertProtocolIdentifier(input.hash, "Trust rule workspace hash");
    return;
  }
  if (input.kind === "scene") {
    assertExactKeys(input, ["kind", "sceneId"], "Trust rule contextId");
    assertProtocolIdentifier(input.sceneId, "Trust rule sceneId");
    return;
  }
  throw new TypeError("Trust rule contextId kind is invalid");
}

function clone<T>(input: T): T {
  try {
    return JSON.parse(canonicalize(input)) as T;
  } catch (error) {
    throw new TypeError("Trust rule snapshot must be canonical JSON", { cause: error });
  }
}

function validateSignature(input: unknown, label: string): asserts input is Signature {
  assertPlainRecord(input, label);
  assertExactKeys(input, ["alg", "keyId", "sig"], label);
  assertBoundedString(input.alg, `${label} algorithm`);
  assertBoundedString(input.keyId, `${label} keyId`);
  assertBoundedString(input.sig, `${label} value`, 16_384);
}

function assertDigest(input: unknown, label: string): asserts input is Digest {
  if (typeof input !== "string" || !DIGEST_PATTERN.test(input)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertCanonicalTime(input: unknown, label: string): asserts input is string {
  if (typeof input !== "string") throw new TypeError(`${label} is invalid`);
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertNonNegativeInteger(input: unknown, label: string): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(input: unknown, label: string): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertBoundedString(
  input: unknown,
  label: string,
  maximum = 480,
): asserts input is string {
  if (typeof input !== "string" || input.length === 0 || input.length > maximum) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertPlainRecord(
  input: unknown,
  label: string,
): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertDenseArray(input: unknown, label: string): asserts input is unknown[] {
  if (!Array.isArray(input) || Object.keys(input).length !== input.length) {
    throw new TypeError(`${label} must be a dense array`);
  }
}

function assertExactKeys(input: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertAllowedKeys(input: object, allowed: readonly string[], label: string): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
}

function assertSorted<T>(
  input: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): void {
  for (let index = 1; index < input.length; index += 1) {
    if (
      compareCanonicalStrings(
        keyOf(input[index - 1]!),
        keyOf(input[index]!),
      ) >= 0
    ) {
      throw new TypeError(`${label} must be uniquely sorted`);
    }
  }
}
