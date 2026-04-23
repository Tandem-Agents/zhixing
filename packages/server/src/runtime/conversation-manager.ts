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

import type { Message, Turn } from "@zhixing/core";
import type { SessionRuntime, RuntimeFactory } from "./types.js";
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
  /** ephemeral 模式下累积的待持久化 turns */
  readonly pendingTurns: Turn[];
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

/** 持久化单个 turn 的回调。由外部注入（如 TranscriptStore.appendTurn）。 */
export type PersistTurn = (conversationId: string, turn: Turn) => Promise<void>;

export interface ConversationManagerCallbacks {
  onRelease?: OnSessionRelease;
  loadHistory?: LoadHistory;
  initTranscript?: InitTranscript;
  persistTurn?: PersistTurn;
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
  private readonly persistTurn?: PersistTurn;
  private readonly confirmationHub?: ConfirmationHub;
  /** conversationId 集合——已 attach 到 hub 的会话，用于 dispose 前反查 + 防重 */
  private readonly attachedBrokers = new Set<string>();

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
      this.persistTurn = callbacksOrOnRelease.persistTurn;
      this.confirmationHub = callbacksOrOnRelease.confirmationHub;
    } else if (loadHistory) {
      this.loadHistory = loadHistory;
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
    }
  }

  abort(conversationId: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    session.runtime.abort();
    return true;
  }

  // ─── Turn 记录 + 晋升 ───

  /**
   * 记录一个完成的 turn。
   * - persistent → 立即调用 persistTurn 回调
   * - ephemeral → 累积到 pendingTurns，turnCount >= 2 时自动晋升
   */
  async recordTurn(conversationId: string, turn: Turn): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;

    if (session.ephemeral) {
      session.pendingTurns.push(turn);
      session.turnCount++;
      if (session.turnCount >= 2) {
        await this.promote(conversationId);
      }
    } else {
      if (this.persistTurn) {
        await this.persistTurn(conversationId, turn);
      }
      session.turnCount++;
    }
  }

  /**
   * 将 ephemeral 会话晋升为 persistent。
   * 调用 initTranscript → 逐个 flush pendingTurns → 标记 ephemeral=false。
   */
  async promote(conversationId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!session || !session.ephemeral) return false;

    if (!session.transcriptInited && this.initTranscript) {
      await this.initTranscript(conversationId);
      session.transcriptInited = true;
    }

    if (this.persistTurn) {
      while (session.pendingTurns.length > 0) {
        await this.persistTurn(conversationId, session.pendingTurns[0]!);
        session.pendingTurns.shift();
      }
    } else {
      session.pendingTurns.length = 0;
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

  delete(conversationId: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    this.clearPendingQueue(conversationId);
    this.clearGraceTimer(conversationId);
    this.detachFromHub(conversationId);
    session.runtime.dispose();
    this.sessions.delete(conversationId);
    return true;
  }

  /** 释放所有运行时资源（Server 关闭时调用） */
  disposeAll(): void {
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
        session.runtime.dispose();
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
      this.releaseIfEmpty(conversationId, "grace");
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

  private releaseIfEmpty(conversationId: string, reason: "grace" | "idle"): void {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (session.observers.size > 0 || session.busy) return;
    this.clearPendingQueue(conversationId);
    this.detachFromHub(conversationId);
    session.runtime.dispose();
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
      for (const id of expired) {
        this.clearPendingQueue(id);
        this.clearGraceTimer(id);
        const session = this.sessions.get(id);
        if (session) {
          this.detachFromHub(id);
          session.runtime.dispose();
          this.sessions.delete(id);
          this.onRelease?.(id, "idle");
        }
      }
    }, intervalMs);
    if (this.idleInterval.unref) this.idleInterval.unref();
  }
}

// ─── ID 生成 ───

function generateConversationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `conv_${ts}_${rand}`;
}
