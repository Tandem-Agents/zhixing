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

  // Node.js 网络错误码：SDK 常把底层错误包进 cause 链（如 OpenAI 兼容 SDK 的 APIConnectionError
  // 消息只是 "Connection error."，ECONNREFUSED 在 cause.cause 里），沿链有界查找
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = getErrorCode(current);
    if (code && NETWORK_ERROR_CODES.has(code)) return "network";
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
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

/** 错误链扫描上限；超过即视为原因无法辨清。 */
const CAUSE_CHAIN_LIMIT = 8;

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,40}$/u;
const SAFE_SYSCALL = /^[a-z][a-z0-9_]{0,20}$/u;
const CAUSE_SUMMARY_NODES = 16;
/** 摘要长度上界；事件流协议按同一上界校验。 */
export const CAUSE_SUMMARY_CHARS = 512;

/**
 * 沿 cause 链（含 AggregateError 的内层）的首因摘要，供日志与事件记下真实原因而不只外层一句。只用安全字段：
 * 错误类名、错误码、系统调用名与 HTTP 状态；不带任何消息、请求或响应文本、地址、路径与查询。访问节点总数有界，
 * 环与重复节点只走一次，读取字段出错只少记、不替换业务错误。各层都没有错误码与状态时没有摘要。
 */
export function errorCauseSummary(error: unknown): string | undefined {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let budget = CAUSE_SUMMARY_NODES;
  const read = (value: object, key: string): unknown => {
    try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
  };
  const visit = (value: unknown, depth: number): void => {
    let current = value;
    for (; current && typeof current === "object" && depth < CAUSE_CHAIN_LIMIT && budget > 0 && !seen.has(current); depth++) {
      seen.add(current); budget--;
      const name = read(current, "name"), code = read(current, "code"), syscall = read(current, "syscall");
      const status = read(current, "status") ?? read(current, "statusCode");
      parts.push([
        typeof name === "string" && SAFE_ERROR_NAME.test(name) ? name : "Error",
        typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined,
        typeof syscall === "string" && SAFE_SYSCALL.test(syscall) ? syscall : undefined,
        typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : undefined,
      ].filter(Boolean).join(" "));
      const inner = read(current, "errors");
      if (Array.isArray(inner)) for (const item of inner.slice(0, 4)) visit(item, depth + 1);
      current = read(current, "cause");
    }
  };
  try { visit(error, 0); } catch { /* 摘要只是附加证据，失败时不记 */ }
  if (parts.length < 2 || !parts.some((part) => part.includes(" "))) return undefined;
  // 相邻的相同层合并计数（如 localhost 两个地址各一次拒绝连接）
  const merged: string[] = [];
  for (const part of parts) {
    const last = merged.at(-1), match = last?.match(/^(.*?)(?: ×(\d+))?$/u);
    if (match && match[1] === part) merged[merged.length - 1] = `${part} ×${Number(match[2] ?? 1) + 1}`;
    else merged.push(part);
  }
  const summary = merged.join(" ← ");
  return summary.length <= CAUSE_SUMMARY_CHARS ? summary : `${summary.slice(0, CAUSE_SUMMARY_CHARS - 1)}…`;
}

// ─── 消息启发式分类 ───

function classifyByMessage(message: string): AgentErrorType {
  const lower = message.toLowerCase();

  // abort 启发式: SDK 在 controller.abort 时可能抛非标准 AbortError (如 fetch 内部
  // "Request aborted" 或自定义 wrapper "ABORT: ..."), 通过 message 兜底识别。
  // retryableStream 的 abort fast-path 是协议层主防线, 此处分类是辅助稳健性。
  if (lower.includes("abort")) {
    return "aborted";
  }

  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate_limit";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return "timeout";
  }
  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("connection error") ||
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
