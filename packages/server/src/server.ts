/**
 * Server — HTTP 服务核心
 *
 * 设计要点：
 * - 端口监听本身就是单实例锁（重复启动 EADDRINUSE）
 * - close() 等待所有连接关闭后再 resolve（优雅停机）
 * - 监听 0 端口由 OS 分配（测试用），实际端口通过 server.address() 读取
 * - host 默认 127.0.0.1：仅本地访问，规避 SSRF 和未授权访问
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { IEventBus, SchedulerEventMap } from "@zhixing/core";
import { isInternal } from "@zhixing/core";
import { createEventBridge, type DisposeBridge } from "@zhixing/rpc/event-bridge";
import {
  createActivityBroadcast,
  createObserverBroadcast,
} from "@zhixing/rpc/session-broadcast";
import { dispatchRest } from "./routes.js";
import type { ServerContext } from "./context.js";
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from "./types.js";
import {
  createRpcConnection,
  isLoopbackAddress,
  type RpcConnection,
} from "./rpc/connection.js";
import { RpcDispatcher } from "./rpc/dispatcher.js";
import { HandlerRegistry } from "./rpc/handlers.js";
import { buildBuiltinRegistry } from "./rpc/methods/index.js";
import { RpcSurfaceRegistry } from "./rpc/surface-identity.js";

export interface ZhixingServerInstance {
  /** 实际监听的端口（监听 0 时由 OS 分配） */
  readonly port: number;
  /** 实际监听的地址 */
  readonly host: string;
  /** 关闭服务器，等待所有连接结束 */
  close(): Promise<void>;
  /** 共享上下文（供测试和后续阶段访问） */
  readonly context: ServerContext;
  /** 底层 HTTP server 实例 */
  readonly httpServer: HttpServer;
  /** RPC 方法注册表（供测试和扩展 register 自定义方法） */
  readonly registry: HandlerRegistry;
  /** 当前活跃的 RPC 连接列表（用于推送事件、强制断开） */
  readonly connections: ReadonlySet<RpcConnection>;
}

export interface StartServerOptions {
  /** 服务上下文（包含配置、scheduler 等） */
  context: ServerContext;
  /** 配置覆盖（如测试时端口设为 0） */
  config?: Partial<ServerConfig>;
  /** 自定义 RPC 注册表。不提供则用 buildBuiltinRegistry() */
  registry?: HandlerRegistry;
  /** WebSocket 路径。默认 /ws */
  wsPath?: string;
  /** 错误日志钩子 */
  onError?: (err: unknown, context: { method?: string; messageId?: string | number | null }) => void;
  /** Scheduler EventBus（提供则自动桥接事件到 RPC 推送） */
  schedulerEventBus?: IEventBus<SchedulerEventMap>;
  /** 已在最终端点取得 OS owner、但尚未开放业务入口的 server handle。 */
  boundServer?: BoundZhixingServer;
  /**
   * 已建立内部 handler/connection 设施、但同一 bound handle 仍只返回 503 时执行。
   * resolve 后才会一次性开放 REST/RPC/WS；reject 时默认由 Server
   * 关闭该 inactive handle。
   */
  activationGate?: (server: ZhixingServerInstance) => Promise<void>;
}

/** @internal 只由本包 lifecycle 组合根注入，不从包根公开。 */
export interface ServerActivationFailureOwner {
  cleanupActivationFailure(): Promise<void>;
}

export interface BindServerOptions {
  /** 最终监听配置；生命周期 owner 只能使用与激活阶段完全相同的 host/port。 */
  config?: Partial<ServerConfig>;
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;
type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * 已由 OS `listen` 仲裁、尚未开放 REST/RPC 的 server handle。
 *
 * 它只表达当前进程对最终 home endpoint 的易失独占权：崩溃时由 OS 自动释放，
 * 激活必须复用同一个 HTTP server，不能 close/rebind 或第二次 listen。
 */
export class BoundZhixingServer {
  readonly #requested: ServerConfig;
  #requestHandler: RequestHandler | undefined;
  #upgradeHandler: UpgradeHandler | undefined;
  #activeCleanup: (() => Promise<void>) | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    readonly httpServer: HttpServer,
    requested: ServerConfig,
    readonly port: number,
    readonly host: string,
  ) {
    this.#requested = requested;
  }

  static async listen(options: BindServerOptions = {}): Promise<BoundZhixingServer> {
    const requested = { ...DEFAULT_SERVER_CONFIG, ...options.config };
    let bound: BoundZhixingServer | undefined;
    const httpServer = createServer((req, res) => {
      const handler = bound ? bound.#requestHandler : undefined;
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(503, {
        "Connection": "close",
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": "1",
      });
      res.end("Server starting");
    });
    httpServer.on("upgrade", (req, socket, head) => {
      const handler = bound ? bound.#upgradeHandler : undefined;
      if (handler) {
        handler(req, socket, head);
        return;
      }
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          "Connection: close\r\n" +
          "Retry-After: 1\r\n\r\n",
      );
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.removeListener("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(requested.port, requested.host);
    });

    const addr = httpServer.address();
    if (addr === null || typeof addr === "string") {
      await closeHttpServer(httpServer);
      throw new Error("Server address unavailable after listen");
    }
    bound = new BoundZhixingServer(
      httpServer,
      requested,
      addr.port,
      addr.address,
    );
    return bound;
  }

  get listening(): boolean {
    return !this.#closed && this.httpServer.listening;
  }

  ownsEndpoint(port: number): boolean {
    return this.listening && this.port === port;
  }

  /** @internal 仅由 startServer 在完整上下文就绪后调用。 */
  activate(input: {
    readonly config: ServerConfig;
    readonly requestHandler: RequestHandler;
    readonly upgradeHandler: UpgradeHandler;
    readonly cleanup: () => Promise<void>;
  }): void {
    if (this.#closed || !this.httpServer.listening) {
      throw new Error("Cannot activate a closed server binding");
    }
    if (this.#requestHandler || this.#upgradeHandler || this.#activeCleanup) {
      throw new Error("Server binding is already active");
    }
    if (
      input.config.host !== this.#requested.host ||
      input.config.port !== this.#requested.port
    ) {
      throw new Error("Server activation does not match the bound endpoint request");
    }
    this.#activeCleanup = input.cleanup;
    this.#requestHandler = input.requestHandler;
    this.#upgradeHandler = input.upgradeHandler;
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#requestHandler = undefined;
      this.#upgradeHandler = undefined;
      if (this.#activeCleanup) {
        await this.#activeCleanup();
      } else {
        await closeHttpServer(this.httpServer);
      }
    })();
    return this.#closePromise;
  }
}

/** 在最终 host/port 建立 inactive ingress；不会创建 RPC/REST router 或发布 ready。 */
export function bindServer(options: BindServerOptions = {}): Promise<BoundZhixingServer> {
  return BoundZhixingServer.listen(options);
}

/**
 * 启动 Server。返回 Promise 在监听就绪后 resolve。
 * 端口被占用会 reject EADDRINUSE。
 */
export async function startServer(opts: StartServerOptions): Promise<ZhixingServerInstance> {
  return startServerWithOwner(opts);
}

/** @internal 持久 Host 将 activation failure 交回已取得 endpoint 的真实 owner。 */
export async function startServerWithActivationFailureOwner(
  opts: StartServerOptions,
  owner: ServerActivationFailureOwner,
): Promise<ZhixingServerInstance> {
  if (!owner || typeof owner.cleanupActivationFailure !== "function") {
    await opts.boundServer?.close().catch(() => undefined);
    throw new TypeError("Server activation failure owner is invalid");
  }
  return startServerWithOwner(opts, owner);
}

async function startServerWithOwner(
  opts: StartServerOptions,
  activationFailureOwner?: ServerActivationFailureOwner,
): Promise<ZhixingServerInstance> {
  const config = { ...DEFAULT_SERVER_CONFIG, ...opts.context.config, ...opts.config };
  const ctx = opts.context;
  const wsPath = opts.wsPath ?? "/ws";
  const registry = opts.registry ?? buildBuiltinRegistry();
  const boundServer = opts.boundServer ?? await bindServer({ config });
  const httpServer = boundServer.httpServer;

  const requestHandler: RequestHandler = (req, res) => {
    const routePath = new URL(req.url ?? "/", "http://localhost").pathname;
    const channelRoute = ctx.channelHttpRoutes?.get(routePath);
    if (channelRoute) {
      void Promise.resolve(channelRoute(req, res)).catch((error) => {
        opts.onError?.(error, { method: `http:${routePath}` });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        if (!res.writableEnded) res.end("Internal Server Error");
      });
      return;
    }
    // REST 路由匹配
    if (dispatchRest(req, res, ctx)) return;

    // 未匹配 → 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };

  // ─── WebSocket 集成 ───
  // 用 noServer 模式：手动处理 upgrade，便于路径过滤
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<RpcConnection>();
  const rpcSurfaces = new RpcSurfaceRegistry();
  ctx.rpcSurfaces = rpcSurfaces;
  const dispatcher = new RpcDispatcher({ registry, server: ctx, onError: opts.onError });

  const upgradeHandler: UpgradeHandler = (req, socket, head) => {
    const url = req.url ?? "/";
    if (url !== wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // 在 upgrade 时刻捕获来源地址——loopback 与否是连接的固有属性,
    // 进入接入面信任级判定(trusted = authenticated + loopback)
    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachConnection(ws, loopback);
    });
  };

  function attachConnection(ws: WebSocket, loopback: boolean): void {
    const connection = createRpcConnection(ws, { loopback });
    connections.add(connection);

    ws.on("message", (data) => {
      // ws 默认把 text frame 给 Buffer——dispatcher 内部统一转 string
      void dispatcher.handleMessage(connection, data as Buffer);
    });

    ws.on("close", () => {
      rpcSurfaces.unbind(connection);
      connections.delete(connection);
      ctx.conversations?.removeObserverFromAll(String(connection.id));
    });

    ws.on("error", (err) => {
      opts.onError?.(err, { method: "websocket" });
    });
  }

  // 回填实际监听地址到 context，供 status 等端点读取
  ctx.listenAddr = { port: boundServer.port, host: boundServer.host };

  // 回填会话域组播——delta / complete / session.event / session.changed 经
  // observer 名册推送给会话的全部在场接入面(多端同看一个流式 turn 由此成立)。
  if (ctx.conversations) {
    const manager = ctx.conversations;
    ctx.sessionBroadcast = createObserverBroadcast({ connections, manager });
    ctx.sessionActivityBroadcast = createActivityBroadcast({
      connections,
      manager,
    });
  }

  // 回填全连接广播(全局域变更通知,如 skill.changed)与连接计数(server.info)。
  ctx.broadcastAll = (method, params) => {
    for (const conn of connections) {
      if (conn.authenticated && !conn.closed) conn.notify(method, params);
    }
  };
  ctx.connectionCount = () => connections.size;

  // EventBus → RPC notification 桥接（订阅 scheduler 等事件，向所有连接广播）。
  // 内部维护任务的运行事件不广播给 client（结果触达：内部静默）——谓词用 ctx.scheduler
  // 现查 task.system，与 channel 投递、facade.onEvent 两个触达边界一致。
  const disposeBridge: DisposeBridge = createEventBridge({
    connections,
    schedulerEventBus: opts.schedulerEventBus,
    isInternalTask: (taskId) => {
      const task = ctx.scheduler?.getTask(taskId);
      return task ? isInternal(task) : false;
    },
  });

  let activeClosed = false;
  const cleanupActive = async () => {
    if (activeClosed) return;
    activeClosed = true;
    // 0. 断开所有通道适配器
    if (ctx.channels) {
      await ctx.channels.dispose().catch(() => {});
    }
    // 1. 释放所有对话运行时（timer 清理 + 资源回收 + 各会话末窗 onWindowClose）
    await ctx.conversations?.disposeAll();
    // 2. 取消事件桥接订阅（否则 scheduler 后续事件还会调 conn.notify）
    disposeBridge();
    // 3. 关闭所有 WebSocket（触发 ws.on("close") → 从 connections 移除）
    for (const conn of connections) {
      conn.close(1001, "Server shutting down");
    }
    // 4. 关闭 ws server（不再接受新连接）
    wss.close();
    // 5. 关闭 HTTP server（停止监听 + 等待现有连接结束）
    await closeHttpServer(httpServer);
  };

  const server: ZhixingServerInstance = {
    port: boundServer.port,
    host: boundServer.host,
    httpServer,
    context: ctx,
    registry,
    connections,
    async close() {
      await boundServer.close();
    },
  };

  try {
    await opts.activationGate?.(server);
    boundServer.activate({ config, requestHandler, upgradeHandler, cleanup: cleanupActive });
  } catch (error) {
    disposeBridge();
    wss.close();
    if (activationFailureOwner) {
      try {
        await activationFailureOwner.cleanupActivationFailure();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Server activation and owner cleanup failed",
        );
      }
    } else {
      await boundServer.close().catch(() => {});
    }
    throw error;
  }

  return server;
}

async function closeHttpServer(httpServer: HttpServer): Promise<void> {
  if (!httpServer.listening) return;
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
    httpServer.closeAllConnections();
  });
}
