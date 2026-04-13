/**
 * SlidingWindowRateLimiter 单元测试
 *
 * 关键点：
 *   - 时钟注入让我们可以精确控制窗口边界，不依赖 setTimeout
 *   - check() 不副作用记录，record() 才消耗配额（除了懒清理过期项）
 *   - per-key 隔离
 */

import { describe, expect, it } from "vitest";

import { SlidingWindowRateLimiter } from "../rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  /** 创建一个使用受控时钟的 limiter */
  function make(windowMs: number, maxCalls: number) {
    let now = 1_000_000;
    const limiter = new SlidingWindowRateLimiter(windowMs, maxCalls, () => now);
    return {
      limiter,
      advance: (ms: number) => {
        now += ms;
      },
      get now() {
        return now;
      },
    };
  }

  describe("基本配额", () => {
    it("初始 check 返回 allowed=true，remaining=limit", () => {
      const { limiter } = make(1000, 5);
      const result = limiter.check("bash");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
      expect(result.used).toBe(0);
    });

    it("record N 次后 remaining 减少 N", () => {
      const { limiter } = make(1000, 5);
      limiter.record("bash");
      limiter.record("bash");
      const result = limiter.check("bash");
      expect(result.used).toBe(2);
      expect(result.remaining).toBe(3);
    });

    it("达到 limit 时 allowed=false", () => {
      const { limiter } = make(1000, 3);
      limiter.record("bash");
      limiter.record("bash");
      limiter.record("bash");
      const result = limiter.check("bash");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("超过 limit 后再 record 不会让 remaining 变负", () => {
      const { limiter } = make(1000, 2);
      limiter.record("bash");
      limiter.record("bash");
      limiter.record("bash"); // 超额
      const result = limiter.check("bash");
      expect(result.remaining).toBe(0);
      expect(result.used).toBeGreaterThanOrEqual(2);
    });
  });

  describe("窗口滑动", () => {
    it("窗口外的记录被自动过期", () => {
      const { limiter, advance } = make(1000, 3);
      limiter.record("bash"); // t=0
      advance(500);
      limiter.record("bash"); // t=500
      advance(600);
      // t=1100，窗口 [100, 1100]，第一次记录 (0) 已过期
      const result = limiter.check("bash");
      expect(result.used).toBe(1);
      expect(result.allowed).toBe(true);
    });

    it("窗口边界恰好等于 cutoff 的记录被过期", () => {
      const { limiter, advance } = make(1000, 1);
      limiter.record("bash"); // t=0
      advance(1001);
      // t=1001，窗口 [1, 1001]，t=0 不在窗口
      expect(limiter.check("bash").allowed).toBe(true);
    });

    it("满载后等待窗口过期，重新可用", () => {
      const { limiter, advance } = make(1000, 2);
      limiter.record("bash");
      limiter.record("bash");
      expect(limiter.check("bash").allowed).toBe(false);

      advance(1100);
      expect(limiter.check("bash").allowed).toBe(true);
      expect(limiter.check("bash").remaining).toBe(2);
    });
  });

  describe("per-key 隔离", () => {
    it("不同 key 的配额相互独立", () => {
      const { limiter } = make(1000, 2);
      limiter.record("bash");
      limiter.record("bash");
      // bash 满载，但 read 还有空间
      expect(limiter.check("bash").allowed).toBe(false);
      expect(limiter.check("read").allowed).toBe(true);
      expect(limiter.check("read").remaining).toBe(2);
    });
  });

  describe("reset", () => {
    it("reset(key) 只清除指定 key", () => {
      const { limiter } = make(1000, 2);
      limiter.record("bash");
      limiter.record("read");
      limiter.reset("bash");

      expect(limiter.check("bash").used).toBe(0);
      expect(limiter.check("read").used).toBe(1);
    });

    it("reset() 不传参清除全部", () => {
      const { limiter } = make(1000, 2);
      limiter.record("bash");
      limiter.record("read");
      limiter.reset();

      expect(limiter.check("bash").used).toBe(0);
      expect(limiter.check("read").used).toBe(0);
    });
  });

  describe("snapshot", () => {
    it("返回所有 key 的当前使用量（仅窗口内）", () => {
      const { limiter, advance } = make(1000, 5);
      limiter.record("bash");
      limiter.record("bash");
      limiter.record("read");
      advance(1100);
      // 全部过期了——但 snapshot 应该展示 0 而不是包含已过期的
      const snap = limiter.snapshot();
      for (const entry of snap) {
        expect(entry.used).toBe(0);
      }
    });

    it("展示活动 key 的实时使用", () => {
      const { limiter } = make(10_000, 5);
      limiter.record("bash");
      limiter.record("bash");
      limiter.record("write");

      const snap = limiter.snapshot();
      const bashEntry = snap.find((e) => e.key === "bash");
      const writeEntry = snap.find((e) => e.key === "write");
      expect(bashEntry?.used).toBe(2);
      expect(writeEntry?.used).toBe(1);
    });
  });
});
