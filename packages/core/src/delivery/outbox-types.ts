/**
 * Outbox 类型定义
 *
 * 规格：[message-outbox.md](../../../../research/design/specifications/message-outbox.md) §3.3
 *
 * Outbox 是叠加在 ChannelAdapter 之上的 per-target FIFO 串行化层。
 * 职责：顺序性（per-user 串行）+ 因果依赖（Phase 3 Turn Slot）。
 * 非职责：持久化、重试策略、过滤（归 DeliveryPipeline）。
 */

import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../channels/types.js";

// ─── Turn 相关标识 ───

/** 全局唯一的 turn 标识，由 ConversationManager 在 turn 开始时生成（Phase 3 启用） */
export type TurnId = string;

/** Turn Slot 的标识（与 TurnId 同源，Phase 3 启用因果阻塞） */
export type TurnSlotId = TurnId;

/** Outbox 实例的索引键，格式 `${channelId}:${to}` */
export type OutboxKey = string;

// ─── Entry 模型 ───

/** entry 的来源标签，用于日志、审计、未来策略分叉 */
export type EmissionSource =
  | {
      kind: "llm-reply";
      conversationId: string;
      turnId?: TurnId;
    }
  | {
      kind: "tool-commitment";
      conversationId: string;
      turnId?: TurnId;
      toolName: string;
    }
  | {
      kind: "scheduled-task";
      taskId: string;
      createdInTurn?: TurnId;
    }
  | {
      kind: "system";
      handler: string;
    };

/** Outbox 队列中的单个 entry */
export interface OutboxEntry {
  /** 便于日志追踪的 entry id */
  readonly id: string;
  readonly target: DeliveryTarget;
  readonly content: OutboundContent;
  readonly source: EmissionSource;
  /**
   * 因果依赖（Phase 3 启用）：若指定，drain 时必须等待 slotId 进入终态后才发送。
   * Phase 1 阶段忽略此字段，仅保留类型面以避免 Phase 3 时破坏调用方。
   */
  readonly afterSlot?: TurnSlotId;
  /** 入队时间（ISO-8601），用于观测 */
  readonly enqueuedAt: string;
}

// ─── 事件模型 ───

/**
 * Outbox 生命周期事件——通过构造函数的 `onEvent` 回调上报。
 * 消费者：测试（断言顺序）、生产日志、遥测。
 */
export type OutboxEvent =
  | { type: "entry:enqueued"; key: OutboxKey; entry: OutboxEntry }
  | {
      type: "entry:sent";
      key: OutboxKey;
      entry: OutboxEntry;
      result: DeliveryResult;
      attemptLatencyMs: number;
    }
  | {
      type: "entry:failed";
      key: OutboxKey;
      entry: OutboxEntry;
      error: string;
    };

// ─── 日志 & 回调接口 ───

/** 最小 logger 接口（与 @zhixing/core 其他模块一致） */
export interface OutboxLogger {
  debug?(msg: string, data?: unknown): void;
  info?(msg: string, data?: unknown): void;
  warn?(msg: string, data?: unknown): void;
  error?(msg: string, data?: unknown): void;
}

/** Outbox drain 时实际对外发送的回调。由 Registry 注入，Outbox 本身不知道 adapter 存在。 */
export type OutboxDoSend = (
  target: DeliveryTarget,
  content: OutboundContent,
) => Promise<DeliveryResult>;

// ─── 配置 ───

export interface OutboxOptions {
  /** adapter.send 的超时兜底（默认 30_000 ms），防 channel 卡死拖垮 drain */
  readonly sendTimeoutMs?: number;
  /** 事件回调 */
  readonly onEvent?: (event: OutboxEvent) => void;
  /** 日志钩子 */
  readonly logger?: OutboxLogger;
  /** 时间源，测试时可注入；默认 Date.now */
  readonly now?: () => number;
}

// ─── Registry 配置 ───

export interface OutboxRegistryOptions extends OutboxOptions {
  /** 空闲超时——超过此时长未访问的 Outbox 可被 reapIdle 回收（默认 10 分钟） */
  readonly idleTimeoutMs?: number;
}

/** 构造 entry 的便捷入参（Outbox 自动补 id + enqueuedAt） */
export interface PostEntryInput {
  readonly target: DeliveryTarget;
  readonly content: OutboundContent;
  readonly source: EmissionSource;
  readonly afterSlot?: TurnSlotId;
}

// ─── 默认值 ───

export const DEFAULT_SEND_TIMEOUT_MS = 30_000;
export const DEFAULT_REGISTRY_IDLE_MS = 10 * 60_000;
