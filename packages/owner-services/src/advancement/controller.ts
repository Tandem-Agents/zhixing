import {
  RubricContractBuilder,
  ConservativeAdvancementAdmissionStrategy,
  type AdvancementAdmissionDecision,
  type AdvancementAdmissionStrategy,
  type AdvancementExit,
  type AdvancementSession,
  type AdvancementOriginalTaskAdmissionIntent,
  type ConfirmedRubricSnapshot,
  type RubricContractDraftSnapshot,
  type Message,
  type UserTurnInput,
  type AdvancementClosureReport,
  extractText,
} from "@zhixing/core";
import type {
  AdvancementActiveUserTurnMechanismPort,
  AdvancementAwaitingRubricAdmissionDecision,
  AdvancementAwaitingRubricAdmissionMechanismPort,
  AdvancementNewTaskMechanismPort,
  AdvancementRubricConfirmationMechanismPort,
  AdvancementRubricRevisionMechanismPort,
  AdvancementClosureSynthesizer,
  RubricPublicationOutcome,
  RubricPublicationPort,
} from "@zhixing/core/advancement/application";
import { randomUUID } from "node:crypto";
import { composeAdvancementClosureReport } from "@zhixing/core/advancement/application";
import type { AdvancementSessionStore } from "./session-store.js";

export interface AdvancementControllerOptions {
  /** 推进会话存储——生产装配注入权威日志适配实现，无隐式回退。 */
  readonly store: AdvancementSessionStore;
  readonly contractBuilder?: RubricContractBuilder;
  readonly admissionStrategy?: AdvancementAdmissionStrategy;
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
  readonly now?: () => string;
}
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
  private readonly rubricPublication?: RubricPublicationPort;
  private readonly recentContextProvider?: (
    conversationId: string,
  ) => Promise<string | undefined>;
  private readonly onAdmissionTiming?: (elapsedMs: number) => void;
  private readonly closureSynthesizer?: AdvancementClosureSynthesizer;
  private readonly now: () => string;

  constructor(options: AdvancementControllerOptions) {
    this.store = options.store;
    this.contractBuilder = options.contractBuilder ?? new RubricContractBuilder();
    this.admissionStrategy =
      options.admissionStrategy ?? new ConservativeAdvancementAdmissionStrategy();
    this.rubricPublication = options.rubricPublication;
    this.recentContextProvider = options.recentContextProvider;
    this.onAdmissionTiming = options.onAdmissionTiming;
    this.closureSynthesizer = options.closureSynthesizer;
    this.now = options.now ?? (() => new Date().toISOString());
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
    return await this.store.settleProxyMessage(
      input.conversationId,
      input.advancementSessionId,
      input.proxyMessageId,
      this.now(),
    );
  }

  /** 收场报告：LLM 合成优先，失败或缺 synthesizer 时降级结构化直出。 */
  private async composeClosureReport(
    session: AdvancementSession,
  ): Promise<AdvancementClosureReport> {
    return await composeAdvancementClosureReport(
      session,
      this.closureSynthesizer,
    );
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

  loadOpenConversationLifecycleSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    return this.store.loadActiveSession(conversationId);
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
