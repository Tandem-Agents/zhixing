import type { JobOccurrence, LogicalRecord } from "@zhixing-ai/core/contracts";
import { compareJobOccurrences } from "@zhixing-ai/core/protocol";
import { isScheduleFailure } from "@zhixing-ai/core/scheduler/application";
import {
  requireFailureSummaryPaths,
  setFailureSummaryEntry,
} from "../../job-failure-summary.js";
import type { JobStateSet, KeyedSet } from "../../job-run-state.js";
import {
  JOB_CHANNEL_FIELDS,
  JOB_MAIN_SUBJECTS,
  jobScopeOf,
  jobViewStore,
  scopeKeys,
  type JobProjection,
} from "../contracts.js";
import { jobGrantPending } from "./channel-tickets-mirror.js";
import { isTerminal, jobStream } from "./common.js";
import { scheduleOccurrenceOf } from "./task-schedule.js";

export function refreshJobDirectories(state: JobProjection): void {
  const store = jobViewStore(state);
  const changed = (field: string) => store.changedSubjects(field).map(String);
  const toggle = (
    directory: KeyedSet<string>,
    subject: string,
    present: boolean,
  ) => {
    if (directory.has(subject) === present) return;
    if (present) directory.add(subject);
    else directory.delete(subject);
  };
  const runOpen = (jobRunId: string) => {
    const current = state.states.get(jobRunId);
    return current !== undefined && !isTerminal(current.state);
  };
  const runs = new Set(changed("states"));
  for (const jobRunId of runs) {
    toggle(state.openRuns, jobRunId, runOpen(jobRunId));
  }
  const assignments = new Set(changed("assignedById"));
  for (const jobRunId of new Set([...runs, ...changed("assignmentByJob")])) {
    const current = state.assignmentByJob.get(jobRunId);
    if (current) assignments.add(current);
    const previous = store.baseOf("assignmentByJob", jobRunId);
    if (previous?.present) assignments.add(previous.value as string);
  }
  for (const assignmentId of assignments) {
    const assigned = state.assignedById.get(assignmentId);
    toggle(
      state.openAssignments,
      assignmentId,
      assigned !== undefined &&
        state.assignmentByJob.get(assigned.record.jobRunId) === assignmentId &&
        runOpen(assigned.record.jobRunId),
    );
  }
  for (const assignmentId of new Set([
    ...changed("interactionSettlementFences"),
    ...changed("completedInteractionSettlements"),
  ])) {
    toggle(
      state.pendingSettlements,
      assignmentId,
      state.interactionSettlementFences.has(assignmentId) &&
        !state.completedInteractionSettlements.has(assignmentId),
    );
  }
  const channel = state.channelInteractions;
  for (const challengeId of new Set([
    ...changed(JOB_CHANNEL_FIELDS.preparedByChallenge),
    ...changed(JOB_CHANNEL_FIELDS.closedByChallenge),
  ])) {
    toggle(
      state.openChallenges,
      challengeId,
      channel.preparedByChallenge.get(challengeId)?.ref.execution === "job" &&
        !channel.closedByChallenge.has(challengeId),
    );
  }
  const grants = new Set(changed(JOB_CHANNEL_FIELDS.grantByChallenge));
  for (const assignmentId of changed("interactionMirrors")) {
    const previous = store.baseOf("interactionMirrors", assignmentId)?.value as
      | { readonly outcomes: ReadonlyMap<string, unknown> }
      | undefined;
    for (const outcomes of [
      state.interactionMirrors.get(assignmentId)?.outcomes,
      previous?.outcomes,
    ]) {
      for (const interactionRequestId of outcomes?.keys() ?? []) {
        const challengeId = channel.challengeByInteraction.get(
          `${assignmentId}\u0000${interactionRequestId}`,
        );
        if (challengeId) grants.add(challengeId);
      }
    }
  }
  for (const challengeId of grants) {
    toggle(state.pendingGrants, challengeId, jobGrantPending(state, challengeId));
  }
  for (const jobRunId of new Set([
    ...changed("failurePolicyByRun"),
    ...changed("autoDisableSettledRuns"),
  ])) {
    toggle(
      state.pendingAutoDisable,
      jobRunId,
      state.failurePolicyByRun.get(jobRunId)?.autoDisableRequired === true &&
        !state.autoDisableSettledRuns.has(jobRunId),
    );
  }
}

export function refreshFailureSummary(state: JobProjection): void {
  const store = jobViewStore(state);
  const changed = new Set(
    ["occurrences", "states", "outcomeByRun"].flatMap((field) =>
      store.changedSubjects(field).map(String),
    ),
  );
  const updates = [...changed]
    .map((jobRunId) => state.occurrences.get(jobRunId))
    .filter(
      (occurrence): occurrence is JobOccurrence =>
        occurrence !== undefined && occurrence.state !== "missed",
    )
    .map((occurrence) => ({
      occurrence,
      failed: isScheduleFailure(scheduleOccurrenceOf(state, occurrence)),
    }))
    .filter(
      ({ occurrence, failed }) =>
        state.failureFlagByRun.get(occurrence.jobRunId) !== failed,
    )
    .sort((left, right) =>
      compareJobOccurrences(left.occurrence, right.occurrence),
    );
  requireFailureSummaryPaths(
    state,
    updates.map(({ occurrence }) => occurrence),
  );
  for (const { occurrence, failed } of updates) {
    setFailureSummaryEntry(state, occurrence, failed);
    state.failureFlagByRun.set(occurrence.jobRunId, failed);
  }
}

export function jobStreamBodies(
  entries: readonly LogicalRecord<unknown>[],
  taskId: string,
): unknown[] {
  return entries
    .filter((entry) => entry.stream === jobStream(taskId))
    .map((entry) => entry.body);
}

export function candidateStateNeeds(
  set: JobStateSet,
  entries: readonly LogicalRecord<unknown>[],
  taskId: string,
): { readonly key: string }[] {
  const scope = jobScopeOf(
    entries
      .filter((entry) => entry.stream === jobStream(taskId))
      .map((entry) => entry.body),
  );
  return scopeKeys(set, JOB_MAIN_SUBJECTS, scope).map((key) => ({ key }));
}
