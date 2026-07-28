/**
 * ConfirmationBroker — 确认交互系统的核心调度器
 *
 * 职责：
 *   1. 接收 ConfirmationRequest，把它们按 FIFO 放入队列
 *   2. 串行化展示——任意时刻只有队首一条处于 "showing" 状态
 *   3. 通过 onRequest 监听器把 showing 状态的请求通知给渲染器
 *   4. 接收渲染器回传的 decision 并完成请求 Promise
 *   5. 超时 / 取消 / 会话结束时自动清场
 *   6. 无渲染器时走 NonInteractiveResolver 兜底
 *   7. 已 resolve 的请求在 grace period 内可被再次查询（幂等）
 *
 * 设计与 OpenClaw ExecApprovalManager 同构：
 *   - in-memory Map<id, entry>
 *   - register/resolve 分离
 *   - grace period 处理延迟回调
 *   - 原子 consume 防重放
 *
 * 但 broker 的作用域是**进程内、会话级**，不是跨进程 RPC。
 * 多通道分发（Web / 微信 / 钉钉）由 Phase 2+ 的上层适配器处理。
 */

import { randomUUID } from "node:crypto";
import type { IEventBus } from "../events/types.js";
import { failToDenyResolver } from "./non-interactive.js";
import { validateConfirmationDecisionText } from "./types.js";
import type {
  BrokerSnapshot,
  BrokerUnsubscribe,
  CancelCause,
  ConfirmationDecision,
  ConfirmationEventMap,
  ConfirmationRequest,
  ConfirmationLifecycleObserver,
  ConfirmationRequestId,
  ConfirmationResolutionSource,
  IConfirmationBroker,
  NonInteractiveResolver,
  PendingSnapshot,
  RequestListener,
  ResolvedListener,
} from "./types.js";

// ─── 常量 ───

/**
 * 已 resolve 的请求保留多久后从内存清除。
 * 学 OpenClaw 的 RESOLVED_ENTRY_GRACE_MS=15_000——允许迟到的 resolve/cancel
 * 调用幂等返回 false 而非命中一个新分配的 id。
 */
const DEFAULT_RESOLVED_GRACE_MS = 15_000;

/**
 * 默认最大队列深度。
 * 超过时新请求会被 cancelled(backpressure) 立即拒绝，防止模型失控生成
 * 100 个审批请求淹没 UI。
 */
const DEFAULT_MAX_QUEUE_DEPTH = 32;

// ─── 内部数据结构 ───

interface PendingEntry {
  request: ConfirmationRequest;
  status: "queued" | "showing" | "resolving";
  createdAt: number;
  /** setTimeout handle 用于超时自动 expire */
  expireTimer: ReturnType<typeof setTimeout> | null;
  /** resolve 外部 Promise 的函数 */
  resolvePromise: (decision: ConfirmationDecision) => void;
  rejectPromise: (error: unknown) => void;
  terminal?: TerminalAttempt;
  deferredTerminal?: TerminalRequest;
}

interface TerminalRequest {
  readonly decision: ConfirmationDecision;
  readonly source: ConfirmationResolutionSource;
  readonly emit: () => void;
  readonly requeueOnFailure: boolean;
}

interface TerminalAttempt extends TerminalRequest {
  readonly promise: Promise<boolean>;
}

interface ResolvedEntry {
  id: ConfirmationRequestId;
  decision: ConfirmationDecision;
  resolvedAt: number;
}

// ─── 选项 ───

export interface ConfirmationBrokerOptions {
  /** 事件总线——用于发射可观测事件（可选） */
  eventBus?: IEventBus<ConfirmationEventMap>;
  /** 非交互兜底解析器——默认 fail-to-deny */
  nonInteractiveResolver?: NonInteractiveResolver;
  /** 已 resolve 的请求在内存中保留多久（ms）。默认 15000 */
  resolvedGraceMs?: number;
  /** 队列最大深度——超出时新请求立即 cancelled(backpressure)。默认 32 */
  maxQueueDepth?: number;
  /** 当前时间源——便于测试注入 fake clock */
  now?: () => number;
  /**
   * broker 实例 id —— 缺省走 randomUUID()。仅在测试需要稳定 id 时显式传入。
   * 实例 id 通过 IConfirmationBroker.id 暴露,审计 / Snapshot / 事件 payload 引用此 id。
   */
  id?: string;
  /**
   * 父 broker id(审计血缘) —— 子 agent dispatch 派生 broker 时由 orchestrator
   * 透传(取自 parentBroker.id);主 broker 不传。本字段不影响 broker 任何行为,
   * 仅在 emit 事件 / snapshot() 时透传给下游审计层。
   */
  parentBrokerId?: string;
  /**
   * 派生此 broker 的 sub-agent 实例 id(审计追溯) —— 与 ChildAgentResult.subAgentId
   * 一致。同 parentBrokerId,纯审计透传字段,不影响 broker 行为。
   */
  sourceAgentId?: string;
  /** Optional durable interaction boundary shared by parent and child brokers. */
  lifecycleObserver?: ConfirmationLifecycleObserver;
}

// ─── Broker ───

export class ConfirmationBroker implements IConfirmationBroker {
  private readonly pending = new Map<ConfirmationRequestId, PendingEntry>();
  /**
   * 队列——按插入顺序存放 id。队首 id 对应的 entry 就是 "showing" 状态。
   * 用数组而非双端队列：队列深度受 maxQueueDepth 限制，O(N) 操作可接受。
   */
  private readonly queue: ConfirmationRequestId[] = [];

  private readonly resolvedRecent = new Map<
    ConfirmationRequestId,
    ResolvedEntry
  >();

  private readonly requestListeners: RequestListener[] = [];
  private readonly resolvedListeners: ResolvedListener[] = [];

  private readonly eventBus?: IEventBus<ConfirmationEventMap>;
  private readonly resolver: NonInteractiveResolver;
  private readonly resolvedGraceMs: number;
  private readonly maxQueueDepth: number;
  private readonly now: () => number;

  // 审计血缘字段 —— 构造时一次性赋值后只读
  readonly id: string;
  readonly lifecycleObserver?: ConfirmationLifecycleObserver;
  private readonly parentBrokerId?: string;
  private readonly sourceAgentId?: string;

  constructor(options: ConfirmationBrokerOptions = {}) {
    this.eventBus = options.eventBus;
    this.resolver = options.nonInteractiveResolver ?? failToDenyResolver;
    this.resolvedGraceMs = options.resolvedGraceMs ?? DEFAULT_RESOLVED_GRACE_MS;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? randomUUID();
    this.parentBrokerId = options.parentBrokerId;
    this.sourceAgentId = options.sourceAgentId;
    this.lifecycleObserver = options.lifecycleObserver;
  }

  // ─── 公共 API ───

  async requestConfirmation(
    request: ConfirmationRequest,
  ): Promise<ConfirmationDecision> {
    // 1. id 合法性检查：重复 id 直接拒绝
    if (this.pending.has(request.id) || this.resolvedRecent.has(request.id)) {
      throw new Error(
        `ConfirmationBroker: duplicate request id "${request.id}"`,
      );
    }
    if (this.lifecycleObserver) {
      const disposition = await this.lifecycleObserver.beforeRequest(request);
      if (disposition?.accepted === false) {
        this.markResolved(request.id, disposition.decision);
        this.emitEvent("confirmation:cancelled", {
          requestId: request.id,
          tool: request.tool,
          cause: disposition.decision.cause,
          timestamp: this.now(),
        });
        return disposition.decision;
      }
    }

    // 2. 无监听器 → 立即走非交互兜底
    if (this.requestListeners.length === 0) {
      const decision = this.resolver.resolve(request);
      await this.lifecycleObserver?.afterResolved(request, decision, {
        kind: "non-interactive",
        resolver: this.resolver.name,
      });
      this.emitEvent("confirmation:auto-resolved", {
        requestId: request.id,
        tool: request.tool,
        resolverName: this.resolver.name,
        decision,
        timestamp: this.now(),
      });
      // 仍然进 resolvedRecent 以保持 duplicate-id 检测语义
      this.markResolved(request.id, decision);
      return decision;
    }

    // 3. 队列满 → backpressure 拒绝
    if (this.pending.size >= this.maxQueueDepth) {
      const decision: ConfirmationDecision = {
        kind: "cancelled",
        cause: "backpressure",
      };
      await this.lifecycleObserver?.afterResolved(request, decision, {
        kind: "backpressure",
      });
      this.markResolved(request.id, decision);
      this.emitEvent("confirmation:cancelled", {
        requestId: request.id,
        tool: request.tool,
        cause: "backpressure",
        timestamp: this.now(),
      });
      return decision;
    }

    // 4. 正常流程：创建 entry、入队、启动超时计时器
    return new Promise<ConfirmationDecision>((resolvePromise, rejectPromise) => {
      const entry: PendingEntry = {
        request,
        status: "queued",
        createdAt: this.now(),
        expireTimer: null,
        resolvePromise,
        rejectPromise,
      };
      this.pending.set(request.id, entry);
      this.queue.push(request.id);

      this.emitEvent("confirmation:requested", {
        requestId: request.id,
        tool: request.tool,
        operationClass: request.operationClass,
        riskLevel: request.decision?.riskLevel,
        queueDepth: this.queue.length,
        timestamp: this.now(),
      });

      // 设置过期定时器（只在队首被 show 的时候真正开始计时效果；
      // 但为简单起见所有请求一入队就开始计时——超时仍然是从 createdAt 算）
      const remaining = Math.max(0, request.expiresAt - this.now());
      entry.expireTimer = setTimeout(() => this.expire(request.id), remaining);
      // setTimeout 返回值在 Node 中有 unref 方法，避免 timer 阻止进程退出
      if (typeof entry.expireTimer === "object" && entry.expireTimer !== null) {
        (entry.expireTimer as { unref?: () => void }).unref?.();
      }

      // 如果队首就是本请求 → 立刻"展示"
      if (this.queue[0] === request.id) {
        this.showHead();
      }
    });
  }

  onRequest(listener: RequestListener): BrokerUnsubscribe {
    this.requestListeners.push(listener);
    return () => {
      const idx = this.requestListeners.indexOf(listener);
      if (idx !== -1) this.requestListeners.splice(idx, 1);
    };
  }

  onResolved(listener: ResolvedListener): BrokerUnsubscribe {
    this.resolvedListeners.push(listener);
    return () => {
      const idx = this.resolvedListeners.indexOf(listener);
      if (idx !== -1) this.resolvedListeners.splice(idx, 1);
    };
  }

  resolve(
    requestId: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): boolean {
    validateConfirmationDecisionText(decision);
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const durationMs = this.now() - entry.createdAt;
    const terminal: TerminalRequest = {
      decision,
      source: { kind: "surface" },
      requeueOnFailure: false,
      emit: () => {
        this.emitEvent("confirmation:resolved", {
          requestId,
          tool: entry.request.tool,
          decision,
          durationMs,
          timestamp: this.now(),
        });
      },
    };
    if (!this.lifecycleObserver) {
      this.completeImmediately(entry, terminal);
      return true;
    }
    if (entry.terminal) {
      return canonicalDecision(entry.terminal.decision) === canonicalDecision(decision);
    }
    void this.startTerminal(entry, terminal).catch(() => {});
    return true;
  }

  async resolveDurably(
    requestId: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): Promise<boolean> {
    validateConfirmationDecisionText(decision);
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (!this.lifecycleObserver) return this.resolve(requestId, decision);
    if (entry.terminal) {
      return canonicalDecision(entry.terminal.decision) === canonicalDecision(decision)
        ? entry.terminal.promise
        : false;
    }
    const durationMs = this.now() - entry.createdAt;
    return this.startTerminal(entry, {
      decision,
      source: { kind: "surface" },
      requeueOnFailure: true,
      emit: () => {
        this.emitEvent("confirmation:resolved", {
          requestId,
          tool: entry.request.tool,
          decision,
          durationMs,
          timestamp: this.now(),
        });
      },
    });
  }

  async resolveNonInteractiveDurably(
    requestId: ConfirmationRequestId,
  ): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const decision = this.resolver.resolve(entry.request);
    validateConfirmationDecisionText(decision);
    const terminal: TerminalRequest = {
      decision,
      source: {
        kind: "non-interactive",
        resolver: this.resolver.name,
      },
      requeueOnFailure: true,
      emit: () => {
        this.emitEvent("confirmation:auto-resolved", {
          requestId,
          tool: entry.request.tool,
          resolverName: this.resolver.name,
          decision,
          timestamp: this.now(),
        });
      },
    };
    if (!this.lifecycleObserver) {
      this.completeImmediately(entry, terminal);
      return true;
    }
    if (entry.terminal) {
      return entry.terminal.source.kind === "non-interactive" &&
        canonicalDecision(entry.terminal.decision) === canonicalDecision(decision)
        ? entry.terminal.promise
        : false;
    }
    return this.startTerminal(entry, terminal);
  }

  cancel(requestId: ConfirmationRequestId, cause: CancelCause): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    const decision: ConfirmationDecision = { kind: "cancelled", cause };
    const terminal: TerminalRequest = {
      decision,
      source: { kind: "cancel", cause },
      requeueOnFailure: false,
      emit: () => {
        this.emitEvent("confirmation:cancelled", {
          requestId,
          tool: entry.request.tool,
          cause,
          timestamp: this.now(),
        });
      },
    };
    if (!this.lifecycleObserver) {
      this.completeImmediately(entry, terminal);
      return true;
    }
    if (entry.terminal) {
      if (entry.terminal.source.kind === "surface") {
        entry.deferredTerminal ??= terminal;
        this.clearExpireTimer(entry);
        this.removeFromQueue(requestId);
        return true;
      }
      return canonicalDecision(entry.terminal.decision) === canonicalDecision(decision);
    }
    void this.startTerminal(entry, terminal).catch(() => {});
    return true;
  }

  cancelAll(cause: CancelCause): number {
    // pending 包含 queued/showing/resolving；关停不能漏掉正在耐久终结的请求。
    const ids = [...this.pending.keys()];
    let cancelled = 0;
    for (const id of ids) {
      if (this.cancel(id, cause)) cancelled++;
    }
    return cancelled;
  }

  listPending(): PendingSnapshot[] {
    return [...this.pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => ({ request: entry.request, status: entry.status }));
  }

  snapshot(): BrokerSnapshot {
    return {
      id: this.id,
      ...(this.parentBrokerId !== undefined && {
        parentBrokerId: this.parentBrokerId,
      }),
      ...(this.sourceAgentId !== undefined && {
        sourceAgentId: this.sourceAgentId,
      }),
      pending: this.listPending(),
      resolvedRecently: Array.from(this.resolvedRecent.values()).map((e) => ({
        id: e.id,
        decision: e.decision,
        resolvedAt: e.resolvedAt,
      })),
      listenerCount: this.requestListeners.length,
      nonInteractiveResolver: this.resolver.name,
    };
  }

  // ─── 内部工具 ───

  /**
   * 推进队列——把队首设为 showing 并通知监听器。
   * 如果队列为空则什么都不做。
   * 幂等：连续调用不会重复通知已 showing 的请求。
   */
  private showHead(): void {
    const headId = this.queue[0];
    if (!headId) return;

    const entry = this.pending.get(headId);
    if (!entry) return;

    if (entry.status === "showing") return; // 已经在展示中
    entry.status = "showing";

    this.emitEvent("confirmation:shown", {
      requestId: headId,
      tool: entry.request.tool,
      queueDepth: this.queue.length,
      timestamp: this.now(),
    });

    // 通知所有订阅者
    // 注意：用 snapshot 遍历，避免监听器在回调里 subscribe/unsubscribe 导致
    // 索引错乱（和 EventBus 的做法一致）
    const snapshot = [...this.requestListeners];
    for (const listener of snapshot) {
      try {
        listener(entry.request);
      } catch (err) {
        // 监听器错误不能阻塞 broker，但要可见
        console.error(
          "[ConfirmationBroker] listener threw while showing",
          headId,
          err,
        );
      }
    }
  }

  private expire(requestId: ConfirmationRequestId): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    const decision: ConfirmationDecision = { kind: "expired" };
    const durationMs = this.now() - entry.createdAt;

    const terminal: TerminalRequest = {
      decision,
      source: { kind: "expired" },
      requeueOnFailure: false,
      emit: () => {
        this.emitEvent("confirmation:expired", {
          requestId,
          tool: entry.request.tool,
          durationMs,
          timestamp: this.now(),
        });
      },
    };
    if (!this.lifecycleObserver) {
      this.completeImmediately(entry, terminal);
      return;
    }
    if (entry.terminal) {
      if (entry.terminal.source.kind === "surface") {
        entry.deferredTerminal ??= terminal;
      }
      return;
    }
    void this.startTerminal(entry, terminal).catch(() => {});
  }

  private completeImmediately(
    entry: PendingEntry,
    terminal: TerminalRequest,
  ): void {
    this.clearExpireTimer(entry);
    this.pending.delete(entry.request.id);
    this.removeFromQueue(entry.request.id);
    this.markResolved(entry.request.id, terminal.decision);
    entry.resolvePromise(terminal.decision);
    terminal.emit();
    this.showHead();
  }

  private startTerminal(
    entry: PendingEntry,
    terminal: TerminalRequest,
  ): Promise<boolean> {
    if (this.pending.get(entry.request.id) !== entry) return Promise.resolve(false);
    if (entry.terminal) return entry.terminal.promise;

    this.clearExpireTimer(entry);
    this.removeFromQueue(entry.request.id);
    entry.status = "resolving";
    const promise = this.commitTerminal(entry, terminal);
    entry.terminal = { ...terminal, promise };
    return promise;
  }

  private async commitTerminal(
    entry: PendingEntry,
    terminal: TerminalRequest,
  ): Promise<boolean> {
    try {
      await this.lifecycleObserver!.afterResolved(
        entry.request,
        terminal.decision,
        terminal.source,
      );
      if (this.pending.get(entry.request.id) !== entry) return false;
      this.pending.delete(entry.request.id);
      entry.terminal = undefined;
      entry.deferredTerminal = undefined;
      this.markResolved(entry.request.id, terminal.decision);
      entry.resolvePromise(terminal.decision);
      terminal.emit();
      this.showHead();
      return true;
    } catch (error) {
      if (this.pending.get(entry.request.id) !== entry) throw error;
      entry.terminal = undefined;
      const deferred = entry.deferredTerminal;
      entry.deferredTerminal = undefined;
      if (deferred) {
        void this.startTerminal(entry, deferred).catch(() => {});
      } else if (terminal.requeueOnFailure) {
        entry.status = "queued";
        if (!this.queue.includes(entry.request.id)) this.queue.unshift(entry.request.id);
        this.scheduleExpiry(entry);
        this.showHead();
      } else {
        this.pending.delete(entry.request.id);
        entry.rejectPromise(error);
        this.showHead();
      }
      throw error;
    }
  }

  private markResolved(
    id: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): void {
    const resolvedAt = this.now();
    this.resolvedRecent.set(id, { id, decision, resolvedAt });

    // 通知 onResolved 监听器——所有 resolved 路径的唯一出口。
    // 用 snapshot 遍历，避免监听器在回调里 unsubscribe 导致索引错乱
    // （与 showHead 的 requestListeners 处理一致）。
    const snapshot = [...this.resolvedListeners];
    for (const listener of snapshot) {
      try {
        listener(id, decision);
      } catch (err) {
        console.error(
          "[ConfirmationBroker] resolved listener threw",
          id,
          err,
        );
      }
    }

    // 安排 grace period 后清除
    const timer = setTimeout(() => {
      this.resolvedRecent.delete(id);
    }, this.resolvedGraceMs);
    if (typeof timer === "object" && timer !== null) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  private clearExpireTimer(entry: PendingEntry): void {
    if (entry.expireTimer !== null) {
      clearTimeout(entry.expireTimer);
      entry.expireTimer = null;
    }
  }

  private scheduleExpiry(entry: PendingEntry): void {
    const remaining = Math.max(0, entry.request.expiresAt - this.now());
    entry.expireTimer = setTimeout(() => this.expire(entry.request.id), remaining);
    if (typeof entry.expireTimer === "object" && entry.expireTimer !== null) {
      (entry.expireTimer as { unref?: () => void }).unref?.();
    }
  }

  private removeFromQueue(id: ConfirmationRequestId): void {
    const idx = this.queue.indexOf(id);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  /**
   * 自动注入审计血缘字段 —— 调用方只构造业务字段,broker 统一补 brokerId /
   * parentBrokerId / sourceAgentId,避免每个 emit 站点重复透传。
   */
  private emitEvent<K extends keyof ConfirmationEventMap>(
    event: K,
    payload: Omit<
      ConfirmationEventMap[K],
      "brokerId" | "parentBrokerId" | "sourceAgentId"
    >,
  ): void {
    if (!this.eventBus) return;
    const enriched = {
      ...payload,
      brokerId: this.id,
      ...(this.parentBrokerId !== undefined && {
        parentBrokerId: this.parentBrokerId,
      }),
      ...(this.sourceAgentId !== undefined && {
        sourceAgentId: this.sourceAgentId,
      }),
    } as ConfirmationEventMap[K];
    // 用 emitSync 避免在 broker 内部 await —— 事件是通知，不是阻塞点
    this.eventBus.emitSync(event, enriched);
  }
}

function canonicalDecision(decision: ConfirmationDecision | undefined): string | undefined {
  return decision === undefined ? undefined : JSON.stringify(decision);
}

// ─── 工厂 ───

/**
 * 创建一个 broker 实例。
 * 便于在不同会话 / 不同测试间得到干净的状态。
 */
export function createConfirmationBroker(
  options: ConfirmationBrokerOptions = {},
): ConfirmationBroker {
  return new ConfirmationBroker(options);
}

/**
 * 工具函数：生成一个新的 request id。
 * 让外部不依赖 node:crypto。
 */
export function generateRequestId(): ConfirmationRequestId {
  return randomUUID();
}
