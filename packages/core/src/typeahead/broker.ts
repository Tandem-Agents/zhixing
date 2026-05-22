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
  InlineActionSupport,
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
  /**
   * 额外的 word 终止符 pattern——broker 在调 provider.matchTrigger 之前注入到
   * TriggerContext.wordTerminators。语义见 `TriggerContext.wordTerminators` 注释。
   * caller（如 cli）创建 broker 时注入（如 cli 注入粘贴占位符 pattern）；
   * core 不知具体语义，只透传给 trigger matcher 当 word 边界使用。
   */
  readonly wordTerminators?: readonly RegExp[];
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
  private readonly wordTerminators: readonly RegExp[] | undefined;

  constructor(options: TypeaheadBrokerOptions = {}) {
    this.eventSink = options.eventSink ?? noopEventSink;
    this.now = options.now ?? (() => Date.now());
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    this.onProviderError = options.onProviderError ?? (() => {});
    this.wordTerminators = options.wordTerminators;
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
      state: { ...makeEmptyState(id), deletePending: null },
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

    // 启动新的 query（同步或异步）—— 传入 isNewTrigger 决定 async 路径是否需要
    // emit 初始 loading 态（仅 trigger 首次出现时；同 trigger 续 typing 不 emit，
    // 保留前次 canonical state，由 query resolve 时统一 swap）。
    this.runQuery(session, provider, match, isNewTrigger);
  }

  /** 找第一个 matchTrigger 返回非 null 的 provider */
  private findFirstMatch(
    ctx: TriggerContext,
  ): { provider: SuggestionProvider; match: TriggerMatch } | null {
    // 注入 broker-level wordTerminators 让所有 provider 共享同一 word 边界规则；
    // caller 已在 ctx 上传过则保留 caller 的（caller 优先）
    const enrichedCtx: TriggerContext =
      this.wordTerminators && !ctx.wordTerminators
        ? { ...ctx, wordTerminators: this.wordTerminators }
        : ctx;
    for (const provider of this.providers) {
      try {
        const match = provider.matchTrigger(enrichedCtx);
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
   *
   * ─── session state 双语义分层 ───
   *
   * `TypeaheadSessionState` 内部承载两类语义独立的字段：
   *
   *   **trigger 几何字段**（`trigger` / `activeProvider`）：表达"当前 draft 的
   *   typeahead token 边界"。accept() 计算 replacement 几何依赖 tokenStart /
   *   tokenEnd；UI 渲染依赖 activeProvider id。**每次 updateInput 必须立即反映
   *   新鲜值**——否则 stale typing 期间用户 accept 会产生几何错位的替换。
   *
   *   **canonical 查询结果字段**（`suggestions` / `selectedIndex` / `ghostText` /
   *   `argumentHint`）：表达"当前 trigger 下最近一次确定查询结果"。query
   *   revalidate 飞行期间**保留前次值**（stale-while-revalidate）让 UI 继续
   *   展示稳定内容，由 query resolve 时一次性 swap。
   *
   * 两类字段合并在同一个 state 对象 emit，但更新频率不同：trigger 几何每次
   * updateInput 都新鲜，canonical 仅 resolve / trigger 首次出现时变化。
   *
   * ─── emit 策略 ───
   *
   *   - **同步 provider**：1 次 `setLoadingFinished` emit（trigger + canonical
   *     同时新鲜，原子）。
   *   - **异步 provider，trigger 首次出现**（`isNewTrigger=true`，panel 从无到
   *     有）：emit 初始 empty + loading=true 让 panel 首次显示有 "loading…"
   *     反馈；resolve 时再 emit canonical → 共 2 emit。
   *   - **异步 provider，同 trigger 续 typing**（`isNewTrigger=false`）：emit
   *     trigger-refresh —— trigger 几何字段更新到新 match，canonical 字段保留
   *     前次值，`loading=false`（不在 typing 期间闪烁 "loading…" 标题污染稳定
   *     的候选展示）；resolve 时再 emit canonical → 共 2 emit。
   *
   * 配合 panel renderer "全 visible state panel 总高度恒等" 不变量，每次 emit
   * 触发的 paint chromeHeight 严格相等 → `setChromeHeight` transition=same 不
   * 触发 DECSTBM 重排，视觉零跳变。async / sync provider 差异对 UI 完全透明。
   *
   * ─── 并发与 stale ───
   *
   * 异步路径用 AbortController + queryToken 双重 stale 检查。新 updateInput
   * 进来时旧 query 的 abort 被触发 + queryToken 递增；旧 query 的 .then
   * 回调（若仍在飞）通过双重检查丢弃 stale 结果。
   */
  private runQuery(
    session: InternalSession,
    provider: SuggestionProvider,
    match: TriggerMatch,
    isNewTrigger: boolean,
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
      this.handleProviderError(provider.id, error, session.id);
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

    // 异步返回：两种 emit 形态，由 isNewTrigger 选择（详见方法 docstring "emit
    // 策略" 段）。两条路径都 emit 一次保证 listener fire → UI paint（输入框新字符
    // 可见 + trigger 几何更新）；canonical 字段则按 stale-while-revalidate 决定。
    if (isNewTrigger) {
      // Trigger 首次出现 —— canonical 无前次值可保留，初始化为 empty + loading=true
      // 让 panel 首次显示有 "loading…" 反馈。
      this.setSessionState(session, {
        sessionId: session.id,
        activeProvider: { id: provider.id },
        trigger: match,
        suggestions: [],
        selectedIndex: -1,
        loading: true,
        ghostText: null,
        argumentHint: null,
        inlineActions: {},
      });
    } else {
      // 同 trigger 续 typing —— trigger 几何更新，canonical 字段保留前次值
      // (stale-while-revalidate)；loading=false 避免 title 在 typing 期间闪烁
      // "loading…" 污染稳定的候选展示。
      this.setSessionState(session, {
        ...session.state,
        activeProvider: { id: provider.id },
        trigger: match,
        loading: false,
      });
    }

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
        this.handleProviderError(provider.id, error, session.id);
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

    // Ghost text：provider 声明 supportsGhostText + 实现了 computeGhostText 时计算
    let ghostText: import("./types.js").GhostText | null = null;
    if (
      provider.supportsGhostText &&
      typeof provider.computeGhostText === "function"
    ) {
      try {
        ghostText = provider.computeGhostText(match);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleProviderError(provider.id, error, session.id);
      }
    }

    // Argument hint：provider 实现了 computeArgumentHint 时计算
    let argumentHint: import("./types.js").ArgumentHint | null = null;
    if (typeof provider.computeArgumentHint === "function") {
      try {
        argumentHint = provider.computeArgumentHint(match);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleProviderError(provider.id, error, session.id);
      }
    }

    // Inline actions: provider 通过 computeInlineActions hook 自决当前 trigger
    // 的候选列表支持哪些就地操作。broker 不跨层访问 provider 内部数据结构,
    // opt-in hook 让 provider 自决,结果写入 state.inlineActions 给 typeahead
    // Panel / InputController 消费。
    let inlineActions: InlineActionSupport = {};
    if (typeof provider.computeInlineActions === "function") {
      try {
        inlineActions = provider.computeInlineActions(match);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleProviderError(provider.id, error, session.id);
      }
    }

    this.setSessionState(session, {
      sessionId: session.id,
      activeProvider: { id: provider.id },
      trigger: match,
      suggestions,
      selectedIndex,
      loading: false,
      ghostText,
      argumentHint,
      inlineActions,
    });
  }

  // ─── 选择与接受 ───

  moveSelection(sessionId: string, delta: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const len = session.state.suggestions.length;
    if (len === 0) return;
    // Clamp 语义（非循环）：末尾 ↓ 无反应，首项 ↑ 无反应。
    //
    // Why: 循环导航会让窗口从 `[last-maxVisible, last]` 跳到 `[0, maxVisible]`，
    // 列表内容整个翻转，用户按 ↓ 一次看到的不是"下一项"而是"完全不同的一个列表"
    // —— 视觉上极其突兀。VSCode / Sublime / 主流 IDE 的 typeahead 都是 clamp 而
    // 非 circular，符合"滚到头就到头"的物理直觉。
    const newIndex = Math.max(
      0,
      Math.min(session.state.selectedIndex + delta, len - 1),
    );
    if (newIndex === session.state.selectedIndex) return;
    this.setSessionState(session, {
      ...session.state,
      selectedIndex: newIndex,
    });
  }

  /**
   * 计算 accept 结果——**state-纯函数**：返回 AcceptResult + 发 telemetry 事件，
   * **不动 session state**。caller 负责后续 updateInput / cancelSession 驱动状态变更。
   *
   * ─── 为什么是 state-纯 ───
   *
   * 历史 drift（已修复）：本方法曾在末尾同步调 `setSessionState(makeEmptyState)`
   * 清 session state。该副作用同步通知 onSessionChange listener，listener 立刻在
   * caller 写 buffer **之前**触发 chrome 重画——chrome 用旧 buffer（accept 之前的
   * partial 文本）画完，caller 之后才 setDraft。execute=true 路径下 submit 内的
   * buffer.commit 后无 chrome 重画环节 → chrome 卡在旧 partial 文本（典型现象：
   * home 模式输入 `/cle` 回车后 /clear 已执行但输入行仍显示 `/cle`）。
   *
   * 修复后契约：accept 仅算结果 + 发 telemetry；caller 显式按"accept(pure) →
   * setDraft → syncBroker / submit"顺序写。broker.updateInput（由 syncBroker
   * 触发）观测新 draft 派生新 session state——状态机收敛在 updateInput 单点。
   *
   * 顺带保护：未来任何调用方按签名理解写"accept → 改 caller 状态 → 后续"，
   * 不会再踩 TOCTOU。
   */
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

    return result;
  }

  /**
   * 接受 ghost text 自动完成（Tab 触发）——**state-纯函数**（与 [[accept]] 同契约）：
   * 返回 AcceptResult + 发 telemetry，不动 session state。caller 负责通过
   * updateInput / cancelSession 驱动状态变更。
   *
   * 历史 drift 与 accept 完全同构（同一 TOCTOU 模式），fix 同步处理。详细论证见
   * accept 方法注释。
   */
  acceptGhostText(sessionId: string): AcceptResult | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const { ghostText, trigger } = session.state;
    if (!ghostText || !trigger) return null;

    const draft = session.lastContext.draft;
    // 按**字符**切片 —— CJK 安全
    const chars = Array.from(draft);
    const before = chars.slice(0, trigger.tokenStart).join("");
    const after = chars.slice(trigger.tokenEnd).join("");
    const newDraft = before + ghostText.fullValue + after;
    const newCursor =
      trigger.tokenStart + Array.from(ghostText.fullValue).length;

    const result: AcceptResult = {
      newDraft,
      newCursor,
      execute: false, // ghost accept 不自动执行 —— 用户可能还要加参数
    };

    this.emit({
      type: "typeahead:suggestion-accepted",
      sessionId,
      timestamp: this.now(),
      providerId: session.state.activeProvider?.id ?? "__ghost_text__",
      item: {
        id: "ghost-text",
        providerId: session.state.activeProvider?.id ?? "__ghost_text__",
        displayText: ghostText.fullValue,
      },
      result,
    });

    return result;
  }

  markDeletePending(sessionId: string, suggestionId: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.setDeletePending(session, suggestionId);
  }

  refresh(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.inflightAbort) {
      session.inflightAbort.abort();
      session.inflightAbort = null;
    }
    // 重新按 lastContext 算 trigger;命中则强制走 isNewTrigger=true 分支
    // 让 canonical 重置 + emit loading=true(用户即时看到"正在刷新"反馈),
    // query resolve 后看到新候选。trigger 已 gone(用户已改 query)时退化
    // 到清空 state,与 updateInput 无命中路径同款。
    const matchResult = this.findFirstMatch(session.lastContext);
    if (!matchResult) {
      this.setSessionState(session, makeEmptyState(sessionId));
      return;
    }
    this.runQuery(session, matchResult.provider, matchResult.match, true);
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

  /**
   * session state 变更入口。入参类型 Omit deletePending —— 强制 caller 不能
   * 通过本入口设置 deletePending,内部统一覆写为 null。该约束实现"任何
   * mutate session 的路径(updateInput / moveSelection / setLoadingFinished
   * 等)自动清空 deletePending"的单源不变量,无需 caller 在每条路径显式清。
   *
   * deletePending 字段的唯一变更入口是 markDeletePending(走 setDeletePending),
   * 与本入口正交。
   */
  private setSessionState(
    session: InternalSession,
    next: Omit<TypeaheadSessionState, "deletePending">,
  ): void {
    session.state = { ...next, deletePending: null };
    this.emitSessionChange(session);
  }

  private setDeletePending(
    session: InternalSession,
    value: string | null,
  ): void {
    session.state = { ...session.state, deletePending: value };
    this.emitSessionChange(session);
  }

  private emitSessionChange(session: InternalSession): void {
    // 复制一份再遍历 —— 防止 listener 在回调里 unsubscribe
    const listeners = Array.from(session.listeners);
    for (const listener of listeners) {
      try {
        listener(session.state);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onProviderError("session-listener", error);
      }
    }
  }

  private handleProviderError(
    providerId: string,
    error: Error,
    sessionId?: string,
  ): void {
    this.onProviderError(providerId, error);
    this.emit({
      type: "typeahead:provider-error",
      sessionId: sessionId ?? "",
      timestamp: this.now(),
      providerId,
      error: { name: error.name, message: error.message },
    });
  }

  private emit(event: TypeaheadEvent): void {
    try {
      this.eventSink(event);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onProviderError("event-sink", error);
    }
  }
}

// ─── 辅助：构造空 state ───

function makeEmptyState(
  sessionId: string,
): Omit<TypeaheadSessionState, "deletePending"> {
  return {
    sessionId,
    activeProvider: null,
    trigger: null,
    suggestions: [],
    selectedIndex: -1,
    loading: false,
    ghostText: null,
    argumentHint: null,
    inlineActions: {},
  };
}
