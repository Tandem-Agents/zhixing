import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type {
  AssignmentTerminationProof,
  CancelProofBody,
  LogicalRecord,
  SupersedeProof,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import type { ConversationAbortTicketAuthorizer } from "../../conversation-journal/contracts.js";
import { isOpenResolutionFact } from "../../conversation-run-contracts.js";
import {
  assertJobConflictContainmentReplayContract,
  corruptJobJournal,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import {
  classifyNotStartedTermination,
  decideTerminationReplayOrCurrentness,
  sameUnsignedTerminationProof,
} from "../../shared-protocol/not-started-termination.js";
import type {
  AssignedJob,
  JobCancelResult,
  JobResolutionFact,
  JobStateEntry,
  PendingJobFence,
  SystemJobResourceCoordinator,
} from "../contracts.js";
import {
  closeResolution,
  notStartedResolutionKind,
  notStartedTargetState,
  openResolution,
  recordsHaveJobState,
  terminationProofKind,
} from "../state/assignment-control.js";
import {
  isTerminal,
  jobRecord,
  jobStream,
  sameTerminationProofIdentity,
  snapshot,
  stateRecord,
} from "../state/common.js";
import type { DeepReadonly, JobDecisionFacts } from "../state/views.js";

export function decideCancelJob(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly requestId: string;
  readonly nextLsn: number;
  readonly authorize: (definition: TaskDefinition) => void;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly systemResources: SystemJobResourceCoordinator | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, JobCancelResult> {
  const { task, assignment } = input.facts;
  const definition = task.requireDefinition() as TaskDefinition;
  input.authorize(definition);
  const current = assignment.getRunState(input.jobRunId);
  if (!current) throw new Error("Cannot cancel an unknown job occurrence");
  const assignmentId = assignment.getAssignmentIdForJob(input.jobRunId);
  if (current.state === "queued") {
    const resourceRecords = task.prepareQueuedTerminalRecords(
      definition.definition.kind === "system"
        ? input.systemResources
        : input.resources,
      input.jobRunId,
      "cancelled",
    );
    return {
      kind: "append",
      entries: [
        ...resourceRecords,
        stateRecord(
          input.taskId,
          input.jobRunId,
          "cancelled",
          current.statusRevision + 1,
        ),
      ],
      value: { state: "cancelled" },
    };
  }
  if (
    assignmentId &&
    (current.state === "dispatched" || current.state === "running")
  ) {
    const existing = assignment.getCancelFence(assignmentId);
    if (existing) {
      if (existing.requestId !== input.requestId) {
        throw new Error("Assignment already has a different cancellation fence");
      }
      return {
        kind: "return",
        value: {
          state: "cancel-requested",
          assignmentId,
          fence: {
            fenceSeq: existing.fenceSeq,
            requestId: existing.requestId,
          },
        },
      };
    }
    const fence = { fenceSeq: input.nextLsn, requestId: input.requestId };
    return {
      kind: "append",
      entries: [
        jobRecord(input.taskId, {
          t: "cancel-fence",
          assignmentId,
          ...fence,
        }),
        ...assignment.dataPlaneTicketRevocationsFor(input.taskId, assignmentId),
        stateRecord(
          input.taskId,
          input.jobRunId,
          "cancel-requested",
          current.statusRevision + 1,
          assignmentId,
        ),
      ],
      value: { state: "cancel-requested", assignmentId, fence },
    };
  }
  if (current.state === "cancel-requested") {
    if (!assignmentId) {
      throw corruptJobJournal("Cancel-requested job has no current assignment");
    }
    const existing = assignment.getCancelFence(assignmentId);
    if (!existing) {
      throw corruptJobJournal("Cancel-requested job has no durable fence");
    }
    if (existing.requestId !== input.requestId) {
      throw new Error("Assignment already has a different cancellation fence");
    }
    return {
      kind: "return",
      value: {
        state: "cancel-requested",
        assignmentId,
        fence: {
          fenceSeq: existing.fenceSeq,
          requestId: existing.requestId,
        },
      },
    };
  }
  if (current.state === "cancelled") {
    return { kind: "return", value: { state: "cancelled" } };
  }
  return { kind: "return", value: { state: current.state } };
}

export function selectPendingCancellations(
  facts: Pick<JobDecisionFacts, "assignment">,
): PendingJobFence[] {
  const { assignment } = facts;
  return assignment
    .listOpenAssignmentIdsByCommit()
    .flatMap((assignmentId) => {
      const fence = assignment.getCancelFence(assignmentId);
      return fence ? [fence] : [];
    })
    .filter((fence) => {
      const assigned = assignment.getAssigned(fence.assignmentId);
      const current = assigned
        ? assignment.getRunState(assigned.record.jobRunId)
        : undefined;
      const openDigest = assigned
        ? assignment.getResolution(assigned.record.jobRunId)?.openFactDigest ?? ""
        : "";
      return (
        assigned !== undefined &&
        assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
          fence.assignmentId &&
        (current?.state === "cancel-requested" ||
          current?.state === "uncertain") &&
        assignment.getAcceptedCancellation(fence.assignmentId) === undefined &&
        assignment.getSuperseded(fence.assignmentId) === undefined &&
        !assignment.hasContainedFact(openDigest) &&
        assignment.getRejectedNotStarted(
          fence.assignmentId,
          "cancel-owner-fence",
        ) === undefined
      );
    })
    .map((fence) => ({
      assignmentId: fence.assignmentId,
      fence: { fenceSeq: fence.fenceSeq, requestId: fence.requestId },
    }));
}

export function decideRequestSupersede(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly requestId: string;
  readonly nextLsn: number;
  readonly facts: Pick<JobDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<unknown, PendingJobFence["fence"]> {
  const { assignment } = input.facts;
  const known = assignment.getAssigned(input.assignmentId);
  if (!known) {
    throw new Error("Supersede request names an unknown assignment");
  }
  const existing = assignment.getSupersedeRequest(input.assignmentId);
  if (existing) {
    if (existing.requestId !== input.requestId) {
      throw new Error("Assignment already has a different supersede request");
    }
    return {
      kind: "return",
      value: { fenceSeq: existing.fenceSeq, requestId: existing.requestId },
    };
  }
  const assigned = assignment.requireCurrentAssignment(input.assignmentId);
  const current = assignment.getRunState(assigned.record.jobRunId);
  if (current?.state !== "dispatched") {
    throw new Error("Only a dispatched assignment can be superseded");
  }
  const fence = { fenceSeq: input.nextLsn, requestId: input.requestId };
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        t: "supersede-requested",
        assignmentId: input.assignmentId,
        ...fence,
      }),
    ],
    value: fence,
  };
}

export function selectPendingSupersedes(
  facts: Pick<JobDecisionFacts, "assignment">,
): PendingJobFence[] {
  const { assignment } = facts;
  return assignment
    .listOpenAssignmentIdsByCommit()
    .flatMap((assignmentId) => {
      const request = assignment.getSupersedeRequest(assignmentId);
      return request ? [request] : [];
    })
    .filter((request) => {
      const assigned = assignment.getAssigned(request.assignmentId);
      const current = assigned
        ? assignment.getRunState(assigned.record.jobRunId)
        : undefined;
      return (
        assigned !== undefined &&
        assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
          request.assignmentId &&
        (current?.state === "dispatched" ||
          current?.state === "cancel-requested" ||
          current?.state === "uncertain") &&
        assignment.getSuperseded(request.assignmentId) === undefined &&
        assignment.getSupersedeStarted(request.assignmentId) === undefined &&
        assignment.getRejectedNotStarted(request.assignmentId, "supersede") ===
          undefined
      );
    })
    .map((request) => ({
      assignmentId: request.assignmentId,
      fence: { fenceSeq: request.fenceSeq, requestId: request.requestId },
    }));
}

export function decideMarkUncertain(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly assignmentId: string;
  readonly cause: Exclude<JobResolutionFact["cause"], "dispatch-conflict">;
  readonly openedAt: string;
  readonly facts: Pick<JobDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<unknown, JobResolutionFact> {
  const { assignment } = input.facts;
  const assigned = assignment.requireCurrentAssignment(input.assignmentId);
  const current = assignment.getRunState(assigned.record.jobRunId);
  if (!current) throw corruptJobJournal("Assigned job has no state");
  const existing = assignment.getResolution(assigned.record.jobRunId);
  if (isOpenResolutionFact(existing)) {
    if (existing.cause !== input.cause) {
      throw new Error("Job occurrence already has a different uncertain fact");
    }
    return {
      kind: "return",
      value: snapshot(existing as JobResolutionFact),
    };
  }
  if (
    current.state !== "dispatched" &&
    current.state !== "running" &&
    current.state !== "cancel-requested"
  ) {
    throw new Error("Only an active assignment can become uncertain");
  }
  const fact = openResolution(
    input.taskId,
    assigned.record.jobRunId,
    input.anchorEpoch,
    input.assignmentId,
    input.cause,
    input.openedAt,
  );
  return {
    kind: "append",
    entries: [
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
        input.assignmentId,
      ),
    ],
    value: fact,
  };
}

function buildJobRejectedNotStartedDecision(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly assigned: DeepReadonly<AssignedJob>;
  readonly proof: AssignmentTerminationProof;
  readonly current: JobStateEntry;
  readonly opensUncertain: boolean;
  readonly openedAt: string;
  readonly assignment: JobDecisionFacts["assignment"];
}): ProjectionTransactionDecision<unknown, void> {
  const entries: LogicalRecord<unknown>[] = [
    jobRecord(input.taskId, {
      t: "not-started-rejected",
      assignmentId: input.assigned.record.assignmentId,
      proof: input.proof,
    }),
  ];
  if (input.opensUncertain) {
    const fact = openResolution(
      input.taskId,
      input.assigned.record.jobRunId,
      input.anchorEpoch,
      input.assigned.record.assignmentId,
      "cause" in input.proof ? "job-cancel-unknown" : "ledger-unknown",
      input.openedAt,
    );
    entries.push(
      jobRecord(input.taskId, {
        t: "resolution",
        jobRunId: input.assigned.record.jobRunId,
        fact,
      }),
      ...input.assignment.capabilityRevocationsFor(
        input.taskId,
        input.assigned,
      ),
      stateRecord(
        input.taskId,
        input.assigned.record.jobRunId,
        "uncertain",
        input.current.statusRevision + 1,
        input.assigned.record.assignmentId,
      ),
    );
  }
  return { kind: "append", entries, value: undefined };
}

function buildJobAcceptedCancelProofDecision(input: {
  readonly taskId: string;
  readonly assigned: DeepReadonly<AssignedJob>;
  readonly proof: CancelProofBody;
  readonly current: JobStateEntry;
  readonly assignment: JobDecisionFacts["assignment"];
}): ProjectionTransactionDecision<unknown, void> {
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        t: "cancel-proof-accepted",
        assignmentId: input.assigned.record.assignmentId,
        proof: input.proof,
      }),
      ...input.assignment.capabilityRevocationsFor(
        input.taskId,
        input.assigned,
      ),
      stateRecord(
        input.taskId,
        input.assigned.record.jobRunId,
        "cancelled",
        input.current.statusRevision + 1,
        input.assigned.record.assignmentId,
      ),
    ],
    value: undefined,
  };
}

function buildJobAcceptedNotStartedDecision(input: {
  readonly taskId: string;
  readonly assigned: DeepReadonly<AssignedJob>;
  readonly proof: AssignmentTerminationProof;
  readonly current: JobStateEntry;
  readonly open: DeepReadonly<JobResolutionFact> | undefined;
  readonly closesOpenResolution: boolean;
  readonly closesDispatchConflict: boolean;
  readonly closedAt: string;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { task, assignment } = input.facts;
  const targetState = notStartedTargetState(
    task.definition?.state,
    input.current,
  );
  const entries: LogicalRecord<unknown>[] = [
    jobRecord(input.taskId, {
      t: "assignment-superseded",
      assignmentId: input.assigned.record.assignmentId,
      proof: input.proof,
    }),
    ...assignment.capabilityRevocationsFor(input.taskId, input.assigned),
    stateRecord(
      input.taskId,
      input.assigned.record.jobRunId,
      targetState,
      input.current.statusRevision + 1,
      input.assigned.record.assignmentId,
    ),
  ];
  if (input.closesOpenResolution && input.open) {
    if (input.closesDispatchConflict) {
      entries.unshift(
        jobRecord(input.taskId, {
          t: "dispatch-conflict-contained",
          assignmentId: input.assigned.record.assignmentId,
          openFactDigest: input.open.openFactDigest,
          proof: input.proof as
            | CancelProofBody
            | Extract<SupersedeProof, { decision: "not-started-fenced" }>,
        }),
      );
    }
    entries.push(
      jobRecord(input.taskId, {
        t: "resolution",
        jobRunId: input.assigned.record.jobRunId,
        fact: closeResolution(
          input.open as JobResolutionFact,
          notStartedResolutionKind(targetState),
          input.proof.executorId,
          input.closedAt,
        ),
      }),
    );
  }
  if (input.closesDispatchConflict && input.open) {
    const records = entries
      .filter((entry) => entry.stream === jobStream(input.taskId))
      .map((entry) => entry.body as JobJournalRecord);
    assertJobConflictContainmentReplayContract({
      proofDecision: "not-started",
      conflictOpen: true,
      hasAtomicSupersedeWithSameProof: records.some(
        (record) =>
          record.t === "assignment-superseded" &&
          record.assignmentId === input.assigned.record.assignmentId &&
          sameTerminationProofIdentity(record.proof, input.proof),
      ),
      hasAtomicResolutionClose: records.some(
        (record) =>
          record.t === "resolution" &&
          record.jobRunId === input.assigned.record.jobRunId &&
          record.fact.openFactDigest === input.open!.openFactDigest &&
          record.fact.resolution !== undefined,
      ),
      hasAtomicTargetState: recordsHaveJobState(
        records,
        input.assigned.record.jobRunId,
        targetState,
        input.current.statusRevision + 1,
        input.assigned.record.assignmentId,
      ),
      allCapabilitiesRevoked: assignment.allCapabilitiesRevoked(
        records,
        input.assigned,
      ),
    });
  }
  return { kind: "append", entries, value: undefined };
}

export function decideAcceptSupersedeProof(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly proof: SupersedeProof;
  readonly at: string;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment } = input.facts;
  const { proof } = input;
  const assigned = assignment.getAssigned(proof.assignmentId);
  if (!assigned) throw new Error("Supersede proof names an unknown assignment");
  if (
    !assignment.proofBindsSource(
      assigned,
      proof,
      input.anchorEpoch,
      input.legacyAbortTickets,
    )
  ) {
    throw new Error("Supersede proof does not bind the durable fence");
  }
  if (proof.decision === "not-started-fenced") {
    const replay = decideTerminationReplayOrCurrentness({
      domain: "job",
      entrypoint: "supersede",
      proof,
      durablePriorProofs: [assignment.getSuperseded(proof.assignmentId)?.proof],
      assignmentIsCurrent:
        assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
        proof.assignmentId,
      currentRunState: assignment.getRunState(assigned.record.jobRunId)?.state,
    });
    if (replay.kind === "conflicting-prior-proof") {
      throw new Error("Assignment already has a different termination proof");
    }
    if (replay.kind === "same-proof-replay") {
      return { kind: "return", value: undefined };
    }
    const current = assignment.getRunState(assigned.record.jobRunId);
    if (!current) throw corruptJobJournal("Supersede target has no state");
    if (replay.kind === "historical-assignment") {
      throw new Error("Supersede proof names a historical assignment");
    }
    const open = assignment.getResolution(assigned.record.jobRunId);
    const classified = classifyNotStartedTermination({
      domain: "job",
      entrypoint: "supersede",
      proof,
      proofKind: "supersede",
      currentRunState: current.state,
      existingRejectedNotStarted: assignment.getRejectedNotStarted(
        proof.assignmentId,
        "supersede",
      )?.proof,
      rejectionAlreadyCheckedInPriorProofs: false,
      hasDurableStartedObservation: assignment.hasDurableStarted(
        proof.assignmentId,
      ),
      openResolution: open
        ? {
            cause: open.cause,
            isOpen: open.resolution === undefined,
            conflictReceivedRecordSeq: assignment.getConflict(
              proof.assignmentId,
            )?.proof.receivedRecordSeq,
          }
        : undefined,
    });
    if (classified.kind === "same-proof-replay") {
      return { kind: "return", value: undefined };
    }
    if (classified.kind === "conflicting-prior-proof") {
      throw new Error(
        "Assignment already has a different durable termination proof",
      );
    }
    if (classified.kind === "missing-open-resolution") {
      throw corruptJobJournal("Uncertain job has no open resolution fact");
    }
    if (classified.kind === "conflict-seq-invalid") {
      throw new Error(
        "Conflict containment proof does not follow the received prefix",
      );
    }
    if (classified.kind === "late-for-state") {
      throw new Error("Supersede proof is invalid for the current state");
    }
    if (classified.kind === "contradictory-not-started") {
      return buildJobRejectedNotStartedDecision({
        taskId: input.taskId,
        anchorEpoch: input.anchorEpoch,
        assigned,
        proof,
        current,
        opensUncertain: classified.opensUncertain,
        openedAt: input.at,
        assignment,
      });
    }
    if (classified.kind !== "accepted-not-started") {
      throw corruptJobJournal("Unexpected supersede not-started classification");
    }
    return buildJobAcceptedNotStartedDecision({
      taskId: input.taskId,
      assigned,
      proof,
      current,
      open,
      closesOpenResolution: classified.closesOpenResolution,
      closesDispatchConflict: classified.closesDispatchConflict,
      closedAt: input.at,
      facts: input.facts,
    });
  }

  const observed = assignment.getSupersedeStarted(proof.assignmentId);
  if (observed) {
    if (!sameUnsignedTerminationProof(observed.proof as never, proof as never)) {
      throw new Error("Assignment already observed a different started proof");
    }
    return { kind: "return", value: undefined };
  }
  const current = assignment.getRunState(assigned.record.jobRunId);
  if (!current) throw corruptJobJournal("Supersede target has no state");
  if (
    assignment.getAssignmentIdForJob(assigned.record.jobRunId) !==
    proof.assignmentId
  ) {
    if (assignment.hasDurableStarted(proof.assignmentId)) {
      return { kind: "return", value: undefined };
    }
    throw new Error("Supersede proof names a historical assignment");
  }
  if (current.state === "running" || isTerminal(current.state)) {
    return { kind: "return", value: undefined };
  }
  if (current.state === "uncertain" || current.state === "cancel-requested") {
    return {
      kind: "append",
      entries: [
        jobRecord(input.taskId, {
          t: "supersede-started-observed",
          assignmentId: proof.assignmentId,
          proof,
        }),
      ],
      value: undefined,
    };
  }
  if (current.state !== "dispatched") {
    throw new Error("Already-started proof is invalid for the current state");
  }
  return {
    kind: "append",
    entries: [
      ...(!assigned.acked
        ? [
            jobRecord(input.taskId, {
              t: "dispatch-acked" as const,
              assignmentId: proof.assignmentId,
            }),
          ]
        : []),
      stateRecord(
        input.taskId,
        assigned.record.jobRunId,
        "running",
        current.statusRevision + 1,
        proof.assignmentId,
      ),
    ],
    value: undefined,
  };
}

export function decideAcceptDispatchRejection(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly proof: AssignmentTerminationProof;
  readonly at: string;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment } = input.facts;
  const { proof } = input;
  const assigned = assignment.getAssigned(proof.assignmentId);
  if (!assigned) {
    throw new Error("Dispatch rejection names an unknown assignment");
  }
  const current = assignment.getRunState(assigned.record.jobRunId);
  const replay = decideTerminationReplayOrCurrentness({
    domain: "job",
    entrypoint: "dispatch-rejection",
    proof,
    durablePriorProofs: [assignment.getSuperseded(proof.assignmentId)?.proof],
    assignmentIsCurrent:
      assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
      proof.assignmentId,
    currentRunState: current?.state,
  });
  if (replay.kind === "conflicting-prior-proof") {
    throw new Error("Assignment already has a different termination proof");
  }
  if (replay.kind === "same-proof-replay") {
    return { kind: "return", value: undefined };
  }
  if (
    replay.kind === "historical-assignment" ||
    !assignment.proofBindsSource(
      assigned,
      proof,
      input.anchorEpoch,
      input.legacyAbortTickets,
    ) ||
    (current?.state !== "dispatched" && current?.state !== "uncertain")
  ) {
    throw new Error("Dispatch rejection does not bind the current assignment");
  }
  const open = assignment.getResolution(assigned.record.jobRunId);
  const classified = classifyNotStartedTermination({
    domain: "job",
    entrypoint: "dispatch-rejection",
    proof,
    proofKind: "dispatch-rejection",
    currentRunState: current.state,
    existingRejectedNotStarted: assignment.getRejectedNotStarted(
      proof.assignmentId,
      "dispatch-rejection",
    )?.proof,
    rejectionAlreadyCheckedInPriorProofs: false,
    hasDurableStartedObservation: assignment.hasDurableStarted(
      proof.assignmentId,
    ),
    openResolution: open
      ? {
          cause: open.cause,
          isOpen: open.resolution === undefined,
        }
      : undefined,
  });
  if (classified.kind === "same-proof-replay") {
    return { kind: "return", value: undefined };
  }
  if (classified.kind === "conflicting-prior-proof") {
    throw new Error(
      "Assignment already has a different durable termination proof",
    );
  }
  if (classified.kind === "missing-open-resolution") {
    throw corruptJobJournal("Uncertain job has no open resolution fact");
  }
  if (classified.kind === "dispatch-rejection-cannot-close-conflict") {
    throw new Error(
      "Dispatch rejection cannot resolve an uncertain dispatch conflict",
    );
  }
  if (classified.kind === "contradictory-not-started") {
    return buildJobRejectedNotStartedDecision({
      taskId: input.taskId,
      anchorEpoch: input.anchorEpoch,
      assigned,
      proof,
      current,
      opensUncertain: classified.opensUncertain,
      openedAt: input.at,
      assignment,
    });
  }
  if (classified.kind !== "accepted-not-started") {
    throw corruptJobJournal(
      "Unexpected dispatch rejection not-started classification",
    );
  }
  return buildJobAcceptedNotStartedDecision({
    taskId: input.taskId,
    assigned,
    proof,
    current,
    open,
    closesOpenResolution: classified.closesOpenResolution,
    closesDispatchConflict: classified.closesDispatchConflict,
    closedAt: input.at,
    facts: input.facts,
  });
}

export function decideSubmitCancelProof(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly assignmentId: string;
  readonly proof: CancelProofBody;
  readonly at: string;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly authorizeReplay: () => void;
  readonly authorizeSettlement: () => void;
  readonly assertAssignmentUsageFinal: (
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: CancelProofBody["usageFinal"],
  ) => void;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment } = input.facts;
  const { assignmentId, proof } = input;
  const assigned = assignment.getAssigned(assignmentId);
  if (!assigned) {
    throw new Error("Cancel proof does not bind the job assignment authority");
  }
  if (
    !assignment.proofBindsSource(
      assigned,
      proof,
      input.anchorEpoch,
      input.legacyAbortTickets,
    )
  ) {
    throw new Error(
      proof.cause === "abort-ticket"
        ? "Abort proof does not bind an owner-issued abort ticket"
        : "Cancel proof does not bind the job assignment authority",
    );
  }
  const current = assignment.getRunState(assigned.record.jobRunId);
  const rejectedNotStarted = assignment.getRejectedNotStarted(
    assignmentId,
    terminationProofKind(proof),
  );
  const replay = decideTerminationReplayOrCurrentness({
    domain: "job",
    entrypoint: "cancel-proof",
    proof,
    durablePriorProofs: [
      assignment.getAcceptedCancellation(assignmentId)?.proof,
      assignment.getSuperseded(assignmentId)?.proof,
      assignment.getContainment(assignmentId)?.proof,
      rejectedNotStarted?.proof,
    ],
    assignmentIsCurrent:
      assignment.getAssignmentIdForJob(assigned.record.jobRunId) ===
      assignmentId,
    currentRunState: current?.state,
  });
  if (replay.kind === "conflicting-prior-proof") {
    throw new Error(
      "Assignment already has a different durable termination proof",
    );
  }
  if (replay.kind === "same-proof-replay") {
    input.authorizeReplay();
    return { kind: "return", value: undefined };
  }
  if (replay.kind === "historical-assignment") {
    throw new Error("Job operation names a historical assignment");
  }
  if (!current) throw corruptJobJournal("Cancel proof target has no state");
  input.authorizeSettlement();

  const open = assignment.getResolution(assigned.record.jobRunId);
  if (proof.decision === "not-started") {
    const classified = classifyNotStartedTermination({
      domain: "job",
      entrypoint: "cancel-proof",
      proof,
      proofKind: "cancel",
      currentRunState: current.state,
      existingRejectedNotStarted: rejectedNotStarted?.proof,
      rejectionAlreadyCheckedInPriorProofs: true,
      hasDurableStartedObservation: assignment.hasDurableStarted(assignmentId),
      openResolution: open
        ? {
            cause: open.cause,
            isOpen: open.resolution === undefined,
            alreadyContained: assignment.hasContainedFact(open.openFactDigest),
            conflictReceivedRecordSeq:
              assignment.getConflict(assignmentId)?.proof.receivedRecordSeq,
          }
        : undefined,
    });
    if (classified.kind === "unexpected-unreplayed-rejection") {
      throw corruptJobJournal(
        "Rejected not-started proof was not replayed durably",
      );
    }
    if (classified.kind === "missing-open-resolution") {
      throw corruptJobJournal("Uncertain job has no open resolution fact");
    }
    if (classified.kind === "conflict-seq-invalid") {
      throw new Error(
        "Conflict containment proof does not follow the received prefix",
      );
    }
    if (classified.kind === "unexpected-contained-fact") {
      throw corruptJobJournal("Contained cancel proof was not replayed durably");
    }
    if (classified.kind === "late-for-state") {
      throw new Error("Cancel proof is invalid for the current job state");
    }
    if (classified.kind === "contradictory-not-started") {
      return buildJobRejectedNotStartedDecision({
        taskId: input.taskId,
        anchorEpoch: input.anchorEpoch,
        assigned,
        proof,
        current,
        opensUncertain: classified.opensUncertain,
        openedAt: input.at,
        assignment,
      });
    }
    if (classified.kind !== "accepted-not-started") {
      throw corruptJobJournal(
        "Unexpected cancel proof not-started classification",
      );
    }
    input.assertAssignmentUsageFinal(
      assigned.record as Extract<JobJournalRecord, { t: "assigned" }>,
      proof.usageFinal,
    );
    if (classified.settlementRecord === "assignment-superseded") {
      return buildJobAcceptedNotStartedDecision({
        taskId: input.taskId,
        assigned,
        proof,
        current,
        open,
        closesOpenResolution: classified.closesOpenResolution,
        closesDispatchConflict: classified.closesDispatchConflict,
        closedAt: input.at,
        facts: input.facts,
      });
    }
    return buildJobAcceptedCancelProofDecision({
      taskId: input.taskId,
      assigned,
      proof,
      current,
      assignment,
    });
  }

  if (current.state === "uncertain") {
    if (!open || open.resolution) {
      throw corruptJobJournal("Uncertain job has no open resolution fact");
    }
    if (open.cause === "dispatch-conflict") {
      const conflict = assignment.getConflict(assignmentId);
      if (!conflict || proof.lastRecordSeq <= conflict.proof.receivedRecordSeq) {
        throw new Error(
          "Conflict containment proof does not follow the received prefix",
        );
      }
      if (assignment.hasContainedFact(open.openFactDigest)) {
        throw corruptJobJournal(
          "Contained cancel proof was not replayed durably",
        );
      }
      return {
        kind: "append",
        entries: [
          jobRecord(input.taskId, {
            t: "dispatch-conflict-contained",
            assignmentId,
            openFactDigest: open.openFactDigest,
            proof,
          }),
        ],
        value: undefined,
      };
    }
    if (assignment.hasContainedFact(open.openFactDigest)) {
      throw corruptJobJournal(
        "Contained cancel proof was not replayed durably",
      );
    }
    return {
      kind: "append",
      entries: [
        jobRecord(input.taskId, {
          t: "cancel-contained",
          assignmentId,
          openFactDigest: open.openFactDigest,
          proof,
        }),
      ],
      value: undefined,
    };
  }
  if (
    current.state !== "cancel-requested" &&
    !(
      proof.cause === "abort-ticket" &&
      (current.state === "dispatched" || current.state === "running")
    )
  ) {
    throw new Error("Cancel proof is invalid for the current job state");
  }
  input.assertAssignmentUsageFinal(
    assigned.record as Extract<JobJournalRecord, { t: "assigned" }>,
    proof.usageFinal,
  );
  return buildJobAcceptedCancelProofDecision({
    taskId: input.taskId,
    assigned,
    proof,
    current,
    assignment,
  });
}
