import type {
  DataPlaneTicket,
  IngressContext,
  LogicalRecord,
} from "@zhixing-ai/core/contracts";
import {
  assertDataPlaneTicketTtlMs,
  canonicalize,
  rethrowUnloadedProtocolIdentity,
  validateDataPlaneTicket,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  advanceChannelInteractionJournal,
  type ChannelInteractionJournalState,
} from "../../channel-interaction-records.js";
import {
  assertIdentifier,
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import {
  nextDataPlaneTicketSyncFrontier,
  ticketPrecedesSyncFrontier,
} from "../../data-plane-ticket-lifecycle.js";
import type {
  ConversationCommitLogRecord,
  DataPlaneTicketIssueRequest,
} from "../contracts.js";
import { runRecord, type DeepReadonly } from "./common.js";

export interface TicketLedgerSlice {
  readonly ticketsById: Map<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: Map<string, Set<string>>;
  readonly ticketReplacementsById: Map<string, string>;
  readonly revokedTickets: Set<string>;
  ticketSyncFrontier: string | undefined;
}

export interface ChannelTicketMutableSlice extends TicketLedgerSlice {
  channelInteractions: ChannelInteractionJournalState;
}

export interface TicketReadonlyContext {
  readonly ticketsById: ReadonlyMap<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: ReadonlyMap<string, ReadonlySet<string>>;
  readonly revokedTickets: ReadonlySet<string>;
}

export function dataPlaneTicketRevocations(
  conversationId: string,
  state: Pick<TicketReadonlyContext, "ticketIdsByAssignment" | "revokedTickets">,
  assignmentId: string,
): LogicalRecord<ConversationCommitLogRecord>[] {
  return [...(state.ticketIdsByAssignment.get(assignmentId) ?? [])]
    .filter((ticketId) => !state.revokedTickets.has(ticketId))
    .map((ticketId) =>
      runRecord(conversationId, {
        t: "ticket-revoked",
        ticketId,
      }),
    );
}

export function validateTicketIssueRequest(input: DataPlaneTicketIssueRequest): void {
  assertIdentifier(input.ticketId, "Data-plane ticket id");
  assertIdentifier(input.assignmentId, "Data-plane ticket assignment id");
  assertIdentifier(
    input.surfacePrincipal,
    "Data-plane ticket surface principal",
  );
  assertDataPlaneTicketTtlMs(input.ttlMs);
  if (input.replacesTicketId !== undefined) {
    assertIdentifier(input.replacesTicketId, "Replaced data-plane ticket id");
    if (input.replacesTicketId === input.ticketId) {
      throw new TypeError("Ticket renewal requires a new ticket id");
    }
  }
}

export async function applyConversationTicketRecord(input: {
  readonly state: TicketLedgerSlice;
  readonly record: Extract<
    ConversationRunJournalRecord,
    { t: "ticket-issued" | "ticket-revoked" }
  >;
  readonly verifier: ProtocolSignatureVerifier;
  readonly envelopeAt: string;
  readonly conversationId: string;
  readonly assigned?: DeepReadonly<
    Extract<ConversationRunJournalRecord, { t: "assigned" }>
  >;
  readonly assignmentIsCurrent: boolean;
  readonly assignmentAcknowledged: boolean;
  readonly assignmentClosed: boolean;
  readonly assignmentActive: boolean;
  readonly originalSurfacePrincipal?: string;
  readonly hasAtomicReplacementRevocation?: boolean;
}): Promise<void> {
  const { state, record } = input;
  if (record.t === "ticket-revoked") {
    assertIdentifier(record.ticketId, "Revoked data-plane ticket id");
    if (!state.ticketsById.has(record.ticketId)) {
      throw corruptRunJournal("Ticket revocation names an unknown ticket");
    }
    if (state.revokedTickets.has(record.ticketId)) {
      throw corruptRunJournal("Ticket is revoked more than once");
    }
    state.revokedTickets.add(record.ticketId);
    return;
  }

  const ticket = await verifyProtocolStep(() =>
    validateDataPlaneTicket(record.ticket, input.verifier),
  );
  const assigned = input.assigned;
  const replaced =
    record.replacesTicketId === undefined
      ? undefined
      : state.ticketsById.get(record.replacesTicketId);
  if (
    !assigned ||
    !input.assignmentIsCurrent ||
    !input.assignmentAcknowledged ||
    input.assignmentClosed ||
    !input.assignmentActive ||
    state.ticketsById.has(ticket.ticketId) ||
    ticket.assignmentId !== assigned.assignmentId ||
    ticket.executorId !== assigned.executorId ||
    ticket.issuedAt !== input.envelopeAt ||
    ticket.ref.execution !== "conversation" ||
    ticket.ref.runId !== assigned.runId ||
    ticket.ref.conversationId !== input.conversationId ||
    ticket.ref.ownerEpoch !== assigned.ownerEpoch ||
    ticketPrecedesSyncFrontier(ticket, state.ticketSyncFrontier) ||
    (record.replacesTicketId !== undefined &&
      (!replaced ||
        !input.hasAtomicReplacementRevocation ||
        state.revokedTickets.has(record.replacesTicketId) ||
        !replaced.renewable ||
        ticket.kind === "abort" ||
        replaced.assignmentId !== ticket.assignmentId ||
        replaced.surfacePrincipal !== ticket.surfacePrincipal ||
        replaced.kind !== ticket.kind))
  ) {
    throw corruptRunJournal(
      "Issued ticket does not bind an active acknowledged assignment",
    );
  }
  if (
    ticket.kind !== "run-observe" &&
    ticket.surfacePrincipal !== input.originalSurfacePrincipal
  ) {
    throw corruptRunJournal("Interactive ticket does not bind the original surface");
  }
  state.ticketsById.set(ticket.ticketId, ticket);
  if (record.replacesTicketId !== undefined) {
    state.ticketReplacementsById.set(ticket.ticketId, record.replacesTicketId);
  }
  const byAssignment =
    state.ticketIdsByAssignment.get(ticket.assignmentId) ?? new Set<string>();
  byAssignment.add(ticket.ticketId);
  state.ticketIdsByAssignment.set(ticket.assignmentId, byAssignment);
}

export function applyConversationTicketSyncFrontier(
  state: Pick<TicketLedgerSlice, "ticketsById" | "ticketSyncFrontier">,
  expiresThrough: string,
  envelopeAt: string,
): void {
  const expected = nextDataPlaneTicketSyncFrontier(
    state.ticketsById.values(),
    state.ticketSyncFrontier,
    envelopeAt,
  );
  if (expected !== expiresThrough) {
    throw corruptRunJournal("Ticket sync frontier is not the next durable boundary");
  }
  state.ticketSyncFrontier = expiresThrough;
}

export async function reduceChannelChallengeRecord(input: {
  readonly state: ChannelTicketMutableSlice;
  readonly body: Extract<
    ConversationRunJournalRecord,
    {
      t:
        | "channel-challenge-prepared"
        | "channel-challenge-delivered"
        | "channel-challenge-closed";
    }
  >;
  readonly conversationId: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly bindingFacts?: {
    readonly assigned?: DeepReadonly<
      Extract<ConversationRunJournalRecord, { t: "assigned" }>
    >;
    readonly admittedIngress?: DeepReadonly<IngressContext>;
  };
}): Promise<void> {
  const { state, body } = input;
  if (body.t === "channel-challenge-prepared") {
    const assigned = input.bindingFacts?.assigned;
    const ingress = input.bindingFacts?.admittedIngress;
    if (
      !assigned ||
      !ingress ||
      ingress.kind !== "channel" ||
      body.ref.conversationId !== input.conversationId ||
      body.ref.runId !== assigned.runId ||
      body.ref.ownerEpoch !== assigned.ownerEpoch ||
      canonicalize(body.responder) !== canonicalize(ingress.responder) ||
      canonicalize(body.token.route) !== canonicalize(ingress.replyTarget)
    ) {
      throw corruptRunJournal(
        "Conversation channel challenge does not bind its assignment ingress",
      );
    }
  }
  try {
    state.channelInteractions = await verifyProtocolStep(() =>
      advanceChannelInteractionJournal(
        state.channelInteractions,
        body,
        input.verifier,
      ),
    );
  } catch (error) {
    rethrowUnloadedProtocolIdentity(error);
    throw corruptRunJournal(
      error instanceof Error ? error.message : String(error),
    );
  }
}
