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
import { RpcMessagePump } from "./rpc-message-pump.js";
import { RpcRequestSender } from "./rpc-request-sender.js";
import type { RpcEncodedJsonSource, RpcRequestDeadline } from "./rpc-encoded-source.js";
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
  /** Surface-owned correlation admission; released after response consumption
   * and actual send retirement, including after caller cancellation. */
  acquireRequest?: () => () => void;
  maximumPendingRequests?: number;
  maximumQueuedRequestBytes?: number;
}

export interface AuthResult {
  protocol: number;
  protocolRange?: { min: number; max: number };
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
  /** 消费完成前保留接收背压，用于异步分页写入；不重发或重置请求超时。 */
  consume?<T, R>(method: string, params: unknown, consumer: (result: T) => R | Promise<R>): Promise<R>;
  /** Prepare one immutable JSON value at an idle receive-message boundary.
   * The returned deadline includes waiting and preparation, not just sending. */
  prepareRequestSource?<T extends RpcEncodedJsonSource | undefined>(prepare: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<{ source: T; deadline: number }>;
  maximumRequestSourceBytes?(method: string): number;
  requestEncoded?<T = unknown>(method: string, params: RpcEncodedJsonSource, options?: Partial<RpcRequestDeadline>): Promise<T>;
  consumeEncoded?<T, R>(method: string, params: RpcEncodedJsonSource, consumer: (result: T) => R | Promise<R>, options?: Partial<RpcRequestDeadline>): Promise<R>;
  /** Actual consumer/preparation/source-read exit, independent of close ACK. */
  drain?(): Promise<void>;
  /** Latest original deadline of work admitted by this client; never renewed
   * by close/drain. A connection owner may fail its wait without opening a new
   * generation while drain() is still unsettled. */
  readonly drainDeadline?: number;
  /** 订阅特定方法名的通知 */
  onNotification<T = unknown>(method: string, handler: NotificationHandler<T>): Unsubscribe;
  /** 订阅所有通知（用于调试/监听全局事件） */
  onAnyNotification(handler: WildcardNotificationHandler): Unsubscribe;
  /** 主动关闭连接 */
  close(): Promise<void>;
  /** 当前连接是否已关闭 */
  readonly closed: boolean;
  /** 被动观察连接关闭；不建立连接。 */
  onClose?(handler: () => void): Unsubscribe;
  /** 逻辑 client 保持可用，但已认证接入代次更换；旧代投影随之失效。 */
  onTurnover?(handler: () => void): Unsubscribe;
}

// ─── 实现 ───

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  const timeout = opts.timeout ?? 30_000;
  const connectTimeout = opts.connectTimeout ?? 5_000;

  let ws: WebSocket | null = null;
  let pump: RpcMessagePump | undefined;
  let sender: RpcRequestSender | undefined;
  let nextId = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let drainDeadline = 0;
  const closeHandlers = new Set<() => void>();
  const notifyClosed = () => {
    if (closed) return;
    closed = true;
    pump?.close();
    sender?.close(new RpcClientClosedError());
    for (const handler of [...closeHandlers]) {
      try { handler(); } catch { /* 与 notification listener 一样隔离订阅者。 */ }
    }
    closeHandlers.clear();
  };

  const pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout>;
      consume?: (value: unknown) => unknown | Promise<unknown>; retire(): void }
  >();
  const liveRequests = new Set<NonNullable<ReturnType<typeof pending.get>>>();
  const consuming = new Set<NonNullable<ReturnType<typeof pending.get>>>();
  const methodHandlers = new Map<string, Set<NotificationHandler>>();
  const wildcardHandlers = new Set<WildcardNotificationHandler>();

  function dispatchMessage(raw: string): void | Promise<void> {
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
      if (!entry.consume || !isSuccessResponse(parsed.message)) clearTimeout(entry.timer);

      if (isSuccessResponse(parsed.message)) {
        if (entry.consume) return consumeResponse(parsed.message.result, entry);
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

  // Keep the raw JSON dispatch frame out of an asynchronous consumer's closure.
  function consumeResponse(result: unknown, entry: NonNullable<ReturnType<typeof pending.get>>): Promise<void> {
    consuming.add(entry);
    return Promise.resolve().then(() => {
      if (closed) throw new RpcClientClosedError();
      return entry.consume!(result);
    }).then(entry.resolve, entry.reject).finally(() => {
      clearTimeout(entry.timer);
      consuming.delete(entry);
      entry.retire();
    });
  }

  function request<T>(method: string, params?: unknown, consume?: (value: unknown) => unknown | Promise<unknown>,
    encoded?: { source: RpcEncodedJsonSource; options?: Partial<RpcRequestDeadline> }): Promise<T> {
    if (closed) return Promise.reject(new RpcClientClosedError());
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new RpcClientClosedError("Not connected"));
    if (liveRequests.size >= (opts.maximumPendingRequests ?? 32)) return Promise.reject(Error('RPC pending request capacity'));
    const deadline = encoded?.options?.deadline ?? Date.now() + timeout;
    drainDeadline = Math.max(drainDeadline, deadline);
    const signal = encoded?.options?.signal;
    if (deadline <= Date.now() || signal?.aborted) return Promise.reject(Error('RPC request deadline or cancellation'));
    let release: (() => void) | undefined;
    try { release = opts.acquireRequest?.(); }
    catch (error) { return Promise.reject(error); }
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      let entry: NonNullable<ReturnType<typeof pending.get>>;
      let cancelSend: (() => boolean) | undefined;
      let settled = false, sendRetired = false;
      const reading = new AbortController();
      const cancel = () => {
        pending.delete(id);
        const partialSend = cancelSend?.();
        entry.reject(new Error(encoded ? `RPC request deadline or cancellation: ${method}` : `RPC request timeout after ${timeout}ms: ${method}`));
        // A held result cannot be discarded while its consumer still owns it.
        // End this connection on the original deadline instead of admitting
        // another large message or waiting indefinitely for consumer IO.
        if (consuming.has(entry) || partialSend) {
          notifyClosed();
          rejectAllPending(new RpcClientClosedError("Response consumption timed out"));
          ws?.terminate();
        }
      };
      const timer = setTimeout(cancel, deadline - Date.now());
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      entry = {
        resolve: value => { cleanup(); settled = true; resolve(value as T); entry.retire(); },
        reject: error => { cleanup(); settled = true; reading.abort(); reject(error); entry.retire(); }, timer, consume,
        retire: () => {
          if (!settled || !sendRetired || consuming.has(entry)) return;
          if (liveRequests.delete(entry)) { const done = release; release = undefined; done?.(); }
        },
      };
      liveRequests.add(entry);
      pending.set(id, entry);
      signal?.addEventListener('abort', cancel, { once: true });
      const done = (error?: Error) => {
        if (!error) return;
        pending.delete(id); entry.reject(error);
      };
      const retired = () => { sendRetired = true; entry.retire(); };
      cancelSend = encoded
        ? sender!.sendEncoded(id, method, encoded.source, reading.signal, () => pending.has(id), done, retired)
        : sender!.send(() => encodeRequest(id, method, params), () => pending.has(id), done, retired);
    });
  }

  function rejectAllPending(reason: unknown): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
    for (const entry of consuming) { clearTimeout(entry.timer); entry.reject(reason); }
    // Keep actual consumers registered until their own finally has returned.
  }

  return {
    async prepareRequestSource(prepare, signal) {
      if (closed || !pump) throw Error('RPC preparation connection unavailable');
      const deadline = Date.now() + timeout;
      drainDeadline = Math.max(drainDeadline, deadline);
      const source = await pump.prepare(prepare, { deadline, signal });
      return { source, deadline };
    },
    maximumRequestSourceBytes(method) {
      const prefix = `{"jsonrpc":"2.0","id":${Number.MAX_SAFE_INTEGER},"method":${JSON.stringify(method)},"params":`;
      return 100 * 1024 * 1024 - Buffer.byteLength(prefix) - 1;
    },
    requestEncoded<T>(method: string, source: RpcEncodedJsonSource, options?: Partial<RpcRequestDeadline>) {
      return request<T>(method, undefined, undefined, { source, options });
    },
    consumeEncoded<T, R>(method: string, source: RpcEncodedJsonSource, consumer: (result: T) => R | Promise<R>, options?: Partial<RpcRequestDeadline>) {
      return request<R>(method, undefined, value => consumer(value as T), { source, options });
    },
    async drain() { await Promise.all([pump?.drain(), sender?.drain()]); },
    get drainDeadline() { return drainDeadline; },
    onClose(handler) {
      if (closed) {
        try { handler(); } catch { /* 与关闭事件的订阅者隔离保持一致。 */ }
        return () => {};
      }
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },
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
          try {
            pump = new RpcMessagePump(ws!, dispatchMessage, () => {
              rejectAllPending(new RpcClientClosedError("Connection closed by server"));
              notifyClosed();
              ws?.terminate();
            });
            sender = new RpcRequestSender(ws!, () => {
              rejectAllPending(new RpcClientClosedError("Request transmission failed"));
              notifyClosed(); ws?.terminate();
            }, opts.maximumQueuedRequestBytes);
            ws!.on("message", data => pump!.accept(data));
            ws!.on("close", () => {
              rejectAllPending(new RpcClientClosedError("Connection closed by server"));
              notifyClosed();
            });
            ws!.on("error", () => { /* close settles pending requests. */ });
            resolve();
          } catch (error) {
            ws!.on("error", () => {});
            ws!.terminate();
            ws = null;
            reject(error);
          }
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

    },

    async authenticate(token, clientInfo): Promise<AuthResult> {
      return this.request<AuthResult>("auth", { token, client: clientInfo });
    },

    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      return request<T>(method, params);
    },

    consume<T, R>(method: string, params: unknown, consumer: (result: T) => R | Promise<R>): Promise<R> {
      return request<R>(method, params, value => consumer(value as T));
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

    close(): Promise<void> {
      if (closing) return closing;
      let resolve!: () => void, reject!: (error: unknown) => void;
      closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Install the shared close promise before close observers can re-enter.
      // notifyClosed seals admission synchronously, as before.
      void (async () => {
        notifyClosed();
        rejectAllPending(new RpcClientClosedError("Client closed"));
        const w = ws; ws = null;
        if (w && w.readyState !== WebSocket.CLOSED) {
          await new Promise<void>(done => {
            w.once("close", done);
            if (w.readyState === WebSocket.OPEN || w.readyState === WebSocket.CONNECTING) w.close();
          });
        }
      })().then(resolve, reject);
      return closing;
    },
  };
}
