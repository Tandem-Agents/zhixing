/**
 * Server 生命周期编排器
 *
 * 把进程锁、Server、Scheduler、信号处理器编排到一起。调用方只需要：
 *   await runServer({ context, scheduler, cleanupRegistry })
 *
 * Shutdown 架构（M4 重构）：
 * - 所有清理职责统一走 CleanupRegistry（LIFO 栈）
 * - `shutdown(reason)` 只做两件事：registry.runAll(reason) → 唤醒 waiters
 * - **绝不调 `process.exit`**——退出权在调用方（信号 handler / command.ts / RPC）
 *
 * 两种使用模式：
 * 1. **注入模式**（command.ts 传入 cleanupRegistry）：
 *    - runServer 只在 registry 中注册 `server.close`
 *    - 其余资源（scheduler / channels / delivery / stateFile / releaseLock）
 *      由 command.ts 注册——它是唯一知道全部资源的编排点
 *    - LIFO 保证：命令行注册尾部项（释放锁）→ server.close → 命令行注册核心资源
 * 2. **独立模式**（cleanupRegistry 未传入，lifecycle.test.ts 等场景）：
 *    - runServer 内部创建默认 registry
 *    - 额外注册 scheduler.stop + releaseLock，保持 M3 之前的 shutdown 语义不变
 *
 * 关闭顺序（LIFO 展开示例，注入模式 + 全量资源）：
 * 1. stateFile.markStopping        ← 对外宣告
 * 2. scheduler.stop                ← 业务子系统
 * 3. channels.dispose
 * 4. delivery.stop
 * 5. clearInterval(heartbeat)
 * 6. server.close                  ← HTTP/WS
 * 7. stateFile.markStopped
 * 8. stateFile.cleanup             ← 删 state/ready
 * 9. releaseLock                   ← 删 PID 文件，最后
 *
 * 多次信号处理：
 * - 第一次 SIGTERM/SIGINT → 进入优雅停机流程，shutdown resolve 后 process.exit(0)
 * - 第二次 SIGINT → 立即 process.exit(1)
 *
 * Windows 兼容：
 * - 不支持 SIGUSR1 → 跳过注册
 * - SIGTERM 在 Windows 等价 force-kill（仍尽量调 handler）
 */

import type { Scheduler } from "@zhixing/core";
import { startServer, type StartServerOptions, type ZhixingServerInstance } from "./server.js";
import {
  acquireLock,
  releaseLock,
  type AcquireLockOptions,
  type ProcessLockPaths,
} from "./process-lock.js";
import { CleanupRegistry } from "./cleanup-registry.js";

export interface RunServerOptions extends StartServerOptions {
  /** Scheduler 实例（已 start）。独立模式会在 registry 中注册 scheduler.stop */
  scheduler?: Scheduler;
  /** 进程锁文件路径覆盖 */
  lockPaths?: ProcessLockPaths;
  /** 写入 PID 发现文件的诊断元数据 */
  processInfo?: Pick<AcquireLockOptions, "argv" | "host" | "kind" | "logPath" | "version">;
  /** 跳过进程锁（测试用） */
  skipProcessLock?: boolean;
  /** 跳过信号处理器注册（测试用——避免污染 vitest 进程信号处理器） */
  skipSignalHandlers?: boolean;
  /**
   * 外部注入的 cleanup registry。
   * - 传入：lifecycle 只注册 server.close，其他由调用方负责
   * - 未传入：内部创建默认 registry，注册 scheduler.stop + server.close + releaseLock
   *   （向后兼容模式——lifecycle.test.ts 等直接调用方场景）
   */
  cleanupRegistry?: CleanupRegistry;
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
  /** 主动触发优雅停机；返回 Promise 在停机完成后 resolve。不调 process.exit */
  shutdown(reason?: string): Promise<void>;
  /** 等待停机完成（信号触发或 RPC 时） */
  waitForShutdown(): Promise<void>;
}

/**
 * 启动完整 server 生命周期：进程锁 + 信号处理 + CleanupRegistry 驱动的优雅停机。
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

  // 2. 写 PID / port 发现文件 —— owner 已由上面的 listen 确立（端口才是单例锁），
  //    acquireLock 覆盖任何崩溃残留、不因 PID 冲突自杀（见 process-lock.ts）。
  if (!opts.skipProcessLock) {
    try {
      await acquireLock(server.port, {
        ...opts.lockPaths,
        ...opts.processInfo,
        host: opts.processInfo?.host ?? server.host,
      });
    } catch (err) {
      // 仅 PID 文件写入 IO 失败（磁盘满 / 权限）才会到这里——此时 server 已 listen 但
      // cleanup 尚未注册，手动关掉防端口泄漏再传播（fail-fast：发现文件写不了，宿主无法被接入）。
      await server.close();
      throw err;
    }
  }

  logger.info(`Server listening on http://${server.host}:${server.port}`);

  // 3. Cleanup registry：外部注入 or 内部默认
  const injected = !!opts.cleanupRegistry;
  const registry =
    opts.cleanupRegistry ??
    new CleanupRegistry({
      logger: {
        error: (msg, err) => logger.error(`${msg}${err ? ": " + errMsg(err) : ""}`),
      },
    });

  // 4. 注册 server-internal cleanup
  //    LIFO 语义：后注册者先执行 = 注册顺序是期望执行顺序的倒序。
  if (injected) {
    // 注入模式：只管 server.close，其他由调用方在此前/此后注册
    registry.register("server.close", async () => {
      await server.close();
    });
  } else {
    // 独立模式：保持 M3 之前的 shutdown 顺序（scheduler.stop → server.close → releaseLock）
    // 注册顺序（倒序）：releaseLock → server.close → scheduler.stop
    if (!opts.skipProcessLock) {
      registry.register("releaseLock", async () => {
        await releaseLock(opts.lockPaths);
      });
    }
    registry.register("server.close", async () => {
      await server.close();
    });
    if (opts.scheduler) {
      registry.register("scheduler.stop", async () => {
        await opts.scheduler!.stop();
      });
    }
  }

  // 5. shutdown 编排
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const shutdownDoneWaiters: Array<() => void> = [];

  const shutdown = async (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info(`Shutting down (${reason})...`);
      await registry.runAll(reason);
      logger.info("Shutdown complete");
      for (const w of shutdownDoneWaiters.splice(0)) w();
    })();
    return shutdownPromise;
  };

  // 5a. 绑定 ctx.requestShutdown —— 供 server.shutdown RPC handler 使用
  //     startServer 已 resolve，同一微任务内绑定，不存在 race（RPC handler 在下一 tick 才能执行）
  opts.context.requestShutdown = (reason: string) => {
    void shutdown(reason);
  };

  // 6. 信号处理器
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

    // SIGUSR1 — 本 Level 等同 SIGTERM（无 supervisor 不做自动重启）；Windows 跳过
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
