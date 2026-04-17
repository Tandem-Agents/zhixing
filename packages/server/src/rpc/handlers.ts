/**
 * RPC 方法分发器
 *
 * 职责：
 * - 注册和查找 RPC 方法处理器
 * - 检查认证：除 `auth` 和 `health` 外，所有方法要求 connection.authenticated === true
 * - 包装错误：处理器抛出异常 → 自动转为 INTERNAL_ERROR / 自定义 RPC 错误
 *
 * 设计要点：
 * - HandlerContext 包含连接 + 服务上下文，处理器可以 notify 推送事件
 * - RpcAppError 让处理器声明语义化错误码（如 NOT_FOUND）而不必抛 string
 * - dispatcher 自身无状态，可重用于多个连接
 */

import type { RpcConnection } from "./connection.js";
import type { ServerContext } from "../context.js";
import { RPC_ERROR_CODES, type JsonRpcError } from "./protocol.js";

export interface HandlerContext {
  /** 当前连接 */
  connection: RpcConnection;
  /** 服务上下文 */
  server: ServerContext;
}

export type RpcHandler = (
  params: unknown,
  ctx: HandlerContext,
) => Promise<unknown> | unknown;

export interface MethodEntry {
  /** 方法名（如 "auth"、"session.send"） */
  name: string;
  /** 是否需要认证（默认 true） */
  requiresAuth?: boolean;
  /** 处理器实现 */
  handler: RpcHandler;
}

/**
 * 应用层 RPC 错误。处理器抛出此错误会被转为对应的 JSON-RPC 错误响应。
 */
export class RpcAppError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcAppError";
  }
}

/** 便捷构造函数 */
export const RpcErrors = {
  unauthorized(message = "Unauthorized") {
    return new RpcAppError(RPC_ERROR_CODES.UNAUTHORIZED, message);
  },
  notFound(message: string) {
    return new RpcAppError(RPC_ERROR_CODES.NOT_FOUND, message);
  },
  invalidParams(message: string) {
    return new RpcAppError(RPC_ERROR_CODES.INVALID_PARAMS, message);
  },
};

export class HandlerRegistry {
  private readonly entries = new Map<string, MethodEntry>();

  register(entry: MethodEntry): void {
    this.entries.set(entry.name, entry);
  }

  registerAll(entries: MethodEntry[]): void {
    for (const e of entries) this.register(e);
  }

  get(name: string): MethodEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * 分发一次 RPC 请求，返回结果或抛出 RpcAppError。
   * 路由层根据返回/异常生成响应消息。
   */
  async dispatch(
    method: string,
    params: unknown,
    ctx: HandlerContext,
  ): Promise<unknown> {
    const entry = this.entries.get(method);
    if (!entry) {
      throw new RpcAppError(
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
    }

    const requiresAuth = entry.requiresAuth ?? true;
    if (requiresAuth && !ctx.connection.authenticated) {
      throw RpcErrors.unauthorized(`Method requires authentication: ${method}`);
    }

    return await entry.handler(params, ctx);
  }
}

/**
 * 把任意异常转为 JsonRpcError。
 * - RpcAppError → 直接使用其 code/message
 * - 其他异常 → INTERNAL_ERROR（隐藏内部细节，仅在 data 中保留 message 用于调试）
 */
export function toJsonRpcError(err: unknown): JsonRpcError {
  if (err instanceof RpcAppError) {
    return { code: err.code, message: err.message, data: err.data };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: RPC_ERROR_CODES.INTERNAL_ERROR,
    message: "Internal error",
    data: { message },
  };
}
