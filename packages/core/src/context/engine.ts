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
  BudgetStatus,
  BudgetThresholds,
  CompactionContext,
  CompactionStrategy,
  CompactStrategyContribution,
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
    const { turnCount, abortSignal } = input;
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
      phase: "pre-compact",
      currentTokens: budget.currentTokens,
      effectiveWindow: budget.effectiveWindow,
      usageRatio: budget.usageRatio,
      status: budget.status,
    });

    if (budget.status !== "compact" && budget.status !== "critical") {
      return { messages: messages as Message[], modified };
    }

    // ── Step 3: 剩余策略兜底（LLM 压缩等） ──
    const contributions: CompactStrategyContribution[] = [];
    const transactionTokensBefore = budget.currentTokens;
    // 事务幂等启动 —— 第一次 canApply 成功（或 force-apply 入场）时 fire compact_start，
    // 重复调用只读 flag 不再 emit。抽成 closure 避免在 loop 内和 force-apply 分支各维护一份。
    const tx = { started: false };
    const startTransaction = async (): Promise<void> => {
      if (tx.started) return;
      await this.eventBus?.emit("context:compact_start", {
        tokensBefore: transactionTokensBefore,
      });
      tx.started = true;
    };

    // 单个 strategy 的"执行 + 贡献记录"原子操作 —— 循环和 force-apply 共用。
    //
    // 职责：
    //   1. startTransaction（事务幂等启动）
    //   2. 构造 CompactionContext（每次用当前 messages/budget 快照，循环中它们会在上一步 mutate）
    //   3. strategy.apply —— 若抛错记录一条 success:false 的贡献再 rethrow
    //      （契约：strategies 内部应捕获异常并返 compacted:false；rethrow 只发生在
    //       programming bug 路径。贡献预先记录保证 compact_end 事件包含所有尝试记录，
    //       诊断/审计不丢）
    //   4. 成功时更新 messages / budget / modified
    //   5. 无论如何推一条贡献进 contributions 数组
    //
    // 关闭了闭包里所有 mutation：contributions / messages / modified / budget。
    // 函数之外不再操作同名变量（单一 mutation 入口）。
    const runStrategyAttempt = async (
      strategy: CompactionStrategy,
      phase: "normal" | "force-apply",
    ): Promise<void> => {
      const stratBefore = budget.currentTokens;
      await startTransaction();

      const context: CompactionContext = {
        messages,
        budget,
        currentTurn: turnCount,
        abortSignal,
      };

      let compacted = false;
      let summary: string | undefined;
      let turnsCompacted: number | undefined;
      let threwError: unknown;

      try {
        const result = await strategy.apply(context);
        if (result.compacted) {
          messages = result.messages;
          modified = true;
          budget = this.checkBudget(messages);
        }
        compacted = result.compacted;
        summary = result.summary;
        turnsCompacted = result.turnsCompacted;
      } catch (e) {
        threwError = e;
      }

      contributions.push({
        name: strategy.name,
        phase,
        success: compacted,
        tokensBefore: stratBefore,
        tokensAfter: compacted ? budget.currentTokens : stratBefore,
        summary,
        turnsCompacted,
      });

      if (threwError) throw threwError;
    };

    let caughtError: unknown;

    try {
      for (const strategy of this.strategies) {
        const checkContext: CompactionContext = {
          messages,
          budget,
          currentTurn: turnCount,
          abortSignal,
        };

        if (!strategy.canApply(checkContext)) continue;

        await runStrategyAttempt(strategy, "normal");

        // runStrategyAttempt 闭包里重新赋值 budget（this.checkBudget 结果）；
        // 但 TS 的 control-flow narrowing 不跟踪 async 闭包里的 mutation —— 从 Step 2 的
        // early return 带下来的"status 只能是 compact|critical"narrow 仍在起作用。
        // 用 `as BudgetStatus` 显式拓宽联合，让 normal/warning 比较不被判 dead code。
        const postStatus = budget.status as BudgetStatus;
        if (postStatus === "normal" || postStatus === "warning") {
          break;
        }
      }

      // ── critical 硬挡 —— strategies 循环后仍 critical，force-apply 所有摘要型策略 ──
      //
      // 场景：
      //   - summarize 型 canApply 被 triggerRatio / messages.length 挡住没跑
      //   - 或跑过但 compacted:false（LLM 调用失败 / summary 校验失败）
      //   - 循环结束后 budget.status === "critical" —— 必须再 try，否则 agent-loop
      //     硬送 LLM 会被 provider 报 context_length_exceeded
      //
      // 设计：
      //   - force-apply 纳入当前事务（contributions 数组 + 同一 compact_end）—— 不另起事务
      //   - 绕过 canApply 的 triggerRatio / messages.length 门槛直接调 apply
      //   - breaker 保护：apply 内部熔断时 compacted:false 返回，不破坏事务
      //   - 按 `kind === "summarize"` 识别 —— 分类维度一等公民；未来改名/加多摘要
      //     策略/用户自定义策略时自动适配，无需改 engine
      //   - 遍历**所有** summarize 策略（按 priority ASC，与循环顺序一致）—— 若用户注册
      //     多个摘要型策略（如 fast-summarize priority=100 + llm-summarize priority=200），
      //     force-apply 会从轻到重依次尝试，降到 non-critical 就 break。
      //     单策略场景下行为零变化（只遍历 1 个）。
      //   - contribution.phase = "force-apply" 标记阶段，name 保持纯策略 ID
      //     （消费方按 name + phase 组合做分组/统计）
      if (budget.status === "critical") {
        const summarizeStrategies = this.strategies.filter(
          (s) => s.kind === "summarize",
        );
        for (const strategy of summarizeStrategies) {
          // 同上：async 闭包 mutation 不被 TS 追踪；显式用 `as BudgetStatus` 拓宽
          // 防止外层 "critical" 窄化把 "!== 'critical'" 判为 dead code
          const currentStatus = budget.status as BudgetStatus;
          if (currentStatus !== "critical") break;
          await runStrategyAttempt(strategy, "force-apply");
        }
      }
    } catch (e) {
      caughtError = e;
    } finally {
      if (tx.started) {
        const aggregateSummary = contributions
          .map((c) => c.summary)
          .filter((s): s is string => s !== undefined)
          .pop();
        const aggregateTurnsCompactedRaw = contributions.reduce(
          (sum, c) =>
            c.turnsCompacted !== undefined ? sum + c.turnsCompacted : sum,
          0,
        );
        const aggregateTurnsCompacted =
          aggregateTurnsCompactedRaw > 0 ? aggregateTurnsCompactedRaw : undefined;

        // EventBus.emit 契约：单个 listener 抛错由 EventBus 内部 errorHandler 吞掉
        // 并 console.error，emit 本身永远 resolve 不 reject。因此不需要外层 try-catch
        // 去防御"emit 会抛错掩盖 caughtError"的情况 —— 那种情况不存在。
        await this.eventBus?.emit("context:compact_end", {
          strategies: contributions,
          summary: aggregateSummary,
          turnsCompacted: aggregateTurnsCompacted,
          tokensBefore: transactionTokensBefore,
          tokensAfter: budget.currentTokens,
        });
      }
    }

    // ── Step 4: post-compact budget_check ──
    //
    // 契约：只要进入了 strategies 循环路径（即 pre-compact budget 是 compact/critical），
    // 无论 strategies 是否抛错，post-compact 必须 fire —— 保证订阅方观测链完整：
    //   pre-compact → compact_start/end（事务化）→ post-compact
    //
    // 这和 compact_start/end 的 try-finally 契约精神一致：错误路径不破坏事件契约。
    // 注意顺序：post-compact emit 必须在 rethrow caughtError 之前，否则抛错路径会跳过。
    // EventBus.emit 不抛错（契约见上方 compact_end 注释），无需 try-catch 包装。
    await this.eventBus?.emit("context:budget_check", {
      phase: "post-compact",
      currentTokens: budget.currentTokens,
      effectiveWindow: budget.effectiveWindow,
      usageRatio: budget.usageRatio,
      status: budget.status,
    });

    if (caughtError) throw caughtError;

    // 硬挡失败判断 —— force-apply 后仍 critical 则 failed。
    // 消费方（agent-loop / run-agent pre-flight）收到 failed 必须终止 run，
    // 不要硬送 LLM（会被 provider 报 context_length_exceeded）。
    const failed = budget.status === "critical" ? true : undefined;

    return { messages: messages as Message[], modified, failed };
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
