/**
 * 投递基础设施组装 — serve 和 repl 共用
 *
 * 职责：
 * - 创建 OutboxRegistry（顺序层，per-target FIFO；ADR-007）
 * - 创建 DeliveryPipeline（持久化队列 + 重试）
 * - Pipeline 的 sender 是 outbox-bound：Pipeline drain → Outbox.post → ChannelAdapter.send
 *
 * 不关心通道具体类型（飞书/Slack/...），只依赖 ChannelRegistry 接口。
 * 不关心运行模式（REPL/serve），两端调用方式一样。
 */

import {
  DeliveryPipeline,
  DEFAULT_DELIVERY_CONFIG,
  OutboxRegistry,
  createEventBus,
  createOutboxSender,
  type ChannelRegistry,
  type DeliveryEventMap,
  type OutboxEvent,
} from "@zhixing/core";

import path from "node:path";

export interface DeliveryStack {
  delivery: DeliveryPipeline;
  outboxRegistry: OutboxRegistry;
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
}

export async function setupDelivery(options: SetupDeliveryOptions): Promise<DeliveryStack> {
  const { channels, zhixingHome, logger } = options;

  // 1. OutboxRegistry — 顺序层，per-target FIFO
  //    doSend 直通 channel adapter；adapter 未就绪则返回可重试失败
  const outboxRegistry = new OutboxRegistry(
    async (target, content) => {
      const adapter = channels.get(target.channelId);
      if (!adapter) {
        return {
          success: false,
          error: `Channel not found: ${target.channelId}`,
          retryable: false,
        };
      }
      return adapter.send(target, content);
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

  // 3. Pipeline — 持久化队列 + 重试，drain 目标为 outbox
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

  return {
    delivery,
    outboxRegistry,
    stop: async () => {
      await delivery.stop();
      await outboxRegistry.dispose();
    },
  };
}
