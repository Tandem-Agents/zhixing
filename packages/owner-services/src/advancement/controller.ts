import {
  RubricContractBuilder,
  ConservativeAdvancementAdmissionStrategy,
  createAdvancementWindowReviewEntry,
  type AdvancementAdmissionDecision,
  type AdvancementAdmissionStrategy,
  type AdvancementExit,
  type AdvancementProxyMessage,
  type AdvancementReviewRunOutcome,
  type AdvancementRunReview,
  type AdvancementSession,
  type AdvancementWindowState,
  type RunRecordInput,
  type RunRecordRef,
  type RubricContractDraftSnapshot,
  type RubricDraftPersistenceChoice,
  type Message,
  type UserTurnInput,
  type AdvancementClosureFacts,
  type AdvancementClosureReport,
  buildClosureFacts,
  extractText,
  extractUserTurnInputText,
  projectConfirmedRubricToDraftContent,
  renderClosureReport,
  sumAdvancementUsage,
} from "@zhixing/core";
import type {
  AdvancementReviewerPort,
  AuthorityCallContext,
  ImmediateRootResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import { randomUUID } from "node:crypto";
import {
  buildAdvancementProxyMessage,
  selectFailureHandling,
} from "./proxy-content.js";
import type { AdvancementSessionStore } from "./session-store.js";
import {
  AdvancementEvidenceCoordinator,
  AdvancementEvidenceDeferredError,
} from "./evidence.js";

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
      readonly closure: AdvancementClosureReport;
    }
  | {
      readonly kind: "rubric-regenerated";
      readonly exitedSession: AdvancementSession;
      readonly exit: AdvancementExit;
      readonly closure: AdvancementClosureReport;
      readonly session: AdvancementSession;
      readonly draft: RubricContractDraftSnapshot;
      readonly admission: AdvancementAdmissionDecision;
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
  readonly rubricPublication?: RubricPublicationOutcome;
}

export type RubricPublicationOutcome =
  | { readonly kind: "saved"; readonly rubricId: string; readonly revision: number }
  | { readonly kind: "deferred"; readonly message: string };

export interface RubricPublicationPort {
  acceptanceOutcome(): RubricPublicationOutcome;
  publish(input: {
    readonly conversationId: string;
    readonly draft: RubricContractDraftSnapshot;
    readonly persistence: RubricDraftPersistenceChoice;
  }): Promise<RubricPublicationOutcome>;
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

export class AdvancementController {
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

  async prepareUserTurn(input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly userInput: UserTurnInput;
    readonly beforeCreateSession?: () => Promise<void>;
  }): Promise<AdvancementPrepareResult> {
    const open = await this.store.loadActiveSession(input.conversationId);
    if (open?.status === "awaiting-rubric-confirmation") {
      const admission = await this.decideAdmission({
        conversationId: input.conversationId,
        userInput: input.userInput,
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
      const admission = await this.decideAdmission({
        conversationId: input.conversationId,
        userInput: input.userInput,
        hasActiveAdvancementSession: true,
      });
      if (admission.action === "take-over-active") {
        // 有推进事实的接管归 exited 并交付收场；cancelled 只留给
        // 无执行事实的关闭（awaiting 取消、对话删除）。
        const exit: AdvancementExit = {
          reason: "user-took-over",
          message: "用户接管或改变了当前推进目标，原推进闭环已退出。",
          occurredAt: this.now(),
        };
        const exited = await this.store.exitSession(
          input.conversationId,
          open.id,
          exit,
          exit.occurredAt,
        );
        return {
          kind: "active-session-taken-over",
          session: exited,
          admission,
          exit,
          closure: await this.composeClosureReport(exited),
        };
      }
      if (admission.action === "revise-rubric") {
        return await this.regenerateRubricContract(input, open, admission);
      }
      return {
        kind: "active-user-turn",
        session: open,
        admission,
      };
    }

    const admission = await this.decideAdmission({
      conversationId: input.conversationId,
      userInput: input.userInput,
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

  /**
   * 契约再生：标准修正类退出后一回合重启——先按用户修正生成新草案
   * （可失败，失败时旧契约保持 active 不受损），成功后才退出旧契约
   * （superseded + 收场），以反投影预填 + 用户修正的新草案开新 awaiting
   * 会话。语义仍是「退出 + 新不可变快照」，无中途可变契约；执行侧历史
   * 留在同一 conversation，执行进度零丢失。
   */
  private async regenerateRubricContract(
    input: {
      readonly conversationId: string;
      readonly turnId: string;
      readonly userInput: UserTurnInput;
      readonly beforeCreateSession?: () => Promise<void>;
    },
    open: AdvancementSession,
    admission: AdvancementAdmissionDecision,
  ): Promise<AdvancementPrepareResult> {
    const oldRubric = open.confirmedRubric;
    if (!oldRubric) {
      const exit: AdvancementExit = {
        reason: "system-error",
        message: "推进会话缺少已确认 Rubric，无法按其再生契约，已退出。",
        occurredAt: this.now(),
      };
      const exited = await this.store.exitSession(
        input.conversationId,
        open.id,
        exit,
        exit.occurredAt,
      );
      return {
        kind: "active-session-taken-over",
        session: exited,
        admission,
        exit,
        closure: await this.composeClosureReport(exited),
      };
    }

    const prefillDraft: RubricContractDraftSnapshot = {
      draftId: randomUUID(),
      originalTurnId: input.turnId,
      source: "generated",
      candidateRubricIds: [],
      title: oldRubric.title,
      description: oldRubric.description,
      content: projectConfirmedRubricToDraftContent(oldRubric),
      createdAt: this.now(),
    };
    let revised: RubricContractDraftSnapshot;
    try {
      revised = await this.contractBuilder.reviseDraft({
        currentDraft: prefillDraft,
        originalUserTask: open.originalUserTask,
        userFeedback: extractUserTurnInputText(input.userInput).trim(),
      });
    } catch (err) {
      // 修订失败不动旧契约——闭环保持原样，确认面受控失败提示。
      return {
        kind: "contract-failed",
        conversationId: input.conversationId,
        originalTurnId: input.turnId,
        error: { message: errorMessage(err) },
      };
    }

    const exit: AdvancementExit = {
      reason: "superseded",
      message: "用户修正验收标准，原契约退出，按修正后的标准重新确认。",
      occurredAt: this.now(),
    };
    const exited = await this.store.exitSession(
      input.conversationId,
      open.id,
      exit,
      exit.occurredAt,
    );
    const closure = await this.composeClosureReport(exited);
    await input.beforeCreateSession?.();
    const session = await this.store.createSession({
      id: `adv_${revised.draftId}`,
      conversationId: input.conversationId,
      originalUserTask: open.originalUserTask,
      pendingRubricDraft: revised,
      createdAt: revised.createdAt,
    });
    return {
      kind: "rubric-regenerated",
      exitedSession: exited,
      exit,
      closure,
      session,
      draft: revised,
      admission,
    };
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

  async confirmRubric(input: {
    readonly conversationId: string;
    readonly advancementSessionId: string;
    /**
     * 发起端所见草案版本——「确认你所见」是协议语义，必填强制：
     * 草案被并发修订后拒绝盲确认，不依赖调用方自觉。
     */
    readonly expectedRubricDraftId: string;
    readonly persistence?: RubricDraftPersistenceChoice;
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
    if (draft.draftId !== input.expectedRubricDraftId) {
      throw new Error(
        "推进准则草案已被修订，请查看最新内容后再确认。",
      );
    }
    const confirmedRubric = await this.contractBuilder.confirmDraft(draft);
    const confirmed = await this.store.confirmRubric(
      input.conversationId,
      input.advancementSessionId,
      confirmedRubric,
      confirmedRubric.confirmedAt,
    );
    let rubricPublication: RubricPublicationOutcome | undefined;
    if (draft.source === "generated" && input.persistence) {
      rubricPublication = this.rubricPublication?.acceptanceOutcome() ?? {
        kind: "deferred",
        message: "准则已用于本任务，连接值班设备后可保存到准则库。",
      };
      if (this.rubricPublication) {
        void this.rubricPublication.publish({
          conversationId: input.conversationId,
          draft,
          persistence: input.persistence,
        }).catch(() => undefined);
      }
    }
    return {
      session: confirmed,
      originalTurnId: draft.originalTurnId,
      originalUserTask: confirmed.originalUserTask,
      ...(rubricPublication ? { rubricPublication } : {}),
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
    let session = await this.store.loadActiveSession(input.conversationId);
    if (!session) return { kind: "skipped", reason: "no-active-session" };
    if (session.status !== "active") {
      return { kind: "skipped", reason: "not-active" };
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

    let outcome: AdvancementReviewRunOutcome;
    const pendingEvidence = input.runId
      ? session.evidence?.pending.find(
          (pending) => pending.request.runId === input.runId,
        )
      : undefined;
    const reviewId = pendingEvidence?.reviewId ?? this.reviewIdGenerator();
    const reviewCtx: AuthorityCallContext = {
      principal: { kind: "host", component: "advancement-review" },
      requestId: `advancement-review:${reviewId}`,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    };
    let lease: ImmediateRootResourceLease | undefined;
    let evidenceRequestId: string | undefined;
    try {
      const evidenceTarget = this.evidence && input.runId
        ? await this.evidence.resolveTarget(input.conversationId, input.runId)
        : undefined;
      lease = await this.resources.acquireRoot(
        { kind: "control", id: reviewId, attempt: 1 },
        { maxCalls: 8, maxTokens: 300_000 },
        { admissionClass: "advancement", entry: "advancement-control" },
        reviewCtx,
        evidenceTarget ? { executorId: evidenceTarget.executorId } : undefined,
        evidenceTarget
          ? {
              kind: "conversation",
              conversationId: input.conversationId,
              ownerEpoch: evidenceTarget.ownerEpoch,
            }
          : undefined,
      );
      const collected = this.evidence && input.runId
        ? await this.evidence.collect({
            session,
            runId: input.runId,
            reviewId,
            runRecord: input.runRecord,
            rootLease: lease,
            target: evidenceTarget,
            abort: input.abortSignal ?? new AbortController().signal,
          })
        : undefined;
      evidenceRequestId = collected?.requestId;
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
          ...(collected
            ? { canonicalEvidence: collected.canonicalEvidence }
            : {}),
        },
        lease,
        input.abortSignal ?? new AbortController().signal,
      );
    } catch (err) {
      // 运行体按契约不 throw；意外 throw 视作基础设施抖动挂起，
      // 交补审触发点收敛，不误落终局杀掉长期会话。
      outcome = {
        kind: "deferred",
        cause:
          err instanceof AdvancementEvidenceDeferredError ||
          (err instanceof Error && err.name === "AbortError")
            ? "aborted"
            : "infrastructure",
        reason: `推进侧验收运行失败：${errorMessage(err)}`,
      };
    } finally {
      if (lease) {
        try {
          await this.resources.settle(lease, reviewCtx);
        } catch {
          // 终结失败由治理侧过期回收兜底，不吞裁判结论。
        }
        try {
          await this.resources.release(lease, reviewCtx);
        } catch {
          // 同上。
        }
      }
    }
    if (outcome.kind === "deferred") {
      return {
        kind: "review-deferred",
        session,
        cause: outcome.cause,
        reason: outcome.reason,
      };
    }

    // 结论与被审 run 的绑定校验在挂起分流之外：不匹配是系统一致性
    // 错误，直接冒泡暴露，不落盘也不伪装成裁判结论。
    assertReviewMatchesAcceptedRun(input, outcome.review);
    return await this.persistReviewOutcome(
      session,
      outcome.review,
      outcome.advancementWindow,
      evidenceRequestId,
    );
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
    evidenceRequestId?: string,
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
    );
  }

  private async persistProxyOutcome(
    session: AdvancementSession,
    review: AdvancementRunReview,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
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
