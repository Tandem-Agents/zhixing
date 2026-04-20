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
  | { kind: "scheduler"; taskId: string; taskName: string }
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

// ─── 过滤器（可插拔链式过滤） ───

export type FilterVerdict =
  | { pass: true }
  | { pass: false; reason: string };

export interface DeliveryFilter {
  readonly name: string;
  check(item: DeliveryItem): FilterVerdict | Promise<FilterVerdict>;
}

// ─── 发送器（抽象通道发送，解耦 ChannelRegistry） ───

export interface DeliverySender {
  send(
    target: DeliveryTarget,
    content: OutboundContent,
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
