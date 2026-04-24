/**
 * 上下文引擎 — 窗口管理 + 策略编排 + 系统提示组装
 *
 * 将 WindowManager、CompactionStrategy、LayerAssembler 整合为统一的 ContextManager。
 *
 * 职责：
 * 1. 窗口管理：Tier 压缩 → 预算检查 → Pin-aware 淘汰（manageWindow）
 * 2. 策略兜底：窗口管理后仍超标时，按优先级执行 LLM 压缩等策略
 * 3. 系统提示组装：通过 LayerAssembler 按 ContextProfile 参数组装四层 system prompt
 * 4. Turn 轨迹：存储 TurnDigest，在 Layer 3 中注入面包屑轨迹
 *
 * onTurnComplete 流程：
 * 1. manageWindow：Tier 压缩（预防性，每轮运行）→ 预算检查 → 淘汰
 * 2. 如果仍超标：按优先级执行剩余策略（LLM 压缩等）
 * 3. 发射事件
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
import { calculateBudget, calculateEffectiveWindow, type ModelBudgetInfo } from "./budget.js";
import { INTERACTIVE_PROFILE, type ContextProfile } from "./context-profile.js";
import type { TurnDigest } from "./turn-digest.js";
import type { ToolDeclaration } from "./layer-assembler.js";
import { assembleSystemPrompt } from "./layer-assembler.js";
import { manageWindow, defaultIsPinned } from "./window-manager.js";

// ─── 配置（对外） ───

/**
 * 对外配置接口：允许省略 profile / thresholds，由引擎归一化到默认值。
 */
export interface ContextEngineConfig {
  modelInfo: ModelBudgetInfo;
  /** 覆盖 profile.budgetThresholds（通常不用；手动 compact 场景下用来强制低阈值） */
  thresholds?: BudgetThresholds;
  /** 场景 Profile（决定预算阈值、Tier 压缩、系统提示组装）。默认 INTERACTIVE_PROFILE */
  profile?: ContextProfile;
}

// ─── 配置（对内归一化） ───

/**
 * 归一化后的内部配置：所有字段必填。
 *
 * 这是"配置归一化边界"模式：构造器一次性完成归一化，类内部只读归一化后的值。
 * 避免"原始 config 与默认化字段并存"的二义性（曾导致 WindowManager 成为死代码）。
 */
interface NormalizedContextEngineConfig {
  readonly modelInfo: ModelBudgetInfo;
  readonly thresholds: BudgetThresholds;
  readonly profile: ContextProfile;
}

function normalizeConfig(
  raw: ContextEngineConfig,
): NormalizedContextEngineConfig {
  const profile = raw.profile ?? INTERACTIVE_PROFILE;
  return {
    modelInfo: raw.modelInfo,
    thresholds: raw.thresholds ?? profile.budgetThresholds,
    profile,
  };
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
  private readonly config: NormalizedContextEngineConfig;
  private readonly eventBus?: IEventBus<AgentEventMap>;
  private readonly digestHistory: TurnDigest[] = [];

  constructor(
    estimator: ITokenEstimator,
    strategies: CompactionStrategy[],
    config: ContextEngineConfig,
    eventBus?: IEventBus<AgentEventMap>,
  ) {
    this.estimator = estimator;
    this.strategies = [...strategies].sort((a, b) => a.priority - b.priority);
    this.config = normalizeConfig(config);
    this.eventBus = eventBus;
  }

  /**
   * 检查当前预算状态。
   */
  checkBudget(messages: readonly Message[]): ContextBudget {
    const currentTokens = this.estimator.estimateMessages(messages);
    return calculateBudget(
      this.config.modelInfo,
      currentTokens,
      this.config.thresholds,
    );
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
   * 流程（级联淘汰）：
   * 1. WindowManager：Tier 压缩（预防性）→ 预算检查 → Pin-aware turn 淘汰
   * 2. 如果仍超标：按优先级执行剩余策略（LLM 压缩等）
   * 3. 发射事件
   */
  async onTurnComplete(input: ContextManagerInput): Promise<ContextManagerOutput> {
    let { messages } = input;
    const { turnCount } = input;
    let modified = false;

    // ── Step 1: WindowManager 级联（Tier 压缩 + 淘汰） ──
    if (this.config.profile.tierThresholds) {
      const windowResult = manageWindow(messages, {
        tierThresholds: this.config.profile.tierThresholds,
        estimator: this.estimator,
        effectiveWindow: calculateEffectiveWindow(
          this.config.modelInfo.contextWindow,
          this.config.modelInfo.maxOutputTokens,
        ),
        compactRatio: this.config.thresholds.compact,
        isPinned: defaultIsPinned,
      });
      if (windowResult.modified) {
        messages = windowResult.messages;
        modified = true;
      }
    }

    // ── Step 2: 预算检查 ──
    let budget = this.checkBudget(messages);

    await this.eventBus?.emit("context:budget_check", {
      currentTokens: budget.currentTokens,
      effectiveWindow: budget.effectiveWindow,
      usageRatio: budget.usageRatio,
      status: budget.status,
    });

    if (budget.status !== "compact" && budget.status !== "critical") {
      return { messages: messages as Message[], modified };
    }

    // ── Step 3: 剩余策略兜底（LLM 压缩等） ──
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

  /** 当前使用的 ContextProfile（归一化后，永远非空） */
  getProfile(): ContextProfile {
    return this.config.profile;
  }

  /**
   * 组装 system prompt（四层结构）。
   *
   * 委托 LayerAssembler，自动注入 Profile 和已存储的 TurnDigest。
   * 调用方负责预取 userProfile / sceneContent 等数据。
   */
  buildSystemPrompt(opts: BuildSystemPromptOptions): string {
    return assembleSystemPrompt({
      profile: this.config.profile,
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
