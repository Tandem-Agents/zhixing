/**
 * 滑动窗口频率限制器 — Phase 2 执行守卫
 *
 * 设计要点：
 *   - 按 key（通常是工具名）独立限流
 *   - 滑动窗口：保留窗口期内的时间戳，窗口外的自动过期
 *   - 纯内存，时钟可注入便于测试
 *   - `check()` 只查询不记录；`record()` 真正消耗配额
 *     这种分离让"决策 + 记录"可以分两步完成（先 check 判断是否允许，
 *     真正放行时才 record），避免被拦截的调用也占用配额
 */

export interface RateLimitResult {
  /** 是否在配额内 */
  allowed: boolean;
  /** 窗口内剩余可用次数 */
  remaining: number;
  /** 窗口内已用次数 */
  used: number;
  /** 窗口大小（ms） */
  windowMs: number;
  /** 窗口最大次数 */
  limit: number;
}

export class SlidingWindowRateLimiter {
  private readonly timestamps = new Map<string, number[]>();

  constructor(
    /** 窗口大小（毫秒） */
    private readonly windowMs: number,
    /** 窗口内最大次数 */
    private readonly maxCalls: number,
    /** 时钟注入（便于测试） */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 查询给定 key 是否还有配额。
   * 副作用：清理窗口外的过期时间戳（懒清理）。
   */
  check(key: string): RateLimitResult {
    const current = this.now();
    const cutoff = current - this.windowMs;
    const all = this.timestamps.get(key) ?? [];

    // 懒清理：去掉窗口外的
    const valid = all.filter((t) => t > cutoff);
    if (valid.length !== all.length) {
      this.timestamps.set(key, valid);
    }

    return {
      allowed: valid.length < this.maxCalls,
      remaining: Math.max(0, this.maxCalls - valid.length),
      used: valid.length,
      windowMs: this.windowMs,
      limit: this.maxCalls,
    };
  }

  /**
   * 真正记录一次调用——消耗一格配额。
   * 调用方应在放行决策后调用，被拦截的调用不应 record。
   */
  record(key: string): void {
    const current = this.now();
    const list = this.timestamps.get(key) ?? [];
    list.push(current);
    this.timestamps.set(key, list);
  }

  /** 清除指定 key 或全部的记录 */
  reset(key?: string): void {
    if (key === undefined) {
      this.timestamps.clear();
    } else {
      this.timestamps.delete(key);
    }
  }

  /** 调试：返回所有 key 的当前使用量 */
  snapshot(): Array<{ key: string; used: number; limit: number }> {
    const current = this.now();
    const cutoff = current - this.windowMs;
    const out: Array<{ key: string; used: number; limit: number }> = [];
    for (const [key, stamps] of this.timestamps) {
      const used = stamps.filter((t) => t > cutoff).length;
      out.push({ key, used, limit: this.maxCalls });
    }
    return out;
  }
}
