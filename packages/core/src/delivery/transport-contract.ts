import type { DeliveryResult } from "../channels/types.js";
import type { DeliveryEndpointDto } from "../contracts/index.js";
import type { DeliveryEndpointTransport } from "./types.js";
import { assertDeliveryIdentifier } from "./validation.js";

export type DeliveryOutcomePolicy = ReturnType<DeliveryEndpointTransport["outcomePolicy"]>;

const SAFE_AUTHORITY_FAILURE = "Delivery transport rejected the request";

export function requireDeliveryEndpointTransport(
  value: unknown,
  endpointKind?: DeliveryEndpointDto["kind"],
): asserts value is DeliveryEndpointTransport {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Delivery endpoint transport must be an object");
  }
  const transport = value as Partial<DeliveryEndpointTransport>;
  if (
    (transport.endpointKind !== "channel" && transport.endpointKind !== "webhook") ||
    (endpointKind !== undefined && transport.endpointKind !== endpointKind) ||
    typeof transport.isReady !== "function" ||
    typeof transport.outcomePolicy !== "function" ||
    typeof transport.send !== "function"
  ) {
    throw new TypeError("Delivery endpoint transport contract is invalid");
  }
}

export function requireDeliveryReadiness(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError("Delivery transport readiness must be boolean");
  }
  return value;
}

export function normalizeDeliveryOutcomePolicy(value: unknown): DeliveryOutcomePolicy {
  const record = requirePlainDataRecord(value, "Delivery outcome policy");
  if (record.kind === "manual-resolution") {
    requireExactKeys(record, ["kind"]);
    return { kind: "manual-resolution" };
  }
  if (record.kind === "idempotent-redrive") {
    requireExactKeys(record, ["kind", "windowMs"]);
    if (!Number.isSafeInteger(record.windowMs) || (record.windowMs as number) <= 0) {
      throw new TypeError("Delivery redrive window must be a positive safe integer");
    }
    return { kind: "idempotent-redrive", windowMs: record.windowMs as number };
  }
  throw new TypeError("Delivery outcome policy kind is invalid");
}

export function normalizeDeliveryResult(value: unknown): DeliveryResult {
  const record = requirePlainDataRecord(value, "Delivery result");
  if (typeof record.success !== "boolean" || typeof record.retryable !== "boolean") {
    throw new TypeError("Delivery result flags must be boolean");
  }
  if (record.success) {
    requireExactKeys(record, ["messageId", "receiptBytes", "retryable", "success"], [
      "messageId",
      "receiptBytes",
    ]);
    if (record.retryable) {
      throw new TypeError("Successful delivery result cannot be retryable");
    }
    if (record.messageId !== undefined) {
      assertDeliveryIdentifier(record.messageId, "Delivery message id");
    }
    if (record.receiptBytes !== undefined && !(record.receiptBytes instanceof Uint8Array)) {
      throw new TypeError("Delivery receipt bytes must be a Uint8Array");
    }
    return {
      success: true,
      retryable: false,
      ...(record.messageId !== undefined ? { messageId: record.messageId } : {}),
      ...(record.receiptBytes !== undefined
        ? { receiptBytes: new Uint8Array(record.receiptBytes) }
        : {}),
    };
  }

  requireExactKeys(record, ["error", "retryable", "success"], ["error"]);
  if (record.error !== undefined && typeof record.error !== "string") {
    throw new TypeError("Delivery result error must be a string");
  }
  return {
    success: false,
    retryable: record.retryable,
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

export function normalizeAuthorityDeliveryResult(value: unknown): DeliveryResult {
  const result = normalizeDeliveryResult(value);
  return result.success
    ? result
    : {
        success: false,
        retryable: result.retryable,
        error: SAFE_AUTHORITY_FAILURE,
      };
}

export function authorityDeliveryFailure(): Error {
  return new Error("Authority delivery transport failed");
}

function requirePlainDataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} fields must be strings`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} fields must be enumerable data properties`);
    }
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const allowedSet = new Set(allowed);
  const required = allowed.filter((key) => !optional.includes(key));
  if (
    keys.some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError("Delivery transport value fields are incomplete or unknown");
  }
}
