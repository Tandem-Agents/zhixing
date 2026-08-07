import { assertArtifactRef } from "../authority/artifact-references.js";
import type {
  DeferredGlobalIntent,
  IntentStreamRecord,
  RubricWriteMutation,
} from "../contracts/index.js";
import { protocolDigest } from "./canonical.js";
import { validateGlobalStagedMutation } from "./commit.js";
import {
  assertPrefixedUlid,
  assertProtocolIdentifier,
} from "./validation.js";

export const DEFERRED_INTENT_STREAM_PREFIX = "intent:";
const NON_CONVERSATION_INTENT_STREAMS = new Set(["intent:rubric-registry"]);

export function deferredIntentStream(conversationId: string): string {
  assertProtocolIdentifier(conversationId, "Deferred intent conversation id");
  return `${DEFERRED_INTENT_STREAM_PREFIX}${conversationId}`;
}

export function isDeferredIntentStream(stream: string): boolean {
  return stream.startsWith(DEFERRED_INTENT_STREAM_PREFIX) &&
    stream.length > DEFERRED_INTENT_STREAM_PREFIX.length &&
    !NON_CONVERSATION_INTENT_STREAMS.has(stream);
}

export function deferredGlobalIntentDigest(intent: DeferredGlobalIntent): string {
  validateDeferredGlobalIntent(intent);
  return protocolDigest("DeferredGlobalIntent", 1, intent);
}

export function deferredIntentMutationDigest(
  mutation: DeferredGlobalIntent["mutation"],
  timeSensitive: boolean,
): string {
  validateDeferredIntentMutation(mutation, timeSensitive);
  return protocolDigest("DeferredGlobalIntentMutation", 1, {
    mutation,
    timeSensitive,
  });
}

export function validateDeferredIntentMutation(
  mutation: DeferredGlobalIntent["mutation"],
  timeSensitive: boolean,
): void {
  if (!isPlainRecord(mutation)) {
    throw new TypeError("Deferred intent mutation must be a plain object");
  }
  if (isScheduleKind(mutation.kind)) {
    if (timeSensitive !== true) {
      throw new TypeError("Schedule deferred intents must be time-sensitive");
    }
    validateGlobalStagedMutation(mutation as never);
    return;
  }
  if (
    mutation.kind !== "rubric-save-own" &&
    mutation.kind !== "rubric-update-own"
  ) {
    throw new TypeError("Deferred intent mutation is outside its closed union");
  }
  if (timeSensitive !== false) {
    throw new TypeError("Rubric deferred intents must not be time-sensitive");
  }
  validateRubricMutation(mutation as Extract<
    RubricWriteMutation,
    { kind: "rubric-save-own" | "rubric-update-own" }
  >);
}

export function validateDeferredGlobalIntent(value: unknown): asserts value is DeferredGlobalIntent {
  if (!isPlainRecord(value)) {
    throw new TypeError("Deferred global intent must be a plain object");
  }
  assertExactKeys(
    value,
    [
      "conversationId",
      "intentId",
      "localDomainId",
      "mutation",
      "recordedAt",
      "reviewedAt",
      "status",
      "timeSensitive",
    ],
    true,
  );
  assertPrefixedUlid(value.intentId, "int-", "Deferred intent id");
  assertProtocolIdentifier(value.localDomainId, "Deferred intent local domain id");
  if (!value.localDomainId.startsWith("local:")) {
    throw new TypeError("Deferred intent local domain id must identify a local domain");
  }
  assertProtocolIdentifier(value.conversationId, "Deferred intent conversation id");
  assertCanonicalTime(value.recordedAt, "Deferred intent recordedAt");
  if (typeof value.timeSensitive !== "boolean") {
    throw new TypeError("Deferred intent timeSensitive must be boolean");
  }
  validateDeferredIntentMutation(
    value.mutation as DeferredGlobalIntent["mutation"],
    value.timeSensitive,
  );
  if (
    value.status !== "pending" &&
    value.status !== "confirmed" &&
    value.status !== "discarded"
  ) {
    throw new TypeError("Deferred intent status is invalid");
  }
  if (value.status === "pending") {
    if (value.reviewedAt !== undefined) {
      throw new TypeError("Pending deferred intent cannot have reviewedAt");
    }
    return;
  }
  assertCanonicalTime(value.reviewedAt, "Deferred intent reviewedAt");
  if (Date.parse(value.reviewedAt) < Date.parse(value.recordedAt)) {
    throw new TypeError("Deferred intent review precedes its recording");
  }
}

export function validateIntentStreamRecord(
  value: unknown,
  stream?: string,
): asserts value is IntentStreamRecord {
  if (!isPlainRecord(value)) {
    throw new TypeError("Deferred intent stream record must be a plain object");
  }
  assertExactKeys(value, ["intent", "t"]);
  if (value.t !== "intent") {
    throw new TypeError("Deferred intent stream record kind is invalid");
  }
  validateDeferredGlobalIntent(value.intent);
  if (
    stream !== undefined &&
    stream !== deferredIntentStream(value.intent.conversationId)
  ) {
    throw new TypeError("Deferred intent record is stored in the wrong stream");
  }
}

export function reduceDeferredGlobalIntent(
  current: DeferredGlobalIntent | undefined,
  record: IntentStreamRecord,
  stream?: string,
): DeferredGlobalIntent {
  validateIntentStreamRecord(record, stream);
  const next = structuredClone(record.intent);
  if (!current) {
    if (next.status !== "pending") {
      throw new TypeError("Deferred intent must begin in pending state");
    }
    return next;
  }
  validateDeferredGlobalIntent(current);
  if (
    current.intentId !== next.intentId ||
    current.localDomainId !== next.localDomainId ||
    current.conversationId !== next.conversationId ||
    current.recordedAt !== next.recordedAt ||
    current.timeSensitive !== next.timeSensitive ||
    protocolDigest("DeferredGlobalIntentMutation", 1, current.mutation) !==
      protocolDigest("DeferredGlobalIntentMutation", 1, next.mutation)
  ) {
    throw new TypeError("Deferred intent immutable identity changed");
  }
  if (current.status !== "pending") {
    if (deferredGlobalIntentDigest(current) === deferredGlobalIntentDigest(next)) {
      return structuredClone(current);
    }
    throw new TypeError("Deferred intent terminal state is immutable");
  }
  if (next.status === "pending") {
    throw new TypeError("Deferred intent pending state cannot be appended twice");
  }
  return next;
}

function validateRubricMutation(
  mutation: Extract<
    RubricWriteMutation,
    { kind: "rubric-save-own" | "rubric-update-own" }
  >,
): void {
  assertExactKeys(
    mutation,
    mutation.kind === "rubric-save-own"
      ? ["kind", "rubric"]
      : ["expectedRevision", "kind", "rubric", "rubricId"],
  );
  if (mutation.kind === "rubric-update-own") {
    assertProtocolIdentifier(mutation.rubricId, "Deferred rubric id");
    if (!Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0) {
      throw new TypeError("Deferred rubric expected revision is invalid");
    }
  }
  if (!isPlainRecord(mutation.rubric)) {
    throw new TypeError("Deferred rubric write must be a plain object");
  }
  assertExactKeys(mutation.rubric, ["content", "description", "title"]);
  if (typeof mutation.rubric.title !== "string" || !mutation.rubric.title.trim()) {
    throw new TypeError("Deferred rubric title is required");
  }
  if (
    typeof mutation.rubric.description !== "string" ||
    !mutation.rubric.description.trim()
  ) {
    throw new TypeError("Deferred rubric description is required");
  }
  assertArtifactRef(mutation.rubric.content);
}

function isScheduleKind(kind: unknown): boolean {
  return kind === "schedule-create" || kind === "schedule-update" ||
    kind === "schedule-set-state" || kind === "schedule-delete";
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  optionalLast = false,
): void {
  const keys = Object.keys(value).sort();
  const required = expected.filter((key) => !(optionalLast && key === "reviewedAt"));
  const allowed = new Set(expected);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) {
    throw new TypeError("Deferred intent value contains unknown or missing fields");
  }
}
