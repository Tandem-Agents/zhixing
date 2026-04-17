/**
 * SessionRegistry — 服务级会话注册表
 *
 * 职责：
 * - 按 sessionId 管理 ServerSession 实例
 * - 跟踪每个会话的活跃状态（busy）和元信息（消息数、时间戳）
 * - getOrCreate 语义：传 sessionId 则查找/创建，不传则新建
 * - 提供 list 用于 session.list RPC
 *
 * 设计要点：
 * - 内存存储（持久化在 ServerSession 内部各自负责）
 * - sessionId 由调用方传入或自动生成（避免冲突）
 * - dispose 释放所有会话资源
 */

import type { ServerSession, SessionFactory, SessionInfo } from "./types.js";

interface Entry {
  session: ServerSession;
  createdAt: string;
  lastActiveAt: string;
  busy: boolean;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly factory: SessionFactory;

  constructor(factory: SessionFactory) {
    this.factory = factory;
  }

  async getOrCreate(sessionId?: string): Promise<ServerSession> {
    if (sessionId && this.entries.has(sessionId)) {
      const entry = this.entries.get(sessionId)!;
      entry.lastActiveAt = new Date().toISOString();
      return entry.session;
    }

    const id = sessionId ?? generateSessionId();
    const session = await this.factory.create(id);
    const now = new Date().toISOString();
    this.entries.set(id, {
      session,
      createdAt: now,
      lastActiveAt: now,
      busy: false,
    });
    return session;
  }

  get(sessionId: string): ServerSession | undefined {
    return this.entries.get(sessionId)?.session;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  list(): SessionInfo[] {
    return [...this.entries.entries()].map(([sessionId, entry]) => ({
      sessionId,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      messageCount: entry.session.getHistory().length,
      busy: entry.busy,
    }));
  }

  /** 标记会话为 busy 状态（session.send 内部调用） */
  setBusy(sessionId: string, busy: boolean): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.busy = busy;
    if (busy) {
      entry.lastActiveAt = new Date().toISOString();
    }
  }

  abort(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.session.abort();
    return true;
  }

  delete(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.session.dispose();
    this.entries.delete(sessionId);
    return true;
  }

  /** 释放所有会话资源（Server 关闭时调用） */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.session.dispose();
      } catch {
        // ignore
      }
    }
    this.entries.clear();
  }
}

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `sess_${ts}_${rand}`;
}
