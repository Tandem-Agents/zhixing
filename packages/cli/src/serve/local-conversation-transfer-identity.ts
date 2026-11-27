import { parseLocalConversationId } from "@zhixing-ai/core/conversation";
import type { TransferRecord } from "@zhixing-ai/core/contracts";
import { protocolDigest } from "@zhixing-ai/core/protocol";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function digestToDeterministicUlid(hex64: string): string {
  let value = BigInt(`0x${hex64.slice(0, 32)}`);
  const chars = new Array<string>(26);
  for (let i = 25; i >= 0; i -= 1) {
    chars[i] = CROCKFORD_BASE32[Number(value & 31n)]!;
    value >>= 5n;
  }
  return chars.join("");
}

export interface LocalConversationTransferStateView {
  readonly phase: string;
  readonly identity: {
    readonly transferId: string;
    readonly requestId: string;
    readonly conversationId: string;
    readonly targetDeviceId: string;
  };
  readonly manifest?: unknown;
}

export interface LocalConversationTransferAttemptIdentity {
  readonly attempt: number;
  readonly transferId: string;
  readonly requestId: string;
  readonly prepared: (source: {
    readonly deviceId: string;
    readonly ownerEpoch: number;
  }) => Extract<TransferRecord, { t: "prepared" }>;
}

export type DerivedLocalConversationTransferAttempt<
  T extends LocalConversationTransferStateView = LocalConversationTransferStateView,
> =
  | { readonly kind: "completed"; readonly state: T }
  | { readonly kind: "resume"; readonly state: T; readonly attempt: LocalConversationTransferAttemptIdentity }
  | { readonly kind: "new"; readonly attempt: LocalConversationTransferAttemptIdentity };

/**
 * Derives the next durable `(transferId, requestId)` attempt for adopting a `local-*`
 * conversation onto `targetDeviceId`: resumes non-aborted active attempts, skips
 * committed/tombstoned transfers, and deterministically allocates a fresh valid protocol
 * identifier pair when all prior attempts for `(conversationId, targetDeviceId)` aborted.
 */
export function deriveLocalConversationTransferAttemptIdentity<
  T extends LocalConversationTransferStateView,
>(input: {
  readonly conversationId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly sourceOwnerEpoch: number;
  readonly states: readonly T[];
}): DerivedLocalConversationTransferAttempt<T> | undefined {
  const parsed = parseLocalConversationId(input.conversationId);
  if (!parsed) return undefined;

  const forTarget = input.states.filter(
    (state) =>
      state.identity.conversationId === input.conversationId &&
      state.identity.targetDeviceId === input.targetDeviceId,
  );
  const active = forTarget.find((state) => state.phase !== "aborted");
  if (active) {
    if (active.phase === "committed" || active.phase === "tombstoned") {
      return { kind: "completed", state: active };
    }
    return {
      kind: "resume",
      state: active,
      attempt: buildAttemptIdentity(
        input.conversationId,
        input.targetDeviceId,
        1,
        active.identity.transferId,
        active.identity.requestId,
      ),
    };
  }

  const abortedAttempts = forTarget.filter((state) => state.phase === "aborted");
  if (abortedAttempts.length === 0) {
    return {
      kind: "new",
      attempt: buildAttemptIdentity(
        input.conversationId,
        input.targetDeviceId,
        1,
        `xfer-${parsed.ulid}`,
        `adopt:${input.conversationId}`,
      ),
    };
  }

  const attemptNumber = abortedAttempts.length + 1;
  const last = abortedAttempts[abortedAttempts.length - 1]!.identity;
  const usedIds = new Set(forTarget.map((state) => state.identity.transferId));
  let hex = "";
  let retryTransferId = "";
  for (let collisionSalt = 0; ; collisionSalt += 1) {
    const retryDigest = protocolDigest("ConversationTransferRetryIdentity", 1, {
      previousTransferId: last.transferId,
      previousRequestId: last.requestId,
      sourceDeviceId: input.sourceDeviceId,
      targetDeviceId: input.targetDeviceId,
      conversationId: input.conversationId,
      sourceOwnerEpoch: input.sourceOwnerEpoch,
      attempt: attemptNumber,
      ...(collisionSalt > 0 ? { collisionSalt } : {}),
    });
    hex = retryDigest.startsWith("sha256:")
      ? retryDigest.slice("sha256:".length)
      : retryDigest;
    retryTransferId = `xfer-${digestToDeterministicUlid(hex)}`;
    if (!usedIds.has(retryTransferId)) {
      break;
    }
  }
  return {
    kind: "new",
    attempt: buildAttemptIdentity(
      input.conversationId,
      input.targetDeviceId,
      attemptNumber,
      retryTransferId,
      `adopt:${input.conversationId}:r${attemptNumber}:${hex.slice(12, 24)}`,
    ),
  };
}

function buildAttemptIdentity(
  conversationId: string,
  targetDeviceId: string,
  attempt: number,
  transferId: string,
  requestId: string,
): LocalConversationTransferAttemptIdentity {
  return {
    attempt,
    transferId,
    requestId,
    prepared: (source) => ({
      v: 1 as const,
      t: "prepared" as const,
      requestId,
      transferId,
      sourceDeviceId: source.deviceId,
      targetDeviceId,
      conversationId,
      sourceOwnerEpoch: source.ownerEpoch,
      nextOwnerEpoch: source.ownerEpoch + 1,
    }),
  };
}
