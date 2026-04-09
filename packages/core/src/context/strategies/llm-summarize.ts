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
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
  ITokenEstimator,
} from "../types.js";
import { getSummarizationPrompt } from "../prompts.js";
import { buildRetryPrompt } from "../prompts.js";
import { validateSummary } from "../validation.js";

// ─── 类型 ───

/**
 * 简化的 LLM 调用函数。
 * 接收消息列表，返回纯文本响应。
 * 由调用方从 LLMProvider 构造。
 */
export type SummarizeLLMFn = (messages: Message[]) => Promise<string>;

export interface LLMSummarizeConfig {
  /** LLM 调用函数 */
  callLLM: SummarizeLLMFn;
  /** 估算器引用（用于计算压缩前后 token 差） */
  estimator: ITokenEstimator;
  /**
   * 触发 L3 的阈值。仅在 budget.usageRatio >= 此值时执行。
   * 默认 0.90 — L2 后仍超 90% 才调 LLM。
   */
  triggerRatio?: number;
  /** 保留最近 N 轮不压缩（默认 4） */
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

  private readonly callLLM: SummarizeLLMFn;
  private readonly estimator: ITokenEstimator;
  private readonly triggerRatio: number;
  private readonly preserveRecentTurns: number;
  private readonly breaker: CircuitBreaker;

  constructor(config: LLMSummarizeConfig) {
    this.callLLM = config.callLLM;
    this.estimator = config.estimator;
    this.triggerRatio = config.triggerRatio ?? 0.9;
    this.preserveRecentTurns = config.preserveRecentTurns ?? 4;
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
    const { messages } = context;
    const tokensBefore = this.estimator.estimateMessages(messages);

    try {
      const { toSummarize, toPreserve } = this.splitMessages(
        messages as Message[],
      );

      if (toSummarize.length < 2) {
        return { messages: messages as Message[], tokensBefore, tokensAfter: tokensBefore, compacted: false };
      }

      const summary = await this.generateAndValidate(toSummarize);

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
      this.breaker.recordFailure();
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
   * 将消息分为"待摘要"和"保留原样"两部分。
   * 保留第一条 user 消息（原始意图）+ 最近 N 轮。
   */
  private splitMessages(messages: Message[]): {
    toSummarize: Message[];
    toPreserve: Message[];
  } {
    const preserveCount = this.preserveRecentTurns * 2;

    if (messages.length <= preserveCount + 2) {
      return { toSummarize: [], toPreserve: messages };
    }

    // 保留最近 N 轮
    const toPreserve = messages.slice(-preserveCount);
    const toSummarize = messages.slice(0, -preserveCount);

    return { toSummarize, toPreserve };
  }

  /**
   * 生成摘要并校验质量。失败时追加修正指令重试一次。
   */
  private async generateAndValidate(messages: Message[]): Promise<string> {
    const prompt = getSummarizationPrompt("main-session");

    // 构建摘要请求：原始消息 + 摘要指令作为末尾 user 消息
    const summaryRequest: Message[] = [
      ...messages,
      { role: "user", content: [{ type: "text", text: prompt }] },
    ];

    const summary = await this.callLLM(summaryRequest);
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

    const retried = await this.callLLM(retryRequest);
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
   */
  private buildCompactedMessages(
    summary: string,
    preservedMessages: Message[],
  ): Message[] {
    return [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[对话已压缩] 以下是之前对话的摘要：\n\n${summary}`,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "已了解之前的对话上下文，请继续。" },
        ],
      },
      ...preservedMessages,
    ];
  }
}

/**
 * 从 LLMProvider 构造 SummarizeLLMFn。
 *
 * 消耗流式响应，拼接为完整文本。
 * 这样 L3 策略不需要直接依赖 LLMProvider 接口。
 */
export function createSummarizeFn(
  provider: {
    chat: (request: {
      model: string;
      messages: Message[];
      tools?: undefined;
    }) => AsyncGenerator<
      { type: string; text?: string },
      void,
      undefined
    >;
  },
  model: string,
): SummarizeLLMFn {
  return async (messages: Message[]): Promise<string> => {
    let text = "";
    const stream = provider.chat({ model, messages, tools: undefined });
    for await (const event of stream) {
      if (event.type === "text_delta" && event.text) {
        text += event.text;
      }
    }
    return text;
  };
}
