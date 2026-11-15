import {
  awaitAuthorityPreparation,
  type ArtifactStore,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityCallContext,
  AuthorityError,
  JobOccurrence,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  SealedBundle,
  TaskDefinition,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  createJobCommitFence,
  sealedBundleArtifact,
  validateJobSealedBundle,
  validatePublishDecisionForBatch,
  verifyProtocolStep,
} from "@zhixing-ai/core/protocol";
import { projectSchedulePublishNotices } from "@zhixing-ai/core/scheduler/application";
import type { JobDeliveryParticipant } from "../../delivery-participant.js";
import {
  corruptJobJournal,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import type { SchedulerUserNoticeJournal } from "../../scheduler-user-notices.js";
import type {
  AssignmentSubmissionAuthorization,
  AssignmentSubmissionIdentity,
  AssignmentSubmissionPreflightResult,
} from "../../shared-protocol/contracts.js";
import { decideSubmissionBundleGuardRejection } from "../../shared-protocol/submission-authorization.js";
import type {
  AssignedJob,
  JobBundle,
  JobCommitParticipant,
  JobResolutionFact,
} from "../contracts.js";
import {
  buildJobBundleCommitEntries,
  validateJobBundleAtPrefix,
} from "../operations/terminal-commit-system.js";
import {
  compileJobDeliveryContents,
  JobBundleClosureError,
  validateJobBundleClosure,
  type CompiledJobDeliveryContents,
} from "../replay/bundle-closure.js";
import { jobRecord, jobStream, rejected, stateRecord } from "../state/common.js";
import { assertForeignRecords } from "../state/task-schedule.js";
import type {
  DeepReadonly,
  JobDecisionFacts,
  JobGuardDecisionFacts,
} from "../state/views.js";

export interface PreparedJobBundleSubmission {
  readonly assignmentId: string;
  readonly bundle: JobBundle;
  readonly artifact: ReturnType<typeof sealedBundleArtifact>;
  readonly batch?: MutationBatch;
  readonly compiledDelivery: CompiledJobDeliveryContents;
  readonly candidateReferences: readonly ArtifactRef[];
  readonly readProjectionIds: readonly string[];
}

export type PrepareJobBundleSubmissionOutcome =
  | {
      readonly kind: "return";
      readonly result:
        | { readonly committed: true; readonly commitRevision: number }
        | { readonly committed: false; readonly error: AuthorityError };
    }
  | {
      readonly kind: "prepared";
      readonly submission: PreparedJobBundleSubmission;
    };

export interface JobSubmissionGuardAccess {
  readonly taskId: string;
  authenticateSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void;
  loadSubmissionGuard(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<JobGuardDecisionFacts>;
  hasCurrentSubmissionAuthority(context: AuthorityCallContext): boolean;
  authorizeGuardSubmission(
    guard: JobGuardDecisionFacts,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void;
  assertAssignmentUsageFinal(
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: JobBundle["usageFinal"],
  ): void;
}

export async function preflightJobBundleGuard(input: {
  readonly context: AuthorityCallContext;
  readonly identity: AssignmentSubmissionIdentity;
  readonly guardAccess: JobSubmissionGuardAccess;
}): Promise<AssignmentSubmissionPreflightResult> {
  const { context, identity, guardAccess } = input;
  guardAccess.authenticateSubmission(context, identity);
  const guard = await guardAccess.loadSubmissionGuard(context, identity);
  if (identity.method !== "submission.submitBundle") {
    return { kind: "continue" };
  }
  const assigned = guard.getAssigned(identity.assignmentId);
  if (!assigned) {
    throw new Error(
      "Bundle capability is not activated by a durable job assignment",
    );
  }
  if (!guard.getOccurrence(assigned.record.jobRunId)) {
    throw new Error("Bundle assignment has no durable occurrence");
  }
  if (guard.getCommitted(identity.assignmentId) !== undefined) {
    return { kind: "continue" };
  }
  const rejectionMessage = decideSubmissionBundleGuardRejection({
    domain: "job",
    hasCurrentAuthority: guardAccess.hasCurrentSubmissionAuthority(context),
    assignmentIsCurrent:
      guard.getAssignmentIdForJob(assigned.record.jobRunId) ===
      identity.assignmentId,
    hasOpenDispatchConflict: guard.hasOpenConflict(identity.assignmentId),
    currentState: guard.getRunState(assigned.record.jobRunId)?.state,
  });
  if (!rejectionMessage) return { kind: "continue" };
  await verifyProtocolStep(() =>
    guardAccess.authorizeGuardSubmission(guard, context, {
      mode: "durable-rejection",
      method: "submission.submitBundle",
      assignmentId: identity.assignmentId,
    }),
  );
  return {
    kind: "return",
    result: rejected("fence-rejected", rejectionMessage, false),
  };
}

export async function prepareJobBundleSubmission(input: {
  readonly rawBundle: SealedBundle;
  readonly context: AuthorityCallContext;
  readonly artifacts: ArtifactStore;
  readonly commitParticipant: JobCommitParticipant | undefined;
  readonly guardAccess: JobSubmissionGuardAccess;
}): Promise<PrepareJobBundleSubmissionOutcome> {
  const { rawBundle, context, artifacts, commitParticipant, guardAccess } =
    input;
  if (context.principal.kind !== "assignment") {
    throw new Error("Bundle submission requires an assignment capability");
  }
  const assignmentId = context.principal.capability.assignmentId;
  guardAccess.authenticateSubmission(context, {
    method: "submission.submitBundle",
    assignmentId,
  });
  const guard = await guardAccess.loadSubmissionGuard(context, {
    method: "submission.submitBundle",
    assignmentId,
  });
  const guardAssigned = guard.getAssigned(assignmentId);
  if (!guardAssigned) {
    throw new Error(
      "Bundle capability is not activated by a durable job assignment",
    );
  }
  const guardOccurrence = guard.getOccurrence(guardAssigned.record.jobRunId);
  if (!guardOccurrence) {
    throw new Error("Bundle assignment has no durable occurrence");
  }
  const guardCommitted = guard.getCommitted(assignmentId);
  if (!guardCommitted) {
    const guardState = guard.getRunState(guardAssigned.record.jobRunId)?.state;
    const rejectionMessage = decideSubmissionBundleGuardRejection({
      domain: "job",
      hasCurrentAuthority: guardAccess.hasCurrentSubmissionAuthority(context),
      assignmentIsCurrent:
        guard.getAssignmentIdForJob(guardAssigned.record.jobRunId) ===
        assignmentId,
      hasOpenDispatchConflict: guard.hasOpenConflict(assignmentId),
      currentState: guardState,
    });
    if (rejectionMessage) {
      await verifyProtocolStep(() =>
        guardAccess.authorizeGuardSubmission(guard, context, {
          mode: "durable-rejection",
          method: "submission.submitBundle",
          assignmentId,
        }),
      );
      return {
        kind: "return",
        result: rejected("fence-rejected", rejectionMessage, false),
      };
    }
    await verifyProtocolStep(() =>
      guardAccess.authorizeGuardSubmission(guard, context, {
        mode: guardState === "uncertain" ? "settlement" : "active",
        method: "submission.submitBundle",
        assignmentId,
      }),
    );
  }
  let bundle: JobBundle;
  try {
    bundle = validateJobSealedBundle(rawBundle);
  } catch (error) {
    return {
      kind: "return",
      result: rejected(
        "invalid",
        error instanceof Error ? error.message : "Invalid job bundle",
        false,
      ),
    };
  }
  if (bundle.assignmentId !== assignmentId) {
    return {
      kind: "return",
      result: rejected(
        "fence-rejected",
        "Bundle does not bind the authenticated assignment",
        false,
      ),
    };
  }
  if (guardCommitted) {
    const artifact = sealedBundleArtifact(bundle);
    if (canonicalize(guardCommitted.ref) !== canonicalize(artifact.ref)) {
      await verifyProtocolStep(() =>
        guardAccess.authorizeGuardSubmission(guard, context, {
          mode: "active",
          method: "submission.submitBundle",
          assignmentId,
        }),
      );
      return {
        kind: "return",
        result: rejected(
          "fence-rejected",
          "Assignment committed another bundle",
          false,
        ),
      };
    }
    const occurrence = guard.getOccurrence(guardAssigned.record.jobRunId);
    if (!occurrence) {
      throw corruptJobJournal(
        "Committed job assignment has no durable occurrence",
      );
    }
    const capability = context.principal.capability;
    const expectedFence = createJobCommitFence({
      taskId: guardAccess.taskId,
      jobRunId: guardAssigned.record.jobRunId,
      scheduledFor: occurrence.scheduledFor,
      taskRevision: guardAssigned.record.taskRevision,
      deliveryPlanDigest: guardAssigned.record.deliveryPlanDigest,
      anchorEpoch: guardAssigned.record.anchorEpoch,
      assignmentId,
      executorId: guardAssigned.record.executorId,
    });
    if (
      capability.scope.execution !== "job" ||
      !("anchorEpoch" in capability) ||
      capability.anchorEpoch !== guardAssigned.record.anchorEpoch ||
      bundle.body.taskId !== guardAccess.taskId ||
      bundle.body.jobRunId !== guardAssigned.record.jobRunId ||
      bundle.executorId !== guardAssigned.record.executorId ||
      canonicalize(bundle.body.fence) !== canonicalize(expectedFence)
    ) {
      throw corruptJobJournal(
        "Committed bundle does not match its durable assignment fence",
      );
    }
    await verifyProtocolStep(() =>
      guardAccess.authorizeGuardSubmission(guard, context, {
        mode: "durable-replay",
        method: "submission.submitBundle",
        assignmentId,
      }),
    );
    // 已提交的重放在日志事务之外核对用量终值：调控状态待装入时补齐后重做
    const assignedRecord =
      guardAssigned.record as unknown as Extract<
        JobJournalRecord,
        { t: "assigned" }
      >;
    for (let rounds = 0; ; rounds++) {
      try {
        guardAccess.assertAssignmentUsageFinal(
          assignedRecord,
          bundle.usageFinal,
        );
        break;
      } catch (error) {
        if (rounds >= 64 || !(await awaitAuthorityPreparation(error))) {
          throw error;
        }
      }
    }
    commitParticipant?.wakePendingPublishing?.(guardAccess.taskId);
    return {
      kind: "return",
      result: { committed: true, commitRevision: guardCommitted.jobRevision },
    };
  }

  let closure: Awaited<ReturnType<typeof validateJobBundleClosure>>;
  try {
    closure = await validateJobBundleClosure(bundle, artifacts);
  } catch (error) {
    if (error instanceof JobBundleClosureError) {
      return {
        kind: "return",
        result: rejected(error.code, error.message, false),
      };
    }
    throw error;
  }
  const compiledDelivery = await compileJobDeliveryContents(
    bundle,
    closure.batch,
    artifacts,
    guardOccurrence.deliveryRequired,
  );
  const stagedReferences = closure.batch
    ? (await commitParticipant?.collectStagedReferences?.(closure.batch)) ?? []
    : [];
  const submission: PreparedJobBundleSubmission = Object.freeze({
    assignmentId,
    bundle,
    artifact: closure.artifact,
    ...(closure.batch ? { batch: closure.batch } : {}),
    compiledDelivery,
    candidateReferences: Object.freeze([
      ...closure.references,
      ...compiledDelivery.references,
      ...stagedReferences,
    ]),
    readProjectionIds: Object.freeze([
      ...(commitParticipant?.readProjectionIds ?? []),
    ]),
  });
  return { kind: "prepared", submission };
}

export async function prepareJobCommitCompanions(input: {
  readonly taskId: string;
  readonly localExecutorId: string | undefined;
  readonly submission: PreparedJobBundleSubmission;
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
  readonly prefix: ProjectionTransactionContext;
  readonly closedAt: string;
  readonly delivery: JobDeliveryParticipant;
  readonly commitParticipant: JobCommitParticipant | undefined;
  readonly schedulerNotices: SchedulerUserNoticeJournal | undefined;
  readonly facts: Pick<JobDecisionFacts, "assignment" | "channel">;
}): Promise<
  ProjectionTransactionDecision<
    unknown,
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  >
> {
  const {
    taskId,
    localExecutorId,
    submission,
    assigned,
    occurrence,
    definition,
    prefix,
    delivery,
    commitParticipant,
    schedulerNotices,
    facts,
  } = input;
  const { assignmentId, bundle, artifact, batch: mutationBatch, compiledDelivery } =
    submission;

  const deliveryResult = await delivery.prepareJobCommit(
    {
      at: prefix.at,
      occurrence,
      definition,
      bundle,
      assignmentLifecycleSource: {
        owner: "assignment",
        id: `${assigned.record.executorId === localExecutorId ? "local" : "relay"}:${assignmentId}`,
        revision: assigned.record.dispatchDigest,
      },
      ...(mutationBatch ? { mutationBatch } : {}),
      ...(compiledDelivery.result
        ? { resultContent: compiledDelivery.result.content }
        : {}),
      stagedContents: compiledDelivery.stagedContents,
      stagedContentErrors: compiledDelivery.stagedContentErrors,
    },
    prefix,
  );
  if (!deliveryResult.accepted) {
    return {
      kind: "return",
      value: { committed: false as const, error: deliveryResult.error },
    };
  }
  if (deliveryResult.records.length > 0) {
    assertForeignRecords(
      deliveryResult.records,
      jobStream(taskId),
      "Job delivery participant",
    );
  }

  const requiresMutationParticipant =
    mutationBatch?.records.some(
      (record) => record.mutation.kind !== "delivery-enqueue",
    ) === true;
  let mutationRecords: readonly LogicalRecord<unknown>[] = [];
  let mutationOutcomes: ReadonlyMap<
    number,
    Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"]
  > = new Map();
  if (requiresMutationParticipant) {
    if (!mutationBatch || !commitParticipant) {
      return {
        kind: "return",
        value: rejected(
          "capability-gap",
          "Job staged mutation requires its owning commit participant",
          false,
        ),
      };
    }
    const prepared = await commitParticipant.prepare({
      authorityPrefixLsn: prefix.lastLsn,
      authorityContext: prefix,
      occurrence,
      bundle,
      mutationBatch,
    });
    if (!prepared.accepted) {
      return {
        kind: "return",
        value: { committed: false as const, error: prepared.error },
      };
    }
    assertForeignRecords(
      prepared.records,
      jobStream(taskId),
      "Job mutation commit participant",
    );
    if (prepared.records.some((record) => record.stream === "delivery")) {
      throw new Error(
        "Job mutation commit participant cannot write the delivery stream",
      );
    }
    mutationRecords = prepared.records;
    mutationOutcomes = prepared.outcomes;
  }

  const publishOutcomes: Extract<
    PublishRecord,
    { t: "publish-decision" }
  >["outcomes"] = [];
  for (const record of mutationBatch?.records ?? []) {
    const outcome =
      record.mutation.kind === "delivery-enqueue"
        ? deliveryResult.stagedRevisions.has(record.seq)
          ? {
              t: "granted" as const,
              targetRevision: deliveryResult.stagedRevisions.get(record.seq)!,
            }
          : deliveryResult.stagedConflicts.has(record.seq)
            ? {
                t: "conflicted" as const,
                error: deliveryResult.stagedConflicts.get(record.seq)!,
              }
            : undefined
        : mutationOutcomes.get(record.seq);
    if (!outcome) {
      throw new Error("Job publish decision omitted a staged mutation");
    }
    publishOutcomes.push({ seq: record.seq, outcome });
  }

  let publishDecisionRecord:
    | LogicalRecord<Extract<PublishRecord, { t: "publish-decision" }>>
    | undefined;
  let publishProgressRecord:
    | LogicalRecord<Extract<PublishRecord, { t: "publish-progress" }>>
    | undefined;
  const schedulerNoticeRecords: LogicalRecord<unknown>[] = [];

  if (mutationBatch && bundle.body.mutationBatch) {
    const decision = {
      t: "publish-decision",
      assignmentId,
      batch: { ref: bundle.body.mutationBatch.ref },
      sessionCount: 0,
      globalCount: bundle.body.mutationBatch.globalCount,
      outcomes: publishOutcomes,
    } satisfies Extract<PublishRecord, { t: "publish-decision" }>;
    validatePublishDecisionForBatch(decision, mutationBatch);
    publishDecisionRecord = {
      stream: "publish",
      body: decision,
    };
    if (
      mutationBatch.records.some(
        (record) =>
          record.domain === "global" &&
          record.mutation.kind !== "delivery-enqueue",
      )
    ) {
      publishProgressRecord = {
        stream: "publish",
        body: {
          t: "publish-progress",
          assignmentId,
          domain: "global",
          upToSeq: 0,
          state: "pending",
        } satisfies Extract<PublishRecord, { t: "publish-progress" }>,
      };
    }
    if (schedulerNotices) {
      const candidateEnvelopePrefix: LogicalRecord<unknown>[] = [
        jobRecord(taskId, {
          t: "committed",
          jobRunId: assigned.record.jobRunId,
          assignmentId,
          bundle: { ref: artifact.ref },
          jobRevision: facts.channel.nextJobRevision,
        }),
        ...facts.assignment.capabilityRevocationsFor(taskId, assigned),
        stateRecord(
          taskId,
          assigned.record.jobRunId,
          "committed",
          input.currentStatusRevision + 1,
          assignmentId,
        ),
        ...deliveryResult.records,
        ...mutationRecords,
        publishDecisionRecord,
        ...(publishProgressRecord ? [publishProgressRecord] : []),
      ];
      for (const draft of projectSchedulePublishNotices({
        taskId,
        jobRunId: occurrence.jobRunId,
        assignmentId,
        definition,
        batch: mutationBatch,
        outcomes: publishOutcomes,
        at: prefix.at,
      })) {
        const noticeEntries = await schedulerNotices.prepareRecords(
          draft,
          prefix,
          candidateEnvelopePrefix,
        );
        schedulerNoticeRecords.push(...noticeEntries);
        candidateEnvelopePrefix.push(...noticeEntries);
      }
    }
  }

  const built = buildJobBundleCommitEntries({
    taskId,
    assignmentId,
    bundle,
    bundleArtifactRef: artifact.ref,
    assigned,
    currentStatusRevision: input.currentStatusRevision,
    currentState: input.currentState,
    openResolution: input.openResolution,
    deliveryRecords: deliveryResult.records,
    mutationRecords,
    publishDecisionRecord,
    publishProgressRecord,
    schedulerNoticeRecords,
    closedAt: input.closedAt,
    facts,
  });

  return {
    kind: "append",
    entries: built.entries,
    value: { committed: true, commitRevision: built.jobRevision },
  };
}

export async function decideLockedJobBundleSubmission(input: {
  readonly taskId: string;
  readonly localExecutorId: string | undefined;
  readonly context: AuthorityCallContext;
  readonly submission: PreparedJobBundleSubmission;
  readonly prefix: ProjectionTransactionContext;
  readonly closedAt: string;
  readonly delivery: JobDeliveryParticipant;
  readonly commitParticipant: JobCommitParticipant | undefined;
  readonly schedulerNotices: SchedulerUserNoticeJournal | undefined;
  readonly authorizeSubmission: (
    facts: Pick<JobDecisionFacts, "assignment">,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ) => void;
  readonly assertAssignmentUsageFinal: (
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: JobBundle["usageFinal"],
  ) => void;
  readonly facts: JobDecisionFacts;
}): Promise<
  ProjectionTransactionDecision<
    unknown,
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  >
> {
  const { submission, context, facts } = input;
  const { assignmentId, bundle, artifact } = submission;
  const validated = validateJobBundleAtPrefix({
    assignmentId,
    bundle,
    bundleArtifactRef: artifact.ref,
    authorizeReplay: () =>
      input.authorizeSubmission(facts, context, {
        mode: "durable-replay",
        method: "submission.submitBundle",
        assignmentId,
      }),
    authorizeRejection: () =>
      input.authorizeSubmission(facts, context, {
        mode: "durable-rejection",
        method: "submission.submitBundle",
        assignmentId,
      }),
    authorizeActiveOrSettlement: (mode) =>
      input.authorizeSubmission(facts, context, {
        mode,
        method: "submission.submitBundle",
        assignmentId,
      }),
    assertAssignmentUsageFinal: input.assertAssignmentUsageFinal,
    facts,
  });
  if (validated.kind === "return") {
    return { kind: "return", value: validated.value };
  }
  return prepareJobCommitCompanions({
    taskId: input.taskId,
    localExecutorId: input.localExecutorId,
    submission,
    assigned: validated.assigned,
    occurrence: validated.occurrence,
    definition: validated.definition,
    currentStatusRevision: validated.currentStatusRevision,
    currentState: validated.currentState,
    openResolution: validated.openResolution,
    prefix: input.prefix,
    closedAt: input.closedAt,
    delivery: input.delivery,
    commitParticipant: input.commitParticipant,
    schedulerNotices: input.schedulerNotices,
    facts,
  });
}
