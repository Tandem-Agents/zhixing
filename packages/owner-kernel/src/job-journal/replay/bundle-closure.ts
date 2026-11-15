import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  resolveSealedBundleArtifactClosure,
  type ArtifactStore,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityError,
  CommitEnvelope,
  DeliveryIntentDto,
  JobOccurrence,
  JobRunState,
  JobStatusNotice,
  LedgerSnapshot,
  LogicalRecord,
  MutationBatch,
} from "@zhixing-ai/core/contracts";
import {
  compileDeliveryContent,
  DeliveryContentValidationError,
  type CompiledDeliveryContent,
} from "@zhixing-ai/core/delivery";
import {
  canonicalize,
  mutationBatchArtifact,
  sealedBundleArtifact,
  validateJobMutationBatch,
} from "@zhixing-ai/core/protocol";
import { bundleAcknowledgementBindsCommitted } from "../../conversation-run-contracts.js";
import type { JobStatusDeliveryInput } from "../../delivery-participant.js";
import {
  corruptJobJournal,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import type {
  AssignedJob,
  JobBundle,
  JobLifecycleEvent,
  JobProjection,
  JobStatusHistoryEntry,
} from "../contracts.js";
import { jobStream } from "../state/common.js";

export interface ValidatedJobBundleClosure {
  readonly artifact: ReturnType<typeof sealedBundleArtifact>;
  readonly batch?: MutationBatch;
  readonly references: ArtifactRef[];
}

export class JobBundleClosureError extends Error {
  constructor(
    readonly code: "invalid" | "missing-base",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JobBundleClosureError";
  }
}

export interface CompiledJobDeliveryContents {
  readonly result?: CompiledDeliveryContent;
  readonly stagedContents: ReadonlyMap<number, DeliveryIntentDto["content"]>;
  readonly stagedContentErrors: ReadonlyMap<number, AuthorityError>;
  readonly references: readonly ArtifactRef[];
}

export async function compileJobDeliveryContents(
  bundle: JobBundle,
  batch: MutationBatch | undefined,
  artifacts: ArtifactStore,
  deliveryRequired: boolean,
): Promise<CompiledJobDeliveryContents> {
  const result = deliveryRequired
    ? await compileDeliveryContent(bundle.body.outcome.summary, artifacts)
    : undefined;
  const stagedContents = new Map<number, DeliveryIntentDto["content"]>();
  const stagedContentErrors = new Map<number, AuthorityError>();
  const references: ArtifactRef[] = [...(result?.references ?? [])];
  for (const record of batch?.records ?? []) {
    if (record.mutation.kind !== "delivery-enqueue") continue;
    try {
      const compiled = await compileDeliveryContent(
        record.mutation.request.content,
        artifacts,
      );
      stagedContents.set(record.seq, compiled.content);
      references.push(...compiled.references);
    } catch (error) {
      if (!(error instanceof DeliveryContentValidationError)) throw error;
      stagedContentErrors.set(record.seq, {
        code: "invalid",
        message: "Delivery content is invalid or unavailable",
        retryable: false,
      });
    }
  }
  return { result, stagedContents, stagedContentErrors, references };
}

function jobBundleClosureReadError(
  error: unknown,
  message: string,
): JobBundleClosureError {
  return error instanceof AuthorityStorageError &&
    error.code === "artifact-missing"
    ? new JobBundleClosureError(
        "missing-base",
        `${message}: artifact is not present`,
        { cause: error },
      )
    : new JobBundleClosureError(
        "invalid",
        error instanceof Error ? `${message}: ${error.message}` : message,
        { cause: error },
      );
}

export async function validateJobBundleClosure(
  bundle: JobBundle,
  artifacts: ArtifactStore,
): Promise<ValidatedJobBundleClosure> {
  const artifact = sealedBundleArtifact(bundle);
  if (!(await artifacts.has(artifact.ref))) {
    throw new JobBundleClosureError(
      "missing-base",
      "Sealed job bundle artifact is not present",
    );
  }
  let closure: Awaited<ReturnType<typeof resolveSealedBundleArtifactClosure>>;
  try {
    closure = await resolveSealedBundleArtifactClosure(bundle, artifacts);
  } catch (error) {
    throw jobBundleClosureReadError(
      error,
      "Invalid sealed job bundle closure",
    );
  }

  const references = [artifact.ref, ...closure.transfer];
  let batch: MutationBatch | undefined;
  if (bundle.body.mutationBatch) {
    try {
      const bytes = await artifacts.get(bundle.body.mutationBatch.ref);
      const text = Buffer.from(bytes).toString("utf8");
      batch = validateJobMutationBatch(JSON.parse(text) as MutationBatch);
      const batchArtifact = mutationBatchArtifact(batch);
      if (
        canonicalize(batchArtifact.ref) !==
          canonicalize(bundle.body.mutationBatch.ref) ||
        canonicalize(batch) !== text ||
        bundle.body.mutationBatch.sessionCount !== 0 ||
        bundle.body.mutationBatch.globalCount !== batch.count ||
        batch.assignmentId !== bundle.assignmentId
      ) {
        throw new TypeError(
          "Mutation batch does not bind the job bundle summary",
        );
      }
    } catch (error) {
      throw jobBundleClosureReadError(error, "Invalid job mutation batch");
    }
  }
  return {
    artifact,
    ...(batch ? { batch } : {}),
    references,
  };
}

export function jobBundleBindsAssignedOccurrence(
  bundle: JobBundle,
  assigned: Pick<AssignedJob, "record" | "envelope">,
  occurrence: Pick<JobOccurrence, "taskId" | "jobRunId" | "deliveryPlan">,
): boolean {
  return (
    bundle.assignmentId === assigned.record.assignmentId &&
    bundle.executorId === assigned.record.executorId &&
    bundle.body.taskId === assigned.record.taskId &&
    bundle.body.jobRunId === assigned.record.jobRunId &&
    occurrence.taskId === assigned.record.taskId &&
    occurrence.jobRunId === assigned.record.jobRunId &&
    canonicalize(bundle.body.fence) ===
      canonicalize(assigned.envelope.work.fence) &&
    bundle.body.fence.deliveryPlanDigest === occurrence.deliveryPlan.planDigest
  );
}

export function jobStatusNotice(
  taskId: string,
  anchorEpoch: number,
  jobRunId: string,
  entry: JobStatusHistoryEntry,
): JobStatusNotice | undefined {
  const ref = { execution: "job" as const, taskId, jobRunId, anchorEpoch };
  if (entry.uncertainTransition === "opened") {
    if (entry.state !== "uncertain") {
      throw corruptJobJournal(
        "Job uncertainty opening has a non-uncertain state",
      );
    }
    return {
      v: 1,
      ref,
      state: "uncertain",
      statusRevision: entry.statusRevision,
      actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
    };
  }
  if (entry.uncertainTransition === "closed") {
    if (entry.resultingState !== entry.state) {
      throw corruptJobJournal(
        "Job uncertainty closure has a mismatched successor state",
      );
    }
    return {
      v: 1,
      ref,
      state: "uncertain-closed",
      statusRevision: entry.statusRevision,
      actions: [],
      at: entry.at,
      openFactDigest: entry.openFactDigest,
      closedBy: entry.closedBy,
      resultingState: entry.resultingState,
    } as JobStatusNotice;
  }
  if (entry.state === "committed") return undefined;
  if (entry.state === "uncertain") {
    throw corruptJobJournal("Job uncertainty has no durable open fact identity");
  }
  return {
    v: 1,
    ref,
    state: entry.state,
    statusRevision: entry.statusRevision,
    actions: [],
    at: entry.at,
  };
}

export function jobStatusNoticesForCommit(
  state: JobProjection,
  envelope: CommitEnvelope<unknown>,
  taskId: string,
  anchorEpoch: number,
): JobStatusNotice[] {
  const notices: JobStatusNotice[] = [];
  for (const record of envelope.entries) {
    if (record.stream !== jobStream(taskId)) continue;
    const body = record.body as JobJournalRecord;
    const identity =
      body.t === "occurrence"
        ? { jobRunId: body.occ.jobRunId, statusRevision: 1 }
        : body.t === "state"
          ? { jobRunId: body.jobRunId, statusRevision: body.statusRevision }
          : undefined;
    if (!identity) continue;
    const entry = state.statusHistoryByRun
      .get(identity.jobRunId)
      ?.find(
        (candidate) => candidate.statusRevision === identity.statusRevision,
      );
    if (!entry) {
      throw corruptJobJournal("Committed job status has no history projection");
    }
    const notice = jobStatusNotice(
      taskId,
      anchorEpoch,
      identity.jobRunId,
      entry,
    );
    if (notice) notices.push(notice);
  }
  return notices;
}

function assignmentIdFromJobRecord(
  record: JobJournalRecord,
): string | undefined {
  if (
    "assignmentId" in record &&
    typeof record.assignmentId === "string"
  ) {
    return record.assignmentId;
  }
  return record.t === "resolution"
    ? record.fact.subject.assignmentId
    : undefined;
}

export function jobLifecycleEventsForCommit(
  state: JobProjection,
  envelope: CommitEnvelope<unknown>,
  taskId: string,
  anchorEpoch: number,
): JobLifecycleEvent[] {
  const events: JobLifecycleEvent[] = [];
  const retiredCandidates = new Set<string>();
  const seenStates = new Set<string>();
  for (const record of envelope.entries) {
    if (record.stream !== jobStream(taskId)) continue;
    const body = record.body as JobJournalRecord;
    const identity =
      body.t === "occurrence"
        ? { jobRunId: body.occ.jobRunId, statusRevision: 1 }
        : body.t === "state"
          ? { jobRunId: body.jobRunId, statusRevision: body.statusRevision }
          : undefined;
    if (identity) {
      const key = `${identity.jobRunId}:${identity.statusRevision}`;
      if (!seenStates.has(key)) {
        seenStates.add(key);
        const projected = state.statusHistoryByRun
          .get(identity.jobRunId)
          ?.find(
            (entry) => entry.statusRevision === identity.statusRevision,
          );
        if (!projected) {
          throw corruptJobJournal(
            "Committed job lifecycle state has no projection",
          );
        }
        const assignmentId = assignmentIdFromJobRecord(body);
        events.push({
          kind: "job-state-changed",
          ref: {
            execution: "job",
            taskId,
            jobRunId: identity.jobRunId,
            anchorEpoch,
          },
          state: projected.state,
          statusRevision: projected.statusRevision,
          ...(assignmentId ? { assignmentId } : {}),
          at: envelope.at,
        });
      }
    }
    const assignmentId = assignmentIdFromJobRecord(body);
    if (assignmentId) retiredCandidates.add(assignmentId);
  }
  for (const assignmentId of retiredCandidates) {
    if (
      state.recoveryAssignments.has(assignmentId) ||
      state.bundleAcknowledgementOutbox.has(assignmentId)
    ) {
      continue;
    }
    const assigned = state.assignedById.get(assignmentId);
    if (!assigned) continue;
    events.push({
      kind: "assignment-retired",
      ref: {
        execution: "job",
        taskId,
        jobRunId: assigned.record.jobRunId,
        anchorEpoch,
      },
      assignmentId,
      at: envelope.at,
    });
  }
  return events;
}

function occurrenceInEntries(
  entries: readonly LogicalRecord<unknown>[],
  taskId: string,
  jobRunId: string,
): JobOccurrence | undefined {
  for (const entry of entries) {
    if (entry.stream !== jobStream(taskId)) continue;
    const body = entry.body as Partial<JobJournalRecord>;
    if (body.t === "occurrence" && "occ" in body) {
      const occurrence = body.occ as JobOccurrence;
      if (occurrence.jobRunId === jobRunId) return occurrence;
    }
  }
  return undefined;
}

export function jobStatusDeliveryInputs(
  taskId: string,
  state: Pick<JobProjection, "occurrences" | "definitions">,
  entries: readonly LogicalRecord<unknown>[],
  at: string,
): JobStatusDeliveryInput[] {
  const result: JobStatusDeliveryInput[] = [];
  for (const entry of entries) {
    if (entry.stream !== jobStream(taskId)) continue;
    const body = entry.body as Partial<JobJournalRecord>;
    if (
      body.t !== "state" ||
      !("jobRunId" in body) ||
      !("state" in body) ||
      !("statusRevision" in body)
    ) {
      continue;
    }
    const jobRunId = body.jobRunId as string;
    const occurrence =
      state.occurrences.get(jobRunId) ??
      occurrenceInEntries(entries, taskId, jobRunId);
    if (!occurrence) {
      throw corruptJobJournal(
        "Job state has no occurrence for status delivery",
      );
    }
    const definition = state.definitions.get(occurrence.taskRevision);
    if (!definition) {
      throw corruptJobJournal("Job status delivery has no task definition");
    }
    result.push({
      at,
      occurrence,
      definition,
      state: body.state as JobRunState,
      statusRevision: body.statusRevision as number,
    });
  }
  return result;
}

export function bundleAcknowledgementRecord(
  assignmentId: string,
  committed: Pick<
    Extract<JobJournalRecord, { t: "committed" }>,
    "bundle" | "jobRevision"
  >,
): Extract<JobJournalRecord, { t: "bundle-ack-observed" }> {
  return {
    t: "bundle-ack-observed",
    assignmentId,
    bundleRef: committed.bundle.ref,
    jobRevision: committed.jobRevision,
  };
}

export function assertLedgerAcknowledgesCommittedBundle(
  ledger: Pick<
    LedgerSnapshot,
    "sealedBundleRef" | "acknowledgedCommitRevision"
  >,
  expected: Extract<JobJournalRecord, { t: "bundle-ack-observed" }>,
): void {
  if (
    !bundleAcknowledgementBindsCommitted({
      observedBundleRef: ledger.sealedBundleRef,
      observedCommitRevision: ledger.acknowledgedCommitRevision,
      expectedBundleRef: expected.bundleRef,
      expectedCommitRevision: expected.jobRevision,
    })
  ) {
    throw new Error(
      "Bundle acknowledgement does not bind the committed job revision",
    );
  }
}
