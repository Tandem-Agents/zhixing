/**
 * ServerContext — 服务运行时共享上下文
 *
 * 持有所有跨模块共享的状态：配置、Scheduler、auth token、启动时间等。
 * 通过显式传递（而不是单例）保持可测试性。
 */

import type { Scheduler, ChannelRegistry, RunRegistry } from "@zhixing/core";
import type { ServerConfig } from "./types.js";
import type { ConversationManager } from "./runtime/index.js";
import type { ConfirmationHub } from "./confirmation/hub.js";
import type { SessionBroadcast } from "./rpc/session-broadcast.js";

export interface ServerContext {
  /** 配置（不可变；config.port 是请求的端口，实际端口见 listenAddr） */
  readonly config: ServerConfig;
  /** Server 包版本号 */
  readonly version: string;
  /** 启动时间戳（ms） */
  readonly startedAt: number;
  /** 共享 token（auth 验证用）。由 ServerOrchestrator 注入 */
  readonly token: string;
  /** 调度器实例（S2.E 注入） */
  scheduler?: Scheduler;
  /** 对话运行时管理器（不传则 session.* 方法不可用） */
  conversations?: ConversationManager;
  /** 通道注册表（不传则不启用通道功能） */
  channels?: ChannelRegistry;
  /**
   * 确认聚合器（不传则远程确认不启用，serve 模式回退到永久 pending → 30min expire → 拒绝）。
   * 远程权限确认的聚合入口——参见 remote-confirmation-execution.md §3.2。
   */
  confirmationHub?: ConfirmationHub;
  /**
   * Scheduler ephemeral run 的中断注册表。不传则 `schedule.abortRun` RPC 不可用,
   * scheduler 关停链 abort 也降级 no-op。serve 模式应注入 —— 由 command.ts
   * 与 scheduler 一起初始化。
   */
  runRegistry?: RunRegistry;
  /** 实际监听的地址（startServer 监听就绪后回填） */
  listenAddr?: { port: number; host: string };
  /**
   * 会话域组播(observer 名册定向推送)。startServer 在 connections 就绪后
   * 回填;未回填(最小测试 ctx)时 session 推送退化为发起连接单播。
   */
  sessionBroadcast?: SessionBroadcast;
  /**
   * 优雅停机触发器（runServer 在 startServer resolve 后同一微任务绑定）。
   * 供 `server.shutdown` RPC handler 使用——handler 不 await，立即 ack 回响应。
   * 未绑定（start 失败）时 handler 应抛 RpcErrors.internal。
   */
  requestShutdown?: (reason: string) => void;
}

export interface CreateContextOptions {
  config: ServerConfig;
  version: string;
  token: string;
  scheduler?: Scheduler;
  conversations?: ConversationManager;
  channels?: ChannelRegistry;
  confirmationHub?: ConfirmationHub;
  runRegistry?: RunRegistry;
}

export function createServerContext(opts: CreateContextOptions): ServerContext {
  return {
    config: opts.config,
    version: opts.version,
    token: opts.token,
    startedAt: Date.now(),
    scheduler: opts.scheduler,
    conversations: opts.conversations,
    channels: opts.channels,
    confirmationHub: opts.confirmationHub,
    runRegistry: opts.runRegistry,
  };
}
