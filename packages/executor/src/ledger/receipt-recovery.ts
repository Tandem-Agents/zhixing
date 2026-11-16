import {
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type AuthorityCommitLog,
  type DurableLogCheckpoint,
  type RebuildableDurableProjectionIndex,
} from "@zhixing-ai/core/authority";
import type {
  AssignmentRecord,
  AssignmentResourceLease,
  CancelProofBody,
  InteractionMirrorBatch,
  InteractionMirrorEntry,
  InteractionSettlementStreamProof,
  LedgerSnapshot,
} from "@zhixing-ai/core/contracts";
import {
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  createSignedAssignmentInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  currentMaintenanceUrgency,
  runDetachedDeviceCapacity,
  runDetachedMaintenanceContext,
  runWithMaintenanceUrgency,
  StorageMaintenanceCancelledError,
  type StorageMaintenanceUrgency,
} from "@zhixing-ai/core/resources";
import type { ExecutorAssignmentResourceCoordinator } from "../resource-governor.js";
import {
  assignmentRecord,
  JobRecoveryProjectionValueError,
  nextEntryFromSeq,
  type AbortCause,
  type ConversationEnvelope,
  type InteractionMirrorReceipt,
  type JobEnvelope,
  type JobRecoveryObligation,
  type JobRecoveryObligationPage,
  type ReceiptRecoveryFacts,
  type ReceiptWaiter,
} from "./contracts.js";
import {
  interactionMirrorRecordBytes,
  interactionMirrorRecordCapacityBytes,
  mirrorEntry,
} from "./interaction-effect.js";
import type { LedgerProjectionHistoryStore } from "./projection-history-store.js";
import {
  classifyJobRecoveryObligation,
  corruptJobRecoveryProjection,
  JOB_RECOVERY_KEY_PREFIX,
  jobRecoveryKey,
  validateJobRecoveryIndexValue,
} from "./state-replay.js";

const RECEIPT_URGENCY_RANK: Record<StorageMaintenanceUrgency, number> = {
  background: 0,
  recovery: 1,
  foreground: 2,
};

function strongestReceiptUrgency(
  waiters: readonly ReceiptWaiter[],
): StorageMaintenanceUrgency {
  let strongest: StorageMaintenanceUrgency = "background";
  for (const waiter of waiters) {
    if (
      !waiter.settled &&
      RECEIPT_URGENCY_RANK[waiter.urgency] > RECEIPT_URGENCY_RANK[strongest]
    ) {
      strongest = waiter.urgency;
    }
  }
  return strongest;
}

export interface LedgerReceiptRecoveryOptions {
  readonly store: LedgerProjectionHistoryStore;
  readonly log: AuthorityCommitLog;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly resources?: ExecutorAssignmentResourceCoordinator;
  readonly jobRecoveryIndex: RebuildableDurableProjectionIndex;
  readonly assignmentRecordV2Writes: boolean;
  readonly runReconcileSupersededReceipts?: () => Promise<number>;
  readonly requestAbort: (
    assignmentId: string,
    cause: AbortCause,
    complete?: boolean,
  ) => Promise<CancelProofBody | undefined>;
}

export class LedgerReceiptRecovery {
  readonly #store: LedgerProjectionHistoryStore;
  readonly #log: AuthorityCommitLog;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #resources: ExecutorAssignmentResourceCoordinator | undefined;
  readonly #jobRecoveryIndex: RebuildableDurableProjectionIndex;
  readonly #assignmentRecordV2Writes: boolean;
  readonly #runReconcileSupersededReceipts:
    | (() => Promise<number>)
    | undefined;
  #requestAbort: LedgerReceiptRecoveryOptions["requestAbort"];
  #receiptWaiters: ReceiptWaiter[] = [];
  #receiptDriving = false;
  #receiptsSettledAt: DurableLogCheckpoint | undefined;

  constructor(options: LedgerReceiptRecoveryOptions) {
    this.#store = options.store;
    this.#log = options.log;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#resources = options.resources;
    this.#jobRecoveryIndex = options.jobRecoveryIndex;
    this.#assignmentRecordV2Writes = options.assignmentRecordV2Writes;
    this.#runReconcileSupersededReceipts =
      options.runReconcileSupersededReceipts;
    this.#requestAbort = options.requestAbort;
  }

  bindRequestAbort(
    requestAbort: LedgerReceiptRecoveryOptions["requestAbort"],
  ): void {
    this.#requestAbort = requestAbort;
  }

  reconcileSupersededReceipts(): Promise<number> {
    if (!this.#resources) return Promise.resolve(0);
    const abort = currentMaintenanceAbortSignal();
    if (abort.aborted) {
      return Promise.reject(new StorageMaintenanceCancelledError());
    }
    return new Promise<number>((resolve, reject) => {
      const cancel = () => {
        this.#receiptWaiters = this.#receiptWaiters.filter(
          (item) => item !== waiter,
        );
        waiter.reject(new StorageMaintenanceCancelledError());
      };
      const waiter: ReceiptWaiter = {
        urgency: currentMaintenanceUrgency(),
        settled: false,
        resolve: (value) => {
          if (waiter.settled) return;
          waiter.settled = true;
          abort.removeEventListener("abort", cancel);
          resolve(value);
        },
        reject: (error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          abort.removeEventListener("abort", cancel);
          reject(error);
        },
      };
      abort.addEventListener("abort", cancel, { once: true });
      this.#receiptWaiters.push(waiter);
      if (!this.#receiptDriving) void this.#driveReceiptPasses();
    });
  }

  async sealedConversationAssignmentsAwaitingAcknowledgement(): Promise<
    readonly ConversationEnvelope[]
  > {
    const phases = new Set<LedgerSnapshot["phase"]>(["sealed"]);
    return this.#store.conversationAssignmentsMatching(
      (facts) => phases.has(facts.phase),
      (candidate) => phases.has(candidate.phase),
    );
  }

  async recoverableConversationAssignments(): Promise<
    readonly ConversationEnvelope[]
  > {
    await (this.#runReconcileSupersededReceipts
      ? this.#runReconcileSupersededReceipts()
      : this.reconcileSupersededReceipts());
    const phases = new Set<LedgerSnapshot["phase"]>(["received", "sealed"]);
    return this.#store.conversationAssignmentsMatching(
      (facts) => phases.has(facts.phase) && !facts.hasAborts,
      (candidate) => phases.has(candidate.phase) && candidate.aborts === 0,
    );
  }

  async recoverableConversationCancellations(): Promise<
    readonly ConversationEnvelope[]
  > {
    return this.#store.conversationAssignmentsMatching(
      (facts) =>
        facts.hasAbortMatching((abort) => abort.via === "abort-ticket") &&
        !facts.cancelProofOwnerAccepted &&
        (facts.phase === "received" ||
          facts.phase === "started" ||
          facts.phase === "halted"),
      (candidate) =>
        candidate.ticketAbortPending &&
        (candidate.phase === "received" ||
          candidate.phase === "started" ||
          candidate.phase === "halted"),
    );
  }

  async conversationAssignmentForRecovery(
    assignmentId: string,
  ): Promise<ConversationEnvelope | undefined> {
    assertIdentifier(assignmentId, "Conversation recovery assignment id");
    const envelopeRef = await this.#store.selectReceiptRecovery(
      assignmentId,
      (facts) => facts.received?.body.envelope.ref,
    );
    return envelopeRef
      ? this.#store.loadConversationEnvelope(assignmentId, envelopeRef)
      : undefined;
  }

  async recoverableJobObligations(input: {
    readonly limit: number;
    readonly continuation?: string;
  }): Promise<JobRecoveryObligationPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 256
    ) {
      throw new RangeError("Job recovery page limit must be 1-256");
    }
    if (input.continuation !== undefined) {
      assertIdentifier(input.continuation, "Job recovery continuation");
    }
    const scan = async (): Promise<JobRecoveryObligationPage> => {
      const page = await this.#jobRecoveryIndex.scan(
        {
          ...(input.continuation
            ? { gt: jobRecoveryKey(input.continuation) }
            : { gte: JOB_RECOVERY_KEY_PREFIX }),
          lt: `${JOB_RECOVERY_KEY_PREFIX}\uffff`,
        },
        input.limit,
      );
      const entries: JobRecoveryObligation[] = [];
      for (const entry of page.entries) {
        const value = validateJobRecoveryIndexValue(entry.value);
        if (entry.key !== jobRecoveryKey(value.assignmentId)) {
          throw corruptJobRecoveryProjection(
            "Job recovery index value does not bind its key",
          );
        }
        const obligation = classifyJobRecoveryObligation(value);
        if (
          !obligation.execution &&
          !obligation.cancellation &&
          !obligation.interaction
        ) {
          continue;
        }
        const envelope = await this.#store.loadJobEnvelope(
          value.assignmentId,
          value.envelopeRef,
        );
        if (!envelope) {
          throw corruptJobRecoveryProjection(
            "Job recovery index references a missing envelope",
          );
        }
        entries.push({ envelope, ...obligation });
      }
      const last = page.entries.at(-1);
      return {
        entries,
        ...(page.entries.length === input.limit && last
          ? {
              continuation: validateJobRecoveryIndexValue(last.value)
                .assignmentId,
            }
          : {}),
      };
    };
    try {
      return await scan();
    } catch (error) {
      if (!(error instanceof JobRecoveryProjectionValueError)) throw error;
      await this.#jobRecoveryIndex.rebuild();
      return scan();
    }
  }

  async jobAssignmentPhaseForRecovery(
    assignmentId: string,
  ): Promise<LedgerSnapshot["phase"] | undefined> {
    assertIdentifier(assignmentId, "Job recovery assignment id");
    return this.#store.selectReceiptRecovery(assignmentId, (facts) =>
      facts.received?.body.activation.ref.execution === "job"
        ? facts.phase
        : undefined,
    );
  }

  async jobAssignmentForRecovery(
    assignmentId: string,
  ): Promise<JobEnvelope | undefined> {
    assertIdentifier(assignmentId, "Job recovery assignment id");
    const envelopeRef = await this.#store.selectReceiptRecovery(
      assignmentId,
      (facts) => facts.received?.body.envelope.ref,
    );
    return envelopeRef
      ? this.#store.loadJobEnvelope(assignmentId, envelopeRef)
      : undefined;
  }

  async hasPendingTicketCancellation(assignmentId: string): Promise<boolean> {
    return this.#store.selectReceiptRecovery(
      assignmentId,
      (facts) =>
        facts.hasAbortMatching((abort) => abort.via === "abort-ticket") &&
        !facts.cancelProofOwnerAccepted &&
        facts.interactionSettlementOwnerAccepted === undefined,
    );
  }

  async hasPendingOwnerCancellation(assignmentId: string): Promise<boolean> {
    return this.#store.selectReceiptRecovery(
      assignmentId,
      (facts) =>
        facts.hasAbortMatching((abort) => abort.via === "owner-fence") &&
        facts.phase !== "failed" &&
        facts.phase !== "sealed" &&
        facts.phase !== "acked",
    );
  }

  async continueTicketCancellation(
    assignmentId: string,
  ): Promise<CancelProofBody | undefined> {
    const abort = await this.#store.selectReceiptRecovery(assignmentId, (facts) =>
      facts.latestAbort("abort-ticket") as
        | Extract<AssignmentRecord, { t: "abort-requested"; via: "abort-ticket" }>
        | undefined,
    );
    if (!abort) return undefined;
    return this.#requestAbort(assignmentId, {
      cause: "abort-ticket",
      ticketDigest: abort.refId,
      surfacePrincipal: abort.surfacePrincipal,
    });
  }

  async markTicketCancellationProofOwnerAccepted(
    assignmentId: string,
  ): Promise<boolean> {
    return (
      await this.#store.transactReceiptRecovery<boolean>(
        assignmentId,
        (facts) => {
          if (facts.cancelProofOwnerAccepted) {
            return { kind: "return", value: true };
          }
          if (
            facts.received === undefined ||
            facts.phase !== "halted" ||
            !facts.halted ||
            !facts.hasAbortMatching((abort) => abort.via === "abort-ticket")
          ) {
            throw new Error(
              "Ticket cancellation proof cannot be retired before its durable halted proof",
            );
          }
          if (
            !this.#assignmentRecordV2Writes &&
            facts.streamProjectionEnabledAfter === undefined
          ) {
            return { kind: "return", value: false };
          }
          return {
            kind: "append",
            entries: [
              assignmentRecord(
                assignmentId,
                nextEntryFromSeq(facts.lastSeq, {
                  v: 2,
                  t: "cancel-proof-owner-accepted",
                }),
              ),
            ],
            value: true,
          };
        },
      )
    ).value;
  }

  async markInteractionSettlementOwnerAccepted(
    assignmentId: string,
    settlement:
      | { readonly settlementVersion: 1 }
      | {
          readonly settlementVersion: 2;
          readonly streamProof?: InteractionSettlementStreamProof;
        },
  ): Promise<boolean> {
    return (
      await this.#store.transactReceiptRecovery<boolean>(
        assignmentId,
        (facts) => {
          const abort = facts.firstValidationTicketAbort();
          if (!abort) {
            throw new Error(
              "Interaction settlement acceptance has no durable abort ticket",
            );
          }
          const body =
            settlement.settlementVersion === 2
              ? ({
                  v: 2,
                  t: "interaction-settlement-owner-accepted",
                  assignmentId,
                  ticketDigest: abort.refId,
                  settlementVersion: 2,
                  ...(settlement.streamProof
                    ? { streamProof: settlement.streamProof }
                    : {}),
                } as const)
              : ({
                  v: 2,
                  t: "interaction-settlement-owner-accepted",
                  assignmentId,
                  ticketDigest: abort.refId,
                  settlementVersion: 1,
                } as const);
          const existing = facts.interactionSettlementOwnerAccepted;
          if (existing) {
            if (canonicalize(existing) !== canonicalize(body)) {
              throw new Error(
                "Interaction settlement was already accepted with a different durable identity",
              );
            }
            return { kind: "return", value: true };
          }
          if (
            !this.#assignmentRecordV2Writes &&
            facts.streamProjectionEnabledAfter === undefined
          ) {
            return { kind: "return", value: false };
          }
          return {
            kind: "append",
            entries: [
              assignmentRecord(
                assignmentId,
                nextEntryFromSeq(facts.lastSeq, body),
              ),
            ],
            value: true,
          };
        },
      )
    ).value;
  }

  async pendingInteractionMirrors(
    assignmentId: string,
  ): Promise<InteractionMirrorEntry[]> {
    return this.#store.selectReceiptRecovery(assignmentId, (facts) =>
      selectPendingInteractionMirrors(facts, assignmentId, this.#executorId),
    );
  }

  async pendingInteractionMirrorBatch(
    assignmentId: string,
  ): Promise<InteractionMirrorBatch | undefined> {
    const selected = await this.#store.selectReceiptRecovery(
      assignmentId,
      (facts) => ({
        previousDigest: facts.mirroredInteractionDigest,
        entries: selectPendingInteractionMirrors(
          facts,
          assignmentId,
          this.#executorId,
        ),
      }),
    );
    if (selected.entries.length === 0) return undefined;
    const batch = createSignedAssignmentInteractionMirrorBatch({
      assignmentId,
      executorId: this.#executorId,
      previousDigest: selected.previousDigest,
      entries: selected.entries,
      signer: this.#signer,
      verifier: this.#verifier,
    });
    if (
      interactionMirrorRecordBytes(assignmentId, batch) >
      MAX_INLINE_LOGICAL_RECORD_BYTES
    ) {
      throw new Error(
        "Signed interaction mirror batch exceeded its capacity proof",
      );
    }
    return batch;
  }

  async markInteractionsMirrored(
    assignmentId: string,
    receipt: InteractionMirrorReceipt,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(receipt.mirroredUpTo) ||
      receipt.mirroredUpTo <= 0
    ) {
      throw new TypeError(
        "Interaction mirror watermark must be a positive safe integer",
      );
    }
    if (!Number.isSafeInteger(receipt.ordinal) || receipt.ordinal <= 0) {
      throw new TypeError(
        "Interaction mirror ordinal must be a positive safe integer",
      );
    }
    await this.#store.transactReceiptRecovery<void>(
      assignmentId,
      (facts) => {
        const historic = facts.historicMirrorAt(receipt.mirroredUpTo);
        const finishedIndex =
          facts.finishedIndexAtSeq(receipt.mirroredUpTo) ??
          (historic ? historic.ordinal - 1 : undefined);
        const finished =
          finishedIndex === undefined
            ? undefined
            : facts.finishedAt(finishedIndex) ?? historic;
        if (
          finishedIndex === undefined ||
          !finished ||
          finished.ordinal !== receipt.ordinal ||
          finished.mirrorDigest !== receipt.mirrorDigest ||
          receipt.ordinal !== finishedIndex + 1
        ) {
          throw new Error(
            "Interaction mirror watermark exceeds durable finished records",
          );
        }
        if (receipt.ordinal <= facts.mirroredInteractionOrdinal) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [
            assignmentRecord(
              assignmentId,
              nextEntryFromSeq(facts.lastSeq, {
                v: 1,
                t: "mirrored",
                upTo: receipt.mirroredUpTo,
                ordinal: receipt.ordinal,
                mirrorDigest: receipt.mirrorDigest,
              }),
            ),
          ],
          value: undefined,
        };
      },
      { history: () => ({ mirrorSeqs: [receipt.mirroredUpTo] }) },
    );
  }

  async acknowledge(assignmentId: string, commitRevision: number): Promise<void> {
    if (!Number.isSafeInteger(commitRevision) || commitRevision < 0) {
      throw new TypeError(
        "Commit revision must be a non-negative safe integer",
      );
    }
    await this.#store.transactReceiptRecovery<void>(assignmentId, (facts) => {
      if (facts.phase === "acked") {
        if (facts.acknowledgedCommitRevision !== commitRevision) {
          throw new Error(
            "Assignment already acknowledged a different commit revision",
          );
        }
        return { kind: "return", value: undefined };
      }
      if (facts.phase !== "sealed") {
        throw new Error(
          "Assignment cannot be acknowledged before bundle sealing",
        );
      }
      return {
        kind: "append",
        entries: [
          assignmentRecord(
            assignmentId,
            nextEntryFromSeq(facts.lastSeq, {
              v: 1,
              t: "acked",
              commitRevision,
            }),
          ),
        ],
        value: undefined,
      };
    });
  }

  async #driveReceiptPasses(): Promise<void> {
    this.#receiptDriving = true;
    try {
      while (this.#receiptWaiters.length) {
        const served = this.#receiptWaiters;
        this.#receiptWaiters = [];
        const urgency = () =>
          strongestReceiptUrgency([...served, ...this.#receiptWaiters]);
        try {
          const value = await runDetachedDeviceCapacity(() =>
            runDetachedMaintenanceContext("background", () =>
              runWithMaintenanceUrgency(
                urgency,
                currentMaintenanceAbortSignal(),
                () => this.#reconcileReceiptsOnce(),
              ),
            ),
          );
          for (const waiter of served) waiter.resolve(value);
        } catch (error) {
          for (const waiter of served) waiter.reject(error);
        }
      }
    } finally {
      this.#receiptDriving = false;
    }
  }

  async #reconcileReceiptsOnce(): Promise<number> {
    const settled = this.#receiptsSettledAt;
    const head = settled
      ? await this.#log.checkpoint(settled)
      : await this.#log.checkpoint();
    if (head === settled) return 0;
    this.#receiptsSettledAt = undefined;
    const candidates = await this.#resources!.activeAssignmentReceipts();
    const phases = await this.#store.readAssignmentPhasesFromIndex(
      candidates.map((lease) => lease.activation.assignmentId),
    );
    let released = 0;
    for (const lease of candidates) {
      const phase = phases.get(lease.activation.assignmentId);
      if (phase && (phase.started || !phase.received)) continue;
      const result = await this.#store.transactReceiptRecovery<number>(
        lease.activation.assignmentId,
        (facts) => {
          if (
            !facts.supersedeFence ||
            facts.started ||
            !facts.received ||
            canonicalize(facts.received.resourceLease) !== canonicalize(lease)
          ) {
            return { kind: "return" as const, value: 0 };
          }
          const entries =
            this.#resources!.prepareSupersededReceiptRelease(lease);
          return entries.length
            ? { kind: "append" as const, entries, value: 1 }
            : { kind: "return" as const, value: 0 };
        },
        { receiptRetirement: true },
      );
      released += result.value;
    }
    const retirement = await this.#retireLostExecutions(
      candidates.filter(
        (lease) => phases.get(lease.activation.assignmentId)?.started !== false,
      ),
    );
    released += retirement.retired;
    if (released === 0 && !retirement.deferred) {
      this.#receiptsSettledAt = head;
    }
    return released;
  }

  async #retireLostExecutions(
    candidates: readonly AssignmentResourceLease[],
  ): Promise<{ readonly retired: number; readonly deferred: boolean }> {
    if (
      !this.#resources?.lostExecutionRetirement ||
      candidates.length === 0
    ) {
      return { retired: 0, deferred: false };
    }
    const preflight =
      await this.#resources.lostExecutionRetirementDue(candidates);
    let deferred = preflight.deferred;
    let retired = 0;
    for (const lease of preflight.due) {
      const result = await this.#store.transactReceiptRecovery<
        "retired" | "deferred" | "skip"
      >(
        lease.activation.assignmentId,
        (facts) => {
          if (
            facts.phase !== "started" ||
            !facts.started ||
            facts.halted ||
            !facts.received ||
            canonicalize(facts.received.resourceLease) !== canonicalize(lease)
          ) {
            return { kind: "return", value: "skip" };
          }
          const prepared =
            this.#resources!.prepareLostExecutionRetirement(lease);
          if (prepared.records.length > 0) {
            return {
              kind: "append",
              entries: prepared.records,
              value: "retired",
            };
          }
          return {
            kind: "return",
            value: prepared.deferred ? "deferred" : "skip",
          };
        },
        { receiptRetirement: true },
      );
      if (result.value === "retired") retired += 1;
      else if (result.value === "deferred") deferred = true;
    }
    return { retired, deferred };
  }
}

function selectPendingInteractionMirrors(
  facts: ReceiptRecoveryFacts,
  assignmentId: string,
  executorId: string,
): InteractionMirrorEntry[] {
  const entries: InteractionMirrorEntry[] = [];
  for (
    let index = facts.mirroredFinishedCount;
    index < facts.finishedCount;
    index += 1
  ) {
    if (entries.length === 256) break;
    const finished = facts.finishedAt(index)!;
    const candidate = mirrorEntry(finished);
    const nextEntries = [...entries, candidate];
    const nextBytes = interactionMirrorRecordCapacityBytes({
      assignmentId,
      executorId,
      previousDigest: facts.mirroredInteractionDigest,
      entries: nextEntries,
      mirrorDigest: finished.mirrorDigest,
    });
    if (nextBytes > MAX_INLINE_LOGICAL_RECORD_BYTES) {
      if (entries.length === 0) {
        throw new Error(
          "A durable interaction outcome cannot fit in a mirror batch",
        );
      }
      break;
    }
    entries.push(candidate);
  }
  return entries;
}
