import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  DispatchConflictProof,
  JobOccurrence,
  LogicalRecord,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import {
  buildJobActivationPayloadFromBinding,
  canonicalize,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  permissionSnapshotLeaseDigest,
  protocolDigest,
  requiresFormalResourceCoordination,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import { isOpenResolutionFact } from "../../conversation-run-contracts.js";
import {
  corruptJobJournal,
  sameJobInteractionSettlement,
  type JobJournalRecord,
  type NotStartedProofKind,
} from "../../job-run-contracts.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import type {
  AssignedJob,
  JobEnvelope,
  JobRecoveryCandidate,
  PendingJobDispatch,
} from "../contracts.js";
import { openResolution } from "../state/assignment-control.js";
import {
  jobRecord,
  snapshot,
  stateRecord,
  withoutSignature,
} from "../state/common.js";
import { assertDispatchMatchesOccurrence } from "../state/task-schedule.js";
import type { DeepReadonly, JobDecisionFacts } from "../state/views.js";

export function selectExistingAssignmentForPlan(
  facts: Pick<JobDecisionFacts, "assignment">,
  jobRunId: string,
  assignmentId: string,
): {
  readonly currentAssignment: AssignedJob | undefined;
  readonly assignmentIdInUse: boolean;
} {
  const currentAssignmentId = facts.assignment.getAssignmentIdForJob(jobRunId);
  const currentAssignment = currentAssignmentId
    ? facts.assignment.getAssigned(currentAssignmentId)
    : undefined;
  return {
    currentAssignment: currentAssignment
      ? snapshot(currentAssignment as unknown as AssignedJob)
      : undefined,
    assignmentIdInUse: facts.assignment.getAssigned(assignmentId) !== undefined,
  };
}

export function decideAssignOccurrence(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly envelope: JobEnvelope;
  readonly dispatchRef: ArtifactRef;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, string> {
  const { task, assignment } = input.facts;
  const { envelope } = input;
  const occurrence = task.getOccurrence(envelope.work.jobRunId) as
    | JobOccurrence
    | undefined;
  const current = assignment.getRunState(envelope.work.jobRunId);
  const currentAssignmentId = assignment.getAssignmentIdForJob(
    envelope.work.jobRunId,
  );
  const currentAssignment = currentAssignmentId
    ? assignment.getAssigned(currentAssignmentId)
    : undefined;
  if (currentAssignment) {
    if (
      currentAssignment.record.assignmentId !== envelope.assignmentId ||
      canonicalize(withoutSignature(currentAssignment.envelope)) !==
        canonicalize(withoutSignature(envelope))
    ) {
      throw new Error("Job occurrence already has a different assignment");
    }
    return { kind: "return", value: currentAssignment.record.assignmentId };
  }
  if (assignment.getAssigned(envelope.assignmentId) !== undefined) {
    throw new Error("Assignment id already belongs to another occurrence");
  }
  if (!occurrence || current?.state !== "queued") {
    throw new Error("Only a durable queued occurrence can be assigned");
  }
  if (task.requireDefinition().state !== "enabled") {
    throw new Error("Disabled or deleted tasks cannot activate queued work");
  }
  const definition = task.requireDefinitionRevision(
    occurrence.taskRevision,
  ) as TaskDefinition;
  if (definition.definition.kind !== "user") {
    throw new Error("System jobs cannot enter the assignment protocol");
  }
  assertDispatchMatchesOccurrence(
    envelope,
    occurrence,
    definition,
    input.anchorEpoch,
  );
  const assigned: Extract<JobJournalRecord, { t: "assigned" }> = {
    t: "assigned",
    taskId: input.taskId,
    jobRunId: occurrence.jobRunId,
    assignmentId: envelope.assignmentId,
    executorId: envelope.executorId,
    anchorEpoch: input.anchorEpoch,
    taskRevision: occurrence.taskRevision,
    deliveryPlanDigest: occurrence.deliveryPlan.planDigest,
    dispatchDigest: dispatchEnvelopeDigest(envelope),
    manifestDigest: envelope.manifest.digest,
    dispatchRef: input.dispatchRef,
    permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
    capIds: envelope.capabilities.map((capability) => capability.capId),
    reservation: {
      reservationId: envelope.resourceLease.reservationId,
      attempt: envelope.resourceLease.workload.attempt,
    },
  };
  if (
    requiresFormalResourceCoordination(envelope.resourceLease) &&
    !input.resources
  ) {
    throw new Error("Job assignment resource coordination is not configured");
  }
  const resourceRecords = requiresFormalResourceCoordination(
    envelope.resourceLease,
  )
    ? input.resources?.prepareActivation(envelope.resourceLease)
    : [];
  return {
    kind: "append",
    entries: [
      ...(resourceRecords ?? []),
      jobRecord(input.taskId, assigned),
      stateRecord(
        input.taskId,
        occurrence.jobRunId,
        "dispatched",
        current.statusRevision + 1,
        envelope.assignmentId,
      ),
    ],
    value: envelope.assignmentId,
  };
}

export function selectReplayAssignment(
  facts: Pick<JobDecisionFacts, "assignment">,
  jobRunId: string,
): AssignedJob | undefined {
  const assignmentId = facts.assignment.getAssignmentIdForJob(jobRunId);
  const assigned =
    assignmentId === undefined
      ? undefined
      : facts.assignment.getAssigned(assignmentId);
  return assigned === undefined
    ? undefined
    : snapshot(assigned as unknown as AssignedJob);
}

export function selectPendingDispatches(
  facts: Pick<JobDecisionFacts, "assignment">,
): AssignedJob[] {
  const { assignment } = facts;
  return assignment
    .listOpenAssignmentIdsByCommit()
    .map((assignmentId) => assignment.getAssigned(assignmentId)!)
    .filter((assigned) => {
      const current = assignment.getRunState(assigned.record.jobRunId);
      return (
        current?.state === "dispatched" &&
        assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
          assigned.record.assignmentId &&
        !assigned.acked &&
        assignment.getSuperseded(assigned.record.assignmentId) === undefined
      );
    })
    .map((assigned) => snapshot(assigned as unknown as AssignedJob));
}

export function selectDispatchesAwaitingStarted(
  facts: Pick<JobDecisionFacts, "assignment">,
): AssignedJob[] {
  const { assignment } = facts;
  return assignment
    .listOpenAssignmentIdsByCommit()
    .map((assignmentId) => assignment.getAssigned(assignmentId)!)
    .filter((assigned) => {
      const assignmentId = assigned.record.assignmentId;
      return (
        assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
          assignmentId &&
        assignment.getRunState(assigned.record.jobRunId)?.state ===
          "dispatched" &&
        assignment.getSuperseded(assignmentId) === undefined
      );
    })
    .map((assigned) => snapshot(assigned as unknown as AssignedJob));
}

export function selectRecoveryCandidatesFromFacts(
  facts: Pick<JobDecisionFacts, "assignment" | "channel">,
  candidateIds: readonly string[],
): {
  readonly assignmentId: string;
  readonly state: JobRecoveryCandidate["state"];
  readonly stoppedProofKinds: readonly NotStartedProofKind[];
  readonly assigned: AssignedJob;
}[] {
  const { assignment, channel } = facts;
  return assignment
    .orderAssignmentIdsByCommit(candidateIds)
    .flatMap(
      (
        assignmentId,
      ): {
        readonly assignmentId: string;
        readonly state: JobRecoveryCandidate["state"];
        readonly stoppedProofKinds: readonly NotStartedProofKind[];
        readonly assigned: AssignedJob;
      }[] => {
      const assigned = assignment.getAssigned(assignmentId);
      if (!assigned) {
        throw corruptJobJournal("Recovery outbox names an unknown assignment");
      }
      const current = assignment.getRunState(assigned.record.jobRunId)?.state;
      const committed = channel.getCommitted(assignmentId);
      if (channel.hasBundleAckOutbox(assignmentId)) {
        if (
          current !== "committed" ||
          committed?.jobRunId !== assigned.record.jobRunId ||
          channel.getBundleAcknowledgement(assignmentId) !== undefined
        ) {
          throw corruptJobJournal(
            "Bundle acknowledgement outbox does not bind one pending committed assignment",
          );
        }
        return [
          {
            assignmentId,
            state: current,
            stoppedProofKinds: [],
            assigned: snapshot(assigned as unknown as AssignedJob),
          },
        ];
      }
      const isCurrent =
        assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
        assignmentId;
      if (
        !isCurrent ||
        assignment.getSuperseded(assignmentId) !== undefined ||
        (current !== "dispatched" &&
          current !== "running" &&
          current !== "cancel-requested" &&
          current !== "uncertain")
      ) {
        return [];
      }
      const open = assignment.getResolution(assigned.record.jobRunId);
      if (open && assignment.hasContainedFact(open.openFactDigest)) return [];
      const stoppedProofKinds =
        assignment.listPresentStoppedProofKinds(assignmentId);
      return [
        {
          assignmentId,
          state: current,
          stoppedProofKinds,
          assigned: snapshot(assigned as unknown as AssignedJob),
        },
      ];
    });
}

export function materializeRecoveryCandidates(
  facts: Pick<JobDecisionFacts, "assignment">,
  candidates: readonly {
    readonly assignmentId: string;
    readonly state: JobRecoveryCandidate["state"];
    readonly stoppedProofKinds: readonly NotStartedProofKind[];
    readonly assigned: DeepReadonly<AssignedJob>;
  }[],
  signer: ProtocolSigner,
): JobRecoveryCandidate[] {
  return candidates.map(({ assigned, ...candidate }) => ({
    ...candidate,
    dispatch: facts.assignment.materializeDispatch(assigned, signer),
  }));
}

export function decideAcknowledgeDispatch(
  facts: Pick<JobDecisionFacts, "assignment">,
  taskId: string,
  assignmentId: string,
): ProjectionTransactionDecision<unknown, void> {
  const assigned = facts.assignment.requireCurrentAssignment(assignmentId);
  if (assigned.acked) return { kind: "return", value: undefined };
  return {
    kind: "append",
    entries: [jobRecord(taskId, { t: "dispatch-acked", assignmentId })],
    value: undefined,
  };
}

export function decideRecordDispatchConflict(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly sent: PendingJobDispatch;
  readonly proof: DispatchConflictProof;
  readonly nextLsn: number;
  readonly openedAt: string;
  readonly facts: Pick<JobDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<
  unknown,
  "acked-original" | "opened-uncertain"
> {
  const { assignment } = input.facts;
  const { sent, proof } = input;
  const assignmentId = sent.assignmentId;
  const assigned = assignment.getAssigned(assignmentId);
  if (!assigned) {
    throw new Error("Dispatch conflict names an unknown assignment");
  }
  if (
    proof.assignmentId !== assignmentId ||
    proof.executorId !== assigned.record.executorId ||
    canonicalize(proof.conflictingDispatchRef) !==
      canonicalize(dispatchEnvelopeArtifact(sent.envelope).ref) ||
    proof.conflictingActivationDigest !==
      protocolDigest(
        "AssignmentActivationPayload",
        1,
        withoutSignature(sent.activation),
      )
  ) {
    throw new Error("Dispatch conflict proof does not bind the sent dispatch");
  }
  const existing = assignment.getConflict(assignmentId);
  if (existing) {
    if (
      canonicalize(withoutSignature(existing.proof)) !==
      canonicalize(withoutSignature(proof))
    ) {
      throw new Error("Assignment already has a different dispatch conflict");
    }
    return { kind: "return", value: existing.handling };
  }
  const current = assignment.getRunState(assigned.record.jobRunId);
  if (
    assignment.getAssignmentIdForJob(assigned.record.jobRunId) !==
      assignmentId ||
    current?.state !== "dispatched" ||
    assigned.acked
  ) {
    throw new Error("Dispatch conflict is invalid for the current job state");
  }
  const expectedActivation = buildJobActivationPayloadFromBinding({
    binding: {
      jobRunId: assigned.record.jobRunId,
      taskId: input.taskId,
      anchorEpoch: assigned.record.anchorEpoch,
      assignmentId,
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
  });
  const expectedDigest = protocolDigest(
    "AssignmentActivationPayload",
    1,
    expectedActivation,
  );
  const handling =
    canonicalize(proof.acceptedDispatchRef) ===
      canonicalize(assigned.record.dispatchRef) &&
    proof.acceptedActivationDigest === expectedDigest
      ? "acked-original"
      : "opened-uncertain";
  const entries: LogicalRecord<JobJournalRecord>[] = [
    jobRecord(input.taskId, {
      t: "dispatch-conflict",
      assignmentId,
      proof,
      handling,
    }),
  ];
  if (handling === "acked-original") {
    entries.push(jobRecord(input.taskId, { t: "dispatch-acked", assignmentId }));
  } else {
    const fact = openResolution(
      input.taskId,
      assigned.record.jobRunId,
      input.anchorEpoch,
      assignmentId,
      "dispatch-conflict",
      input.openedAt,
    );
    entries.push(
      jobRecord(input.taskId, {
        t: "resolution",
        jobRunId: assigned.record.jobRunId,
        fact,
      }),
      stateRecord(
        input.taskId,
        assigned.record.jobRunId,
        "uncertain",
        current.statusRevision + 1,
        assignmentId,
      ),
      jobRecord(input.taskId, {
        t: "cancel-fence",
        assignmentId,
        fenceSeq: input.nextLsn,
        requestId: `dispatch-conflict:${fact.openFactDigest}`,
      }),
      ...assignment.capabilityRevocationsFor(input.taskId, assigned),
    );
  }
  return { kind: "append", entries, value: handling };
}

export function decideReconcileStarted(
  facts: Pick<JobDecisionFacts, "assignment">,
  taskId: string,
  assignmentId: string,
): ProjectionTransactionDecision<unknown, void> {
  const assigned = facts.assignment.requireCurrentAssignment(assignmentId);
  const current = facts.assignment.getRunState(assigned.record.jobRunId);
  if (current?.state === "running" || current?.state === "committed") {
    return { kind: "return", value: undefined };
  }
  if (current?.state !== "dispatched") {
    throw new Error(
      "Started ledger snapshot is late for the current job state",
    );
  }
  return {
    kind: "append",
    entries: [
      ...(!assigned.acked
        ? [jobRecord(taskId, { t: "dispatch-acked", assignmentId })]
        : []),
      stateRecord(
        taskId,
        assigned.record.jobRunId,
        "running",
        current.statusRevision + 1,
        assignmentId,
      ),
    ],
    value: undefined,
  };
}

export function decideOpenInteractionSettlementFence(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly assignmentId: string;
  readonly settlement: Extract<
    JobJournalRecord,
    { readonly t: "interaction-settlement-fence" }
  >;
  readonly openedAt: string;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment, channel } = input.facts;
  const assignedState = assignment.requireCurrentAssignment(input.assignmentId);
  const current = assignment.getRunState(assignedState.record.jobRunId);
  if (!current) throw corruptJobJournal("Assigned job has no state");
  const existingFence = channel.getSettlementFence(input.assignmentId) as
    | Extract<JobJournalRecord, { readonly t: "interaction-settlement-fence" }>
    | undefined;
  if (existingFence) {
    if (!sameJobInteractionSettlement(existingFence, input.settlement)) {
      throw new Error(
        "Job cancellation evidence conflicts with its durable interaction settlement",
      );
    }
    return { kind: "return", value: undefined };
  }
  const existingResolution = assignment.getResolution(
    assignedState.record.jobRunId,
  );
  if (
    isOpenResolutionFact(existingResolution) &&
    existingResolution.cause !== "job-cancel-unknown"
  ) {
    throw new Error("Job occurrence already has a different uncertain fact");
  }
  if (
    current.state !== "dispatched" &&
    current.state !== "running" &&
    current.state !== "cancel-requested" &&
    !(
      current.state === "uncertain" &&
      isOpenResolutionFact(existingResolution) &&
      existingResolution.cause === "job-cancel-unknown"
    )
  ) {
    throw new Error(
      "Only an active or matching uncertain assignment can open interaction settlement",
    );
  }
  const entries: LogicalRecord<JobJournalRecord>[] = [];
  if (current.state !== "uncertain") {
    const fact = openResolution(
      input.taskId,
      assignedState.record.jobRunId,
      input.anchorEpoch,
      input.assignmentId,
      "job-cancel-unknown",
      input.openedAt,
    );
    entries.push(
      jobRecord(input.taskId, {
        t: "resolution",
        jobRunId: assignedState.record.jobRunId,
        fact,
      }),
      stateRecord(
        input.taskId,
        assignedState.record.jobRunId,
        "uncertain",
        current.statusRevision + 1,
        input.assignmentId,
      ),
    );
  }
  entries.push(jobRecord(input.taskId, input.settlement));
  return { kind: "append", entries, value: undefined };
}
