/**
 * 上下文引擎 — 预算检查 + 策略编排
 *
 * 将 TokenEstimator、Budget、CompactionStrategy 整合为统一的 ContextManager。
 * Agent Loop 在每轮结束后调用 onTurnComplete()，引擎自动完成：
 *   1. 估算当前 token 使用量
 *   2. 计算预算状态
 *   3. 如果需要压缩，按策略优先级执行
 *   4. 发射事件（预算检查、压缩开始/结束、校准）
 *
 * 策略执行遵循成本优先级联原则：
 * - 先做免费操作（ToolResult 截断、消息丢弃）
 * - 每执行一个策略后重新检查预算
 * - 仅在免费策略不够时才调用 LLM 摘要
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import type { Message } from "../types/messages.js";
import type {
  BudgetThresholds,
  CompactionStrategy,
  ContextBudget,
  ContextManagerHook,
  ContextManagerInput,
  ContextManagerOutput,
  ITokenEstimator,
} from "./types.js";
import { DEFAULT_THRESHOLDS } from "./types.js";
import { calculateBudget, type ModelBudgetInfo } from "./budget.js";

// ─── 配置 ───

export interface ContextEngineConfig {
  modelInfo: ModelBudgetInfo;
  thresholds?: BudgetThresholds;
}

// ─── 引擎 ───

export class ContextEngine implements ContextManagerHook {
  private readonly estimator: ITokenEstimator;
  private readonly strategies: CompactionStrategy[];
  private readonly config: ContextEngineConfig;
  private readonly thresholds: BudgetThresholds;
  private readonly eventBus?: IEventBus<AgentEventMap>;

  constructor(
    estimator: ITokenEstimator,
    strategies: CompactionStrategy[],
    config: ContextEngineConfig,
    eventBus?: IEventBus<AgentEventMap>,
  ) {
    this.estimator = estimator;
    this.strategies = [...strategies].sort((a, b) => a.priority - b.priority);
    this.config = config;
    this.thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
    this.eventBus = eventBus;
  }

  /**
   * 检查当前预算状态。
   */
  checkBudget(messages: readonly Message[]): ContextBudget {
    const currentTokens = this.estimator.estimateMessages(messages);
    return calculateBudget(this.config.modelInfo, currentTokens, this.thresholds);
  }

  /**
   * 用 API 返回的实际 token 数校准估算器。
   */
  calibrate(estimated: number, actual: number): void {
    this.estimator.calibrate(estimated, actual);

    this.eventBus?.emit("context:calibrate", {
      estimated,
      actual,
      newRatio: this.estimator.calibrationFactor,
    });
  }

  /**
   * Agent Loop 的 hook：每轮结束后调用。
   *
   * 流程：
   * 1. 估算 token → 计算预算
   * 2. 发射 budget_check 事件
   * 3. 如果状态 ≥ compact，按优先级执行策略
   * 4. 每个策略执行后重新估算，如果已回到 normal/warning 则停止
   */
  async onTurnComplete(input: ContextManagerInput): Promise<ContextManagerOutput> {
    let { messages } = input;
    const { turnCount } = input;
    let modified = false;

    let budget = this.checkBudget(messages);

    await this.eventBus?.emit("context:budget_check", {
      currentTokens: budget.currentTokens,
      effectiveWindow: budget.effectiveWindow,
      usageRatio: budget.usageRatio,
      status: budget.status,
    });

    if (budget.status !== "compact" && budget.status !== "critical") {
      return { messages: messages as Message[], modified: false };
    }

    for (const strategy of this.strategies) {
      const context = { messages, budget, currentTurn: turnCount };

      if (!strategy.canApply(context)) continue;

      const tokensBefore = budget.currentTokens;

      await this.eventBus?.emit("context:compact_start", {
        strategy: strategy.name,
        tokensBefore,
      });

      const result = await strategy.apply(context);

      if (result.compacted) {
        messages = result.messages;
        modified = true;

        budget = this.checkBudget(messages);

        await this.eventBus?.emit("context:compact_end", {
          strategy: strategy.name,
          tokensBefore,
          tokensAfter: budget.currentTokens,
          success: true,
        });

        // 压缩后已回到安全区间，停止执行更多策略
        if (budget.status === "normal" || budget.status === "warning") {
          break;
        }
      } else {
        await this.eventBus?.emit("context:compact_end", {
          strategy: strategy.name,
          tokensBefore,
          tokensAfter: tokensBefore,
          success: false,
        });
      }
    }

    return { messages: messages as Message[], modified };
  }
}

export function createContextEngine(
  estimator: ITokenEstimator,
  strategies: CompactionStrategy[],
  config: ContextEngineConfig,
  eventBus?: IEventBus<AgentEventMap>,
): ContextEngine {
  return new ContextEngine(estimator, strategies, config, eventBus);
}
