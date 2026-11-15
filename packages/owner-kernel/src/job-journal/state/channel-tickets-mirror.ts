import type {
  DataPlaneTicket,
  InteractionAnswerMirrorEntry,
  StreamFrame,
} from "@zhixing-ai/core/contracts";
import {
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  validateDataPlaneTicket,
  type ProtocolSignatureVerifier,
  type StreamVerifierCheckpoint,
} from "@zhixing-ai/core/protocol";
import type { JobChannelChallengePreparedRecord } from "../../channel-interaction-records.js";
import {
  dataPlaneTicketSyncBoundary,
  nextDataPlaneTicketSyncFrontier,
  ticketPrecedesSyncFrontier,
} from "../../data-plane-ticket-lifecycle.js";
import { corruptJobJournal, type JobJournalRecord } from "../../job-run-contracts.js";
import type { KeyedMap, KeyedOrder, KeyedSet } from "../../job-run-state.js";
import { validateDataPlaneTicketIssueRequest } from "../../shared-protocol/data-plane-ticket-authority.js";
import type {
  JobChannelInteractions,
  JobChannelRelayAdoption,
} from "../contracts.js";

export interface JobTicketMutableStateSlice {
  readonly ticketsById: KeyedMap<string, DataPlaneTicket>;
  readonly ticketIdsByAssignment: KeyedMap<string, Set<string>>;
  readonly ticketReplacementsById: KeyedMap<string, string>;
  readonly revokedTickets: KeyedSet<string>;
  ticketSyncFrontier: string | undefined;
  readonly ticketExpiry: KeyedOrder<string>;
}

export interface JobTicketRangeReadSlice {
  readonly ticketsById: Pick<KeyedMap<string, DataPlaneTicket>, "get">;
  readonly ticketExpiry: Pick<KeyedOrder<string>, "range">;
}

export interface JobGrantPendingReadSlice {
  readonly channelInteractions: JobChannelInteractions;
  readonly interactionMirrors: Pick<
    KeyedMap<
      string,
      {
        readonly outcomes: ReadonlyMap<
          string,
          InteractionAnswerMirrorEntry["outcome"]
        >;
      }
    >,
    "get"
  >;
}

export interface JobMirrorClosedReadSlice {
  readonly assignedById: Pick<
    ReadonlyMap<string, { readonly record: { readonly jobRunId: string } }>,
    "get"
  >;
  readonly states: Pick<
    ReadonlyMap<string, { readonly state: string }>,
    "get"
  >;
  readonly assignmentByJob: Pick<ReadonlyMap<string, string>, "get">;
  readonly cancelFences: Pick<ReadonlyMap<string, unknown>, "has">;
  readonly interactionSettlementFences: Pick<ReadonlyMap<string, unknown>, "has">;
  readonly completedInteractionSettlements: Pick<
    ReadonlyMap<string, unknown>,
    "has"
  >;
}

export const validateJobTicketIssueRequest = validateDataPlaneTicketIssueRequest;

export async function applyJobTicketRecord(input: {
  readonly state: JobTicketMutableStateSlice;
  readonly record: Extract<
    JobJournalRecord,
    { t: "ticket-issued" | "ticket-revoked" }
  >;
  readonly verifier: ProtocolSignatureVerifier;
  readonly envelopeAt: string;
  readonly taskId: string;
  readonly assigned?: Extract<JobJournalRecord, { t: "assigned" }>;
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
      throw corruptJobJournal("Ticket revocation names an unknown ticket");
    }
    if (state.revokedTickets.has(record.ticketId)) {
      throw corruptJobJournal("Ticket is revoked more than once");
    }
    state.revokedTickets.add(record.ticketId);
    return;
  }
  const ticket = validateDataPlaneTicket(record.ticket, input.verifier);
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
    ticket.ref.execution !== "job" ||
    ticket.ref.jobRunId !== assigned.jobRunId ||
    ticket.ref.taskId !== input.taskId ||
    ticket.ref.anchorEpoch !== assigned.anchorEpoch ||
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
    throw corruptJobJournal(
      "Issued ticket does not bind an active acknowledged assignment",
    );
  }
  if (
    ticket.kind !== "run-observe" &&
    ticket.surfacePrincipal !== input.originalSurfacePrincipal
  ) {
    throw corruptJobJournal(
      "Interactive ticket does not bind the original surface",
    );
  }
  state.ticketsById.set(ticket.ticketId, ticket);
  if (record.replacesTicketId !== undefined) {
    state.ticketReplacementsById.set(ticket.ticketId, record.replacesTicketId);
  }
  const byAssignment =
    state.ticketIdsByAssignment.get(ticket.assignmentId) ?? new Set<string>();
  byAssignment.add(ticket.ticketId);
  state.ticketIdsByAssignment.set(ticket.assignmentId, byAssignment);
  state.ticketExpiry.add(dataPlaneTicketSyncBoundary(ticket), ticket.ticketId);
}

export function applyJobTicketSyncFrontier(
  state: Pick<
    JobTicketMutableStateSlice,
    "ticketsById" | "ticketSyncFrontier" | "ticketExpiry"
  >,
  expiresThrough: string,
  envelopeAt: string,
): void {
  const passed = ticketsBetween(state, state.ticketSyncFrontier, envelopeAt);
  const expected = nextDataPlaneTicketSyncFrontier(
    passed.map((row) => row.ticket),
    state.ticketSyncFrontier,
    envelopeAt,
  );
  if (expected !== expiresThrough) {
    throw corruptJobJournal(
      "Ticket sync frontier is not the next durable boundary",
    );
  }
  state.ticketSyncFrontier = expiresThrough;
  for (const row of passed) {
    if (row.sortKey <= expiresThrough) {
      state.ticketExpiry.remove(row.sortKey, row.ticket.ticketId);
    }
  }
}

export function ticketsBetween(
  state: JobTicketRangeReadSlice,
  after: string | undefined,
  through: string | undefined,
): { readonly sortKey: string; readonly ticket: DataPlaneTicket }[] {
  return state.ticketExpiry
    .range({
      ...(after ? { after } : {}),
      ...(through ? { through } : {}),
    })
    .map((row) => {
      const ticket = state.ticketsById.get(row.subject);
      if (!ticket) {
        throw corruptJobJournal("Ticket expiry index names an unknown ticket");
      }
      return { sortKey: row.sortKey, ticket };
    });
}

export function jobMirrorClosed(
  state: JobMirrorClosedReadSlice,
  assignmentId: string,
  closedBySet = false,
): boolean {
  const assigned = state.assignedById.get(assignmentId);
  if (!assigned) return true;
  if (
    !state.completedInteractionSettlements.has(assignmentId) &&
    state.interactionSettlementFences.has(assignmentId)
  ) {
    return false;
  }
  if (
    closedBySet ||
    state.assignmentByJob.get(assigned.record.jobRunId) !== assignmentId
  ) {
    return true;
  }
  const current = state.states.get(assigned.record.jobRunId)?.state;
  return (
    current !== "dispatched" &&
    current !== "running" &&
    !(
      (current === "cancel-requested" || current === "uncertain") &&
      state.cancelFences.has(assignmentId)
    )
  );
}

export function jobGrantPending(
  state: JobGrantPendingReadSlice,
  challengeId: string,
): boolean {
  const granted = state.channelInteractions.grantByChallenge.get(challengeId);
  if (!granted || granted.grant.ref.execution !== "job") return false;
  const outcome = state.interactionMirrors
    .get(granted.grant.assignmentId)
    ?.outcomes.get(granted.grant.interactionRequestId);
  if (!outcome) return true;
  if (outcome.t !== "answered") return false;
  if (
    outcome.authority.via !== "channel-grant" ||
    canonicalize(outcome.authority.grant) !== canonicalize(granted.grant)
  ) {
    throw corruptJobJournal(
      "Mirrored job answer conflicts with its durable channel grant",
    );
  }
  return false;
}

export function relayAdoptionAtCursor(
  state: JobChannelInteractions,
  assignmentId: string,
  frame: StreamFrame,
  checkpoint: StreamVerifierCheckpoint,
): JobChannelRelayAdoption {
  if (frame.payload.kind !== "interaction") {
    return { checkpoint: structuredClone(checkpoint) };
  }
  const challengeId = state.challengeByInteraction.get(
    `${assignmentId}\u0000${frame.payload.event.requestId}`,
  );
  if (!challengeId) {
    return { checkpoint: structuredClone(checkpoint) };
  }
  const prepared = state.preparedByChallenge.get(challengeId);
  const closed = state.closedByChallenge.get(challengeId);
  const jobPrepared =
    prepared?.ref.execution === "job"
      ? (prepared as JobChannelChallengePreparedRecord)
      : undefined;
  return {
    checkpoint: structuredClone(checkpoint),
    ...(frame.payload.event.t === "requested" && jobPrepared
      ? { prepared: jobPrepared }
      : {}),
    ...(frame.payload.event.t === "finished" && closed ? { closed } : {}),
  };
}

export function channelRelayFinishedOutcome(
  outcome: InteractionAnswerMirrorEntry["outcome"],
): "allowed" | "denied" | "cancelled" | "expired" {
  switch (outcome.t) {
    case "answered":
      return outcome.decision.allowed ? "allowed" : "denied";
    case "auto-resolved":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
  }
}
