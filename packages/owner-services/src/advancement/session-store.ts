import { advancementSubmissionOutcome, advancementSubmissionRequestId, type AdvancementSubmissionIdentity, type AdvancementSubmissionReceipt, type AdvancementSubmissionOutcome } from "@zhixing/core/advancement";
import { randomUUID } from "node:crypto";
import {
  runReviewedEvents,
  advancementReviewAttemptMutationId,
  type AdvancementControlEvent,
  type AdvancementEvidenceAttempt,
  type AdvancementEvidenceOutcome,
  type AdvancementEvidenceSettlement,
  type AdvancementOriginalTaskAdmissionIntent,
  type AdvancementExit,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type AdvancementReviewAttempt,
  type AdvancementSession,
  type AdvancementWindowState,
  type ConfirmedRubricSnapshot,
  type CreateAdvancementSessionInput,
  type RubricContractDraftSnapshot,
} from "@zhixing/core/advancement";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type {
  AuthorityCallContext,
  SessionStatePort,
} from "@zhixing/core/contracts";

/**
 * 推进会话存储的统一接口——文件控制日志与权威日志适配器同一形状，
 * 控制器只依赖接口，不感知持久化形态。
 */
export interface AdvancementSessionStore {
  readSubmission(conversationId: string, identity: { readonly surfacePrincipal: string; readonly submissionId: string }): Promise<AdvancementSubmissionReceipt | null>;
  settleSubmission(conversationId: string, identity: AdvancementSubmissionIdentity, outcome: AdvancementSubmissionOutcome): Promise<void>;
  regenerateSession(conversationId: string, previousSessionId: string, nextSessionId: string, draft: RubricContractDraftSnapshot, exit: AdvancementExit, submission?: AdvancementSubmissionIdentity): Promise<{ readonly exited: AdvancementSession; readonly created: AdvancementSession }>;
  createSession(input: CreateAdvancementSessionInput): Promise<AdvancementSession>;
  directOriginalTask(conversationId: string, sessionId: string, admissionIntent: AdvancementOriginalTaskAdmissionIntent, exit: AdvancementExit, timestamp?: string, submission?: AdvancementSubmissionIdentity): Promise<AdvancementSession>;
  rejectOriginalTaskAdmission(conversationId: string, sessionId: string, rejection: { readonly turnId: string; readonly inputDigest: import("@zhixing/core").Digest; readonly reason: "conversation-not-found" | "idempotency-conflict" }, timestamp?: string): Promise<AdvancementSession>;
  listPendingOriginalTasks(conversationId: string, after?: string): Promise<{ readonly sessionIds: readonly string[]; readonly next?: string }>;

  confirmRubric(
    conversationId: string,
    sessionId: string,
    confirmedRubric: ConfirmedRubricSnapshot,
    admissionIntent: AdvancementOriginalTaskAdmissionIntent,
    timestamp?: string,
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession>;
  settleOriginalTaskAdmission(
    conversationId: string,
    sessionId: string,
    settlement: {
      readonly turnId: string;
      readonly inputDigest: import("@zhixing/core").Digest;
      readonly runId: string;
    },
    timestamp?: string,
  ): Promise<AdvancementSession>;
  reviseRubricDraft(
    conversationId: string,
    sessionId: string,
    pendingRubricDraft: RubricContractDraftSnapshot,
    timestamp?: string,
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession>;
  appendEvidenceRequest(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementEvidenceAttempt,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  appendEvidenceResult(
    conversationId: string,
    sessionId: string,
    requestId: string,
    outcome: AdvancementEvidenceOutcome,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  settleEvidence(
    conversationId: string,
    sessionId: string,
    requestId: string,
    settlement: AdvancementEvidenceSettlement,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  transitionReviewAttempt(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementReviewAttempt,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  appendRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    timestamp?: string,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementSession>;
  appendTerminalRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    terminal: {
      readonly type: "completed" | "exited";
      readonly exit: AdvancementExit;
      readonly timestamp?: string;
    },
    timestamp?: string,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementSession>;
  appendRunReviewWithProxyMessage(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    proxyMessage: AdvancementProxyMessage,
    timestamp?: string,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementSession>;
  enqueueProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessage: AdvancementProxyMessage,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  settleProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessageId: string,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  completeSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  exitSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  cancelSession(
    conversationId: string,
    sessionId: string,
    exit?: AdvancementExit,
    timestamp?: string,
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession>;
  loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null>;
  loadActiveSession(conversationId: string): Promise<AdvancementSession | null>;
  loadConversationSessions(conversationId: string): Promise<AdvancementSession[]>;
  removeConversation(conversationId: string): Promise<void>;
  listConversationDataCandidates(): Promise<readonly string[]>;
  removeConversationDataCandidate(candidateId: string): Promise<void>;
}

export interface SessionAdvancementStoreOptions {
  /** Required conversation-owner state port captured before publication. */
  readonly port: SessionStatePort;
  readonly hostComponent?: string;
  readonly requestIdFor?: () => string;
  readonly now?: () => string;
}

/**
 * 权威日志适配的推进会话存储——写入经 SessionStatePort 的 advancement-event
 * 原子进入对话 owner 权威日志，读取复用同一折叠头状态；事件构造与返回
 * 语义和文件控制日志一致，控制器零感知。
 */
export class SessionAdvancementStore implements AdvancementSessionStore {
  readonly #port: SessionStatePort;
  readonly #hostComponent: string;
  readonly #requestIdFor: () => string;
  readonly #now: () => string;

  constructor(options: SessionAdvancementStoreOptions) {
    this.#port = options.port;
    this.#hostComponent = options.hostComponent ?? "advancement-owner-services";
    this.#requestIdFor = options.requestIdFor ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  readSubmission(conversationId: string, identity: { readonly surfacePrincipal: string; readonly submissionId: string }) {
    return this.#port.readAdvancementSubmission(conversationId, identity, this.#ctx(this.#requestIdFor()));
  }

  async settleSubmission(conversationId: string, identity: AdvancementSubmissionIdentity, outcome: AdvancementSubmissionOutcome): Promise<void> {
    const receipt = { identity, outcome };
    const existing = await this.readSubmission(conversationId, identity);
    if (existing) {
      if (!canonicalEqual(existing, receipt)) throw Error("Advancement submission identity conflict");
      return;
    }
    const requestId = advancementSubmissionRequestId(conversationId, identity.surfacePrincipal, identity.submissionId);
    try {
      await this.#port.mutate(conversationId, { kind: "advancement-event", events: [{ type: "submission_settled", conversationId, timestamp: this.#now(), receipt }] }, this.#ctx(requestId));
    } catch (error) {
      const recovered = await this.readSubmission(conversationId, identity).catch(() => null);
      if (!recovered || !canonicalEqual(recovered, receipt)) throw error;
    }
  }

  async regenerateSession(conversationId: string, previousSessionId: string, nextSessionId: string, draft: RubricContractDraftSnapshot, exit: AdvancementExit, submission?: AdvancementSubmissionIdentity): Promise<{ readonly exited: AdvancementSession; readonly created: AdvancementSession }> {
    const exited = await this.#write(conversationId, [{ type: "session_regenerated", sessionId: previousSessionId, nextSessionId, timestamp: draft.createdAt, pendingRubricDraft: draft, exit }], undefined, submission);
    const created = await this.loadSession(conversationId, nextSessionId);
    if (!created) throw Error("Advancement regenerated session missing after commit");
    return { exited, created };
  }

  async directOriginalTask(conversationId: string, sessionId: string, admissionIntent: AdvancementOriginalTaskAdmissionIntent, exit: AdvancementExit, timestamp = this.#now(), submission?: AdvancementSubmissionIdentity): Promise<AdvancementSession> {
    return this.#write(conversationId, [{ type: "original_task_directed", sessionId, timestamp, admissionIntent, exit }], undefined, submission);
  }

  async rejectOriginalTaskAdmission(conversationId: string, sessionId: string, rejection: { readonly turnId: string; readonly inputDigest: import("@zhixing/core").Digest; readonly reason: "conversation-not-found" | "idempotency-conflict" }, timestamp = this.#now()): Promise<AdvancementSession> {
    return this.#write(conversationId, [{ type: "original_task_admission_rejected", sessionId, timestamp, turnId: rejection.turnId, inputDigest: rejection.inputDigest, reason: rejection.reason }]);
  }

  listPendingOriginalTasks(conversationId: string, after?: string) {
    return this.#port.listPendingAdvancementOriginalTasks(conversationId, this.#ctx(this.#requestIdFor()), after);
  }

  async createSession(
    input: CreateAdvancementSessionInput,
  ): Promise<AdvancementSession> {
    const timestamp = input.createdAt ?? this.#now();
    return await this.#write(input.conversationId, [
      {
        type: "session_created",
        timestamp,
        sessionId: input.id,
        conversationId: input.conversationId,
        originalUserTask: input.originalUserTask,
        pendingRubricDraft: input.pendingRubricDraft,
      },
    ], undefined, input.submission);
  }

  async confirmRubric(
    conversationId: string,
    sessionId: string,
    confirmedRubric: ConfirmedRubricSnapshot,
    admissionIntent: AdvancementOriginalTaskAdmissionIntent,
    timestamp = this.#now(),
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      {
        type: "rubric_confirmed",
        timestamp,
        sessionId,
        confirmedRubric,
        admissionIntent,
      },
    ], undefined, submission);
  }

  async settleOriginalTaskAdmission(
    conversationId: string,
    sessionId: string,
    settlement: {
      readonly turnId: string;
      readonly inputDigest: import("@zhixing/core").Digest;
      readonly runId: string;
    },
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      {
        type: "original_task_admitted",
        timestamp,
        sessionId,
        ...settlement,
      },
    ]);
  }

  async reviseRubricDraft(
    conversationId: string,
    sessionId: string,
    pendingRubricDraft: RubricContractDraftSnapshot,
    timestamp = this.#now(),
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "rubric_draft_revised", timestamp, sessionId, pendingRubricDraft },
    ], undefined, submission);
  }

  async appendEvidenceRequest(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementEvidenceAttempt,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "evidence_requested", timestamp, sessionId, attempt },
    ], stableEvidenceMutationId(attempt.reviewId, attempt.generation, `requested:${attempt.attempt}`));
  }

  async appendEvidenceResult(
    conversationId: string,
    sessionId: string,
    requestId: string,
    outcome: AdvancementEvidenceOutcome,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "evidence_result", timestamp, sessionId, requestId, outcome },
    ], stableEvidenceMutationId(requestId, 1, `result:${protocolDigest("AdvancementEvidenceOutcome", 1, outcome)}`));
  }

  async settleEvidence(
    conversationId: string,
    sessionId: string,
    requestId: string,
    settlement: AdvancementEvidenceSettlement,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "evidence_settled", timestamp, sessionId, requestId, settlement },
    ], stableEvidenceMutationId(requestId, 1, `settled:${settlement}`));
  }

  async transitionReviewAttempt(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementReviewAttempt,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(
      conversationId,
      [{ type: "review_attempt_transitioned", timestamp, sessionId, attempt }],
      advancementReviewAttemptMutationId(
        attempt.lineageId,
        attempt.generation,
        attempt.phase,
      ),
    );
  }

  async appendRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    timestamp = this.#now(),
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementSession> {
    return await this.#write(
      conversationId,
      [
        ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
        ...evidenceSettlementEvent(sessionId, evidenceRequestId, timestamp),
        ...reviewAttemptEvent(sessionId, reviewAttempt, timestamp),
      ],
      reviewAttempt
        ? advancementReviewAttemptMutationId(
            reviewAttempt.lineageId,
            reviewAttempt.generation,
            reviewAttempt.phase,
          )
        : undefined,
    );
  }

  async appendTerminalRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    terminal: {
      readonly type: "completed" | "exited";
      readonly exit: AdvancementExit;
      readonly timestamp?: string;
    },
    timestamp = review.reviewedAt,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementSession> {
    return await this.#write(
      conversationId,
      [
        ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
        ...evidenceSettlementEvent(sessionId, evidenceRequestId, timestamp),
        ...reviewAttemptEvent(sessionId, reviewAttempt, timestamp),
        {
          type: terminal.type,
          timestamp: terminal.timestamp ?? terminal.exit.occurredAt,
          sessionId,
          exit: terminal.exit,
        },
      ],
      reviewAttempt
        ? advancementReviewAttemptMutationId(
            reviewAttempt.lineageId,
            reviewAttempt.generation,
            reviewAttempt.phase,
          )
        : undefined,
    );
  }

  async appendRunReviewWithProxyMessage(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    proxyMessage: AdvancementProxyMessage,
    timestamp = review.reviewedAt,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementSession> {
    return await this.#write(
      conversationId,
      [
        ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
        ...evidenceSettlementEvent(sessionId, evidenceRequestId, timestamp),
        ...reviewAttemptEvent(sessionId, reviewAttempt, timestamp),
        {
          type: "proxy_enqueued",
          timestamp: proxyMessage.createdAt,
          sessionId,
          proxyMessage,
        },
      ],
      reviewAttempt
        ? advancementReviewAttemptMutationId(
            reviewAttempt.lineageId,
            reviewAttempt.generation,
            reviewAttempt.phase,
          )
        : undefined,
    );
  }

  async enqueueProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessage: AdvancementProxyMessage,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "proxy_enqueued", timestamp, sessionId, proxyMessage },
    ]);
  }

  async settleProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessageId: string,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    const session = await this.#requireHead(conversationId, sessionId);
    const knownProxy = session.proxyMessages.some(
      (message) => message.id === proxyMessageId,
    );
    if (knownProxy && session.outstandingProxyMessageId !== proxyMessageId) {
      return session;
    }
    return await this.#write(conversationId, [
      { type: "proxy_settled", timestamp, sessionId, proxyMessageId },
    ]);
  }

  async completeSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "completed", timestamp, sessionId, exit },
    ]);
  }

  async exitSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "exited", timestamp, sessionId, exit },
    ]);
  }

  async cancelSession(
    conversationId: string,
    sessionId: string,
    exit?: AdvancementExit,
    timestamp = this.#now(),
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "cancelled", timestamp, sessionId, exit },
    ], undefined, submission);
  }

  async loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null> {
    return this.#port.readAdvancementState(conversationId, this.#ctx(this.#requestIdFor()), sessionId);
  }

  async loadActiveSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    const head = await this.#read(conversationId);
    return head &&
      (head.status === "awaiting-rubric-confirmation" ||
        head.status === "active")
      ? head
      : null;
  }

  async loadConversationSessions(
    conversationId: string,
  ): Promise<AdvancementSession[]> {
    const head = await this.#read(conversationId);
    return head ? [head] : [];
  }

  /**
   * 推进数据的生命周期已并入对话权威日志——对话删除（conversation-delete）
   * 即其删除闭包，此处不再存在独立目录形态的清理对象。
   */
  async removeConversation(_conversationId: string): Promise<void> {}

  /** 数据入住对话权威日志后不再产生独立的孤儿候选。 */
  async listConversationDataCandidates(): Promise<readonly string[]> {
    return [];
  }

  async removeConversationDataCandidate(_candidateId: string): Promise<void> {}

  async #requireHead(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession> {
    const head = await this.loadSession(conversationId, sessionId);
    if (!head || head.id !== sessionId) {
      throw new Error(`AdvancementStore: session "${sessionId}" not found`);
    }
    return head;
  }

  async #read(conversationId: string): Promise<AdvancementSession | null> {
    return await this.#port.readAdvancementState(
      conversationId,
      this.#ctx(this.#requestIdFor()),
    );
  }

  async #write(
    conversationId: string,
    events: readonly AdvancementControlEvent[],
    requestId?: string,
    submission?: AdvancementSubmissionIdentity,
  ): Promise<AdvancementSession> {
    const sessionId = events[0]?.sessionId;
    if (!sessionId || events.some(event => event.type === "submission_settled")) throw Error("Business write requires session events");
    let batch: readonly AdvancementControlEvent[] = events;
    let receipt: AdvancementSubmissionReceipt | undefined;
    if (submission) {
      const existing = await this.readSubmission(conversationId, submission);
      if (existing) {
        if (existing.identity.requestDigest !== submission.requestDigest) throw Error("Advancement submission identity conflict");
        const outcome = existing.outcome;
        if (!("sessionId" in outcome)) throw Error("Advancement submission already has another disposition");
        const committed = await this.loadSession(conversationId, sessionId);
        if (!committed) throw Error("Advancement submission session is unavailable");
        return committed;
      }
      receipt = { identity: submission, outcome: await this.#submissionOutcome(conversationId, events) };
      requestId = advancementSubmissionRequestId(conversationId, submission.surfacePrincipal, submission.submissionId);
      batch = [...events, { type: "submission_settled", conversationId, timestamp: events.at(-1)!.timestamp, receipt }];
    }
    try {
      await this.#port.mutate(
        conversationId,
        { kind: "advancement-event", events: batch },
        this.#ctx(requestId ?? this.#requestIdFor()),
      );
    } catch (error) {
      if (requestId === undefined) throw error;
      if (receipt) {
        const recovered = await this.readSubmission(conversationId, receipt.identity).catch(() => null);
        if (!recovered || !canonicalEqual(recovered, receipt)) throw error;
        const committed = await this.loadSession(conversationId, sessionId);
        if (committed) return committed;
        throw error;
      }
      try {
        const head = await this.loadSession(conversationId, sessionId);
        if (head && events.every((event) => advancementEventIsReflected(head, event))) {
          return head;
        }
      } catch {
        // The original mutation error remains the authoritative failure.
      }
      throw error;
    }
    const head = await this.loadSession(conversationId, sessionId);
    if (!head) {
      throw new Error("AdvancementStore: session disappeared after write");
    }
    return head;
  }

  async #submissionOutcome(conversationId: string, events: readonly AdvancementControlEvent[]): Promise<AdvancementSubmissionOutcome> {
    if (events.length !== 1) throw Error("Submission must bind one finite business transition");
    const event = events[0]!;
    if (event.type === "submission_settled") throw Error("Submission receipt cannot settle itself");
    return advancementSubmissionOutcome(event, event.type === "rubric_draft_revised" ? await this.loadSession(conversationId, event.sessionId) : undefined);
  }

  #ctx(requestId: string): AuthorityCallContext {
    return {
      principal: { kind: "host", component: this.#hostComponent },
      requestId,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

function advancementEventIsReflected(
  session: AdvancementSession,
  event: AdvancementControlEvent,
): boolean {
  if (event.type === "submission_settled" || event.sessionId !== session.id) return false;
  switch (event.type) {
    case "review_attempt_transitioned": {
      const current = session.reviewAttempts?.find(
        (attempt) => attempt.lineageId === event.attempt.lineageId,
      );
      return current !== undefined && canonicalEqual(current, event.attempt);
    }
    case "run_reviewed":
      return session.runs.some(
        (review) => review.id === event.review.id && canonicalEqual(review, event.review),
      );
    case "window_updated":
      return canonicalEqual(session.advancementWindow, event.advancementWindow);
    case "evidence_requested": {
      const pending = session.evidence?.pending.find(
        (attempt) => attempt.requestId === event.attempt.requestId,
      );
      if (pending && canonicalEqual(pending, event.attempt)) return true;
      const generation = session.evidence?.generations?.find(
        (entry) =>
          entry.reviewId === event.attempt.reviewId &&
          entry.generation === event.attempt.generation,
      );
      return (generation?.lastAttempt ?? 0) >= event.attempt.attempt;
    }
    case "evidence_result": {
      const pending = session.evidence?.pending.find(
        (attempt) => attempt.requestId === event.requestId,
      );
      return pending?.outcome !== undefined && canonicalEqual(pending.outcome, event.outcome);
    }
    case "evidence_settled":
      return !session.evidence?.pending.some(
        (attempt) => attempt.requestId === event.requestId,
      );
    case "proxy_enqueued":
      return session.proxyMessages.some(
        (message) =>
          message.id === event.proxyMessage.id &&
          canonicalEqual(message, event.proxyMessage),
      );
    case "completed":
      return session.status === "completed" && canonicalEqual(session.exit, event.exit);
    case "exited":
      return session.status === "exited" && canonicalEqual(session.exit, event.exit);
    default:
      return false;
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function reviewAttemptEvent(
  sessionId: string,
  attempt: AdvancementReviewAttempt | undefined,
  timestamp: string,
): AdvancementControlEvent[] {
  return attempt
    ? [{ type: "review_attempt_transitioned", timestamp, sessionId, attempt }]
    : [];
}

function stableEvidenceMutationId(
  identity: string,
  generation: number,
  transition: string,
): string {
  return `adv-evidence-mutation:${protocolDigest("AdvancementEvidenceMutation", 1, {
    identity,
    generation,
    transition,
  }).slice("sha256:".length)}`;
}

function evidenceSettlementEvent(
  sessionId: string,
  requestId: string | undefined,
  timestamp: string,
): AdvancementControlEvent[] {
  return requestId
    ? [{
        type: "evidence_settled",
        timestamp,
        sessionId,
        requestId,
        settlement: "consumed",
      }]
    : [];
}
