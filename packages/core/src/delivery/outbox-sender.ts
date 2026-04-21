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
 *
 * 若 source.kind === "scheduler" 且带 createdInTurn，
 * 该值会被派生为 OutboxEntry.afterSlot——drain 时必须等对应 turn slot 进终态才发送。
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
        afterSlot: deriveAfterSlot(meta?.source),
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
      return {
        kind: "scheduled-task",
        taskId: source.taskId,
        ...(source.createdInTurn !== undefined && {
          createdInTurn: source.createdInTurn,
        }),
      };
    case "agent":
      return { kind: "llm-reply", conversationId: source.conversationId };
    case "system":
      return { kind: "system", handler: source.reason };
  }
}

/**
 * 从 DeliverySource 派生 afterSlot——唯一的 Pipeline → Outbox 因果依赖注入点。
 *
 * 扩展约定：
 * - afterSlot 仅供**跨 turn 边界**的异步投递使用（典型：scheduler 触发的 task fire
 *   携带创建它的 turnId，以排在该 turn 最终回复之后）
 * - turn 内直接发送的 source（如 agent 自己 post 的 LLM 回复、tool-commitment）
 *   不应派生 afterSlot——它们本就由 InboundRouter 的 slot 生命周期和 fillSlot
 *   原子插入保证顺序，重复派生会产生自依赖或误阻塞
 * - 新增 DeliverySource kind 时先问：这条 entry 是否跨越了"创建它的 turn"的边界？
 *   是 → 在此扩展 case；否 → 保持返回 undefined
 */
function deriveAfterSlot(source?: DeliverySource): string | undefined {
  if (!source) return undefined;
  if (source.kind === "scheduler") return source.createdInTurn;
  return undefined;
}
