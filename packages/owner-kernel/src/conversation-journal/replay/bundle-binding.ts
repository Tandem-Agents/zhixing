import { Buffer } from "node:buffer";
import type { Message } from "@zhixing-ai/core";
import {
  AuthorityStorageError,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveSealedBundleArtifactClosure,
  type ArtifactStore,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityError,
  ConversationRunState,
  DeliveryIntentDto,
  FinalOutboxRecord,
  IngressContext,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  SealedBundle,
  TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import {
  compileDeliveryContent,
  DeliveryContentValidationError,
  type CompiledDeliveryContent,
} from "@zhixing-ai/core/delivery";
import {
  byteDigest,
  canonicalize,
  sealedBundleArtifact,
  validateConversationSealedBundle,
  validateMutationBatch,
  validateTranscriptRunRecord,
} from "@zhixing-ai/core/protocol";
import {
  DeviceCapacityAdmissionError,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
} from "@zhixing-ai/core/resources";
import { validateWorksceneContinuationCommit } from "@zhixing-ai/core/workscene/application";
import {
  isAuthenticatedConversationFacts,
  type AuthenticatedConversationFacts,
} from "../../conversation-base-source.js";
import { domainPublishDecisionRequired } from "../../conversation-publish-obligations.js";
import { readConversationReplayRecord } from "../../conversation-replay-record.js";
import {
  assertArtifactReference,
  assertCommittedRunRecord,
  assertConversationRunInternalRecord,
  assertDigest,
  assertExactRecordKeys,
  assertHistoricalBundleFence,
  assertNonNegativeSafeInteger,
  assertPlainRecord,
  corruptRunJournal,
  type ConversationRunJournalRecord,
  type Stored,
} from "../../conversation-run-contracts.js";
import type { ConversationStatusDeliveryInput } from "../../delivery-participant.js";
import type {
  ConversationFactGroup,
  ConversationRunReductionContext,
  PreparedStored,
  RunProjection,
  SubmissionCommitSidecars,
} from "../contracts.js";
import { requireAssignedEnvelope } from "../state/assignment-control.js";
import { runStream, snapshot } from "../state/common.js";
import {
  assertRunInputCommit,
  expectedRunInputMessages,
} from "../state/run-queue-input.js";
import { applyCommittedSessionMutations } from "../state/session-domain.js";

export interface ValidatedConversationBundleClosure {
  readonly artifact: ReturnType<typeof sealedBundleArtifact>;
  readonly batch?: MutationBatch;
  readonly runRecord: TranscriptRunRecord;
  readonly references: ArtifactRef[];
}

export interface ValidatedConversationReplayClosure
  extends Omit<ValidatedConversationBundleClosure, "runRecord"> {
  readonly metadata: Omit<TranscriptRunRecord, "messages">;
}

export class BundleClosureError extends Error {
  constructor(
    readonly code: "invalid" | "missing-base",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BundleClosureError";
  }
}

export function isOperationalArtifactFailure(error: unknown): boolean {
  return (
    error instanceof StorageMaintenanceAdmissionError ||
    error instanceof StorageMaintenanceCancelledError ||
    error instanceof DeviceCapacityAdmissionError
  );
}

function bundleClosureReadError(error: unknown, message: string): Error {
  if (isOperationalArtifactFailure(error)) return error as Error;
  return error instanceof AuthorityStorageError &&
    error.code === "artifact-missing"
    ? new BundleClosureError("missing-base", `${message}: artifact is not present`, {
        cause: error,
      })
    : new BundleClosureError(
        "invalid",
        error instanceof Error ? `${message}: ${error.message}` : message,
        { cause: error },
      );
}

export function validateConversationBundleClosure(
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  artifacts: ArtifactStore,
): Promise<ValidatedConversationBundleClosure>;
export function validateConversationBundleClosure(
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  artifacts: ArtifactStore,
  expectedInputs: readonly Message[] | null,
): Promise<ValidatedConversationBundleClosure | ValidatedConversationReplayClosure>;
export async function validateConversationBundleClosure(
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  artifacts: ArtifactStore,
  expectedInputs?: readonly Message[] | null,
): Promise<ValidatedConversationBundleClosure | ValidatedConversationReplayClosure> {
  const artifact = sealedBundleArtifact(bundle);
  if (!(await artifacts.has(artifact.ref))) {
    throw new BundleClosureError(
      "missing-base",
      "Sealed bundle artifact is not present",
    );
  }
  let closure: Awaited<ReturnType<typeof resolveSealedBundleArtifactClosure>>;
  const replay =
    expectedInputs !== undefined && isStoredReference(bundle.body.runRecord)
      ? await readConversationReplayRecord(
          artifacts,
          bundle.body.runRecord.ref,
          bundle.body.runId,
          expectedInputs ?? undefined,
        )
      : undefined;
  try {
    closure = await resolveSealedBundleArtifactClosure(
      bundle,
      artifacts,
      replay
        ? async (descriptor) =>
            descriptor.schema === "transcript-run-record"
              ? replay.references
              : undefined
        : undefined,
    );
  } catch (error) {
    throw bundleClosureReadError(error, "Invalid sealed bundle closure");
  }

  const references = [artifact.ref, ...closure.transfer];

  let runRecord: TranscriptRunRecord | undefined;
  if (replay) {
    /* Canonical schema, input identities and exact dependencies were verified through byte ranges. */
  } else if (isStoredReference(bundle.body.runRecord)) {
    try {
      const bytes = await artifacts.get(bundle.body.runRecord.ref);
      const text = Buffer.from(bytes).toString("utf8");
      runRecord = validateTranscriptRunRecord(
        JSON.parse(text) as TranscriptRunRecord,
        bundle.body.runId,
      );
      if (canonicalize(runRecord) !== text) {
        throw new TypeError("Transcript run record artifact is not canonical");
      }
    } catch (error) {
      throw bundleClosureReadError(error, "Invalid transcript run record");
    }
  } else {
    runRecord = validateTranscriptRunRecord(
      bundle.body.runRecord,
      bundle.body.runId,
    );
  }

  let batch: MutationBatch | undefined;
  if (bundle.body.mutationBatch) {
    try {
      const bytes = await artifacts.get(bundle.body.mutationBatch.ref);
      const text = Buffer.from(bytes).toString("utf8");
      batch = validateMutationBatch(JSON.parse(text) as MutationBatch);
      if (canonicalize(batch) !== text) {
        throw new TypeError("Mutation batch artifact is not canonical");
      }
    } catch (error) {
      throw bundleClosureReadError(error, "Invalid mutation batch");
    }
    const sessionCount = batch.records.filter(
      (record) => record.domain === "session",
    ).length;
    const globalCount = batch.count - sessionCount;
    if (
      batch.assignmentId !== bundle.assignmentId ||
      sessionCount !== bundle.body.mutationBatch.sessionCount ||
      globalCount !== bundle.body.mutationBatch.globalCount
    ) {
      throw new BundleClosureError(
        "invalid",
        "Mutation batch summary does not bind the bundle",
      );
    }
  }

  return replay
    ? {
        artifact,
        ...(batch ? { batch } : {}),
        metadata: replay.metadata,
        references,
      }
    : {
        artifact,
        ...(batch ? { batch } : {}),
        runRecord: runRecord!,
        references,
      };
}

export function envelopeContainsCommit(
  envelope: ConversationFactGroup,
  conversationId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
): boolean {
  return envelope.entries.some(
    (entry) =>
      entry.stream === runStream(conversationId) &&
      "t" in entry.body &&
      entry.body.t === "committed" &&
      entry.body.assignmentId === committed.assignmentId &&
      entry.body.runId === committed.runId &&
      entry.body.commitRevision === committed.commitRevision &&
      canonicalize(entry.body.bundle) === canonicalize(committed.bundle),
  );
}

export interface CompiledConversationDeliveryContents {
  readonly final?: CompiledDeliveryContent;
  readonly stagedContents: ReadonlyMap<number, DeliveryIntentDto["content"]>;
  readonly stagedContentErrors: ReadonlyMap<number, AuthorityError>;
  readonly references: readonly ArtifactRef[];
}

export async function compileConversationDeliveryContents(
  runRecord: TranscriptRunRecord,
  batch: MutationBatch | undefined,
  artifacts: ArtifactStore,
  ingress: IngressContext,
): Promise<CompiledConversationDeliveryContents> {
  const final =
    ingress.kind === "channel"
      ? await compileDeliveryContent(
          transcriptFinalAssistantText(runRecord),
          artifacts,
        )
      : undefined;
  const stagedContents = new Map<number, DeliveryIntentDto["content"]>();
  const stagedContentErrors = new Map<number, AuthorityError>();
  const references: ArtifactRef[] = [...(final?.references ?? [])];
  for (const record of batch?.records ?? []) {
    if (record.mutation.kind !== "delivery-enqueue") continue;
    if (
      record.mutation.request.target.kind === "turn-origin" &&
      ingress.kind !== "channel"
    ) {
      continue;
    }
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
  return {
    final,
    stagedContents,
    stagedContentErrors,
    references,
  };
}

export function transcriptFinalAssistantText(record: TranscriptRunRecord): string {
  for (let index = record.messages.length - 1; index >= 0; index -= 1) {
    const message = record.messages[index]!;
    if (message.role !== "assistant") continue;
    return message.content
      .filter(
        (
          block,
        ): block is Extract<(typeof message.content)[number], { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

export function envelopeHasConversationCommitSidecars(
  envelope: ConversationFactGroup,
  conversationId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  batch?: MutationBatch,
): boolean {
  const hasContentIndex = envelope.entries.some((entry) => {
    if (
      entry.stream !== runStream(conversationId) ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as {
      readonly kind?: unknown;
      readonly entries?: unknown;
    };
    return (
      body.kind === "content-asset-index" &&
      canonicalize(body.entries) === canonicalize(bundle.body.contentAssets)
    );
  });
  const hasFinal = envelope.entries.some((entry) => {
    if (
      entry.stream !== "final-outbox" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as Partial<FinalOutboxRecord>;
    return (
      body.t === "final" &&
      body.conversationId === conversationId &&
      body.runId === committed.runId &&
      body.commitRevision === committed.commitRevision &&
      body.digest === bundle.digest &&
      body.state === "pending"
    );
  });
  if (!hasContentIndex || !hasFinal) return false;

  const mutationBatch = bundle.body.mutationBatch;
  if (!mutationBatch) return true;
  if (!batch) return true;
  const decision = envelope.entries.find((entry) => {
    if (
      entry.stream !== "publish" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as Partial<
      Extract<PublishRecord, { t: "publish-decision" }>
    >;
    return (
      body.t === "publish-decision" &&
      body.assignmentId === committed.assignmentId &&
      canonicalize(body.batch) === canonicalize({ ref: mutationBatch.ref }) &&
      body.sessionCount === mutationBatch.sessionCount &&
      body.globalCount === mutationBatch.globalCount
    );
  })?.body as Extract<PublishRecord, { t: "publish-decision" }> | undefined;
  const needsDecision = batch.records.length > 0;
  if (!needsDecision) return decision === undefined;
  if (!decision) return false;
  return (["session", "global"] as const).every((domain) => {
    if (
      !domainPublishDecisionRequired(batch.records, decision.outcomes, domain)
    ) {
      return true;
    }
    return envelope.entries.some((entry) => {
      if (
        entry.stream !== "publish" ||
        typeof entry.body !== "object" ||
        entry.body === null
      ) {
        return false;
      }
      const body = entry.body as Partial<
        Extract<PublishRecord, { t: "publish-progress" }>
      >;
      return (
        body.t === "publish-progress" &&
        body.assignmentId === committed.assignmentId &&
        body.domain === domain &&
        body.upToSeq === 0 &&
        body.state === "pending"
      );
    });
  });
}

export function submissionCommitSidecars(
  envelope: ConversationFactGroup,
  conversationId: string,
  committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
): SubmissionCommitSidecars {
  const contentRecords = envelope.entries.filter((entry) => {
    if (
      entry.stream !== runStream(conversationId) ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    return (entry.body as { readonly kind?: unknown }).kind === "content-asset-index";
  });
  if (contentRecords.length !== 1) {
    throw corruptRunJournal(
      "Submission guard commit has no unique content sidecar",
    );
  }
  const content = contentRecords[0]!.body as unknown;
  assertConversationRunInternalRecord(content);
  if (content.kind !== "content-asset-index") {
    throw corruptRunJournal(
      "Submission guard commit has an invalid content sidecar",
    );
  }

  const finalRecords = envelope.entries.filter((entry) => {
    if (
      entry.stream !== "final-outbox" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as Partial<FinalOutboxRecord>;
    return (
      body.t === "final" &&
      body.conversationId === conversationId &&
      body.runId === committed.runId &&
      body.commitRevision === committed.commitRevision
    );
  });
  if (finalRecords.length !== 1) {
    throw corruptRunJournal(
      "Submission guard commit has no unique final sidecar",
    );
  }
  const final = finalRecords[0]!.body as unknown;
  assertPlainRecord(final, "Submission guard final sidecar");
  assertExactRecordKeys(
    final,
    ["commitRevision", "conversationId", "digest", "runId", "state", "t"],
    "Submission guard final sidecar",
  );
  assertDigest(final.digest, "Submission guard final digest");
  if (final.state !== "pending") {
    throw corruptRunJournal("Submission guard final sidecar is not pending");
  }

  const publishRecords = envelope.entries.filter((entry) => {
    if (
      entry.stream !== "publish" ||
      typeof entry.body !== "object" ||
      entry.body === null
    ) {
      return false;
    }
    const body = entry.body as {
      readonly assignmentId?: unknown;
      readonly t?: unknown;
    };
    return body.assignmentId === committed.assignmentId;
  });
  const decisionRecords = publishRecords.filter(
    (entry) => (entry.body as { readonly t?: unknown }).t === "publish-decision",
  );
  const progressRecords = publishRecords.filter(
    (entry) => (entry.body as { readonly t?: unknown }).t === "publish-progress",
  );
  if (
    decisionRecords.length + progressRecords.length !== publishRecords.length ||
    decisionRecords.length > 1
  ) {
    throw corruptRunJournal(
      "Submission guard commit has duplicate publish decisions",
    );
  }
  let publish: SubmissionCommitSidecars["publish"];
  if (decisionRecords.length === 1) {
    const decision = decisionRecords[0]!.body as unknown;
    assertPlainRecord(decision, "Submission guard publish decision");
    assertExactRecordKeys(
      decision,
      [
        "assignmentId",
        "batch",
        "globalCount",
        "outcomes",
        "sessionCount",
        "t",
      ],
      "Submission guard publish decision",
    );
    assertPlainRecord(decision.batch, "Submission guard publish batch");
    assertExactRecordKeys(
      decision.batch,
      ["ref"],
      "Submission guard publish batch",
    );
    assertArtifactReference(
      decision.batch.ref,
      "Submission guard publish batch ref",
    );
    assertNonNegativeSafeInteger(
      decision.sessionCount as number,
      "Submission guard session mutation count",
    );
    assertNonNegativeSafeInteger(
      decision.globalCount as number,
      "Submission guard global mutation count",
    );
    if (!Array.isArray(decision.outcomes)) {
      throw corruptRunJournal(
        "Submission guard publish outcomes must be an array",
      );
    }
    const pendingDomains = new Set<"session" | "global">();
    for (const record of progressRecords) {
      const progress = record.body as unknown;
      assertPlainRecord(progress, "Submission guard publish progress");
      assertExactRecordKeys(
        progress,
        ["assignmentId", "domain", "state", "t", "upToSeq"],
        "Submission guard publish progress",
      );
      if (
        (progress.domain !== "session" && progress.domain !== "global") ||
        progress.state !== "pending" ||
        progress.upToSeq !== 0 ||
        pendingDomains.has(progress.domain)
      ) {
        throw corruptRunJournal("Submission guard publish progress is invalid");
      }
      pendingDomains.add(progress.domain);
    }
    publish = {
      batch: { ref: decision.batch.ref as ArtifactRef },
      sessionCount: decision.sessionCount as number,
      globalCount: decision.globalCount as number,
      pendingDomains,
    };
  } else if (progressRecords.length > 0) {
    throw corruptRunJournal(
      "Submission guard publish progress has no decision",
    );
  }
  return {
    contentAssetsDigest: byteDigest(
      Buffer.from(canonicalize(content.entries), "utf8"),
    ),
    finalDigest: final.digest as string,
    ...(publish ? { publish } : {}),
  };
}

export function submissionCommitSidecarsMatch(
  sidecars: SubmissionCommitSidecars,
  bundle: ReturnType<typeof validateConversationSealedBundle>,
): boolean {
  if (
    sidecars.contentAssetsDigest !==
      byteDigest(
        Buffer.from(canonicalize(bundle.body.contentAssets), "utf8"),
      ) ||
    sidecars.finalDigest !== bundle.digest
  ) {
    return false;
  }
  const mutationBatch = bundle.body.mutationBatch;
  if (!mutationBatch) return sidecars.publish === undefined;
  const publish = sidecars.publish;
  if (
    !publish ||
    canonicalize(publish.batch) !== canonicalize({ ref: mutationBatch.ref }) ||
    publish.sessionCount !== mutationBatch.sessionCount ||
    publish.globalCount !== mutationBatch.globalCount
  ) {
    return false;
  }
  const expectedDomains = new Set<"session" | "global">();
  if (mutationBatch.sessionCount > 0) expectedDomains.add("session");
  if (mutationBatch.globalCount > 0) expectedDomains.add("global");
  return (
    publish.pendingDomains.size === expectedDomains.size &&
    [...expectedDomains].every((domain) => publish.pendingDomains.has(domain))
  );
}

export interface CommittedBundleBinding {
  readonly committed: Extract<ConversationRunJournalRecord, { t: "committed" }>;
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly closure:
    | ValidatedConversationBundleClosure
    | ValidatedConversationReplayClosure;
}

export async function loadCommittedBundleBinding(
  envelope: ConversationFactGroup<unknown>,
  artifacts: ArtifactStore,
  matches: (
    committed: Extract<ConversationRunJournalRecord, { t: "committed" }>,
  ) => boolean,
): Promise<CommittedBundleBinding> {
  const candidates = envelope.entries
    .filter(
      (entry) =>
        entry.stream.startsWith("run:") &&
        typeof entry.body === "object" &&
        entry.body !== null &&
        "t" in entry.body &&
        entry.body.t === "committed",
    )
    .map((entry) => ({
      stream: entry.stream,
      committed: snapshot(
        entry.body as Extract<ConversationRunJournalRecord, { t: "committed" }>,
        "Committed run sidecar binding",
      ),
    }))
    .filter((candidate) => matches(candidate.committed));
  if (candidates.length !== 1) {
    throw corruptRunJournal("Commit sidecar must bind exactly one committed run");
  }
  const { committed, stream } = candidates[0]!;
  assertCommittedRunRecord(committed);
  const bytes = await artifacts.get(committed.bundle.ref);
  const bundle = validateConversationSealedBundle(
    JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
  );
  const closure = await validateConversationBundleClosure(bundle, artifacts, null);
  if (
    stream !== runStream(bundle.body.conversationId) ||
    bundle.assignmentId !== committed.assignmentId ||
    bundle.body.runId !== committed.runId ||
    bundle.body.baseRevision + 1 !== committed.commitRevision ||
    canonicalize(closure.artifact.ref) !== canonicalize(committed.bundle.ref)
  ) {
    throw corruptRunJournal(
      "Committed run sidecar binding does not match its bundle",
    );
  }
  return { committed, bundle, closure };
}

export async function prepareStored<T>(
  value: T,
  artifacts: ArtifactStore,
): Promise<PreparedStored<T>> {
  const bytes = Buffer.from(canonicalize(value), "utf8");
  if (bytes.byteLength <= MAX_INLINE_LOGICAL_RECORD_BYTES / 2) {
    return { stored: value, references: [] };
  }
  const ref = await artifacts.put(bytes);
  return { stored: { ref }, references: [ref] };
}

export async function loadStored<T>(
  stored: Stored<T>,
  artifacts: ArtifactStore,
): Promise<T> {
  if (isStoredReference(stored)) {
    return JSON.parse(
      Buffer.from(await artifacts.get(stored.ref)).toString("utf8"),
    ) as T;
  }
  return snapshot(stored, "Inline run journal value");
}

export function isStoredReference<T>(
  value: Stored<T>,
): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

export function conversationStatusDeliveryInputs(
  conversationId: string,
  state: Pick<RunProjection, "admittedByRun">,
  entries: readonly LogicalRecord<unknown>[],
  at: string,
): ConversationStatusDeliveryInput[] {
  const admittedInEnvelope = new Map<string, IngressContext>();
  for (const entry of entries) {
    if (entry.stream !== runStream(conversationId)) continue;
    const body = entry.body as Partial<ConversationRunJournalRecord>;
    if (
      "t" in body &&
      body.t === "admitted" &&
      "runId" in body &&
      "ingress" in body
    ) {
      admittedInEnvelope.set(
        body.runId as string,
        body.ingress as IngressContext,
      );
    }
  }
  const result: ConversationStatusDeliveryInput[] = [];
  for (const entry of entries) {
    if (entry.stream !== runStream(conversationId)) continue;
    const body = entry.body as Partial<ConversationRunJournalRecord>;
    if (
      !("t" in body) ||
      body.t !== "state" ||
      !("runId" in body) ||
      !("state" in body) ||
      !("statusRevision" in body)
    ) {
      continue;
    }
    const runId = body.runId as string;
    const ingress =
      admittedInEnvelope.get(runId) ??
      state.admittedByRun.get(runId)?.record.ingress;
    if (!ingress) {
      throw corruptRunJournal(
        "Run state has no durable ingress for status delivery",
      );
    }
    result.push({
      at,
      conversationId,
      runId,
      state: body.state as ConversationRunState,
      statusRevision: body.statusRevision as number,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ingress,
    });
  }
  return result;
}

export async function validateImportedConversationCommit(
  context: Pick<
    ConversationRunReductionContext,
    "conversationId" | "artifacts" | "verifier"
  >,
  state: RunProjection,
  body: Extract<ConversationRunJournalRecord, { t: "committed" }>,
  group: AuthenticatedConversationFacts,
): Promise<void> {
  if (
    !isAuthenticatedConversationFacts(group) ||
    group.source.manifest.conversationId !== context.conversationId
  ) {
    throw corruptRunJournal(
      "Imported commit has no authenticated conversation scope",
    );
  }
  const assigned = state.assignedById.get(body.assignmentId);
  if (!assigned || assigned.record.runId !== body.runId) {
    throw corruptRunJournal("Imported commit has no matching assignment");
  }
  group.assertAssignment(assigned.record);
  const binding = await loadCommittedBundleBinding(
    group,
    context.artifacts,
    (candidate) => candidate.assignmentId === body.assignmentId,
  );
  const bundle = binding.bundle;
  const open = state.resolutionsByRun.get(body.runId);
  assertHistoricalBundleFence({
    assignedExecutorId: assigned.record.executorId,
    assignedOwnerEpoch: assigned.record.ownerEpoch,
    assignedBaseRevision: assigned.record.baseRevision,
    bundleExecutorId: bundle.executorId,
    bundleOwnerEpoch: bundle.body.ownerEpoch,
    bundleBaseRevision: bundle.body.baseRevision,
    conflictOpen:
      open?.cause === "dispatch-conflict" && open.resolution === undefined,
  });
  if (
    bundle.body.conversationId !== context.conversationId ||
    bundle.body.runId !== body.runId ||
    bundle.body.baseRevision + 1 !== body.commitRevision
  ) {
    throw corruptRunJournal(
      "Imported bundle does not bind its conversation revision",
    );
  }
  const admitted = state.admittedByRun.get(body.runId);
  if (!admitted || state.openInputAssignments.get(body.runId) === body.assignmentId) {
    throw corruptRunJournal("Imported committed input is missing or still open");
  }
  const closure =
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
  if (
    !envelopeHasConversationCommitSidecars(
      group as ConversationFactGroup,
      context.conversationId,
      body,
      bundle,
      closure.batch,
    )
  ) {
    throw corruptRunJournal("Imported commit has incomplete conversation sidecars");
  }
  applyCommittedSessionMutations(state, closure.batch?.records ?? []);
}
