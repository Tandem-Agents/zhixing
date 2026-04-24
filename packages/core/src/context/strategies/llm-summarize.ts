/**
 * L3 压缩策略：LLM 摘要压缩
 *
 * 最昂贵的策略（需要 LLM 调用），仅在 L1/L2 不够时触发。
 *
 * 流程：
 * 1. 构建摘要请求：对话历史 + 7 段摘要指令
 * 2. 调用 LLM 生成摘要
 * 3. 校验摘要质量（必需章节检查）
 * 4. 校验失败时追加修正指令重试一次
 * 5. 用摘要替换被压缩的消息
 *
 * 保护机制：
 * - CircuitBreaker：3 次连续失败后停止尝试
 * - 降级：熔断后跳过 L3，保留 L1/L2 的结果
 */

import type { Message } from "../../types/messages.js";
import { CircuitBreaker } from "../../resilience/circuit-breaker.js";
import type {
  CompactLLMFn,
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
  ITokenEstimator,
} from "../types.js";
import { splitMessagesPairAware } from "../message-turns.js";
import { getSummarizationPrompt } from "../prompts.js";
import { buildRetryPrompt } from "../prompts.js";
import { buildCompactSummaryPair } from "../system-meta.js";
import { validateSummary } from "../validation.js";

// ─── 类型 ───

/**
 * 摘要压缩用的 LLM 调用函数。
 *
 * @deprecated 使用 `CompactLLMFn`（等价类型，统一契约）。此别名仅为保留既有导入不破。
 *
 * 迁移指引：`import type { CompactLLMFn } from "@zhixing/core"` 并在构造函数参数中替换。
 * 新签名支持透传 `opts.abortSignal` 到 provider.chat，消除 compact 期间的 abort 竞争。
 */
export type SummarizeLLMFn = CompactLLMFn;

export interface LLMSummarizeConfig {
  /** LLM 调用函数 */
  callLLM: CompactLLMFn;
  /** 估算器引用（用于计算压缩前后 token 差） */
  estimator: ITokenEstimator;
  /**
   * 触发 L3 的阈值。仅在 budget.usageRatio >= 此值时执行。
   * 默认 0.90 — L2 后仍超 90% 才调 LLM。
   */
  triggerRatio?: number;
  /**
   * 保留最近 N 个 turn 不压缩（默认 2）。
   *
   * 注意：turn 数语义（一个 assistant 消息 + 其后 tool_result user）。
   * 不是"消息数"。2 个完整 turn 在 tool 密集场景可能对应 4-8 条消息，
   * 这是 pair-aware 切分的必要代价 —— 保证 tool_use/tool_result 对完整。
   */
  preserveRecentTurns?: number;
  /** 熔断配置 */
  circuitBreaker?: {
    maxFailures?: number;
    resetAfterMs?: number;
  };
}

// ─── 策略实现 ───

export class LLMSummarizeStrategy implements CompactionStrategy {
  readonly name = "llm-summarize";
  readonly priority = 200;
  readonly requiresLLM = true;

  private readonly callLLM: CompactLLMFn;
  private readonly estimator: ITokenEstimator;
  private readonly triggerRatio: number;
  /**
   * 保留最近 N 个 turn（按 turn 数，不是消息数）。
   *
   * turn 定义：一个 assistant 消息 + 其后续 tool_result user 消息。
   * 通过 splitMessagesPairAware 确保 tool pair 不被切开。
   */
  private readonly preserveRecentTurns: number;
  private readonly breaker: CircuitBreaker;

  constructor(config: LLMSummarizeConfig) {
    this.callLLM = config.callLLM;
    this.estimator = config.estimator;
    this.triggerRatio = config.triggerRatio ?? 0.9;
    // 默认 2（新 turn 数语义）。文档曾用 4 作"消息数/2"，切到 pair-aware
    // 按 turn 数后继续用 4 会让 toPreserve 在 tool 密集场景占过多空间、
    // 摘要降幅不足。2 个完整 turn 够 LLM 保持最近上下文。
    this.preserveRecentTurns = config.preserveRecentTurns ?? 2;
    this.breaker = new CircuitBreaker({
      maxFailures: config.circuitBreaker?.maxFailures ?? 3,
      resetAfterMs: config.circuitBreaker?.resetAfterMs ?? 60_000,
    });
  }

  canApply(context: CompactionContext): boolean {
    if (!this.breaker.isAllowed) return false;
    if (context.budget.usageRatio < this.triggerRatio) return false;
    // 至少需要一些消息才值得摘要
    if (context.messages.length < 6) return false;
    return true;
  }

  async apply(context: CompactionContext): Promise<CompactionResult> {
    const { messages, abortSignal } = context;
    const tokensBefore = this.estimator.estimateMessages(messages);

    try {
      // 按 turn 数切分（pair-aware），tool_use/tool_result 对不会被劈开
      const { toSummarize, toPreserve } = splitMessagesPairAware(
        messages,
        this.preserveRecentTurns,
      );

      if (toSummarize.length < 2) {
        return { messages: messages as Message[], tokensBefore, tokensAfter: tokensBefore, compacted: false };
      }

      const summary = await this.generateAndValidate(toSummarize, abortSignal);

      const compactedMessages = this.buildCompactedMessages(
        summary,
        toPreserve,
      );
      const tokensAfter = this.estimator.estimateMessages(compactedMessages);

      this.breaker.recordSuccess();
      return {
        messages: compactedMessages,
        tokensBefore,
        tokensAfter,
        compacted: true,
      };
    } catch (error) {
      // Abort 是用户意图（session.abort / /abort / grace timer），不是策略不可靠。
      // 不计 breaker 失败（避免连续 abort 误熔断 60s），不 rethrow（engine/agent-loop
      // 链路没有 try-catch，rethrow 会导致 agent-loop 抛未捕获错误）。
      // 静默返回 compacted:false，agent-loop 的下一次主循环迭代会自行检查
      // abortSignal.aborted 并正常停止。
      if (!abortSignal?.aborted) {
        this.breaker.recordFailure();
      }
      return {
        messages: messages as Message[],
        tokensBefore,
        tokensAfter: tokensBefore,
        compacted: false,
      };
    }
  }

  /** 当前熔断器状态（用于诊断） */
  get circuitBreakerState() {
    return this.breaker.state;
  }

  // ─── 内部方法 ───

  /**
   * 生成摘要并校验质量。失败时追加修正指令重试一次。
   */
  private async generateAndValidate(
    messages: Message[],
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const prompt = getSummarizationPrompt("main-session");
    const opts = { abortSignal };

    // 构建摘要请求：原始消息 + 摘要指令作为末尾 user 消息
    const summaryRequest: Message[] = [
      ...messages,
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];

    const summary = await this.callLLM(summaryRequest, opts);
    const validation = validateSummary(summary, "main-session");

    if (validation.valid) {
      return summary;
    }

    // 单次重试：追加修正指令
    const retryRequest: Message[] = [
      ...summaryRequest,
      { role: "assistant", content: [{ type: "text", text: summary }] },
      {
        role: "user",
        content: [
          { type: "text", text: buildRetryPrompt(validation.missing) },
        ],
      },
    ];

    const retried = await this.callLLM(retryRequest, opts);
    const revalidation = validateSummary(retried, "main-session");

    if (revalidation.valid) {
      return retried;
    }

    throw new Error(
      `摘要校验失败（重试后仍缺少：${revalidation.missing.join("、")}）`,
    );
  }

  /**
   * 用摘要替换被压缩的消息，保留最近的 turns。
   *
   * 摘要由 `buildCompactSummaryPair` 构造为 `<system-meta>` 标签 pair，
   * 确保 LLM 看到的格式和 transcript load 时 rebuild 一致（system-meta 统一事实源）。
   */
  private buildCompactedMessages(
    summary: string,
    preservedMessages: Message[],
  ): Message[] {
    const [summaryMsg, ackMsg] = buildCompactSummaryPair(summary);
    return [summaryMsg, ackMsg, ...preservedMessages];
  }
}

/**
 * 工厂函数 —— 与其他策略（createToolResultTrimStrategy / createMessageDropStrategy /
 * createMemoryFlushStrategy）命名一致，方便在 strategies 数组中统一风格注册。
 */
export function createLLMSummarizeStrategy(
  config: LLMSummarizeConfig,
): LLMSummarizeStrategy {
  return new LLMSummarizeStrategy(config);
}

/**
 * 从 LLMProvider 构造 CompactLLMFn。
 *
 * 消耗流式响应，拼接为完整文本。`abortSignal` 透传给 provider.chat，
 * 被 abort 时 stream 会抛 AbortError，此函数不吞掉 —— 调用方（strategy.apply
 * 的 try-catch）负责 CircuitBreaker / 静默处理。
 */
export function createSummarizeFn(
  provider: {
    chat: (request: {
      model: string;
      messages: Message[];
      tools?: undefined;
      abortSignal?: AbortSignal;
    }) => AsyncGenerator<
      { type: string; text?: string },
      void,
      undefined
    >;
  },
  model: string,
): CompactLLMFn {
  return async (messages: Message[], opts?): Promise<string> => {
    let text = "";
    const stream = provider.chat({
      model,
      messages,
      tools: undefined,
      abortSignal: opts?.abortSignal,
    });
    for await (const event of stream) {
      if (event.type === "text_delta" && event.text) {
        text += event.text;
      }
    }
    return text;
  };
}
