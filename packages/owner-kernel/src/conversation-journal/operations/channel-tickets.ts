import { Buffer } from "node:buffer";
import {
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import type {
  ChannelResponderRef,
  ConversationChannelChallengeToken,
  DataPlaneTicket,
  EnvironmentRequirement,
  StreamFrame,
} from "@zhixing-ai/core/contracts";
import {
  assertChannelChallengeActiveAt,
  canonicalize,
  createSignedChannelChallengeToken,
  createSignedDataPlaneTicket,
  interactionDisplayDigest,
  protocolDigest,
  type ConversationInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  validateConversationChannelChallengeRecord,
  type ConversationChannelChallengePreparedRecord,
  type ConversationChannelChallengeRecord,
} from "../../channel-interaction-records.js";
import {
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import {
  dataPlaneTicketIssueMatches,
  nextDataPlaneTicketSyncFrontier,
  ticketPrecedesSyncFrontier,
} from "../../data-plane-ticket-lifecycle.js";
import type {
  DataPlaneTicketFacts,
  DataPlaneTicketIssueRequest,
} from "../../shared-protocol/contracts.js";
import type { TrustRuleHitBatchState } from "../../trust-rule-hits.js";
import {
  ConversationAssignmentCancelledError,
  type ConversationChannelFrameAdoption,
  type ConversationCommitLogRecord,
} from "../contracts.js";
import { runRecord, snapshot, withoutSignature } from "../state/common.js";
import type { ConversationDecisionFacts } from "../state/views.js";

export function decideIssueDataPlaneTicket(input: {
  readonly conversationId: string;
  readonly request: DataPlaneTicketIssueRequest;
  readonly issuedAt: string;
  readonly signer: ProtocolSigner;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "queueInput" | "assignment" | "tickets"
  >;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, DataPlaneTicket> {
  const { queueInput, assignment, tickets } = input.facts;
  const { request } = input;
  const existing = tickets.getTicket(request.ticketId);
  if (existing) {
    if (
      !dataPlaneTicketIssueMatches(
        existing,
        tickets.getTicketReplacement(request.ticketId),
        request,
      )
    ) {
      throw new Error("Ticket id already belongs to a different grant");
    }
    return {
      kind: "return",
      value: snapshot(existing, "Issued data-plane ticket"),
    };
  }
  const assigned = assignment.getAssigned(request.assignmentId);
  const runState = assigned
    ? assignment.getRunState(assigned.record.runId)?.state
    : undefined;
  if (
    !assigned ||
    !assigned.acked ||
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
      request.assignmentId ||
    (assignment.isAssignmentClosed(request.assignmentId) &&
      runState !== "cancelled")
  ) {
    throw new Error("Ticket requires a current acknowledged assignment");
  }
  const admitted = queueInput.getAdmitted(assigned.record.runId);
  if (!admitted) throw corruptRunJournal("Ticket assignment has no admission");
  if (
    request.kind !== "run-observe" &&
    request.surfacePrincipal !== admitted.record.ingress.surfacePrincipal
  ) {
    throw new Error("Interactive tickets are restricted to the original surface");
  }
  const replaced = request.replacesTicketId
    ? tickets.getTicket(request.replacesTicketId)
    : undefined;
  if (request.kind === "abort" && request.replacesTicketId !== undefined) {
    throw new Error("Abort tickets are not renewable");
  }
  if (
    request.replacesTicketId !== undefined &&
    (!replaced ||
      tickets.isTicketRevoked(request.replacesTicketId) ||
      !replaced.renewable ||
      replaced.assignmentId !== request.assignmentId ||
      replaced.surfacePrincipal !== request.surfacePrincipal ||
      replaced.kind !== request.kind)
  ) {
    throw new Error(
      "Ticket renewal does not continue an active renewable grant",
    );
  }
  if (
    (runState === "cancel-requested" || runState === "cancelled") &&
    assignment.getCancelFence(request.assignmentId) !== undefined
  ) {
    throw new ConversationAssignmentCancelledError(
      assigned.record.runId,
      request.assignmentId,
    );
  }
  if (
    (runState !== "dispatched" && runState !== "running") ||
    assignment.getCancelFence(request.assignmentId) !== undefined
  ) {
    throw new Error("Ticket requires a current acknowledged assignment");
  }
  const ticket = createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId: request.ticketId,
      ref: {
        execution: "conversation",
        runId: assigned.record.runId,
        conversationId: input.conversationId,
        ownerEpoch: assigned.record.ownerEpoch,
      },
      assignmentId: request.assignmentId,
      surfacePrincipal: request.surfacePrincipal,
      executorId: assigned.record.executorId,
      issuedAt: input.issuedAt,
      expiry: new Date(Date.parse(input.issuedAt) + request.ttlMs).toISOString(),
      kind: request.kind,
      renewable: request.kind !== "abort",
    } as Parameters<typeof createSignedDataPlaneTicket>[0],
    input.signer,
  );
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "ticket-issued",
        ticket,
        ...(request.replacesTicketId === undefined
          ? {}
          : { replacesTicketId: request.replacesTicketId }),
      }),
      ...(request.replacesTicketId === undefined
        ? []
        : [
            runRecord(input.conversationId, {
              t: "ticket-revoked" as const,
              ticketId: request.replacesTicketId,
            }),
          ]),
    ],
    value: ticket,
  };
}

export function decideRevokeDataPlaneTicket(input: {
  readonly conversationId: string;
  readonly ticketId: string;
  readonly facts: Pick<ConversationDecisionFacts, "tickets">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, boolean> {
  const { tickets } = input.facts;
  if (!tickets.hasTicket(input.ticketId)) {
    throw new Error("Cannot revoke an unknown data-plane ticket");
  }
  if (tickets.isTicketRevoked(input.ticketId)) {
    return { kind: "return", value: false };
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "ticket-revoked",
        ticketId: input.ticketId,
      }),
    ],
    value: true,
  };
}

export function decideDataPlaneTicketFacts(input: {
  readonly conversationId: string;
  readonly at: string;
  readonly facts: Pick<ConversationDecisionFacts, "tickets">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  DataPlaneTicketFacts
> {
  const { tickets } = input.facts;
  const nextFrontier = nextDataPlaneTicketSyncFrontier(
    tickets.listTickets(),
    tickets.ticketSyncFrontier,
    input.at,
  );
  const frontier = nextFrontier ?? tickets.ticketSyncFrontier;
  const issued = [...tickets.listTickets()]
    .filter((ticket) => !ticketPrecedesSyncFrontier(ticket, frontier))
    .sort((left, right) => left.ticketId.localeCompare(right.ticketId))
    .map((ticket) => snapshot(ticket, "Issued data-plane ticket"));
  const retainedIds = new Set(issued.map((ticket) => ticket.ticketId));
  const revokedTicketIds = [...retainedIds]
    .filter((ticketId) => tickets.isTicketRevoked(ticketId))
    .sort();
  const value = {
    issued,
    revokedTicketIds,
  };
  return nextFrontier === undefined
    ? { kind: "return", value }
    : {
        kind: "append",
        entries: [
          runRecord(input.conversationId, {
            t: "ticket-sync-frontier",
            expiresThrough: nextFrontier,
          }),
        ],
        value,
      };
}

export function decideRecordChannelChallengeDelivered(input: {
  readonly conversationId: string;
  readonly challengeId: string;
  readonly record: ConversationChannelChallengeRecord;
  readonly facts: Pick<ConversationDecisionFacts, "tickets">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const current =
    input.facts.tickets.channelInteractions.deliveredByChallenge.get(
      input.challengeId,
    );
  if (current && canonicalize(current) === canonicalize(input.record)) {
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [runRecord(input.conversationId, input.record)],
    value: undefined,
  };
}

export function decideCloseChannelChallenge(input: {
  readonly conversationId: string;
  readonly challengeId: string;
  readonly record: ConversationChannelChallengeRecord;
  readonly facts: Pick<ConversationDecisionFacts, "tickets">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const current =
    input.facts.tickets.channelInteractions.closedByChallenge.get(
      input.challengeId,
    );
  if (current && canonicalize(current) === canonicalize(input.record)) {
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [runRecord(input.conversationId, input.record)],
    value: undefined,
  };
}

export function decideAdoptConversationChannelFrame(input: {
  readonly conversationId: string;
  readonly frame: StreamFrame;
  readonly at: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "queueInput" | "assignment" | "tickets"
  >;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  ConversationChannelFrameAdoption
> {
  const { queueInput, assignment, tickets } = input.facts;
  const { frame } = input;
  const ref = frame.ref;
  if (ref.execution !== "conversation") {
    throw new TypeError("Conversation channel frame belongs to a different authority");
  }
  const payload = frame.payload;
  if (payload.kind !== "interaction") {
    return { kind: "return", value: {} };
  }
  const assigned = assignment.getAssigned(frame.assignmentId);
  if (
    !assigned ||
    assigned.record.runId !== ref.runId ||
    assigned.record.ownerEpoch !== ref.ownerEpoch
  ) {
    throw new TypeError(
      "Conversation channel frame does not bind the current assignment",
    );
  }
  const admitted = queueInput.getAdmitted(ref.runId);
  if (!admitted || admitted.record.ingress.kind !== "channel") {
    throw new TypeError(
      "Conversation channel confirmation requires channel ingress",
    );
  }
  if (payload.event.t === "requested") {
    const event = payload.event;
    const interactionKey = `${frame.assignmentId}\u0000${event.requestId}`;
    const existingChallengeId =
      tickets.channelInteractions.challengeByInteraction.get(interactionKey);
    if (existingChallengeId) {
      const existing =
        tickets.channelInteractions.preparedByChallenge.get(existingChallengeId);
      if (!existing || existing.ref.execution !== "conversation") {
        throw new TypeError(
          "Conversation channel request conflicts with its prepared challenge",
        );
      }
      const conversationPrepared =
        existing as ConversationChannelChallengePreparedRecord;
      if (
        conversationPrepared.frameSeq !== frame.seq ||
        conversationPrepared.toolName !== event.toolName ||
        canonicalize(conversationPrepared.display) !==
          canonicalize(event.display)
      ) {
        throw new TypeError(
          "Conversation channel request conflicts with its prepared challenge",
        );
      }
      return {
        kind: "return",
        value: { prepared: structuredClone(conversationPrepared) },
      };
    }
    const challengeId = protocolDigest("ChannelChallengeIdentity", 1, {
      ref,
      assignmentId: frame.assignmentId,
      interactionRequestId: event.requestId,
    });
    const token = createSignedChannelChallengeToken(
      {
        v: 1,
        challengeId,
        ref,
        assignmentId: frame.assignmentId,
        interactionRequestId: event.requestId,
        route: admitted.record.ingress.replyTarget,
        displayDigest: interactionDisplayDigest(event.toolName, event.display),
        issuedAt: event.issuedAt,
        expiry: event.expiresAt,
      },
      input.signer,
    );
    const prepared = validateConversationChannelChallengeRecord(
      {
        t: "channel-challenge-prepared",
        ref,
        assignmentId: frame.assignmentId,
        frameSeq: frame.seq,
        token,
        responder: admitted.record.ingress.responder,
        toolName: event.toolName,
        display: event.display,
      },
      input.verifier,
    ) as ConversationChannelChallengePreparedRecord;
    return {
      kind: "append",
      entries: [runRecord(input.conversationId, prepared)],
      value: { prepared },
    };
  }

  const challengeId = tickets.channelInteractions.challengeByInteraction.get(
    `${frame.assignmentId}\u0000${payload.event.requestId}`,
  );
  if (!challengeId) {
    throw new TypeError(
      "Conversation channel completion has no prepared challenge",
    );
  }
  const current =
    tickets.channelInteractions.closedByChallenge.get(challengeId);
  const closed = validateConversationChannelChallengeRecord(
    {
      t: "channel-challenge-closed",
      challengeId,
      outcome: payload.event.outcome,
      at: input.at,
    },
    input.verifier,
  ) as Extract<
    ConversationChannelChallengeRecord,
    { readonly t: "channel-challenge-closed" }
  >;
  if (current) {
    if (canonicalize(current) !== canonicalize(closed)) {
      throw new TypeError(
        "Conversation channel completion conflicts with its terminal record",
      );
    }
    return {
      kind: "return",
      value: { closed: structuredClone(current) },
    };
  }
  return {
    kind: "append",
    entries: [runRecord(input.conversationId, closed)],
    value: { closed },
  };
}

export function decideAuthorizeChannelCallback(input: {
  readonly token: ConversationChannelChallengeToken;
  readonly responder: ChannelResponderRef;
  readonly activeAt: string;
  readonly facts: Pick<ConversationDecisionFacts, "tickets">;
}): {
  readonly assignmentId: string;
  readonly interactionRequestId: string;
} {
  const { channelInteractions } = input.facts.tickets;
  const prepared = channelInteractions.preparedByChallenge.get(
    input.token.challengeId,
  );
  if (
    !prepared ||
    prepared.ref.execution !== "conversation" ||
    canonicalize(prepared.token) !== canonicalize(input.token) ||
    canonicalize(prepared.responder) !== canonicalize(input.responder) ||
    channelInteractions.closedByChallenge.has(input.token.challengeId)
  ) {
    throw new TypeError(
      "Conversation channel callback does not bind a pending challenge",
    );
  }
  assertChannelChallengeActiveAt(prepared.token, input.activeAt);
  return {
    assignmentId: prepared.assignmentId,
    interactionRequestId: prepared.token.interactionRequestId,
  };
}

export function decideInteractionMirror(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly batch: ConversationInteractionMirrorBatch;
  readonly batchDigest: string;
  readonly authorizeReplay: () => void;
  readonly authorizeCommit: (mode: "active" | "settlement") => void;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "assignment" | "commitPublish"
  >;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  {
    readonly mirroredUpTo: number;
    readonly ordinal: number;
    readonly mirrorDigest: string;
  }
> {
  const { assignment, commitPublish } = input.facts;
  const { assignmentId, batch, batchDigest } = input;
  const assigned = assignment.getAssigned(assignmentId);
  if (!assigned || assigned.record.executorId !== batch.executorId) {
    throw new Error("Interaction mirror does not bind the durable assignment");
  }
  const existingBatch = commitPublish.getMirrorBatch(batchDigest);
  if (existingBatch) {
    if (
      canonicalize(withoutSignature(existingBatch.batch)) !==
      canonicalize(withoutSignature(batch))
    ) {
      throw new Error(
        "Interaction mirror batch identity has conflicting payloads",
      );
    }
    input.authorizeReplay();
    const last = existingBatch.batch.entries.at(-1)!;
    return {
      kind: "return",
      value: {
        mirroredUpTo: last.seq,
        ordinal: last.ordinal,
        mirrorDigest: existingBatch.batch.mirrorDigest,
      },
    };
  }
  const mirrorState = commitPublish.getMirrorState(assignmentId);
  if (!mirrorState) {
    throw new Error("Interaction mirror projection is missing its assignment");
  }
  const first = batch.entries[0]!;
  const last = batch.entries.at(-1)!;
  if (
    batch.previousDigest !== mirrorState.mirrorDigest ||
    first.ordinal !== mirrorState.ordinal + 1 ||
    first.seq <= mirrorState.mirroredUpTo
  ) {
    throw new Error(
      "Interaction mirror batch does not continue the durable audit prefix",
    );
  }
  const batchRequestIds = new Set<string>();
  for (const entry of batch.entries) {
    if (
      mirrorState.requestIds.has(entry.requestId) ||
      batchRequestIds.has(entry.requestId)
    ) {
      throw new Error(
        "Interaction mirror batch repeats a durable request identity",
      );
    }
    batchRequestIds.add(entry.requestId);
  }
  const current = assignment.getRunState(assigned.record.runId)?.state;
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !== assignmentId ||
    assignment.isAssignmentClosed(assignmentId) ||
    (current !== "dispatched" &&
      current !== "running" &&
      !(
        (current === "cancel-requested" || current === "uncertain") &&
        assignment.getCancelFence(assignmentId) !== undefined
      ))
  ) {
    throw new Error("New interaction mirror belongs to a historical assignment");
  }
  input.authorizeCommit(
    current === "cancel-requested" || current === "uncertain"
      ? "settlement"
      : "active",
  );
  const mirrorRecord: Extract<
    ConversationRunJournalRecord,
    { t: "interaction-mirror" }
  > = {
    t: "interaction-mirror",
    assignmentId,
    batch,
  };
  if (
    Buffer.byteLength(canonicalize(mirrorRecord), "utf8") >
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    throw new TypeError(
      "Interaction mirror batch exceeds the durable record limit",
    );
  }
  return {
    kind: "append",
    entries: [runRecord(input.conversationId, mirrorRecord)],
    value: {
      mirroredUpTo: last.seq,
      ordinal: last.ordinal,
      mirrorDigest: batch.mirrorDigest,
    },
  };
}

export function decideTrustRuleHitPrecheck(input: {
  readonly assignmentId: string;
  readonly batch: ConversationInteractionMirrorBatch;
  readonly batchDigest: string;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "assignment" | "commitPublish"
  >;
}):
  | {
      readonly prepare: boolean;
      readonly environment: EnvironmentRequirement;
    }
  | undefined {
  const { assignment, commitPublish } = input.facts;
  const current = assignment.getAssigned(input.assignmentId);
  if (!current?.envelope) return undefined;
  const mirrorState = commitPublish.getMirrorState(input.assignmentId);
  const first = input.batch.entries[0];
  const runState = assignment.getRunState(current.record.runId)?.state;
  const requestIds = new Set<string>();
  const freshIdentities = input.batch.entries.every((entry) => {
    if (
      requestIds.has(entry.requestId) ||
      mirrorState?.requestIds.has(entry.requestId)
    ) {
      return false;
    }
    requestIds.add(entry.requestId);
    return true;
  });
  const prepare =
    !commitPublish.hasMirrorBatch(input.batchDigest) &&
    !assignment.isAssignmentClosed(input.assignmentId) &&
    assignment.getAssignmentIdForRun(current.record.runId) ===
      input.assignmentId &&
    (runState === "dispatched" ||
      runState === "running" ||
      ((runState === "cancel-requested" || runState === "uncertain") &&
        assignment.getCancelFence(input.assignmentId) !== undefined)) &&
    current.record.executorId === input.batch.executorId &&
    mirrorState !== undefined &&
    first !== undefined &&
    input.batch.previousDigest === mirrorState.mirrorDigest &&
    first.ordinal === mirrorState.ordinal + 1 &&
    first.seq > mirrorState.mirroredUpTo &&
    freshIdentities;
  return {
    prepare,
    environment: structuredClone(
      current.envelope.manifest.environment,
    ) as EnvironmentRequirement,
  };
}

export function decideTrustRuleHitBatchState(input: {
  readonly assignmentId: string;
  readonly batchDigest: string;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "assignment" | "commitPublish"
  >;
}): TrustRuleHitBatchState {
  const { assignment, commitPublish } = input.facts;
  if (commitPublish.hasMirrorBatch(input.batchDigest)) return "committed";
  if (
    !assignment.hasAssigned(input.assignmentId) ||
    assignment.isAssignmentClosed(input.assignmentId)
  ) {
    return "rejected";
  }
  return "unknown";
}
