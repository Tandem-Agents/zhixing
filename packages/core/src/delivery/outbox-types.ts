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

// ─── Slot 状态（ADR-007 Phase 3） ───

/**
 * Turn Slot 的终态——进入任何一个终态即释放等待在此 slot 上的 entry。
 * INV-4（slot 单调性）：slot 一旦开启，必在有限时间内进入终态之一。
 */
export type SlotTerminalState = "filled" | "abandoned" | "expired";

/** Slot 的完整状态（pending 或一种终态） */
export type SlotState = "pending" | SlotTerminalState;

/** 开启 slot 的选项 */
export interface OpenSlotOptions {
  /** slot 的全局 id（通常 = TurnId）；同一 id 重复 open 视为幂等（已存在直接返回） */
  readonly slotId: TurnSlotId;
  /** TTL 毫秒——超时后 slot 自动置 expired。默认 10 分钟 */
  readonly ttlMs?: number;
}

/** Slot 运行时信息（观测用） */
export interface SlotInfo {
  readonly slotId: TurnSlotId;
  readonly state: SlotState;
  readonly openedAt: string;
  readonly closedAt?: string;  // filled/abandoned/expired 时填充
  readonly closeReason?: string; // abandon 的原因文本
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
    }
  | {
      /**
       * 因果断链——drain 放行了一个 `afterSlot` 未得到正常 `filled` 终态的 entry。
       * 可能原因：
       *  - `orphan-slot`: entry 引用的 slotId 在本 Outbox 从未 open（通常是对应 Outbox 已被 reapIdle 回收后的 task fire，合法但丢失因果）
       *  - `slot-abandoned`: slot 因 turn 异常被 abandonSlot
       *  - `slot-expired`: slot 达到 TTL 未 fill
       * 外部监控应订阅此事件以告警"因果顺序已非严格保证"。
       */
      type: "entry:causal-broken";
      key: OutboxKey;
      entry: OutboxEntry;
      slotId: TurnSlotId;
      reason: "orphan-slot" | "slot-abandoned" | "slot-expired";
      /** abandon 时的 reason 文本，或 expired 时为 undefined */
      slotCloseReason?: string;
    }
  | {
      type: "slot:opened";
      key: OutboxKey;
      slotId: TurnSlotId;
      /** TTL 毫秒；`null` 表示禁用 TTL（openSlot 传入的 ttlMs <= 0） */
      ttlMs: number | null;
    }
  | {
      type: "slot:filled";
      key: OutboxKey;
      slotId: TurnSlotId;
      /** 若 fillSlot 携带了 entry，这里是 entry id */
      entryId?: string;
    }
  | {
      type: "slot:abandoned";
      key: OutboxKey;
      slotId: TurnSlotId;
      reason: string;
    }
  | {
      type: "slot:expired";
      key: OutboxKey;
      slotId: TurnSlotId;
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
/** Turn Slot 默认 TTL —— 10 分钟（ADR-007 Phase 3） */
export const DEFAULT_SLOT_TTL_MS = 10 * 60_000;
