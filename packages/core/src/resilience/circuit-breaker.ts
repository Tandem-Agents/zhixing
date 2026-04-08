/**
 * 通用熔断器（Circuit Breaker）
 *
 * 三态模型：
 * - closed（关闭）：正常通行，计数连续失败
 * - open（打开）：拒绝所有请求，直到 resetAfterMs 后转为 half_open
 * - half_open（半开）：允许一次探测请求，成功则关闭，失败则重新打开
 *
 * 跨层复用：LLM 重试、通道重连、消息重处理都用同一个 CircuitBreaker。
 * 这是 OpenClaw/Claude Code 都没有的通用原语——它们在各处硬编码重试上限。
 */

import type { CircuitBreakerConfig, CircuitBreakerState } from "./types.js";

export class CircuitBreaker {
  private _state: CircuitBreakerState = "closed";
  private _failureCount = 0;
  private _lastFailureTime = 0;

  constructor(private readonly config: CircuitBreakerConfig) {
    if (config.maxFailures < 1) {
      throw new RangeError("maxFailures must be at least 1");
    }
  }

  get state(): CircuitBreakerState {
    // 如果在 open 状态且超过重置时间，自动转为 half_open
    if (this._state === "open" && this.config.resetAfterMs !== undefined) {
      const elapsed = Date.now() - this._lastFailureTime;
      if (elapsed >= this.config.resetAfterMs) {
        this._state = "half_open";
      }
    }
    return this._state;
  }

  get failureCount(): number {
    return this._failureCount;
  }

  /** 当前是否允许通行 */
  get isAllowed(): boolean {
    const currentState = this.state;
    return currentState === "closed" || currentState === "half_open";
  }

  /** 记录一次成功，重置熔断器 */
  recordSuccess(): void {
    this._failureCount = 0;
    this._state = "closed";
  }

  /** 记录一次失败 */
  recordFailure(): void {
    this._failureCount++;
    this._lastFailureTime = Date.now();

    if (this._state === "half_open") {
      // 半开状态下失败，立即回到 open
      this._state = "open";
      return;
    }

    if (this._failureCount >= this.config.maxFailures) {
      this._state = "open";
    }
  }

  /** 手动重置为关闭状态 */
  reset(): void {
    this._state = "closed";
    this._failureCount = 0;
    this._lastFailureTime = 0;
  }
}
