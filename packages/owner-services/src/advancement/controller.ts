import {
  RubricContractBuilder,
  ConservativeAdvancementAdmissionStrategy,
  createAdvancementWindowReviewEntry,
  type AdvancementAdmissionDecision,
  type AdvancementAdmissionStrategy,
  type AdvancementExit,
  type AdvancementProxyMessage,
  type AdvancementReviewAttempt,
  type AdvancementReviewRunOutcome,
  type AdvancementRunReview,
  type AdvancementSession,
  type AdvancementOriginalTaskAdmissionIntent,
  type AdvancementWindowState,
  type ConfirmedRubricSnapshot,
  type RunRecordInput,
  type RunRecordRef,
  type RubricContractDraftSnapshot,
  type Message,
  type UserTurnInput,
  type AdvancementClosureFacts,
  type AdvancementClosureReport,
  buildClosureFacts,
  extractText,
  renderClosureReport,
  sumAdvancementUsage,
} from "@zhixing/core";
import type { AdvancementReviewerPort } from "@zhixing/core/contracts";
import type {
  AdvancementActiveUserTurnMechanismPort,
  AdvancementAwaitingRubricAdmissionDecision,
  AdvancementAwaitingRubricAdmissionMechanismPort,
  AdvancementNewTaskMechanismPort,
  AdvancementRubricConfirmationMechanismPort,
  AdvancementRubricRevisionMechanismPort,
  AdvancementReviewAttemptApplication,
  AdvancementReviewAttemptMechanismPort,
  AdvancementTurnReviewResult,
  RubricPublicationOutcome,
  RubricPublicationPort,
} from "@zhixing/core/advancement/application";
import { randomUUID } from "node:crypto";
import {
  buildAdvancementProxyMessage,
  selectFailureHandling,
} from "./proxy-content.js";
import type { AdvancementSessionStore } from "./session-store.js";
import {
  AdvancementEvidenceCoordinator,
  AdvancementEvidenceDeferredError,
  type AdvancementEvidenceTarget,
} from "./evidence.js";

export interface AdvancementControllerOptions {
  /** 推进会话存储——生产装配注入权威日志适配实现，无隐式回退。 */
  readonly store: AdvancementSessionStore;
  readonly contractBuilder?: RubricContractBuilder;
  readonly admissionStrategy?: AdvancementAdmissionStrategy;
  readonly reviewer?: AdvancementReviewerPort;
  /** owner 侧耐久取证协调器；未装配时只允许无独立取证的既有测试/兼容路径。 */
  readonly evidence?: AdvancementEvidenceCoordinator;
  /** Advancement-owned durable attempt/root lifecycle application. */
  readonly reviewAttempts?: AdvancementReviewAttemptApplication;
  /** Optional global-library publication; active session adoption never waits on it. */
  readonly rubricPublication?: RubricPublicationPort;
  /**
   * 最近会话投影提供者——给准入判断喂执行侧窗口尾部的轻量文本，
   * 让「继续把它弄完」这类上下文依赖输入分类正确。失败按无投影处理。
   */
  readonly recentContextProvider?: (
    conversationId: string,
  ) => Promise<string | undefined>;
  /** 准入延迟观测——每次准入 LLM 判断的耗时回调（诊断面，基线数据来源）。 */
  readonly onAdmissionTiming?: (elapsedMs: number) => void;
  /** 收场报告合成执行体——缺省时收场恒为结构化直出。 */
  readonly closureSynthesizer?: AdvancementClosureSynthesizer;
  /**
   * 单会话 token 保险丝阈值（全量口径，含裁判与被审 run 两半）。
   * 触达即 budget-exceeded 退出 + 收场交付。
   */
  readonly sessionTokenBudget?: number;
  readonly now?: () => string;
  readonly reviewIdGenerator?: () => string;
  readonly proxyIdGenerator?: () => string;
}

export type {
  AdvancementReviewRunInput,
  AdvancementReviewRunOutcome,
} from "@zhixing/core";

/** 推进侧裁判端口——与 contracts AdvancementReviewerPort 同一抽象。 */
export type AdvancementRunReviewer = AdvancementReviewerPort;

/**
 * 收场报告合成执行体——可替换 strategy（与准入 / 草案生成同构），默认
 * 走宿主轻推理通道。合成失败降级为结构化数据直出，不阻塞退出。
 */
export interface AdvancementClosureSynthesizer {
  synthesize(facts: AdvancementClosureFacts): Promise<string>;
}

/**
 * 单会话失控保险丝默认阈值（token 全量口径）——默认宽到正常任务永不触碰，
 * 它是失控保险，不是推进机制。
 */
export const DEFAULT_SESSION_TOKEN_BUDGET = 20_000_000;

export type { AdvancementTurnReviewResult } from "@zhixing/core/advancement/application";

export class AdvancementController implements
  AdvancementActiveUserTurnMechanismPort,
  AdvancementAwaitingRubricAdmissionMechanismPort,
  AdvancementNewTaskMechanismPort,
  AdvancementRubricRevisionMechanismPort,
  AdvancementRubricConfirmationMechanismPort
{
  private readonly store: AdvancementSessionStore;
  private readonly contractBuilder: RubricContractBuilder;
  private readonly admissionStrategy: AdvancementAdmissionStrategy;
  private readonly reviewer?: AdvancementRunReviewer;
  private readonly evidence?: AdvancementEvidenceCoordinator;
  private readonly reviewAttempts?: AdvancementReviewAttemptApplication;
  private readonly rubricPublication?: RubricPublicationPort;
  private readonly recentContextProvider?: (
    conversationId: string,
  ) => Promise<string | undefined>;
  private readonly onAdmissionTiming?: (elapsedMs: number) => void;
  private readonly closureSynthesizer?: AdvancementClosureSynthesizer;
  private readonly sessionTokenBudget: number;
  private readonly now: () => string;
  private readonly reviewIdGenerator: () => string;
  private readonly proxyIdGenerator: () => string;

  constructor(options: AdvancementControllerOptions) {
    this.store = options.store;
    this.contractBuilder = options.contractBuilder ?? new RubricContractBuilder();
    this.admissionStrategy =
      options.admissionStrategy ?? new ConservativeAdvancementAdmissionStrategy();
    this.reviewer = options.reviewer;
    this.evidence = options.evidence;
    this.reviewAttempts = options.reviewAttempts;
    this.rubricPublication = options.rubricPublication;
    this.recentContextProvider = options.recentContextProvider;
    this.onAdmissionTiming = options.onAdmissionTiming;
    this.closureSynthesizer = options.closureSynthesizer;
    this.sessionTokenBudget =
      options.sessionTokenBudget ?? DEFAULT_SESSION_TOKEN_BUDGET;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reviewIdGenerator =
      options.reviewIdGenerator ?? (() => `adv_review_${randomUUID()}`);
    this.proxyIdGenerator =
      options.proxyIdGenerator ?? (() => `adv_proxy_${randomUUID()}`);
  }

  /** 准入判断统一出口：喂最近会话投影、计延迟基线；投影失败按无投影降级。 */
  async decideAwaitingRubricAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAwaitingRubricAdmissionDecision> {
    const decision = await this.decideAdmission({
      conversationId: input.conversationId,
      userInput: input.userInput,
      hasOpenAdvancementSession: true,
    });
    if (
      decision.action !== "keep-awaiting-confirmation" &&
      decision.action !== "downgrade-to-direct" &&
      decision.action !== "cancel-pending-task"
    ) {
      throw new Error(
        `AdvancementController: invalid awaiting-Rubric admission action ${decision.action}`,
      );
    }
    return Object.freeze({
      kind: decision.kind,
      action: decision.action,
      reason: decision.reason,
    });
  }

  loadOpenNewTaskSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    return this.store.loadActiveSession(conversationId);
  }

  async decideNewTaskAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAdmissionDecision> {
    const decision = await this.decideAdmission(input);
    if (
      decision.action !== "run-direct" &&
      decision.action !== "start-advancement"
    ) {
      throw new Error(
        `AdvancementController: invalid new-task admission action ${decision.action}`,
      );
    }
    return decision;
  }

  buildNewTaskRubricDraft(input: Readonly<{
    originalTurnId: string;
    originalUserTask: Readonly<UserTurnInput>;
  }>): Promise<RubricContractDraftSnapshot> {
    return this.contractBuilder.buildDraft(input);
  }

  persistNewTaskAwaitingSession(input: Readonly<{
    conversationId: string;
    originalUserTask: Readonly<UserTurnInput>;
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession> {
    return this.store.createSession({
      id: `adv_${input.draft.draftId}`,
      conversationId: input.conversationId,
      originalUserTask: input.originalUserTask,
      pendingRubricDraft: input.draft,
      createdAt: input.draft.createdAt,
    });
  }

  private async decideAdmission(input: {
    readonly conversationId: string;
    readonly userInput: UserTurnInput;
    readonly hasOpenAdvancementSession?: boolean;
    readonly hasActiveAdvancementSession?: boolean;
  }): Promise<AdvancementAdmissionDecision> {
    let recentContext: string | undefined;
    try {
      recentContext = await this.recentContextProvider?.(input.conversationId);
    } catch {
      recentContext = undefined;
    }
    const startedAt = Date.now();
    try {
      return await this.admissionStrategy.decide({
        input: input.userInput,
        hasOpenAdvancementSession: input.hasOpenAdvancementSession,
        hasActiveAdvancementSession: input.hasActiveAdvancementSession,
        ...(recentContext ? { recentContext } : {}),
      });
    } finally {
      this.onAdmissionTiming?.(Date.now() - startedAt);
    }
  }

  async loadActiveUserTurnSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    return await this.loadActiveSession(conversationId);
  }

  async decideActiveUserTurnAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAdmissionDecision> {
    return await this.decideAdmission({
      conversationId: input.conversationId,
      userInput: input.userInput,
      hasActiveAdvancementSession: true,
    });
  }

  activeUserTurnNow(): string {
    return this.now();
  }

  createActiveRubricDraftId(): string {
    return randomUUID();
  }

  async reviseActiveRubricDraft(input: Readonly<{
    currentDraft: RubricContractDraftSnapshot;
    originalUserTask: AdvancementSession["originalUserTask"];
    userFeedback: string;
  }>): Promise<RubricContractDraftSnapshot> {
    return await this.contractBuilder.reviseDraft(input);
  }

  async persistActiveUserTurnExit(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    exit: AdvancementExit;
  }>): Promise<AdvancementSession> {
    return await this.store.exitSession(
      input.conversationId,
      input.advancementSessionId,
      input.exit,
      input.exit.occurredAt,
    );
  }

  async composeActiveUserTurnClosure(
    session: AdvancementSession,
  ): Promise<AdvancementClosureReport> {
    return await this.composeClosureReport(session);
  }

  async persistRegeneratedRubricSession(input: Readonly<{
    advancementSessionId: string;
    conversationId: string;
    originalUserTask: AdvancementSession["originalUserTask"];
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession> {
    return await this.store.createSession({
      id: input.advancementSessionId,
      conversationId: input.conversationId,
      originalUserTask: input.originalUserTask,
      pendingRubricDraft: input.draft,
      createdAt: input.draft.createdAt,
    });
  }

  async settleInterruptedProxy(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    proxyMessageId: string;
  }>): Promise<AdvancementSession> {
    return await this.settleProxyMessage(input);
  }

  /** 收场报告：LLM 合成优先，失败或缺 synthesizer 时降级结构化直出。 */
  private async composeClosureReport(
    session: AdvancementSession,
  ): Promise<AdvancementClosureReport> {
    const facts = buildClosureFacts(session);
    if (this.closureSynthesizer) {
      try {
        const summary = (await this.closureSynthesizer.synthesize(facts)).trim();
        if (summary) return { summary, synthesized: true, facts };
      } catch {
        // 合成失败降级直出，不阻塞退出。
      }
    }
    return { summary: renderClosureReport(facts), synthesized: false, facts };
  }

  loadRubricConfirmationSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null> {
    return this.store.loadSession(conversationId, advancementSessionId);
  }

  confirmRubricDraftContent(
    draft: RubricContractDraftSnapshot,
  ): Promise<ConfirmedRubricSnapshot> {
    return this.contractBuilder.confirmDraft(draft);
  }

  persistRubricConfirmation(input: Readonly<{
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly confirmedRubric: ConfirmedRubricSnapshot;
    readonly admissionIntent: AdvancementOriginalTaskAdmissionIntent;
  }>): Promise<AdvancementSession> {
    return this.store.confirmRubric(
      input.conversationId,
      input.advancementSessionId,
      input.confirmedRubric,
      input.admissionIntent,
      input.confirmedRubric.confirmedAt,
    );
  }

  persistOriginalTaskAdmissionSettlement(input: Readonly<{
    readonly conversationId: string;
    readonly advancementSessionId: string;
    readonly turnId: string;
    readonly inputDigest: import("@zhixing/core").Digest;
    readonly runId: string;
  }>): Promise<AdvancementSession> {
    return this.store.settleOriginalTaskAdmission(
      input.conversationId,
      input.advancementSessionId,
      {
        turnId: input.turnId,
        inputDigest: input.inputDigest,
        runId: input.runId,
      },
    );
  }

  publishRubric(input: Parameters<RubricPublicationPort["publish"]>[0]): Promise<
    RubricPublicationOutcome | Readonly<{ kind: "unavailable" }>
  > {
    return this.rubricPublication
      ? this.rubricPublication.publish(input)
      : Promise.resolve({ kind: "unavailable" });
  }

  loadRubricRevisionSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null> {
    return this.store.loadSession(conversationId, advancementSessionId);
  }

  reviseRubricDraftContent(input: Readonly<{
    currentDraft: RubricContractDraftSnapshot;
    originalUserTask: UserTurnInput;
    userFeedback: string;
  }>): Promise<RubricContractDraftSnapshot> {
    return this.contractBuilder.reviseDraft(input);
  }

  persistRubricDraftRevision(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession> {
    return this.store.reviseRubricDraft(
      input.conversationId,
      input.advancementSessionId,
      input.draft,
      input.draft.createdAt,
    );
  }

  loadRubricCancellationSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null> {
    return this.store.loadSession(conversationId, advancementSessionId);
  }

  persistRubricCancellation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession> {
    return this.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      input.message,
      input.reason,
    );
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

  loadOpenConversationLifecycleSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    return this.store.loadActiveSession(conversationId);
  }

  persistConversationLifecycleCancellation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession> {
    return this.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      input.message,
      input.reason,
    );
  }

  removeConversationLifecycleData(conversationId: string): Promise<void> {
    return this.store.removeConversation(conversationId);
  }

  listConversationLifecycleDataCandidates(): Promise<readonly string[]> {
    return this.store.listConversationDataCandidates();
  }

  removeConversationLifecycleDataCandidate(
    candidateId: string,
  ): Promise<void> {
    return this.store.removeConversationDataCandidate(candidateId);
  }

  async loadActiveSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    if (!this.reviewAttempts) {
      throw new Error(
        "AdvancementController: review attempt application is not assembled",
      );
    }
    await this.reviewAttempts.reconcileConversation(conversationId);
    return await this.store.loadActiveSession(conversationId);
  }

  /**
   * 详情查询入口：open 会话优先；无 open 时返回最新的终态会话——
   * 离线错过收场事件后，收场事实可从持久化 review 序列随时重看。
   */
  async loadLatestSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    const sessions = await this.store.loadConversationSessions(conversationId);
    if (sessions.length === 0) return null;
    const open = sessions.find(
      (session) =>
        session.status === "awaiting-rubric-confirmation" ||
        session.status === "active",
    );
    return open ?? sessions[sessions.length - 1]!;
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

  /**
   * missing-proxy 自愈：最新 failed review 带 proxyMessageId 但实体不在
   * proxyMessages（review 与 proxy 的双事件写入被中断 / 日志掉尾）时，
   * 从已持久化 review 确定性重建并补写 proxy_enqueued。
   * id 恒复用 review.proxyMessageId，content 由同一组纯函数按同一 review
   * 重渲染（byte 等价）；createdAt 为重建时刻。
   */
  async rebuildMissingProxyMessage(session: AdvancementSession): Promise<
    | {
        readonly kind: "rebuilt";
        readonly session: AdvancementSession;
        readonly proxyMessage: AdvancementProxyMessage;
        readonly review: AdvancementRunReview;
      }
    | { readonly kind: "not-applicable" }
  > {
    if (session.status !== "active" || session.outstandingProxyMessageId) {
      return { kind: "not-applicable" };
    }
    const review = session.runs[session.runs.length - 1];
    if (!review || review.decision !== "failed" || !review.proxyMessageId) {
      return { kind: "not-applicable" };
    }
    if (
      session.proxyMessages.some(
        (message) => message.id === review.proxyMessageId,
      )
    ) {
      return { kind: "not-applicable" };
    }
    const rubric = session.confirmedRubric;
    const handling = rubric
      ? selectFailureHandling(rubric, review.selectedFailureHandlingId)
      : undefined;
    if (!rubric || !handling) return { kind: "not-applicable" };
    const proxyMessage = buildAdvancementProxyMessage({
      id: review.proxyMessageId,
      sessionId: session.id,
      review,
      handling,
      rubric,
      createdAt: this.now(),
    });
    const updated = await this.store.enqueueProxyMessage(
      session.conversationId,
      session.id,
      proxyMessage,
    );
    return { kind: "rebuilt", session: updated, proxyMessage, review };
  }

  async afterTurnCommitted(input: {
    readonly conversationId: string;
    readonly runId?: string;
    readonly runIndex: number;
    readonly runRecord: RunRecordInput;
    readonly runRecordRef?: RunRecordRef;
    readonly abortSignal?: AbortSignal;
  }): Promise<AdvancementTurnReviewResult> {
    if (!this.reviewAttempts) {
      throw new Error(
        "AdvancementController: review attempt application is not assembled",
      );
    }
    return await this.reviewAttempts.reviewAcceptedRun(
      input,
      this.reviewAttemptMechanism(),
    );
  }

  private reviewAttemptMechanism(): AdvancementReviewAttemptMechanismPort {
    let evidenceTarget: AdvancementEvidenceTarget | undefined;
    return {
      prepareEligibility: async (session, input) => {
        const settled = await this.settleAcceptedProxyRun(session, input);
        if (isTurnReviewResult(settled)) {
          return { kind: "return", result: settled };
        }
        session = settled;
        const rubric = session.confirmedRubric;
        if (!rubric) {
          const review = this.systemExitReview(
            input,
            "推进会话已激活但缺少已确认 Rubric，无法继续可靠验收。",
          );
          return {
            kind: "return",
            result: await this.persistReviewOutcome(session, review),
          };
        }
        if (!this.reviewer) {
          const review = this.systemExitReview(
            input,
            "推进侧验收运行体未装配，无法继续可靠验收。",
          );
          return {
            kind: "return",
            result: await this.persistReviewOutcome(session, review),
          };
        }
        const spentTokens = sumAdvancementUsage(session.runs).totalTokens;
        if (spentTokens >= this.sessionTokenBudget) {
          const review = this.systemExitReview(
            input,
            `本次推进累计消耗约 ${spentTokens} tokens，已达单任务成本上限（${this.sessionTokenBudget}），按系统边界退出。如需继续可调高推进保险丝阈值后重新发起。`,
            "budget-exceeded",
          );
          return {
            kind: "return",
            result: await this.persistReviewOutcome(session, review),
          };
        }
        return { kind: "ready", session, rubric };
      },
      commitMissingDurableRun: async (session, input, reason) => {
        const review = this.systemExitReview(input, reason);
        return await this.persistReviewOutcome(session, review);
      },
      resolveRootTarget: async (session, input) => {
        if (!this.evidence || !input.runId) return undefined;
        const carried = this.evidence.carriedOutcomeRootTarget(
          session,
          input.runId,
        );
        if (carried) return carried;
        evidenceTarget = await this.evidence.resolveTarget(
          input.conversationId,
          input.runId,
        );
        return evidenceTarget;
      },
      prepareEvidence: async ({
        session,
        request,
        attempt,
        rootLease,
      }) => {
        try {
          const collected =
            this.evidence && request.runId
              ? await this.evidence.collect({
                  session,
                  runId: request.runId,
                  reviewId: attempt.lineageId,
                  generation: attempt.generation,
                  runRecord: request.runRecord,
                  rootLease,
                  target: evidenceTarget,
                  abort:
                    request.abortSignal ?? new AbortController().signal,
                })
              : undefined;
          return {
            kind: "ready",
            ...(collected
              ? {
                  canonicalEvidence: collected.canonicalEvidence,
                  ...(collected.requestId
                    ? { requestId: collected.requestId }
                    : {}),
                }
              : {}),
          };
        } catch (error) {
          return {
            kind: "deferred",
            cause:
              error instanceof AdvancementEvidenceDeferredError ||
              (error instanceof Error && error.name === "AbortError")
                ? "aborted"
                : "infrastructure",
            reason: `独立取证未能形成可消费终态：${errorMessage(error)}`,
          };
        }
      },
      invokeReviewer: async ({
        session,
        rubric,
        request,
        rootLease,
        canonicalEvidence,
      }) => {
        if (!this.reviewer) {
          throw new Error("Advancement reviewer is not assembled");
        }
        let outcome: AdvancementReviewRunOutcome;
        try {
          outcome = await this.reviewer.review(
            {
              sessionId: session.id,
              originalUserTask: session.originalUserTask,
              rubric,
              runIndex: request.runIndex,
              runRecord: request.runRecord,
              runRecordRef: request.runRecordRef,
              priorReviews: session.runs,
              advancementWindow: session.advancementWindow,
              ...(canonicalEvidence ? { canonicalEvidence } : {}),
            },
            rootLease,
            request.abortSignal ?? new AbortController().signal,
          );
        } catch (error) {
          outcome = {
            kind: "deferred",
            cause:
              error instanceof Error && error.name === "AbortError"
                ? "aborted"
                : "infrastructure",
            reason: `推进侧验收运行失败：${errorMessage(error)}`,
          };
        }
        if (outcome.kind !== "deferred") {
          assertReviewMatchesAcceptedRun(request, outcome.review);
        }
        return outcome;
      },
      commitConsumed: async ({
        session,
        outcome,
        evidenceRequestId,
        attempt,
      }) =>
        await this.persistReviewOutcome(
          session,
          outcome.review,
          outcome.advancementWindow,
          evidenceRequestId,
          attempt,
        ),
    };
  }

  private async cancelSession(
    conversationId: string,
    sessionId: string,
    message: string,
    reason: AdvancementExit["reason"] = "user-cancelled",
  ): Promise<AdvancementSession> {
    if (!this.reviewAttempts) {
      throw new Error(
        "AdvancementController: review attempt application is not assembled",
      );
    }
    return await this.reviewAttempts.cancelSession({
      conversationId,
      advancementSessionId: sessionId,
      reason,
      message,
    });
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
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
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
        evidenceRequestId,
        reviewAttempt,
      );
      return {
        kind: "completed",
        session: completed,
        review,
        exit,
        closure: await this.composeClosureReport(completed),
      };
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
        evidenceRequestId,
        reviewAttempt,
      );
      return {
        kind: "exited",
        session: exited,
        review,
        exit,
        closure: await this.composeClosureReport(exited),
      };
    }
    // 审后保险丝：本轮 usage 落账后已打穿阈值 → 不再入队续推，就地
    // budget-exceeded 终局。与审前检查互补——审前挡裁判调用的消耗，
    // 审后挡下一轮执行的启动；「触达即退出」不允许超阈后再跑一轮。
    const spentWithThisRun = sumAdvancementUsage([
      ...session.runs,
      review,
    ]).totalTokens;
    if (spentWithThisRun >= this.sessionTokenBudget) {
      const exit: AdvancementExit = {
        reason: "budget-exceeded",
        message: `本次推进累计消耗约 ${spentWithThisRun} tokens，已达单任务成本上限（${this.sessionTokenBudget}），不再自动续推。如需继续可调高推进保险丝阈值后重新发起。`,
        occurredAt: this.now(),
      };
      const exitReview: AdvancementRunReview = {
        ...review,
        decision: "exit",
        exitReason: "budget-exceeded",
      };
      const exited = await this.store.appendTerminalRunReview(
        session.conversationId,
        session.id,
        exitReview,
        { type: "exited", exit, timestamp: exit.occurredAt },
        review.reviewedAt,
        syncAdvancementWindowReview(advancementWindow, exitReview),
        evidenceRequestId,
        reviewAttempt,
      );
      return {
        kind: "exited",
        session: exited,
        review: exited.runs[exited.runs.length - 1]!,
        exit,
        closure: await this.composeClosureReport(exited),
      };
    }

    return await this.persistProxyOutcome(
      session,
      review,
      advancementWindow,
      evidenceRequestId,
      reviewAttempt,
    );
  }

  private async persistProxyOutcome(
    session: AdvancementSession,
    review: AdvancementRunReview,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementTurnReviewResult> {
    const rubric = session.confirmedRubric;
    const handling = rubric
      ? selectFailureHandling(rubric, review.selectedFailureHandlingId)
      : undefined;
    if (!rubric || !handling) {
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
        evidenceRequestId,
        reviewAttempt,
      );
      return {
        kind: "exited",
        session: exited,
        review: exited.runs[exited.runs.length - 1]!,
        exit,
        closure: await this.composeClosureReport(exited),
      };
    }

    const proxyMessageId = this.proxyIdGenerator();
    const proxyMessage = buildAdvancementProxyMessage({
      id: proxyMessageId,
      sessionId: session.id,
      review,
      handling,
      rubric,
      createdAt: this.now(),
    });
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
      evidenceRequestId,
      reviewAttempt,
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
      !proxyMessageId
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
    if (!session.outstandingProxyMessageId) {
      const knownProxy = session.proxyMessages.some(
        (message) => message.id === proxyMessageId,
      );
      if (knownProxy) return session;
      const review = this.systemExitReview(
        {
          runIndex: input.runIndex,
          runRecordRef: input.runRecordRef,
        },
        "推进侧代理 run 来源元数据指向未知代理消息，无法可靠继续。",
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
    exitReason: AdvancementExit["reason"] = "system-error",
  ): AdvancementRunReview {
    return {
      id: this.reviewIdGenerator(),
      runIndex: input.runIndex,
      runRecordRef: input.runRecordRef,
      reviewedAt: this.now(),
      decision: "exit",
      evidence: [],
      attribution: { criteria: [] },
      unmetCriteria: [message],
      exitReason,
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim().length > 0
    ? err.message
    : "Rubric contract draft generation failed";
}

const RECENT_CONTEXT_MESSAGE_CHARS = 200;
const RECENT_CONTEXT_TOTAL_CHARS = 1200;

/**
 * 把执行侧窗口尾部消息渲染为准入投影文本——体量硬裁剪，保持准入 prompt
 * 小体量（投影是分类参考，不是完整上下文）。
 */
export function renderRecentContextFromMessages(
  messages: readonly Message[] | undefined,
): string | undefined {
  if (!messages?.length) return undefined;
  const lines: string[] = [];
  let total = 0;
  for (const message of [...messages].reverse()) {
    const text = extractText(message).trim();
    if (!text) continue;
    const clipped =
      text.length > RECENT_CONTEXT_MESSAGE_CHARS
        ? `${text.slice(0, RECENT_CONTEXT_MESSAGE_CHARS)}...`
        : text;
    const line = `${message.role === "user" ? "用户" : "知行"}：${clipped}`;
    if (total + line.length > RECENT_CONTEXT_TOTAL_CHARS) break;
    lines.unshift(line);
    total += line.length;
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
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
    value.kind === "review-deferred" ||
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
