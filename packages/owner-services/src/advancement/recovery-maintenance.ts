import type {
  AdvancementReviewAttemptApplication,
  AdvancementReviewResultProjectionApplication,
} from "@zhixing/core/advancement/application";
import type { AdvancementProxyMessage, AdvancementSession, AdvancementReviewAttempt } from "@zhixing/core/advancement";
import type { RunRecord, RunRecordRef } from "@zhixing/core/transcript";
import type { AdvancementConversationDirectory } from "./conversation-directory-port.js";
import type { AdvancementController } from "./controller.js";
import type {
  AdvancementEventSink,
  AdvancementOriginalTaskAdmissionPort,
  AdvancementProxyDurableClaim,
  AdvancementProxyTurnPort,
} from "./ports.js";
import {
  ProxyMessageScheduler,
  type ScheduleProxyMessageResult,
} from "./proxy-scheduler.js";

import { hasPendingWorksceneTask } from "@zhixing/core/workscene/application";

const RECOVERY_SCAN_PAGE_SIZE = 50;

export interface AdvancementRecoveryReadPort {
  list(after?: string): Promise<{ conversationIds: readonly string[]; next?: string }>;
  cleanup(conversationId: string, after?: string): Promise<{ items: readonly { sessionId: string; attempt: AdvancementReviewAttempt; deleted?: boolean }[]; next?: string }>;
  run(conversationId: string, sessionId: string, before?: number): Promise<{ record: RunRecord; runRecordRef: RunRecordRef } | null | undefined>;
}

export interface AdvancementRecoveryMaintenanceOptions {
  readonly advancement: AdvancementController;
  readonly reviews: AdvancementReviewAttemptApplication;
  readonly directory: AdvancementConversationDirectory;
  readonly proxyTurns: AdvancementProxyTurnPort;
  readonly events?: AdvancementEventSink;
  readonly reviewResults: AdvancementReviewResultProjectionApplication;
  readonly originalTasks?: AdvancementOriginalTaskAdmissionPort;
  readonly logger?: Pick<Console, "warn">;
  readonly pending?: AdvancementRecoveryReadPort;
}

export type AdvancementRecoveryResult =
  | {
      readonly status:
        | "no-active-session"
        | "not-active"
        | "no-pending-recovery"
        | "recovery-pending"
        | "awaiting-original-run";
      readonly conversationId: string;
    }
  | {
      readonly status: "already-running" | "already-scheduled";
      readonly conversationId: string;
      readonly advancementSessionId: string;
      readonly proxyMessageId: string;
    }
  | {
      readonly status: "durable-run-owned" | "closed-run-recovered";
      readonly conversationId: string;
      readonly advancementSessionId: string;
      readonly proxyMessageId: string;
      readonly runId: string;
    }
  | {
      readonly status: "scheduled";
      readonly conversationId: string;
      readonly advancementSessionId: string;
      readonly proxyMessageId: string;
      readonly scheduleStatus: Extract<
        ScheduleProxyMessageResult["status"],
        "immediate" | "queued"
      >;
    }
  | {
      readonly status: "accepted-run-recovered";
      readonly conversationId: string;
      readonly advancementSessionId: string;
      readonly proxyMessageId?: string;
      readonly runRecordRef: RunRecordRef;
    }
  | {
      readonly status: "review-deferred";
      readonly conversationId: string;
      readonly advancementSessionId: string;
      readonly runRecordRef: RunRecordRef;
      readonly cause: "infrastructure" | "aborted";
      readonly message: string;
    }
  | {
      readonly status: "not-found" | "full" | "busy" | "missing-proxy" | "failed";
      readonly conversationId: string;
      readonly advancementSessionId?: string;
      readonly proxyMessageId?: string;
      readonly message?: string;
    };

export interface AdvancementRecoveryOptions {
  /**
   * 只补审此 runIndex 之前的欠账。turn 提交触发的 catch-up 用它排除
   * 当轮——当轮由唯一 review application 正常验收（补审走 scheduleProxy:false，
   * 吞掉当轮 proxy 调度）。
   */
  readonly beforeRunIndex?: number;
}

export interface AdvancementRecoveryMaintenance {
  prepare(): Promise<void>;
  start(): void;
  resume(): void;
  stop(): Promise<void>;
  beginDrain(): Promise<void>;
  recoverAllOpenSessions(): Promise<readonly AdvancementRecoveryResult[]>;
  recoverConversation(
    conversationId: string,
    options?: AdvancementRecoveryOptions,
  ): Promise<AdvancementRecoveryResult>;
}

export function createAdvancementRecoveryMaintenance(
  options: AdvancementRecoveryMaintenanceOptions,
): AdvancementRecoveryMaintenance {
  return new DefaultAdvancementRecoveryMaintenance(options);
}

class DefaultAdvancementRecoveryMaintenance
  implements AdvancementRecoveryMaintenance
{
  private readonly scheduled = new Set<string>();
  private readonly recovering = new Map<string, Promise<AdvancementRecoveryResult>>();
  private readonly scheduler: ProxyMessageScheduler;
  private cursor?: string;
  private readonly originals = new Map<string, string>();
  private readonly cleanups = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private loop?: Promise<void>;
  private stopped = false;
  private draining = false;
  private abort = new AbortController();

  constructor(private readonly options: AdvancementRecoveryMaintenanceOptions) {
    this.scheduler = new ProxyMessageScheduler({
      proxyTurns: options.proxyTurns,
    });
  }

  async recoverAllOpenSessions(): Promise<readonly AdvancementRecoveryResult[]> {
    if (this.stopped) return [];
    const page = this.options.pending ? await this.options.pending.list(this.cursor) : undefined;
    this.cursor = page?.next;
    const conversations = page ? page.conversationIds.map(id => ({ id })) : await this.options.directory.list();
    const results: AdvancementRecoveryResult[] = [];
    for (const conversation of conversations) {
      if (this.stopped) break;
      try {
        results.push(await this.recoverConversation(conversation.id));
      } catch (error) {
        results.push(this.failed(conversation.id, undefined, undefined, error));
      }
    }
    return results;
  }

  async prepare(): Promise<void> { await this.options.pending?.list(); }
  start(): void {
    if (this.stopped || this.draining || this.timer || this.loop) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.loop = this.recoverAllOpenSessions().then(() => {}, error => {
        if (!this.stopped) this.options.logger?.warn(`[advancement-recovery] ${String(error)}`);
      }).finally(() => { this.loop = undefined; this.start(); });
    }, 1000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    await this.beginDrain();
    this.stopped = true; this.abort.abort();
    clearTimeout(this.timer); this.timer = undefined;
    await this.loop;
    await Promise.allSettled([...this.recovering.values()]);
  }
  async beginDrain(): Promise<void> {
    this.draining = true; this.abort.abort(); clearTimeout(this.timer); this.timer = undefined;
    await this.loop; await Promise.allSettled([...this.recovering.values()]);
  }
  resume(): void {
    if (this.stopped) return;
    this.draining = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.start();
  }

  recoverConversation(
    conversationId: string,
    options?: AdvancementRecoveryOptions,
  ): Promise<AdvancementRecoveryResult> {
    if (this.stopped) return Promise.resolve({ status: 'no-pending-recovery', conversationId });
    const running = this.recovering.get(conversationId);
    if (running) return running;
    const recovery = this.recoverConversationOnce(conversationId, options).finally(
      () => {
        if (this.recovering.get(conversationId) === recovery) {
          this.recovering.delete(conversationId);
        }
      },
    );
    this.recovering.set(conversationId, recovery);
    return recovery;
  }

  private async recoverOriginalAdmissions(conversationId: string): Promise<AdvancementRecoveryResult | undefined> {
    let failure: AdvancementRecoveryResult | undefined;
    let after = this.originals.get(conversationId);
    do {
      const page = await this.options.advancement.listPendingOriginalTasks(conversationId, after);
      if (page.next) this.originals.set(conversationId, page.next); else this.originals.delete(conversationId);
      for (const sessionId of page.sessionIds) {
        if (this.stopped || this.draining) return failure;
        try {
        const session = await this.options.advancement.loadExactSession(conversationId, sessionId);
        const obligation = session?.originalTaskAdmission;
        if (!session || !obligation || obligation.status !== "pending") continue;
        const originalTasks = this.options.originalTasks;
        if (!originalTasks) throw new Error("Original-task admission recovery is not assembled");
        const admitted = await originalTasks.admit(session);
        if (admitted.status === "rejected") {
          // Deletion owns closure; never recreate a deleted conversation to record a rejection.
          if (admitted.reason === "conversation-not-found") continue;
          await this.options.advancement.persistOriginalTaskAdmissionRejection({
            conversationId, advancementSessionId: session.id, turnId: obligation.intent.turnId,
            inputDigest: obligation.intent.inputDigest, reason: admitted.reason,
          });
          continue;
        }
        await this.options.advancement.persistOriginalTaskAdmissionSettlement({
          conversationId, advancementSessionId: session.id, turnId: obligation.intent.turnId,
          inputDigest: obligation.intent.inputDigest, runId: admitted.runId,
        });
        } catch (error) { const failed = this.failed(conversationId, sessionId, undefined, error); failure ??= failed; }
      }
      after = page.next;
    } while (!this.options.pending && after !== undefined);
    return failure;
  }

  private async recoverConversationOnce(
    conversationId: string,
    options?: AdvancementRecoveryOptions,
  ): Promise<AdvancementRecoveryResult> {
    let session: AdvancementSession | null;
    let admissionFailure: AdvancementRecoveryResult | undefined;
    try {
      if (!this.draining) admissionFailure = await this.recoverOriginalAdmissions(conversationId);
      const work = await this.options.pending?.cleanup(conversationId, this.cleanups.get(conversationId));
      if (work?.next) this.cleanups.set(conversationId, work.next); else this.cleanups.delete(conversationId);
      await this.options.reviews.reconcileConversation(conversationId, work?.items);
      if (work?.items.some(item => item.deleted)) return { status: 'no-active-session', conversationId };
      if (this.draining) return { status: 'no-pending-recovery', conversationId };
      session = await this.options.advancement.loadActiveSession(conversationId);
    } catch (err) {
      return this.failed(conversationId, undefined, undefined, err);
    }
    if (!session) return admissionFailure ?? { status: "no-active-session", conversationId };
    if (session.status !== "active") {
      return { status: "not-active", conversationId };
    }

    let lastRecoveredRun: AdvancementRecoveryResult | undefined;
    while (true) {
      if (this.draining || this.stopped) return { status: 'recovery-pending', conversationId };
      const acceptedRun = await this.findUnreviewedAcceptedRun(session, options);
      if (acceptedRun === null) {
        return { status: "awaiting-original-run", conversationId };
      }
      if (!acceptedRun) break;
      const recovered = await this.recoverAcceptedRun(session, acceptedRun);
      if (recovered.status !== "accepted-run-recovered") return recovered;
      lastRecoveredRun = recovered;

      const latest = await this.options.advancement.loadActiveSession(
        conversationId,
      );
      if (!latest) return recovered;
      if (latest.status !== "active") return recovered;
      if (
        !latest.runs.some(
          (review) =>
            review.runRecordRef !== undefined &&
            (this.options.pending ? review.runRecordRef.runIndex === acceptedRun.runRecordRef.runIndex
              : runRefKey(review.runRecordRef) === runRefKey(acceptedRun.runRecordRef)),
        )
      ) {
        return this.failed(
          conversationId,
          latest.id,
          acceptedRun.record.advancement?.proxyMessageId,
          new Error(
            "Accepted-run recovery returned without durably reviewing the selected run",
          ),
        );
      }
      session = latest;
      if (this.options.pending) {
        if (await this.findUnreviewedAcceptedRun(session, options)) return { status: 'recovery-pending', conversationId };
        break;
      }
    }

    if (!session.outstandingProxyMessageId) {
      if (this.draining || this.stopped) return { status: 'recovery-pending', conversationId };
      let rebuilt: Awaited<
        ReturnType<AdvancementReviewAttemptApplication["rebuildMissingProxyMessage"]>
      >;
      try {
        rebuilt = await this.options.reviews.rebuildMissingProxyMessage(session);
      } catch (err) {
        return this.failed(conversationId, session.id, undefined, err);
      }
      if (rebuilt.kind !== "rebuilt") {
        return (
          lastRecoveredRun ?? { status: "no-pending-recovery", conversationId }
        );
      }
      session = rebuilt.session;
      this.emitProxyRebuilt(session, rebuilt.proxyMessage, rebuilt.review);
    }

    const proxyMessage = findOutstandingProxyMessage(session);
    if (!proxyMessage) {
      const result: AdvancementRecoveryResult = {
        status: "missing-proxy",
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: session.outstandingProxyMessageId,
        message: "active advancement session references a missing proxy message",
      };
      this.emitRecoveryFailed(result);
      return result;
    }
    const key = recoveryKey(session, proxyMessage);
    if (this.scheduled.has(key)) {
      return {
        status: "already-scheduled",
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
      };
    }
    if (this.options.proxyTurns.isRunning(conversationId)) {
      return {
        status: "already-running",
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
      };
    }
    // 调度前必须取得显式 unclaimed;查询异常 fail-closed,保留待办下轮重试。
    let durableClaim: AdvancementProxyDurableClaim;
    try {
      durableClaim = await this.options.proxyTurns.inspectDurableClaim(
        conversationId,
        proxyMessage.id,
      );
    } catch (err) {
      return this.failed(conversationId, session.id, proxyMessage.id, err);
    }
    if (durableClaim.status === "owned") {
      return {
        status: "durable-run-owned",
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
        runId: durableClaim.runId,
      };
    }
    if (durableClaim.status === "closed") {
      try {
        await this.options.reviews.settleProxyRun({
          conversationId,
          proxyMessageId: proxyMessage.id,
        });
      } catch (err) {
        return this.failed(conversationId, session.id, proxyMessage.id, err);
      }
      return {
        status: "closed-run-recovered",
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
        runId: durableClaim.runId,
      };
    }

    this.scheduled.add(key);
    try {
      const scheduled = await this.scheduler.schedule({
        session,
        proxyMessage,
        onTaskSettled: () => {
          this.scheduled.delete(key);
        },
      });
      if (scheduled.status === "immediate" || scheduled.status === "queued") {
        const result: AdvancementRecoveryResult = {
          status: "scheduled",
          conversationId,
          advancementSessionId: session.id,
          proxyMessageId: proxyMessage.id,
          scheduleStatus: scheduled.status,
        };
        this.emitProxyRecovered(result);
        return result;
      }
      this.scheduled.delete(key);
      const result: AdvancementRecoveryResult = {
        status: scheduled.status,
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
      };
      this.emitRecoveryFailed(result);
      return result;
    } catch (err) {
      this.scheduled.delete(key);
      return this.failed(conversationId, session.id, proxyMessage.id, err);
    }
  }

  private failed(
    conversationId: string,
    advancementSessionId: string | undefined,
    proxyMessageId: string | undefined,
    err: unknown,
  ): AdvancementRecoveryResult {
    const result: AdvancementRecoveryResult = {
      status: "failed",
      conversationId,
      advancementSessionId,
      proxyMessageId,
      message: err instanceof Error ? err.message : String(err),
    };
    this.options.logger?.warn(
      `[advancement-recovery] ${conversationId}: ${result.message}`,
    );
    this.emitRecoveryFailed(result);
    return result;
  }

  private async findUnreviewedAcceptedRun(
    session: AdvancementSession,
    options?: AdvancementRecoveryOptions,
  ): Promise<
    | {
        readonly record: RunRecord;
        readonly runRecordRef: RunRecordRef;
      }
    | null
    | undefined
  > {
    if (this.options.pending) return this.options.pending.run(session.conversationId, session.id, options?.beforeRunIndex);
    let before: RunRecordRef | undefined;
    const reviewed = new Set(
      session.runs
        .map((run) => run.runRecordRef)
        .filter((ref): ref is RunRecordRef => ref !== undefined)
        .map(runRefKey),
    );
    const lowerRunId =
      session.originalTaskAdmission?.status === "admitted"
        ? session.originalTaskAdmission.runId
        : undefined;
    const candidates: Array<{
      record: RunRecord;
      runRecordRef: RunRecordRef;
    }> = [];
    while (true) {
      const page = await this.options.directory.readRunsReverse(
        session.conversationId,
        {
          limit: RECOVERY_SCAN_PAGE_SIZE,
          ...(before ? { before } : {}),
        },
      );
      for (const item of page.runs) {
        const record = item.record;
        if (!lowerRunId && record.timestamp < session.createdAt) {
          return oldestCandidate(candidates);
        }
        const ref = {
          shardId: item.shardId,
          runIndex: record.runIndex,
        };
        const isLowerBound =
          lowerRunId !== undefined &&
          recoveryRunId({ record, runRecordRef: ref }) === lowerRunId;
        if (
          options?.beforeRunIndex !== undefined &&
          record.runIndex >= options.beforeRunIndex
        ) {
          if (isLowerBound) return oldestCandidate(candidates);
          continue;
        }
        if (
          isRecoverableAcceptedRun(session, record) &&
          !reviewed.has(runRefKey(ref))
        ) {
          candidates.push({
            record,
            runRecordRef: ref,
          });
        }
        if (isLowerBound) {
          return oldestCandidate(candidates);
        }
      }
      if (!page.hasMore || page.runs.length === 0) {
        // The admitted original run is the durable lower bound for this
        // advancement session.  If it is absent, the scanned suffix cannot
        // prove membership and must not advance a later run.
        return lowerRunId ? null : oldestCandidate(candidates);
      }
      const last = page.runs[page.runs.length - 1]!;
      before = { shardId: last.shardId, runIndex: last.record.runIndex };
    }
  }

  private async recoverAcceptedRun(
    session: AdvancementSession,
    accepted: {
      readonly record: RunRecord;
      readonly runRecordRef: RunRecordRef;
    },
  ): Promise<AdvancementRecoveryResult> {
    try {
      const result = await this.options.reviews.reviewAcceptedRun({
        conversationId: session.conversationId,
        runId: recoveryRunId(accepted),
        runIndex: accepted.record.runIndex,
        runRecord: accepted.record,
        runRecordRef: accepted.runRecordRef,
        abortSignal: this.abort.signal,
      });
      await this.options.reviewResults.projectReviewResult({
        conversationId: session.conversationId,
        runId: recoveryRunId(accepted),
        result,
        emitProxyEnqueued: false,
        scheduleProxy: false,
      });
      if (result.kind === "review-deferred") {
        // 补审本身又挂起：review 没落盘、该 run 仍是未审态。必须中断
        // 本次恢复（否则扫描循环会反复命中同一 run 空转），等下一个
        // 恢复触发点重来。
        return {
          status: "review-deferred",
          conversationId: session.conversationId,
          advancementSessionId: session.id,
          runRecordRef: accepted.runRecordRef,
          cause: result.cause,
          message: result.reason,
        };
      }
      return {
        status: "accepted-run-recovered",
        conversationId: session.conversationId,
        advancementSessionId: session.id,
        proxyMessageId: accepted.record.advancement?.proxyMessageId,
        runRecordRef: accepted.runRecordRef,
      };
    } catch (err) {
      return this.failed(
        session.conversationId,
        session.id,
        accepted.record.advancement?.proxyMessageId,
        err,
      );
    }
  }

  private emitProxyRebuilt(
    session: AdvancementSession,
    proxyMessage: AdvancementProxyMessage,
    review: { readonly id: string },
  ): void {
    this.options.events?.emit({
      conversationId: session.conversationId,
      runId: proxyMessage.id,
      event: "advancement:proxy_enqueued",
      payload: {
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
        reviewId: review.id,
      },
    });
  }

  private emitProxyRecovered(
    result: Extract<AdvancementRecoveryResult, { status: "scheduled" }>,
  ): void {
    this.options.events?.emit({
      conversationId: result.conversationId,
      runId: result.proxyMessageId,
      event: "advancement:proxy_recovered",
      payload: {
        advancementSessionId: result.advancementSessionId,
        proxyMessageId: result.proxyMessageId,
        scheduleStatus: result.scheduleStatus,
      },
    });
  }

  private emitRecoveryFailed(
    result: Extract<
      AdvancementRecoveryResult,
      { status: "not-found" | "full" | "busy" | "missing-proxy" | "failed" }
    >,
  ): void {
    this.options.events?.emit({
      conversationId: result.conversationId,
      runId:
        result.proxyMessageId ??
        result.advancementSessionId ??
        result.conversationId,
      event: "advancement:recovery_failed",
      payload: {
        status: result.status,
        advancementSessionId: result.advancementSessionId,
        proxyMessageId: result.proxyMessageId,
        message: result.message,
      },
    });
  }
}

function findOutstandingProxyMessage(
  session: AdvancementSession,
): AdvancementProxyMessage | undefined {
  return session.proxyMessages.find(
    (message) => message.id === session.outstandingProxyMessageId,
  );
}

function recoveryKey(
  session: AdvancementSession,
  proxyMessage: AdvancementProxyMessage,
): string {
  return `${session.conversationId}:${session.id}:${proxyMessage.id}`;
}

function runRefKey(ref: RunRecordRef): string {
  return `${ref.shardId}:${ref.runIndex}`;
}

function oldestCandidate(
  candidates: readonly {
    readonly record: RunRecord;
    readonly runRecordRef: RunRecordRef;
  }[],
):
  | {
      readonly record: RunRecord;
      readonly runRecordRef: RunRecordRef;
    }
  | undefined {
  return candidates.reduce<
    | {
        readonly record: RunRecord;
        readonly runRecordRef: RunRecordRef;
      }
    | undefined
  >(
    (oldest, current) =>
      !oldest || current.record.runIndex < oldest.record.runIndex
        ? current
        : oldest,
    undefined,
  );
}

function isRecoverableAcceptedRun(
  session: AdvancementSession,
  record: RunRecord,
): boolean {
  if (hasPendingWorksceneTask(record)) return false;
  if (record.source === "advancement") {
    return (
      record.advancement?.sessionId === session.id &&
      typeof record.advancement.proxyMessageId === "string"
    );
  }
  return (
    record.source === undefined ||
    record.source === "interactive" ||
    record.source === "channel"
  );
}

function recoveryRunId(accepted: {
  readonly record: RunRecord;
  readonly runRecordRef: RunRecordRef;
}): string {
  const committedRunId = (accepted.record as RunRecord & { runId?: unknown }).runId;
  if (typeof committedRunId === "string" && committedRunId.length > 0) {
    return committedRunId;
  }
  return (
    `legacy-recovered:${accepted.runRecordRef.shardId}:${accepted.runRecordRef.runIndex}`
  );
}
