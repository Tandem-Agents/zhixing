import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  CancelProofBody,
  CommitEnvelope,
  ConversationRunState,
  LogicalRecord,
  MutationBatch,
  SealedBundle,
  TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import { admittedConversationRunLifecycleSource } from "@zhixing-ai/core/delivery";
import {
  assertQueuedTerminalDequeue,
  canonicalize,
  sealedBundleArtifact,
  validateConversationSealedBundle,
} from "@zhixing-ai/core/protocol";
import { validateWorksceneContinuationCommit } from "@zhixing-ai/core/workscene/application";
import { conversationCommitSummary } from "../../conversation-commit-summary.js";
import {
  assertCommittedReplayContract,
  assertHistoricalBundleFence,
  assertStateAtomicReplayContract,
  assertStateReplayContract,
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import type {
  ConversationCommitLogRecord,
  ConversationFactGroup,
  ConversationRunReductionContext,
  ConversationUncertainResolutionFact,
  RunProjection,
  SubmissionCommitSidecars,
  SubmissionGuardProjection,
} from "../contracts.js";
import {
  applyGuardStateTransition,
  applyRunStateTransition,
  clearRecoveryAssignment,
  computeNextActiveRunId,
  conversationResolutionFactsInEnvelope,
  envelopeClosesAssignment,
  envelopeHasRunRecord,
  envelopeHasRunState,
  envelopeRevokesCapabilities,
  envelopeRevokesRemainingCapabilities,
  nextConversationAssignmentAttempt,
  requireAssignedEnvelope,
} from "../state/assignment-control.js";
import {
  applyCommittedBundle,
  applyGuardCommittedBundle,
} from "../state/commit-publish.js";
import {
  applyQueueMembershipDelta,
  assertRunInputCommit,
  expectedRunInputMessages,
} from "../state/run-queue-input.js";
import { applyCommittedSessionEffects } from "../state/session-domain.js";
import {
  conversationStatusDeliveryInputs,
  envelopeContainsCommit,
  envelopeHasConversationCommitSidecars,
  isOperationalArtifactFailure,
  submissionCommitSidecars,
  validateConversationBundleClosure,
  type ValidatedConversationBundleClosure,
  type ValidatedConversationReplayClosure,
} from "./bundle-binding.js";

export interface StateJointTransitionEffect {
  readonly runId: string;
  readonly body: Extract<ConversationRunJournalRecord, { t: "state" }>;
  readonly queuedPosition: number;
  readonly previousState: ConversationRunState | undefined;
  readonly nextActiveRunId: string | undefined;
  readonly uncertainOrigin?: {
    readonly assignmentId: string;
    readonly origin: "dispatched" | "running" | "cancel-requested";
  };
  readonly envelopeAt: string;
  readonly resolutionsInEnvelope: readonly ConversationUncertainResolutionFact[];
}

export interface GuardStateJointTransitionEffect {
  readonly runId: string;
  readonly body: Extract<ConversationRunJournalRecord, { t: "state" }>;
  readonly queuedPosition: number;
  readonly previousState: ConversationRunState | undefined;
  readonly nextActiveRunId: string | undefined;
}

export interface CommittedJointTransitionEffect {
  readonly body: Extract<ConversationRunJournalRecord, { t: "committed" }>;
  readonly runRecord?: TranscriptRunRecord;
  readonly isWorksceneContinuation: boolean;
  readonly batchRecords: readonly MutationBatch["records"][number][];
  readonly envelopeAt: string;
}

export interface GuardCommittedJointTransitionEffect {
  readonly assignmentId: string;
  readonly bundle: { readonly ref: ArtifactRef };
  readonly commitRevision: number;
  readonly sidecars: SubmissionCommitSidecars;
}

/**
 * Two-phase joint transition for `state` records on `RunProjection`:
 * Phase 1 validates against the immutable pre-state snapshot after prior records
 * in the same envelope and computes a pure `StateJointTransitionEffect`;
 * Phase 2 applies `run-queue-input` -> `assignment-control` deltas in fixed order.
 */
export async function applyConversationStateJointTransition(input: {
  readonly context: ConversationRunReductionContext;
  readonly state: RunProjection;
  readonly body: Extract<ConversationRunJournalRecord, { t: "state" }>;
  readonly envelope: CommitEnvelope<ConversationCommitLogRecord>;
  readonly verify: (check: () => void) => Promise<void>;
}): Promise<RunProjection> {
  const { context, state, body, envelope, verify } = input;

  // Phase 1: Capture candidate pre-state & validate before mutating any family
  const admitted = state.admittedByRun.get(body.runId);
  if (!admitted) {
    throw corruptRunJournal("Run state has no admitted run");
  }
  const previous = state.stateByRun.get(body.runId);
  const previousState = previous?.state;
  const previousRevision = previous?.statusRevision;
  const mappedAssignmentId = state.assignmentByRun.get(body.runId);
  const preActiveRunId = state.activeRunId;
  const queuedPosition = admitted.record.queuedPosition;

  try {
    context.delivery?.assertConversationStatuses(
      conversationStatusDeliveryInputs(
        context.conversationId,
        state,
        envelope.entries,
        envelope.at,
      ),
      envelope,
    );
  } catch (error) {
    throw corruptRunJournal(
      error instanceof Error
        ? `Conversation status delivery is invalid: ${error.message}`
        : "Conversation status delivery is invalid",
    );
  }

  const closedEarlierInEnvelope =
    body.assignmentId !== undefined &&
    mappedAssignmentId === undefined &&
    state.closedAssignments.has(body.assignmentId) &&
    envelopeClosesAssignment(
      envelope,
      context.conversationId,
      body.runId,
      body.assignmentId,
    );
  assertStateReplayContract({
    currentState: previousState,
    currentRevision: previousRevision,
    nextState: body.state,
    nextRevision: body.statusRevision,
    assignmentId: body.assignmentId,
    assignmentBindingValid:
      mappedAssignmentId === body.assignmentId || closedEarlierInEnvelope,
    unassignedBindingValid: mappedAssignmentId === undefined,
    hasAtomicAssignment:
      previousState !== "queued" ||
      body.state !== "dispatched" ||
      envelopeHasRunRecord(
        envelope,
        context.conversationId,
        (candidate) =>
          candidate.t === "assigned" &&
          candidate.runId === body.runId &&
          candidate.assignmentId === body.assignmentId,
      ),
  });
  if (
    previousState === "queued" &&
    (body.state === "cancelled" ||
      body.state === "failed" ||
      body.state === "expired")
  ) {
    try {
      assertQueuedTerminalDequeue(
        envelope.entries,
        {
          kind: "run",
          id: body.runId,
          attempt: nextConversationAssignmentAttempt(state, body.runId),
        },
        body.state,
      );
    } catch (error) {
      throw corruptRunJournal(
        error instanceof Error
          ? error.message
          : "Queued run resource dequeue is invalid",
      );
    }
  }
  const latestCommitted = state.commits.at(-1);
  assertStateAtomicReplayContract({
    currentState: previousState,
    nextState: body.state,
    hasAtomicCancelFence: envelopeHasRunRecord(
      envelope,
      context.conversationId,
      (candidate) =>
        candidate.t === "cancel-fence" &&
        candidate.assignmentId === body.assignmentId &&
        state.assignedById.get(candidate.assignmentId)?.record.runId ===
          body.runId,
    ),
    hasAtomicOpenResolution: envelopeHasRunRecord(
      envelope,
      context.conversationId,
      (candidate) =>
        candidate.t === "resolution" &&
        candidate.runId === body.runId &&
        candidate.fact.subject.assignmentId === body.assignmentId &&
        candidate.fact.resolution === undefined,
    ),
    hasAtomicSupersede: envelopeHasRunRecord(
      envelope,
      context.conversationId,
      (candidate) =>
        candidate.t === "assignment-superseded" &&
        candidate.assignmentId === body.assignmentId &&
        state.assignedById.get(candidate.assignmentId)?.record.runId ===
          body.runId,
    ),
    hasAtomicTermination: envelopeHasRunRecord(
      envelope,
      context.conversationId,
      (candidate) =>
        (candidate.t === "cancel-proof-accepted" ||
          candidate.t === "assignment-superseded") &&
        candidate.assignmentId === body.assignmentId &&
        state.assignedById.get(candidate.assignmentId)?.record.runId ===
          body.runId,
    ),
    hasAtomicResolutionClose: envelopeHasRunRecord(
      envelope,
      context.conversationId,
      (candidate) =>
        candidate.t === "resolution" &&
        candidate.runId === body.runId &&
        candidate.fact.subject.assignmentId === body.assignmentId &&
        candidate.fact.resolution !== undefined,
    ),
    hasAtomicCommit:
      latestCommitted !== undefined &&
      latestCommitted.runId === body.runId &&
      latestCommitted.assignmentId === body.assignmentId &&
      envelopeContainsCommit(envelope, context.conversationId, latestCommitted),
  });
  if (
    body.state === "failed" &&
    body.assignmentId !== undefined &&
    (!state.assignedById.has(body.assignmentId) ||
      !envelopeRevokesRemainingCapabilities(
        envelope,
        context.conversationId,
        state.revokedCapabilities,
        state,
        state.assignedById.get(body.assignmentId)!,
      ))
  ) {
    throw corruptRunJournal(
      "Assigned failure is not atomic with capability revocation",
    );
  }
  if (body.state === "failed" && body.assignmentId !== undefined) {
    const assigned = state.assignedById.get(body.assignmentId);
    if (!assigned) throw corruptRunJournal("Assigned failure has no assignment");
    const assignedRecord = assigned.record;
    const usageFinal = body.usageFinal;
    const envelopeEntries = envelope.entries;
    if (usageFinal) {
      await verify(() => {
        context.assertResourceUsageFinal(assignedRecord, usageFinal);
      });
    }
    const terminalMode = usageFinal ? "settle-release" : "reclaim";
    await verify(() => {
      context.assertResourceTerminalRecords(
        assignedRecord,
        terminalMode,
        envelopeEntries,
      );
    });
  }

  let uncertainOrigin:
    | {
        readonly assignmentId: string;
        readonly origin: "dispatched" | "running" | "cancel-requested";
      }
    | undefined;
  if (body.state === "uncertain" && previousState !== "uncertain") {
    if (
      !mappedAssignmentId ||
      (previousState !== "dispatched" &&
        previousState !== "running" &&
        previousState !== "cancel-requested")
    ) {
      throw corruptRunJournal("Uncertain state has no durable active origin");
    }
    uncertainOrigin = {
      assignmentId: mappedAssignmentId,
      origin: previousState,
    };
  }

  const nextActiveRunId = computeNextActiveRunId({
    activeRunId: preActiveRunId,
    runId: body.runId,
    currentState: previousState,
    nextState: body.state,
  });

  const effect: StateJointTransitionEffect = Object.freeze({
    runId: body.runId,
    body,
    queuedPosition,
    previousState,
    nextActiveRunId,
    ...(uncertainOrigin ? { uncertainOrigin } : {}),
    envelopeAt: envelope.at,
    resolutionsInEnvelope: conversationResolutionFactsInEnvelope(
      envelope,
      context.conversationId,
      body.runId,
    ),
  });

  // Phase 2: Ordered family apply (run-queue-input -> assignment-control)
  applyQueueMembershipDelta(
    state,
    effect.queuedPosition,
    effect.runId,
    effect.previousState,
    effect.body.state,
  );
  applyRunStateTransition({
    state,
    body: effect.body,
    previousState: effect.previousState,
    nextActiveRunId: effect.nextActiveRunId,
    ...(effect.uncertainOrigin ? { uncertainOrigin: effect.uncertainOrigin } : {}),
    envelopeAt: effect.envelopeAt,
    resolutionsInEnvelope: effect.resolutionsInEnvelope,
  });
  return state;
}

/**
 * Two-phase joint transition for `state` records on `SubmissionGuardProjection`.
 */
export async function applyConversationGuardStateJointTransition(input: {
  readonly conversationId: string;
  readonly isLocalSource: boolean;
  readonly state: SubmissionGuardProjection;
  readonly body: Extract<ConversationRunJournalRecord, { t: "state" }>;
  readonly envelope: ConversationFactGroup;
  readonly assertUsage: (
    assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
    usageFinal: CancelProofBody["usageFinal"],
  ) => void;
  readonly assertTerminal: (
    assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
    mode: "release" | "reclaim" | "settle-release",
    records: readonly LogicalRecord<unknown>[],
  ) => void;
  readonly verify: (check: () => void) => Promise<void>;
}): Promise<SubmissionGuardProjection> {
  const { conversationId, state, body, envelope, verify } = input;

  // Phase 1: Capture candidate pre-state & validate
  const runId = body.runId;
  const admitted = state.admittedByRun.get(runId);
  if (!admitted) {
    throw corruptRunJournal("Submission guard state has no admitted run");
  }
  const previous = state.stateByRun.get(runId);
  const previousState = previous?.state;
  const previousRevision = previous?.statusRevision;
  const next = body.state;
  const assignmentId = body.assignmentId;
  const assigned = assignmentId ? state.assignedById.get(assignmentId) : undefined;
  const mappedAssignmentId = state.assignmentByRun.get(runId);
  const preActiveRunId = state.activeRunId;
  const closedEarlierInEnvelope =
    assignmentId !== undefined &&
    mappedAssignmentId === undefined &&
    state.closedAssignments.has(assignmentId) &&
    envelopeClosesAssignment(envelope, conversationId, runId, assignmentId);

  assertStateReplayContract({
    currentState: previousState,
    currentRevision: previousRevision,
    nextState: next,
    nextRevision: body.statusRevision,
    assignmentId,
    assignmentBindingValid:
      assigned?.record.runId === runId &&
      (mappedAssignmentId === assignmentId || closedEarlierInEnvelope),
    unassignedBindingValid: mappedAssignmentId === undefined,
    hasAtomicAssignment:
      previousState !== "queued" ||
      next !== "dispatched" ||
      envelopeHasRunRecord(
        envelope,
        conversationId,
        (candidate) =>
          candidate.t === "assigned" &&
          candidate.runId === runId &&
          candidate.assignmentId === assignmentId,
      ),
  });
  if (
    input.isLocalSource &&
    previousState === "queued" &&
    (next === "cancelled" || next === "failed" || next === "expired")
  ) {
    try {
      assertQueuedTerminalDequeue(
        envelope.entries,
        {
          kind: "run",
          id: runId,
          attempt: nextConversationAssignmentAttempt(state, runId),
        },
        next,
      );
    } catch (error) {
      throw corruptRunJournal(
        error instanceof Error
          ? error.message
          : "Queued run resource dequeue is invalid",
      );
    }
  }
  assertStateAtomicReplayContract({
    currentState: previousState,
    nextState: next,
    hasAtomicCancelFence: envelopeHasRunRecord(
      envelope,
      conversationId,
      (candidate) =>
        candidate.t === "cancel-fence" &&
        candidate.assignmentId === assignmentId &&
        state.assignedById.get(candidate.assignmentId)?.record.runId === runId,
    ),
    hasAtomicOpenResolution: envelopeHasRunRecord(
      envelope,
      conversationId,
      (candidate) =>
        candidate.t === "resolution" &&
        candidate.runId === runId &&
        candidate.fact.subject.assignmentId === assignmentId &&
        candidate.fact.resolution === undefined,
    ),
    hasAtomicSupersede: envelopeHasRunRecord(
      envelope,
      conversationId,
      (candidate) =>
        candidate.t === "assignment-superseded" &&
        candidate.assignmentId === assignmentId &&
        state.assignedById.get(candidate.assignmentId)?.record.runId === runId,
    ),
    hasAtomicTermination: envelopeHasRunRecord(
      envelope,
      conversationId,
      (candidate) =>
        (candidate.t === "cancel-proof-accepted" ||
          candidate.t === "assignment-superseded") &&
        candidate.assignmentId === assignmentId &&
        state.assignedById.get(candidate.assignmentId)?.record.runId === runId,
    ),
    hasAtomicResolutionClose: envelopeHasRunRecord(
      envelope,
      conversationId,
      (candidate) =>
        candidate.t === "resolution" &&
        candidate.runId === runId &&
        candidate.fact.subject.assignmentId === assignmentId &&
        candidate.fact.resolution !== undefined,
    ),
    hasAtomicCommit: envelopeHasRunRecord(
      envelope,
      conversationId,
      (candidate) =>
        candidate.t === "committed" &&
        candidate.runId === runId &&
        candidate.assignmentId === assignmentId,
    ),
  });
  if (
    next === "failed" &&
    assignmentId !== undefined &&
    (!assigned ||
      !envelopeRevokesCapabilities(
        envelope,
        conversationId,
        state.revokedCapabilities,
        assignmentId,
        assigned.capIds,
        state.ticketIdsByAssignment.get(assignmentId) ?? [],
        state.revokedTickets,
      ))
  ) {
    throw corruptRunJournal(
      "Submission guard failure is not atomic with capability revocation",
    );
  }
  if (next === "failed" && assignmentId !== undefined) {
    if (!assigned) {
      throw corruptRunJournal("Submission guard failure has no assignment");
    }
    const assignedRecord = assigned.record;
    const usageFinal = body.usageFinal;
    const envelopeEntries = envelope.entries;
    if (usageFinal) {
      await verify(() => {
        input.assertUsage(assignedRecord, usageFinal);
      });
    }
    const terminalMode = usageFinal ? "settle-release" : "reclaim";
    await verify(() => {
      input.assertTerminal(assignedRecord, terminalMode, envelopeEntries);
    });
  }

  const effect: GuardStateJointTransitionEffect = Object.freeze({
    runId,
    body,
    queuedPosition: admitted.queuedPosition,
    previousState,
    nextActiveRunId: computeNextActiveRunId({
      activeRunId: preActiveRunId,
      runId,
      currentState: previousState,
      nextState: next,
    }),
  });

  // Phase 2: Ordered family apply (run-queue-input -> assignment-control)
  applyQueueMembershipDelta(
    state,
    effect.queuedPosition,
    effect.runId,
    effect.previousState,
    effect.body.state,
  );
  applyGuardStateTransition({
    state,
    body: effect.body,
    nextActiveRunId: effect.nextActiveRunId,
  });
  return state;
}

/**
 * Two-phase joint transition for `committed` records on `RunProjection`:
 * Phase 1 validates assignment, revision, bundle closure, input closure, sidecars,
 * delivery obligations, and resource settlement against candidate pre-state;
 * Phase 2 applies `commit-publish` -> `assignment-control` -> `session-domain` effects.
 */
export async function applyConversationCommittedJointTransition(input: {
  readonly context: ConversationRunReductionContext;
  readonly state: RunProjection;
  readonly body: Extract<ConversationRunJournalRecord, { t: "committed" }>;
  readonly envelope: CommitEnvelope<ConversationCommitLogRecord>;
  readonly verify: (check: () => void) => Promise<void>;
}): Promise<RunProjection> {
  const { context, state, body, envelope, verify } = input;

  // Phase 1: Capture candidate pre-state & validate before mutating any family
  const assigned = state.assignedById.get(body.assignmentId);
  const current = assigned
    ? state.stateByRun.get(assigned.record.runId)
    : undefined;
  const openResolution = state.resolutionsByRun.get(body.runId);
  assertCommittedReplayContract({
    assignmentExists: assigned !== undefined,
    assignmentBindsRun: assigned?.record.runId === body.runId,
    assignmentIsCurrent:
      state.assignmentByRun.get(body.runId) === body.assignmentId,
    currentState: current?.state,
    alreadyCommitted: state.committedByAssignment.has(body.assignmentId),
    conflictOpen:
      openResolution?.cause === "dispatch-conflict" &&
      !openResolution.resolution,
    commitRevisionMatchesAssignedBase:
      assigned !== undefined &&
      body.commitRevision === assigned.record.baseRevision + 1,
    hasAtomicCommittedState:
      current !== undefined &&
      envelopeHasRunState(
        envelope,
        context.conversationId,
        body.runId,
        "committed",
        current.statusRevision + 1,
        body.assignmentId,
      ),
    allCapabilitiesRevoked:
      assigned !== undefined &&
      envelopeRevokesRemainingCapabilities(
        envelope,
        context.conversationId,
        state.revokedCapabilities,
        state,
        assigned,
      ),
  });
  if (!assigned || !current) {
    throw corruptRunJournal(
      "Committed run does not match a complete unique assignment closure",
    );
  }
  const previous = state.commits.at(-1);
  if (previous && body.commitRevision !== previous.commitRevision + 1) {
    throw corruptRunJournal("Committed run revision is not contiguous");
  }
  const bytes = await context.artifacts.get(body.bundle.ref);
  const bundle = validateConversationSealedBundle(
    JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
  );
  assertHistoricalBundleFence({
    assignedExecutorId: assigned.record.executorId,
    assignedOwnerEpoch: assigned.record.ownerEpoch,
    assignedBaseRevision: assigned.record.baseRevision,
    bundleExecutorId: bundle.executorId,
    bundleOwnerEpoch: bundle.body.ownerEpoch,
    bundleBaseRevision: bundle.body.baseRevision,
    conflictOpen:
      openResolution?.cause === "dispatch-conflict" &&
      openResolution.resolution === undefined,
  });
  if (
    canonicalize(sealedBundleArtifact(bundle).ref) !==
      canonicalize(body.bundle.ref) ||
    bundle.assignmentId !== body.assignmentId ||
    bundle.body.runId !== body.runId ||
    bundle.body.conversationId !== context.conversationId ||
    bundle.body.baseRevision + 1 !== body.commitRevision
  ) {
    throw corruptRunJournal(
      "Committed bundle does not bind its run journal fact",
    );
  }
  const assignedRecord = assigned.record;
  const bundleUsageFinal = bundle.usageFinal;
  const envelopeEntries = envelope.entries;
  await verify(() => {
    context.assertResourceUsageFinal(assignedRecord, bundleUsageFinal);
  });
  await verify(() => {
    context.assertResourceTerminalRecords(
      assignedRecord,
      "settle-release",
      envelopeEntries,
    );
  });
  const admitted = state.admittedByRun.get(body.runId);
  if (!admitted) throw corruptRunJournal("Committed run has no durable ingress");
  let closure:
    | ValidatedConversationBundleClosure
    | ValidatedConversationReplayClosure;
  try {
    if (state.openInputAssignments.get(body.runId) === body.assignmentId) {
      throw Error("Run input must close before commit");
    }
    closure =
      admitted.record.ingress.kind !== "channel" &&
      !admitted.record.ingress.turnOrigin?.worksceneContinuation
        ? await validateConversationBundleClosure(
            bundle,
            context.artifacts,
            expectedRunInputMessages(state, body.runId, body.assignmentId),
          )
        : await validateConversationBundleClosure(bundle, context.artifacts);
    validateWorksceneContinuationCommit(
      "metadata" in closure ? closure.metadata : closure.runRecord,
      requireAssignedEnvelope(assigned).work,
    );
    if (!("metadata" in closure)) {
      assertRunInputCommit(
        state,
        body.runId,
        body.assignmentId,
        closure.runRecord.messages,
      );
    }
  } catch (error) {
    if (isOperationalArtifactFailure(error)) throw error;
    throw corruptRunJournal(
      error instanceof Error
        ? `Committed bundle closure is invalid: ${error.message}`
        : "Committed bundle closure is invalid",
    );
  }
  if (
    !envelopeHasConversationCommitSidecars(
      envelope,
      context.conversationId,
      body,
      bundle,
      closure.batch,
    )
  ) {
    throw corruptRunJournal(
      "Committed run is missing its content, publish, or final sidecars",
    );
  }
  const committedMetadata =
    "metadata" in closure ? closure.metadata : closure.runRecord;
  const replayRunLifecycleSource = admittedConversationRunLifecycleSource({
    conversationId: context.conversationId,
    runId: body.runId,
    queuedPosition: admitted.record.queuedPosition,
  });
  try {
    context.delivery?.assertConversationCommit(
      {
        at: envelope.at,
        conversationId: context.conversationId,
        runId: body.runId,
        assignmentId: body.assignmentId,
        commitRevision: body.commitRevision,
        conversationLifecycleSource: replayRunLifecycleSource,
        assignmentLifecycleSource: {
          owner: "assignment",
          id: `${assigned.record.executorId === context.currentAuthority?.executorId ? "local" : "relay"}:${body.assignmentId}`,
          revision: assigned.record.dispatchDigest,
        },
        stagedDeliveryLifecycleSource: replayRunLifecycleSource,
        ingress: admitted.record.ingress,
        runRecord: committedMetadata,
        ...(closure.batch ? { mutationBatch: closure.batch } : {}),
      },
      envelope,
    );
  } catch (error) {
    throw corruptRunJournal(
      error instanceof Error
        ? `Committed delivery companions are invalid: ${error.message}`
        : "Committed delivery companions are invalid",
    );
  }
  const expectedSummary = conversationCommitSummary(committedMetadata);
  const { controlRecovery: _recovery, ...legacySummary } = expectedSummary;
  if (
    body.readSummary &&
    canonicalize(body.readSummary) !==
      canonicalize(
        body.readSummary.controlRecovery === undefined
          ? legacySummary
          : expectedSummary,
      )
  ) {
    throw corruptRunJournal(
      "Committed read summary does not match its authoritative record",
    );
  }

  const runRecord = "metadata" in closure ? undefined : closure.runRecord;
  const isWorksceneContinuation = Boolean(
    runRecord &&
      state.admittedByRun.get(runRecord.runId)?.record.ingress.turnOrigin
        ?.worksceneContinuation,
  );
  const effect: CommittedJointTransitionEffect = Object.freeze({
    body,
    ...(runRecord ? { runRecord } : {}),
    isWorksceneContinuation,
    batchRecords: closure.batch?.records ?? [],
    envelopeAt: envelope.at,
  });

  // Phase 2: Ordered family apply (commit-publish -> assignment-control -> session-domain)
  applyCommittedBundle(state, effect.body);
  clearRecoveryAssignment(state, effect.body.assignmentId);
  applyCommittedSessionEffects({
    state,
    ...(effect.runRecord ? { runRecord: effect.runRecord } : {}),
    isWorksceneContinuation: effect.isWorksceneContinuation,
    batchRecords: effect.batchRecords,
    envelopeAt: effect.envelopeAt,
  });
  return state;
}

/**
 * Two-phase joint transition for `committed` records on `SubmissionGuardProjection`.
 */
export async function applyConversationGuardCommittedJointTransition(input: {
  readonly conversationId: string;
  readonly state: SubmissionGuardProjection;
  readonly body: Extract<ConversationRunJournalRecord, { t: "committed" }>;
  readonly envelope: ConversationFactGroup;
  readonly assertTerminal: (
    assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
    mode: "release" | "reclaim" | "settle-release",
    records: readonly LogicalRecord<unknown>[],
  ) => void;
  readonly verify: (check: () => void) => Promise<void>;
}): Promise<SubmissionGuardProjection> {
  const { conversationId, state, body, envelope, verify } = input;

  // Phase 1: Capture candidate pre-state & validate
  const runId = body.runId;
  const assignmentId = body.assignmentId;
  const assigned = state.assignedById.get(assignmentId);
  const current = state.stateByRun.get(runId);
  assertCommittedReplayContract({
    assignmentExists: assigned !== undefined,
    assignmentBindsRun: assigned?.record.runId === runId,
    assignmentIsCurrent: state.assignmentByRun.get(runId) === assignmentId,
    currentState: current?.state,
    alreadyCommitted: state.committedByAssignment.has(assignmentId),
    conflictOpen: state.openConflictAssignments.has(assignmentId),
    commitRevisionMatchesAssignedBase:
      assigned !== undefined &&
      body.commitRevision === assigned.record.baseRevision + 1,
    hasAtomicCommittedState:
      current !== undefined &&
      envelopeHasRunState(
        envelope,
        conversationId,
        runId,
        "committed",
        current.statusRevision + 1,
        assignmentId,
      ),
    allCapabilitiesRevoked:
      assigned !== undefined &&
      envelopeRevokesCapabilities(
        envelope,
        conversationId,
        state.revokedCapabilities,
        assignmentId,
        assigned.capIds,
        state.ticketIdsByAssignment.get(assignmentId) ?? [],
        state.revokedTickets,
      ),
  });
  if (!assigned) {
    throw corruptRunJournal("Submission guard commit has no assignment");
  }
  const assignedRecord = assigned.record;
  const envelopeEntries = envelope.entries;
  await verify(() => {
    input.assertTerminal(assignedRecord, "settle-release", envelopeEntries);
  });
  const sidecars = submissionCommitSidecars(envelope, conversationId, {
    t: "committed",
    runId,
    assignmentId,
    bundle: body.bundle,
    commitRevision: body.commitRevision,
  });

  const effect: GuardCommittedJointTransitionEffect = Object.freeze({
    assignmentId,
    bundle: body.bundle,
    commitRevision: body.commitRevision,
    sidecars,
  });

  // Phase 2: Ordered family apply
  applyGuardCommittedBundle(state, effect.assignmentId, {
    bundle: effect.bundle,
    commitRevision: effect.commitRevision,
    sidecars: effect.sidecars,
  });
  return state;
}
