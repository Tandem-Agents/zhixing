import type {
  AssignmentTerminationProof,
  CancelProofBody,
  CommitEnvelope,
  DataPlaneTicket,
  JobRunState,
  LogicalRecord,
  SupersedeProof,
  UncertainResolutionFact,
} from "@zhixing-ai/core/contracts";
import {
  buildJobActivationPayload,
  buildJobActivationPayloadFromBinding,
  canonicalize,
  protocolDigest,
  signJobActivation,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import type { ConversationAbortTicketAuthorizer } from "../../conversation-journal/contracts.js";
import {
  resolutionFactDigest,
  terminationProofBindsDurableSource,
} from "../../conversation-run-contracts.js";
import { abortTicketProofBindsOwnerHistory } from "../../data-plane-ticket-proof.js";
import {
  assertExecutionFailureAcceptedReplayContract,
  corruptJobJournal,
  type JobJournalRecord,
  type NotStartedProofKind,
} from "../../job-run-contracts.js";
import type { KeyedMap } from "../../job-run-state.js";
import type {
  AssignedJob,
  JobResolutionFact,
  JobStateEntry,
  PendingJobDispatch,
} from "../contracts.js";
import { jobRecord, revokedCapabilityKey, snapshot } from "./common.js";

export interface JobCapabilityRevocationSlice {
  readonly revokedCapabilities: Pick<ReadonlySet<string>, "has">;
  readonly ticketIdsByAssignment: Pick<
    ReadonlyMap<string, ReadonlySet<string>>,
    "get"
  >;
  readonly revokedTickets: Pick<ReadonlySet<string>, "has">;
}

export interface JobSourceProofBindingSlice {
  readonly supersedeRequests: Pick<
    ReadonlyMap<string, Extract<JobJournalRecord, { t: "supersede-requested" }>>,
    "get"
  >;
  readonly cancelFences: Pick<
    ReadonlyMap<string, Extract<JobJournalRecord, { t: "cancel-fence" }>>,
    "get"
  >;
  readonly ticketIdsByAssignment: Pick<
    ReadonlyMap<string, ReadonlySet<string>>,
    "get"
  >;
  readonly ticketsById: Pick<ReadonlyMap<string, DataPlaneTicket>, "get">;
}

export function notStartedTargetState(
  definitionState: "enabled" | "disabled" | "deleted" | undefined,
  current: JobStateEntry,
): "queued" | "cancelled" {
  return current.state === "cancel-requested" || definitionState !== "enabled"
    ? "cancelled"
    : "queued";
}

export function notStartedResolutionKind(
  target: "queued" | "cancelled",
): "proven-not-started-redispatched" | "proven-not-started-cancelled" {
  return target === "queued"
    ? "proven-not-started-redispatched"
    : "proven-not-started-cancelled";
}

export function openResolution(
  taskId: string,
  jobRunId: string,
  anchorEpoch: number,
  assignmentId: string,
  cause: JobResolutionFact["cause"],
  openedAt: string,
): JobResolutionFact {
  const subject = {
    execution: "job" as const,
    taskId,
    jobRunId,
    anchorEpoch,
    assignmentId,
  };
  return {
    subject,
    openedAt,
    cause,
    openFactDigest: protocolDigest("UncertainOpenFact", 1, {
      subject,
      openedAt,
      cause,
    }),
  };
}

export function closeResolution(
  fact: JobResolutionFact,
  kind: NonNullable<UncertainResolutionFact["resolution"]>["kind"],
  by: string,
  at: string,
): JobResolutionFact {
  return snapshot({
    ...fact,
    resolution: {
      kind,
      by,
      at,
      factDigest: resolutionFactDigest(fact.openFactDigest, kind, by, at),
    },
  });
}

export function terminationProofKind(
  proof: AssignmentTerminationProof | CancelProofBody,
): NotStartedProofKind {
  if ("dispatchDigest" in proof) return "dispatch-rejection";
  if (proof.decision === "not-started-fenced") return "supersede";
  return proof.cause === "owner-fence"
    ? "cancel-owner-fence"
    : "cancel-abort-ticket";
}

export function proofBindsJobSource(
  state: JobSourceProofBindingSlice,
  assigned: {
    readonly record: {
      readonly assignmentId: string;
      readonly executorId: string;
      readonly taskId: string;
      readonly dispatchDigest: string;
    };
  },
  proof: AssignmentTerminationProof | CancelProofBody | SupersedeProof,
  anchorEpoch: number,
  legacy: ConversationAbortTicketAuthorizer | undefined,
): boolean {
  const assignmentId = assigned.record.assignmentId;
  const abortTicketProofBindsDurableSource =
    "cause" in proof && proof.cause === "abort-ticket"
      ? abortTicketProofBindsOwnerHistory({
          assignmentId,
          ticketIds:
            state.ticketIdsByAssignment.get(assignmentId) ?? new Set<string>(),
          ticketsById: state.ticketsById as ReadonlyMap<string, DataPlaneTicket>,
          proof,
          ...(legacy ? { legacy } : {}),
        })
      : false;
  return terminationProofBindsDurableSource({
    execution: "job",
    proof,
    assignmentId,
    executorId: assigned.record.executorId,
    taskId: assigned.record.taskId,
    anchorEpoch,
    dispatchDigest: assigned.record.dispatchDigest,
    supersedeRequest: state.supersedeRequests.get(assignmentId),
    cancelFence: state.cancelFences.get(assignmentId),
    abortTicketProofBindsDurableSource,
  });
}

export function materializeDispatch(
  assigned: AssignedJob,
  signer: ProtocolSigner,
): PendingJobDispatch {
  const activation = signJobActivation(
    buildJobActivationPayload({
      envelope: assigned.envelope,
      dispatchRef: assigned.record.dispatchRef,
      commit: {
        lsn: assigned.commit.lsn,
        envelopeDigest: assigned.commit.envelopeDigest,
      },
      issuedAt: assigned.commit.at,
    }),
    signer,
  );
  return {
    assignmentId: assigned.record.assignmentId,
    envelope: snapshot(assigned.envelope),
    activation,
  };
}

export function assignedActivationDigest(assigned: {
  readonly record: Extract<JobJournalRecord, { t: "assigned" }>;
  readonly commit: {
    readonly lsn: number;
    readonly envelopeDigest: string;
    readonly at: string;
  };
}): string {
  return protocolDigest(
    "AssignmentActivationPayload",
    1,
    buildJobActivationPayloadFromBinding({
      binding: {
        jobRunId: assigned.record.jobRunId,
        taskId: assigned.record.taskId,
        anchorEpoch: assigned.record.anchorEpoch,
        assignmentId: assigned.record.assignmentId,
        executorId: assigned.record.executorId,
        dispatchRef: assigned.record.dispatchRef,
        manifestDigest: assigned.record.manifestDigest,
        permissionLeaseDigest: assigned.record.permissionLeaseDigest,
        capIds: assigned.record.capIds,
        reservation: assigned.record.reservation,
      },
      commit: {
        lsn: assigned.commit.lsn,
        envelopeDigest: assigned.commit.envelopeDigest,
      },
      issuedAt: assigned.commit.at,
    }),
  );
}

export function byAssignmentCommit(
  state: {
    readonly assignedById: Pick<
      KeyedMap<string, { readonly commit: { readonly lsn: number } }>,
      "get"
    >;
  },
  assignmentIds: readonly string[],
): string[] {
  return assignmentIds
    .map((assignmentId) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) {
        throw corruptJobJournal(
          "Assignment directory names an unknown assignment",
        );
      }
      return { assignmentId, lsn: assigned.commit.lsn };
    })
    .sort(
      (left, right) =>
        left.lsn - right.lsn ||
        left.assignmentId.localeCompare(right.assignmentId),
    )
    .map(({ assignmentId }) => assignmentId);
}

export function capabilityRevocations(
  taskId: string,
  state: JobCapabilityRevocationSlice,
  assigned: {
    readonly record: {
      readonly assignmentId: string;
      readonly capIds: readonly string[];
    };
  },
): LogicalRecord<JobJournalRecord>[] {
  const capabilities = assigned.record.capIds
    .filter(
      (capId) =>
        !state.revokedCapabilities.has(
          revokedCapabilityKey(assigned.record.assignmentId, capId),
        ),
    )
    .map((capId) =>
      jobRecord(taskId, {
        t: "capability-revoked",
        capId,
        assignmentId: assigned.record.assignmentId,
      }),
    );
  const tickets = dataPlaneTicketRevocations(
    taskId,
    state,
    assigned.record.assignmentId,
  );
  return [...capabilities, ...tickets];
}

export function dataPlaneTicketRevocations(
  taskId: string,
  state: Pick<
    JobCapabilityRevocationSlice,
    "ticketIdsByAssignment" | "revokedTickets"
  >,
  assignmentId: string,
): LogicalRecord<JobJournalRecord>[] {
  return [...(state.ticketIdsByAssignment.get(assignmentId) ?? [])]
    .filter((ticketId) => !state.revokedTickets.has(ticketId))
    .map((ticketId) =>
      jobRecord(taskId, {
        t: "ticket-revoked",
        ticketId,
      }),
    );
}

export function allJobCapabilitiesRevoked(
  envelopeRecords: readonly JobJournalRecord[],
  state: JobCapabilityRevocationSlice,
  assigned: {
    readonly record: {
      readonly assignmentId: string;
      readonly capIds: readonly string[];
    };
  },
): boolean {
  return (
    assigned.record.capIds.every(
      (capId) =>
        state.revokedCapabilities.has(
          revokedCapabilityKey(assigned.record.assignmentId, capId),
        ) ||
        envelopeRecords.some(
          (record) =>
            record.t === "capability-revoked" &&
            record.assignmentId === assigned.record.assignmentId &&
            record.capId === capId,
        ),
    ) &&
    [...(state.ticketIdsByAssignment.get(assigned.record.assignmentId) ?? [])].every(
      (ticketId) =>
        state.revokedTickets.has(ticketId) ||
        envelopeRecords.some(
          (record) =>
            record.t === "ticket-revoked" && record.ticketId === ticketId,
        ),
    )
  );
}

export function recordsAcceptExecutionFailure(
  envelopeRecords: readonly JobJournalRecord[],
  failed: Extract<JobJournalRecord, { t: "state" }>,
): boolean {
  const usageFinal = failed.usageFinal;
  return (
    failed.assignmentId !== undefined &&
    usageFinal !== undefined &&
    envelopeRecords.some(
      (record) =>
        record.t === "execution-failure-accepted" &&
        record.assignmentId === failed.assignmentId &&
        canonicalize(record.failure.usageFinal) === canonicalize(usageFinal),
    )
  );
}

export function assertExecutionFailureAcceptanceReplay(
  state: JobCapabilityRevocationSlice & {
    readonly assignedById: Pick<
      ReadonlyMap<
        string,
        { readonly record: Extract<JobJournalRecord, { t: "assigned" }> }
      >,
      "get"
    >;
    readonly states: Pick<
      ReadonlyMap<
        string,
        { readonly state: JobRunState; readonly statusRevision: number }
      >,
      "get"
    >;
    readonly assignmentByJob: Pick<ReadonlyMap<string, string>, "get">;
  },
  body: Extract<JobJournalRecord, { t: "execution-failure-accepted" }>,
  envelopeRecords: readonly JobJournalRecord[],
): void {
  const assigned = state.assignedById.get(body.assignmentId);
  const current = assigned ? state.states.get(assigned.record.jobRunId) : undefined;
  assertExecutionFailureAcceptedReplayContract({
    assignmentExists: assigned !== undefined,
    assignmentIsCurrent:
      assigned !== undefined &&
      state.assignmentByJob.get(assigned.record.jobRunId) === body.assignmentId,
    currentState: current?.state,
    hasAtomicFailedState:
      assigned !== undefined &&
      current !== undefined &&
      envelopeRecords.some(
        (record) =>
          record.t === "state" &&
          record.jobRunId === assigned.record.jobRunId &&
          record.assignmentId === body.assignmentId &&
          record.state === "failed" &&
          record.statusRevision === current.statusRevision + 1 &&
          record.usageFinal !== undefined &&
          canonicalize(record.usageFinal) ===
            canonicalize(body.failure.usageFinal),
      ),
    allCapabilitiesRevoked:
      assigned !== undefined &&
      allJobCapabilitiesRevoked(envelopeRecords, state, {
        record: assigned.record,
      }),
  });
}

export function recordsHaveJobState(
  records: readonly JobJournalRecord[],
  jobRunId: string,
  state: JobRunState,
  statusRevision: number,
  assignmentId: string | undefined,
): boolean {
  return records.some(
    (record) =>
      record.t === "state" &&
      record.jobRunId === jobRunId &&
      record.assignmentId === assignmentId &&
      record.state === state &&
      record.statusRevision === statusRevision,
  );
}

export function recordsCloseJobAssignment(
  records: readonly JobJournalRecord[],
  jobRunId: string,
  assignmentId: string,
): boolean {
  return records.some(
    (record) =>
      (record.t === "assignment-superseded" &&
        record.assignmentId === assignmentId) ||
      (record.t === "committed" && record.assignmentId === assignmentId) ||
      (record.t === "state" &&
        record.jobRunId === jobRunId &&
        record.assignmentId === assignmentId &&
        (record.state === "queued" ||
          record.state === "committed" ||
          record.state === "cancelled" ||
          record.state === "failed")),
  );
}

export function taskRevisionAtomicFacts(input: {
  readonly records: readonly JobJournalRecord[];
  readonly taskRevision: number;
  readonly activeJobRunId: string | undefined;
  readonly active: JobStateEntry | undefined;
  readonly assignmentId: string | undefined;
  readonly cancelFences: Pick<ReadonlyMap<string, unknown>, "has">;
  readonly envelopeLsn: number;
}): {
  readonly hasAtomicQueuedCancellation: boolean;
  readonly hasAtomicAssignedCancellation: boolean;
  readonly hasExistingCancelFence: boolean;
  readonly hasAtomicUncertainFence: boolean;
} {
  const { activeJobRunId, active, assignmentId } = input;
  const hasRevisionFence =
    assignmentId !== undefined &&
    input.records.some(
      (record) =>
        record.t === "cancel-fence" &&
        record.assignmentId === assignmentId &&
        record.fenceSeq === input.envelopeLsn &&
        record.requestId === `task-revision:${input.taskRevision}`,
    );
  return {
    hasAtomicQueuedCancellation:
      activeJobRunId !== undefined &&
      active !== undefined &&
      recordsHaveJobState(
        input.records,
        activeJobRunId,
        "cancelled",
        active.statusRevision + 1,
        undefined,
      ),
    hasAtomicAssignedCancellation:
      activeJobRunId !== undefined &&
      active !== undefined &&
      hasRevisionFence &&
      recordsHaveJobState(
        input.records,
        activeJobRunId,
        "cancel-requested",
        active.statusRevision + 1,
        assignmentId,
      ),
    hasExistingCancelFence:
      assignmentId !== undefined && input.cancelFences.has(assignmentId),
    hasAtomicUncertainFence:
      activeJobRunId !== undefined && active !== undefined && hasRevisionFence,
  };
}

export function envelopeHasManualJobRunApplied(
  envelope: CommitEnvelope<unknown>,
  jobRunId: string,
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
      applied.authorityRevision !== envelope.lsn ||
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
      readonly jobRunId?: unknown;
    };
    return body.t === "job-run" && body.jobRunId === jobRunId;
  });
}

export function envelopeHasSuccessfulJobUncertainControl(
  envelope: CommitEnvelope<unknown>,
  state: JobRunState,
  factDigest: string,
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
      applied.authorityRevision !== envelope.lsn ||
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
