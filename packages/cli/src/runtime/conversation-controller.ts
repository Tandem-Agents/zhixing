/**
 * ConversationController —— repl 的会话域控制器(纯接入面形态)。
 *
 * cli 收编后会话状态的唯一权威在核心宿主(窗口 / turnCounter / 持久化全在
 * 宿主侧),cli 持有的只是**当前对话指针**与围绕它的 RPC 编排:
 *
 * - sendTurn:预分配 turnId → send 入队 → 等待该 turn 的 complete 通知
 *   (turn 落定)→ 带出
 *   暂存的模式切换意图(intent 先于 complete 定向到达,turn 边界统一消费,
 *   与 REPL 原有消费语义对齐);
 * - 主通道喂渲染:delta 通知按当前对话过滤后经 onYield 回调交给渲染器——
 *   主渲染管线一行不改;
 * - abort:打断当前对话的 in-flight turn(宿主侧 abort,complete 随 cleanup
 *   自然到达);
 * - 指针操作:new / resume / clear / rename / compact / 场景 enter·exit 组合
 *   facade 调用与指针维护;"当前在哪个对话 / 场景"是接入面 UI 态,宿主零知识,
 *   模式视图由对话全域键纯函数派生。
 */

import {
  generateTurnId,
  parseConversationId,
  type AgentYield,
  type UserTurnInput,
  type WorkModeSwitchIntent,
} from "@zhixing/core";
import type {
  RunsPage,
  SessionCompactResult,
  SessionContextBudgetResult,
  SessionChangedPayload,
  SessionActivityPayload,
  SessionConversationEntry,
  SessionUsageResult,
  WireAgentResult,
  WorksceneSummary,
} from "@zhixing/server";
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
  /** turn 内 LLM 产生的模式切换意图(定向通知暂存,turn 边界消费) */
  modeSwitchIntent?: WorkModeSwitchIntent;
}

export interface AcceptedTurn {
  readonly conversationId: string;
  readonly turnId: string;
  readonly outcome: Promise<TurnOutcome>;
}

export interface BeginTurnOptions {
  readonly onAccepted?: (turn: {
    readonly conversationId: string;
    readonly turnId: string;
  }) => void;
}

export type ExitSceneResult =
  | { kind: "not-in-workscene"; active: ActiveConversation }
  | { kind: "returned"; active: ActiveConversation }
  | {
      kind: "fallback-latest" | "fallback-new";
      active: ActiveConversation;
      missingConversationId: string;
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
  /** 同一当前对话里,非本接入面发起的 turn 已落定。 */
  onObservedTurnComplete?: (turn: ObservedTurnNotification) => void;
  /** 非当前对话发生外部活动；只用于工作台提示或列表刷新，不携带内容。 */
  onActivity?: (activity: SessionActivityPayload) => void;
}

export interface InitialConversationSelection {
  active: ActiveConversation;
  resumedConversationName: string | null;
}

export interface ObservedTurnNotification {
  conversationId: string;
  turnId?: string;
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
  >,
): Promise<InitialConversationSelection> {
  for (const candidate of await conversation.list()) {
    if (!isMainConversationId(candidate.conversationId)) continue;
    const resumed = await conversation.resumeIfExists(candidate.conversationId);
    if (!resumed) continue;
    return {
      active: toActiveConversation(resumed),
      resumedConversationName: resumed.name,
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
  private readonly waiters = new Map<string, (outcome: TurnOutcome) => void>();
  private readonly pendingIntents = new Map<string, WorkModeSwitchIntent>();
  private readonly localTurnsByConversation = new Map<string, string>();
  private readonly localTurnAcceptances = new Map<
    string,
    (turn: { readonly conversationId: string; readonly turnId: string }) => void
  >();
  private readonly unsubscribes: Array<() => void>;

  constructor(
    private readonly opts: ConversationControllerOptions,
    initial: ActiveConversation,
  ) {
    this.active = initial;
    this.unsubscribes = [
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
      opts.conversation.onModeSwitchIntent((p) => {
        this.pendingIntents.set(p.turnId, p.intent);
      }),
      opts.conversation.onComplete((p) => {
        const waiter = this.waiters.get(p.turnId);
        if (!waiter) {
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
        this.waiters.delete(p.turnId);
        const intent = this.pendingIntents.get(p.turnId);
        this.pendingIntents.delete(p.turnId);
        if (this.localTurnsByConversation.get(p.conversationId) === p.turnId) {
          this.localTurnsByConversation.delete(p.conversationId);
        }
        this.markLocalTurnAccepted({
          conversationId: p.conversationId,
          turnId: p.turnId,
        });
        waiter({ result: p.result, modeSwitchIntent: intent });
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
      .subscribe(this.active.conversationId)
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
    const target = this.active.conversationId;
    const turnId = generateTurnId();
    const outcome = new Promise<TurnOutcome>((resolve) => {
      this.waiters.set(turnId, resolve);
    });
    this.localTurnsByConversation.set(target, turnId);
    if (options.onAccepted) {
      this.localTurnAcceptances.set(turnId, options.onAccepted);
    }
    try {
      await this.opts.conversation.send(input, target, turnId);
      this.observedConversationId = target;
      this.markLocalTurnAccepted({ conversationId: target, turnId });
    } catch (err) {
      this.waiters.delete(turnId);
      this.pendingIntents.delete(turnId);
      this.localTurnAcceptances.delete(turnId);
      if (this.localTurnsByConversation.get(target) === turnId) {
        this.localTurnsByConversation.delete(target);
      }
      throw err;
    }
    return { conversationId: target, turnId, outcome };
  }

  /** 发送一个 turn 并等待落定。 */
  async sendTurn(input: string | UserTurnInput): Promise<TurnOutcome> {
    return (await this.beginTurn(input)).outcome;
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

  /** 打断当前对话的 in-flight turn——complete 随宿主 cleanup 自然到达。 */
  async abort(): Promise<void> {
    await this.opts.conversation.abort(this.active.conversationId);
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

  /** 切换到既有对话(宿主 touch + 返回 meta),指针随之移动。 */
  async resume(conversationId: string): Promise<ActiveConversation> {
    const resumed = await this.opts.conversation.resume(conversationId);
    await this.switchActive(toActiveConversation(resumed));
    return this.active;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.opts.conversation.delete(conversationId);
    if (this.observedConversationId === conversationId) {
      this.observedConversationId = null;
    }
  }

  // ─── 工作场景(进出 = 宿主取建对话 + 指针切换) ───

  async enterScene(sceneId: string): Promise<ActiveConversation> {
    const entered = await this.opts.workscene.enter(sceneId);
    await this.switchActive({
      conversationId: entered.conversationId,
      name: entered.scene.name,
      mode: deriveMode(entered.conversationId, entered.scene.name),
    });
    return this.active;
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
    await this.opts.workscene.exit(this.active.mode.sceneId).catch(() => {});
    const resumed = await this.opts.conversation.resumeIfExists(
      mainTarget.conversationId,
    );
    if (resumed) {
      await this.switchActive(toMainActive(resumed));
      return { kind: "returned", active: this.active };
    }

    for (const candidate of await this.opts.conversation.list()) {
      if (!isMainConversationId(candidate.conversationId)) continue;
      const fallback = await this.opts.conversation.resumeIfExists(
        candidate.conversationId,
      );
      if (fallback) {
        await this.switchActive(toMainActive(fallback));
        return {
          kind: "fallback-latest",
          active: this.active,
          missingConversationId: mainTarget.conversationId,
        };
      }
    }

    const created = await this.opts.conversation.newConversation();
    await this.switchActive({
      conversationId: created.conversationId,
      name: created.name,
      mode: { kind: "main" },
    });
    return {
      kind: "fallback-new",
      active: this.active,
      missingConversationId: mainTarget.conversationId,
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
    for (const unsub of this.unsubscribes) unsub();
    this.waiters.clear();
    this.pendingIntents.clear();
    this.localTurnsByConversation.clear();
    this.observedConversationId = null;
  }
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
