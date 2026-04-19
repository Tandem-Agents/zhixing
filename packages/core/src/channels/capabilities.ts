import type {
  ChannelAdapter,
  DeliveryResult,
  DeliveryTarget,
  Disposable,
  OutboundContent,
} from "./types.js";
import type { ConfirmationDecision, ConfirmationRequest } from "../confirmation/index.js";

// ─── Capability Traits ───

export interface EditableChannel {
  editMessage(messageId: string, content: OutboundContent): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
}

export interface ThreadableChannel {
  resolveThread(messageId: string): Promise<string | null>;
  sendToThread(threadId: string, content: OutboundContent): Promise<DeliveryResult>;
}

export interface StreamHandle {
  update(content: string): Promise<void>;
  finalize(content: OutboundContent): Promise<DeliveryResult>;
  abort(): Promise<void>;
}

export interface StreamableChannel {
  createStreamMessage(target: DeliveryTarget): Promise<StreamHandle>;
}

export interface ReactableChannel {
  addReaction(messageId: string, emoji: string): Promise<void>;
  removeReaction(messageId: string, emoji: string): Promise<void>;
}

export interface ApprovalHandle {
  onDecision(handler: (decision: ConfirmationDecision) => void): Disposable;
  dismiss(): Promise<void>;
}

export interface ApprovableChannel {
  renderApproval(request: ConfirmationRequest, target: DeliveryTarget): Promise<ApprovalHandle>;
}

export interface TypingChannel {
  sendTyping(target: DeliveryTarget): Promise<void>;
  stopTyping(target: DeliveryTarget): Promise<void>;
}

// ─── 类型守卫 ───

export function isEditable(adapter: ChannelAdapter): adapter is ChannelAdapter & EditableChannel {
  return "editMessage" in adapter && typeof (adapter as Record<string, unknown>).editMessage === "function";
}

export function isThreadable(adapter: ChannelAdapter): adapter is ChannelAdapter & ThreadableChannel {
  return "resolveThread" in adapter && typeof (adapter as Record<string, unknown>).resolveThread === "function";
}

export function isStreamable(adapter: ChannelAdapter): adapter is ChannelAdapter & StreamableChannel {
  return "createStreamMessage" in adapter && typeof (adapter as Record<string, unknown>).createStreamMessage === "function";
}

export function isReactable(adapter: ChannelAdapter): adapter is ChannelAdapter & ReactableChannel {
  return "addReaction" in adapter && typeof (adapter as Record<string, unknown>).addReaction === "function";
}

export function isApprovable(adapter: ChannelAdapter): adapter is ChannelAdapter & ApprovableChannel {
  return "renderApproval" in adapter && typeof (adapter as Record<string, unknown>).renderApproval === "function";
}

export function isTyping(adapter: ChannelAdapter): adapter is ChannelAdapter & TypingChannel {
  return "sendTyping" in adapter && typeof (adapter as Record<string, unknown>).sendTyping === "function";
}
