/**
 * 上下文引擎 — 预算检查 + 策略编排 + 系统提示组装
 *
 * 将 TokenEstimator、Budget、CompactionStrategy、LayerAssembler 整合为统一的 ContextManager。
 *
 * 职责：
 * 1. 预算管理：估算 token → 检查预算 → 按优先级执行压缩策略
 * 2. 系统提示组装：通过 LayerAssembler 按 ContextProfile 参数组装四层 system prompt
 * 3. Turn 轨迹：存储 TurnDigest，在 Layer 3 中注入面包屑轨迹
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
import { INTERACTIVE_PROFILE, type ContextProfile } from "./context-profile.js";
import type { TurnDigest } from "./turn-digest.js";
import type { ToolDeclaration } from "./layer-assembler.js";
import { assembleSystemPrompt } from "./layer-assembler.js";

// ─── 配置 ───

export interface ContextEngineConfig {
  modelInfo: ModelBudgetInfo;
  thresholds?: BudgetThresholds;
  /** 场景 Profile（决定预算阈值、系统提示组装行为）。默认 INTERACTIVE_PROFILE */
  profile?: ContextProfile;
}

// ─── 引擎 ───

/** system prompt 组装所需的可选参数 */
export interface BuildSystemPromptOptions {
  readonly identity: string;
  readonly tools?: readonly ToolDeclaration[];
  readonly userProfile?: string;
  readonly sceneContent?: string;
  readonly workspaceContext?: string;
  readonly currentTime?: string;
  readonly activeTaskHint?: string;
}

export class ContextEngine implements ContextManagerHook {
  private readonly estimator: ITokenEstimator;
  private readonly strategies: CompactionStrategy[];
  private readonly config: ContextEngineConfig;
  private readonly thresholds: BudgetThresholds;
  private readonly eventBus?: IEventBus<AgentEventMap>;
  private readonly profile: ContextProfile;
  private readonly digestHistory: TurnDigest[] = [];

  constructor(
    estimator: ITokenEstimator,
    strategies: CompactionStrategy[],
    config: ContextEngineConfig,
    eventBus?: IEventBus<AgentEventMap>,
  ) {
    this.estimator = estimator;
    this.strategies = [...strategies].sort((a, b) => a.priority - b.priority);
    this.config = config;
    this.thresholds =
      config.thresholds ?? config.profile?.budgetThresholds ?? DEFAULT_THRESHOLDS;
    this.profile = config.profile ?? INTERACTIVE_PROFILE;
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

  /**
   * 记录一个 Turn 的轨迹摘要。
   *
   * 由 Agent Loop 或运行时在每轮完成后调用。
   * 存储的 digest 会在 buildSystemPrompt() 中自动注入 Layer 3。
   */
  addTurnDigest(digest: TurnDigest): void {
    this.digestHistory.push(digest);
  }

  /** 获取所有已记录的 Turn 轨迹摘要 */
  getTurnDigests(): readonly TurnDigest[] {
    return this.digestHistory;
  }

  /** 当前使用的 ContextProfile */
  getProfile(): ContextProfile {
    return this.profile;
  }

  /**
   * 组装 system prompt（四层结构）。
   *
   * 委托 LayerAssembler，自动注入 Profile 和已存储的 TurnDigest。
   * 调用方负责预取 userProfile / sceneContent 等数据。
   */
  buildSystemPrompt(opts: BuildSystemPromptOptions): string {
    return assembleSystemPrompt({
      profile: this.profile,
      ...opts,
      turnDigests: this.digestHistory,
    });
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
