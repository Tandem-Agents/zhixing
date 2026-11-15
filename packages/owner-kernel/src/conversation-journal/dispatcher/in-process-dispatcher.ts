import type {
  AuthorityCallContext,
  AuthorityError,
  DispatchResult,
  LedgerEvidencePage,
  SupersedeProof,
} from "@zhixing-ai/core/contracts";
import {
  assignmentActivationDigest,
  dispatchEnvelopeDigest,
} from "@zhixing-ai/core/protocol";
import type {
  InProcessBundleSubmission,
  InProcessCancellationSubmission,
  InProcessDispatchContextFactory,
} from "../../shared-protocol/contracts.js";
import type {
  ConversationCancelRequest,
  ConversationCancelResult,
  ConversationDispatchPort,
  PendingConversationDispatch,
} from "../contracts.js";
import type { ConversationRunJournal } from "../journal.js";
import { withoutSignature } from "../state/common.js";

interface InProcessConversationDispatcherBaseOptions {
  readonly journal: ConversationRunJournal;
  readonly executor: ConversationDispatchPort;
  readonly contexts: InProcessDispatchContextFactory;
  /** Same-process cancellation still owns a live execution's quiescence step. Not a stop proof. */
  readonly cancellationContinuationPending?: (assignmentId: string) => boolean;
}

export type InProcessConversationDispatcherOptions =
  InProcessConversationDispatcherBaseOptions &
    (
      | {
          readonly enabled: false;
          readonly cancellationSubmission?: InProcessCancellationSubmission;
          readonly bundleSubmission?: InProcessBundleSubmission;
        }
      | {
          readonly enabled: true;
          readonly cancellationSubmission: InProcessCancellationSubmission;
          readonly bundleSubmission: InProcessBundleSubmission;
        }
    );

/** Explicitly gated single-process transport; disabled means zero dispatch side effects. */
export class InProcessConversationDispatcher {
  readonly #enabled: boolean;
  readonly #journal: ConversationRunJournal;
  readonly #executor: ConversationDispatchPort;
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #cancellationSubmission: InProcessCancellationSubmission | undefined;
  readonly #bundleSubmission: InProcessBundleSubmission | undefined;
  readonly #cancellationContinuationPending: (assignmentId: string) => boolean;

  constructor(options: InProcessConversationDispatcherOptions) {
    this.#enabled = options.enabled;
    this.#journal = options.journal;
    this.#executor = options.executor;
    this.#contexts = options.contexts;
    this.#cancellationSubmission = options.cancellationSubmission;
    this.#bundleSubmission = options.bundleSubmission;
    this.#cancellationContinuationPending =
      options.cancellationContinuationPending ?? (() => false);
  }

  async dispatchPending(): Promise<readonly DispatchResult[]> {
    if (!this.#enabled) return [];
    const outcomes: DispatchResult[] = [];
    for (const item of await this.#journal.pendingDispatches()) {
      outcomes.push(await this.dispatchAssignment(item));
    }
    return outcomes;
  }

  /** Deliver this exact issued assignment even if another reader already ACKed it. */
  async dispatchAssignment(
    item: PendingConversationDispatch,
  ): Promise<DispatchResult> {
    if (!this.#enabled) throw new Error("Conversation dispatch is disabled");
    const outcome = await this.#journal.validateExecutorDispatchResult(
      await this.#executor.dispatch(
        item.envelope,
        item.activation,
        this.#dispatchContext(item),
      ),
    );
    if (outcome.accepted) {
      await this.#journal.acknowledgeDispatch(item.assignmentId);
    } else if (outcome.outcome === "rejected-before-received") {
      await this.#journal.acceptDispatchRejection(outcome);
    } else {
      await this.#journal.recordDispatchConflict(item, outcome);
    }
    return outcome;
  }

  async recoverStarted(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.dispatchesAwaitingStarted();
    let recovered = 0;
    for (const item of pending) {
      const snapshot = await this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          item.assignmentId,
          this.#queryContext(item.assignmentId),
        ),
      );
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

  async cancelRun(
    input: ConversationCancelRequest,
  ): Promise<ConversationCancelResult> {
    const result = await this.#journal.cancelRun(input);
    if (!this.#enabled || result.state !== "cancel-requested") return result;
    await this.#executor.cancel(
      result.assignmentId,
      result.fence,
      this.#fenceContext(result.assignmentId, "executor.cancel", result.fence),
    );
    if (!(await this.#submitCancellation(result.assignmentId))) {
      await this.#executor.cancel(
        result.assignmentId,
        result.fence,
        this.#fenceContext(result.assignmentId, "executor.cancel", result.fence),
      );
      await this.#submitCancellation(result.assignmentId);
    }
    return result;
  }

  async recoverCancellations(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingCancellations();
    for (const item of pending) {
      await this.#executor.cancel(
        item.assignmentId,
        item.fence,
        this.#fenceContext(item.assignmentId, "executor.cancel", item.fence),
      );
      if (!(await this.#submitCancellation(item.assignmentId))) {
        await this.#executor.cancel(
          item.assignmentId,
          item.fence,
          this.#fenceContext(item.assignmentId, "executor.cancel", item.fence),
        );
        await this.#submitCancellation(item.assignmentId);
      }
    }
    return pending.length;
  }

  async recoverAssignments(): Promise<number> {
    if (!this.#enabled) return 0;
    const assignments = await this.#journal.assignmentsAwaitingRecovery();
    let recovered = 0;
    for (const candidate of assignments) {
      const ledger = await this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          candidate.assignmentId,
          this.#queryContext(candidate.assignmentId),
        ),
      );
      if (ledger.phase === "dispatch-rejected") {
        const outcome = await this.#journal.validateExecutorDispatchResult(
          await this.#executor.dispatch(
            candidate.dispatch.envelope,
            candidate.dispatch.activation,
            this.#dispatchContext(candidate.dispatch),
          ),
        );
        if (
          outcome.accepted ||
          outcome.outcome !== "rejected-before-received"
        ) {
          throw new Error(
            "Dispatch rejection terminal did not replay its original proof",
          );
        }
        await this.#journal.acceptDispatchRejection(outcome);
        recovered += 1;
        continue;
      }
      if (ledger.phase === "failed") {
        if (!ledger.failure) {
          throw new Error(
            "Failed executor assignment has no durable failure fact",
          );
        }
        const currentRunState = await this.#journal.runState(
          candidate.dispatch.envelope.work.runId,
        );
        if (
          currentRunState !== "cancel-requested" &&
          currentRunState !== "cancelled"
        ) {
          await this.#journal.failAssignedRun(
            candidate.dispatch.envelope.work.runId,
            candidate.assignmentId,
            ledger.failure.reason,
            ledger.failure.usageFinal,
          );
          recovered += 1;
        }
        continue;
      }
      if (ledger.cancelProof) {
        if (!(await this.#submitCancellation(candidate.assignmentId))) {
          throw new Error(
            "Durable cancel proof disappeared before submission",
          );
        }
        recovered += 1;
        continue;
      }
      if (ledger.phase === "acked") {
        if (candidate.state === "dispatched") {
          await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
        }
        await this.#journal.observeBundleAcknowledgement(
          candidate.assignmentId,
          ledger,
        );
        recovered += 1;
        continue;
      }
      if (ledger.phase === "sealed") {
        let progressed = false;
        if (candidate.state === "dispatched") {
          await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
          progressed = true;
        }
        const result = await this.#submitSealedBundle(candidate.assignmentId);
        if (result.committed) {
          const acknowledged =
            await this.#journal.validateExecutorLedgerSnapshot(
              await this.#executor.queryLedger(
                candidate.assignmentId,
                this.#queryContext(candidate.assignmentId),
              ),
            );
          await this.#journal.observeBundleAcknowledgement(
            candidate.assignmentId,
            acknowledged,
          );
          progressed = true;
        }
        if (progressed) recovered += 1;
        continue;
      }
      if (
        candidate.state === "uncertain" ||
        candidate.state === "committed" ||
        ledger.lastSeq <= 0 ||
        this.#cancellationContinuationPending(candidate.assignmentId)
      ) {
        continue;
      }
      const assignmentId = candidate.assignmentId;
      const executor = this.#executor;
      const contexts = this.#contexts;
      const pages = (async function* (): AsyncGenerator<LedgerEvidencePage> {
        let fromSeq = 1;
        while (fromSeq <= ledger.lastSeq) {
          const limit = Math.min(256, ledger.lastSeq - fromSeq + 1);
          const page = await executor.queryLedger(
            assignmentId,
            contexts.create(assignmentId, "executor.queryLedger", {
              requestId: `ledger:${assignmentId}:${fromSeq}:${limit}`,
              body: {
                range: {
                  fromSeq,
                  limit,
                },
              },
            }),
            { fromSeq, limit },
          );
          if (!("entries" in page)) {
            throw new TypeError(
              "Executor returned a snapshot for an evidence page query",
            );
          }
          yield page;
          fromSeq = page.toSeq + 1;
        }
      })();
      if (
        await this.#journal.reconcileCancellationEvidence(
          assignmentId,
          ledger,
          pages,
        )
      ) {
        recovered += 1;
      }
    }
    return recovered;
  }

  async recoverCancellationProofs(): Promise<number> {
    return this.recoverAssignments();
  }

  async supersede(
    assignmentId: string,
    requestId: string,
  ): Promise<SupersedeProof> {
    if (!this.#enabled) throw new Error("In-process dispatch is disabled");
    const fence = await this.#journal.requestSupersede(assignmentId, requestId);
    const proof = await this.#executor.supersede(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.supersede", fence),
    );
    await this.#journal.acceptSupersedeProof(proof);
    return proof;
  }

  async recoverSupersedes(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingSupersedes();
    for (const item of pending) {
      const proof = await this.#executor.supersede(
        item.assignmentId,
        item.fence,
        this.#fenceContext(item.assignmentId, "executor.supersede", item.fence),
      );
      await this.#journal.acceptSupersedeProof(proof);
    }
    return pending.length;
  }

  async #submitCancellation(assignmentId: string): Promise<boolean> {
    if (!this.#cancellationSubmission) {
      throw new Error("In-process cancellation submission is not configured");
    }
    return this.#cancellationSubmission.submitCancellation(assignmentId);
  }

  #dispatchContext(item: PendingConversationDispatch): AuthorityCallContext {
    return this.#contexts.create(item.assignmentId, "executor.dispatch", {
      requestId: `dispatch:${item.assignmentId}`,
      body: {
        dispatchDigest: dispatchEnvelopeDigest(item.envelope),
        activationDigest: assignmentActivationDigest(
          withoutSignature(item.activation),
        ),
      },
    });
  }

  #queryContext(
    assignmentId: string,
    range?: { readonly fromSeq: number; readonly limit: number },
  ): AuthorityCallContext {
    return this.#contexts.create(assignmentId, "executor.queryLedger", {
      requestId: range
        ? `ledger:${assignmentId}:${range.fromSeq}:${range.limit}`
        : `ledger:${assignmentId}:snapshot`,
      body: { range: range ?? null },
    });
  }

  #fenceContext(
    assignmentId: string,
    method: "executor.cancel" | "executor.supersede",
    fence: { readonly fenceSeq: number; readonly requestId: string },
  ): AuthorityCallContext {
    return this.#contexts.create(assignmentId, method, {
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
  }

  async #submitSealedBundle(
    assignmentId: string,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | { readonly committed: false; readonly error: AuthorityError }
  > {
    if (!this.#bundleSubmission) {
      throw new Error("In-process bundle submission is not configured");
    }
    return this.#bundleSubmission.submitSealedBundle(assignmentId);
  }
}
