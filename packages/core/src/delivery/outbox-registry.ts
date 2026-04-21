/**
 * OutboxRegistry — 管理所有 per-target Outbox 实例
 *
 * 规格：[message-outbox.md](../../../../research/design/specifications/message-outbox.md) §3.4
 *
 * 职责：
 * - 懒创建：首次访问某 target 时创建 Outbox
 * - 生命周期：空闲回收（reapIdle）+ 全量停机（dispose）
 * - 注入点：doSend 回调由外部提供——registry 不直接依赖 ChannelRegistry
 *
 * 使用模式：
 *   const registry = new OutboxRegistry((target, content) => adapter.send(target, content));
 *   await registry.of({ channelId, to }).post({ target, content, source });
 */

import type { DeliveryTarget } from "../channels/types.js";
import { Outbox } from "./outbox.js";
import {
  DEFAULT_REGISTRY_IDLE_MS,
  type OutboxDoSend,
  type OutboxKey,
  type OutboxLogger,
  type OutboxRegistryOptions,
} from "./outbox-types.js";

export class OutboxRegistry {
  private readonly outboxes = new Map<OutboxKey, Outbox>();
  private readonly options: OutboxRegistryOptions;
  private readonly logger?: OutboxLogger;
  private readonly now: () => number;

  constructor(
    private readonly doSend: OutboxDoSend,
    options?: OutboxRegistryOptions,
  ) {
    this.options = options ?? {};
    this.logger = options?.logger;
    this.now = options?.now ?? Date.now;
  }

  /** 获取（或按需创建）某 target 的 Outbox */
  of(target: DeliveryTarget): Outbox {
    const key = makeKey(target);
    let outbox = this.outboxes.get(key);
    if (!outbox) {
      outbox = new Outbox(key, this.doSend, this.options);
      this.outboxes.set(key, outbox);
      this.logger?.debug?.(`[outbox-registry] created`, { key });
    }
    return outbox;
  }

  /** 当前已托管的 Outbox 数量（观测用） */
  size(): number {
    return this.outboxes.size;
  }

  /** 列出所有 key（测试/调试用） */
  keys(): string[] {
    return [...this.outboxes.keys()];
  }

  /**
   * 回收长时间空闲的 Outbox——返回回收数量。
   * "空闲"定义：`now - lastActivity > maxIdleMs` 且 `isIdle() === true`（无 pending / inflight）。
   */
  reapIdle(maxIdleMs?: number): number {
    const limit = maxIdleMs ?? this.options.idleTimeoutMs ?? DEFAULT_REGISTRY_IDLE_MS;
    const threshold = this.now() - limit;
    let reaped = 0;
    for (const [key, outbox] of this.outboxes) {
      if (outbox.lastActivity < threshold && outbox.isIdle()) {
        this.outboxes.delete(key);
        reaped++;
      }
    }
    if (reaped > 0) {
      this.logger?.debug?.(`[outbox-registry] reaped idle`, {
        count: reaped,
        remaining: this.outboxes.size,
      });
    }
    return reaped;
  }

  /**
   * 等待所有 Outbox 排空并释放。Server 关停时调用。
   * 若某 Outbox 仍在 drain，等其完成；完成后移除。
   */
  async dispose(): Promise<void> {
    const waits = [...this.outboxes.values()].map((o) => o.waitIdle());
    await Promise.all(waits);
    this.outboxes.clear();
    this.logger?.debug?.(`[outbox-registry] disposed`);
  }
}

// ─── 工具 ───

/** target → outbox key。threadId 不入键——同一 to 的不同 thread 共享同一时间轴。 */
export function makeKey(target: DeliveryTarget): OutboxKey {
  return `${target.channelId}:${target.to}`;
}
