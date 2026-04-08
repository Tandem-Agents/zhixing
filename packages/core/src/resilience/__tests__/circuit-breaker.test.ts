import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
  // ─── 初始状态 ───

  describe("初始化", () => {
    it("初始状态为 closed", () => {
      const cb = new CircuitBreaker({ maxFailures: 3 });
      expect(cb.state).toBe("closed");
      expect(cb.isAllowed).toBe(true);
      expect(cb.failureCount).toBe(0);
    });

    it("maxFailures < 1 时抛出 RangeError", () => {
      expect(() => new CircuitBreaker({ maxFailures: 0 })).toThrow(RangeError);
      expect(() => new CircuitBreaker({ maxFailures: -1 })).toThrow(RangeError);
    });
  });

  // ─── closed → open 转换 ───

  describe("closed → open", () => {
    it("连续失败达到阈值后转为 open", () => {
      const cb = new CircuitBreaker({ maxFailures: 3 });

      cb.recordFailure();
      expect(cb.state).toBe("closed");
      expect(cb.failureCount).toBe(1);

      cb.recordFailure();
      expect(cb.state).toBe("closed");
      expect(cb.failureCount).toBe(2);

      cb.recordFailure();
      expect(cb.state).toBe("open");
      expect(cb.isAllowed).toBe(false);
      expect(cb.failureCount).toBe(3);
    });

    it("maxFailures=1 时首次失败即熔断", () => {
      const cb = new CircuitBreaker({ maxFailures: 1 });
      cb.recordFailure();
      expect(cb.state).toBe("open");
      expect(cb.isAllowed).toBe(false);
    });
  });

  // ─── 成功重置 ───

  describe("recordSuccess", () => {
    it("中间成功一次应重置失败计数", () => {
      const cb = new CircuitBreaker({ maxFailures: 3 });

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.failureCount).toBe(2);

      cb.recordSuccess();
      expect(cb.failureCount).toBe(0);
      expect(cb.state).toBe("closed");

      // 需要再连续 3 次失败才会熔断
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe("closed");

      cb.recordFailure();
      expect(cb.state).toBe("open");
    });
  });

  // ─── open → half_open 自动重置 ───

  describe("open → half_open（定时重置）", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("超过 resetAfterMs 后自动转为 half_open", () => {
      const cb = new CircuitBreaker({
        maxFailures: 1,
        resetAfterMs: 5000,
      });

      cb.recordFailure();
      expect(cb.state).toBe("open");

      vi.advanceTimersByTime(4999);
      expect(cb.state).toBe("open");

      vi.advanceTimersByTime(1);
      expect(cb.state).toBe("half_open");
      expect(cb.isAllowed).toBe(true);
    });

    it("没有 resetAfterMs 时永不自动重置", () => {
      const cb = new CircuitBreaker({ maxFailures: 1 });

      cb.recordFailure();
      expect(cb.state).toBe("open");

      vi.advanceTimersByTime(100_000);
      expect(cb.state).toBe("open");
    });
  });

  // ─── half_open 行为 ───

  describe("half_open", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("half_open 状态下成功 → closed", () => {
      const cb = new CircuitBreaker({
        maxFailures: 1,
        resetAfterMs: 1000,
      });

      cb.recordFailure();
      vi.advanceTimersByTime(1000);
      expect(cb.state).toBe("half_open");

      cb.recordSuccess();
      expect(cb.state).toBe("closed");
      expect(cb.failureCount).toBe(0);
    });

    it("half_open 状态下失败 → 立即回到 open", () => {
      const cb = new CircuitBreaker({
        maxFailures: 2,
        resetAfterMs: 1000,
      });

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe("open");

      vi.advanceTimersByTime(1000);
      expect(cb.state).toBe("half_open");

      cb.recordFailure();
      expect(cb.state).toBe("open");
    });
  });

  // ─── 手动重置 ───

  describe("reset", () => {
    it("从 open 状态手动重置为 closed", () => {
      const cb = new CircuitBreaker({ maxFailures: 1 });

      cb.recordFailure();
      expect(cb.state).toBe("open");

      cb.reset();
      expect(cb.state).toBe("closed");
      expect(cb.failureCount).toBe(0);
      expect(cb.isAllowed).toBe(true);
    });
  });
});
