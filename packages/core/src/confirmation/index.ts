// Confirmation — 确认交互系统的公开 API

export type {
  BrokerSnapshot,
  BrokerUnsubscribe,
  CancelCause,
  ConfirmationDecision,
  ConfirmationAdmissionDisposition,
  ConfirmationDisplay,
  ConfirmationEventMap,
  ConfirmationFallbackStrategy,
  ConfirmationLifecycleObserver,
  ConfirmationOption,
  ConfirmationOptionKind,
  ConfirmationRenderer,
  ConfirmationRendererPort,
  ConfirmationRequest,
  ConfirmationRequestId,
  ConfirmationResolutionSource,
  DisplayBody,
  IConfirmationBroker,
  NonInteractiveResolver,
  PendingSnapshot,
  RendererCapabilities,
  RequestListener,
  ResolvedListener,
} from "./types.js";

export {
  ConfirmationBroker,
  createConfirmationBroker,
  generateRequestId,
} from "./broker.js";
export type { ConfirmationBrokerOptions } from "./broker.js";

export { isFreeTextDeny, validateConfirmationDecisionText } from "./types.js";

export {
  failToAllowResolver,
  failToDenyResolver,
  failToExpiredResolver,
} from "./non-interactive.js";

export {
  buildConfirmationRequest,
  buildConfirmationOptions,
  buildDisplayBody,
  buildPanelTitle,
  sanitizeCommandPreview,
} from "./request-builder.js";
export type { BuildConfirmationRequestParams } from "./request-builder.js";
