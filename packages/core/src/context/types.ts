/**
 * 上下文管理模块类型定义
 *
 * 设计原则：
 * - Token 估算与预算管理分离：估算器只管"多少 token"，预算管理管"该不该压缩"
 * - 百分比阈值替代绝对值：自适应不同模型的上下文窗口大小
 * - 策略可插拔：CompactionStrategy 接口支持注册自定义压缩策略
 *
 * 对比 Claude Code：它硬编码 13K/3K/20K 常量，在小窗口模型上浪费空间。
 * 对比 OpenClaw：它用闭源 estimateTokens，我们完全自研。
 */

import type { Message } from "../types/messages.js";

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

export interface BudgetThresholds {
  /** 预警阈值（百分比，默认 0.75） */
  warning: number;
  /** 自动压缩阈值（百分比，默认 0.85） */
  compact: number;
  /** 硬挡阈值（百分比，默认 0.95） */
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

// ─── LLM 调用契约 ───

/**
 * 压缩场景的 LLM 调用函数 —— 所有策略的 LLM 调用统一签名。
 *
 * 为什么统一：之前 FlushLLMFn / SummarizeLLMFn 在不同模块各自定义为 `(msgs) => Promise<string>`，
 * 都没有 abortSignal 透传通道 —— session.abort 期间 compact 会继续跑完，
 * 拖住 session 几秒（daemon 模式下更严重）。
 *
 * 契约：
 *   - messages: 发送给 LLM 的消息列表（已含指令 prompt）
 *   - opts.abortSignal: 上游传入的 abort 信号；实现必须透传给底层 provider.chat
 *
 * 实现方从 LLMProvider 构造，或从 CLI 的 flushCallLLM 传入。
 */
export type CompactLLMFn = (
  messages: Message[],
  opts?: { abortSignal?: AbortSignal },
) => Promise<string>;

// ─── 压缩策略 ───

export interface CompactionContext {
  readonly messages: readonly Message[];
  readonly budget: ContextBudget;
  /** 当前已完成的轮次数 */
  readonly currentTurn: number;
  /**
   * 上游传入的 abort 信号 —— 策略的 LLM 调用必须透传。
   *
   * 语义：session.abort / 用户 /abort / daemon grace timer 过期 时触发。
   * 未设置时策略按无限制运行（测试 / 手动 /compact 场景）。
   */
  readonly abortSignal?: AbortSignal;
}

export interface CompactionResult {
  messages: Message[];
  tokensBefore: number;
  tokensAfter: number;
  compacted: boolean;
}

/**
 * 可插拔的压缩策略接口。
 *
 * 内置策略按优先级：
 * - P0: ToolResultTrim（免费，截断旧 tool_result）
 * - P1: MessageDrop（免费，丢弃早期消息）
 * - P2: LLMSummarize（昂贵，LLM 生成摘要）
 */
export interface CompactionStrategy {
  readonly name: string;
  /** 优先级（越小越先执行） */
  readonly priority: number;
  /** 是否需要调用 LLM（影响成本判断） */
  readonly requiresLLM: boolean;
  /** 判断当前状态是否适合执行此策略 */
  canApply(context: CompactionContext): boolean;
  /** 执行压缩 */
  apply(context: CompactionContext): Promise<CompactionResult>;
}

// ─── 上下文管理器 ───

/**
 * Agent Loop 在每轮结束后调用此接口检查预算并执行压缩。
 *
 * 这是 Agent Loop 与上下文管理的唯一耦合点。
 * Agent Loop 无需了解压缩的具体策略，只关心：
 * - 消息是否被修改了
 * - 修改后的消息列表是什么
 */
export interface ContextManagerHook {
  onTurnComplete(state: ContextManagerInput): Promise<ContextManagerOutput>;
}

export interface ContextManagerInput {
  readonly messages: readonly Message[];
  readonly turnCount: number;
  /**
   * 上游传入的 abort 信号。engine 会注入到每个 strategy 的 CompactionContext，
   * 由策略的 LLM 调用透传给 provider。未设置时策略无限制运行。
   */
  readonly abortSignal?: AbortSignal;
}

export interface ContextManagerOutput {
  messages: Message[];
  modified: boolean;
}
