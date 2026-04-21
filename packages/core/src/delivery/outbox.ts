/**
 * Outbox — per-target 串行化出口
 *
 * 规格：[message-outbox.md](../../../../research/design/specifications/message-outbox.md) §3.4-3.5
 * 决策：[ADR-007](../../../../research/design/architecture/decisions/007-message-outbox.md)
 *
 * 不变量（必须保持）：
 * - INV-1 Per-Target FIFO：入队顺序 = 出队顺序
 * - INV-5 发送原子性：post() resolved 时 entry 要么发成功要么失败，不存在部分状态
 * - INV-6 无隐式重排：同一 Outbox 的后续 entry 不越过失败项（当前设计：失败即上抛，后续继续）
 * - INV-7 可观测：每个 entry 至少产生一个 sent 或 failed 事件
 *
 * Phase 1 范围：
 * - FIFO 串行化（单 drain loop）
 * - adapter.send 超时兜底（Promise.race）
 * - 失败不内部重试（重试归 Pipeline）
 * - afterSlot 字段接收但不处理（Phase 3 启用）
 */

import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../channels/types.js";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  type OutboxDoSend,
  type OutboxEntry,
  type OutboxEvent,
  type OutboxKey,
  type OutboxLogger,
  type OutboxOptions,
  type PostEntryInput,
} from "./outbox-types.js";

// ─── 内部队列项（绑定 promise 回调） ───

interface PendingItem {
  readonly entry: OutboxEntry;
  readonly resolve: (result: DeliveryResult) => void;
  readonly reject: (error: Error) => void;
}

// ─── Outbox 类 ───

export class Outbox {
  private readonly pending: PendingItem[] = [];
  private draining: Promise<void> | null = null;
  private _inflight: OutboxEntry | null = null;
  private lastActivityAt: number;

  private readonly sendTimeoutMs: number;
  private readonly onEvent?: (event: OutboxEvent) => void;
  private readonly logger?: OutboxLogger;
  private readonly now: () => number;

  constructor(
    readonly key: OutboxKey,
    private readonly doSend: OutboxDoSend,
    options?: OutboxOptions,
  ) {
    this.sendTimeoutMs = options?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.onEvent = options?.onEvent;
    this.logger = options?.logger;
    this.now = options?.now ?? Date.now;
    this.lastActivityAt = this.now();
  }

  /** 当前队列里等待发送的 entry 数量（不含 inflight） */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 正在发送中的 entry（null 表示空闲） */
  get inflight(): OutboxEntry | null {
    return this._inflight;
  }

  /** 是否完全空闲（无 pending 且无 inflight） */
  isIdle(): boolean {
    return this.pending.length === 0 && this._inflight === null;
  }

  /** 最近一次 post / drain 活动时间戳（用于 registry 空闲回收） */
  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /**
   * 提交一个 entry。Promise 在 entry 发送成功或永久失败时 resolve/reject。
   * 同一 Outbox 的多次 post 严格按调用顺序发送（INV-1）。
   */
  post(input: PostEntryInput): Promise<DeliveryResult> {
    const entry: OutboxEntry = {
      id: `ob_${this.now().toString(36)}_${randSuffix()}`,
      target: input.target,
      content: input.content,
      source: input.source,
      afterSlot: input.afterSlot,
      enqueuedAt: new Date(this.now()).toISOString(),
    };

    this.lastActivityAt = this.now();
    this.emit({ type: "entry:enqueued", key: this.key, entry });
    this.logger?.debug?.(`[outbox ${this.key}] enqueued`, {
      entryId: entry.id,
      source: entry.source.kind,
    });

    return new Promise<DeliveryResult>((resolve, reject) => {
      this.pending.push({ entry, resolve, reject });
      this.kick();
    });
  }

  /** 等待当前队列全部排空（用于 registry.dispose / 测试同步） */
  async waitIdle(): Promise<void> {
    while (!this.isIdle()) {
      if (this.draining) await this.draining;
      else break;
    }
  }

  // ─── 内部：drain 调度 ───

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      // 微任务间隙兜底：drain 的 while 退出 → finally 跑之间的微任务队列里，
      // 可能有"在 post 的 .then 回调里再次 post"触发了 kick() 但因 draining!=null 被 no-op。
      // 此时 pending 非空但无人 drain，entry 永久搁浅。必须在 finally 里重查一次 pending。
      // 参见 outbox.test.ts "after-then post 不会搁浅"。
      if (this.pending.length > 0) this.kick();
    });
    // 把内部异常吞掉（每个 entry 已通过 reject 上报），防止 unhandled rejection
    this.draining.catch(() => {});
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      this._inflight = item.entry;
      this.lastActivityAt = this.now();

      if (item.entry.afterSlot) {
        // Phase 1：还不支持 slot 阻塞。记 warn 让 Phase 3 前能看到期望-实现差距。
        this.logger?.warn?.(
          `[outbox ${this.key}] afterSlot specified but slot machinery not active in Phase 1`,
          { entryId: item.entry.id, slot: item.entry.afterSlot },
        );
      }

      const startedAt = this.now();
      try {
        const result = await this.sendWithTimeout(item.entry);
        const latency = this.now() - startedAt;

        if (!result.success) {
          // adapter 返回 success=false 视为 failed 事件（同时 resolve——由上游 Pipeline 据 result 决定是否 requeue）
          this.emit({
            type: "entry:failed",
            key: this.key,
            entry: item.entry,
            error: result.error ?? "adapter reported failure",
          });
          this.logger?.warn?.(`[outbox ${this.key}] send reported failure`, {
            entryId: item.entry.id,
            error: result.error,
          });
        } else {
          this.emit({
            type: "entry:sent",
            key: this.key,
            entry: item.entry,
            result,
            attemptLatencyMs: latency,
          });
          this.logger?.debug?.(`[outbox ${this.key}] sent`, {
            entryId: item.entry.id,
            latencyMs: latency,
          });
        }
        item.resolve(result);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error(String(err));
        this.emit({
          type: "entry:failed",
          key: this.key,
          entry: item.entry,
          error: error.message,
        });
        this.logger?.error?.(`[outbox ${this.key}] send threw`, {
          entryId: item.entry.id,
          error: error.message,
        });
        item.reject(error);
      } finally {
        this._inflight = null;
      }
    }
  }

  // ─── 内部：带超时的 send ───

  private sendWithTimeout(entry: OutboxEntry): Promise<DeliveryResult> {
    if (this.sendTimeoutMs <= 0) {
      return this.doSend(entry.target, entry.content);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DeliveryResult>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `adapter.send timed out after ${this.sendTimeoutMs}ms (channel=${entry.target.channelId} to=${entry.target.to})`,
          ),
        );
      }, this.sendTimeoutMs);
      // 不阻止进程退出
      if (timer.unref) timer.unref();
    });

    return Promise.race([
      this.doSend(entry.target, entry.content),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private emit(event: OutboxEvent): void {
    try {
      this.onEvent?.(event);
    } catch (err) {
      // 事件回调异常不允许影响 drain 正确性
      this.logger?.error?.(`[outbox ${this.key}] onEvent handler threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── 工具 ───

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ─── 便捷类型导出（转发，便于消费者单点 import） ───

export type { OutboxEntry, OutboxEvent, OutboxKey, PostEntryInput, OutboxDoSend };
export type { DeliveryResult, DeliveryTarget, OutboundContent };
