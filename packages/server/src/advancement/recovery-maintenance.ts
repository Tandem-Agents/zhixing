import type {
  AdvancementProxyMessage,
  AdvancementSession,
  RunRecord,
  RunRecordRef,
} from "@zhixing/core";
import type { ConversationDirectory } from "../runtime/conversation-directory.js";
import type { ConversationManager } from "../runtime/conversation-manager.js";
import { createControlSessionEventEnvelope } from "../rpc/session-events.js";
import type { SessionBroadcast } from "../rpc/session-broadcast.js";
import { SESSION_NOTIFICATIONS } from "../rpc/session-wire.js";
import type { AdvancementController } from "./controller.js";
import {
  ProxyMessageScheduler,
  type ScheduleProxyMessageResult,
} from "./proxy-scheduler.js";
import { dispatchAdvancementReviewResult } from "./review-dispatch.js";

const RECOVERY_SCAN_PAGE_SIZE = 50;

export interface AdvancementRecoveryMaintenanceOptions {
  readonly advancement: AdvancementController;
  readonly manager: ConversationManager;
  readonly directory: ConversationDirectory;
  readonly sessionBroadcast?: () => SessionBroadcast | null;
  readonly logger?: Pick<Console, "warn">;
}

export type AdvancementRecoveryResult =
  | {
      readonly status: "no-active-session" | "not-active" | "no-pending-recovery";
      readonly conversationId: string;
    }
  | {
      readonly status: "already-running" | "already-scheduled";
      readonly conversationId: string;
      readonly advancementSessionId: string;
      readonly proxyMessageId: string;
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
      readonly status: "not-found" | "full" | "missing-proxy" | "failed";
      readonly conversationId: string;
      readonly advancementSessionId?: string;
      readonly proxyMessageId?: string;
      readonly message?: string;
    };

export interface AdvancementRecoveryMaintenance {
  recoverAllOpenSessions(): Promise<readonly AdvancementRecoveryResult[]>;
  recoverConversation(conversationId: string): Promise<AdvancementRecoveryResult>;
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

  constructor(private readonly options: AdvancementRecoveryMaintenanceOptions) {
    this.scheduler = new ProxyMessageScheduler({
      manager: options.manager,
      sessionBroadcast: options.sessionBroadcast,
      conversationExists: (conversationId) => options.directory.exists(conversationId),
    });
  }

  async recoverAllOpenSessions(): Promise<readonly AdvancementRecoveryResult[]> {
    const conversations = await this.options.directory.list();
    const results: AdvancementRecoveryResult[] = [];
    for (const conversation of conversations) {
      results.push(await this.recoverConversation(conversation.id));
    }
    return results;
  }

  recoverConversation(conversationId: string): Promise<AdvancementRecoveryResult> {
    const running = this.recovering.get(conversationId);
    if (running) return running;
    const recovery = this.recoverConversationOnce(conversationId).finally(() => {
      if (this.recovering.get(conversationId) === recovery) {
        this.recovering.delete(conversationId);
      }
    });
    this.recovering.set(conversationId, recovery);
    return recovery;
  }

  private async recoverConversationOnce(
    conversationId: string,
  ): Promise<AdvancementRecoveryResult> {
    let session: AdvancementSession | null;
    try {
      session = await this.options.advancement.loadActiveSession(conversationId);
    } catch (err) {
      return this.failed(conversationId, undefined, undefined, err);
    }
    if (!session) return { status: "no-active-session", conversationId };
    if (session.status !== "active") {
      return { status: "not-active", conversationId };
    }

    let lastRecoveredRun: AdvancementRecoveryResult | undefined;
    while (true) {
      const acceptedRun = await this.findUnreviewedAcceptedRun(session);
      if (!acceptedRun) break;
      const recovered = await this.recoverAcceptedRun(session, acceptedRun);
      if (recovered.status !== "accepted-run-recovered") return recovered;
      lastRecoveredRun = recovered;

      const latest = await this.options.advancement.loadActiveSession(
        conversationId,
      );
      if (!latest) return recovered;
      if (latest.status !== "active") return recovered;
      session = latest;
    }

    if (!session.outstandingProxyMessageId) {
      return lastRecoveredRun ?? { status: "no-pending-recovery", conversationId };
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
    if (this.options.manager.getBusySource(conversationId) === "advancement") {
      return {
        status: "already-running",
        conversationId,
        advancementSessionId: session.id,
        proxyMessageId: proxyMessage.id,
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
  ): Promise<
    | {
        readonly record: RunRecord;
        readonly runRecordRef: RunRecordRef;
      }
    | undefined
  > {
    let before: RunRecordRef | undefined;
    const reviewedThrough = lastReviewedRunIndex(session);
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
        if (reviewedThrough !== undefined && record.runIndex <= reviewedThrough) {
          return oldestCandidate(candidates);
        }
        if (
          reviewedThrough === undefined &&
          record.timestamp < session.createdAt
        ) {
          return oldestCandidate(candidates);
        }
        if (isRecoverableAcceptedRun(session, record)) {
          candidates.push({
            record,
            runRecordRef: {
              shardId: item.shardId,
              runIndex: record.runIndex,
            },
          });
        }
      }
      if (!page.hasMore || page.runs.length === 0) {
        return oldestCandidate(candidates);
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
      const result = await this.options.advancement.afterTurnCommitted({
        conversationId: session.conversationId,
        runIndex: accepted.record.runIndex,
        runRecord: accepted.record,
        runRecordRef: accepted.runRecordRef,
      });
      await dispatchAdvancementReviewResult(
        {
          sessionBroadcast: this.options.sessionBroadcast ?? (() => null),
          conversations: () => this.options.manager,
          conversationExists: (conversationId) =>
            this.options.directory.exists(conversationId),
        },
        {
          conversationId: session.conversationId,
          runId: recoveryRunId(accepted),
          result,
          emitProxyEnqueued: false,
          scheduleProxy: false,
        },
      );
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

  private emitProxyRecovered(
    result: Extract<AdvancementRecoveryResult, { status: "scheduled" }>,
  ): void {
    this.options.sessionBroadcast?.()?.(
      result.conversationId,
      SESSION_NOTIFICATIONS.event,
      createControlSessionEventEnvelope({
        conversationId: result.conversationId,
        runId: result.proxyMessageId,
        event: "advancement:proxy_recovered",
        payload: {
          advancementSessionId: result.advancementSessionId,
          proxyMessageId: result.proxyMessageId,
          scheduleStatus: result.scheduleStatus,
        },
      }),
    );
  }

  private emitRecoveryFailed(
    result: Extract<
      AdvancementRecoveryResult,
      { status: "not-found" | "full" | "missing-proxy" | "failed" }
    >,
  ): void {
    this.options.sessionBroadcast?.()?.(
      result.conversationId,
      SESSION_NOTIFICATIONS.event,
      createControlSessionEventEnvelope({
        conversationId: result.conversationId,
        runId: result.proxyMessageId ?? result.advancementSessionId ?? result.conversationId,
        event: "advancement:recovery_failed",
        payload: {
          status: result.status,
          advancementSessionId: result.advancementSessionId,
          proxyMessageId: result.proxyMessageId,
          message: result.message,
        },
      }),
    );
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

function lastReviewedRunIndex(
  session: AdvancementSession,
): number | undefined {
  const indexes = session.runs.map((run) => run.runIndex);
  return indexes.length > 0 ? Math.max(...indexes) : undefined;
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
  return (
    accepted.record.advancement?.proxyMessageId ??
    `recovered:${accepted.runRecordRef.shardId}:${accepted.runRecordRef.runIndex}`
  );
}
