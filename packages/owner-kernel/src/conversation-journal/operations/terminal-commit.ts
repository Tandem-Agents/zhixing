import type { ProjectionTransactionDecision } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityCallContext,
  LedgerSnapshot,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  SealedBundle,
  TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  validateConversationSealedBundle,
  validatePublishDecisionForBatch,
} from "@zhixing-ai/core/protocol";
import { conversationCommitSummary } from "../../conversation-commit-summary.js";
import { domainPublishDecisionRequired } from "../../conversation-publish-obligations.js";
import {
  corruptRunJournal,
  historicalBundleFenceMatches,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import type { AssignmentBundleSubmissionResult } from "../../shared-protocol/contracts.js";
import type {
  ConversationCommitLogRecord,
  ConversationProjectionRecord,
} from "../contracts.js";
import { submissionCommitSidecarsMatch } from "../replay/bundle-binding.js";
import { closeResolution } from "../state/assignment-control.js";
import { runRecord, snapshot, type DeepReadonly } from "../state/common.js";
import {
  assertLedgerAcknowledgesCommittedConversationBundle,
  conversationBundleAcknowledgementRecord,
  publishDecisionRequired,
  rejected,
} from "../state/commit-publish.js";
import { worksceneTurnActivityEntries } from "../state/session-domain.js";
import type {
  ConversationDecisionFacts,
  ConversationGuardDecisionFacts,
  ReadonlyAssignedFact,
} from "../state/views.js";

export function decideGuardBundleRejection(input: {
  readonly hasCurrentEpoch: boolean;
  readonly assignmentId: string;
  readonly runId: string;
  readonly guard: Pick<ConversationGuardDecisionFacts, "assignment">;
}): string | undefined {
  const { assignment } = input.guard;
  const state = assignment.getRunState(input.runId)?.state;
  return !input.hasCurrentEpoch
    ? "Bundle capability belongs to a stale owner epoch"
    : assignment.getAssignmentIdForRun(input.runId) !== input.assignmentId
      ? "Bundle belongs to a historical assignment"
      : assignment.hasOpenConflict(input.assignmentId)
        ? "Bundle is blocked by an open dispatch conflict"
        : state !== "dispatched" &&
            state !== "running" &&
            state !== "cancel-requested" &&
            state !== "uncertain"
          ? "Bundle is late for the current run state"
          : undefined;
}

export function decideSubmitBundleGuardCommittedFastPath(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly artifactRef: ArtifactRef;
  readonly capability: Extract<
    AuthorityCallContext["principal"],
    { kind: "assignment" }
  >["capability"];
  readonly guard: ConversationGuardDecisionFacts;
}):
  | {
      readonly kind: "mismatch-bundle";
      readonly result: AssignmentBundleSubmissionResult;
    }
  | {
      readonly kind: "replay-committed";
      readonly commitRevision: number;
      readonly assigned: DeepReadonly<
        Extract<ConversationRunJournalRecord, { t: "assigned" }>
      >;
    } {
  const guardAssigned = input.guard.assignment.getAssigned(input.assignmentId)!;
  const guardCommitted = input.guard.commitPublish.getCommitted(
    input.assignmentId,
  )!;
  if (canonicalize(guardCommitted.bundle.ref) !== canonicalize(input.artifactRef)) {
    return {
      kind: "mismatch-bundle",
      result: rejected(
        "fence-rejected",
        "Assignment already committed another bundle",
        false,
      ),
    };
  }
  if (!submissionCommitSidecarsMatch(guardCommitted.sidecars, input.bundle)) {
    throw corruptRunJournal("Committed bundle does not match its durable sidecars");
  }
  const capability = input.capability;
  if (
    capability.scope.execution !== "conversation" ||
    !("ownerEpoch" in capability) ||
    capability.ownerEpoch !== guardAssigned.record.ownerEpoch ||
    input.bundle.body.conversationId !== input.conversationId ||
    input.bundle.body.runId !== guardAssigned.record.runId ||
    !historicalBundleFenceMatches({
      assignedExecutorId: guardAssigned.record.executorId,
      assignedOwnerEpoch: guardAssigned.record.ownerEpoch,
      assignedBaseRevision: guardAssigned.record.baseRevision,
      bundleExecutorId: input.bundle.executorId,
      bundleOwnerEpoch: input.bundle.body.ownerEpoch,
      bundleBaseRevision: input.bundle.body.baseRevision,
      conflictOpen: input.guard.assignment.hasOpenConflict(input.assignmentId),
    }) ||
    input.bundle.body.baseRevision + 1 !== guardCommitted.commitRevision
  ) {
    throw corruptRunJournal(
      "Committed bundle does not match its durable assignment fence",
    );
  }
  return {
    kind: "replay-committed",
    commitRevision: guardCommitted.commitRevision,
    assigned: guardAssigned.record,
  };
}

export function decideSubmitBundleSelectPreflight(input: {
  readonly assignmentId: string;
  readonly artifactRef: ArtifactRef;
  readonly authorizeActive: () => void;
  readonly authorizeReplay: () => void;
  readonly authorizeRejection: () => void;
  readonly authorizeSettlement: () => void;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "assignment" | "commitPublish"
  >;
}):
  | {
      readonly kind: "return";
      readonly value: AssignmentBundleSubmissionResult;
    }
  | {
      readonly kind: "proceed";
      readonly assigned: ReadonlyAssignedFact;
    } {
  const { assignment, commitPublish } = input.facts;
  const assigned = assignment.getAssigned(input.assignmentId);
  if (!assigned) {
    throw new Error("Bundle capability is not activated by a durable assignment");
  }
  const committed = commitPublish.getCommitted(input.assignmentId);
  if (committed) {
    if (canonicalize(committed.bundle.ref) !== canonicalize(input.artifactRef)) {
      input.authorizeActive();
      return {
        kind: "return",
        value: rejected(
          "fence-rejected",
          "Assignment already committed another bundle",
          false,
        ),
      };
    }
    input.authorizeReplay();
    return {
      kind: "return",
      value: { committed: true, commitRevision: committed.commitRevision },
    };
  }
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    input.assignmentId
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
  const currentRunState = assignment.getRunState(assigned.record.runId)?.state;
  const openResolution = assignment.getResolution(assigned.record.runId);
  if (
    currentRunState === "uncertain" &&
    openResolution?.cause === "dispatch-conflict" &&
    !openResolution.resolution
  ) {
    input.authorizeRejection();
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
    currentRunState !== "dispatched" &&
    currentRunState !== "running" &&
    currentRunState !== "cancel-requested" &&
    currentRunState !== "uncertain"
  ) {
    input.authorizeRejection();
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle is late for the current run state",
        false,
      ),
    };
  }
  if (currentRunState === "uncertain") {
    input.authorizeSettlement();
  } else {
    input.authorizeActive();
  }
  return {
    kind: "proceed",
    assigned: snapshot(assigned, "Bundle preflight assignment"),
  };
}

export function decideSubmitBundlePreflightAtState(input: {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly artifactRef: ArtifactRef;
  readonly committedRunRecord: TranscriptRunRecord;
  readonly authorizeActive: () => void;
  readonly authorizeReplay: () => void;
  readonly authorizeRejection: () => void;
  readonly authorizeSettlement: () => void;
  readonly assertResourceUsageFinal: (
    assigned: DeepReadonly<
      Extract<ConversationRunJournalRecord, { t: "assigned" }>
    >,
    usageFinal: SealedBundle["usageFinal"],
  ) => void;
  readonly facts: Pick<
    ConversationDecisionFacts,
    "queueInput" | "assignment" | "commitPublish"
  >;
}):
  | {
      readonly kind: "return";
      readonly value: AssignmentBundleSubmissionResult;
    }
  | {
      readonly kind: "proceed";
      readonly assigned: ReadonlyAssignedFact;
      readonly currentRunState: "dispatched" | "running" | "cancel-requested" | "uncertain";
    } {
  const { queueInput, assignment, commitPublish } = input.facts;
  const { bundle, artifactRef } = input;
  const assigned = assignment.getAssigned(bundle.assignmentId);
  const committed = commitPublish.getCommitted(bundle.assignmentId);
  if (committed) {
    if (canonicalize(committed.bundle.ref) !== canonicalize(artifactRef)) {
      input.authorizeActive();
      return {
        kind: "return",
        value: rejected(
          "fence-rejected",
          "Assignment already committed another bundle",
          false,
        ),
      };
    }
    input.authorizeReplay();
    return {
      kind: "return",
      value: { committed: true, commitRevision: committed.commitRevision },
    };
  }
  if (!assigned) {
    input.authorizeActive();
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle names an unknown assignment",
        false,
      ),
    };
  }
  try {
    queueInput.assertClosedInputMatches(
      assigned.record.runId,
      bundle.assignmentId,
      input.committedRunRecord.messages,
    );
  } catch (error) {
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        error instanceof Error ? error.message : "Invalid input commit",
        false,
      ),
    };
  }
  const body = bundle.body;
  if (
    assignment.getAssignmentIdForRun(assigned.record.runId) !==
    bundle.assignmentId
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
  if (
    body.conversationId !== input.conversationId ||
    body.runId !== assigned.record.runId ||
    body.ownerEpoch !== input.ownerEpoch ||
    !historicalBundleFenceMatches({
      assignedExecutorId: assigned.record.executorId,
      assignedOwnerEpoch: assigned.record.ownerEpoch,
      assignedBaseRevision: assigned.record.baseRevision,
      bundleExecutorId: bundle.executorId,
      bundleOwnerEpoch: body.ownerEpoch,
      bundleBaseRevision: body.baseRevision,
      conflictOpen: false,
    })
  ) {
    input.authorizeActive();
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle fence does not match the durable assignment",
        false,
      ),
    };
  }
  const currentRunState = assignment.getRunState(body.runId)?.state;
  const openResolution = assignment.getResolution(body.runId);
  if (
    currentRunState === "uncertain" &&
    openResolution?.cause === "dispatch-conflict" &&
    !openResolution.resolution
  ) {
    input.authorizeRejection();
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
    currentRunState !== "dispatched" &&
    currentRunState !== "running" &&
    currentRunState !== "cancel-requested" &&
    currentRunState !== "uncertain"
  ) {
    input.authorizeActive();
    return {
      kind: "return",
      value: rejected(
        "fence-rejected",
        "Bundle is late for the current run state",
        false,
      ),
    };
  }
  input.assertResourceUsageFinal(assigned.record, bundle.usageFinal);
  const previousCommit = commitPublish.latestCommit;
  if (previousCommit && body.baseRevision !== previousCommit.commitRevision) {
    input.authorizeActive();
    return {
      kind: "return",
      value: rejected(
        "revision-conflict",
        "Conversation base revision does not follow the durable commit chain",
        false,
      ),
    };
  }
  if (currentRunState === "uncertain") {
    input.authorizeSettlement();
  } else {
    input.authorizeActive();
  }
  return {
    kind: "proceed",
    assigned,
    currentRunState,
  };
}

export function decideSubmitBundleCompanionEntries(input: {
  readonly conversationId: string;
  readonly assigned: ReadonlyAssignedFact;
  readonly currentRunState: "dispatched" | "running" | "cancel-requested" | "uncertain";
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly artifactRef: ArtifactRef;
  readonly commitRevision: number;
  readonly committedRunRecord: TranscriptRunRecord;
  readonly batch: MutationBatch | undefined;
  readonly outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"];
  readonly deliveryRecords: readonly LogicalRecord<unknown>[];
  readonly globalMutationRecords: readonly LogicalRecord<unknown>[];
  readonly clockAt: () => string;
  readonly facts: Pick<ConversationDecisionFacts, "session" | "assignment">;
}): ProjectionTransactionDecision<
  unknown,
  { readonly committed: true; readonly commitRevision: number }
> {
  const { session, assignment } = input.facts;
  const { bundle } = input;
  const body = bundle.body;
  const committedRecord: Extract<
    ConversationRunJournalRecord,
    { t: "committed" }
  > = {
    t: "committed",
    runId: body.runId,
    assignmentId: bundle.assignmentId,
    bundle: { ref: input.artifactRef },
    commitRevision: input.commitRevision,
    readSummary: conversationCommitSummary(input.committedRunRecord),
  };
  const entries: LogicalRecord<unknown>[] = [
    runRecord(input.conversationId, committedRecord),
    runRecord(input.conversationId, {
      kind: "content-asset-index",
      entries: body.contentAssets,
    }),
    ...worksceneTurnActivityEntries(
      input.conversationId,
      session.domainRevision + 1,
      bundle.assignmentId,
      input.committedRunRecord.timestamp,
      session.sessionMeta ? "touch" : "create",
    ),
    ...assignment.capabilityRevocationsFor(
      input.conversationId,
      input.assigned,
    ),
    runRecord(input.conversationId, {
      t: "state",
      runId: body.runId,
      assignmentId: bundle.assignmentId,
      state: "committed",
      statusRevision:
        (assignment.getRunState(body.runId)?.statusRevision ?? 0) + 1,
    }),
    ...input.deliveryRecords,
    ...input.globalMutationRecords,
  ];
  if (input.currentRunState === "uncertain") {
    const openResolution = assignment.getResolution(body.runId);
    if (!openResolution || openResolution.resolution) {
      throw corruptRunJournal("Uncertain run has no open resolution fact");
    }
    entries.push(
      runRecord(input.conversationId, {
        t: "resolution",
        runId: body.runId,
        fact: closeResolution(
          openResolution,
          "late-bundle-committed",
          bundle.executorId,
          input.clockAt(),
        ),
      }),
    );
  }
  if (
    input.batch &&
    body.mutationBatch &&
    publishDecisionRequired(input.batch.records, input.outcomes)
  ) {
    const decision = {
      t: "publish-decision",
      assignmentId: bundle.assignmentId,
      batch: { ref: body.mutationBatch.ref },
      sessionCount: body.mutationBatch.sessionCount,
      globalCount: body.mutationBatch.globalCount,
      outcomes: input.outcomes,
    } satisfies Extract<PublishRecord, { t: "publish-decision" }>;
    validatePublishDecisionForBatch(decision, input.batch);
    entries.push({
      stream: "publish",
      body: decision,
    });
    for (const domain of ["session", "global"] as const) {
      if (domainPublishDecisionRequired(input.batch.records, input.outcomes, domain)) {
        entries.push({
          stream: "publish",
          body: {
            t: "publish-progress",
            assignmentId: bundle.assignmentId,
            domain,
            upToSeq: 0,
            state: "pending",
          },
        });
      }
    }
  }
  entries.push({
    stream: "final-outbox",
    body: {
      t: "final",
      conversationId: input.conversationId,
      runId: body.runId,
      commitRevision: input.commitRevision,
      digest: bundle.digest,
      state: "pending",
    },
  });
  return {
    kind: "append",
    entries,
    value: { committed: true, commitRevision: input.commitRevision },
  };
}

export function decideObserveBundleAcknowledgementPreflight(input: {
  readonly assignmentId: string;
  readonly facts: Pick<ConversationDecisionFacts, "commitPublish">;
}): {
  readonly expected: Extract<
    ConversationRunJournalRecord,
    { t: "bundle-ack-observed" }
  >;
  readonly existing:
    | Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>
    | undefined;
} {
  const { commitPublish } = input.facts;
  const committed = commitPublish.getCommitted(input.assignmentId);
  if (!committed) {
    throw new Error(
      "Bundle acknowledgement names an uncommitted conversation assignment",
    );
  }
  return {
    expected: conversationBundleAcknowledgementRecord(
      input.assignmentId,
      committed,
    ),
    existing: (() => {
      const ack = commitPublish.getBundleAcknowledgement(input.assignmentId);
      return ack
        ? (snapshot(ack, "Bundle acknowledgement") as Extract<
            ConversationRunJournalRecord,
            { t: "bundle-ack-observed" }
          >)
        : undefined;
    })(),
  };
}

export function decideObserveBundleAcknowledgementAtState(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly ledger: LedgerSnapshot;
  readonly preflightExpected: Extract<
    ConversationRunJournalRecord,
    { t: "bundle-ack-observed" }
  >;
  readonly facts: Pick<ConversationDecisionFacts, "commitPublish">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, void> {
  const { commitPublish } = input.facts;
  const committed = commitPublish.getCommitted(input.assignmentId);
  const existing = commitPublish.getBundleAcknowledgement(input.assignmentId);
  if (!committed) {
    throw new Error(
      "Bundle acknowledgement names an uncommitted conversation assignment",
    );
  }
  const expected = conversationBundleAcknowledgementRecord(
    input.assignmentId,
    committed,
  );
  if (canonicalize(expected) !== canonicalize(input.preflightExpected)) {
    throw corruptRunJournal("Committed bundle acknowledgement binding changed");
  }
  assertLedgerAcknowledgesCommittedConversationBundle(input.ledger, expected);
  if (existing) {
    if (canonicalize(existing) !== canonicalize(expected)) {
      throw corruptRunJournal(
        "Bundle acknowledgement observation is inconsistent",
      );
    }
    return { kind: "return", value: undefined };
  }
  return {
    kind: "append",
    entries: [runRecord(input.conversationId, expected)],
    value: undefined,
  };
}

export function decideCommitProjectionProgress(input: {
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly progress: ConversationProjectionRecord;
  readonly facts: Pick<ConversationDecisionFacts, "commitPublish">;
}): ProjectionTransactionDecision<ConversationCommitLogRecord, boolean> {
  const { commitPublish } = input.facts;
  const durable = commitPublish.getCommitted(input.assignmentId);
  if (!durable) {
    throw corruptRunJournal("Projection progress has no committed run");
  }
  if (commitPublish.hasProjectedCommit(input.assignmentId)) {
    return { kind: "return", value: false };
  }
  return {
    kind: "append",
    entries: [runRecord(input.conversationId, input.progress)],
    value: true,
  };
}
