/**
 * Compact 事件 L1 累积订阅
 *
 * 为什么独立成模块：
 *   - run-agent.ts 的 run() 和 forceCompact() 共用此累积逻辑
 *   - Phase 4 加多个 compact 触发点（pre-flight / pure-text return / critical
 *     force-apply）后，一个 run 内可能多次 fire compact_end；覆盖式订阅会丢失
 *     前面事务的 turnsCompacted 贡献，导致 commitTurn 按错误的 Turn 数截断
 *   - Phase 5 若需要 server 包共用此逻辑，只需搬一个文件（保 SRP）
 *
 * 累积规则（L1）：
 *   - 只有含 summary 的事务参与累积（非摘要型事务不代表文件 Turn 替代）
 *   - turnsCompacted 累加（本 run 内所有摘要型事务替代的 Turn 数之和）
 *   - summary 取最新（后一次的 LLM 摘要天然包含前一次，因为 toSummarize 含前次 pair）
 *   - tokensBefore 锚定第一次（事务起点真实值）
 *   - tokensAfter 取最新
 */

import type { AgentEventMap, IEventBus, CompactMarker } from "@zhixing/core";

// ─── 类型 ───

/**
 * L1 累积后的 Compact 信息 —— Phase 3 的 run-agent 层中间形态。
 *
 * Phase 5 P0-O 会将 RunResult 迁至直接使用 CompactMarker，届时此类型可移除。
 */
export interface CompactInfo {
  readonly summary: string;
  readonly turnsCompacted: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

// ─── 订阅 ───

/**
 * 在给定 eventBus 上订阅 `context:compact_end`，累积多次 fire 的权威元数据。
 *
 * @param eventBus 订阅目标。支持 run-agent 外层 eventBus / forceCompact 独立 localBus。
 * @param onEvent 可选回调 —— 每次事件触发时调用（用于 UI 渲染等副作用）。
 *
 *   **时序契约**：onEvent 在累积逻辑 **之前** 调用。
 *   如果在 onEvent 内读取返回的 getter，拿到的是 **不包含当前事件** 的累积值
 *   （当前 info 还没被 merge 进 acc）。两种正确用法：
 *     - onEvent 内只做与当前事件相关的副作用（如 renderCompactEnd(info)）—— 推荐
 *     - 需要最新累积值时，在 eventBus 下一个微任务 / onTurnComplete 完成后读 getter
 *   不要在 onEvent 内立即读 getter 并假设含当前事件。
 *
 * @returns getter 函数；调用方在需要时读取累积结果，未累积时返回 undefined。
 *
 * 幂等性：订阅是附加的（EventBus.on），多次调用会注册多个订阅者。
 * 调用方生命周期负责：通常每个 run/forceCompact 创建新 eventBus，随之销毁。
 */
export function subscribeCompactAccumulator(
  eventBus: IEventBus<AgentEventMap>,
  onEvent?: (info: AgentEventMap["context:compact_end"]) => void,
): () => CompactInfo | undefined {
  let acc: CompactInfo | undefined;
  let firstTokensBefore: number | undefined;

  eventBus.on("context:compact_end", (info) => {
    onEvent?.(info);
    // 只有产生 LLM summary 的事务参与累积；非摘要型事务不影响文件 Turn 替代
    if (!info.summary) return;
    if (firstTokensBefore === undefined) firstTokensBefore = info.tokensBefore;
    acc = {
      summary: info.summary,
      turnsCompacted:
        (acc?.turnsCompacted ?? 0) + (info.turnsCompacted ?? 0),
      tokensBefore: firstTokensBefore,
      tokensAfter: info.tokensAfter,
    };
  });

  return () => acc;
}

// ─── 格式转换 ───

/**
 * 把 L1 累积结果转换成 transcript 层的 CompactMarker（加 type + timestamp）。
 *
 * 用途：REPL /compact 的 appendCompact 参数、RunResult.compactInfo → CompactMarker 适配。
 */
export function toCompactMarker(info: CompactInfo): CompactMarker {
  return {
    type: "compact",
    timestamp: new Date().toISOString(),
    summary: info.summary,
    turnsCompacted: info.turnsCompacted,
    tokensBefore: info.tokensBefore,
    tokensAfter: info.tokensAfter,
  };
}
