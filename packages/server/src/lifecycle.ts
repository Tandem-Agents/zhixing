/**
 * Server 生命周期编排器
 *
 * 把进程锁、Server、Scheduler、信号处理器编排到一起，让 CLI 只需要一行：
 *   await runServer({ scheduler, sessions, ... })
 *
 * 关闭顺序（关键）：
 * 1. 收到 SIGTERM/SIGINT → 进入 shutting-down 状态
 * 2. 停 Scheduler（等待活跃任务完成或超时）
 * 3. 关 Server（断开 ws 连接、关闭 http 监听）
 * 4. 释放进程锁（删 pid/port 文件）
 * 5. process.exit(0)
 *
 * 多次信号处理：
 * - 第一次 SIGTERM/SIGINT → 进入优雅停机流程
 * - 第二次 SIGINT → 强制 exit(1)（用户着急了）
 *
 * Windows 兼容性：
 * - Windows 不支持 SIGUSR1，跳过该信号注册
 * - SIGTERM 在 Windows 上等价于强制终止，但不影响优雅流程（Node 会在 exit 前执行 listener）
 */

import type { Scheduler } from "@zhixing/core";
import { startServer, type StartServerOptions, type ZhixingServerInstance } from "./server.js";
import {
  acquireLock,
  releaseLock,
  type ProcessLockPaths,
} from "./process-lock.js";

export interface RunServerOptions extends StartServerOptions {
  /** Scheduler 实例（已 start）。runServer 会在停机时调用 scheduler.stop() */
  scheduler?: Scheduler;
  /** 进程锁文件路径覆盖 */
  lockPaths?: ProcessLockPaths;
  /** 跳过进程锁（测试用） */
  skipProcessLock?: boolean;
  /** 跳过信号处理器注册（测试用——避免污染 vitest 进程信号处理器） */
  skipSignalHandlers?: boolean;
  /** 日志钩子 */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface RunningServer {
  /** Server 实例 */
  server: ZhixingServerInstance;
  /** 主动触发优雅停机；返回 Promise 在停机完成后 resolve */
  shutdown(reason?: string): Promise<void>;
  /** 等待停机完成（信号触发时使用） */
  waitForShutdown(): Promise<void>;
}

/**
 * 启动一个完整的 server 生命周期，包含进程锁、信号处理、优雅停机。
 */
export async function runServer(opts: RunServerOptions): Promise<RunningServer> {
  const logger = opts.logger ?? defaultLogger();

  // 1. 启动 server（端口锁内置在 listen() 里）
  const server = await startServer({
    context: opts.context,
    config: opts.config,
    registry: opts.registry,
    wsPath: opts.wsPath,
    onError: opts.onError,
    schedulerEventBus: opts.schedulerEventBus,
  });

  // 2. 获取 PID 锁（基于实际监听端口）
  if (!opts.skipProcessLock) {
    try {
      await acquireLock(server.port, opts.lockPaths);
    } catch (err) {
      // 端口已通过——但 PID 文件被占用？关掉 server 防止泄漏，再抛错
      await server.close();
      throw err;
    }
  }

  logger.info(`Server listening on http://${server.host}:${server.port}`);

  // 3. 优雅停机封装
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const shutdownDoneWaiters: Array<() => void> = [];

  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info(`Shutting down (${reason})...`);

      // a. 停 Scheduler（等待活跃任务）
      if (opts.scheduler) {
        try {
          await opts.scheduler.stop();
        } catch (err) {
          logger.error(`scheduler.stop() failed: ${errMsg(err)}`);
        }
      }

      // b. 关闭 server（断 ws + 停 http）
      try {
        await server.close();
      } catch (err) {
        logger.error(`server.close() failed: ${errMsg(err)}`);
      }

      // c. 释放 PID 锁
      if (!opts.skipProcessLock) {
        await releaseLock(opts.lockPaths);
      }

      logger.info("Shutdown complete");
      for (const w of shutdownDoneWaiters.splice(0)) w();
    })();
    return shutdownPromise;
  };

  // 4. 信号处理器
  if (!opts.skipSignalHandlers) {
    let sigintCount = 0;
    const onSigterm = () => {
      void shutdown("SIGTERM").then(() => process.exit(0));
    };
    const onSigint = () => {
      sigintCount += 1;
      if (sigintCount >= 2) {
        logger.warn("Received second SIGINT, forcing exit");
        process.exit(1);
      }
      void shutdown("SIGINT").then(() => process.exit(0));
    };

    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);

    // SIGUSR1 — 优雅重启信号占位（实际重启逻辑由 daemon 模式实现，S4）
    // 当前阶段：收到 SIGUSR1 也走优雅停机，进程外的 supervisor 负责重启
    if (process.platform !== "win32") {
      process.once("SIGUSR1", () => {
        void shutdown("SIGUSR1 (restart)").then(() => process.exit(0));
      });
    }
  }

  return {
    server,
    shutdown,
    waitForShutdown(): Promise<void> {
      if (shuttingDown && shutdownPromise) return shutdownPromise;
      return new Promise<void>((resolve) => {
        shutdownDoneWaiters.push(resolve);
      });
    },
  };
}

// ─── 工具 ───

function defaultLogger() {
  return {
    info: (msg: string) => console.log(`[server] ${msg}`),
    warn: (msg: string) => console.warn(`[server] ${msg}`),
    error: (msg: string) => console.error(`[server] ${msg}`),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
