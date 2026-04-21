import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../channels/types.js";
import type { EventMap } from "../events/index.js";

// ─── 投递优先级 ───

export type DeliveryPriority = "low" | "normal" | "high";

// ─── 投递来源（溯源追踪） ───

export type DeliverySource =
  | {
      kind: "scheduler";
      taskId: string;
      taskName: string;
      /**
       * 创建此任务的 turn id（ADR-007 Phase 3）。
       * 由 OutboxSender 映射为 OutboxEntry.afterSlot，保证 task-fire 排在
       * 创建 turn 的 LLM 回复之后送达。未提供 = 任务创建上下文不是 turn（如 API/CLI），无需排序依赖。
       */
      createdInTurn?: string;
    }
  | { kind: "agent"; conversationId: string }
  | { kind: "system"; reason: string };

// ─── 投递项（队列中的单元） ───

export interface DeliveryItem {
  id: string;
  target: DeliveryTarget;
  content: OutboundContent;
  priority: DeliveryPriority;
  source?: DeliverySource;
  createdAt: string;

  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}

// ─── 投递统计 ───

export interface DeliveryStats {
  queued: number;
  delivered: number;
  failed: number;
  retrying: number;
}

// ─── 投递事件 ───

export interface DeliveryEventMap extends EventMap {
  "delivery:enqueued": { itemId: string; target: DeliveryTarget };
  "delivery:success": {
    itemId: string;
    target: DeliveryTarget;
    attempts: number;
  };
  "delivery:failed": {
    itemId: string;
    target: DeliveryTarget;
    error: string;
    attempts: number;
  };
  "delivery:retry": {
    itemId: string;
    target: DeliveryTarget;
    attempt: number;
    nextAttemptAt: string;
  };
}

// ─── 发送器（抽象通道发送，解耦 ChannelRegistry） ───

/**
 * 传递给 sender.send 的元数据（可选）。
 * Pipeline 调用时会传入 item 的 source 和 id，供 Outbox 等上游生成更精细的事件/日志/源标签。
 * 兼容：meta 可选，不影响不需要此信息的实现。
 */
export interface DeliverySendMeta {
  readonly source?: DeliverySource;
  readonly itemId?: string;
}

export interface DeliverySender {
  send(
    target: DeliveryTarget,
    content: OutboundContent,
    meta?: DeliverySendMeta,
  ): Promise<DeliveryResult>;
  isReady(channelId: string): boolean;
}

// ─── 入队参数 ───

export interface EnqueueParams {
  target: DeliveryTarget;
  content: OutboundContent;
  priority?: DeliveryPriority;
  source?: DeliverySource;
  maxAttempts?: number;
}

// ─── Pipeline 接口 ───

export interface IDeliveryPipeline {
  enqueue(params: EnqueueParams): Promise<string>;
  flush(): Promise<void>;
  stats(): DeliveryStats;
}
