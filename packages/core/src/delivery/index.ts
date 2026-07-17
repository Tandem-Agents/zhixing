export { DeliveryPipeline } from "./pipeline.js";
export type {
  DeliveryLogger,
  DeliveryPipelineConfig,
  DeliveryPipelineDeps,
} from "./pipeline.js";
export { DEFAULT_DELIVERY_CONFIG } from "./pipeline.js";

export { AuthorityDeliveryPipeline } from "./authority-pipeline.js";
export { channelAuthorityDeliveryTransport } from "./authority-pipeline.js";
export type {
  AuthorityDeliveryPipelineConfig,
  AuthorityDeliveryPipelineDeps,
} from "./authority-pipeline.js";
export { DEFAULT_AUTHORITY_DELIVERY_CONFIG } from "./authority-pipeline.js";
export { DeliveryTransportRegistry } from "./transport-registry.js";
export {
  compileDeliveryContent,
  DeliveryContentValidationError,
} from "./content.js";
export type { CompiledDeliveryContent } from "./content.js";
export type { DeliveryStatusNotice } from "../contracts/index.js";

export {
  DELIVERY_STREAM,
  assertDeliveryEnvelopeCompanions,
  DeliveryAuthority,
  decideDeliveryResolution,
  deliveryIdempotencyKey,
  deliveryIntentDigest,
  deliveryItemId,
  deliveryOpenFactDigest,
  deliveryResponseBindingDigest,
  deliveryRecord,
  deliveryResolutionFactBindsRequest,
  deliveryResolutionStatusNotice,
  deliveryResolutionFactDigest,
  emptyDeliveryProjection,
  prepareDeliveryEnqueues,
  reduceDeliveryAuthorityRecord,
  validateDeliveryEnqueueKeyBody,
  validateDeliveryIntent,
  validateDeliveryStreamRecord,
} from "./authority.js";
export { validateOutboundContentDto } from "./content-schema.js";
export {
  assertDeliveryItemId,
  DELIVERY_ITEM_ID_PREFIX,
  isDeliveryItemId,
  MAX_DELIVERY_DIAGNOSTIC_TEXT_LENGTH,
  MAX_DELIVERY_IDENTIFIER_LENGTH,
  projectDeliveryDisplayText,
} from "./validation.js";
export type {
  DeliveryAttemptClaim,
  DeliveryClaimResult,
  DeliveryOutcome,
  DeliveryOutcomeDecision,
  DeliveryProjection,
  DeliveryResolutionDecision,
  DeliveryResolutionInput,
  DeliveryResolutionRequestBinding,
} from "./authority.js";

export { DeliveryQueue } from "./queue.js";
export type { DeliveryQueueOptions } from "./queue.js";
export { AuthorityDeliveryQueue } from "./authority-queue.js";
export type { AuthorityDeliveryQueueOptions } from "./authority-queue.js";

export { DefaultDeliveryRouter, buildRoutingContext } from "./router.js";
export type {
  DeliveryRouter,
  RouteRequest,
  RoutingContext,
} from "./router.js";

export type {
  AuthorityDeliveryEventMap,
  AuthorityDeliveryItem,
  AuthorityDeliverySendMeta,
  AuthorityDeliveryStats,
  DeliveryEndpointTransport,
  DeliveryEnqueueInput,
  DeliveryEnqueueResult,
  DeliveryEventMap,
  DeliveryItem,
  AuthorityDeliveryLogger,
  DeliveryOpenFact,
  DeliveryPriority,
  DeliverySender,
  DeliverySource,
  DeliveryStats,
  DeliveryTransport,
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
