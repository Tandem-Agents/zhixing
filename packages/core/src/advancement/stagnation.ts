import type { AdvancementRunReview } from "./types.js";

/**
 * 跨轮僵持信号——死胡同检测的机械半边。输入是 AdvancementStore 的结构化
 * review 序列（criterionId 锚定的逐条判定 + 证据指纹），不依赖推进侧折叠
 * 窗口的自然语言记忆：任务越长窗口折叠越早蒸发跨轮细节，而长任务恰是
 * 最需要死胡同检测的场景。机械信号之上由 LLM 裁判做最终判断——
 * 事实来自 store、判断交 LLM。
 */
export interface StagnationSignal {
  /** 尾部连续 failed 且「unmet 集合 + 证据指纹」无变化的轮数（含最新一轮）。 */
  readonly stagnantRounds: number;
  /** 僵持中的未满足条目 id 集（排序稳定）。 */
  readonly unmetCriterionIds: readonly string[];
}

/**
 * 检测 review 序列尾部的僵持：连续 failed 轮之间 unmet criterionId 集合
 * 与证据指纹都无变化，说明推进没有产生新证据或新缺口。
 * 少于两轮同构不构成信号（单轮 failed 是正常推进）。
 */
export function detectStagnation(
  reviews: readonly AdvancementRunReview[],
): StagnationSignal | undefined {
  const tail: AdvancementRunReview[] = [];
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i]!;
    if (review.decision !== "failed") break;
    tail.unshift(review);
  }
  if (tail.length < 2) return undefined;

  const latest = tail[tail.length - 1]!;
  const latestKey = reviewComparisonKey(latest);
  let stagnantRounds = 1;
  for (let i = tail.length - 2; i >= 0; i--) {
    if (reviewComparisonKey(tail[i]!) !== latestKey) break;
    stagnantRounds++;
  }
  if (stagnantRounds < 2) return undefined;

  return {
    stagnantRounds,
    unmetCriterionIds: unmetCriterionIds(latest),
  };
}

function unmetCriterionIds(review: AdvancementRunReview): readonly string[] {
  return review.attribution.criteria
    .filter((item) => item.verdict === "unmet")
    .map((item) => item.criterionId)
    .sort();
}

/** 一轮验收的对比键 = unmet 条目集 + 证据指纹（id + kind + summary）。 */
function reviewComparisonKey(review: AdvancementRunReview): string {
  const unmet = unmetCriterionIds(review).join(",");
  const evidence = [...review.evidence]
    .map((item) => `${item.id}|${item.kind}|${item.summary}`)
    .sort()
    .join(";");
  return `${unmet}#${evidence}`;
}
