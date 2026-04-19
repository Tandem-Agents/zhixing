export {
  type ChannelAdapter,
  type ChannelBindingPolicy,
  type ChannelCapabilities,
  type ChannelConfig,
  type ChannelContext,
  type ChannelEventMap,
  type ChannelLogger,
  type ChannelState,
  type ChannelStatus,
  type ChatType,
  type DeliveryResult,
  type DeliveryTarget,
  type Disposable,
  type HttpHandler,
  type InboundMessage,
  type OutboundContent,
  DEFAULT_BINDING_POLICY,
} from "./types.js";

export {
  type ApprovableChannel,
  type ApprovalHandle,
  type EditableChannel,
  type ReactableChannel,
  type StreamableChannel,
  type StreamHandle,
  type ThreadableChannel,
  type TypingChannel,
  isApprovable,
  isEditable,
  isReactable,
  isStreamable,
  isThreadable,
  isTyping,
} from "./capabilities.js";

export { ChannelRegistry, type ChannelRegistryOptions } from "./registry.js";
