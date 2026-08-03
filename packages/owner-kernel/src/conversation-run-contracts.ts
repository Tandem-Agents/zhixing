import { AuthorityStorageError } from "@zhixing/core/authority";
import { isAdvancementControlEvent } from "@zhixing/core/advancement";
import type { AdvancementControlEvent } from "@zhixing/core/advancement";
import type {
  ArtifactRef,
  AssignmentTerminationProof,
  CancelProofBody,
  ConversationInvocation,
  ConversationUncertainClosure,
  ConversationRunState,
  ContentAssetRef,
  DataPlaneTicket,
  Digest,
  DispatchConflictProof,
  ExplicitEnvironmentSelection,
  IngressContext,
  JobRunState,
  JobUncertainClosure,
  SessionInternalRecord,
  SupersedeProof,
  UncertainResolutionFact,
  UserTurnInput,
} from "@zhixing/core/contracts";

/**
 * Shared replay predicates compare literal state values only, so the
 * conversation and job authority families execute one predicate source;
 * states outside a predicate's accepted set simply fail its checks.
 */
export type SharedRunState = ConversationRunState | JobRunState;
import {
  assertProtocolIdentifier,
  canonicalize,
  protocolDigest,
  validateAssignmentTerminationProof,
  validateCancelProof,
  validateConversationInteractionMirrorBatch,
  validateConversationInvocation,
  validateContentAssetRefs,
  validateDataPlaneTicket,
  validateDispatchConflictProof,
  validateIngressContext,
  validateExplicitEnvironmentSelection,
  validateNonEmptyUserTurnInput,
  validateSupersedeProof,
  type ConversationInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import {
  validateConversationChannelChallengeRecord,
  type ConversationChannelChallengeRecord,
} from "./channel-interaction-records.js";

export type Stored<T> = T | { readonly ref: ArtifactRef };

export type ConversationRunJournalRecord =
  | {
      readonly t: "session-lifecycle";
      readonly mutation: "clear" | "delete";
      readonly domainRevision: number;
      readonly requestId: string;
    }
  | {
      readonly t: "session-meta";
      readonly operation: "create" | "touch" | "delete";
      readonly domainRevision: number;
      readonly requestId: string;
      readonly sceneId: string;
      readonly lastActiveAt: string;
    }
  | {
      readonly t: "admitted";
      readonly ingressKey: string;
      readonly runId: string;
      readonly input: Stored<UserTurnInput>;
      readonly attachments?: ContentAssetRef[];
      readonly ingress: IngressContext;
      readonly invocation: ConversationInvocation;
      readonly environment?: ExplicitEnvironmentSelection;
      readonly queuedPosition: number;
    }
  | {
      readonly t: "assigned";
      readonly runId: string;
      readonly assignmentId: string;
      readonly executorId: string;
      readonly ownerEpoch: number;
      readonly baseRevision: number;
      readonly dispatchDigest: string;
      readonly manifestDigest: string;
      readonly dispatchRef: ArtifactRef;
      readonly permissionLeaseDigest: string;
      readonly capIds: string[];
      readonly reservation: { readonly reservationId: string; readonly attempt: number };
    }
  | { readonly t: "dispatch-acked"; readonly assignmentId: string }
  | {
      readonly t: "dispatch-conflict";
      readonly assignmentId: string;
      readonly proof: DispatchConflictProof;
      readonly handling: "acked-original" | "opened-uncertain";
    }
  | {
      readonly t: "dispatch-conflict-contained";
      readonly assignmentId: string;
      readonly openFactDigest: string;
      readonly proof:
        | CancelProofBody
        | Extract<SupersedeProof, { decision: "not-started-fenced" }>;
    }
  | {
      readonly t: "assignment-superseded";
      readonly assignmentId: string;
      readonly proof: AssignmentTerminationProof;
    }
  | {
      readonly t: "supersede-requested";
      readonly assignmentId: string;
      readonly fenceSeq: number;
      readonly requestId: string;
    }
  | {
      readonly t: "supersede-started-observed";
      readonly assignmentId: string;
      readonly proof: Extract<SupersedeProof, { decision: "already-started" }>;
    }
  | {
      readonly t: "cancel-fence";
      readonly assignmentId: string;
      readonly fenceSeq: number;
      readonly requestId: string;
    }
  | {
      readonly t: "capability-revoked";
      readonly capId: string;
      readonly assignmentId: string;
    }
  | {
      readonly t: "ticket-issued";
      readonly ticket: DataPlaneTicket;
      readonly replacesTicketId?: string;
    }
  | { readonly t: "ticket-revoked"; readonly ticketId: string }
  | { readonly t: "ticket-sync-frontier"; readonly expiresThrough: string }
  | {
      readonly t: "interaction-mirror";
      readonly assignmentId: string;
      readonly batch: ConversationInteractionMirrorBatch;
    }
  | {
      readonly t: "state";
      readonly runId: string;
      /** Present iff this transition is caused by an assignment attempt. */
      readonly assignmentId?: string;
      readonly state: ConversationRunState;
      readonly statusRevision: number;
      readonly reason?: string;
      readonly usageFinal?: {
        readonly reportDigest: Digest;
        readonly upToUsageSeq: number;
      };
    }
  | {
      readonly t: "committed";
      readonly runId: string;
      readonly assignmentId: string;
      readonly bundle: { readonly ref: ArtifactRef };
      readonly commitRevision: number;
    }
  | {
      readonly t: "bundle-ack-observed";
      readonly assignmentId: string;
      readonly bundleRef: ArtifactRef;
      readonly commitRevision: number;
    }
  | { readonly t: "resolution"; readonly runId: string; readonly fact: UncertainResolutionFact }
  | {
      readonly t: "advancement-event";
      /** 所属推进写入的幂等身份——同一 requestId 重放原结果，异载荷拒绝。 */
      readonly requestId: string;
      /** 本次推进写入的会话域 revision（整批事件共享）。 */
      readonly domainRevision: number;
      /** 整批事件的规范内容摘要（B(bytes)），逐记录冗余以判定异载荷。 */
      readonly eventsDigest: string;
      readonly event: Stored<AdvancementControlEvent>;
    }
  | {
      readonly t: "cancel-contained";
      readonly assignmentId: string;
      readonly openFactDigest: string;
      readonly proof: CancelProofBody;
    }
  | {
      readonly t: "cancel-proof-accepted";
      readonly assignmentId: string;
      readonly proof: CancelProofBody;
    }
  | {
      readonly t: "not-started-rejected";
      readonly assignmentId: string;
      readonly proof: AssignmentTerminationProof;
    }
  | ConversationChannelChallengeRecord
  | SessionInternalRecord;

export type ConversationRunRecord = Exclude<ConversationRunJournalRecord, SessionInternalRecord>;
export type ConversationRunRecordType = ConversationRunRecord["t"];

export type ConversationRunInternalRecord =
  | SessionInternalRecord
  | {
      readonly kind: "conversation-commit-projection";
      readonly assignmentId: string;
      readonly runId: string;
      readonly commitRevision: number;
      readonly digest: string;
    }
  | {
      readonly kind: "conversation-lifecycle-projection";
      readonly mutation: "clear" | "delete";
      readonly domainRevision: number;
      readonly requestId: string;
    };

export const CONVERSATION_RUN_INTERNAL_RECORD_TYPES = [
  "content-asset-index",
  "session-activity",
  "conversation-commit-projection",
  "conversation-lifecycle-projection",
] as const satisfies readonly ConversationRunInternalRecord["kind"][];

interface RecordShape {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

export const CONVERSATION_RUN_RECORD_SHAPES = {
  "session-lifecycle": {
    required: ["domainRevision", "mutation", "requestId", "t"],
  },
  "session-meta": {
    required: [
      "domainRevision",
      "lastActiveAt",
      "operation",
      "requestId",
      "sceneId",
      "t",
    ],
  },
  admitted: {
    required: [
      "ingress",
      "ingressKey",
      "input",
      "invocation",
      "queuedPosition",
      "runId",
      "t",
    ],
    optional: ["attachments", "environment"],
  },
  assigned: {
    required: [
      "assignmentId",
      "baseRevision",
      "capIds",
      "dispatchDigest",
      "dispatchRef",
      "executorId",
      "manifestDigest",
      "ownerEpoch",
      "permissionLeaseDigest",
      "reservation",
      "runId",
      "t",
    ],
  },
  "dispatch-acked": { required: ["assignmentId", "t"] },
  "dispatch-conflict": { required: ["assignmentId", "handling", "proof", "t"] },
  "dispatch-conflict-contained": {
    required: ["assignmentId", "openFactDigest", "proof", "t"],
  },
  "assignment-superseded": { required: ["assignmentId", "proof", "t"] },
  "supersede-requested": {
    required: ["assignmentId", "fenceSeq", "requestId", "t"],
  },
  "supersede-started-observed": { required: ["assignmentId", "proof", "t"] },
  "cancel-fence": { required: ["assignmentId", "fenceSeq", "requestId", "t"] },
  "capability-revoked": { required: ["assignmentId", "capId", "t"] },
  "ticket-issued": {
    required: ["t", "ticket"],
    optional: ["replacesTicketId"],
  },
  "ticket-revoked": { required: ["t", "ticketId"] },
  "ticket-sync-frontier": { required: ["expiresThrough", "t"] },
  "interaction-mirror": { required: ["assignmentId", "batch", "t"] },
  "channel-challenge-prepared": {
    required: [
      "assignmentId",
      "display",
      "frameSeq",
      "ref",
      "responder",
      "t",
      "token",
      "toolName",
    ],
  },
  "channel-challenge-delivered": {
    required: ["challengeId", "receipt", "t"],
  },
  "channel-challenge-closed": {
    required: ["at", "challengeId", "outcome", "t"],
  },
  state: {
    required: ["runId", "state", "statusRevision", "t"],
    optional: ["assignmentId", "reason", "usageFinal"],
  },
  committed: {
    required: ["assignmentId", "bundle", "commitRevision", "runId", "t"],
  },
  "bundle-ack-observed": {
    required: ["assignmentId", "bundleRef", "commitRevision", "t"],
  },
  resolution: { required: ["fact", "runId", "t"] },
  "advancement-event": {
    required: ["domainRevision", "event", "eventsDigest", "requestId", "t"],
  },
  "cancel-contained": {
    required: ["assignmentId", "openFactDigest", "proof", "t"],
  },
  "cancel-proof-accepted": { required: ["assignmentId", "proof", "t"] },
  "not-started-rejected": { required: ["assignmentId", "proof", "t"] },
} as const satisfies Record<ConversationRunRecordType, RecordShape>;

const RUN_STATES = new Set<ConversationRunState>([
  "queued",
  "dispatched",
  "running",
  "cancel-requested",
  "committed",
  "cancelled",
  "failed",
  "expired",
  "uncertain",
]);

const RESOLUTION_CAUSES = new Set<UncertainResolutionFact["cause"]>([
  "ledger-unknown",
  "cancel-unproven",
  "job-cancel-unknown",
  "dispatch-conflict",
]);

const RESOLUTION_KINDS = new Set<
  NonNullable<UncertainResolutionFact["resolution"]>["kind"]
>([
  "late-bundle-committed",
  "proven-not-started-redispatched",
  "proven-not-started-cancelled",
  "user-verified-side-effects",
  "user-abandoned",
  "user-retry-acknowledged",
]);

const CONTENT_ASSET_KINDS = new Set([
  "image",
  "file",
  "tool-output",
  "window-snapshot",
]);

export function validateConversationRunRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): ConversationRunRecord {
  try {
    assertPlainRecord(value, "Run journal record");
    if (typeof value.t !== "string" || !(value.t in CONVERSATION_RUN_RECORD_SHAPES)) {
      throw corruptRunJournal("Run journal record type is unknown");
    }
    const type = value.t as ConversationRunRecordType;
    const shape: RecordShape = CONVERSATION_RUN_RECORD_SHAPES[type];
    assertRecordKeys(value, shape.required, shape.optional ?? [], `${type} run record`);

    switch (type) {
      case "session-lifecycle":
        if (value.mutation !== "clear" && value.mutation !== "delete") {
          throw corruptRunJournal("Session lifecycle mutation is invalid");
        }
        assertPositiveSafeInteger(
          value.domainRevision,
          "Session lifecycle domain revision",
        );
        assertIdentifier(value.requestId, "Session lifecycle request id");
        break;
      case "session-meta":
        if (
          value.operation !== "create" &&
          value.operation !== "touch" &&
          value.operation !== "delete"
        ) {
          throw corruptRunJournal("Session metadata operation is invalid");
        }
        assertPositiveSafeInteger(
          value.domainRevision,
          "Session metadata domain revision",
        );
        assertIdentifier(value.requestId, "Session metadata request id");
        assertIdentifier(value.sceneId, "Session metadata scene id");
        assertCanonicalTime(value.lastActiveAt, "Session metadata activity time");
        break;
      case "admitted": {
        assertIdentifier(value.ingressKey, "Admitted ingress key");
        assertIdentifier(value.runId, "Admitted run id");
        assertNonNegativeSafeInteger(value.queuedPosition, "Admitted queued position");
        validateIngressContext(value.ingress as IngressContext);
        validateConversationInvocation(value.invocation);
        if (value.environment !== undefined) {
          validateExplicitEnvironmentSelection(value.environment);
          if ((value.ingress as IngressContext).kind !== "first-party") {
            throw corruptRunJournal(
              "Only first-party admission may carry an environment selection",
            );
          }
        }
        if (isStoredReference(value.input)) {
          assertArtifactReference(value.input.ref, "Admitted input reference");
        } else {
          validateNonEmptyUserTurnInput(value.input as UserTurnInput);
        }
        if (value.attachments !== undefined) {
          validateContentAssetRefs(value.attachments, {
            label: "Admitted attachments",
          });
        }
        break;
      }
      case "assigned": {
        assertIdentifier(value.runId, "Assigned run id");
        assertIdentifier(value.assignmentId, "Assigned assignment id");
        assertIdentifier(value.executorId, "Assigned executor id");
        assertPositiveSafeInteger(value.ownerEpoch, "Assigned owner epoch");
        assertNonNegativeSafeInteger(value.baseRevision, "Assigned base revision");
        assertDigest(value.dispatchDigest, "Assigned dispatch digest");
        assertDigest(value.manifestDigest, "Assigned manifest digest");
        assertDigest(value.permissionLeaseDigest, "Assigned permission lease digest");
        assertArtifactReference(value.dispatchRef, "Assigned dispatch reference");
        assertPlainRecord(value.reservation, "Assigned reservation");
        assertExactRecordKeys(
          value.reservation,
          ["attempt", "reservationId"],
          "Assigned reservation",
        );
        assertIdentifier(value.reservation.reservationId, "Assigned reservation id");
        assertNonNegativeSafeInteger(value.reservation.attempt, "Assigned reservation attempt");
        if (!Array.isArray(value.capIds)) {
          throw corruptRunJournal("Assigned capability ids must be an array");
        }
        const capIds = new Set<string>();
        for (const capId of value.capIds) {
          assertIdentifier(capId, "Assigned capability id");
          if (capIds.has(capId)) {
            throw corruptRunJournal("Assigned capability ids are duplicated");
          }
          capIds.add(capId);
        }
        break;
      }
      case "ticket-issued":
        validateDataPlaneTicket(value.ticket, verifier);
        if (value.replacesTicketId !== undefined) {
          assertIdentifier(value.replacesTicketId, "Replaced ticket id");
        }
        break;
      case "ticket-revoked":
        assertIdentifier(value.ticketId, "Revoked ticket id");
        break;
      case "ticket-sync-frontier":
        assertCanonicalTime(value.expiresThrough, "Ticket sync frontier");
        break;
      case "dispatch-acked":
        assertIdentifier(value.assignmentId, "Dispatch acknowledgement assignment id");
        break;
      case "dispatch-conflict": {
        assertIdentifier(value.assignmentId, "Dispatch conflict assignment id");
        if (value.handling !== "acked-original" && value.handling !== "opened-uncertain") {
          throw corruptRunJournal("Dispatch conflict handling is invalid");
        }
        validateDispatchConflictProof(value.proof as DispatchConflictProof, verifier);
        break;
      }
      case "dispatch-conflict-contained": {
        assertIdentifier(value.assignmentId, "Conflict containment assignment id");
        assertDigest(value.openFactDigest, "Conflict containment open fact digest");
        if (isCancelProof(value.proof)) {
          validateCancelProof(value.proof as CancelProofBody, verifier);
        } else {
          const proof = validateSupersedeProof(value.proof as SupersedeProof, verifier);
          if (proof.decision !== "not-started-fenced") {
            throw corruptRunJournal("Conflict containment supersede proof is not terminal");
          }
        }
        break;
      }
      case "assignment-superseded":
      case "not-started-rejected":
        assertIdentifier(value.assignmentId, `${type} assignment id`);
        validateAssignmentTerminationProof(
          value.proof as AssignmentTerminationProof,
          verifier,
        );
        break;
      case "supersede-requested":
      case "cancel-fence":
        assertIdentifier(value.assignmentId, `${type} assignment id`);
        assertPositiveSafeInteger(value.fenceSeq, `${type} fence sequence`);
        assertIdentifier(value.requestId, `${type} request id`);
        break;
      case "supersede-started-observed": {
        assertIdentifier(value.assignmentId, "Supersede observation assignment id");
        const proof = validateSupersedeProof(value.proof as SupersedeProof, verifier);
        if (proof.decision !== "already-started") {
          throw corruptRunJournal("Supersede observation proof is not already-started");
        }
        break;
      }
      case "capability-revoked":
        assertIdentifier(value.assignmentId, "Capability revocation assignment id");
        assertIdentifier(value.capId, "Capability revocation capability id");
        break;
      case "interaction-mirror":
        assertIdentifier(value.assignmentId, "Interaction mirror assignment id");
        validateConversationInteractionMirrorBatch(
          value.batch as ConversationInteractionMirrorBatch,
          verifier,
        );
        break;
      case "channel-challenge-prepared":
      case "channel-challenge-delivered":
      case "channel-challenge-closed":
        validateConversationChannelChallengeRecord(value, verifier);
        break;
      case "state":
        assertIdentifier(value.runId, "Run state run id");
        if (value.assignmentId !== undefined) {
          assertIdentifier(value.assignmentId, "Run state assignment id");
        }
        if (!RUN_STATES.has(value.state as ConversationRunState)) {
          throw corruptRunJournal("Run state value is invalid");
        }
        assertPositiveSafeInteger(value.statusRevision, "Run state revision");
        if (value.reason !== undefined) {
          if (typeof value.reason !== "string" || Buffer.byteLength(value.reason, "utf8") > 512) {
            throw corruptRunJournal("Run state reason exceeds its durable bound");
          }
          if (value.state !== "failed") {
            throw corruptRunJournal("Only failed run state may carry a reason");
          }
        }
        if (value.usageFinal !== undefined) {
          if (value.state !== "failed" || value.assignmentId === undefined) {
            throw corruptRunJournal(
              "Only assigned failed run state may carry final usage",
            );
          }
          assertPlainRecord(value.usageFinal, "Run failure final usage");
          assertExactRecordKeys(
            value.usageFinal,
            ["reportDigest", "upToUsageSeq"],
            "Run failure final usage",
          );
          assertDigest(
            value.usageFinal.reportDigest,
            "Run failure final usage report digest",
          );
          assertNonNegativeSafeInteger(
            value.usageFinal.upToUsageSeq,
            "Run failure final usage sequence",
          );
        }
        break;
      case "committed":
        assertIdentifier(value.runId, "Committed run id");
        assertIdentifier(value.assignmentId, "Committed assignment id");
        assertPositiveSafeInteger(value.commitRevision, "Committed revision");
        assertExactRecordKeys(value.bundle, ["ref"], "Committed bundle");
        assertArtifactReference(value.bundle.ref, "Committed bundle reference");
        break;
      case "bundle-ack-observed":
        assertIdentifier(value.assignmentId, "Bundle acknowledgement assignment id");
        assertArtifactReference(
          value.bundleRef,
          "Bundle acknowledgement bundle reference",
        );
        assertPositiveSafeInteger(
          value.commitRevision,
          "Bundle acknowledgement commit revision",
        );
        break;
      case "resolution":
        assertIdentifier(value.runId, "Resolution run id");
        validateResolutionFact(value.fact);
        break;
      case "advancement-event": {
        assertIdentifier(value.requestId, "Advancement event request id");
        assertPositiveSafeInteger(
          value.domainRevision,
          "Advancement event domain revision",
        );
        assertDigest(value.eventsDigest, "Advancement events digest");
        if (isStoredReference(value.event)) {
          assertArtifactReference(value.event.ref, "Advancement event reference");
        } else if (!isAdvancementControlEvent(value.event, verifier)) {
          throw corruptRunJournal("Advancement event contract failed");
        }
        break;
      }
      case "cancel-contained":
      case "cancel-proof-accepted":
        assertIdentifier(value.assignmentId, `${type} assignment id`);
        if (type === "cancel-contained") {
          assertDigest(value.openFactDigest, "Cancellation containment open fact digest");
        }
        validateCancelProof(value.proof as CancelProofBody, verifier);
        break;
    }
    return value as unknown as ConversationRunRecord;
  } catch (error) {
    if (error instanceof AuthorityStorageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw corruptRunJournal(`Run journal record contract failed: ${message}`);
  }
}

export function validateConversationRunInternalRecord(
  value: unknown,
): ConversationRunInternalRecord {
  assertPlainRecord(value, "Run internal record");
  if (value.kind === "conversation-commit-projection") {
    assertExactRecordKeys(
      value,
      ["assignmentId", "commitRevision", "digest", "kind", "runId"],
      "Conversation commit projection",
    );
    assertIdentifier(value.assignmentId, "Projection assignment id");
    assertIdentifier(value.runId, "Projection run id");
    assertPositiveSafeInteger(value.commitRevision, "Projection commit revision");
    assertDigest(value.digest, "Projection bundle digest");
    return value as ConversationRunInternalRecord;
  }
  if (value.kind === "conversation-lifecycle-projection") {
    assertExactRecordKeys(
      value,
      ["domainRevision", "kind", "mutation", "requestId"],
      "Conversation lifecycle projection",
    );
    if (value.mutation !== "clear" && value.mutation !== "delete") {
      throw corruptRunJournal("Conversation lifecycle projection mutation is invalid");
    }
    assertPositiveSafeInteger(
      value.domainRevision,
      "Conversation lifecycle projection domain revision",
    );
    assertIdentifier(value.requestId, "Conversation lifecycle projection request id");
    return value as ConversationRunInternalRecord;
  }
  if (value.kind === "session-activity") {
    assertExactRecordKeys(
      value,
      [
        "conversationId",
        "kind",
        "lastActiveAt",
        "operation",
        "sceneId",
        "sessionRevision",
      ],
      "Session activity record",
    );
    if (value.operation !== "upsert" && value.operation !== "delete") {
      throw corruptRunJournal("Session activity operation is invalid");
    }
    assertIdentifier(value.conversationId, "Session activity conversation id");
    assertIdentifier(value.sceneId, "Session activity scene id");
    assertPositiveSafeInteger(
      value.sessionRevision,
      "Session activity revision",
    );
    assertCanonicalTime(value.lastActiveAt, "Session activity time");
    return value as ConversationRunInternalRecord;
  }
  if (value.kind !== "content-asset-index") {
    throw corruptRunJournal("Run journal contains an unknown internal record");
  }
  assertExactRecordKeys(value, ["entries", "kind"], "Content asset index");
  if (!Array.isArray(value.entries)) {
    throw corruptRunJournal("Content asset index entries must be an array");
  }
  let previousDigest: string | undefined;
  const digests = new Set<string>();
  for (const entry of value.entries) {
    assertExactRecordKeys(entry, ["bytes", "digest", "kind"], "Content asset entry");
    assertDigest(entry.digest, "Content asset entry digest");
    assertNonNegativeSafeInteger(entry.bytes, "Content asset entry byte count");
    if (!CONTENT_ASSET_KINDS.has(entry.kind as string)) {
      throw corruptRunJournal("Content asset entry kind is invalid");
    }
    if (digests.has(entry.digest) || (previousDigest ?? "") >= entry.digest) {
      throw corruptRunJournal("Content asset entries must be unique and sorted by digest");
    }
    previousDigest = entry.digest;
    digests.add(previousDigest);
  }
  return value as ConversationRunInternalRecord;
}

export function assertConversationRunInternalRecord(
  value: unknown,
): asserts value is ConversationRunInternalRecord {
  validateConversationRunInternalRecord(value);
}

export function assertConversationRunRecord(
  value: unknown,
  verifier: ProtocolSignatureVerifier,
): asserts value is ConversationRunRecord {
  validateConversationRunRecord(value, verifier);
}

export function validateResolutionFact(value: unknown): UncertainResolutionFact {
  assertPlainRecord(value, "Uncertain resolution fact");
  assertRecordKeys(
    value,
    ["cause", "openFactDigest", "openedAt", "subject"],
    ["resolution"],
    "Uncertain resolution fact",
  );
  assertDigest(value.openFactDigest, "Uncertain resolution open fact digest");
  assertCanonicalTime(value.openedAt, "Uncertain resolution openedAt");
  if (!RESOLUTION_CAUSES.has(value.cause as UncertainResolutionFact["cause"])) {
    throw corruptRunJournal("Uncertain resolution cause is invalid");
  }
  assertPlainRecord(value.subject, "Uncertain resolution subject");
  const execution = value.subject.execution;
  if (execution === "conversation") {
    assertExactRecordKeys(
      value.subject,
      ["assignmentId", "conversationId", "execution", "ownerEpoch", "runId"],
      "Conversation resolution subject",
    );
    assertIdentifier(value.subject.conversationId, "Resolution conversation id");
    assertIdentifier(value.subject.runId, "Resolution run id");
  } else if (execution === "job") {
    assertExactRecordKeys(
      value.subject,
      ["anchorEpoch", "assignmentId", "execution", "jobRunId", "taskId"],
      "Job resolution subject",
    );
    assertIdentifier(value.subject.taskId, "Resolution task id");
    assertIdentifier(value.subject.jobRunId, "Resolution job run id");
    assertPositiveSafeInteger(value.subject.anchorEpoch, "Resolution anchor epoch");
  } else {
    throw corruptRunJournal("Uncertain resolution execution is invalid");
  }
  if (
    (execution === "conversation" && value.cause === "job-cancel-unknown") ||
    (execution === "job" && value.cause === "cancel-unproven")
  ) {
    throw corruptRunJournal("Uncertain resolution cause does not match its execution kind");
  }
  assertIdentifier(value.subject.assignmentId, "Resolution assignment id");
  if (execution === "conversation") {
    assertPositiveSafeInteger(value.subject.ownerEpoch, "Resolution owner epoch");
  }
  if (
    value.openFactDigest !==
    protocolDigest("UncertainOpenFact", 1, {
      subject: value.subject,
      openedAt: value.openedAt,
      cause: value.cause,
    })
  ) {
    throw corruptRunJournal("Uncertain resolution open digest is invalid");
  }

  if (value.resolution !== undefined) {
    assertExactRecordKeys(
      value.resolution,
      ["at", "by", "factDigest", "kind"],
      "Uncertain resolution decision",
    );
    assertIdentifier(value.resolution.by, "Uncertain resolution actor");
    assertCanonicalTime(value.resolution.at, "Uncertain resolution time");
    assertDigest(value.resolution.factDigest, "Uncertain resolution fact digest");
    if (
      !RESOLUTION_KINDS.has(
        value.resolution.kind as NonNullable<UncertainResolutionFact["resolution"]>["kind"],
      )
    ) {
      throw corruptRunJournal("Uncertain resolution decision kind is invalid");
    }
    if (
      execution !== "job" &&
      value.resolution.kind === "proven-not-started-cancelled"
    ) {
      throw corruptRunJournal(
        "Task-state cancellation resolution belongs only to job execution",
      );
    }
    if (
      value.resolution.factDigest !==
      resolutionFactDigest(
        value.openFactDigest as string,
        value.resolution.kind as NonNullable<
          UncertainResolutionFact["resolution"]
        >["kind"],
        value.resolution.by as string,
        value.resolution.at as string,
      )
    ) {
      throw corruptRunJournal("Uncertain resolution decision digest is invalid");
    }
    assertResolutionKindCompatible(
      value.cause as UncertainResolutionFact["cause"],
      value.resolution.kind as NonNullable<UncertainResolutionFact["resolution"]>["kind"],
    );
  }
  return value as unknown as UncertainResolutionFact;
}

export function resolutionFactDigest(
  openFactDigest: string,
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
  by: string,
  at: string,
): string {
  return protocolDigest("UncertainResolutionDecision", 1, {
    openFactDigest,
    kind,
    by,
    at,
  });
}

export function assertResolutionKindCompatible(
  cause: UncertainResolutionFact["cause"],
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
): void {
  if (cause === "dispatch-conflict" && kind === "late-bundle-committed") {
    throw corruptRunJournal("Dispatch conflict cannot close through a late bundle commit");
  }
}

export function assertAdmissionReplayContract(input: {
  readonly runAlreadyAdmitted: boolean;
  readonly ingressAlreadyAdmitted: boolean;
  readonly queuedPositionAlreadyUsed: boolean;
  readonly hasAtomicQueuedState: boolean;
}): void {
  if (
    input.runAlreadyAdmitted ||
    input.ingressAlreadyAdmitted ||
    input.queuedPositionAlreadyUsed ||
    !input.hasAtomicQueuedState
  ) {
    throw corruptRunJournal(
      "Run admission is duplicated or not atomic with its initial queued state",
    );
  }
}

export function assertAssignmentReplayContract(input: {
  readonly currentState: SharedRunState | undefined;
  readonly currentRevision: number | undefined;
  readonly runAlreadyAssigned: boolean;
  readonly assignmentAlreadyKnown: boolean;
  readonly isEarliestQueuedRun: boolean;
  readonly hasAtomicDispatchedState: boolean;
}): void {
  if (
    input.currentState !== "queued" ||
    input.currentRevision === undefined ||
    input.runAlreadyAssigned ||
    input.assignmentAlreadyKnown ||
    !input.isEarliestQueuedRun ||
    !input.hasAtomicDispatchedState
  ) {
    throw corruptRunJournal(
      "Run assignment is duplicated, misplaced, or not atomic with dispatched state",
    );
  }
}

export function bundleAcknowledgementBindsCommitted(input: {
  readonly observedBundleRef: ArtifactRef | undefined;
  readonly observedCommitRevision: number | undefined;
  readonly expectedBundleRef: ArtifactRef;
  readonly expectedCommitRevision: number;
}): boolean {
  return (
    input.observedBundleRef !== undefined &&
    input.observedCommitRevision !== undefined &&
    canonicalize(input.observedBundleRef) === canonicalize(input.expectedBundleRef) &&
    input.observedCommitRevision === input.expectedCommitRevision
  );
}

export function assertDispatchAcknowledgementReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly alreadyAcknowledged: boolean;
  readonly assignmentSuperseded: boolean;
  readonly assignmentClosed: boolean;
}): void {
  // The producer accepts late receipts after started/fence facts landed, so any
  // active state is a legal acknowledgement point; only terminal states reject.
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    (input.currentState !== "dispatched" &&
      input.currentState !== "running" &&
      input.currentState !== "cancel-requested" &&
      input.currentState !== "uncertain") ||
    input.alreadyAcknowledged ||
    input.assignmentSuperseded ||
    input.assignmentClosed
  ) {
    throw corruptRunJournal("Dispatch acknowledgement replay contract is invalid");
  }
}

export function assertDispatchConflictReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly proofBindsAssignment: boolean;
  readonly handling: unknown;
  readonly assignmentAcknowledged: boolean;
  readonly assignmentSuperseded: boolean;
  readonly assignmentClosed: boolean;
  readonly conflictAlreadySeen: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    input.currentState !== "dispatched" ||
    !input.proofBindsAssignment ||
    (input.handling !== "acked-original" && input.handling !== "opened-uncertain") ||
    input.assignmentAcknowledged ||
    input.assignmentSuperseded ||
    input.assignmentClosed ||
    input.conflictAlreadySeen
  ) {
    throw corruptRunJournal("Dispatch conflict replay contract is invalid");
  }
}

export function assertDispatchConflictHandlingReplayContract(input: {
  readonly handling: "acked-original" | "opened-uncertain";
  readonly acceptedMatches: boolean;
  readonly conflictingMatches: boolean;
  readonly atomicHandling: boolean;
}): void {
  if (
    (input.handling === "acked-original" &&
      (!input.acceptedMatches || input.conflictingMatches)) ||
    (input.handling === "opened-uncertain" &&
      (input.acceptedMatches || !input.conflictingMatches)) ||
    !input.atomicHandling
  ) {
    throw corruptRunJournal(
      "Dispatch conflict handling is incomplete or does not match authority truth",
    );
  }
}

export function assertSupersedeRequestReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly requestAlreadyExists: boolean;
  readonly fenceSeq: number;
  readonly envelopeLsn: number;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    input.currentState !== "dispatched" ||
    input.requestAlreadyExists ||
    !Number.isSafeInteger(input.fenceSeq) ||
    input.fenceSeq !== input.envelopeLsn
  ) {
    throw corruptRunJournal("Supersede request replay contract is invalid");
  }
}

export function assertSupersedeStartedObservationReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly proofBindsDurableSource: boolean;
  readonly observationAlreadyExists: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    (input.currentState !== "uncertain" && input.currentState !== "cancel-requested") ||
    !input.proofBindsDurableSource ||
    input.observationAlreadyExists
  ) {
    throw corruptRunJournal("Supersede started observation replay contract is invalid");
  }
}

export function assertCancelFenceReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: ConversationRunState | undefined;
  readonly fenceAlreadyExists: boolean;
  readonly fenceSeq: number;
  readonly envelopeLsn: number;
  readonly hasAtomicTargetState: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    (input.currentState !== "dispatched" && input.currentState !== "running") ||
    input.fenceAlreadyExists ||
    !Number.isSafeInteger(input.fenceSeq) ||
    input.fenceSeq !== input.envelopeLsn ||
    !input.hasAtomicTargetState
  ) {
    throw corruptRunJournal("Cancel fence replay contract is invalid");
  }
}

export type AssignmentTerminationProofKind =
  | "cancel"
  | "dispatch-rejection"
  | "supersede";

/** Cancel proofs bind identically for both decisions, so halted CancelProofBody shares this source. */
export type DurableSourceBoundProof =
  | AssignmentTerminationProof
  | CancelProofBody
  | Extract<SupersedeProof, { decision: "already-started" }>;

export function assignmentTerminationProofKind(
  proof: DurableSourceBoundProof,
): AssignmentTerminationProofKind {
  if ("dispatchDigest" in proof) return "dispatch-rejection";
  if (proof.decision === "not-started-fenced" || proof.decision === "already-started") {
    return "supersede";
  }
  return "cancel";
}

type DurableSourceBinding = {
  readonly proof: DurableSourceBoundProof;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly dispatchDigest: string;
  readonly abortTicketProofBindsDurableSource: boolean;
  readonly supersedeRequest?: {
    readonly fenceSeq: number;
    readonly requestId: string;
  };
  readonly cancelFence?: {
    readonly fenceSeq: number;
    readonly requestId: string;
  };
} & (
  | { readonly execution?: "conversation"; readonly conversationId: string; readonly ownerEpoch: number }
  | { readonly execution: "job"; readonly taskId: string; readonly anchorEpoch: number }
);

export function terminationProofBindsDurableSource(
  input: DurableSourceBinding,
): boolean {
  const { proof } = input;
  if (proof.assignmentId !== input.assignmentId || proof.executorId !== input.executorId) {
    return false;
  }
  const kind = assignmentTerminationProofKind(proof);
  if (kind === "dispatch-rejection") {
    return "dispatchDigest" in proof && proof.dispatchDigest === input.dispatchDigest;
  }
  if (kind === "supersede") {
    const fence = "fence" in proof ? proof.fence : undefined;
    return (
      fence !== undefined &&
      input.supersedeRequest !== undefined &&
      fence.fenceSeq === input.supersedeRequest.fenceSeq &&
      fence.requestId === input.supersedeRequest.requestId
    );
  }
  const cancelProof = proof as CancelProofBody;
  const authorityMatches = input.execution === "job"
    ? cancelProof.authority.execution === "job" &&
      cancelProof.authority.taskId === input.taskId &&
      cancelProof.authority.anchorEpoch === input.anchorEpoch
    : cancelProof.authority.execution === "conversation" &&
      cancelProof.authority.conversationId === input.conversationId &&
      cancelProof.authority.ownerEpoch === input.ownerEpoch;
  if (!authorityMatches) {
    return false;
  }
  if (cancelProof.cause === "abort-ticket") {
    return input.abortTicketProofBindsDurableSource;
  }
  return (
    input.cancelFence !== undefined &&
    cancelProof.fence.fenceSeq === input.cancelFence.fenceSeq &&
    cancelProof.fence.requestId === input.cancelFence.requestId
  );
}

export function assertAssignmentSupersededReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly assignmentAlreadyClosed: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly durableStartedObserved: boolean;
  readonly proofBindsDurableSource: boolean;
  readonly proofKind: AssignmentTerminationProofKind;
  readonly hasAtomicTargetState: boolean;
  readonly allCapabilitiesRevoked: boolean;
  readonly hasAtomicResolutionClose: boolean;
  readonly conflictOpen: boolean;
  readonly hasAtomicConflictContainment: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    input.assignmentAlreadyClosed ||
    (input.currentState !== "dispatched" &&
      input.currentState !== "uncertain" &&
      input.currentState !== "cancel-requested") ||
    // A not-started cancel proof only authorizes supersede as an uncertain
    // containment settlement; outside uncertain it must go through
    // cancel-proof-accepted instead.
    (input.proofKind === "cancel" && input.currentState !== "uncertain") ||
    input.durableStartedObserved ||
    !input.proofBindsDurableSource ||
    !input.hasAtomicTargetState ||
    !input.allCapabilitiesRevoked ||
    (input.currentState === "uncertain" && !input.hasAtomicResolutionClose) ||
    (input.conflictOpen &&
      (input.proofKind === "dispatch-rejection" ||
        !input.hasAtomicConflictContainment))
  ) {
    throw corruptRunJournal("Assignment supersede replay contract is invalid");
  }
}

export function assertCancelProofAcceptedReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly acceptanceAlreadyExists: boolean;
  readonly durableStartedObserved: boolean;
  readonly proofDecision: CancelProofBody["decision"];
  readonly proofBindsDurableSource: boolean;
  readonly hasAtomicCancelledState: boolean;
  readonly allCapabilitiesRevoked: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentIsCurrent ||
    (input.currentState !== "dispatched" &&
      input.currentState !== "running" &&
      input.currentState !== "cancel-requested") ||
    input.acceptanceAlreadyExists ||
    (input.proofDecision === "not-started" && input.durableStartedObserved) ||
    !input.proofBindsDurableSource ||
    !input.hasAtomicCancelledState ||
    !input.allCapabilitiesRevoked
  ) {
    throw corruptRunJournal("Accepted cancel proof replay contract is invalid");
  }
}

export function assertCapabilityRevocationReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly capabilityBelongsToAssignment: boolean;
  readonly alreadyRevoked: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.capabilityBelongsToAssignment ||
    input.alreadyRevoked
  ) {
    throw corruptRunJournal("Capability revocation replay contract is invalid");
  }
}

export function assertStateReplayContract(input: {
  readonly currentState: ConversationRunState | undefined;
  readonly currentRevision: number | undefined;
  readonly nextState: ConversationRunState;
  readonly nextRevision: number;
  readonly assignmentId: string | undefined;
  readonly assignmentBindingValid: boolean;
  readonly unassignedBindingValid: boolean;
  readonly hasAtomicAssignment: boolean;
}): { readonly assignmentDriven: boolean } {
  assertRunStateTransition(input.currentState, input.nextState);
  if (input.nextRevision !== (input.currentRevision ?? 0) + 1) {
    throw corruptRunJournal("Run status revision is not contiguous");
  }
  const assignmentDriven = transitionRequiresAssignment(input.currentState, input.nextState);
  if (assignmentDriven) {
    if (!input.assignmentId || !input.assignmentBindingValid) {
      throw corruptRunJournal("Run state transition does not bind its assignment");
    }
  } else if (input.assignmentId !== undefined || !input.unassignedBindingValid) {
    throw corruptRunJournal("Unassigned run state transition carries an assignment identity");
  }
  if (
    input.currentState === "queued" &&
    input.nextState === "dispatched" &&
    !input.hasAtomicAssignment
  ) {
    throw corruptRunJournal("Dispatched state is not atomic with its assignment");
  }
  return { assignmentDriven };
}

export function assertStateAtomicReplayContract(input: {
  readonly currentState: SharedRunState | undefined;
  readonly nextState: SharedRunState;
  readonly hasAtomicCancelFence: boolean;
  readonly hasAtomicOpenResolution: boolean;
  readonly hasAtomicSupersede: boolean;
  readonly hasAtomicTermination: boolean;
  readonly hasAtomicResolutionClose: boolean;
  readonly hasAtomicCommit: boolean;
}): void {
  if (input.nextState === "cancel-requested" && !input.hasAtomicCancelFence) {
    throw corruptRunJournal("Cancel-requested state is not atomic with its cancel fence");
  }
  if (input.nextState === "uncertain" && !input.hasAtomicOpenResolution) {
    throw corruptRunJournal("Uncertain state is not atomic with its open resolution fact");
  }
  if (
    input.currentState === "dispatched" &&
    input.nextState === "queued" &&
    !input.hasAtomicSupersede
  ) {
    throw corruptRunJournal("Redispatched state is not atomic with assignment supersede");
  }
  if (
    input.currentState !== undefined &&
    input.currentState !== "queued" &&
    input.currentState !== "uncertain" &&
    input.nextState === "cancelled" &&
    !input.hasAtomicTermination
  ) {
    throw corruptRunJournal("Assigned cancellation is not atomic with its termination proof");
  }
  if (
    input.currentState === "uncertain" &&
    input.nextState !== "uncertain" &&
    !input.hasAtomicResolutionClose
  ) {
    throw corruptRunJournal("Uncertain state can only exit with an atomic resolution");
  }
  if (input.nextState === "committed" && !input.hasAtomicCommit) {
    throw corruptRunJournal("Committed state is not atomic with its committed run fact");
  }
}

export function nextActiveRunIdForReplay(input: {
  readonly activeRunId: string | undefined;
  readonly runId: string;
  readonly currentState: ConversationRunState | undefined;
  readonly nextState: ConversationRunState;
}): string | undefined {
  const wasActive =
    input.currentState !== undefined && isActiveRunState(input.currentState);
  const willBeActive = isActiveRunState(input.nextState);
  if (wasActive && input.activeRunId !== input.runId) {
    throw corruptRunJournal("Active run index does not match the durable state");
  }
  if (
    willBeActive &&
    input.activeRunId !== undefined &&
    input.activeRunId !== input.runId
  ) {
    throw corruptRunJournal("Conversation has more than one active run");
  }
  if (wasActive && !willBeActive) return undefined;
  if (willBeActive) return input.runId;
  return input.activeRunId;
}

export function assertConversationResolutionBinding(input: {
  readonly execution: unknown;
  readonly conversationId: unknown;
  readonly subjectRunId: unknown;
  readonly recordRunId: string;
  readonly authorityConversationId: string;
  readonly subjectOwnerEpoch: unknown;
  /** Durable assigned snapshot epoch; undefined defers to assignmentExists rejection. */
  readonly authorityOwnerEpoch: number | undefined;
}): void {
  if (
    input.execution !== "conversation" ||
    input.conversationId !== input.authorityConversationId ||
    input.subjectRunId !== input.recordRunId ||
    (input.authorityOwnerEpoch !== undefined &&
      input.subjectOwnerEpoch !== input.authorityOwnerEpoch)
  ) {
    throw corruptRunJournal("Uncertain resolution fact belongs to another authority");
  }
}

export function isOpenResolutionFact(
  fact: UncertainResolutionFact | undefined,
): fact is UncertainResolutionFact & { readonly resolution?: undefined } {
  return fact !== undefined && fact.resolution === undefined;
}

export function assertResolutionOpenReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentBindsRun: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly alreadyOpen: boolean;
  readonly cause: UncertainResolutionFact["cause"];
  readonly hasAtomicUncertainState: boolean;
  readonly hasAtomicDispatchConflict: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentBindsRun ||
    !input.assignmentIsCurrent ||
    input.alreadyOpen ||
    (input.currentState !== "dispatched" &&
      input.currentState !== "running" &&
      input.currentState !== "cancel-requested") ||
    !input.hasAtomicUncertainState ||
    (input.cause === "dispatch-conflict" && !input.hasAtomicDispatchConflict)
  ) {
    throw corruptRunJournal(
      "Uncertain resolution open is duplicated or not atomic with authority state",
    );
  }
}

export function resolutionTargetState(
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
): "committed" | "queued" | "cancelled" | "failed" {
  if (kind === "late-bundle-committed") return "committed";
  if (kind === "proven-not-started-redispatched" || kind === "user-retry-acknowledged") {
    return "queued";
  }
  if (kind === "proven-not-started-cancelled" || kind === "user-abandoned") {
    return "cancelled";
  }
  return "failed";
}

export type UncertainStatusTransition =
  | { readonly kind: "ordinary" }
  | { readonly kind: "opened"; readonly openFactDigest: string }
  | {
      readonly kind: "closed";
      readonly openFactDigest: string;
      readonly resolutionKind: NonNullable<
        UncertainResolutionFact["resolution"]
      >["kind"];
    };

export function projectUncertainStatusTransition(input: {
  readonly currentState: SharedRunState | undefined;
  readonly nextState: SharedRunState;
  readonly resolutionFacts: readonly UncertainResolutionFact[];
}): UncertainStatusTransition {
  const opens = input.resolutionFacts.filter((fact) => fact.resolution === undefined);
  const closes = input.resolutionFacts.filter((fact) => fact.resolution !== undefined);
  if (input.nextState === "uncertain" && input.currentState !== "uncertain") {
    if (opens.length !== 1 || closes.length !== 0) {
      throw corruptRunJournal(
        "Uncertain status opening does not bind exactly one durable open fact",
      );
    }
    return { kind: "opened", openFactDigest: opens[0]!.openFactDigest };
  }
  if (input.currentState === "uncertain" && input.nextState !== "uncertain") {
    if (closes.length !== 1 || opens.length !== 0) {
      throw corruptRunJournal(
        "Uncertain status closure does not bind exactly one durable resolution",
      );
    }
    const fact = closes[0]!;
    const resolution = fact.resolution!;
    if (resolutionTargetState(resolution.kind) !== input.nextState) {
      throw corruptRunJournal(
        "Uncertain status closure does not match its durable successor state",
      );
    }
    return {
      kind: "closed",
      openFactDigest: fact.openFactDigest,
      resolutionKind: resolution.kind,
    };
  }
  if (input.resolutionFacts.length !== 0) {
    throw corruptRunJournal(
      "Uncertain resolution fact does not bind an uncertainty state edge",
    );
  }
  return { kind: "ordinary" };
}

export function conversationUncertainClosure(
  kind: Exclude<
    NonNullable<UncertainResolutionFact["resolution"]>["kind"],
    "proven-not-started-cancelled"
  >,
): ConversationUncertainClosure {
  switch (kind) {
    case "late-bundle-committed":
      return { closedBy: kind, resultingState: "committed" };
    case "proven-not-started-redispatched":
    case "user-retry-acknowledged":
      return { closedBy: kind, resultingState: "queued" };
    case "user-abandoned":
      return { closedBy: kind, resultingState: "cancelled" };
    case "user-verified-side-effects":
      return { closedBy: kind, resultingState: "failed" };
  }
}

export function jobUncertainClosure(
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
): JobUncertainClosure {
  if (kind === "proven-not-started-cancelled") {
    return { closedBy: kind, resultingState: "cancelled" };
  }
  return conversationUncertainClosure(kind);
}

export function assertResolutionCloseAtomicReplayContract(input: {
  readonly cause: UncertainResolutionFact["cause"];
  readonly kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"];
  readonly existingOpenMatches: boolean;
  readonly hasAtomicTargetState: boolean;
  readonly allCapabilitiesRevoked: boolean;
  readonly hasRequiredCompanion: boolean;
}): void {
  assertResolutionKindCompatible(input.cause, input.kind);
  if (
    !input.existingOpenMatches ||
    !input.hasAtomicTargetState ||
    !input.allCapabilitiesRevoked ||
    !input.hasRequiredCompanion
  ) {
    throw corruptRunJournal(
      "Uncertain resolution close is missing its atomic authority facts",
    );
  }
}

export function assertResolutionClosureReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentBindsRun: boolean;
  readonly assignmentIsCurrentOrAtomicallyClosed: boolean;
  readonly conflictOpen: boolean;
  readonly resolutionKind: NonNullable<UncertainResolutionFact["resolution"]>["kind"];
}): void {
  assertResolutionKindCompatible(
    input.conflictOpen ? "dispatch-conflict" : "ledger-unknown",
    input.resolutionKind,
  );
  if (
    !input.assignmentExists ||
    !input.assignmentBindsRun ||
    !input.assignmentIsCurrentOrAtomicallyClosed
  ) {
    throw corruptRunJournal("Uncertain resolution closure replay contract is invalid");
  }
}

export function assertCommittedReplayContract(input: {
  readonly assignmentExists: boolean;
  readonly assignmentBindsRun: boolean;
  readonly assignmentIsCurrent: boolean;
  readonly currentState: SharedRunState | undefined;
  readonly alreadyCommitted: boolean;
  readonly conflictOpen: boolean;
  readonly commitRevisionMatchesAssignedBase: boolean;
  readonly hasAtomicCommittedState: boolean;
  readonly allCapabilitiesRevoked: boolean;
}): void {
  if (
    !input.assignmentExists ||
    !input.assignmentBindsRun ||
    !input.assignmentIsCurrent ||
    input.currentState === undefined ||
    input.alreadyCommitted ||
    input.conflictOpen ||
    !input.commitRevisionMatchesAssignedBase ||
    !input.hasAtomicCommittedState ||
    !input.allCapabilitiesRevoked
  ) {
    throw corruptRunJournal("Committed run replay contract is invalid or incomplete");
  }
}

export function assertHistoricalBundleFence(input: {
  readonly assignedExecutorId: string;
  readonly assignedOwnerEpoch: number;
  readonly assignedBaseRevision: number;
  readonly bundleExecutorId: string;
  readonly bundleOwnerEpoch: number;
  readonly bundleBaseRevision: number;
  readonly conflictOpen: boolean;
}): void {
  if (!historicalBundleFenceMatches(input)) {
    throw corruptRunJournal("Bundle does not satisfy its historical assignment fence");
  }
}

export function historicalBundleFenceMatches(input: {
  readonly assignedExecutorId: string;
  readonly assignedOwnerEpoch: number;
  readonly assignedBaseRevision: number;
  readonly bundleExecutorId: string;
  readonly bundleOwnerEpoch: number;
  readonly bundleBaseRevision: number;
  readonly conflictOpen: boolean;
}): boolean {
  return (
    !input.conflictOpen &&
    input.bundleExecutorId === input.assignedExecutorId &&
    input.bundleOwnerEpoch === input.assignedOwnerEpoch &&
    input.bundleBaseRevision === input.assignedBaseRevision
  );
}

export function assertRunStateTransition(
  current: ConversationRunState | undefined,
  next: ConversationRunState,
): void {
  if (
    (current === undefined && next === "queued") ||
    (current === "queued" &&
      (next === "dispatched" ||
        next === "cancelled" ||
        next === "failed" ||
        next === "expired")) ||
    (current === "dispatched" &&
      (next === "running" ||
        next === "committed" ||
        next === "failed" ||
        next === "queued" ||
        next === "cancel-requested" ||
        next === "uncertain" ||
        next === "cancelled")) ||
    (current === "running" &&
      (next === "committed" ||
        next === "failed" ||
        next === "cancel-requested" ||
        next === "uncertain" ||
        next === "cancelled")) ||
    (current === "cancel-requested" &&
      (next === "committed" || next === "cancelled" || next === "uncertain")) ||
    (current === "uncertain" &&
      (next === "committed" ||
        next === "queued" ||
        next === "failed" ||
        next === "cancelled"))
  ) {
    return;
  }
  throw corruptRunJournal(`Illegal conversation run transition: ${current ?? "none"} -> ${next}`);
}

export function transitionRequiresAssignment(
  current: ConversationRunState | undefined,
  next: ConversationRunState,
): boolean {
  return !(
    (current === undefined && next === "queued") ||
    (current === "queued" &&
      (next === "cancelled" || next === "failed" || next === "expired"))
  );
}

function isActiveRunState(state: ConversationRunState): boolean {
  return (
    state === "dispatched" ||
    state === "running" ||
    state === "cancel-requested" ||
    state === "uncertain"
  );
}

export function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertProtocolIdentifier(value, label);
}

export function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function assertNonNegativeSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

export function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corruptRunJournal(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw corruptRunJournal(`${label} must be a plain object`);
  }
}

export function assertExactRecordKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertRecordKeys(value, keys, [], label);
}

export function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw corruptRunJournal(`${label} must be a canonical SHA-256 digest`);
  }
}

export function assertArtifactReference(value: unknown, label: string): void {
  assertExactRecordKeys(value, ["bytes", "digest"], label);
  assertDigest(value.digest, `${label} digest`);
  assertNonNegativeSafeInteger(value.bytes, `${label} byte count`);
}

export function corruptRunJournal(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function assertRecordKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertPlainRecord(value, label);
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw corruptRunJournal(`${label} fields are incomplete or unknown`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw corruptRunJournal(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw corruptRunJournal(`${label} must be a canonical ISO timestamp`);
  }
}

function isStoredReference(value: unknown): value is { readonly ref: ArtifactRef } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

function isCancelProof(value: unknown): value is CancelProofBody {
  return value !== null && typeof value === "object" && "cause" in value;
}
