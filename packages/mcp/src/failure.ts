export type McpFailureStage =
  | "spawn"
  | "connect"
  | "list-tools"
  | "call-tool"
  | "disconnected";

export type McpFailureReason =
  | "command-not-found"
  | "spawn-error"
  | "timeout"
  | "connection-refused"
  | "http-auth"
  | "http-status"
  | "protocol-error"
  | "tool-error-result"
  | "network-blocked"
  | "closed"
  | "unknown";

export interface McpPublicFailure {
  readonly stage: McpFailureStage;
  readonly reason: McpFailureReason;
  readonly statusCode?: number;
  readonly contentBlocks?: number;
  readonly contentBytes?: number;
}

export class McpStdioSpawnError extends Error {
  readonly stage = "spawn" as const;
  readonly reason: "command-not-found" | "spawn-error";

  constructor(code: string | undefined) {
    const reason = code === "ENOENT" ? "command-not-found" : "spawn-error";
    super(`MCP stdio ${reason}`);
    this.name = "McpStdioSpawnError";
    this.reason = reason;
  }
}

export class McpStageError extends Error {
  constructor(
    readonly stage: McpFailureStage,
    readonly causeError: unknown,
  ) {
    const classified = classifyMcpPublicFailure(stage, causeError);
    super(formatMcpShortError(classified));
    this.name = "McpStageError";
  }
}

export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string" && candidate.code.length > 0) {
    return candidate.code;
  }
  if (candidate.cause && candidate.cause !== err) {
    return extractErrorCode(candidate.cause);
  }
  return undefined;
}

function extractHttpStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    cause?: unknown;
    message?: unknown;
  };
  for (const field of [candidate.statusCode, candidate.status]) {
    if (typeof field === "number" && Number.isInteger(field) && field >= 100 && field <= 599) {
      return field;
    }
  }
  if (typeof candidate.code === "number" && candidate.code >= 400 && candidate.code <= 599) {
    return candidate.code;
  }
  if (typeof candidate.message === "string") {
    const m = /\bHTTP\s+([45]\d{2})\b/i.exec(candidate.message) ??
      /\bstatus(?:\s+code)?\s*[:=]?\s*([45]\d{2})\b/i.exec(candidate.message);
    if (m) return Number(m[1]);
  }
  if (candidate.cause && candidate.cause !== err) {
    return extractHttpStatusCode(candidate.cause);
  }
  return undefined;
}

function collectLowerErrorTags(err: unknown, depth = 0): string {
  if (depth > 3 || err == null) return "";
  if (typeof err === "string") return err.toLowerCase();
  if (typeof err !== "object") return "";
  const obj = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  const parts: string[] = [];
  if (typeof obj.name === "string") parts.push(obj.name.toLowerCase());
  if (typeof obj.code === "string") parts.push(obj.code.toLowerCase());
  if (typeof obj.message === "string") parts.push(obj.message.toLowerCase());
  if (obj.cause && obj.cause !== err) {
    parts.push(collectLowerErrorTags(obj.cause, depth + 1));
  }
  return parts.join(" ");
}

/**
 * 纯函数故障分类器 —— 仅提取结构化 stage/reason/statusCode，
 * 严禁把原始 err.message / URL query / args / env 拼入返回值。
 */
export function classifyMcpPublicFailure(
  defaultStage: McpFailureStage,
  err: unknown,
): McpPublicFailure {
  if (err instanceof McpStdioSpawnError) {
    return { stage: "spawn", reason: err.reason };
  }
  if (err instanceof McpStageError) {
    return classifyMcpPublicFailure(err.stage, err.causeError);
  }

  const code = extractErrorCode(err);
  const statusCode = extractHttpStatusCode(err);
  const tags = collectLowerErrorTags(err);

  if (defaultStage === "spawn") {
    if (code === "ENOENT" || tags.includes("enoent") || tags.includes("command not found")) {
      return { stage: "spawn", reason: "command-not-found" };
    }
    return { stage: "spawn", reason: "spawn-error" };
  }

  if (code === "ENOENT") {
    return { stage: "spawn", reason: "command-not-found" };
  }
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    tags.includes("timed out") ||
    tags.includes("timeout")
  ) {
    return { stage: defaultStage, reason: "timeout" };
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    tags.includes("econnrefused") ||
    tags.includes("connection refused")
  ) {
    return { stage: defaultStage, reason: "connection-refused" };
  }
  if (
    code === "SSRF_BLOCKED" ||
    code === "ERR_NETWORK_BLOCKED" ||
    tags.includes("ssrf") ||
    tags.includes("private ip") ||
    tags.includes("network blocked")
  ) {
    return { stage: defaultStage, reason: "network-blocked" };
  }
  if (statusCode === 401 || statusCode === 403 || tags.includes("unauthorized")) {
    return {
      stage: defaultStage,
      reason: "http-auth",
      ...(statusCode !== undefined ? { statusCode } : {}),
    };
  }
  if (statusCode !== undefined && statusCode >= 400) {
    return {
      stage: defaultStage,
      reason: "http-status",
      statusCode,
    };
  }
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    tags.includes("connection closed") ||
    tags.includes("transport is closed") ||
    tags.includes("eof")
  ) {
    return { stage: defaultStage, reason: "closed" };
  }
  if (
    tags.includes("json-rpc") ||
    tags.includes("jsonrpc") ||
    tags.includes("invalid params") ||
    tags.includes("method not found") ||
    tags.includes("tools/list") ||
    tags.includes("protocol") ||
    tags.includes("mcp error")
  ) {
    return { stage: defaultStage, reason: "protocol-error" };
  }
  return { stage: defaultStage, reason: "unknown" };
}

/** 生成不含原始文本、URL 或凭据的短分类码（兼容 legacy `server.error` 字段）。 */
export function formatMcpShortError(failure: McpPublicFailure): string {
  const base = `${failure.stage}:${failure.reason}`;
  const withStatus = failure.statusCode !== undefined ? `${base}(${failure.statusCode})` : base;
  return failure.reason === "network-blocked" ? `${withStatus} (SSRF blocked)` : withStatus;
}

/** 面向模型与调用方展示的无秘密公共失败摘要。 */
export function formatMcpPublicFailure(
  serverId: string,
  toolName: string | undefined,
  failure: McpPublicFailure,
): string {
  const payload = {
    serverId,
    ...(toolName !== undefined ? { toolName } : {}),
    stage: failure.stage,
    reason: failure.reason,
    ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
    ...(failure.contentBlocks !== undefined ? { contentBlocks: failure.contentBlocks } : {}),
    ...(failure.contentBytes !== undefined ? { contentBytes: failure.contentBytes } : {}),
  };
  return `MCP failure ${JSON.stringify(payload)}`;
}
