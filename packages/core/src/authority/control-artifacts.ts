import type {
  ArtifactRef,
  ControlEnvelope,
  ControlRequest,
} from "../contracts/index.js";
import {
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  protocolDigest,
  validateContentAssetRefs,
  validateConversationInvocation,
  validateExplicitEnvironmentSelection,
  validateNonEmptyUserTurnInput,
} from "../protocol/index.js";
import { assertDeliveryItemId } from "../delivery/validation.js";
import { collectArtifactRefs } from "./artifact-references.js";
import { AuthorityStorageError } from "./errors.js";
import type { ArtifactStore } from "./interfaces.js";
import {
  assertCanonicalArtifactRefs,
  normalizedArtifactRefs,
} from "./assignment-artifacts.js";

export interface ControlArtifactClosure {
  readonly roots: readonly ArtifactRef[];
  readonly dependencies: readonly ArtifactRef[];
  readonly references: readonly ArtifactRef[];
}

/**
 * The single strict predicate for control envelopes accepted by the durable
 * control-admission pipeline and its derived consumers.
 */
export function validateAdmittedControlEnvelope(value: unknown): ControlEnvelope {
  const envelope = snapshot(value, "Control envelope");
  assertPlainRecord(envelope, "Control envelope");
  assertExactKeys(
    envelope,
    [
      "at",
      "body",
      "dependencyArtifacts",
      "payloadDigest",
      "principal",
      "requestId",
      "v",
    ],
    "Control envelope",
  );
  if (envelope.v !== 1) throw new TypeError("Control envelope version must be 1");
  assertIdentifier(envelope.requestId, "Control requestId");
  assertCanonicalTime(envelope.at, "Control envelope time");
  assertPlainRecord(envelope.principal, "Control principal");
  assertExactKeys(
    envelope.principal,
    ["connectionId", "deviceId", "surfacePrincipal"],
    "Control principal",
  );
  assertIdentifier(envelope.principal.surfacePrincipal, "surfacePrincipal");
  assertIdentifier(envelope.principal.deviceId, "deviceId");
  assertIdentifier(envelope.principal.connectionId, "connectionId");
  assertCanonicalArtifactRefs(
    envelope.dependencyArtifacts as ArtifactRef[],
    "Control dependency artifacts",
  );
  assertAdmittedControlRequest(envelope.body);
  if (
    canonicalize(
      describeControlArtifactClosure(envelope.body as ControlRequest).dependencies,
    ) !== canonicalize(envelope.dependencyArtifacts)
  ) {
    throw new TypeError(
      "Control dependency artifacts do not match the exact root closure",
    );
  }
  if (
    typeof envelope.payloadDigest !== "string" ||
    envelope.payloadDigest !==
      protocolDigest("ControlEnvelopePayload", 1, {
        body: envelope.body,
        dependencyArtifacts: envelope.dependencyArtifacts,
      })
  ) {
    throw new TypeError("Control envelope payload digest is invalid");
  }
  return envelope as unknown as ControlEnvelope;
}

/**
 * Defines the only artifact-closure interpretation for control requests.
 * Current control fields contain opaque roots, so they cannot declare nested
 * dependencies. New registered root schemas must be added here before use.
 */
export function describeControlArtifactClosure(
  body: ControlRequest,
): ControlArtifactClosure {
  const roots = normalizedArtifactRefs(collectArtifactRefs(body));
  return { roots, dependencies: [], references: roots };
}

export async function resolveControlArtifactClosure(
  envelope: ControlEnvelope,
  artifacts: ArtifactStore,
): Promise<ControlArtifactClosure> {
  assertCanonicalArtifactRefs(
    envelope.dependencyArtifacts,
    "Control dependency artifacts",
  );
  const described = describeControlArtifactClosure(envelope.body);
  if (
    canonicalize(envelope.dependencyArtifacts) !==
    canonicalize(described.dependencies)
  ) {
    throw new TypeError(
      "Control dependency artifacts do not match the exact root closure",
    );
  }
  for (const ref of described.references) {
    if (!(await artifacts.has(ref))) {
      throw new AuthorityStorageError(
        "artifact-missing",
        `Control artifact is not present: ${ref.digest}`,
      );
    }
  }
  return described;
}

function assertAdmittedControlRequest(value: unknown): asserts value is ControlRequest {
  assertPlainRecord(value, "Control request");
  if (value.t === "session-create") {
    assertAllowedKeys(
      value,
      ["requestedName", "sceneId", "t"],
      "session-create request",
    );
    if (value.requestedName !== undefined) {
      assertNonEmptyString(value.requestedName, "requestedName");
    }
    if (value.sceneId !== undefined) assertIdentifier(value.sceneId, "sceneId");
    return;
  }
  if (value.t === "cancel") {
    assertExactKeys(
      value,
      ["conversationId", "ownerEpoch", "runId", "t"],
      "cancel request",
    );
    assertIdentifier(value.conversationId, "cancel conversationId");
    assertIdentifier(value.runId, "cancel runId");
    assertNonNegativeInteger(value.ownerEpoch, "cancel ownerEpoch");
    return;
  }
  if (value.t === "cancel-batch") {
    assertAllowedKeys(
      value,
      ["conversationId", "ownerEpoch", "response", "t"],
      "cancel-batch request",
    );
    assertIdentifier(value.conversationId, "cancel-batch conversationId");
    assertNonNegativeInteger(value.ownerEpoch, "cancel-batch ownerEpoch");
    if (value.response !== undefined) {
      assertPlainRecord(value.response, "cancel-batch response");
      assertExactKeys(value.response, ["replyTarget"], "cancel-batch response");
      const target = value.response.replyTarget;
      assertPlainRecord(target, "cancel-batch replyTarget");
      assertAllowedKeys(
        target,
        ["channelId", "threadId", "to"],
        "cancel-batch replyTarget",
      );
      assertIdentifier(target.channelId, "cancel-batch replyTarget channelId");
      assertIdentifier(target.to, "cancel-batch replyTarget recipient");
      if (target.threadId !== undefined) {
        assertIdentifier(target.threadId, "cancel-batch replyTarget threadId");
      }
    }
    return;
  }
  if (value.t === "session-write") {
    assertExactKeys(
      value,
      ["conversationId", "domainRevision", "mutation", "ownerEpoch", "t"],
      "session-write request",
    );
    assertIdentifier(value.conversationId, "session-write conversationId");
    assertNonNegativeInteger(value.ownerEpoch, "session-write ownerEpoch");
    assertNonNegativeInteger(value.domainRevision, "session-write domainRevision");
    assertPlainRecord(value.mutation, "session-write mutation");
    if (
      value.mutation.kind === "window-op" &&
      (value.mutation.op === "clear" || value.mutation.op === "compact") &&
      Object.keys(value.mutation).sort().join(",") === "kind,op"
    ) {
      return;
    }
    if (
      value.mutation.kind === "conversation-delete" &&
      Object.keys(value.mutation).length === 1
    ) {
      return;
    }
    throw new TypeError("session-write mutation is not supported by conversation authority");
  }
  if (value.t === "job-run") {
    assertExactKeys(value, ["anchorEpoch", "t", "taskId"], "job-run request");
    assertIdentifier(value.taskId, "job-run taskId");
    assertNonNegativeInteger(value.anchorEpoch, "job-run anchorEpoch");
    return;
  }
  if (value.t === "job-cancel") {
    assertExactKeys(
      value,
      ["anchorEpoch", "jobRunId", "t", "taskId"],
      "job-cancel request",
    );
    assertIdentifier(value.taskId, "job-cancel taskId");
    assertIdentifier(value.jobRunId, "job-cancel jobRunId");
    assertNonNegativeInteger(value.anchorEpoch, "job-cancel anchorEpoch");
    return;
  }
  if (value.t === "uncertain-resolve") {
    assertExactKeys(
      value,
      ["decision", "openFactDigest", "ref", "t"],
      "uncertain-resolve request",
    );
    assertPlainRecord(value.ref, "uncertain-resolve ref");
    if (value.ref.execution === "conversation") {
      assertExactKeys(
        value.ref,
        ["conversationId", "execution", "ownerEpoch", "runId"],
        "conversation uncertain-resolve ref",
      );
      assertIdentifier(
        value.ref.conversationId,
        "uncertain-resolve conversationId",
      );
      assertIdentifier(value.ref.runId, "uncertain-resolve runId");
      assertNonNegativeInteger(
        value.ref.ownerEpoch,
        "uncertain-resolve ownerEpoch",
      );
    } else if (value.ref.execution === "job") {
      assertExactKeys(
        value.ref,
        ["anchorEpoch", "execution", "jobRunId", "taskId"],
        "job uncertain-resolve ref",
      );
      assertIdentifier(value.ref.taskId, "uncertain-resolve taskId");
      assertIdentifier(value.ref.jobRunId, "uncertain-resolve jobRunId");
      assertNonNegativeInteger(
        value.ref.anchorEpoch,
        "uncertain-resolve anchorEpoch",
      );
    } else {
      throw new TypeError("uncertain-resolve execution is invalid");
    }
    assertDigest(value.openFactDigest, "uncertain-resolve openFactDigest");
    if (
      value.decision !== "user-verified-side-effects" &&
      value.decision !== "user-abandoned" &&
      value.decision !== "user-retry-acknowledged"
    ) {
      throw new TypeError("uncertain-resolve decision is invalid");
    }
    return;
  }
  if (value.t === "delivery-resolve") {
    assertExactKeys(
      value,
      ["anchorEpoch", "attempt", "decision", "itemId", "openFactDigest", "t"],
      "delivery-resolve request",
    );
    assertDeliveryItemId(value.itemId, "delivery-resolve itemId");
    assertPositiveInteger(value.attempt, "delivery-resolve attempt");
    assertPositiveInteger(value.anchorEpoch, "delivery-resolve anchorEpoch");
    assertDigest(value.openFactDigest, "delivery-resolve openFactDigest");
    if (
      value.decision !== "user-verified-sent" &&
      value.decision !== "abandon" &&
      value.decision !== "retry-risk-ack"
    ) {
      throw new TypeError("delivery-resolve decision is invalid");
    }
    return;
  }
  if (value.t !== "input") {
    throw new TypeError(
      "Control admission does not accept this control request type",
    );
  }
  assertAllowedKeys(
    value,
    [
      "attachments",
      "conversationId",
      "environment",
      "ingress",
      "input",
      "invocation",
      "ownerEpoch",
      "t",
    ],
    "input request",
  );
  assertIdentifier(value.conversationId, "conversationId");
  assertNonNegativeInteger(value.ownerEpoch, "ownerEpoch");
  assertPlainRecord(value.ingress, "Control input ingress reference");
  assertExactKeys(
    value.ingress,
    ["ingressId", "source"],
    "Control input ingress reference",
  );
  assertIdentifier(value.ingress.ingressId, "ingressId");
  if (
    value.ingress.source !== "first-party" &&
    value.ingress.source !== "channel"
  ) {
    throw new TypeError("Control input source is invalid");
  }
  validateNonEmptyUserTurnInput(value.input);
  if (value.environment !== undefined) {
    if (value.ingress.source !== "first-party") {
      throw new TypeError(
        "Only first-party input may carry an explicit environment selection",
      );
    }
    validateExplicitEnvironmentSelection(value.environment);
  }
  if (value.attachments !== undefined) {
    validateContentAssetRefs(value.attachments, {
      label: "Control input attachments",
    });
  }
  validateConversationInvocation(value.invocation);
}

function snapshot(value: unknown, label: string): unknown {
  try {
    return JSON.parse(canonicalize(value)) as unknown;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON data`, {
      cause: error,
    });
  }
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new TypeError(`${label} contains unknown fields`);
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertCanonicalTime(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}
