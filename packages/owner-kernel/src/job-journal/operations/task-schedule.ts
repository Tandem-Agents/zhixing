import type {
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import type {
  ControlResult,
  GovernorRecord,
  JobOccurrence,
  JobRunState,
  LogicalRecord,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  compareJobOccurrences,
  validateJobOccurrence,
} from "@zhixing-ai/core/protocol";
import {
  decideScheduleCapabilityGap,
  type ScheduleOccurrence,
} from "@zhixing-ai/core/scheduler/application";
import type {
  AtomicControlApplicationContext,
  JobControlEnvelope,
} from "../../control-admission.js";
import type { Stored } from "../../conversation-run-contracts.js";
import {
  assertJobAdmissionReplayContract,
  assertJobOccurrenceReplayContract,
  assertSystemMissCoalescedReplayContract,
  corruptJobJournal,
  taskCreationProvenanceMatches,
  taskRevisionReplayViolation,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import type { SchedulerUserNoticeJournal } from "../../scheduler-user-notices.js";
import type {
  JobSchedulerReadView,
  SystemJobResourceCoordinator,
} from "../contracts.js";
import {
  closeResolution,
  taskRevisionAtomicFacts,
} from "../state/assignment-control.js";
import {
  isTerminal,
  jobRecord,
  jobStream,
  rejectedControl,
  snapshot,
  stateRecord,
} from "../state/common.js";
import {
  createManualJobRunId,
  deliveryPlan,
  requireControlIngress,
  taskRevisionRecord,
  taskRevisionStopsAssigned,
  taskRevisionStopsQueued,
  throwTaskDefinitionViolation,
} from "../state/task-schedule.js";
import type { JobDecisionFacts, JobTaskScheduleFacts } from "../state/views.js";

export function selectTaskMutationRevision(
  task: JobTaskScheduleFacts,
  operationId: string,
  operationDigest: string,
): number | undefined {
  const receipt = task.getTaskOperation(operationId);
  if (!receipt) return undefined;
  if (receipt.digest !== operationDigest) {
    throw new Error("Task mutation operation id has a conflicting payload");
  }
  return receipt.taskRevision;
}

export function decideDefineTask(input: {
  readonly taskId: string;
  readonly candidate: TaskDefinition;
  readonly stored: Stored<TaskDefinition>;
  readonly policy?: {
    readonly kind: "legacy-import";
    readonly nextFire: string;
    readonly scheduleDigest: string;
    readonly legacyDigest: string;
  };
  readonly operation?: {
    readonly operationId: string;
    readonly operationDigest: string;
    readonly expectedRevision?: number;
  };
  readonly nextLsn: number;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly systemResources: SystemJobResourceCoordinator | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<
  unknown,
  { readonly taskRevision: number; readonly replayed: boolean }
> {
  const { task, assignment } = input.facts;
  const { candidate, operation, policy } = input;
  if (operation) {
    const replay = task.getTaskOperation(operation.operationId);
    if (replay) {
      if (replay.digest !== operation.operationDigest) {
        throw new Error("Task mutation operation id has a conflicting payload");
      }
      return {
        kind: "return",
        value: { taskRevision: replay.taskRevision, replayed: true },
      };
    }
  }
  const current = task.definition as TaskDefinition | undefined;
  if (
    operation?.expectedRevision !== undefined &&
    current?.taskRevision !== operation.expectedRevision
  ) {
    throw new Error("Schedule task revision conflict");
  }
  if (current && canonicalize(current) === canonicalize(candidate)) {
    return {
      kind: "return",
      value: { taskRevision: current.taskRevision, replayed: true },
    };
  }
  if (current && !taskCreationProvenanceMatches(current, candidate)) {
    throw new Error("Task creation provenance is immutable");
  }
  const entries: LogicalRecord<JobJournalRecord | GovernorRecord>[] = [
    jobRecord(
      input.taskId,
      taskRevisionRecord(candidate, input.stored, operation),
    ),
  ];
  if (policy) {
    entries.push(
      jobRecord(input.taskId, {
        t: "legacy-next-fire",
        taskRevision: candidate.taskRevision,
        nextFire: policy.nextFire,
        scheduleDigest: policy.scheduleDigest,
        legacyDigest: policy.legacyDigest,
      }),
    );
  }
  const activeJobRunId = assignment.activeJobRunId;
  if (taskRevisionStopsQueued(candidate) && activeJobRunId) {
    const active = assignment.getRunState(activeJobRunId);
    const assignmentId = assignment.getAssignmentIdForJob(activeJobRunId);
    if (active?.state === "queued") {
      const resourceRecords = task.prepareQueuedTerminalRecords(
        candidate.definition.kind === "system"
          ? input.systemResources
          : input.resources,
        activeJobRunId,
        "cancelled",
      );
      entries.push(
        ...resourceRecords,
        stateRecord(
          input.taskId,
          activeJobRunId,
          "cancelled",
          active.statusRevision + 1,
        ),
      );
    } else if (
      taskRevisionStopsAssigned(candidate) &&
      assignmentId &&
      (active?.state === "dispatched" || active?.state === "running")
    ) {
      entries.push(
        jobRecord(input.taskId, {
          t: "cancel-fence",
          assignmentId,
          fenceSeq: input.nextLsn,
          requestId: `task-revision:${candidate.taskRevision}`,
        }),
        ...assignment.dataPlaneTicketRevocationsFor(input.taskId, assignmentId),
        stateRecord(
          input.taskId,
          activeJobRunId,
          "cancel-requested",
          active.statusRevision + 1,
          assignmentId,
        ),
      );
    } else if (
      taskRevisionStopsAssigned(candidate) &&
      assignmentId &&
      active?.state === "uncertain" &&
      assignment.getCancelFence(assignmentId) === undefined
    ) {
      entries.push(
        jobRecord(input.taskId, {
          t: "cancel-fence",
          assignmentId,
          fenceSeq: input.nextLsn,
          requestId: `task-revision:${candidate.taskRevision}`,
        }),
        ...assignment.dataPlaneTicketRevocationsFor(input.taskId, assignmentId),
      );
    }
  }
  const active = activeJobRunId
    ? assignment.getRunState(activeJobRunId)
    : undefined;
  const atomicFacts = taskRevisionAtomicFacts({
    records: entries
      .filter(
        (entry): entry is LogicalRecord<JobJournalRecord> =>
          entry.stream === jobStream(input.taskId),
      )
      .map((entry) => entry.body),
    taskRevision: candidate.taskRevision,
    activeJobRunId,
    active,
    assignmentId: activeJobRunId
      ? assignment.getAssignmentIdForJob(activeJobRunId)
      : undefined,
    cancelFences: {
      has: (assignmentId: string) =>
        assignment.getCancelFence(assignmentId) !== undefined,
    },
    envelopeLsn: input.nextLsn,
  });
  const violation = taskRevisionReplayViolation({
    taskIdMatches: candidate.taskId === input.taskId,
    taskRevision: candidate.taskRevision,
    state: candidate.state,
    kind: candidate.definition.kind,
    previousRevision: current?.taskRevision,
    previousState: current?.state,
    previousKind: current?.definition.kind,
    activeState: active?.state,
    ...atomicFacts,
  });
  if (violation !== undefined) throwTaskDefinitionViolation(violation);
  return {
    kind: "append",
    entries,
    value: { taskRevision: candidate.taskRevision, replayed: false },
  };
}

export function decideTriggerOccurrence(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly scheduledFor: string;
  readonly source: "user" | "system";
  readonly disposition?: "due" | "missed-offline";
  readonly missedNextFire?: {
    readonly readyBoundary: string;
    readonly nextFire?: string;
  };
  readonly authorize: (definition: TaskDefinition) => void;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, JobOccurrence> {
  const { task, assignment } = input.facts;
  const definition = task.requireDefinition() as TaskDefinition;
  if (definition.definition.kind !== input.source) {
    throw new Error("Trigger source does not match the task definition kind");
  }
  input.authorize(definition);
  const existing = task.getOccurrence(input.jobRunId) as
    | JobOccurrence
    | undefined;
  if (existing) {
    if (existing.scheduledFor !== input.scheduledFor) {
      throw new Error("Job occurrence id has a conflicting schedule time");
    }
    return { kind: "return", value: snapshot(existing) };
  }
  const alias = task.getSystemMissAlias(input.jobRunId);
  if (alias) {
    if (alias.scheduledFor !== input.scheduledFor) {
      throw new Error("Job occurrence alias has a conflicting schedule time");
    }
    const coalesced = task.getOccurrence(alias.coalescedJobRunId) as
      | JobOccurrence
      | undefined;
    if (!coalesced) {
      throw corruptJobJournal("System missed-occurrence alias is dangling");
    }
    return { kind: "return", value: snapshot(coalesced) };
  }
  if (definition.state !== "enabled") {
    throw new Error("Disabled or deleted tasks cannot create occurrences");
  }
  if (task.hasPendingAutoDisable()) {
    throw new Error("Task is pending automatic disablement");
  }
  let occurrenceState: JobRunState =
    input.disposition === "missed-offline" && input.source === "user"
      ? "missed"
      : "queued";
  let effectiveActiveState: JobRunState | undefined;
  const entries: LogicalRecord<unknown>[] = [];
  const activeJobRunId = assignment.activeJobRunId;
  if (activeJobRunId && occurrenceState !== "missed") {
    const active = assignment.getRunState(activeJobRunId);
    effectiveActiveState = active?.state;
    if (active?.state === "uncertain") {
      occurrenceState = "missed";
    } else if (active?.state === "queued") {
      if (definition.definition.kind === "system") {
        occurrenceState = "missed";
      } else {
        entries.push(
          ...task.prepareQueuedTerminalRecords(
            input.resources,
            activeJobRunId,
            "expired",
          ),
          stateRecord(
            input.taskId,
            activeJobRunId,
            "expired",
            active.statusRevision + 1,
          ),
        );
        effectiveActiveState = undefined;
      }
    } else if (active && !isTerminal(active.state)) {
      occurrenceState = "missed";
    }
  }
  const pendingSystemMissedId = task.pendingSystemMissedJobRunId;
  if (
    occurrenceState === "missed" &&
    definition.definition.kind === "system" &&
    pendingSystemMissedId
  ) {
    const coalesced = task.getOccurrence(pendingSystemMissedId) as
      | JobOccurrence
      | undefined;
    if (!coalesced) {
      throw corruptJobJournal("System missed-occurrence index is dangling");
    }
    const active = activeJobRunId
      ? assignment.getRunState(activeJobRunId)
      : undefined;
    assertSystemMissCoalescedReplayContract({
      definitionKind: definition.definition.kind,
      requestedIdentifierUnused:
        task.getOccurrence(input.jobRunId) === undefined &&
        task.getSystemMissAlias(input.jobRunId) === undefined,
      pendingMatchesCoalesced: pendingSystemMissedId === coalesced.jobRunId,
      coalescedState: coalesced.state,
      activeState: active?.state,
    });
    return {
      kind: "append",
      entries: [
        jobRecord(input.taskId, {
          t: "system-miss-coalesced",
          requestedJobRunId: input.jobRunId,
          scheduledFor: input.scheduledFor,
          coalescedJobRunId: coalesced.jobRunId,
        }),
      ],
      value: snapshot(coalesced),
    };
  }
  const occurrence: JobOccurrence = validateJobOccurrence({
    taskId: input.taskId,
    jobRunId: input.jobRunId,
    scheduledFor: input.scheduledFor,
    taskRevision: definition.taskRevision,
    deliveryPlan: deliveryPlan(definition.definition),
    state: occurrenceState,
  });
  assertJobOccurrenceReplayContract({
    taskIdMatches: occurrence.taskId === input.taskId,
    definitionPresent: true,
    definitionState: definition.state,
    definitionRevisionMatches:
      occurrence.taskRevision === definition.taskRevision,
    definitionKind: definition.definition.kind,
    identifierUnused:
      task.getOccurrence(occurrence.jobRunId) === undefined &&
      task.getSystemMissAlias(occurrence.jobRunId) === undefined,
    occurrenceState: occurrence.state,
    activeState: effectiveActiveState,
    hasAtomicAdmission: occurrence.state === "queued",
    hasAtomicOfflineMissPolicy:
      occurrence.state === "missed" &&
      input.source === "user" &&
      input.missedNextFire !== undefined,
  });
  entries.push(jobRecord(input.taskId, { t: "occurrence", occ: occurrence }));
  if (occurrenceState === "missed" && input.source === "user") {
    if (!input.missedNextFire) {
      throw new TypeError(
        "Missed user occurrence requires a frozen next-fire policy",
      );
    }
    entries.push(
      jobRecord(input.taskId, {
        t: "missed-next-fire",
        jobRunId: input.jobRunId,
        readyBoundary: input.missedNextFire.readyBoundary,
        ...(input.missedNextFire.nextFire
          ? { nextFire: input.missedNextFire.nextFire }
          : {}),
      }),
    );
  }
  if (occurrenceState === "queued") {
    const admission: Extract<JobJournalRecord, { t: "admitted" }> = {
      t: "admitted",
      taskId: input.taskId,
      jobRunId: input.jobRunId,
      scheduledFor: input.scheduledFor,
    };
    assertJobAdmissionReplayContract({
      taskIdMatches: admission.taskId === input.taskId,
      occurrencePresent: true,
      scheduleMatches: admission.scheduledFor === occurrence.scheduledFor,
      occurrenceState: occurrence.state,
      definitionKind: definition.definition.kind,
      admissionAlreadyExists: false,
      ingressPresent: false,
      hasAtomicManualControlResult: false,
    });
    entries.push(jobRecord(input.taskId, admission));
  }
  return { kind: "append", entries, value: occurrence };
}

export async function decideNoteCapabilityGap(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly capabilityRevision: number;
  readonly reason: string;
  readonly now: string;
  readonly prefix: ProjectionTransactionContext;
  readonly schedulerNotices: SchedulerUserNoticeJournal;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): Promise<ProjectionTransactionDecision<unknown, void>> {
  const { task, assignment } = input.facts;
  const occurrence = task.getOccurrence(input.jobRunId);
  const current = assignment.getRunState(input.jobRunId);
  const definition = occurrence
    ? (task.requireDefinitionRevision(occurrence.taskRevision) as TaskDefinition)
    : undefined;
  const decision = decideScheduleCapabilityGap({
    taskId: input.taskId,
    jobRunId: input.jobRunId,
    ...(definition ? { definition } : {}),
    ...(current ? { state: current.state } : {}),
    previous: task.getCapabilityGap(input.jobRunId),
    capabilityRevision: input.capabilityRevision,
    reason: input.reason,
  });
  if (!decision) return { kind: "return", value: undefined };
  const entries: LogicalRecord<unknown>[] = [
    jobRecord(input.taskId, {
      t: decision.kind,
      jobRunId: input.jobRunId,
      round: decision.round,
      noticeId: decision.noticeId,
      capabilityRevision: input.capabilityRevision,
      reasonDigest: decision.reasonDigest,
      reason: input.reason,
    }),
    ...(await input.schedulerNotices.prepareRecords(
      { ...decision.notice, at: input.now },
      input.prefix,
    )),
  ];
  return { kind: "append", entries, value: undefined };
}

export function decideSettleSchedulerAutoDisable(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly disabledTaskRevision: number;
  readonly facts: Pick<JobDecisionFacts, "task">;
}): ProjectionTransactionDecision<unknown, void> {
  const { task } = input.facts;
  if (task.hasAutoDisableSettled(input.jobRunId)) {
    return { kind: "return", value: undefined };
  }
  const policy = task.getFailurePolicy(input.jobRunId);
  if (!policy?.autoDisableRequired) {
    throw new Error("Scheduler auto-disable has no durable obligation");
  }
  if (
    task.definition?.state !== "disabled" ||
    task.definition.taskRevision !== input.disabledTaskRevision
  ) {
    throw new Error(
      "Scheduler auto-disable settlement lacks its disabled definition",
    );
  }
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        t: "auto-disable-settled",
        jobRunId: input.jobRunId,
        disabledTaskRevision: input.disabledTaskRevision,
      }),
    ],
    value: undefined,
  };
}

export function decideCloseQueued(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly target: "failed" | "expired";
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, boolean> {
  const { task, assignment } = input.facts;
  const current = assignment.getRunState(input.jobRunId);
  const occurrence = task.getOccurrence(input.jobRunId);
  if (!current) throw new Error("Job occurrence is unknown");
  if (
    !occurrence ||
    task.requireDefinitionRevision(occurrence.taskRevision).definition.kind !==
      "user"
  ) {
    throw new Error("Only user job occurrences use queued selection outcomes");
  }
  if (current.state === input.target) return { kind: "return", value: false };
  if (current.state !== "queued") {
    throw new Error(`Only a queued job can become ${input.target}`);
  }
  return {
    kind: "append",
    entries: [
      ...task.prepareQueuedTerminalRecords(
        input.resources,
        input.jobRunId,
        input.target,
      ),
      stateRecord(
        input.taskId,
        input.jobRunId,
        input.target,
        current.statusRevision + 1,
      ),
    ],
    value: true,
  };
}

export function decideApplyJobControl(input: {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly context: AtomicControlApplicationContext<JobControlEnvelope>;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): {
  readonly result: ControlResult;
  readonly authorityEntries?: readonly LogicalRecord<unknown>[];
} {
  const { task, assignment } = input.facts;
  const body = input.context.envelope.body;
  const definition = task.definition as TaskDefinition | undefined;
  if (!definition) {
    return {
      result: rejectedControl("not-found", "Task definition is unknown"),
    };
  }
  if (definition.definition.kind === "system") {
    return {
      result: rejectedControl(
        "unauthorized",
        "System tasks cannot be controlled from a surface",
      ),
    };
  }
  if (body.t === "job-run") {
    if (
      body.taskId !== input.taskId ||
      body.anchorEpoch !== input.anchorEpoch
    ) {
      return {
        result: rejectedControl(
          "epoch-stale",
          "Job run request does not bind the current task anchor",
        ),
      };
    }
    if (definition.state !== "enabled") {
      return {
        result: rejectedControl("fence-rejected", "Task is not enabled"),
      };
    }
    if (task.hasPendingAutoDisable()) {
      return {
        result: rejectedControl(
          "fence-rejected",
          "Task is pending automatic disablement",
        ),
      };
    }
    const replacementEntries: LogicalRecord<unknown>[] = [];
    const activeJobRunId = assignment.activeJobRunId;
    if (activeJobRunId) {
      const active = assignment.getRunState(activeJobRunId);
      if (!active) {
        throw corruptJobJournal("Active job occurrence has no state");
      }
      if (active.state === "queued") {
        replacementEntries.push(
          ...task.prepareQueuedTerminalRecords(
            input.resources,
            activeJobRunId,
            "expired",
          ),
          stateRecord(
            input.taskId,
            activeJobRunId,
            "expired",
            active.statusRevision + 1,
          ),
        );
      } else {
        return {
          result: rejectedControl(
            active.state === "uncertain" ? "busy" : "fence-rejected",
            "Task already has an active occurrence",
          ),
        };
      }
    }
    const jobRunId = createManualJobRunId({
      taskId: input.taskId,
      requestId: input.context.canonicalRequestId,
      scheduledFor: input.context.envelope.at,
    });
    const occurrence = validateJobOccurrence({
      taskId: input.taskId,
      jobRunId,
      scheduledFor: input.context.envelope.at,
      taskRevision: definition.taskRevision,
      deliveryPlan: deliveryPlan(definition.definition),
      state: "queued",
    });
    const ingress = requireControlIngress(input.context);
    const admission: Extract<JobJournalRecord, { t: "admitted" }> = {
      t: "admitted",
      taskId: input.taskId,
      jobRunId,
      scheduledFor: occurrence.scheduledFor,
      ingress,
    };
    assertJobAdmissionReplayContract({
      taskIdMatches: admission.taskId === input.taskId,
      occurrencePresent: true,
      scheduleMatches: admission.scheduledFor === occurrence.scheduledFor,
      occurrenceState: occurrence.state,
      definitionKind: definition.definition.kind,
      admissionAlreadyExists: false,
      ingressPresent: true,
      hasAtomicManualControlResult: true,
    });
    return {
      result: {
        v: 1,
        status: "ok",
        body: { t: "job-run", jobRunId },
      },
      authorityEntries: [
        ...replacementEntries,
        jobRecord(input.taskId, { t: "occurrence", occ: occurrence }),
        jobRecord(input.taskId, admission),
      ],
    };
  }
  if (body.t === "job-cancel") {
    if (
      body.taskId !== input.taskId ||
      body.anchorEpoch !== input.anchorEpoch
    ) {
      return {
        result: rejectedControl(
          "epoch-stale",
          "Job cancellation does not bind the current task anchor",
        ),
      };
    }
    const current = assignment.getRunState(body.jobRunId);
    if (!current) {
      return {
        result: rejectedControl("not-found", "Job occurrence is unknown"),
      };
    }
    if (current.state === "queued") {
      return {
        result: {
          v: 1,
          status: "ok",
          body: { t: "job-cancel", runState: "cancelled" },
        },
        authorityEntries: [
          ...task.prepareQueuedTerminalRecords(
            input.resources,
            body.jobRunId,
            "cancelled",
          ),
          stateRecord(
            input.taskId,
            body.jobRunId,
            "cancelled",
            current.statusRevision + 1,
          ),
        ],
      };
    }
    const assignmentId = assignment.getAssignmentIdForJob(body.jobRunId);
    if (
      !assignmentId ||
      (current.state !== "dispatched" && current.state !== "running")
    ) {
      return {
        result: rejectedControl(
          "fence-rejected",
          "Job occurrence is not cancellable",
        ),
      };
    }
    const fence = {
      fenceSeq: input.context.authorityPrefix.nextLsn,
      requestId: input.context.canonicalRequestId,
    };
    return {
      result: {
        v: 1,
        status: "ok",
        body: { t: "job-cancel", runState: "cancel-requested" },
      },
      authorityEntries: [
        jobRecord(input.taskId, {
          t: "cancel-fence",
          assignmentId,
          ...fence,
        }),
        ...assignment.dataPlaneTicketRevocationsFor(input.taskId, assignmentId),
        stateRecord(
          input.taskId,
          body.jobRunId,
          "cancel-requested",
          current.statusRevision + 1,
          assignmentId,
        ),
      ],
    };
  }
  if (
    body.ref.execution !== "job" ||
    body.ref.taskId !== input.taskId ||
    body.ref.anchorEpoch !== input.anchorEpoch
  ) {
    return {
      result: rejectedControl(
        "epoch-stale",
        "Uncertain resolution does not bind the current task anchor",
      ),
    };
  }
  const current = assignment.getRunState(body.ref.jobRunId);
  const open = assignment.getResolution(body.ref.jobRunId);
  const assigned = open
    ? assignment.getAssigned(open.subject.assignmentId)
    : undefined;
  if (
    !current ||
    current.state !== "uncertain" ||
    !open ||
    open.resolution ||
    open.openFactDigest !== body.openFactDigest ||
    !assigned ||
    assignment.getAssignmentIdForJob(body.ref.jobRunId) !==
      assigned.record.assignmentId
  ) {
    return {
      result: rejectedControl(
        "fence-rejected",
        "Uncertain resolution targets a closed or different job fact",
      ),
    };
  }
  const nextState: JobRunState =
    body.decision === "user-verified-side-effects"
      ? "failed"
      : body.decision === "user-abandoned"
        ? "cancelled"
        : "queued";
  if (nextState === "queued" && definition.state !== "enabled") {
    return {
      result: rejectedControl(
        "fence-rejected",
        "Task must be enabled before uncertain work can be retried",
      ),
    };
  }
  const fact = closeResolution(
    open as Parameters<typeof closeResolution>[0],
    body.decision,
    input.context.envelope.principal.surfacePrincipal,
    input.context.envelope.at,
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
      jobRecord(input.taskId, {
        t: "resolution",
        jobRunId: body.ref.jobRunId,
        fact,
      }),
      ...assignment.capabilityRevocationsFor(input.taskId, assigned),
      stateRecord(
        input.taskId,
        body.ref.jobRunId,
        nextState,
        current.statusRevision + 1,
        assigned.record.assignmentId,
      ),
    ],
  };
}

export function selectSchedulerPolicy(
  facts: Pick<JobDecisionFacts, "task">,
  jobRunIds: readonly string[],
): {
  readonly legacyNextFire?: Extract<JobJournalRecord, { t: "legacy-next-fire" }>;
  readonly missedNextFireByRun: ReadonlyMap<
    string,
    Extract<JobJournalRecord, { t: "missed-next-fire" }>
  >;
  readonly failurePolicyByRun: ReadonlyMap<
    string,
    Extract<JobJournalRecord, { t: "failure-policy" }>
  >;
  readonly pendingAutoDisable: readonly Extract<
    JobJournalRecord,
    { t: "failure-policy" }
  >[];
} {
  const { task } = facts;
  const missedNextFireByRun = new Map(
    jobRunIds.flatMap((jobRunId) => {
      const value = task.getMissedNextFire(jobRunId);
      return value === undefined
        ? []
        : [
            [
              jobRunId,
              structuredClone(
                value as Extract<JobJournalRecord, { t: "missed-next-fire" }>,
              ),
            ] as const,
          ];
    }),
  );
  const failurePolicyByRun = new Map(
    jobRunIds.flatMap((jobRunId) => {
      const value = task.getFailurePolicy(jobRunId);
      return value === undefined
        ? []
        : [
            [
              jobRunId,
              structuredClone(
                value as Extract<JobJournalRecord, { t: "failure-policy" }>,
              ),
            ] as const,
          ];
    }),
  );
  const pending = task
    .listPendingAutoDisableRunIds()
    .map((jobRunId) => {
      const policy = task.getFailurePolicy(jobRunId) as
        | Extract<JobJournalRecord, { t: "failure-policy" }>
        | undefined;
      const occurrence = task.getOccurrence(jobRunId) as
        | JobOccurrence
        | undefined;
      if (!policy || !occurrence) {
        throw corruptJobJournal("Pending auto-disable has no durable policy");
      }
      return { policy, occurrence };
    })
    .sort((left, right) => compareJobOccurrences(left.occurrence, right.occurrence));
  return {
    ...(task.legacyNextFire
      ? {
          legacyNextFire: structuredClone(
            task.legacyNextFire as Extract<
              JobJournalRecord,
              { t: "legacy-next-fire" }
            >,
          ),
        }
      : {}),
    missedNextFireByRun,
    failurePolicyByRun,
    pendingAutoDisable: pending.map(({ policy }) => structuredClone(policy)),
  };
}

export function selectSchedulerReadView(
  facts: Pick<JobDecisionFacts, "task">,
): JobSchedulerReadView {
  const { task } = facts;
  const last = task.getLatestScheduleOccurrence();
  return {
    ...(task.definition
      ? { definition: snapshot(task.definition as TaskDefinition) }
      : {}),
    runCount: task.runCount,
    consecutiveFailures: task.latestFailureCount(),
    ...(last ? { last } : {}),
    open: task.listOpenRunIdsOrdered().map((jobRunId) => {
      const occ = task.getScheduleOccurrence(jobRunId);
      if (!occ) throw corruptJobJournal("Run directory names an unknown occurrence");
      return occ;
    }),
  };
}

export function selectPendingMissedOccurrences(
  facts: Pick<JobDecisionFacts, "task">,
): readonly ScheduleOccurrence[] {
  const { task } = facts;
  return task.listPendingMissedRunIdsOrdered().map((jobRunId) => {
    const occ = task.getScheduleOccurrence(jobRunId);
    if (!occ) throw corruptJobJournal("Run directory names an unknown occurrence");
    return occ;
  });
}

export function selectOccurrencesPage(
  facts: Pick<JobDecisionFacts, "task">,
  beforeId: string | undefined,
  limit: number,
): readonly ScheduleOccurrence[] {
  const { task } = facts;
  const before =
    beforeId === undefined
      ? undefined
      : (task.getOccurrence(beforeId) as JobOccurrence | undefined);
  if (beforeId !== undefined && !before) {
    throw new TypeError("Occurrence page cursor is unknown");
  }
  const page: ScheduleOccurrence[] = [];
  task.walkOccurrencesBackward(before, (occurrence) => {
    page.push(task.projectScheduleOccurrence(occurrence));
    return page.length < limit;
  });
  return page;
}

export function selectOccurrence(
  facts: Pick<JobDecisionFacts, "task" | "assignment">,
  jobRunId: string,
): JobOccurrence | undefined {
  const occurrence = facts.task.getOccurrence(jobRunId) as
    | JobOccurrence
    | undefined;
  const current = facts.assignment.getRunState(jobRunId);
  return occurrence
    ? validateJobOccurrence({
        ...snapshot(occurrence),
        state: current?.state ?? occurrence.state,
      })
    : undefined;
}
