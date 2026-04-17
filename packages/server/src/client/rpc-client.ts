/**
 * RpcClient — 知行 Server 的官方 JSON-RPC 客户端
 *
 * 设计原则：
 * - Promise-based API（隐藏 id 跟踪、超时、错误转换）
 * - 与 server 共享协议层（同一个 protocol.ts），保证编解码一致
 * - 通知按方法名订阅（避免主程序被无关事件淹没）
 * - 连接生命周期可观察（onClose/closed 让调用方感知断线）
 *
 * 使用范式：
 *   const client = createRpcClient({ url: 'ws://127.0.0.1:18900/ws' });
 *   await client.connect();
 *   await client.authenticate(token);
 *   const result = await client.request('schedule.list');
 *   const off = client.onNotification('session.delta', (p) => console.log(p));
 *   await client.close();
 */

import { WebSocket } from "ws";
import {
  encodeRequest,
  parseMessage,
  isSuccessResponse,
  isErrorResponse,
} from "../rpc/protocol.js";

// ─── 公共类型 ───

export interface RpcClientOptions {
  /** WebSocket URL，例如 ws://127.0.0.1:18900/ws */
  url: string;
  /** 单条请求超时（毫秒）。默认 30_000 */
  timeout?: number;
  /** 连接握手超时（毫秒）。默认 5_000 */
  connectTimeout?: number;
}

export interface AuthResult {
  protocol: number;
  server: { version: string };
  capabilities: string[];
}

export class RpcClientError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcClientError";
  }
}

export class RpcClientClosedError extends Error {
  constructor(message = "RPC client is closed") {
    super(message);
    this.name = "RpcClientClosedError";
  }
}

export type NotificationHandler<T = unknown> = (params: T) => void;
export type WildcardNotificationHandler = (method: string, params: unknown) => void;
export type Unsubscribe = () => void;

export interface RpcClient {
  /** 建立 WebSocket 连接（不自动 auth） */
  connect(): Promise<void>;
  /** 发送 auth 方法，成功后服务端会标记此连接为 authenticated */
  authenticate(token: string, clientInfo?: { id?: string; version?: string }): Promise<AuthResult>;
  /** 发送 RPC 请求，返回 result（错误以 RpcClientError 抛出） */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** 订阅特定方法名的通知 */
  onNotification<T = unknown>(method: string, handler: NotificationHandler<T>): Unsubscribe;
  /** 订阅所有通知（用于调试/监听全局事件） */
  onAnyNotification(handler: WildcardNotificationHandler): Unsubscribe;
  /** 主动关闭连接 */
  close(): Promise<void>;
  /** 当前连接是否已关闭 */
  readonly closed: boolean;
}

// ─── 实现 ───

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  const timeout = opts.timeout ?? 30_000;
  const connectTimeout = opts.connectTimeout ?? 5_000;

  let ws: WebSocket | null = null;
  let nextId = 0;
  let closed = false;

  const pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const methodHandlers = new Map<string, Set<NotificationHandler>>();
  const wildcardHandlers = new Set<WildcardNotificationHandler>();

  function dispatchMessage(raw: string): void {
    const parsed = parseMessage(raw);

    if (parsed.kind === "error") {
      // server-side parse error response targeting null id —— 没有可路由的目标
      // 一般不会发生（server 只对 client 错误回应），先丢弃
      return;
    }

    if (parsed.kind === "response") {
      const id = parsed.message.id;
      if (id === null) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);

      if (isSuccessResponse(parsed.message)) {
        entry.resolve(parsed.message.result);
      } else if (isErrorResponse(parsed.message)) {
        const err = parsed.message.error;
        entry.reject(new RpcClientError(err.code, err.message, err.data));
      }
      return;
    }

    if (parsed.kind === "notification") {
      const { method, params } = parsed.message;
      const handlers = methodHandlers.get(method);
      if (handlers) {
        for (const h of [...handlers]) {
          try {
            h(params);
          } catch {
            // listener 错误隔离
          }
        }
      }
      for (const h of [...wildcardHandlers]) {
        try {
          h(method, params);
        } catch {
          // ignore
        }
      }
      return;
    }

    // request from server → client：当前协议不存在这种情况，忽略
  }

  function rejectAllPending(reason: unknown): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  return {
    get closed() {
      return closed;
    },

    async connect(): Promise<void> {
      if (closed) throw new RpcClientClosedError();
      if (ws !== null) throw new Error("RpcClient already connected");

      ws = new WebSocket(opts.url);

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          ws?.removeAllListeners();
          ws = null;
          reject(err);
        };
        const onOpen = () => {
          ws?.removeListener("error", onError);
          resolve();
        };
        const timer = setTimeout(() => {
          ws?.removeAllListeners();
          ws?.terminate();
          ws = null;
          reject(new Error(`Connect timeout after ${connectTimeout}ms`));
        }, connectTimeout);

        ws!.once("error", (err) => {
          clearTimeout(timer);
          onError(err);
        });
        ws!.once("open", () => {
          clearTimeout(timer);
          onOpen();
        });
      });

      // 进入正常工作状态：注册消息和关闭处理
      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf-8");
        dispatchMessage(text);
      });

      ws.on("close", () => {
        rejectAllPending(new RpcClientClosedError("Connection closed by server"));
        closed = true;
      });

      ws.on("error", () => {
        // 错误后通常会触发 close —— 让 close handler 处理 cleanup
      });
    },

    async authenticate(token, clientInfo): Promise<AuthResult> {
      return this.request<AuthResult>("auth", { token, client: clientInfo });
    },

    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (closed) return Promise.reject(new RpcClientClosedError());
      if (!ws || ws.readyState !== ws.OPEN) {
        return Promise.reject(new RpcClientClosedError("Not connected"));
      }

      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC request timeout after ${timeout}ms: ${method}`));
        }, timeout);

        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });

        try {
          ws!.send(encodeRequest(id, method, params));
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    },

    onNotification<T = unknown>(method: string, handler: NotificationHandler<T>): Unsubscribe {
      let handlers = methodHandlers.get(method);
      if (!handlers) {
        handlers = new Set();
        methodHandlers.set(method, handlers);
      }
      handlers.add(handler as NotificationHandler);
      return () => {
        handlers!.delete(handler as NotificationHandler);
        if (handlers!.size === 0) methodHandlers.delete(method);
      };
    },

    onAnyNotification(handler): Unsubscribe {
      wildcardHandlers.add(handler);
      return () => {
        wildcardHandlers.delete(handler);
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      rejectAllPending(new RpcClientClosedError("Client closed"));
      if (ws) {
        const w = ws;
        ws = null;
        if (w.readyState === w.OPEN || w.readyState === w.CONNECTING) {
          await new Promise<void>((resolve) => {
            w.once("close", () => resolve());
            w.close();
          });
        }
      }
    },
  };
}
