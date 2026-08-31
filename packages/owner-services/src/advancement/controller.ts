import {
  RubricContractBuilder,
  ConservativeAdvancementAdmissionStrategy,
  createAdvancementWindowReviewEntry,
  advancementReviewAttemptId,
  advancementReviewLineageId,
  advancementReviewRootRequestId,
  type AdvancementAdmissionDecision,
  type AdvancementAdmissionStrategy,
  type AdvancementExit,
  type AdvancementProxyMessage,
  type AdvancementReviewRunOutcome,
  type AdvancementRunReview,
  type AdvancementReviewAttempt,
  type AdvancementReviewRootContract,
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
import { canonicalize } from "@zhixing/core/protocol";
import type {
  AdvancementReviewerPort,
  AuthorityCallContext,
  ImmediateRootResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import type {
  AdvancementActiveUserTurnMechanismPort,
  AdvancementAwaitingRubricAdmissionDecision,
  AdvancementAwaitingRubricAdmissionMechanismPort,
  AdvancementNewTaskMechanismPort,
  AdvancementRubricConfirmationMechanismPort,
  AdvancementRubricRevisionMechanismPort,
  RubricPublicationOutcome,
  RubricPublicationPort,
} from "@zhixing/core/advancement/application";
import { ImmediateRootReplayTerminalError } from "@zhixing/core/contracts";
import { randomUUID } from "node:crypto";
import {
  buildAdvancementProxyMessage,
  selectFailureHandling,
} from "./proxy-content.js";
import type { AdvancementSessionStore } from "./session-store.js";
import {
  AdvancementEvidenceCoordinator,
  AdvancementEvidenceDeferredError,
  type AdvancementEvidenceRootTarget,
} from "./evidence.js";

export interface AdvancementControllerOptions {
  /** 推进会话存储——生产装配注入权威日志适配实现，无隐式回退。 */
  readonly store: AdvancementSessionStore;
  readonly contractBuilder?: RubricContractBuilder;
  readonly admissionStrategy?: AdvancementAdmissionStrategy;
  readonly reviewer?: AdvancementReviewerPort;
  /** 准入 / 裁判 / 收场的 control 资源治理端口——装配 reviewer 时必需。 */
  readonly resources?: ResourceReservationPort;
  /** owner 侧耐久取证协调器；未装配时只允许无独立取证的既有测试/兼容路径。 */
  readonly evidence?: AdvancementEvidenceCoordinator;
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

export type AdvancementTurnReviewResult =
  | {
      readonly kind: "skipped";
      readonly reason: "no-active-session" | "not-active" | "already-reviewed";
    }
  | {
      readonly kind: "review-deferred";
      readonly session: AdvancementSession;
      readonly cause: "infrastructure" | "aborted";
      readonly reason: string;
    }
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
      readonly closure: AdvancementClosureReport;
    }
  | {
      readonly kind: "exited";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly exit: AdvancementExit;
      readonly closure: AdvancementClosureReport;
    };

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
  private readonly resources?: ResourceReservationPort;
  private readonly evidence?: AdvancementEvidenceCoordinator;
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
  private readonly reviewFlights = new Map<string, Promise<AdvancementTurnReviewResult>>();

  constructor(options: AdvancementControllerOptions) {
    this.store = options.store;
    this.contractBuilder = options.contractBuilder ?? new RubricContractBuilder();
    this.admissionStrategy =
      options.admissionStrategy ?? new ConservativeAdvancementAdmissionStrategy();
    this.reviewer = options.reviewer;
    this.resources = options.resources;
    this.evidence = options.evidence;
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

  /**
   * 删除对话的全部推进控制数据（含孤儿 sweep 用的同一底层能力）——
   * 控制日志生命周期跟随对话本体，对话删除时连带调用。
   */
  async removeConversationData(conversationId: string): Promise<void> {
    await this.store.removeConversation(conversationId);
  }

  /** 孤儿控制日志目录清理——对话已不存在时其控制日志没有独立存在意义。 */
  async sweepOrphanData(
    isConversationDirAlive: (dirName: string) => Promise<boolean>,
  ): Promise<{ scanned: number; removed: number; warnings: string[] }> {
    return await this.store.sweepOrphanDirs(isConversationDirAlive);
  }

  async loadActiveSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    await this.reconcileTerminalReviewAttempts(conversationId);
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
    const key = reviewFlightKey(input);
    const current = this.reviewFlights.get(key);
    if (current) return await current;
    const flight = this.reviewCommittedTurn(input).finally(() => {
      if (this.reviewFlights.get(key) === flight) this.reviewFlights.delete(key);
    });
    this.reviewFlights.set(key, flight);
    return await flight;
  }

  private async reviewCommittedTurn(input: {
    readonly conversationId: string;
    readonly runId?: string;
    readonly runIndex: number;
    readonly runRecord: RunRecordInput;
    readonly runRecordRef?: RunRecordRef;
    readonly abortSignal?: AbortSignal;
  }): Promise<AdvancementTurnReviewResult> {
    let session = await this.loadActiveSession(input.conversationId);
    if (!session) return { kind: "skipped", reason: "no-active-session" };
    if (session.status !== "active") {
      return { kind: "skipped", reason: "not-active" };
    }
    const existingAttempt = input.runRecordRef
      ? reviewAttemptFor(session, input.runRecordRef)
      : undefined;
    if (
      existingAttempt &&
      isTerminalAttempt(existingAttempt) &&
      !(await this.cleanupReviewAttemptRoot(existingAttempt))
    ) {
      return reviewDeferred(
        session,
        "既有裁判终态已落盘，资源仍等待保守回收。",
      );
    }
    // 幂等护栏：补审触发点有三个（宿主启动扫描、resume、turn 提交
    // catch-up），并发或重复命中同一 run 时只允许第一份结论落盘。
    if (session.runs.some((run) => run.runIndex === input.runIndex)) {
      return { kind: "skipped", reason: "already-reviewed" };
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
    if (!this.resources) {
      const review = this.systemExitReview(
        input,
        "推进侧控制资源治理端口未装配，无法继续可靠验收。",
      );
      return await this.persistReviewOutcome(session, review);
    }

    // 失控保险丝（审前计量）：沿 review 序列累加的两半 usage 快照触达
    // 阈值即系统边界退出 + 收场交付，不再消耗裁判调用。
    const spentTokens = sumAdvancementUsage(session.runs).totalTokens;
    if (spentTokens >= this.sessionTokenBudget) {
      const review = this.systemExitReview(
        input,
        `本次推进累计消耗约 ${spentTokens} tokens，已达单任务成本上限（${this.sessionTokenBudget}），按系统边界退出。如需继续可调高推进保险丝阈值后重新发起。`,
        "budget-exceeded",
      );
      return await this.persistReviewOutcome(session, review);
    }

    if (!input.runRecordRef) {
      const review = this.systemExitReview(
        input,
        "推进侧验收缺少 accepted run 的耐久位置，无法建立可恢复的裁判身份。",
      );
      return await this.persistReviewOutcome(session, review);
    }

    const runId = input.runId ?? stableRunId(input.runRecordRef);
    let attempt = reviewAttemptFor(session, input.runRecordRef);
    if (attempt?.phase === "invoking") {
      const settled = await this.transitionTerminalReviewAttempt(
        input.conversationId,
        session.id,
        terminalAttempt(
          attempt,
          "deferred",
          "裁判调用结果不明；本代禁止重放 provider。",
        ),
      );
      session = settled.session;
      attempt = settled.attempt;
    }
    if (attempt && isTerminalAttempt(attempt)) {
      const cleaned = await this.cleanupReviewAttemptRoot(attempt);
      if (!cleaned) {
        return reviewDeferred(
          session,
          "裁判资源仍在等待保守计量回收，暂不进入下一代验收。",
        );
      }
      session = (await this.store.loadActiveSession(input.conversationId)) ?? session;
      if (session.runs.some((run) => sameRunRecordRef(run.runRecordRef, input.runRecordRef))) {
        return { kind: "skipped", reason: "already-reviewed" };
      }
    }

    const lineageId = advancementReviewLineageId(session.id, input.runRecordRef);
    const carriedTarget = this.evidence && input.runId
      ? this.evidence.carriedOutcomeRootTarget(session, input.runId)
      : undefined;
    const evidenceTarget = this.evidence && input.runId && !carriedTarget
      ? await this.evidence.resolveTarget(input.conversationId, input.runId)
      : undefined;
    const rootTarget = carriedTarget ?? evidenceTarget;

    attempt = reviewAttemptFor(session, input.runRecordRef);
    if (!attempt || isTerminalAttempt(attempt)) {
      const legacyGeneration = session.evidence?.generations?.find(
        (entry) => entry.runId === runId,
      )?.generation ?? 0;
      const generation = Math.max(attempt?.generation ?? 0, legacyGeneration) + 1;
      const root = reviewRootContract({
        lineageId,
        generation,
        conversationId: input.conversationId,
        target: rootTarget,
      });
      attempt = {
        lineageId,
        generation,
        runId,
        runIndex: input.runIndex,
        runRecordRef: structuredClone(input.runRecordRef),
        phase: "started",
        root,
      };
      session = await this.store.transitionReviewAttempt(
        input.conversationId,
        session.id,
        attempt,
        this.now(),
      );
    }

    if (attempt.phase !== "started") {
      throw new Error("AdvancementController: review attempt is not restartable");
    }
    if (!reviewRootTargetMatches(attempt.root, rootTarget)) {
      const expired = terminalAttempt(
        attempt,
        "expired",
        "取证目标在裁判调用前发生变化；冻结本代并等待下一次恢复。",
      );
      const settled = await this.transitionTerminalReviewAttempt(
        input.conversationId,
        session.id,
        expired,
      );
      session = settled.session;
      await this.cleanupReviewAttemptRoot(settled.attempt);
      return reviewDeferred(session, settled.attempt.detail ?? expired.detail!);
    }

    let lease: ImmediateRootResourceLease;
    try {
      lease = await this.acquireReviewRoot(attempt);
    } catch (error) {
      if (!(error instanceof ImmediateRootReplayTerminalError)) {
        return reviewDeferred(
          session,
          `裁判根资源获取结果尚未确定：${errorMessage(error)}`,
        );
      }
      const afterFailure = await this.store.loadSession(
        input.conversationId,
        session.id,
      );
      const durableAfterFailure = afterFailure
        ? reviewAttemptFor(afterFailure, input.runRecordRef)
        : undefined;
      if (
        afterFailure &&
        (afterFailure.status !== "active" ||
          !durableAfterFailure ||
          durableAfterFailure.lineageId !== attempt.lineageId ||
          durableAfterFailure.generation !== attempt.generation ||
          durableAfterFailure.phase !== "started")
      ) {
        if (
          durableAfterFailure &&
          durableAfterFailure.lineageId === attempt.lineageId &&
          durableAfterFailure.generation === attempt.generation &&
          isTerminalAttempt(durableAfterFailure)
        ) {
          await this.cleanupReviewAttemptRoot(durableAfterFailure);
        }
        return reviewDeferred(
          afterFailure,
          "裁判根获取结束前业务 owner 已推进，本代不再写入或调用外部裁判。",
        );
      }
      if (!afterFailure) {
        throw new Error(
          "AdvancementController: session disappeared after its review root became terminal",
        );
      }
      session = afterFailure;
      attempt = durableAfterFailure!;
      const expired = terminalAttempt(
        attempt,
        "expired",
        `裁判根资源已${describeRootTerminal(error)}，本代不再复活。`,
        error.inspection.kind === "reservation"
          ? error.inspection.lease
          : undefined,
      );
      const settled = await this.transitionTerminalReviewAttempt(
        input.conversationId,
        session.id,
        expired,
      );
      session = settled.session;
      await this.cleanupReviewAttemptRoot(settled.attempt);
      return reviewDeferred(session, settled.attempt.detail ?? expired.detail!);
    }

    const afterAcquire = await this.store.loadSession(
      input.conversationId,
      session.id,
    );
    const durableAfterAcquire = afterAcquire
      ? reviewAttemptFor(afterAcquire, input.runRecordRef)
      : undefined;
    if (
      !afterAcquire ||
      afterAcquire.status !== "active" ||
      !durableAfterAcquire ||
      durableAfterAcquire.lineageId !== attempt.lineageId ||
      durableAfterAcquire.generation !== attempt.generation ||
      durableAfterAcquire.phase !== "started"
    ) {
      const cleanupAttempt = durableAfterAcquire &&
          isTerminalAttempt(durableAfterAcquire)
        ? durableAfterAcquire
        : terminalAttempt(
            { ...attempt, rootLease: lease },
            "expired",
            "裁判根取得后业务 owner 已不再允许本代继续。",
            lease,
          );
      if (durableAfterAcquire?.phase !== "invoking") {
        await this.cleanupReviewAttemptRoot(cleanupAttempt);
      }
      if (!afterAcquire) {
        throw new Error(
          "AdvancementController: session disappeared after acquiring its review root",
        );
      }
      return reviewDeferred(
        afterAcquire,
        durableAfterAcquire?.phase === "invoking"
          ? "本代裁判已由唯一调用者接管。"
          : "裁判根取得后推进会话已进入终态，本代不再调用外部裁判。",
      );
    }
    session = afterAcquire;
    attempt = durableAfterAcquire;

    let evidenceRequestId: string | undefined;
    let collected:
      | { readonly canonicalEvidence: readonly import("@zhixing/core").ReviewEvidence[]; readonly requestId?: string }
      | undefined;
    try {
      collected = this.evidence && input.runId
        ? await this.evidence.collect({
            session,
            runId: input.runId,
            reviewId: attempt.lineageId,
            generation: attempt.generation,
            runRecord: input.runRecord,
            rootLease: lease,
            target: evidenceTarget,
            abort: input.abortSignal ?? new AbortController().signal,
          })
        : undefined;
      evidenceRequestId = collected?.requestId;
    } catch (error) {
      const expired = terminalAttempt(
        { ...attempt, rootLease: lease },
        "expired",
        `独立取证未能形成可消费终态：${errorMessage(error)}`,
        lease,
      );
      const settled = await this.transitionTerminalReviewAttempt(
        input.conversationId,
        session.id,
        expired,
      );
      session = settled.session;
      await this.cleanupReviewAttemptRoot(settled.attempt);
      return reviewDeferred(
        session,
        settled.attempt.detail ?? expired.detail!,
        error instanceof AdvancementEvidenceDeferredError ||
          (error instanceof Error && error.name === "AbortError")
          ? "aborted"
          : "infrastructure",
      );
    }

    const invoking: AdvancementReviewAttempt = {
      ...attempt,
      phase: "invoking",
      rootLease: lease,
    };
    try {
      session = await this.store.transitionReviewAttempt(
        input.conversationId,
        session.id,
        invoking,
        this.now(),
      );
    } catch (error) {
      const latestSession = await this.store.loadSession(
        input.conversationId,
        session.id,
      );
      const latestAttempt = latestSession
        ? reviewAttemptFor(latestSession, input.runRecordRef)
        : undefined;
      if (
        latestSession &&
        (latestSession.status !== "active" ||
          (latestAttempt !== undefined && isTerminalAttempt(latestAttempt)))
      ) {
        await this.cleanupReviewAttemptRoot(
          latestAttempt && isTerminalAttempt(latestAttempt)
            ? latestAttempt
            : terminalAttempt(
                { ...attempt, rootLease: lease },
                "expired",
                "裁判调用前业务 owner 已进入终态。",
                lease,
              ),
        );
        return reviewDeferred(
          latestSession,
          "裁判调用前推进会话已进入终态，本代未调用外部裁判。",
        );
      }
      throw error;
    }

    let outcome: AdvancementReviewRunOutcome;
    try {
      outcome = await this.reviewer.review(
        {
          sessionId: session.id,
          originalUserTask: session.originalUserTask,
          rubric,
          runIndex: input.runIndex,
          runRecord: input.runRecord,
          runRecordRef: input.runRecordRef,
          priorReviews: session.runs,
          advancementWindow: session.advancementWindow,
          ...(collected ? { canonicalEvidence: collected.canonicalEvidence } : {}),
        },
        lease,
        input.abortSignal ?? new AbortController().signal,
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
    if (outcome.kind === "deferred") {
      const deferred = terminalAttempt(
        invoking,
        "deferred",
        outcome.reason,
        lease,
      );
      const settled = await this.transitionTerminalReviewAttempt(
        input.conversationId,
        session.id,
        deferred,
      );
      session = settled.session;
      await this.cleanupReviewAttemptRoot(settled.attempt);
      return reviewDeferred(
        session,
        settled.attempt.detail ?? outcome.reason,
        outcome.cause,
      );
    }

    assertReviewMatchesAcceptedRun(input, outcome.review);
    const consumed = terminalAttempt(invoking, "consumed", undefined, lease);
    const result = await this.persistReviewOutcome(
      session,
      outcome.review,
      outcome.advancementWindow,
      evidenceRequestId,
      consumed,
    );
    await this.cleanupReviewAttemptRoot(consumed);
    return result;
  }

  private async reconcileTerminalReviewAttempts(
    conversationId: string,
  ): Promise<void> {
    if (!this.resources) return;
    const sessions = await this.store.loadConversationSessions(conversationId);
    for (const session of sessions) {
      for (const attempt of session.reviewAttempts ?? []) {
        if (isTerminalAttempt(attempt)) {
          await this.cleanupReviewAttemptRoot(attempt);
        }
      }
    }
  }

  private async transitionTerminalReviewAttempt(
    conversationId: string,
    sessionId: string,
    proposed: AdvancementReviewAttempt,
  ): Promise<{
    readonly session: AdvancementSession;
    readonly attempt: AdvancementReviewAttempt;
  }> {
    if (!isTerminalAttempt(proposed)) {
      throw new TypeError("AdvancementController: terminal transition requires a terminal attempt");
    }
    try {
      const session = await this.store.transitionReviewAttempt(
        conversationId,
        sessionId,
        proposed,
        this.now(),
      );
      return {
        session,
        attempt: reviewAttemptFor(session, proposed.runRecordRef) ?? proposed,
      };
    } catch (error) {
      const session = await this.store.loadSession(conversationId, sessionId);
      const winner = session
        ? reviewAttemptFor(session, proposed.runRecordRef)
        : undefined;
      if (
        session &&
        winner &&
        winner.lineageId === proposed.lineageId &&
        winner.generation === proposed.generation &&
        isTerminalAttempt(winner)
      ) {
        return { session, attempt: winner };
      }
      throw error;
    }
  }

  private async acquireReviewRoot(
    attempt: AdvancementReviewAttempt,
  ): Promise<ImmediateRootResourceLease> {
    if (!this.resources) {
      throw new Error("AdvancementController: resource governor is not assembled");
    }
    const inspection = await this.resources.inspectImmediateRoot(
      attempt.root.workload,
    );
    if (inspection.kind === "reservation") {
      assertReviewRootLease(attempt.root, inspection.lease);
      if (inspection.state !== "active") {
        throw new ImmediateRootReplayTerminalError(inspection);
      }
      return inspection.lease;
    }
    if (inspection.kind === "dequeued") {
      throw new ImmediateRootReplayTerminalError(inspection);
    }
    let lease: ImmediateRootResourceLease;
    try {
      lease = await this.resources.acquireRoot(
        attempt.root.workload,
        attempt.root.budget,
        { admissionClass: "advancement", entry: "advancement-control" },
        reviewRootContext(attempt.root),
        attempt.root.audience,
        attempt.root.scopeBinding,
      );
    } catch (error) {
      const afterFailure = await this.resources.inspectImmediateRoot(
        attempt.root.workload,
      );
      if (
        afterFailure.kind === "reservation" &&
        afterFailure.state === "active"
      ) {
        assertReviewRootLease(attempt.root, afterFailure.lease);
        return afterFailure.lease;
      }
      if (
        afterFailure.kind === "dequeued" ||
        (afterFailure.kind === "reservation" && afterFailure.state !== "active")
      ) {
        throw new ImmediateRootReplayTerminalError(afterFailure);
      }
      throw error;
    }
    assertReviewRootLease(attempt.root, lease);
    return lease;
  }

  private async cleanupReviewAttemptRoot(
    attempt: AdvancementReviewAttempt,
  ): Promise<boolean> {
    if (!this.resources || !isTerminalAttempt(attempt)) return false;
    let inspection = await this.resources.inspectImmediateRoot(attempt.root.workload);
    if (inspection.kind === "absent" || inspection.kind === "dequeued") return true;
    if (inspection.kind === "queued") {
      try {
        const lease = await this.resources.acquireRoot(
          attempt.root.workload,
          attempt.root.budget,
          { admissionClass: "advancement", entry: "advancement-control" },
          reviewRootContext(attempt.root, 250),
          attempt.root.audience,
          attempt.root.scopeBinding,
        );
        assertReviewRootLease(attempt.root, lease);
      } catch {
        // acquireRoot 的有界 deadline 会为未激活队列写入出队事实；
        // 无论返回还是抛错都以随后重读的耐久分类为准。
      }
      inspection = await this.resources.inspectImmediateRoot(attempt.root.workload);
      if (inspection.kind === "absent" || inspection.kind === "dequeued") return true;
      if (inspection.kind === "queued") return false;
    }
    assertReviewRootLease(attempt.root, inspection.lease);
    if (inspection.state === "released" || inspection.state === "reclaimed") {
      return true;
    }
    const ctx = reviewRootContext(attempt.root);
    if (inspection.state === "active") {
      try {
        await this.resources.settle(inspection.lease, ctx);
      } catch {
        return false;
      }
    }
    try {
      await this.resources.release(inspection.lease, ctx);
    } catch {
      return false;
    }
    inspection = await this.resources.inspectImmediateRoot(attempt.root.workload);
    return (
      inspection.kind === "absent" ||
      inspection.kind === "dequeued" ||
      (inspection.kind === "reservation" &&
        (inspection.state === "released" || inspection.state === "reclaimed"))
    );
  }

  private async cancelSession(
    conversationId: string,
    sessionId: string,
    message: string,
    reason: AdvancementExit["reason"] = "user-cancelled",
  ): Promise<AdvancementSession> {
    let current = await this.store.loadSession(conversationId, sessionId);
    const terminalAttempts: AdvancementReviewAttempt[] = [];
    for (const attempt of current?.reviewAttempts ?? []) {
      if (attempt.phase !== "started" && attempt.phase !== "invoking") continue;
      const terminal = terminalAttempt(
        attempt,
        attempt.phase === "invoking" ? "deferred" : "expired",
        "推进会话关闭，未完成裁判尝试停止推进。",
      );
      const settled = await this.transitionTerminalReviewAttempt(
        conversationId,
        sessionId,
        terminal,
      );
      current = settled.session;
      terminalAttempts.push(settled.attempt);
    }
    const cancelled = await this.store.cancelSession(conversationId, sessionId, {
      reason,
      message,
      occurredAt: this.now(),
    } satisfies AdvancementExit);
    for (const attempt of terminalAttempts) {
      await this.cleanupReviewAttemptRoot(attempt);
    }
    return cancelled;
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

function reviewFlightKey(input: {
  readonly conversationId: string;
  readonly runIndex: number;
  readonly runRecordRef?: RunRecordRef;
}): string {
  return input.runRecordRef
    ? `${input.conversationId}:${input.runRecordRef.shardId}:${input.runRecordRef.runIndex}`
    : `${input.conversationId}:legacy:${input.runIndex}`;
}

function stableRunId(ref: RunRecordRef): string {
  return `accepted-run:${ref.shardId}:${ref.runIndex}`;
}

function reviewAttemptFor(
  session: AdvancementSession,
  ref: RunRecordRef,
): AdvancementReviewAttempt | undefined {
  return session.reviewAttempts?.find((attempt) =>
    sameRunRecordRef(attempt.runRecordRef, ref),
  );
}

function isTerminalAttempt(attempt: AdvancementReviewAttempt): boolean {
  return (
    attempt.phase === "consumed" ||
    attempt.phase === "deferred" ||
    attempt.phase === "expired"
  );
}

function terminalAttempt(
  attempt: AdvancementReviewAttempt,
  phase: "consumed" | "deferred" | "expired",
  detail?: string,
  rootLease?: ImmediateRootResourceLease,
): AdvancementReviewAttempt {
  return {
    lineageId: attempt.lineageId,
    generation: attempt.generation,
    runId: attempt.runId,
    runIndex: attempt.runIndex,
    runRecordRef: structuredClone(attempt.runRecordRef),
    phase,
    root: structuredClone(attempt.root),
    ...(rootLease ?? attempt.rootLease
      ? { rootLease: structuredClone(rootLease ?? attempt.rootLease!) }
      : {}),
    ...(detail === undefined ? {} : { detail }),
  };
}

function reviewRootContract(input: {
  readonly lineageId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly target?: AdvancementEvidenceRootTarget;
}): AdvancementReviewRootContract {
  const id = advancementReviewAttemptId(input.lineageId, input.generation);
  return {
    workload: { kind: "control", id, attempt: 1 },
    budget: { maxCalls: 8, maxTokens: 300_000 },
    requestId: advancementReviewRootRequestId(input.lineageId, input.generation),
    ...(input.target
      ? {
          audience: { executorId: input.target.executorId },
          scopeBinding: {
            kind: "conversation" as const,
            conversationId: input.conversationId,
            ownerEpoch: input.target.ownerEpoch,
          },
        }
      : {}),
  };
}

function reviewRootTargetMatches(
  root: AdvancementReviewRootContract,
  target: AdvancementEvidenceRootTarget | undefined,
): boolean {
  if (!target) {
    return root.audience === undefined && root.scopeBinding === undefined;
  }
  return (
    root.audience?.executorId === target.executorId &&
    root.scopeBinding?.kind === "conversation" &&
    root.scopeBinding.ownerEpoch === target.ownerEpoch
  );
}

function reviewRootContext(
  root: AdvancementReviewRootContract,
  deadlineMs = 120_000,
): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "advancement-review" },
    requestId: root.requestId,
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
  };
}

function assertReviewRootLease(
  root: AdvancementReviewRootContract,
  lease: ImmediateRootResourceLease,
): void {
  const expectedScope = root.scopeBinding ?? {
    kind: "control" as const,
    subject: root.workload.id,
  };
  if (
    canonicalize(lease.workload) !== canonicalize(root.workload) ||
    canonicalize(lease.budget) !== canonicalize(root.budget) ||
    canonicalize(lease.scopeBinding) !== canonicalize(expectedScope) ||
    (root.audience !== undefined &&
      canonicalize(lease.audience) !== canonicalize(root.audience))
  ) {
    throw new Error("AdvancementController: review root changed its frozen contract");
  }
}

function describeRootTerminal(error: ImmediateRootReplayTerminalError): string {
  return error.inspection.kind === "dequeued"
    ? `出队（${error.inspection.reason}）`
    : `进入 ${error.inspection.state} 终态`;
}

function reviewDeferred(
  session: AdvancementSession,
  reason: string,
  cause: "infrastructure" | "aborted" = "infrastructure",
): AdvancementTurnReviewResult {
  return { kind: "review-deferred", session, cause, reason };
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
