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
  AssignmentActivationProof,
  AuthorityCallContext,
  ConversationRunState,
  DispatchResult,
  IngressContext,
  LedgerSnapshot,
  LogicalRecord,
  UserTurnInput,
} from "@zhixing/core/contracts";
import {
  buildConversationActivationPayload,
  canonicalize,
  createSignedConversationEnvelope,
  dispatchEnvelopeArtifact,
  permissionSnapshotLeaseDigest,
  signConversationActivation,
  validateConversationEnvelope,
  validateConversationInteractionMirrorEntry,
  type ConversationInteractionMirrorEntry,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
  type UnsignedConversationEnvelope,
} from "@zhixing/core/protocol";

type Stored<T> = T | { readonly ref: ArtifactRef };

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
    };

export interface AssignmentSubmissionAuthorizer {
  authorize(
    context: AuthorityCallContext,
    method: "submission.reportStarted" | "submission.mirrorInteractions",
    assignmentId: string,
  ): void;
}

export interface ConversationRunJournalOptions {
  readonly conversationId: string;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly submission: AssignmentSubmissionAuthorizer;
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
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #submission: AssignmentSubmissionAuthorizer;

  constructor(options: ConversationRunJournalOptions) {
    assertIdentifier(options.conversationId, "Conversation id");
    this.#conversationId = options.conversationId;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#submission = options.submission;
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
      if (current?.state === "running") return { kind: "return", value: undefined };
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
      if (current?.state === "running") return { kind: "return", value: undefined };
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
      ConversationRunJournalRecord,
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
    record: LogicalRecord<ConversationRunJournalRecord>,
    envelope: import("@zhixing/core/contracts").CommitEnvelope<ConversationRunJournalRecord>,
  ): Promise<RunProjection> => {
    if (record.stream !== runStream(this.#conversationId)) {
      throw corruptRunJournal("Run projection received a different stream");
    }
    const body = snapshot(record.body, "Run journal record");
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
        state.stateByRun.set(body.runId, {
          state: body.state,
          statusRevision: body.statusRevision,
        });
        return state;
      }
    }
  };

  async #transact<Value>(
    decide: (
      state: RunProjection,
    ) => ProjectionTransactionDecision<ConversationRunJournalRecord, Value>,
    candidateReferences: readonly ArtifactRef[] = [],
  ) {
    return this.#log.transactProjection<
      RunProjection,
      ConversationRunJournalRecord,
      Value
    >(emptyProjection(this.#conversationId), this.#reduce, decide, {
      stream: runStream(this.#conversationId),
      candidateReferences,
    });
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
  };
}

function runRecord(
  conversationId: string,
  body: ConversationRunJournalRecord,
): LogicalRecord<ConversationRunJournalRecord> {
  return { stream: runStream(conversationId), body };
}

function runStream(conversationId: string): string {
  return `run:${conversationId}`;
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
    (current === "dispatched" && next === "running")
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

function corruptRunJournal(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} is not canonical protocol data`, { cause: error });
  }
}
