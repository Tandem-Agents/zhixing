/**
 * 上下文模块基础类型 —— token 估算与预算展示快照。
 *
 * 压缩决策已全部归段机制（attention-driven）；预算（ContextBudget）只作
 * UI 占用展示的纯计算，不再驱动任何压缩。
 */

import type { Message } from "../types/messages.js";
import type { ToolSpec } from "../types/tools.js";

// ─── Token 估算 ───

/**
 * Token 估算器接口。
 *
 * 核心能力：
 * - CJK/emoji 独立加权（中文用户必需）
 * - API 返回值自适应校准（越用越准）
 */
export interface ITokenEstimator {
  /** 估算单条消息的 token 数 */
  estimateMessage(message: Message): number;

  /** 估算消息列表的总 token 数 */
  estimateMessages(messages: readonly Message[]): number;

  /** 估算一段文本的 token 数 */
  estimateText(text: string): number;

  /**
   * 估算工具集 token 数 —— LLM API 请求 `tools[]` 字段所占的 token。
   *
   * Provider 把 ToolSpec 转 wire 格式（OpenAI tools / Anthropic tools）后送 LLM；
   * 估算复用文本估算 + JSON 结构开销 + 协议层固定包装字节。
   */
  estimateTools(tools: readonly ToolSpec[]): number;

  /**
   * 用 API 返回的真实 token 数校准估算比率。
   * 滑动平均，不会因单次偏差剧烈波动。
   */
  calibrate(estimated: number, actual: number): void;

  /** 当前的校准因子（1.0 = 未校准，>1.0 = 估算偏低需放大） */
  readonly calibrationFactor: number;
}

// ─── 上下文预算 ───

/** 预算状态。百分比阈值自适应不同窗口大小。 */
export type BudgetStatus = "normal" | "warning" | "compact" | "critical";

export interface ContextBudget {
  /** 模型的原始上下文窗口大小 */
  contextWindow: number;
  /** 有效窗口 = contextWindow - min(maxOutput, 20_000) */
  effectiveWindow: number;
  /** 当前估算的 token 使用量 */
  currentTokens: number;
  /** 使用比例 (0-1+) */
  usageRatio: number;
  /** 预算状态 */
  status: BudgetStatus;
}

/** 展示分级阈值 —— 仅驱动 {@link ContextBudget.status} 的 UI 占用分级，不驱动任何压缩。 */
export interface BudgetThresholds {
  /** 预警阈值（展示分级，默认 0.75） */
  warning: number;
  /** 建议压缩阈值（展示分级，默认 0.85） */
  compact: number;
  /** 临界阈值（展示分级，默认 0.95） */
  critical: number;
}

export const DEFAULT_THRESHOLDS: BudgetThresholds = {
  warning: 0.75,
  compact: 0.85,
  critical: 0.95,
};

/**
 * 输出预留上限。
 * Claude Code 用 min(maxOutput, 20_000)，我们采用相同公式。
 * 防止大额 maxOutput（如 100K）把可用输入空间压得极小。
 */
export const MAX_OUTPUT_RESERVE = 20_000;
