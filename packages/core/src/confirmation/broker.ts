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
import type {
  BrokerSnapshot,
  BrokerUnsubscribe,
  CancelCause,
  ConfirmationDecision,
  ConfirmationEventMap,
  ConfirmationRequest,
  ConfirmationRequestId,
  IConfirmationBroker,
  NonInteractiveResolver,
  PendingSnapshot,
  RequestListener,
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
  status: "queued" | "showing";
  createdAt: number;
  /** setTimeout handle 用于超时自动 expire */
  expireTimer: ReturnType<typeof setTimeout> | null;
  /** resolve 外部 Promise 的函数 */
  resolvePromise: (decision: ConfirmationDecision) => void;
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

  private readonly eventBus?: IEventBus<ConfirmationEventMap>;
  private readonly resolver: NonInteractiveResolver;
  private readonly resolvedGraceMs: number;
  private readonly maxQueueDepth: number;
  private readonly now: () => number;

  constructor(options: ConfirmationBrokerOptions = {}) {
    this.eventBus = options.eventBus;
    this.resolver = options.nonInteractiveResolver ?? failToDenyResolver;
    this.resolvedGraceMs = options.resolvedGraceMs ?? DEFAULT_RESOLVED_GRACE_MS;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.now = options.now ?? (() => Date.now());
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

    // 2. 无监听器 → 立即走非交互兜底
    if (this.requestListeners.length === 0) {
      const decision = this.resolver.resolve(request);
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
    if (this.queue.length >= this.maxQueueDepth) {
      const decision: ConfirmationDecision = {
        kind: "cancelled",
        cause: "backpressure",
      };
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
    return new Promise<ConfirmationDecision>((resolvePromise) => {
      const entry: PendingEntry = {
        request,
        status: "queued",
        createdAt: this.now(),
        expireTimer: null,
        resolvePromise,
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

  resolve(
    requestId: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    this.clearExpireTimer(entry);
    this.pending.delete(requestId);
    this.removeFromQueue(requestId);

    const durationMs = this.now() - entry.createdAt;
    this.markResolved(requestId, decision);
    entry.resolvePromise(decision);

    this.emitEvent("confirmation:resolved", {
      requestId,
      tool: entry.request.tool,
      decision,
      durationMs,
      timestamp: this.now(),
    });

    // 推进队列到下一个 pending
    this.showHead();
    return true;
  }

  cancel(requestId: ConfirmationRequestId, cause: CancelCause): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    const decision: ConfirmationDecision = { kind: "cancelled", cause };
    this.clearExpireTimer(entry);
    this.pending.delete(requestId);
    this.removeFromQueue(requestId);
    this.markResolved(requestId, decision);
    entry.resolvePromise(decision);

    this.emitEvent("confirmation:cancelled", {
      requestId,
      tool: entry.request.tool,
      cause,
      timestamp: this.now(),
    });

    this.showHead();
    return true;
  }

  cancelAll(cause: CancelCause): number {
    // 快照一份 id 列表：cancel 会修改 pending 和 queue
    const ids = [...this.queue];
    let cancelled = 0;
    for (const id of ids) {
      if (this.cancel(id, cause)) cancelled++;
    }
    return cancelled;
  }

  listPending(): PendingSnapshot[] {
    return this.queue.map((id) => {
      const entry = this.pending.get(id);
      // queue 和 pending 应严格同步；理论上永远命中
      if (!entry) {
        throw new Error(`invariant violation: queued id ${id} not in pending`);
      }
      return { request: entry.request, status: entry.status };
    });
  }

  snapshot(): BrokerSnapshot {
    return {
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

    this.pending.delete(requestId);
    this.removeFromQueue(requestId);
    this.markResolved(requestId, decision);
    entry.resolvePromise(decision);

    this.emitEvent("confirmation:expired", {
      requestId,
      tool: entry.request.tool,
      durationMs,
      timestamp: this.now(),
    });

    this.showHead();
  }

  private markResolved(
    id: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): void {
    const resolvedAt = this.now();
    this.resolvedRecent.set(id, { id, decision, resolvedAt });
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

  private removeFromQueue(id: ConfirmationRequestId): void {
    const idx = this.queue.indexOf(id);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  private emitEvent<K extends keyof ConfirmationEventMap>(
    event: K,
    payload: ConfirmationEventMap[K],
  ): void {
    if (!this.eventBus) return;
    // 用 emitSync 避免在 broker 内部 await——事件是通知，不是阻塞点
    this.eventBus.emitSync(event, payload);
  }
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
