import type { EventMap, IEventBus } from "../events/index.js";
import type {
  ChannelChallengeToken,
  ChannelResponderRef,
  InteractionDisplay,
} from "../contracts/index.js";

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

/** Platform-authenticated callback emitted by an interactive channel message. */
export interface ChannelChallengeAction {
  readonly token: ChannelChallengeToken;
  readonly responder: ChannelResponderRef;
  readonly decision: {
    readonly allowed: boolean;
    readonly reason?: string;
  };
  readonly raw?: unknown;
}

/** Signed challenge rendered by a channel adapter without exposing owner tickets. */
export interface ChannelChallengeMessage {
  readonly challengeId: string;
  readonly token: ChannelChallengeToken;
  readonly responder: ChannelResponderRef;
  readonly toolName: string;
  readonly display: InteractionDisplay;
  readonly renderedDisplay?: Extract<
    InteractionDisplay,
    { readonly title: string }
  >;
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

/** 投递目标的 wire 白名单，领域类型新增字段不会自动扩权。 */
export interface DeliveryTargetDto {
  channelId: string;
  to: string;
  threadId?: string;
}

/** 出站内容的内容寻址快照。 */
export interface OutboundContentDto {
  text: string;
  markdown?: string;
  media?: Array<{
    ref: import("../types/distributed.js").ArtifactRef;
    type: "image" | "file" | "audio" | "video";
  }>;
}

// ─── 投递结果 ───

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  /** Exact immutable receipt bytes returned by the external service. */
  receiptBytes?: Uint8Array;
  error?: string;
  retryable: boolean;
}

export interface DeliveryAdapterSendMeta {
  /** Stable across every redrive of the same durable delivery item. */
  idempotencyKey?: string;
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
  /**
   * 群聊是否按群共享一条会话,或按群内成员拆分。
   *
   * 私聊固定进入用户主对话;thread 固定按 threadId 归组。它们不是 adapter
   * 可选择的策略,避免接入面把来源误当成对话边界。
   */
  group: "per-group" | "per-user-in-group";
}

// ─── ChannelContext（Server 注入给适配器的上下文） ───

export type HttpHandler = (req: unknown, res: unknown) => void | Promise<void>;

export interface ChannelContext {
  config: ChannelConfig;
  abortSignal: AbortSignal;
  eventBus: IEventBus<ChannelEventMap>;
  logger: ChannelLogger;

  onMessage(msg: InboundMessage): void;
  /**
   * 渠道 callback 的可等待入口:宿主只在耐久裁决完成后 resolve,adapter
   * 必须等它成功才向平台返回成功——发送方看到的"已受理"即已耐久。
   */
  onChallengeAction(action: ChannelChallengeAction): Promise<void>;
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
  send(
    target: DeliveryTarget,
    content: OutboundContent,
    meta?: DeliveryAdapterSendMeta,
  ): Promise<DeliveryResult>;

  bindingPolicy?: ChannelBindingPolicy;
}

// ─── 默认归组策略 ───

export const DEFAULT_BINDING_POLICY: ChannelBindingPolicy = {
  group: "per-group",
};
