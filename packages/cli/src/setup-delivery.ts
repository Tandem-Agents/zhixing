/**
 * 投递基础设施组装 — serve 和 repl 共用
 *
 * 职责：
 * - 创建 DeliverySender（包装 ChannelRegistry 的 send/isReady）
 * - 创建 DeliveryPipeline（持久化队列 + 重试）
 *
 * 不关心通道具体类型（飞书/Slack/...），只依赖 ChannelRegistry 接口。
 * 不关心运行模式（REPL/serve），两端调用方式一样。
 */

import {
  DeliveryPipeline,
  DEFAULT_DELIVERY_CONFIG,
  createEventBus,
  type ChannelRegistry,
  type DeliveryEventMap,
  type DeliverySender,
} from "@zhixing/core";

import path from "node:path";

export interface DeliveryStack {
  delivery: DeliveryPipeline;
  stop: () => Promise<void>;
}

export interface SetupDeliveryOptions {
  channels: ChannelRegistry;
  zhixingHome: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export async function setupDelivery(options: SetupDeliveryOptions): Promise<DeliveryStack> {
  const { channels, zhixingHome, logger } = options;

  // 1. Sender — 包装 registry 的 send/isReady
  const sender: DeliverySender = {
    send: async (target, content) => {
      const adapter = channels.get(target.channelId);
      if (!adapter) {
        return { success: false, error: `Channel not found: ${target.channelId}`, retryable: false };
      }
      return adapter.send(target, content);
    },
    isReady: (channelId) => {
      const status = channels.getStatus(channelId);
      return status?.state === "connected";
    },
  };

  // 2. Pipeline — 持久化队列 + 重试
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
    stop: () => delivery.stop(),
  };
}
