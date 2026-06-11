/**
 * Segment 事件的窗口重构指令收集订阅。
 *
 * `segment:new_started` 事件 payload 直接携带完整 `WindowCompact`
 * （含 segmentId / structuredSummary），单次触发即终态——订阅只做
 * 覆盖式记录，run 结束后经 `getWindowCompact` 交会话层折叠。
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
