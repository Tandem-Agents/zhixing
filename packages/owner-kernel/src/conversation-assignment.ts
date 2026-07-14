import { Buffer } from "node:buffer";
import { isNonEmptyUserTurnInput } from "@zhixing/core";
import {
  AuthorityStorageError,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  collectArtifactRefs,
  type ArtifactStore,
  type AuthorityCommitLog,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentRecord,
  AssignmentActivationProof,
  AuthorityCallContext,
  ConversationRunState,
  ConversationStatusNotice,
  FinalFrame,
  FinalOutboxRecord,
  GlobalStagedMutation,
  DispatchResult,
  IngressContext,
  IsoTime,
  LedgerSnapshot,
  LogicalRecord,
  MutationBatch,
  PublishRecord,
  PublishConflictNotice,
  SealedBundle,
  SessionInternalRecord,
  SessionStagedMutation,
  TranscriptRunRecord,
  UserTurnInput,
} from "@zhixing/core/contracts";
import {
  buildConversationActivationPayload,
  canonicalize,
  conversationBundleRoots,
  createSignedConversationEnvelope,
  dispatchEnvelopeArtifact,
  permissionSnapshotLeaseDigest,
  sealedBundleArtifact,
  signConversationActivation,
  validateConversationEnvelope,
  validateConversationSealedBundle,
  validateConversationInteractionMirrorEntry,
  validateMutationBatch,
  validateTranscriptRunRecord,
  type ConversationInteractionMirrorEntry,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";

type Stored<T> = T | { readonly ref: ArtifactRef };
type AssignmentRecordLike = Extract<AssignmentRecord, { t: "staged-mutation" }>;

type ConversationCommitLogRecord =
  | ConversationRunJournalRecord
  | ConversationProjectionRecord
  | PublishRecord
  | FinalOutboxRecord;

interface ConversationProjectionRecord {
  readonly kind: "conversation-commit-projection";
  readonly assignmentId: string;
  readonly runId: string;
  readonly commitRevision: number;
  readonly digest: string;
}

interface PublishProjection {
  readonly decisions: Map<
    string,
    Extract<PublishRecord, { t: "publish-decision" }>
  >;
  readonly batches: Map<string, MutationBatch>;
  readonly commitRevisions: Map<string, number>;
  readonly progress: Map<
    string,
    Extract<PublishRecord, { t: "publish-progress" }>
  >;
}

interface FinalOutboxProjectionEntry {
  readonly record: FinalOutboxRecord;
  readonly at: IsoTime;
}

type FinalOutboxProjection = Map<string, FinalOutboxProjectionEntry>;

const FINAL_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type ConversationRunJournalRecord =
  | {
      readonly t: "admitted";
      readonly ingressKey: string;
      readonly runId: string;
      readonly input: Stored<UserTurnInput>;
      readonly ingress: IngressContext;
      readonly queuedPosition: number;
    }
  | {
      readonly t: "assigned";
      readonly runId: string;
      readonly assignmentId: string;
      readonly executorId: string;
      readonly manifestDigest: string;
      readonly dispatchRef: ArtifactRef;
      readonly permissionLeaseDigest: string;
      readonly capIds: string[];
      readonly reservation: { readonly reservationId: string; readonly attempt: number };
    }
  | { readonly t: "dispatch-acked"; readonly assignmentId: string }
  | {
      readonly t: "interaction-mirror";
      readonly assignmentId: string;
      readonly entries: ConversationInteractionMirrorEntry[];
    }
  | {
      readonly t: "state";
      readonly runId: string;
      readonly state: ConversationRunState;
      readonly statusRevision: number;
    }
  | {
      readonly t: "committed";
      readonly runId: string;
      readonly assignmentId: string;
      readonly bundle: { readonly ref: ArtifactRef };
      readonly commitRevision: number;
    }
  | SessionInternalRecord;

export interface AssignmentSubmissionAuthorizer {
  authorize(
    context: AuthorityCallContext,
    method:
      | "submission.reportStarted"
      | "submission.mirrorInteractions"
      | "submission.submitBundle",
    assignmentId: string,
  ): void;
}

export interface ConversationRunJournalOptions {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly submission: AssignmentSubmissionAuthorizer;
  readonly authority: ConversationCommitAuthority;
  readonly projection: ConversationCommitProjection;
  readonly publisher?: ConversationMutationPublisher;
}

export interface ConversationCommitDecisionInput {
  readonly assignmentId: string;
  readonly authorityPrefixLsn: number;
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly baseRevision: number;
  readonly runRecord: TranscriptRunRecord;
  readonly sessionMutations: ReadonlyArray<{
    readonly seq: number;
    readonly mutation: SessionStagedMutation;
    readonly requestId: string;
  }>;
}

export interface ConversationCommitAuthority {
  /**
   * 在同一 AuthorityCommitLog 前缀上裁决当前 epoch、revision、transcript 序号
   * 与 session staged 写，并为本次提交保留唯一 commitRevision。
   */
  decideAtPrefix(
    input: ConversationCommitDecisionInput,
  ):
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: import("@zhixing/core/contracts").AuthorityError;
      };
}

export interface ConversationCommitProjectionInput {
  readonly assignmentId: string;
  readonly conversationId: string;
  readonly commitRevision: number;
  readonly digest: string;
  readonly runRecord: TranscriptRunRecord;
  readonly windowCompact?: import("@zhixing/core/contracts").WindowCompactInstruction;
  readonly contentAssets: readonly import("@zhixing/core/contracts").ContentAssetRef[];
}

export interface ConversationCommitProjection {
  /** 幂等物化权威提交；重复调用必须返回成功且不得产生第二份派生事实。 */
  project(input: ConversationCommitProjectionInput): Promise<void>;
}

export interface ConversationMutationPublisher {
  /**
   * Pure batch decision over this AuthorityCommitLog projected through authorityPrefixLsn.
   * The projection must include prior granted publish decisions so revisions are reserved at
   * the same serialization point as the conversation commit.
   */
  decideGlobalBatchAtPrefix(input: {
    readonly assignmentId: string;
    readonly authorityPrefixLsn: number;
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly mutation: GlobalStagedMutation;
      readonly requestId: string;
      readonly expected: { readonly anchorEpoch: number };
    }>;
  }): ReadonlyArray<{
    readonly seq: number;
    readonly outcome:
      | { readonly t: "granted"; readonly targetRevision: number }
      | {
          readonly t: "conflicted";
          readonly error: import("@zhixing/core/contracts").AuthorityError;
        };
  }>;
  /** Granted decisions are final; replaying the same assignment/seq must not duplicate effects. */
  apply(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly domain: "session" | "global";
    readonly mutation: SessionStagedMutation | GlobalStagedMutation;
    readonly requestId: string;
    readonly targetRevision: number;
  }): Promise<void>;
}

export interface CommittedConversationResult {
  readonly frame: FinalFrame;
  readonly bundle: SealedBundle & { readonly body: { readonly t: "conversation" } };
}

export interface PendingConversationDispatch {
  readonly assignmentId: string;
  readonly envelope: Extract<
    import("@zhixing/core/contracts").DispatchEnvelope,
    { execution: "conversation" }
  >;
  readonly activation: AssignmentActivationProof<"conversation">;
}

export interface ConversationDispatchPort {
  dispatch(
    envelope: PendingConversationDispatch["envelope"],
    activation: AssignmentActivationProof<"conversation">,
    ctx: AuthorityCallContext,
  ): Promise<DispatchResult>;
  queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<import("@zhixing/core/contracts").LedgerSnapshot | import("@zhixing/core/contracts").LedgerEvidencePage>;
}

interface AdmittedProjection {
  readonly record: Extract<ConversationRunJournalRecord, { t: "admitted" }>;
  readonly input: UserTurnInput;
}

interface AssignedProjection {
  readonly record: Extract<ConversationRunJournalRecord, { t: "assigned" }>;
  readonly envelope: PendingConversationDispatch["envelope"];
  readonly commit: { readonly lsn: number; readonly envelopeDigest: string; readonly at: string };
  acked: boolean;
}

interface RunProjection {
  readonly conversationId: string;
  readonly admittedByRun: Map<string, AdmittedProjection>;
  readonly runByIngress: Map<string, string>;
  readonly assignedById: Map<string, AssignedProjection>;
  readonly assignmentByRun: Map<string, string>;
  readonly stateByRun: Map<
    string,
    { readonly state: ConversationRunState; readonly statusRevision: number }
  >;
  readonly mirroredUpTo: Map<string, number>;
  readonly mirroredEntries: Map<string, Map<number, ConversationInteractionMirrorEntry>>;
  readonly committedByAssignment: Map<
    string,
    Extract<ConversationRunJournalRecord, { t: "committed" }>
  >;
  readonly commits: Array<Extract<ConversationRunJournalRecord, { t: "committed" }>>;
  readonly contentByRevision: Map<number, readonly import("@zhixing/core/contracts").ContentAssetRef[]>;
  readonly projectedByAssignment: Map<string, ConversationProjectionRecord>;
}

interface PreparedStored<T> {
  readonly stored: Stored<T>;
  readonly references: readonly ArtifactRef[];
}

interface AssignDecision {
  readonly assignmentId: string;
}

export interface InProcessDispatchContextFactory {
  create(
    assignmentId: string,
    method: "executor.dispatch" | "executor.queryLedger",
  ): AuthorityCallContext;
}

export interface InProcessConversationDispatcherOptions {
  readonly enabled: boolean;
  readonly journal: ConversationRunJournal;
  readonly executor: ConversationDispatchPort;
  readonly contexts: InProcessDispatchContextFactory;
}

/** Owner-side durable run facts and deterministic dispatch outbox for one conversation. */
export class ConversationRunJournal {
  readonly #conversationId: string;
  readonly #ownerEpoch: number;
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #submission: AssignmentSubmissionAuthorizer;
  readonly #authority: ConversationCommitAuthority;
  readonly #projection: ConversationCommitProjection;
  readonly #publisher: ConversationMutationPublisher | undefined;

  constructor(options: ConversationRunJournalOptions) {
    assertIdentifier(options.conversationId, "Conversation id");
    assertPositiveSafeInteger(options.ownerEpoch, "Owner epoch");
    this.#conversationId = options.conversationId;
    this.#ownerEpoch = options.ownerEpoch;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#submission = options.submission;
    this.#authority = options.authority;
    this.#projection = options.projection;
    this.#publisher = options.publisher;
  }

  async admit(input: {
    readonly ingressKey: string;
    readonly runId: string;
    readonly userInput: UserTurnInput;
    readonly ingress: IngressContext;
    readonly queuedPosition: number;
  }): Promise<void> {
    assertIdentifier(input.ingressKey, "Ingress key");
    assertIdentifier(input.runId, "Run id");
    if (!isNonEmptyUserTurnInput(input.userInput)) {
      throw new TypeError("Run admission requires non-empty user input");
    }
    if (!Number.isSafeInteger(input.queuedPosition) || input.queuedPosition < 0) {
      throw new TypeError("Queued position must be a non-negative safe integer");
    }
    const userInput = snapshot(input.userInput, "Run input");
    const ingress = snapshot(input.ingress, "Run ingress");
    const prepared = await prepareStored(userInput, this.#artifacts);
    const admitted: Extract<ConversationRunJournalRecord, { t: "admitted" }> = {
      t: "admitted",
      ingressKey: input.ingressKey,
      runId: input.runId,
      input: prepared.stored,
      ingress,
      queuedPosition: input.queuedPosition,
    };

    await this.#transact<void>(
      (state) => {
        const byRun = state.admittedByRun.get(input.runId);
        const ingressRun = state.runByIngress.get(input.ingressKey);
        if (byRun || ingressRun) {
          if (
            !byRun ||
            ingressRun !== input.runId ||
            canonicalize(byRun.record.ingress) !== canonicalize(ingress) ||
            canonicalize(byRun.input) !== canonicalize(userInput) ||
            byRun.record.queuedPosition !== input.queuedPosition
          ) {
            throw new Error("Run admission identity has conflicting durable payloads");
          }
          return { kind: "return", value: undefined };
        }
        for (const [runId, admitted] of state.admittedByRun) {
          if (
            state.stateByRun.get(runId)?.state === "queued" &&
            admitted.record.queuedPosition === input.queuedPosition
          ) {
            throw new Error("Queued position already belongs to an active run");
          }
        }
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, admitted),
            runRecord(this.#conversationId, {
              t: "state",
              runId: input.runId,
              state: "queued",
              statusRevision: 1,
            }),
          ],
          value: undefined,
        };
      },
      prepared.references,
    );
  }

  async assign(
    unsignedEnvelope: UnsignedConversationEnvelope,
  ): Promise<PendingConversationDispatch> {
    if (unsignedEnvelope.work.conversationId !== this.#conversationId) {
      throw new TypeError("Dispatch belongs to a different conversation journal");
    }
    if (unsignedEnvelope.work.ownerEpoch !== this.#ownerEpoch) {
      throw new TypeError("Dispatch belongs to a different owner epoch");
    }
    const envelope = createSignedConversationEnvelope(
      unsignedEnvelope,
      this.#signer,
      this.#verifier,
    );
    const currentState = await this.#read();
    const currentAssignmentId = currentState.assignmentByRun.get(
      envelope.work.runId,
    );
    const currentAssignment = currentAssignmentId
      ? currentState.assignedById.get(currentAssignmentId)
      : undefined;
    if (currentAssignment) {
      if (
        currentAssignment.record.assignmentId !== envelope.assignmentId ||
        canonicalize(withoutSignature(currentAssignment.envelope)) !==
          canonicalize(withoutSignature(envelope))
      ) {
        throw new Error("Run already has a different durable assignment");
      }
      return this.#materializeDispatch(currentAssignment);
    }
    if (currentState.assignedById.has(envelope.assignmentId)) {
      throw new Error("Assignment id already belongs to a different run");
    }
    const envelopeReferences = await assertArtifactsPresent(envelope, this.#artifacts);
    const artifact = dispatchEnvelopeArtifact(envelope);
    const stored = await this.#artifacts.put(artifact.bytes);
    if (canonicalize(stored) !== canonicalize(artifact.ref)) {
      throw new Error("Dispatch artifact store returned a different reference");
    }
    const transaction = await this.#transact<AssignDecision>(
      (state) => {
        const admitted = state.admittedByRun.get(envelope.work.runId);
        if (!admitted) throw new Error("Run must be durably admitted before assignment");
        if (canonicalize(admitted.record.ingress) !== canonicalize(envelope.work.ingress)) {
          throw new Error("Dispatch ingress does not match the admitted run");
        }
        const existingId = state.assignmentByRun.get(envelope.work.runId);
        const existing = existingId ? state.assignedById.get(existingId) : undefined;
        if (existing) {
          if (
            existing.record.assignmentId !== envelope.assignmentId ||
            canonicalize(withoutSignature(existing.envelope)) !==
              canonicalize(withoutSignature(envelope))
          ) {
            throw new Error("Run already has a different durable assignment");
          }
          return {
            kind: "return",
            value: { assignmentId: existing.record.assignmentId },
          };
        }
        if (state.assignedById.has(envelope.assignmentId)) {
          throw new Error("Assignment id already belongs to a different run");
        }
        const current = state.stateByRun.get(envelope.work.runId);
        if (current?.state !== "queued") {
          throw new Error("Only the current queued run can be assigned");
        }
        for (const [runId, runState] of state.stateByRun) {
          if (
            runId !== envelope.work.runId &&
            (runState.state === "dispatched" || runState.state === "running")
          ) {
            throw new Error("Conversation already has an active assignment");
          }
        }
        const earlierQueued = [...state.admittedByRun.entries()].some(
          ([runId, candidate]) =>
            runId !== envelope.work.runId &&
            state.stateByRun.get(runId)?.state === "queued" &&
            candidate.record.queuedPosition < admitted.record.queuedPosition,
        );
        if (earlierQueued) {
          throw new Error("Only the earliest queued run can be assigned");
        }
        const assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }> = {
          t: "assigned",
          runId: envelope.work.runId,
          assignmentId: envelope.assignmentId,
          executorId: envelope.executorId,
          manifestDigest: envelope.manifest.digest,
          dispatchRef: artifact.ref,
          permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
          capIds: envelope.capabilities.map((capability) => capability.capId),
          reservation: {
            reservationId: envelope.resourceLease.reservationId,
            attempt: envelope.resourceLease.workload.attempt,
          },
        };
        return {
          kind: "append",
          entries: [
            runRecord(this.#conversationId, assigned),
            runRecord(this.#conversationId, {
              t: "state",
              runId: envelope.work.runId,
              state: "dispatched",
              statusRevision: (current?.statusRevision ?? 0) + 1,
            }),
          ],
          value: { assignmentId: envelope.assignmentId },
        };
      },
      [artifact.ref, ...envelopeReferences],
    );
    const assigned = transaction.state.assignedById.get(transaction.value.assignmentId);
    if (!assigned) throw new Error("Assigned commit did not rebuild its outbox fact");
    return this.#materializeDispatch(assigned);
  }

  async pendingDispatches(): Promise<PendingConversationDispatch[]> {
    const state = await this.#read();
    return Promise.all(
      [...state.assignedById.values()]
        .filter(
          (assigned) =>
            !assigned.acked &&
            state.stateByRun.get(assigned.record.runId)?.state === "dispatched",
        )
        .map((assigned) => this.#materializeDispatch(assigned)),
    );
  }

  async dispatchesAwaitingStarted(): Promise<PendingConversationDispatch[]> {
    const state = await this.#read();
    return Promise.all(
      [...state.assignedById.values()]
        .filter(
          (assigned) =>
            state.stateByRun.get(assigned.record.runId)?.state === "dispatched",
        )
        .map((assigned) => this.#materializeDispatch(assigned)),
    );
  }

  async acknowledgeDispatch(assignmentId: string): Promise<void> {
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Cannot acknowledge an unknown assignment");
      if (assigned.acked) return { kind: "return", value: undefined };
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, { t: "dispatch-acked", assignmentId }),
        ],
        value: undefined,
      };
    });
  }

  async reportStarted(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<void> {
    this.#submission.authorize(ctx, "submission.reportStarted", assignmentId);
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Started report names an unknown assignment");
      const current = state.stateByRun.get(assigned.record.runId);
      if (current?.state === "running" || current?.state === "committed") {
        return { kind: "return", value: undefined };
      }
      if (current?.state !== "dispatched") {
        throw new Error("Started report is invalid for the current run state");
      }
      return {
        kind: "append",
        entries: [
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            state: "running",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  async reconcileStarted(
    assignmentId: string,
    snapshot: LedgerSnapshot,
  ): Promise<void> {
    if (
      snapshot.assignmentId !== assignmentId ||
      (snapshot.phase !== "started" &&
        snapshot.phase !== "sealed" &&
        snapshot.phase !== "acked")
    ) {
      throw new TypeError("Ledger snapshot does not prove that the assignment started");
    }
    await this.#transact<void>((state) => {
      const assigned = state.assignedById.get(assignmentId);
      if (!assigned) throw new Error("Ledger snapshot names an unknown assignment");
      const current = state.stateByRun.get(assigned.record.runId);
      if (current?.state === "running" || current?.state === "committed") {
        return { kind: "return", value: undefined };
      }
      if (current?.state !== "dispatched") {
        throw new Error("Ledger snapshot is invalid for the current run state");
      }
      return {
        kind: "append",
        entries: [
          ...(!assigned.acked
            ? [
                runRecord(this.#conversationId, {
                  t: "dispatch-acked" as const,
                  assignmentId,
                }),
              ]
            : []),
          runRecord(this.#conversationId, {
            t: "state",
            runId: assigned.record.runId,
            state: "running",
            statusRevision: current.statusRevision + 1,
          }),
        ],
        value: undefined,
      };
    });
  }

  async mirrorInteractions(
    assignmentId: string,
    entries: readonly ConversationInteractionMirrorEntry[],
    ctx: AuthorityCallContext,
  ): Promise<{ readonly mirroredUpTo: number }> {
    this.#submission.authorize(ctx, "submission.mirrorInteractions", assignmentId);
    const incoming = entries.map(validateConversationInteractionMirrorEntry);
    const transaction = await this.#transact<{ mirroredUpTo: number }>((state) => {
      if (!state.assignedById.has(assignmentId)) {
        throw new Error("Interaction mirror names an unknown assignment");
      }
      const previous = state.mirroredUpTo.get(assignmentId) ?? 0;
      const durableEntries = state.mirroredEntries.get(assignmentId);
      if (!durableEntries) {
        throw new Error("Interaction mirror projection is missing its assignment");
      }
      const seen = new Map(durableEntries);
      let lastInput = 0;
      let last = previous;
      const fresh: ConversationInteractionMirrorEntry[] = [];
      for (const entry of incoming) {
        if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0) {
          throw new Error("Interaction mirror sequence must be a positive safe integer");
        }
        if (entry.seq <= lastInput) {
          throw new Error("Interaction mirror sequence must increase");
        }
        lastInput = entry.seq;
        const durable = seen.get(entry.seq);
        if (durable) {
          if (canonicalize(durable) !== canonicalize(entry)) {
            throw new Error("Interaction mirror sequence has conflicting payloads");
          }
          continue;
        }
        if (entry.seq <= previous) {
          throw new Error("Interaction mirror watermark has no matching durable entry");
        }
        fresh.push(entry);
        seen.set(entry.seq, entry);
        last = entry.seq;
      }
      if (fresh.length === 0) {
        return { kind: "return", value: { mirroredUpTo: previous } };
      }
      const mirrorRecord: Extract<ConversationRunJournalRecord, { t: "interaction-mirror" }> = {
        t: "interaction-mirror",
        assignmentId,
        entries: fresh,
      };
      if (
        Buffer.byteLength(canonicalize(mirrorRecord), "utf8") >
        MAX_INLINE_LOGICAL_RECORD_BYTES
      ) {
        throw new TypeError("Interaction mirror batch exceeds the durable record limit");
      }
      return {
        kind: "append",
        entries: [runRecord(this.#conversationId, mirrorRecord)],
        value: { mirroredUpTo: last },
      };
    });
    return transaction.value;
  }

  async submitBundle(
    rawBundle: SealedBundle,
    ctx: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: import("@zhixing/core/contracts").AuthorityError;
      }
  > {
    let bundle: ReturnType<typeof validateConversationSealedBundle>;
    try {
      bundle = validateConversationSealedBundle(rawBundle);
    } catch (error) {
      return rejected("invalid", error instanceof Error ? error.message : "Invalid bundle", false);
    }
    this.#submission.authorize(ctx, "submission.submitBundle", bundle.assignmentId);
    let closure: ValidatedConversationBundleClosure;
    try {
      closure = await validateConversationBundleClosure(bundle, this.#artifacts);
    } catch (error) {
      if (error instanceof BundleClosureError) {
        return rejected(error.code, error.message, error.code === "missing-base");
      }
      throw error;
    }
    const { artifact, batch, references, runRecord: committedRunRecord } = closure;
    if (batch && !this.#publisher) {
      return rejected("capability-gap", "Staged mutation publisher is not configured", false);
    }

    const transaction = await this.#transact<
        | { readonly committed: true; readonly commitRevision: number }
        | {
            readonly committed: false;
            readonly error: import("@zhixing/core/contracts").AuthorityError;
          }
      >(
        (state, authorityPrefix) => {
        const assigned = state.assignedById.get(bundle.assignmentId);
        const committed = state.committedByAssignment.get(bundle.assignmentId);
        if (committed) {
          if (canonicalize(committed.bundle.ref) !== canonicalize(artifact.ref)) {
            return {
              kind: "return",
              value: rejected(
                "fence-rejected",
                "Assignment already committed another bundle",
                false,
              ),
            };
          }
          return {
            kind: "return",
            value: { committed: true, commitRevision: committed.commitRevision },
          };
        }
        if (!assigned) {
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle names an unknown assignment", false),
          };
        }
        const dispatch = assigned.envelope;
        const body = bundle.body;
        if (
          body.conversationId !== this.#conversationId ||
          body.runId !== assigned.record.runId ||
          body.ownerEpoch !== this.#ownerEpoch ||
          body.ownerEpoch !== dispatch.work.ownerEpoch ||
          body.baseRevision !== dispatch.work.baseRevision ||
          bundle.executorId !== assigned.record.executorId
        ) {
          return {
            kind: "return",
            value: rejected(
              "fence-rejected",
              "Bundle fence does not match the durable assignment",
              false,
            ),
          };
        }
        const currentRunState = state.stateByRun.get(body.runId)?.state;
        if (currentRunState !== "dispatched" && currentRunState !== "running") {
          return {
            kind: "return",
            value: rejected("fence-rejected", "Bundle is late for the current run state", false),
          };
        }
        const sessionRecords = (batch?.records ?? [])
          .filter((record) => record.domain === "session")
          .map((record) => ({
            seq: record.seq,
            mutation: record.mutation as SessionStagedMutation,
            requestId: record.requestId,
          }));
        const authorityDecision = snapshot(
          this.#authority.decideAtPrefix({
            assignmentId: bundle.assignmentId,
            authorityPrefixLsn: authorityPrefix.lastLsn,
            conversationId: this.#conversationId,
            ownerEpoch: body.ownerEpoch,
            baseRevision: body.baseRevision,
            runRecord: committedRunRecord,
            sessionMutations: sessionRecords,
          }),
          "Conversation commit authority decision",
        );
        if (!authorityDecision.committed) {
          validateAuthorityError(authorityDecision.error);
          return { kind: "return", value: authorityDecision };
        }
        const commitRevision = authorityDecision.commitRevision;
        if (
          !Number.isSafeInteger(commitRevision) ||
          commitRevision <= 0 ||
          commitRevision !== body.baseRevision + 1 ||
          commitRevision <= (state.commits.at(-1)?.commitRevision ?? 0)
        ) {
          return {
            kind: "return",
            value: rejected(
              "revision-conflict",
              "Conversation authority returned an invalid commit revision",
              false,
            ),
          };
        }
        const outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"] = [];
        if (batch) {
          const globalRecords = batch.records
            .filter((record) => record.domain === "global")
            .map((record) => ({
              seq: record.seq,
              mutation: record.mutation as GlobalStagedMutation,
              requestId: record.requestId,
              expected: record.expected!,
            }));
          const globalOutcomes =
            globalRecords.length === 0
              ? new Map<number, ReturnType<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>[number]["outcome"]>()
              : validateGlobalPublishBatchOutcomes(
                  globalRecords,
                  this.#publisher!.decideGlobalBatchAtPrefix({
                    assignmentId: bundle.assignmentId,
                    authorityPrefixLsn: authorityPrefix.lastLsn,
                    records: globalRecords,
                  }),
                );
          for (const record of batch.records) {
            if (record.domain === "session") {
              outcomes.push({
                seq: record.seq,
                outcome: { t: "granted", targetRevision: commitRevision },
              });
            } else {
              const outcome = globalOutcomes.get(record.seq);
              if (!outcome) throw new TypeError("Global publish batch omitted a mutation");
              outcomes.push({ seq: record.seq, outcome });
            }
          }
        }
        const committedRecord: Extract<ConversationRunJournalRecord, { t: "committed" }> = {
          t: "committed",
          runId: body.runId,
          assignmentId: bundle.assignmentId,
          bundle: { ref: artifact.ref },
          commitRevision,
        };
        const entries: LogicalRecord<ConversationCommitLogRecord>[] = [
          runRecord(this.#conversationId, committedRecord),
          runRecord(this.#conversationId, {
            kind: "content-asset-index",
            entries: body.contentAssets,
          }),
          runRecord(this.#conversationId, {
            t: "state",
            runId: body.runId,
            state: "committed",
            statusRevision:
              (state.stateByRun.get(body.runId)?.statusRevision ?? 0) + 1,
          }),
        ];
        if (batch && body.mutationBatch) {
          entries.push({
            stream: "publish",
            body: {
              t: "publish-decision",
              assignmentId: bundle.assignmentId,
              batch: { ref: body.mutationBatch.ref },
              sessionCount: body.mutationBatch.sessionCount,
              globalCount: body.mutationBatch.globalCount,
              outcomes,
            },
          });
          for (const domain of ["session", "global"] as const) {
            if (batch.records.some((record) => record.domain === domain)) {
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
            conversationId: this.#conversationId,
            runId: body.runId,
            commitRevision,
            digest: bundle.digest,
            state: "pending",
          },
        });
        return {
          kind: "append",
          entries,
          value: { committed: true, commitRevision },
        };
        },
        references,
      ).catch((error: unknown) => {
        if (error instanceof AuthorityStorageError && error.code === "artifact-missing") {
          return undefined;
        }
        throw error;
      });
    if (!transaction) {
      return rejected(
        "missing-base",
        "Bundle artifact disappeared before the commit point",
        true,
      );
    }
    if (transaction.value.committed) {
      await this.resumeCommittedProjections();
      if (batch) await this.resumePublishing(bundle.assignmentId);
    }
    return transaction.value;
  }

  /** Rebuild every missing post-commit projection from durable committed facts. */
  async resumeCommittedProjections(): Promise<number> {
    const state = await this.#read();
    let projected = 0;
    for (const committed of state.commits) {
      if (state.projectedByAssignment.has(committed.assignmentId)) continue;
      const bytes = await this.#artifacts.get(committed.bundle.ref);
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
      );
      const closure = await validateConversationBundleClosure(bundle, this.#artifacts);
      await this.#projection.project({
        assignmentId: committed.assignmentId,
        conversationId: this.#conversationId,
        commitRevision: committed.commitRevision,
        digest: bundle.digest,
        runRecord: closure.runRecord,
        ...(bundle.body.windowCompact ? { windowCompact: bundle.body.windowCompact } : {}),
        contentAssets: bundle.body.contentAssets,
      });
      const progress: ConversationProjectionRecord = {
        kind: "conversation-commit-projection",
        assignmentId: committed.assignmentId,
        runId: committed.runId,
        commitRevision: committed.commitRevision,
        digest: bundle.digest,
      };
      const transaction = await this.#transact<boolean>((current) => {
        const durable = current.committedByAssignment.get(committed.assignmentId);
        if (!durable) throw corruptRunJournal("Projection progress has no committed run");
        if (current.projectedByAssignment.has(committed.assignmentId)) {
          return { kind: "return", value: false };
        }
        return {
          kind: "append",
          entries: [runRecord(this.#conversationId, progress)],
          value: true,
        };
      });
      if (transaction.value) projected += 1;
    }
    return projected;
  }

  async resumePublishing(assignmentId: string): Promise<number> {
    assertIdentifier(assignmentId, "Assignment id");
    const [projection, runState] = await Promise.all([
      this.#readPublishProjection(),
      this.#read(),
    ]);
    const decision = projection.decisions.get(assignmentId);
    if (!decision) return 0;
    if (!runState.committedByAssignment.has(assignmentId)) {
      throw corruptRunJournal("Publish decision has no committed assignment");
    }
    if (!this.#publisher) {
      throw new Error("Staged mutation publisher is not configured");
    }
    const batchBytes = await this.#artifacts.get(decision.batch.ref);
    const batch = validateMutationBatch(
      JSON.parse(Buffer.from(batchBytes).toString("utf8")) as MutationBatch,
    );
    let applied = 0;
    for (const domain of ["session", "global"] as const) {
      let watermark = projection.progress.get(`${assignmentId}\0${domain}`)?.upToSeq ?? 0;
      const granted = decision.outcomes
        .filter((item) => item.outcome.t === "granted")
        .map((item) => ({
          record: batch.records.find((record) => record.seq === item.seq),
          outcome: item.outcome as Extract<typeof item.outcome, { t: "granted" }>,
        }))
        .filter((item) => item.record?.domain === domain)
        .map((item) => ({
          record: item.record as AssignmentRecordLike,
          outcome: item.outcome,
        }))
        .sort((left, right) => left.record.seq - right.record.seq);
      for (let index = 0; index < granted.length; index += 1) {
        const item = granted[index]!;
        if (item.record.seq <= watermark) continue;
        await this.#publisher.apply({
          assignmentId,
          seq: item.record.seq,
          domain,
          mutation: item.record.mutation as SessionStagedMutation | GlobalStagedMutation,
          requestId: item.record.requestId,
          targetRevision: item.outcome.targetRevision,
        });
        watermark = item.record.seq;
        const settled = index === granted.length - 1;
        await this.#appendPublishProgress({
          t: "publish-progress",
          assignmentId,
          domain,
          upToSeq: watermark,
          state: settled ? "settled" : "pending",
        });
        applied += 1;
      }
      if (granted.length === 0) {
        const domainSeqs = batch.records
          .filter((record) => record.domain === domain)
          .map((record) => record.seq);
        if (domainSeqs.length > 0 && projection.progress.get(`${assignmentId}\0${domain}`)?.state !== "settled") {
          await this.#appendPublishProgress({
            t: "publish-progress",
            assignmentId,
            domain,
            upToSeq: Math.max(...domainSeqs),
            state: "settled",
          });
        }
      }
    }
    return applied;
  }

  /** Resume every committed publish decision that is not settled, without caller memory. */
  async resumePendingPublishing(): Promise<number> {
    const [projection, runState] = await Promise.all([
      this.#readPublishProjection(),
      this.#read(),
    ]);
    let applied = 0;
    for (const committed of runState.commits) {
      const decision = projection.decisions.get(committed.assignmentId);
      if (!decision) continue;
      const pending = (["session", "global"] as const).some((domain) => {
        const count = domain === "session" ? decision.sessionCount : decision.globalCount;
        return (
          count > 0 &&
          projection.progress.get(`${committed.assignmentId}\0${domain}`)?.state !== "settled"
        );
      });
      if (pending) applied += await this.resumePublishing(committed.assignmentId);
    }
    return applied;
  }

  async pendingFinalFrames(): Promise<FinalFrame[]> {
    const [projection, runState, publishState] = await Promise.all([
      this.#readFinalOutbox(),
      this.#read(),
      this.#readPublishProjection(),
    ]);
    const assignmentByRevision = new Map(
      runState.commits.map((record) => [record.commitRevision, record.assignmentId]),
    );
    return [...projection.values()]
      .filter(
        ({ record }) =>
          record.conversationId === this.#conversationId && record.state === "pending",
      )
      .sort((left, right) => left.record.commitRevision - right.record.commitRevision)
      .map(({ record }) => {
        const assignmentId = assignmentByRevision.get(record.commitRevision);
        const conflictCount = assignmentId
          ? publishConflictCount(publishState, assignmentId)
          : 0;
        return finalFrame(record, conflictCount);
      });
  }

  async publishPendingFinals(
    publish: (frame: FinalFrame) => Promise<void>,
  ): Promise<number> {
    let published = 0;
    for (const frame of await this.pendingFinalFrames()) {
      await publish(frame);
      if (await this.#transitionFinal(frame, "pending", "published")) published += 1;
    }
    return published;
  }

  async expirePublishedFinals(now: IsoTime): Promise<number> {
    const cutoff = canonicalTime(now, "Final outbox sweep time") - FINAL_OUTBOX_RETENTION_MS;
    const projection = await this.#readFinalOutbox();
    let expired = 0;
    for (const { record, at } of [...projection.values()].sort(
      (left, right) => left.record.commitRevision - right.record.commitRevision,
    )) {
      if (
        record.conversationId !== this.#conversationId ||
        record.state !== "published" ||
        canonicalTime(at, "Final outbox record time") > cutoff
      ) {
        continue;
      }
      if (await this.#transitionFinal(finalFrame(record), "published", "expired", cutoff)) {
        expired += 1;
      }
    }
    return expired;
  }

  async statusHistory(
    runId: string,
    afterStatusRevision: number,
  ): Promise<ConversationStatusNotice[]> {
    assertIdentifier(runId, "Run id");
    assertNonNegativeSafeInteger(afterStatusRevision, "Last-seen status revision");
    const records = await this.#log.readStream<ConversationCommitLogRecord>(
      runStream(this.#conversationId),
    );
    const notices: ConversationStatusNotice[] = [];
    for (const record of records) {
      const body = record.body as ConversationRunJournalRecord;
      if (
        !("t" in body) ||
        body.t !== "state" ||
        body.runId !== runId ||
        body.statusRevision <= afterStatusRevision ||
        body.state === "committed"
      ) {
        continue;
      }
      const ref = {
        execution: "conversation" as const,
        conversationId: this.#conversationId,
        runId,
        ownerEpoch: this.#ownerEpoch,
      };
      if (body.state === "uncertain") {
        notices.push({
          v: 1,
          ref,
          state: body.state,
          statusRevision: body.statusRevision,
          actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
          at: record.at,
        });
      } else {
        notices.push({
          v: 1,
          ref,
          state: body.state,
          statusRevision: body.statusRevision,
          actions: [],
          at: record.at,
        });
      }
    }
    return notices;
  }

  async publishConflicts(assignmentId: string): Promise<PublishConflictNotice | undefined> {
    assertIdentifier(assignmentId, "Assignment id");
    const [runState, publishState] = await Promise.all([
      this.#read(),
      this.#readPublishProjection(),
    ]);
    const committed = runState.committedByAssignment.get(assignmentId);
    const decision = publishState.decisions.get(assignmentId);
    if (!committed || !decision) return undefined;
    const bytes = await this.#artifacts.get(decision.batch.ref);
    const batch = validateMutationBatch(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as MutationBatch,
    );
    if (batch.assignmentId !== assignmentId) {
      throw corruptRunJournal("Publish decision batch belongs to another assignment");
    }
    const conflicts: PublishConflictNotice["conflicts"] = [];
    for (const item of decision.outcomes) {
      if (item.outcome.t !== "conflicted") continue;
      const record = batch.records.find((candidate) => candidate.seq === item.seq);
      if (!record || record.domain !== "global") {
        throw corruptRunJournal("Publish conflict has no global staged mutation");
      }
      conflicts.push({
        seq: item.seq,
        mutation: record.mutation as GlobalStagedMutation,
        error: item.outcome.error,
      });
    }
    if (conflicts.length === 0) return undefined;
    return {
      conversationId: this.#conversationId,
      runId: committed.runId,
      commitRevision: committed.commitRevision,
      conflicts,
    };
  }

  async finalHistory(afterCommitRevision: number): Promise<CommittedConversationResult[]> {
    assertNonNegativeSafeInteger(afterCommitRevision, "Last-seen commit revision");
    const [state, publishState] = await Promise.all([
      this.#read(),
      this.#readPublishProjection(),
    ]);
    const output: CommittedConversationResult[] = [];
    for (const committed of state.commits) {
      if (committed.commitRevision <= afterCommitRevision) continue;
      const bytes = await this.#artifacts.get(committed.bundle.ref);
      const bundle = validateConversationSealedBundle(
        JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
      );
      const conflictCount = publishConflictCount(publishState, committed.assignmentId);
      output.push({
        frame: {
          v: 1,
          conversationId: this.#conversationId,
          runId: committed.runId,
          commitRevision: committed.commitRevision,
          digest: bundle.digest,
          ...(conflictCount > 0 ? { publishConflicts: conflictCount } : {}),
        },
        bundle,
      });
    }
    return output;
  }

  async currentState(runId: string): Promise<ConversationRunState | undefined> {
    return (await this.#read()).stateByRun.get(runId)?.state;
  }

  async #materializeDispatch(
    assigned: AssignedProjection,
  ): Promise<PendingConversationDispatch> {
    const bytes = await this.#artifacts.get(assigned.record.dispatchRef);
    const envelope = validateConversationEnvelope(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as PendingConversationDispatch["envelope"],
      this.#verifier,
    );
    const payload = buildConversationActivationPayload({
      envelope,
      dispatchRef: assigned.record.dispatchRef,
      commit: {
        lsn: assigned.commit.lsn,
        envelopeDigest: assigned.commit.envelopeDigest,
      },
      issuedAt: assigned.commit.at,
    });
    return {
      assignmentId: assigned.record.assignmentId,
      envelope,
      activation: signConversationActivation(payload, this.#signer),
    };
  }

  async #read(): Promise<RunProjection> {
    const transaction = await this.#log.transactProjection<
      RunProjection,
      ConversationCommitLogRecord,
      void
    >(
      emptyProjection(this.#conversationId),
      this.#reduce,
      () => ({ kind: "return", value: undefined }),
      { stream: runStream(this.#conversationId) },
    );
    return transaction.state;
  }

  readonly #reduce = async (
    state: RunProjection,
    record: LogicalRecord<ConversationCommitLogRecord>,
    envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
  ): Promise<RunProjection> => {
    if (record.stream !== runStream(this.#conversationId)) {
      throw corruptRunJournal("Run projection received a different stream");
    }
    const body = snapshot(
      record.body as ConversationRunJournalRecord | ConversationProjectionRecord,
      "Run journal record",
    );
    if ("kind" in body) {
      if (body.kind === "conversation-commit-projection") {
        assertExactRecordKeys(
          body,
          ["assignmentId", "commitRevision", "digest", "kind", "runId"],
          "Conversation commit projection",
        );
        assertIdentifier(body.assignmentId, "Projection assignment id");
        assertIdentifier(body.runId, "Projection run id");
        assertPositiveSafeInteger(body.commitRevision, "Projection commit revision");
        assertDigest(body.digest, "Projection bundle digest");
        const committed = state.committedByAssignment.get(body.assignmentId);
        if (
          !committed ||
          committed.runId !== body.runId ||
          committed.commitRevision !== body.commitRevision ||
          state.projectedByAssignment.has(body.assignmentId)
        ) {
          throw corruptRunJournal("Projection progress does not name one unprojected commit");
        }
        const bytes = await this.#artifacts.get(committed.bundle.ref);
        const bundle = validateConversationSealedBundle(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
        );
        if (bundle.digest !== body.digest) {
          throw corruptRunJournal("Projection progress digest does not match its bundle");
        }
        state.projectedByAssignment.set(body.assignmentId, body);
        return state;
      }
      if (body.kind !== "content-asset-index") {
        throw corruptRunJournal("Run journal contains an unknown internal record");
      }
      assertExactRecordKeys(body, ["entries", "kind"], "Content asset index");
      const committed = state.commits.at(-1);
      if (
        !committed ||
        state.contentByRevision.has(committed.commitRevision) ||
        !envelopeContainsCommit(envelope, this.#conversationId, committed)
      ) {
        throw corruptRunJournal("Content index has no unique committed run");
      }
      const bundleBytes = await this.#artifacts.get(committed.bundle.ref);
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
      return state;
    }
    switch (body.t) {
      case "admitted": {
        if (
          state.admittedByRun.has(body.runId) ||
          state.runByIngress.has(body.ingressKey)
        ) {
          throw corruptRunJournal("Run admission identity is duplicated");
        }
        const input = await loadStored(body.input, this.#artifacts);
        if (!isNonEmptyUserTurnInput(input)) {
          throw corruptRunJournal("Run journal contains invalid user input");
        }
        state.admittedByRun.set(body.runId, { record: body, input });
        state.runByIngress.set(body.ingressKey, body.runId);
        return state;
      }
      case "assigned": {
        const admitted = state.admittedByRun.get(body.runId);
        if (
          !admitted ||
          state.assignmentByRun.has(body.runId) ||
          state.assignedById.has(body.assignmentId)
        ) {
          throw corruptRunJournal("Run assignment has no unique admitted run");
        }
        const bytes = await this.#artifacts.get(body.dispatchRef);
        const dispatch = validateConversationEnvelope(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as PendingConversationDispatch["envelope"],
          this.#verifier,
        );
        await assertArtifactsPresent(dispatch, this.#artifacts);
        assertAssignedMatchesDispatch(body, dispatch, admitted.record.ingress);
        state.assignedById.set(body.assignmentId, {
          record: body,
          envelope: dispatch,
          commit: {
            lsn: envelope.lsn,
            envelopeDigest: envelope.envelopeDigest,
            at: envelope.at,
          },
          acked: false,
        });
        state.assignmentByRun.set(body.runId, body.assignmentId);
        state.mirroredEntries.set(body.assignmentId, new Map());
        return state;
      }
      case "dispatch-acked": {
        const assigned = state.assignedById.get(body.assignmentId);
        if (!assigned || assigned.acked) {
          throw corruptRunJournal("Dispatch acknowledgement is missing or duplicated");
        }
        assigned.acked = true;
        return state;
      }
      case "interaction-mirror": {
        if (!state.assignedById.has(body.assignmentId)) {
          throw corruptRunJournal("Interaction mirror has no assignment");
        }
        const previous = state.mirroredUpTo.get(body.assignmentId) ?? 0;
        const durableEntries = state.mirroredEntries.get(body.assignmentId);
        if (!durableEntries || body.entries.length === 0) {
          throw corruptRunJournal("Interaction mirror has no durable entries");
        }
        let last = previous;
        for (const rawEntry of body.entries) {
          const entry = validateConversationInteractionMirrorEntry(rawEntry);
          if (
            !Number.isSafeInteger(entry.seq) ||
            entry.seq <= last ||
            durableEntries.has(entry.seq)
          ) {
            throw corruptRunJournal("Interaction mirror sequence is not increasing");
          }
          durableEntries.set(entry.seq, entry);
          last = entry.seq;
        }
        state.mirroredUpTo.set(body.assignmentId, last);
        return state;
      }
      case "state": {
        if (!state.admittedByRun.has(body.runId)) {
          throw corruptRunJournal("Run state has no admitted run");
        }
        const current = state.stateByRun.get(body.runId);
        if (body.statusRevision !== (current?.statusRevision ?? 0) + 1) {
          throw corruptRunJournal("Run status revision is not contiguous");
        }
        assertRunStateTransition(current?.state, body.state);
        if (body.state === "committed") {
          const committed = state.commits.at(-1);
          if (
            !committed ||
            committed.runId !== body.runId ||
            !envelopeContainsCommit(envelope, this.#conversationId, committed)
          ) {
            throw corruptRunJournal("Committed state is not atomic with its committed run fact");
          }
        }
        state.stateByRun.set(body.runId, {
          state: body.state,
          statusRevision: body.statusRevision,
        });
        return state;
      }
      case "committed": {
        const assigned = state.assignedById.get(body.assignmentId);
        if (
          !assigned ||
          assigned.record.runId !== body.runId ||
          state.committedByAssignment.has(body.assignmentId) ||
          body.commitRevision !== assigned.envelope.work.baseRevision + 1
        ) {
          throw corruptRunJournal("Committed run does not match a unique assignment fence");
        }
        const previous = state.commits.at(-1);
        if (previous && body.commitRevision <= previous.commitRevision) {
          throw corruptRunJournal("Committed run revision does not advance authority state");
        }
        const bytes = await this.#artifacts.get(body.bundle.ref);
        const bundle = validateConversationSealedBundle(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
        );
        if (
          canonicalize(sealedBundleArtifact(bundle).ref) !== canonicalize(body.bundle.ref) ||
          bundle.assignmentId !== body.assignmentId ||
          bundle.body.runId !== body.runId ||
          bundle.body.conversationId !== this.#conversationId ||
          bundle.body.baseRevision + 1 !== body.commitRevision
        ) {
          throw corruptRunJournal("Committed bundle does not bind its run journal fact");
        }
        try {
          await validateConversationBundleClosure(bundle, this.#artifacts);
        } catch (error) {
          throw corruptRunJournal(
            error instanceof Error
              ? `Committed bundle closure is invalid: ${error.message}`
              : "Committed bundle closure is invalid",
          );
        }
        state.committedByAssignment.set(body.assignmentId, body);
        state.commits.push(body);
        return state;
      }
    }
  };

  async #transact<Value>(
    decide: (
      state: RunProjection,
      authorityPrefix: { readonly lastLsn: number; readonly nextLsn: number },
    ) => ProjectionTransactionDecision<ConversationCommitLogRecord, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    return this.#log.transactProjection<
      RunProjection,
      ConversationCommitLogRecord,
      Value
    >(emptyProjection(this.#conversationId), this.#reduce, decide, {
      stream: runStream(this.#conversationId),
      candidateReferences,
    });
  }

  async #appendPublishProgress(progress: Extract<PublishRecord, { t: "publish-progress" }>) {
    await this.#log.transactProjection<PublishProjection, PublishRecord, void>(
      emptyPublishProjection(),
      (state, record, envelope) =>
        reducePublishRecord(state, record, envelope, this.#artifacts),
      (state) => {
        const key = `${progress.assignmentId}\0${progress.domain}`;
        const current = state.progress.get(key);
        if (
          current &&
          (current.upToSeq > progress.upToSeq ||
            current.state === "settled" ||
            (current.upToSeq === progress.upToSeq && current.state === progress.state))
        ) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [{ stream: "publish", body: progress }],
          value: undefined,
        };
      },
      { stream: "publish" },
    );
  }

  async #readPublishProjection(): Promise<PublishProjection> {
    const state = emptyPublishProjection();
    for (const envelope of await this.#log.readAll<ConversationCommitLogRecord>()) {
      for (const entry of envelope.entries) {
        if (entry.stream === "publish") {
          await reducePublishRecord(
            state,
            entry as LogicalRecord<PublishRecord>,
            envelope,
            this.#artifacts,
          );
        }
      }
    }
    return state;
  }

  async #readFinalOutbox(): Promise<FinalOutboxProjection> {
    const projection: FinalOutboxProjection = new Map();
    for (const envelope of await this.#log.readAll<ConversationCommitLogRecord>()) {
      for (const entry of envelope.entries) {
        if (entry.stream === "final-outbox") {
          await applyFinalRecord(
            projection,
            entry.body as FinalOutboxRecord,
            envelope.at,
            envelope,
            this.#artifacts,
          );
        }
      }
    }
    return projection;
  }

  async #transitionFinal(
    frame: FinalFrame,
    expectedState: "pending" | "published",
    state: "published" | "expired",
    notAfter?: number,
  ): Promise<boolean> {
    const key = finalKey(frame);
    const result = await this.#log.transactProjection<
      FinalOutboxProjection,
      FinalOutboxRecord,
      boolean
    >(
      new Map(),
      async (projection, record, envelope) => {
        await applyFinalRecord(
          projection,
          record.body,
          envelope.at,
          envelope,
          this.#artifacts,
        );
        return projection;
      },
      (projection) => {
        const current = projection.get(key);
        if (
          !current ||
          current.record.state !== expectedState ||
          current.record.digest !== frame.digest ||
          (notAfter !== undefined &&
            canonicalTime(current.at, "Final outbox record time") > notAfter)
        ) {
          return { kind: "return", value: false };
        }
        return {
          kind: "append",
          entries: [
            { stream: "final-outbox", body: { ...current.record, state } },
          ],
          value: true,
        };
      },
      { stream: "final-outbox" },
    );
    return result.value;
  }
}

/** Explicitly gated single-process transport; disabled means zero dispatch side effects. */
export class InProcessConversationDispatcher {
  readonly #enabled: boolean;
  readonly #journal: ConversationRunJournal;
  readonly #executor: ConversationDispatchPort;
  readonly #contexts: InProcessDispatchContextFactory;

  constructor(options: InProcessConversationDispatcherOptions) {
    this.#enabled = options.enabled;
    this.#journal = options.journal;
    this.#executor = options.executor;
    this.#contexts = options.contexts;
  }

  async dispatchPending(): Promise<readonly DispatchResult[]> {
    if (!this.#enabled) return [];
    const pending = await this.#journal.pendingDispatches();
    const outcomes: DispatchResult[] = [];
    for (const item of pending) {
      const outcome = await this.#executor.dispatch(
        item.envelope,
        item.activation,
        this.#contexts.create(item.assignmentId, "executor.dispatch"),
      );
      outcomes.push(outcome);
      if (outcome.accepted) {
        await this.#journal.acknowledgeDispatch(item.assignmentId);
      }
    }
    return outcomes;
  }

  async recoverStarted(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.dispatchesAwaitingStarted();
    let recovered = 0;
    for (const item of pending) {
      const snapshot = (await this.#executor.queryLedger(
        item.assignmentId,
        this.#contexts.create(item.assignmentId, "executor.queryLedger"),
      )) as LedgerSnapshot;
      if (
        snapshot.phase === "started" ||
        snapshot.phase === "sealed" ||
        snapshot.phase === "acked"
      ) {
        await this.#journal.reconcileStarted(item.assignmentId, snapshot);
        recovered += 1;
      }
    }
    return recovered;
  }
}

function emptyProjection(conversationId: string): RunProjection {
  return {
    conversationId,
    admittedByRun: new Map(),
    runByIngress: new Map(),
    assignedById: new Map(),
    assignmentByRun: new Map(),
    stateByRun: new Map(),
    mirroredUpTo: new Map(),
    mirroredEntries: new Map(),
    committedByAssignment: new Map(),
    commits: [],
    contentByRevision: new Map(),
    projectedByAssignment: new Map(),
  };
}

function runRecord(
  conversationId: string,
  body: ConversationRunJournalRecord | ConversationProjectionRecord,
): LogicalRecord<ConversationCommitLogRecord> {
  return { stream: runStream(conversationId), body };
}

function runStream(conversationId: string): string {
  return `run:${conversationId}`;
}

interface ValidatedConversationBundleClosure {
  readonly artifact: ReturnType<typeof sealedBundleArtifact>;
  readonly batch?: MutationBatch;
  readonly runRecord: TranscriptRunRecord;
  readonly references: ArtifactRef[];
}

class BundleClosureError extends Error {
  constructor(
    readonly code: "invalid" | "missing-base",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BundleClosureError";
  }
}

async function validateConversationBundleClosure(
  bundle: ReturnType<typeof validateConversationSealedBundle>,
  artifacts: ArtifactStore,
): Promise<ValidatedConversationBundleClosure> {
  const artifact = sealedBundleArtifact(bundle);
  if (!(await artifacts.has(artifact.ref))) {
    throw new BundleClosureError("missing-base", "Sealed bundle artifact is not present");
  }
  const roots = conversationBundleRoots(bundle.body);
  const references = [artifact.ref, ...roots, ...bundle.dependencyArtifacts];
  for (const ref of references) {
    if (!(await artifacts.has(ref))) {
      throw new BundleClosureError(
        "missing-base",
        `Bundle artifact is not present: ${ref.digest}`,
      );
    }
  }

  const runRecordDependencies: ArtifactRef[] = [];
  let runRecord: TranscriptRunRecord;
  if (isStoredReference(bundle.body.runRecord)) {
    try {
      const bytes = await artifacts.get(bundle.body.runRecord.ref);
      const text = Buffer.from(bytes).toString("utf8");
      runRecord = validateTranscriptRunRecord(
        JSON.parse(text) as import("@zhixing/core/contracts").TranscriptRunRecord,
        bundle.body.runId,
      );
      if (canonicalize(runRecord) !== text) {
        throw new TypeError("Transcript run record artifact is not canonical");
      }
      runRecordDependencies.push(...collectArtifactRefs(runRecord));
    } catch (error) {
      throw bundleClosureReadError(error, "Invalid transcript run record");
    }
  } else {
    runRecord = validateTranscriptRunRecord(bundle.body.runRecord, bundle.body.runId);
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
    const sessionCount = batch.records.filter((record) => record.domain === "session").length;
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

  const expectedDependencies = collectArtifactRefs([
    runRecordDependencies,
    ...(batch ? [batch] : []),
  ]).filter((ref) => !roots.some((root) => root.digest === ref.digest));
  if (canonicalize(expectedDependencies) !== canonicalize(bundle.dependencyArtifacts)) {
    throw new BundleClosureError(
      "invalid",
      "Bundle dependency artifacts do not match the registered root closure",
    );
  }
  return { artifact, ...(batch ? { batch } : {}), runRecord, references };
}

function bundleClosureReadError(error: unknown, message: string): BundleClosureError {
  return error instanceof AuthorityStorageError && error.code === "artifact-missing"
    ? new BundleClosureError("missing-base", `${message}: artifact is not present`, {
        cause: error,
      })
    : new BundleClosureError(
        "invalid",
        error instanceof Error ? `${message}: ${error.message}` : message,
        { cause: error },
      );
}

function envelopeContainsCommit(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationCommitLogRecord>,
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

interface CommittedBundleBinding {
  readonly committed: Extract<ConversationRunJournalRecord, { t: "committed" }>;
  readonly bundle: ReturnType<typeof validateConversationSealedBundle>;
  readonly closure: ValidatedConversationBundleClosure;
}

async function loadCommittedBundleBinding(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
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
  assertExactRecordKeys(
    committed,
    ["assignmentId", "bundle", "commitRevision", "runId", "t"],
    "Committed run sidecar binding",
  );
  assertIdentifier(committed.assignmentId, "Committed assignment id");
  assertIdentifier(committed.runId, "Committed run id");
  assertPositiveSafeInteger(committed.commitRevision, "Committed revision");
  assertExactRecordKeys(committed.bundle, ["ref"], "Committed bundle reference");
  assertArtifactReference(committed.bundle.ref, "Committed bundle reference");
  const bytes = await artifacts.get(committed.bundle.ref);
  const bundle = validateConversationSealedBundle(
    JSON.parse(Buffer.from(bytes).toString("utf8")) as SealedBundle,
  );
  const closure = await validateConversationBundleClosure(bundle, artifacts);
  if (
    stream !== runStream(bundle.body.conversationId) ||
    bundle.assignmentId !== committed.assignmentId ||
    bundle.body.runId !== committed.runId ||
    bundle.body.baseRevision + 1 !== committed.commitRevision ||
    canonicalize(closure.artifact.ref) !== canonicalize(committed.bundle.ref)
  ) {
    throw corruptRunJournal("Committed run sidecar binding does not match its bundle");
  }
  return { committed, bundle, closure };
}

async function prepareStored<T>(
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

async function loadStored<T>(stored: Stored<T>, artifacts: ArtifactStore): Promise<T> {
  if (isStoredReference(stored)) {
    return JSON.parse(Buffer.from(await artifacts.get(stored.ref)).toString("utf8")) as T;
  }
  return snapshot(stored, "Inline run journal value");
}

async function assertArtifactsPresent(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<ArtifactRef[]> {
  const references = collectArtifactRefs(value);
  for (const ref of references) {
    if (!(await artifacts.has(ref))) {
      throw new TypeError(`Dispatch dependency is not present: ${ref.digest}`);
    }
  }
  return references;
}

function isStoredReference<T>(value: Stored<T>): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

function assertAssignedMatchesDispatch(
  assigned: Extract<ConversationRunJournalRecord, { t: "assigned" }>,
  dispatch: PendingConversationDispatch["envelope"],
  ingress: IngressContext,
): void {
  const artifact = dispatchEnvelopeArtifact(dispatch);
  if (
    assigned.runId !== dispatch.work.runId ||
    assigned.assignmentId !== dispatch.assignmentId ||
    assigned.executorId !== dispatch.executorId ||
    assigned.manifestDigest !== dispatch.manifest.digest ||
    canonicalize(assigned.dispatchRef) !== canonicalize(artifact.ref) ||
    assigned.permissionLeaseDigest !== permissionSnapshotLeaseDigest(dispatch) ||
    assigned.capIds.join("\u0000") !==
      dispatch.capabilities.map((capability) => capability.capId).join("\u0000") ||
    assigned.reservation.reservationId !== dispatch.resourceLease.reservationId ||
    assigned.reservation.attempt !== dispatch.resourceLease.workload.attempt ||
    canonicalize(ingress) !== canonicalize(dispatch.work.ingress)
  ) {
    throw corruptRunJournal("Assigned record does not match its dispatch artifact");
  }
}

function assertRunStateTransition(
  current: ConversationRunState | undefined,
  next: ConversationRunState,
): void {
  if (
    (current === undefined && next === "queued") ||
    (current === "queued" && next === "dispatched") ||
    (current === "dispatched" && next === "running") ||
    (current === "dispatched" && next === "committed") ||
    (current === "running" && next === "committed")
  ) {
    return;
  }
  throw corruptRunJournal(`Run state transition ${current ?? "none"} -> ${next} is invalid`);
}

function withoutSignature<T extends { signature: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return payload;
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function canonicalTime(value: IsoTime, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corruptRunJournal(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw corruptRunJournal(`${label} must be a plain object`);
  }
}

function assertExactRecordKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertPlainRecord(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw corruptRunJournal(`${label} fields are incomplete or unknown`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw corruptRunJournal(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertArtifactReference(value: unknown, label: string): void {
  assertExactRecordKeys(value, ["bytes", "digest"], label);
  assertDigest(value.digest, `${label} digest`);
  assertNonNegativeSafeInteger(value.bytes as number, `${label} byte count`);
}

function validateAuthorityError(value: unknown): void {
  assertExactRecordKeys(value, ["code", "message", "retryable"], "Authority error");
  const codes = new Set([
    "unauthorized",
    "capability-expired",
    "epoch-stale",
    "revision-conflict",
    "fence-rejected",
    "busy",
    "not-found",
    "invalid",
    "lease-exhausted",
    "missing-base",
    "typed-stale",
    "capability-gap",
    "unavailable-offline",
    "idempotency-conflict",
  ]);
  if (
    !codes.has(String(value.code)) ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    throw corruptRunJournal("Authority error value is invalid");
  }
}

type GlobalPublishBatch = ReturnType<
  ConversationMutationPublisher["decideGlobalBatchAtPrefix"]
>;
type GlobalPublishOutcome = GlobalPublishBatch[number]["outcome"];

function validateGlobalPublishBatchOutcomes(
  records: readonly { readonly seq: number }[],
  value: GlobalPublishBatch,
): Map<number, GlobalPublishOutcome> {
  if (!Array.isArray(value) || value.length !== records.length) {
    throw new TypeError("Global publish batch must decide every mutation exactly once");
  }
  const outcomes = new Map<number, GlobalPublishOutcome>();
  for (let index = 0; index < value.length; index += 1) {
    const item = snapshot(value[index], "Global publish batch outcome");
    assertExactRecordKeys(item, ["outcome", "seq"], "Global publish batch outcome");
    if (item.seq !== records[index]?.seq || outcomes.has(item.seq as number)) {
      throw new TypeError("Global publish batch sequence is incomplete, reordered, or duplicated");
    }
    outcomes.set(
      item.seq as number,
      validateGlobalPublishOutcome(item.outcome as GlobalPublishOutcome),
    );
  }
  return outcomes;
}

function validateGlobalPublishOutcome(value: GlobalPublishOutcome): GlobalPublishOutcome {
  const outcome = snapshot(value, "Global publish outcome");
  assertPlainRecord(outcome, "Global publish outcome");
  if (outcome.t === "granted") {
    assertExactRecordKeys(outcome, ["t", "targetRevision"], "Granted publish outcome");
    assertPositiveSafeInteger(outcome.targetRevision as number, "Granted target revision");
    return outcome as GlobalPublishOutcome;
  }
  if (outcome.t === "conflicted") {
    assertExactRecordKeys(outcome, ["error", "t"], "Conflicted publish outcome");
    validateAuthorityError(outcome.error);
    return outcome as GlobalPublishOutcome;
  }
  throw new TypeError("Global publish outcome kind is invalid");
}

function corruptRunJournal(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function rejected(
  code: import("@zhixing/core/contracts").AuthorityError["code"],
  message: string,
  retryable: boolean,
): {
  readonly committed: false;
  readonly error: import("@zhixing/core/contracts").AuthorityError;
} {
  return { committed: false, error: { code, message, retryable } };
}

function emptyPublishProjection(): PublishProjection {
  return {
    decisions: new Map(),
    batches: new Map(),
    commitRevisions: new Map(),
    progress: new Map(),
  };
}

async function reducePublishRecord(
  state: PublishProjection,
  record: LogicalRecord<PublishRecord>,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  artifacts: ArtifactStore,
): Promise<PublishProjection> {
  if (record.body.t === "publish-decision") {
    const binding = await loadCommittedBundleBinding(
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
      throw corruptRunJournal("Publish decision does not bind its committed mutation batch");
    }
    state.batches.set(record.body.assignmentId, binding.closure.batch);
    state.commitRevisions.set(record.body.assignmentId, binding.committed.commitRevision);
  }
  reducePublishBody(state, record.body, envelope);
  return state;
}

function reducePublishBody(
  state: PublishProjection,
  raw: PublishRecord,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
): void {
  const body = snapshot(raw, "Publish record");
  assertPlainRecord(body, "Publish record");
  if (body.t === "publish-decision") {
    assertExactRecordKeys(
      body,
      ["assignmentId", "batch", "globalCount", "outcomes", "sessionCount", "t"],
      "Publish decision",
    );
    assertIdentifier(body.assignmentId, "Publish assignment id");
    assertPlainRecord(body.batch, "Publish mutation batch");
    assertArtifactReference(body.batch.ref, "Publish mutation batch");
    assertNonNegativeSafeInteger(body.sessionCount, "Publish session count");
    assertNonNegativeSafeInteger(body.globalCount, "Publish global count");
    if (!Array.isArray(body.outcomes)) {
      throw corruptRunJournal("Publish decision outcomes must be an array");
    }
    for (const item of body.outcomes) {
      assertExactRecordKeys(item, ["outcome", "seq"], "Publish outcome");
      assertPositiveSafeInteger(item.seq, "Publish outcome sequence");
      assertPlainRecord(item.outcome, "Publish outcome value");
      if (item.outcome.t === "granted") {
        assertExactRecordKeys(item.outcome, ["t", "targetRevision"], "Granted outcome");
        assertPositiveSafeInteger(item.outcome.targetRevision, "Granted target revision");
      } else if (item.outcome.t === "conflicted") {
        assertExactRecordKeys(item.outcome, ["error", "t"], "Conflicted outcome");
        validateAuthorityError(item.outcome.error);
      } else {
        throw corruptRunJournal("Publish outcome kind is invalid");
      }
    }
    if (state.decisions.has(body.assignmentId)) {
      throw corruptRunJournal("Publish decision is duplicated");
    }
    const batch = state.batches.get(body.assignmentId);
    if (!batch || batch.assignmentId !== body.assignmentId) {
      throw corruptRunJournal("Publish decision has no validated mutation batch");
    }
    if (
      body.outcomes.length !== body.sessionCount + body.globalCount ||
      body.outcomes.some((item, index) => item.seq !== index + 1)
    ) {
      throw corruptRunJournal("Publish decision outcomes do not cover the mutation batch");
    }
    for (const [index, item] of body.outcomes.entries()) {
      const mutation = batch.records[index];
      if (!mutation || mutation.seq !== item.seq) {
        throw corruptRunJournal("Publish decision sequence does not match its mutation batch");
      }
      if (
        mutation.domain === "session" &&
        (item.outcome.t !== "granted" ||
          item.outcome.targetRevision !== state.commitRevisions.get(body.assignmentId))
      ) {
        throw corruptRunJournal("Session mutation decision does not match its conversation commit");
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
      throw corruptRunJournal("Publish decision is not atomic with its committed run fact");
    }
    state.decisions.set(body.assignmentId, body);
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
  const batch = state.batches.get(body.assignmentId);
  if (!batch) throw corruptRunJournal("Publish progress has no validated mutation batch");
  const domainRecords = batch.records.filter((record) => record.domain === body.domain);
  const grantedSeqs = decision.outcomes
    .filter(
      (item) =>
        item.outcome.t === "granted" &&
        domainRecords.some((record) => record.seq === item.seq),
    )
    .map((item) => item.seq);
  const terminalSeq =
    grantedSeqs.length > 0
      ? Math.max(...grantedSeqs)
      : Math.max(...domainRecords.map((record) => record.seq));
  const key = `${body.assignmentId}\0${body.domain}`;
  const current = state.progress.get(key);
  const nextGrantedSeq = grantedSeqs.find((seq) => seq > (current?.upToSeq ?? 0));
  const validProgress =
    (body.upToSeq === 0 && body.state === "pending" && !current) ||
    (current?.state === "pending" &&
      nextGrantedSeq !== undefined &&
      body.upToSeq === nextGrantedSeq &&
      body.state === (body.upToSeq === terminalSeq ? "settled" : "pending")) ||
    (current?.state === "pending" &&
      grantedSeqs.length === 0 &&
      body.upToSeq === terminalSeq &&
      body.state === "settled");
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
}

function finalKey(value: Pick<FinalFrame, "conversationId" | "runId" | "commitRevision">): string {
  return `${value.conversationId}\0${value.runId}\0${value.commitRevision}`;
}

function finalFrame(record: FinalOutboxRecord, publishConflicts = 0): FinalFrame {
  return {
    v: 1,
    conversationId: record.conversationId,
    runId: record.runId,
    commitRevision: record.commitRevision,
    digest: record.digest,
    ...(publishConflicts > 0 ? { publishConflicts } : {}),
  };
}

async function applyFinalRecord(
  projection: FinalOutboxProjection,
  raw: FinalOutboxRecord,
  at: IsoTime,
  envelope: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  artifacts: ArtifactStore,
): Promise<void> {
  const body = snapshot(raw, "Final outbox record");
  assertExactRecordKeys(
    body,
    ["commitRevision", "conversationId", "digest", "runId", "state", "t"],
    "Final outbox record",
  );
  if (body.t !== "final") throw corruptRunJournal("Final outbox record kind is invalid");
  assertIdentifier(body.conversationId, "Final conversation id");
  assertIdentifier(body.runId, "Final run id");
  assertPositiveSafeInteger(body.commitRevision, "Final commit revision");
  assertDigest(body.digest, "Final bundle digest");
  if (body.state !== "pending" && body.state !== "published" && body.state !== "expired") {
    throw corruptRunJournal("Final outbox state is invalid");
  }
  canonicalTime(at, "Final outbox record time");
  const key = finalKey(body);
  const current = projection.get(key);
  if (!current) {
    if (body.state !== "pending") {
      throw corruptRunJournal("Final outbox must begin pending");
    }
    const binding = await loadCommittedBundleBinding(
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
    projection.set(key, { record: body, at });
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
  projection.set(key, { record: body, at });
}

function publishConflictCount(state: PublishProjection, assignmentId: string): number {
  return (
    state.decisions
      .get(assignmentId)
      ?.outcomes.filter((item) => item.outcome.t === "conflicted").length ?? 0
  );
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}
