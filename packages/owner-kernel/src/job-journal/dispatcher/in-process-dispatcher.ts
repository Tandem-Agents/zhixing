import type {
  AuthorityCallContext,
  AuthorityError,
  DispatchEnvelope,
  DispatchResult,
  LedgerEvidencePage,
  LedgerSnapshot,
  RunExecutorPort,
  SupersedeProof,
} from "@zhixing-ai/core/contracts";
import {
  assignmentActivationDigest,
  canonicalize,
  dispatchEnvelopeDigest,
} from "@zhixing-ai/core/protocol";
import type { InProcessDispatchContextFactory } from "../../shared-protocol/contracts.js";
import type {
  InProcessJobBundleSubmission,
  InProcessJobCancellationSubmission,
  JobCancelResult,
  JobEnvelope,
  JobRecoveryCandidate,
  PendingJobDispatch,
  PendingJobFence,
} from "../contracts.js";
import type { JobJournal } from "../journal.js";
import { terminationProofKind } from "../state/assignment-control.js";
import { withoutSignature } from "../state/common.js";

interface InProcessJobDispatcherBaseOptions {
  readonly journal: JobJournal;
  readonly executor: RunExecutorPort;
  readonly contexts: InProcessDispatchContextFactory;
  /**
   * dispatch 被 executor 接受后的进程内执行接缝——与 mesh 服务端
   * onDispatchAccepted 对称;耐久事实已在 executor 账本,这里只是加速
   * 通知,漏通知由 executor 恢复枚举兜底。
   */
  readonly onDispatchAccepted?: (
    envelope: Extract<DispatchEnvelope, { execution: "job" }>,
  ) => void | Promise<void>;
  readonly onCancelAccepted?: (
    assignmentId: string,
  ) => void | Promise<void>;
  readonly onRecoveryError?: (error: Error) => void;
  /**
   * 本调度器负责的指派：恢复驱动每轮按此间隔对它做一次执行端终态对账。
   * 终态通知是加速，丢一次时由这里在有界时间内收敛（本机与远程执行端一致）。
   */
  readonly terminalReconciliation?: {
    readonly assignmentId: string;
    readonly intervalMs?: number;
  };
}

export type InProcessJobDispatcherOptions = InProcessJobDispatcherBaseOptions &
  (
    | {
        readonly enabled: false;
        readonly cancellationSubmission?: InProcessJobCancellationSubmission;
        readonly bundleSubmission?: InProcessJobBundleSubmission;
      }
    | {
        readonly enabled: true;
        readonly cancellationSubmission: InProcessJobCancellationSubmission;
        readonly bundleSubmission: InProcessJobBundleSubmission;
      }
  );

/** Explicitly gated same-process transport for user jobs. */
export class InProcessJobDispatcher {
  readonly #enabled: boolean;
  readonly #journal: JobJournal;
  readonly #executor: RunExecutorPort;
  readonly #contexts: InProcessDispatchContextFactory;
  readonly #cancellationSubmission:
    | InProcessJobCancellationSubmission
    | undefined;
  readonly #bundleSubmission: InProcessJobBundleSubmission | undefined;
  readonly #onDispatchAccepted:
    | ((envelope: JobEnvelope) => void | Promise<void>)
    | undefined;
  readonly #onCancelAccepted:
    | ((assignmentId: string) => void | Promise<void>)
    | undefined;
  readonly #onRecoveryError: ((error: Error) => void) | undefined;
  readonly #terminalReconciliation: InProcessJobDispatcherBaseOptions["terminalReconciliation"];
  #nextTerminalReconciliationAt = 0;
  readonly #cancellationDispatches = new Map<
    string,
    {
      readonly fence: PendingJobFence["fence"];
      readonly task: Promise<boolean>;
    }
  >();
  readonly #cancellationRetry = new Map<
    string,
    { readonly delayMs: number; readonly nextAttemptAt: number }
  >();
  readonly #stoppedCancellationRecovery = new Set<string>();
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #recoveryRunning: Promise<void> | undefined;
  #recoveryStopped = true;

  constructor(options: InProcessJobDispatcherOptions) {
    this.#enabled = options.enabled;
    this.#journal = options.journal;
    this.#executor = options.executor;
    this.#contexts = options.contexts;
    this.#cancellationSubmission = options.cancellationSubmission;
    this.#bundleSubmission = options.bundleSubmission;
    this.#onDispatchAccepted = options.onDispatchAccepted;
    this.#onCancelAccepted = options.onCancelAccepted;
    this.#onRecoveryError = options.onRecoveryError;
    this.#terminalReconciliation = options.terminalReconciliation;
  }

  /**
   * Owner 生命周期持有的耐久 outbox 驱动器。每轮都重读 journal；失败只结束
   * 当前尝试，未完成 fence 仍由下一轮用同一身份继续推进。
   */
  startRecoveryLoop(intervalMs = 1_000): void {
    if (!this.#enabled || this.#recoveryRunning || this.#recoveryTimer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new TypeError("Job recovery interval must be a positive integer");
    }
    this.#recoveryStopped = false;
    const run = () => {
      if (this.#recoveryStopped) return;
      const active = this.#recoverDurableOutboxes();
      this.#recoveryRunning = active;
      void active
        .catch((error) =>
          this.#onRecoveryError?.(
            error instanceof Error ? error : new Error(String(error)),
          ),
        )
        .finally(() => {
          if (this.#recoveryRunning === active) {
            this.#recoveryRunning = undefined;
          }
          if (!this.#recoveryStopped) {
            this.#recoveryTimer = setTimeout(() => {
              this.#recoveryTimer = undefined;
              run();
            }, intervalMs);
            this.#recoveryTimer.unref?.();
          }
        });
    };
    run();
  }

  async stopRecoveryLoop(): Promise<void> {
    this.#recoveryStopped = true;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    await this.#recoveryRunning?.catch(() => undefined);
  }

  async #recoverDurableOutboxes(): Promise<void> {
    await this.recoverCancellations();
    const terminal = this.#terminalReconciliation;
    if (terminal && Date.now() >= this.#nextTerminalReconciliationAt) {
      this.#nextTerminalReconciliationAt =
        Date.now() + (terminal.intervalMs ?? 5_000);
      await this.reconcileExecutorTerminal(terminal.assignmentId);
    }
  }

  async dispatchPending(): Promise<readonly DispatchResult[]> {
    if (!this.#enabled) return [];
    const pending = await this.#journal.pendingDispatches();
    const outcomes: DispatchResult[] = [];
    for (const item of pending) {
      const outcome = await this.#journal.validateExecutorDispatchResult(
        await this.#executor.dispatch(
          item.envelope,
          item.activation,
          this.#dispatchContext(item),
        ),
      );
      outcomes.push(outcome);
      if (outcome.accepted) {
        await this.#journal.acknowledgeDispatch(item.assignmentId);
        await this.#onDispatchAccepted?.(item.envelope);
      } else if (outcome.outcome === "rejected-before-received") {
        await this.#journal.acceptDispatchRejection(outcome);
      } else {
        await this.#journal.recordDispatchConflict(item, outcome);
      }
    }
    return outcomes;
  }

  async recoverStarted(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.dispatchesAwaitingStarted();
    let recovered = 0;
    for (const item of pending) {
      const ledger = await this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          item.assignmentId,
          this.#queryContext(item.assignmentId),
        ),
      );
      if (
        ledger.phase === "started" ||
        ledger.phase === "sealed" ||
        ledger.phase === "acked"
      ) {
        await this.#journal.reconcileStarted(item.assignmentId, ledger);
        recovered += 1;
      }
    }
    return recovered;
  }

  async cancel(input: {
    readonly jobRunId: string;
    readonly requestId: string;
    readonly context: AuthorityCallContext;
  }): Promise<JobCancelResult> {
    const result = await this.#journal.cancel(input);
    if (!this.#enabled || result.state !== "cancel-requested") return result;
    await this.#dispatchCancellation(result.assignmentId, result.fence);
    return result;
  }

  async recoverCancellations(): Promise<number> {
    if (!this.#enabled) return 0;
    const pending = await this.#journal.pendingCancellations();
    const now = Date.now();
    const due = pending.filter((item) => {
      if (this.#stoppedCancellationRecovery.has(item.assignmentId)) {
        return false;
      }
      const retry = this.#cancellationRetry.get(item.assignmentId);
      return retry === undefined || retry.nextAttemptAt <= now;
    });
    await Promise.all(
      due.map((item) =>
        this.#dispatchCancellation(item.assignmentId, item.fence),
      ),
    );
    return due.length;
  }

  #dispatchCancellation(
    assignmentId: string,
    fence: PendingJobFence["fence"],
  ): Promise<boolean> {
    const existing = this.#cancellationDispatches.get(assignmentId);
    if (existing) {
      if (canonicalize(existing.fence) !== canonicalize(fence)) {
        throw new Error(
          "Job cancellation retry changed its durable fence identity",
        );
      }
      return existing.task;
    }
    const task = this.#dispatchCancellationOnce(assignmentId, fence)
      .then((completed) => {
        if (completed) {
          this.#cancellationRetry.delete(assignmentId);
          this.#stoppedCancellationRecovery.delete(assignmentId);
        } else {
          this.#deferCancellationRecovery(assignmentId);
        }
        return completed;
      })
      .catch((error) => {
        if (error instanceof TypeError) {
          this.#stoppedCancellationRecovery.add(assignmentId);
        } else {
          this.#deferCancellationRecovery(assignmentId);
        }
        throw error;
      })
      .finally(() => {
        if (this.#cancellationDispatches.get(assignmentId)?.task === task) {
          this.#cancellationDispatches.delete(assignmentId);
        }
      });
    this.#cancellationDispatches.set(assignmentId, { fence, task });
    return task;
  }

  #deferCancellationRecovery(assignmentId: string): void {
    const previous = this.#cancellationRetry.get(assignmentId)?.delayMs ?? 50;
    const delayMs = Math.min(previous * 2, 5_000);
    this.#cancellationRetry.set(assignmentId, {
      delayMs,
      nextAttemptAt: Date.now() + previous,
    });
  }

  async #dispatchCancellationOnce(
    assignmentId: string,
    fence: PendingJobFence["fence"],
  ): Promise<boolean> {
    if (await this.#submitCancellation(assignmentId)) return true;
    await this.#executor.cancel(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.cancel", fence),
    );
    await this.#onCancelAccepted?.(assignmentId);
    if (await this.#submitCancellation(assignmentId)) return true;
    await this.#executor.cancel(
      assignmentId,
      fence,
      this.#fenceContext(assignmentId, "executor.cancel", fence),
    );
    return this.#submitCancellation(assignmentId);
  }

  async supersede(
    assignmentId: string,
    requestId: string,
  ): Promise<SupersedeProof> {
    if (!this.#enabled) throw new Error("In-process job dispatch is disabled");
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

  /**
   * 单个指派在执行端到达终态后的 owner 侧收尾：执行端耐久失败落成 failed；
   * 执行端已确认的提交写回执观察（started 上报丢失时先补 running）。
   * 只按指派精确读取一次 owner 待办与一次执行端台账；取消证明与密封包由各自
   * 所属路径推进（锚点本机装配里由执行端自担），这里不碰。重复调用幂等。
   */
  async reconcileExecutorTerminal(assignmentId: string): Promise<boolean> {
    if (!this.#enabled) return false;
    const candidate =
      await this.#journal.assignmentAwaitingRecovery(assignmentId);
    if (!candidate) return false;
    if (
      candidate.state !== "dispatched" &&
      candidate.state !== "running" &&
      candidate.state !== "committed"
    ) {
      return false;
    }
    const ledger = await this.#journal.validateExecutorLedgerSnapshot(
      await this.#executor.queryLedger(
        assignmentId,
        this.#queryContext(assignmentId),
      ),
    );
    if (ledger.assignmentId !== assignmentId) {
      throw new TypeError("Executor ledger snapshot names another assignment");
    }
    if (ledger.phase === "failed" && candidate.state !== "committed") {
      await this.#acceptExecutorFailure(candidate, ledger);
      return true;
    }
    if (ledger.phase === "acked") {
      await this.#observeAcknowledgement(candidate, ledger);
      return true;
    }
    return false;
  }

  async #observeAcknowledgement(
    candidate: JobRecoveryCandidate,
    ledger: LedgerSnapshot,
  ): Promise<void> {
    if (candidate.state === "dispatched") {
      await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
    }
    await this.#journal.observeBundleAcknowledgement(
      candidate.assignmentId,
      ledger,
    );
  }

  async #acceptExecutorFailure(
    candidate: JobRecoveryCandidate,
    ledger: LedgerSnapshot,
  ): Promise<void> {
    if (!ledger.failure) {
      throw new Error(
        "Failed executor job assignment has no durable failure fact",
      );
    }
    await this.#journal.failAssigned(
      candidate.dispatch.envelope.work.jobRunId,
      candidate.assignmentId,
      { lastSeq: ledger.lastSeq, failure: ledger.failure },
    );
  }

  async recoverAssignments(): Promise<number> {
    if (!this.#enabled) return 0;
    const candidates = await this.#journal.assignmentsAwaitingRecovery();
    let recovered = 0;
    for (const candidate of candidates) {
      const ledger = await this.#journal.validateExecutorLedgerSnapshot(
        await this.#executor.queryLedger(
          candidate.assignmentId,
          this.#queryContext(candidate.assignmentId),
        ),
      );
      if (ledger.phase === "dispatch-rejected") {
        if (candidate.stoppedProofKinds.includes("dispatch-rejection")) {
          // owner 已耐久拒绝该矛盾的 dispatch-rejection 证明：本恢复动作
          // 永久停止，保持 uncertain 与 open fact 待用户裁决或迟到 bundle。
          continue;
        }
        const result = await this.#journal.validateExecutorDispatchResult(
          await this.#executor.dispatch(
            candidate.dispatch.envelope,
            candidate.dispatch.activation,
            this.#dispatchContext(candidate.dispatch),
          ),
        );
        if (result.accepted || result.outcome !== "rejected-before-received") {
          throw new Error(
            "Rejected job dispatch did not replay its terminal proof",
          );
        }
        await this.#journal.acceptDispatchRejection(result);
        recovered += 1;
        continue;
      }
      if (ledger.phase === "failed") {
        await this.#acceptExecutorFailure(candidate, ledger);
        recovered += 1;
        continue;
      }
      if (ledger.cancelProof) {
        if (
          candidate.stoppedProofKinds.includes(
            terminationProofKind(ledger.cancelProof),
          )
        ) {
          // owner 已耐久拒绝同 kind 的矛盾 not-started 证明（executor 侧
          // 终态证明不可变，账本里的正是被拒证明）：停止重提，其余 kind
          // 的恢复义务与迟到 bundle 路径不受影响。
          continue;
        }
        if (!(await this.#submitCancellation(candidate.assignmentId))) {
          throw new Error(
            "Durable job cancel proof disappeared before submission",
          );
        }
        recovered += 1;
        continue;
      }
      if (ledger.phase === "acked") {
        await this.#observeAcknowledgement(candidate, ledger);
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
      if (candidate.state === "uncertain" || ledger.lastSeq <= 0) continue;
      const assignmentId = candidate.assignmentId;
      const executor = this.#executor;
      const contexts = this.#contexts;
      const pages = (async function* (): AsyncGenerator<LedgerEvidencePage> {
        let fromSeq = 1;
        while (fromSeq <= ledger.lastSeq) {
          const page = await executor.queryLedger(
            assignmentId,
            contexts.create(assignmentId, "executor.queryLedger", {
              requestId: `ledger:${assignmentId}:${fromSeq}:${Math.min(256, ledger.lastSeq - fromSeq + 1)}`,
              body: {
                range: {
                  fromSeq,
                  limit: Math.min(256, ledger.lastSeq - fromSeq + 1),
                },
              },
            }),
            { fromSeq, limit: Math.min(256, ledger.lastSeq - fromSeq + 1) },
          );
          if (!("entries" in page)) {
            throw new TypeError(
              "Executor returned a snapshot for job evidence query",
            );
          }
          yield page;
          fromSeq = page.toSeq + 1;
        }
      })();
      if (
        await this.#journal.reconcileCancellationEvidence(
          candidate.assignmentId,
          ledger,
          pages,
        )
      ) {
        recovered += 1;
        continue;
      }
      if (ledger.phase === "started" && candidate.state === "dispatched") {
        await this.#journal.reconcileStarted(candidate.assignmentId, ledger);
        recovered += 1;
      }
    }
    return recovered;
  }

  async #submitCancellation(assignmentId: string): Promise<boolean> {
    if (!this.#cancellationSubmission) {
      throw new Error(
        "In-process job cancellation submission is not configured",
      );
    }
    return this.#cancellationSubmission.submitCancellation(assignmentId);
  }

  #dispatchContext(item: PendingJobDispatch): AuthorityCallContext {
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
      throw new Error("In-process job bundle submission is not configured");
    }
    return this.#bundleSubmission.submitSealedBundle(assignmentId);
  }
}
