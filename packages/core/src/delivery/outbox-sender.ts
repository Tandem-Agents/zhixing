/**
 * OutboxSender — 把 OutboxRegistry 包装成 DeliverySender
 *
 * 让现有 DeliveryPipeline 无需改造即可把 drain 目标从"直发 adapter"切换为"经 Outbox"。
 * Pipeline → OutboxSender.send(target, content, meta) → registry.of(target).post(entry)
 *
 * 规格：[message-outbox.md](../../../../research/design/specifications/message-outbox.md) §5.3
 */

import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../channels/types.js";
import type { OutboxRegistry } from "./outbox-registry.js";
import type { EmissionSource } from "./outbox-types.js";
import type { DeliverySender, DeliverySendMeta, DeliverySource } from "./types.js";

export interface OutboxSenderOptions {
  /** 查询 channel 就绪状态；由 ChannelRegistry 提供 */
  readonly isReady: (channelId: string) => boolean;
}

/**
 * 构造一个 DeliverySender，把所有 send 调用转为 Outbox.post。
 *
 * `meta.source`（来自 Pipeline 的 DeliverySource）会被映射为 OutboxEntry.source（EmissionSource）。
 * 未提供时退化为 system 源。
 */
export function createOutboxSender(
  registry: OutboxRegistry,
  options: OutboxSenderOptions,
): DeliverySender {
  return {
    async send(
      target: DeliveryTarget,
      content: OutboundContent,
      meta?: DeliverySendMeta,
    ): Promise<DeliveryResult> {
      const outbox = registry.of(target);
      return outbox.post({
        target,
        content,
        source: mapSource(meta?.source),
      });
    },
    isReady: options.isReady,
  };
}

/** DeliverySource → EmissionSource 的映射 */
function mapSource(source?: DeliverySource): EmissionSource {
  if (!source) {
    return { kind: "system", handler: "delivery-pipeline" };
  }
  switch (source.kind) {
    case "scheduler":
      return { kind: "scheduled-task", taskId: source.taskId };
    case "agent":
      return { kind: "llm-reply", conversationId: source.conversationId };
    case "system":
      return { kind: "system", handler: source.reason };
  }
}
