/**
 * 工作模式切换意图 L1 收集订阅
 *
 * 结构形态复用 compact-accumulator（订阅 → getter → run 结束带出 → 显式
 * dispose），但**语义为 last-wins 单一意图**，非累加：
 *   - 同 turn 多次 workmode_enter 取最后一次（对应用户最后拍板的 sceneId）
 *   - enter / exit 按构造不会同 turn 共存（main-only vs power-only 工具，
 *     一 turn 一 runtime），故无需处理混合，纯覆盖即正确
 *
 * 纯管道：仅收集意图，不执行任何切换。切换由 REPL 主回路 turn 边界单一
 * 事务消费 RunResult.pendingModeSwitch 后执行。
 */

import type {
  AgentEventMap,
  IEventBus,
  WorkModeSwitchIntent,
} from "@zhixing/core";

/**
 * 收集器句柄 —— `subscribeWorkModeAccumulator` 的返回值。
 *
 * `dispose` 显式取消 EventBus 订阅。与 compact-accumulator 同款：当前每 run
 * 新 bus、run 结束 GC，dispose 非必须；但 eventBus 跨 run 共享时不 dispose
 * 会泄漏 listener，API 形态提前到位。
 */
export interface WorkModeAccumulator {
  /** 读取本 run 最后一次切换意图；从未 emit 时返 undefined */
  getIntent(): WorkModeSwitchIntent | undefined;
  /** 从 eventBus 移除订阅；多次调用幂等 */
  dispose(): void;
}

/**
 * 在给定 eventBus 上订阅 `workmode:switch_requested`，last-wins 收集最后
 * 一次意图。
 *
 * @param eventBus 订阅目标。
 * @param onEvent 可选回调 —— 每次事件触发时调用（UI 副作用等）。
 *   时序：onEvent 在覆盖逻辑**之前**调用（与 compact-accumulator 一致）。
 *
 * 幂等性：订阅是附加的（EventBus.on），多次调用各自注册独立订阅者 / 返回
 * 独立句柄，互不干扰。
 */
export function subscribeWorkModeAccumulator(
  eventBus: IEventBus<AgentEventMap>,
  onEvent?: (intent: AgentEventMap["workmode:switch_requested"]) => void,
): WorkModeAccumulator {
  let last: WorkModeSwitchIntent | undefined;

  const unsubscribe = eventBus.on("workmode:switch_requested", (intent) => {
    onEvent?.(intent);
    // last-wins：纯覆盖即正确（同 turn 多次 enter 取最后；enter/exit 按
    // 构造不共存）
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
