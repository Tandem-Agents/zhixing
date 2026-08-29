import type {
  DeliveryFailure,
  DeliveryStreamRecord,
} from "../contracts/index.js";

export interface DeliveryAttemptPolicyState {
  readonly pendingManualRetryFactDigest?: string;
  readonly automaticAttemptsUsed: number;
  readonly intent: { readonly maxAttempts: number };
}

type AttemptAuthorization = Extract<
  DeliveryStreamRecord,
  { readonly t: "attempt-started" }
>["authorization"];

export function deliveryAttemptAuthorizationMatches(
  item: DeliveryAttemptPolicyState,
  authorization: AttemptAuthorization,
): boolean {
  if (authorization.kind === "manual") {
    return (
      item.pendingManualRetryFactDigest !== undefined &&
      authorization.resolutionFactDigest === item.pendingManualRetryFactDigest
    );
  }
  return (
    item.pendingManualRetryFactDigest === undefined &&
    item.automaticAttemptsUsed < item.intent.maxAttempts
  );
}

export function deliveryFailureDisposition(
  item: DeliveryAttemptPolicyState,
  error: DeliveryFailure,
): "retry" | "terminal" {
  return error.retryable && item.automaticAttemptsUsed < item.intent.maxAttempts
    ? "retry"
    : "terminal";
}

export function deliveryUnknownOutcomeDisposition(
  started: Extract<DeliveryStreamRecord, { readonly t: "attempt-started" }>,
  at: string,
): "redrive" | "uncertain" {
  if (started.unknownOutcome.kind === "manual-resolution") return "uncertain";
  return Date.parse(at) <= Date.parse(started.unknownOutcome.redriveUntil)
    ? "redrive"
    : "uncertain";
}

/** Produces a canonical deadline without letting valid integer policy values overflow Date. */
export function deliveryDeadlineAt(
  at: string,
  baseDelayMs: number,
  exponent = 0,
): string {
  assertCanonicalTime(at, "Delivery deadline base time");
  assertNonNegativeInteger(baseDelayMs, "Delivery deadline delay");
  assertNonNegativeInteger(exponent, "Delivery deadline exponent");
  const start = BigInt(Date.parse(at));
  const maximum = 8_640_000_000_000_000n;
  const delay =
    baseDelayMs === 0
      ? 0n
      : exponent > 53
        ? maximum
        : BigInt(baseDelayMs) * 2n ** BigInt(exponent);
  const target = start + delay > maximum ? maximum : start + delay;
  return new Date(Number(target)).toISOString();
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}
