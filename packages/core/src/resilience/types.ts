/**
 * 容错引擎类型定义
 *
 * 设计原则：
 * - 跨层复用：这些类型不只用于 LLM 重试——通道重连、消息重处理都复用
 * - 策略与原语分离：RetryConfig 描述"怎么重试"，RecoveryStrategy 描述"该不该重试"
 * - 与 AgentErrorType 对齐：分类结果直接映射到恢复策略
 */

import type { AgentErrorType } from "../types/errors.js";

// ─── 退避配置 ───

export interface BackoffConfig {
  /** 初始退避延迟（毫秒）。默认 500 */
  baseDelayMs: number;
  /** 最大退避延迟（毫秒）。默认 30_000 */
  maxDelayMs: number;
  /** 是否添加随机抖动，避免惊群效应。默认 true */
  jitter: boolean;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
};

// ─── 熔断器配置 ───

export interface CircuitBreakerConfig {
  /** 连续失败多少次后熔断（拒绝后续请求） */
  maxFailures: number;
  /** 熔断后多久自动重置为半开状态（毫秒），允许探测一次。不设置则永不自动重置 */
  resetAfterMs?: number;
}

/** 熔断器状态 */
export type CircuitBreakerState = "closed" | "open" | "half_open";

// ─── 重试配置 ───

export interface RetryConfig {
  /** 最大重试次数（不含首次调用）。默认 3 */
  maxRetries: number;
  /** 退避配置 */
  backoff: BackoffConfig;
  /** 可重试的错误类型列表。默认 ['rate_limit', 'timeout', 'network', 'provider_error'] */
  retryableTypes: AgentErrorType[];
  /** 外部中止信号 */
  abortSignal?: AbortSignal;
}

export const DEFAULT_RETRYABLE_TYPES: AgentErrorType[] = [
  "rate_limit",
  "timeout",
  "network",
  "provider_error",
  "unknown",
];

export const DEFAULT_RETRY_CONFIG: Omit<RetryConfig, "abortSignal"> = {
  maxRetries: 3,
  backoff: DEFAULT_BACKOFF,
  retryableTypes: DEFAULT_RETRYABLE_TYPES,
};

// ─── 恢复策略 ───

/**
 * 错误的恢复动作。
 * - retry：可以自动重试
 * - surface：不可重试，直接暴露给消费者
 * - abort：用户主动中止，立即停止
 */
export type RecoveryAction = "retry" | "surface" | "abort";

export interface RecoveryStrategy {
  action: RecoveryAction;
  maxRetries: number;
  useBackoff: boolean;
}
