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
  DEFAULT_SLOT_TTL_MS,
  type OpenSlotOptions,
  type OutboxDoSend,
  type OutboxEntry,
  type OutboxEvent,
  type OutboxKey,
  type OutboxLogger,
  type OutboxOptions,
  type PostEntryInput,
  type SlotInfo,
  type SlotState,
  type SlotTerminalState,
  type TurnSlotId,
} from "./outbox-types.js";

// ─── 内部队列项（绑定 promise 回调） ───

interface PendingItem {
  readonly entry: OutboxEntry;
  readonly resolve: (result: DeliveryResult) => void;
  readonly reject: (error: Error) => void;
}

// ─── 内部 Slot 记录 ───

interface InternalSlot {
  readonly slotId: TurnSlotId;
  readonly openedAt: number;
  state: SlotState;
  closedAt?: number;
  closeReason?: string;
  /** 用于 TTL 过期——`fillSlot`/`abandonSlot` 时必须 clearTimeout */
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Outbox 类 ───

export class Outbox {
  private readonly pending: PendingItem[] = [];
  private readonly slots = new Map<TurnSlotId, InternalSlot>();
  private draining: Promise<void> | null = null;
  private _inflight: OutboxEntry | null = null;
  private lastActivityAt: number;
  /**
   * Slot 信号量：drain 在 head entry 被 pending slot 阻塞时 await 此 promise。
   * 任意 slot 进入终态（fill/abandon/expire）通过 closeSlot 唤醒所有等待者。
   * 用 promise/resolver 而不是 setImmediate 轮询，避免 CPU 死循环。
   */
  private slotWaiter: { promise: Promise<void>; resolve: () => void } | null = null;

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
    const entry = this.buildEntry(input);

    this.lastActivityAt = this.now();
    this.emit({ type: "entry:enqueued", key: this.key, entry });
    this.safeLog("debug", `[outbox ${this.key}] enqueued`, {
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

  // ─── Turn Slot 管理 ───

  /**
   * 开启一个 Turn Slot。幂等：若同 slotId 已开启直接返回，不重置 TTL。
   * INV-4（slot 单调性）：slot 必在有限时间内进终态——由 TTL 兜底。
   */
  openSlot(opts: OpenSlotOptions): void {
    const { slotId } = opts;
    if (this.slots.has(slotId)) {
      this.safeLog(
        "debug",
        `[outbox ${this.key}] openSlot(${slotId}) idempotent (already exists)`,
      );
      return;
    }
    const ttlMs = opts.ttlMs ?? DEFAULT_SLOT_TTL_MS;
    const slot: InternalSlot = {
      slotId,
      openedAt: this.now(),
      state: "pending",
      ttlTimer: null,
    };
    if (ttlMs > 0) {
      const timer = setTimeout(() => {
        // TTL 到期：若仍 pending 才置 expired（保险，防被 fill 过的 slot 再被 expire）
        if (slot.state === "pending") {
          this.closeSlot(slot, "expired");
        }
      }, ttlMs);
      // 允许进程在 timer 未触发时退出
      if (typeof timer.unref === "function") timer.unref();
      slot.ttlTimer = timer;
    }
    this.slots.set(slotId, slot);
    this.lastActivityAt = this.now();
    // 事件里的 ttlMs：>0 传数值，<=0（禁用 TTL）传 null 以明示语义
    const eventTtl = ttlMs > 0 ? ttlMs : null;
    this.emit({ type: "slot:opened", key: this.key, slotId, ttlMs: eventTtl });
    this.safeLog("debug", `[outbox ${this.key}] slot:opened`, {
      slotId,
      ttlMs: eventTtl,
    });
  }

  /**
   * 将 slot 置 filled 并释放等待者。若提供 entry：
   * 此 entry 会被插入到第一个 `afterSlot === slotId` 的等待 entry **之前**——
   * 这样 drain 唤醒后会先送出此 entry，再送出 afterSlot=slotId 的 entry。
   *
   * turn 完成时用最终 LLM 回复 fill slot，保证回复先于后续 task fire。
   * 注意：该插入会越过 afterSlot=slotId 的等待 entry，但不会越过其它无关 entry——
   * 即此操作仅放宽 LLM 回复 vs. 同 slot 的 task-fire 的相对顺序。
   */
  async fillSlot(
    slotId: TurnSlotId,
    entry?: PostEntryInput,
  ): Promise<DeliveryResult | void> {
    const slot = this.slots.get(slotId);

    // 不变量：fillSlot 若带 entry，entry 必须到达队列——slot 生命周期问题不能吞掉消息。
    // 未知 slot / 已终态都触发 degrade-post：以普通 post 入队（剥掉 afterSlot），
    // 确保回复永远不因 slot 状态异常而丢失（INV-5 消息不丢）。
    if (!slot) {
      this.safeLog(
        "warn",
        `[outbox ${this.key}] fillSlot(${slotId}) on unknown slot`,
        { degraded: Boolean(entry) },
      );
      return entry ? this.post({ ...entry, afterSlot: undefined }) : undefined;
    }
    if (slot.state !== "pending") {
      this.safeLog(
        "debug",
        `[outbox ${this.key}] fillSlot(${slotId}) on terminal slot (${slot.state})`,
        { degraded: Boolean(entry) },
      );
      return entry ? this.post({ ...entry, afterSlot: undefined }) : undefined;
    }

    let postPromise: Promise<DeliveryResult> | undefined;
    let postedEntryId: string | undefined;
    if (entry) {
      const built = this.buildEntry(entry);
      postedEntryId = built.id;
      postPromise = this.insertBeforeWaiters(built, slotId);
    }

    // entryId 即 postedEntryId——当 fillSlot 未带 entry 时为 undefined
    this.closeSlot(slot, "filled", undefined, postedEntryId);
    return postPromise;
  }

  /**
   * 把 entry 插到第一个 afterSlot=slotId 的 pending 项之前；若无任何等待者，append 到队尾。
   * 不影响其它无关 entry 的 FIFO 位置。
   */
  private insertBeforeWaiters(
    entry: OutboxEntry,
    slotId: TurnSlotId,
  ): Promise<DeliveryResult> {
    return new Promise<DeliveryResult>((resolve, reject) => {
      const item: PendingItem = { entry, resolve, reject };
      const idx = this.pending.findIndex((p) => p.entry.afterSlot === slotId);
      if (idx === -1) {
        this.pending.push(item);
      } else {
        this.pending.splice(idx, 0, item);
      }
      this.lastActivityAt = this.now();
      this.emit({ type: "entry:enqueued", key: this.key, entry });
      this.safeLog(
        "debug",
        `[outbox ${this.key}] enqueued (slot-fill insertion)`,
        { entryId: entry.id, slotId, insertedAt: idx === -1 ? "tail" : idx },
      );
      this.kick();
    });
  }

  /** 构造 OutboxEntry（与 post() 内部相同，抽出复用） */
  private buildEntry(input: PostEntryInput): OutboxEntry {
    return {
      id: `ob_${this.now().toString(36)}_${randSuffix()}`,
      target: input.target,
      content: input.content,
      source: input.source,
      afterSlot: input.afterSlot,
      enqueuedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * 将 slot 置 abandoned 并释放等待者——turn 异常中止时调用。
   * 等待的 entry 会放行并带 warn 日志（因果前置条件丢失）。
   */
  abandonSlot(slotId: TurnSlotId, reason: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) {
      this.safeLog(
        "warn",
        `[outbox ${this.key}] abandonSlot(${slotId}) on unknown slot, ignored`,
      );
      return;
    }
    if (slot.state !== "pending") return;
    this.closeSlot(slot, "abandoned", reason);
  }

  /** 查询 slot 信息（观测 / 测试用） */
  getSlot(slotId: TurnSlotId): SlotInfo | undefined {
    const slot = this.slots.get(slotId);
    if (!slot) return undefined;
    return {
      slotId: slot.slotId,
      state: slot.state,
      openedAt: new Date(slot.openedAt).toISOString(),
      closedAt: slot.closedAt ? new Date(slot.closedAt).toISOString() : undefined,
      closeReason: slot.closeReason,
    };
  }

  /** 列出所有 slot（观测用） */
  listSlots(): SlotInfo[] {
    return [...this.slots.values()].map((s) => ({
      slotId: s.slotId,
      state: s.state,
      openedAt: new Date(s.openedAt).toISOString(),
      closedAt: s.closedAt ? new Date(s.closedAt).toISOString() : undefined,
      closeReason: s.closeReason,
    }));
  }

  /** 内部：slot 终态化 + 发事件 + 触发 drain kick 唤醒等待者 */
  private closeSlot(
    slot: InternalSlot,
    terminalState: SlotTerminalState,
    reason?: string,
    /** filled 事件的 entryId：fillSlot 带 entry 时 = entry.id；纯 fill 时 = undefined */
    entryId?: string,
  ): void {
    slot.state = terminalState;
    slot.closedAt = this.now();
    if (reason !== undefined) slot.closeReason = reason;
    if (slot.ttlTimer !== null) {
      clearTimeout(slot.ttlTimer);
      slot.ttlTimer = null;
    }

    const baseEvent = { key: this.key, slotId: slot.slotId };
    if (terminalState === "filled") {
      this.emit({
        type: "slot:filled",
        ...baseEvent,
        entryId,
      });
    } else if (terminalState === "abandoned") {
      this.emit({
        type: "slot:abandoned",
        ...baseEvent,
        reason: reason ?? "unspecified",
      });
    } else {
      this.emit({ type: "slot:expired", ...baseEvent });
    }

    this.safeLog("debug", `[outbox ${this.key}] slot:${terminalState}`, {
      slotId: slot.slotId,
      reason,
    });

    // 关键：唤醒任何 await slotWaiter 的 drain（不调 kick——drain 本就活着，只是挂起）。
    // 如果当前没有 drain 在跑（正常情况下不会，因为 slot 阻塞才会有 waiter），
    // signalSlotChange 是 no-op；如果将来有新 post，kick 会正常启动新 drain。
    this.signalSlotChange();
  }

  /** 获取（或创建）下一次 slot 状态变化的 promise；drain 用它挂起 */
  private waitForSlotChange(): Promise<void> {
    if (!this.slotWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.slotWaiter = { promise, resolve };
    }
    return this.slotWaiter.promise;
  }

  /** 唤醒所有 await slotWaiter 的等待者（drain）；幂等 */
  private signalSlotChange(): void {
    if (this.slotWaiter) {
      const w = this.slotWaiter;
      this.slotWaiter = null;
      w.resolve();
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
      // 先 peek head，检查 afterSlot 因果依赖
      const head = this.pending[0]!;
      if (head.entry.afterSlot) {
        const slot = this.slots.get(head.entry.afterSlot);
        if (!slot) {
          // 孤儿 slot：entry 引用的 slotId 在本 Outbox 从未开启。
          // 常见合法场景：task 创建后 Registry.reapIdle 回收了对应 Outbox，
          // 之后 task fire 时新 Outbox 里无此 slot——这不是故障，只是因果已终结。
          // 少数情况是生产者 bug；两者通过 causal-broken 事件统一上报让上层决定告警。
          // 必须走 safeLog：如果 logger 在此抛错，drain 会回退到 finally，
          // pending 非空触发 re-kick → 同一 entry 同一路径再抛 → 无限循环。
          this.safeLog(
            "warn",
            `[outbox ${this.key}] orphan afterSlot reference, releasing entry`,
            { entryId: head.entry.id, slotId: head.entry.afterSlot },
          );
          this.emit({
            type: "entry:causal-broken",
            key: this.key,
            entry: head.entry,
            slotId: head.entry.afterSlot,
            reason: "orphan-slot",
          });
        } else if (slot.state === "pending") {
          // 未终态：真正挂起——await slotWaiter，等任意 slot 终态化时被唤醒。
          // 关键：用 promise/resolver 模式而非 return-rekick——后者会让 finally 立刻
          // 重启 drain → 新 drain 又看到同一阻塞 → return → 又重启……CPU 死循环。
          this.safeLog(
            "debug",
            `[outbox ${this.key}] drain suspended, waiting for slot`,
            { entryId: head.entry.id, slotId: head.entry.afterSlot },
          );
          await this.waitForSlotChange();
          continue;  // 回到循环顶部重新 peek head + 检查 slot 状态
        } else if (slot.state !== "filled") {
          // abandoned / expired：放行但记 warn + emit causal-broken 事件（上层据此告警）
          this.safeLog(
            "warn",
            `[outbox ${this.key}] slot ${slot.state}, releasing entry with broken causality`,
            {
              entryId: head.entry.id,
              slotId: head.entry.afterSlot,
              reason: slot.closeReason,
            },
          );
          this.emit({
            type: "entry:causal-broken",
            key: this.key,
            entry: head.entry,
            slotId: head.entry.afterSlot,
            reason: slot.state === "abandoned" ? "slot-abandoned" : "slot-expired",
            slotCloseReason: slot.closeReason,
          });
        }
      }

      // 通过因果检查，正式出队
      const item = this.pending.shift()!;
      this._inflight = item.entry;
      this.lastActivityAt = this.now();

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
          this.safeLog("warn", `[outbox ${this.key}] send reported failure`, {
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
          this.safeLog("debug", `[outbox ${this.key}] sent`, {
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
        this.safeLog("error", `[outbox ${this.key}] send threw`, {
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
      this.safeLog("error", `[outbox ${this.key}] onEvent handler threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 包裹 logger 调用——任何 logger 异常都被吞掉。
   *
   * 必须性：drain 内调用 logger 时若 logger 抛错，会让 drain 提前退出，
   * 而 finally 看到 pending 非空会 re-kick → 新 drain 同样路径再抛 → 无限循环。
   * 所有 drain/closeSlot/post 路径上的 logger 调用必须走这里。
   */
  private safeLog(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    data?: unknown,
  ): void {
    try {
      this.logger?.[level]?.(msg, data);
    } catch {
      // intentionally swallowed
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
