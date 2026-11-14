import { protocolDigest } from "../protocol/canonical.js";
import {
  assertPrefixedUlid,
  assertProtocolIdentifier,
  isPrefixedUlid,
  MAX_PROTOCOL_IDENTIFIER_LENGTH,
} from "../protocol/validation.js";
import type { DeliveryLifecycleSourceRef } from "./types.js";

export const MAX_DELIVERY_IDENTIFIER_LENGTH = MAX_PROTOCOL_IDENTIFIER_LENGTH;
export const MAX_DELIVERY_DIAGNOSTIC_TEXT_LENGTH = 480;
export const DELIVERY_ITEM_ID_PREFIX = "dlv-";

const ADMITTED_CONVERSATION_RUN_PREFIX = "admitted-run:";
const ADMITTED_CONVERSATION_RUN_SUFFIX_LENGTH = ":sha256:".length + 64;
const ADMITTED_CONVERSATION_RUN_SUFFIX_PATTERN = /^:sha256:[0-9a-f]{64}$/u;

export function admittedConversationRunLifecycleSource(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly queuedPosition: number;
}): DeliveryLifecycleSourceRef {
  assertDeliveryIdentifier(input.conversationId, "Admitted run conversation id");
  assertDeliveryIdentifier(input.runId, "Admitted run id");
  if (!Number.isSafeInteger(input.queuedPosition) || input.queuedPosition < 0) {
    throw new TypeError("Admitted run queuedPosition must be a non-negative safe integer");
  }
  const identityDigest = protocolDigest("AdmittedConversationRunIdentity", 1, {
    conversationId: input.conversationId,
    runId: input.runId,
  });
  const id = `${ADMITTED_CONVERSATION_RUN_PREFIX}${input.conversationId}:${identityDigest}`;
  assertDeliveryIdentifier(id, "Admitted run lifecycle source id");
  const revision = protocolDigest("AdmittedConversationRunLifecycleSource", 1, {
    conversationId: input.conversationId,
    runId: input.runId,
    queuedPosition: input.queuedPosition,
  });
  return Object.freeze({
    owner: "conversation" as const,
    id,
    revision,
  });
}

export function parseAdmittedConversationRunSource(
  id: string,
): { readonly conversationId: string; readonly identityDigest: string } | undefined {
  if (
    typeof id !== "string" ||
    !id.startsWith(ADMITTED_CONVERSATION_RUN_PREFIX) ||
    id.length <= ADMITTED_CONVERSATION_RUN_PREFIX.length + ADMITTED_CONVERSATION_RUN_SUFFIX_LENGTH ||
    id.length > MAX_DELIVERY_IDENTIFIER_LENGTH
  ) {
    return undefined;
  }
  const suffixStart = id.length - ADMITTED_CONVERSATION_RUN_SUFFIX_LENGTH;
  const suffix = id.slice(suffixStart);
  if (!ADMITTED_CONVERSATION_RUN_SUFFIX_PATTERN.test(suffix)) {
    return undefined;
  }
  const conversationId = id.slice(ADMITTED_CONVERSATION_RUN_PREFIX.length, suffixStart);
  if (conversationId.length === 0) return undefined;
  return Object.freeze({
    conversationId,
    identityDigest: suffix.slice(1),
  });
}

export function assertDeliveryIdentifier(value: unknown, label: string): asserts value is string {
  assertProtocolIdentifier(value, label);
}

export function isDeliveryItemId(value: unknown): value is string {
  return isPrefixedUlid(value, DELIVERY_ITEM_ID_PREFIX);
}

export function assertDeliveryItemId(
  value: unknown,
  label = "Delivery item id",
): asserts value is string {
  assertPrefixedUlid(value, DELIVERY_ITEM_ID_PREFIX, label);
}

export function assertDeliveryLifecycleSourceRef(
  source: DeliveryLifecycleSourceRef,
): void {
  if (
    source.owner !== "conversation" &&
    source.owner !== "assignment" &&
    source.owner !== "scheduler"
  ) {
    throw new TypeError("Delivery lifecycle source owner is invalid");
  }
  assertDeliveryIdentifier(source.id, "Delivery lifecycle source id");
  if (
    typeof source.revision !== "string" ||
    source.revision.length === 0 ||
    source.revision.length > 512
  ) {
    throw new TypeError("Delivery lifecycle source revision is invalid");
  }
}

export function assertDeliveryDiagnosticText(
  value: unknown,
  label: string,
  options: { readonly nonEmpty?: boolean } = {},
): asserts value is string {
  if (
    typeof value !== "string" ||
    (options.nonEmpty === true && value.length === 0) ||
    value.length > MAX_DELIVERY_DIAGNOSTIC_TEXT_LENGTH
  ) {
    throw new TypeError(`${label} must be a bounded string`);
  }
}

/** Produces a stable, Unicode-safe label that always fits the delivery wire budget. */
export function projectDeliveryDisplayText(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Delivery display text must be a non-empty string");
  }
  if (value.length <= MAX_DELIVERY_DIAGNOSTIC_TEXT_LENGTH) return value;

  const budget = MAX_DELIVERY_DIAGNOSTIC_TEXT_LENGTH - 1;
  let prefix = "";
  for (const symbol of value) {
    if (prefix.length + symbol.length > budget) break;
    prefix += symbol;
  }
  return `${prefix}…`;
}
