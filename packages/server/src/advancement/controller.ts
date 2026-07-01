import {
  AdvancementStore,
  ConservativeAdvancementAdmissionStrategy,
  RubricContractBuilder,
  createAdvancementWindowReviewEntry,
  type AdvancementAdmissionDecision,
  type AdvancementAdmissionStrategy,
  type AdvancementExit,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type AdvancementRunReviewOutput,
  type AdvancementSession,
  type AdvancementWindowState,
  type ConfirmedRubricSnapshot,
  type FailureHandlingSpec,
  type RunRecordInput,
  type RunRecordRef,
  type RubricContractDraftSnapshot,
  type UserTurnInput,
  userTurnInputFromText,
} from "@zhixing/core";
import { randomUUID } from "node:crypto";

export type AdvancementPrepareResult =
  | {
      readonly kind: "run-direct";
      readonly admission: AdvancementAdmissionDecision;
    }
  | {
      readonly kind: "active-user-turn";
      readonly session: AdvancementSession;
      readonly admission: AdvancementAdmissionDecision;
    }
  | {
      readonly kind: "active-session-taken-over";
      readonly session: AdvancementSession;
      readonly admission: AdvancementAdmissionDecision;
      readonly exit: AdvancementExit;
    }
  | {
      readonly kind: "awaiting-rubric-confirmation";
      readonly session: AdvancementSession;
      readonly draft: RubricContractDraftSnapshot;
      readonly admission: AdvancementAdmissionDecision;
    }
  | {
      readonly kind: "direct-original-task";
      readonly session: AdvancementSession;
      readonly originalTurnId: string;
      readonly originalUserTask: UserTurnInput;
    }
  | {
      readonly kind: "cancelled-pending-task";
      readonly session: AdvancementSession;
      readonly originalTurnId: string;
    }
  | {
      readonly kind: "contract-failed";
      readonly conversationId: string;
      readonly originalTurnId: string;
      readonly error: { readonly message: string };
    }
  | {
      readonly kind: "await-existing-confirmation";
      readonly session: AdvancementSession;
      readonly draft: RubricContractDraftSnapshot;
    };

export interface AdvancementConfirmedTurn {
  readonly session: AdvancementSession;
  readonly originalTurnId: string;
  readonly originalUserTask: UserTurnInput;
}

export interface AdvancementRevisedDraft {
  readonly session: AdvancementSession;
  readonly draft: RubricContractDraftSnapshot;
}

export type AdvancementCancelResult =
  | {
      readonly kind: "cancelled";
      readonly session: AdvancementSession;
      readonly originalTurnId?: string;
    }
  | {
      readonly kind: "direct-original-task";
      readonly session: AdvancementSession;
      readonly originalTurnId: string;
      readonly originalUserTask: UserTurnInput;
    };

export interface AdvancementControllerOptions {
  readonly store?: AdvancementStore;
  readonly contractBuilder?: RubricContractBuilder;
  readonly admissionStrategy?: AdvancementAdmissionStrategy;
  readonly reviewer?: AdvancementRunReviewer;
  readonly now?: () => string;
  readonly reviewIdGenerator?: () => string;
  readonly proxyIdGenerator?: () => string;
}

export interface AdvancementReviewRunInput {
  readonly sessionId: string;
  readonly originalUserTask: UserTurnInput;
  readonly rubric: ConfirmedRubricSnapshot;
  readonly runIndex: number;
  readonly runRecord: RunRecordInput;
  readonly runRecordRef?: RunRecordRef;
  readonly priorReviews?: readonly AdvancementRunReview[];
  readonly advancementWindow?: AdvancementWindowState;
  readonly abortSignal?: AbortSignal;
}

export interface AdvancementRunReviewer {
  reviewRun(input: AdvancementReviewRunInput): Promise<AdvancementRunReviewOutput>;
}

export type AdvancementTurnReviewResult =
  | { readonly kind: "skipped"; readonly reason: "no-active-session" | "not-active" }
  | {
      readonly kind: "reviewed";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
    }
  | {
      readonly kind: "proxy-enqueued";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly proxyMessage: AdvancementProxyMessage;
    }
  | {
      readonly kind: "completed";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly exit: AdvancementExit;
    }
  | {
      readonly kind: "exited";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly exit: AdvancementExit;
    };

export class AdvancementController {
  private readonly store: AdvancementStore;
  private readonly contractBuilder: RubricContractBuilder;
  private readonly admissionStrategy: AdvancementAdmissionStrategy;
  private readonly reviewer?: AdvancementRunReviewer;
  private readonly now: () => string;
  private readonly reviewIdGenerator: () => string;
  private readonly proxyIdGenerator: () => string;

  constructor(options: AdvancementControllerOptions = {}) {
    this.store = options.store ?? new AdvancementStore();
    this.contractBuilder = options.contractBuilder ?? new RubricContractBuilder();
    this.admissionStrategy =
      options.admissionStrategy ?? new ConservativeAdvancementAdmissionStrategy();
    this.reviewer = options.reviewer;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reviewIdGenerator =
      options.reviewIdGenerator ?? (() => `adv_review_${randomUUID()}`);
    this.proxyIdGenerator =
      options.proxyIdGenerator ?? (() => `adv_proxy_${randomUUID()}`);
  }

  async prepareUserTurn(input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly userInput: UserTurnInput;
    readonly beforeCreateSession?: () => Promise<void>;
  }): Promise<AdvancementPrepareResult> {
    const open = await this.store.loadActiveSession(input.conversationId);
    if (open?.status === "awaiting-rubric-confirmation") {
      const admission = await this.admissionStrategy.decide({
        input: input.userInput,
        hasOpenAdvancementSession: true,
      });
      if (admission.action === "downgrade-to-direct") {
        const cancelled = await this.cancelSession(
          input.conversationId,
          open.id,
          "用户选择直接执行原始任务",
        );
        return {
          kind: "direct-original-task",
          session: cancelled,
          originalTurnId: open.pendingRubricDraft!.originalTurnId,
          originalUserTask: open.originalUserTask,
        };
      }
      if (admission.action === "cancel-pending-task") {
        const cancelled = await this.cancelSession(
          input.conversationId,
          open.id,
          "用户取消待确认任务",
        );
        return {
          kind: "cancelled-pending-task",
          session: cancelled,
          originalTurnId: open.pendingRubricDraft!.originalTurnId,
        };
      }
      return {
        kind: "await-existing-confirmation",
        session: open,
        draft: open.pendingRubricDraft!,
      };
    }

    if (open?.status === "active") {
      const admission = await this.admissionStrategy.decide({
        input: input.userInput,
        hasActiveAdvancementSession: true,
      });
      if (admission.action === "take-over-active") {
        const exit: AdvancementExit = {
          reason: "user-took-over",
          message: "用户接管或改变了当前推进目标，原推进闭环已退出。",
          occurredAt: this.now(),
        };
        const cancelled = await this.store.cancelSession(
          input.conversationId,
          open.id,
          exit,
          exit.occurredAt,
        );
        return {
          kind: "active-session-taken-over",
          session: cancelled,
          admission,
          exit,
        };
      }
      return {
        kind: "active-user-turn",
        session: open,
        admission,
      };
    }

    const admission = await this.admissionStrategy.decide({
      input: input.userInput,
    });
    if (admission.action !== "start-advancement") {
      return { kind: "run-direct", admission };
    }

    let draft: RubricContractDraftSnapshot;
    try {
      draft = await this.contractBuilder.buildDraft({
        originalTurnId: input.turnId,
        originalUserTask: input.userInput,
      });
    } catch (err) {
      return {
        kind: "contract-failed",
        conversationId: input.conversationId,
        originalTurnId: input.turnId,
        error: { message: errorMessage(err) },
      };
    }

    await input.beforeCreateSession?.();
    const session = await this.store.createSession({
      id: `adv_${draft.draftId}`,
      conversationId: input.conversationId,
      originalUserTask: input.userInput,
      pendingRubricDraft: draft,
      createdAt: draft.createdAt,
    });

    return {
      kind: "awaiting-rubric-confirmation",
      session,
      draft,
      admission,
    };
  }

  async confirmRubric(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
  }): Promise<AdvancementConfirmedTurn> {
    const session = await this.requireSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (session.status !== "awaiting-rubric-confirmation") {
      throw new Error(
        `AdvancementController: session "${session.id}" is not awaiting rubric confirmation`,
      );
    }
    const draft = session.pendingRubricDraft;
    if (!draft) {
      throw new Error(
        `AdvancementController: session "${session.id}" has no pending rubric draft`,
      );
    }
    const confirmedRubric = await this.contractBuilder.confirmDraft(draft);
    const confirmed = await this.store.confirmRubric(
      input.conversationId,
      input.advancementSessionId,
      confirmedRubric,
      confirmedRubric.confirmedAt,
    );
    return {
      session: confirmed,
      originalTurnId: draft.originalTurnId,
      originalUserTask: confirmed.originalUserTask,
    };
  }

  async reviseRubricDraft(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly userFeedback: string;
  }): Promise<AdvancementRevisedDraft> {
    const session = await this.requireSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (session.status !== "awaiting-rubric-confirmation") {
      throw new Error(
        `AdvancementController: session "${session.id}" is not awaiting rubric confirmation`,
      );
    }
    const draft = session.pendingRubricDraft;
    if (!draft) {
      throw new Error(
        `AdvancementController: session "${session.id}" has no pending rubric draft`,
      );
    }
    const revised = await this.contractBuilder.reviseDraft({
      currentDraft: draft,
      originalUserTask: session.originalUserTask,
      userFeedback: input.userFeedback,
    });
    const updated = await this.store.reviseRubricDraft(
      input.conversationId,
      input.advancementSessionId,
      revised,
      revised.createdAt,
    );
    return { session: updated, draft: revised };
  }

  async cancelRubric(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly executeOriginal?: boolean;
    readonly reason?: AdvancementExit["reason"];
    readonly message?: string;
  }): Promise<AdvancementCancelResult> {
    const session = await this.requireSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (session.status !== "awaiting-rubric-confirmation") {
      throw new Error(
        `AdvancementController: session "${session.id}" is not awaiting rubric confirmation`,
      );
    }
    const draft = session.pendingRubricDraft;
    const cancelled = await this.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      input.message ??
        (input.executeOriginal
          ? "用户选择直接执行原始任务"
          : "用户取消 Rubric 确认"),
      input.reason,
    );
    if (input.executeOriginal && draft) {
      return {
        kind: "direct-original-task",
        session: cancelled,
        originalTurnId: draft.originalTurnId,
        originalUserTask: session.originalUserTask,
      };
    }
    return {
      kind: "cancelled",
      session: cancelled,
      originalTurnId: draft?.originalTurnId,
    };
  }

  async cancelOpenSession(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly reason?: AdvancementExit["reason"];
    readonly message: string;
  }): Promise<AdvancementSession> {
    await this.requireSession(input.conversationId, input.advancementSessionId);
    return await this.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      input.message,
      input.reason,
    );
  }

  async cancelOpenConversationSession(input: {
    readonly conversationId: string;
    readonly reason?: AdvancementExit["reason"];
    readonly message: string;
  }): Promise<AdvancementSession | null> {
    const session = await this.store.loadActiveSession(input.conversationId);
    if (!session) return null;
    return await this.cancelSession(
      input.conversationId,
      session.id,
      input.message,
      input.reason,
    );
  }

  async loadActiveSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    return await this.store.loadActiveSession(conversationId);
  }

  async settleProxyMessage(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly proxyMessageId: string;
  }): Promise<AdvancementSession> {
    return await this.store.settleProxyMessage(
      input.conversationId,
      input.advancementSessionId,
      input.proxyMessageId,
      this.now(),
    );
  }

  async afterTurnCommitted(input: {
    readonly conversationId: string;
    readonly runIndex: number;
    readonly runRecord: RunRecordInput;
    readonly runRecordRef?: RunRecordRef;
    readonly abortSignal?: AbortSignal;
  }): Promise<AdvancementTurnReviewResult> {
    let session = await this.store.loadActiveSession(input.conversationId);
    if (!session) return { kind: "skipped", reason: "no-active-session" };
    if (session.status !== "active") {
      return { kind: "skipped", reason: "not-active" };
    }
    const settled = await this.settleAcceptedProxyRun(session, input);
    if (isTurnReviewResult(settled)) return settled;
    session = settled;
    const rubric = session.confirmedRubric;
    if (!rubric) {
      const review = this.systemExitReview(
        input,
        "推进会话已激活但缺少已确认 Rubric，无法继续可靠验收。",
      );
      return await this.persistReviewOutcome(session, review);
    }
    if (!this.reviewer) {
      const review = this.systemExitReview(
        input,
        "推进侧验收运行体未装配，无法继续可靠验收。",
      );
      return await this.persistReviewOutcome(session, review);
    }

    let review: AdvancementRunReview;
    let advancementWindow: AdvancementWindowState | undefined;
    try {
      const output = await this.reviewer.reviewRun({
        sessionId: session.id,
        originalUserTask: session.originalUserTask,
        rubric,
        runIndex: input.runIndex,
        runRecord: input.runRecord,
        runRecordRef: input.runRecordRef,
        priorReviews: session.runs,
        advancementWindow: session.advancementWindow,
        abortSignal: input.abortSignal,
      });
      ({ review, advancementWindow } = splitReviewOutput(output));
      assertReviewMatchesAcceptedRun(input, review);
    } catch (err) {
      advancementWindow = undefined;
      review = this.systemExitReview(
        input,
        `推进侧验收运行失败：${errorMessage(err)}`,
      );
    }

    return await this.persistReviewOutcome(session, review, advancementWindow);
  }

  private async cancelSession(
    conversationId: string,
    sessionId: string,
    message: string,
    reason: AdvancementExit["reason"] = "user-cancelled",
  ): Promise<AdvancementSession> {
    return await this.store.cancelSession(conversationId, sessionId, {
      reason,
      message,
      occurredAt: this.now(),
    } satisfies AdvancementExit);
  }

  private async requireSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession> {
    const session = await this.store.loadSession(conversationId, sessionId);
    if (!session) {
      throw new Error(`AdvancementController: session "${sessionId}" not found`);
    }
    return session;
  }

  private async persistReviewOutcome(
    session: AdvancementSession,
    review: AdvancementRunReview,
    advancementWindow?: AdvancementWindowState,
  ): Promise<AdvancementTurnReviewResult> {
    if (review.decision === "passed") {
      const exit: AdvancementExit = {
        reason: "passed",
        message: "Rubric 已验收通过，任务推进闭环结束。",
        occurredAt: this.now(),
      };
      const completed = await this.store.appendTerminalRunReview(
        session.conversationId,
        session.id,
        review,
        { type: "completed", exit, timestamp: exit.occurredAt },
        review.reviewedAt,
        advancementWindow,
      );
      return { kind: "completed", session: completed, review, exit };
    }
    if (review.decision === "exit") {
      const exit: AdvancementExit = {
        reason: review.exitReason ?? "system-error",
        message: review.unmetCriteria[0] ?? "推进侧判断继续推进已不合适。",
        occurredAt: this.now(),
      };
      const exited = await this.store.appendTerminalRunReview(
        session.conversationId,
        session.id,
        review,
        { type: "exited", exit, timestamp: exit.occurredAt },
        review.reviewedAt,
        advancementWindow,
      );
      return { kind: "exited", session: exited, review, exit };
    }
    return await this.persistProxyOutcome(session, review, advancementWindow);
  }

  private async persistProxyOutcome(
    session: AdvancementSession,
    review: AdvancementRunReview,
    advancementWindow?: AdvancementWindowState,
  ): Promise<AdvancementTurnReviewResult> {
    const rubric = session.confirmedRubric;
    const handling = rubric
      ? selectFailureHandling(rubric, review.selectedFailureHandlingId)
      : undefined;
    if (!handling) {
      const exit: AdvancementExit = {
        reason: "dead-end",
        message: "推进侧未能找到可执行的未通过处理准则，继续推进没有可靠收益。",
        occurredAt: this.now(),
      };
      const exitReview: AdvancementRunReview = {
        ...review,
        decision: "exit",
        exitReason: "dead-end",
        unmetCriteria:
          review.unmetCriteria.length > 0 ? review.unmetCriteria : [exit.message],
      };
      const exited = await this.store.appendTerminalRunReview(
        session.conversationId,
        session.id,
        exitReview,
        { type: "exited", exit, timestamp: exit.occurredAt },
        review.reviewedAt,
        syncAdvancementWindowReview(advancementWindow, exitReview),
      );
      return {
        kind: "exited",
        session: exited,
        review: exited.runs[exited.runs.length - 1]!,
        exit,
      };
    }

    const proxyMessageId = this.proxyIdGenerator();
    const variables = buildProxyVariables(review);
    const proxyMessage: AdvancementProxyMessage = {
      id: proxyMessageId,
      sessionId: session.id,
      reviewId: review.id,
      content: userTurnInputFromText(renderFailureHandlingReply(handling, variables)),
      rubricFailureHandlingId: handling.id,
      variables,
      createdAt: this.now(),
    };
    const reviewWithProxy: AdvancementRunReview = {
      ...review,
      selectedFailureHandlingId: handling.id,
      proxyMessageId,
    };
    const updated = await this.store.appendRunReviewWithProxyMessage(
      session.conversationId,
      session.id,
      reviewWithProxy,
      proxyMessage,
      review.reviewedAt,
      syncAdvancementWindowReview(advancementWindow, reviewWithProxy),
    );
    return {
      kind: "proxy-enqueued",
      session: updated,
      review: reviewWithProxy,
      proxyMessage,
    };
  }

  private async settleAcceptedProxyRun(
    session: AdvancementSession,
    input: {
      readonly conversationId: string;
      readonly runIndex: number;
      readonly runRecordRef?: RunRecordRef;
      readonly runRecord: RunRecordInput;
    },
  ): Promise<AdvancementSession | AdvancementTurnReviewResult> {
    if (input.runRecord.source !== "advancement") return session;
    const proxyMessageId = input.runRecord.advancement?.proxyMessageId;
    if (
      !input.runRecord.advancement ||
      input.runRecord.advancement.sessionId !== session.id ||
      !proxyMessageId ||
      !session.outstandingProxyMessageId
    ) {
      const review = this.systemExitReview(
        {
          runIndex: input.runIndex,
          runRecordRef: input.runRecordRef,
        },
        "推进侧代理 run 缺少匹配的来源元数据，无法可靠继续。",
      );
      return await this.persistReviewOutcome(session, review);
    }
    if (session.outstandingProxyMessageId !== proxyMessageId) {
      const review = this.systemExitReview(
        {
          runIndex: input.runIndex,
          runRecordRef: input.runRecordRef,
        },
        "推进侧代理 run 与 outstanding proxy 不匹配，无法可靠继续。",
      );
      return await this.persistReviewOutcome(session, review);
    }
    return await this.store.settleProxyMessage(
      input.conversationId,
      session.id,
      proxyMessageId,
      this.now(),
    );
  }

  private systemExitReview(
    input: {
      readonly runIndex: number;
      readonly runRecordRef?: RunRecordRef;
    },
    message: string,
  ): AdvancementRunReview {
    return {
      id: this.reviewIdGenerator(),
      runIndex: input.runIndex,
      runRecordRef: input.runRecordRef,
      reviewedAt: this.now(),
      decision: "exit",
      evidence: [],
      unmetCriteria: [message],
      exitReason: "system-error",
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim().length > 0
    ? err.message
    : "Rubric contract draft generation failed";
}

function splitReviewOutput(output: AdvancementRunReviewOutput): {
  readonly review: AdvancementRunReview;
  readonly advancementWindow?: AdvancementWindowState;
} {
  return output;
}

function syncAdvancementWindowReview(
  advancementWindow: AdvancementWindowState | undefined,
  review: AdvancementRunReview,
): AdvancementWindowState | undefined {
  if (!advancementWindow) return undefined;
  return {
    ...advancementWindow,
    entries: advancementWindow.entries.map((entry) =>
      entry.kind === "review" && entry.reviewId === review.id
        ? createAdvancementWindowReviewEntry(review)
        : entry,
    ),
  };
}

function assertReviewMatchesAcceptedRun(
  accepted: {
    readonly runIndex: number;
    readonly runRecordRef?: RunRecordRef;
  },
  review: AdvancementRunReview,
): void {
  if (review.runIndex !== accepted.runIndex) {
    throw new Error(
      `review runIndex ${review.runIndex} does not match accepted runIndex ${accepted.runIndex}`,
    );
  }
  if (!sameRunRecordRef(review.runRecordRef, accepted.runRecordRef)) {
    throw new Error("review runRecordRef does not match accepted runRecordRef");
  }
}

function isTurnReviewResult(
  value: AdvancementSession | AdvancementTurnReviewResult,
): value is AdvancementTurnReviewResult {
  if (!("kind" in value)) return false;
  return (
    value.kind === "skipped" ||
    value.kind === "reviewed" ||
    value.kind === "proxy-enqueued" ||
    value.kind === "completed" ||
    value.kind === "exited"
  );
}

function sameRunRecordRef(
  a: RunRecordRef | undefined,
  b: RunRecordRef | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.shardId === b.shardId && a.runIndex === b.runIndex;
}

function selectFailureHandling(
  rubric: ConfirmedRubricSnapshot,
  selectedId: string | undefined,
): FailureHandlingSpec | undefined {
  const handlers = rubric.content.failureHandling;
  if (selectedId) {
    return handlers.find((handler) => handler.id === selectedId);
  }
  return handlers[0];
}

function buildProxyVariables(
  review: AdvancementRunReview,
): Readonly<Record<string, string>> {
  return {
    unmet_criteria: review.unmetCriteria.join("\n"),
    review_id: review.id,
  };
}

function renderFailureHandlingReply(
  handling: FailureHandlingSpec,
  variables: Readonly<Record<string, string>>,
): string {
  return handling.reply.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined ? match : value;
  });
}
