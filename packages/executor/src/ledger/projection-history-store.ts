import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  awaitAuthorityPreparation,
  projectionCheckpointKey,
  type ArtifactStore,
  type AuthorityCommitLog,
  type DurableProjectionReadContext,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import {
  MAX_LEDGER_EVIDENCE_PAGE_BYTES,
  type ArtifactRef,
  type AssignmentEntry,
  type AssignmentRecord,
  type CommitEnvelope,
  type JsonValue,
  type LedgerEvidencePage,
  type LedgerSnapshot,
  type LogicalRecord,
} from "@zhixing-ai/core/contracts";
import { SerialTaskQueue } from "@zhixing-ai/core/persistence";
import {
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  dispatchEnvelopeArtifact,
  interactionSettlementNeedsStreamProof,
  materializeInteractionDisplay,
  validateConversationEnvelope,
  validateJobEnvelope,
  verifyProtocolStep,
  type DataPlaneTicketUse,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError,
  waitForMaintenanceRetry,
} from "@zhixing-ai/core/resources";
import {
  leaseClockRecord,
  leaseTime,
  readLeaseClockSummary,
  type LeaseClockSummary,
} from "../assignment-lease-clock.js";
import {
  ASSIGNMENT_LEDGER_INDEX_ID,
  assignmentChangedAfter,
  hasAssignmentHistoryKeys,
  readAssignmentEnvelopes,
  readAssignmentEnvelopesAfter,
  readAssignmentHistory,
  readAssignmentPhases,
  readRecoveryCandidateClasses,
  type AssignmentHistoryNeeds,
  type AssignmentHistoryRows,
  type RecoveryCandidateClass,
} from "../assignment-ledger-index.js";
import type { DataPlaneAssignmentBinding } from "../data-plane-ticket-registry.js";
import type {
  ExecutorAssignmentResourceCoordinator,
  ExecutorCoordinationOptions,
} from "../resource-governor.js";
import {
  AssignmentExecutionResourceRetiredError,
  assignmentStream,
  BINDING_RECOVERY_CHUNK,
  buildLedgerProjectionCheckpointPrefix,
  corruptLedger,
  DATA_PLANE_BINDING_BATCH_LIMIT,
  DECISION_STATE_SAVE_DELAY_MS,
  HistoryLookupRequired,
  LEDGER_DECISION_STATE_VERSION,
  LEGACY_HISTORY_PAGE_KEYS,
  requiresExecutorResourceReceipt,
  snapshot,
  type AssignmentEnvelope,
  type ConversationEnvelope,
  type DecisionState,
  type DeepReadonly,
  type DurableInteractionStreamEvent,
  type ExecutionControlFacts,
  type FinishedInteraction,
  type InteractionEffectFacts,
  type JobEnvelope,
  type LedgerControlState,
  type LedgerProjection,
  type LedgerReceivedState,
  type LedgerRejectionState,
  type LedgerStartedState,
  type LedgerSupersedeFenceState,
  type LegacyHistory,
  type LegacyHistoryCategory,
  type LegacyHistoryPage,
  type LegacyHistoryPages,
  type MirrorChainItem,
  type ReadonlyLedgerReceivedState,
  type ReceiptRecoveryFacts,
  type RequestedInteraction,
  type SealingEvidenceFacts,
  type StoredDataPlaneBinding,
  type ValidationTicketAbortFact,
} from "./contracts.js";
import {
  assertEnvelopeArtifactsPresent,
  decisionSnapshot,
  emptyProjection,
  extractDataPlaneBinding,
  finishedAt,
  finishedCount,
  hasPendingInteractionObligations,
  LEDGER_BINDING_FINGERPRINT_FNS,
  LEDGER_DECISION_FINGERPRINT_FNS,
  ledgerSnapshot,
  omitsHistory,
  reduceAssignmentRecord,
  restoreDecisionState,
  withLeaseClock,
  type LedgerReductionEnvironment,
} from "./state-replay.js";

export interface LedgerProjectionHistoryStoreOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly resources?: ExecutorAssignmentResourceCoordinator;
  readonly leaseClockProjectionId: string;
  readonly maxCachedAssignments: number;
}

export class LedgerProjectionHistoryStore {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #resources: ExecutorAssignmentResourceCoordinator | undefined;
  readonly #leaseClockProjectionId: string;
  readonly #maxCachedAssignments: number;
  readonly #reductionEnv: LedgerReductionEnvironment;
  readonly #operations = new SerialTaskQueue();
  readonly #projections = new Map<
    string,
    { readonly state: LedgerProjection; readonly cursor: ProjectionCursor }
  >();
  readonly #decisionPending = new Map<
    string,
    {
      readonly state: LedgerProjection;
      readonly cursor: ProjectionCursor;
      readonly legacy?: {
        readonly generation: string;
        readonly upToSeq: number;
        readonly pages: LegacyHistoryPages;
        readonly files: readonly LegacyHistoryPage[];
      };
      readonly fallback?: LedgerProjection;
    }
  >();
  readonly #legacyBackfilled = new Map<
    string,
    {
      readonly upToSeq: number;
      readonly generation: string;
      readonly pages: LegacyHistoryPages;
    }
  >();
  readonly #legacyHistories = new Map<string, Map<string, LegacyHistoryPage>>();
  #decisionSave: NodeJS.Timeout | undefined;
  #decisionWrite: Promise<void> = Promise.resolve();

  constructor(options: LedgerProjectionHistoryStoreOptions) {
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#resources = options.resources;
    this.#leaseClockProjectionId = options.leaseClockProjectionId;
    this.#maxCachedAssignments = options.maxCachedAssignments;
    this.#reductionEnv = {
      executorId: options.executorId,
      artifacts: options.artifacts,
      verifier: options.verifier,
      ...(options.resources ? { resources: options.resources } : {}),
    };
  }

  async flushDecisionStates(): Promise<void> {
    if (this.#decisionSave) {
      clearTimeout(this.#decisionSave);
      this.#decisionSave = undefined;
    }
    await this.#writeDecisionStates();
  }

  async repeatPrepared<Value>(operation: () => Promise<Value>): Promise<Value> {
    const abort = currentMaintenanceAbortSignal();
    let deadline: number | undefined;
    for (let rounds = 0; ; rounds++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof HistoryLookupRequired && rounds === 0) continue;
        if (rounds >= 64) throw error;
        if (await awaitAuthorityPreparation(error)) continue;
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || abort.aborted) {
          throw error;
        }
        deadline ??= performance.now() + 5_000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, deadline - performance.now()), abort);
        if (abort.aborted) throw new StorageMaintenanceCancelledError();
        if (performance.now() >= deadline) throw error;
      }
    }
  }

  async selectExecutionControl<Value>(
    assignmentId: string,
    select: (facts: ExecutionControlFacts) => Value,
  ): Promise<Value> {
    return this.#select(assignmentId, (state) => select(toExecutionControlFacts(state)));
  }

  async transactExecutionControl<Value>(
    assignmentId: string,
    decide: (
      facts: ExecutionControlFacts,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    options: {
      readonly candidateReferences?: readonly ArtifactRef[];
      readonly readProjectionIds?: readonly string[];
      readonly resourcePreparation?: NonNullable<ExecutorCoordinationOptions["prepare"]>;
    } = {},
  ) {
    return this.#transact(
      assignmentId,
      (state, context) => decide(toExecutionControlFacts(state), context),
      options.candidateReferences ?? [],
      false,
      options.readProjectionIds ?? [],
      options.resourcePreparation ? { resourcePreparation: options.resourcePreparation } : {},
    );
  }

  async selectInteractionEffect<Value>(
    assignmentId: string,
    select: (facts: InteractionEffectFacts) => Value,
    history?: () => AssignmentHistoryNeeds,
  ): Promise<Value> {
    return this.#select(
      assignmentId,
      (state) => select(toInteractionEffectFacts(state)),
      history ? () => history() : undefined,
    );
  }

  async transactInteractionEffect<Value>(
    assignmentId: string,
    decide: (
      facts: InteractionEffectFacts,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    options: {
      readonly candidateReferences?: readonly ArtifactRef[];
      readonly readProjectionIds?: readonly string[];
      readonly history?: () => AssignmentHistoryNeeds;
    } = {},
  ) {
    return this.#transact(
      assignmentId,
      (state, context) => decide(toInteractionEffectFacts(state), context),
      options.candidateReferences ?? [],
      false,
      options.readProjectionIds ?? [],
      options.history ? { history: () => options.history!() } : {},
    );
  }

  async selectSealingEvidence<Value>(
    assignmentId: string,
    select: (facts: SealingEvidenceFacts) => Value,
  ): Promise<Value> {
    return this.#select(assignmentId, (state) => select(toSealingEvidenceFacts(state)));
  }

  async transactSealingEvidence<Value>(
    assignmentId: string,
    decide: (
      facts: SealingEvidenceFacts,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    options: {
      readonly candidateReferences?: readonly ArtifactRef[];
    } = {},
  ) {
    return this.#transact(
      assignmentId,
      (state, context) => decide(toSealingEvidenceFacts(state), context),
      options.candidateReferences ?? [],
    );
  }

  async selectReceiptRecovery<Value>(
    assignmentId: string,
    select: (facts: ReceiptRecoveryFacts) => Value,
    history?: () => AssignmentHistoryNeeds,
  ): Promise<Value> {
    return this.#select(
      assignmentId,
      (state) => select(toReceiptRecoveryFacts(state)),
      history ? () => history() : undefined,
    );
  }

  async transactReceiptRecovery<Value>(
    assignmentId: string,
    decide: (
      facts: ReceiptRecoveryFacts,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    options: {
      readonly receiptRetirement?: boolean;
      readonly history?: () => AssignmentHistoryNeeds;
    } = {},
  ) {
    return this.#transact(
      assignmentId,
      (state, context) => decide(toReceiptRecoveryFacts(state), context),
      [],
      options.receiptRetirement ?? false,
      [],
      options.history ? { history: () => options.history!() } : {},
    );
  }

  async queryEvidenceOrSnapshot(
    assignmentId: string,
    range?: { fromSeq: number; limit: number },
  ): Promise<LedgerSnapshot | LedgerEvidencePage> {
    const selected = await this.#select(assignmentId, (state) => {
      if (!range) return snapshot(ledgerSnapshot(state), "Ledger snapshot");
      if ((state.historyBase ?? 0) > 0 && range.fromSeq <= state.historyBase!) {
        return undefined;
      }
      return this.#evidencePage(assignmentId, state, range);
    });
    if (selected !== undefined) return selected;
    const full = (
      await this.repeatPrepared(() =>
        this.#operations.run(() =>
          this.#recoverProjections([assignmentId], false, true),
        ),
      )
    ).states.get(assignmentId)!;
    return this.#evidencePage(assignmentId, full, range!);
  }

  async interactionStreamEvents(
    assignmentId: string,
    afterRecordSeq = 0,
  ): Promise<readonly DurableInteractionStreamEvent[]> {
    const local = await this.#select(assignmentId, (state) =>
      (state.historyInteractionUpTo ?? 0) > afterRecordSeq
        ? undefined
        : interactionStreamEventsOf(state),
    );
    if (local) return local;
    const full = await this.repeatPrepared(() =>
      this.#operations.run(() =>
        this.#recoverProjections([assignmentId], false, true),
      ),
    );
    return interactionStreamEventsOf(full.states.get(assignmentId)!);
  }

  async dataPlaneBinding(
    assignmentId: string,
    use?: DataPlaneTicketUse,
  ): Promise<DataPlaneAssignmentBinding | undefined> {
    assertIdentifier(assignmentId, "Data-plane assignment id");
    const { binding, lease } = await this.#select(assignmentId, (state) => ({
      binding: extractDataPlaneBinding(state, this.#executorId, use),
      lease: state.received?.resourceLease,
    }));
    if (
      use === "observe" ||
      !binding ||
      !lease ||
      !requiresExecutorResourceReceipt(lease)
    ) {
      return binding;
    }
    return (await this.#inactiveResourceReservations([lease.reservationId])).size > 0
      ? undefined
      : binding;
  }

  async dataPlaneBindings(
    requests: readonly { readonly assignmentId: string; readonly use?: DataPlaneTicketUse }[],
  ): Promise<(DataPlaneAssignmentBinding | undefined)[]> {
    if (requests.length > DATA_PLANE_BINDING_BATCH_LIMIT) {
      throw new RangeError(
        `Data-plane binding batch exceeds ${DATA_PLANE_BINDING_BATCH_LIMIT} requests`,
      );
    }
    for (const request of requests) {
      assertIdentifier(request.assignmentId, "Data-plane assignment id");
    }
    if (requests.length === 0) return [];
    const resolved = await this.repeatPrepared(() =>
      this.#operations.run(async () => {
        const wanted = [...new Set(requests.map((request) => request.assignmentId))];
        const key = this.#bindingCheckpointKey();
        const saved =
          await this.#log.loadProjectionCheckpoint?.<
            ReadonlyMap<string, StoredDataPlaneBinding>
          >(key);
        const known = saved && saved.state instanceof Map ? saved.state : undefined;
        const bindings = new Map<string, StoredDataPlaneBinding>();
        let cursor: ProjectionCursor | undefined;
        const reusable = known ? wanted.filter((id) => known.has(id)) : [];
        if (saved && known && reusable.length > 0) {
          const since = saved.cursor.lsn;
          const check = await this.#log.transactDurableProjection<
            unknown,
            ReadonlySet<string>
          >(ASSIGNMENT_LEDGER_INDEX_ID, async (current) => {
            const changed = new Set<string>();
            for (const id of reusable) {
              if (await assignmentChangedAfter(current, id, since)) changed.add(id);
            }
            return { kind: "return", value: changed };
          });
          cursor = check.cursor;
          for (const id of reusable) {
            if (!check.value.has(id)) bindings.set(id, known.get(id)!);
          }
        }
        const fresh = wanted.filter((id) => !bindings.has(id));
        for (let offset = 0; offset < fresh.length; offset += BINDING_RECOVERY_CHUNK) {
          const recovered = await this.#recoverProjections(
            fresh.slice(offset, offset + BINDING_RECOVERY_CHUNK),
          );
          cursor ??= recovered.cursor;
          for (const [id, state] of recovered.states) {
            const lease = state.received?.resourceLease;
            bindings.set(id, {
              observe: extractDataPlaneBinding(state, this.#executorId, "observe"),
              active: extractDataPlaneBinding(state, this.#executorId),
              ...(lease && requiresExecutorResourceReceipt(lease)
                ? { resourceReservationId: lease.reservationId }
                : {}),
            });
          }
        }
        if (cursor) await this.#log.saveProjectionCheckpoint?.(key, cursor, bindings);
        return requests.map((request) => bindings.get(request.assignmentId)!);
      }),
    );
    const inactive = await this.#inactiveResourceReservations(
      resolved.flatMap((binding, index) =>
        requests[index]!.use !== "observe" &&
        binding.active &&
        binding.resourceReservationId
          ? [binding.resourceReservationId]
          : [],
      ),
    );
    return resolved.map((binding, index) =>
      requests[index]!.use === "observe"
        ? binding.observe
        : binding.resourceReservationId && inactive.has(binding.resourceReservationId)
          ? undefined
          : binding.active,
    );
  }

  async readAssignmentPhasesFromIndex(
    assignmentIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly started: boolean; readonly received: boolean }>> {
    if (assignmentIds.length === 0) return new Map();
    return (
      await this.repeatPrepared(() =>
        this.#log.transactDurableProjection<
          unknown,
          ReadonlyMap<string, { readonly started: boolean; readonly received: boolean }>
        >(ASSIGNMENT_LEDGER_INDEX_ID, async (current) => ({
          kind: "return",
          value: await readAssignmentPhases(current, assignmentIds),
        })),
      )
    ).value;
  }

  async conversationAssignmentsMatching(
    predicate: (facts: ReceiptRecoveryFacts) => boolean,
    classify: (classification: RecoveryCandidateClass) => boolean,
  ): Promise<readonly ConversationEnvelope[]> {
    const envelopes: ConversationEnvelope[] = [];
    for (const { assignmentId, envelopeRef, indexed } of await this.#assignmentEnvelopeRefsMatching(
      (state) => predicate(toReceiptRecoveryFacts(state)),
      classify,
    )) {
      const envelope = await this.loadConversationEnvelope(assignmentId, envelopeRef);
      if (!envelope) continue;
      if (indexed) {
        if (
          envelope.executorId !== this.#executorId ||
          canonicalize(dispatchEnvelopeArtifact(envelope).ref) !== canonicalize(envelopeRef)
        ) {
          throw corruptLedger(
            "received dispatch targets a different assignment or executor",
          );
        }
        await assertEnvelopeArtifactsPresent(envelope, this.#artifacts);
      }
      envelopes.push(envelope);
    }
    return envelopes;
  }

  async loadConversationEnvelope(
    assignmentId: string,
    envelopeRef: ArtifactRef,
  ): Promise<ConversationEnvelope | undefined> {
    const envelope = await this.#loadAssignmentEnvelope(assignmentId, envelopeRef);
    return envelope.execution === "conversation" ? envelope : undefined;
  }

  async loadJobEnvelope(
    assignmentId: string,
    envelopeRef: ArtifactRef,
  ): Promise<JobEnvelope | undefined> {
    const envelope = await this.#loadAssignmentEnvelope(assignmentId, envelopeRef);
    return envelope.execution === "job" ? envelope : undefined;
  }

  async #inactiveResourceReservations(
    reservationIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (!this.#resources?.lostExecutionRetirement || reservationIds.length === 0) {
      return new Set();
    }
    const states = await this.#resources.reservationStates([...new Set(reservationIds)]);
    return new Set(
      [...states].flatMap(([id, state]) => (state === "active" ? [] : [id])),
    );
  }

  #bindingCheckpointKey(): string {
    return `${buildLedgerProjectionCheckpointPrefix(
      "executor-data-plane-bindings",
      2,
      LEDGER_BINDING_FINGERPRINT_FNS,
    )}:${this.#executorId}`;
  }

  #decisionStateKey(assignmentId: string): string {
    return `${buildLedgerProjectionCheckpointPrefix(
      "executor-assignment-decision",
      LEDGER_DECISION_STATE_VERSION,
      LEDGER_DECISION_FINGERPRINT_FNS,
    )}:${this.#executorId}:${assignmentId}`;
  }

  #evidencePage(
    assignmentId: string,
    state: LedgerProjection,
    range: { fromSeq: number; limit: number },
  ): LedgerEvidencePage {
    const offset = state.historyBase ?? 0;
    const candidates = state.entries.slice(
      range.fromSeq - 1 - offset,
      range.fromSeq - 1 - offset + range.limit,
    );
    if (candidates.length === 0) {
      throw new RangeError("Ledger evidence range starts beyond the durable ledger");
    }
    const chainDigestAt = (recordSeq: number) =>
      state.ledgerBySeq[recordSeq - 1 - offset]!;
    let lower = 1;
    let upper = candidates.length;
    let selected = 0;
    while (lower <= upper) {
      const count = Math.floor((lower + upper) / 2);
      const payload = ledgerEvidencePayload(
        assignmentId,
        this.#executorId,
        candidates.slice(0, count),
        chainDigestAt,
      );
      if (
        Buffer.byteLength(canonicalize(payload), "utf8") <=
        MAX_LEDGER_EVIDENCE_PAGE_BYTES
      ) {
        selected = count;
        lower = count + 1;
      } else {
        upper = count - 1;
      }
    }
    if (selected === 0) {
      throw new RangeError("A ledger evidence entry exceeds the protocol page byte limit");
    }
    const payload = ledgerEvidencePayload(
      assignmentId,
      this.#executorId,
      candidates.slice(0, selected),
      chainDigestAt,
    );
    return snapshot(
      {
        ...payload,
        signature: this.#signer.sign("LedgerEvidencePage", 1, payload),
      },
      "Ledger evidence page",
    );
  }

  async #assignmentEnvelopeRefsMatching(
    predicate: (state: LedgerProjection) => boolean,
    classify: (classification: RecoveryCandidateClass) => boolean,
  ): Promise<
    readonly {
      readonly assignmentId: string;
      readonly envelopeRef: ArtifactRef;
      readonly indexed?: true;
    }[]
  > {
    const candidates = (
      await this.repeatPrepared(() =>
        this.#log.transactDurableProjection<
          unknown,
          readonly {
            readonly assignmentId: string;
            readonly classification?: RecoveryCandidateClass;
            readonly envelopeRef?: unknown;
          }[]
        >(ASSIGNMENT_LEDGER_INDEX_ID, async (current) => ({
          kind: "return",
          value: await readRecoveryCandidateClasses(current),
        })),
      )
    ).value;
    const refs: Array<{
      readonly assignmentId: string;
      readonly envelopeRef: ArtifactRef;
      readonly indexed?: true;
    }> = [];
    const selected = candidates
      .filter(({ classification }) => classification === undefined || classify(classification))
      .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId, "en-US"));
    const decided = new Map<string, DecisionState>();
    for (const { assignmentId, classification } of selected) {
      if (!classification) continue;
      const saved = (await this.#loadDecisionStates([assignmentId])).get(assignmentId);
      if (saved) decided.set(assignmentId, saved);
    }
    const current =
      decided.size === 0
        ? new Set<string>()
        : (
            await this.repeatPrepared(() =>
              this.#log.transactDurableProjection<unknown, ReadonlySet<string>>(
                ASSIGNMENT_LEDGER_INDEX_ID,
                async (view) => {
                  const unchanged = new Set<string>();
                  for (const [assignmentId, saved] of decided) {
                    if (!(await assignmentChangedAfter(view, assignmentId, saved.coveredLsn))) {
                      unchanged.add(assignmentId);
                    }
                  }
                  return { kind: "return", value: unchanged };
                },
              ),
            )
          ).value;
    for (const { assignmentId } of selected) {
      const saved = current.has(assignmentId) ? decided.get(assignmentId)!.state : undefined;
      if (saved) {
        if (predicate(saved) && saved.received) {
          refs.push({
            assignmentId,
            envelopeRef: saved.received.body.envelope.ref,
            indexed: true,
          });
        }
        continue;
      }
      const envelopeRef = await this.#select(assignmentId, (state) =>
        predicate(state) && state.received ? state.received.body.envelope.ref : undefined,
      );
      if (envelopeRef) refs.push({ assignmentId, envelopeRef });
    }
    return refs;
  }

  async #loadAssignmentEnvelope(
    assignmentId: string,
    envelopeRef: ArtifactRef,
  ): Promise<AssignmentEnvelope> {
    const bytes = await this.#artifacts.get(envelopeRef);
    const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as AssignmentEnvelope;
    if (raw.assignmentId !== assignmentId) {
      throw corruptLedger("Assignment envelope does not bind its ledger");
    }
    return raw.execution === "conversation"
      ? await verifyProtocolStep(() =>
          validateConversationEnvelope(raw, this.#verifier),
        )
      : await verifyProtocolStep(() => validateJobEnvelope(raw, this.#verifier));
  }

  async #select<Value>(
    assignmentId: string,
    select: (state: LedgerProjection) => Value,
    history?: (state: LedgerProjection) => AssignmentHistoryNeeds,
  ): Promise<Value> {
    assertIdentifier(assignmentId, "Assignment id");
    return this.repeatPrepared(() =>
      this.#operations.run(async () => {
        let state: LedgerProjection;
        for (let attempt = 0; ; attempt++) {
          try {
            const cached =
              this.#takeCachedProjection(assignmentId) ??
              (await this.#recoverProjection(assignmentId));
            const keyed = history !== undefined && omitsHistory(cached.state);
            const legacy = keyed
              ? await this.#legacyHistory(cached.state, history!(cached.state))
              : undefined;
            const transaction = await this.#log.transactProjection<
              LedgerProjection,
              AssignmentEntry,
              LeaseClockSummary
            >(
              cached.state,
              (currentState, record, envelope) =>
                reduceAssignmentRecord(
                  this.#reductionEnv,
                  currentState === cached.state
                    ? structuredClone(currentState)
                    : currentState,
                  record,
                  envelope,
                ),
              async (currentState, context) => {
                if (keyed) {
                  await this.#hydrateHistory(
                    currentState,
                    context.readProjection(ASSIGNMENT_LEDGER_INDEX_ID),
                    history!(currentState),
                    legacy,
                  );
                }
                return {
                  kind: "return",
                  value: await readLeaseClockSummary(
                    context.readProjection(this.#leaseClockProjectionId),
                  ),
                };
              },
              {
                streams: [assignmentStream(assignmentId)],
                cursor: cached.cursor,
                readProjectionIds: keyed
                  ? [this.#leaseClockProjectionId, ASSIGNMENT_LEDGER_INDEX_ID]
                  : [this.#leaseClockProjectionId],
              },
            );
            withLeaseClock(transaction.state, transaction.value);
            this.#cacheProjection(assignmentId, {
              state: transaction.state,
              cursor: transaction.cursor,
            });
            state = transaction.state;
            break;
          } catch (error) {
            this.#projections.delete(assignmentId);
            if (error instanceof HistoryLookupRequired && attempt === 0) continue;
            throw error;
          }
        }
        return select(state);
      }),
    );
  }

  async #transact<Value>(
    assignmentId: string,
    decide: (
      state: LedgerProjection,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    candidateReferences: readonly ArtifactRef[] = [],
    receiptRetirement = false,
    readProjectionIds: readonly string[] = [],
    options: {
      readonly resourcePreparation?: NonNullable<ExecutorCoordinationOptions["prepare"]>;
      readonly history?: (state: LedgerProjection) => AssignmentHistoryNeeds;
    } = {},
  ) {
    assertIdentifier(assignmentId, "Assignment id");
    return this.repeatPrepared(() =>
      this.#operations.run(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const cached =
              (receiptRetirement ? undefined : this.#takeCachedProjection(assignmentId)) ??
              (await this.#recoverProjection(assignmentId, receiptRetirement));
            const keyed = options.history !== undefined && omitsHistory(cached.state);
            const legacy = keyed
              ? await this.#legacyHistory(cached.state, options.history!(cached.state))
              : undefined;
            const transact = () =>
              this.#log.transactProjection<LedgerProjection, unknown, Value>(
                cached.state,
                (currentState, record, commit) =>
                  reduceAssignmentRecord(
                    this.#reductionEnv,
                    currentState === cached.state
                      ? structuredClone(currentState)
                      : currentState,
                    record,
                    commit,
                    receiptRetirement,
                  ),
                async (currentState, context) => {
                  withLeaseClock(
                    currentState,
                    await readLeaseClockSummary(
                      context.readProjection(this.#leaseClockProjectionId),
                    ),
                  );
                  if (keyed) {
                    await this.#hydrateHistory(
                      currentState,
                      context.readProjection(ASSIGNMENT_LEDGER_INDEX_ID),
                      options.history!(currentState),
                      legacy,
                    );
                  }
                  const decision = await decide(currentState, context);
                  if (decision.kind !== "append") return decision;
                  const resourceRecords = this.#prepareResourceTerminalRecords(
                    currentState,
                    decision.entries,
                  );
                  return {
                    ...decision,
                    entries: [
                      ...resourceRecords,
                      ...this.#leaseCompanions(decision.entries),
                      ...decision.entries,
                    ],
                  };
                },
                {
                  streams: [assignmentStream(assignmentId)],
                  cursor: cached.cursor,
                  candidateReferences,
                  readProjectionIds: [
                    ...readProjectionIds,
                    this.#leaseClockProjectionId,
                    ...(keyed ? [ASSIGNMENT_LEDGER_INDEX_ID] : []),
                  ],
                },
              );
            const transaction = await (this.#resources
              ? this.#resources.coordinate(transact, {
                  caller: "assignment-ledger",
                  ...(options.resourcePreparation
                    ? { prepare: options.resourcePreparation }
                    : {}),
                })
              : transact());
            if (!receiptRetirement) {
              this.#cacheProjection(assignmentId, {
                state: transaction.state,
                cursor: transaction.cursor,
              });
            }
            return transaction;
          } catch (error) {
            if (!receiptRetirement) {
              this.#projections.delete(assignmentId);
            }
            if (error instanceof HistoryLookupRequired && attempt === 0) continue;
            throw error;
          }
        }
      }),
    );
  }

  async #recoverProjection(
    assignmentId: string,
    receiptRetirement = false,
  ): Promise<{ readonly state: LedgerProjection; readonly cursor: ProjectionCursor }> {
    const recovered = await this.#recoverProjections([assignmentId], receiptRetirement);
    return { state: recovered.states.get(assignmentId)!, cursor: recovered.cursor };
  }

  async #recoverProjections(
    assignmentIds: readonly string[],
    receiptRetirement = false,
    fullHistory = false,
  ): Promise<{
    readonly states: ReadonlyMap<string, LedgerProjection>;
    readonly cursor: ProjectionCursor;
  }> {
    const decisions =
      receiptRetirement || fullHistory
        ? new Map<string, DecisionState>()
        : await this.#loadDecisionStates(assignmentIds);
    type Recovered = {
      readonly envelopes: readonly CommitEnvelope<unknown>[];
      readonly keyed: boolean;
      readonly history?: Awaited<ReturnType<typeof readAssignmentHistory>>;
    };
    const read = await this.#log.transactDurableProjection<
      unknown,
      ReadonlyMap<string, Recovered>
    >(ASSIGNMENT_LEDGER_INDEX_ID, async (current) => {
      const recovered = new Map<string, Recovered>();
      for (const assignmentId of assignmentIds) {
        const saved = decisions.get(assignmentId);
        if (saved) {
          const envelopes = await readAssignmentEnvelopesAfter(
            current,
            assignmentId,
            saved.coveredLsn,
          );
          const requests = omitsHistory(saved.state)
            ? tailInteractionRequestIds(assignmentId, envelopes)
            : [];
          recovered.set(assignmentId, {
            envelopes,
            keyed: saved.state.keyed === true,
            ...(requests.length > 0
              ? {
                  history: await readAssignmentHistory(
                    current,
                    assignmentId,
                    { requests },
                    saved.state.historyBase!,
                  ),
                }
              : {}),
          });
        } else {
          const envelopes = await readAssignmentEnvelopes(current, assignmentId);
          recovered.set(assignmentId, {
            envelopes,
            keyed:
              envelopes.length === 0 ||
              (await hasAssignmentHistoryKeys(current, assignmentId)),
          });
        }
      }
      return { kind: "return", value: recovered };
    });
    const states = new Map<string, LedgerProjection>();
    for (const assignmentId of assignmentIds) {
      const saved = decisions.get(assignmentId);
      const recovered = read.value.get(assignmentId)!;
      if (saved) {
        try {
          let state = restoreDecisionState(saved.state);
          if (omitsHistory(state)) {
            const requests = tailInteractionRequestIds(assignmentId, recovered.envelopes);
            const legacy =
              requests.length > 0
                ? await this.#legacyHistory(state, { requests })
                : undefined;
            await this.#applyHistory(
              state,
              requests,
              [],
              [],
              withLegacyHistory(recovered.history, legacy, { requests }),
            );
          }
          const stream = assignmentStream(assignmentId);
          for (const envelope of recovered.envelopes) {
            for (const record of envelope.entries) {
              if (record.stream === stream) {
                state = await reduceAssignmentRecord(
                  this.#reductionEnv,
                  state,
                  record,
                  envelope,
                  receiptRetirement,
                );
              }
            }
          }
          await this.#recheckRestoredState(state);
          states.set(assignmentId, state);
          this.#scheduleDecisionSave(assignmentId, state, read.cursor);
          continue;
        } catch (error) {
          this.#decisionPending.delete(assignmentId);
          await this.#recoverProjections([assignmentId], receiptRetirement, true);
          throw error;
        }
      }
      const stream = assignmentStream(assignmentId);
      let state = emptyProjection(assignmentId);
      if (recovered.keyed) state.keyed = true;
      for (const envelope of recovered.envelopes) {
        for (const record of envelope.entries) {
          if (record.stream === stream) {
            state = await reduceAssignmentRecord(
              this.#reductionEnv,
              state,
              record,
              envelope,
              receiptRetirement,
            );
          }
        }
      }
      states.set(assignmentId, state);
      if (!receiptRetirement) {
        this.#scheduleDecisionSave(assignmentId, state, read.cursor);
      }
    }
    return { states, cursor: read.cursor };
  }

  async #loadDecisionStates(
    assignmentIds: readonly string[],
  ): Promise<Map<string, DecisionState>> {
    const decisions = new Map<string, DecisionState>();
    for (const assignmentId of assignmentIds) {
      const pending = this.#decisionPending.get(assignmentId);
      if (pending) {
        decisions.set(assignmentId, {
          coveredLsn: pending.cursor.lsn,
          state: pending.state,
        });
        continue;
      }
      const saved = await this.#log.loadProjectionCheckpoint?.<unknown>(
        this.#decisionStateKey(assignmentId),
      );
      const item = saved?.state as
        | { coveredLsn?: unknown; state?: LedgerProjection }
        | undefined;
      if (
        saved &&
        item &&
        Number.isSafeInteger(item.coveredLsn) &&
        (item.coveredLsn as number) > 0 &&
        (item.coveredLsn as number) <= saved.cursor.lsn &&
        item.state &&
        typeof item.state === "object" &&
        item.state.assignmentId === assignmentId &&
        Number.isSafeInteger(item.state.lastSeq) &&
        item.state.lastSeq > 0 &&
        (item.state.legacyHistoryUpTo === undefined ||
          (Number.isSafeInteger(item.state.legacyHistoryUpTo) &&
            item.state.legacyHistoryUpTo > 0 &&
            item.state.legacyHistoryUpTo <= item.state.lastSeq &&
            typeof item.state.legacyHistoryGeneration === "string" &&
            validLegacyPages(item.state.legacyHistoryPages)))
      ) {
        decisions.set(assignmentId, {
          coveredLsn: item.coveredLsn as number,
          state: item.state,
        });
      }
    }
    return decisions;
  }

  async #recheckRestoredState(state: LedgerProjection): Promise<void> {
    if (state.received) {
      const envelope = await this.#loadAssignmentEnvelope(
        state.assignmentId,
        state.received.body.envelope.ref,
      );
      if (envelope.executorId !== this.#executorId) {
        throw corruptLedger(
          "received dispatch targets a different assignment or executor",
        );
      }
      await assertEnvelopeArtifactsPresent(envelope, this.#artifacts);
    }
    for (const request of state.pendingRequests.values()) {
      await materializeInteractionDisplay(request.body.display, this.#artifacts);
    }
  }

  async #hydrateHistory(
    state: LedgerProjection,
    view: DurableProjectionReadContext,
    needs: AssignmentHistoryNeeds,
    legacy: LegacyHistory | undefined,
  ): Promise<void> {
    const requests = (needs.requests ?? []).filter(
      (id) => !state.requested.has(id) && !state.historyChecked?.has(id),
    );
    const effects = (needs.effects ?? []).filter(
      (effectSeq) => !state.sideEffects.has(effectSeq),
    );
    const mirrorSeqs = (needs.mirrorSeqs ?? []).filter(
      (seq) =>
        !state.finishedIndexBySeq.has(seq) && !state.historicMirror?.has(seq),
    );
    if (requests.length === 0 && effects.length === 0 && mirrorSeqs.length === 0) {
      return;
    }
    const rows = await readAssignmentHistory(
      view,
      state.assignmentId,
      { requests, effects, mirrorSeqs },
      state.historyBase!,
    );
    await this.#applyHistory(
      state,
      requests,
      effects,
      mirrorSeqs,
      withLegacyHistory(rows, legacy, { requests, effects, mirrorSeqs }),
    );
  }

  async #legacyHistory(
    state: LedgerProjection,
    needs: AssignmentHistoryNeeds,
  ): Promise<LegacyHistory | undefined> {
    const upTo = state.legacyHistoryUpTo;
    const generation = state.legacyHistoryGeneration;
    const pages = state.legacyHistoryPages;
    if (!upTo) return undefined;
    const merged: LegacyHistory = {
      generation: generation!,
      upToSeq: upTo,
      requests: new Map(),
      finished: new Map(),
      effectStarts: new Map(),
      effectEnds: new Map(),
      mirror: new Map(),
    };
    const wanted = new Map<
      string,
      { category: LegacyHistoryCategory; page: number }
    >();
    const want = (category: LegacyHistoryCategory, key: string | number) => {
      const page = legacyPageOf(category, key, pages![category]);
      wanted.set(this.#legacyHistoryKey(state.assignmentId, category, page), {
        category,
        page,
      });
    };
    if (pages) {
      for (const requestId of needs.requests ?? []) want("requests", requestId);
      for (const effectSeq of needs.effects ?? []) want("effects", effectSeq);
      for (const seq of needs.mirrorSeqs ?? []) want("mirror", seq);
    }
    const cache =
      this.#legacyHistories.get(state.assignmentId) ??
      new Map<string, LegacyHistoryPage>();
    this.#legacyHistories.set(state.assignmentId, cache);
    for (const [key, slot] of wanted) {
      let page = cache.get(key);
      if (!page || page.generation !== generation) {
        page = (
          await this.#log
            .loadProjectionCheckpoint?.<LegacyHistoryPage>(key)
            ?.catch(() => undefined)
        )?.state;
        if (
          !isLegacyHistoryPage(
            page,
            generation!,
            upTo,
            slot.category,
            slot.page,
            pages![slot.category],
          )
        ) {
          this.#decisionPending.delete(state.assignmentId);
          this.#legacyBackfilled.delete(state.assignmentId);
          this.#legacyHistories.delete(state.assignmentId);
          await this.#log
            .deleteProjectionCheckpoint?.(this.#decisionStateKey(state.assignmentId))
            ?.catch(() => {});
          throw new HistoryLookupRequired();
        }
        cache.set(key, page);
      }
      for (const name of [
        "requests",
        "finished",
        "effectStarts",
        "effectEnds",
        "mirror",
      ] as const) {
        for (const [factKey, fact] of page[name] as Map<unknown, never>) {
          (merged[name] as Map<unknown, unknown>).set(factKey, fact);
        }
      }
    }
    if (
      !pages &&
      wanted.size === 0 &&
      (needs.requests?.length ?? 0) +
        (needs.effects?.length ?? 0) +
        (needs.mirrorSeqs?.length ?? 0) >
        0
    ) {
      throw new HistoryLookupRequired();
    }
    return merged;
  }

  #legacyHistoryKey(
    assignmentId: string,
    category?: LegacyHistoryCategory,
    page?: number,
  ): string {
    const base = `${projectionCheckpointKey(
      "executor-assignment-legacy-history",
      1,
    )}:${this.#executorId}:${assignmentId}`;
    return category === undefined ? base : `${base}:${category}:${page}`;
  }

  async #deleteLegacyHistory(
    assignmentId: string,
    pages: LegacyHistoryPages | undefined,
  ): Promise<void> {
    await this.#log
      .deleteProjectionCheckpoint?.(this.#legacyHistoryKey(assignmentId))
      ?.catch(() => {});
    if (!pages) return;
    for (const category of ["requests", "effects", "mirror"] as const) {
      for (let page = 0; page < pages[category]; page++) {
        await this.#log
          .deleteProjectionCheckpoint?.(
            this.#legacyHistoryKey(assignmentId, category, page),
          )
          ?.catch(() => {});
      }
    }
  }

  async #applyHistory(
    state: LedgerProjection,
    requests: readonly string[],
    effects: readonly number[],
    mirrorSeqs: readonly number[],
    rows: Awaited<ReturnType<typeof readAssignmentHistory>> | undefined,
  ): Promise<void> {
    const checked = (state.historyChecked ??= new Set());
    for (const requestId of requests) {
      checked.add(requestId);
      const found = rows?.requests.get(requestId);
      const finished = rows?.finished.get(requestId) as unknown as
        | FinishedInteraction
        | undefined;
      if (!found) {
        if (finished) {
          throw corruptLedger(
            "Interaction result has no durable request in the keyed history",
          );
        }
        continue;
      }
      if (
        finished &&
        (finished.body.requestId !== requestId || finished.recordSeq <= found.seq)
      ) {
        throw corruptLedger(
          "Interaction result does not follow its durable request in the keyed history",
        );
      }
      const body = found.body as unknown as RequestedInteraction["body"];
      await materializeInteractionDisplay(body.display, this.#artifacts);
      state.requested.set(requestId, { body, recordSeq: found.seq });
      state.validation.requestedInteractions.add(requestId);
      if (finished) state.finished.set(requestId, finished);
    }
    for (const effectSeq of effects) {
      const started = rows?.effectStarts.get(effectSeq);
      const completed = rows?.effectEnds.get(effectSeq);
      if (!started) {
        if (completed) {
          throw corruptLedger(
            "Side-effect completion has no durable start in the keyed history",
          );
        }
        continue;
      }
      if (
        completed &&
        started.seq !== undefined &&
        completed.seq !== undefined &&
        completed.seq <= started.seq
      ) {
        throw corruptLedger(
          "Side-effect completion does not follow its durable start in the keyed history",
        );
      }
      state.sideEffects.set(effectSeq, {
        started: started.body as unknown as Extract<
          AssignmentRecord,
          { t: "side-effect-started" }
        >,
        ...(completed
          ? {
              completed: completed.body as unknown as Extract<
                AssignmentRecord,
                { t: "side-effect-completed" }
              >,
            }
          : {}),
      });
    }
    for (const seq of mirrorSeqs) {
      const found = rows?.mirror.get(seq);
      if (found) {
        (state.historicMirror ??= new Map()).set(
          seq,
          found as unknown as MirrorChainItem,
        );
      }
    }
  }

  #scheduleDecisionSave(
    assignmentId: string,
    state: LedgerProjection,
    cursor: ProjectionCursor,
  ): void {
    if (!this.#log.saveProjectionCheckpoint || state.lastSeq <= 0) return;
    if (state.keyed) {
      this.#decisionPending.set(assignmentId, {
        state: decisionSnapshot(state),
        cursor,
      });
    } else {
      const backfilled = this.#legacyBackfilled.get(assignmentId);
      if (backfilled !== undefined) {
        this.#decisionPending.set(assignmentId, {
          state: decisionSnapshot({
            ...state,
            keyed: true,
            legacyHistoryUpTo: backfilled.upToSeq,
            legacyHistoryGeneration: backfilled.generation,
            legacyHistoryPages: backfilled.pages,
          }),
          cursor,
        });
      } else {
        const legacy = pageLegacyHistory(legacyHistoryOf(state));
        this.#legacyHistories.set(
          assignmentId,
          new Map(
            legacy.files.map(
              (file) =>
                [
                  this.#legacyHistoryKey(assignmentId, file.category, file.page),
                  file,
                ] as const,
            ),
          ),
        );
        this.#decisionPending.set(assignmentId, {
          state: decisionSnapshot({
            ...state,
            keyed: true,
            legacyHistoryUpTo: legacy.upToSeq,
            legacyHistoryGeneration: legacy.generation,
            legacyHistoryPages: legacy.pages,
          }),
          cursor,
          legacy,
          fallback: decisionSnapshot(state),
        });
      }
    }
    if (this.#decisionSave) return;
    this.#decisionSave = setTimeout(() => {
      this.#decisionSave = undefined;
      void this.#writeDecisionStates();
    }, DECISION_STATE_SAVE_DELAY_MS);
    this.#decisionSave.unref?.();
  }

  #writeDecisionStates(): Promise<void> {
    const batch = [...this.#decisionPending];
    this.#decisionPending.clear();
    this.#decisionWrite = this.#decisionWrite.then(async () => {
      for (const [id, { state: item, cursor: at, legacy, fallback }] of batch) {
        if (item.phase === "acked" || item.phase === "dispatch-rejected") {
          await this.#log
            .deleteProjectionCheckpoint?.(this.#decisionStateKey(id))
            ?.catch(() => {});
          await this.#deleteLegacyHistory(
            id,
            item.legacyHistoryPages ?? this.#legacyBackfilled.get(id)?.pages,
          );
          this.#legacyBackfilled.delete(id);
          this.#legacyHistories.delete(id);
          continue;
        }
        if (legacy) {
          for (const file of legacy.files) {
            await this.#log
              .saveProjectionCheckpoint?.(
                this.#legacyHistoryKey(id, file.category, file.page),
                at,
                file,
              )
              ?.catch(() => {});
          }
          let durable = true;
          for (const file of legacy.files) {
            const written = await this.#log
              .loadProjectionCheckpoint?.<LegacyHistoryPage>(
                this.#legacyHistoryKey(id, file.category, file.page),
              )
              ?.catch(() => undefined);
            if (
              !written ||
              written.cursor.lsn !== at.lsn ||
              !isLegacyHistoryPage(
                written.state,
                legacy.generation,
                legacy.upToSeq,
                file.category,
                file.page,
                file.pages,
              )
            ) {
              durable = false;
              break;
            }
          }
          if (!durable) {
            await this.#log
              .saveProjectionCheckpoint?.(this.#decisionStateKey(id), at, {
                coveredLsn: at.lsn,
                state: fallback,
              })
              ?.catch(() => {});
            continue;
          }
          this.#legacyBackfilled.set(id, {
            upToSeq: legacy.upToSeq,
            generation: legacy.generation,
            pages: legacy.pages,
          });
          await this.#log
            .deleteProjectionCheckpoint?.(this.#legacyHistoryKey(id))
            ?.catch(() => {});
        }
        await this.#log
          .saveProjectionCheckpoint?.(this.#decisionStateKey(id), at, {
            coveredLsn: at.lsn,
            state: item,
          })
          ?.catch(() => {});
      }
    });
    return this.#decisionWrite;
  }

  #leaseCompanions(
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const times = entries
      .filter((entry) => entry.stream.startsWith("assignment:"))
      .map((entry) => (entry.body as AssignmentEntry).body)
      .filter((body) => body.v === 3)
      .map((body) => leaseTime(body.effectiveAcceptedAt));
    if (times.length === 0) return [];
    if (times.some((time) => time !== times[0])) {
      throw new TypeError("Lease acceptances in one commit must share time");
    }
    return [leaseClockRecord(this.#executorId, times[0]!)];
  }

  #prepareResourceTerminalRecords(
    state: LedgerProjection,
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const terminal = entries
      .filter((record) => record.stream === assignmentStream(state.assignmentId))
      .map((record) => record.body)
      .find((raw): raw is AssignmentEntry => {
        if (typeof raw !== "object" || raw === null || !("body" in raw)) return false;
        const body = raw.body;
        return (
          typeof body === "object" &&
          body !== null &&
          "t" in body &&
          (body.t === "bundle_sealed" ||
            body.t === "halted" ||
            body.t === "execution-failed" ||
            body.t === "supersede-fenced")
        );
      });
    if (!terminal) return [];
    const lease = state.received?.resourceLease;
    if (!lease) return [];
    if (!requiresExecutorResourceReceipt(lease)) return [];
    if (!this.#resources) {
      throw corruptLedger("Governed assignment has no executor resource coordinator");
    }
    if (this.#resources.assignmentRootState(lease) === "reclaimed") {
      throw new AssignmentExecutionResourceRetiredError(state.assignmentId);
    }
    const mode =
      terminal.body.t === "supersede-fenced" ||
      (terminal.body.t === "halted" && terminal.body.proof.decision === "not-started")
        ? "release"
        : "settle-release";
    return this.#resources.prepareTerminal({ lease, mode });
  }

  #takeCachedProjection(
    assignmentId: string,
  ): { readonly state: LedgerProjection; readonly cursor: ProjectionCursor } | undefined {
    const cached = this.#projections.get(assignmentId);
    if (!cached) return undefined;
    this.#projections.delete(assignmentId);
    return cached;
  }

  #cacheProjection(
    assignmentId: string,
    cached: { readonly state: LedgerProjection; readonly cursor: ProjectionCursor },
  ): void {
    this.#projections.set(assignmentId, cached);
    this.#scheduleDecisionSave(assignmentId, cached.state, cached.cursor);
    while (this.#projections.size > this.#maxCachedAssignments) {
      const oldest = this.#projections.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#projections.delete(oldest);
    }
  }
}

function freezeInPlaceRecursive<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      freezeInPlaceRecursive(value[index]);
    }
    return Object.freeze(value) as DeepReadonly<T>;
  }
  for (const key of Object.keys(value)) {
    freezeInPlaceRecursive((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function detachDeepReadonly<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }
  return freezeInPlaceRecursive(structuredClone(value));
}

function freezeReceivedState(
  received: LedgerReceivedState | undefined,
): ReadonlyLedgerReceivedState | undefined {
  return received ? detachDeepReadonly(received) : undefined;
}

function freezeControlState(
  control: LedgerControlState | undefined,
): DeepReadonly<LedgerControlState> | undefined {
  return control ? detachDeepReadonly(control) : undefined;
}

function freezeRejectionState(
  rejection: LedgerRejectionState | undefined,
): DeepReadonly<LedgerRejectionState> | undefined {
  return rejection ? detachDeepReadonly(rejection) : undefined;
}

function freezeStartedState(
  started: LedgerStartedState | undefined,
): DeepReadonly<LedgerStartedState> | undefined {
  return started ? detachDeepReadonly(started) : undefined;
}

function freezeSupersedeFenceState(
  supersedeFence: LedgerSupersedeFenceState | undefined,
): DeepReadonly<LedgerSupersedeFenceState> | undefined {
  return supersedeFence ? detachDeepReadonly(supersedeFence) : undefined;
}

function findLatestAbort(
  state: LedgerProjection,
  via?: "owner-fence" | "abort-ticket",
): DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>> | undefined {
  for (let index = state.aborts.length - 1; index >= 0; index -= 1) {
    const abort = state.aborts[index]!;
    if (via === undefined || abort.via === via) {
      return detachDeepReadonly(abort);
    }
  }
  return undefined;
}

function hasMatchingAbort(
  state: LedgerProjection,
  predicate: (
    abort: DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>>,
  ) => boolean,
): boolean {
  for (const abort of state.aborts) {
    if (predicate(detachDeepReadonly(abort))) return true;
  }
  return false;
}

function findFirstValidationTicketAbort(
  state: LedgerProjection,
): DeepReadonly<ValidationTicketAbortFact> | undefined {
  for (const candidate of state.validation.aborts.values()) {
    if (candidate.via === "abort-ticket") {
      return Object.freeze({
        refId: candidate.refId,
        recordSeq: candidate.recordSeq,
        ledgerDigest: candidate.ledgerDigest,
      });
    }
  }
  return undefined;
}

function snapshotPendingRequests(
  state: LedgerProjection,
): readonly DeepReadonly<RequestedInteraction>[] {
  return Object.freeze(
    [...state.pendingRequests.values()].map((request) =>
      detachDeepReadonly({ body: request.body, recordSeq: request.recordSeq }),
    ),
  );
}

function hasOpenSideEffectEntries(state: LedgerProjection): boolean {
  for (const effect of state.sideEffects.values()) {
    if (!effect.completed) return true;
  }
  return false;
}

export function toExecutionControlFacts(state: LedgerProjection): ExecutionControlFacts {
  return Object.freeze({
    get assignmentId() {
      return state.assignmentId;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    get chainDigest() {
      return state.chainDigest;
    },
    get phase() {
      return state.phase;
    },
    get leaseTimeFrontier() {
      return state.leaseTimeFrontier;
    },
    get leaseAcceptanceFloor() {
      return state.leaseAcceptanceFloor;
    },
    get control() {
      return freezeControlState(state.control);
    },
    get received() {
      return freezeReceivedState(state.received);
    },
    get rejection() {
      return freezeRejectionState(state.rejection);
    },
    get started() {
      return freezeStartedState(state.started);
    },
    get supersedeFence() {
      return freezeSupersedeFenceState(state.supersedeFence);
    },
    get halted() {
      return state.halted ? detachDeepReadonly(state.halted) : undefined;
    },
    get hasAborts() {
      return state.aborts.length > 0;
    },
    hasAbortMatching(
      predicate: (
        abort: DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>>,
      ) => boolean,
    ) {
      return hasMatchingAbort(state, predicate);
    },
    pendingRequestsSnapshot() {
      return snapshotPendingRequests(state);
    },
    get sideEffectCount() {
      return state.validation.sideEffectCount;
    },
    get hasOpenSideEffects() {
      return hasOpenSideEffectEntries(state);
    },
    get hasPendingInteractionObligations() {
      return hasPendingInteractionObligations(state);
    },
  });
}

export function toInteractionEffectFacts(state: LedgerProjection): InteractionEffectFacts {
  return Object.freeze({
    get assignmentId() {
      return state.assignmentId;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    get phase() {
      return state.phase;
    },
    get control() {
      return freezeControlState(state.control);
    },
    get received() {
      return freezeReceivedState(state.received);
    },
    get supersedeFence() {
      return freezeSupersedeFenceState(state.supersedeFence);
    },
    get hasAborts() {
      return state.aborts.length > 0;
    },
    latestAbort(via?: "owner-fence" | "abort-ticket") {
      return findLatestAbort(state, via);
    },
    firstValidationTicketAbort() {
      return findFirstValidationTicketAbort(state);
    },
    get sideEffectCount() {
      return state.validation.sideEffectCount;
    },
    get hasOpenSideEffects() {
      return hasOpenSideEffectEntries(state);
    },
    sideEffectBySeq(effectSeq: number) {
      const effect = state.sideEffects.get(effectSeq);
      if (!effect) return undefined;
      return detachDeepReadonly({
        started: effect.started,
        ...(effect.completed ? { completed: effect.completed } : {}),
      });
    },
    get trustSedimentCount() {
      return state.validation.trustSedimentCount;
    },
    get trustRuleHitCount() {
      return state.validation.trustRuleHitCount;
    },
    get interactionMirrorDigest() {
      return state.validation.interactionMirrorDigest;
    },
    get lastFinishedInteractionRecordSeq() {
      return state.validation.lastFinishedInteractionRecordSeq;
    },
    get needsStreamProof() {
      return interactionSettlementNeedsStreamProof(state.validation);
    },
    hasRequested(requestId: string) {
      return state.requested.has(requestId);
    },
    requestedById(requestId: string) {
      const item = state.requested.get(requestId);
      return item
        ? detachDeepReadonly({ body: item.body, recordSeq: item.recordSeq })
        : undefined;
    },
    get pendingRequestCount() {
      return state.pendingRequests.size;
    },
    pendingRequestsSnapshot() {
      return snapshotPendingRequests(state);
    },
    finishedById(requestId: string) {
      const item = state.finished.get(requestId);
      return item ? detachDeepReadonly(item) : undefined;
    },
    get finishedCount() {
      return finishedCount(state);
    },
    interactionProjectionSourceIdsBetween(
      afterRecordSeq: number,
      upToRecordSeq: number,
    ) {
      const records: number[] = [];
      for (const item of state.requested.values()) {
        if (item.recordSeq > afterRecordSeq && item.recordSeq <= upToRecordSeq) {
          records.push(item.recordSeq);
        }
      }
      for (const item of state.finished.values()) {
        if (item.recordSeq > afterRecordSeq && item.recordSeq <= upToRecordSeq) {
          records.push(item.recordSeq);
        }
      }
      records.sort((left, right) => left - right);
      return Object.freeze(records.map((recordSeq) => `interaction:${recordSeq}`));
    },
    get streamProjectionEnabledAfter() {
      return state.streamProjectionEnabledAfter;
    },
    get streamProjectedUpTo() {
      return state.streamProjectedUpTo;
    },
    get lastInteractionStreamSeq() {
      return state.lastInteractionStreamSeq;
    },
    get interactionStreamDigest() {
      return state.interactionStreamDigest;
    },
    get lastStreamProjectionRecordSeq() {
      return state.lastStreamProjectionRecordSeq;
    },
    get lastStreamProjectionDigest() {
      return state.lastStreamProjectionDigest;
    },
    get historyInteractionUpTo() {
      return state.historyInteractionUpTo;
    },
  });
}

export function toSealingEvidenceFacts(state: LedgerProjection): SealingEvidenceFacts {
  return Object.freeze({
    get assignmentId() {
      return state.assignmentId;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    get phase() {
      return state.phase;
    },
    get received() {
      return freezeReceivedState(state.received);
    },
    get sealed() {
      return state.sealed ? detachDeepReadonly(state.sealed) : undefined;
    },
    get halted() {
      return state.halted ? detachDeepReadonly(state.halted) : undefined;
    },
    get failure() {
      return state.failure ? detachDeepReadonly(state.failure) : undefined;
    },
    get hasAborts() {
      return state.aborts.length > 0;
    },
    get stagedMutationCount() {
      return state.stagedMutations.length;
    },
    hasMutationRequestId(requestId: string) {
      return state.mutationRequestIds.has(requestId);
    },
    stagedMutationForRequestId(requestId: string) {
      const item = state.stagedMutationByRequestId.get(requestId);
      return item ? detachDeepReadonly(item) : undefined;
    },
    stagedMutationsSnapshot() {
      return Object.freeze(
        state.stagedMutations.map((item) => detachDeepReadonly(item)),
      );
    },
    get hasOpenSideEffects() {
      return hasOpenSideEffectEntries(state);
    },
    get hasPendingInteractionObligations() {
      return hasPendingInteractionObligations(state);
    },
  });
}

export function toReceiptRecoveryFacts(state: LedgerProjection): ReceiptRecoveryFacts {
  return Object.freeze({
    get assignmentId() {
      return state.assignmentId;
    },
    get lastSeq() {
      return state.lastSeq;
    },
    get phase() {
      return state.phase;
    },
    get received() {
      return freezeReceivedState(state.received);
    },
    get started() {
      return freezeStartedState(state.started);
    },
    get supersedeFence() {
      return freezeSupersedeFenceState(state.supersedeFence);
    },
    get halted() {
      return state.halted ? detachDeepReadonly(state.halted) : undefined;
    },
    get hasAborts() {
      return state.aborts.length > 0;
    },
    hasAbortMatching(
      predicate: (
        abort: DeepReadonly<Extract<AssignmentRecord, { t: "abort-requested" }>>,
      ) => boolean,
    ) {
      return hasMatchingAbort(state, predicate);
    },
    latestAbort(via?: "owner-fence" | "abort-ticket") {
      return findLatestAbort(state, via);
    },
    firstValidationTicketAbort() {
      return findFirstValidationTicketAbort(state);
    },
    get acknowledgedCommitRevision() {
      return state.acknowledgedCommitRevision;
    },
    get streamProjectionEnabledAfter() {
      return state.streamProjectionEnabledAfter;
    },
    get cancelProofOwnerAccepted() {
      return state.validation.cancelProofOwnerAccepted;
    },
    get interactionSettlementOwnerAccepted() {
      return detachDeepReadonly(state.validation.interactionSettlementOwnerAccepted);
    },
    get mirroredInteractionOrdinal() {
      return state.mirroredInteractionOrdinal;
    },
    get mirroredInteractionDigest() {
      return state.mirroredInteractionDigest;
    },
    get mirroredFinishedCount() {
      return state.mirroredFinishedCount;
    },
    get finishedCount() {
      return finishedCount(state);
    },
    finishedIndexAtSeq(seq: number) {
      return state.finishedIndexBySeq.get(seq);
    },
    historicMirrorAt(seq: number) {
      const item = state.historicMirror?.get(seq);
      return item ? detachDeepReadonly(item) : undefined;
    },
    finishedAt(index: number) {
      const item = finishedAt(state, index);
      return item ? detachDeepReadonly(item) : undefined;
    },
  });
}

function ledgerEvidencePayload(
  assignmentId: string,
  executorId: string,
  entries: readonly AssignmentEntry[],
  chainDigestAt: (recordSeq: number) => string,
) {
  return {
    v: 1 as const,
    assignmentId,
    fromSeq: entries[0]!.recordSeq,
    toSeq: entries.at(-1)!.recordSeq,
    entries: snapshot([...entries], "Ledger evidence entries"),
    chainDigest: chainDigestAt(entries.at(-1)!.recordSeq),
    executorId,
  };
}

function streamInteractionOutcome(
  outcome: Extract<
    AssignmentRecord,
    { readonly t: "interaction-finished" }
  >["outcome"],
): "allowed" | "denied" | "cancelled" | "expired" {
  switch (outcome.t) {
    case "answered":
      return outcome.decision.allowed ? "allowed" : "denied";
    case "auto-resolved":
      return "denied";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
  }
}

function interactionStreamEventsOf(
  state: LedgerProjection,
): DurableInteractionStreamEvent[] {
  const events: DurableInteractionStreamEvent[] = [];
  for (const requested of state.requested.values()) {
    events.push({
      recordSeq: requested.recordSeq,
      payload: {
        kind: "interaction",
        event: {
          t: "requested",
          requestId: requested.body.requestId,
          toolName: requested.body.toolName,
          display: snapshot(
            requested.body.display,
            "Interaction stream display",
          ),
          issuedAt: requested.body.issuedAt,
          ttlMs: requested.body.ttlMs,
          expiresAt: requested.body.expiresAt,
        },
      },
    });
  }
  for (const finished of state.finished.values()) {
    events.push({
      recordSeq: finished.recordSeq,
      payload: {
        kind: "interaction",
        event: {
          t: "finished",
          requestId: finished.body.requestId,
          outcome: streamInteractionOutcome(finished.body.outcome),
        },
      },
    });
  }
  return events.sort((left, right) => left.recordSeq - right.recordSeq);
}

function legacyHistoryOf(state: LedgerProjection): LegacyHistory {
  const requests = new Map<string, { seq: number; body: JsonValue }>();
  for (const [requestId, item] of state.requested) {
    requests.set(requestId, {
      seq: item.recordSeq,
      body: item.body as unknown as JsonValue,
    });
  }
  const finished = new Map<string, JsonValue>();
  for (const [requestId, item] of state.finished) {
    finished.set(requestId, item as unknown as JsonValue);
  }
  const effectStarts = new Map<number, { body: JsonValue }>();
  const effectEnds = new Map<number, { body: JsonValue }>();
  for (const [effectSeq, effect] of state.sideEffects) {
    effectStarts.set(effectSeq, {
      body: effect.started as unknown as JsonValue,
    });
    if (effect.completed) {
      effectEnds.set(effectSeq, {
        body: effect.completed as unknown as JsonValue,
      });
    }
  }
  const mirror = new Map<number, JsonValue>();
  for (const item of state.finishedOrder) {
    mirror.set(item.recordSeq, item as unknown as JsonValue);
  }
  return structuredClone({
    generation: randomUUID(),
    upToSeq: state.lastSeq,
    requests,
    finished,
    effectStarts,
    effectEnds,
    mirror,
  });
}

function legacyPageOf(
  category: LegacyHistoryCategory,
  key: string | number,
  pages: number,
): number {
  return (
    createHash("sha256")
      .update(`${category}\0${key}`, "utf8")
      .digest()
      .readUInt32BE(0) % pages
  );
}

function pageLegacyHistory(legacy: LegacyHistory) {
  const requestIds = new Set([...legacy.requests.keys(), ...legacy.finished.keys()]);
  const effectSeqs = new Set([
    ...legacy.effectStarts.keys(),
    ...legacy.effectEnds.keys(),
  ]);
  const count = (keys: number) => Math.max(1, Math.ceil(keys / LEGACY_HISTORY_PAGE_KEYS));
  const pages: LegacyHistoryPages = {
    requests: count(requestIds.size),
    effects: count(effectSeqs.size),
    mirror: count(legacy.mirror.size),
  };
  const byCategory: Record<LegacyHistoryCategory, LegacyHistoryPage[]> = {
    requests: [],
    effects: [],
    mirror: [],
  };
  for (const category of ["requests", "effects", "mirror"] as const) {
    for (let page = 0; page < pages[category]; page++) {
      byCategory[category].push({
        generation: legacy.generation,
        upToSeq: legacy.upToSeq,
        category,
        page,
        pages: pages[category],
        requests: new Map(),
        finished: new Map(),
        effectStarts: new Map(),
        effectEnds: new Map(),
        mirror: new Map(),
      });
    }
  }
  const pageOf = (category: LegacyHistoryCategory, key: string | number) =>
    byCategory[category][legacyPageOf(category, key, pages[category])]!;
  for (const requestId of requestIds) {
    const file = pageOf("requests", requestId);
    const requested = legacy.requests.get(requestId);
    const finished = legacy.finished.get(requestId);
    if (requested) file.requests.set(requestId, requested);
    if (finished !== undefined) file.finished.set(requestId, finished);
  }
  for (const effectSeq of effectSeqs) {
    const file = pageOf("effects", effectSeq);
    const started = legacy.effectStarts.get(effectSeq);
    const ended = legacy.effectEnds.get(effectSeq);
    if (started) file.effectStarts.set(effectSeq, started);
    if (ended) file.effectEnds.set(effectSeq, ended);
  }
  for (const [seq, item] of legacy.mirror) {
    pageOf("mirror", seq).mirror.set(seq, item);
  }
  return {
    generation: legacy.generation,
    upToSeq: legacy.upToSeq,
    pages,
    files: [...byCategory.requests, ...byCategory.effects, ...byCategory.mirror],
  };
}

function validLegacyPages(pages: unknown): pages is LegacyHistoryPages {
  const value = pages as LegacyHistoryPages | undefined;
  return (
    !!value &&
    typeof value === "object" &&
    (["requests", "effects", "mirror"] as const).every(
      (category) =>
        Number.isSafeInteger(value[category]) && value[category] > 0,
    )
  );
}

function isLegacyHistoryPage(
  page: LegacyHistoryPage | undefined,
  generation: string,
  upToSeq: number,
  category: LegacyHistoryCategory,
  index: number,
  pages: number,
): page is LegacyHistoryPage {
  return (
    !!page &&
    page.generation === generation &&
    page.upToSeq === upToSeq &&
    page.category === category &&
    page.page === index &&
    page.pages === pages &&
    page.requests instanceof Map &&
    page.finished instanceof Map &&
    page.effectStarts instanceof Map &&
    page.effectEnds instanceof Map &&
    page.mirror instanceof Map
  );
}

function withLegacyHistory(
  rows: AssignmentHistoryRows | undefined,
  legacy: LegacyHistory | undefined,
  needs: AssignmentHistoryNeeds,
): AssignmentHistoryRows | undefined {
  if (!legacy) return rows;
  const fill = <Key, Value>(
    own: ReadonlyMap<Key, Value> | undefined,
    old: ReadonlyMap<Key, Value>,
    keys: readonly Key[],
  ) => {
    const merged = new Map(own);
    for (const key of keys) {
      if (!merged.has(key) && old.has(key)) merged.set(key, old.get(key)!);
    }
    return merged;
  };
  const requests = needs.requests ?? [];
  const effects = needs.effects ?? [];
  return {
    requests: fill(rows?.requests, legacy.requests, requests),
    finished: fill(rows?.finished, legacy.finished, requests),
    effectStarts: fill(rows?.effectStarts, legacy.effectStarts, effects),
    effectEnds: fill(rows?.effectEnds, legacy.effectEnds, effects),
    mirror: fill(rows?.mirror, legacy.mirror, needs.mirrorSeqs ?? []),
  };
}

function tailInteractionRequestIds(
  assignmentId: string,
  envelopes: readonly CommitEnvelope<unknown>[],
): string[] {
  const stream = assignmentStream(assignmentId);
  const ids = new Set<string>();
  for (const envelope of envelopes) {
    for (const record of envelope.entries) {
      if (record.stream !== stream) continue;
      const body = (
        record.body as {
          readonly body?: { readonly t?: unknown; readonly requestId?: unknown };
        } | null
      )?.body;
      if (body?.t === "interaction-requested" && typeof body.requestId === "string") {
        ids.add(body.requestId);
      }
    }
  }
  return [...ids];
}
