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

import type { SessionRuntime, RuntimeFactory } from "./types.js";

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
}

// ─── 释放事件回调 ───

export type OnSessionRelease = (conversationId: string, reason: "grace" | "idle") => void;

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

  constructor(
    factory: RuntimeFactory,
    config?: ConversationManagerConfig,
    onRelease?: OnSessionRelease,
  ) {
    this.factory = factory;
    this.graceTimeoutMs = config?.graceTimeoutMs ?? DEFAULT_GRACE_TIMEOUT_MS;
    this.idleTimeoutMs = config?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxPending = config?.maxPending ?? DEFAULT_MAX_PENDING;
    this.onRelease = onRelease;
    this.startIdleReaper(config?.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * 获取或创建托管会话。
   *
   * - 传 conversationId 且已存在 → 返回现有会话
   * - 传 conversationId 但不存在 → 通过 factory 创建
   * - 不传 → 自动生成 ID 并创建
   */
  async getOrCreate(conversationId?: string): Promise<ManagedSession> {
    if (conversationId && this.sessions.has(conversationId)) {
      const session = this.sessions.get(conversationId)!;
      session.lastActiveAt = new Date().toISOString();
      this.clearGraceTimer(conversationId);
      return session;
    }

    const id = conversationId ?? generateConversationId();

    const inflight = this.creating.get(id);
    if (inflight) return inflight;

    const promise = this.doCreate(id);
    this.creating.set(id, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(id);
    }
  }

  private async doCreate(id: string): Promise<ManagedSession> {
    const runtime = await this.factory.create(id);
    const now = new Date().toISOString();

    const session: ManagedSession = {
      conversationId: id,
      runtime,
      createdAt: now,
      lastActiveAt: now,
      busy: false,
      observers: new Set(),
    };

    this.sessions.set(id, session);
    return session;
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
    for (const session of this.sessions.values()) {
      try {
        session.runtime.dispose();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
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
