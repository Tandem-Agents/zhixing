import {
  ChannelRegistry,
  createEventBus,
  type ChannelAdapter,
  type ChannelConfig,
  type ChannelEventMap,
  type ChannelLogger,
  type InboundMessage,
} from "@zhixing/core";
import {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  DEFAULT_CANCEL_KEYWORDS,
  InboundRouter,
  createDefaultIntentClassifier,
  type ConversationManager,
  type ConfirmationHub,
} from "@zhixing/server";
import type { ChannelConfigEntry } from "@zhixing/providers";

// ─── Adapter Factory ───

const ADAPTER_FACTORIES: Record<string, () => Promise<ChannelAdapter>> = {
  feishu: async () => {
    const { FeishuAdapter } = await import("@zhixing/channel-feishu");
    return new FeishuAdapter();
  },
};

function createAdapter(type: string): Promise<ChannelAdapter> {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) {
    throw new Error(`Unknown channel type: ${type}. Supported: ${Object.keys(ADAPTER_FACTORIES).join(", ")}`);
  }
  return factory();
}

// ─── Channel Setup ───

export interface SetupChannelsOptions {
  entries: Record<string, ChannelConfigEntry>;
  /** ConversationManager for inbound routing. Omit for outbound-only mode (REPL). */
  conversations?: ConversationManager;
  logger: ChannelLogger;
  /**
   * 可选 ConfirmationHub。传入时 InboundRouter 会在 enqueue 之前检查
   * pending confirmation，按词集匹配规则解决。
   */
  confirmationHub?: ConfirmationHub;
  /**
   * 用户配置的 cancel 关键词扩展（来自 `ZhixingConfig.intent.cancelKeywords`）。
   * 与 `DEFAULT_CANCEL_KEYWORDS` append 合并后注入 IntentClassifier；启动期
   * 静态互斥校验生效——配错关键词跟 confirmation 集合冲突会立即 throw。
   */
  cancelKeywords?: readonly string[];
}

export interface SetupChannelsResult {
  registry: ChannelRegistry;
  router: InboundRouter | null;
}

export async function setupChannels(
  options: SetupChannelsOptions,
): Promise<SetupChannelsResult> {
  const { entries, conversations, logger, confirmationHub, cancelKeywords } =
    options;

  const eventBus = createEventBus<ChannelEventMap>();

  let router: InboundRouter | null = null;

  const registry = new ChannelRegistry({
    eventBus,
    logger,
    onMessage: conversations
      ? (msg: InboundMessage) => {
          router!.handleMessage(msg).catch((err) => {
            logger.error("Unhandled error in message routing: %s", err instanceof Error ? err.message : String(err));
          });
        }
      : undefined,
  });

  if (conversations) {
    // 显式构造 IntentClassifier 注入——把 default 关键词与用户配置 append 合并，
    // 启动期 disjoint 校验生效（与 confirmation 词集冲突 fail-fast）。
    const mergedCancelKeywords =
      cancelKeywords && cancelKeywords.length > 0
        ? [...DEFAULT_CANCEL_KEYWORDS, ...cancelKeywords]
        : DEFAULT_CANCEL_KEYWORDS;
    const intentClassifier = createDefaultIntentClassifier({
      cancelKeywords: mergedCancelKeywords,
      confirmationApproveKeywords: APPROVE_KEYWORDS,
      confirmationDenyKeywords: DENY_KEYWORDS,
    });

    router = new InboundRouter({
      conversations,
      channels: registry,
      logger,
      confirmationHub,
      intentClassifier,
    });
  }

  for (const [id, entry] of Object.entries(entries)) {
    if (entry.enabled === false) continue;

    const type = entry.type ?? id;
    let adapter: ChannelAdapter;
    try {
      adapter = await createAdapter(type);
    } catch (err) {
      logger.error(
        "Failed to create adapter for channel '%s': %s",
        id,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    registry.register(adapter);

    const channelConfig: ChannelConfig = {
      type,
      enabled: true,
      credentials: entry.credentials,
      options: entry.options,
      defaultTarget: entry.defaultTarget
        ? { channelId: id, to: entry.defaultTarget.to }
        : undefined,
    };

    try {
      await registry.connect(adapter.id, channelConfig);
      logger.info("Channel '%s' connected", id);
    } catch (err) {
      logger.error(
        "Channel '%s' failed to connect (non-fatal): %s",
        id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { registry, router };
}
