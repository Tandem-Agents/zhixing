export { DeliveryPipeline } from "./pipeline.js";
export type {
  DeliveryLogger,
  DeliveryPipelineConfig,
  DeliveryPipelineDeps,
} from "./pipeline.js";
export { DEFAULT_DELIVERY_CONFIG } from "./pipeline.js";

export { DeliveryQueue } from "./queue.js";
export type { DeliveryQueueOptions } from "./queue.js";

export { DefaultDeliveryRouter, buildRoutingContext } from "./router.js";
export type {
  DeliveryRouter,
  RouteRequest,
  RoutingContext,
} from "./router.js";

export type {
  DeliveryEventMap,
  DeliveryItem,
  DeliveryPriority,
  DeliverySender,
  DeliverySource,
  DeliveryStats,
  EnqueueParams,
  IDeliveryPipeline,
} from "./types.js";

// ─── Outbox（顺序层 / ADR-007） ───
export { Outbox } from "./outbox.js";
export { OutboxRegistry, makeKey as makeOutboxKey } from "./outbox-registry.js";
export { createOutboxSender } from "./outbox-sender.js";
export type { OutboxSenderOptions } from "./outbox-sender.js";
export type { DeliverySendMeta } from "./types.js";
export type {
  EmissionSource,
  OpenSlotOptions,
  OutboxDoSend,
  OutboxEntry,
  OutboxEvent,
  OutboxKey,
  OutboxLogger,
  OutboxOptions,
  OutboxRegistryOptions,
  PostEntryInput,
  SlotInfo,
  SlotState,
  SlotTerminalState,
  TurnId,
  TurnSlotId,
} from "./outbox-types.js";
