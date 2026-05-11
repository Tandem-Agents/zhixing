/**
 * 段切换决策 —— 纯函数，无 IO。
 *
 * 三档判定：
 *   - currentTokens < optimal        → pass（注意力舒适区，无须干预）
 *   - optimal ≤ currentTokens < risk → 有 in-progress 则 defer（避开任务中段切换），否则 trigger
 *   - currentTokens ≥ risk           → 强制 trigger（即使任务中也切，避免注意力质量崩塌）
 *
 * 边界语义：`< optimal` 严格小于；`= optimal` 已落入评估区。这与"optimal 是
 * 注意力还能保持高质量的最后一站"语义一致——到达此处即应考虑切段。
 *
 * 退化情形：optimal === risk === 0（或两者颠倒的异常配置）时第二档区间为空，
 * 任何 currentTokens ≥ optimal 直接走 risk-exceeded 分支。这让调用方传入
 * 异常 capability 不会陷入 defer 死锁（永远延后但永远触发不了）。
 */

import type { SegmentDecision, SegmentThresholds } from "./types.js";

export interface DecideInput {
  readonly currentTokens: number;
  readonly capability: SegmentThresholds;
  readonly hasInProgressTask: boolean;
}

export function decideSegmentAction(input: DecideInput): SegmentDecision {
  const { currentTokens, capability, hasInProgressTask } = input;
  const { optimalMaxTokens, riskMaxTokens } = capability;

  if (currentTokens < optimalMaxTokens) {
    return { kind: "pass", reason: "below-optimal" };
  }
  if (currentTokens < riskMaxTokens) {
    if (hasInProgressTask) {
      return {
        kind: "defer",
        reason: "in-progress-task",
        currentTokens,
        threshold: optimalMaxTokens,
      };
    }
    return {
      kind: "trigger",
      reason: "optimal-exceeded",
      currentTokens,
      threshold: optimalMaxTokens,
    };
  }
  return {
    kind: "trigger",
    reason: "risk-exceeded",
    currentTokens,
    threshold: riskMaxTokens,
  };
}
