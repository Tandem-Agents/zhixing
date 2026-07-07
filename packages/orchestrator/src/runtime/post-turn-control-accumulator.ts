/**
 * turn 边界控制意图 L1 收集订阅。
 *
 * 结构形态与 segment-marker-accumulator 同款（订阅 → getter → run 结束带出 →
 * 显式 dispose），语义为 last-wins 单一意图。纯管道：仅收集意图，不执行
 * 任何控制动作。消费方在 turn 边界以单一事务处理 RunResult.pendingPostTurnControl。
 */

import type {
  AgentEventMap,
  IEventBus,
  PostTurnControlIntent,
} from "@zhixing/core";

/**
 * 收集器句柄 —— `subscribePostTurnControlAccumulator` 的返回值。
 *
 * `dispose` 显式取消 EventBus 订阅。与 segment-marker-accumulator 同款：当前每 run
 * 新 bus、run 结束 GC，dispose 非必须；但 eventBus 跨 run 共享时不 dispose
 * 会泄漏 listener，API 形态提前到位。
 */
export interface PostTurnControlAccumulator {
  /** 读取本 run 最后一次控制意图；从未 emit 时返 undefined */
  getIntent(): PostTurnControlIntent | undefined;
  /** 从 eventBus 移除订阅；多次调用幂等 */
  dispose(): void;
}

/**
 * 在给定 eventBus 上订阅 `post_turn_control:requested`，last-wins 收集最后
 * 一次意图。
 *
 * @param eventBus 订阅目标。
 * @param onEvent 可选回调 —— 每次事件触发时调用（UI 副作用等）。
 *   时序：onEvent 在覆盖逻辑**之前**调用。
 *
 * 幂等性：订阅是附加的（EventBus.on），多次调用各自注册独立订阅者 / 返回
 * 独立句柄，互不干扰。
 */
export function subscribePostTurnControlAccumulator(
  eventBus: IEventBus<AgentEventMap>,
  onEvent?: (intent: AgentEventMap["post_turn_control:requested"]) => void,
): PostTurnControlAccumulator {
  let last: PostTurnControlIntent | undefined;

  const unsubscribe = eventBus.on("post_turn_control:requested", (intent) => {
    onEvent?.(intent);
    // last-wins：同 turn 多次控制请求以最后一次用户确认的意图为准。
    last = intent;
  });

  let disposed = false;
  return {
    getIntent: () => last,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
