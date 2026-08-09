import {
  ChannelRegistry,
  createEventBus,
  type ChannelAdapter,
  type ChannelConfig,
  type ChannelEventMap,
  type ChannelLogger,
  type InboundMessage,
  type ChannelChallengeAction,
  type HttpHandler,
} from "@zhixing/core";
import {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  DEFAULT_CANCEL_KEYWORDS,
  InboundRouter,
  createDefaultIntentClassifier,
} from "@zhixing/server";
import type {
  ConfirmationHub,
  ConversationManager,
} from "@zhixing/owner-kernel";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc";
import type {
  ChannelCredentialProjection,
  MessagingChannelEntry,
} from "@zhixing/providers";

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
  /** 会话 observer 组播 getter；server 启动后才会返回真实函数。 */
  sessionBroadcast?: () => SessionBroadcast | null;
  /** 非当前会话活动提示 getter；server 启动后才会返回真实函数。 */
  sessionActivityBroadcast?: () => SessionActivityBroadcast | null;
  onChallengeAction?: (action: ChannelChallengeAction) => Promise<void>;
  registerHttpRoute?: (path: string, handler: HttpHandler) => void;
  /** Final callback guard; defaults to current-owner for non-mesh callers. */
  isCurrentOwner?: () => boolean;
  /** Registration is always completed; physical connections may be deferred. */
  connectImmediately?: boolean;
}

export interface SetupChannelsResult {
  registry: ChannelRegistry;
  router: InboundRouter | null;
  connectionTask: Promise<void>;
  connectConfigured(): Promise<void>;
  disconnectConfigured(): Promise<void>;
}

export async function setupChannels(
  options: SetupChannelsOptions,
): Promise<SetupChannelsResult> {
  const {
    entries,
    credentials,
    conversations,
    logger,
    confirmationHub,
    cancelKeywords,
    sessionBroadcast,
    sessionActivityBroadcast,
    onChallengeAction,
    registerHttpRoute,
    isCurrentOwner,
    connectImmediately = true,
  } = options;

  const eventBus = createEventBus<ChannelEventMap>();
  const currentOwnerChallengeAction = onChallengeAction
    ? async (action: ChannelChallengeAction) => {
        if (isCurrentOwner?.() === false) {
          throw new Error("Channel interaction is not owned by this device");
        }
        await onChallengeAction(action);
      }
    : undefined;

  let router: InboundRouter | null = null;
  const connectionJobs: Array<{
    configId: string;
    adapterId: string;
    config: ChannelConfig;
  }> = [];

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
    onChallengeAction: currentOwnerChallengeAction,
    registerHttpRoute,
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
      sessionBroadcast,
      sessionActivityBroadcast,
      isCurrentOwner,
    });
  }

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
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const current = transition.then(operation, operation);
    transition = current.catch(() => undefined);
    return current;
  };
  const connectConfigured = () => serialize(() => connectConfiguredChannels({
      registry,
      jobs: connectionJobs,
      logger,
    }));
  const disconnectConfigured = () => serialize(() => disconnectConfiguredChannels({
      registry,
      jobs: connectionJobs,
      logger,
    }));
  const connectionTask = connectImmediately
    ? connectConfigured()
    : Promise.resolve();

  return {
    registry,
    router,
    connectionTask,
    connectConfigured,
    disconnectConfigured,
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
}): Promise<void> {
  const { registry, jobs, logger } = options;
  await Promise.all(
    jobs.map(async ({ configId, adapterId, config }) => {
      try {
        await registry.connect(adapterId, config);
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
