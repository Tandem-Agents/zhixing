export { AuthorityDeliveryPipeline } from "./authority-pipeline.js";
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
  SCHEDULER_USER_NOTICE_STREAM,
  assertDeliveryEnvelopeCompanions,
  bindDeliveryLifecycleDecisionRecords,
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
  projectDeliveryApplicationProjection,
  projectDeliveryLifecycleRecords,
  reduceDeliveryAuthorityRecord,
  validateDeliveryEnqueueKeyBody,
  validateDeliveryIntent,
  validateDeliveryStreamRecord,
} from "./authority.js";
export { DeliveryAuthority } from "./delivery-authority.js";
export type { DeliveryStatusPage, DeliverySubjectCursor } from "./delivery-authority.js";
export {
  DELIVERY_AUTHORITY_PROJECTION_ID,
  DELIVERY_PRIORITY_RANKS,
  loadDeliveryProjection,
  registerDeliveryAuthorityProjection,
} from "./authority-index.js";
export type { DeliveryNoticePosition } from "./authority-index.js";
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
  DeliveryProjection,
  DeliveryResolutionDecision,
  DeliveryResolutionInput,
  DeliveryResolutionRequestBinding,
} from "./authority.js";


export { DefaultDeliveryRouter, buildRoutingContext } from "./router.js";
export type {
  DeliveryRouter,
  RouteRequest,
  RoutingContext,
} from "./router.js";

export type {
  AuthorityDeliveryEventMap,
  AuthorityDeliveryItem,
  DeliveryApplicationProjection,
  DeliveryApplicationProjectionItem,
  AuthorityDeliverySendMeta,
  AuthorityDeliveryStats,
  DeliveryClaimablePage,
  DeliveryClaimablePageRequest,
  DeliveryDirectoryPage,
  DeliveryEndpointTransport,
  DeliveryEnqueueInput,
  DeliveryEnqueueResult,
  DeliveryLifecycleAdmission,
  DeliveryLifecycleRestoration,
  DeliveryLifecycleBinding,
  DeliveryLifecycleSourceOwner,
  DeliveryLifecycleSourcePermit,
  DeliveryLifecycleSourceRef,
  DeliveryEventMap,
  DeliveryItem,
  AuthorityDeliveryLogger,
  DeliveryOpenFact,
  DeliveryResolutionProjection,
  DeliveryStatusProjectionPort,
  DeliveryPriority,
  DeliveryResponseLossEvidence,
  DeliverySource,
  DeliveryStats,
  DeliveryTransport,
} from "./types.js";

// ─── Outbox（顺序层 / ADR-007） ───
export { Outbox } from "./outbox.js";
export { OutboxRegistry, makeKey as makeOutboxKey } from "./outbox-registry.js";
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
