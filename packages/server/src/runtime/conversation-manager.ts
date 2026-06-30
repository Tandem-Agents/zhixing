/**
 * ConversationManager — 对话生命周期与会话状态的全域权威
 *
 * 职责：
 * - 会话状态 owner：注意力窗口("给 LLM 看什么"的唯一内存权威)、turnCount、
 *   接受协议(先持久化、后入窗)都挂在 ManagedSession 上——SessionRuntime 是
 *   纯执行体,不持有任何会话状态
 * - Observer 跟踪：多个连接可共享同一个会话
 * - Grace Period：最后一个 observer 断开后等待 60s 再释放
 * - Idle Timeout：30 分钟无活动自动释放（防止内存泄漏）
 *
 * 设计原则：
 * - 持久层经回调注入（appendRun / loadHistory / writeSnapshot），不直接依赖 store
 * - 依赖注入：RuntimeFactory 由外部提供（CLI 或测试）
 * - 可测试：grace/idle 超时可通过配置注入
 */

import {
  createAttentionWindow,
  type AbortReason,
  type AppendRunResult,
  type AttentionWindowState,
  type Message,
  type RunRecordInput,
  type SnapshotInput,
  type WindowCompact,
  type WindowFoldOutcome,
} from "@zhixing/core";
import type {
  AbortResult,
  ConversationBootstrap,
  RuntimeCompactOutcome,
  RuntimeSecuritySnapshot,
  RuntimeSubAgentUsageEntry,
  SessionRuntime,
  RuntimeFactory,
} from "./types.js";
import { EphemeralRunBuffer } from "./ephemeral-run-buffer.js";
import type { ConfirmationHub } from "../confirmation/hub.js";

// 空 set 复用，避免每次 getObserverConnectionIds 返回新对象
const EMPTY_OBSERVER_SET: ReadonlySet<string> = new Set();

// ─── 配置 ───

export interface ConversationManagerConfig {
  /** observer 清空后释放 SessionRuntime 的延迟（ms）。默认 60_000 */
  readonly graceTimeoutMs?: number;
  /** 空闲超时（ms）。默认 30 * 60_000 */
  readonly idleTimeoutMs?: number;
  /** 空闲检查间隔（ms）。默认 60_000 */
  readonly idleCheckIntervalMs?: number;
  /** 每个 conversation 的最大待处理消息数。默认 5（spec §4.5） */
  readonly maxPending?: number;
}

const DEFAULT_GRACE_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_MAX_PENDING = 5;

// ─── 托管会话 ───

export interface ManagedSession {
  readonly conversationId: string;
  readonly runtime: SessionRuntime;
  /**
   * 注意力窗口 —— "给 LLM 看什么"的唯一内存权威,会话状态归 manager 而非
   * 执行体。恢复历史经启动装填对作为窗口起始条目;窗口只经接受协议前进
   * (recordTurn 在持久化 / pending 入列成功后调 acceptRun),run 输入瞬态
   * 构造、失败路径窗口不动——无需任何回滚。
   */
  readonly window: AttentionWindowState;
  readonly createdAt: string;
  lastActiveAt: string;
  busy: boolean;
  readonly observers: Set<string>;
  /** 已记录的 turn 数量（用于 turnIndex 计算） */
  turnCount: number;
  /** true = 纯内存会话，跳过持久化 */
  ephemeral: boolean;
  /** transcript 文件已初始化（防止 promote 重试时重复 init） */
  transcriptInited: boolean;
  /**
   * ephemeral 模式下的内存事实流缓冲 —— 持久化的 append-only 镜像，
   * 只追加、不因压缩截断（压缩是窗口的视图操作，原文不动）。每条 run
   * 入列即由缓冲定格 provisional runIndex（窗口配对锚与 promote 对账共用
   * 的同一事实）；promote 时按序平铺落盘。
   */
  readonly pendingRuns: EphemeralRunBuffer;
  /**
   * 窗口折叠锚（配对 runIndex）与持久化是否对齐 —— promote 对账不一致时
   * 置 false：错误的锚会让快照声明错误的覆盖边界（比缺失更糟），此后该
   * 会话的快照写入降级停写（快照是派生缓存，停写只损失启动连贯性）。
   */
  snapshotAnchorsTrusted: boolean;
}

// ─── 列表信息 ───

export interface ManagedSessionInfo {
  readonly conversationId: string;
  /** 向后兼容 RuntimeInfo.sessionId */
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly messageCount: number;
  readonly busy: boolean;
  readonly observerCount: number;
  readonly pendingCount: number;
  readonly ephemeral: boolean;
}

// ─── 释放事件回调 ───

export type OnSessionRelease = (conversationId: string, reason: "grace" | "idle") => void;

/**
 * 装载会话历史的回调 —— 返回启动装填产物（摘要快照 + 预算化倒读渲染的
 * 窗口起始条目 + turn 计数）。返回 undefined 表示无任何历史（新会话）。
 */
export type LoadHistory = (
  conversationId: string,
) => Promise<ConversationBootstrap | undefined>;

/** 新对话首次创建时的初始化回调（如写入 transcript header）。 */
export type InitTranscript = (conversationId: string) => Promise<void>;

/** 确保持久化对话身份已存在（meta + transcript 壳）。 */
export type EnsureConversation = (conversationId: string) => Promise<void>;

/**
 * 追加一条原始 run record 的回调 —— 对应分片 store 的 `appendRunRecord`。
 *
 * append-only：持久化只收原文，压缩是窗口的视图操作、不经此回调。
 * 返回 store 分配的 runIndex，recordTurn 据此推进窗口（覆盖锚点）。
 */
export type AppendRun = (
  conversationId: string,
  input: RunRecordInput,
) => Promise<AppendRunResult>;

export interface ConversationManagerCallbacks {
  onRelease?: OnSessionRelease;
  loadHistory?: LoadHistory;
  initTranscript?: InitTranscript;
  /**
   * 持久化身份确保入口。
   *
   * 宿主若有 ConversationDirectory，应提供此回调，让确定性外部会话 ID
   * （如通道 DM / 群聊 ID）在持久会话建立时同步拥有 meta 与 transcript 壳。
   * 未提供时回退到 initTranscript，兼容纯测试与旧装配。
   */
  ensureConversation?: EnsureConversation;
  /**
   * 原子持久化入口。
   *
   * recordTurn 内部调用此回调追加原文，成功后以返回的 runIndex 经
   * SessionRuntime.acceptRun 推进窗口。
   *
   * **配置契约（构造函数守卫）**：
   *   - 纯 ephemeral-only 场景（未提供持久化回调）：可省略
   *   - 任何持久化意图场景（提供了 loadHistory / initTranscript / ensureConversation）：**必须提供**
   *     constructor 检测到"部分配置"立即 throw —— 避免配置错误静默失败
   *     （persistent 分支丢消息、promote 错误晋升）。
   *
   * 运行时契约：recordTurn 的 persistent 分支 / promote 在缺省时不再静默
   * 降级 —— 前者 throw，后者 return false 保持 ephemeral。
   */
  appendRun?: AppendRun;
  /**
   * 派生摘要快照写入 —— 对应快照 store 的 `write`。
   *
   * recordTurn 在 persistent 会话的窗口折叠产生结构化摘要、且折叠锚可得时
   * 调用；写失败只 warn（快照是派生缓存，绝不影响 run record 与窗口）。
   * 省略时快照不落盘（启动装填降级为纯倒读）。
   */
  writeSnapshot?: (
    conversationId: string,
    input: SnapshotInput,
  ) => Promise<void>;
  /**
   * 可选 ConfirmationHub —— 提供时每个新建会话的 runtime.confirmationBroker 会
   * 自动 attach；会话释放（delete / grace / idle / disposeAll）前自动 detach。
   * 未提供时 ConversationManager 行为完全等价。
   *
   * 参见 remote-confirmation-execution.md §3.2。
   */
  confirmationHub?: ConfirmationHub;
  /**
   * turn 持久化成功后的维护钩子——所有入口(RPC / 渠道)的 turn 都经
   * recordTurn,此处是宿主侧 turn 后维护(自动命名 / journal 凝练等)的
   * 唯一汇聚点。同步签名 fire-and-forget:实现自行 void 异步工作并兜错,
   * 钩子失败绝不影响已完成的持久化与窗口推进。
   */
  onTurnCommitted?: (info: TurnCommittedInfo) => void;
}

/** onTurnCommitted 的入参——本次 turn 落定后的会话事实快照 */
export interface TurnCommittedInfo {
  readonly conversationId: string;
  /** 本 turn 落定后的累计 turn 数(首轮 = 1) */
  readonly turnCount: number;
  /** 本 run 的全部消息(含用户消息与助手回复) */
  readonly runMessages: readonly Message[];
  readonly ephemeral: boolean;
  /** 该会话的运行体(维护任务的 callText 推理通道) */
  readonly runtime: SessionRuntime;
}

// ─── 待处理任务 ───

export interface PendingTask {
  execute: () => Promise<void>;
  cancel: () => void;
}

type ConversationExists = () => Promise<boolean>;

export type TurnAdmissionResult =
  | {
      status: "immediate" | "queued";
      conversationId: string;
      managed: ManagedSession;
      task: PendingTask;
    }
  | { status: "full"; conversationId: string }
  | { status: "not-found"; conversationId: string };

export type ContextBudgetInspectionResult =
  | {
      status: "done";
      budget: ReturnType<NonNullable<SessionRuntime["checkBudget"]>>;
      turnCount: number;
      calibrationFactor: number;
    }
  | { status: "not-found" }
  | { status: "unsupported" };

export type UsageInspectionResult =
  | {
      status: "done";
      budget: ReturnType<NonNullable<SessionRuntime["checkBudget"]>>;
      turnCount: number;
      calibrationFactor: number;
      subUsages: readonly RuntimeSubAgentUsageEntry[];
    }
  | { status: "not-found" }
  | { status: "unsupported" };

export type SecurityInspectionResult =
  | { status: "done"; snapshot: RuntimeSecuritySnapshot }
  | { status: "not-found" }
  | { status: "unsupported" };

// ─── ConversationManager ───

export class ConversationManager {
  private readonly sessions = new Map<string, ManagedSession>();
  /**
   * observer 名册是 conversation 身份层状态,不是活跃 runtime 状态。
   *
   * 一个接入面可以正在"看"某个已落盘但尚未激活运行体的 conversation:
   * `/resume` / `session.new` 只切身份指针,第一次 send 才创建 ManagedSession。
   * 因此名册必须独立于 sessions,否则 idle 当前对话收不到 rename/delete/clear
   * 这类 run 外变更。
   */
  private readonly observers = new Map<string, Set<string>>();
  private readonly creating = new Map<string, Promise<ManagedSession>>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingQueues = new Map<string, PendingTask[]>();
  /**
   * 正在执行删除终结的 conversationId。
   *
   * 这是 idLocks 的可见状态位：idLocks 负责 FIFO 串行,但 `getOrCreate`
   * 的 promise 会在后续 delete 锁任务执行前先把 session 交还给调用方。
   * delete 发起瞬间立此标记,让创建完成的 session 以 busy=true 出生,
   * 从而保证调用方即便先恢复也只能排队,最终由 delete 统一取消。
   */
  private readonly deleting = new Set<string>();
  /**
   * 单 conversationId 串行门(promise 链 mutex)——覆盖"激活(getOrCreate
   * 的 doCreate/loadHistory)与 run 外写操作(clear / delete)在会话尚未
   * 活跃时仍可能撞车的读/写操作。活跃后的 turn 串行由 busy + pendingQueues
   * 承担(粒度更细、带界队列);本门只串"激活 vs run 外写",二者都从写后的
   * 事实流出发,杜绝"盘已清/已删却被并发 send 装入旧历史"。
   */
  private readonly idLocks = new Map<string, Promise<unknown>>();
  private idleInterval: ReturnType<typeof setInterval> | null = null;

  private readonly factory: RuntimeFactory;
  private readonly graceTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxPending: number;
  private readonly onRelease?: OnSessionRelease;
  private readonly loadHistory?: LoadHistory;
  private readonly initTranscript?: InitTranscript;
  private readonly ensureConversation?: EnsureConversation;
  private readonly appendRunCb?: AppendRun;
  private readonly writeSnapshotCb?: (
    conversationId: string,
    input: SnapshotInput,
  ) => Promise<void>;
  private readonly confirmationHub?: ConfirmationHub;
  private readonly onTurnCommitted?: (info: TurnCommittedInfo) => void;
  /** conversationId 集合——已 attach 到 hub 的会话，用于 dispose 前反查 + 防重 */
  private readonly attachedBrokers = new Set<string>();
  /**
   * `abortAllAndWait` 的 drain resolver:event-driven 等所有 in-flight 走完 cleanup
   * (`setBusy(id, false)` 末端检测全 idle 时 resolve)。null 表示当前无 abortAllAndWait
   * 在等待 —— `setBusy(false)` 路径不会误触发。
   */
  private drainResolver: (() => void) | null = null;

  constructor(
    factory: RuntimeFactory,
    config?: ConversationManagerConfig,
    callbacksOrOnRelease?: ConversationManagerCallbacks | OnSessionRelease,
    loadHistory?: LoadHistory,
  ) {
    this.factory = factory;
    this.graceTimeoutMs = config?.graceTimeoutMs ?? DEFAULT_GRACE_TIMEOUT_MS;
    this.idleTimeoutMs = config?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxPending = config?.maxPending ?? DEFAULT_MAX_PENDING;

    if (typeof callbacksOrOnRelease === "function") {
      this.onRelease = callbacksOrOnRelease;
      this.loadHistory = loadHistory;
    } else if (callbacksOrOnRelease) {
      this.onRelease = callbacksOrOnRelease.onRelease;
      this.loadHistory = callbacksOrOnRelease.loadHistory;
      this.initTranscript = callbacksOrOnRelease.initTranscript;
      this.ensureConversation = callbacksOrOnRelease.ensureConversation;
      this.appendRunCb = callbacksOrOnRelease.appendRun;
      this.writeSnapshotCb = callbacksOrOnRelease.writeSnapshot;
      this.confirmationHub = callbacksOrOnRelease.confirmationHub;
      this.onTurnCommitted = callbacksOrOnRelease.onTurnCommitted;
    } else if (loadHistory) {
      this.loadHistory = loadHistory;
    }

    // 配置守卫：部分配置即配置错误 —— 提供了持久化信号（loadHistory / initTranscript / ensureConversation）
    // 但没提供 appendRun，会导致 recordTurn 的 persistent 分支无路可走。
    // fail-fast 在构造阶段暴露。
    const hasPersistenceIntent = !!(
      this.loadHistory ||
      this.initTranscript ||
      this.ensureConversation
    );
    if (hasPersistenceIntent && !this.appendRunCb) {
      throw new Error(
        "ConversationManager: `appendRun` callback is required when persistence callbacks are provided. " +
          "Ephemeral-only usage should omit all persistence callbacks.",
      );
    }

    this.startIdleReaper(config?.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * 获取或创建托管会话。
   *
   * - 传 conversationId 且已存在 → 返回现有会话
   * - 传 conversationId 但不存在 → 通过 factory 创建
   * - 不传 → 自动生成 ID 并创建
   */
  async getOrCreate(
    conversationId?: string,
    options?: { ephemeral?: boolean },
  ): Promise<ManagedSession> {
    if (conversationId && this.sessions.has(conversationId)) {
      const session = this.sessions.get(conversationId)!;
      session.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
      return session;
    }

    const id = conversationId ?? generateConversationId();

    const inflight = this.creating.get(id);
    if (inflight) return inflight;

    // 激活(doCreate 内 loadHistory 读盘)经 id 串行门——与同 id 的 clear
    // 互斥:clear 在途时此处等待,clear 完成后从清空后的事实流装填。
    const promise = this.withIdLock(id, () =>
      this.doCreate(id, options?.ephemeral ?? false),
    );
    this.creating.set(id, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(id);
    }
  }

  /**
   * 单 conversationId 串行门:把 fn 链在该 id 当前在途操作之后同步执行。
   * 读取当前 tail 与挂上新 tail 一气呵成(无 await 间隙),不同调用者各自
   * 链在前者之后,严格 FIFO 互斥;前者成功或失败都不阻断链(`.then(_,_)`)。
   */
  private withIdLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.idLocks.get(id) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // tail 吞掉成败,既作为后续者的串行锚,也用于"我是末尾才清理"判定
    const tail = result.then(
      () => {},
      () => {},
    );
    this.idLocks.set(id, tail);
    void tail.then(() => {
      if (this.idLocks.get(id) === tail) this.idLocks.delete(id);
    });
    return result;
  }

  private async doCreate(id: string, ephemeral: boolean): Promise<ManagedSession> {
    const history = ephemeral ? undefined : await this.loadHistory?.(id);
    // factory 先于持久身份确保:装配失败(如对话所属场景已删)时 fail-fast
    // 在任何写盘之前——否则会在已删除的归属目录里重建空身份壳。
    const runtime = await this.factory.create(id);
    if (!ephemeral) {
      await this.ensurePersistentConversation(id, history !== undefined);
    }
    const now = new Date().toISOString();

    const session: ManagedSession = {
      conversationId: id,
      runtime,
      window: createAttentionWindow({
        conversationId: id,
        bootstrap: history?.bootstrap ?? undefined,
      }),
      createdAt: now,
      lastActiveAt: now,
      busy: this.deleting.has(id),
      observers: this.getOrCreateObserverSet(id),
      turnCount: history?.turnCount ?? 0,
      ephemeral,
      transcriptInited: !ephemeral,
      pendingRuns: new EphemeralRunBuffer(),
      snapshotAnchorsTrusted: true,
    };

    this.sessions.set(id, session);
    this.attachToHub(id, runtime);
    return session;
  }

  /**
   * 显式 conversationId 的启动装填门禁。
   *
   * `exists` 必须在 manager 的 id 串行门内执行,否则 RPC 层会形成
   * "exists=true → delete 完成 → getOrCreate 又重建持久身份" 的复活竞态。
   * 无持久目录的最小测试/ephemeral 场景可不传 exists,保持旧的纯内存语义。
   */
  private async getOrCreateExisting(
    conversationId: string,
    exists?: ConversationExists,
  ): Promise<ManagedSession | undefined> {
    const active = this.sessions.get(conversationId);
    if (active) {
      active.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
      return active;
    }

    return this.withIdLock(conversationId, async () => {
      const activeAfterWait = this.sessions.get(conversationId);
      if (activeAfterWait) {
        activeAfterWait.lastActiveAt = new Date().toISOString();
        this.clearGraceTimer(conversationId);
        return activeAfterWait;
      }
      if (exists && !(await exists())) return undefined;
      return this.doCreate(conversationId, false);
    });
  }

  /**
   * turn 准入的唯一 owner 入口。
   *
   * 它把"身份解析/存在性门禁/运行体激活/observer 入册/排队或 busy 占位"
   * 收进同一个结构里。调用方拿到 immediate 后只负责启动返回的 task;
   * queued/full/not-found 均已在 owner 内形成确定状态,不会在 RPC 层留下
   * 可被 delete/clear 插入的半开放窗口。
   */
  async admitTurn(input: {
    conversationId?: string;
    createConversation?: () => Promise<string>;
    exists?: ConversationExists;
    connectionId: string;
    makeTask: (managed: ManagedSession) => PendingTask;
  }): Promise<TurnAdmissionResult> {
    if (input.conversationId) {
      const active = this.sessions.get(input.conversationId);
      if (active) {
        return this.admitTurnForSession(
          active,
          input.connectionId,
          input.makeTask,
        );
      }
    }

    const managed = input.conversationId
      ? await this.getOrCreateExisting(input.conversationId, input.exists)
      : await this.getOrCreate(await input.createConversation?.());

    if (!managed) {
      return {
        status: "not-found",
        conversationId: input.conversationId!,
      };
    }

    return this.admitTurnForSession(managed, input.connectionId, input.makeTask);
  }

  private admitTurnForSession(
    managed: ManagedSession,
    connectionId: string,
    makeTask: (managed: ManagedSession) => PendingTask,
  ): TurnAdmissionResult {
    managed.lastActiveAt = new Date().toISOString();
    this.clearGraceTimer(managed.conversationId);
    const task = makeTask(managed);
    const status = this.enqueue(managed.conversationId, task);
    if (status === "full") {
      return { status: "full", conversationId: managed.conversationId };
    }

    this.addObserver(managed.conversationId, connectionId);
    if (status === "immediate") {
      this.setBusy(managed.conversationId, true);
    }

    return {
      status,
      conversationId: managed.conversationId,
      managed,
      task,
    };
  }

  // ─── ConfirmationHub 接入（remote-confirmation-execution.md §3.2） ───

  /** 把会话的 broker 接到 hub（幂等）；未配置 hub 或 runtime 无 broker 时 no-op */
  private attachToHub(conversationId: string, runtime: SessionRuntime): void {
    if (!this.confirmationHub) return;
    if (!runtime.confirmationBroker) return;
    if (this.attachedBrokers.has(conversationId)) return;

    this.confirmationHub.attach(
      `conv:${conversationId}`,
      runtime.confirmationBroker,
      { conversationId },
    );
    this.attachedBrokers.add(conversationId);
  }

  /**
   * 从 hub 解绑。必须在 session.runtime.dispose() 之前调用——否则 dispose 后
   * broker 内存仍被 hub listener 持有，等到 hub 被释放时才 GC。
   *
   * INV-H3 保证：detach 内部先 cancelAll → pending 的 resolved 事件送达
   * Renderer/Bridge → 清索引。
   */
  private detachFromHub(conversationId: string): void {
    if (!this.confirmationHub) return;
    if (!this.attachedBrokers.has(conversationId)) return;
    this.confirmationHub.detach(`conv:${conversationId}`);
    this.attachedBrokers.delete(conversationId);
  }

  // ─── Observer 管理 ───

  private getOrCreateObserverSet(conversationId: string): Set<string> {
    let observers = this.observers.get(conversationId);
    if (!observers) {
      observers = new Set();
      this.observers.set(conversationId, observers);
    }
    return observers;
  }

  private maybeDropEmptyObserverSet(conversationId: string): void {
    const observers = this.observers.get(conversationId);
    if (!observers || observers.size > 0) return;
    if (this.sessions.has(conversationId)) return;
    this.observers.delete(conversationId);
  }

  /**
   * 添加观察者连接。
   *
   * 默认只允许活跃会话;RPC `session.subscribe` 在目录层确认 conversation
   * 身份存在后传 `allowInactive`，从而支持已落盘但未激活 runtime 的当前对话
   * 收到 run 外变更通知。
   */
  addObserver(
    conversationId: string,
    connectionId: string,
    opts?: { allowInactive?: boolean },
  ): boolean {
    const session = this.sessions.get(conversationId);
    if (!session && !opts?.allowInactive) return false;
    const observers = this.getOrCreateObserverSet(conversationId);
    observers.add(connectionId);
    if (session) this.clearGraceTimer(conversationId);
    return true;
  }

  /**
   * 移除观察者连接。如果没有剩余观察者且不在 busy 状态，启动 grace timer。
   */
  removeObserver(conversationId: string, connectionId: string): void {
    const observers = this.observers.get(conversationId);
    if (!observers) return;
    observers.delete(connectionId);
    const session = this.sessions.get(conversationId);
    if (session && observers.size === 0 && !session.busy) {
      this.startGraceTimer(conversationId);
    }
    this.maybeDropEmptyObserverSet(conversationId);
  }

  /**
   * 断开某个连接在所有会话上的观察。
   * 典型场景：WebSocket 断开时批量清理。
   */
  removeObserverFromAll(connectionId: string): void {
    for (const [convId, observers] of this.observers) {
      if (!observers.has(connectionId)) continue;
      observers.delete(connectionId);
      const session = this.sessions.get(convId);
      if (session && observers.size === 0 && !session.busy) {
        this.startGraceTimer(convId);
      }
      this.maybeDropEmptyObserverSet(convId);
    }
  }

  /** 查询会话的当前观察者数量 */
  getObserverCount(conversationId: string): number {
    return this.observers.get(conversationId)?.size ?? 0;
  }

  /**
   * 查询会话的当前观察者 connectionId 集合（只读）。
   * 返回内部 observers set 的引用（类型系统限制为 ReadonlySet）——调用方不应修改。
   * 会话不存在时返回共享的空 set。
   *
   * 用途：ConfirmationBridge 按 conversation observer 定向推送 RPC 通知
   * （remote-confirmation-execution.md §3.9）。
   */
  getObserverConnectionIds(conversationId: string): ReadonlySet<string> {
    return this.observers.get(conversationId) ?? EMPTY_OBSERVER_SET;
  }

  // ─── 查询 ───

  get(conversationId: string): SessionRuntime | undefined {
    return this.sessions.get(conversationId)?.runtime;
  }

  getSession(conversationId: string): ManagedSession | undefined {
    return this.sessions.get(conversationId);
  }

  has(conversationId: string): boolean {
    return this.sessions.has(conversationId);
  }

  /**
   * 当前注意力窗口内容(只读拷贝)—— RPC 历史查询的数据源。
   * 会话不存在(未活跃)返回 undefined,调用方据此回 not-found。
   */
  getHistory(conversationId: string, limit?: number): Message[] | undefined {
    const session = this.sessions.get(conversationId);
    if (!session) return undefined;
    const msgs = session.window.getMessages();
    return limit ? msgs.slice(-limit) : [...msgs];
  }

  list(): ManagedSessionInfo[] {
    return [...this.sessions.entries()].map(([id, s]) => ({
      conversationId: id,
      sessionId: s.runtime.sessionId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      messageCount: s.window.getMessages().length,
      busy: s.busy,
      observerCount: this.getObserverCount(id),
      pendingCount: this.pendingQueues.get(id)?.length ?? 0,
      ephemeral: s.ephemeral,
    }));
  }

  // ─── 状态操作 ───

  setBusy(conversationId: string, busy: boolean): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.busy = busy;
    if (busy) {
      session.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
    } else {
      const queue = this.pendingQueues.get(conversationId);
      if (queue && queue.length > 0) {
        this.dequeueNext(conversationId);
      } else if (this.getObserverCount(conversationId) === 0) {
        this.startGraceTimer(conversationId);
      }
      // event-driven drain:从 busy 到 idle 的下降沿,若 abortAllAndWait 在等且
      // 全部 session idle 则 resolve(关停期间 dequeueNext 不会再 setBusy(true) ——
      // pending queue 已被 abortAll 清空)。
      if (this.drainResolver && this.sessionsAllIdle()) {
        const resolve = this.drainResolver;
        this.drainResolver = null;
        resolve();
      }
    }
  }

  /**
   * 取消该 conversation 的 in-flight turn 与 pending queue,返回双维度结果。
   *
   * 用户视角"正在处理"包含两类:已发未跑的 pending 也是用户期待 abort 的目标。
   * 单 boolean 无法区分"取消了什么";`AbortResult` 让 caller 按 channel 上下文
   * 决定 UX 反馈(参见 `AbortResult` doc)。
   *
   * 不抛异常 —— session 不存在 / idle / 重复调用都是飞书等异步通道的正常状态。
   */
  abort(conversationId: string, reason?: AbortReason): AbortResult {
    const session = this.sessions.get(conversationId);
    if (!session) return { abortedInFlight: false, cancelledPending: 0 };

    const abortedInFlight = session.runtime.abort(reason);

    // pending task 在用户主动 cancel 场景下应该被清理 —— 否则用户发"取消"后,
    // 后续 dequeue 仍会跑这些 pending,与"我让 agent 停"语义违背。
    const queue = this.pendingQueues.get(conversationId);
    let cancelledPending = 0;
    if (queue) {
      for (const task of queue) {
        try {
          task.cancel();
        } catch {
          // 逐个独立 swallow:某条 task 的 cancel hook 抛错不影响其它 task
        }
        cancelledPending++;
      }
      this.pendingQueues.delete(conversationId);
    }

    return { abortedInFlight, cancelledPending };
  }

  /**
   * 关停链路用,与单 session `abort` 行为对称:同步 fire 各 session in-flight +
   * 同步清各 pending queue 触发各 cancel hook。
   *
   * 不依赖 `disposeAll()` 注册到关停链 —— 把"清 pending"假设给 disposeAll 等于
   * 假设了一个未建立的事实(disposeAll 当前仅 test afterEach 用),且关停场景下
   * pending 与 in-flight 是同一组取消语义,拆开两个方法是非对称破口。
   *
   * 返回 in-flight aborted count(关停场景调用方是 CleanupRegistry callback,
   * 只关心 drain 完成性,pending 计数不暴露)。与 `abortAllAndWait` 配合实现
   * 关停期间所有 in-flight 走完 cleanup。
   */
  abortAll(reason: AbortReason): number {
    let aborted = 0;
    for (const [id, session] of this.sessions) {
      if (session.runtime.abort(reason)) aborted++;
      const queue = this.pendingQueues.get(id);
      if (queue) {
        for (const task of queue) {
          try {
            task.cancel();
          } catch {
            // swallow
          }
        }
        this.pendingQueues.delete(id);
      }
    }
    return aborted;
  }

  /**
   * 触发 `abortAll` 后 await 所有 in-flight session 走完 cleanup —— event-driven
   * `setBusy(false)` 检测全 idle 时 resolve drain Promise,不轮询。
   *
   * `timeoutMs` 兜底:超时不抛,直接返回 —— 避免 grace 类工具 hang 整条关停链;
   * graceful shutdown 必须有上限,接受"30s 之后强行进下一步"的工程妥协。
   */
  async abortAllAndWait(reason: AbortReason, timeoutMs = 30_000): Promise<number> {
    const aborted = this.abortAll(reason);
    if (this.sessionsAllIdle()) return aborted;

    const drained = new Promise<void>((resolve) => {
      this.drainResolver = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([drained, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // 超时路径主动清掉 resolver,避免后续 setBusy(false) 误调一个无效 resolve
      this.drainResolver = null;
    }
    return aborted;
  }

  private sessionsAllIdle(): boolean {
    for (const session of this.sessions.values()) {
      if (session.busy) return false;
    }
    return true;
  }

  // ─── Run 记录 + 晋升（单向数据流） ───

  /**
   * 记录一个完成的 run，并可选地应用本 run 的窗口折叠指令。
   *
   * 接受协议："先持久化（或 pending 入列）成功、后窗口前进"——成功后调
   * `session.runtime.acceptRun`，窗口应用 windowCompact 折叠并追加本 run
   * 蒸馏对。失败路径不触窗口：内存停在原基底，下轮重试，无需回滚。
   *
   * 压缩与持久化的分界：windowCompact 只驱动**窗口折叠**（注意力视图）；
   * 持久化（磁盘 / pending）是 append-only 原文，永不因压缩变短——被摘
   * 内容仍完整躺在持久层上。
   *
   * 两条路径：
   *   - persistent → appendRun 回调（追加原始 run record）→ 以返回的 runIndex
   *     acceptRun（折叠覆盖锚点随配对落进窗口）
   *   - ephemeral → pendingRuns 追加（promote 的平铺落盘原料）→ acceptRun
   *     携 **provisional runIndex**（= pending 队列序号）；turnCount >= 2 自动 promote
   */
  async recordTurn(
    conversationId: string,
    record: RunRecordInput,
    windowCompact?: WindowCompact,
  ): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;

    if (session.ephemeral) {
      // 入列即 ephemeral 的"持久化成功"——缓冲在入列那一刻定格 provisional
      // runIndex（内存事实流的唯一编号分配点，与 store 同一编号纪律）。
      // promote 按 FIFO flush 到全新 transcript 时与 store 顺序分配一致
      //（promote 内对账校验）——persistent 化后窗口配对恒有 runIndex，
      // 折叠的覆盖锚点不缺。
      const provisionalRunIndex = session.pendingRuns.enqueue(record);
      session.turnCount++;

      session.window.acceptRun({
        runMessages: record.messages,
        runIndex: provisionalRunIndex,
        windowCompact,
      });

      if (session.turnCount >= 2) {
        await this.promote(conversationId);
      }
      this.notifyTurnCommitted(session, record);
      return;
    }

    // persistent 分支：appendRun 落盘成功后窗口前进
    //
    // 构造函数已守卫 "有持久化意图必须有 appendRun"；此处的 assert 是 defense-in-depth ——
    // 防止有人构造时通过 `undefined as any` 等方式绕过类型检查后在运行时 bite。
    // 不静默降级（静默会让本轮 run 既不落盘也不报错）。
    if (!this.appendRunCb) {
      throw new Error(
        `ConversationManager.recordTurn: persistent session ${conversationId} requires appendRun callback ` +
          "(was this manager constructed without appendRun while the session is not ephemeral?)",
      );
    }
    const { runIndex } = await this.appendRunCb(conversationId, record);
    const outcome = session.window.acceptRun({
      runMessages: record.messages,
      runIndex,
      windowCompact,
    });
    session.turnCount++;
    await this.maybeWriteSnapshot(conversationId, session, windowCompact, outcome);
    this.notifyTurnCommitted(session, record);
  }

  /** 持久化成功后触发维护钩子——钩子抛错不反向影响已落定的 turn。 */
  private notifyTurnCommitted(
    session: ManagedSession,
    record: RunRecordInput,
  ): void {
    if (!this.onTurnCommitted) return;
    try {
      this.onTurnCommitted({
        conversationId: session.conversationId,
        turnCount: session.turnCount,
        runMessages: record.messages,
        ephemeral: session.ephemeral,
        runtime: session.runtime,
      });
    } catch (err) {
      console.warn(
        `[ConversationManager] onTurnCommitted 钩子失败 conv=${session.conversationId}(不影响已落定 turn):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ─── 会话命令执行体(run 外窗口操作) ───

  /**
   * 同步占用活跃会话的串行点做一次 run 外维护(clear / compact)。
   *
   * check-and-set 一气呵成、其间无 await——这是消除 TOCTOU 的关键:维护操作
   * 在开头同步把 busy 置真,并发 send 经 enqueue 即见 busy 而排队(不会在
   * "检查不忙"与"占用"之间挤进一个跑在旧窗口上的 turn)。维护的 async 工作
   * (持久层清空 / LLM 摘要 / 窗口重置)全程持有 busy;release 经 setBusy(false)
   * 把排队的 send 在维护产出的新窗口上 dequeue。
   *
   * 返回活跃会话(已占用,调用方须 finally setBusy(false))/ "busy"(进行中
   * turn 或另一维护占用,拒绝)/ "not-active"(不在活跃集,无内存窗口)。
   */
  private acquireExclusive(
    conversationId: string,
  ): ManagedSession | "busy" | "not-active" {
    const session = this.sessions.get(conversationId);
    if (!session) return "not-active";
    if (session.busy) return "busy";
    // 同步占用——此后到 setBusy(false) 之间任何 send 的 enqueue 都见 busy 排队
    session.busy = true;
    session.lastActiveAt = new Date().toISOString();
    this.clearGraceTimer(conversationId);
    return session;
  }

  /**
   * 清空对话——双层互斥各司其职,杜绝"盘已清却被并发操作看旧状态记新流":
   *
   * - **busy 串行点**(活跃会话):`acquireExclusive` **同步**占用(调用即占,
   *   无微任务间隙),并发 send 经 enqueue 立即排队,清空后在空窗口 dequeue。
   * - **id 串行门**(非活跃会话):`withIdLock` 与同 id 的 getOrCreate 激活
   *   (doCreate/loadHistory 读盘)严格 FIFO 互斥——并发 send 的激活排在 clear
   *   之后,从清空后的事实流装填,不读旧历史。等门期间若被激活,门内复用 busy
   *   快路。
   *
   * 返回:"cleared"(活跃,盘+窗同事务清)/ "cleared-inactive"(非活跃,仅盘清)
   * / "not-found"(盘上无此对话)/ "busy"(进行中 turn,拒绝、盘未动)。
   */
  async clear(
    conversationId: string,
    persistClear: () => Promise<boolean>,
  ): Promise<"cleared" | "cleared-inactive" | "not-found" | "busy"> {
    // 活跃快路:同步占用 busy(无微任务间隙——这是并发 send 立即见忙的关键)
    const acquired = this.acquireExclusive(conversationId);
    if (acquired === "busy") return "busy";
    if (acquired !== "not-active") {
      return this.clearActiveSession(acquired, persistClear);
    }
    // 非活跃:经 id 门与激活互斥;门内再判活跃(等门期间可能被一次 send 激活)
    return this.withIdLock(conversationId, async () => {
      const acq2 = this.acquireExclusive(conversationId);
      if (acq2 === "busy") return "busy";
      if (acq2 !== "not-active") {
        return this.clearActiveSession(acq2, persistClear);
      }
      // 仍非活跃:无内存窗口;持 id 门写盘,并发 send 的激活排在其后从空盘装填
      return (await persistClear()) ? "cleared-inactive" : "not-found";
    });
  }

  /**
   * 清空一个**已同步占用 busy** 的活跃会话(调用方经 acquireExclusive 占用)——
   * 持久层清空(在占用之后,busy 拒绝路径下盘不被动)+ 内存窗口重置 + 运行体
   * 换代钩子;finally 释放 busy(排队的 send 在空窗口 dequeue)。
   */
  private async clearActiveSession(
    session: ManagedSession,
    persistClear: () => Promise<boolean>,
  ): Promise<"cleared" | "not-found"> {
    try {
      if (!(await persistClear())) return "not-found";
      session.window.reset("clear");
      session.turnCount = 0;
      // 运行体能力可选:缺失时窗口已清,内存语义即"清空",降级可接受
      await session.runtime.resetConversationState?.().catch(() => {});
      await session.runtime.onAttentionWindowChange?.("clear").catch(() => {});
      return "cleared";
    } finally {
      this.setBusy(session.conversationId, false);
    }
  }

  /**
   * 在会话 owner 内执行一次 run 外视图态维护。
   *
   * 用途:task_list 这类不跑 LLM、但会写 conversation meta / 推送视图变更的
   * 操作。它必须与 clear / delete / send 共享同一 per-conversation 串行点:
   * - 活跃会话:同步占用 busy,并发 send 排队,并发 clear/delete 见 busy 拒绝。
   * - 非活跃会话:走 id 门,与同 id 激活 / clear / delete 的读写互斥。
   *
   * 不在这里判断 conversation 是否存在;持久层执行体负责给出自己的失败语义。
   */
  async runMaintenance<T>(
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<{ status: "done"; value: T } | { status: "busy" }> {
    const acquired = this.acquireExclusive(conversationId);
    if (acquired === "busy") return { status: "busy" };
    if (acquired !== "not-active") {
      return this.runActiveMaintenance(acquired, fn);
    }

    return this.withIdLock(conversationId, async () => {
      const acq2 = this.acquireExclusive(conversationId);
      if (acq2 === "busy") return { status: "busy" };
      if (acq2 !== "not-active") {
        return this.runActiveMaintenance(acq2, fn);
      }
      return { status: "done", value: await fn() };
    });
  }

  async runMaintenanceExisting<T>(
    conversationId: string,
    exists: ConversationExists | undefined,
    fn: () => Promise<T>,
  ): Promise<
    | { status: "done"; value: T }
    | { status: "busy" }
    | { status: "not-found" }
  > {
    const acquired = this.acquireExclusive(conversationId);
    if (acquired === "busy") return { status: "busy" };
    if (acquired !== "not-active") {
      return this.runActiveMaintenance(acquired, fn);
    }

    return this.withIdLock(conversationId, async () => {
      const acq2 = this.acquireExclusive(conversationId);
      if (acq2 === "busy") return { status: "busy" };
      if (acq2 !== "not-active") {
        return this.runActiveMaintenance(acq2, fn);
      }
      if (exists && !(await exists())) return { status: "not-found" };
      return { status: "done", value: await fn() };
    });
  }

  private async runActiveMaintenance<T>(
    session: ManagedSession,
    fn: () => Promise<T>,
  ): Promise<{ status: "done"; value: T }> {
    try {
      return { status: "done", value: await fn() };
    } finally {
      this.setBusy(session.conversationId, false);
    }
  }

  /**
   * 手动压缩会话窗口——运行体产出窗口重构指令,此处应用折叠 + 写派生快照
   * (与 recordTurn 的折叠共用 maybeWriteSnapshot)+ 窗口换代钩子。全程持有
   * 串行点:forceCompact 的 LLM 摘要 async 期间并发 send 排队,不会与折叠
   * 撞窗口。调用方须先 getOrCreate 激活会话。
   */
  async compact(
    conversationId: string,
  ): Promise<
    | { status: "done"; outcome: RuntimeCompactOutcome }
    | { status: "not-active" }
    | { status: "busy" }
    | { status: "unsupported" }
  > {
    const acquired = this.acquireExclusive(conversationId);
    if (acquired === "not-active") return { status: "not-active" };
    if (acquired === "busy") return { status: "busy" };
    return this.compactAcquired(conversationId, acquired);
  }

  async compactExisting(
    conversationId: string,
    exists?: ConversationExists,
  ): Promise<
    | { status: "done"; outcome: RuntimeCompactOutcome }
    | { status: "not-found" }
    | { status: "busy" }
    | { status: "unsupported" }
  > {
    const active = this.acquireExclusive(conversationId);
    if (active === "busy") return { status: "busy" };
    if (active !== "not-active") {
      return this.compactAcquired(conversationId, active);
    }

    const acquired = await this.acquireInactiveExistingExclusive(
      conversationId,
      exists,
    );
    if (acquired === "busy") return { status: "busy" };
    if (acquired === "not-found") return { status: "not-found" };
    return this.compactAcquired(conversationId, acquired);
  }

  private async acquireInactiveExistingExclusive(
    conversationId: string,
    exists?: ConversationExists,
  ): Promise<ManagedSession | "busy" | "not-found"> {
    return this.withIdLock(conversationId, async () => {
      const acq2 = this.acquireExclusive(conversationId);
      if (acq2 === "busy") return "busy";
      if (acq2 !== "not-active") return acq2;
      if (exists && !(await exists())) return "not-found";
      const managed = await this.doCreate(conversationId, false);
      const acquiredAfterCreate = this.acquireExclusive(managed.conversationId);
      if (acquiredAfterCreate === "not-active") return "not-found";
      return acquiredAfterCreate;
    });
  }

  private async compactAcquired(
    conversationId: string,
    acquired: ManagedSession,
  ): Promise<
    | { status: "done"; outcome: RuntimeCompactOutcome }
    | { status: "busy" }
    | { status: "unsupported" }
  > {
    try {
      if (!acquired.runtime.forceCompact) return { status: "unsupported" };
      const outcome = await acquired.runtime.forceCompact(
        [...acquired.window.getMessages()],
        acquired.turnCount,
      );
      if (outcome.windowCompact) {
        const foldOutcome = acquired.window.applyCompact(outcome.windowCompact);
        await this.maybeWriteSnapshot(
          conversationId,
          acquired,
          outcome.windowCompact,
          foldOutcome,
        );
        await acquired.runtime
          .onAttentionWindowChange?.("compact")
          .catch(() => {});
      }
      return { status: "done", outcome };
    } finally {
      this.setBusy(conversationId, false);
    }
  }

  async inspectContextBudgetExisting(
    conversationId: string,
    exists?: ConversationExists,
  ): Promise<ContextBudgetInspectionResult> {
    const active = this.sessions.get(conversationId);
    if (active) {
      active.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
      return this.inspectContextBudget(active);
    }

    return this.withIdLock(conversationId, async () => {
      const activeAfterWait = this.sessions.get(conversationId);
      if (activeAfterWait) {
        activeAfterWait.lastActiveAt = new Date().toISOString();
        this.clearGraceTimer(conversationId);
        return this.inspectContextBudget(activeAfterWait);
      }
      if (exists && !(await exists())) return { status: "not-found" };
      const managed = await this.doCreate(conversationId, false);
      return this.inspectContextBudget(managed);
    });
  }

  private inspectContextBudget(
    session: ManagedSession,
  ): ContextBudgetInspectionResult {
    if (!session.runtime.checkBudget) return { status: "unsupported" };
    return {
      status: "done",
      budget: session.runtime.checkBudget([...session.window.getMessages()]),
      turnCount: session.turnCount,
      calibrationFactor: session.runtime.calibrationFactor ?? 1,
    };
  }

  async inspectUsageExisting(
    conversationId: string,
    exists?: ConversationExists,
  ): Promise<UsageInspectionResult> {
    const active = this.sessions.get(conversationId);
    if (active) {
      active.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
      return this.inspectUsage(active);
    }

    return this.withIdLock(conversationId, async () => {
      const activeAfterWait = this.sessions.get(conversationId);
      if (activeAfterWait) {
        activeAfterWait.lastActiveAt = new Date().toISOString();
        this.clearGraceTimer(conversationId);
        return this.inspectUsage(activeAfterWait);
      }
      if (exists && !(await exists())) return { status: "not-found" };
      const managed = await this.doCreate(conversationId, false);
      return this.inspectUsage(managed);
    });
  }

  private inspectUsage(session: ManagedSession): UsageInspectionResult {
    if (!session.runtime.checkBudget) return { status: "unsupported" };
    const messages = [...session.window.getMessages()];
    return {
      status: "done",
      budget: session.runtime.checkBudget(messages),
      turnCount: session.turnCount,
      calibrationFactor: session.runtime.calibrationFactor ?? 1,
      subUsages: session.runtime.subAgentUsages?.(messages) ?? [],
    };
  }

  async inspectSecurityExisting(
    conversationId: string,
    exists?: ConversationExists,
  ): Promise<SecurityInspectionResult> {
    const active = this.sessions.get(conversationId);
    if (active) {
      active.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
      return this.inspectSecurity(active);
    }

    return this.withIdLock(conversationId, async () => {
      const activeAfterWait = this.sessions.get(conversationId);
      if (activeAfterWait) {
        activeAfterWait.lastActiveAt = new Date().toISOString();
        this.clearGraceTimer(conversationId);
        return this.inspectSecurity(activeAfterWait);
      }
      if (exists && !(await exists())) return { status: "not-found" };
      const managed = await this.doCreate(conversationId, false);
      return this.inspectSecurity(managed);
    });
  }

  private inspectSecurity(session: ManagedSession): SecurityInspectionResult {
    if (!session.runtime.securitySnapshot) return { status: "unsupported" };
    return { status: "done", snapshot: session.runtime.securitySnapshot() };
  }

  /**
   * 窗口折叠产生结构化摘要时顺手写派生快照（启动装填的摘要来源）。
   *
   * 全部条件缺一不写（宁缺毋滥——快照是派生缓存，缺失只是启动连贯性降级）：
   *   - windowCompact 携结构化摘要（段切换路径产物）
   *   - 配置了 writeSnapshot 回调（serve 装配注入）
   *   - 会话的折叠锚可信（promote 对账不一致后停写——错误的覆盖边界比缺失更糟）
   *   - 折叠交出了覆盖锚（被折配对带 runIndex）
   * 写失败只 warn：run record 已落盘、窗口已前进，快照绝不反向影响两者。
   */
  private async maybeWriteSnapshot(
    conversationId: string,
    session: ManagedSession,
    windowCompact: WindowCompact | undefined,
    outcome: WindowFoldOutcome,
  ): Promise<void> {
    if (!windowCompact?.structuredSummary || !this.writeSnapshotCb) return;
    if (!session.snapshotAnchorsTrusted) return;
    const covered = outcome.coveredThroughRunIndex;
    if (covered === undefined) return;
    try {
      await this.writeSnapshotCb(conversationId, {
        coveredThroughRunIndex: covered,
        structuredSummary: windowCompact.structuredSummary,
        tokensBefore: windowCompact.tokensBefore,
        tokensAfter: windowCompact.tokensAfter,
      });
    } catch (err) {
      console.warn(
        `[ConversationManager] 快照写入失败 conv=${conversationId}（不影响 run record 与窗口）:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 将 ephemeral 会话晋升为 persistent —— 把 pending 的原始 run records 按序
   * 平铺落盘（append-only，无任何压缩边界参与）。
   *
   * 不触窗口 —— ephemeral 期间窗口已随每次 recordTurn 的接受协议前进；
   * 窗口是压缩视图、持久化是全量原文，二者本就允许分叉，晋升无需同步。
   */
  async promote(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!session || !session.ephemeral) return false;

    // 无 appendRun 回调：保持 ephemeral 状态，不晋升。
    //
    // 若清空 pending 后仍置 ephemeral=false 会导致：
    //   1. 本次调用已清空 pending，数据丢失
    //   2. 更严重：ephemeral=false 使后续 recordTurn 走 persistent 分支，
    //      persistent 分支又 throw（见 recordTurn 的 assert）—— 彻底卡死
    // 返 false 告知调用方"未晋升"，保留 pendingRuns 供后续真正配置了 appendRun
    // 的新 manager 处理（或允许会话继续作为 ephemeral 运行）。
    if (!this.appendRunCb) {
      return false;
    }

    if (!session.transcriptInited) {
      await this.ensurePersistentConversation(conversationId, false);
      session.transcriptInited = true;
    }

    // 逐条 flush：出队只在单条 appendRun 成功后执行 —— 任意中间失败 rethrow
    // 时缓冲保留未持久化尾部（retry 安全）。
    //
    // runIndex 对账：窗口配对持有的 provisional runIndex（条目入列时定格的
    // 事实）必须与 store 实际分配一致——FIFO flush 到全新 transcript 时结构
    // 上成立；不一致（如 promote 撞上同 id 的旧 transcript）说明窗口锚与
    // 持久化错位，warn 暴露（窗口锚修正随快照消费者落地，在那之前锚无
    // 消费者、无实害）。
    for (let head = session.pendingRuns.peek(); head; head = session.pendingRuns.peek()) {
      const { runIndex } = await this.appendRunCb(conversationId, head.record);
      if (runIndex !== head.provisionalRunIndex) {
        // 锚错位 → 该会话快照降级停写：错误的覆盖边界会让启动装填
        // 重叠 / 缺漏，比没有快照更糟
        session.snapshotAnchorsTrusted = false;
        console.warn(
          `[ConversationManager.promote] runIndex 对账不一致 conv=${conversationId}: ` +
            `store=${runIndex} provisional=${head.provisionalRunIndex}（transcript 非全新？）` +
            "—— 窗口折叠锚与持久化错位，本会话快照写入已停用",
        );
      }
      session.pendingRuns.dequeue();
    }

    session.ephemeral = false;
    return true;
  }

  private async ensurePersistentConversation(
    conversationId: string,
    hasHistory: boolean,
  ): Promise<void> {
    if (this.ensureConversation) {
      await this.ensureConversation(conversationId);
      return;
    }
    if (!hasHistory && this.initTranscript) {
      await this.initTranscript(conversationId);
    }
  }

  // ─── Pending Queue ───

  /**
   * 将任务入队。如果 conversation 不忙则返回 "immediate"（调用方应直接执行）。
   * 队列满时返回 "full"。正常入队返回 "queued"。
   */
  enqueue(conversationId: string, task: PendingTask): "immediate" | "queued" | "full" {
    const session = this.sessions.get(conversationId);
    if (!session) return "full";

    if (!session.busy) {
      return "immediate";
    }

    const queue = this.pendingQueues.get(conversationId) ?? [];
    if (queue.length >= this.maxPending) {
      return "full";
    }

    queue.push(task);
    this.pendingQueues.set(conversationId, queue);
    return "queued";
  }

  pendingCount(conversationId: string): number {
    return this.pendingQueues.get(conversationId)?.length ?? 0;
  }

  private dequeueNext(conversationId: string): void {
    const queue = this.pendingQueues.get(conversationId);
    if (!queue || queue.length === 0) return;

    const task = queue.shift()!;
    if (queue.length === 0) {
      this.pendingQueues.delete(conversationId);
    }

    const session = this.sessions.get(conversationId);
    if (!session) {
      task.cancel();
      return;
    }

    session.busy = true;
    session.lastActiveAt = new Date().toISOString();
    this.clearGraceTimer(conversationId);
    void task.execute();
  }

  private clearPendingQueue(conversationId: string): void {
    const queue = this.pendingQueues.get(conversationId);
    if (!queue) return;
    for (const task of queue) {
      task.cancel();
    }
    this.pendingQueues.delete(conversationId);
  }

  /**
   * 删除对话——活跃运行时释放 + 落盘数据删除(经注入 removeDisk),与 clear /
   * compact 同一 per-conversation 生命周期串行,两层互斥各司其职:
   *
   * - **busy 拒绝**(承载不变量):活跃会话有 in-flight turn 时返回 "busy"。
   *   不可拔掉在飞会话——`runtime.dispose` 只是末窗收尾、不 abort/drain,
   *   delete 后会话移出活跃集,而 in-flight turn 末尾的 `session.complete`
   *   走 observer 组播查的是已删会话的空名册 → 发起端的 sendTurn 永等不到
   *   complete 而挂死。须先 abort(发起端经 in-flight cleanup 拿到 complete、
   *   pending 各 cancel),再删。
   * - **id 串行门**(withIdLock):盘删与同 id 的 getOrCreate 激活
   *   (doCreate/loadHistory)严格 FIFO——杜绝"删盘途中被装填半截 / 删盘后又被
   *   一次 send 孤儿重建在已删存储上"。这是与 clear 同源的 run 外写竞态闭合。
   *
   * `onDeleted` 在删除成功后、observer 名册清理前回调,供 RPC 组播 deleted。
   *
   * 返回:true(活跃释放或盘删任一成功)/ false(均无,对话不存在)/ "busy"。
   */
  async delete(
    conversationId: string,
    opts?: {
      removeDisk?: () => Promise<boolean>;
      onDeleted?: () => void;
    },
  ): Promise<boolean | "busy"> {
    if (this.deleting.has(conversationId)) return "busy";

    // 活跃快路:同步占用 busy(check 与 set 间无 await——这是并发 send 立即见忙
    // 排队的关键,避免在"已广播 deleted / 正在 dispose"的半死会话上以 immediate
    // 启动新 turn)。busy 占用后,会话直到本删除把它移出 sessions 前不会被另一
    // 删除/clear 抢占(它们同步见 busy 即 "busy")。
    const activeNow = this.sessions.get(conversationId);
    if (activeNow) {
      if (activeNow.busy) return "busy";
      activeNow.busy = true;
    }
    this.deleting.add(conversationId);

    // id 门:终结的盘删与同 id 的 getOrCreate 激活严格 FIFO。活跃会话删除
    // 期间仍留在 sessions 里但已 busy,并发 send 只能排队;盘删成功后统一取消
    // 队列,盘删失败则释放 busy 让队列继续,避免"删盘失败但运行体已丢"。
    try {
      return await this.withIdLock(conversationId, async () => {
        // 必须在锁内重读:delete 可能排在 getOrCreate/doCreate 后面,入口处
        // 尚无 active session,但门内已经有刚创建出的 session 等待终结。
        const session = this.sessions.get(conversationId);
        if (session) {
          session.busy = true;
          // busy 自快路起一直持有——会话保证仍在;async 终结全程并发 send 排队。
          this.clearGraceTimer(conversationId);
        }

        const removed = (await opts?.removeDisk?.()) ?? false;
        const deleted = !!session || removed;
        if (!deleted) return false;

        if (session) {
          this.detachFromHub(conversationId);
          // 末窗 onWindowClose（serve main runtime 销毁）—— await 让 flush 完成;
          // 失败不阻断删除（与销毁链"不阻断"语义一致）。
          try {
            await session.runtime.dispose();
          } catch (err) {
            console.error("[ConversationManager.delete] runtime.dispose failed:", err);
          }
          this.sessions.delete(conversationId);
          // 终结态与维护态(clear/compact)的释放语义不同:维护态 setBusy(false)
          // 把排队 send dequeue 到新窗口继续;删除态会话已不存在,排队 send 必须
          // 取消——cancel 钩子向发起端发 complete(error),不留 sendTurn 挂死。
          this.clearPendingQueue(conversationId);
        }

        opts?.onDeleted?.();
        this.observers.delete(conversationId);
        return true;
      });
    } catch (err) {
      // removeDisk 是 delete 的事实边界。它失败时不能终结运行体,否则 RPC 层
      // 会看到"删除失败",但 owner 已丢 active session。恢复 busy 后让 delete
      // 期间排队的 turn 正常继续。
      const session = this.sessions.get(conversationId);
      if (session?.busy) {
        this.deleting.delete(conversationId);
        this.setBusy(conversationId, false);
      }
      throw err;
    } finally {
      this.deleting.delete(conversationId);
    }
  }

  /** 释放所有运行时资源（Server 关闭时调用）。async —— 透传各会话末窗 onWindowClose。 */
  async disposeAll(): Promise<void> {
    const queueIds = [...this.pendingQueues.keys()];
    for (const id of queueIds) {
      this.clearPendingQueue(id);
    }
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.deleting.clear();
    if (this.idleInterval) {
      clearInterval(this.idleInterval);
      this.idleInterval = null;
    }
    for (const [id, session] of this.sessions) {
      try {
        this.detachFromHub(id);
        await session.runtime.dispose();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.attachedBrokers.clear();
    this.observers.clear();
  }

  // ─── Grace Period ───

  private startGraceTimer(conversationId: string): void {
    this.clearGraceTimer(conversationId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(conversationId);
      void this.releaseIfEmpty(conversationId, "grace");
    }, this.graceTimeoutMs);
    // 不阻止进程退出
    if (timer.unref) timer.unref();
    this.graceTimers.set(conversationId, timer);
  }

  private clearGraceTimer(conversationId: string): void {
    const timer = this.graceTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(conversationId);
    }
  }

  private async releaseIfEmpty(
    conversationId: string,
    reason: "grace" | "idle",
  ): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (this.getObserverCount(conversationId) > 0 || session.busy) return;
    this.clearPendingQueue(conversationId);
    this.detachFromHub(conversationId);
    try {
      await session.runtime.dispose();
    } catch (err) {
      console.error(
        "[ConversationManager.releaseIfEmpty] runtime.dispose failed:",
        err,
      );
    }
    this.sessions.delete(conversationId);
    this.maybeDropEmptyObserverSet(conversationId);
    this.onRelease?.(conversationId, reason);
  }

  // ─── Idle Reaper ───

  private startIdleReaper(intervalMs: number): void {
    this.idleInterval = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];
      for (const [id, session] of this.sessions) {
        if (session.busy) continue;
        const lastActive = new Date(session.lastActiveAt).getTime();
        if (now - lastActive > this.idleTimeoutMs) {
          expired.push(id);
        }
      }
      // setInterval 回调本身 sync —— 末窗 onWindowClose 的 await 收敛到 reapExpired,
      // void 化（后台收割,失败逐项吞 + log,不让 unhandled rejection 逃逸）。
      void this.reapExpired(expired);
    }, intervalMs);
    if (this.idleInterval.unref) this.idleInterval.unref();
  }

  private async reapExpired(expired: string[]): Promise<void> {
    for (const id of expired) {
      this.clearPendingQueue(id);
      this.clearGraceTimer(id);
      const session = this.sessions.get(id);
      if (session) {
        this.detachFromHub(id);
        try {
          await session.runtime.dispose();
        } catch (err) {
          console.error(
            "[ConversationManager.idleReaper] runtime.dispose failed:",
            err,
          );
        }
        this.sessions.delete(id);
        this.maybeDropEmptyObserverSet(id);
        this.onRelease?.(id, "idle");
      }
    }
  }
}

// ─── ID 生成 ───

export function generateConversationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `conv_${ts}_${rand}`;
}
