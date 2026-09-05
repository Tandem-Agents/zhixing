import {
  ChannelRegistry,
  type ChannelAdapter,
  type ChannelConfig,
  type ChannelEventMap,
  type ChannelLogger,
  type ChannelStatus,
  type DeliveryResult,
  type DeliveryTarget,
  type InboundMessage,
  type ChannelChallengeAction,
  type ChannelChallengeMessage,
  type HttpHandler,
  type OutboundContent,
  isChallengeChannel,
} from "@zhixing/core/channels";
import { createEventBus } from "@zhixing/core";
import type { ChannelDeliveryEffectSource } from "@zhixing/core/delivery/channel-effect";
import {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  DEFAULT_CANCEL_KEYWORDS,
  InboundRouter,
  createDefaultIntentClassifier,
  type InboundChannelPort,
  type InboundConversationApplicationPort,
  type InboundDeliveryOutboxPort,
} from "@zhixing/server";
import type { ConfirmationHub } from "@zhixing/owner-kernel/confirmation-hub";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc";
import type {
  ChannelCredentialProjection,
  MessagingChannelEntry,
} from "@zhixing/providers";
import type { ChannelChallengeDeliveryPort } from "./lossless-data-plane-runtime.js";

// ─── Adapter Factory ───

interface ChannelAdapterFactory {
  readonly adapterType: string;
  create(): Promise<ChannelAdapter>;
}

const ADAPTER_FACTORIES: Readonly<Record<string, ChannelAdapterFactory>> = {
  feishu: {
    adapterType: "feishu",
    create: async () => {
      const { FeishuAdapter } = await import("@zhixing/channel-feishu");
      return new FeishuAdapter();
    },
  },
};

/** Derived from the production factory table, not a separately maintained channel list. */
export function captureChannelAdapterFactoryDescriptor(): readonly {
  readonly configType: string;
  readonly adapterType: string;
}[] {
  return Object.entries(ADAPTER_FACTORIES)
    .map(([configType, factory]) => ({
      configType,
      adapterType: factory.adapterType,
    }))
    .sort((left, right) => left.configType.localeCompare(right.configType, "en-US"));
}

function createAdapter(type: string): Promise<ChannelAdapter> {
  const factory = ADAPTER_FACTORIES[type];
  if (!factory) {
    throw new Error(`Unknown channel type: ${type}. Supported: ${Object.keys(ADAPTER_FACTORIES).join(", ")}`);
  }
  return factory.create();
}

// ─── Channel Setup ───

export interface SetupChannelsOptions {
  /**
   * 启用的 channel 列表（来自 config.messaging）。
   *
   * 出现在 entries 的 channel 视为启用；entries[id] 是 MessagingChannelEntry，
   * 仅含功能选项（type / options / defaultTarget），不含凭证。
   */
  entries: Record<string, MessagingChannelEntry>;
  /**
   * 组合根从 SecretStore 解出的 channel-only 投影。
   *
   * setupChannels 内部把 `credentials.channels[id]` 整体作为 ChannelConfig.credentials
   * 传给 ChannelAdapter.connect；channel adapter 收到 Record<string, string>
   * 形态不变；本接入面从类型层无法接触 provider / MCP 凭据。
   */
  credentials: ChannelCredentialProjection;
  logger: ChannelLogger;
  registerHttpRoute?: (path: string, handler: HttpHandler) => void;
}

/** Explicit physical-connection profile; absence is never inferred from a missing router. */
export type ConfiguredChannelInbound =
  | Readonly<{
      kind: "router";
      handleMessage(message: InboundMessage): Promise<void>;
    }>
  | Readonly<{ kind: "absent"; reason: "outbound-only" }>;

/** Complete physical consumers required before any configured adapter connects. */
export interface ConfiguredChannelConsumers {
  readonly inbound: ConfiguredChannelInbound;
  readonly onChallengeAction: (action: ChannelChallengeAction) => Promise<void>;
}

export interface SetupChannelsResult {
  statusSnapshot(): readonly Readonly<ChannelStatus>[];
  readonly delivery: ChannelDeliveryEffectSource;
  readonly inbound: InboundChannelPort;
  readonly challenges: ChannelChallengeDeliveryPort;
  connectConfigured(consumers: ConfiguredChannelConsumers): Promise<void>;
  disconnectConfigured(): Promise<void>;
  suspendConfigured(): Promise<void>;
  resumeConfigured(consumers: ConfiguredChannelConsumers): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreateInboundChannelRouterOptions {
  readonly conversation: InboundConversationApplicationPort;
  readonly channels: InboundChannelPort;
  readonly deliveryOutbox: InboundDeliveryOutboxPort;
  readonly logger: ChannelLogger;
  readonly confirmationHub?: ConfirmationHub;
  readonly cancelKeywords?: readonly string[];
  readonly sessionBroadcast: SessionBroadcast;
  readonly sessionActivityBroadcast: SessionActivityBroadcast;
  readonly isCurrentOwner: () => boolean;
}

/** Constructs the complete inbound consumer only after Delivery owns its Outbox. */
export function createInboundChannelRouter(
  options: CreateInboundChannelRouterOptions,
): InboundRouter {
  const mergedCancelKeywords =
    options.cancelKeywords && options.cancelKeywords.length > 0
      ? [...DEFAULT_CANCEL_KEYWORDS, ...options.cancelKeywords]
      : DEFAULT_CANCEL_KEYWORDS;
  const intentClassifier = createDefaultIntentClassifier({
    cancelKeywords: mergedCancelKeywords,
    confirmationApproveKeywords: APPROVE_KEYWORDS,
    confirmationDenyKeywords: DENY_KEYWORDS,
  });
  return new InboundRouter({
    conversation: options.conversation,
    channels: options.channels,
    deliveryOutbox: options.deliveryOutbox,
    logger: options.logger,
    confirmationHub: options.confirmationHub,
    intentClassifier,
    sessionBroadcast: options.sessionBroadcast,
    sessionActivityBroadcast: options.sessionActivityBroadcast,
    isCurrentOwner: options.isCurrentOwner,
  });
}

export async function setupChannels(
  options: SetupChannelsOptions,
): Promise<SetupChannelsResult> {
  const {
    entries,
    credentials,
    logger,
    registerHttpRoute,
  } = options;

  const eventBus = createEventBus<ChannelEventMap>();

  const connectionJobs: Array<{
    configId: string;
    adapterId: string;
    config: ChannelConfig;
  }> = [];

  const registry = new ChannelRegistry({
    eventBus,
    logger,
    registerHttpRoute,
  });
  const statusSnapshot = (): readonly Readonly<ChannelStatus>[] =>
    Object.freeze(
      registry.listStatuses().map((status) => Object.freeze({ ...status })),
    );
  const delivery = Object.freeze({
    status(channelId: string) {
      return registry.getStatus(channelId)?.state;
    },
    async send(
      target: DeliveryTarget,
      content: OutboundContent,
      meta?: Parameters<ChannelAdapter["send"]>[2],
    ): Promise<DeliveryResult | undefined> {
      const adapter = registry.get(target.channelId);
      if (!adapter) return undefined;
      return meta
        ? adapter.send(target, content, meta)
        : adapter.send(target, content);
    },
  } satisfies ChannelDeliveryEffectSource);
  const inbound = Object.freeze({
    has(channelId: string): boolean {
      return registry.get(channelId) !== undefined;
    },
    bindingPolicy(channelId: string) {
      return registry.get(channelId)?.bindingPolicy;
    },
    async send(
      target: DeliveryTarget,
      content: OutboundContent,
    ): Promise<DeliveryResult> {
      const adapter = registry.get(target.channelId);
      if (!adapter) {
        throw new Error(`Channel adapter not found: ${target.channelId}`);
      }
      return adapter.send(target, content);
    },
  } satisfies InboundChannelPort);
  const challenges = Object.freeze({
    supports(channelId: string): boolean {
      const adapter = registry.get(channelId);
      return adapter !== undefined && isChallengeChannel(adapter);
    },
    async sendChallenge(message: ChannelChallengeMessage): Promise<DeliveryResult> {
      const channelId = message.token.route.channelId;
      const adapter = registry.get(channelId);
      if (!adapter || !isChallengeChannel(adapter)) {
        throw new Error(`Channel does not support signed challenges: ${channelId}`);
      }
      return adapter.sendChallenge(message);
    },
  } satisfies ChannelChallengeDeliveryPort);

  for (const [id, entry] of Object.entries(entries)) {
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

    // channel 完整字段（含 appId / appSecret 等）从 credentials.channels.<id> 取——
    // channel 资源定义集中在设备本地 SecretStore，config.json 只记录"启用列表 + 功能选项"。
    const channelCredentials = credentials.channels?.[id] ?? {};

    const channelConfig: ChannelConfig = {
      type,
      enabled: true,
      credentials: channelCredentials,
      options: entry.options,
      defaultTarget: entry.defaultTarget
        ? { channelId: id, to: entry.defaultTarget.to }
        : undefined,
    };

    connectionJobs.push({
      configId: id,
      adapterId: adapter.id,
      config: channelConfig,
    });
  }

  let transition: Promise<void> = Promise.resolve();
  let suspended = false;
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const current = transition.then(operation, operation);
    transition = current.catch(() => undefined);
    return current;
  };
  const connectConfigured = (consumers: ConfiguredChannelConsumers) => serialize(async () => {
    if (suspended) return;
    await connectConfiguredChannels({
      registry,
      jobs: connectionJobs,
      logger,
      consumers,
    });
  });
  const disconnectConfigured = () => serialize(() => disconnectConfiguredChannels({
      registry,
      jobs: connectionJobs,
      logger,
    }));
  const suspendConfigured = () => serialize(async () => {
    suspended = true;
  });
  const resumeConfigured = (consumers: ConfiguredChannelConsumers) => serialize(async () => {
    suspended = false;
    await connectConfiguredChannels({
      registry,
      jobs: connectionJobs,
      logger,
      consumers,
    });
  });

  return {
    statusSnapshot,
    delivery,
    inbound,
    challenges,
    connectConfigured,
    disconnectConfigured,
    suspendConfigured,
    resumeConfigured,
    dispose: () => registry.dispose(),
  };
}

async function connectConfiguredChannels(options: {
  registry: ChannelRegistry;
  jobs: readonly {
    configId: string;
    adapterId: string;
    config: ChannelConfig;
  }[];
  logger: ChannelLogger;
  consumers: ConfiguredChannelConsumers;
}): Promise<void> {
  const { registry, jobs, logger, consumers } = options;
  const { inbound, onChallengeAction } = consumers;
  const onMessage = inbound.kind === "router"
    ? (message: InboundMessage) => {
        inbound.handleMessage(message).catch((error) => {
          logger.error(
            "Unhandled error in message routing: %s",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    : undefined;
  await Promise.all(
    jobs.map(async ({ configId, adapterId, config }) => {
      try {
        await registry.connect(
          adapterId,
          config,
          {
            ...(onMessage ? { onMessage } : {}),
            onChallengeAction,
          },
        );
        logger.info("Channel '%s' connected", configId);
      } catch (err) {
        logger.error(
          "Channel '%s' failed to connect (non-fatal): %s",
          configId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }),
  );
}

async function disconnectConfiguredChannels(options: {
  registry: ChannelRegistry;
  jobs: readonly { configId: string; adapterId: string }[];
  logger: ChannelLogger;
}): Promise<void> {
  const { registry, jobs, logger } = options;
  await Promise.all(
    jobs.map(async ({ configId, adapterId }) => {
      try {
        await registry.disconnect(adapterId);
        logger.info("Channel '%s' disconnected", configId);
      } catch (err) {
        logger.error(
          "Channel '%s' failed to disconnect: %s",
          configId,
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }
    }),
  );
}
