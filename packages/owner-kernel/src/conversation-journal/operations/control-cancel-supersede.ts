import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type {
  AssignmentTerminationProof,
  CancelProofBody,
  ControlResult,
  ControlResultBody,
  DispatchRejectionProof,
  GovernorRecord,
  LogicalRecord,
  SupersedeProof,
  TranscriptRunRecord,
  UncertainResolutionFact,
} from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import { hasPendingWorksceneTask } from "@zhixing-ai/core/workscene/application";
import type { ConversationControlEnvelope } from "../../control-admission.js";
import {
  assignmentTerminationProofKind,
  corruptRunJournal,
  isOpenResolutionFact,
} from "../../conversation-run-contracts.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import type {
  ConversationAbortTicketAuthorizer,
  ConversationCancelRequest,
  ConversationCancelResult,
  ConversationCommitLogRecord,
  ConversationUncertainResolutionFact,
  PendingConversationFence,
} from "../contracts.js";
import {
  closeResolution,
  createOpenResolutionFact,
} from "../state/assignment-control.js";
import { runRecord, snapshot, withoutSignature } from "../state/common.js";
import type { ConversationDecisionFacts } from "../state/views.js";
import { decideSessionWriteControl } from "./admission-input.js";

export function rejectedControl(
  code: import("@zhixing-ai/core/contracts").AuthorityError["code"],
  message: string,
): Extract<ControlResult, { status: "rejected" }> {
  return {
    v: 1,
    status: "rejected",
    error: { code, message, retryable: false },
  };
}

export function decideConversationCancel(input: {
  readonly conversationId: string;
  readonly request: ConversationCancelRequest;
  readonly nextLsn: number;
  readonly queuedTerminalRecords: readonly LogicalRecord<GovernorRecord>[];
  readonly facts: Pick<ConversationDecisionFacts, "assignment" | "tickets">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  ConversationCancelResult
> {
  const { assignment, tickets } = input.facts;
  const current = assignment.getRunState(input.request.runId);
  if (!current) throw new Error("Cannot cancel an unknown run");
  const assignmentId = assignment.getAssignmentIdForRun(input.request.runId);
  if (current.state === "queued") {
    return {
      kind: "append",
      entries: [
        ...input.queuedTerminalRecords,
        runRecord(input.conversationId, {
          t: "state",
          runId: input.request.runId,
          state: "cancelled",
          statusRevision: current.statusRevision + 1,
        }),
      ],
      value: { state: "cancelled", ...(assignmentId ? { assignmentId } : {}) },
    };
  }
  if (current.state === "cancel-requested") {
    if (!assignmentId) throw corruptRunJournal("Cancelling run has no assignment");
    const durableFence = assignment.getCancelFence(assignmentId);
    if (!durableFence) {
      throw corruptRunJournal("Cancelling run has no durable fence");
    }
    return {
      kind: "return",
      value: {
        state: "cancel-requested",
        assignmentId,
        fence: {
          fenceSeq: durableFence.fenceSeq,
          requestId: durableFence.requestId,
        },
      },
    };
  }
  if (current.state !== "dispatched" && current.state !== "running") {
    return { kind: "return", value: { state: current.state } };
  }
  if (!assignmentId) throw corruptRunJournal("Active run has no assignment");
  if (!assignment.hasAssigned(assignmentId)) {
    throw corruptRunJournal("Active assignment is missing");
  }
  const fence = { fenceSeq: input.nextLsn, requestId: input.request.requestId };
  const ticketRevocations = tickets
    .listUnrevokedTicketIds(assignmentId)
    .map((ticketId) =>
      runRecord(input.conversationId, {
        t: "ticket-revoked",
        ticketId,
      }),
    );
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "cancel-fence",
        assignmentId,
        ...fence,
      }),
      ...ticketRevocations,
      runRecord(input.conversationId, {
        t: "state",
        runId: input.request.runId,
        assignmentId,
        state: "cancel-requested",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: { state: "cancel-requested", assignmentId, fence },
  };
}

export function decideControlEnvelope(input: {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly envelope: ConversationControlEnvelope;
  readonly canonicalRequestId: string;
  readonly authorityAt: string;
  readonly nextLsn: number;
  readonly pendingWorkspaceControl: TranscriptRunRecord | undefined;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: ConversationDecisionFacts;
}): {
  readonly result: ControlResult;
  readonly authorityEntries?: readonly LogicalRecord<unknown>[];
} {
  const { session, assignment } = input.facts;
  const body = input.envelope.body;
  if (body.t === "session-write") {
    return decideSessionWriteControl({
      conversationId: input.conversationId,
      ownerEpoch: input.ownerEpoch,
      body,
      canonicalRequestId: input.canonicalRequestId,
      authorityAt: input.authorityAt,
      facts: input.facts,
    });
  }
  if (body.t === "cancel") {
    if (
      body.conversationId !== input.conversationId ||
      body.ownerEpoch !== input.ownerEpoch
    ) {
      return {
        result: rejectedControl(
          "epoch-stale",
          "Cancel request does not bind the current conversation owner",
        ),
      };
    }
    const current = assignment.getRunState(body.runId);
    const workspaceControl =
      session.getWorksceneControl(body.runId)?.record ??
      input.pendingWorkspaceControl;
    if (
      current?.state === "committed" &&
      hasPendingWorksceneTask(
        (workspaceControl ?? {}) as Parameters<typeof hasPendingWorksceneTask>[0],
      )
    ) {
      return {
        result: { v: 1, status: "ok", body: { t: "cancel", runState: "committed" } },
      };
    }
    if (
      !current ||
      (current.state !== "queued" &&
        current.state !== "dispatched" &&
        current.state !== "running")
    ) {
      return {
        result: rejectedControl(
          "fence-rejected",
          "Cancel request targets a closed or non-cancellable run",
        ),
      };
    }
    const decision = decideConversationCancel({
      conversationId: input.conversationId,
      request: { runId: body.runId, requestId: input.canonicalRequestId },
      nextLsn: input.nextLsn,
      queuedTerminalRecords:
        current.state === "queued"
          ? assignment.prepareQueuedTerminalRecords(
              input.resources,
              body.runId,
              "cancelled",
            )
          : [],
      facts: input.facts,
    });
    if (decision.kind !== "append") {
      throw corruptRunJournal(
        "Fresh cancel control did not produce an authority change",
      );
    }
    return {
      result: {
        v: 1,
        status: "ok",
        body: { t: "cancel", runState: decision.value.state },
      },
      authorityEntries: decision.entries,
    };
  }
  if (body.t === "cancel-batch") {
    if (
      body.conversationId !== input.conversationId ||
      body.ownerEpoch !== input.ownerEpoch
    ) {
      return {
        result: rejectedControl(
          "epoch-stale",
          "Batch cancel request does not bind the current conversation owner",
        ),
      };
    }
    const candidates = assignment.listCancellableRuns();
    const entries: LogicalRecord<ConversationCommitLogRecord>[] = [];
    const runs: Extract<ControlResultBody, { t: "cancel-batch" }>["runs"] = [];
    for (const candidate of candidates) {
      const decision = decideConversationCancel({
        conversationId: input.conversationId,
        request: {
          runId: candidate.runId,
          requestId: input.canonicalRequestId,
        },
        nextLsn: input.nextLsn + entries.length,
        queuedTerminalRecords:
          candidate.state === "queued"
            ? assignment.prepareQueuedTerminalRecords(
                input.resources,
                candidate.runId,
                "cancelled",
              )
            : [],
        facts: input.facts,
      });
      if (decision.kind === "append") entries.push(...decision.entries);
      runs.push({
        runId: candidate.runId,
        runState: decision.value.state,
        source: candidate.source,
        ingressId: candidate.ingressId,
      });
    }
    return {
      result: {
        v: 1,
        status: "ok",
        body: {
          t: "cancel-batch",
          conversationId: input.conversationId,
          runs,
        },
      },
      authorityEntries: entries,
    };
  }

  if (
    body.ref.execution !== "conversation" ||
    body.ref.conversationId !== input.conversationId ||
    body.ref.ownerEpoch !== input.ownerEpoch
  ) {
    return {
      result: rejectedControl(
        "epoch-stale",
        "Uncertain resolution does not bind the current conversation owner",
      ),
    };
  }
  const current = assignment.getRunState(body.ref.runId);
  const open = assignment.getResolution(body.ref.runId);
  const assignmentId = open?.subject.assignmentId;
  const assigned = assignmentId
    ? assignment.getAssigned(assignmentId)
    : undefined;
  if (
    !current ||
    current.state !== "uncertain" ||
    !open ||
    open.resolution !== undefined ||
    open.openFactDigest !== body.openFactDigest ||
    !assigned ||
    assigned.record.runId !== body.ref.runId
  ) {
    return {
      result: rejectedControl(
        "fence-rejected",
        "Uncertain resolution targets a closed or different fact",
      ),
    };
  }
  const nextState =
    body.decision === "user-verified-side-effects"
      ? "failed"
      : body.decision === "user-abandoned"
        ? "cancelled"
        : "queued";
  const fact = closeResolution(
    open,
    body.decision,
    input.envelope.principal.surfacePrincipal,
    input.envelope.at,
  );
  return {
    result: {
      v: 1,
      status: "ok",
      body: {
        t: "uncertain-resolve",
        state: nextState,
        factDigest: fact.resolution!.factDigest,
      },
    },
    authorityEntries: [
      runRecord(input.conversationId, {
        t: "resolution",
        runId: body.ref.runId,
        fact,
      }),
      ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
      runRecord(input.conversationId, {
        t: "state",
        runId: body.ref.runId,
        assignmentId,
        state: nextState,
        statusRevision: current.statusRevision + 1,
      }),
    ],
  };
}

export function decideRequestSupersede(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly requestId: string;
  readonly nextLsn: number;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  PendingConversationFence["fence"]
> {
  const { assignment } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
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
  const current = assigned
    ? assignment.getRunState(assigned.record.runId)
    : undefined;
  if (
    !assigned ||
    !current ||
    current.state !== "dispatched" ||
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
      input.assignmentId
  ) {
    throw new Error("Only a dispatched assignment can be superseded");
  }
  const fence = { fenceSeq: input.nextLsn, requestId: input.requestId };
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "supersede-requested",
        assignmentId: input.assignmentId,
        ...fence,
      }),
    ],
    value: fence,
  };
}

export function decideAcceptSupersedeAlreadyStarted(input: {
  readonly conversationId: string;
  readonly proof: Extract<SupersedeProof, { decision: "already-started" }>;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const { proof } = input;
  const assigned = assignment.getAssigned(proof.assignmentId);
  if (
    !assigned ||
    !assignment.proofBindsSource(
      assigned,
      proof,
      input.conversationId,
      input.legacyAbortTickets,
    )
  ) {
    throw new Error("Supersede proof does not bind a durable assignment");
  }
  const observed = assignment.getSupersedeStartedObservation(
    proof.assignmentId,
  );
  if (observed) {
    if (
      canonicalize(withoutSignature(observed.proof)) !==
      canonicalize(withoutSignature(proof))
    ) {
      throw new Error(
        "Supersede already-started observation has conflicting payloads",
      );
    }
    return { kind: "return", value: undefined };
  }
  const current = assignment.getRunState(assigned.record.runId);
  if (!current) throw corruptRunJournal("Assigned run has no state");
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    proof.assignmentId
  ) {
    throw new Error("Supersede proof belongs to a historical assignment");
  }
  if (
    current.state === "running" ||
    current.state === "committed" ||
    current.state === "cancelled"
  ) {
    return { kind: "return", value: undefined };
  }
  if (current.state === "uncertain" || current.state === "cancel-requested") {
    return {
      kind: "append",
      entries: [
        runRecord(input.conversationId, {
          t: "supersede-started-observed",
          assignmentId: proof.assignmentId,
          proof,
        }),
      ],
      value: undefined,
    };
  }
  if (current.state !== "dispatched") {
    throw new Error("Already-started proof is late for the current run state");
  }
  return {
    kind: "append",
    entries: [
      ...(!assigned.acked
        ? [
            runRecord(input.conversationId, {
              t: "dispatch-acked" as const,
              assignmentId: proof.assignmentId,
            }),
          ]
        : []),
      runRecord(input.conversationId, {
        t: "state",
        runId: assigned.record.runId,
        assignmentId: proof.assignmentId,
        state: "running",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: undefined,
  };
}

export function decideAcceptNotStartedTermination(input: {
  readonly conversationId: string;
  readonly proof:
    | DispatchRejectionProof
    | Extract<SupersedeProof, { decision: "not-started-fenced" }>;
  readonly at: string;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const { proof } = input;
  const assigned = assignment.getAssigned(proof.assignmentId);
  if (
    !assigned ||
    !assignment.proofBindsSource(
      assigned,
      proof,
      input.conversationId,
      input.legacyAbortTickets,
    )
  ) {
    throw new Error("Termination proof does not bind a durable assignment");
  }
  const prior = assignment.getSuperseded(proof.assignmentId);
  if (prior) {
    if (
      canonicalize(withoutSignature(prior.proof)) !==
      canonicalize(withoutSignature(proof))
    ) {
      throw new Error("Assignment already has a different termination proof");
    }
    return { kind: "return", value: undefined };
  }
  const current = assignment.getRunState(assigned.record.runId);
  if (!current) {
    throw corruptRunJournal("Terminated assignment has no run state");
  }
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    proof.assignmentId
  ) {
    throw new Error("Termination proof belongs to a historical assignment");
  }
  const open = assignment.getResolution(assigned.record.runId);
  const kind = assignmentTerminationProofKind(proof);
  const conflictsWithReceived =
    kind === "dispatch-rejection" && open?.cause === "dispatch-conflict";
  if (
    assignment.hasDurableStarted(proof.assignmentId) ||
    conflictsWithReceived
  ) {
    const existing = assignment.getRejectedNotStarted(proof.assignmentId, kind);
    if (existing) {
      if (
        canonicalize(withoutSignature(existing.proof)) !==
        canonicalize(withoutSignature(proof))
      ) {
        throw new Error(
          "Assignment already rejected a different not-started proof",
        );
      }
      return { kind: "return", value: undefined };
    }
    const rejection = runRecord(input.conversationId, {
      t: "not-started-rejected",
      assignmentId: proof.assignmentId,
      proof,
    });
    if (current.state === "uncertain") {
      if (!open || open.resolution) {
        throw corruptRunJournal("Uncertain run has no open resolution fact");
      }
      return { kind: "append", entries: [rejection], value: undefined };
    }
    if (
      current.state !== "dispatched" &&
      current.state !== "running" &&
      current.state !== "cancel-requested"
    ) {
      throw new Error("Termination proof is late for the current run state");
    }
    const fact = createOpenResolutionFact(assigned, "ledger-unknown", input.at);
    return {
      kind: "append",
      entries: [
        rejection,
        runRecord(input.conversationId, {
          t: "resolution",
          runId: assigned.record.runId,
          fact,
        }),
        ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
        runRecord(input.conversationId, {
          t: "state",
          runId: assigned.record.runId,
          assignmentId: proof.assignmentId,
          state: "uncertain",
          statusRevision: current.statusRevision + 1,
        }),
      ],
      value: undefined,
    };
  }
  if (
    current.state !== "dispatched" &&
    current.state !== "uncertain" &&
    current.state !== "cancel-requested"
  ) {
    throw new Error("Termination proof is late for the current run state");
  }
  if (current.state === "uncertain" && (!open || open.resolution)) {
    throw corruptRunJournal("Uncertain run has no open resolution fact");
  }
  let containment: LogicalRecord<ConversationCommitLogRecord> | undefined;
  if (open?.cause === "dispatch-conflict") {
    if (kind !== "supersede") {
      throw new Error(
        "Dispatch rejection cannot resolve a received dispatch conflict",
      );
    }
    const containmentProof = proof as Extract<
      SupersedeProof,
      { decision: "not-started-fenced" }
    >;
    const conflict = assignment.getConflictByAssignment(
      containmentProof.assignmentId,
    );
    if (
      !conflict ||
      containmentProof.lastRecordSeq <= conflict.proof.receivedRecordSeq
    ) {
      throw new Error(
        "Conflict containment proof does not follow the received prefix",
      );
    }
    containment = runRecord(input.conversationId, {
      t: "dispatch-conflict-contained",
      assignmentId: containmentProof.assignmentId,
      openFactDigest: open.openFactDigest,
      proof: containmentProof,
    });
  }
  const entries: LogicalRecord<ConversationCommitLogRecord>[] = [
    ...(containment ? [containment] : []),
    runRecord(input.conversationId, {
      t: "assignment-superseded",
      assignmentId: proof.assignmentId,
      proof,
    }),
    ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
  ];
  if (open && !open.resolution) {
    entries.push(
      runRecord(input.conversationId, {
        t: "resolution",
        runId: assigned.record.runId,
        fact: closeResolution(
          open,
          "proven-not-started-redispatched",
          proof.executorId,
          input.at,
        ),
      }),
    );
  }
  entries.push(
    runRecord(input.conversationId, {
      t: "state",
      runId: assigned.record.runId,
      assignmentId: proof.assignmentId,
      state: current.state === "cancel-requested" ? "cancelled" : "queued",
      statusRevision: current.statusRevision + 1,
    }),
  );
  return { kind: "append", entries, value: undefined };
}

export function decideSubmitCancelProof(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly proof: CancelProofBody;
  readonly at: string;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly authorizeReplay: () => void;
  readonly authorizeSettlement: () => void;
  readonly assertResourceUsageFinal: (
    assigned: {
      readonly assignmentId: string;
      readonly executorId: string;
      readonly reservation: { readonly reservationId: string };
    },
    usageFinal: CancelProofBody["usageFinal"],
  ) => void;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const { proof, assignmentId } = input;
  const assigned = assignment.getAssigned(assignmentId);
  if (!assigned) {
    throw new Error("Cancel proof does not bind the durable assignment authority");
  }
  if (
    !assignment.proofBindsSource(
      assigned,
      proof,
      input.conversationId,
      input.legacyAbortTickets,
    )
  ) {
    throw new Error(
      proof.cause === "abort-ticket"
        ? "Abort proof does not bind an owner-issued abort ticket"
        : "Cancel proof does not bind the durable assignment authority",
    );
  }
  const current = assignment.getRunState(assigned.record.runId);
  if (!current) throw corruptRunJournal("Cancelled assignment has no run state");
  const accepted = assignment.getAcceptedCancellation(assignmentId);
  const prior = assignment.getSuperseded(assignmentId);
  const containment = assignment.getContainmentByAssignment(assignmentId);
  const rejectedNotStarted = assignment.getRejectedNotStarted(
    assignmentId,
    "cancel",
  );
  const durableProofs = [
    accepted?.proof,
    prior?.proof,
    containment?.proof,
    rejectedNotStarted?.proof,
  ].filter(
    (candidate): candidate is AssignmentTerminationProof | CancelProofBody =>
      candidate !== undefined,
  );
  if (durableProofs.length > 0) {
    if (
      durableProofs.some(
        (candidate) =>
          canonicalize(withoutSignature(candidate)) !==
          canonicalize(withoutSignature(proof)),
      )
    ) {
      throw new Error(
        "Assignment already has a different durable termination proof",
      );
    }
    input.authorizeReplay();
    return { kind: "return", value: undefined };
  }
  if (assignment.getAssignmentIdForRun(assigned.record.runId) !== assignmentId) {
    throw new Error("Cancel proof belongs to a historical assignment");
  }
  if (current.state === "cancelled" || current.state === "committed") {
    throw new Error("Cancel proof has no matching durable terminal fact");
  }
  input.authorizeSettlement();

  const open = assignment.getResolution(assigned.record.runId);
  const contradictoryNotStarted =
    proof.decision === "not-started" &&
    assignment.hasDurableStarted(assignmentId);
  if (contradictoryNotStarted) {
    const existingRejection = assignment.getRejectedNotStarted(
      assignmentId,
      "cancel",
    );
    if (existingRejection) {
      throw corruptRunJournal(
        "Rejected not-started proof was not replayed durably",
      );
    }
    const rejection = runRecord(input.conversationId, {
      t: "not-started-rejected",
      assignmentId,
      proof,
    });
    if (current.state === "uncertain") {
      return { kind: "append", entries: [rejection], value: undefined };
    }
    const fact = createOpenResolutionFact(assigned, "cancel-unproven", input.at);
    return {
      kind: "append",
      entries: [
        rejection,
        runRecord(input.conversationId, {
          t: "resolution",
          runId: assigned.record.runId,
          fact,
        }),
        ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
        runRecord(input.conversationId, {
          t: "state",
          runId: assigned.record.runId,
          assignmentId,
          state: "uncertain",
          statusRevision: current.statusRevision + 1,
        }),
      ],
      value: undefined,
    };
  }
  if (current.state === "uncertain") {
    if (!open || open.resolution) {
      throw corruptRunJournal(
        "Uncertain cancellation has no open resolution fact",
      );
    }
    const conflict = open.cause === "dispatch-conflict";
    if (conflict) {
      const conflictRecord = assignment.getConflictByAssignment(assignmentId);
      if (
        !conflictRecord ||
        proof.lastRecordSeq <= conflictRecord.proof.receivedRecordSeq
      ) {
        throw new Error(
          "Conflict containment proof does not follow the received prefix",
        );
      }
    }
    const requiresContainment = conflict || proof.decision === "halted";
    if (requiresContainment && assignment.hasContainedFact(open.openFactDigest)) {
      throw corruptRunJournal("Contained cancel proof was not replayed durably");
    }
    const containmentRecord = requiresContainment
      ? runRecord(input.conversationId, {
          t: conflict ? "dispatch-conflict-contained" : "cancel-contained",
          assignmentId,
          openFactDigest: open.openFactDigest,
          proof,
        })
      : undefined;
    if (proof.decision === "halted") {
      return { kind: "append", entries: [containmentRecord!], value: undefined };
    }
    input.assertResourceUsageFinal(assigned.record, proof.usageFinal);
    const resolved = closeResolution(
      open,
      "proven-not-started-redispatched",
      proof.executorId,
      input.at,
    );
    return {
      kind: "append",
      entries: [
        ...(containmentRecord ? [containmentRecord] : []),
        runRecord(input.conversationId, {
          t: "assignment-superseded",
          assignmentId,
          proof,
        }),
        runRecord(input.conversationId, {
          t: "resolution",
          runId: assigned.record.runId,
          fact: resolved,
        }),
        ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
        runRecord(input.conversationId, {
          t: "state",
          runId: assigned.record.runId,
          assignmentId,
          state: "queued",
          statusRevision: current.statusRevision + 1,
        }),
      ],
      value: undefined,
    };
  }

  if (
    current.state !== "cancel-requested" &&
    current.state !== "dispatched" &&
    current.state !== "running"
  ) {
    throw new Error("Cancel proof is late for the current run state");
  }
  input.assertResourceUsageFinal(assigned.record, proof.usageFinal);
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "cancel-proof-accepted",
        assignmentId,
        proof,
      }),
      ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
      runRecord(input.conversationId, {
        t: "state",
        runId: assigned.record.runId,
        assignmentId,
        state: "cancelled",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: undefined,
  };
}

export function decideMarkAssignmentUncertain(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly cause: "ledger-unknown" | "cancel-unproven";
  readonly openedAt: string;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<
  ConversationCommitLogRecord,
  UncertainResolutionFact
> {
  const { assignment } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  if (!assigned) throw new Error("Cannot mark an unknown assignment uncertain");
  const current = assignment.getRunState(assigned.record.runId);
  if (!current) throw corruptRunJournal("Assigned run has no state");
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    input.assignmentId
  ) {
    throw new Error("Cannot reopen uncertainty for a historical assignment");
  }
  const existing = assignment.getResolution(assigned.record.runId);
  if (
    current.state === "uncertain" &&
    isOpenResolutionFact(existing as ConversationUncertainResolutionFact | undefined)
  ) {
    return {
      kind: "return",
      value: snapshot(existing, "Uncertain resolution fact") as UncertainResolutionFact,
    };
  }
  if (
    current.state !== "dispatched" &&
    current.state !== "running" &&
    current.state !== "cancel-requested"
  ) {
    throw new Error("Run state cannot enter uncertain");
  }
  const fact = createOpenResolutionFact(assigned, input.cause, input.openedAt);
  return {
    kind: "append",
    entries: [
      runRecord(input.conversationId, {
        t: "resolution",
        runId: assigned.record.runId,
        fact,
      }),
      runRecord(input.conversationId, {
        t: "state",
        runId: assigned.record.runId,
        assignmentId: input.assignmentId,
        state: "uncertain",
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: fact,
  };
}

export function decideCloseQueuedRun(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly outcome: "failed" | "expired";
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment } = input.facts;
  const current = assignment.getRunState(input.runId);
  if (current?.state === input.outcome) {
    return { kind: "return", value: undefined };
  }
  if (
    current?.state !== "queued" ||
    assignment.getAssignmentIdForRun(input.runId) !== undefined
  ) {
    throw new Error("Only an unassigned queued run can be closed");
  }
  return {
    kind: "append",
    entries: [
      ...assignment.prepareQueuedTerminalRecords(
        input.resources,
        input.runId,
        input.outcome,
      ),
      runRecord(input.conversationId, {
        t: "state",
        runId: input.runId,
        state: input.outcome,
        statusRevision: current.statusRevision + 1,
      }),
    ],
    value: undefined,
  };
}

export function decideFailAssignedRun(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly boundedReason: string | undefined;
  readonly usageFinal:
    | { readonly reportDigest: string; readonly upToUsageSeq: number }
    | undefined;
  readonly facts: Pick<ConversationDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { assignment } = input.facts;
  const current = assignment.getRunState(input.runId);
  if (current?.state === "failed") {
    return { kind: "return", value: undefined };
  }
  const assigned = assignment.getAssigned(input.assignmentId);
  if (
    !assigned ||
    assigned.record.runId !== input.runId ||
    assignment.getAssignmentIdForRun(input.runId) !== input.assignmentId ||
    (current?.state !== "dispatched" && current?.state !== "running")
  ) {
    throw new Error(
      "Only the current active assignment may report execution failure",
    );
  }
  return {
    kind: "append",
    entries: [
      ...assignment.capabilityRevocationsFor(input.conversationId, assigned),
      runRecord(input.conversationId, {
        t: "state",
        runId: input.runId,
        assignmentId: input.assignmentId,
        state: "failed",
        statusRevision: current.statusRevision + 1,
        ...(input.boundedReason ? { reason: input.boundedReason } : {}),
        ...(input.usageFinal
          ? { usageFinal: snapshot(input.usageFinal, "Failed run final usage") }
          : {}),
      }),
    ],
    value: undefined,
  };
}
