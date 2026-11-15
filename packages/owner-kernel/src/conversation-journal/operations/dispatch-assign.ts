import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type { ArtifactRef, DispatchResult } from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  permissionSnapshotLeaseDigest,
  requiresFormalResourceCoordination,
} from "@zhixing-ai/core/protocol";
import type { ConversationRunJournalRecord } from "../../conversation-run-contracts.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import { dispatchConflictKey } from "../../shared-protocol/contracts.js";
import {
  ConversationAssignmentCancelledError,
  ConversationPendingCancellationError,
  type ConversationCommitLogRecord,
  type PendingConversationDispatch,
} from "../contracts.js";
import { createOpenResolutionFact } from "../state/assignment-control.js";
import { runRecord, snapshot, withoutSignature } from "../state/common.js";
import type {
  ConversationDecisionFacts,
  ReadonlyAssignedFact,
} from "../state/views.js";

export interface AssignDecision {
  readonly assignmentId: string;
  /** 本次事务写入了这次分派（不是命中已有分派）。 */
  readonly appended?: true;
}

export function decideAssignPreflight(input: {
  readonly runId: string;
  readonly assignmentId: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): {
  readonly currentAssignment: ReadonlyAssignedFact | undefined;
  readonly assignmentIdInUse: boolean;
} {
  const { assignment } = input.facts;
  const currentAssignmentId = assignment.getAssignmentIdForRun(input.runId);
  const currentAssignment = currentAssignmentId
    ? assignment.getAssigned(currentAssignmentId)
    : undefined;
  return {
    currentAssignment: currentAssignment
      ? snapshot(currentAssignment, "Current assignment")
      : undefined,
    assignmentIdInUse: assignment.hasAssigned(input.assignmentId),
  };
}

export function decideAssign(input: {
  readonly conversationId: string;
  readonly envelope: PendingConversationDispatch["envelope"];
  readonly dispatchDigest: string;
  readonly dispatchRef: ArtifactRef;
  readonly pendingCancellation: boolean;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: Pick<ConversationDecisionFacts, "queueInput" | "assignment">;
}): ProjectionTransactionDecision<unknown, AssignDecision> {
  const { queueInput, assignment } = input.facts;
  const { envelope, dispatchDigest } = input;
  const admitted = queueInput.getAdmitted(envelope.work.runId);
  if (!admitted) {
    throw new Error("Run must be durably admitted before assignment");
  }
  if (
    canonicalize(admitted.record.ingress) !==
    canonicalize(envelope.work.ingress)
  ) {
    throw new Error("Dispatch ingress does not match the admitted run");
  }
  const existingId = assignment.getAssignmentIdForRun(envelope.work.runId);
  const existing = existingId ? assignment.getAssigned(existingId) : undefined;
  if (existing) {
    if (
      existing.record.assignmentId !== envelope.assignmentId ||
      existing.record.dispatchDigest !== dispatchDigest
    ) {
      throw new Error("Run already has a different durable assignment");
    }
    return {
      kind: "return",
      value: { assignmentId: existing.record.assignmentId },
    };
  }
  if (assignment.hasAssigned(envelope.assignmentId)) {
    throw new Error("Assignment id already belongs to a different run");
  }
  const current = assignment.getRunState(envelope.work.runId);
  if (current?.state !== "queued") {
    throw new Error("Only the current queued run can be assigned");
  }
  if (
    assignment.activeRunId !== undefined &&
    assignment.activeRunId !== envelope.work.runId
  ) {
    throw new Error("Conversation already has an active assignment");
  }
  if (!queueInput.isEarliestQueuedPosition(admitted.record.queuedPosition)) {
    throw new Error("Only the earliest queued run can be assigned");
  }
  if (input.pendingCancellation) {
    throw new ConversationPendingCancellationError(envelope.work.runId);
  }
  const assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }> = {
    t: "assigned",
    runId: envelope.work.runId,
    assignmentId: envelope.assignmentId,
    executorId: envelope.executorId,
    ownerEpoch: envelope.work.ownerEpoch,
    baseRevision: envelope.work.baseRevision,
    dispatchDigest,
    manifestDigest: envelope.manifest.digest,
    dispatchRef: input.dispatchRef,
    permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
    capIds: envelope.capabilities.map((capability) => capability.capId),
    reservation: {
      reservationId: envelope.resourceLease.reservationId,
      attempt: envelope.resourceLease.workload.attempt,
    },
  };
  const governed = requiresFormalResourceCoordination(envelope.resourceLease);
  const resourceRecords =
    governed && input.resources
      ? input.resources.prepareActivation(envelope.resourceLease)
      : [];
  if (governed && !input.resources) {
    throw new Error("Anchor resource coordination is not configured");
  }
  return {
    kind: "append",
    entries: [
      ...resourceRecords,
      runRecord(input.conversationId, assigned),
      runRecord(input.conversationId, {
        t: "state",
        runId: envelope.work.runId,
        assignmentId: envelope.assignmentId,
        state: "dispatched",
        statusRevision: (current?.statusRevision ?? 0) + 1,
      }),
    ],
    value: { assignmentId: envelope.assignmentId, appended: true },
  };
}

export function decideAssignmentSchedulingState(input: {
  readonly runId: string;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "session" | "queueInput" | "assignment"
  >;
}): { readonly ready: boolean; readonly blockingRunId?: string } {
  const { session, queueInput, assignment } = input.facts;
  const admitted = queueInput.getAdmitted(input.runId);
  if (
    !admitted ||
    session.deleted ||
    assignment.getRunState(input.runId)?.state !== "queued" ||
    assignment.getAssignmentIdForRun(input.runId) !== undefined
  ) {
    return { ready: false };
  }
  const first = queueInput.peekEarliestQueued();
  const blockingRunId =
    assignment.activeRunId !== undefined &&
    assignment.activeRunId !== input.runId
      ? assignment.activeRunId
      : first !== undefined &&
          first.queuedPosition !== admitted.record.queuedPosition
        ? first.runId
        : undefined;
  return blockingRunId
    ? { ready: false, blockingRunId }
    : { ready: first?.queuedPosition === admitted.record.queuedPosition };
}

export function decideAcknowledgeDispatch(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  if (!assigned) {
    throw new Error("Cannot acknowledge an unknown assignment");
  }
  if (assigned.acked) {
    return { kind: "return", value: undefined };
  }
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    input.assignmentId
  ) {
    throw new Error("Cannot acknowledge a historical assignment");
  }
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "dispatch-acked",
        assignmentId: input.assignmentId,
      }),
    ],
    value: undefined,
  };
}

export function decideRecordDispatchConflict(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly proof: Extract<
    DispatchResult,
    { accepted: false; outcome: "conflicting-redelivery" }
  >["proof"];
  readonly acceptedMatches: boolean;
  readonly openedAt: string;
  readonly nextLsn: number;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  "acked-original" | "opened-uncertain"
> {
  const { assignment } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  const current = assigned
    ? assignment.getRunState(assigned.record.runId)
    : undefined;
  const key = dispatchConflictKey(input.proof);
  const existing = assignment.getConflictByKey(key);
  if (existing) {
    if (
      canonicalize(withoutSignature(existing.proof)) !==
      canonicalize(withoutSignature(input.proof))
    ) {
      throw new Error("Dispatch conflict identity has conflicting payloads");
    }
    return { kind: "return", value: existing.handling };
  }
  if (!assigned || !current || current.state !== "dispatched" || assigned.acked) {
    throw new Error("Dispatch conflict is late for the current assignment");
  }
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    input.assignmentId
  ) {
    throw new Error("Dispatch conflict belongs to a historical assignment");
  }
  if (input.acceptedMatches) {
    return {
      kind: "append",
      entries: [
        runRecord(input.conversationId, {
          t: "dispatch-conflict",
          assignmentId: input.assignmentId,
          proof: input.proof,
          handling: "acked-original",
        }),
        runRecord(input.conversationId, {
          t: "dispatch-acked",
          assignmentId: input.assignmentId,
        }),
      ],
      value: "acked-original",
    };
  }
  const fact = createOpenResolutionFact(
    assigned,
    "dispatch-conflict",
    input.openedAt,
  );
  const fence = {
    fenceSeq: input.nextLsn,
    requestId: `dispatch-conflict:${input.proof.conflictingActivationDigest}`,
  };
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "dispatch-conflict",
        assignmentId: input.assignmentId,
        proof: input.proof,
        handling: "opened-uncertain",
      }),
      runRecord(input.conversationId, {
        t: "resolution",
        runId: assigned.record.runId,
        fact,
      }),
      runRecord(input.conversationId, {
        t: "cancel-fence",
        assignmentId: input.assignmentId,
        ...fence,
      }),
      ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
      runRecord(input.conversationId, {
        t: "state",
        runId: assigned.record.runId,
        assignmentId: input.assignmentId,
        state: "uncertain",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: "opened-uncertain",
  };
}

export function decideReportStarted(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly authorizeReplay: () => void;
  readonly authorizeActive: () => void;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  if (!assigned) {
    throw new Error("Started report names an unknown assignment");
  }
  const current = assignment.getRunState(assigned.record.runId);
  if (
    (assignment.getAssignmentIdForRun(assigned.record.runId) ===
      input.assignmentId &&
      (current?.state === "running" || current?.state === "committed")) ||
    assignment.hasDurableStarted(input.assignmentId)
  ) {
    input.authorizeReplay();
    return { kind: "return", value: undefined };
  }
  if (
    current?.state !== "dispatched" ||
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
      input.assignmentId
  ) {
    if (
      assignment.getAssignmentIdForRun(assigned.record.runId) ===
        input.assignmentId &&
      (current?.state === "cancel-requested" ||
        current?.state === "cancelled") &&
      assignment.getCancelFence(input.assignmentId) !== undefined
    ) {
      throw new ConversationAssignmentCancelledError(
        assigned.record.runId,
        input.assignmentId,
      );
    }
    throw new Error("Started report is invalid for the current run state");
  }
  input.authorizeActive();
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "state",
        runId: assigned.record.runId,
        assignmentId: input.assignmentId,
        state: "running",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: undefined,
  };
}

export function decideReconcileStarted(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  if (!assigned) {
    throw new Error("Ledger snapshot names an unknown assignment");
  }
  const current = assignment.getRunState(assigned.record.runId);
  if (
    (assignment.getAssignmentIdForRun(assigned.record.runId) ===
      input.assignmentId &&
      (current?.state === "running" || current?.state === "committed")) ||
    assignment.hasDurableStarted(input.assignmentId)
  ) {
    return { kind: "return", value: undefined };
  }
  if (
    current?.state !== "dispatched" ||
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
      input.assignmentId
  ) {
    throw new Error("Ledger snapshot is invalid for the current run state");
  }
  return {
    kind: "append",
    entries: [
      ...(!assigned.acked
        ? [
            runRecord(input.conversationId, {
              t: "dispatch-acked" as const,
              assignmentId: input.assignmentId,
            }),
          ]
        : []),
      runRecord(input.conversationId, {
        t: "state",
        runId: assigned.record.runId,
        assignmentId: input.assignmentId,
        state: "running",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: undefined,
  };
}
