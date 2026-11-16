import { Buffer } from "node:buffer";
import {
  collectArtifactRefs,
  resolveSealedBundleArtifactClosure,
  type ArtifactStore,
} from "@zhixing-ai/core/authority";
import {
  MAX_LEDGER_EVIDENCE_PAGE_ENTRIES,
  type ArtifactRef,
  type AssignmentActivationProof,
  type AssignmentMutationOverlayRecord,
  type AssignmentRecord,
  type AssignmentStagedReceipt,
  type AuthorityCallContext,
  type AuthorityCapability,
  type CancelProofBody,
  type LedgerEvidencePage,
  type LedgerSnapshot,
  type MutationBatch,
  type SealedBundle,
  type TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import {
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  conversationBundleRoots,
  createConversationSealedBundle,
  createJobSealedBundle,
  createMutationBatch,
  jobBundleRoots,
  mutationBatchArtifact,
  sealedBundleArtifact,
  stagedMutationDigest,
  validateConversationEnvelope,
  validateConversationSealedBundle,
  validateJobEnvelope,
  validateJobMutationBatch,
  validateJobSealedBundle,
  validateJobStagedMutationRecord,
  validateMutationBatch,
  validateStagedMutationRecord,
  validateTranscriptRunRecord,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  assertDigest,
  assertNonNegativeSafeInteger,
  assignmentRecord,
  corruptLedger,
  nextEntryFromSeq,
  snapshot,
  truncateUtf8,
  type AnyAssignmentActivationProof,
  type AssignmentEnvelope,
  type ConversationEnvelope,
  type ConversationSealInput,
  type JobEnvelope,
  type JobSealInput,
  type OwnerControlRequest,
  type StagedConversationMutationInput,
  type StagedJobMutationInput,
} from "./contracts.js";
import type { LedgerProjectionHistoryStore } from "./projection-history-store.js";

export interface LedgerSealingEvidenceOptions {
  readonly store: LedgerProjectionHistoryStore;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly acceptOwnerControl: (
    context: AuthorityCallContext,
    request: OwnerControlRequest,
  ) => Promise<void>;
}

export class LedgerSealingEvidence {
  readonly #store: LedgerProjectionHistoryStore;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #acceptOwnerControl: LedgerSealingEvidenceOptions["acceptOwnerControl"];

  constructor(options: LedgerSealingEvidenceOptions) {
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#verifier = options.verifier;
    this.#acceptOwnerControl = options.acceptOwnerControl;
  }

  async queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    assertIdentifier(assignmentId, "Assignment id");
    if (
      range &&
      (!Number.isSafeInteger(range.fromSeq) ||
        range.fromSeq <= 0 ||
        !Number.isSafeInteger(range.limit) ||
        range.limit <= 0 ||
        range.limit > MAX_LEDGER_EVIDENCE_PAGE_ENTRIES)
    ) {
      throw new RangeError(
        `Ledger evidence range must be within 1..${MAX_LEDGER_EVIDENCE_PAGE_ENTRIES}`,
      );
    }
    await this.#acceptOwnerControl(ctx, {
      method: "executor.queryLedger",
      assignmentId,
      requestId: ctx.requestId,
      body: { range: range ?? null },
    });
    return this.#store.queryEvidenceOrSnapshot(assignmentId, range);
  }

  async stageMutation(
    assignmentId: string,
    input: StagedConversationMutationInput | StagedJobMutationInput,
  ): Promise<AssignmentStagedReceipt> {
    const candidate = snapshot(input, "Staged mutation input");
    const digest = stagedMutationDigest(candidate);
    const transaction =
      await this.#store.transactSealingEvidence<AssignmentStagedReceipt>(
        assignmentId,
        (facts) => {
          if (facts.hasMutationRequestId(candidate.requestId)) {
            const existing = facts.stagedMutationForRequestId(
              candidate.requestId,
            );
            if (
              !existing ||
              canonicalize({
                domain: existing.domain,
                mutation: existing.mutation,
                requestId: existing.requestId,
                ...(existing.expected ? { expected: existing.expected } : {}),
              }) !== canonicalize(candidate)
            ) {
              throw new Error(
                "Staged mutation requestId has a conflicting payload",
              );
            }
            return {
              kind: "return",
              value: {
                kind: "assignment-mutation-staged",
                requestId: existing.requestId,
                recordSeq: existing.seq,
                mutationDigest: stagedMutationDigest(existing),
              },
            };
          }
          if (facts.phase !== "started" || facts.hasAborts) {
            throw new Error("Assignment can stage mutations only while started");
          }
          const execution = facts.received?.body.activation.ref.execution;
          if (!execution) {
            throw new Error("Assignment has no durable activation");
          }
          const staged = {
            v: 1 as const,
            t: "staged-mutation" as const,
            seq: facts.stagedMutationCount + 1,
            ...candidate,
          } as Extract<AssignmentRecord, { t: "staged-mutation" }>;
          if (execution === "job") {
            validateJobStagedMutationRecord(staged);
          } else {
            validateStagedMutationRecord(staged);
          }
          return {
            kind: "append",
            entries: [
              assignmentRecord(
                assignmentId,
                nextEntryFromSeq(facts.lastSeq, staged),
              ),
            ],
            value: {
              kind: "assignment-mutation-staged",
              requestId: staged.requestId,
              recordSeq: staged.seq,
              mutationDigest: digest,
            },
          };
        },
        { candidateReferences: collectArtifactRefs(candidate) },
      );
    return transaction.value;
  }

  async readStagedMutationOverlay(
    assignmentId: string,
  ): Promise<readonly AssignmentMutationOverlayRecord[]> {
    return this.#store.selectSealingEvidence(assignmentId, (facts) =>
      facts.stagedMutationsSnapshot().map((record) => ({
        recordSeq: record.seq,
        domain: record.domain,
        mutation: snapshot(record.mutation, "Staged overlay mutation"),
        requestId: record.requestId,
        mutationDigest: stagedMutationDigest(record),
      })),
    );
  }

  async sealConversationBundle(
    assignmentId: string,
    input: ConversationSealInput,
  ): Promise<ReturnType<typeof validateConversationSealedBundle>> {
    const state = await this.#store.selectSealingEvidence(
      assignmentId,
      (current) => ({
        phase: current.phase,
        received: current.received
          ? snapshot(current.received, "Received seal projection")
          : undefined,
        stagedMutations: current.stagedMutationsSnapshot().map((record) =>
          snapshot(record, "Staged seal mutation"),
        ),
      }),
    );
    if (
      (state.phase !== "started" &&
        state.phase !== "sealed" &&
        state.phase !== "acked") ||
      !state.received
    ) {
      throw new Error(
        "Assignment cannot seal a conversation result before started",
      );
    }
    const envelopeBytes = await this.#artifacts.get(
      state.received.body.envelope.ref,
    );
    const envelope = await verifyProtocolStep(() =>
      validateConversationEnvelope(
        JSON.parse(
          Buffer.from(envelopeBytes).toString("utf8"),
        ) as ConversationEnvelope,
        this.#verifier,
      ),
    );
    const staged = state.stagedMutations;
    const runRecordDependencies: ArtifactRef[] = [];
    if (isReferenceContainer(input.runRecord)) {
      const bytes = await this.#artifacts.get(input.runRecord.ref);
      const text = Buffer.from(bytes).toString("utf8");
      const parsed = JSON.parse(text) as TranscriptRunRecord;
      if (canonicalize(parsed) !== text) {
        throw new TypeError(
          "Transcript run record artifact must be canonical JSON",
        );
      }
      validateTranscriptRunRecord(parsed, envelope.work.runId);
      runRecordDependencies.push(...collectArtifactRefs(parsed));
    } else {
      validateTranscriptRunRecord(input.runRecord, envelope.work.runId);
    }
    let batchValue: MutationBatch | undefined;
    let batchSummary:
      | {
          readonly ref: ArtifactRef;
          readonly sessionCount: number;
          readonly globalCount: number;
        }
      | undefined;
    if (staged.length > 0) {
      batchValue = createMutationBatch(assignmentId, staged);
      const artifact = mutationBatchArtifact(batchValue);
      const stored = await this.#artifacts.put(artifact.bytes);
      if (canonicalize(stored) !== canonicalize(artifact.ref)) {
        throw new Error("Mutation batch store returned a different reference");
      }
      batchSummary = {
        ref: artifact.ref,
        sessionCount: staged.filter((record) => record.domain === "session")
          .length,
        globalCount: staged.filter((record) => record.domain === "global")
          .length,
      };
    }
    const body = {
      t: "conversation" as const,
      runId: envelope.work.runId,
      conversationId: envelope.work.conversationId,
      ownerEpoch: envelope.work.ownerEpoch,
      baseRevision: envelope.work.baseRevision,
      runRecord: input.runRecord,
      ...(input.windowCompact ? { windowCompact: input.windowCompact } : {}),
      contentAssets: [...input.contentAssets].sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      ),
      ...(batchSummary ? { mutationBatch: batchSummary } : {}),
    };
    const rootRefs = conversationBundleRoots(body);
    const rootDigests = new Set(rootRefs.map((ref) => ref.digest));
    const dependencyArtifacts = collectArtifactRefs([
      staged,
      runRecordDependencies,
    ])
      .filter((ref) => !rootDigests.has(ref.digest))
      .sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      );
    const bundle = createConversationSealedBundle({
      assignmentId,
      executorId: this.#executorId,
      streamFinal: input.streamFinal,
      usage: input.usage,
      usageFinal: input.usageFinal,
      dependencyArtifacts,
      body,
    });
    const artifact = sealedBundleArtifact(bundle);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Sealed bundle store returned a different reference");
    }
    await resolveSealedBundleArtifactClosure(bundle, this.#artifacts);
    await this.#recordSealedBundle(
      assignmentId,
      bundle,
      artifact.ref,
      batchValue,
    );
    return bundle;
  }

  async sealJobBundle(
    assignmentId: string,
    input: JobSealInput,
  ): Promise<ReturnType<typeof createJobSealedBundle>> {
    const state = await this.#store.selectSealingEvidence(
      assignmentId,
      (current) => ({
        phase: current.phase,
        received: current.received
          ? snapshot(current.received, "Received seal projection")
          : undefined,
        stagedMutations: current.stagedMutationsSnapshot().map((record) =>
          snapshot(record, "Staged seal mutation"),
        ),
      }),
    );
    if (
      (state.phase !== "started" &&
        state.phase !== "sealed" &&
        state.phase !== "acked") ||
      !state.received
    ) {
      throw new Error("Assignment cannot seal a job result before started");
    }
    const envelopeBytes = await this.#artifacts.get(
      state.received.body.envelope.ref,
    );
    const envelope = await verifyProtocolStep(() =>
      validateJobEnvelope(
        JSON.parse(
          Buffer.from(envelopeBytes).toString("utf8"),
        ) as JobEnvelope,
        this.#verifier,
      ),
    );
    if (canonicalize(input.fence) !== canonicalize(envelope.work.fence)) {
      throw new TypeError("Job seal fence does not match the durable dispatch");
    }
    const staged = state.stagedMutations;
    if (staged.some((record) => record.domain !== "global")) {
      throw corruptLedger("Job assignment contains a session mutation");
    }
    let batchValue: MutationBatch | undefined;
    let batchSummary:
      | {
          readonly ref: ArtifactRef;
          readonly sessionCount: 0;
          readonly globalCount: number;
        }
      | undefined;
    if (staged.length > 0) {
      batchValue = createMutationBatch(assignmentId, staged);
      const batchArtifact = mutationBatchArtifact(batchValue);
      const stored = await this.#artifacts.put(batchArtifact.bytes);
      if (canonicalize(stored) !== canonicalize(batchArtifact.ref)) {
        throw new Error("Mutation batch store returned a different reference");
      }
      batchSummary = {
        ref: batchArtifact.ref,
        sessionCount: 0,
        globalCount: staged.length,
      };
    }
    const body = {
      t: "job" as const,
      jobRunId: envelope.work.jobRunId,
      taskId: envelope.work.taskId,
      fence: snapshot(input.fence, "Job commit fence"),
      outcome: snapshot(input.outcome, "Job outcome"),
      contentAssets: [...input.contentAssets].sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      ),
      ...(batchSummary ? { mutationBatch: batchSummary } : {}),
    };
    const rootRefs = jobBundleRoots(body);
    const rootDigests = new Set(rootRefs.map((ref) => ref.digest));
    const dependencyArtifacts = collectArtifactRefs(staged)
      .filter((ref) => !rootDigests.has(ref.digest))
      .sort((left, right) =>
        left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
      );
    const bundle = createJobSealedBundle({
      assignmentId,
      executorId: this.#executorId,
      streamFinal: input.streamFinal,
      usage: input.usage,
      usageFinal: input.usageFinal,
      dependencyArtifacts,
      body,
    });
    const artifact = sealedBundleArtifact(bundle);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Sealed bundle store returned a different reference");
    }
    await resolveSealedBundleArtifactClosure(bundle, this.#artifacts);
    await this.#recordSealedBundle(
      assignmentId,
      bundle,
      artifact.ref,
      batchValue,
    );
    return bundle;
  }

  async sealedBundle(assignmentId: string): Promise<SealedBundle> {
    const projection = await this.#store.selectSealingEvidence(
      assignmentId,
      (facts) => {
        if (
          (facts.phase !== "sealed" && facts.phase !== "acked") ||
          !facts.sealed
        ) {
          throw new Error("Assignment has no sealed bundle");
        }
        const execution = facts.received?.body.activation.ref.execution;
        if (!execution) {
          throw corruptLedger("Sealed assignment has no received activation");
        }
        return {
          sealed: snapshot(facts.sealed, "Sealed record"),
          execution,
        };
      },
    );
    return this.#loadSealedBundle(
      assignmentId,
      projection.sealed,
      projection.execution,
    );
  }

  async assignmentArtifactAuthority(assignmentId: string): Promise<{
    readonly capability: AuthorityCapability;
    readonly activation: AnyAssignmentActivationProof;
  }> {
    const received = await this.#store.selectSealingEvidence(
      assignmentId,
      (facts) => {
        if (!facts.received) {
          throw new Error("Assignment has no durable received activation");
        }
        return snapshot(facts.received.body, "Received artifact authorization");
      },
    );
    const bytes = await this.#artifacts.get(received.envelope.ref);
    const raw = JSON.parse(
      Buffer.from(bytes).toString("utf8"),
    ) as AssignmentEnvelope;
    const envelope =
      raw.execution === "conversation"
        ? await verifyProtocolStep(() =>
            validateConversationEnvelope(raw, this.#verifier),
          )
        : await verifyProtocolStep(() =>
            validateJobEnvelope(raw, this.#verifier),
          );
    const capability = envelope.capabilities.find(
      (candidate) =>
        received.activation.capIds.includes(candidate.capId) &&
        candidate.assignmentId === assignmentId &&
        candidate.executorId === this.#executorId,
    );
    if (!capability) {
      throw corruptLedger(
        "Received assignment has no activated artifact capability",
      );
    }
    const activation =
      received.activation.ref.execution === "conversation"
        ? (received.activation as AssignmentActivationProof<"conversation">)
        : (received.activation as AssignmentActivationProof<"job">);
    return {
      capability: snapshot(capability, "Artifact authority capability"),
      activation: snapshot(activation, "Artifact activation proof"),
    };
  }

  async sealedBundleForRecovery(
    assignmentId: string,
  ): Promise<
    | { readonly kind: "not-sealed" }
    | { readonly kind: "sealed"; readonly bundle: SealedBundle }
  > {
    const projection = await this.#store.selectSealingEvidence(
      assignmentId,
      (facts) => {
        if (facts.phase !== "sealed" && facts.phase !== "acked") {
          return undefined;
        }
        if (!facts.sealed) {
          throw corruptLedger("Sealed assignment has no sealed record");
        }
        const execution = facts.received?.body.activation.ref.execution;
        if (!execution) {
          throw corruptLedger("Sealed assignment has no received activation");
        }
        return {
          sealed: snapshot(facts.sealed, "Sealed record"),
          execution,
        };
      },
    );
    if (!projection) return { kind: "not-sealed" };
    return {
      kind: "sealed",
      bundle: await this.#loadSealedBundle(
        assignmentId,
        projection.sealed,
        projection.execution,
      ),
    };
  }

  async cancelProof(assignmentId: string): Promise<CancelProofBody | undefined> {
    return this.#store.selectSealingEvidence(assignmentId, (facts) =>
      facts.halted ? snapshot(facts.halted, "Cancel proof") : undefined,
    );
  }

  async failExecution(
    assignmentId: string,
    input: {
      readonly reason: string;
      readonly usageFinal: {
        readonly reportDigest: string;
        readonly upToUsageSeq: number;
      };
    },
  ): Promise<Extract<AssignmentRecord, { t: "execution-failed" }> | undefined> {
    assertIdentifier(assignmentId, "Failed assignment id");
    const reason = truncateUtf8(input.reason.trim(), 512);
    if (reason.length === 0) {
      throw new TypeError("Execution failure reason is empty");
    }
    assertDigest(
      input.usageFinal.reportDigest,
      "Execution failure report digest",
    );
    assertNonNegativeSafeInteger(
      input.usageFinal.upToUsageSeq,
      "Execution failure usage sequence",
    );
    const failure = snapshot(
      {
        v: 1 as const,
        t: "execution-failed" as const,
        reason,
        usageFinal: snapshot(
          input.usageFinal,
          "Execution failure final usage",
        ),
      },
      "Execution failure record",
    );
    const transaction = await this.#store.transactSealingEvidence<
      Extract<AssignmentRecord, { t: "execution-failed" }> | undefined
    >(assignmentId, (facts) => {
      if (facts.phase === "failed") {
        if (canonicalize(facts.failure) !== canonicalize(failure)) {
          throw new Error(
            "Assignment already failed with a different durable result",
          );
        }
        return { kind: "return", value: facts.failure };
      }
      if (
        facts.phase === "halted" ||
        facts.phase === "sealed" ||
        facts.phase === "acked"
      ) {
        return { kind: "return", value: undefined };
      }
      if (
        facts.phase !== "started" ||
        facts.hasAborts ||
        facts.hasPendingInteractionObligations ||
        facts.hasOpenSideEffects
      ) {
        throw new Error(
          "Assignment execution failure has no clean started prefix",
        );
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntryFromSeq(facts.lastSeq, failure),
          ),
        ],
        value: failure,
      };
    });
    return transaction.value;
  }

  async #recordSealedBundle(
    assignmentId: string,
    bundle: SealedBundle,
    bundleRef: ArtifactRef,
    mutationBatch?: MutationBatch,
  ): Promise<void> {
    const mutationBatchRef = mutationBatchArtifactReference(mutationBatch);
    const references = [
      bundleRef,
      ...(bundle.body.t === "conversation"
        ? conversationBundleRoots(bundle.body)
        : jobBundleRoots(bundle.body)),
      ...bundle.dependencyArtifacts,
      ...(mutationBatchRef ? [mutationBatchRef] : []),
    ];
    const sealed = snapshot(
      {
        v: 1 as const,
        t: "bundle_sealed" as const,
        bundle: { ref: snapshot(bundleRef, "Sealed bundle reference") },
        ...(mutationBatchRef
          ? {
              mutationBatch: {
                ref: snapshot(mutationBatchRef, "Mutation batch reference"),
              },
            }
          : {}),
      },
      "Bundle sealed record",
    );
    await this.#store.transactSealingEvidence<void>(
      assignmentId,
      (facts) => {
        if (
          facts.phase === "failed" ||
          facts.phase === "sealed" ||
          facts.phase === "acked"
        ) {
          if (canonicalize(facts.sealed) !== canonicalize(sealed)) {
            throw new Error(
              "Assignment already sealed a different bundle payload",
            );
          }
          return { kind: "return", value: undefined };
        }
        if (facts.phase !== "started" || facts.hasAborts) {
          throw new Error("Assignment cannot seal a bundle before started");
        }
        if (facts.hasOpenSideEffects) {
          throw new Error(
            "Assignment cannot seal a bundle with an open side effect",
          );
        }
        if (facts.hasPendingInteractionObligations) {
          throw new Error(
            "Assignment cannot seal a bundle before every interaction obligation is complete",
          );
        }
        if (!facts.received) {
          throw corruptLedger("Started assignment has no received record");
        }
        const activationRef = facts.received.body.activation.ref;
        const bodyMatches =
          activationRef.execution === "conversation"
            ? bundle.body.t === "conversation" &&
              bundle.body.runId === activationRef.runId &&
              bundle.body.conversationId === activationRef.conversationId
            : bundle.body.t === "job" &&
              bundle.body.jobRunId === activationRef.jobRunId &&
              bundle.body.taskId === activationRef.taskId;
        if (
          !bodyMatches ||
          bundle.assignmentId !== assignmentId ||
          bundle.executorId !== this.#executorId
        ) {
          throw new Error(
            "Sealed bundle does not bind the received assignment",
          );
        }
        if (facts.stagedMutationCount === 0) {
          if (mutationBatch || bundle.body.mutationBatch) {
            throw new Error(
              "Sealed bundle declares a mutation batch without staged mutations",
            );
          }
        } else {
          if (!mutationBatch || !mutationBatchRef || !bundle.body.mutationBatch) {
            throw new Error("Sealed bundle omits its staged mutation batch");
          }
          const expected = createMutationBatch(
            assignmentId,
            [...facts.stagedMutationsSnapshot()],
          );
          if (
            canonicalize(expected) !== canonicalize(mutationBatch) ||
            canonicalize(bundle.body.mutationBatch.ref) !==
              canonicalize(mutationBatchRef)
          ) {
            throw new Error(
              "Sealed bundle mutation batch is not the current staged prefix",
            );
          }
        }
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntryFromSeq(facts.lastSeq, sealed),
            ),
          ],
          value: undefined,
        };
      },
      { candidateReferences: references },
    );
  }

  async #loadSealedBundle(
    assignmentId: string,
    sealed: Extract<AssignmentRecord, { t: "bundle_sealed" }>,
    expectedExecution: "conversation" | "job",
  ): Promise<SealedBundle> {
    const bytes = await this.#artifacts.get(sealed.bundle.ref);
    const raw = JSON.parse(
      Buffer.from(bytes).toString("utf8"),
    ) as SealedBundle;
    const bundle =
      raw.body.t === "conversation"
        ? validateConversationSealedBundle(raw)
        : validateJobSealedBundle(raw);
    if (bundle.body.t !== expectedExecution) {
      throw corruptLedger(
        "Sealed bundle execution kind differs from its activation",
      );
    }
    const artifact = sealedBundleArtifact(bundle);
    if (canonicalize(artifact.ref) !== canonicalize(sealed.bundle.ref)) {
      throw corruptLedger("Sealed bundle artifact reference is inconsistent");
    }
    if (sealed.mutationBatch) {
      if (!bundle.body.mutationBatch) {
        throw corruptLedger(
          "Ledger mutation batch reference is absent from the bundle",
        );
      }
      if (
        canonicalize(sealed.mutationBatch.ref) !==
        canonicalize(bundle.body.mutationBatch.ref)
      ) {
        throw corruptLedger(
          "Ledger mutation batch reference conflicts with the bundle",
        );
      }
      const batchBytes = await this.#artifacts.get(sealed.mutationBatch.ref);
      const candidate = JSON.parse(
        Buffer.from(batchBytes).toString("utf8"),
      ) as MutationBatch;
      const batch =
        expectedExecution === "job"
          ? validateJobMutationBatch(candidate)
          : validateMutationBatch(candidate);
      if (batch.assignmentId !== assignmentId) {
        throw corruptLedger(
          "Mutation batch belongs to a different assignment",
        );
      }
    } else if (bundle.body.mutationBatch) {
      throw corruptLedger(
        "Bundle mutation batch is absent from the ledger seal record",
      );
    }
    await resolveSealedBundleArtifactClosure(bundle, this.#artifacts);
    return bundle;
  }
}

function isReferenceContainer(
  value: unknown,
): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "ref")
  );
}

function mutationBatchArtifactReference(
  batch: MutationBatch | undefined,
): ArtifactRef | undefined {
  return batch ? mutationBatchArtifact(batch).ref : undefined;
}
