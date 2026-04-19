import {
  ChannelRegistry,
  createEventBus,
  type ChannelAdapter,
  type ChannelConfig,
  type ChannelEventMap,
  type ChannelLogger,
  type InboundMessage,
} from "@zhixing/core";
import { InboundRouter, type ConversationManager } from "@zhixing/server";
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
  conversations: ConversationManager;
  logger: ChannelLogger;
}

export interface SetupChannelsResult {
  registry: ChannelRegistry;
  router: InboundRouter;
}

export async function setupChannels(
  options: SetupChannelsOptions,
): Promise<SetupChannelsResult> {
  const { entries, conversations, logger } = options;

  const eventBus = createEventBus<ChannelEventMap>();

  let router: InboundRouter;

  const registry = new ChannelRegistry({
    eventBus,
    logger,
    onMessage: (msg: InboundMessage) => {
      router.handleMessage(msg).catch((err) => {
        logger.error("Unhandled error in message routing: %s", err instanceof Error ? err.message : String(err));
      });
    },
  });

  router = new InboundRouter({ conversations, channels: registry, logger });

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
