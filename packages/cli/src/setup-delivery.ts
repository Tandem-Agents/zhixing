/**
 * 投递基础设施组装 — serve 和 repl 共用
 *
 * 职责：
 * - 创建 OutboxRegistry（顺序层，per-target FIFO）
 * - 保留既有 DeliveryPipeline 生产链
 * - 组装零生产流量的权威 delivery 影子组件
 * - 两条链路共享 per-target FIFO Outbox
 *
 * 不关心通道具体类型（飞书/Slack/...），只依赖 ChannelRegistry 接口。
 * 不关心运行模式（REPL/serve），两端调用方式一样。
 */

import {
  DeliveryPipeline,
  AuthorityDeliveryPipeline,
  DeliveryAuthority,
  DeliveryTransportRegistry,
  DEFAULT_DELIVERY_CONFIG,
  DEFAULT_AUTHORITY_DELIVERY_CONFIG,
  OutboxRegistry,
  createEventBus,
  createOutboxSender,
  channelAuthorityDeliveryTransport,
  type ChannelRegistry,
  type AuthorityDeliveryEventMap,
  type DeliveryEventMap,
  type DeliveryStatusNotice,
  type OutboxEvent,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  ControlAdmissionJournal,
  OwnerDeliveryParticipant,
  applyDeliveryResolutionControl,
  createDeliveryControlEnvelope,
  type CreateDeliveryControlEnvelopeInput,
} from "@zhixing/owner-kernel";

import path from "node:path";
export interface DeliveryStack {
  delivery: DeliveryPipeline;
  authorityDelivery: AuthorityDeliveryPipeline;
  authority: DeliveryAuthority;
  authorityLog: FileAuthorityCommitLog;
  artifacts: FileArtifactStore;
  participant: OwnerDeliveryParticipant;
  controlAdmission: ControlAdmissionJournal;
  outboxRegistry: OutboxRegistry;
  statusHistory: (
    afterByItem?: Readonly<Record<string, number>>,
  ) => Promise<readonly DeliveryStatusNotice[]>;
  onStatus: (
    listener: (notice: DeliveryStatusNotice) => void | Promise<void>,
  ) => () => void;
  resolve: (
    input: CreateDeliveryControlEnvelopeInput,
  ) => ReturnType<typeof applyDeliveryResolutionControl>;
  stop: () => Promise<void>;
}

export interface SetupDeliveryOptions {
  channels: ChannelRegistry;
  zhixingHome: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 可选：观测 Outbox 事件（测试/调试；生产留空由 logger 承接） */
  onOutboxEvent?: (event: OutboxEvent) => void;
  anchorEpoch?: number;
}

export async function setupDelivery(options: SetupDeliveryOptions): Promise<DeliveryStack> {
  const { channels, zhixingHome, logger } = options;

  // 1. OutboxRegistry — 顺序层，per-target FIFO
  //    doSend 直通 channel adapter；adapter 未就绪则返回可重试失败
  const outboxRegistry = new OutboxRegistry(
    async (target, content, meta) => {
      const adapter = channels.get(target.channelId);
      if (!adapter) {
        // Adapter 可能正处于重连窗口；保持可重试，避免把瞬时不可用误判为永久失败。
        return {
          success: false,
          error: `Channel not found: ${target.channelId}`,
          retryable: true,
        };
      }
      return meta
        ? adapter.send(target, content, meta)
        : adapter.send(target, content);
    },
    {
      onEvent: options.onOutboxEvent,
      logger: {
        debug: logger.debug,
        info: (msg) => logger.info(msg),
        warn: (msg) => logger.warn(msg),
        error: (msg) => logger.error(msg),
      },
    },
  );

  // 2. Sender — outbox-bound，Pipeline 的 drain 现在经 Outbox
  const sender = createOutboxSender(outboxRegistry, {
    isReady: (channelId) => {
      const status = channels.getStatus(channelId);
      return status?.state === "connected";
    },
  });

  const authorityRoot = path.join(zhixingHome, "distributed-runtime");
  const artifacts = new FileArtifactStore(path.join(authorityRoot, "artifacts"));
  const authorityLog = new FileAuthorityCommitLog(
    path.join(authorityRoot, "authority"),
    artifacts,
  );
  const authority = new DeliveryAuthority({
    log: authorityLog,
    anchorEpoch: options.anchorEpoch ?? 1,
  });
  const participant = new OwnerDeliveryParticipant({ authority });
  const controlAdmission = new ControlAdmissionJournal(authorityLog, artifacts);

  const delivery = new DeliveryPipeline({
    sender,
    eventBus: createEventBus<DeliveryEventMap>(),
    config: {
      ...DEFAULT_DELIVERY_CONFIG,
      queueFilePath: path.join(zhixingHome, "delivery-queue.json"),
    },
    logger: {
      debug: () => {},
      info: (msg: string) => logger.info(`[delivery] ${msg}`),
      warn: (msg: string) => logger.warn(`[delivery] ${msg}`),
      error: (msg: string) => logger.error(`[delivery] ${msg}`),
    },
  });
  await delivery.start();

  const transports = new DeliveryTransportRegistry();
  transports.register(channelAuthorityDeliveryTransport(sender));
  const eventBus = createEventBus<AuthorityDeliveryEventMap>();
  const statusListeners = new Set<
    (notice: DeliveryStatusNotice) => void | Promise<void>
  >();
  const publishNotice = async (notice: DeliveryStatusNotice) => {
    await Promise.allSettled(
      [...statusListeners].map(async (listener) => listener(notice)),
    );
  };
  eventBus.on("delivery:notice", ({ notice }) => publishNotice(notice));

  // 影子 Pipeline 只消费权威事实，不提供生产入口。
  const authorityDelivery = new AuthorityDeliveryPipeline({
    authority,
    artifacts,
    transport: transports,
    eventBus,
    config: {
      ...DEFAULT_AUTHORITY_DELIVERY_CONFIG,
    },
    logger: {
      debug: () => {},
      info: (msg: string) => logger.info(`[delivery] ${msg}`),
      warn: (msg: string) => logger.warn(`[delivery] ${msg}`),
      error: (msg: string) => logger.error(`[delivery] ${msg}`),
    },
  });
  await authorityDelivery.start();

  return {
    delivery,
    authorityDelivery,
    authority,
    authorityLog,
    artifacts,
    participant,
    controlAdmission,
    outboxRegistry,
    statusHistory: (afterByItem = {}) => authority.statusNotices(afterByItem),
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    resolve: (input) => {
      const envelope = createDeliveryControlEnvelope(input);
      return applyDeliveryResolutionControl({
        admission: controlAdmission,
        authority,
        envelope,
        source: input.source,
        onResolved: (notice) => eventBus.emit("delivery:notice", { notice }),
      });
    },
    stop: async () => {
      statusListeners.clear();
      await authorityDelivery.stop();
      await delivery.stop();
      await outboxRegistry.dispose();
    },
  };
}
