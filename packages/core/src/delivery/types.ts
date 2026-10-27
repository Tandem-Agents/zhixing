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

// ─── 权威投递流的只读投影与执行适配 ───

export interface DeliveryOpenFact {
  readonly itemId: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly unknownOutcome: Extract<
    DeliveryStreamRecord,
    { t: "attempt-started" }
  >["unknownOutcome"];
  readonly idempotencyKey: string;
  readonly openFactDigest: string;
}

export interface DeliveryResolutionProjection {
  readonly itemId: string;
  readonly attempt: number;
  readonly openFactDigest: string;
  readonly decision: DeliveryResolutionFact["decision"];
  readonly by: string;
  readonly at: string;
  readonly factDigest: string;
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
  readonly resolution?: DeliveryResolutionProjection;
  readonly lifecycleBinding?: DeliveryLifecycleBinding;
}

/** Topology-neutral state supplied to Delivery application decisions. */
export interface DeliveryApplicationProjectionItem extends AuthorityDeliveryItem {
  readonly attemptStarted?: Extract<DeliveryStreamRecord, { readonly t: "attempt-started" }>;
}

export interface DeliveryApplicationProjection {
  readonly items: ReadonlyMap<string, DeliveryApplicationProjectionItem>;
  readonly itemByKey: ReadonlyMap<string, string>;
}

/** Correctness-owned public status projection; Delivery applications do not construct it. */
export interface DeliveryStatusProjectionPort {
  statusNotice(itemId: string, statusRevision: number): Promise<DeliveryStatusNotice | undefined>;
}

/** 领取目录的一页请求：ready 取 queued 与 attempting，retry 取下次尝试不晚于 now 的 retry-wait。 */
export interface DeliveryClaimablePageRequest {
  readonly priority: "high" | "normal" | "low";
  readonly kind: "ready" | "retry";
  readonly now: string;
  readonly afterKey?: string;
  readonly limit: number;
  /**
   * 本轮上界：只给出进入当前目录时的日志位置不大于它的条目，之后入列的留给下一轮。省略时以本页读到的
   * 投影位置为上界，并在结果里给出，供同一轮的后续页沿用。
   */
  readonly enteredThrough?: number;
}

/** 目录的一页：每条带它的目录键，从最后一个键之后续读。 */
export interface DeliveryDirectoryPage {
  readonly items: readonly { readonly key: string; readonly item: AuthorityDeliveryItem }[];
  readonly more: boolean;
}

/** 领取目录的一页：next 是本页最后扫过的键（含因超出本轮上界而跳过的），从它之后续读。 */
export interface DeliveryClaimablePage extends DeliveryDirectoryPage {
  readonly enteredThrough: number;
  readonly next?: string;
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

export interface AuthorityDeliverySendMeta {
  readonly source?: DeliverySource;
  readonly itemId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
}

export interface DeliveryTransport {
  /** Captures one ready adapter for the whole attempt preparation/send boundary. */
  resolve(endpoint: DeliveryEndpointDto): DeliveryEndpointTransport | undefined;
}

export type DeliveryResponseLossEvidence =
  | { readonly kind: "unverified" }
  | { readonly kind: "idempotent"; readonly windowMs: number };

export interface DeliveryEndpointTransport {
  readonly endpointKind: DeliveryEndpointDto["kind"];
  send(
    endpoint: DeliveryEndpointDto,
    content: OutboundContent,
    meta: AuthorityDeliverySendMeta,
  ): Promise<DeliveryResult>;
  isReady(endpoint: DeliveryEndpointDto): boolean;
  responseLossEvidence(endpoint: DeliveryEndpointDto): DeliveryResponseLossEvidence;
}

export interface DeliveryEnqueueInput {
  readonly keyBody: DeliveryEnqueueKeyBody;
  readonly intent: DeliveryIntentDto;
  /**
   * Identifies the accepted-work owner whose durable source fact is allowed to
   * create this delivery while a device lifecycle operation owns admission.
   * It is deliberately not part of the delivery record: the existing source
   * companion remains the durable source fact.
   */
  readonly lifecycleSources?: readonly DeliveryLifecycleSourceRef[];
}

export type DeliveryLifecycleSourceOwner = "conversation" | "assignment" | "scheduler";

export interface DeliveryLifecycleSourceRef {
  readonly owner: DeliveryLifecycleSourceOwner;
  readonly id: string;
  readonly revision: string;
}

export type DeliveryLifecycleSourcePermit = DeliveryLifecycleSourceRef;

export interface DeliveryLifecycleAdmission {
  readonly operationId: string;
  readonly sources: readonly DeliveryLifecycleSourcePermit[];
  readonly deliveries: readonly {
    readonly id: string;
    readonly revision: string;
  }[];
}

export interface DeliveryLifecycleRestoration extends DeliveryLifecycleAdmission {
  readonly sealed: boolean;
}

export interface DeliveryLifecycleBinding {
  readonly operationId: string;
  readonly sources: readonly DeliveryLifecycleSourcePermit[];
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
