import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import type { ChatRequest, StreamEvent } from "../../types/llm.js";
import { CircuitBreaker } from "../circuit-breaker.js";
import type { CallLLMFn } from "../with-retry.js";
import { withRetry } from "../with-retry.js";

// ─── 测试辅助 ───

const DUMMY_REQUEST: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

const DUMMY_USAGE = { inputTokens: 10, outputTokens: 20 };

/** 构造一个成功的 LLM 流 */
function makeSuccessStream(text = "Hello world"): CallLLMFn {
  return async function* () {
    yield { type: "message_start" } satisfies StreamEvent;
    yield { type: "text_delta", text } satisfies StreamEvent;
    yield {
      type: "message_end",
      stopReason: "end_turn",
      usage: DUMMY_USAGE,
    } satisfies StreamEvent;
  };
}

/** 构造一个 yield error 事件的 LLM 流（模拟 Provider 适配器行为） */
function makeErrorStream(error: Error, preEvents: StreamEvent[] = []): CallLLMFn {
  return async function* () {
    yield { type: "message_start" } satisfies StreamEvent;
    for (const event of preEvents) {
      yield event;
    }
    yield { type: "error", error } satisfies StreamEvent;
  };
}

/** 构造一个抛出异常的 LLM 流 */
function makeThrowingStream(error: Error): CallLLMFn {
  return async function* () {
    yield { type: "message_start" } satisfies StreamEvent;
    throw error;
  };
}

/** 收集 AsyncGenerator 的所有 yield 值 */
async function collectEvents(
  gen: AsyncGenerator<StreamEvent, void, undefined>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** 创建带 status 的 SDK 风格错误 */
function makeApiError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** 创建带 code 的网络错误 */
function makeNetworkError(code: string): NodeJS.ErrnoException {
  const err = new Error(`connect ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ─── 测试 ───

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 正常场景 ───

  describe("正常调用（无错误）", () => {
    it("成功流直接透传所有事件", async () => {
      vi.useRealTimers();
      const callLLM = makeSuccessStream("Hi");
      const wrapped = withRetry(callLLM);

      const events = await collectEvents(wrapped(DUMMY_REQUEST));

      expect(events).toEqual([
        { type: "message_start" },
        { type: "text_delta", text: "Hi" },
        { type: "message_end", stopReason: "end_turn", usage: DUMMY_USAGE },
      ]);
    });
  });

  // ─── 429 速率限制重试 ───

  describe("429 → 自动退避 → 最终成功", () => {
    it("两次 429 后第三次成功", async () => {
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount <= 2) {
          yield { type: "error", error: makeApiError(429, "Rate limited") };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 3,
          backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
        },
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));

      // 第一次退避：100ms（100 × 2^0）
      await vi.advanceTimersByTimeAsync(100);
      // 第二次退避：200ms（100 × 2^1）
      await vi.advanceTimersByTimeAsync(200);

      const events = await resultPromise;
      expect(callCount).toBe(3);

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toEqual({ type: "text_delta", text: "ok" });

      expect(events[events.length - 1]).toEqual({
        type: "message_end",
        stopReason: "end_turn",
        usage: DUMMY_USAGE,
      });
    });
  });

  // ─── 连接错误重试 ───

  describe("连接错误 → 重试（覆盖 Claude Code 盲区）", () => {
    it("ECONNRESET → 自动重试 → 成功", async () => {
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount === 1) {
          yield { type: "error", error: makeNetworkError("ECONNRESET") };
          return;
        }
        yield { type: "text_delta", text: "recovered" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 50, maxDelayMs: 500, jitter: false },
        },
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      await vi.advanceTimersByTimeAsync(50);

      const events = await resultPromise;
      expect(callCount).toBe(2);

      const textEvents = events.filter((e) => e.type === "text_delta");
      expect(textEvents).toEqual([{ type: "text_delta", text: "recovered" }]);
    });

    it("抛出异常（非 yield error）也能重试", async () => {
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount === 1) {
          throw makeNetworkError("ECONNREFUSED");
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 50, maxDelayMs: 500, jitter: false },
        },
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      await vi.advanceTimersByTimeAsync(50);

      const events = await resultPromise;
      expect(callCount).toBe(2);
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
    });
  });

  // ─── 连续失败 → 熔断 ───

  describe("连续失败 → 重试耗尽 → 暴露错误", () => {
    it("4 次 500 → maxRetries=3 → 最终暴露错误", async () => {
      const callLLM = makeErrorStream(makeApiError(500, "Internal server error"));

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 3,
          backoff: { baseDelayMs: 50, maxDelayMs: 200, jitter: false },
        },
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));

      // 推进所有退避定时器
      await vi.advanceTimersByTimeAsync(50); // 1st retry
      await vi.advanceTimersByTimeAsync(100); // 2nd retry
      await vi.advanceTimersByTimeAsync(200); // 3rd retry

      const events = await resultPromise;

      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { type: "error"; error: Error }).error.message).toBe(
        "Internal server error",
      );
    });
  });

  // ─── 不可重试错误 ───

  describe("不可重试错误 → 立即暴露", () => {
    it("401 auth 错误不重试", async () => {
      vi.useRealTimers();
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        yield { type: "error", error: makeApiError(401, "Unauthorized") };
      };

      const wrapped = withRetry(callLLM, { config: { maxRetries: 3 } });
      const events = await collectEvents(wrapped(DUMMY_REQUEST));

      expect(callCount).toBe(1);
      expect(events.some((e) => e.type === "error")).toBe(true);
    });

    it("400 invalid_request 不重试", async () => {
      vi.useRealTimers();
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        yield { type: "error", error: makeApiError(400, "Bad request") };
      };

      const wrapped = withRetry(callLLM, { config: { maxRetries: 3 } });
      const events = await collectEvents(wrapped(DUMMY_REQUEST));

      expect(callCount).toBe(1);
    });
  });

  // ─── 已有内容流出 → 不重试 ───

  describe("已有内容流出后出错 → 不重试", () => {
    it("text_delta 已发射后的错误不重试", async () => {
      vi.useRealTimers();
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        yield { type: "text_delta", text: "partial" };
        yield { type: "error", error: makeNetworkError("ECONNRESET") };
      };

      const wrapped = withRetry(callLLM, { config: { maxRetries: 3 } });
      const events = await collectEvents(wrapped(DUMMY_REQUEST));

      expect(callCount).toBe(1); // 不重试
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(true);
    });

    it("tool_call_start 已发射后的错误不重试", async () => {
      vi.useRealTimers();
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        yield { type: "tool_call_start", id: "tc1", name: "read_file" };
        yield { type: "error", error: makeApiError(500, "Server error") };
      };

      const wrapped = withRetry(callLLM, { config: { maxRetries: 3 } });
      const events = await collectEvents(wrapped(DUMMY_REQUEST));

      expect(callCount).toBe(1);
    });
  });

  // ─── AbortSignal ───

  describe("AbortSignal 中断重试", () => {
    it("退避等待中收到 abort → 立即停止", async () => {
      const controller = new AbortController();

      const callLLM = makeErrorStream(makeApiError(429, "Rate limited"));

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 5,
          backoff: { baseDelayMs: 10_000, maxDelayMs: 30_000, jitter: false },
          abortSignal: controller.signal,
        },
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));

      // 推进到退避等待中
      await vi.advanceTimersByTimeAsync(500);
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);

      const events = await resultPromise;
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { type: "error"; error: Error }).error.name).toBe(
        "AbortError",
      );
    });
  });

  // ─── 熔断器 ───

  describe("外部熔断器", () => {
    it("熔断器开启时直接暴露错误", async () => {
      vi.useRealTimers();
      const breaker = new CircuitBreaker({ maxFailures: 1 });
      breaker.recordFailure(); // 手动触发熔断

      const callLLM = makeSuccessStream();
      const wrapped = withRetry(callLLM, {
        config: { maxRetries: 3 },
        circuitBreaker: breaker,
      });

      const events = await collectEvents(wrapped(DUMMY_REQUEST));
      const errorEvents = events.filter((e) => e.type === "error");
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as { type: "error"; error: Error }).error.message).toContain(
        "Circuit breaker open",
      );
    });

    it("重试成功后熔断器重置", async () => {
      const breaker = new CircuitBreaker({ maxFailures: 5 });
      let callCount = 0;

      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount === 1) {
          yield { type: "error", error: makeApiError(500, "fail") };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 50, maxDelayMs: 200, jitter: false },
        },
        circuitBreaker: breaker,
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;

      expect(breaker.state).toBe("closed");
      expect(breaker.failureCount).toBe(0);
    });
  });

  // ─── EventBus 事件 ───

  describe("EventBus 事件发射", () => {
    it("重试时发射 retry:attempt 事件", async () => {
      const eventBus = createEventBus<AgentEventMap>();
      const attemptHandler = vi.fn();
      eventBus.on("retry:attempt", attemptHandler);

      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount === 1) {
          yield { type: "error", error: makeApiError(429, "Rate limited") };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 50, maxDelayMs: 200, jitter: false },
        },
        eventBus,
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;

      expect(attemptHandler).toHaveBeenCalledOnce();
      expect(attemptHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: "rate_limit",
          attempt: 1,
          maxRetries: 2,
          delayMs: 50,
          willRetry: true,
        }),
      );
    });

    it("重试成功后发射 retry:success 事件", async () => {
      const eventBus = createEventBus<AgentEventMap>();
      const successHandler = vi.fn();
      eventBus.on("retry:success", successHandler);

      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount === 1) {
          yield { type: "error", error: makeApiError(429, "Rate limited") };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 50, maxDelayMs: 200, jitter: false },
        },
        eventBus,
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      await vi.advanceTimersByTimeAsync(50);
      await resultPromise;

      expect(successHandler).toHaveBeenCalledOnce();
      expect(successHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: "rate_limit",
          attemptsTaken: 1,
        }),
      );
    });

    it("重试耗尽后发射 retry:exhausted 事件", async () => {
      const eventBus = createEventBus<AgentEventMap>();
      const exhaustedHandler = vi.fn();
      eventBus.on("retry:exhausted", exhaustedHandler);

      const callLLM = makeErrorStream(makeApiError(500, "Server error"));

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 50, maxDelayMs: 200, jitter: false },
        },
        eventBus,
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(100);
      await resultPromise;

      expect(exhaustedHandler).toHaveBeenCalledOnce();
      expect(exhaustedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: "provider_error",
          totalAttempts: 3,
          lastError: "Server error",
        }),
      );
    });
  });

  // ─── Retry-After 优先 ───

  describe("Retry-After header 优先", () => {
    it("有 Retry-After 时使用其值而非指数退避", async () => {
      let callCount = 0;
      const callLLM: CallLLMFn = async function* () {
        callCount++;
        yield { type: "message_start" };
        if (callCount === 1) {
          const err = makeApiError(429, "Rate limited");
          (err as unknown as Record<string, unknown>).headers = {
            "retry-after": "3",
          };
          yield { type: "error", error: err };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: DUMMY_USAGE,
        };
      };

      const eventBus = createEventBus<AgentEventMap>();
      const attemptHandler = vi.fn();
      eventBus.on("retry:attempt", attemptHandler);

      const wrapped = withRetry(callLLM, {
        config: {
          maxRetries: 2,
          backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter: false },
        },
        eventBus,
      });

      const resultPromise = collectEvents(wrapped(DUMMY_REQUEST));
      // Retry-After: 3s = 3000ms
      await vi.advanceTimersByTimeAsync(3000);
      await resultPromise;

      expect(callCount).toBe(2);
      expect(attemptHandler).toHaveBeenCalledWith(
        expect.objectContaining({ delayMs: 3000 }),
      );
    });
  });
});
