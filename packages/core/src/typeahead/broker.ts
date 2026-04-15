/**
 * DefaultTypeaheadBroker —— Typeahead 输入补全的核心调度器
 *
 * 职责（spec §5.5）：
 *   1. Provider 注册 + 按 priority 升序遍历分派
 *   2. Session 生命周期管理（beginSession / updateInput / accept / cancel）
 *   3. `updateInput` 每次触发 matchTrigger → query，**abort 前次 async 查询**
 *   4. 维护零键执行不变量（spec §6.5）：suggestions 非空时 selectedIndex 重置到 0
 *   5. Provider 异常降级到空 suggestions，不传染到 renderer
 *   6. 发射 typeahead:* 事件到注入的 EventSink
 *   7. `accept` 把 SuggestionItem 翻译成 AcceptResult（新 draft + cursor + execute）
 *
 * 与 ConfirmationBroker 的异同（spec §4.3 架构同构）：
 *   - **同构部分**：单例 broker、provider 注册、onSessionChange 订阅、EventBus 发射
 *   - **差异部分**：
 *     - confirmation 是"一次性请求"，typeahead 是"会话持续更新"
 *     - confirmation 有 FIFO 队列，typeahead 一次只有一个 active session
 *     - confirmation 阻塞上层（await broker.requestConfirmation），typeahead 非阻塞
 *
 * 并发模型：单线程 Node.js。`updateInput` 的串行由事件循环保证。多个 async
 * query 同时在飞时用 AbortController 取消过期 + 双重 stale 检查兜底。
 */

import { randomUUID } from "node:crypto";
import {
  noopEventSink,
  type TypeaheadEvent,
  type TypeaheadEventSink,
} from "./events.js";
import type {
  AcceptResult,
  ITypeaheadBroker,
  SuggestionItem,
  SuggestionProvider,
  TriggerContext,
  TriggerMatch,
  TypeaheadBrokerSnapshot,
  TypeaheadSessionHandle,
  TypeaheadSessionState,
  Unregister,
  Unsubscribe,
} from "./types.js";

// ─── 选项 ───

export interface TypeaheadBrokerOptions {
  /** 事件 sink（通常是 CLI 的 EventBus 适配器）。缺省：noop */
  readonly eventSink?: TypeaheadEventSink;
  /** 时钟注入（事件时间戳） */
  readonly now?: () => number;
  /** 单次 query 的超时（ms）；超时后自动 abort 并发送 query-aborted 事件 */
  readonly queryTimeoutMs?: number;
  /** Provider 失败的额外日志 hook（事件 sink 之外） */
  readonly onProviderError?: (providerId: string, error: Error) => void;
}

const DEFAULT_QUERY_TIMEOUT_MS = 3000;

// ─── 内部会话状态 ───

interface InternalSession {
  readonly id: string;
  /** 最近一次 updateInput 给的 ctx，snapshot 持有以便 accept 时重放 */
  lastContext: TriggerContext;
  /** 当前对外的派生 state */
  state: TypeaheadSessionState;
  /** 当前飞行中的 query 对应的 abort controller */
  inflightAbort: AbortController | null;
  /** 订阅者 */
  listeners: Set<(state: TypeaheadSessionState) => void>;
  /** 单调递增的 query token，用于双重 stale 检查 */
  queryToken: number;
}

// ─── 实现 ───

export class DefaultTypeaheadBroker implements ITypeaheadBroker {
  private readonly providers: SuggestionProvider[] = [];
  private readonly sessions = new Map<string, InternalSession>();

  private readonly eventSink: TypeaheadEventSink;
  private readonly now: () => number;
  private readonly queryTimeoutMs: number;
  private readonly onProviderError: (providerId: string, error: Error) => void;

  constructor(options: TypeaheadBrokerOptions = {}) {
    this.eventSink = options.eventSink ?? noopEventSink;
    this.now = options.now ?? (() => Date.now());
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.onProviderError = options.onProviderError ?? (() => {});
  }

  // ─── Provider 注册 ───

  register(provider: SuggestionProvider): Unregister {
    if (this.providers.some((p) => p.id === provider.id)) {
      throw new Error(
        `TypeaheadBroker: duplicate provider id "${provider.id}"`,
      );
    }
    this.providers.push(provider);
    // 按 priority 升序保持数组有序（同 priority 按注册顺序）
    this.providers.sort((a, b) => a.priority - b.priority);
    return () => {
      const idx = this.providers.findIndex((p) => p.id === provider.id);
      if (idx !== -1) this.providers.splice(idx, 1);
    };
  }

  listProviders(): readonly SuggestionProvider[] {
    return this.providers.slice();
  }

  // ─── Session 生命周期 ───

  beginSession(initial: TriggerContext): TypeaheadSessionHandle {
    const id = randomUUID();
    const session: InternalSession = {
      id,
      lastContext: initial,
      state: makeEmptyState(id),
      inflightAbort: null,
      listeners: new Set(),
      queryToken: 0,
    };
    this.sessions.set(id, session);

    this.emit({
      type: "typeahead:session-started",
      sessionId: id,
      timestamp: this.now(),
    });

    // 首个 updateInput 同步触发一次 match 检测
    this.updateInput(id, initial);

    return { id };
  }

  updateInput(sessionId: string, ctx: TriggerContext): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastContext = ctx;

    // 取消前次 query（如果还在飞）
    if (session.inflightAbort) {
      session.inflightAbort.abort();
      session.inflightAbort = null;
    }

    // 按优先级遍历 providers 找第一个命中
    const matchResult = this.findFirstMatch(ctx);

    if (!matchResult) {
      // 无 trigger 命中 —— 清空 session state
      const hadTrigger = session.state.trigger !== null;
      if (hadTrigger) {
        this.emit({
          type: "typeahead:trigger-cleared",
          sessionId,
          timestamp: this.now(),
          previousProviderId: session.state.activeProvider?.id ?? null,
        });
      }
      this.setSessionState(session, makeEmptyState(sessionId));
      return;
    }

    const { provider, match } = matchResult;

    // trigger 变化：发 trigger-detected 事件
    const isNewTrigger =
      session.state.trigger === null ||
      session.state.activeProvider?.id !== provider.id ||
      session.state.trigger.tokenStart !== match.tokenStart;

    if (isNewTrigger) {
      this.emit({
        type: "typeahead:trigger-detected",
        sessionId,
        timestamp: this.now(),
        providerId: provider.id,
        trigger: match,
      });
    }

    // 启动新的 query（同步或异步）
    this.runQuery(session, provider, match);
  }

  /** 找第一个 matchTrigger 返回非 null 的 provider */
  private findFirstMatch(
    ctx: TriggerContext,
  ): { provider: SuggestionProvider; match: TriggerMatch } | null {
    for (const provider of this.providers) {
      try {
        const match = provider.matchTrigger(ctx);
        if (match) return { provider, match };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleProviderError(provider.id, error);
      }
    }
    return null;
  }

  /**
   * 执行一次 query。
   * - 同步结果立即更新 session
   * - 异步结果用 AbortController + query token 双重 stale 检查
   */
  private runQuery(
    session: InternalSession,
    provider: SuggestionProvider,
    match: TriggerMatch,
  ): void {
    const token = ++session.queryToken;
    const abort = new AbortController();
    session.inflightAbort = abort;

    const startTime = this.now();

    this.emit({
      type: "typeahead:query-started",
      sessionId: session.id,
      timestamp: startTime,
      providerId: provider.id,
      query: match.query,
    });

    // 超时自动 abort
    const timer = setTimeout(() => abort.abort(), this.queryTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    let result: SuggestionItem[] | Promise<SuggestionItem[]>;
    try {
      result = provider.query(match, abort.signal);
    } catch (err) {
      clearTimeout(timer);
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleProviderError(provider.id, error);
      this.setLoadingFinished(session, provider, match, []);
      return;
    }

    // 同步返回：立即更新
    if (Array.isArray(result)) {
      clearTimeout(timer);
      this.setLoadingFinished(session, provider, match, result);
      this.emit({
        type: "typeahead:query-completed",
        sessionId: session.id,
        timestamp: this.now(),
        providerId: provider.id,
        query: match.query,
        suggestionCount: result.length,
        queryMs: this.now() - startTime,
      });
      return;
    }

    // 异步返回：先设 loading=true，等 Promise 结算
    this.setSessionState(session, {
      ...session.state,
      activeProvider: provider,
      trigger: match,
      suggestions: [],
      selectedIndex: -1,
      loading: true,
      stale: false,
      ghostText: null,
      argumentHint: null,
    });

    result.then(
      (items) => {
        clearTimeout(timer);
        // Stale check：此 query 已过期（新的 updateInput 来了）
        if (session.queryToken !== token) return;
        if (abort.signal.aborted) return;
        this.setLoadingFinished(session, provider, match, items);
        this.emit({
          type: "typeahead:query-completed",
          sessionId: session.id,
          timestamp: this.now(),
          providerId: provider.id,
          query: match.query,
          suggestionCount: items.length,
          queryMs: this.now() - startTime,
        });
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (session.queryToken !== token) return;
        if (abort.signal.aborted) {
          this.emit({
            type: "typeahead:query-aborted",
            sessionId: session.id,
            timestamp: this.now(),
            providerId: provider.id,
            query: match.query,
          });
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleProviderError(provider.id, error);
        this.setLoadingFinished(session, provider, match, []);
      },
    );
  }

  /**
   * Query 完成后更新 session state。
   * 关键：应用 spec §6.5 零键执行不变量 —— suggestions 非空时 selectedIndex = 0。
   */
  private setLoadingFinished(
    session: InternalSession,
    provider: SuggestionProvider,
    match: TriggerMatch,
    suggestions: readonly SuggestionItem[],
  ): void {
    const selectedIndex = suggestions.length > 0 ? 0 : -1;
    this.setSessionState(session, {
      sessionId: session.id,
      activeProvider: provider,
      trigger: match,
      suggestions,
      selectedIndex,
      loading: false,
      stale: false,
      ghostText: null, // Step 7 填充
      argumentHint: null, // Step 8 填充
    });
  }

  // ─── 选择与接受 ───

  moveSelection(sessionId: string, delta: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const len = session.state.suggestions.length;
    if (len === 0) return;
    // 循环导航（末尾下一个回到首项）
    const newIndex = ((session.state.selectedIndex + delta) % len + len) % len;
    if (newIndex === session.state.selectedIndex) return;
    this.setSessionState(session, {
      ...session.state,
      selectedIndex: newIndex,
    });
  }

  accept(sessionId: string, item: SuggestionItem): AcceptResult | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const trigger = session.state.trigger;
    if (!trigger) return null;

    const { replacement, execute, cursorOffset, executionHint, metadata } =
      item.acceptPayload;

    const draft = session.lastContext.draft;
    // 按**字符**切片，不是 UTF-16 code unit —— CJK 安全
    const chars = Array.from(draft);
    const before = chars.slice(0, trigger.tokenStart).join("");
    const after = chars.slice(trigger.tokenEnd).join("");
    const newDraft = before + replacement + after;

    // 新 cursor 位置：replacement 的末尾，或显式 cursorOffset
    const replacementChars = Array.from(replacement);
    const cursorWithinReplacement =
      cursorOffset !== undefined
        ? Math.max(0, Math.min(cursorOffset, replacementChars.length))
        : replacementChars.length;
    const newCursor = trigger.tokenStart + cursorWithinReplacement;

    const result: AcceptResult = {
      newDraft,
      newCursor,
      execute,
      executionHint,
      metadata,
    };

    this.emit({
      type: "typeahead:suggestion-accepted",
      sessionId,
      timestamp: this.now(),
      providerId: item.providerId,
      item: {
        id: item.id,
        providerId: item.providerId,
        displayText: item.displayText,
      },
      result,
    });

    // Accept 清空 session state（session 本身还活着，等下次 updateInput）
    this.setSessionState(session, makeEmptyState(sessionId));

    return result;
  }

  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.inflightAbort) {
      session.inflightAbort.abort();
      session.inflightAbort = null;
    }
    // 发最后一次 state 变化
    this.setSessionState(session, makeEmptyState(sessionId));
    this.emit({
      type: "typeahead:session-ended",
      sessionId,
      timestamp: this.now(),
      reason: "cancelled",
    });
    session.listeners.clear();
    this.sessions.delete(sessionId);
  }

  // ─── 状态查询与订阅 ───

  getState(sessionId: string): TypeaheadSessionState | null {
    return this.sessions.get(sessionId)?.state ?? null;
  }

  onSessionChange(
    sessionId: string,
    listener: (state: TypeaheadSessionState) => void,
  ): Unsubscribe {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return () => {};
    }
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  snapshot(): TypeaheadBrokerSnapshot {
    return {
      activeSessions: this.sessions.size,
      providerCount: this.providers.length,
      providers: this.providers.map((p) => ({
        id: p.id,
        priority: p.priority,
      })),
    };
  }

  // ─── 内部辅助 ───

  private setSessionState(
    session: InternalSession,
    next: TypeaheadSessionState,
  ): void {
    session.state = next;
    // 复制一份再遍历 —— 防止 listener 在回调里 unsubscribe
    const listeners = Array.from(session.listeners);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onProviderError("session-listener", error);
      }
    }
  }

  private handleProviderError(providerId: string, error: Error): void {
    this.onProviderError(providerId, error);
    this.emit({
      type: "typeahead:provider-error",
      sessionId: "",
      timestamp: this.now(),
      providerId,
      error: { name: error.name, message: error.message },
    });
  }

  private emit(event: TypeaheadEvent): void {
    try {
      this.eventSink(event);
    } catch {
      // EventSink 自己出 bug 不应影响 broker
    }
  }
}

// ─── 辅助：构造空 state ───

function makeEmptyState(sessionId: string): TypeaheadSessionState {
  return {
    sessionId,
    activeProvider: null,
    trigger: null,
    suggestions: [],
    selectedIndex: -1,
    loading: false,
    stale: false,
    ghostText: null,
    argumentHint: null,
  };
}
