import type { UserTurnInput } from "../types/user-input.js";
import { advancementProposalId } from "./proposal-identity.js";
import { isProposalStageStatus } from "./reducer.js";
import type {
  AdvancementDraftAttempt,
  AdvancementSession,
  RubricContractDraftSnapshot,
} from "./types.js";

/** 本会话已提交、尚未被推进应用接受的提议；原任务取自提议运行的耐久 ingress。 */
export interface AdvancementPendingProposal {
  readonly runId: string;
  readonly originalTurnId: string;
  readonly originalUserTask: UserTurnInput;
}

/** 提议阶段用到的持久化与模型机制；推进状态的决定留在本应用。 */
export interface AdvancementProposalMechanismPort {
  listPendingProposals(conversationId: string): Promise<readonly AdvancementPendingProposal[]>;
  acceptProposal(input: Readonly<{
    conversationId: string;
    proposalId: string;
    runId: string;
    originalTurnId: string;
    originalUserTask: UserTurnInput;
  }>): Promise<AdvancementSession>;
  loadLatestSession(conversationId: string): Promise<AdvancementSession | null>;
  transitionDraftAttempt(conversationId: string, sessionId: string, attempt: AdvancementDraftAttempt): Promise<AdvancementSession>;
  persistProposalDraft(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementDraftAttempt,
    revision: number,
    draft: RubricContractDraftSnapshot,
  ): Promise<AdvancementSession>;
  buildDraft(input: Readonly<{ originalTurnId: string; originalUserTask: UserTurnInput; abortSignal: AbortSignal }>): Promise<RubricContractDraftSnapshot>;
  /** 把补充原样（文字与图片）按修订语义并入草案。 */
  reviseDraft(input: Readonly<{
    currentDraft: RubricContractDraftSnapshot;
    originalUserTask: UserTurnInput;
    supplements: readonly UserTurnInput[];
    abortSignal: AbortSignal;
  }>): Promise<RubricContractDraftSnapshot>;
}

/** 提议阶段的可见结果；接入面只呈现，不决定也不持久化推进状态。 */
export type AdvancementProposalFact =
  | Readonly<{
      kind: "advancement-proposal-drafted";
      conversationId: string;
      advancementSessionId: string;
      originalTurnId: string;
      rubricDraft: RubricContractDraftSnapshot;
    }>
  | Readonly<{
      kind: "advancement-proposal-draft-failed";
      conversationId: string;
      advancementSessionId: string;
      originalTurnId: string;
      outcome: "failed" | "uncertain";
      message: string;
    }>;

export interface AdvancementProposalFactPort {
  publish(fact: AdvancementProposalFact): void | Promise<void>;
}

const PERSIST_RACE_LIMIT = 3;

/** 实例内在途的一代草案尝试：模型调用随它的中止信号停下。 */
interface DraftFlight {
  readonly conversationId: string;
  readonly controller: AbortController;
  readonly promise: Promise<AdvancementSession | null>;
}

/**
 * 主 Agent 提议的接受与草案。接受幂等，凡处理会话的入口（运行提交后、控制输入、恢复）都先接受；
 * 草案尝试按实例内在途表单飞：同一会话的并发调用并入同一在途，本实例无在途而耐久为 invoking 的尝试
 * 记为结果不明，本代不重放模型调用。
 *
 * 停服与排空沿用恢复维护的合同：开始排空或停止时中止全部在途模型调用并等它们收尾，排空期间不起新的
 * 尝试；删除对话时中止该对话的在途调用。被中止的这一代仍是本代时记为结果不明，写不进去（宿主已在
 * 关停）就留下 invoking，由下次启动按“失去调用者”同样收尾；会话已离开本代则只作废结果。
 */
export class AdvancementProposalApplicationService {
  readonly #mechanism: AdvancementProposalMechanismPort;
  readonly #facts?: AdvancementProposalFactPort;
  readonly #flights = new Map<string, DraftFlight>();
  #draining = false;
  #stopped = false;

  constructor(options: Readonly<{
    mechanism: AdvancementProposalMechanismPort;
    facts?: AdvancementProposalFactPort;
  }>) {
    this.#mechanism = options.mechanism;
    this.#facts = options.facts;
  }

  /** 开始排空：中止全部在途草案调用并等它们收尾；恢复前不起新的尝试。 */
  async beginDrain(): Promise<void> {
    this.#draining = true;
    await this.#abortWhere(() => true);
  }

  resume(): void {
    if (!this.#stopped) this.#draining = false;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.beginDrain();
  }

  /** 对话删除或取消：中止该对话的在途草案调用；迟到结果因会话已离开本代而作废。 */
  async cancel(conversationId: string): Promise<void> {
    await this.#abortWhere((flight) => flight.conversationId === conversationId);
  }

  async #abortWhere(match: (flight: DraftFlight) => boolean): Promise<void> {
    const flights = [...this.#flights.values()].filter(match);
    for (const flight of flights) flight.controller.abort(new DraftInterruptedError());
    await Promise.allSettled(flights.map((flight) => flight.promise));
  }

  /** 幂等接受本会话的待接受提议，返回当前头会话。 */
  async acceptPending(conversationId: string): Promise<AdvancementSession | null> {
    for (const pending of await this.#mechanism.listPendingProposals(conversationId)) {
      await this.#mechanism.acceptProposal({
        conversationId,
        proposalId: advancementProposalId(conversationId, pending.runId),
        runId: pending.runId,
        originalTurnId: pending.originalTurnId,
        originalUserTask: pending.originalUserTask,
      });
    }
    return await this.#mechanism.loadLatestSession(conversationId);
  }

  /** 接受并推进：proposed 会话起一代草案尝试；失去调用者的 invoking 尝试记为结果不明。 */
  async advance(conversationId: string): Promise<AdvancementSession | null> {
    const session = await this.acceptPending(conversationId);
    if (!session?.proposal || !isProposalStageStatus(session.status)) return session;
    const inFlight = this.#flights.get(session.id);
    if (inFlight) return await inFlight.promise;
    // 排空或停止期间不起新尝试，也不结算 invoking（在途的正由排空中止并收尾）
    if (this.#draining) return session;
    if (session.status === "drafting") return await this.#settleLostAttempt(session);
    if (session.status !== "proposed") return session;
    const controller = new AbortController();
    const promise = this.#draft(session, controller.signal).finally(() => {
      if (this.#flights.get(session.id)?.promise === promise) this.#flights.delete(session.id);
    });
    this.#flights.set(session.id, { conversationId: session.conversationId, controller, promise });
    return await promise;
  }

  async #settleLostAttempt(session: AdvancementSession): Promise<AdvancementSession> {
    const attempt = session.proposal!.draftAttempt!;
    const message = "Rubric 草案生成结果不明，未自动重试；可以直接执行原任务或取消。";
    const settled = await this.#mechanism.transitionDraftAttempt(session.conversationId, session.id, {
      ...attempt,
      phase: "deferred",
      detail: message,
    });
    await this.#publishFailure(settled, "uncertain", message);
    return settled;
  }

  async #draft(session: AdvancementSession, abortSignal: AbortSignal): Promise<AdvancementSession | null> {
    const proposal = session.proposal!;
    const conversationId = session.conversationId;
    const invoking: AdvancementDraftAttempt = {
      generation: (proposal.draftAttempt?.generation ?? 0) + 1,
      revision: proposal.supplements.length,
      phase: "invoking",
    };
    await this.#mechanism.transitionDraftAttempt(conversationId, session.id, invoking);
    let draft: RubricContractDraftSnapshot;
    let merged = 0;
    try {
      abortSignal.throwIfAborted();
      draft = await this.#mechanism.buildDraft({
        originalTurnId: proposal.originalTurnId,
        originalUserTask: session.originalUserTask,
        abortSignal,
      });
      // 补充按修订语义并入：起草前已有的与起草期间新到的都在这里并入，文字与图片原样交给修订
      for (let race = 0; ; race += 1) {
        abortSignal.throwIfAborted();
        const latest = await this.#current(session, invoking);
        if (!latest) return await this.#mechanism.loadLatestSession(conversationId);
        const supplements = latest.proposal!.supplements;
        if (supplements.length > merged) {
          draft = await this.#mechanism.reviseDraft({
            currentDraft: draft,
            originalUserTask: latest.originalUserTask,
            supplements: supplements.slice(merged),
            abortSignal,
          });
          merged = supplements.length;
          continue;
        }
        try {
          const committed = await this.#mechanism.persistProposalDraft(
            conversationId,
            session.id,
            { ...invoking, phase: "consumed" },
            merged,
            draft,
          );
          await this.#facts?.publish({
            kind: "advancement-proposal-drafted",
            conversationId,
            advancementSessionId: committed.id,
            originalTurnId: proposal.originalTurnId,
            rubricDraft: draft,
          });
          return committed;
        } catch (error) {
          // 写入前又到了补充（修订数不再一致）：重读后并入再写；会话已离开本代则只作废结果
          if (race + 1 >= PERSIST_RACE_LIMIT) throw error;
        }
      }
    } catch (error) {
      if (!(await this.#current(session, invoking))) return await this.#mechanism.loadLatestSession(conversationId);
      if (abortSignal.aborted) {
        // 停服、排空或删除中止了本代调用：模型是否已产生用量与结果不可知，记为结果不明，不重放
        const message = "Rubric 草案生成在服务停止时被中断，结果不明，未自动重试；可以补充说明重新起草，或直接执行原任务、取消。";
        const deferred = await this.#mechanism.transitionDraftAttempt(conversationId, session.id, {
          ...invoking,
          phase: "deferred",
          detail: message,
        });
        await this.#publishFailure(deferred, "uncertain", message);
        return deferred;
      }
      // 原因本身：给用户的说明已带“验收标准起草失败”，不再叠一层内部前缀
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.#mechanism.transitionDraftAttempt(conversationId, session.id, {
        ...invoking,
        phase: "failed",
        detail: message.slice(0, 500),
      });
      await this.#publishFailure(failed, "failed", message);
      return failed;
    }
  }

  /** 会话仍在本代草案中才返回它；已取消、换目标或进入下一代时迟到结果只作废。 */
  async #current(session: AdvancementSession, attempt: AdvancementDraftAttempt): Promise<AdvancementSession | null> {
    const latest = await this.#mechanism.loadLatestSession(session.conversationId);
    return latest?.id === session.id && latest.status === "drafting" &&
      latest.proposal?.draftAttempt?.generation === attempt.generation
      ? latest
      : null;
  }

  async #publishFailure(session: AdvancementSession, outcome: "failed" | "uncertain", message: string): Promise<void> {
    await this.#facts?.publish({
      kind: "advancement-proposal-draft-failed",
      conversationId: session.conversationId,
      advancementSessionId: session.id,
      originalTurnId: session.proposal!.originalTurnId,
      outcome,
      message,
    });
  }
}

/** 排空、停止或删除中止草案调用时的原因。 */
class DraftInterruptedError extends Error {
  constructor() {
    super("Rubric draft attempt was interrupted");
    this.name = "AbortError";
  }
}
