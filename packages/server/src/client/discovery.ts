/**
 * Server 自动发现
 *
 * 本地协议客户端调用此模块拿到「连接到本地 server 所需的全部信息」：
 * - URL（host + port）
 * - token
 *
 * 所有信息从约定路径读取，不假设 server 进程仍在运行——但提供 isProcessAlive 检查能力。
 *
 * 失败时抛 ServerNotRunningError，上层接入面可以给出友好提示而非堆栈。
 */

import { readFile } from "node:fs/promises";

import { getDefaultTokenPath } from "../paths.js";
import { readLock, isProcessAlive, type PidFileContents } from "../process-lock.js";

export class ServerNotRunningError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "ServerNotRunningError";
  }
}

export interface ServerEndpoint {
  /** WebSocket URL，例如 ws://127.0.0.1:18900/ws */
  url: string;
  /** HTTP base URL，例如 http://127.0.0.1:18900 */
  httpBase: string;
  /** 共享 token */
  token: string;
  /** PID 文件读到的元信息 */
  pid: PidFileContents;
}

export interface DiscoverOptions {
  /** PID 文件路径覆盖 */
  pidPath?: string;
  /** 端口文件路径覆盖（当前未使用，但保留扩展点） */
  portPath?: string;
  /** Token 文件路径覆盖 */
  tokenPath?: string;
  /** 主机覆盖（如远程 server）。默认从 PID 文件推断（127.0.0.1） */
  host?: string;
  /** WebSocket 路径。默认 /ws */
  wsPath?: string;
}

/**
 * 发现并验证本地 server。
 * - 读 PID 文件 → 验证进程存活 → 读 token → 拼出 endpoint
 *
 * 失败场景及对应提示：
 * - PID 文件不存在 → "Server is not running. Start it with: zhixing serve"
 * - PID 文件存在但进程死了 → "Found stale pid file; server is not actually running"
 * - Token 文件不存在 → "Token file missing"
 */
export async function discoverServer(opts: DiscoverOptions = {}): Promise<ServerEndpoint> {
  const lock = await readLock({
    pidPath: opts.pidPath,
    portPath: opts.portPath,
  });

  if (!lock) {
    throw new ServerNotRunningError(
      "Server is not running",
      "Start it with: zhixing serve",
    );
  }

  if (!isProcessAlive(lock.pid)) {
    throw new ServerNotRunningError(
      `Server pid ${lock.pid} is no longer alive (stale pid file)`,
      "Run: zhixing serve",
    );
  }

  const token = await readToken(opts.tokenPath);
  if (!token) {
    throw new ServerNotRunningError(
      "Server token file missing or empty",
      `Expected at: ${opts.tokenPath ?? getDefaultTokenPath()}`,
    );
  }

  const host = opts.host ?? "127.0.0.1";
  const wsPath = opts.wsPath ?? "/ws";

  return {
    url: `ws://${host}:${lock.port}${wsPath}`,
    httpBase: `http://${host}:${lock.port}`,
    token,
    pid: lock,
  };
}

/**
 * 仅读取 token，不检查 server 状态。
 * 用于不需要连接的场景（如显示 token 路径）。
 */
export async function readToken(tokenPath?: string): Promise<string | null> {
  const path = tokenPath ?? getDefaultTokenPath();
  try {
    const content = (await readFile(path, "utf-8")).trim();
    return content.length > 0 ? content : null;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}
