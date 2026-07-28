import type {
  ChannelChallengeToken,
  ChannelInteractionGrant,
  ChannelResponderRef,
  DeliveryTargetDto,
  Digest,
  ExecutionRef,
  InteractionDisplay,
  JobChannelChallengeToken,
  Signature,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "./signature.js";
import { validateInteractionDisplay } from "./interaction-display.js";
import { assertProtocolIdentifier } from "./validation.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_CHANNEL_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CHANNEL_DECISION_REASON_BYTES = 8 * 1024;

export type UnsignedChannelChallengeToken =
  ChannelChallengeToken extends infer Token
    ? Token extends ChannelChallengeToken
      ? Omit<Token, "signature">
      : never
    : never;

export type UnsignedChannelInteractionGrant = Omit<
  ChannelInteractionGrant,
  "signature"
>;

export interface ChannelChallengeBinding {
  readonly ref: ExecutionRef;
  readonly assignmentId: string;
  readonly interactionRequestId: string;
  readonly route: DeliveryTargetDto;
  readonly toolName: string;
  readonly display: InteractionDisplay;
}

export interface ChannelInteractionGrantBinding {
  readonly ref: Extract<ExecutionRef, { execution: "job" }>;
  readonly assignmentId: string;
  readonly interactionRequestId: string;
  readonly challengeId: string;
  readonly route: DeliveryTargetDto;
  readonly responder: ChannelResponderRef;
  readonly decision: { readonly allowed: boolean; readonly reason?: string };
  readonly toolName: string;
  readonly display: InteractionDisplay;
}

export function interactionDisplayDigest(
  toolName: string,
  display: InteractionDisplay,
): Digest {
  assertProtocolIdentifier(toolName, "Interaction display tool name");
  return protocolDigest("InteractionDisplay", 1, {
    toolName,
    display: validateInteractionDisplay(display),
  }) as Digest;
}

export function channelResponderPrincipal(
  responder: ChannelResponderRef,
): string {
  return `channel:${protocolDigest(
    "ChannelResponderRef",
    1,
    validateChannelResponder(responder, "Channel responder"),
  )}`;
}

export function channelInteractionDecisionDigest(
  interactionRequestId: string,
  decision: { readonly allowed: boolean; readonly reason?: string },
): Digest {
  assertProtocolIdentifier(
    interactionRequestId,
    "Channel decision interactionRequestId",
  );
  return protocolDigest("ChannelInteractionDecision", 1, {
    interactionRequestId,
    decision: validateDecision(decision, "Channel interaction decision"),
  }) as Digest;
}

export function createSignedChannelChallengeToken(
  input: UnsignedChannelChallengeToken,
  signer: ProtocolSigner,
): ChannelChallengeToken {
  const payload = validateUnsignedChallengeToken(input);
  return {
    ...payload,
    signature: signer.sign("ChannelChallengeToken", 1, payload),
  } as ChannelChallengeToken;
}

export function validateChannelChallengeToken(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ChannelChallengeToken {
  const token = clone(input, "Channel challenge token") as ChannelChallengeToken;
  assertPlainObject(token, "Channel challenge token");
  assertExactKeys(
    token,
    [
      "assignmentId",
      "challengeId",
      "displayDigest",
      "expiry",
      "interactionRequestId",
      "issuedAt",
      "ref",
      "route",
      "signature",
      "v",
    ],
    "Channel challenge token",
  );
  assertSignature(token.signature, "Channel challenge token signature");
  const { signature, ...unsigned } = token;
  const payload = validateUnsignedChallengeToken(
    unsigned as UnsignedChannelChallengeToken,
  );
  verifier.verify("ChannelChallengeToken", 1, payload, signature);
  return token;
}

export function channelChallengeTokenDigest(
  token: ChannelChallengeToken,
): Digest {
  const { signature: _, ...payload } = token;
  return protocolDigest("ChannelChallengeToken", 1, payload) as Digest;
}

export function assertChannelChallengeBinding(
  token: ChannelChallengeToken,
  binding: ChannelChallengeBinding,
): void {
  const ref = validateExecutionRef(binding.ref, "Challenge binding reference");
  assertProtocolIdentifier(
    binding.assignmentId,
    "Challenge binding assignmentId",
  );
  assertProtocolIdentifier(
    binding.interactionRequestId,
    "Challenge binding interactionRequestId",
  );
  const route = validateDeliveryTarget(
    binding.route,
    "Challenge binding route",
  );
  const displayDigest = interactionDisplayDigest(
    binding.toolName,
    binding.display,
  );
  if (
    canonicalize(token.ref) !== canonicalize(ref) ||
    token.assignmentId !== binding.assignmentId ||
    token.interactionRequestId !== binding.interactionRequestId ||
    canonicalize(token.route) !== canonicalize(route) ||
    token.displayDigest !== displayDigest
  ) {
    throw new TypeError(
      "Channel challenge token does not bind the requested interaction",
    );
  }
}

export function assertChannelChallengeActiveAt(
  token: ChannelChallengeToken,
  at: string,
): void {
  const current = parseCanonicalTime(at, "Channel challenge use time");
  const issuedAt = parseCanonicalTime(
    token.issuedAt,
    "Channel challenge issuedAt",
  );
  const expiry = parseCanonicalTime(token.expiry, "Channel challenge expiry");
  if (current < issuedAt || current >= expiry) {
    throw new TypeError("Channel challenge token is not active");
  }
}

export function createSignedChannelInteractionGrant(
  input: UnsignedChannelInteractionGrant,
  signer: ProtocolSigner,
  verifier: ProtocolSignatureVerifier,
): ChannelInteractionGrant {
  const payload = validateUnsignedChannelInteractionGrant(input, verifier);
  return {
    ...payload,
    signature: signer.sign("ChannelInteractionGrant", 1, payload),
  };
}

export function validateChannelInteractionGrant(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ChannelInteractionGrant {
  const grant = clone(input, "Channel interaction grant") as ChannelInteractionGrant;
  assertPlainObject(grant, "Channel interaction grant");
  assertExactKeys(
    grant,
    [
      "assignmentId",
      "challengeToken",
      "decision",
      "expiry",
      "grantId",
      "interactionRequestId",
      "issuedAt",
      "ref",
      "responder",
      "route",
      "signature",
      "v",
    ],
    "Channel interaction grant",
  );
  assertSignature(grant.signature, "Channel interaction grant signature");
  const { signature, ...unsigned } = grant;
  const payload = validateUnsignedChannelInteractionGrant(unsigned, verifier);
  verifier.verify("ChannelInteractionGrant", 1, payload, signature);
  return grant;
}

export function channelInteractionGrantDigest(
  grant: ChannelInteractionGrant,
): Digest {
  const { signature: _, ...payload } = grant;
  return protocolDigest("ChannelInteractionGrant", 1, payload) as Digest;
}

export function assertChannelInteractionGrantBinding(
  grant: ChannelInteractionGrant,
  binding: ChannelInteractionGrantBinding,
): void {
  const responder = validateChannelResponder(
    binding.responder,
    "Grant binding responder",
  );
  const route = validateDeliveryTarget(binding.route, "Grant binding route");
  const decision = validateDecision(binding.decision, "Grant binding decision");
  assertProtocolIdentifier(binding.challengeId, "Grant binding challengeId");
  assertChannelChallengeBinding(grant.challengeToken as ChannelChallengeToken, {
    ref: binding.ref,
    assignmentId: binding.assignmentId,
    interactionRequestId: binding.interactionRequestId,
    route,
    toolName: binding.toolName,
    display: binding.display,
  });
  if (
    canonicalize(grant.ref) !== canonicalize(binding.ref) ||
    grant.assignmentId !== binding.assignmentId ||
    grant.interactionRequestId !== binding.interactionRequestId ||
    grant.challengeToken.challengeId !== binding.challengeId ||
    canonicalize(grant.route) !== canonicalize(route) ||
    canonicalize(grant.responder) !== canonicalize(responder) ||
    canonicalize(grant.decision) !== canonicalize(decision)
  ) {
    throw new TypeError(
      "Channel interaction grant does not bind the requested decision",
    );
  }
}

export function assertChannelInteractionGrantActiveAt(
  grant: ChannelInteractionGrant,
  at: string,
): void {
  assertChannelChallengeActiveAt(
    grant.challengeToken as ChannelChallengeToken,
    at,
  );
  const current = parseCanonicalTime(at, "Channel grant use time");
  const issuedAt = parseCanonicalTime(grant.issuedAt, "Channel grant issuedAt");
  const expiry = parseCanonicalTime(grant.expiry, "Channel grant expiry");
  if (current < issuedAt || current >= expiry) {
    throw new TypeError("Channel interaction grant is not active");
  }
}

function validateUnsignedChallengeToken(
  input: UnsignedChannelChallengeToken,
): UnsignedChannelChallengeToken {
  const token = clone(
    input,
    "Unsigned channel challenge token",
  ) as UnsignedChannelChallengeToken;
  assertPlainObject(token, "Unsigned channel challenge token");
  assertExactKeys(
    token,
    [
      "assignmentId",
      "challengeId",
      "displayDigest",
      "expiry",
      "interactionRequestId",
      "issuedAt",
      "ref",
      "route",
      "v",
    ],
    "Unsigned channel challenge token",
  );
  if (token.v !== 1) {
    throw new TypeError("Channel challenge token version must be 1");
  }
  assertProtocolIdentifier(token.challengeId, "Channel challenge id");
  validateExecutionRef(token.ref, "Channel challenge reference");
  assertProtocolIdentifier(token.assignmentId, "Channel challenge assignmentId");
  assertProtocolIdentifier(
    token.interactionRequestId,
    "Channel challenge interactionRequestId",
  );
  validateDeliveryTarget(token.route, "Channel challenge route");
  assertDigest(token.displayDigest, "Channel challenge display digest");
  validateBoundedInterval(
    token.issuedAt,
    token.expiry,
    MAX_CHANNEL_CHALLENGE_TTL_MS,
    "Channel challenge",
  );
  return token;
}

function validateUnsignedChannelInteractionGrant(
  input: UnsignedChannelInteractionGrant,
  verifier: ProtocolSignatureVerifier,
): UnsignedChannelInteractionGrant {
  const grant = clone(
    input,
    "Unsigned channel interaction grant",
  ) as UnsignedChannelInteractionGrant;
  assertPlainObject(grant, "Unsigned channel interaction grant");
  assertExactKeys(
    grant,
    [
      "assignmentId",
      "challengeToken",
      "decision",
      "expiry",
      "grantId",
      "interactionRequestId",
      "issuedAt",
      "ref",
      "responder",
      "route",
      "v",
    ],
    "Unsigned channel interaction grant",
  );
  if (grant.v !== 1) {
    throw new TypeError("Channel interaction grant version must be 1");
  }
  assertProtocolIdentifier(grant.grantId, "Channel interaction grant id");
  const ref = validateExecutionRef(grant.ref, "Channel grant reference");
  if (ref.execution !== "job") {
    throw new TypeError("Channel interaction grant is job-only");
  }
  assertProtocolIdentifier(grant.assignmentId, "Channel grant assignmentId");
  assertProtocolIdentifier(
    grant.interactionRequestId,
    "Channel grant interactionRequestId",
  );
  const token = validateChannelChallengeToken(grant.challengeToken, verifier);
  if (token.ref.execution !== "job") {
    throw new TypeError(
      "Conversation channel challenge cannot enter a channel grant",
    );
  }
  const route = validateDeliveryTarget(grant.route, "Channel grant route");
  const responder = validateChannelResponder(
    grant.responder,
    "Channel grant responder",
  );
  const decision = validateDecision(grant.decision, "Channel grant decision");
  const interval = validateBoundedInterval(
    grant.issuedAt,
    grant.expiry,
    MAX_CHANNEL_CHALLENGE_TTL_MS,
    "Channel grant",
  );
  const tokenIssuedAt = parseCanonicalTime(
    token.issuedAt,
    "Channel challenge issuedAt",
  );
  const tokenExpiry = parseCanonicalTime(
    token.expiry,
    "Channel challenge expiry",
  );
  if (
    interval.issuedAt < tokenIssuedAt ||
    interval.issuedAt >= tokenExpiry ||
    interval.expiry > tokenExpiry
  ) {
    throw new TypeError(
      "Channel interaction grant interval exceeds its challenge",
    );
  }
  if (
    canonicalize(ref) !== canonicalize(token.ref) ||
    grant.assignmentId !== token.assignmentId ||
    grant.interactionRequestId !== token.interactionRequestId ||
    canonicalize(route) !== canonicalize(token.route)
  ) {
    throw new TypeError(
      "Channel interaction grant does not bind its challenge token",
    );
  }
  return {
    ...grant,
    ref,
    challengeToken: token as JobChannelChallengeToken,
    route,
    responder,
    decision,
  };
}

function validateExecutionRef(value: unknown, label: string): ExecutionRef {
  assertPlainObject(value, label);
  if (value.execution === "conversation") {
    assertExactKeys(
      value,
      ["conversationId", "execution", "ownerEpoch", "runId"],
      label,
    );
    assertProtocolIdentifier(value.conversationId, `${label} conversationId`);
    assertProtocolIdentifier(value.runId, `${label} runId`);
    assertPositiveInteger(value.ownerEpoch, `${label} ownerEpoch`);
    return value as unknown as ExecutionRef;
  }
  if (value.execution === "job") {
    assertExactKeys(
      value,
      ["anchorEpoch", "execution", "jobRunId", "taskId"],
      label,
    );
    assertProtocolIdentifier(value.taskId, `${label} taskId`);
    assertProtocolIdentifier(value.jobRunId, `${label} jobRunId`);
    assertPositiveInteger(value.anchorEpoch, `${label} anchorEpoch`);
    return value as unknown as ExecutionRef;
  }
  throw new TypeError(`${label} execution kind is invalid`);
}

function validateDeliveryTarget(
  value: unknown,
  label: string,
): DeliveryTargetDto {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    value.threadId === undefined
      ? ["channelId", "to"]
      : ["channelId", "threadId", "to"],
    label,
  );
  assertProtocolIdentifier(value.channelId, `${label} channelId`);
  assertProtocolIdentifier(value.to, `${label} to`);
  if (value.threadId !== undefined) {
    assertProtocolIdentifier(value.threadId, `${label} threadId`);
  }
  return value as unknown as DeliveryTargetDto;
}

function validateChannelResponder(
  value: unknown,
  label: string,
): ChannelResponderRef {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    value.tenant === undefined
      ? ["channelId", "platformSubject"]
      : ["channelId", "platformSubject", "tenant"],
    label,
  );
  assertProtocolIdentifier(value.channelId, `${label} channelId`);
  assertProtocolIdentifier(value.platformSubject, `${label} platformSubject`);
  if (value.tenant !== undefined) {
    assertProtocolIdentifier(value.tenant, `${label} tenant`);
  }
  return value as unknown as ChannelResponderRef;
}

function validateDecision(
  value: unknown,
  label: string,
): { allowed: boolean; reason?: string } {
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    value.reason === undefined ? ["allowed"] : ["allowed", "reason"],
    label,
  );
  if (typeof value.allowed !== "boolean") {
    throw new TypeError(`${label} allowed must be boolean`);
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      Buffer.byteLength(value.reason, "utf8") >
        MAX_CHANNEL_DECISION_REASON_BYTES)
  ) {
    throw new TypeError(`${label} reason is invalid`);
  }
  return value as { allowed: boolean; reason?: string };
}

function validateBoundedInterval(
  issuedAtValue: unknown,
  expiryValue: unknown,
  maximumMs: number,
  label: string,
): { issuedAt: number; expiry: number } {
  const issuedAt = parseCanonicalTime(issuedAtValue, `${label} issuedAt`);
  const expiry = parseCanonicalTime(expiryValue, `${label} expiry`);
  if (expiry <= issuedAt || expiry - issuedAt > maximumMs) {
    throw new TypeError(`${label} validity interval is invalid`);
  }
  return { issuedAt, expiry };
}

function parseCanonicalTime(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
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

function assertDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertPositiveInteger(value: unknown, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
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
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...expected].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function clone(value: unknown, label: string): unknown {
  try {
    return JSON.parse(canonicalize(value));
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, {
      cause: error,
    });
  }
}
