/**
 * RpcDispatcher — WebSocket 消息 → handler 分发的胶水层
 *
 * 职责：
 * - 收到 WebSocket text frame → parseMessage
 * - 根据消息类型路由：
 *   - request → registry.dispatch → sendSuccess / sendError
 *   - notification → registry.dispatch（结果丢弃，错误仅 log）
 *   - response → 当前不期望（客户端 → 服务端只有请求/通知）
 *   - parse error → sendError(id, error)
 * - 异常隔离：单条消息处理失败不应让连接挂掉
 */

import type { ServerContext } from "../context.js";
import type { RpcConnection } from "./connection.js";
import { HandlerRegistry, toJsonRpcError } from "./handlers.js";
import { parseMessage } from "./protocol.js";

export interface DispatcherDeps {
  registry: HandlerRegistry;
  server: ServerContext;
  /** 错误日志钩子（可选） */
  onError?: (err: unknown, context: { method?: string; messageId?: string | number | null }) => void;
}

export class RpcDispatcher {
  private readonly deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  /**
   * 处理一条 WebSocket text frame。
   * 永远不抛出——所有错误都通过响应消息或 onError 回调上报。
   */
  async handleMessage(connection: RpcConnection, raw: string | Buffer): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString("utf-8");
    const parsed = parseMessage(text);

    if (parsed.kind === "error") {
      connection.sendError(parsed.id, parsed.error);
      return;
    }

    if (parsed.kind === "response") {
      // 客户端不应该向服务端发响应消息
      // 日志即可，不主动断连
      this.deps.onError?.(new Error("Unexpected response message from client"), {});
      return;
    }

    if (parsed.kind === "request") {
      const { id, method, params } = parsed.message;
      try {
        const result = await this.deps.registry.dispatch(method, params, {
          connection,
          server: this.deps.server,
        });
        connection.sendSuccess(id, result);
      } catch (err) {
        const rpcError = toJsonRpcError(err);
        connection.sendError(id, rpcError);
        // INTERNAL_ERROR 通常是 bug——记到 onError 便于调试
        if (rpcError.code === -32603) {
          this.deps.onError?.(err, { method, messageId: id });
        }
      }
      return;
    }

    // notification
    if (parsed.kind === "notification") {
      const { method, params } = parsed.message;
      try {
        await this.deps.registry.dispatch(method, params, {
          connection,
          server: this.deps.server,
        });
      } catch (err) {
        // notification 没有 id，无法响应错误——仅 log
        this.deps.onError?.(err, { method });
      }
    }
  }
}
