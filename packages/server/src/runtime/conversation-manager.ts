/**
 * ConversationManager — 对话运行时生命周期管理
 *
 * 规格引用：conversation-model.md §4 (SessionRuntime) + §8 (ConversationManager)
 *
 * 替代 RuntimeRegistry，在其基础上增加：
 * - Observer 跟踪：多个连接可共享同一个 SessionRuntime
 * - Grace Period：最后一个 observer 断开后等待 60s 再释放
 * - Idle Timeout：30 分钟无活动自动释放（防止内存泄漏）
 *
 * 设计原则：
 * - 纯运行时关注：管理 SessionRuntime 生命周期，不直接操作持久层
 * - 依赖注入：RuntimeFactory 由外部提供（CLI 或测试）
 * - Drop-in 替代：与 RuntimeRegistry 相同的核心 API（getOrCreate/list/abort/delete）
 * - 可测试：grace/idle 超时可通过配置注入
 */

import {
  windowCompactFromMarker,
  type AbortReason,
  type CompactMarker,
  type Message,
  type Turn,
} from "@zhixing/core";
import type { AbortResult, SessionRuntime, RuntimeFactory } from "./types.js";
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
   * ephemeral 模式下累积的待持久化 turns —— 持久化的 append-only 镜像，
   * 只追加、不因压缩截断（压缩是窗口的视图操作，原文不动）；promote 时
   * 按序平铺落盘。
   */
  pendingTurns: Turn[];
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

/** 加载对话历史的回调。返回 undefined 表示无历史可加载。 */
export type LoadHistory = (conversationId: string) => Promise<Message[] | undefined>;

/** 新对话首次创建时的初始化回调（如写入 transcript header）。 */
export type InitTranscript = (conversationId: string) => Promise<void>;

/**
 * 原子提交 turn / compact / 两者的回调。
 *
 * 对应 `ITranscriptStore.commitTurn` 的签名：
 *   - `{turn}` → append 新 turn
 *   - `{turn, compactBefore}` → 原子重写 + 追加 turn（按 turnsCompacted 截断）
 *   - `{compactBefore}` → 原子重写（无新 turn）
 *
 * 返回值（canonical）不再被消费 —— 内存状态由注意力窗口经接受协议自行前进
 * （recordTurn 在落盘成功后调 `session.runtime.acceptRun`），不从持久化回喂。
 * 签名保持与 store API 一致，待 store 重写时一并收敛。
 */
export type CommitTurn = (
  conversationId: string,
  payload: { turn?: Turn; compactBefore?: CompactMarker },
) => Promise<Message[]>;

export interface ConversationManagerCallbacks {
  onRelease?: OnSessionRelease;
  loadHistory?: LoadHistory;
  initTranscript?: InitTranscript;
  /**
   * 原子持久化入口 —— 替代旧 `persistTurn`。
   *
   * recordTurn 内部调用此回调落盘，成功后经 SessionRuntime.acceptRun 推进窗口
   * （返回值不再被消费）。
   *
   * **配置契约（构造函数守卫）**：
   *   - 纯 ephemeral-only 场景（未提供 loadHistory / initTranscript）：可省略
   *   - 任何持久化意图场景（提供了 loadHistory 或 initTranscript）：**必须提供**
   *     constructor 检测到"部分配置"立即 throw —— 避免配置错误静默失败
   *     （persistent 分支丢消息、promote 错误晋升）。
   *
   * 运行时契约：recordTurn 的 persistent 分支 / promote 在 `!commitTurn` 时
   * 不再静默降级 —— 前者 throw，后者 return false 保持 ephemeral。
   */
  commitTurn?: CommitTurn;
  /**
   * 可选 ConfirmationHub —— 提供时每个新建会话的 runtime.confirmationBroker 会
   * 自动 attach；会话释放（delete / grace / idle / disposeAll）前自动 detach。
   * 未提供时 ConversationManager 行为完全等价。
   *
   * 参见 remote-confirmation-execution.md §3.2。
   */
  confirmationHub?: ConfirmationHub;
}

// ─── 待处理任务 ───

export interface PendingTask {
  execute: () => Promise<void>;
  cancel: () => void;
}

// ─── ConversationManager ───

export class ConversationManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creating = new Map<string, Promise<ManagedSession>>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingQueues = new Map<string, PendingTask[]>();
  private idleInterval: ReturnType<typeof setInterval> | null = null;

  private readonly factory: RuntimeFactory;
  private readonly graceTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxPending: number;
  private readonly onRelease?: OnSessionRelease;
  private readonly loadHistory?: LoadHistory;
  private readonly initTranscript?: InitTranscript;
  private readonly commitTurnCb?: CommitTurn;
  private readonly confirmationHub?: ConfirmationHub;
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
      this.commitTurnCb = callbacksOrOnRelease.commitTurn;
      this.confirmationHub = callbacksOrOnRelease.confirmationHub;
    } else if (loadHistory) {
      this.loadHistory = loadHistory;
    }

    // 配置守卫：部分配置即配置错误 —— 提供了持久化信号（loadHistory / initTranscript）
    // 但没提供 commitTurn，会导致 recordTurn 的 persistent 分支静默丢消息
    // （adapter.messages 缺本轮 assistant 回复）。fail-fast 在构造阶段暴露。
    const hasPersistenceIntent = !!(this.loadHistory || this.initTranscript);
    if (hasPersistenceIntent && !this.commitTurnCb) {
      throw new Error(
        "ConversationManager: `commitTurn` callback is required when `loadHistory` or `initTranscript` is provided. " +
          "Ephemeral-only usage should omit all three callbacks.",
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

    const promise = this.doCreate(id, options?.ephemeral ?? false);
    this.creating.set(id, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(id);
    }
  }

  private async doCreate(id: string, ephemeral: boolean): Promise<ManagedSession> {
    const initialMessages = ephemeral ? undefined : await this.loadHistory?.(id);
    if (!initialMessages && !ephemeral && this.initTranscript) {
      await this.initTranscript(id);
    }
    const runtime = await this.factory.create(id, initialMessages);
    const now = new Date().toISOString();

    const session: ManagedSession = {
      conversationId: id,
      runtime,
      createdAt: now,
      lastActiveAt: now,
      busy: false,
      observers: new Set(),
      turnCount: initialMessages
        ? initialMessages.filter(m => m.role === "user").length
        : 0,
      ephemeral,
      transcriptInited: !ephemeral,
      pendingTurns: [],
    };

    this.sessions.set(id, session);
    this.attachToHub(id, runtime);
    return session;
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

  /**
   * 添加观察者连接。清除任何挂起的 grace timer。
   * 返回 false 表示会话不存在。
   */
  addObserver(conversationId: string, connectionId: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    session.observers.add(connectionId);
    this.clearGraceTimer(conversationId);
    return true;
  }

  /**
   * 移除观察者连接。如果没有剩余观察者且不在 busy 状态，启动 grace timer。
   */
  removeObserver(conversationId: string, connectionId: string): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.observers.delete(connectionId);
    if (session.observers.size === 0 && !session.busy) {
      this.startGraceTimer(conversationId);
    }
  }

  /**
   * 断开某个连接在所有会话上的观察。
   * 典型场景：WebSocket 断开时批量清理。
   */
  removeObserverFromAll(connectionId: string): void {
    for (const [convId, session] of this.sessions) {
      if (session.observers.has(connectionId)) {
        session.observers.delete(connectionId);
        if (session.observers.size === 0 && !session.busy) {
          this.startGraceTimer(convId);
        }
      }
    }
  }

  /** 查询会话的当前观察者数量 */
  getObserverCount(conversationId: string): number {
    return this.sessions.get(conversationId)?.observers.size ?? 0;
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
    return this.sessions.get(conversationId)?.observers ?? EMPTY_OBSERVER_SET;
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

  list(): ManagedSessionInfo[] {
    return [...this.sessions.entries()].map(([id, s]) => ({
      conversationId: id,
      sessionId: s.runtime.sessionId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      messageCount: s.runtime.getHistory().length,
      busy: s.busy,
      observerCount: s.observers.size,
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
      } else if (session.observers.size === 0) {
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

  // ─── Turn 记录 + 晋升（单向数据流） ───

  /**
   * 记录一个完成的 turn，并可选地应用本 run 的 compact 边界。
   *
   * 接受协议："先持久化（或 pending 入列）成功、后窗口前进"——成功后调
   * `session.runtime.acceptRun`，窗口应用 windowCompact 折叠并追加本 run
   * 蒸馏对。失败路径不触窗口：内存停在原基底，下轮重试，无需回滚。
   *
   * 压缩与持久化的分界：compactBefore 只驱动**窗口折叠**（注意力视图）；
   * 持久化（磁盘 / pending）是 append-only 原文，永不因压缩变短——被摘
   * 内容仍完整躺在持久层上。
   *
   * 两条路径：
   *   - persistent → commitTurn 回调（原子追加原始 turn）→ acceptRun
   *   - ephemeral → pendingTurns 追加（promote 的平铺落盘原料）→ acceptRun；
   *     turnCount >= 2 自动 promote
   */
  async recordTurn(
    conversationId: string,
    turn: Turn,
    compactBefore?: CompactMarker,
  ): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;

    if (session.ephemeral) {
      // pending 入列即 ephemeral 的"持久化成功"——promote 据此 FIFO 平铺落盘
      session.pendingTurns.push(turn);
      session.turnCount++;

      session.runtime.acceptRun({
        runMessages: [turn.userMessage, turn.assistantMessage],
        windowCompact: compactBefore
          ? windowCompactFromMarker(compactBefore)
          : undefined,
      });

      if (session.turnCount >= 2) {
        await this.promote(conversationId);
      }
      return;
    }

    // persistent 分支：commitTurn 落盘成功后窗口前进
    //
    // 构造函数已守卫 "有持久化意图必须有 commitTurn"；此处的 assert 是 defense-in-depth ——
    // 防止有人构造时通过 `undefined as any` 等方式绕过类型检查后在运行时 bite。
    // 不再静默降级（老实现 `if (cb) { ... }` 会让 adapter 丢本轮 assistant）。
    if (!this.commitTurnCb) {
      throw new Error(
        `ConversationManager.recordTurn: persistent session ${conversationId} requires commitTurn callback ` +
          "(was this manager constructed without commitTurn while the session is not ephemeral?)",
      );
    }
    await this.commitTurnCb(conversationId, { turn });
    session.runtime.acceptRun({
      runMessages: [turn.userMessage, turn.assistantMessage],
      windowCompact: compactBefore
        ? windowCompactFromMarker(compactBefore)
        : undefined,
    });
    session.turnCount++;
  }

  /**
   * 将 ephemeral 会话晋升为 persistent —— 把 pending 的原始 turns 按序
   * 平铺落盘（append-only，无任何压缩边界参与）。
   *
   * 不触窗口 —— ephemeral 期间窗口已随每次 recordTurn 的接受协议前进；
   * 窗口是压缩视图、持久化是全量原文，二者本就允许分叉，晋升无需同步。
   */
  async promote(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!session || !session.ephemeral) return false;

    if (!session.transcriptInited && this.initTranscript) {
      await this.initTranscript(conversationId);
      session.transcriptInited = true;
    }

    // 无 commitTurn 回调：保持 ephemeral 状态，不晋升。
    //
    // 老实现 `else { pendingTurns = []; }` 然后落到 `ephemeral = false` 会导致：
    //   1. 本次调用已清空 pending，数据丢失
    //   2. 更严重：ephemeral=false 使后续 recordTurn 走 persistent 分支，
    //      persistent 分支又 throw（见 recordTurn 的 assert）—— 彻底卡死
    // 返 false 告知调用方"未晋升"，保留 pendingTurns 供后续真正配置了 commitTurn
    // 的新 manager 处理（或允许会话继续作为 ephemeral 运行）。
    if (!this.commitTurnCb) {
      return false;
    }

    // 逐个 flush：shift 只在单次 commitTurn 成功后执行 —— 任意中间失败 rethrow
    // 时保留未持久化的 pending（retry 安全）。
    while (session.pendingTurns.length > 0) {
      const first = session.pendingTurns[0]!;
      await this.commitTurnCb(conversationId, { turn: first });
      session.pendingTurns.shift();
    }

    session.ephemeral = false;
    return true;
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

  async delete(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    this.clearPendingQueue(conversationId);
    this.clearGraceTimer(conversationId);
    this.detachFromHub(conversationId);
    // 末窗 onWindowClose（serve main runtime 销毁）—— await 让 flush 完成;失败
    // 不阻断删除（与销毁链"不阻断"语义一致）。
    try {
      await session.runtime.dispose();
    } catch (err) {
      console.error("[ConversationManager.delete] runtime.dispose failed:", err);
    }
    this.sessions.delete(conversationId);
    return true;
  }

  /** 释放所有运行时资源（Server 关闭时调用）。async —— 透传各会话末窗 onWindowClose。 */
  async disposeAll(): Promise<void> {
    const queueIds = [...this.pendingQueues.keys()];
    for (const id of queueIds) {
      this.clearPendingQueue(id);
    }
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
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
    if (session.observers.size > 0 || session.busy) return;
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
        this.onRelease?.(id, "idle");
      }
    }
  }
}

// ─── ID 生成 ───

function generateConversationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `conv_${ts}_${rand}`;
}
