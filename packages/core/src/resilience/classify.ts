/**
 * Provider 错误分类器
 *
 * 将 LLM Provider 抛出的原始错误映射到 AgentErrorType。
 * 分类结果直接决定恢复策略（重试 / 暴露 / 中止）。
 *
 * 覆盖 Claude Code 的盲区：
 * - 连接错误（ECONNRESET 等）归类为 "network"，会被重试
 * - Claude Code 不重试连接错误，这是其 #1 用户报告问题
 *
 * 不依赖具体 SDK 类型（通过鸭子类型判断），
 * 使 core 包不需要 peer-depend Anthropic/OpenAI SDK。
 */

import type { AgentErrorType } from "../types/errors.js";
import type { RecoveryStrategy } from "./types.js";

// ─── 错误分类 ───

/**
 * 将 Provider 抛出的错误分类为 AgentErrorType。
 *
 * 处理优先级：
 * 1. AbortError → "aborted"
 * 2. HTTP 状态码（来自 SDK 的 APIError）
 * 3. Node.js 网络错误码（ECONNRESET 等）
 * 4. 消息内容启发式匹配
 * 5. 兜底 → "unknown"
 */
export function classifyProviderError(error: unknown): AgentErrorType {
  if (!error) return "unknown";

  // AbortError：用户主动取消
  if (isAbortError(error)) return "aborted";

  // HTTP 状态码分类
  const status = getStatusCode(error);
  if (status !== undefined) {
    return classifyHttpStatus(status);
  }

  // Node.js 网络错误码
  const code = getErrorCode(error);
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return "network";
  }

  // 消息启发式
  if (error instanceof Error) {
    return classifyByMessage(error.message);
  }

  return "unknown";
}

// ─── 恢复策略映射 ───

const RECOVERY_MAP: Record<AgentErrorType, RecoveryStrategy> = {
  rate_limit: { action: "retry", maxRetries: 5, useBackoff: true },
  timeout: { action: "retry", maxRetries: 3, useBackoff: true },
  network: { action: "retry", maxRetries: 5, useBackoff: true },
  provider_error: { action: "retry", maxRetries: 2, useBackoff: true },
  unknown: { action: "retry", maxRetries: 1, useBackoff: true },
  context_overflow: { action: "surface", maxRetries: 0, useBackoff: false },
  auth: { action: "surface", maxRetries: 0, useBackoff: false },
  invalid_request: { action: "surface", maxRetries: 0, useBackoff: false },
  tool_error: { action: "surface", maxRetries: 0, useBackoff: false },
  aborted: { action: "abort", maxRetries: 0, useBackoff: false },
};

/**
 * 根据错误类型获取恢复策略。
 */
export function getRecoveryStrategy(errorType: AgentErrorType): RecoveryStrategy {
  return RECOVERY_MAP[errorType];
}

// ─── HTTP 状态码分类 ───

function classifyHttpStatus(status: number): AgentErrorType {
  switch (status) {
    case 401:
    case 403:
      return "auth";
    case 429:
      return "rate_limit";
    case 408:
      return "timeout";
    case 413:
      return "context_overflow";
    case 400:
      return "invalid_request";
    case 500:
    case 502:
    case 503:
    case 529:
      return "provider_error";
    default:
      if (status >= 400 && status < 500) return "invalid_request";
      if (status >= 500) return "provider_error";
      return "unknown";
  }
}

// ─── 网络错误码 ───

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "FETCH_ERROR",
]);

// ─── 消息启发式分类 ───

function classifyByMessage(message: string): AgentErrorType {
  const lower = message.toLowerCase();

  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate_limit";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return "timeout";
  }
  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("dns")
  ) {
    return "network";
  }
  if (lower.includes("context") && (lower.includes("overflow") || lower.includes("too long"))) {
    return "context_overflow";
  }
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("api key")) {
    return "auth";
  }
  if (lower.includes("overloaded") || lower.includes("capacity") || lower.includes("529")) {
    return "provider_error";
  }

  return "unknown";
}

// ─── 辅助函数 ───

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/**
 * 从 SDK APIError 鸭子类型中提取 HTTP 状态码。
 * Anthropic SDK: error.status
 * OpenAI SDK: error.status
 */
function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusLike = (error as Record<string, unknown>)["status"];
  if (typeof statusLike === "number" && statusLike >= 100 && statusLike < 600) {
    return statusLike;
  }
  return undefined;
}

/**
 * 从 Node.js 错误中提取 error.code。
 */
function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}
