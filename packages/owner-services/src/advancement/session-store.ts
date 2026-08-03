import { randomUUID } from "node:crypto";
import {
  runReviewedEvents,
  type AdvancementControlEvent,
  type AdvancementEvidenceAttempt,
  type AdvancementEvidenceOutcome,
  type AdvancementEvidenceSettlement,
  type AdvancementExit,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type AdvancementSession,
  type AdvancementWindowState,
  type ConfirmedRubricSnapshot,
  type CreateAdvancementSessionInput,
  type RubricContractDraftSnapshot,
} from "@zhixing/core";
import type {
  AuthorityCallContext,
  SessionStatePort,
} from "@zhixing/core/contracts";

/**
 * 推进会话存储的统一接口——文件控制日志与权威日志适配器同一形状，
 * 控制器只依赖接口，不感知持久化形态。
 */
export interface AdvancementSessionStore {
  createSession(input: CreateAdvancementSessionInput): Promise<AdvancementSession>;
  confirmRubric(
    conversationId: string,
    sessionId: string,
    confirmedRubric: ConfirmedRubricSnapshot,
    timestamp?: string,
  ): Promise<AdvancementSession>;
  reviseRubricDraft(
    conversationId: string,
    sessionId: string,
    pendingRubricDraft: RubricContractDraftSnapshot,
    timestamp?: string,
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
  appendRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    timestamp?: string,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
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
  ): Promise<AdvancementSession>;
  appendRunReviewWithProxyMessage(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    proxyMessage: AdvancementProxyMessage,
    timestamp?: string,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
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
  ): Promise<AdvancementSession>;
  loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null>;
  loadActiveSession(conversationId: string): Promise<AdvancementSession | null>;
  loadConversationSessions(conversationId: string): Promise<AdvancementSession[]>;
  removeConversation(conversationId: string): Promise<void>;
  sweepOrphanDirs(
    isConversationDirAlive: (dirName: string) => Promise<boolean>,
  ): Promise<{ scanned: number; removed: number; warnings: string[] }>;
}

export interface SessionAdvancementStoreOptions {
  /**
   * 惰性解析的会话状态端口——权威运行时晚于控制器装配，调用时才解析；
   * 未装配即 fail-closed（不得回退到任何本地文件形态）。
   */
  readonly port: () => SessionStatePort;
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
  readonly #port: () => SessionStatePort;
  readonly #hostComponent: string;
  readonly #requestIdFor: () => string;
  readonly #now: () => string;

  constructor(options: SessionAdvancementStoreOptions) {
    this.#port = options.port;
    this.#hostComponent = options.hostComponent ?? "advancement-owner-services";
    this.#requestIdFor = options.requestIdFor ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #requirePort(): SessionStatePort {
    const port = this.#port();
    if (!port) {
      throw new Error(
        "AdvancementStore: session state port is not assembled",
      );
    }
    return port;
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
    ]);
  }

  async confirmRubric(
    conversationId: string,
    sessionId: string,
    confirmedRubric: ConfirmedRubricSnapshot,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "rubric_confirmed", timestamp, sessionId, confirmedRubric },
    ]);
  }

  async reviseRubricDraft(
    conversationId: string,
    sessionId: string,
    pendingRubricDraft: RubricContractDraftSnapshot,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "rubric_draft_revised", timestamp, sessionId, pendingRubricDraft },
    ]);
  }

  async appendEvidenceRequest(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementEvidenceAttempt,
    timestamp = this.#now(),
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "evidence_requested", timestamp, sessionId, attempt },
    ]);
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
    ]);
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
    ]);
  }

  async appendRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    timestamp = this.#now(),
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
      ...evidenceSettlementEvent(sessionId, evidenceRequestId, timestamp),
    ]);
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
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
      {
        type: terminal.type,
        timestamp: terminal.timestamp ?? terminal.exit.occurredAt,
        sessionId,
        exit: terminal.exit,
      },
      ...evidenceSettlementEvent(sessionId, evidenceRequestId, timestamp),
    ]);
  }

  async appendRunReviewWithProxyMessage(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    proxyMessage: AdvancementProxyMessage,
    timestamp = review.reviewedAt,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
      {
        type: "proxy_enqueued",
        timestamp: proxyMessage.createdAt,
        sessionId,
        proxyMessage,
      },
      ...evidenceSettlementEvent(sessionId, evidenceRequestId, timestamp),
    ]);
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
  ): Promise<AdvancementSession> {
    return await this.#write(conversationId, [
      { type: "cancelled", timestamp, sessionId, exit },
    ]);
  }

  async loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null> {
    const head = await this.#read(conversationId);
    return head?.id === sessionId ? head : null;
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

  /** 数据入住对话权威日志后不再产生孤儿目录；保留接口形状供治理任务调用。 */
  async sweepOrphanDirs(
    _isConversationDirAlive: (dirName: string) => Promise<boolean>,
  ): Promise<{ scanned: number; removed: number; warnings: string[] }> {
    return { scanned: 0, removed: 0, warnings: [] };
  }

  async #requireHead(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession> {
    const head = await this.#read(conversationId);
    if (!head || head.id !== sessionId) {
      throw new Error(`AdvancementStore: session "${sessionId}" not found`);
    }
    return head;
  }

  async #read(conversationId: string): Promise<AdvancementSession | null> {
    return await this.#requirePort().readAdvancementState(
      conversationId,
      this.#ctx(this.#requestIdFor()),
    );
  }

  async #write(
    conversationId: string,
    events: readonly AdvancementControlEvent[],
  ): Promise<AdvancementSession> {
    await this.#requirePort().mutate(
      conversationId,
      { kind: "advancement-event", events },
      this.#ctx(this.#requestIdFor()),
    );
    const head = await this.#read(conversationId);
    if (!head) {
      throw new Error("AdvancementStore: session disappeared after write");
    }
    return head;
  }

  #ctx(requestId: string): AuthorityCallContext {
    return {
      principal: { kind: "host", component: this.#hostComponent },
      requestId,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
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
