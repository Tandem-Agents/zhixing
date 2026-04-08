import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoffDelay,
  extractRetryAfterMs,
  resolveDelay,
  sleep,
} from "../backoff.js";

describe("computeBackoffDelay", () => {
  describe("无抖动时应严格按指数退避", () => {
    it("attempt=0 → baseDelay", () => {
      const delay = computeBackoffDelay(0, { jitter: false });
      expect(delay).toBe(500); // 500 × 2^0 = 500
    });

    it("attempt=1 → 2×baseDelay", () => {
      const delay = computeBackoffDelay(1, { jitter: false });
      expect(delay).toBe(1000); // 500 × 2^1 = 1000
    });

    it("attempt=2 → 4×baseDelay", () => {
      const delay = computeBackoffDelay(2, { jitter: false });
      expect(delay).toBe(2000); // 500 × 2^2 = 2000
    });

    it("attempt=5 → 16000 (500 × 2^5)", () => {
      const delay = computeBackoffDelay(5, { jitter: false });
      expect(delay).toBe(16000);
    });
  });

  describe("应被 maxDelayMs 封顶", () => {
    it("超出 maxDelay 时封顶", () => {
      const delay = computeBackoffDelay(10, {
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        jitter: false,
      });
      // 500 × 2^10 = 512000，应被封顶为 10000
      expect(delay).toBe(10_000);
    });

    it("刚好不超出时不封顶", () => {
      const delay = computeBackoffDelay(3, {
        baseDelayMs: 1000,
        maxDelayMs: 10_000,
        jitter: false,
      });
      // 1000 × 2^3 = 8000 < 10000
      expect(delay).toBe(8000);
    });
  });

  describe("抖动（Full Jitter）", () => {
    it("返回值在 [0, capped] 范围内", () => {
      const results = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const delay = computeBackoffDelay(2, { jitter: true });
        results.add(delay);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(2000); // 500 × 2^2
      }
      // 100 次调用应有多个不同值（概率极高）
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe("自定义配置", () => {
    it("接受自定义 baseDelayMs", () => {
      const delay = computeBackoffDelay(0, {
        baseDelayMs: 1000,
        jitter: false,
      });
      expect(delay).toBe(1000);
    });

    it("使用默认配置", () => {
      const delay = computeBackoffDelay(0, { jitter: false });
      expect(delay).toBe(500);
    });
  });
});

describe("extractRetryAfterMs", () => {
  it("从 headers 中提取秒数", () => {
    const error = { headers: { "retry-after": "2" } };
    expect(extractRetryAfterMs(error)).toBe(2000);
  });

  it("从 headers 中提取大写 Retry-After", () => {
    const error = { headers: { "Retry-After": "5" } };
    expect(extractRetryAfterMs(error)).toBe(5000);
  });

  it("处理小数秒数", () => {
    const error = { headers: { "retry-after": "1.5" } };
    expect(extractRetryAfterMs(error)).toBe(1500);
  });

  it("从 x-ratelimit-reset 提取", () => {
    const error = { headers: { "x-ratelimit-reset": "3" } };
    expect(extractRetryAfterMs(error)).toBe(3000);
  });

  it("从嵌套 error.error.headers 提取", () => {
    const error = {
      error: { headers: { "retry-after": "4" } },
    };
    expect(extractRetryAfterMs(error)).toBe(4000);
  });

  it("无 headers 时返回 undefined", () => {
    expect(extractRetryAfterMs({})).toBeUndefined();
    expect(extractRetryAfterMs(null)).toBeUndefined();
    expect(extractRetryAfterMs("string")).toBeUndefined();
    expect(extractRetryAfterMs(undefined)).toBeUndefined();
  });

  it("无法解析时返回 undefined", () => {
    const error = { headers: { "retry-after": "invalid" } };
    expect(extractRetryAfterMs(error)).toBeUndefined();
  });

  it("值为 0 时返回 0", () => {
    const error = { headers: { "retry-after": "0" } };
    expect(extractRetryAfterMs(error)).toBe(0);
  });
});

describe("resolveDelay", () => {
  it("有 Retry-After 时优先使用", () => {
    const error = { headers: { "retry-after": "10" } };
    const delay = resolveDelay(0, error, { jitter: false });
    expect(delay).toBe(10_000);
  });

  it("无 Retry-After 时回退到指数退避", () => {
    const delay = resolveDelay(2, {}, { jitter: false });
    expect(delay).toBe(2000); // 500 × 2^2
  });
});

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("等待指定毫秒数后 resolve", async () => {
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
  });

  it("ms <= 0 时立即 resolve", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-100)).resolves.toBeUndefined();
  });

  it("AbortSignal 已中止时立即 reject", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toThrow("aborted");
  });

  it("等待期间收到 abort 时 reject 并清除定时器", async () => {
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);

    vi.advanceTimersByTime(500);
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
  });
});
