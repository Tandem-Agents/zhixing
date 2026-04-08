/**
 * 指数退避算法
 *
 * 跨层复用：LLM 重试、通道重连、消息重处理都使用同一套退避逻辑。
 *
 * 算法：delay = min(baseDelay × 2^attempt, maxDelay)
 * 抖动：Full Jitter — delay = random(0, computedDelay)
 *
 * Full Jitter 优于 Equal Jitter 和 Decorrelated Jitter 的原因：
 * AWS 架构博客（2015）验证了 Full Jitter 在高并发场景下
 * 总完成时间最短、争用最少。
 */

import { DEFAULT_BACKOFF, type BackoffConfig } from "./types.js";

/**
 * 计算第 N 次重试的退避延迟（毫秒）。
 *
 * @param attempt - 第几次重试（0-based：0 = 首次重试）
 * @param config - 退避配置，不传则使用默认值
 * @returns 退避延迟（毫秒）
 */
export function computeBackoffDelay(
  attempt: number,
  config: Partial<BackoffConfig> = {},
): number {
  const { baseDelayMs, maxDelayMs, jitter } = { ...DEFAULT_BACKOFF, ...config };

  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);

  if (!jitter) return capped;

  // Full Jitter: uniform random in [0, capped]
  return Math.floor(Math.random() * (capped + 1));
}

/**
 * 从 LLM Provider 错误中提取 Retry-After 值（毫秒）。
 *
 * 支持两种格式（HTTP 标准）：
 * - 秒数："2" → 2000ms
 * - 日期："Thu, 01 Dec 2025 16:00:00 GMT" → 与当前时间的差值
 *
 * Anthropic 和 OpenAI 的 SDK 通常在 error.headers 中暴露此值。
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  // Anthropic SDK: error.headers?.["retry-after"]
  // OpenAI SDK: error.headers?.["retry-after"]
  const headers = getHeaders(error);
  if (!headers) return undefined;

  const retryAfter =
    headers["retry-after"] ?? headers["Retry-After"] ?? headers["x-ratelimit-reset"];
  if (retryAfter === undefined || retryAfter === null) return undefined;

  const asString = String(retryAfter);

  // 尝试解析为秒数
  const seconds = Number(asString);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  // 尝试解析为日期
  const date = new Date(asString);
  if (!Number.isNaN(date.getTime())) {
    const delta = date.getTime() - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

/**
 * 综合决定退避延迟：优先使用 Retry-After，否则使用指数退避。
 */
export function resolveDelay(
  attempt: number,
  error: unknown,
  config: Partial<BackoffConfig> = {},
): number {
  const retryAfter = extractRetryAfterMs(error);
  if (retryAfter !== undefined) return retryAfter;
  return computeBackoffDelay(attempt, config);
}

/**
 * 异步等待指定毫秒数，支持 AbortSignal 中断。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

// ─── 内部辅助 ───

function getHeaders(error: unknown): Record<string, string | undefined> | undefined {
  const err = error as Record<string, unknown>;

  // SDK error.headers
  if (err["headers"] && typeof err["headers"] === "object") {
    return err["headers"] as Record<string, string | undefined>;
  }

  // 嵌套在 error.error.headers
  if (err["error"] && typeof err["error"] === "object") {
    const inner = err["error"] as Record<string, unknown>;
    if (inner["headers"] && typeof inner["headers"] === "object") {
      return inner["headers"] as Record<string, string | undefined>;
    }
  }

  return undefined;
}
