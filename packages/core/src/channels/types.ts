import type { EventMap, IEventBus } from "../events/index.js";

// ─── Disposable ───

export interface Disposable {
  dispose(): void;
}

// ─── 聊天类型 ───

export type ChatType = "dm" | "group" | "channel" | "thread";

// ─── 通道能力声明 ───

export interface ChannelCapabilities {
  chatTypes: ChatType[];
  media: boolean;
  edit: boolean;
  streaming: boolean;
}

// ─── 入站消息 ───

export interface InboundMessage {
  from: string;
  text: string;
  channelId: string;
  chatType: ChatType;
  messageId?: string;
  timestamp?: string;
  groupId?: string;
  threadId?: string;
  mediaUrls?: string[];
  isCommand?: boolean;
  raw?: unknown;
}

// ─── 出站内容 ───

export interface OutboundContent {
  text: string;
  markdown?: string;
  media?: Array<{ url: string; type: "image" | "file" | "audio" | "video" }>;
}

// ─── 投递目标 ───

export interface DeliveryTarget {
  channelId: string;
  to: string;
  threadId?: string;
}

// ─── 投递结果 ───

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
  retryable: boolean;
}

// ─── 通道配置 ───

export interface ChannelConfig {
  type: string;
  enabled: boolean;
  credentials: Record<string, string>;
  defaultTarget?: DeliveryTarget;
  options?: Record<string, unknown>;
}

// ─── 通道状态 ───

export type ChannelState = "connected" | "connecting" | "disconnected" | "error";

export interface ChannelStatus {
  channelId: string;
  state: ChannelState;
  error?: string;
  lastMessageAt?: string;
  connectedAt?: string;
}

// ─── 对话归组策略 ───

export interface ChannelBindingPolicy {
  dm: "per-user";
  group: "per-group" | "per-user-in-group";
  thread: "per-thread";
}

// ─── ChannelContext（Server 注入给适配器的上下文） ───

export type HttpHandler = (req: unknown, res: unknown) => void | Promise<void>;

export interface ChannelContext {
  config: ChannelConfig;
  abortSignal: AbortSignal;
  eventBus: IEventBus<ChannelEventMap>;
  logger: ChannelLogger;

  onMessage(msg: InboundMessage): void;
  registerHttpRoute(path: string, handler: HttpHandler): void;
}

// ─── 通道事件 ───

export interface ChannelEventMap extends EventMap {
  "channel:connected": { channelId: string };
  "channel:disconnected": { channelId: string; reason?: string };
  "channel:error": { channelId: string; error: string };
  "channel:message-received": { channelId: string; message: InboundMessage };
}

// ─── Logger（最小接口，不绑定具体日志库） ───

export interface ChannelLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ─── ChannelAdapter 核心接口 ───

export interface ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;

  connect(ctx: ChannelContext): Promise<void>;
  disconnect(): Promise<void>;
  send(target: DeliveryTarget, content: OutboundContent): Promise<DeliveryResult>;

  bindingPolicy?: ChannelBindingPolicy;
}

// ─── 默认归组策略 ───

export const DEFAULT_BINDING_POLICY: ChannelBindingPolicy = {
  dm: "per-user",
  group: "per-group",
  thread: "per-thread",
};
