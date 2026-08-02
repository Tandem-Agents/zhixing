import type {
  ArtifactRef,
  DeliveryEndpointDto,
  DeliveryEnqueueKeyBody,
  DeliveryFailure,
  DeliveryIntentDto,
  DeliveryItemState,
  DeliveryResolutionFact,
  DeliveryStatusNotice,
  DeliveryStreamRecord,
} from "../contracts/index.js";
import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
  OutboundContentDto,
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
  | { kind: "agent"; conversationId: string; turnSlotId?: string }
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
  readonly idempotencyKey?: string;
  readonly attempt?: number;
}

export interface DeliverySender {
  send(
    target: DeliveryTarget,
    content: OutboundContent,
    meta?: DeliverySendMeta,
  ): Promise<DeliveryResult>;
  isReady(channelId: string): boolean;
}

// ─── 权威投递流的只读投影与执行适配 ───

export interface DeliveryOpenFact {
  readonly itemId: string;
  readonly attempt: number;
  readonly openedAnchorEpoch: number;
  readonly startedAt: string;
  readonly unknownOutcome: Extract<
    DeliveryStreamRecord,
    { t: "attempt-started" }
  >["unknownOutcome"];
  readonly idempotencyKey: string;
  readonly openFactDigest: string;
}

export interface AuthorityDeliveryItem {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly keyBody: DeliveryEnqueueKeyBody;
  readonly intentDigest: string;
  readonly endpoint: DeliveryEndpointDto;
  readonly content: OutboundContentDto | { readonly ref: ArtifactRef };
  readonly priority: DeliveryPriority;
  readonly source?: DeliverySource;
  readonly createdAt: string;
  readonly maxAttempts: number;
  readonly state: DeliveryItemState;
  readonly statusRevision: number;
  readonly attempts: number;
  readonly currentAttempt: number;
  readonly automaticAttemptsUsed: number;
  readonly pendingManualRetryFactDigest?: string;
  readonly nextAttemptAt?: string;
  readonly lastError?: DeliveryFailure;
  readonly receiptDigest?: string;
  readonly openFact?: DeliveryOpenFact;
  readonly resolution?: DeliveryResolutionFact;
}

export interface AuthorityDeliveryStats {
  readonly pending: number;
  readonly queued: number;
  readonly attempting: number;
  readonly delivered: number;
  readonly failed: number;
  readonly retrying: number;
  readonly uncertain: number;
}

export interface AuthorityDeliveryEventMap extends EventMap {
  "delivery:notice": { notice: DeliveryStatusNotice };
  "delivery:success": {
    itemId: string;
    endpoint: DeliveryEndpointDto;
    attempts: number;
  };
  "delivery:failed": {
    itemId: string;
    endpoint: DeliveryEndpointDto;
    error: string;
    attempts: number;
    statusRevision: number;
  };
  "delivery:retry": {
    itemId: string;
    endpoint: DeliveryEndpointDto;
    attempt: number;
    nextAttemptAt: string;
  };
  "delivery:uncertain": {
    itemId: string;
    endpoint: DeliveryEndpointDto;
    attempt: number;
    openFactDigest: string;
    statusRevision: number;
  };
  "delivery:resolved": {
    itemId: string;
    attempt: number;
    decision: DeliveryResolutionFact["decision"];
    statusRevision: number;
  };
}

export interface AuthorityDeliverySendMeta extends DeliverySendMeta {
  readonly itemId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
}

export interface DeliveryTransport {
  /** Captures one ready adapter for the whole attempt preparation/send boundary. */
  resolve(endpoint: DeliveryEndpointDto): DeliveryEndpointTransport | undefined;
}

export interface DeliveryEndpointTransport {
  readonly endpointKind: DeliveryEndpointDto["kind"];
  send(
    endpoint: DeliveryEndpointDto,
    content: OutboundContent,
    meta: AuthorityDeliverySendMeta,
  ): Promise<DeliveryResult>;
  isReady(endpoint: DeliveryEndpointDto): boolean;
  outcomePolicy(endpoint: DeliveryEndpointDto):
    | { readonly kind: "manual-resolution" }
    | { readonly kind: "idempotent-redrive"; readonly windowMs: number };
}

export interface DeliveryEnqueueInput {
  readonly keyBody: DeliveryEnqueueKeyBody;
  readonly intent: DeliveryIntentDto;
}

export type DeliveryEnqueueResult =
  | {
      readonly accepted: true;
      readonly records: readonly DeliveryStreamRecord[];
      readonly items: ReadonlyArray<{
        readonly itemId: string;
        readonly state: DeliveryItemState;
        readonly statusRevision: number;
      }>;
    }
  | {
      readonly accepted: false;
      readonly error: {
        readonly code: "idempotency-conflict";
        readonly message: string;
        readonly retryable: false;
      };
    };

export interface AuthorityDeliveryLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}
