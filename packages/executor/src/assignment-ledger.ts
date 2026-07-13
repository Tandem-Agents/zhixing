import { Buffer } from "node:buffer";
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
  AssignmentActivationPayload,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AuthorityCallContext,
  AuthorityError,
  DispatchConflictProof,
  DispatchRejectionProof,
  DispatchResult,
  LedgerEvidencePage,
  LedgerSnapshot,
  LogicalRecord,
} from "@zhixing/core/contracts";
import {
  advanceAssignmentLedger,
  assignmentActivationDigest,
  assignmentLedgerSeed,
  canonicalize,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  validateConversationInteractionMirrorEntry,
  validateConversationInteractionOutcome,
  validateConversationActivation,
  validateConversationEnvelope,
  type ConversationInteractionMirrorEntry,
  type ConversationInteractionOutcome,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";

type ConversationEnvelope = Extract<
  import("@zhixing/core/contracts").DispatchEnvelope,
  { execution: "conversation" }
>;

export type ConversationDispatchPort = {
  dispatch(
    envelope: ConversationEnvelope,
    activation: AssignmentActivationProof<"conversation">,
    ctx: AuthorityCallContext,
  ): Promise<DispatchResult>;
  queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage>;
};

export interface OwnerControlAuthorizer {
  authorize(
    context: AuthorityCallContext,
    method: "executor.dispatch" | "executor.queryLedger",
    assignmentId: string,
  ): void;
}

export interface AssignmentLedgerOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly ownerControl: OwnerControlAuthorizer;
  readonly clock?: () => string;
  readonly maxPendingInteractions?: number;
}

export interface ConversationSubmissionPort {
  reportStarted(assignmentId: string, ctx: AuthorityCallContext): Promise<void>;
  mirrorInteractions(
    assignmentId: string,
    entries: readonly ConversationInteractionMirrorEntry[],
    ctx: AuthorityCallContext,
  ): Promise<{ readonly mirroredUpTo: number }>;
}

export interface InProcessAssignmentSubmissionOptions {
  readonly ledger: ConversationAssignmentLedger;
  readonly owner: ConversationSubmissionPort;
}

export interface InteractionRequestInput {
  readonly requestId: string;
  readonly toolName: string;
  readonly display: { readonly title: string; readonly lines: readonly string[] };
  readonly issuedAt: string;
  readonly ttlMs: number;
  readonly expiresAt: string;
}

export type InteractionOutcome = ConversationInteractionOutcome;

export interface InteractionRecoveryResult {
  readonly pending: ReadonlyArray<
    Extract<AssignmentRecord, { t: "interaction-requested" }>
  >;
  readonly resolved: readonly ConversationInteractionMirrorEntry[];
}

interface FinishedInteraction {
  readonly body: Extract<AssignmentRecord, { t: "interaction-finished" }>;
  readonly recordSeq: number;
  readonly at: string;
}

interface LedgerProjection {
  readonly assignmentId: string;
  lastSeq: number;
  chainDigest: string;
  phase: LedgerSnapshot["phase"];
  sealed?: Extract<AssignmentRecord, { t: "bundle_sealed" }>;
  received?: {
    readonly body: Extract<AssignmentRecord, { t: "received" }>;
    readonly recordSeq: number;
    readonly ledgerDigest: string;
  };
  rejection?: {
    readonly body: Extract<AssignmentRecord, { t: "dispatch-rejected" }>;
    readonly recordSeq: number;
    readonly ledgerDigest: string;
  };
  readonly entries: AssignmentEntry[];
  readonly ledgerBySeq: string[];
  readonly requested: Map<
    string,
    Extract<AssignmentRecord, { t: "interaction-requested" }>
  >;
  readonly finished: Map<string, FinishedInteraction>;
  mirroredUpTo: number;
}

type DispatchDecision =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "rejected";
      readonly dispatchDigest: string;
      readonly error: AuthorityError;
      readonly recordSeq: number;
      readonly ledgerDigest: string;
    }
  | {
      readonly kind: "conflict";
      readonly received: NonNullable<LedgerProjection["received"]>;
    };

const MAX_LEDGER_PAGE = 256;
const DEFAULT_MAX_PENDING_INTERACTIONS = 32;
const MAX_WIDTH_CANONICAL_TIME = "+275760-09-13T00:00:00.000Z";

/** Durable executor-side conversation assignment protocol; it has no listener or topology side effects. */
export class ConversationAssignmentLedger implements ConversationDispatchPort {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #ownerControl: OwnerControlAuthorizer;
  readonly #clock: () => string;
  readonly #maxPendingInteractions: number;

  constructor(options: AssignmentLedgerOptions) {
    assertIdentifier(options.executorId, "Executor id");
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#ownerControl = options.ownerControl;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#maxPendingInteractions =
      options.maxPendingInteractions ?? DEFAULT_MAX_PENDING_INTERACTIONS;
    if (
      !Number.isSafeInteger(this.#maxPendingInteractions) ||
      this.#maxPendingInteractions <= 0
    ) {
      throw new TypeError("Maximum pending interactions must be a positive safe integer");
    }
  }

  async dispatch(
    rawEnvelope: ConversationEnvelope,
    rawActivation: AssignmentActivationProof<"conversation">,
    ctx: AuthorityCallContext,
  ): Promise<DispatchResult> {
    const assignmentId = assertDispatchIdentity(rawEnvelope, this.#executorId);
    this.#ownerControl.authorize(ctx, "executor.dispatch", assignmentId);
    const artifact = dispatchEnvelopeArtifact(rawEnvelope);
    const dispatchDigest = dispatchEnvelopeDigest(rawEnvelope);

    let envelope: ConversationEnvelope;
    let envelopeReferences: ArtifactRef[];
    let activation: AssignmentActivationProof<"conversation">;
    let activationPayload: AssignmentActivationPayload<"conversation">;
    try {
      envelope = validateConversationEnvelope(rawEnvelope, this.#verifier);
      if (
        (await this.#artifacts.put(artifact.bytes)).digest !== artifact.ref.digest
      ) {
        throw new TypeError("Dispatch artifact store returned a different digest");
      }
      envelopeReferences = await this.#assertEnvelopeArtifactsPresent(envelope);
      activation = snapshot(rawActivation, "Assignment activation proof");
      activationPayload = validateConversationActivation({
        envelope,
        activation,
        dispatchRef: artifact.ref,
        verifier: this.#verifier,
      });
    } catch (error) {
      const authorityError = invalidDispatchError(error);
      return this.#rejectBeforeReceived(
        assignmentId,
        dispatchDigest,
        authorityError,
      );
    }

    const transaction = await this.#transact<DispatchDecision>(
      assignmentId,
      (state) => {
        if (state.rejection) {
          return {
            kind: "return",
            value: {
              kind: "rejected",
              dispatchDigest: state.rejection.body.dispatchDigest,
              error: state.rejection.body.reason,
              recordSeq: state.rejection.recordSeq,
              ledgerDigest: state.rejection.ledgerDigest,
            },
          };
        }
        if (state.received) {
          const acceptedPayload = withoutSignature(state.received.body.activation);
          return canonicalize(acceptedPayload) === canonicalize(activationPayload)
            ? { kind: "return", value: { kind: "accepted" } }
            : {
                kind: "return",
                value: { kind: "conflict", received: state.received },
              };
        }
        const entry = nextEntry(state, {
          v: 1,
          t: "received",
          envelope: { ref: artifact.ref },
          activation: activation as AssignmentActivationProof,
        });
        return {
          kind: "append",
          entries: [assignmentRecord(assignmentId, entry)],
          value: { kind: "accepted" },
        };
      },
      [artifact.ref, ...envelopeReferences],
    );

    if (transaction.value.kind === "accepted") {
      return { v: 1, accepted: true };
    }
    if (transaction.value.kind === "rejected") {
      return this.#rejectionResult(
        assignmentId,
        transaction.value.dispatchDigest,
        transaction.value.error,
        transaction.value.recordSeq,
        transaction.value.ledgerDigest,
      );
    }
    return this.#conflictResult(
      assignmentId,
      artifact.ref,
      activationPayload,
      transaction.value.received,
    );
  }

  async queryLedger(
    assignmentId: string,
    ctx: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    assertIdentifier(assignmentId, "Assignment id");
    this.#ownerControl.authorize(ctx, "executor.queryLedger", assignmentId);
    const state = await this.#read(assignmentId);
    if (!range) return ledgerSnapshot(state);
    if (
      !Number.isSafeInteger(range.fromSeq) ||
      range.fromSeq <= 0 ||
      !Number.isSafeInteger(range.limit) ||
      range.limit <= 0 ||
      range.limit > MAX_LEDGER_PAGE
    ) {
      throw new RangeError(`Ledger evidence range must be within 1..${MAX_LEDGER_PAGE}`);
    }
    const entries = state.entries.slice(
      range.fromSeq - 1,
      range.fromSeq - 1 + range.limit,
    );
    if (entries.length === 0) {
      throw new RangeError("Ledger evidence range starts beyond the durable ledger");
    }
    const payload = {
      v: 1 as const,
      assignmentId,
      fromSeq: entries[0]!.recordSeq,
      toSeq: entries.at(-1)!.recordSeq,
      entries: snapshot(entries, "Ledger evidence entries"),
      chainDigest: state.ledgerBySeq[entries.at(-1)!.recordSeq - 1]!,
      executorId: this.#executorId,
    };
    return snapshot(
      {
        ...payload,
        signature: this.#signer.sign("LedgerEvidencePage", 1, payload),
      },
      "Ledger evidence page",
    );
  }

  async start(assignmentId: string): Promise<{ readonly started: boolean }> {
    const transaction = await this.#transact<{ started: boolean }>(
      assignmentId,
      (state) => {
        if (state.phase === "received") {
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, nextEntry(state, { v: 1, t: "started" }))],
            value: { started: true },
          };
        }
        if (
          state.phase === "started" ||
          state.phase === "sealed" ||
          state.phase === "acked"
        ) {
          return { kind: "return", value: { started: false } };
        }
        throw new Error("Assignment cannot start before a durable received record");
      },
    );
    return transaction.value;
  }

  async requestInteraction(
    assignmentId: string,
    input: InteractionRequestInput,
  ): Promise<{ readonly recordSeq: number }> {
    const body = interactionRequested(input);
    const transaction = await this.#transact<{ recordSeq: number }>(
      assignmentId,
      (state) => {
        const existing = state.requested.get(body.requestId);
        if (existing) {
          if (canonicalize(existing) !== canonicalize(body)) {
            throw new Error("Interaction requestId has conflicting durable payloads");
          }
          const record = state.entries.find(
            (entry) =>
              entry.body.t === "interaction-requested" &&
              entry.body.requestId === body.requestId,
          )!;
          return { kind: "return", value: { recordSeq: record.recordSeq } };
        }
        if (state.phase !== "started") {
          throw new Error("Interactions can only be requested by a started assignment");
        }
        const entry = nextEntry(state, body);
        const pendingCount = [...state.requested.keys()].filter(
          (requestId) => !state.finished.has(requestId),
        ).length;
        const entries = [entry];
        if (pendingCount >= this.#maxPendingInteractions) {
          entries.push({
            recordSeq: entry.recordSeq + 1,
            body: {
              v: 1,
              t: "interaction-finished",
              requestId: body.requestId,
              kind: "allow-once",
              outcome: { t: "cancelled", via: "backpressure" },
            },
          });
        }
        return {
          kind: "append",
          entries: entries.map((item) => assignmentRecord(assignmentId, item)),
          value: { recordSeq: entry.recordSeq },
        };
      },
    );
    return transaction.value;
  }

  async finishInteraction(
    assignmentId: string,
    requestId: string,
    outcome: InteractionOutcome,
  ): Promise<ConversationInteractionMirrorEntry> {
    assertIdentifier(requestId, "Interaction requestId");
    const validatedOutcome = validateConversationInteractionOutcome(outcome);
    const body = snapshot(
      {
        v: 1 as const,
        t: "interaction-finished" as const,
        requestId,
        kind: "allow-once" as const,
        outcome: validatedOutcome,
      },
      "Interaction result",
    );
    assertFinishedInteractionFits(assignmentId, body);
    const transaction = await this.#transact<{
      readonly existing?: FinishedInteraction;
      readonly recordSeq?: number;
    }>(assignmentId, (state) => {
      const requested = state.requested.get(requestId);
      if (!requested) throw new Error("Interaction result has no durable request");
      const existing = state.finished.get(requestId);
      if (existing) {
        if (canonicalize(existing.body) !== canonicalize(body)) {
          throw new Error("Interaction requestId already has a different terminal result");
        }
        return { kind: "return", value: { existing } };
      }
      const entry = nextEntry(state, body);
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: { recordSeq: entry.recordSeq },
      };
    });
    if (transaction.value.existing) {
      return mirrorEntry(transaction.value.existing);
    }
    return validateConversationInteractionMirrorEntry({
      seq: transaction.value.recordSeq!,
      requestId,
      kind: "allow-once",
      outcome: validatedOutcome,
      at: transaction.commit!.at,
    });
  }

  async pendingInteractionMirrors(
    assignmentId: string,
  ): Promise<ConversationInteractionMirrorEntry[]> {
    const state = await this.#read(assignmentId);
    const candidates = [...state.finished.values()]
      .filter((finished) => finished.recordSeq > state.mirroredUpTo)
      .sort((left, right) => left.recordSeq - right.recordSeq)
      .map(mirrorEntry);
    const batch: ConversationInteractionMirrorEntry[] = [];
    for (const candidate of candidates) {
      const next = [...batch, candidate];
      const bytes = Buffer.byteLength(
        canonicalize({ t: "interaction-mirror", assignmentId, entries: next }),
        "utf8",
      );
      if (bytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
        if (batch.length === 0) {
          throw new Error("A durable interaction outcome cannot fit in a mirror batch");
        }
        break;
      }
      batch.push(candidate);
    }
    return batch;
  }

  async markInteractionsMirrored(
    assignmentId: string,
    upTo: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(upTo) || upTo <= 0) {
      throw new TypeError("Interaction mirror watermark must be a positive safe integer");
    }
    await this.#transact<void>(assignmentId, (state) => {
      if (upTo <= state.mirroredUpTo) return { kind: "return", value: undefined };
      const lastFinished = Math.max(0, ...[...state.finished.values()].map((item) => item.recordSeq));
      if (upTo > lastFinished) {
        throw new Error("Interaction mirror watermark exceeds durable finished records");
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntry(state, { v: 1, t: "mirrored", upTo }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async recoverInteractions(
    assignmentId: string,
    now = this.#clock(),
  ): Promise<InteractionRecoveryResult> {
    const nowMs = canonicalTime(now, "Interaction recovery time");
    const transaction = await this.#transact<{
      readonly pending: Array<Extract<AssignmentRecord, { t: "interaction-requested" }>>;
      readonly appended: Array<{
        requestId: string;
        outcome: InteractionOutcome;
        recordSeq: number;
      }>;
    }>(assignmentId, (state) => {
      const pending = [...state.requested.values()].filter(
        (request) => !state.finished.has(request.requestId),
      );
      const terminal = state.phase === "sealed" || state.phase === "acked";
      const toResolve = pending.filter(
        (request) => terminal || canonicalTime(request.expiresAt, "Interaction expiry") < nowMs,
      );
      const stillPending = pending.filter((request) => !toResolve.includes(request));
      if (toResolve.length === 0) {
        return {
          kind: "return",
          value: { pending: stillPending, appended: [] },
        };
      }
      let nextSeq = state.lastSeq;
      const appended = toResolve.map((request) => {
        const outcome: InteractionOutcome = terminal
          ? { t: "cancelled", via: "run-end" }
          : { t: "expired" };
        nextSeq += 1;
        return { requestId: request.requestId, outcome, recordSeq: nextSeq };
      });
      return {
        kind: "append",
        entries: appended.map((item) =>
          assignmentRecord(assignmentId, {
            recordSeq: item.recordSeq,
            body: {
              v: 1,
              t: "interaction-finished",
              requestId: item.requestId,
              kind: "allow-once",
              outcome: item.outcome,
            },
          }),
        ),
        value: { pending: stillPending, appended },
      };
    });
    const resolved: ConversationInteractionMirrorEntry[] = [];
    if (transaction.commit) {
      resolved.push(
        ...transaction.value.appended.map((item) =>
          validateConversationInteractionMirrorEntry({
            seq: item.recordSeq,
            requestId: item.requestId,
            kind: "allow-once",
            outcome: item.outcome,
            at: transaction.commit!.at,
          }),
        ),
      );
    }
    return { pending: transaction.value.pending, resolved };
  }

  async sealBundle(
    assignmentId: string,
    bundle: { readonly ref: ArtifactRef },
    mutationBatch?: { readonly ref: ArtifactRef },
  ): Promise<void> {
    const references = collectArtifactRefs([bundle, mutationBatch].filter(Boolean));
    const sealed = snapshot(
      {
        v: 1 as const,
        t: "bundle_sealed" as const,
        bundle: snapshot(bundle, "Sealed bundle reference"),
        ...(mutationBatch
          ? { mutationBatch: snapshot(mutationBatch, "Mutation batch reference") }
          : {}),
      },
      "Bundle sealed record",
    );
    await this.#transact<void>(
      assignmentId,
      (state) => {
        if (state.phase === "sealed" || state.phase === "acked") {
          if (canonicalize(state.sealed) !== canonicalize(sealed)) {
            throw new Error("Assignment already sealed a different bundle payload");
          }
          return { kind: "return", value: undefined };
        }
        if (state.phase !== "started") {
          throw new Error("Assignment cannot seal a bundle before started");
        }
        let nextSeq = state.lastSeq;
        const entries: AssignmentEntry[] = [];
        for (const request of state.requested.values()) {
          if (state.finished.has(request.requestId)) continue;
          nextSeq += 1;
          entries.push({
            recordSeq: nextSeq,
            body: {
              v: 1,
              t: "interaction-finished",
              requestId: request.requestId,
              kind: "allow-once",
              outcome: { t: "cancelled", via: "run-end" },
            },
          });
        }
        nextSeq += 1;
        entries.push({ recordSeq: nextSeq, body: sealed });
        return {
          kind: "append",
          entries: entries.map((entry) => assignmentRecord(assignmentId, entry)),
          value: undefined,
        };
      },
      references,
    );
  }

  async acknowledge(assignmentId: string, commitRevision: number): Promise<void> {
    if (!Number.isSafeInteger(commitRevision) || commitRevision < 0) {
      throw new TypeError("Commit revision must be a non-negative safe integer");
    }
    await this.#transact<void>(assignmentId, (state) => {
      if (state.phase === "acked") {
        const ack = state.entries.find((entry) => entry.body.t === "acked")!;
        if (ack.body.t !== "acked" || ack.body.commitRevision !== commitRevision) {
          throw new Error("Assignment already acknowledged a different commit revision");
        }
        return { kind: "return", value: undefined };
      }
      if (state.phase !== "sealed") {
        throw new Error("Assignment cannot be acknowledged before bundle sealing");
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntry(state, { v: 1, t: "acked", commitRevision }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async #rejectBeforeReceived(
    assignmentId: string,
    dispatchDigest: string,
    error: AuthorityError,
  ): Promise<DispatchResult> {
    const transaction = await this.#transact<DispatchDecision>(assignmentId, (state) => {
      if (state.received) {
        throw new Error("Invalid redelivery cannot change an accepted assignment ledger");
      }
      if (state.rejection) {
        return {
          kind: "return",
          value: {
            kind: "rejected",
            dispatchDigest: state.rejection.body.dispatchDigest,
            error: state.rejection.body.reason,
            recordSeq: state.rejection.recordSeq,
            ledgerDigest: state.rejection.ledgerDigest,
          },
        };
      }
      const entry = nextEntry(state, {
        v: 1,
        t: "dispatch-rejected",
        dispatchDigest,
        reason: error,
      });
      const ledgerDigest = advanceAssignmentLedger(state.chainDigest, entry);
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: {
          kind: "rejected",
          dispatchDigest,
          error,
          recordSeq: entry.recordSeq,
          ledgerDigest,
        },
      };
    });
    if (transaction.value.kind !== "rejected") {
      throw new Error("Dispatch rejection did not produce a rejection result");
    }
    return this.#rejectionResult(
      assignmentId,
      transaction.value.dispatchDigest,
      transaction.value.error,
      transaction.value.recordSeq,
      transaction.value.ledgerDigest,
    );
  }

  #rejectionResult(
    assignmentId: string,
    dispatchDigest: string,
    error: AuthorityError,
    recordSeq: number,
    ledgerDigest: string,
  ): DispatchResult {
    const payload = {
      v: 1 as const,
      assignmentId,
      executorId: this.#executorId,
      dispatchDigest,
      error,
      lastRecordSeq: recordSeq,
      ledgerDigest,
    };
    const proof: DispatchRejectionProof = snapshot(
      {
        ...payload,
        signature: this.#signer.sign("DispatchRejectionProof", 1, payload),
      },
      "Dispatch rejection proof",
    );
    return {
      v: 1,
      accepted: false,
      outcome: "rejected-before-received",
      error: snapshot(error, "Dispatch rejection error"),
      proof,
    };
  }

  #conflictResult(
    assignmentId: string,
    conflictingDispatchRef: ArtifactRef,
    conflictingPayload: AssignmentActivationPayload<"conversation">,
    received: NonNullable<LedgerProjection["received"]>,
  ): DispatchResult {
    const acceptedPayload = withoutSignature(received.body.activation);
    const payload = {
      v: 1 as const,
      assignmentId,
      executorId: this.#executorId,
      acceptedDispatchRef: received.body.envelope.ref,
      conflictingDispatchRef,
      acceptedActivationDigest: assignmentActivationDigest(acceptedPayload),
      conflictingActivationDigest: assignmentActivationDigest(
        conflictingPayload as AssignmentActivationPayload,
      ),
      receivedRecordSeq: received.recordSeq,
      receivedLedgerDigest: received.ledgerDigest,
      error: { code: "idempotency-conflict" as const, retryable: false as const },
    };
    const proof: DispatchConflictProof = snapshot(
      {
        ...payload,
        signature: this.#signer.sign("DispatchConflictProof", 1, payload),
      },
      "Dispatch conflict proof",
    );
    return {
      v: 1,
      accepted: false,
      outcome: "conflicting-redelivery",
      error: {
        code: "idempotency-conflict",
        retryable: false,
        message: "Assignment id was redelivered with a different activation payload",
      },
      proof,
    };
  }

  async #read(assignmentId: string): Promise<LedgerProjection> {
    const transaction = await this.#log.transactProjection<
      LedgerProjection,
      AssignmentEntry,
      void
    >(
      emptyProjection(assignmentId),
      this.#reduce,
      () => ({ kind: "return", value: undefined }),
      { stream: assignmentStream(assignmentId) },
    );
    return transaction.state;
  }

  async #transact<Value>(
    assignmentId: string,
    decide: (
      state: LedgerProjection,
    ) => ProjectionTransactionDecision<AssignmentEntry, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    assertIdentifier(assignmentId, "Assignment id");
    return this.#log.transactProjection<LedgerProjection, AssignmentEntry, Value>(
      emptyProjection(assignmentId),
      this.#reduce,
      decide,
      {
        stream: assignmentStream(assignmentId),
        candidateReferences,
      },
    );
  }

  readonly #reduce = async (
    state: LedgerProjection,
    record: LogicalRecord<AssignmentEntry>,
    commit: import("@zhixing/core/contracts").CommitEnvelope<AssignmentEntry>,
  ): Promise<LedgerProjection> => {
    if (record.stream !== assignmentStream(state.assignmentId)) {
      throw corruptLedger("Assignment projection received a different stream");
    }
    const entry = snapshot(record.body, "Assignment entry");
    if (entry.recordSeq !== state.lastSeq + 1) {
      throw corruptLedger("Assignment record sequence is not contiguous");
    }
    if (entry.body.t === "received") {
      const bytes = await this.#artifacts.get(entry.body.envelope.ref);
      const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as ConversationEnvelope;
      const envelope = validateConversationEnvelope(raw, this.#verifier);
      const artifact = dispatchEnvelopeArtifact(envelope);
      if (canonicalize(artifact.ref) !== canonicalize(entry.body.envelope.ref)) {
        throw corruptLedger("received dispatch artifact reference is inconsistent");
      }
      if (
        envelope.assignmentId !== state.assignmentId ||
        envelope.executorId !== this.#executorId
      ) {
        throw corruptLedger("received dispatch targets a different assignment or executor");
      }
      await this.#assertEnvelopeArtifactsPresent(envelope);
      validateConversationActivation({
        envelope,
        activation:
          entry.body.activation as AssignmentActivationProof<"conversation">,
        dispatchRef: artifact.ref,
        verifier: this.#verifier,
      });
    }
    const digest = advanceAssignmentLedger(state.chainDigest, entry);
    applyEntry(state, entry, digest, commit.at);
    state.lastSeq = entry.recordSeq;
    state.chainDigest = digest;
    state.entries.push(entry);
    state.ledgerBySeq.push(digest);
    return state;
  };

  async #assertEnvelopeArtifactsPresent(
    envelope: ConversationEnvelope,
  ): Promise<ArtifactRef[]> {
    const references = collectArtifactRefs(envelope);
    for (const ref of references) {
      if (!(await this.#artifacts.has(ref))) {
        throw new TypeError(`Dispatch dependency is not present: ${ref.digest}`);
      }
    }
    return references;
  }
}

function emptyProjection(assignmentId: string): LedgerProjection {
  return {
    assignmentId,
    lastSeq: 0,
    chainDigest: assignmentLedgerSeed(assignmentId),
    phase: "unknown",
    entries: [],
    ledgerBySeq: [],
    requested: new Map(),
    finished: new Map(),
    mirroredUpTo: 0,
  };
}

function applyEntry(
  state: LedgerProjection,
  entry: AssignmentEntry,
  ledgerDigest: string,
  at: string,
): void {
  const body = entry.body;
  switch (body.t) {
    case "received":
      if (state.phase !== "unknown") throw corruptLedger("received is not the first record");
      state.phase = "received";
      state.received = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "dispatch-rejected":
      if (state.phase !== "unknown") {
        throw corruptLedger("dispatch-rejected is not the first record");
      }
      state.phase = "dispatch-rejected";
      state.rejection = { body, recordSeq: entry.recordSeq, ledgerDigest };
      return;
    case "started":
      if (state.phase !== "received") throw corruptLedger("started has no received prefix");
      state.phase = "started";
      return;
    case "interaction-requested":
      if (state.phase !== "started") {
        throw corruptLedger("interaction request is outside a started assignment");
      }
      if (state.requested.has(body.requestId)) {
        throw corruptLedger("interaction requestId is duplicated");
      }
      validateInteractionRequest(body);
      state.requested.set(body.requestId, body);
      return;
    case "interaction-finished":
      if (!state.requested.has(body.requestId) || state.finished.has(body.requestId)) {
        throw corruptLedger("interaction result is missing or duplicated");
      }
      validateConversationInteractionOutcome(body.outcome);
      assertFinishedInteractionFits(state.assignmentId, body);
      state.finished.set(body.requestId, { body, recordSeq: entry.recordSeq, at });
      return;
    case "bundle_sealed":
      if (state.phase !== "started") {
        throw corruptLedger("bundle_sealed has no started prefix");
      }
      state.phase = "sealed";
      state.sealed = body;
      return;
    case "acked":
      if (state.phase !== "sealed") throw corruptLedger("acked has no sealed prefix");
      state.phase = "acked";
      return;
    case "mirrored":
      if (body.upTo <= state.mirroredUpTo) {
        throw corruptLedger("mirrored watermark must increase");
      }
      if (
        ![...state.finished.values()].some(
          (finished) => finished.recordSeq === body.upTo,
        )
      ) {
        throw corruptLedger("mirrored watermark has no finished interaction");
      }
      state.mirroredUpTo = body.upTo;
      return;
    default:
      throw corruptLedger(`Unsupported assignment record in this protocol stage: ${body.t}`);
  }
}

/** In-process executor-to-owner adapter; it exposes only the submission methods implemented here. */
export class InProcessAssignmentSubmission {
  readonly #ledger: ConversationAssignmentLedger;
  readonly #owner: ConversationSubmissionPort;

  constructor(options: InProcessAssignmentSubmissionOptions) {
    this.#ledger = options.ledger;
    this.#owner = options.owner;
  }

  async startAndReport(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<{ readonly started: boolean }> {
    const started = await this.#ledger.start(assignmentId);
    await this.#owner.reportStarted(assignmentId, ctx);
    return started;
  }

  async finishAndMirror(
    assignmentId: string,
    requestId: string,
    outcome: InteractionOutcome,
    ctx: AuthorityCallContext,
  ): Promise<ConversationInteractionMirrorEntry> {
    const finished = await this.#ledger.finishInteraction(
      assignmentId,
      requestId,
      outcome,
    );
    await this.flushInteractionMirrors(assignmentId, ctx);
    return finished;
  }

  async flushInteractionMirrors(
    assignmentId: string,
    ctx: AuthorityCallContext,
  ): Promise<number> {
    let mirrored = 0;
    while (true) {
      const pending = await this.#ledger.pendingInteractionMirrors(assignmentId);
      if (pending.length === 0) return mirrored;
      const result = await this.#owner.mirrorInteractions(assignmentId, pending, ctx);
      const sentUpTo = pending.at(-1)!.seq;
      if (result.mirroredUpTo !== sentUpTo) {
        throw new Error("Owner returned a mirror watermark outside the submitted batch");
      }
      await this.#ledger.markInteractionsMirrored(assignmentId, result.mirroredUpTo);
      mirrored += pending.length;
    }
  }
}

function ledgerSnapshot(state: LedgerProjection): LedgerSnapshot {
  return {
    v: 1,
    assignmentId: state.assignmentId,
    lastSeq: state.lastSeq,
    phase: state.phase,
    ...(state.sealed
      ? {
          sealedBundleRef: snapshot(
            state.sealed.bundle.ref,
            "Sealed bundle reference",
          ),
        }
      : {}),
  };
}

function nextEntry(
  state: LedgerProjection,
  body: AssignmentRecord,
): AssignmentEntry {
  return { recordSeq: state.lastSeq + 1, body: snapshot(body, "Assignment record") };
}

function assignmentRecord(
  assignmentId: string,
  entry: AssignmentEntry,
): LogicalRecord<AssignmentEntry> {
  return { stream: assignmentStream(assignmentId), body: entry };
}

function assignmentStream(assignmentId: string): string {
  return `assignment:${assignmentId}`;
}

function interactionRequested(
  input: InteractionRequestInput,
): Extract<AssignmentRecord, { t: "interaction-requested" }> {
  const body = snapshot(
    {
      v: 1 as const,
      t: "interaction-requested" as const,
      requestId: input.requestId,
      kind: "allow-once" as const,
      toolName: input.toolName,
      display: { title: input.display.title, lines: [...input.display.lines] },
      issuedAt: input.issuedAt,
      ttlMs: input.ttlMs,
      expiresAt: input.expiresAt,
    },
    "Interaction request",
  );
  validateInteractionRequest(body);
  return body;
}

function validateInteractionRequest(
  body: Extract<AssignmentRecord, { t: "interaction-requested" }>,
): void {
  assertPlainObject(body, "Interaction request");
  assertExactKeys(
    body,
    ["display", "expiresAt", "issuedAt", "kind", "requestId", "t", "ttlMs", "toolName", "v"],
    "Interaction request",
  );
  if (body.v !== 1 || body.t !== "interaction-requested" || body.kind !== "allow-once") {
    throw new TypeError("Interaction request discriminators are invalid");
  }
  assertIdentifier(body.requestId, "Interaction requestId");
  assertIdentifier(body.toolName, "Interaction toolName");
  if (
    !Number.isSafeInteger(body.ttlMs) ||
    body.ttlMs <= 0
  ) {
    throw new TypeError("Interaction TTL is outside the supported bound");
  }
  const issuedAt = canonicalTime(body.issuedAt, "Interaction issuedAt");
  const expiresAt = canonicalTime(body.expiresAt, "Interaction expiresAt");
  if (expiresAt - issuedAt !== body.ttlMs) {
    throw new TypeError("Interaction expiresAt must equal issuedAt plus ttlMs");
  }
  assertPlainObject(body.display, "Interaction display");
  assertExactKeys(body.display, ["lines", "title"], "Interaction display");
  if (
    typeof body.display.title !== "string" ||
    !Array.isArray(body.display.lines) ||
    body.display.lines.some((line) => typeof line !== "string") ||
    body.display.title.length === 0
  ) {
    throw new TypeError("Interaction display exceeds its bounded projection");
  }
  assertInteractionRecordSize(body, "Interaction request");
}

function mirrorEntry(finished: FinishedInteraction): ConversationInteractionMirrorEntry {
  return validateConversationInteractionMirrorEntry({
    seq: finished.recordSeq,
    requestId: finished.body.requestId,
    kind: "allow-once",
    outcome: snapshot(finished.body.outcome, "Interaction outcome"),
    at: finished.at,
  });
}

function assertInteractionRecordSize(value: unknown, label: string): void {
  const largestSequenceWrapper = {
    recordSeq: Number.MAX_SAFE_INTEGER,
    body: value,
  };
  if (
    Buffer.byteLength(canonicalize(largestSequenceWrapper), "utf8") >
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    throw new TypeError(`${label} exceeds the durable protocol limit`);
  }
}

function assertFinishedInteractionFits(
  assignmentId: string,
  body: Extract<AssignmentRecord, { t: "interaction-finished" }>,
): void {
  assertInteractionRecordSize(body, "Interaction result");
  const singleEntryMirrorRecord = {
    t: "interaction-mirror",
    assignmentId,
    entries: [
      {
        seq: Number.MAX_SAFE_INTEGER,
        requestId: body.requestId,
        kind: "allow-once",
        outcome: body.outcome,
        at: MAX_WIDTH_CANONICAL_TIME,
      },
    ],
  };
  if (
    Buffer.byteLength(canonicalize(singleEntryMirrorRecord), "utf8") >
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    throw new TypeError("Interaction result cannot fit in a durable mirror record");
  }
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalize(actual) !== canonicalize(wanted)) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertDispatchIdentity(
  envelope: ConversationEnvelope,
  executorId: string,
): string {
  assertIdentifier(envelope?.assignmentId, "Dispatch assignmentId");
  if (envelope.executorId !== executorId) {
    throw new TypeError("Dispatch targets a different executor");
  }
  return envelope.assignmentId;
}

function invalidDispatchError(error: unknown): AuthorityError {
  return {
    code: "invalid",
    message: error instanceof Error ? error.message : "Dispatch validation failed",
    retryable: false,
  };
}

function withoutSignature(
  proof: AssignmentActivationProof,
): AssignmentActivationPayload {
  const { signature: _, ...payload } = proof;
  return snapshot(payload, "Assignment activation payload");
}

function canonicalTime(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function corruptLedger(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}
