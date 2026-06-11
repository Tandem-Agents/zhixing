/**
 * 上下文预算计算 —— UI 占用展示的纯函数快照
 *
 * 核心公式（采用 Claude Code 的有效窗口计算）：
 *   effectiveWindow = contextWindow - min(maxOutputTokens, MAX_OUTPUT_RESERVE)
 *
 * 三级百分比阈值（替代 Claude Code 的绝对值 13K/3K）只驱动展示分级：
 *   normal  → usageRatio < 75%
 *   warning → usageRatio ≥ 75%（预警提示）
 *   compact → usageRatio ≥ 85%（建议手动 /compact）
 *   critical → usageRatio ≥ 95%（临界提示）
 *
 * 百分比比绝对值更好：在 32K 窗口的小模型上，13K buffer 占了 40%；
 * 用 15% 只占 4.8K，留更多空间给用户。
 *
 * 窗口压缩本身由段机制全权负责（attention 阈值 / risk-exceeded 应急地板），
 * 本模块不驱动任何压缩。
 */

import type { BudgetStatus, BudgetThresholds, ContextBudget } from "./types.js";
import { DEFAULT_THRESHOLDS, MAX_OUTPUT_RESERVE } from "./types.js";

// ─── 有效窗口计算 ───

/**
 * 计算有效上下文窗口。
 *
 * effectiveWindow = contextWindow - min(maxOutputTokens, MAX_OUTPUT_RESERVE)
 *
 * MAX_OUTPUT_RESERVE (20K) 防止大额 maxOutput（如 100K）
 * 把可用输入空间压得极小。
 */
export function calculateEffectiveWindow(
  contextWindow: number,
  maxOutputTokens: number,
): number {
  const outputReserve = Math.min(maxOutputTokens, MAX_OUTPUT_RESERVE);
  return Math.max(0, contextWindow - outputReserve);
}

// ─── 预算状态判定 ───

/**
 * 根据使用比例判定预算状态。
 */
export function getBudgetStatus(
  usageRatio: number,
  thresholds: BudgetThresholds = DEFAULT_THRESHOLDS,
): BudgetStatus {
  if (usageRatio >= thresholds.critical) return "critical";
  if (usageRatio >= thresholds.compact) return "compact";
  if (usageRatio >= thresholds.warning) return "warning";
  return "normal";
}

// ─── 完整预算计算 ───

export interface ModelBudgetInfo {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * 计算完整的上下文预算。
 *
 * @example
 * ```ts
 * const budget = calculateBudget(
 *   { contextWindow: 200_000, maxOutputTokens: 8192 },
 *   currentTokens,
 * );
 * if (budget.status === 'compact') {
 *   // UI 提示用户可手动 /compact
 * }
 * ```
 */
export function calculateBudget(
  model: ModelBudgetInfo,
  currentTokens: number,
  thresholds: BudgetThresholds = DEFAULT_THRESHOLDS,
): ContextBudget {
  const effectiveWindow = calculateEffectiveWindow(
    model.contextWindow,
    model.maxOutputTokens,
  );

  const usageRatio = effectiveWindow > 0 ? currentTokens / effectiveWindow : 0;
  const status = getBudgetStatus(usageRatio, thresholds);

  return {
    contextWindow: model.contextWindow,
    effectiveWindow,
    currentTokens,
    usageRatio,
    status,
  };
}
