/**
 * Segment 事件的窗口重构指令收集订阅 —— 与 compact-accumulator 对偶。
 *
 * 为什么独立成模块（与 compact-accumulator 并列）：
 *   - LLMSummarize 的 `context:compact_end` 事件 payload 是 strategy 维度
 *     （strategies / 折叠配对总和 / 最新 summary），需要按累积语义合并
 *     多次事务的贡献
 *   - SegmentManager 的 `segment:new_started` 事件 payload 直接携带完整
 *     `WindowCompact`（含 segmentId / structuredSummary），单次触发即终态，
 *     不需要累积合并
 *
 * 两个事件在单次 run 内**通常不会同时触发**（attention 阈值远早于 budget critical），
 * 但 run 端的指令选择需要明确优先级：段切换指令 > compact 指令
 * （段切换指令含更丰富的结构化信息，应优先采用）。
 *
 * 设计契约：单次 run 仅期望 ≤1 次段切换，重复触发后取最新。
 */

import type { AgentEventMap, IEventBus, WindowCompact } from "@zhixing/core";

export interface SegmentMarkerAccumulator {
  /** 取累积的段切换窗口重构指令；本 run 未触发段切换时返 undefined */
  getWindowCompact(): WindowCompact | undefined;
  /** 从 eventBus 移除订阅；多次调用幂等 */
  dispose(): void;
}

export function subscribeSegmentMarkerAccumulator(
  eventBus: IEventBus<AgentEventMap>,
): SegmentMarkerAccumulator {
  let acc: WindowCompact | undefined;

  const unsubscribe = eventBus.on("segment:new_started", (info) => {
    // 段切换指令是终态完整指令 —— 单 run 重复触发取最新（覆盖式）
    acc = info.windowCompact;
  });

  let disposed = false;
  return {
    getWindowCompact: () => acc,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
