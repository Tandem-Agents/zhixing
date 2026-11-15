import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  GovernorRecord,
  IngressContext,
  JobOccurrence,
  LogicalRecord,
  SystemJobFence,
  SystemJobResourceLease,
  TaskDefinition,
  TaskDefinitionBody,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  compareJobOccurrences,
  createJobCommitFence,
  jobDeliveryPlanDigest,
  queuedTerminalDequeueRecord,
  validateIngressContext,
  validateJobCommitFence,
  validateJobOccurrence,
  validateSystemJobResourceLease,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import type { ScheduleOccurrence } from "@zhixing-ai/core/scheduler/application";
import type {
  AtomicControlApplicationContext,
  JobControlEnvelope,
} from "../../control-admission.js";
import type { Stored } from "../../conversation-run-contracts.js";
import {
  corruptJobJournal,
  type JobJournalRecord,
  type TaskRevisionReplayViolation,
} from "../../job-run-contracts.js";
import type { KeyedMap, KeyedOrder } from "../../job-run-state.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import {
  occurrenceOrderKey,
  type JobBundle,
  type JobEnvelope,
  type JobStateEntry,
  type SystemJobResourceCoordinator,
} from "../contracts.js";
import { snapshot } from "./common.js";

export interface OccurrenceOrderStateSlice {
  readonly occurrenceOrder: Pick<KeyedOrder<string>, "range">;
  readonly occurrences: Pick<KeyedMap<string, JobOccurrence>, "get">;
}

export interface ScheduleOccurrenceStateSlice {
  readonly states: Pick<KeyedMap<string, JobStateEntry>, "get">;
  readonly outcomeByRun: Pick<
    KeyedMap<string, JobBundle["body"]["outcome"]>,
    "get"
  >;
}

export interface JobAttemptStateSlice {
  readonly assignmentAttemptByRun: Pick<ReadonlyMap<string, number>, "get">;
  readonly systemFences: Pick<ReadonlyMap<string, SystemJobFence>, "get">;
}

export function walkOccurrencesBackward(
  state: OccurrenceOrderStateSlice,
  before: Pick<JobOccurrence, "jobRunId" | "scheduledFor"> | undefined,
  accept: (occurrence: JobOccurrence) => boolean,
): void {
  let after = before ? occurrenceOrderKey(before) : undefined;
  let limit = 16;
  for (;;) {
    const rows = state.occurrenceOrder.range({
      ...(after === undefined ? {} : { after }),
      limit,
    });
    for (const row of rows) {
      const occurrence = state.occurrences.get(row.subject);
      if (!occurrence) {
        throw corruptJobJournal("Occurrence order names an unknown occurrence");
      }
      if (!accept(occurrence)) return;
    }
    if (rows.length < limit) return;
    after = rows.at(-1)!.sortKey;
    limit = Math.min(limit * 2, 256);
  }
}

export function scheduleOccurrenceOf(
  state: ScheduleOccurrenceStateSlice,
  occurrence: JobOccurrence,
): ScheduleOccurrence {
  const current = state.states.get(occurrence.jobRunId);
  const projected = validateJobOccurrence({
    ...snapshot(occurrence),
    state: current?.state ?? occurrence.state,
  });
  const outcome = state.outcomeByRun.get(occurrence.jobRunId);
  return { ...projected, ...(outcome ? { outcome: snapshot(outcome) } : {}) };
}

export function latestOccurrence(
  state: OccurrenceOrderStateSlice,
): JobOccurrence | undefined {
  const row = state.occurrenceOrder.range({ limit: 1 })[0];
  if (!row) return undefined;
  const occurrence = state.occurrences.get(row.subject);
  if (!occurrence) {
    throw corruptJobJournal("Occurrence order names an unknown occurrence");
  }
  return occurrence;
}

export function byOccurrenceOrder(
  state: { readonly occurrences: Pick<KeyedMap<string, JobOccurrence>, "get"> },
  jobRunIds: readonly string[],
): string[] {
  return jobRunIds
    .map((jobRunId) => {
      const occurrence = state.occurrences.get(jobRunId);
      if (!occurrence) {
        throw corruptJobJournal("Run directory names an unknown occurrence");
      }
      return occurrence;
    })
    .sort(compareJobOccurrences)
    .map((occurrence) => occurrence.jobRunId);
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createManualJobRunId(input: {
  readonly taskId: string;
  readonly requestId: string;
  readonly scheduledFor: string;
}): string {
  const timestamp = Date.parse(input.scheduledFor);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffffffffffff
  ) {
    throw new TypeError("Manual job timestamp is outside the ULID range");
  }
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  createHash("sha256")
    .update(canonicalize(input))
    .digest()
    .subarray(0, 10)
    .copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `jobrun-${encoded}`;
}

export function requireControlIngress(
  context: AtomicControlApplicationContext<JobControlEnvelope>,
): IngressContext {
  if (!context.ingress) {
    throw corruptJobJournal("Manual job control has no durable ingress context");
  }
  return validateIngressContext(context.ingress);
}

export function throwTaskDefinitionViolation(
  violation: TaskRevisionReplayViolation,
): never {
  switch (violation) {
    case "different-task":
      throw new TypeError("Task definition belongs to a different job journal");
    case "first-revision":
      throw new Error("First task definition must use revision 1");
    case "deleted-resurrection":
      throw new Error("Deleted task definitions cannot be resurrected");
    case "noncontiguous-revision":
      throw new Error("Task definition revision must advance exactly once");
    case "missing-previous-kind":
    case "kind-change":
      throw new Error("Task definition kind is immutable");
    case "missing-queued-cancellation":
    case "missing-assigned-cancellation":
    case "missing-uncertain-cancellation":
      throw corruptJobJournal(
        "Task revision construction lacks its atomic cancellation",
      );
  }
}

export function taskRevisionStopsQueued(definition: TaskDefinition): boolean {
  return definition.state !== "enabled";
}

export function taskRevisionStopsAssigned(definition: TaskDefinition): boolean {
  return definition.state === "deleted";
}

export function taskRevisionRecord(
  definition: TaskDefinition,
  stored: Stored<TaskDefinition>,
  operation?: {
    readonly operationId: string;
    readonly operationDigest: string;
  },
): Extract<JobJournalRecord, { t: "task-revision" }> {
  return {
    t: "task-revision",
    taskId: definition.taskId,
    taskRevision: definition.taskRevision,
    state: definition.state,
    kind: definition.definition.kind,
    def: stored,
    ...(operation
      ? {
          operationId: operation.operationId,
          operationDigest: operation.operationDigest,
        }
      : {}),
  };
}

export function deliveryPlan(
  definition: TaskDefinitionBody,
): JobOccurrence["deliveryPlan"] {
  const configured =
    definition.kind === "user" ? definition.spec.delivery : undefined;
  const delivery =
    definition.kind === "system"
      ? { kind: "none" as const }
      : configured && configured.kind !== "none"
        ? configured
        : definition.origin
          ? {
              kind: "channel" as const,
              channel: definition.origin.channelId,
              to: definition.origin.to,
              ...(definition.origin.threadId
                ? { threadId: definition.origin.threadId }
                : {}),
            }
          : { kind: "none" as const };
  return {
    delivery: snapshot(delivery),
    planDigest: jobDeliveryPlanDigest(delivery),
  };
}

export function nextJobAssignmentAttempt(
  state: JobAttemptStateSlice,
  jobRunId: string,
): number {
  let latest = state.assignmentAttemptByRun.get(jobRunId) ?? 0;
  const systemFence = state.systemFences.get(jobRunId);
  if (systemFence !== undefined) {
    latest = Math.max(latest, systemFence.attempt);
  }
  if (latest >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Job assignment attempt is exhausted");
  }
  return latest + 1;
}

export function prepareJobQueuedTerminal(
  coordinator:
    | AssignmentResourceCoordinator
    | SystemJobResourceCoordinator
    | undefined,
  state: JobAttemptStateSlice,
  jobRunId: string,
  reason: "cancelled" | "failed" | "expired",
): readonly LogicalRecord<GovernorRecord>[] {
  const attempt = nextJobAssignmentAttempt(state, jobRunId);
  return (coordinator?.prepareQueuedTerminal({
    workload: { kind: "job", id: jobRunId, attempt },
    reason,
  }) ?? [
    queuedTerminalDequeueRecord(
      { kind: "job", id: jobRunId, attempt },
      reason,
    ),
  ]) as readonly LogicalRecord<GovernorRecord>[];
}

export function assertDispatchMatchesOccurrence(
  envelope: JobEnvelope,
  occurrence: JobOccurrence,
  definition: TaskDefinition,
  anchorEpoch: number,
): void {
  if (definition.definition.kind !== "user") {
    throw corruptJobJournal(
      "System task was materialized as an executor dispatch",
    );
  }
  const expectedFence = createJobCommitFence({
    taskId: occurrence.taskId,
    jobRunId: occurrence.jobRunId,
    scheduledFor: occurrence.scheduledFor,
    taskRevision: occurrence.taskRevision,
    deliveryPlanDigest: occurrence.deliveryPlan.planDigest,
    anchorEpoch,
    assignmentId: envelope.assignmentId,
    executorId: envelope.executorId,
  });
  validateJobCommitFence(envelope.work.fence);
  if (
    envelope.execution !== "job" ||
    envelope.work.t !== "job" ||
    envelope.work.taskId !== occurrence.taskId ||
    envelope.work.jobRunId !== occurrence.jobRunId ||
    canonicalize(envelope.work.fence) !== canonicalize(expectedFence) ||
    canonicalize(envelope.work.instruction) !==
      canonicalize(definition.definition.spec.action)
  ) {
    throw corruptJobJournal("Job dispatch does not bind its frozen occurrence");
  }
}

export function assertSystemLease(
  lease: SystemJobResourceLease,
  taskId: string,
  jobRunId: string,
  anchorEpoch: number,
  attempt: number,
  verifier: ProtocolSignatureVerifier,
): void {
  validateSystemJobResourceLease(lease, verifier);
  if (
    lease.activation.kind !== "system-job" ||
    lease.activation.jobRunId !== jobRunId ||
    lease.workload.kind !== "job" ||
    lease.workload.id !== jobRunId ||
    lease.workload.attempt !== attempt ||
    lease.scopeBinding.kind !== "job" ||
    lease.scopeBinding.taskId !== taskId ||
    lease.scopeBinding.anchorEpoch !== anchorEpoch ||
    lease.domain.kind !== "anchor" ||
    lease.domain.anchorEpoch !== anchorEpoch
  ) {
    throw new Error("System job lease does not bind its anchor workload");
  }
}

export function assertForeignRecords(
  records: readonly LogicalRecord<unknown>[],
  authorityStream: string,
  label = "System resource transition",
): void {
  if (records.length === 0) {
    throw new Error(`${label} must produce durable records`);
  }
  if (records.some((record) => record.stream === authorityStream)) {
    throw new Error(`${label} cannot write the job authority stream`);
  }
}
