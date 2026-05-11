/**
 * 上下文引擎 — 预算检查 + 策略编排
 *
 * 职责：
 * 1. 预算检查：按 messages 估算 token，与 budget 阈值比对得到 status
 * 2. 策略兜底：budget 触达 compact/critical 时按优先级执行压缩策略
 *
 * onTurnComplete 流程：
 * 1. checkBudget：估算当前 tokens → 计算 budget status
 * 2. 触达 compact/critical 时按优先级执行策略
 * 3. critical 仍无法压下时 force-apply 摘要型策略
 * 4. 发射事件
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
import { calculateBudget, type ModelBudgetInfo } from "./budget.js";

// ─── 引擎内部默认值 ───

/**
 * 引擎默认 budget 阈值。
 *
 * 这套默认（0.65/0.80/0.90）比 budget 模块的 DEFAULT_THRESHOLDS（0.75/0.85/0.95）更激进，
 * 是 agent loop 长程运行场景下经过实践校准的设定：早预警、早压缩、临界稍宽。
 * 调用方有特殊场景需求时通过 `config.thresholds` 直接覆盖。
 */
const ENGINE_DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {
  warning: 0.65,
  compact: 0.8,
  critical: 0.9,
};

// ─── 配置（对外） ───

/**
 * 对外配置接口：thresholds 可省略，由引擎归一化到内部默认值。
 */
export interface ContextEngineConfig {
  modelInfo: ModelBudgetInfo;
  /** 覆盖 budget 阈值（手动 compact 场景下用来强制低阈值） */
  thresholds?: BudgetThresholds;
}

// ─── 配置（对内归一化） ───

/**
 * 归一化后的内部配置：所有字段必填。
 *
 * 这是"配置归一化边界"模式：构造器一次性完成归一化，类内部只读归一化后的值。
 * 避免"原始 config 与默认化字段并存"的二义性。
 */
interface NormalizedContextEngineConfig {
  readonly modelInfo: ModelBudgetInfo;
  readonly thresholds: BudgetThresholds;
}

function normalizeConfig(
  raw: ContextEngineConfig,
): NormalizedContextEngineConfig {
  return {
    modelInfo: raw.modelInfo,
    thresholds: raw.thresholds ?? ENGINE_DEFAULT_BUDGET_THRESHOLDS,
  };
}

// ─── 引擎 ───

export class ContextEngine implements ContextManagerHook {
  private readonly estimator: ITokenEstimator;
  private readonly strategies: CompactionStrategy[];
  private readonly config: NormalizedContextEngineConfig;
  private readonly eventBus?: IEventBus<AgentEventMap>;

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
   * 流程：
   * 1. 预算检查
   * 2. budget 触达 compact/critical 时按优先级执行剩余策略
   * 3. critical 仍无法压下时 force-apply 所有摘要型策略
   * 4. 发射事件
   */
  async onTurnComplete(input: ContextManagerInput): Promise<ContextManagerOutput> {
    let { messages } = input;
    const { turnCount, abortSignal } = input;
    let modified = false;

    // ── Step 1: 预算检查 ──
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

    // ── Step 2: 策略兜底（LLM 压缩等） ──
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
}

export function createContextEngine(
  estimator: ITokenEstimator,
  strategies: CompactionStrategy[],
  config: ContextEngineConfig,
  eventBus?: IEventBus<AgentEventMap>,
): ContextEngine {
  return new ContextEngine(estimator, strategies, config, eventBus);
}
