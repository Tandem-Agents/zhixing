/**
 * ConversationController —— repl 的会话域控制器(纯接入面形态)。
 *
 * cli 收编后会话状态的唯一权威在核心宿主(窗口 / turnCounter / 持久化全在
 * 宿主侧),cli 持有的只是**当前对话指针**与围绕它的 RPC 编排:
 *
 * - sendTurn:预分配 turnId → send 入队 → 等待该 turn 的 complete 通知
 *   (turn 落定)→ 带出
 *   暂存的 turn 边界控制意图(intent 先于 complete 定向到达,turn 边界统一消费,
 *   与 REPL 原有消费语义对齐);
 * - 主通道喂渲染:delta 通知按当前对话过滤后经 onYield 回调交给渲染器——
 *   主渲染管线一行不改;
 * - abort:打断当前对话的 in-flight turn(宿主侧 abort,complete 随 cleanup
 *   自然到达);
 * - 指针操作:new / resume / clear / rename / compact / 场景 enter·exit 组合
 *   facade 调用与指针维护;"当前在哪个对话 / 场景"是接入面 UI 态,宿主零知识,
 *   模式视图由对话全域键纯函数派生。
 */

import { finalAssistantMessageOf, type AgentYield } from "@zhixing/core/loop";
import { resolveWorksceneMainReturn } from "@zhixing/core/workscene/application";
import { extractText, generateTurnId, type Message, type AgentEventMap, type UserTurnInput, type PostTurnControlOutcome } from "@zhixing/core";
import { parseConversationId, WORKSCENE_CONVERSATION_PREFIX } from "@zhixing/core/conversation";
import type {
  ConversationStatusNotice,
  FinalFrame,
  StreamFrame,
} from "@zhixing/core/contracts";
import type {
  SessionAdvancementCancelResult,
  SessionCompactResult,
  SessionContextBudgetResult,
  SessionChangedPayload,
  SessionActivityPayload,
  SessionConversationEntry,
  SessionUsageResult,
  WireAgentResult,
  WorksceneSummary,
  SessionAdvancementDetailResult,
  SessionAdoptionReviewResult,
  SessionAdvancementStateSnapshot,
  SessionRubricPersistenceChoice,
  SessionAwaitingRubricResult,
  SessionCancelledRubricResult,
  SessionContractFailedResult,
  SessionSendEngage,
  SessionSendResult,
} from "@zhixing/rpc";
import type { ConversationCommunicationHistory as RunsPage } from "@zhixing/core/conversation/application";
import { RPC_ERROR_CODES, RpcClientError } from "@zhixing/server";
import type { RpcConversationFacade } from "./rpc-conversation-facade.js";
import type { RpcWorksceneFacade } from "./rpc-workscene-facade.js";

/** 当前对话指针 + 模式视图(由全域键派生,场景显示名取自 enter 响应) */
export interface ActiveConversation {
  conversationId: string;
  name: string;
  mode:
    | { kind: "main" }
    | { kind: "workscene"; sceneId: string; sceneName: string };
}

export interface TurnOutcome {
  result: WireAgentResult;
  /** turn 内 LLM 产生的 turn 边界控制意图(定向通知暂存,turn 边界消费) */
  postTurnControl?: PostTurnControlOutcome;
}

export interface AcceptedTurn {
  readonly conversationId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly outcome: Promise<TurnOutcome>;
  /** 输入被分类为 active 推进的补充继续时附带——接入面据此告知用户。 */
  readonly advancementContinuation?: {
    readonly interruptedProxy: boolean;
  };
  /** 会话准则已生效；全局准则库沉淀独立进行。 */
  readonly rubricPublicationMessage?: string;
}

export interface AwaitingRubricConfirmationTurn {
  readonly kind: "awaiting-rubric-confirmation";
  readonly conversationId: string;
  readonly turnId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraft: SessionAwaitingRubricResult["rubricDraft"];
}

export interface ContractFailedTurn {
  readonly kind: "contract-failed";
  readonly conversationId: string;
  readonly turnId: string;
  readonly error: { readonly message: string };
}

export interface CancelledRubricTurn {
  readonly kind: "cancelled";
  readonly conversationId: string;
  readonly turnId: string;
  readonly advancementSessionId: string;
}

export type BeginUserTurnResult =
  | { readonly kind: "accepted"; readonly turn: AcceptedTurn }
  | AwaitingRubricConfirmationTurn
  | ContractFailedTurn
  | CancelledRubricTurn;

export type RubricContractCancelResult =
  | {
      readonly kind: "cancelled";
      readonly conversationId: string;
      readonly advancementSessionId: string;
    }
  | {
      readonly kind: "direct-execution";
      readonly advancementSessionId: string;
      readonly turn: AcceptedTurn;
    };

export interface BeginTurnOptions {
  readonly engage?: SessionSendEngage;
  readonly onAccepted?: (turn: {
    readonly conversationId: string;
    readonly turnId: string;
  }) => void;
}

export type ExitSceneResult =
  | { kind: "not-in-workscene"; active: ActiveConversation }
  | {
      kind: "returned";
      active: ActiveConversation;
      /** 返回的主对话有推进状态时携带——切换即呈现。 */
      advancement?: SessionAdvancementStateSnapshot;
    }
  | {
      kind: "fallback-latest" | "fallback-new";
      active: ActiveConversation;
      missingConversationId: string;
      advancement?: SessionAdvancementStateSnapshot;
    };

export type SetCurrentSceneWorkdirResult =
  | {
      kind: "reentered";
      active: ActiveConversation;
      scene: WorksceneSummary;
      advancement?: SessionAdvancementStateSnapshot;
    }
  | { kind: "scene-mismatch"; active: ActiveConversation }
  | { kind: "scene-missing"; active: ActiveConversation; error: unknown }
  | { kind: "set-failed"; active: ActiveConversation; error: unknown }
  | {
      kind: "enter-failed";
      active: ActiveConversation;
      scene: WorksceneSummary;
      error: unknown;
    };

export type SessionChangeReaction =
  | { kind: "ignored" }
  | { kind: "renamed"; name: string }
  | { kind: "cleared" }
  | { kind: "deleted" };

export interface ConversationControllerOptions {
  conversation: RpcConversationFacade;
  workscene: RpcWorksceneFacade;
  /** 主通道还原:当前对话的 AgentYield 流(渲染器 handleEvent 的喂入点) */
  onYield: (event: AgentYield) => void;
  /** 同一当前对话里,非本接入面发起的 turn 开始产出。 */
  onObservedTurnDelta?: (turn: ObservedTurnNotification) => void;
  onObservedInputs?: (turn: ObservedTurnNotification & AgentEventMap["agent:input_received"]) => void;
  /** 同一当前对话里,非本接入面发起的 turn 已落定。 */
  onObservedTurnComplete?: (turn: ObservedTurnNotification) => void;
  /** 非当前对话发生外部活动；只用于工作台提示或列表刷新，不携带内容。 */
  onActivity?: (activity: SessionActivityPayload) => void;
}

export interface InitialConversationSelection {
  active: ActiveConversation;
  resumedConversationName: string | null;
  /** 恢复对话的推进状态快照——awaiting 浮现与 active 提示的素材。 */
  advancement?: SessionAdvancementStateSnapshot;
  adoptionReview?: SessionAdoptionReviewResult;
}

export class ConversationContinuationDeclinedError extends Error {
  constructor() {
    super("已取消使用受限会话能力；完整能力恢复后可继续。");
    this.name = "ConversationContinuationDeclinedError";
  }
}

export interface ObservedTurnNotification {
  conversationId: string;
  turnId?: string;
}

interface DurableRunWatch {
  readonly conversationId: string;
  readonly turnId: string;
  statusRevision: number;
}

/** 由全域键派生模式视图;场景名后补(enter 响应 / list 查询) */
function deriveMode(
  conversationId: string,
  sceneName?: string,
): ActiveConversation["mode"] {
  const { scope } = parseConversationId(conversationId);
  if (scope.kind === "workscene") {
    return {
      kind: "workscene",
      sceneId: scope.sceneId,
      sceneName: sceneName ?? scope.sceneId,
    };
  }
  return { kind: "main" };
}

/**
 * REPL 启动恢复当前 main 指针。session.list 只是候选快照;多接入面下候选
 * 可能在 list 与 resume 之间被其它端删除,必须逐个 resumeIfExists 校验。
 * 工作场景不作为启动落点——它需要明确的进入/退出返回锚;全部 main 候选
 * 失效时新建主对话,而不是让启动失败。
 */
export async function selectInitialConversation(
  conversation: Pick<
    RpcConversationFacade,
    "list" | "resumeIfExists" | "newConversation"
  > &
    Partial<
      Pick<
        RpcConversationFacade,
        "pendingContinuationConfirmation" | "confirmContinuation"
      >
    >,
  options: {
    readonly confirmContinuation?: (
      unavailableCapabilities: readonly string[],
    ) => boolean | Promise<boolean>;
  } = {},
): Promise<InitialConversationSelection> {
  const candidates = await conversation.list();
  const unavailableCapabilities =
    conversation.pendingContinuationConfirmation?.() ?? null;
  if (unavailableCapabilities) {
    const accepted = await options.confirmContinuation?.(
      unavailableCapabilities,
    );
    if (accepted !== true) throw new ConversationContinuationDeclinedError();
    conversation.confirmContinuation?.();
  }
  for (const candidate of candidates) {
    if (!isMainConversationId(candidate.conversationId)) continue;
    const resumed = await conversation.resumeIfExists(candidate.conversationId);
    if (!resumed) continue;
    return {
      active: toActiveConversation(resumed),
      resumedConversationName: resumed.name,
      ...(resumed.advancement ? { advancement: resumed.advancement } : {}),
      ...(resumed.adoptionReview
        ? { adoptionReview: resumed.adoptionReview }
        : {}),
    };
  }

  const created = await conversation.newConversation();
  return {
    active: toActiveConversation(created),
    resumedConversationName: null,
  };
}

export class ConversationController {
  private active: ActiveConversation;
  private observedConversationId: string | null = null;
  /**
   * 进行中的切换目标谓词——切换型 RPC（resume / 进出场景）期间宿主会同步
   * 发出恢复期控制事件，通知帧先于 RPC 响应到达，而 current 要到响应后才
   * 切换；没有这个过渡窗口的放行，事件恒被「只看当前对话」的过滤丢弃。
   */
  private pendingSwitchTarget: ((conversationId: string) => boolean) | null =
    null;
  private readonly waiters = new Map<string, (outcome: TurnOutcome) => void>();
  private readonly pendingPostTurnControls = new Map<string, PostTurnControlOutcome>();
  private readonly localTurnsByConversation = new Map<string, string>();
  private readonly durableRuns = new Map<string, DurableRunWatch>();
  private readonly durableRunByTurn = new Map<string, string>();
  private readonly pendingFinals = new Map<string, FinalFrame>();
  private readonly finalRevisionByConversation = new Map<string, number>();
  private readonly pendingStatuses = new Map<string, ConversationStatusNotice>();
  private readonly finalLookups = new Map<string, Promise<void>>();
  private readonly continuationFinalLookups = new Map<string, Promise<void>>();
  private readonly continuationStatusLookups = new Map<string, Promise<void>>();
  private readonly observedContinuations = new Map<string, {
    conversationId: string;
    communication?: boolean;
    sequences: Map<string, number>;
    text: string;
    streamIncomplete?: boolean;
    settled: boolean;
    terminalInputsReconciled?: boolean;
  }>();
  private readonly pendingAbortByTurn = new Map<
    string,
    {
      readonly requestId: string;
      readonly promise: Promise<void>;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  private readonly localTurnAcceptances = new Map<
    string,
    (turn: { readonly conversationId: string; readonly turnId: string }) => void
  >();
  private readonly unsubscribes: Array<() => void>;
  private disposed = false;
  private readonly focusedTaskByConversation = new Map<string, string>();

  constructor(
    private readonly opts: ConversationControllerOptions,
    initial: ActiveConversation,
  ) {
    this.active = initial;
    this.unsubscribes = [
      opts.conversation.onAssignmentStream((frame) => this.consumeContinuationFrame(frame)),
      // 主通道:当前对话的产出流喂渲染(旁观帧同样可见——多端同看一个 turn)
      opts.conversation.onDelta((p) => {
        if (p.conversationId !== this.active.conversationId) return;
        const localTurnId = this.localTurnsByConversation.get(p.conversationId);
        if (localTurnId && p.turnId !== localTurnId) return;
        if (localTurnId && p.turnId === localTurnId) {
          this.markLocalTurnAccepted({
            conversationId: p.conversationId,
            turnId: p.turnId,
          });
        } else {
          this.opts.onObservedTurnDelta?.({
            conversationId: p.conversationId,
            turnId: p.turnId,
          });
        }
        this.opts.onYield(p.delta);
      }),
      // 控制意图:仅发起连接可达,先于 complete;暂存到 turn 落定统一消费
      opts.conversation.onPostTurnControlIntent((p) => {
        this.pendingPostTurnControls.set(p.turnId, {
          intent: p.intent,
          ...(p.conflict ? { conflict: p.conflict } : {}),
        });
      }),
      opts.conversation.onComplete((p) => {
        if (!this.waiters.has(p.turnId)) {
          if (
            p.conversationId === this.active.conversationId &&
            !this.isLocalTurn({
              conversationId: p.conversationId,
              turnId: p.turnId,
            })
          ) {
            this.opts.onObservedTurnComplete?.({
              conversationId: p.conversationId,
              turnId: p.turnId,
            });
          }
          return;
        }
        this.finishTurn(p.conversationId, p.turnId, p.result);
      }),
      opts.conversation.onFinal((frame) => {
        this.consumeFinal(frame);
      }),
      opts.conversation.onStatus((notice) => {
        this.consumeStatus(notice);
      }),
      opts.conversation.onActivity((p) => {
        if (p.conversationId === this.active.conversationId) return;
        this.opts.onActivity?.(p);
      }),
    ];
  }

  get current(): ActiveConversation {
    return this.active;
  }

  isLocalTurn(turn: ObservedTurnNotification): boolean {
    if (!turn.turnId) return false;
    return (
      this.localTurnsByConversation.get(turn.conversationId) === turn.turnId
    );
  }

  /** 启动当前指针对应的 observer 订阅。非活跃会话返回 false 时静默降级。 */
  async start(): Promise<void> {
    await this.subscribeActive();
  }

  /**
   * 宿主换代后服务端 observer 名册已重建,但 cli 当前指针不变。这里强制
   * 重挂当前对话 observer,保持 conversation 领域订阅由 controller 单点维护。
   */
  async reattachActiveObserver(): Promise<void> {
    this.observedConversationId = null;
    await this.subscribeActive();
    await this.reconcileDurableRuns();
  }

  /** 切当前对话指针(纯 UI 态变更,无宿主副作用)。 */
  setActive(next: ActiveConversation): void {
    this.active = next;
  }

  private async switchActive(next: ActiveConversation): Promise<void> {
    const prevObserved = this.observedConversationId;
    this.active = next;
    if (prevObserved && prevObserved !== next.conversationId) {
      await this.opts.conversation.unsubscribe(prevObserved).catch(() => {});
      this.observedConversationId = null;
    }
    await this.subscribeActive();
  }

  private async subscribeActive(): Promise<void> {
    if (this.observedConversationId === this.active.conversationId) return;
    const ok = await this.opts.conversation
      .subscribe(
        this.active.conversationId,
        this.finalRevisionByConversation.get(this.active.conversationId) ?? 0,
      )
      .catch(() => false);
    this.observedConversationId = ok ? this.active.conversationId : null;
  }

  // ─── turn 执行 ───

  /**
   * 发送一个 turn，宿主接受后返回 outcome waiter。turnId 与 complete waiter
   * 先于 send 挂上——loopback 下推送可能先于 request 响应到达,后挂必丢。
   * send 失败(BUSY / 宿主不可达)时撤 waiter 并原样抛出。
   */
  async beginTurn(
    input: string | UserTurnInput,
    options: BeginTurnOptions = {},
  ): Promise<AcceptedTurn> {
    const result = await this.beginUserTurn(input, options);
    if (result.kind === "accepted") return result.turn;
    throw new Error(
      `ConversationController: received control-plane result "${result.kind}" in beginTurn`,
    );
  }

  /**
   * 发送用户输入。普通执行返回 accepted turn；推进准则确认等控制面结果
   * 不等待 session.complete，由接入面继续承接。
   */
  async beginUserTurn(
    input: string | UserTurnInput,
    options: BeginTurnOptions = {},
  ): Promise<BeginUserTurnResult> {
    const target = this.active.conversationId;
    const turnId = generateTurnId();
    const outcome = this.attachTurnWaiter(target, turnId, options);
    try {
      const sendResult = options.engage
        ? await this.opts.conversation.send(input, target, turnId, {
            engage: options.engage,
          })
        : await this.opts.conversation.send(input, target, turnId);
      this.observedConversationId = target;
      if (isAwaitingRubricResult(sendResult)) {
        this.discardTurnWaiter(target, turnId);
        return {
          kind: "awaiting-rubric-confirmation",
          conversationId: sendResult.conversationId,
          turnId: sendResult.turnId,
          advancementSessionId: sendResult.advancementSessionId,
          rubricDraftId: sendResult.rubricDraftId,
          rubricDraft: sendResult.rubricDraft,
        };
      }
      if (isContractFailedResult(sendResult)) {
        this.discardTurnWaiter(target, turnId);
        return {
          kind: "contract-failed",
          conversationId: sendResult.conversationId,
          turnId: sendResult.turnId,
          error: sendResult.error,
        };
      }
      if (isCancelledRubricResult(sendResult)) {
        this.discardTurnWaiter(target, turnId);
        return {
          kind: "cancelled",
          conversationId: sendResult.conversationId,
          turnId: sendResult.turnId,
          advancementSessionId: sendResult.advancementSessionId,
        };
      }
      this.registerDurableRun(target, turnId, sendResult.runId);
      this.markLocalTurnAccepted({ conversationId: target, turnId });
      return {
        kind: "accepted",
        turn: {
          conversationId: target,
          turnId,
          ...(sendResult.runId ? { runId: sendResult.runId } : {}),
          outcome,
          ...(sendResult.advancementContinuation
            ? { advancementContinuation: sendResult.advancementContinuation }
            : {}),
        },
      };
    } catch (err) {
      this.discardTurnWaiter(target, turnId);
      throw err;
    }
  }

  /** 发送一个 turn 并等待落定。 */
  async sendTurn(input: string | UserTurnInput): Promise<TurnOutcome> {
    return (await this.beginTurn(input)).outcome;
  }

  async confirmRubricContract(
    pending: AwaitingRubricConfirmationTurn,
    options: BeginTurnOptions & {
      readonly rubricPersistence?: SessionRubricPersistenceChoice;
    } = {},
  ): Promise<AcceptedTurn> {
    const outcome = this.attachTurnWaiter(
      pending.conversationId,
      pending.turnId,
      options,
    );
    try {
      const result = await this.opts.conversation.confirmAdvancement(
        pending.conversationId,
        pending.advancementSessionId,
        pending.rubricDraftId,
        options.rubricPersistence,
      );
      if (result.turnId !== pending.turnId) {
        throw new Error(
          `ConversationController: advancement confirm returned unexpected turnId "${result.turnId}"`,
        );
      }
      this.observedConversationId = pending.conversationId;
      this.registerDurableRun(
        pending.conversationId,
        pending.turnId,
        result.runId,
      );
      this.markLocalTurnAccepted({
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        ...(result.runId ? { runId: result.runId } : {}),
      });
      return {
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        outcome,
        ...(result.rubricPublicationMessage
          ? { rubricPublicationMessage: result.rubricPublicationMessage }
          : {}),
      };
    } catch (err) {
      this.discardTurnWaiter(pending.conversationId, pending.turnId);
      throw err;
    }
  }

  async cancelRubricContract(
    pending: AwaitingRubricConfirmationTurn,
    opts: { executeOriginal?: boolean; onAccepted?: BeginTurnOptions["onAccepted"] } = {},
  ): Promise<RubricContractCancelResult> {
    const executeOriginal = opts.executeOriginal ?? false;
    const outcome = executeOriginal
      ? this.attachTurnWaiter(pending.conversationId, pending.turnId, {
          onAccepted: opts.onAccepted,
        })
      : null;
    try {
      const result = await this.opts.conversation.cancelAdvancement(
        pending.conversationId,
        pending.advancementSessionId,
        { executeOriginal },
      );
      if (isDirectExecutionCancelResult(result)) {
        if (!outcome) {
          throw new Error(
            "ConversationController: direct execution returned without an attached turn waiter",
          );
        }
        if (result.turnId !== pending.turnId) {
          throw new Error(
            `ConversationController: advancement cancel returned unexpected turnId "${result.turnId}"`,
          );
        }
        this.observedConversationId = pending.conversationId;
        this.registerDurableRun(
          pending.conversationId,
          pending.turnId,
          result.runId,
        );
        this.markLocalTurnAccepted({
          conversationId: pending.conversationId,
          turnId: pending.turnId,
        });
        return {
          kind: "direct-execution",
          advancementSessionId: result.advancementSessionId,
          turn: {
            conversationId: pending.conversationId,
            turnId: pending.turnId,
            ...(result.runId ? { runId: result.runId } : {}),
            outcome,
          },
        };
      }
      if (outcome) {
        this.discardTurnWaiter(pending.conversationId, pending.turnId);
      }
      return {
        kind: "cancelled",
        conversationId: result.conversationId,
        advancementSessionId: result.advancementSessionId,
      };
    } catch (err) {
      if (outcome) {
        this.discardTurnWaiter(pending.conversationId, pending.turnId);
      }
      throw err;
    }
  }

  async reviseRubricContract(
    pending: AwaitingRubricConfirmationTurn,
    userFeedback: string,
  ): Promise<AwaitingRubricConfirmationTurn> {
    const result = await this.opts.conversation.reviseAdvancement(
      pending.conversationId,
      pending.advancementSessionId,
      userFeedback,
    );
    if (result.conversationId !== pending.conversationId) {
      throw new Error(
        `ConversationController: advancement revise returned unexpected conversationId "${result.conversationId}"`,
      );
    }
    if (result.advancementSessionId !== pending.advancementSessionId) {
      throw new Error(
        `ConversationController: advancement revise returned unexpected advancementSessionId "${result.advancementSessionId}"`,
      );
    }
    if (result.rubricDraft.originalTurnId !== pending.turnId) {
      throw new Error(
        `ConversationController: advancement revise returned unexpected turnId "${result.rubricDraft.originalTurnId}"`,
      );
    }
    if (result.rubricDraftId !== result.rubricDraft.draftId) {
      throw new Error(
        `ConversationController: advancement revise returned inconsistent rubricDraftId "${result.rubricDraftId}"`,
      );
    }
    return {
      kind: "awaiting-rubric-confirmation",
      conversationId: result.conversationId,
      turnId: result.rubricDraft.originalTurnId,
      advancementSessionId: result.advancementSessionId,
      rubricDraftId: result.rubricDraftId,
      rubricDraft: result.rubricDraft,
    };
  }

  private attachTurnWaiter(
    conversationId: string,
    turnId: string,
    options: BeginTurnOptions = {},
  ): Promise<TurnOutcome> {
    const outcome = new Promise<TurnOutcome>((resolve) => {
      this.waiters.set(turnId, resolve);
    });
    this.localTurnsByConversation.set(conversationId, turnId);
    if (options.onAccepted) {
      this.localTurnAcceptances.set(turnId, options.onAccepted);
    }
    return outcome;
  }

  private discardTurnWaiter(conversationId: string, turnId: string): void {
    this.waiters.delete(turnId);
    this.pendingPostTurnControls.delete(turnId);
    this.localTurnAcceptances.delete(turnId);
    this.resolvePendingAbort(turnId);
    if (this.localTurnsByConversation.get(conversationId) === turnId) {
      this.localTurnsByConversation.delete(conversationId);
    }
    this.releaseDurableRun(turnId);
  }

  private resolvePendingAbort(turnId: string): void {
    const pendingAbort = this.pendingAbortByTurn.get(turnId);
    if (!pendingAbort) return;
    this.pendingAbortByTurn.delete(turnId);
    pendingAbort.resolve();
  }

  private markLocalTurnAccepted(turn: {
    readonly conversationId: string;
    readonly turnId: string;
  }): void {
    const accept = this.localTurnAcceptances.get(turn.turnId);
    if (!accept) return;
    this.localTurnAcceptances.delete(turn.turnId);
    accept(turn);
  }

  private finishTurn(
    conversationId: string,
    turnId: string,
    result: WireAgentResult,
  ): void {
    const waiter = this.waiters.get(turnId);
    if (!waiter) return;
    this.waiters.delete(turnId);
    const intent = this.pendingPostTurnControls.get(turnId);
    this.pendingPostTurnControls.delete(turnId);
    if (this.localTurnsByConversation.get(conversationId) === turnId) {
      this.localTurnsByConversation.delete(conversationId);
    }
    this.markLocalTurnAccepted({ conversationId, turnId });
    this.resolvePendingAbort(turnId);
    if (intent?.intent.handoff?.remaining.length) {
      const runId = this.durableRunByTurn.get(turnId);
      if (runId) this.focusedTaskByConversation.set(conversationId, runId);
    }
    const runId = this.durableRunByTurn.get(turnId);
    if (runId && (result.reason === "aborted" || result.reason === "error")) {
      // 本地 waiter 已负责终态展示，重复状态不能再进入旁观展示。
      rememberBounded(this.observedContinuations, runId, { conversationId, sequences: new Map(), text: "", settled: true });
    }
    this.releaseDurableRun(turnId);
    waiter({ result, postTurnControl: intent });
  }

  private registerDurableRun(
    conversationId: string,
    turnId: string,
    runId: string | undefined,
  ): void {
    const pendingAbort = this.pendingAbortByTurn.get(turnId);
    if (pendingAbort) {
      this.pendingAbortByTurn.delete(turnId);
      void this.opts.conversation
        .abort(conversationId, pendingAbort.requestId, runId)
        .then(pendingAbort.resolve, pendingAbort.reject);
    }
    if (!runId || !this.waiters.has(turnId)) return;
    this.durableRuns.set(runId, {
      conversationId,
      turnId,
      statusRevision: 0,
    });
    this.durableRunByTurn.set(turnId, runId);
    const status = this.pendingStatuses.get(runId);
    if (status) {
      this.pendingStatuses.delete(runId);
      this.consumeStatus(status);
    }
    const frame = this.pendingFinals.get(runId);
    if (frame) {
      this.pendingFinals.delete(runId);
      this.consumeFinal(frame);
    }
    void this.reconcileDurableRun(runId).catch(() => {});
  }

  private releaseDurableRun(turnId: string): void {
    const runId = this.durableRunByTurn.get(turnId);
    if (!runId) return;
    this.durableRunByTurn.delete(turnId);
    this.durableRuns.delete(runId);
    this.pendingFinals.delete(runId);
    this.pendingStatuses.delete(runId);
  }

  private consumeFinal(frame: FinalFrame): void {
    const seen = this.finalRevisionByConversation.get(frame.conversationId) ?? 0;
    if (frame.commitRevision > seen) {
      this.finalRevisionByConversation.set(frame.conversationId, frame.commitRevision);
    }
    const watch = this.durableRuns.get(frame.runId);
    if (!watch) {
      const observed = this.observedContinuations.get(frame.runId);
      if (this.active.conversationId === frame.conversationId && !observed?.settled) {
        if (!this.continuationFinalLookups.has(frame.runId)) {
          const lookup = this.presentContinuationFinal(frame).finally(() => {
            if (this.continuationFinalLookups.get(frame.runId) === lookup) this.continuationFinalLookups.delete(frame.runId);
          });
          this.continuationFinalLookups.set(frame.runId, lookup);
          void lookup.catch(() => {});
        }
      }
      if (this.active.conversationId === frame.conversationId || this.localTurnsByConversation.has(frame.conversationId)) {
        rememberBounded(this.pendingFinals, frame.runId, frame);
      }
      return;
    }
    if (watch.conversationId !== frame.conversationId) return;
    this.startFinalLookup(frame.runId);
  }

  private consumeStatus(notice: ConversationStatusNotice): void {
    const runId = notice.ref.runId;
    const watch = this.durableRuns.get(runId);
    if (!watch) {
      if (notice.ref.conversationId !== this.active.conversationId && !this.localTurnsByConversation.has(notice.ref.conversationId)) return;
      const prior = this.pendingStatuses.get(runId);
      if (prior && prior.statusRevision > notice.statusRevision) return;
      rememberBounded(this.pendingStatuses, runId, notice);
      const observed = this.observedContinuations.get(runId);
      const result = terminalResultForStatus(notice);
      if (result && notice.ref.conversationId === this.active.conversationId) {
        if (observed && !observed.communication) {
          this.finishObservedStatus(notice);
        }
        this.startTerminalInputLookup(notice);
      }
      return;
    }
    if (
      watch.conversationId !== notice.ref.conversationId ||
      notice.statusRevision <= watch.statusRevision
    ) {
      return;
    }
    watch.statusRevision = notice.statusRevision;
    const result = terminalResultForStatus(notice);
    if (result) {
      this.finishTurn(watch.conversationId, watch.turnId, result);
      // waiter 收束与追加来信的来源补绘相互独立。
      rememberBounded(this.pendingStatuses, runId, notice);
      this.startTerminalInputLookup(notice);
      return;
    }
    if (
      notice.state === "uncertain-closed" &&
      notice.resultingState === "committed"
    ) {
      this.startFinalLookup(runId);
    }
  }

  private startFinalLookup(runId: string): void {
    if (this.finalLookups.has(runId)) return;
    const lookup = this.retryCommittedRunLookup(runId).finally(() => {
      if (this.finalLookups.get(runId) === lookup) {
        this.finalLookups.delete(runId);
      }
    });
    this.finalLookups.set(runId, lookup);
    void lookup.catch(() => {});
  }

  private finishObservedStatus(notice: ConversationStatusNotice): void {
    const observed = this.observedContinuations.get(notice.ref.runId);
    const result = terminalResultForStatus(notice);
    if (!observed || observed.settled || !result || observed.conversationId !== this.active.conversationId) return;
    observed.settled = true;
    const identity = { conversationId: observed.conversationId, turnId: notice.ref.runId };
    this.opts.onObservedTurnDelta?.(identity);
    const label = observed.communication ? "来信处理" : "任务续接";
    this.opts.onYield({ type: "text_delta", text: result.reason === "error" ? `\n${label}未完成：${result.error.message}\n` : `\n${label}已停止。\n` });
    this.opts.onObservedTurnComplete?.(identity);
  }

  private startTerminalInputLookup(notice: ConversationStatusNotice): void {
    const runId = notice.ref.runId;
    if (notice.ref.conversationId !== this.active.conversationId || this.observedContinuations.get(runId)?.terminalInputsReconciled || this.continuationStatusLookups.has(runId)) return;
    const lookup = this.presentTerminalInputs(notice.ref.conversationId, runId).finally(() => {
      if (this.continuationStatusLookups.get(runId) === lookup) this.continuationStatusLookups.delete(runId);
    });
    this.continuationStatusLookups.set(runId, lookup);
    void lookup.catch(() => {});
  }

  /** 失败/取消没有成功 Final；任何起因的 Run 都可能包含追加来信。 */
  private async presentTerminalInputs(conversationId: string, runId: string): Promise<void> {
    let delayMs = 25;
    while (!this.disposed && this.active.conversationId === conversationId) {
      const notice = this.pendingStatuses.get(runId);
      if (!notice || !terminalResultForStatus(notice) || this.observedContinuations.get(runId)?.terminalInputsReconciled) return;
      try {
        const page = await this.opts.conversation.history(conversationId, { limit: 1 });
        if (this.disposed || this.active.conversationId !== conversationId) return;
        if (this.pendingStatuses.get(runId)?.statusRevision !== notice.statusRevision) continue;
        const messages = (page.inputsOutsideHistory ?? []).filter(input => input.runId === runId).map(input => input.message);
        let observed = this.observedContinuations.get(runId);
        this.presentRecordedInputs(conversationId, runId, messages);
        if (!observed) {
          const communication = messages.some(message => message.inputIdentity?.source.kind === "conversation");
          observed = { conversationId, communication, sequences: new Map(), text: "", settled: !communication };
          rememberBounded(this.observedContinuations, runId, observed);
        }
        observed.terminalInputsReconciled = true;
        this.finishObservedStatus(notice);
        return;
      } catch {
        // 状态仍保留；短暂读取失败不丢终态，也不放行迟到输出。
      }
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1000);
    }
  }

  /** Automatically admitted work has no local send waiter or legacy delta producer. */
  private consumeContinuationFrame(frame: StreamFrame): void {
    const communication = frame.meta.turnOrigin?.messageIdentity?.source.kind === "conversation";
    if (frame.ref.execution !== "conversation") return;
    if (frame.ref.conversationId !== this.active.conversationId) return;
    if (frame.payload.kind === "agent-event" && "event" in frame.payload.event) {
      const event = frame.payload.event;
      if (event.event === "agent:input_received") {
        this.opts.onObservedInputs?.({ conversationId: frame.ref.conversationId, turnId: frame.ref.runId, ...event.payload });
      } else if (event.event === "agent:run_start" && communication) {
        this.opts.onObservedInputs?.({ conversationId: frame.ref.conversationId, turnId: frame.ref.runId, inputs: [{ text: event.payload.prompt, identity: frame.meta.turnOrigin!.messageIdentity! }] });
      }
    }
    if (!frame.meta.turnOrigin?.worksceneContinuation && !communication) return;
    let observed = this.observedContinuations.get(frame.ref.runId);
    if (!observed) {
      observed = { conversationId: frame.ref.conversationId, communication, sequences: new Map(), text: "", settled: false };
      rememberBounded(this.observedContinuations, frame.ref.runId, observed);
    }
    const status = this.pendingStatuses.get(frame.ref.runId);
    if (status && terminalResultForStatus(status)) {
      this.consumeStatus(status);
      return;
    }
    // Final delivery and assignment streaming can arrive in either order.
    const final = this.pendingFinals.get(frame.ref.runId);
    if (final) {
      this.consumeFinal(final);
      return;
    }
    const sequenceKey = `${frame.assignmentId}:${frame.streamEpoch}`;
    const previousSeq = observed.sequences.get(sequenceKey) ?? 0;
    if (observed.settled || frame.seq <= previousSeq) return;
    // A reference, missing frame or replacement stream breaks the displayable prefix.
    // Keep only its contiguous prefix and let the committed history supply the rest.
    if (frame.seq !== previousSeq + 1 || (observed.sequences.size > 0 && !observed.sequences.has(sequenceKey))) observed.streamIncomplete = true;
    observed.sequences.set(sequenceKey, frame.seq);
    if (observed.streamIncomplete) return;
    if (frame.payload.kind !== "agent-yield") return;
    if ("ref" in frame.payload.yield) {
      observed.streamIncomplete = true;
      return;
    }
    const delta = frame.payload.yield;
    if (delta.type === "text_delta") observed.text += delta.text;
    // Only the final assistant segment can be a prefix of the committed answer.
    if (delta.type === "tool_start") observed.text = "";
    this.opts.onObservedTurnDelta?.({ conversationId: observed.conversationId, turnId: frame.ref.runId });
    this.opts.onYield(delta);
  }

  private async presentContinuationFinal(frame: FinalFrame): Promise<void> {
    let before: { shardId: string; runIndex: number } | undefined;
    let delayMs = 25;
    while (!this.disposed && this.active.conversationId === frame.conversationId) {
      try {
        const page = await this.opts.conversation.history(frame.conversationId, {
          limit: 200, ...(before ? { before } : {}),
        });
        const match = page.runs.find((item) => "runId" in item.record && item.record.runId === frame.runId);
        let observed = this.observedContinuations.get(frame.runId);
        if (this.active.conversationId !== frame.conversationId || observed?.settled) return;
        if (match) {
          this.presentRecordedInputs(frame.conversationId, frame.runId, match.record.messages);
          const communication = match.record.messages[0]?.inputIdentity?.source.kind === "conversation";
          if (!observed && !match.record.worksceneContinuation && !communication) return;
          if (!observed) {
            observed = { conversationId: frame.conversationId, communication, sequences: new Map(), text: "", settled: false };
            rememberBounded(this.observedContinuations, frame.runId, observed);
          }
          observed.settled = true;
          const message = finalAssistantMessageOf(match.record.messages);
          const text = message?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          const remaining = text?.startsWith(observed.text) ? text.slice(observed.text.length) : text;
          if (remaining) {
            this.opts.onObservedTurnDelta?.({ conversationId: frame.conversationId, turnId: frame.runId });
            this.opts.onYield({ type: "text_delta", text: remaining });
          }
          this.opts.onObservedTurnComplete?.({ conversationId: frame.conversationId, turnId: frame.runId });
          return;
        }
        const last = page.runs.at(-1);
        if (page.hasMore && last) {
          before = { shardId: last.shardId, runIndex: last.record.runIndex };
          continue;
        }
      } catch {
        // A committed result may outlive a transient history projection/link failure.
      }
      before = undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }

  private presentRecordedInputs(conversationId: string, runId: string, messages: readonly Message[]): void {
    if (conversationId !== this.active.conversationId) return;
    const inputs = messages.flatMap(message => message.inputIdentity?.source.kind === "conversation"
      ? [{ text: extractText(message), identity: message.inputIdentity }] : []);
    if (inputs.length) this.opts.onObservedInputs?.({ conversationId, turnId: runId, inputs });
  }

  private async retryCommittedRunLookup(runId: string): Promise<void> {
    const watch = this.durableRuns.get(runId);
    if (!watch) return;
    let delayMs = 25;
    while (this.durableRuns.get(runId) === watch) {
      try {
        if (await this.resolveCommittedRun(runId)) return;
      } catch {
        // History is a rebuildable projection. Final/status wakeups and this
        // bounded backoff converge after transient projection or link failure.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }

  private async resolveCommittedRun(runId: string): Promise<boolean> {
    const watch = this.durableRuns.get(runId);
    if (!watch) return false;
    let before: { shardId: string; runIndex: number } | undefined;
    while (this.durableRuns.get(runId) === watch) {
      const page = await this.opts.conversation.history(watch.conversationId, {
        limit: 200,
        ...(before ? { before } : {}),
      });
      const match = page.runs.find(
        (item) => "runId" in item.record && item.record.runId === runId,
      );
      if (match) {
        this.presentRecordedInputs(watch.conversationId, runId, match.record.messages);
        if (match.record.postTurnControl) {
          this.pendingPostTurnControls.set(watch.turnId, match.record.postTurnControl);
        }
        this.finishTurn(watch.conversationId, watch.turnId, {
          reason: "completed",
          message: finalAssistantMessageOf(match.record.messages),
          usage: match.record.usage ?? { inputTokens: 0, outputTokens: 0 },
        });
        return true;
      }
      const last = page.runs.at(-1);
      if (!page.hasMore || !last) return false;
      before = { shardId: last.shardId, runIndex: last.record.runIndex };
    }
    return false;
  }

  private async reconcileDurableRuns(): Promise<void> {
    const watches = [...this.durableRuns.entries()];
    for (let offset = 0; offset < watches.length; offset += 64) {
      const batch = watches.slice(offset, offset + 64);
      let cursors = batch.map(([runId, watch]) => ({
        conversationId: watch.conversationId,
        runId,
        afterStatusRevision: watch.statusRevision,
      }));
      while (cursors.length > 0) {
        const history = await this.opts.conversation.statusHistory(cursors);
        for (const notice of history.notices) this.consumeStatus(notice);
        cursors = history.next.map((cursor) => ({ ...cursor }));
      }
    }
    await Promise.all(
      [...this.durableRuns.keys()].map((runId) => this.resolveCommittedRun(runId)),
    );
  }

  private async reconcileDurableRun(runId: string): Promise<void> {
    const watch = this.durableRuns.get(runId);
    if (!watch) return;
    let cursors = [
      {
        conversationId: watch.conversationId,
        runId,
        afterStatusRevision: watch.statusRevision,
      },
    ];
    while (cursors.length > 0 && this.durableRuns.get(runId) === watch) {
      const history = await this.opts.conversation.statusHistory(cursors);
      for (const notice of history.notices) this.consumeStatus(notice);
      cursors = history.next.map((cursor) => ({ ...cursor }));
    }
    if (this.durableRuns.get(runId) === watch) this.startFinalLookup(runId);
  }

  /** 打断当前对话的 in-flight turn——complete 随宿主 cleanup 自然到达。 */
  async abort(): Promise<void> {
    const turnId = this.localTurnsByConversation.get(this.active.conversationId);
    if (!turnId) { await this.abortBackgroundTask(); return; }
    const runId = this.durableRunByTurn.get(turnId);
    const requestId = `cancel:${generateTurnId()}`;
    if (runId) {
      await this.opts.conversation.abort(
        this.active.conversationId,
        requestId,
        runId,
      );
      return;
    }
    const existing = this.pendingAbortByTurn.get(turnId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pendingAbortByTurn.set(turnId, { requestId, promise, resolve, reject });
    return promise;
  }

  /** 无本地 waiter 时也从当前对话权威事实定位运行；不依赖是否见过实时帧。 */
  async abortBackgroundTask(): Promise<boolean> {
    const conversationId = this.active.conversationId;
    const page = await this.opts.conversation.history(conversationId, { limit: 1 });
    if (this.active.conversationId !== conversationId) return false;
    const runs = new Map((page.inputsOutsideHistory ?? [])
      .filter(input => input.message.inputIdentity?.source.kind === "conversation" &&
        ["queued", "dispatched", "running", "cancel-requested"].includes(input.state))
      .map(input => [input.runId, input]));
    const current = [...runs.values()].filter(input => input.state !== "queued");
    const candidates = current.length ? current : [...runs.values()];
    if (candidates.length > 1) throw new Error("当前对话有多个待处理运行，无法确定停止目标；未取消任何运行。");
    if (candidates[0]) {
      await this.opts.conversation.abort(conversationId, `cancel:${generateTurnId()}`, candidates[0].runId);
      return true;
    }
    return this.abortWorksceneTask();
  }

  /** Resolve current entrusted work from owner facts even without a local send waiter or stream. */
  async abortWorksceneTask(): Promise<boolean> {
    const conversationId = this.active.conversationId;
    const tasks = await this.opts.workscene.tasks(conversationId);
    if (!tasks.length || this.active.conversationId !== conversationId) return false;
    const focused = tasks.find((task) => task.runId === this.focusedTaskByConversation.get(conversationId));
    const target = focused ?? (tasks.length === 1 ? tasks[0] : undefined);
    if (!target) throw new Error("当前对话有多项委托，请说明要停止哪一项；未取消任何任务。");
    await this.opts.workscene.stopTask(conversationId, target, `stop-task:${generateTurnId()}`);
    this.focusedTaskByConversation.delete(conversationId);
    return true;
  }

  // ─── 会话命令执行体(分发在 cli、执行在宿主) ───

  async listConversations(): Promise<SessionConversationEntry[]> {
    return this.opts.conversation.list();
  }

  async history(
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<RunsPage> {
    return this.opts.conversation.history(conversationId, opts);
  }

  /** 建新对话并切过去。 */
  async newConversation(): Promise<ActiveConversation> {
    const created = await this.opts.conversation.newConversation();
    await this.switchActive({
      conversationId: created.conversationId,
      name: created.name,
      mode: { kind: "main" },
    });
    return this.active;
  }

  async rename(name: string): Promise<void> {
    const renamed = await this.opts.conversation.rename(
      this.active.conversationId,
      name,
    );
    this.active = { ...this.active, name: renamed.name };
  }

  async clear(): Promise<void> {
    await this.opts.conversation.clear(this.active.conversationId);
  }

  async compact(): Promise<SessionCompactResult> {
    return this.opts.conversation.compact(this.active.conversationId);
  }

  /** 当前对话的上下文预算视图(/usage /context)。 */
  async contextBudget(): Promise<SessionContextBudgetResult> {
    return this.opts.conversation.contextBudget(this.active.conversationId);
  }

  /** 当前对话的完整用量视图(/usage)。 */
  async usage(): Promise<SessionUsageResult> {
    return this.opts.conversation.usage(this.active.conversationId);
  }

  /**
   * 接入面正在看 / 即将看的对话——带外事件（run scope 与推进控制面）的
   * 过滤谓词。切换型 RPC 期间目标对话的事件同样放行，恢复期知情不丢。
   */
  isWatching(conversationId: string): boolean {
    return (
      conversationId === this.active.conversationId ||
      (this.pendingSwitchTarget?.(conversationId) ?? false)
    );
  }

  /** 切换到既有对话(宿主 touch + 返回 meta),指针随之移动。 */
  async resume(conversationId: string): Promise<{
    active: ActiveConversation;
    advancement?: SessionAdvancementStateSnapshot;
    adoptionReview?: SessionAdoptionReviewResult;
  }> {
    this.pendingSwitchTarget = (id) => id === conversationId;
    try {
      const resumed = await this.opts.conversation.resume(conversationId);
      await this.switchActive(toActiveConversation(resumed));
      return {
        active: this.active,
        ...(resumed.advancement ? { advancement: resumed.advancement } : {}),
        ...(resumed.adoptionReview
          ? { adoptionReview: resumed.adoptionReview }
          : {}),
      };
    } finally {
      this.pendingSwitchTarget = null;
    }
  }

  /** /advancement 的数据面：当前对话的推进详情（宿主随查随算）。 */
  async advancementDetail(): Promise<SessionAdvancementDetailResult> {
    return await this.opts.conversation.advancementDetail(
      this.active.conversationId,
    );
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.opts.conversation.delete(conversationId);
    if (this.observedConversationId === conversationId) {
      this.observedConversationId = null;
    }
  }

  // ─── 工作场景(进出 = 宿主取建对话 + 指针切换) ───

  async enterScene(sceneId: string): Promise<{
    active: ActiveConversation;
    advancement?: SessionAdvancementStateSnapshot;
  }> {
    // 目标对话 id 由宿主 enter 决定，切换期以场景全域键前缀放行
    this.pendingSwitchTarget = (id) =>
      id.startsWith(`${WORKSCENE_CONVERSATION_PREFIX}${sceneId}:`);
    try {
      const entered = await this.opts.workscene.enter(sceneId);
      await this.switchActive({
        conversationId: entered.conversationId,
        name: entered.scene.name,
        mode: deriveMode(entered.conversationId, entered.scene.name),
      });
      return {
        active: this.active,
        ...(entered.advancement ? { advancement: entered.advancement } : {}),
      };
    } finally {
      this.pendingSwitchTarget = null;
    }
  }

  /**
   * 场景内更换 / 解绑工作目录的 turn 边界事务。
   *
   * 先撤当前 observer,让服务层 quiesce 的 in-use 守卫看到真实空闲;落盘成功后
   * 重新 enter 同一场景,新 runtime 按新目录装配。set 失败时重挂原 observer,
   * enter 失败交给接入面按退出 fallback 处理。
   */
  async setCurrentSceneWorkdirAndReenter(
    sceneId: string,
    workspace: { deviceId: string; bindingRef: string } | null,
  ): Promise<SetCurrentSceneWorkdirResult> {
    if (
      this.active.mode.kind !== "workscene" ||
      this.active.mode.sceneId !== sceneId
    ) {
      return { kind: "scene-mismatch", active: this.active };
    }

    const previousConversationId = this.active.conversationId;
    if (this.observedConversationId === previousConversationId) {
      await this.opts.conversation.unsubscribe(previousConversationId).catch(() => {});
      this.observedConversationId = null;
    }

    let scene: WorksceneSummary;
    try {
      scene = await this.opts.workscene.setWorkdir(sceneId, workspace);
    } catch (error) {
      if (isRpcNotFound(error)) {
        return { kind: "scene-missing", active: this.active, error };
      }
      await this.subscribeActive();
      return { kind: "set-failed", active: this.active, error };
    }

    try {
      const entered = await this.enterScene(sceneId);
      return {
        kind: "reentered",
        active: entered.active,
        scene,
        ...(entered.advancement ? { advancement: entered.advancement } : {}),
      };
    } catch (error) {
      return { kind: "enter-failed", active: this.active, scene, error };
    }
  }

  /**
   * 退出场景:宿主 touch + 指针切回一个真实存在的 main 对话。
   *
   * mainTarget 是接入面本地保存的"进场前主对话"指针;多接入面下它可能
   * 在场景期间被其它端删除。退出时必须重新经宿主 resume 校验,不可把
   * 悬挂 id 写回 active。目标不存在时按产品语义降级到最近 main 对话,
   * 再无则新建 main 对话。
   */
  async exitScene(mainTarget: ActiveConversation): Promise<ExitSceneResult> {
    if (this.active.mode.kind !== "workscene") {
      return { kind: "not-in-workscene", active: this.active };
    }
    try {
      return await this.exitSceneInner(this.active.mode.sceneId, mainTarget);
    } finally {
      this.pendingSwitchTarget = null;
    }
  }

  private async exitSceneInner(
    sceneId: string,
    mainTarget: ActiveConversation,
  ): Promise<ExitSceneResult> {
    const leavingConversationId = this.active.conversationId;
    if (this.observedConversationId === leavingConversationId) {
      await this.opts.conversation
        .unsubscribe(leavingConversationId)
        .catch(() => {});
      this.observedConversationId = null;
    }
    await this.opts.workscene.exit(sceneId, leavingConversationId);
    // 目标可能从 mainTarget 逐级降级到候选——每次 resume 前把切换窗口
    // 收敛到当次精确目标，不按整个 main 域放行。
    const resolved = await resolveWorksceneMainReturn(mainTarget.conversationId, {
      resume: (conversationId) => {
        this.pendingSwitchTarget = (id) => id === conversationId;
        return this.opts.conversation.resumeIfExists(conversationId);
      },
      list: () => this.opts.conversation.list(),
      create: () => this.opts.conversation.newConversation(),
    });
    await this.switchActive(toMainActive(resolved.conversation));
    if (resolved.kind === "returned") return {
      kind: "returned", active: this.active,
      ...(resolved.conversation.advancement ? { advancement: resolved.conversation.advancement } : {}),
    };
    return {
      kind: resolved.kind,
      active: this.active,
      missingConversationId: mainTarget.conversationId,
      ...(resolved.kind !== "fallback-new" && resolved.conversation.advancement ? { advancement: resolved.conversation.advancement } : {}),
    };
  }

  /**
   * 消费宿主会话级变更通知。taskList 属独立只读视图,由 repl 的 TaskListViewCache
   * 处理；这里仅维护当前对话指针本身。
   */
  applySessionChanged(payload: SessionChangedPayload): SessionChangeReaction {
    if (payload.conversationId !== this.active.conversationId) {
      return { kind: "ignored" };
    }
    if (payload.change === "taskList") {
      return { kind: "ignored" };
    }
    if (payload.change === "renamed") {
      this.active = { ...this.active, name: payload.name };
      return { kind: "renamed", name: payload.name };
    }
    if (payload.change === "cleared") {
      return { kind: "cleared" };
    }
    return { kind: "deleted" };
  }

  async listScenes(): Promise<WorksceneSummary[]> {
    return this.opts.workscene.list();
  }

  dispose(): void {
    this.disposed = true;
    this.observedContinuations.clear();
    for (const unsub of this.unsubscribes) unsub();
    for (const turnId of this.pendingAbortByTurn.keys()) {
      this.resolvePendingAbort(turnId);
    }
    this.waiters.clear();
    this.pendingPostTurnControls.clear();
    this.localTurnsByConversation.clear();
    this.durableRuns.clear();
    this.durableRunByTurn.clear();
    this.pendingFinals.clear();
    this.finalRevisionByConversation.clear();
    this.pendingStatuses.clear();
    this.finalLookups.clear();
    this.continuationFinalLookups.clear();
    this.continuationStatusLookups.clear();
    this.observedConversationId = null;
  }
}

function terminalResultForStatus(
  notice: ConversationStatusNotice,
): WireAgentResult | undefined {
  const resultingState =
    notice.state === "uncertain-closed" ? notice.resultingState : notice.state;
  if (resultingState === "cancelled") {
    return {
      reason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  if (resultingState === "failed" || resultingState === "expired") {
    return {
      reason: "error",
      error: {
        name: resultingState === "expired" ? "RunExpired" : "RunFailed",
        message: notice.reason ?? `Conversation run ${resultingState}`,
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
  return undefined;
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size <= 64) return;
  const oldest = map.keys().next().value as K | undefined;
  if (oldest !== undefined) map.delete(oldest);
}

function isRpcNotFound(error: unknown): error is RpcClientError {
  return (
    error instanceof RpcClientError &&
    error.code === RPC_ERROR_CODES.NOT_FOUND
  );
}

function toMainActive(input: {
  conversationId: string;
  name: string;
}): ActiveConversation {
  return {
    conversationId: input.conversationId,
    name: input.name,
    mode: { kind: "main" },
  };
}

function toActiveConversation(input: {
  conversationId: string;
  name: string;
}): ActiveConversation {
  return {
    conversationId: input.conversationId,
    name: input.name,
    mode: deriveMode(input.conversationId),
  };
}

function isMainConversationId(conversationId: string): boolean {
  return parseConversationId(conversationId).scope.kind === "user";
}

function isAwaitingRubricResult(
  result: SessionSendResult,
): result is SessionAwaitingRubricResult {
  return (
    "status" in result &&
    result.status === "awaiting-rubric-confirmation"
  );
}

function isContractFailedResult(
  result: SessionSendResult,
): result is SessionContractFailedResult {
  return "status" in result && result.status === "contract-failed";
}

function isCancelledRubricResult(
  result: SessionSendResult,
): result is SessionCancelledRubricResult {
  return "status" in result && result.status === "cancelled";
}

function isDirectExecutionCancelResult(
  result: SessionAdvancementCancelResult,
): result is Extract<SessionAdvancementCancelResult, { status: "direct-execution" }> {
  return result.status === "direct-execution";
}
