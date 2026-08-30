import { createHash } from "node:crypto";
import type { JobOccurrence, TaskDefinition } from "../contracts/state.js";
import { protocolDigest } from "../protocol/canonical.js";
import { nextScheduleTime } from "./schedule-time.js";
import type { TaskSchedule } from "./types.js";

export const DEFAULT_SCHEDULE_FAILURE_THRESHOLD = 5;

/** Pure, path-free decision emitted before the journal records a timed occurrence. */
export interface ScheduleTriggerDecision {
  readonly effectiveScheduledFor: string;
  readonly jobRunId: string;
  readonly disposition?: "missed-offline";
  readonly missedNextFire?: {
    readonly readyBoundary: string;
    readonly nextFire?: string;
  };
}

export class ScheduleRuntimePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleRuntimePolicyError";
  }
}

export interface ScheduleFailureFact {
  readonly jobRunId: string;
  readonly scheduledFor: string;
  readonly state: string | undefined;
}

export interface ScheduleFailurePolicyDecision {
  readonly failureCount: number;
  readonly threshold: number;
  readonly nextFire?: string;
  readonly autoDisableRequired: boolean;
}

/** Domain-owned deterministic due ordering. */
export function selectDueScheduleEntries(
  entries: ReadonlyMap<string, string>,
  now: Date,
): readonly (readonly [taskId: string, scheduledFor: string])[] {
  return Object.freeze(
    [...entries]
      .filter(([, scheduledFor]) => Date.parse(scheduledFor) <= now.getTime())
      .sort((left, right) =>
        left[1].localeCompare(right[1]) || left[0].localeCompare(right[0], "en-US")
      )
      .map((entry) => Object.freeze(entry)),
  );
}

/** Domain-owned timer deadline; the Host mechanism only arms the returned delay. */
export function scheduleTimerDelay(
  scheduledFor: Iterable<string>,
  now: Date,
  pollMs: number,
): number {
  const next = [...scheduledFor]
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  return next === undefined
    ? pollMs
    : Math.max(0, Math.min(pollMs, next - now.getTime()));
}

/** Domain-owned offline/catch-up and stable occurrence identity decision. */
export function decideScheduleTrigger(input: {
  readonly taskId: string;
  readonly scheduledFor: string;
  readonly definition: TaskDefinition;
  readonly onlineSince?: number;
  readonly missedGraceMs: number;
}): ScheduleTriggerDecision {
  const scheduledAt = Date.parse(input.scheduledFor);
  if (!Number.isFinite(scheduledAt)) {
    throw new TypeError("Schedule trigger time must be a valid ISO timestamp");
  }
  const offlineMiss =
    input.onlineSince !== undefined &&
    scheduledAt < input.onlineSince - input.missedGraceMs;
  const effectiveScheduledFor =
    offlineMiss && input.definition.definition.kind === "system"
      ? new Date(input.onlineSince!).toISOString()
      : input.scheduledFor;
  const decision = {
    effectiveScheduledFor,
    jobRunId: scheduleJobRunId(input.taskId, effectiveScheduledFor),
    ...(offlineMiss && input.definition.definition.kind === "user"
      ? {
          disposition: "missed-offline" as const,
          missedNextFire: {
            readyBoundary: new Date(input.onlineSince!).toISOString(),
            ...(input.definition.definition.spec.schedule.kind === "once"
              ? {}
              : {
                  nextFire: nextScheduleTime(
                    input.definition.definition.spec.schedule,
                    new Date(input.onlineSince!),
                  ),
                }),
          },
        }
      : {}),
  };
  return Object.freeze({
    ...decision,
    ...(decision.missedNextFire
      ? { missedNextFire: Object.freeze({ ...decision.missedNextFire }) }
      : {}),
  });
}

/** Domain-owned next-fire decision rebuilt from durable occurrences. */
export function deriveScheduleNextRun(
  schedule: TaskSchedule,
  occurrences: readonly JobOccurrence[],
  now: Date,
): string | undefined {
  const last = occurrences.at(-1);
  if (!last) {
    if (schedule.kind === "once") return schedule.at;
    return nextScheduleTime(schedule, now);
  }
  if (schedule.kind === "once") return undefined;
  return nextScheduleTime(schedule, new Date(last.scheduledFor));
}

/** Domain-owned failure streak used by runtime projection and auto-disable. */
export function countScheduleConsecutiveFailures(
  occurrences: readonly JobOccurrence[],
): number {
  let count = 0;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const state = occurrences[index]!.state;
    if (state === "committed") break;
    if (state === "failed" || state === "expired") count += 1;
    else if (state !== "missed") break;
  }
  return count;
}

/** Domain-owned durable failure/backoff/auto-disable decision. */
export function decideScheduleFailurePolicy(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly schedule: TaskSchedule;
  readonly occurrences: readonly ScheduleFailureFact[];
  readonly threshold: number;
  readonly decidedAt: string;
}): ScheduleFailurePolicyDecision {
  if (!Number.isSafeInteger(input.threshold) || input.threshold <= 0) {
    throw new ScheduleRuntimePolicyError(
      "Schedule failure threshold must be a positive safe integer",
    );
  }
  const ordered = [...input.occurrences].sort(
    (left, right) =>
      left.scheduledFor.localeCompare(right.scheduledFor) ||
      left.jobRunId.localeCompare(right.jobRunId),
  );
  const index = ordered.findIndex((occurrence) =>
    occurrence.jobRunId === input.jobRunId
  );
  if (index < 0) {
    throw new ScheduleRuntimePolicyError("Scheduler failure occurrence is absent");
  }
  let failureCount = 1;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = ordered[cursor]!.state;
    if (previous === "failed" || previous === "expired") failureCount += 1;
    else if (previous !== "missed") break;
  }
  const nextFire = frozenScheduleFailureNextFire({
    taskId: input.taskId,
    jobRunId: input.jobRunId,
    schedule: input.schedule,
    scheduledFor: ordered[index]!.scheduledFor,
    failureCount,
    decidedAt: input.decidedAt,
  });
  return Object.freeze({
    failureCount,
    threshold: input.threshold,
    ...(nextFire ? { nextFire } : {}),
    autoDisableRequired: failureCount >= input.threshold,
  });
}

export function scheduleAutoDisableOperationId(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly taskRevision: number;
  readonly failureCount: number;
}): string {
  return `schedule-auto-disable:${protocolDigest("SchedulerAutoDisable", 1, input)}`;
}

export function selectPendingScheduleAutoDisable<
  Policy extends { readonly jobRunId: string; readonly autoDisableRequired: boolean },
>(
  policies: Iterable<Policy>,
  settledJobRunIds: ReadonlySet<string>,
): readonly Policy[] {
  return Object.freeze(
    [...policies].filter((policy) =>
      policy.autoDisableRequired && !settledJobRunIds.has(policy.jobRunId)
    ),
  );
}

export function scheduleJobRunId(taskId: string, scheduledFor: string): string {
  return `job-${shortHash(taskId)}-${shortHash(`${taskId}\n${scheduledFor}`)}`;
}

function frozenScheduleFailureNextFire(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly schedule: TaskSchedule;
  readonly scheduledFor: string;
  readonly failureCount: number;
  readonly decidedAt: string;
}): string | undefined {
  if (input.schedule.kind === "once") return undefined;
  const scheduled = nextScheduleTime(input.schedule, new Date(input.scheduledFor));
  if (!scheduled) return undefined;
  const capMs = Math.min(
    60_000 * 2 ** Math.min(input.failureCount - 1, 6),
    3_600_000,
  );
  const entropy = Number.parseInt(
    createHash("sha256")
      .update(`${input.taskId}\n${input.jobRunId}\n${input.failureCount}`)
      .digest("hex")
      .slice(0, 12),
    16,
  );
  const jitterMs = entropy % (capMs + 1);
  return new Date(
    Math.max(Date.parse(scheduled), Date.parse(input.decidedAt) + jitterMs),
  ).toISOString();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
