/**
 * ServerContext — 服务运行时共享上下文
 *
 * 持有所有跨模块共享的状态：配置、Scheduler、auth token、启动时间等。
 * 通过显式传递（而不是单例）保持可测试性。
 *
 * 后续阶段会扩展：
 * - S2.D: sessions registry（会话注册表）
 * - S2.E: scheduler（调度器实例）
 * - S5: channels（通道注册表）
 */

import type { Scheduler } from "@zhixing/core";
import type { ServerConfig } from "./types.js";
import type { SessionRegistry } from "./session/index.js";

export interface ServerContext {
  /** 配置（不可变；config.port 是请求的端口，实际端口见 listenAddr） */
  readonly config: ServerConfig;
  /** Server 包版本号 */
  readonly version: string;
  /** 启动时间戳（ms） */
  readonly startedAt: number;
  /** 共享 token（auth 验证用）。由 ServerOrchestrator 注入 */
  readonly token: string;
  /** 调度器实例（S2.E 注入；S2.B/C 阶段为 undefined） */
  scheduler?: Scheduler;
  /** 会话注册表（S2.D 注入；不传则 session.* 方法不可用） */
  sessions?: SessionRegistry;
  /** 实际监听的地址（startServer 监听就绪后回填） */
  listenAddr?: { port: number; host: string };
}

export interface CreateContextOptions {
  config: ServerConfig;
  version: string;
  token: string;
  scheduler?: Scheduler;
  sessions?: SessionRegistry;
}

export function createServerContext(opts: CreateContextOptions): ServerContext {
  return {
    config: opts.config,
    version: opts.version,
    token: opts.token,
    startedAt: Date.now(),
    scheduler: opts.scheduler,
    sessions: opts.sessions,
  };
}
