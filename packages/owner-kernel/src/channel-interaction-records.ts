import type {
  ChannelInteractionGrant,
  ChannelMessageRef,
  ChannelResponderRef,
  ConversationChannelChallengeToken,
  ExecutionRef,
  InteractionDisplay,
  JobChannelChallengeToken,
} from "@zhixing/core/contracts";
import {
  assertChannelChallengeBinding,
  assertChannelInteractionGrantBinding,
  canonicalize,
  StreamFrameVerifier,
  validateChannelChallengeToken,
  validateChannelInteractionGrant,
  validateChannelResponderRef,
  validateInteractionDisplay,
  type ProtocolSignatureVerifier,
  type StreamVerifierCheckpoint,
} from "@zhixing/core/protocol";

export interface ConversationChannelChallengePreparedRecord {
  readonly t: "channel-challenge-prepared";
  readonly ref: Extract<ExecutionRef, { execution: "conversation" }>;
  readonly assignmentId: string;
  readonly frameSeq: number;
  readonly token: ConversationChannelChallengeToken;
  readonly responder: ChannelResponderRef;
  readonly toolName: string;
  readonly display: InteractionDisplay;
}

export interface JobChannelChallengePreparedRecord {
  readonly t: "channel-challenge-prepared";
  readonly ref: Extract<ExecutionRef, { execution: "job" }>;
  readonly assignmentId: string;
  readonly frameSeq: number;
  readonly token: JobChannelChallengeToken;
  readonly responder: ChannelResponderRef;
  readonly toolName: string;
  readonly display: InteractionDisplay;
}

export type ChannelChallengeLifecycleRecord =
  | {
      readonly t: "channel-challenge-delivered";
      readonly challengeId: string;
      readonly receipt: {
        readonly acceptedAt: string;
        readonly platformMessage?: ChannelMessageRef;
      };
    }
  | {
      readonly t: "channel-challenge-closed";
      readonly challengeId: string;
      readonly outcome: "allowed" | "denied" | "cancelled" | "expired";
      readonly at: string;
    };

export type ConversationChannelChallengeRecord =
  | ConversationChannelChallengePreparedRecord
  | ChannelChallengeLifecycleRecord;

export type JobChannelChallengeRecord =
  | JobChannelChallengePreparedRecord
  | ChannelChallengeLifecycleRecord;

export type ChannelInteractionRelayRecord =
  | JobChannelChallengeRecord
  | {
      readonly t: "channel-relay-cursor";
      readonly jobRunId: string;
      readonly assignmentId: string;
      readonly upToSeq: number;
      readonly checkpoint: StreamVerifierCheckpoint;
    }
  | {
      readonly t: "channel-challenge-granted";
      readonly jobRunId: string;
      readonly challengeId: string;
      readonly grant: ChannelInteractionGrant;
    };

export type ChannelChallengeRecord =
  | ConversationChannelChallengeRecord
  | JobChannelChallengeRecord;

export type ChannelInteractionRecord =
  | ConversationChannelChallengeRecord
  | ChannelInteractionRelayRecord;

export interface ChannelInteractionJournalState {
  readonly domain: "conversation" | "job";
  readonly preparedByChallenge: ReadonlyMap<
    string,
    ConversationChannelChallengePreparedRecord | JobChannelChallengePreparedRecord
  >;
  readonly challengeByInteraction: ReadonlyMap<string, string>;
  readonly deliveredByChallenge: ReadonlyMap<
    string,
    Extract<ChannelChallengeLifecycleRecord, { t: "channel-challenge-delivered" }>
  >;
  readonly closedByChallenge: ReadonlyMap<
    string,
    Extract<ChannelChallengeLifecycleRecord, { t: "channel-challenge-closed" }>
  >;
  readonly grantByChallenge: ReadonlyMap<
    string,
    Extract<ChannelInteractionRelayRecord, { t: "channel-challenge-granted" }>
  >;
  readonly cursorByAssignment: ReadonlyMap<
    string,
    Extract<ChannelInteractionRelayRecord, { t: "channel-relay-cursor" }>
  >;
}

export function createChannelInteractionJournalState(
  domain: "conversation" | "job",
): ChannelInteractionJournalState {
  return {
    domain,
    preparedByChallenge: new Map(),
    challengeByInteraction: new Map(),
    deliveredByChallenge: new Map(),
    closedByChallenge: new Map(),
    grantByChallenge: new Map(),
    cursorByAssignment: new Map(),
  };
}

export function validateConversationChannelChallengeRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationChannelChallengeRecord {
  return validateRecord(value, verifier, "conversation") as
    ConversationChannelChallengeRecord;
}

export function validateChannelInteractionRelayRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): ChannelInteractionRelayRecord {
  return validateRecord(value, verifier, "job") as ChannelInteractionRelayRecord;
}

export function advanceChannelInteractionJournal(
  current: ChannelInteractionJournalState,
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ChannelInteractionJournalState {
  const record = validateRecord(input, verifier, current.domain);
  const preparedByChallenge = new Map(current.preparedByChallenge);
  const challengeByInteraction = new Map(current.challengeByInteraction);
  const deliveredByChallenge = new Map(current.deliveredByChallenge);
  const closedByChallenge = new Map(current.closedByChallenge);
  const grantByChallenge = new Map(current.grantByChallenge);
  const cursorByAssignment = new Map(current.cursorByAssignment);

  switch (record.t) {
    case "channel-challenge-prepared": {
      const challengeId = record.token.challengeId;
      const interactionKey = `${record.assignmentId}\u0000${record.token.interactionRequestId}`;
      const priorChallenge = preparedByChallenge.get(challengeId);
      const priorInteractionChallenge = challengeByInteraction.get(interactionKey);
      if (
        (priorChallenge &&
          canonicalize(priorChallenge) !== canonicalize(record)) ||
        (priorInteractionChallenge && priorInteractionChallenge !== challengeId)
      ) {
        throw new TypeError(
          "Channel challenge idempotency identity has conflicting payloads",
        );
      }
      preparedByChallenge.set(challengeId, record);
      challengeByInteraction.set(interactionKey, challengeId);
      break;
    }
    case "channel-challenge-delivered": {
      requirePrepared(preparedByChallenge, record.challengeId);
      if (closedByChallenge.has(record.challengeId)) {
        throw new TypeError("Closed channel challenge cannot become delivered");
      }
      const prior = deliveredByChallenge.get(record.challengeId);
      if (prior && canonicalize(prior) !== canonicalize(record)) {
        throw new TypeError(
          "Channel challenge has conflicting delivery receipts",
        );
      }
      deliveredByChallenge.set(record.challengeId, record);
      break;
    }
    case "channel-challenge-closed": {
      requirePrepared(preparedByChallenge, record.challengeId);
      const prior = closedByChallenge.get(record.challengeId);
      if (prior && canonicalize(prior) !== canonicalize(record)) {
        throw new TypeError("Channel challenge has conflicting terminal outcomes");
      }
      closedByChallenge.set(record.challengeId, record);
      break;
    }
    case "channel-relay-cursor": {
      if (current.domain !== "job") {
        throw new TypeError("Conversation journal cannot contain relay cursor");
      }
      const previous = cursorByAssignment.get(record.assignmentId);
      if (previous && record.upToSeq < previous.upToSeq) {
        throw new TypeError("Channel relay cursor cannot move backwards");
      }
      if (
        previous &&
        record.upToSeq === previous.upToSeq &&
        canonicalize(record) !== canonicalize(previous)
      ) {
        throw new TypeError(
          "Channel relay cursor has conflicting verifier state",
        );
      }
      cursorByAssignment.set(record.assignmentId, record);
      break;
    }
    case "channel-challenge-granted": {
      if (current.domain !== "job") {
        throw new TypeError("Conversation journal cannot contain channel grant");
      }
      const prepared = requirePrepared(
        preparedByChallenge,
        record.challengeId,
      );
      if (prepared.ref.execution !== "job") {
        throw new TypeError("Conversation challenge cannot receive a channel grant");
      }
      if (closedByChallenge.has(record.challengeId)) {
        throw new TypeError("Closed channel challenge cannot receive a grant");
      }
      assertChannelInteractionGrantBinding(record.grant, {
        ref: prepared.ref,
        assignmentId: prepared.assignmentId,
        interactionRequestId: prepared.token.interactionRequestId,
        challengeId: record.challengeId,
        route: prepared.token.route,
        responder: prepared.responder,
        decision: record.grant.decision,
        toolName: prepared.toolName,
        display: prepared.display,
      });
      const prior = grantByChallenge.get(record.challengeId);
      if (prior && canonicalize(prior) !== canonicalize(record)) {
        throw new TypeError("Channel challenge has conflicting grants");
      }
      grantByChallenge.set(record.challengeId, record);
      break;
    }
  }

  return {
    domain: current.domain,
    preparedByChallenge,
    challengeByInteraction,
    deliveredByChallenge,
    closedByChallenge,
    grantByChallenge,
    cursorByAssignment,
  };
}

function validateRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
  domain: "conversation" | "job",
): ChannelInteractionRecord {
  assertRecord(value, "Channel interaction journal record");
  switch (value.t) {
    case "channel-challenge-prepared": {
      assertExactKeys(
        value,
        [
          "assignmentId",
          "display",
          "frameSeq",
          "ref",
          "responder",
          "t",
          "token",
          "toolName",
        ],
        "Channel challenge prepared record",
      );
      const token = validateChannelChallengeToken(value.token, verifier);
      if (token.ref.execution !== domain) {
        throw new TypeError("Channel challenge token domain differs from its journal");
      }
      assertIdentifier(value.assignmentId, "Channel challenge assignmentId");
      assertPositive(value.frameSeq, "Channel challenge frame sequence");
      assertIdentifier(value.toolName, "Channel challenge tool name");
      const responder = validateChannelResponderRef(value.responder);
      const display = validateInteractionDisplay(value.display);
      assertChannelChallengeBinding(token, {
        ref: value.ref as ExecutionRef,
        assignmentId: value.assignmentId as string,
        interactionRequestId: token.interactionRequestId,
        route: token.route,
        toolName: value.toolName as string,
        display,
      });
      return {
        ...value,
        token,
        responder,
        display,
      } as unknown as ChannelInteractionRecord;
    }
    case "channel-challenge-delivered":
      assertExactKeys(
        value,
        ["challengeId", "receipt", "t"],
        "Channel challenge delivered record",
      );
      assertIdentifier(value.challengeId, "Delivered challengeId");
      validateReceipt(value.receipt);
      return value as unknown as ChannelChallengeLifecycleRecord;
    case "channel-challenge-closed":
      assertExactKeys(
        value,
        ["at", "challengeId", "outcome", "t"],
        "Channel challenge closed record",
      );
      assertIdentifier(value.challengeId, "Closed challengeId");
      if (
        value.outcome !== "allowed" &&
        value.outcome !== "denied" &&
        value.outcome !== "cancelled" &&
        value.outcome !== "expired"
      ) {
        throw new TypeError("Channel challenge outcome is invalid");
      }
      assertTime(value.at, "Channel challenge closed time");
      return value as unknown as ChannelChallengeLifecycleRecord;
    case "channel-relay-cursor":
      if (domain !== "job") {
        throw new TypeError("Conversation journal cannot contain relay cursor");
      }
      assertExactKeys(
        value,
        ["assignmentId", "checkpoint", "jobRunId", "t", "upToSeq"],
        "Channel relay cursor record",
      );
      assertIdentifier(value.jobRunId, "Channel relay jobRunId");
      assertIdentifier(value.assignmentId, "Channel relay assignmentId");
      assertNonNegative(value.upToSeq, "Channel relay cursor");
      assertRecord(value.checkpoint, "Channel relay verifier checkpoint");
      assertExactKeys(
        value.checkpoint,
        [
          "assignmentId",
          "dataFrames",
          ...(value.checkpoint.finalSeq === undefined ? [] : ["finalSeq"]),
          "head",
          ...(value.checkpoint.lastLogicalDigest === undefined
            ? []
            : ["lastLogicalDigest"]),
          "lastSeq",
          "ref",
          "streamEpoch",
        ],
        "Channel relay verifier checkpoint",
      );
      const checkpoint = new StreamFrameVerifier(
        value.checkpoint as unknown as StreamVerifierCheckpoint,
      ).checkpoint();
      if (
        checkpoint.assignmentId !== value.assignmentId ||
        checkpoint.ref.execution !== "job" ||
        checkpoint.ref.jobRunId !== value.jobRunId ||
        checkpoint.lastSeq !== value.upToSeq
      ) {
        throw new TypeError(
          "Channel relay checkpoint does not bind its cursor",
        );
      }
      return {
        ...value,
        checkpoint,
      } as unknown as ChannelInteractionRelayRecord;
    case "channel-challenge-granted": {
      if (domain !== "job") {
        throw new TypeError("Conversation journal cannot contain channel grant");
      }
      assertExactKeys(
        value,
        ["challengeId", "grant", "jobRunId", "t"],
        "Channel challenge granted record",
      );
      assertIdentifier(value.jobRunId, "Channel grant jobRunId");
      assertIdentifier(value.challengeId, "Channel grant challengeId");
      const grant = validateChannelInteractionGrant(value.grant, verifier);
      if (
        grant.ref.jobRunId !== value.jobRunId ||
        grant.challengeToken.challengeId !== value.challengeId
      ) {
        throw new TypeError("Channel grant journal binding is invalid");
      }
      return { ...value, grant } as ChannelInteractionRelayRecord;
    }
    default:
      throw new TypeError("Channel interaction journal record type is invalid");
  }
}

function requirePrepared(
  prepared: ReadonlyMap<
    string,
    ConversationChannelChallengePreparedRecord | JobChannelChallengePreparedRecord
  >,
  challengeId: string,
):
  | ConversationChannelChallengePreparedRecord
  | JobChannelChallengePreparedRecord {
  const record = prepared.get(challengeId);
  if (!record) {
    throw new TypeError("Channel challenge lifecycle record has no prepared fact");
  }
  return record;
}

function validateReceipt(value: unknown): void {
  assertRecord(value, "Channel delivery receipt");
  assertExactKeys(
    value,
    value.platformMessage === undefined
      ? ["acceptedAt"]
      : ["acceptedAt", "platformMessage"],
    "Channel delivery receipt",
  );
  assertTime(value.acceptedAt, "Channel delivery accepted time");
  if (value.platformMessage !== undefined) {
    assertRecord(value.platformMessage, "Channel platform message");
    assertExactKeys(
      value.platformMessage,
      value.platformMessage.threadId === undefined
        ? ["channelId", "messageId"]
        : ["channelId", "messageId", "threadId"],
      "Channel platform message",
    );
    assertIdentifier(
      value.platformMessage.channelId,
      "Channel platform message channelId",
    );
    assertIdentifier(
      value.platformMessage.messageId,
      "Channel platform message messageId",
    );
    if (value.platformMessage.threadId !== undefined) {
      assertIdentifier(
        value.platformMessage.threadId,
        "Channel platform message threadId",
      );
    }
  }
}

function assertRecord(
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
  keys: readonly string[],
  label: string,
): void {
  if (
    canonicalize(Object.keys(value).sort()) !==
    canonicalize([...keys].sort())
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertPositive(value: unknown, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegative(value: unknown, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertTime(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}
