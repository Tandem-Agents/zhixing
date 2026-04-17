/**
 * RpcConnection — 单条 WebSocket 连接的 RPC 抽象
 *
 * 职责：
 * - 管理一条连接的认证状态、生命周期
 * - 提供 send/notify 方法发送消息
 * - 不处理消息分发逻辑（由 dispatcher 处理）
 *
 * 设计要点：
 * - authenticated 是连接级状态（多连接互不影响）
 * - send/notify 在连接已关闭时静默丢弃（防止 race condition）
 * - 每个连接有唯一 id，便于日志和 sessions 绑定
 */

import type { WebSocket } from "ws";
import {
  encodeError,
  encodeNotification,
  encodeSuccess,
  type JsonRpcError,
} from "./protocol.js";

let nextConnectionId = 0;

export interface RpcConnection {
  /** 连接唯一 id（自增） */
  readonly id: number;
  /** 是否已通过 auth */
  authenticated: boolean;
  /** 客户端自报的元信息（auth 后填充） */
  clientInfo?: { id?: string; version?: string };
  /** 发送 RPC 成功响应 */
  sendSuccess(id: string | number | null, result: unknown): void;
  /** 发送 RPC 错误响应 */
  sendError(id: string | number | null, error: JsonRpcError): void;
  /** 发送服务端 → 客户端单向通知 */
  notify(method: string, params?: unknown): void;
  /** 主动关闭连接 */
  close(code?: number, reason?: string): void;
  /** 是否已关闭 */
  readonly closed: boolean;
}

export function createRpcConnection(socket: WebSocket): RpcConnection {
  const id = ++nextConnectionId;
  let closed = false;

  socket.on("close", () => {
    closed = true;
  });

  const safeSend = (text: string): void => {
    if (closed) return;
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(text);
    } catch {
      // 发送失败不向上抛——网络异常视为连接已断
    }
  };

  return {
    id,
    authenticated: false,
    sendSuccess(messageId, result) {
      safeSend(encodeSuccess(messageId, result));
    },
    sendError(messageId, error) {
      safeSend(encodeError(messageId, error));
    },
    notify(method, params) {
      safeSend(encodeNotification(method, params));
    },
    close(code, reason) {
      if (closed) return;
      try {
        socket.close(code, reason);
      } catch {
        // ignore
      }
    },
    get closed() {
      return closed;
    },
  };
}
