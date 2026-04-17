/**
 * Server 公共类型
 *
 * 跨模块共享的状态、配置、运行时上下文类型。
 */

// ─── 配置 ───

export interface ServerConfig {
  /** 监听端口。默认 18900 */
  port: number;
  /** 监听地址。默认 127.0.0.1（仅本地访问） */
  host: string;
  /** 优雅停机超时（毫秒）。默认 30_000 */
  shutdownTimeoutMs: number;
  /** 共享 token 文件路径。默认 ~/.zhixing/server.token */
  tokenPath?: string;
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 18900,
  host: "127.0.0.1",
  shutdownTimeoutMs: 30_000,
};

// ─── 健康状态 ───

export interface HealthStatus {
  status: "ok";
  version: string;
  uptime: number;
}

// ─── 服务状态 ───

export interface ServerStatus {
  running: boolean;
  pid: number;
  port: number;
  host: string;
  uptime: number;
  version: string;
  startedAt: string;
  scheduler?: {
    taskCount: number;
    activeTaskCount: number;
  };
  memory: {
    rss: number;
    heapUsed: number;
  };
}
