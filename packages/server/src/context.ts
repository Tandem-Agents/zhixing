/**
 * ServerContext — 服务运行时共享上下文
 *
 * 持有所有跨模块共享的状态：配置、Scheduler、auth token、启动时间等。
 * 通过显式传递（而不是单例）保持可测试性。
 */

import type { Scheduler, ChannelRegistry } from "@zhixing/core";
import type { ServerConfig } from "./types.js";
import type { ConversationManager } from "./runtime/index.js";

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
  /** 实际监听的地址（startServer 监听就绪后回填） */
  listenAddr?: { port: number; host: string };
}

export interface CreateContextOptions {
  config: ServerConfig;
  version: string;
  token: string;
  scheduler?: Scheduler;
  conversations?: ConversationManager;
  channels?: ChannelRegistry;
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
  };
}
