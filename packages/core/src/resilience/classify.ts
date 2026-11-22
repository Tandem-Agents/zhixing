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
import { parseModelBudgetStop } from "./budget-stop.js";
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

  // 资源额度停止（含重试时被额度挡下的组合错误）：不是服务端错误，重试也不会变，交给界面如实说明
  if (error instanceof Error && parseModelBudgetStop(error.message)) return "invalid_request";

  // HTTP 状态码分类（沿 cause 链检查，兼容包装后的 AgentError / SDK Error）
  const status = getStatusCodeInChain(error);
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

// ─── 请求未发出 ───

/** 连接建立前就失败的错误码：拒绝连接、域名解析失败、主机或网络不可达，这一次连接没有送出任何字节。
 *  连接中断、超时等不在内：请求可能已经到达服务端。 */
const UNSENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** 错误链扫描上限；超过即视为原因无法辨清。 */
const CAUSE_CHAIN_LIMIT = 8;

/**
 * 一次 fetch 的拒绝是否只来自连接阶段：整条 cause 链在上限内扫完，没有任何 HTTP 状态，
 * 出现过连接阶段错误码，且 AggregateError（如 localhost 的多地址尝试）的每一条内层错误也都是连接阶段失败。
 * 它只说明这一次连接没送出字节；整次调用是否送达由传输层结合跳转与响应记录判断。
 */
export function isConnectPhaseFailure(error: unknown, depth = 0): boolean {
  let unsent = false;
  let current: unknown = error;
  for (; current && depth < CAUSE_CHAIN_LIMIT; depth++) {
    if (getStatusCode(current) !== undefined) return false;
    const code = getErrorCode(current);
    if (code && UNSENT_ERROR_CODES.has(code)) unsent = true;
    const inner = typeof current === "object" ? (current as { errors?: unknown }).errors : undefined;
    if (Array.isArray(inner) && inner.length) {
      if (!inner.every((item) => isConnectPhaseFailure(item, depth + 1))) return false;
      unsent = true;
    }
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return unsent && !current;
}

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

/** 传输层证明“整次调用都没送达”时打在错误上的标记；只有受控传输能打，错误码本身不构成证明。 */
const REQUEST_UNDELIVERED = Symbol.for("zhixing.provider.request-undelivered");
/** 适配器已收到 HTTP 响应并进入协议流、但流在协议终止事件前中断或存在未闭合项时打标；禁止自动重放已发请求。 */
const RESPONSE_STREAM_INTERRUPTED = Symbol.for("zhixing.provider.response-stream-interrupted");

export function markRequestUndelivered(error: unknown): void {
  if (error && typeof error === "object") Object.defineProperty(error, REQUEST_UNDELIVERED, { value: true });
}

export function markResponseStreamInterrupted<T>(error: T): T {
  if (error && typeof error === "object") {
    Object.defineProperty(error, RESPONSE_STREAM_INTERRUPTED, {
      value: true,
      configurable: true,
    });
  }
  return error;
}

export function isResponseStreamInterrupted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < CAUSE_CHAIN_LIMIT; depth++) {
    if (
      typeof current === "object" &&
      (current as Record<symbol, unknown>)[RESPONSE_STREAM_INTERRUPTED] === true
    ) {
      return true;
    }
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * 一次 provider 调用是否已证明整次都没送达：必须带传输层的未送达标记，且整条 cause 链在上限内扫完、没有任何 HTTP 状态。
 * 跟随跳转后才被拒、链上有中间响应、链过长无法辨清，一律不成立（按可能已送达保守处理）。
 */
export function providerRequestNeverSent(error: unknown): boolean {
  if (!error || typeof error !== "object" || (error as Record<symbol, unknown>)[REQUEST_UNDELIVERED] !== true) return false;
  let current: unknown = error;
  for (let depth = 0; current && depth < CAUSE_CHAIN_LIMIT; depth++) {
    if (getStatusCode(current) !== undefined) return false;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return !current;
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
  if (
    lower.includes("overloaded") ||
    lower.includes("capacity") ||
    lower.includes("529") ||
    lower.includes("protocol_state_limit_exceeded") ||
    lower.includes("协议私有思考状态超过有界上限") ||
    lower.includes("stream_incomplete") ||
    lower.includes("未收到协议终止事件")
  ) {
    return "provider_error";
  }

  return "unknown";
}

// ─── 统一脱敏、结构化细类与用户指引（四协议共用单一规则源） ───

export type ProviderErrorSubcode =
  | "auth_invalid_credentials"
  | "forbidden_region"
  | "forbidden_quota"
  | "forbidden_model_access"
  | "forbidden_policy"
  | "forbidden_generic"
  | "rate_limit"
  | "timeout"
  | "network"
  | "context_overflow"
  | "model_not_found"
  | "invalid_request"
  | "provider_error"
  | "aborted"
  | "unknown";

export interface ClassifiedProviderError {
  readonly type: AgentErrorType;
  readonly subcode: ProviderErrorSubcode;
  readonly status?: number;
  readonly sanitizedMessage: string;
  readonly userMessage: string;
}

const URL_USERINFO_RE = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/giu;
const AUTH_HEADER_VALUE_RE =
  /\b(authorization|x-api-key|x-goog-api-key|api-key)\s*[:=]\s*(?:bearer\s+)?([^\s,;'"`<>]+)/giu;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/giu;
const QUERY_SECRET_RE =
  /([?&](?:key|api_key|apikey|token|access_token|secret)=)([^&#\s]+)/giu;
const KNOWN_SECRET_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b/gu;

/**
 * 对模型适配器与传输错误做统一脱敏：剥离 URL 内嵌凭据、Bearer / API Key / 查询串令牌、认证头值，
 * 以及调用方显式传入的本次连接绑定秘密原值（含无厂商前缀的自定义密钥与 URL 编码形式）。
 */
export function sanitizeProviderErrorMessage(
  raw: string,
  redactSecrets?: readonly string[],
): string {
  let out = raw
    .replace(URL_USERINFO_RE, "$1[REDACTED]@")
    .replace(AUTH_HEADER_VALUE_RE, "$1: [REDACTED]")
    .replace(BEARER_TOKEN_RE, "Bearer [REDACTED]")
    .replace(QUERY_SECRET_RE, "$1[REDACTED]")
    .replace(KNOWN_SECRET_TOKEN_RE, "[REDACTED]");
  if (redactSecrets && redactSecrets.length > 0) {
    const candidates = new Set<string>();
    for (const secret of redactSecrets) {
      const trimmed = secret.trim();
      if (trimmed.length >= 4) {
        candidates.add(trimmed);
        const encoded = encodeURIComponent(trimmed);
        if (encoded !== trimmed && encoded.length >= 4) {
          candidates.add(encoded);
        }
      }
    }
    const ordered = [...candidates].sort((a, b) => b.length - a.length);
    for (const secret of ordered) {
      if (out.includes(secret)) {
        out = out.split(secret).join("[REDACTED]");
      }
    }
  }
  return out;
}

function extractStructuredErrorDetails(error: unknown): {
  readonly status?: number;
  readonly message: string;
  readonly rawSignals: string;
} {
  if (typeof error === "string") {
    const sanitized = sanitizeProviderErrorMessage(error);
    const statusMatch = sanitized.match(/\b(?:HTTP|status)\s*[:=]?\s*(4\d{2}|5\d{2})\b/iu)
      ?? sanitized.match(/^\s*(4\d{2}|5\d{2})\b/u);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    return { status, message: sanitized, rawSignals: sanitized.toLowerCase() };
  }

  let status = getStatusCode(error);
  const messageParts: string[] = [];
  const signalParts: string[] = [];

  for (
    let current: unknown = error, depth = 0;
    current && depth < 5;
    depth++
  ) {
    if (status === undefined) status = getStatusCode(current);
    if (current instanceof Error && current.message) {
      messageParts.push(sanitizeProviderErrorMessage(current.message));
    }
    if (typeof current === "object") {
      const rec = current as Record<string, unknown>;
      for (const field of ["code", "type", "errorStatus", "reason", "statusText"]) {
        const val = rec[field];
        if (typeof val === "string" && val.length > 0) {
          signalParts.push(val);
        }
      }
      const nested = rec["error"];
      if (nested && typeof nested === "object") {
        const nrec = nested as Record<string, unknown>;
        for (const field of ["code", "type", "status", "reason", "message"]) {
          const val = nrec[field];
          if (typeof val === "string" && val.length > 0) {
            signalParts.push(sanitizeProviderErrorMessage(val));
          }
        }
        const details = nrec["details"];
        if (Array.isArray(details)) {
          for (const d of details.slice(0, 4)) {
            if (d && typeof d === "object") {
              const dr = d as Record<string, unknown>;
              if (typeof dr.reason === "string") signalParts.push(dr.reason);
              if (typeof dr.message === "string") {
                signalParts.push(sanitizeProviderErrorMessage(dr.message));
              }
            }
          }
        }
      }
      current = rec["cause"];
    } else {
      break;
    }
  }

  const primaryMessage = messageParts[0] ?? sanitizeProviderErrorMessage(String(error ?? ""));
  if (status === undefined) {
    const m = primaryMessage.match(/\b(?:HTTP|status)\s*[:=]?\s*(4\d{2}|5\d{2})\b/iu)
      ?? primaryMessage.match(/^\s*(4\d{2}|5\d{2})\b/u);
    if (m) status = Number(m[1]);
  }
  const rawSignals = [...messageParts, ...signalParts].join(" ").toLowerCase();
  return { status, message: primaryMessage, rawSignals };
}

function classifyForbiddenSubcode(signals: string): {
  readonly subcode: ProviderErrorSubcode;
  readonly userMessage: string;
} {
  if (
    signals.includes("unsupported_country_region_territory") ||
    signals.includes("region") ||
    signals.includes("country") ||
    signals.includes("location is not supported") ||
    signals.includes("not available in your") ||
    signals.includes("geo") ||
    signals.includes("地区") ||
    signals.includes("区域")
  ) {
    return {
      subcode: "forbidden_region",
      userMessage:
        "当前网络地区或出口 IP 暂不支持访问该模型服务（403）：请在 /config 调整代理策略或改用其他可用连接。",
    };
  }
  if (
    signals.includes("quota") ||
    signals.includes("billing") ||
    signals.includes("insufficient_quota") ||
    signals.includes("credit") ||
    signals.includes("balance") ||
    signals.includes("spending limit") ||
    signals.includes("resource_exhausted") ||
    signals.includes("配额") ||
    signals.includes("余额")
  ) {
    return {
      subcode: "forbidden_quota",
      userMessage:
        "模型服务账户余额或配额受限（403）：请检查服务商账单与额度，或在 /config 切换其他连接。",
    };
  }
  if (
    signals.includes("model") ||
    signals.includes("does not have access") ||
    signals.includes("not allowed") ||
    signals.includes("tier") ||
    signals.includes("permission_denied") ||
    signals.includes("无权访问") ||
    signals.includes("未开通")
  ) {
    return {
      subcode: "forbidden_model_access",
      userMessage:
        "当前凭据无权访问所选模型或接口（403）：请在 /model 改选有权限的型号，或在服务商控制台开通对应权限。",
    };
  }
  if (
    signals.includes("policy") ||
    signals.includes("safety") ||
    signals.includes("moderation") ||
    signals.includes("waf") ||
    signals.includes("firewall") ||
    signals.includes("blocked") ||
    signals.includes("合规") ||
    signals.includes("安全策略")
  ) {
    return {
      subcode: "forbidden_policy",
      userMessage:
        "请求被服务商或网关安全策略拦截（403）：请检查请求内容、网关规则或代理设置后重试。",
    };
  }
  return {
    subcode: "forbidden_generic",
    userMessage:
      "模型服务拒绝了本次访问（403，不一定代表 API Key 错误）：请检查模型权限、账户配额、所在地区或 /config 中的代理设置。",
  };
}

/**
 * 面向四协议的统一结构化错误分类与脱敏用户指引（设计 §1.1 / §3.3 / 实施期注意项 #3）。
 * 终端与调用面直接消费本结果，不在 CLI 另堆厂商分支。
 */
export function classifyProviderErrorDetail(error: unknown): ClassifiedProviderError {
  const details = extractStructuredErrorDetails(error);
  const type =
    typeof error === "string"
      ? (details.status !== undefined
          ? classifyHttpStatus(details.status)
          : classifyByMessage(details.message))
      : classifyProviderError(error);
  const signals = details.rawSignals;

  if (type === "aborted") {
    return {
      type,
      subcode: "aborted",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage: "请求已取消。",
    };
  }

  if (details.status === 403 || (type === "auth" && signals.includes("forbidden"))) {
    const forbidden = classifyForbiddenSubcode(signals);
    return {
      type: "auth",
      subcode: forbidden.subcode,
      status: 403,
      sanitizedMessage: details.message,
      userMessage: forbidden.userMessage,
    };
  }

  if (details.status === 401 || type === "auth") {
    return {
      type: "auth",
      subcode: "auth_invalid_credentials",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage:
        "模型服务拒绝了凭据（401）：请在 /config 检查 API Key、认证头或接口地址。",
    };
  }

  if (type === "rate_limit") {
    return {
      type,
      subcode: "rate_limit",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage: "模型服务限流：请稍后重试。",
    };
  }

  if (type === "timeout") {
    return {
      type,
      subcode: "timeout",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage: "模型服务响应超时：请稍后重试；持续出现时检查网络或代理。",
    };
  }

  if (type === "network") {
    return {
      type,
      subcode: "network",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage: "无法连接模型服务：请检查网络、代理或服务地址后重试。",
    };
  }

  if (type === "context_overflow") {
    return {
      type,
      subcode: "context_overflow",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage:
        "上下文长度超过模型限制：请使用 /compact 整理上下文，或切换到更大窗口的模型。",
    };
  }

  if (details.status === 404 || signals.includes("model_not_found") || signals.includes("not_found")) {
    return {
      type: "invalid_request",
      subcode: "model_not_found",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage:
        "所选模型或接口路径不存在（404）：请在 /config 核对接口端点与受控协议，或在 /model 更换有效型号。",
    };
  }

  if (type === "invalid_request") {
    // 若已是本地预检产出的清晰中文说明（如图片不支持、未完工具往返思考签名冲突），直接透出脱敏文本
    const isAlreadyActionableZh =
      details.message.includes("当前模型不支持") ||
      details.message.includes("当前模型剩余上下文窗口") ||
      details.message.includes("手动思考预算（") ||
      details.message.includes("未完成的工具调用") ||
      details.message.includes("本次运行的模型用量");
    return {
      type,
      subcode: "invalid_request",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage: isAlreadyActionableZh
        ? details.message
        : `模型请求参数或协议不兼容（400）：${details.message}。请在 /model 或 /config 核对所选型号、协议与思考参数。`,
    };
  }

  if (type === "provider_error" || isResponseStreamInterrupted(error)) {
    const isProtocolStateOversized =
      signals.includes("protocol_state_limit_exceeded") ||
      signals.includes("协议私有思考状态超过有界上限");
    const isStreamTruncated =
      !isProtocolStateOversized &&
      (isResponseStreamInterrupted(error) ||
        signals.includes("stream_incomplete") ||
        signals.includes("未收到协议终止事件"));
    return {
      type: "provider_error",
      subcode: "provider_error",
      ...(details.status !== undefined ? { status: details.status } : {}),
      sanitizedMessage: details.message,
      userMessage: isProtocolStateOversized
        ? "模型返回的协议私有状态超过有界安全上限，已中止本轮并保留可见部分输出，未截断结构或自动重发。"
        : isStreamTruncated
          ? "模型响应流在完成前意外中断（未收到协议终止事件），已保留部分输出且未自动重发，请稍后重试。"
          : "模型服务暂时出错：请稍后重试。",
    };
  }

  return {
    type,
    subcode: "unknown",
    ...(details.status !== undefined ? { status: details.status } : {}),
    sanitizedMessage: details.message,
    userMessage: details.message,
  };
}

/** 将模型适配器/运行时错误或文本格式化为脱敏且可操作的中文用户说明。 */
export function formatProviderErrorForUser(errorOrMessage: unknown): string {
  return classifyProviderErrorDetail(errorOrMessage).userMessage;
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
  const rec = error as Record<string, unknown>;
  const statusLike = rec["status"] ?? rec["statusCode"];
  if (typeof statusLike === "number" && statusLike >= 100 && statusLike < 600) {
    return statusLike;
  }
  return undefined;
}

function getStatusCodeInChain(error: unknown): number | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = getStatusCode(current);
    if (code !== undefined) return code;
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
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
