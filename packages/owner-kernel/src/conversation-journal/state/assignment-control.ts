import { Buffer } from "node:buffer";
import { resolveDispatchArtifactClosure } from "@zhixing-ai/core/authority";
import type {
  AssignmentTerminationProof,
  AuthorityCapability,
  CancelProofBody,
  ConversationInvocation,
  ConversationRunState,
  DataPlaneTicket,
  GovernorRecord,
  IngressContext,
  LogicalRecord,
  UncertainResolutionFact,
} from "@zhixing-ai/core/contracts";
import {
  assignmentActivationDigest,
  buildConversationActivationPayload,
  buildConversationActivationPayloadFromBinding,
  canonicalize,
  protocolDigest,
  queuedTerminalDequeueRecord,
  requiresFormalResourceCoordination,
  validateConversationEnvelope,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import type { ConversationBaseLocation } from "../../conversation-base-source.js";
import { abortTicketProofBindsOwnerHistory } from "../../data-plane-ticket-proof.js";
import {
  assertAssignmentReplayContract,
  assertAssignmentSupersededReplayContract,
  assertCancelFenceReplayContract,
  assertCancelProofAcceptedReplayContract,
  assertCapabilityRevocationReplayContract,
  assertConversationResolutionBinding,
  assertDispatchAcknowledgementReplayContract,
  assertDispatchConflictHandlingReplayContract,
  assertDispatchConflictReplayContract,
  assertResolutionCloseAtomicReplayContract,
  assertResolutionClosureReplayContract,
  assertResolutionOpenReplayContract,
  assertSupersedeRequestReplayContract,
  assertSupersedeStartedObservationReplayContract,
  assignmentTerminationProofKind,
  corruptRunJournal,
  isOpenResolutionFact,
  nextActiveRunIdForReplay,
  resolutionFactDigest,
  resolutionTargetState,
  terminationProofBindsDurableSource,
  type AssignmentTerminationProofKind,
  type ConversationRunJournalRecord,
  type ConversationRunRecord,
  type DurableSourceBoundProof,
} from "../../conversation-run-contracts.js";
import {
  projectStatusEntry,
  type StatusHistoryEntry,
} from "../../conversation-status-projection.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import {
  assertAssignedMatchesDispatch,
  dispatchConflictKey,
  rejectedNotStartedKey,
  type AssignedProjection,
  type ConversationUncertainResolutionFact,
  type ConversationAbortTicketAuthorizer,
  type ConversationCancelRequest,
  type ConversationCancelResult,
  type ConversationCommitLogRecord,
  type ConversationFactGroup,
  type ConversationRunControlDescriptor,
  type ConversationRunReductionContext,
  type PendingConversationDispatch,
  type RetainedConversationEnvelope,
} from "../contracts.js";
import type { TicketReadonlyContext } from "./channel-tickets.js";
import {
  runRecord,
  runStream,
  snapshot,
  withoutSignature,
  type DeepReadonly,
} from "./common.js";

export type { ConversationCancelRequest, ConversationCancelResult };

export interface AssignmentControlMutableSlice {
  activeRunId?: string;
  readonly assignedById: Map<string, AssignedProjection>;
  readonly assignmentByRun: Map<string, string>;
  readonly assignmentAttemptByRun?: Map<string, number>;
  readonly stateByRun: Map<
    string,
    { readonly state: ConversationRunState; readonly statusRevision: number }
  >;
  readonly recoveryAssignments: Set<string>;
  readonly conflicts: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "dispatch-conflict" }>
  >;
  readonly conflictByAssignment: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "dispatch-conflict" }>
  >;
  readonly containedFacts: Set<string>;
  readonly containmentByAssignment: Map<
    string,
    | Extract<ConversationRunJournalRecord, { t: "dispatch-conflict-contained" }>
    | Extract<ConversationRunJournalRecord, { t: "cancel-contained" }>
  >;
  readonly superseded: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "assignment-superseded" }>
  >;
  readonly supersedeRequests: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "supersede-requested" }>
  >;
  readonly supersedeStartedObservations: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "supersede-started-observed" }>
  >;
  readonly cancelFences: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "cancel-fence" }>
  >;
  readonly cancelOrigins: Map<string, "dispatched" | "running">;
  readonly acceptedCancellations: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "cancel-proof-accepted" }>
  >;
  readonly rejectedNotStarted: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "not-started-rejected" }>
  >;
  readonly uncertainOrigins: Map<
    string,
    "dispatched" | "running" | "cancel-requested"
  >;
  readonly revokedCapabilities: Set<string>;
  readonly resolutionsByRun: Map<string, ConversationUncertainResolutionFact>;
  readonly statusHistoryByRun: Map<string, StatusHistoryEntry[]>;
  readonly closedAssignments: Set<string>;
}

export interface GuardAssignedEntry {
  readonly record: Extract<ConversationRunJournalRecord, { t: "assigned" }>;
  readonly origin?: ConversationBaseLocation;
  readonly commit?: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
  readonly capIds: ReadonlySet<string>;
  acked: boolean;
}

export interface GuardAssignmentControlMutableSlice {
  activeRunId: string | undefined;
  readonly assignmentAttemptByRun?: Map<string, number>;
  readonly assignedById: Map<string, GuardAssignedEntry>;
  readonly assignmentByRun: Map<string, string>;
  readonly stateByRun: Map<
    string,
    { readonly state: ConversationRunState; readonly statusRevision: number }
  >;
  readonly conflictAssignments: Set<string>;
  readonly openConflictAssignments: Set<string>;
  readonly supersedeRequests: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "supersede-requested" }>
  >;
  readonly supersedeStartedAssignments: Set<string>;
  readonly cancelFences: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "cancel-fence" }>
  >;
  readonly acceptedCancellations: Set<string>;
  readonly durableStartedAssignments: Set<string>;
  readonly resolutionsByRun: Map<string, ConversationUncertainResolutionFact>;
  readonly closedAssignments: Set<string>;
  readonly revokedCapabilities: Set<string>;
}

export function hasAssignmentControlDurableStarted(
  state: Pick<
    AssignmentControlMutableSlice,
    | "assignedById"
    | "assignmentByRun"
    | "stateByRun"
    | "cancelOrigins"
    | "uncertainOrigins"
    | "supersedeStartedObservations"
  >,
  assignmentId: string,
): boolean {
  const assigned = state.assignedById.get(assignmentId);
  const current =
    assigned && state.assignmentByRun.get(assigned.record.runId) === assignmentId
      ? state.stateByRun.get(assigned.record.runId)?.state
      : undefined;
  return (
    current === "running" ||
    state.cancelOrigins.get(assignmentId) === "running" ||
    state.uncertainOrigins.get(assignmentId) === "running" ||
    state.supersedeStartedObservations.has(assignmentId)
  );
}

export function clearRecoveryAssignment(
  state: Pick<AssignmentControlMutableSlice, "recoveryAssignments">,
  assignmentId: string,
): void {
  state.recoveryAssignments.delete(assignmentId);
}

export function compactAssignedEnvelopePayload(
  state: Pick<AssignmentControlMutableSlice, "assignedById">,
  assignmentId: string,
): void {
  const assigned = state.assignedById.get(assignmentId);
  if (!assigned) return;
  state.assignedById.set(assignmentId, {
    ...assigned,
    envelope: retainedConversationEnvelope(requireAssignedEnvelope(assigned)),
  });
}

export function retainedConversationEnvelope(
  envelope: RetainedConversationEnvelope,
): RetainedConversationEnvelope {
  if (!Object.hasOwn(envelope.work, "windowInput")) return envelope;
  const { windowInput: _windowInput, ...work } =
    envelope.work as PendingConversationDispatch["envelope"]["work"];
  return { ...envelope, work };
}

export function requireAssignedEnvelope(assigned: {
  readonly envelope?: DeepReadonly<RetainedConversationEnvelope> | RetainedConversationEnvelope;
}): RetainedConversationEnvelope {
  if (!assigned.envelope) {
    throw corruptRunJournal("Active assignment envelope was not prepared");
  }
  return assigned.envelope as RetainedConversationEnvelope;
}

export function requireLocalAssignedCommit(assigned: {
  readonly commit?: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
}) {
  if (!assigned.commit) {
    throw corruptRunJournal(
      "Imported historical assignment cannot obtain a local activation",
    );
  }
  return assigned.commit;
}

export function cancellableRunDescriptors(input: {
  readonly state: Pick<
    AssignmentControlMutableSlice,
    "activeRunId" | "stateByRun"
  >;
  readonly queuedRunIds: readonly string[];
  readonly getAdmittedDescriptorMeta: (
    runId: string,
  ) =>
    | {
        readonly source: ConversationInvocation["source"];
        readonly ingressId: string;
      }
    | undefined;
}): ConversationRunControlDescriptor[] {
  const { state } = input;
  const runs: ConversationRunControlDescriptor[] = input.queuedRunIds.map(
    (runId) => {
      const current = state.stateByRun.get(runId)?.state;
      const meta = input.getAdmittedDescriptorMeta(runId);
      if (current !== "queued" || !meta) {
        throw corruptRunJournal("Queued cancellation projection is inconsistent");
      }
      return {
        runId,
        state: current,
        source: meta.source,
        ingressId: meta.ingressId,
      };
    },
  );
  if (state.activeRunId !== undefined) {
    const current = state.stateByRun.get(state.activeRunId)?.state;
    const meta = input.getAdmittedDescriptorMeta(state.activeRunId);
    if (
      meta &&
      (current === "dispatched" ||
        current === "running" ||
        current === "cancel-requested")
    ) {
      runs.unshift({
        runId: state.activeRunId,
        state: current,
        source: meta.source,
        ingressId: meta.ingressId,
      });
    }
  }
  return runs;
}

export function capabilityRevocations(
  conversationId: string,
  revokedCapabilities: ReadonlySet<string>,
  tickets: Pick<TicketReadonlyContext, "ticketIdsByAssignment" | "revokedTickets">,
  assigned: {
    readonly record: {
      readonly assignmentId: string;
      readonly capIds: readonly string[];
    };
  },
): LogicalRecord<ConversationCommitLogRecord>[] {
  const capabilities = assigned.record.capIds
    .filter(
      (capId) =>
        !revokedCapabilities.has(
          `${assigned.record.assignmentId}\0${capId}`,
        ),
    )
    .map((capId) =>
      runRecord(conversationId, {
        t: "capability-revoked",
        capId,
        assignmentId: assigned.record.assignmentId,
      }),
    );
  const ticketRecords = [
    ...(tickets.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? []),
  ]
    .filter((ticketId) => !tickets.revokedTickets.has(ticketId))
    .map((ticketId) =>
      runRecord(conversationId, {
        t: "ticket-revoked" as const,
        ticketId,
      }),
    );
  return [...capabilities, ...ticketRecords];
}

export function proofBindsConversationSource(
  state: Pick<
    AssignmentControlMutableSlice,
    "supersedeRequests" | "cancelFences"
  >,
  tickets: Pick<TicketReadonlyContext, "ticketIdsByAssignment" | "ticketsById">,
  assigned: {
    readonly record: DeepReadonly<
      Extract<ConversationRunJournalRecord, { t: "assigned" }>
    >;
  },
  proof: DurableSourceBoundProof,
  conversationId: string,
  legacy: ConversationAbortTicketAuthorizer | undefined,
): boolean {
  const assignmentId = assigned.record.assignmentId;
  const abortTicketProofBindsDurableSource =
    "cause" in proof && proof.cause === "abort-ticket"
      ? abortTicketProofBindsOwnerHistory({
          assignmentId,
          ticketIds:
            tickets.ticketIdsByAssignment.get(assignmentId) ?? new Set<string>(),
          ticketsById: tickets.ticketsById as ReadonlyMap<string, DataPlaneTicket>,
          proof,
          ...(legacy ? { legacy } : {}),
        })
      : false;
  return terminationProofBindsDurableSource({
    proof,
    assignmentId,
    executorId: assigned.record.executorId,
    conversationId,
    ownerEpoch: assigned.record.ownerEpoch,
    dispatchDigest: assigned.record.dispatchDigest,
    supersedeRequest: state.supersedeRequests.get(assignmentId),
    cancelFence: state.cancelFences.get(assignmentId),
    abortTicketProofBindsDurableSource,
  });
}

export function createOpenResolutionFact(
  assigned: {
    readonly record: {
      readonly runId: string;
      readonly assignmentId: string;
    };
    readonly envelope?: DeepReadonly<RetainedConversationEnvelope> | RetainedConversationEnvelope;
  },
  cause: ConversationUncertainResolutionFact["cause"],
  openedAt: string,
): ConversationUncertainResolutionFact {
  const envelope = requireAssignedEnvelope(assigned);
  const subject = {
    execution: "conversation" as const,
    runId: assigned.record.runId,
    conversationId: envelope.work.conversationId,
    ownerEpoch: envelope.work.ownerEpoch,
    assignmentId: assigned.record.assignmentId,
  };
  const openFactDigest = protocolDigest("UncertainOpenFact", 1, {
    subject,
    openedAt,
    cause,
  });
  return { subject, openedAt, cause, openFactDigest };
}

export function closeResolution(
  fact: DeepReadonly<ConversationUncertainResolutionFact> | ConversationUncertainResolutionFact,
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
  by: string,
  at: string,
): ConversationUncertainResolutionFact {
  return snapshot(
    {
      ...(fact as ConversationUncertainResolutionFact),
      resolution: {
        kind,
        by,
        at,
        factDigest: resolutionFactDigest(fact.openFactDigest, kind, by, at),
      },
    },
    "Uncertain resolution fact",
  );
}

export function hasRejectedNotStarted(
  state: Pick<AssignmentControlMutableSlice, "rejectedNotStarted">,
  assignmentId: string,
  kind: AssignmentTerminationProofKind,
): boolean {
  return state.rejectedNotStarted.has(rejectedNotStartedKey(assignmentId, kind));
}

export function sameTerminationProof(
  left: DurableSourceBoundProof,
  right: DurableSourceBoundProof,
): boolean {
  return (
    canonicalize(withoutSignature(left)) === canonicalize(withoutSignature(right))
  );
}

export function nextConversationAssignmentAttempt(
  state: {
    readonly assignmentAttemptByRun?: ReadonlyMap<string, number>;
    readonly assignedById: ReadonlyMap<
      string,
      {
        readonly record: {
          readonly runId: string;
          readonly reservation: { readonly attempt: number };
        };
      }
    >;
  },
  runId: string,
): number {
  let latest = state.assignmentAttemptByRun?.get(runId) ?? 0;
  for (const assigned of state.assignedById.values()) {
    if (assigned.record.runId === runId) {
      latest = Math.max(latest, assigned.record.reservation.attempt);
    }
  }
  if (latest >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Conversation assignment attempt is exhausted");
  }
  return latest + 1;
}

export function prepareRunQueuedTerminal(
  coordinator: AssignmentResourceCoordinator | undefined,
  state: {
    readonly assignmentAttemptByRun?: ReadonlyMap<string, number>;
    readonly assignedById: ReadonlyMap<
      string,
      {
        readonly record: {
          readonly runId: string;
          readonly reservation: { readonly attempt: number };
        };
      }
    >;
  },
  runId: string,
  reason: "cancelled" | "failed" | "expired",
): readonly LogicalRecord<GovernorRecord>[] {
  return (
    coordinator?.prepareQueuedTerminal({
      workload: {
        kind: "run",
        id: runId,
        attempt: nextConversationAssignmentAttempt(state, runId),
      },
      reason,
    }) ?? [
      queuedTerminalDequeueRecord(
        {
          kind: "run",
          id: runId,
          attempt: nextConversationAssignmentAttempt(state, runId),
        },
        reason,
      ),
    ]
  );
}

export function assertCapabilityMatchesAssignedEnvelope(
  capability: AuthorityCapability,
  envelope: {
    readonly capabilities: readonly DeepReadonly<AuthorityCapability>[] | readonly AuthorityCapability[];
  },
): void {
  const assigned = envelope.capabilities.find(
    (candidate) => candidate.capId === capability.capId,
  );
  if (!assigned || canonicalize(assigned) !== canonicalize(capability)) {
    throw new TypeError(
      "Assignment capability does not match the durable dispatch capability",
    );
  }
}

export function isActiveRunState(state: ConversationRunState): boolean {
  return (
    state === "dispatched" ||
    state === "running" ||
    state === "cancel-requested" ||
    state === "uncertain"
  );
}

export function selectActiveAssignment<Assigned, Value>(
  state: {
    readonly activeRunId?: string;
    readonly stateByRun: ReadonlyMap<string, { readonly state: ConversationRunState }>;
    readonly assignmentByRun: ReadonlyMap<string, string>;
    readonly assignedById: ReadonlyMap<string, Assigned>;
  },
  select: (assigned: Assigned, current: ConversationRunState) => Value | undefined,
): Value | undefined {
  const runId = state.activeRunId;
  if (runId === undefined) return undefined;
  const current = state.stateByRun.get(runId)?.state;
  const assignmentId = state.assignmentByRun.get(runId);
  const assigned = assignmentId ? state.assignedById.get(assignmentId) : undefined;
  if (!current || !isActiveRunState(current) || !assigned) {
    throw corruptRunJournal("Active run index has no durable assignment state");
  }
  return select(assigned, current);
}

export function envelopeHasRunRecord(
  envelope: ConversationFactGroup,
  conversationId: string,
  predicate: (body: ConversationRunRecord) => boolean,
): boolean {
  return envelope.entries.some((entry) => {
    if (entry.stream !== runStream(conversationId)) return false;
    const body = entry.body as ConversationRunJournalRecord;
    return (
      typeof body === "object" &&
      body !== null &&
      "t" in body &&
      predicate(body as ConversationRunRecord)
    );
  });
}

export function conversationResolutionFactsInEnvelope(
  envelope: ConversationFactGroup,
  conversationId: string,
  runId: string,
): ConversationUncertainResolutionFact[] {
  return envelope.entries.flatMap((entry) => {
    if (entry.stream !== runStream(conversationId)) return [];
    const body = entry.body as ConversationRunJournalRecord;
    return "t" in body && body.t === "resolution" && body.runId === runId
      ? [body.fact as ConversationUncertainResolutionFact]
      : [];
  });
}

export function envelopeHasRunState(
  envelope: ConversationFactGroup,
  conversationId: string,
  runId: string,
  state: ConversationRunState,
  statusRevision: number,
  assignmentId: string | undefined,
): boolean {
  return envelopeHasRunRecord(
    envelope,
    conversationId,
    (body) =>
      body.t === "state" &&
      body.runId === runId &&
      body.assignmentId === assignmentId &&
      body.state === state &&
      body.statusRevision === statusRevision,
  );
}

export function envelopeClosesAssignment(
  envelope: ConversationFactGroup,
  conversationId: string,
  runId: string,
  assignmentId: string,
): boolean {
  return envelopeHasRunRecord(
    envelope,
    conversationId,
    (body) =>
      (body.t === "assignment-superseded" &&
        body.assignmentId === assignmentId) ||
      (body.t === "resolution" &&
        body.runId === runId &&
        body.fact.subject.assignmentId === assignmentId &&
        body.fact.resolution !== undefined),
  );
}

export function envelopeHasResolution(
  envelope: ConversationFactGroup,
  conversationId: string,
  runId: string,
  openFactDigest: string,
  resolved: boolean,
): boolean {
  return envelopeHasRunRecord(
    envelope,
    conversationId,
    (body) =>
      body.t === "resolution" &&
      body.runId === runId &&
      body.fact.openFactDigest === openFactDigest &&
      (body.fact.resolution !== undefined) === resolved,
  );
}

export function envelopeRevokesCapabilities(
  envelope: ConversationFactGroup,
  conversationId: string,
  revokedCapabilities: ReadonlySet<string>,
  assignmentId: string,
  capIds: Iterable<string>,
  ticketIds: Iterable<string> = [],
  revokedTickets: ReadonlySet<string> = new Set(),
): boolean {
  const capabilitiesRevoked = [...capIds].every((capId) => {
    const key = `${assignmentId}\0${capId}`;
    return (
      revokedCapabilities.has(key) ||
      envelopeHasRunRecord(
        envelope,
        conversationId,
        (body) =>
          body.t === "capability-revoked" &&
          body.assignmentId === assignmentId &&
          body.capId === capId,
      )
    );
  });
  return (
    capabilitiesRevoked &&
    [...ticketIds].every(
      (ticketId) =>
        revokedTickets.has(ticketId) ||
        envelopeHasRunRecord(
          envelope,
          conversationId,
          (body) =>
            body.t === "ticket-revoked" && body.ticketId === ticketId,
        ),
    )
  );
}

export function envelopeRevokesRemainingCapabilities(
  envelope: ConversationFactGroup,
  conversationId: string,
  revokedCapabilities: ReadonlySet<string>,
  tickets: Pick<TicketReadonlyContext, "ticketIdsByAssignment" | "revokedTickets">,
  assigned: {
    readonly record: {
      readonly assignmentId: string;
      readonly capIds: readonly string[];
    };
  },
): boolean {
  return envelopeRevokesCapabilities(
    envelope,
    conversationId,
    revokedCapabilities,
    assigned.record.assignmentId,
    assigned.record.capIds,
    tickets.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? [],
    tickets.revokedTickets,
  );
}

export function envelopeHasSuccessfulUncertainControl(
  envelope: ConversationFactGroup,
  state: ConversationRunState,
  factDigest: string,
  authorityRevision: number,
): boolean {
  return envelope.entries.some((entry) => {
    if (
      entry.stream !== "control" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const applied = entry.body as {
      readonly t?: unknown;
      readonly authorityRevision?: unknown;
      readonly result?: unknown;
    };
    if (
      applied.t !== "applied" ||
      applied.authorityRevision !== authorityRevision ||
      typeof applied.result !== "object" ||
      applied.result === null
    ) {
      return false;
    }
    const result = applied.result as {
      readonly v?: unknown;
      readonly status?: unknown;
      readonly body?: unknown;
    };
    if (
      result.v !== 1 ||
      result.status !== "ok" ||
      typeof result.body !== "object" ||
      result.body === null
    ) {
      return false;
    }
    const body = result.body as {
      readonly t?: unknown;
      readonly state?: unknown;
      readonly factDigest?: unknown;
    };
    return (
      body.t === "uncertain-resolve" &&
      body.state === state &&
      body.factDigest === factDigest
    );
  });
}

export function reduceConversationContainment(input: {
  readonly state: AssignmentControlMutableSlice;
  readonly tickets: TicketReadonlyContext;
  readonly body: Extract<
    ConversationRunJournalRecord,
    { t: "dispatch-conflict-contained" | "cancel-contained" | "not-started-rejected" }
  >;
  readonly envelope: ConversationFactGroup;
  readonly conversationId: string;
  readonly legacyTickets?: ConversationAbortTicketAuthorizer;
}): void {
  const { state, tickets, body, envelope, conversationId, legacyTickets } = input;
  switch (body.t) {
    case "dispatch-conflict-contained": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const open = assigned
        ? state.resolutionsByRun.get(assigned.record.runId)
        : undefined;
      const conflict = state.conflictByAssignment.get(body.assignmentId);
      const cancelProof = "cause" in proof ? proof : undefined;
      const supersedeProof =
        "decision" in proof && proof.decision === "not-started-fenced"
          ? proof
          : undefined;
      const terminatesForRedispatch =
        cancelProof?.decision === "not-started" || supersedeProof !== undefined;
      if (
        !assigned ||
        current?.state !== "uncertain" ||
        state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
        !open ||
        open.resolution !== undefined ||
        open.cause !== "dispatch-conflict" ||
        open.openFactDigest !== body.openFactDigest ||
        state.containedFacts.has(body.openFactDigest) ||
        !conflict ||
        (!cancelProof && !supersedeProof) ||
        !proofBindsConversationSource(
          state,
          tickets,
          assigned,
          proof,
          conversationId,
          legacyTickets,
        ) ||
        (terminatesForRedispatch &&
          (!envelopeHasResolution(
            envelope,
            conversationId,
            assigned.record.runId,
            open.openFactDigest,
            true,
          ) ||
            !envelopeHasRunState(
              envelope,
              conversationId,
              assigned.record.runId,
              "queued",
              current.statusRevision + 1,
              body.assignmentId,
            ) ||
            !envelopeHasRunRecord(
              envelope,
              conversationId,
              (candidate) =>
                candidate.t === "assignment-superseded" &&
                candidate.assignmentId === body.assignmentId &&
                sameTerminationProof(
                  candidate.proof,
                  proof as AssignmentTerminationProof,
                ),
            ))) ||
        proof.lastRecordSeq <= conflict.proof.receivedRecordSeq
      ) {
        throw corruptRunJournal(
          "Dispatch conflict containment is invalid or duplicated",
        );
      }
      state.containedFacts.add(body.openFactDigest);
      state.containmentByAssignment.set(body.assignmentId, body);
      state.recoveryAssignments.delete(body.assignmentId);
      return;
    }
    case "cancel-contained": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const open = assigned
        ? state.resolutionsByRun.get(assigned.record.runId)
        : undefined;
      if (
        !assigned ||
        current?.state !== "uncertain" ||
        state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
        !open ||
        open.resolution !== undefined ||
        open.cause === "dispatch-conflict" ||
        open.openFactDigest !== body.openFactDigest ||
        state.containedFacts.has(body.openFactDigest) ||
        proof.decision !== "halted" ||
        !proofBindsConversationSource(
          state,
          tickets,
          assigned,
          proof,
          conversationId,
          legacyTickets,
        )
      ) {
        throw corruptRunJournal(
          "Cancellation containment is invalid or duplicated",
        );
      }
      state.containedFacts.add(body.openFactDigest);
      state.containmentByAssignment.set(body.assignmentId, body);
      state.recoveryAssignments.delete(body.assignmentId);
      return;
    }
    case "not-started-rejected": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const kind = assignmentTerminationProofKind(proof);
      const open = assigned
        ? state.resolutionsByRun.get(assigned.record.runId)
        : undefined;
      const contradictory =
        hasAssignmentControlDurableStarted(state, body.assignmentId) ||
        (kind === "dispatch-rejection" && open?.cause === "dispatch-conflict");
      const proofBindsSource =
        assigned !== undefined &&
        proofBindsConversationSource(
          state,
          tickets,
          assigned,
          proof,
          conversationId,
          legacyTickets,
        );
      const rejectionKey = rejectedNotStartedKey(body.assignmentId, kind);
      if (
        !assigned ||
        state.assignmentByRun.get(assigned.record.runId) !== body.assignmentId ||
        !proofBindsSource ||
        !contradictory ||
        (current?.state !== "uncertain" &&
          (!current ||
            !envelopeHasRunRecord(
              envelope,
              conversationId,
              (candidate) =>
                candidate.t === "resolution" &&
                candidate.runId === assigned.record.runId &&
                candidate.fact.subject.execution === "conversation" &&
                candidate.fact.subject.assignmentId === body.assignmentId &&
                candidate.fact.cause ===
                  (kind === "cancel" ? "cancel-unproven" : "ledger-unknown") &&
                candidate.fact.resolution === undefined,
            ) ||
            !envelopeHasRunState(
              envelope,
              conversationId,
              assigned.record.runId,
              "uncertain",
              current.statusRevision + 1,
              body.assignmentId,
            ) ||
            !envelopeRevokesRemainingCapabilities(
              envelope,
              conversationId,
              state.revokedCapabilities,
              tickets,
              assigned,
            ))) ||
        state.rejectedNotStarted.has(rejectionKey)
      ) {
        throw corruptRunJournal(
          "Rejected not-started proof is invalid or duplicated",
        );
      }
      state.rejectedNotStarted.set(rejectionKey, body);
      return;
    }
  }
}

export interface AssignmentControlRunCrossFacts {
  readonly tickets: TicketReadonlyContext;
  readonly admittedForAssign?: {
    readonly ingress: IngressContext;
    readonly isEarliestQueued: boolean;
  };
}

export async function reduceAssignmentControlRunRecord(input: {
  readonly context: ConversationRunReductionContext;
  readonly state: AssignmentControlMutableSlice;
  readonly crossFacts: AssignmentControlRunCrossFacts;
  readonly body: Extract<
    ConversationRunJournalRecord,
    {
      t:
        | "assigned"
        | "dispatch-acked"
        | "supersede-requested"
        | "supersede-started-observed"
        | "dispatch-conflict"
        | "dispatch-conflict-contained"
        | "cancel-contained"
        | "cancel-proof-accepted"
        | "not-started-rejected"
        | "assignment-superseded"
        | "cancel-fence"
        | "capability-revoked"
        | "resolution";
    }
  >;
  readonly envelope: ConversationFactGroup & {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
  readonly verify: (check: () => void) => Promise<void>;
  readonly legacyTickets?: ConversationAbortTicketAuthorizer;
}): Promise<void> {
  const { context, state, crossFacts, body, envelope, verify, legacyTickets } =
    input;
  const { tickets } = crossFacts;
  switch (body.t) {
    case "assigned": {
      const admitted = crossFacts.admittedForAssign;
      const current = state.stateByRun.get(body.runId);
      assertAssignmentReplayContract({
        currentState: current?.state,
        currentRevision: current?.statusRevision,
        runAlreadyAssigned: state.assignmentByRun.has(body.runId),
        assignmentAlreadyKnown: state.assignedById.has(body.assignmentId),
        isEarliestQueuedRun:
          admitted !== undefined && admitted.isEarliestQueued,
        hasAtomicDispatchedState:
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            context.conversationId,
            body.runId,
            "dispatched",
            current.statusRevision + 1,
            body.assignmentId,
          ),
      });
      if (!admitted) {
        throw corruptRunJournal("Run assignment is not the earliest admitted run");
      }
      const bytes = await context.artifacts.get(body.dispatchRef);
      const dispatch = await verifyProtocolStep(() =>
        validateConversationEnvelope(
          JSON.parse(
            Buffer.from(bytes).toString("utf8"),
          ) as PendingConversationDispatch["envelope"],
          context.verifier,
        ),
      );
      await resolveDispatchArtifactClosure(dispatch, context.artifacts);
      assertAssignedMatchesDispatch(
        body,
        dispatch,
        admitted.ingress,
        context.conversationId,
      );
      if (requiresFormalResourceCoordination(dispatch.resourceLease)) {
        const resources = context.resources;
        if (!resources) {
          throw corruptRunJournal("Anchor assignment has no resource coordinator");
        }
        const resourceLease = dispatch.resourceLease;
        const envelopeEntries = envelope.entries;
        const acceptedAt = envelope.at;
        await verify(() => {
          resources.assertActivationRecords({
            lease: resourceLease,
            records: envelopeEntries,
            acceptedAt,
          });
        });
      }
      state.assignedById.set(body.assignmentId, {
        record: body,
        envelope: dispatch,
        commit: {
          lsn: envelope.lsn,
          envelopeDigest: envelope.envelopeDigest,
          at: envelope.at,
        },
        acked: false,
      });
      state.assignmentByRun.set(body.runId, body.assignmentId);
      state.assignmentAttemptByRun?.set(
        body.runId,
        Math.max(
          state.assignmentAttemptByRun.get(body.runId) ?? 0,
          body.reservation.attempt,
        ),
      );
      state.recoveryAssignments.add(body.assignmentId);
      return;
    }
    case "dispatch-acked": {
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertDispatchAcknowledgementReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        alreadyAcknowledged: assigned?.acked ?? false,
        assignmentSuperseded: state.superseded.has(body.assignmentId),
        assignmentClosed: state.closedAssignments.has(body.assignmentId),
      });
      if (!assigned) {
        throw corruptRunJournal("Dispatch acknowledgement is missing or duplicated");
      }
      assigned.acked = true;
      return;
    }
    case "supersede-requested": {
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertSupersedeRequestReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        requestAlreadyExists: state.supersedeRequests.has(body.assignmentId),
        fenceSeq: body.fenceSeq,
        envelopeLsn: envelope.lsn,
      });
      state.supersedeRequests.set(body.assignmentId, body);
      return;
    }
    case "supersede-started-observed": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertSupersedeStartedObservationReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        proofBindsDurableSource:
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            tickets,
            assigned,
            proof,
            context.conversationId,
            legacyTickets,
          ),
        observationAlreadyExists: state.supersedeStartedObservations.has(
          body.assignmentId,
        ),
      });
      state.supersedeStartedObservations.set(body.assignmentId, body);
      return;
    }
    case "dispatch-conflict": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const key = dispatchConflictKey(proof);
      assertDispatchConflictReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        proofBindsAssignment:
          assigned !== undefined &&
          proof.assignmentId === body.assignmentId &&
          proof.executorId === assigned.record.executorId,
        handling: body.handling,
        assignmentAcknowledged: assigned?.acked ?? false,
        assignmentSuperseded: state.superseded.has(body.assignmentId),
        assignmentClosed: state.closedAssignments.has(body.assignmentId),
        conflictAlreadySeen: state.conflictByAssignment.has(body.assignmentId),
      });
      if (!assigned || !current || state.conflicts.has(key)) {
        throw corruptRunJournal("Dispatch conflict record is invalid or duplicated");
      }
      const expectedActivation = buildConversationActivationPayload({
        envelope: requireAssignedEnvelope(assigned),
        dispatchRef: assigned.record.dispatchRef,
        commit: {
          lsn: requireLocalAssignedCommit(assigned).lsn,
          envelopeDigest: requireLocalAssignedCommit(assigned).envelopeDigest,
        },
        issuedAt: requireLocalAssignedCommit(assigned).at,
      });
      const expectedActivationDigest =
        assignmentActivationDigest(expectedActivation);
      const acceptedMatches =
        canonicalize(proof.acceptedDispatchRef) ===
          canonicalize(assigned.record.dispatchRef) &&
        proof.acceptedActivationDigest === expectedActivationDigest;
      const conflictingMatches =
        canonicalize(proof.conflictingDispatchRef) ===
          canonicalize(assigned.record.dispatchRef) &&
        proof.conflictingActivationDigest === expectedActivationDigest;
      const atomicHandling =
        body.handling === "acked-original"
          ? envelopeHasRunRecord(
              envelope,
              context.conversationId,
              (candidate) =>
                candidate.t === "dispatch-acked" &&
                candidate.assignmentId === body.assignmentId,
            )
          : envelopeHasRunRecord(
              envelope,
              context.conversationId,
              (candidate) =>
                candidate.t === "resolution" &&
                candidate.runId === assigned.record.runId &&
                candidate.fact.subject.execution === "conversation" &&
                candidate.fact.subject.assignmentId === body.assignmentId &&
                candidate.fact.cause === "dispatch-conflict" &&
                candidate.fact.resolution === undefined,
            ) &&
            envelopeHasRunRecord(
              envelope,
              context.conversationId,
              (candidate) =>
                candidate.t === "cancel-fence" &&
                candidate.assignmentId === body.assignmentId,
            ) &&
            envelopeHasRunState(
              envelope,
              context.conversationId,
              assigned.record.runId,
              "uncertain",
              current.statusRevision + 1,
              body.assignmentId,
            ) &&
            envelopeRevokesRemainingCapabilities(
              envelope,
              context.conversationId,
              state.revokedCapabilities,
              tickets,
              assigned,
            );
      assertDispatchConflictHandlingReplayContract({
        handling: body.handling,
        acceptedMatches,
        conflictingMatches,
        atomicHandling,
      });
      state.conflicts.set(key, body);
      state.conflictByAssignment.set(body.assignmentId, body);
      return;
    }
    case "dispatch-conflict-contained":
    case "cancel-contained":
    case "not-started-rejected":
      reduceConversationContainment({
        state,
        tickets,
        body,
        envelope,
        conversationId: context.conversationId,
        legacyTickets,
      });
      return;
    case "cancel-proof-accepted": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertCancelProofAcceptedReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        acceptanceAlreadyExists: state.acceptedCancellations.has(
          body.assignmentId,
        ),
        durableStartedObserved: hasAssignmentControlDurableStarted(
          state,
          body.assignmentId,
        ),
        proofDecision: proof.decision,
        proofBindsDurableSource:
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            tickets,
            assigned,
            proof,
            context.conversationId,
            legacyTickets,
          ),
        hasAtomicCancelledState:
          assigned !== undefined &&
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            context.conversationId,
            assigned.record.runId,
            "cancelled",
            current.statusRevision + 1,
            body.assignmentId,
          ),
        allCapabilitiesRevoked:
          assigned !== undefined &&
          envelopeRevokesRemainingCapabilities(
            envelope,
            context.conversationId,
            state.revokedCapabilities,
            tickets,
            assigned,
          ),
      });
      if (!assigned) {
        throw corruptRunJournal("Accepted cancellation has no durable assignment");
      }
      const assignedRecord = assigned.record;
      const usageFinal = proof.usageFinal;
      const terminalMode =
        proof.decision === "not-started" ? "release" : "settle-release";
      const envelopeEntries = envelope.entries;
      await verify(() => {
        context.assertResourceUsageFinal(assignedRecord, usageFinal);
      });
      await verify(() => {
        context.assertResourceTerminalRecords(
          assignedRecord,
          terminalMode,
          envelopeEntries,
        );
      });
      state.acceptedCancellations.set(body.assignmentId, body);
      state.recoveryAssignments.delete(body.assignmentId);
      return;
    }
    case "assignment-superseded": {
      const assigned = state.assignedById.get(body.assignmentId);
      const proof = body.proof;
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const kind = assignmentTerminationProofKind(proof);
      const open = assigned
        ? state.resolutionsByRun.get(assigned.record.runId)
        : undefined;
      assertAssignmentSupersededReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        assignmentAlreadyClosed: state.superseded.has(body.assignmentId),
        currentState: current?.state,
        durableStartedObserved: hasAssignmentControlDurableStarted(
          state,
          body.assignmentId,
        ),
        proofBindsDurableSource:
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            tickets,
            assigned,
            proof,
            context.conversationId,
            legacyTickets,
          ),
        proofKind: kind,
        hasAtomicTargetState:
          assigned !== undefined &&
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            context.conversationId,
            assigned.record.runId,
            current.state === "cancel-requested" ? "cancelled" : "queued",
            current.statusRevision + 1,
            body.assignmentId,
          ),
        allCapabilitiesRevoked:
          assigned !== undefined &&
          envelopeRevokesRemainingCapabilities(
            envelope,
            context.conversationId,
            state.revokedCapabilities,
            tickets,
            assigned,
          ),
        hasAtomicResolutionClose:
          assigned !== undefined &&
          open !== undefined &&
          envelopeHasResolution(
            envelope,
            context.conversationId,
            assigned.record.runId,
            open.openFactDigest,
            true,
          ),
        conflictOpen:
          open !== undefined &&
          open.cause === "dispatch-conflict" &&
          open.resolution === undefined,
        hasAtomicConflictContainment:
          open !== undefined &&
          envelopeHasRunRecord(
            envelope,
            context.conversationId,
            (candidate) =>
              candidate.t === "dispatch-conflict-contained" &&
              candidate.assignmentId === body.assignmentId &&
              candidate.openFactDigest === open.openFactDigest &&
              sameTerminationProof(candidate.proof, proof),
          ),
      });
      if (!assigned) {
        throw corruptRunJournal(
          "Assignment supersede fact is invalid or duplicated",
        );
      }
      const assignedRecord = assigned.record;
      const envelopeEntries = envelope.entries;
      await verify(() => {
        context.assertResourceTerminalRecords(
          assignedRecord,
          "release",
          envelopeEntries,
        );
      });
      state.superseded.set(body.assignmentId, body);
      state.recoveryAssignments.delete(body.assignmentId);
      if (state.assignmentByRun.get(assigned.record.runId) === body.assignmentId) {
        state.assignmentByRun.delete(assigned.record.runId);
      }
      state.closedAssignments.add(body.assignmentId);
      return;
    }
    case "cancel-fence": {
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const opensConflict = envelopeHasRunRecord(
        envelope,
        context.conversationId,
        (candidate) =>
          candidate.t === "dispatch-conflict" &&
          candidate.assignmentId === body.assignmentId &&
          candidate.handling === "opened-uncertain",
      );
      const targetState = opensConflict ? "uncertain" : "cancel-requested";
      assertCancelFenceReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        fenceAlreadyExists: state.cancelFences.has(body.assignmentId),
        fenceSeq: body.fenceSeq,
        envelopeLsn: envelope.lsn,
        hasAtomicTargetState:
          assigned !== undefined &&
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            context.conversationId,
            assigned.record.runId,
            targetState,
            current.statusRevision + 1,
            body.assignmentId,
          ),
      });
      if (!assigned || !current) {
        throw corruptRunJournal("Cancel fence is invalid or duplicated");
      }
      state.cancelOrigins.set(
        body.assignmentId,
        current.state as "dispatched" | "running",
      );
      state.cancelFences.set(body.assignmentId, body);
      return;
    }
    case "capability-revoked": {
      const assigned = state.assignedById.get(body.assignmentId);
      const key = `${body.assignmentId}\0${body.capId}`;
      assertCapabilityRevocationReplayContract({
        assignmentExists: assigned !== undefined,
        capabilityBelongsToAssignment:
          assigned?.record.capIds.includes(body.capId) ?? false,
        alreadyRevoked: state.revokedCapabilities.has(key),
      });
      state.revokedCapabilities.add(key);
      return;
    }
    case "resolution": {
      const fact = snapshot(body.fact, "Uncertain resolution fact");
      const conversationFact = fact as ConversationUncertainResolutionFact;
      const assigned = state.assignedById.get(
        conversationFact.subject.assignmentId,
      );
      assertConversationResolutionBinding({
        execution: fact.subject.execution,
        conversationId:
          fact.subject.execution === "conversation"
            ? fact.subject.conversationId
            : undefined,
        subjectRunId:
          fact.subject.execution === "conversation"
            ? fact.subject.runId
            : undefined,
        recordRunId: body.runId,
        authorityConversationId: context.conversationId,
        subjectOwnerEpoch:
          fact.subject.execution === "conversation"
            ? fact.subject.ownerEpoch
            : undefined,
        authorityOwnerEpoch: assigned?.record.ownerEpoch,
      });
      const currentAssignmentId = state.assignmentByRun.get(body.runId);
      const closesEarlierInEnvelope =
        currentAssignmentId === undefined &&
        state.closedAssignments.has(conversationFact.subject.assignmentId) &&
        envelopeClosesAssignment(
          envelope,
          context.conversationId,
          body.runId,
          conversationFact.subject.assignmentId,
        );
      if (!assigned) {
        throw corruptRunJournal(
          "Uncertain resolution fact has no durable assignment",
        );
      }
      const existing = state.resolutionsByRun.get(body.runId);
      const current = state.stateByRun.get(body.runId);
      if (!conversationFact.resolution) {
        assertResolutionOpenReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned.record.runId === body.runId,
          assignmentIsCurrent:
            currentAssignmentId === conversationFact.subject.assignmentId,
          currentState: current?.state,
          alreadyOpen: isOpenResolutionFact(existing),
          cause: conversationFact.cause,
          hasAtomicUncertainState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              context.conversationId,
              body.runId,
              "uncertain",
              current.statusRevision + 1,
              conversationFact.subject.assignmentId,
            ),
          hasAtomicDispatchConflict: envelopeHasRunRecord(
            envelope,
            context.conversationId,
            (candidate) =>
              candidate.t === "dispatch-conflict" &&
              candidate.assignmentId === conversationFact.subject.assignmentId &&
              candidate.handling === "opened-uncertain",
          ),
        });
      } else {
        assertResolutionClosureReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned.record.runId === body.runId,
          assignmentIsCurrentOrAtomicallyClosed:
            currentAssignmentId === conversationFact.subject.assignmentId ||
            closesEarlierInEnvelope,
          conflictOpen: conversationFact.cause === "dispatch-conflict",
          resolutionKind: conversationFact.resolution.kind,
        });
        const nextState = resolutionTargetState(
          conversationFact.resolution.kind,
        );
        assertResolutionCloseAtomicReplayContract({
          cause: conversationFact.cause,
          kind: conversationFact.resolution.kind,
          existingOpenMatches:
            existing?.openFactDigest === conversationFact.openFactDigest &&
            existing.resolution === undefined,
          hasAtomicTargetState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              context.conversationId,
              body.runId,
              nextState,
              current.statusRevision + (current.state === "uncertain" ? 1 : 0),
              conversationFact.subject.assignmentId,
            ),
          allCapabilitiesRevoked: envelopeRevokesRemainingCapabilities(
            envelope,
            context.conversationId,
            state.revokedCapabilities,
            tickets,
            assigned,
          ),
          hasRequiredCompanion:
            (conversationFact.resolution.kind !==
              "proven-not-started-redispatched" ||
              envelopeHasRunRecord(
                envelope,
                context.conversationId,
                (candidate) =>
                  candidate.t === "assignment-superseded" &&
                  candidate.assignmentId ===
                    conversationFact.subject.assignmentId,
              )) &&
            (!conversationFact.resolution.kind.startsWith("user-") ||
              envelopeHasSuccessfulUncertainControl(
                envelope,
                nextState,
                conversationFact.resolution.factDigest,
                envelope.lsn,
              )),
        });
        if (conversationFact.resolution.kind.startsWith("user-")) {
          const assignedRecord = assigned.record;
          const envelopeEntries = envelope.entries;
          await verify(() => {
            context.assertResourceTerminalRecords(
              assignedRecord,
              "reclaim",
              envelopeEntries,
            );
          });
        }
      }
      state.resolutionsByRun.set(body.runId, conversationFact);
      if (conversationFact.resolution) {
        state.closedAssignments.add(conversationFact.subject.assignmentId);
        if (
          state.assignmentByRun.get(body.runId) ===
          conversationFact.subject.assignmentId
        ) {
          state.assignmentByRun.delete(body.runId);
        }
      }
      return;
    }
  }
}

export interface AssignmentControlGuardCrossFacts {
  readonly tickets: TicketReadonlyContext;
  readonly isEarliestQueuedForAssign?: boolean;
}

export async function reduceAssignmentControlGuardRecord(input: {
  readonly conversationId: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly state: GuardAssignmentControlMutableSlice;
  readonly crossFacts: AssignmentControlGuardCrossFacts;
  readonly body: Extract<
    ConversationRunJournalRecord,
    {
      t:
        | "assigned"
        | "dispatch-acked"
        | "dispatch-conflict"
        | "supersede-requested"
        | "supersede-started-observed"
        | "cancel-fence"
        | "cancel-proof-accepted"
        | "assignment-superseded"
        | "resolution"
        | "capability-revoked";
    }
  >;
  readonly envelope: ConversationFactGroup;
  readonly sourceLsn: number;
  readonly localCommit?: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
  readonly importedOrigin?: ConversationBaseLocation;
  readonly assertUsage: (
    assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
    usageFinal: CancelProofBody["usageFinal"],
  ) => void;
  readonly assertTerminal: (
    assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
    mode: "release" | "reclaim" | "settle-release",
    records: readonly LogicalRecord<unknown>[],
  ) => void;
  readonly verify: (check: () => void) => Promise<void>;
  readonly legacyTickets?: ConversationAbortTicketAuthorizer;
}): Promise<void> {
  const {
    conversationId,
    state,
    crossFacts,
    body,
    envelope,
    sourceLsn,
    verify,
    legacyTickets,
  } = input;
  const { tickets } = crossFacts;
  switch (body.t) {
    case "assigned": {
      const capIds = new Set(body.capIds);
      const runId = body.runId;
      const assignmentId = body.assignmentId;
      const current = state.stateByRun.get(runId);
      assertAssignmentReplayContract({
        currentState: current?.state,
        currentRevision: current?.statusRevision,
        runAlreadyAssigned: state.assignmentByRun.has(runId),
        assignmentAlreadyKnown: state.assignedById.has(assignmentId),
        isEarliestQueuedRun: Boolean(crossFacts.isEarliestQueuedForAssign),
        hasAtomicDispatchedState:
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            conversationId,
            runId,
            "dispatched",
            current.statusRevision + 1,
            assignmentId,
          ),
      });
      if (!crossFacts.isEarliestQueuedForAssign) {
        throw corruptRunJournal("Run assignment is not the earliest admitted run");
      }
      state.assignedById.set(assignmentId, {
        record: body,
        ...(input.localCommit
          ? { commit: input.localCommit }
          : { origin: input.importedOrigin! }),
        capIds,
        acked: false,
      });
      state.assignmentByRun.set(runId, assignmentId);
      state.assignmentAttemptByRun?.set(
        runId,
        Math.max(
          state.assignmentAttemptByRun.get(runId) ?? 0,
          body.reservation.attempt,
        ),
      );
      return;
    }
    case "dispatch-acked": {
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertDispatchAcknowledgementReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        alreadyAcknowledged: assigned?.acked ?? false,
        assignmentSuperseded: state.closedAssignments.has(body.assignmentId),
        assignmentClosed: state.closedAssignments.has(body.assignmentId),
      });
      if (!assigned) {
        throw corruptRunJournal("Dispatch acknowledgement is missing or duplicated");
      }
      assigned.acked = true;
      return;
    }
    case "dispatch-conflict": {
      const assignmentId = body.assignmentId;
      const assigned = state.assignedById.get(assignmentId);
      const proof = body.proof;
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertDispatchConflictReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === assignmentId,
        currentState: current?.state,
        proofBindsAssignment:
          assigned !== undefined &&
          proof.assignmentId === assignmentId &&
          proof.executorId === assigned.record.executorId,
        handling: body.handling,
        assignmentAcknowledged: assigned?.acked ?? false,
        assignmentSuperseded: state.closedAssignments.has(assignmentId),
        assignmentClosed: state.closedAssignments.has(assignmentId),
        conflictAlreadySeen: state.conflictAssignments.has(assignmentId),
      });
      if (!assigned || !current) {
        throw corruptRunJournal("Dispatch conflict record is invalid or duplicated");
      }
      const expectedActivationDigest = input.localCommit
        ? (() => {
            const expectedActivation =
              buildConversationActivationPayloadFromBinding({
                binding: {
                  runId: assigned.record.runId,
                  conversationId,
                  ownerEpoch: assigned.record.ownerEpoch,
                  assignmentId: assigned.record.assignmentId,
                  executorId: assigned.record.executorId,
                  dispatchRef: assigned.record.dispatchRef,
                  manifestDigest: assigned.record.manifestDigest,
                  permissionLeaseDigest: assigned.record.permissionLeaseDigest,
                  capIds: assigned.record.capIds,
                  reservation: assigned.record.reservation,
                },
                commit: {
                  lsn: requireLocalAssignedCommit(assigned).lsn,
                  envelopeDigest:
                    requireLocalAssignedCommit(assigned).envelopeDigest,
                },
                issuedAt: requireLocalAssignedCommit(assigned).at,
              });
            return assignmentActivationDigest(expectedActivation);
          })()
        : undefined;
      const acceptedMatches =
        canonicalize(proof.acceptedDispatchRef) ===
          canonicalize(assigned.record.dispatchRef) &&
        (expectedActivationDigest === undefined ||
          proof.acceptedActivationDigest === expectedActivationDigest);
      const conflictingMatches =
        canonicalize(proof.conflictingDispatchRef) ===
          canonicalize(assigned.record.dispatchRef) &&
        (expectedActivationDigest === undefined ||
          proof.conflictingActivationDigest === expectedActivationDigest);
      const atomicHandling =
        body.handling === "acked-original"
          ? envelopeHasRunRecord(
              envelope,
              conversationId,
              (candidate) =>
                candidate.t === "dispatch-acked" &&
                candidate.assignmentId === assignmentId,
            )
          : envelopeHasRunRecord(
              envelope,
              conversationId,
              (candidate) =>
                candidate.t === "resolution" &&
                candidate.runId === assigned.record.runId &&
                candidate.fact.subject.execution === "conversation" &&
                candidate.fact.subject.assignmentId === assignmentId &&
                candidate.fact.cause === "dispatch-conflict" &&
                candidate.fact.resolution === undefined,
            ) &&
            envelopeHasRunRecord(
              envelope,
              conversationId,
              (candidate) =>
                candidate.t === "cancel-fence" &&
                candidate.assignmentId === assignmentId,
            ) &&
            envelopeHasRunState(
              envelope,
              conversationId,
              assigned.record.runId,
              "uncertain",
              current.statusRevision + 1,
              assignmentId,
            ) &&
            envelopeRevokesCapabilities(
              envelope,
              conversationId,
              state.revokedCapabilities,
              assignmentId,
              assigned.capIds,
              tickets.ticketIdsByAssignment.get(assignmentId) ?? [],
              tickets.revokedTickets,
            );
      assertDispatchConflictHandlingReplayContract({
        handling: body.handling,
        acceptedMatches,
        conflictingMatches,
        atomicHandling,
      });
      state.conflictAssignments.add(assignmentId);
      if (body.handling === "opened-uncertain") {
        state.openConflictAssignments.add(assignmentId);
      }
      return;
    }
    case "supersede-requested": {
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertSupersedeRequestReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        requestAlreadyExists: state.supersedeRequests.has(body.assignmentId),
        fenceSeq: body.fenceSeq,
        envelopeLsn: sourceLsn,
      });
      state.supersedeRequests.set(body.assignmentId, body);
      return;
    }
    case "supersede-started-observed": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertSupersedeStartedObservationReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        proofBindsDurableSource:
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            tickets,
            assigned,
            proof,
            conversationId,
            legacyTickets,
          ),
        observationAlreadyExists: state.supersedeStartedAssignments.has(
          body.assignmentId,
        ),
      });
      state.supersedeStartedAssignments.add(body.assignmentId);
      state.durableStartedAssignments.add(body.assignmentId);
      return;
    }
    case "cancel-fence": {
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const opensConflict = envelopeHasRunRecord(
        envelope,
        conversationId,
        (candidate) =>
          candidate.t === "dispatch-conflict" &&
          candidate.assignmentId === body.assignmentId &&
          candidate.handling === "opened-uncertain",
      );
      assertCancelFenceReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        fenceAlreadyExists: state.cancelFences.has(body.assignmentId),
        fenceSeq: body.fenceSeq,
        envelopeLsn: sourceLsn,
        hasAtomicTargetState:
          assigned !== undefined &&
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            conversationId,
            assigned.record.runId,
            opensConflict ? "uncertain" : "cancel-requested",
            current.statusRevision + 1,
            body.assignmentId,
          ),
      });
      state.cancelFences.set(body.assignmentId, body);
      return;
    }
    case "cancel-proof-accepted": {
      const proof = body.proof;
      const assigned = state.assignedById.get(body.assignmentId);
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      assertCancelProofAcceptedReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === body.assignmentId,
        currentState: current?.state,
        acceptanceAlreadyExists: state.acceptedCancellations.has(
          body.assignmentId,
        ),
        durableStartedObserved: state.durableStartedAssignments.has(
          body.assignmentId,
        ),
        proofDecision: proof.decision,
        proofBindsDurableSource:
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            tickets,
            assigned,
            proof,
            conversationId,
            legacyTickets,
          ),
        hasAtomicCancelledState:
          assigned !== undefined &&
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            conversationId,
            assigned.record.runId,
            "cancelled",
            current.statusRevision + 1,
            body.assignmentId,
          ),
        allCapabilitiesRevoked:
          assigned !== undefined &&
          envelopeRevokesCapabilities(
            envelope,
            conversationId,
            state.revokedCapabilities,
            body.assignmentId,
            assigned.capIds,
            tickets.ticketIdsByAssignment.get(body.assignmentId) ?? [],
            tickets.revokedTickets,
          ),
      });
      if (!assigned) {
        throw corruptRunJournal("Submission guard cancellation has no assignment");
      }
      const assignedRecord = assigned.record;
      const usageFinal = proof.usageFinal;
      const terminalMode =
        proof.decision === "not-started" ? "release" : "settle-release";
      const envelopeEntries = envelope.entries;
      await verify(() => {
        input.assertUsage(assignedRecord, usageFinal);
      });
      await verify(() => {
        input.assertTerminal(assignedRecord, terminalMode, envelopeEntries);
      });
      state.acceptedCancellations.add(body.assignmentId);
      return;
    }
    case "assignment-superseded": {
      const assignmentId = body.assignmentId;
      const assigned = state.assignedById.get(assignmentId);
      const proof = body.proof;
      const current = assigned
        ? state.stateByRun.get(assigned.record.runId)
        : undefined;
      const kind = assignmentTerminationProofKind(proof);
      const open = assigned
        ? state.resolutionsByRun.get(assigned.record.runId)
        : undefined;
      assertAssignmentSupersededReplayContract({
        assignmentExists: assigned !== undefined,
        assignmentIsCurrent:
          assigned !== undefined &&
          state.assignmentByRun.get(assigned.record.runId) === assignmentId,
        assignmentAlreadyClosed: state.closedAssignments.has(assignmentId),
        currentState: current?.state,
        durableStartedObserved: state.durableStartedAssignments.has(assignmentId),
        proofBindsDurableSource:
          assigned !== undefined &&
          proofBindsConversationSource(
            state,
            tickets,
            assigned,
            proof,
            conversationId,
            legacyTickets,
          ),
        proofKind: kind,
        hasAtomicTargetState:
          assigned !== undefined &&
          current !== undefined &&
          envelopeHasRunState(
            envelope,
            conversationId,
            assigned.record.runId,
            current.state === "cancel-requested" ? "cancelled" : "queued",
            current.statusRevision + 1,
            assignmentId,
          ),
        allCapabilitiesRevoked:
          assigned !== undefined &&
          envelopeRevokesCapabilities(
            envelope,
            conversationId,
            state.revokedCapabilities,
            assignmentId,
            assigned.capIds,
            tickets.ticketIdsByAssignment.get(assignmentId) ?? [],
            tickets.revokedTickets,
          ),
        hasAtomicResolutionClose:
          assigned !== undefined &&
          open !== undefined &&
          envelopeHasResolution(
            envelope,
            conversationId,
            assigned.record.runId,
            open.openFactDigest,
            true,
          ),
        conflictOpen:
          open !== undefined &&
          open.cause === "dispatch-conflict" &&
          open.resolution === undefined,
        hasAtomicConflictContainment:
          open !== undefined &&
          envelopeHasRunRecord(
            envelope,
            conversationId,
            (candidate) =>
              candidate.t === "dispatch-conflict-contained" &&
              candidate.assignmentId === assignmentId &&
              candidate.openFactDigest === open.openFactDigest &&
              sameTerminationProof(candidate.proof, proof),
          ),
      });
      if (!assigned) {
        throw corruptRunJournal("Submission guard supersede has no assignment");
      }
      const assignedRecord = assigned.record;
      const envelopeEntries = envelope.entries;
      await verify(() => {
        input.assertTerminal(assignedRecord, "release", envelopeEntries);
      });
      state.assignmentByRun.delete(assigned.record.runId);
      state.closedAssignments.add(assignmentId);
      state.openConflictAssignments.delete(assignmentId);
      return;
    }
    case "resolution": {
      const fact = body.fact as ConversationUncertainResolutionFact;
      const runId = body.runId;
      const assignmentId = fact.subject.assignmentId;
      const assigned = state.assignedById.get(assignmentId);
      assertConversationResolutionBinding({
        execution: body.fact.subject.execution,
        conversationId:
          body.fact.subject.execution === "conversation"
            ? body.fact.subject.conversationId
            : undefined,
        subjectRunId:
          body.fact.subject.execution === "conversation"
            ? body.fact.subject.runId
            : undefined,
        recordRunId: body.runId,
        authorityConversationId: conversationId,
        subjectOwnerEpoch:
          fact.subject.execution === "conversation"
            ? fact.subject.ownerEpoch
            : undefined,
        authorityOwnerEpoch: assigned?.record.ownerEpoch,
      });
      const currentAssignmentId = state.assignmentByRun.get(runId);
      const closesEarlierInEnvelope =
        currentAssignmentId === undefined &&
        state.closedAssignments.has(assignmentId) &&
        envelopeClosesAssignment(envelope, conversationId, runId, assignmentId);
      const current = state.stateByRun.get(runId);
      const existing = state.resolutionsByRun.get(runId);
      if (!fact.resolution) {
        assertResolutionOpenReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.runId === runId,
          assignmentIsCurrent: currentAssignmentId === assignmentId,
          currentState: current?.state,
          alreadyOpen: isOpenResolutionFact(existing),
          cause: fact.cause,
          hasAtomicUncertainState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              conversationId,
              runId,
              "uncertain",
              current.statusRevision + 1,
              assignmentId,
            ),
          hasAtomicDispatchConflict: envelopeHasRunRecord(
            envelope,
            conversationId,
            (candidate) =>
              candidate.t === "dispatch-conflict" &&
              candidate.assignmentId === assignmentId &&
              candidate.handling === "opened-uncertain",
          ),
        });
      } else {
        assertResolutionClosureReplayContract({
          assignmentExists: assigned !== undefined,
          assignmentBindsRun: assigned?.record.runId === runId,
          assignmentIsCurrentOrAtomicallyClosed:
            currentAssignmentId === assignmentId || closesEarlierInEnvelope,
          conflictOpen: fact.cause === "dispatch-conflict",
          resolutionKind: fact.resolution.kind,
        });
        const nextState = resolutionTargetState(fact.resolution.kind);
        assertResolutionCloseAtomicReplayContract({
          cause: fact.cause,
          kind: fact.resolution.kind,
          existingOpenMatches:
            existing?.openFactDigest === fact.openFactDigest &&
            existing.resolution === undefined,
          hasAtomicTargetState:
            current !== undefined &&
            envelopeHasRunState(
              envelope,
              conversationId,
              runId,
              nextState,
              current.statusRevision + (current.state === "uncertain" ? 1 : 0),
              assignmentId,
            ),
          allCapabilitiesRevoked:
            assigned !== undefined &&
            envelopeRevokesCapabilities(
              envelope,
              conversationId,
              state.revokedCapabilities,
              assignmentId,
              assigned.capIds,
              tickets.ticketIdsByAssignment.get(assignmentId) ?? [],
              tickets.revokedTickets,
            ),
          hasRequiredCompanion:
            (fact.resolution.kind !== "proven-not-started-redispatched" ||
              envelopeHasRunRecord(
                envelope,
                conversationId,
                (candidate) =>
                  candidate.t === "assignment-superseded" &&
                  candidate.assignmentId === assignmentId,
              )) &&
            (!fact.resolution.kind.startsWith("user-") ||
              envelopeHasSuccessfulUncertainControl(
                envelope,
                nextState,
                fact.resolution.factDigest,
                sourceLsn,
              )),
        });
        if (fact.resolution.kind.startsWith("user-") && assigned) {
          const assignedRecord = assigned.record;
          const envelopeEntries = envelope.entries;
          await verify(() => {
            input.assertTerminal(assignedRecord, "reclaim", envelopeEntries);
          });
        }
      }
      state.resolutionsByRun.set(runId, fact);
      if (fact.resolution) {
        state.assignmentByRun.delete(runId);
        state.closedAssignments.add(assignmentId);
        state.openConflictAssignments.delete(assignmentId);
      }
      return;
    }
    case "capability-revoked": {
      const assignmentId = body.assignmentId;
      const capId = body.capId;
      const assigned = state.assignedById.get(assignmentId);
      const key = `${assignmentId}\0${capId}`;
      assertCapabilityRevocationReplayContract({
        assignmentExists: assigned !== undefined,
        capabilityBelongsToAssignment: assigned?.capIds.has(capId) ?? false,
        alreadyRevoked: state.revokedCapabilities.has(key),
      });
      state.revokedCapabilities.add(key);
      return;
    }
  }
}

export function applyRunStateTransition(input: {
  readonly state: Pick<
    AssignmentControlMutableSlice,
    | "activeRunId"
    | "stateByRun"
    | "assignmentByRun"
    | "closedAssignments"
    | "recoveryAssignments"
    | "uncertainOrigins"
    | "statusHistoryByRun"
  >;
  readonly body: Extract<ConversationRunJournalRecord, { t: "state" }>;
  readonly previousState: ConversationRunState | undefined;
  readonly nextActiveRunId: string | undefined;
  readonly uncertainOrigin?: {
    readonly assignmentId: string;
    readonly origin: "dispatched" | "running" | "cancel-requested";
  };
  readonly envelopeAt: string;
  readonly resolutionsInEnvelope: readonly ConversationUncertainResolutionFact[];
}): void {
  const { state, body } = input;
  if (input.uncertainOrigin) {
    state.uncertainOrigins.set(
      input.uncertainOrigin.assignmentId,
      input.uncertainOrigin.origin,
    );
  }
  state.activeRunId = input.nextActiveRunId;
  state.stateByRun.set(body.runId, {
    state: body.state,
    statusRevision: body.statusRevision,
  });
  if (body.state === "failed" && body.assignmentId !== undefined) {
    state.assignmentByRun.delete(body.runId);
    state.closedAssignments.add(body.assignmentId);
  }
  if (
    body.assignmentId !== undefined &&
    (body.state === "queued" ||
      body.state === "cancelled" ||
      body.state === "failed" ||
      body.state === "expired")
  ) {
    state.recoveryAssignments.delete(body.assignmentId);
  }
  const history = state.statusHistoryByRun.get(body.runId) ?? [];
  if ((history.at(-1)?.statusRevision ?? 0) + 1 !== body.statusRevision) {
    throw corruptRunJournal("Run status history index is not contiguous");
  }
  history.push(
    projectStatusEntry(
      body,
      input.envelopeAt,
      input.previousState,
      input.resolutionsInEnvelope,
    ),
  );
  state.statusHistoryByRun.set(body.runId, history);
}

export function applyGuardStateTransition(input: {
  readonly state: Pick<
    GuardAssignmentControlMutableSlice,
    "activeRunId" | "stateByRun" | "durableStartedAssignments"
  >;
  readonly body: Extract<ConversationRunJournalRecord, { t: "state" }>;
  readonly nextActiveRunId: string | undefined;
}): void {
  const { state, body } = input;
  state.activeRunId = input.nextActiveRunId;
  state.stateByRun.set(body.runId, {
    state: body.state,
    statusRevision: body.statusRevision,
  });
  if (body.state === "running" && body.assignmentId !== undefined) {
    state.durableStartedAssignments.add(body.assignmentId);
  }
}

export function computeNextActiveRunId(input: {
  readonly activeRunId: string | undefined;
  readonly runId: string;
  readonly currentState: ConversationRunState | undefined;
  readonly nextState: ConversationRunState;
}): string | undefined {
  return nextActiveRunIdForReplay(input);
}
