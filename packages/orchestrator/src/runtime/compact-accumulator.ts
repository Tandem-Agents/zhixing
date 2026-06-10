/**
 * Compact 事件 L1 累积订阅
 *
 * 为什么独立成模块：
 *   - run() 和 forceCompact() 共用此累积逻辑
 *   - 一个 run 内可能从多个触发点(pre-flight / pure-text return / critical
 *     force-apply)多次 fire compact_end;覆盖式订阅会丢失前面事务的折叠贡献,
 *     导致窗口按错误的配对数折叠
 *
 * 累积规则(L1):
 *   - 只有含 summary 的事务参与累积(非摘要型事务不折叠窗口配对)
 *   - pairsCompacted 累加(本 run 内所有摘要型事务折叠的窗口配对数之和)
 *   - summary 取最新(后一次的 LLM 摘要天然包含前一次,因为 toSummarize 含前次 pair)
 *   - tokensBefore 锚定第一次(事务起点真实值)
 *   - tokensAfter 取最新
 *   - timestamp 取最新(事件触发时刻,对齐持久化"最后一次时间"语义)
 *
 * 直接产出 WindowCompact(core 的权威类型),无中间形态。
 * 单一事实源:RunResult.windowCompact 即是此 getter 的返回值。
 */

import type { AgentEventMap, IEventBus, WindowCompact } from "@zhixing/core";

/**
 * 累积器句柄 —— `subscribeCompactAccumulator` 的返回值。
 *
 * `dispose` 显式取消 EventBus 订阅。当前所有使用点都是"每 run 新 bus + run 结束 bus
 * 自然 GC"模式,dispose 非必须调用;但当未来 eventBus 被跨 run 共享时(如集中式
 * EventBus 架构),不 dispose 会造成 listener 泄漏。API 形态提前到位,杜绝这类隐蔽 bug。
 */
export interface CompactAccumulator {
  /** 读取累积的窗口重构指令;非摘要型事务不参与累积时返 undefined */
  getWindowCompact(): WindowCompact | undefined;
  /** 从 eventBus 移除订阅;多次调用幂等(idempotent) */
  dispose(): void;
}

/**
 * 在给定 eventBus 上订阅 `context:compact_end`,累积多次 fire 的权威元数据。
 *
 * @param eventBus 订阅目标。支持 run 外层 eventBus / forceCompact 独立 localBus。
 * @param onEvent 可选回调 —— 每次事件触发时调用(用于 UI 渲染等副作用)。
 *
 *   **时序契约**:onEvent 在累积逻辑 **之前** 调用。
 *   如果在 onEvent 内读取返回的 getter,拿到的是 **不包含当前事件** 的累积值
 *   (当前 info 还没被 merge 进 acc)。两种正确用法:
 *     - onEvent 内只做与当前事件相关的副作用(如 renderCompactEnd(info))—— 推荐
 *     - 需要最新累积值时,在 eventBus 下一个微任务 / onTurnComplete 完成后读 getMarker
 *   不要在 onEvent 内立即读 getMarker 并假设含当前事件。
 *
 * @returns `{getMarker, dispose}` 句柄。推荐调用方在 try/finally 里 dispose,
 *   保证跨 run / 跨 forceCompact 共享 eventBus 时也不会泄漏 listener。
 *
 * 幂等性:订阅是附加的(EventBus.on),多次调用 subscribeCompactAccumulator 会
 * 各自注册独立订阅者 / 返回独立句柄,互不干扰。
 */
export function subscribeCompactAccumulator(
  eventBus: IEventBus<AgentEventMap>,
  onEvent?: (info: AgentEventMap["context:compact_end"]) => void,
): CompactAccumulator {
  let acc: WindowCompact | undefined;
  let firstTokensBefore: number | undefined;

  // EventBus.on 返回 Unsubscribe 函数 —— 直接用作 dispose,无需自建 handler 引用管理
  const unsubscribe = eventBus.on("context:compact_end", (info) => {
    onEvent?.(info);
    // 只有产生 LLM summary 的事务参与累积;非摘要型事务不影响文件 Turn 替代
    if (!info.summary) return;
    if (firstTokensBefore === undefined) firstTokensBefore = info.tokensBefore;
    acc = {
      summary: info.summary,
      pairsCompacted: (acc?.pairsCompacted ?? 0) + (info.turnsCompacted ?? 0),
      tokensBefore: firstTokensBefore,
      tokensAfter: info.tokensAfter,
    };
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
