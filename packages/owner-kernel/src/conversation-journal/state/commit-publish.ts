import { Buffer } from "node:buffer";
import type { ArtifactStore } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityError,
  ContentAssetRef,
  ConversationRunState,
  FinalFrame,
  FinalOutboxRecord,
  GlobalStagedMutation,
  IsoTime,
  LedgerSnapshot,
  LogicalRecord,
  MutationBatch,
  PublishConflictNotice,
  PublishRecord,
  SealedBundle,
} from "@zhixing-ai/core/contracts";
import {
  canonicalize,
  interactionMirrorBatchDigest,
  interactionMirrorSeed,
  validateConversationInteractionMirrorEntry,
  validateConversationSealedBundle,
  validatePublishDecisionForBatch,
} from "@zhixing-ai/core/protocol";
import {
  domainPublishDecisionRequired,
  publishDomainSequence,
  publishProgressFollows,
} from "../../conversation-publish-obligations.js";
import {
  assertExactRecordKeys,
  assertIdentifier,
  assertNonNegativeSafeInteger,
  assertPlainRecord,
  bundleAcknowledgementBindsCommitted,
  corruptRunJournal,
  validateFinalOutboxRecord,
  type ConversationRunInternalRecord,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import type {
  ConversationFactGroup,
  ConversationGlobalMutationDecision,
  ConversationProjectionRecord,
  FinalOutboxProjection,
  FinalOutboxProjectionEntry,
  PublishProjection,
  SubmissionCommitSidecars,
} from "../contracts.js";
import { canonicalTime, snapshot } from "./common.js";

type GlobalPublishBatch = ConversationGlobalMutationDecision;
type GlobalPublishOutcome = GlobalPublishBatch[number]["outcome"];

export interface MirrorAssignmentState {
  ordinal: number;
  mirrorDigest: string;
  mirroredUpTo: number;
  readonly requestIds: Set<string>;
}

export interface CommitPublishMutableSlice {
  readonly mirrorStateByAssignment: Map<string, MirrorAssignmentState>;
  readonly mirrorBatches: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "interaction-mirror" }>
  >;
  readonly committedByAssignment: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
  readonly bundleAcknowledgements: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>
  >;
  readonly bundleAcknowledgementOutbox: Set<string>;
  readonly commits: Array<
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
  readonly assignmentByCommitRevision: Map<number, string>;
  readonly contentByRevision: Map<number, readonly ContentAssetRef[]>;
  readonly projectedByAssignment: Map<string, ConversationProjectionRecord>;
  readonly pendingCommitProjections: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
}

export interface GuardCommitPublishMutableSlice {
  readonly committedByAssignment: Map<
    string,
    {
      readonly bundle: { readonly ref: ArtifactRef };
      readonly commitRevision: number;
      readonly sidecars: SubmissionCommitSidecars;
    }
  >;
  readonly bundleAcknowledgements: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>
  >;
}

export function initializeAssignmentMirrorState(
  state: Pick<CommitPublishMutableSlice, "mirrorStateByAssignment">,
  assignmentId: string,
): void {
  state.mirrorStateByAssignment.set(assignmentId, {
    ordinal: 0,
    mirrorDigest: interactionMirrorSeed(assignmentId),
    mirroredUpTo: 0,
    requestIds: new Set(),
  });
}

export function conversationBundleAcknowledgementRecord(
  assignmentId: string,
  committed: {
    readonly bundle: { readonly ref: Readonly<ArtifactRef> };
    readonly commitRevision: number;
  },
): Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }> {
  return {
    t: "bundle-ack-observed",
    assignmentId,
    bundleRef: committed.bundle.ref,
    commitRevision: committed.commitRevision,
  };
}

export function assertLedgerAcknowledgesCommittedConversationBundle(
  ledger: Pick<LedgerSnapshot, "sealedBundleRef" | "acknowledgedCommitRevision">,
  expected: Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>,
): void {
  if (
    !bundleAcknowledgementBindsCommitted({
      observedBundleRef: ledger.sealedBundleRef,
      observedCommitRevision: ledger.acknowledgedCommitRevision,
      expectedBundleRef: expected.bundleRef,
      expectedCommitRevision: expected.commitRevision,
    })
  ) {
    throw new Error(
      "Bundle acknowledgement does not bind the committed conversation revision",
    );
  }
}

export function assertGlobalMutationRecords(
  records: readonly LogicalRecord<unknown>[],
  conversationStream: string,
): void {
  const reserved = new Set([
    conversationStream,
    "delivery",
    "publish",
    "final-outbox",
  ]);
  if (records.some((record) => reserved.has(record.stream))) {
    throw new Error(
      "Conversation global mutation publisher wrote an owner-reserved stream",
    );
  }
}

export function indexGlobalPublishBatchOutcomes(
  records: readonly {
    readonly seq: number;
    readonly mutation: GlobalStagedMutation;
  }[],
  value: GlobalPublishBatch,
): Map<number, GlobalPublishOutcome> {
  if (!Array.isArray(value) || value.length !== records.length) {
    throw new TypeError(
      "Global publish batch must decide every mutation exactly once",
    );
  }
  const outcomes = new Map<number, GlobalPublishOutcome>();
  for (let index = 0; index < value.length; index += 1) {
    const item = snapshot(value[index], "Global publish batch outcome");
    assertExactRecordKeys(
      item,
      ["outcome", "seq"],
      "Global publish batch outcome",
    );
    if (item.seq !== records[index]?.seq || outcomes.has(item.seq as number)) {
      throw new TypeError(
        "Global publish batch sequence is incomplete, reordered, or duplicated",
      );
    }
    outcomes.set(item.seq as number, item.outcome as GlobalPublishOutcome);
  }
  return outcomes;
}

export function rejected(
  code: AuthorityError["code"],
  message: string,
  retryable: boolean,
): {
  readonly committed: false;
  readonly error: AuthorityError;
} {
  return { committed: false, error: { code, message, retryable } };
}

export function publishDecisionRequired(
  records: MutationBatch["records"],
  _outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"],
): boolean {
  return records.length > 0;
}

export { domainPublishDecisionRequired };

export function emptyPublishProjection(): PublishProjection {
  return {
    decisions: new Map(),
    batches: new Map(),
    commitRevisions: new Map(),
    progress: new Map(),
    domainPlans: new Map(),
    conversationByAssignment: new Map(),
    pendingAssignmentsByConversation: new Map(),
    completedAssignments: new Set(),
    conflictsByAssignment: new Map(),
  };
}

export function emptyFinalProjection(): FinalOutboxProjection {
  return {
    entries: new Map(),
    activeKeyByConversationRevision: new Map(),
    pendingByConversation: new Map(),
    publishedByConversation: new Map(),
    lastPendingRevisionByConversation: new Map(),
  };
}

export interface CommittedBundleSidecarLoader {
  (
    envelope: ConversationFactGroup<unknown>,
    artifacts: ArtifactStore,
    matches: (
      committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
    ) => boolean,
  ): Promise<{
    readonly committed: Extract<ConversationRunJournalRecord, { t: "committed" }>;
    readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
    readonly closure: { readonly batch?: MutationBatch };
  }>;
}

export async function reducePublishRecord(
  state: PublishProjection,
  record: LogicalRecord<PublishRecord>,
  envelope: ConversationFactGroup<unknown>,
  artifacts: ArtifactStore,
  loadBinding: CommittedBundleSidecarLoader,
): Promise<PublishProjection> {
  if (record.body.t === "publish-decision") {
    const binding = await loadBinding(
      envelope,
      artifacts,
      (body) => body.assignmentId === record.body.assignmentId,
    );
    const summary = binding.bundle.body.mutationBatch;
    if (
      !summary ||
      canonicalize(summary.ref) !== canonicalize(record.body.batch.ref) ||
      summary.sessionCount !== record.body.sessionCount ||
      summary.globalCount !== record.body.globalCount ||
      !binding.closure.batch
    ) {
      throw corruptRunJournal(
        "Publish decision does not bind its committed mutation batch",
      );
    }
    state.conversationByAssignment.set(
      record.body.assignmentId,
      binding.bundle.body.conversationId,
    );
    state.batches.set(record.body.assignmentId, binding.closure.batch);
    state.commitRevisions.set(
      record.body.assignmentId,
      binding.committed.commitRevision,
    );
  }
  reducePublishBody(state, record.body, envelope);
  return state;
}

export function reducePublishBody(
  state: PublishProjection,
  raw: PublishRecord,
  envelope: ConversationFactGroup<unknown>,
): void {
  const body = snapshot(raw, "Publish record");
  assertPlainRecord(body, "Publish record");
  if (body.t === "publish-decision") {
    try {
      const batch = state.batches.get(body.assignmentId);
      if (!batch || batch.assignmentId !== body.assignmentId) {
        throw corruptRunJournal(
          "Publish decision has no validated mutation batch",
        );
      }
      validatePublishDecisionForBatch(body, batch);
    } catch {
      throw corruptRunJournal("Publish decision does not match its mutation batch");
    }
    if (
      state.decisions.has(body.assignmentId) ||
      state.completedAssignments.has(body.assignmentId)
    ) {
      throw corruptRunJournal("Publish decision is duplicated");
    }
    const batch = state.batches.get(body.assignmentId)!;
    if (!publishDecisionRequired(batch.records, body.outcomes)) {
      throw corruptRunJournal(
        "Publish decision has no externally published mutation",
      );
    }
    for (const [index, item] of body.outcomes.entries()) {
      const mutation = batch.records[index]!;
      if (
        mutation.domain === "session" &&
        item.outcome.t === "granted" &&
        item.outcome.targetRevision !==
          state.commitRevisions.get(body.assignmentId)
      ) {
        throw corruptRunJournal(
          "Session mutation decision does not match its conversation commit",
        );
      }
    }
    if (
      !envelope.entries.some(
        (entry) =>
          entry.stream.startsWith("run:") &&
          typeof entry.body === "object" &&
          entry.body !== null &&
          "t" in entry.body &&
          entry.body.t === "committed" &&
          "assignmentId" in entry.body &&
          entry.body.assignmentId === body.assignmentId,
      )
    ) {
      throw corruptRunJournal(
        "Publish decision is not atomic with its committed run fact",
      );
    }
    state.decisions.set(body.assignmentId, body);
    const conflicts: PublishConflictNotice["conflicts"] = [];
    for (const item of body.outcomes) {
      if (item.outcome.t !== "conflicted") continue;
      const mutation = batch.records[item.seq - 1];
      if (!mutation || mutation.domain !== "global") {
        throw corruptRunJournal(
          "Publish conflict has no global staged mutation",
        );
      }
      conflicts.push({
        seq: item.seq,
        mutation: snapshot(
          mutation.mutation,
          "Publish conflict mutation",
        ) as GlobalStagedMutation,
        error: snapshot(item.outcome.error, "Publish conflict error"),
      });
    }
    if (conflicts.length > 0) {
      state.conflictsByAssignment.set(body.assignmentId, conflicts);
    }
    for (const domain of ["session", "global"] as const) {
      const plan = publishDomainSequence(batch.records, body.outcomes, domain);
      if (plan) {
        state.domainPlans.set(body.assignmentId + "\0" + domain, {
          ...plan,
          grantedIndexBySeq: new Map(
            plan.grantedSeqs.map((seq, index) => [seq, index]),
          ),
        });
      }
    }
    const conversationId = state.conversationByAssignment.get(body.assignmentId);
    if (!conversationId) {
      throw corruptRunJournal("Publish decision has no conversation binding");
    }
    if (
      [...state.domainPlans.keys()].some((key) =>
        key.startsWith(`${body.assignmentId}\0`),
      )
    ) {
      pendingPublishAssignments(state, conversationId).add(body.assignmentId);
    } else {
      compactSettledPublish(state, body.assignmentId);
    }
    return;
  }
  assertExactRecordKeys(
    body,
    ["assignmentId", "domain", "state", "t", "upToSeq"],
    "Publish progress",
  );
  assertIdentifier(body.assignmentId, "Publish progress assignment id");
  assertNonNegativeSafeInteger(body.upToSeq, "Publish progress sequence");
  if (
    (body.domain !== "session" && body.domain !== "global") ||
    (body.state !== "pending" && body.state !== "settled")
  ) {
    throw corruptRunJournal("Publish progress value is invalid");
  }
  const decision = state.decisions.get(body.assignmentId);
  if (!decision) {
    throw corruptRunJournal("Publish progress has no decision");
  }
  if (
    (body.domain === "session" && decision.sessionCount === 0) ||
    (body.domain === "global" && decision.globalCount === 0)
  ) {
    throw corruptRunJournal("Publish progress names an empty domain");
  }
  const key = `${body.assignmentId}\0${body.domain}`;
  const plan = state.domainPlans.get(key);
  if (!plan) throw corruptRunJournal("Publish progress has no domain plan");
  const current = state.progress.get(key);
  const nextGrantedIndex = current
    ? (plan.grantedIndexBySeq.get(current.upToSeq) ?? -1) + 1
    : 0;
  const nextGrantedSeq = plan.grantedSeqs[nextGrantedIndex];
  const validProgress = publishProgressFollows({
    current,
    next: body,
    nextGrantedSeq,
    terminalSeq: plan.terminalSeq,
    noGranted: plan.grantedSeqs.length === 0,
  });
  if (!validProgress) {
    throw corruptRunJournal("Publish progress skips or misstates a decided mutation");
  }
  if (
    !Number.isSafeInteger(body.upToSeq) ||
    body.upToSeq < 0 ||
    (current &&
      (body.upToSeq < current.upToSeq ||
        current.state === "settled" ||
        (body.upToSeq === current.upToSeq && body.state === current.state)))
  ) {
    throw corruptRunJournal("Publish progress does not advance monotonically");
  }
  state.progress.set(key, body);
  const conversationId = state.conversationByAssignment.get(body.assignmentId);
  if (!conversationId) {
    throw corruptRunJournal("Publish progress has no conversation binding");
  }
  if (publishAssignmentPending(state, body.assignmentId)) {
    pendingPublishAssignments(state, conversationId).add(body.assignmentId);
  } else {
    removePendingPublishAssignment(state, conversationId, body.assignmentId);
    compactSettledPublish(state, body.assignmentId);
  }
}

export function compactSettledPublish(
  state: PublishProjection,
  assignmentId: string,
): void {
  const conversationId = state.conversationByAssignment.get(assignmentId);
  if (conversationId) {
    removePendingPublishAssignment(state, conversationId, assignmentId);
  }
  state.decisions.delete(assignmentId);
  state.batches.delete(assignmentId);
  state.commitRevisions.delete(assignmentId);
  state.conversationByAssignment.delete(assignmentId);
  state.completedAssignments.add(assignmentId);
  for (const domain of ["session", "global"] as const) {
    const key = `${assignmentId}\0${domain}`;
    state.progress.delete(key);
    state.domainPlans.delete(key);
  }
}

function pendingPublishAssignments(
  state: PublishProjection,
  conversationId: string,
): Set<string> {
  const current = state.pendingAssignmentsByConversation.get(conversationId);
  if (current) return current;
  const created = new Set<string>();
  state.pendingAssignmentsByConversation.set(conversationId, created);
  return created;
}

function removePendingPublishAssignment(
  state: PublishProjection,
  conversationId: string,
  assignmentId: string,
): void {
  const pending = state.pendingAssignmentsByConversation.get(conversationId);
  if (!pending) return;
  pending.delete(assignmentId);
  if (pending.size === 0) {
    state.pendingAssignmentsByConversation.delete(conversationId);
  }
}

function publishAssignmentPending(
  state: PublishProjection,
  assignmentId: string,
): boolean {
  if (!state.decisions.has(assignmentId)) return false;
  return (["session", "global"] as const).some((domain) => {
    const key = `${assignmentId}\0${domain}`;
    return (
      state.domainPlans.has(key) && state.progress.get(key)?.state !== "settled"
    );
  });
}

export function finalKey(
  value: Pick<FinalFrame, "conversationId" | "runId" | "commitRevision">,
): string {
  return `${value.conversationId}\0${value.runId}\0${value.commitRevision}`;
}

export function finalRevisionKey(
  value: Pick<FinalFrame, "conversationId" | "commitRevision">,
): string {
  return `${value.conversationId}\0${value.commitRevision}`;
}

function finalEntriesByConversation(
  index: Map<string, Map<string, FinalOutboxProjectionEntry>>,
  conversationId: string,
): Map<string, FinalOutboxProjectionEntry> {
  const current = index.get(conversationId);
  if (current) return current;
  const created = new Map<string, FinalOutboxProjectionEntry>();
  index.set(conversationId, created);
  return created;
}

function removeFinalEntry(
  index: Map<string, Map<string, FinalOutboxProjectionEntry>>,
  conversationId: string,
  key: string,
): void {
  const entries = index.get(conversationId);
  if (!entries) return;
  entries.delete(key);
  if (entries.size === 0) index.delete(conversationId);
}

export function finalFrame(
  record: FinalOutboxRecord,
  publishConflicts = 0,
): FinalFrame {
  return {
    v: 1,
    conversationId: record.conversationId,
    runId: record.runId,
    commitRevision: record.commitRevision,
    digest: record.digest,
    ...(publishConflicts > 0 ? { publishConflicts } : {}),
  };
}

export async function applyFinalRecord(
  projection: FinalOutboxProjection,
  raw: FinalOutboxRecord,
  at: IsoTime,
  envelope: ConversationFactGroup<unknown>,
  artifacts: ArtifactStore,
  loadBinding: CommittedBundleSidecarLoader,
): Promise<void> {
  const body = validateFinalOutboxRecord(snapshot(raw, "Final outbox record"));
  canonicalTime(at, "Final outbox record time");
  const key = finalKey(body);
  const revisionKey = finalRevisionKey(body);
  const current = projection.entries.get(key);
  if (!current) {
    const lastPendingRevision =
      projection.lastPendingRevisionByConversation.get(body.conversationId);
    if (
      body.state !== "pending" ||
      (lastPendingRevision !== undefined &&
        body.commitRevision <= lastPendingRevision) ||
      projection.activeKeyByConversationRevision.has(revisionKey)
    ) {
      throw corruptRunJournal("Final outbox must begin pending");
    }
    const binding = await loadBinding(
      envelope,
      artifacts,
      (committed) =>
        committed.runId === body.runId &&
        committed.commitRevision === body.commitRevision,
    );
    if (
      binding.bundle.body.conversationId !== body.conversationId ||
      binding.bundle.digest !== body.digest
    ) {
      throw corruptRunJournal("Final outbox does not bind its committed bundle");
    }
    const entry = { record: body, at };
    projection.lastPendingRevisionByConversation.set(
      body.conversationId,
      body.commitRevision,
    );
    projection.entries.set(key, entry);
    projection.activeKeyByConversationRevision.set(revisionKey, key);
    finalEntriesByConversation(
      projection.pendingByConversation,
      body.conversationId,
    ).set(key, entry);
    return;
  }
  const validTransition =
    (current.record.state === "pending" &&
      (body.state === "published" || body.state === "expired")) ||
    (current.record.state === "published" && body.state === "expired");
  if (
    current.record.digest !== body.digest ||
    current.record.conversationId !== body.conversationId ||
    current.record.runId !== body.runId ||
    current.record.commitRevision !== body.commitRevision ||
    !validTransition
  ) {
    throw corruptRunJournal("Final outbox transition is invalid");
  }
  const entry = { record: body, at };
  removeFinalEntry(projection.pendingByConversation, body.conversationId, key);
  removeFinalEntry(
    projection.publishedByConversation,
    body.conversationId,
    key,
  );
  if (body.state === "published") {
    projection.entries.set(key, entry);
    finalEntriesByConversation(
      projection.publishedByConversation,
      body.conversationId,
    ).set(key, entry);
  } else {
    projection.entries.delete(key);
    projection.activeKeyByConversationRevision.delete(revisionKey);
  }
}

export function firstCommitIndexAfter(
  commits: readonly Extract<ConversationRunJournalRecord, { t: "committed" }>[],
  revision: number,
): number {
  let low = 0;
  let high = commits.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (commits[middle]!.commitRevision <= revision) low = middle + 1;
    else high = middle;
  }
  return low;
}

export interface InteractionMirrorAssignmentCrossFacts {
  readonly assigned?: {
    readonly runId: string;
    readonly executorId: string;
  };
  readonly assignmentIsCurrent: boolean;
  readonly assignmentClosed: boolean;
  readonly currentRunState?: ConversationRunState;
  readonly hasCancelFence: boolean;
}

export function reduceCommitPublishRunRecord(input: {
  readonly state: CommitPublishMutableSlice;
  readonly body: Extract<
    ConversationRunJournalRecord,
    { t: "interaction-mirror" | "bundle-ack-observed" }
  >;
  readonly mirrorAssignmentFacts?: InteractionMirrorAssignmentCrossFacts;
}): void {
  const { state, body } = input;
  switch (body.t) {
    case "interaction-mirror": {
      const facts = input.mirrorAssignmentFacts;
      const assigned = facts?.assigned;
      const batch = body.batch;
      const batchDigest = interactionMirrorBatchDigest(batch);
      if (
        !assigned ||
        batch.assignmentId !== body.assignmentId ||
        batch.executorId !== assigned.executorId ||
        !facts.assignmentIsCurrent ||
        facts.assignmentClosed ||
        state.mirrorBatches.has(batchDigest)
      ) {
        throw corruptRunJournal("Interaction mirror has no assignment");
      }
      const mirrorState = state.mirrorStateByAssignment.get(body.assignmentId);
      if (!mirrorState || batch.entries.length === 0) {
        throw corruptRunJournal("Interaction mirror has no durable entries");
      }
      const current = facts.currentRunState;
      if (
        current !== "dispatched" &&
        current !== "running" &&
        !(
          (current === "cancel-requested" || current === "uncertain") &&
          facts.hasCancelFence
        )
      ) {
        throw corruptRunJournal(
          "Interaction mirror is outside its authorized state",
        );
      }
      if (
        batch.previousDigest !== mirrorState.mirrorDigest ||
        batch.entries[0]!.ordinal !== mirrorState.ordinal + 1
      ) {
        throw corruptRunJournal(
          "Interaction mirror does not continue its audit prefix",
        );
      }
      let lastSeq = mirrorState.mirroredUpTo;
      let lastOrdinal = mirrorState.ordinal;
      const batchRequestIds = new Set<string>();
      for (const rawEntry of batch.entries) {
        const entry = validateConversationInteractionMirrorEntry(rawEntry);
        if (
          entry.ordinal !== lastOrdinal + 1 ||
          entry.seq <= lastSeq ||
          mirrorState.requestIds.has(entry.requestId) ||
          batchRequestIds.has(entry.requestId)
        ) {
          throw corruptRunJournal(
            "Interaction mirror sequence or request identity is invalid",
          );
        }
        lastSeq = entry.seq;
        lastOrdinal = entry.ordinal;
        batchRequestIds.add(entry.requestId);
      }
      mirrorState.ordinal = lastOrdinal;
      mirrorState.mirrorDigest = batch.mirrorDigest;
      mirrorState.mirroredUpTo = lastSeq;
      for (const requestId of batchRequestIds) {
        mirrorState.requestIds.add(requestId);
      }
      state.mirrorBatches.set(batchDigest, body);
      return;
    }
    case "bundle-ack-observed": {
      const committed = state.committedByAssignment.get(body.assignmentId);
      if (
        !committed ||
        state.bundleAcknowledgements.has(body.assignmentId) ||
        !bundleAcknowledgementBindsCommitted({
          observedBundleRef: body.bundleRef,
          observedCommitRevision: body.commitRevision,
          expectedBundleRef: committed.bundle.ref,
          expectedCommitRevision: committed.commitRevision,
        })
      ) {
        throw corruptRunJournal(
          "Bundle acknowledgement observation does not bind one committed conversation bundle",
        );
      }
      state.bundleAcknowledgements.set(body.assignmentId, body);
      state.bundleAcknowledgementOutbox.delete(body.assignmentId);
      return;
    }
  }
}

export async function reduceCommitPublishInternalRecord(input: {
  readonly state: CommitPublishMutableSlice;
  readonly body: Extract<
    ConversationRunInternalRecord,
    { kind: "conversation-commit-projection" | "content-asset-index" }
  >;
  readonly artifacts: ArtifactStore;
  readonly envelopeContainsLatestCommit: boolean;
}): Promise<void> {
  const { state, body } = input;
  if (body.kind === "conversation-commit-projection") {
    const committed = state.committedByAssignment.get(
      (body as ConversationProjectionRecord).assignmentId,
    );
    if (
      !committed ||
      committed.runId !== body.runId ||
      committed.commitRevision !== body.commitRevision ||
      state.projectedByAssignment.has(body.assignmentId)
    ) {
      throw corruptRunJournal(
        "Projection progress does not name one unprojected commit",
      );
    }
    const bytes = await input.artifacts.get(committed.bundle.ref);
    const bundle = validateConversationSealedBundle(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
    );
    if (bundle.digest !== body.digest) {
      throw corruptRunJournal(
        "Projection progress digest does not match its bundle",
      );
    }
    state.projectedByAssignment.set(body.assignmentId, body);
    state.pendingCommitProjections.delete(body.assignmentId);
    return;
  }

  const committed = state.commits.at(-1);
  if (
    !committed ||
    state.contentByRevision.has(committed.commitRevision) ||
    !input.envelopeContainsLatestCommit
  ) {
    throw corruptRunJournal("Content index has no unique committed run");
  }
  const bundleBytes = await input.artifacts.get(committed.bundle.ref);
  const bundle = validateConversationSealedBundle(
    JSON.parse(Buffer.from(bundleBytes).toString("utf8")) as SealedBundle,
  );
  if (canonicalize(body.entries) !== canonicalize(bundle.body.contentAssets)) {
    throw corruptRunJournal("Content index does not match its committed bundle");
  }
  state.contentByRevision.set(
    committed.commitRevision,
    snapshot(body.entries, "Content asset index"),
  );
}

export function reduceCommitPublishGuardRecord(
  state: GuardCommitPublishMutableSlice,
  body: Extract<ConversationRunJournalRecord, { t: "bundle-ack-observed" }>,
): void {
  const committed = state.committedByAssignment.get(body.assignmentId);
  if (
    !committed ||
    state.bundleAcknowledgements.has(body.assignmentId) ||
    !bundleAcknowledgementBindsCommitted({
      observedBundleRef: body.bundleRef,
      observedCommitRevision: body.commitRevision,
      expectedBundleRef: committed.bundle.ref,
      expectedCommitRevision: committed.commitRevision,
    })
  ) {
    throw corruptRunJournal(
      "Submission guard bundle acknowledgement is invalid or duplicated",
    );
  }
  state.bundleAcknowledgements.set(body.assignmentId, body);
}

export function applyCommittedBundle(
  state: Pick<
    CommitPublishMutableSlice,
    | "committedByAssignment"
    | "bundleAcknowledgementOutbox"
    | "commits"
    | "assignmentByCommitRevision"
    | "pendingCommitProjections"
  >,
  body: Extract<ConversationRunJournalRecord, { t: "committed" }>,
): void {
  state.committedByAssignment.set(body.assignmentId, body);
  state.bundleAcknowledgementOutbox.add(body.assignmentId);
  state.commits.push(body);
  state.assignmentByCommitRevision.set(body.commitRevision, body.assignmentId);
  state.pendingCommitProjections.set(body.assignmentId, body);
}

export function applyGuardCommittedBundle(
  state: Pick<GuardCommitPublishMutableSlice, "committedByAssignment">,
  assignmentId: string,
  entry: {
    readonly bundle: { readonly ref: ArtifactRef };
    readonly commitRevision: number;
    readonly sidecars: SubmissionCommitSidecars;
  },
): void {
  state.committedByAssignment.set(assignmentId, entry);
}
