/**
 * Segment 事件 marker 收集订阅 —— 与 LLMSummarize 的 compact-accumulator 对偶。
 *
 * 为什么独立成模块（与 compact-accumulator 并列）：
 *   - LLMSummarize 的 `context:compact_end` 事件 payload 是 strategy 维度
 *     （strategies / turnsCompacted 总和 / 最新 summary），需要按累积语义
 *     合并多次事务的贡献
 *   - SegmentManager 的 `segment:new_started` 事件 payload 直接携带完整
 *     `CompactMarker`（含 segmentId / structuredSummary），单次触发即终态，
 *     不需要累积合并
 *
 * 两个事件在单次 run 内**通常不会同时触发**（attention 阈值远早于 budget critical），
 * 但 run-agent 端的 marker 选择需要明确优先级：segment marker > compact marker
 * （段切换 marker 含更丰富的结构化信息，应优先采用）。
 *
 * 设计契约：单次 run 仅期望 ≤1 次段切换，重复触发后取最新。
 */

import type { AgentEventMap, CompactMarker, IEventBus } from "@zhixing/core";

export interface SegmentMarkerAccumulator {
  /** 取累积的段切换 marker；本 run 未触发段切换时返 undefined */
  getMarker(): CompactMarker | undefined;
  /** 从 eventBus 移除订阅；多次调用幂等 */
  dispose(): void;
}

export function subscribeSegmentMarkerAccumulator(
  eventBus: IEventBus<AgentEventMap>,
): SegmentMarkerAccumulator {
  let acc: CompactMarker | undefined;

  const unsubscribe = eventBus.on("segment:new_started", (info) => {
    // 段切换 marker 是终态完整 marker —— 单 run 重复触发取最新（覆盖式）
    acc = info.marker;
  });

  let disposed = false;
  return {
    getMarker: () => acc,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
