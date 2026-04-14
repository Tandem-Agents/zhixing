// Confirmation — 确认交互系统的公开 API

export type {
  BrokerSnapshot,
  BrokerUnsubscribe,
  CancelCause,
  ConfirmationDecision,
  ConfirmationDisplay,
  ConfirmationEventMap,
  ConfirmationOption,
  ConfirmationOptionKind,
  ConfirmationRenderer,
  ConfirmationRequest,
  ConfirmationRequestId,
  DisplayBody,
  IConfirmationBroker,
  NonInteractiveResolver,
  PendingSnapshot,
  RendererCapabilities,
  RequestListener,
} from "./types.js";

export {
  ConfirmationBroker,
  createConfirmationBroker,
  generateRequestId,
} from "./broker.js";
export type { ConfirmationBrokerOptions } from "./broker.js";

export {
  failToDenyResolver,
  failToExpiredResolver,
  getBuiltinNonInteractiveResolver,
} from "./non-interactive.js";
