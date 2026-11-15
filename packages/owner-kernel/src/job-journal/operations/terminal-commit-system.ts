import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityError,
  JobOccurrence,
  LedgerSnapshot,
  LogicalRecord,
  PublishRecord,
  SystemJobFence,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import type { Stored } from "../../conversation-run-contracts.js";
import {
  assertSystemJobActivationReplayContract,
  assertSystemJobTerminalReplayContract,
  corruptJobJournal,
  type JobJournalRecord,
  type validateSystemJobResultDetail,
} from "../../job-run-contracts.js";
import type {
  AssignedJob,
  JobBundle,
  JobResolutionFact,
  SystemJobResourceCoordinator,
} from "../contracts.js";
import {
  assertLedgerAcknowledgesCommittedBundle,
  bundleAcknowledgementRecord,
  jobBundleBindsAssignedOccurrence,
} from "../replay/bundle-closure.js";
import {
  closeResolution,
  recordsHaveJobState,
} from "../state/assignment-control.js";
import { jobRecord, rejected, stateRecord } from "../state/common.js";
import type { DeepReadonly, JobDecisionFacts } from "../state/views.js";

export type JobBundlePrefixValidationResult =
  | {
      readonly kind: "return";
      readonly value:
        | { readonly committed: true; readonly commitRevision: number }
        | { readonly committed: false; readonly error: AuthorityError };
    }
  | {
      readonly kind: "proceed";
      readonly assigned: DeepReadonly<AssignedJob>;
      readonly occurrence: JobOccurrence;
      readonly definition: TaskDefinition;
      readonly currentStatusRevision: number;
      readonly currentState:
        | "dispatched"
        | "running"
        | "cancel-requested"
        | "uncertain";
      readonly openResolution: JobResolutionFact | undefined;
    };

export function validateJobBundleAtPrefix(input: {
  readonly assignmentId: string;
  readonly bundle: JobBundle;
  readonly bundleArtifactRef: ArtifactRef;
  readonly authorizeReplay: () => void;
  readonly authorizeRejection: () => void;
  readonly authorizeActiveOrSettlement: (mode: "active" | "settlement") => void;
  readonly assertAssignmentUsageFinal: (
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: JobBundle["usageFinal"],
  ) => void;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment" | "channel">;
}): JobBundlePrefixValidationResult {
  const { task, assignment, channel } = input.facts;
  const { assignmentId, bundle } = input;
  const exact = channel.getCommitted(assignmentId);
  if (exact) {
    if (
      canonicalize(exact.bundle) !== canonicalize({ ref: input.bundleArtifactRef })
    ) {
      return {
        kind: "return",
        value: rejected(
          "fence-rejected",
          "Assignment committed another bundle",
          false,
        ),
      };
    }
    input.authorizeReplay();
    return {
      kind: "return",
      value: { committed: true, commitRevision: exact.jobRevision },
    };
  }
  const assigned = assignment.getAssigned(assignmentId);
  if (
    !assigned ||
    assignment.getAssignmentIdForJob(assigned.record.jobRunId) !== assignmentId
  ) {
    input.authorizeRejection();
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle belongs to a historical assignment",
        false,
      ),
    };
  }
  const occurrence = task.getOccurrence(assigned.record.jobRunId) as
    | JobOccurrence
    | undefined;
  const current = assignment.getRunState(assigned.record.jobRunId);
  const open = assignment.getResolution(assigned.record.jobRunId) as
    | JobResolutionFact
    | undefined;
  if (!occurrence || !current) {
    throw corruptJobJournal("Bundle assignment is incomplete");
  }
  if (
    !jobBundleBindsAssignedOccurrence(
      bundle,
      assigned as unknown as AssignedJob,
      occurrence,
    )
  ) {
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle fence does not match the occurrence",
        false,
      ),
    };
  }
  if (
    current.state === "uncertain" &&
    open?.cause === "dispatch-conflict" &&
    !open.resolution
  ) {
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle is blocked by an open dispatch conflict",
        false,
      ),
    };
  }
  if (
    current.state !== "dispatched" &&
    current.state !== "running" &&
    current.state !== "cancel-requested" &&
    current.state !== "uncertain"
  ) {
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle is late for the current job state",
        false,
      ),
    };
  }
  input.authorizeActiveOrSettlement(
    current.state === "uncertain" ? "settlement" : "active",
  );
  input.assertAssignmentUsageFinal(
    assigned.record as Extract<JobJournalRecord, { t: "assigned" }>,
    bundle.usageFinal,
  );
  const definition = task.requireDefinitionRevision(
    occurrence.taskRevision,
  ) as TaskDefinition;
  return {
    kind: "proceed",
    assigned,
    occurrence,
    definition,
    currentStatusRevision: current.statusRevision,
    currentState: current.state,
    openResolution: open,
  };
}

export function buildJobBundleCommitEntries(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly bundle: JobBundle;
  readonly bundleArtifactRef: ArtifactRef;
  readonly assigned: DeepReadonly<AssignedJob>;
  readonly currentStatusRevision: number;
  readonly currentState:
    | "dispatched"
    | "running"
    | "cancel-requested"
    | "uncertain";
  readonly openResolution: JobResolutionFact | undefined;
  readonly deliveryRecords: readonly LogicalRecord<unknown>[];
  readonly mutationRecords: readonly LogicalRecord<unknown>[];
  readonly publishDecisionRecord:
    | LogicalRecord<Extract<PublishRecord, { t: "publish-decision" }>>
    | undefined;
  readonly publishProgressRecord:
    | LogicalRecord<Extract<PublishRecord, { t: "publish-progress" }>>
    | undefined;
  readonly schedulerNoticeRecords: readonly LogicalRecord<unknown>[];
  readonly closedAt: string;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}): {
  readonly entries: LogicalRecord<unknown>[];
  readonly jobRevision: number;
} {
  const { assignment, channel } = input.facts;
  const jobRevision = channel.nextJobRevision;
  const entries: LogicalRecord<unknown>[] = [
    jobRecord(input.taskId, {
      t: "committed",
      jobRunId: input.assigned.record.jobRunId,
      assignmentId: input.assignmentId,
      bundle: { ref: input.bundleArtifactRef },
      jobRevision,
    }),
    ...assignment.capabilityRevocationsFor(input.taskId, input.assigned),
    stateRecord(
      input.taskId,
      input.assigned.record.jobRunId,
      "committed",
      input.currentStatusRevision + 1,
      input.assignmentId,
    ),
    ...input.deliveryRecords,
    ...input.mutationRecords,
  ];
  if (input.publishDecisionRecord) {
    entries.push(input.publishDecisionRecord);
  }
  if (input.publishProgressRecord) {
    entries.push(input.publishProgressRecord);
  }
  if (input.schedulerNoticeRecords.length > 0) {
    entries.push(...input.schedulerNoticeRecords);
  }
  if (input.currentState === "uncertain") {
    if (!input.openResolution || input.openResolution.resolution) {
      throw corruptJobJournal("Uncertain job has no open fact");
    }
    entries.push(
      jobRecord(input.taskId, {
        t: "resolution",
        jobRunId: input.assigned.record.jobRunId,
        fact: closeResolution(
          input.openResolution,
          "late-bundle-committed",
          input.bundle.executorId,
          input.closedAt,
        ),
      }),
    );
  }
  return { entries, jobRevision };
}

export function selectBundleAcknowledgementPreflight(
  facts: Pick<JobDecisionFacts, "channel">,
  assignmentId: string,
): {
  readonly expected: Extract<JobJournalRecord, { t: "bundle-ack-observed" }>;
  readonly existing:
    | Extract<JobJournalRecord, { t: "bundle-ack-observed" }>
    | undefined;
} {
  const committed = facts.channel.getCommitted(assignmentId) as
    | Extract<JobJournalRecord, { t: "committed" }>
    | undefined;
  if (!committed) {
    throw new Error(
      "Bundle acknowledgement names an uncommitted job assignment",
    );
  }
  return {
    expected: bundleAcknowledgementRecord(assignmentId, committed),
    existing: facts.channel.getBundleAcknowledgement(assignmentId) as
      | Extract<JobJournalRecord, { t: "bundle-ack-observed" }>
      | undefined,
  };
}

export function decideObserveBundleAcknowledgement(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly ledger: LedgerSnapshot;
  readonly preflightExpected: Extract<
    JobJournalRecord,
    { t: "bundle-ack-observed" }
  >;
  readonly facts: Pick<JobDecisionFacts, "channel">;
}): ProjectionTransactionDecision<unknown, void> {
  const { channel } = input.facts;
  const committed = channel.getCommitted(input.assignmentId) as
    | Extract<JobJournalRecord, { t: "committed" }>
    | undefined;
  const existing = channel.getBundleAcknowledgement(input.assignmentId) as
    | Extract<JobJournalRecord, { t: "bundle-ack-observed" }>
    | undefined;
  if (!committed) {
    throw new Error(
      "Bundle acknowledgement names an uncommitted job assignment",
    );
  }
  const expected = bundleAcknowledgementRecord(input.assignmentId, committed);
  if (canonicalize(expected) !== canonicalize(input.preflightExpected)) {
    throw corruptJobJournal("Committed bundle acknowledgement binding changed");
  }
  assertLedgerAcknowledgesCommittedBundle(input.ledger, expected);
  if (existing) {
    if (canonicalize(existing) !== canonicalize(expected)) {
      throw corruptJobJournal(
        "Bundle acknowledgement observation is inconsistent",
      );
    }
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [jobRecord(input.taskId, expected)],
    value: undefined,
  };
}

export function decideReportStarted(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly authorizeReplay: () => void;
  readonly authorizeActive: () => void;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment, channel } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  if (!assigned) throw new Error("Started report names an unknown assignment");
  const current = assignment.getRunState(assigned.record.jobRunId);
  if (
    assignment.hasDurableStarted(input.assignmentId) ||
    channel.getCommitted(input.assignmentId) !== undefined
  ) {
    input.authorizeReplay();
    return { kind: "return", value: undefined };
  }
  if (
    assignment.getAssignmentIdForJob(assigned.record.jobRunId) !==
    input.assignmentId
  ) {
    throw new Error("Started report names a historical assignment");
  }
  if (current?.state !== "dispatched") {
    throw new Error("Started report is invalid for the current job state");
  }
  input.authorizeActive();
  return {
    kind: "append",
    entries: [
      stateRecord(
        input.taskId,
        assigned.record.jobRunId,
        "running",
        current.statusRevision + 1,
        input.assignmentId,
      ),
    ],
    value: undefined,
  };
}

export function decideFailAssigned(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly assignmentId: string;
  readonly executorFailure: {
    readonly lastSeq: number;
    readonly failure: NonNullable<LedgerSnapshot["failure"]>;
  };
  readonly facts: Pick<JobDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { assignment } = input.facts;
  const current = assignment.getRunState(input.jobRunId);
  if (current?.state === "failed") return { kind: "return", value: undefined };
  const assigned = assignment.getAssigned(input.assignmentId);
  if (
    !assigned ||
    assigned.record.jobRunId !== input.jobRunId ||
    assignment.getAssignmentIdForJob(input.jobRunId) !== input.assignmentId ||
    (current?.state !== "dispatched" && current?.state !== "running")
  ) {
    throw new Error("Only the current active job assignment may report failure");
  }
  const usageFinal = input.executorFailure.failure.usageFinal;
  return {
    kind: "append",
    entries: [
      jobRecord(input.taskId, {
        t: "execution-failure-accepted",
        assignmentId: input.assignmentId,
        lastSeq: input.executorFailure.lastSeq,
        failure: {
          reason: input.executorFailure.failure.reason,
          usageFinal: {
            reportDigest: usageFinal.reportDigest,
            upToUsageSeq: usageFinal.upToUsageSeq,
          },
        },
      }),
      ...assignment.capabilityRevocationsFor(input.taskId, assigned),
      stateRecord(
        input.taskId,
        input.jobRunId,
        "failed",
        current.statusRevision + 1,
        input.assignmentId,
        usageFinal,
      ),
    ],
    value: undefined,
  };
}

export function decideSystemJobActivation(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly anchorEpoch: number;
  readonly definitionKind: "user" | "system";
  readonly occurrence: JobOccurrence;
  readonly fence: SystemJobFence;
  readonly preparedRecords: readonly LogicalRecord<unknown>[];
  readonly systemResources: SystemJobResourceCoordinator;
  readonly facts: Pick<JobDecisionFacts, "assignment">;
}): ProjectionTransactionDecision<unknown, boolean> {
  const current = input.facts.assignment.getRunState(input.jobRunId);
  if (current?.state !== "queued") {
    return { kind: "return", value: false };
  }
  const activationRecords = [
    { t: "system-started", jobRunId: input.jobRunId, fence: input.fence },
    {
      t: "state",
      jobRunId: input.jobRunId,
      state: "running",
      statusRevision: current.statusRevision + 1,
    },
  ] satisfies readonly JobJournalRecord[];
  assertSystemJobActivationReplayContract({
    taskId: input.taskId,
    jobRunId: input.jobRunId,
    anchorEpoch: input.anchorEpoch,
    definitionKind: input.definitionKind,
    occurrence: input.occurrence,
    currentState: current.state,
    previousFence: undefined,
    fence: input.fence,
    hasForeignRecords: input.preparedRecords.length > 0,
    hasAtomicRunningState: recordsHaveJobState(
      activationRecords,
      input.jobRunId,
      "running",
      current.statusRevision + 1,
      undefined,
    ),
  });
  input.systemResources.preflightActivationRecords({
    fence: input.fence,
    records: input.preparedRecords,
  });
  return {
    kind: "append",
    entries: [
      ...input.preparedRecords,
      ...activationRecords.map((record) => jobRecord(input.taskId, record)),
    ],
    value: true,
  };
}

export function decideSystemJobRecoveryReplacement(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly anchorEpoch: number;
  readonly definitionKind: "user" | "system";
  readonly occurrence: JobOccurrence;
  readonly expectedPreviousFence: SystemJobFence;
  readonly fence: SystemJobFence;
  readonly recoveredRecords: readonly LogicalRecord<unknown>[];
  readonly systemResources: SystemJobResourceCoordinator;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, boolean> {
  const currentFence = input.facts.task.getSystemFence(input.jobRunId) as
    | SystemJobFence
    | undefined;
  const current = input.facts.assignment.getRunState(input.jobRunId);
  if (
    current?.state !== "running" ||
    !currentFence ||
    canonicalize(currentFence) !== canonicalize(input.expectedPreviousFence)
  ) {
    return { kind: "return", value: false };
  }
  const activationRecords = [
    { t: "system-started", jobRunId: input.jobRunId, fence: input.fence },
  ] satisfies readonly JobJournalRecord[];
  assertSystemJobActivationReplayContract({
    taskId: input.taskId,
    jobRunId: input.jobRunId,
    anchorEpoch: input.anchorEpoch,
    definitionKind: input.definitionKind,
    occurrence: input.occurrence,
    currentState: current.state,
    previousFence: currentFence,
    fence: input.fence,
    hasForeignRecords: input.recoveredRecords.length > 0,
    hasAtomicRunningState: recordsHaveJobState(
      activationRecords,
      input.jobRunId,
      "running",
      current.statusRevision + 1,
      undefined,
    ),
  });
  input.systemResources.preflightActivationRecords({
    previousFence: input.expectedPreviousFence,
    fence: input.fence,
    records: input.recoveredRecords,
  });
  return {
    kind: "append",
    entries: [
      ...input.recoveredRecords,
      ...activationRecords.map((record) => jobRecord(input.taskId, record)),
    ],
    value: true,
  };
}

export function decideSystemJobTerminal(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly definitionKind: "user" | "system";
  readonly fence: SystemJobFence;
  readonly outcome: "committed" | "failed";
  readonly storedDetail: Stored<ReturnType<typeof validateSystemJobResultDetail>>;
  readonly terminalRecords: readonly LogicalRecord<unknown>[];
  readonly systemResources: SystemJobResourceCoordinator;
  readonly facts: Pick<JobDecisionFacts, "task" | "assignment">;
}): ProjectionTransactionDecision<unknown, void> {
  const { task, assignment } = input.facts;
  const current = assignment.getRunState(input.jobRunId);
  if (current?.state === input.outcome) {
    return { kind: "return", value: undefined };
  }
  if (current?.state !== "running") {
    throw new Error(
      "System job terminal result raced with another terminal transition",
    );
  }
  const currentFence = task.getSystemFence(input.jobRunId) as
    | SystemJobFence
    | undefined;
  if (!currentFence || canonicalize(currentFence) !== canonicalize(input.fence)) {
    throw new Error("System job terminal result belongs to a stale attempt");
  }
  const terminalJobRecords = [
    {
      t: "system-result",
      jobRunId: input.jobRunId,
      fence: input.fence,
      outcome: input.outcome,
      detail: input.storedDetail,
    },
    {
      t: "state",
      jobRunId: input.jobRunId,
      state: input.outcome,
      statusRevision: current.statusRevision + 1,
    },
  ] satisfies readonly JobJournalRecord[];
  assertSystemJobTerminalReplayContract({
    jobRunId: input.jobRunId,
    definitionKind: input.definitionKind,
    currentState: current.state,
    currentFence,
    resultFence: input.fence,
    resultAlreadyExists: task.getSystemResult(input.jobRunId) !== undefined,
    hasForeignRecords: input.terminalRecords.length > 0,
    hasAtomicTerminalState: recordsHaveJobState(
      terminalJobRecords,
      input.jobRunId,
      input.outcome,
      current.statusRevision + 1,
      undefined,
    ),
  });
  input.systemResources.preflightTerminalRecords({
    fence: input.fence,
    outcome: input.outcome,
    records: input.terminalRecords,
  });
  return {
    kind: "append",
    entries: [
      ...input.terminalRecords,
      ...terminalJobRecords.map((record) => jobRecord(input.taskId, record)),
    ],
    value: undefined,
  };
}

export function selectResumableSystemJobs(
  facts: Pick<JobDecisionFacts, "task" | "assignment">,
): string[] {
  const { task, assignment } = facts;
  return task
    .listOpenRunIdsOrdered()
    .map((jobRunId) => [jobRunId, assignment.getRunState(jobRunId)!] as const)
    .filter(([jobRunId, value]) => {
      if (value.state === "running") {
        return task.getSystemFence(jobRunId) !== undefined;
      }
      if (value.state !== "queued") return false;
      const occurrence = task.getOccurrence(jobRunId);
      if (!occurrence) return false;
      const definition = task.requireDefinitionRevision(occurrence.taskRevision);
      return (
        definition.state === "enabled" && definition.definition.kind === "system"
      );
    })
    .map(([jobRunId]) => jobRunId);
}
