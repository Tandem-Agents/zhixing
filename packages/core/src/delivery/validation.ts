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
