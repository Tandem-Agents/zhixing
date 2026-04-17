/**
 * JSON-RPC 2.0 协议编解码
 *
 * 规范：https://www.jsonrpc.org/specification
 *
 * 设计要点：
 * - 严格遵守 JSON-RPC 2.0：jsonrpc 必须是 "2.0"，不接受其他版本
 * - 三种消息类型：Request（带 id）、Notification（无 id）、Response（含 result 或 error）
 * - 标准错误码：-32700 解析错误、-32600 无效请求、-32601 方法不存在、-32602 参数无效、-32603 内部错误
 * - 应用错误码：-32000 ~ -32099（保留给实现）
 * - 不支持批处理（batch）：MVP 不需要，按需补充
 */

// ─── 消息类型 ───

/** RPC 请求：客户端 → 服务端，期望响应 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: TParams;
}

/** RPC 通知：单向消息（客户端 → 服务端 或 服务端 → 客户端），不期望响应 */
export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

/** RPC 成功响应 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: TResult;
}

/** RPC 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

export type JsonRpcMessage<TParams = unknown, TResult = unknown> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>
  | JsonRpcResponse<TResult>;

// ─── 错误 ───

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 标准错误码（spec 定义） */
export const RPC_ERROR_CODES = {
  /** Invalid JSON */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s) */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error */
  INTERNAL_ERROR: -32603,
  /** 应用层错误起始（-32000 ~ -32099 保留给实现） */
  APP_ERROR_BASE: -32000,
  /** 认证失败 */
  UNAUTHORIZED: -32001,
  /** 资源未找到（如 sessionId 不存在） */
  NOT_FOUND: -32002,
} as const;

// ─── 类型守卫 ───

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    isObject(msg) &&
    msg.jsonrpc === "2.0" &&
    typeof msg.method === "string" &&
    "id" in msg &&
    (typeof msg.id === "string" || typeof msg.id === "number")
  );
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    isObject(msg) &&
    msg.jsonrpc === "2.0" &&
    typeof msg.method === "string" &&
    !("id" in msg)
  );
}

export function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    isObject(msg) &&
    msg.jsonrpc === "2.0" &&
    "id" in msg &&
    ("result" in msg || "error" in msg)
  );
}

export function isSuccessResponse(
  msg: JsonRpcResponse,
): msg is JsonRpcSuccessResponse {
  return "result" in msg;
}

export function isErrorResponse(
  msg: JsonRpcResponse,
): msg is JsonRpcErrorResponse {
  return "error" in msg;
}

// ─── 编解码 ───

export type ParseResult =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response"; message: JsonRpcResponse }
  | { kind: "error"; error: JsonRpcError; id: string | number | null };

/**
 * 解析 JSON-RPC 消息。
 * 失败时返回 error kind，包含可发送的错误响应数据。
 *
 * id 提取规则：
 * - 解析成功：使用消息中的 id
 * - 解析失败但能取到 id：使用提取到的 id
 * - 完全无法解析：id = null（spec 要求）
 */
export function parseMessage(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      kind: "error",
      error: { code: RPC_ERROR_CODES.PARSE_ERROR, message: "Parse error" },
      id: null,
    };
  }

  if (!isObject(raw) || raw.jsonrpc !== "2.0") {
    return {
      kind: "error",
      error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid Request" },
      id: extractId(raw),
    };
  }

  if (isResponse(raw)) {
    return { kind: "response", message: raw };
  }

  if (isRequest(raw)) {
    return { kind: "request", message: raw };
  }

  if (isNotification(raw)) {
    return { kind: "notification", message: raw };
  }

  return {
    kind: "error",
    error: { code: RPC_ERROR_CODES.INVALID_REQUEST, message: "Invalid Request" },
    id: extractId(raw),
  };
}

/** 编码请求 */
export function encodeRequest(
  id: string | number,
  method: string,
  params?: unknown,
): string {
  const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg);
}

/** 编码通知 */
export function encodeNotification(method: string, params?: unknown): string {
  const msg: JsonRpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg);
}

/** 编码成功响应。result === undefined 会被规范化为 null —— spec 要求 result 字段必须存在 */
export function encodeSuccess(id: string | number | null, result: unknown): string {
  const msg: JsonRpcSuccessResponse = {
    jsonrpc: "2.0",
    id,
    result: result === undefined ? null : result,
  };
  return JSON.stringify(msg);
}

/** 编码错误响应 */
export function encodeError(
  id: string | number | null,
  error: JsonRpcError,
): string {
  const msg: JsonRpcErrorResponse = { jsonrpc: "2.0", id, error };
  return JSON.stringify(msg);
}

// ─── 工具 ───

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractId(raw: unknown): string | number | null {
  if (!isObject(raw)) return null;
  const id = raw.id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}
