/**
 * RuntimeRegistry — 服务级运行时注册表
 *
 * 职责：
 * - 按 sessionId 管理 SessionRuntime 实例
 * - 跟踪每个运行时的活跃状态（busy）和元信息（消息数、时间戳）
 * - getOrCreate 语义：传 sessionId 则查找/创建，不传则新建
 * - 提供 list 用于 session.list RPC
 */

import type { SessionRuntime, RuntimeFactory, RuntimeInfo } from "./types.js";

interface Entry {
  runtime: SessionRuntime;
  createdAt: string;
  lastActiveAt: string;
  busy: boolean;
}

export class RuntimeRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly factory: RuntimeFactory;

  constructor(factory: RuntimeFactory) {
    this.factory = factory;
  }

  async getOrCreate(sessionId?: string): Promise<SessionRuntime> {
    if (sessionId && this.entries.has(sessionId)) {
      const entry = this.entries.get(sessionId)!;
      entry.lastActiveAt = new Date().toISOString();
      return entry.runtime;
    }

    const id = sessionId ?? generateSessionId();
    const runtime = await this.factory.create(id);
    const now = new Date().toISOString();
    this.entries.set(id, {
      runtime,
      createdAt: now,
      lastActiveAt: now,
      busy: false,
    });
    return runtime;
  }

  get(sessionId: string): SessionRuntime | undefined {
    return this.entries.get(sessionId)?.runtime;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  list(): RuntimeInfo[] {
    return [...this.entries.entries()].map(([sessionId, entry]) => ({
      sessionId,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      messageCount: entry.runtime.getHistory().length,
      busy: entry.busy,
    }));
  }

  /** 标记运行时为 busy 状态（session.send 内部调用） */
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
    entry.runtime.abort();
    return true;
  }

  delete(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    entry.runtime.dispose();
    this.entries.delete(sessionId);
    return true;
  }

  /** 释放所有运行时资源（Server 关闭时调用） */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.runtime.dispose();
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
