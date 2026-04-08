/**
 * withRetry — LLM 调用重试包装器
 *
 * 核心设计：通过包装 deps.callLLM，将容错能力注入 Agent Loop，
 * 而 agent-loop.ts 本身零修改。
 *
 * "Withhold Error" 模式（借鉴 Claude Code 并改进）：
 * - 可重试错误不立即暴露给消费者，先尝试自动恢复
 * - 只有所有重试耗尽后，才将最后一个错误发射出去
 * - 对消费者来说，要么收到成功的流，要么收到最终的 error 事件
 *
 * 安全重试边界：
 * - 如果尚未向消费者发射任何内容事件（text_delta / tool_call_start 等），
 *   可以安全丢弃当前流并重新发起调用
 * - 如果已经有内容流出，不重试（避免重复数据），直接暴露错误
 *
 * 覆盖 Claude Code 的盲区：
 * - 连接错误（ECONNRESET 等）同样重试
 * - Claude Code 不重试连接错误，这是其 #1 用户报告问题
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import type { ChatRequest, StreamEvent } from "../types/llm.js";
import { resolveDelay, sleep } from "./backoff.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { classifyProviderError } from "./classify.js";
import type { RetryConfig } from "./types.js";
import { DEFAULT_RETRY_CONFIG } from "./types.js";

/**
 * callLLM 函数签名。
 * 与 AgentLoopDeps.callLLM 一致。
 */
export type CallLLMFn = (
  request: ChatRequest,
) => AsyncGenerator<StreamEvent, void, undefined>;

export interface WithRetryOptions {
  config?: Partial<RetryConfig>;
  eventBus?: IEventBus<AgentEventMap>;
  /** 外部传入的熔断器实例（跨调用共享状态）。不传则内部创建 */
  circuitBreaker?: CircuitBreaker;
}

/**
 * 包装 callLLM，添加自动重试和熔断。
 *
 * 使用方式：
 * ```ts
 * const resilientCallLLM = withRetry(provider.chat.bind(provider), {
 *   config: { maxRetries: 3 },
 *   eventBus,
 * });
 *
 * // 注入到 Agent Loop
 * runAgentLoop({ ..., deps: { callLLM: resilientCallLLM } });
 * ```
 */
export function withRetry(
  callLLM: CallLLMFn,
  options: WithRetryOptions = {},
): CallLLMFn {
  const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...options.config };
  const breaker =
    options.circuitBreaker ??
    new CircuitBreaker({ maxFailures: config.maxRetries + 1 });

  return (request: ChatRequest) =>
    retryableStream(callLLM, request, config, breaker, options.eventBus);
}

// ─── 内部实现 ───

/** 标记已流出内容的事件类型 */
const CONTENT_EVENT_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_end",
]);

async function* retryableStream(
  callLLM: CallLLMFn,
  request: ChatRequest,
  config: RetryConfig,
  breaker: CircuitBreaker,
  eventBus?: IEventBus<AgentEventMap>,
): AsyncGenerator<StreamEvent, void, undefined> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    // ── 熔断器检查 ──
    if (!breaker.isAllowed) {
      await emitRetryExhausted(eventBus, lastError, attempt);
      yield {
        type: "error",
        error: new Error(
          `Circuit breaker open after ${breaker.failureCount} consecutive failures`,
        ),
      };
      return;
    }

    // ── 退避等待（首次不等） ──
    if (attempt > 0) {
      const delayMs = resolveDelay(attempt - 1, lastError, config.backoff);
      const willRetry = true;

      await emitRetryAttempt(eventBus, lastError, attempt, config.maxRetries, delayMs, willRetry);

      try {
        await sleep(delayMs, config.abortSignal);
      } catch {
        // AbortSignal 触发
        yield {
          type: "error",
          error: new DOMException("Retry aborted", "AbortError"),
        };
        return;
      }
    }

    // ── 尝试调用 ──
    let hasStreamedContent = false;
    let streamError: unknown = null;

    try {
      const stream = callLLM(request);

      for await (const event of stream) {
        if (event.type === "error") {
          streamError = event.error;
          break;
        }

        if (CONTENT_EVENT_TYPES.has(event.type)) {
          hasStreamedContent = true;
        }

        yield event;
      }

      if (!streamError) {
        // 流正常完成
        breaker.recordSuccess();

        if (attempt > 0) {
          await emitRetrySuccess(eventBus, lastError, attempt);
        }
        return;
      }
    } catch (err) {
      streamError = err;
    }

    // ── 错误处理 ──
    lastError = streamError;
    const errorType = classifyProviderError(streamError);
    const isRetryable = config.retryableTypes.includes(errorType);
    const isLastAttempt = attempt >= config.maxRetries;

    // 三种情况不重试：已有内容流出、不可重试类型、最后一次尝试
    if (hasStreamedContent || !isRetryable || isLastAttempt) {
      breaker.recordFailure();

      if (isLastAttempt && isRetryable && !hasStreamedContent) {
        await emitRetryExhausted(eventBus, lastError, attempt + 1);
      }

      yield {
        type: "error",
        error:
          streamError instanceof Error
            ? streamError
            : new Error(String(streamError)),
      };
      return;
    }

    // 记录失败但继续重试
    breaker.recordFailure();
  }
}

// ─── 事件发射辅助 ───

async function emitRetryAttempt(
  eventBus: IEventBus<AgentEventMap> | undefined,
  error: unknown,
  attempt: number,
  maxRetries: number,
  delayMs: number,
  willRetry: boolean,
): Promise<void> {
  await eventBus?.emit("retry:attempt", {
    errorType: classifyProviderError(error),
    attempt,
    maxRetries,
    delayMs,
    willRetry,
  });
}

async function emitRetrySuccess(
  eventBus: IEventBus<AgentEventMap> | undefined,
  _originalError: unknown,
  attemptsTaken: number,
): Promise<void> {
  await eventBus?.emit("retry:success", {
    errorType: classifyProviderError(_originalError),
    attemptsTaken,
    totalDelayMs: 0, // 简化：精确值需要累计，后续按需增强
  });
}

async function emitRetryExhausted(
  eventBus: IEventBus<AgentEventMap> | undefined,
  error: unknown,
  totalAttempts: number,
): Promise<void> {
  await eventBus?.emit("retry:exhausted", {
    errorType: classifyProviderError(error),
    totalAttempts,
    lastError: error instanceof Error ? error.message : String(error),
  });
}
