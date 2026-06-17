/**
 * Server — HTTP 服务核心
 *
 * 当前阶段（S2.B）：node:http 服务 + REST 路由分发。
 * 下一阶段（S2.C）：WebSocket upgrade + RPC 分发器。
 *
 * 设计要点：
 * - 端口监听本身就是单实例锁（重复启动 EADDRINUSE）
 * - close() 等待所有连接关闭后再 resolve（优雅停机）
 * - 监听 0 端口由 OS 分配（测试用），实际端口通过 server.address() 读取
 * - host 默认 127.0.0.1：仅本地访问，规避 SSRF 和未授权访问
 */

import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { IEventBus, SchedulerEventMap } from "@zhixing/core";
import { isInternal } from "@zhixing/core";
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
import { createEventBridge, type DisposeBridge } from "./rpc/event-bridge.js";
import {
  createActivityBroadcast,
  createObserverBroadcast,
} from "./rpc/session-broadcast.js";

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
}

/**
 * 启动 Server。返回 Promise 在监听就绪后 resolve。
 * 端口被占用会 reject EADDRINUSE。
 */
export async function startServer(opts: StartServerOptions): Promise<ZhixingServerInstance> {
  const config = { ...DEFAULT_SERVER_CONFIG, ...opts.context.config, ...opts.config };
  const ctx = opts.context;
  const wsPath = opts.wsPath ?? "/ws";
  const registry = opts.registry ?? buildBuiltinRegistry();

  const httpServer = createServer((req, res) => {
    // REST 路由匹配
    if (dispatchRest(req, res, ctx)) return;

    // 未匹配 → 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  // ─── WebSocket 集成 ───
  // 用 noServer 模式：手动处理 upgrade，便于路径过滤
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<RpcConnection>();
  const dispatcher = new RpcDispatcher({ registry, server: ctx, onError: opts.onError });

  httpServer.on("upgrade", (req, socket, head) => {
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
  });

  function attachConnection(ws: WebSocket, loopback: boolean): void {
    const connection = createRpcConnection(ws, { loopback });
    connections.add(connection);

    ws.on("message", (data) => {
      // ws 默认把 text frame 给 Buffer——dispatcher 内部统一转 string
      void dispatcher.handleMessage(connection, data as Buffer);
    });

    ws.on("close", () => {
      connections.delete(connection);
      ctx.conversations?.removeObserverFromAll(String(connection.id));
    });

    ws.on("error", (err) => {
      opts.onError?.(err, { method: "websocket" });
    });
  }

  // 等待监听就绪
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
    httpServer.listen(config.port, config.host);
  });

  // 提取实际监听信息（端口可能由 OS 分配）
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server address unavailable after listen");
  }

  // 回填实际监听地址到 context，供 status 等端点读取
  ctx.listenAddr = { port: addr.port, host: addr.address };

  void ctx.workflow?.recoverUnfinished().catch((err) => {
    opts.onError?.(err, { method: "workflow.recoverUnfinished" });
  });

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

  let closed = false;

  return {
    port: addr.port,
    host: addr.address,
    httpServer,
    context: ctx,
    registry,
    connections,
    async close() {
      if (closed) return;
      closed = true;
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
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeAllConnections();
      });
    },
  };
}
