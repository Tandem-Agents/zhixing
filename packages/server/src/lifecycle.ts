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
 *    - 默认由 runServer 注册 `server.close`；持久 Host 可注入一个类型化
 *      lifecycle owner，以同一 handle 接管 endpoint 与 discovery
 *    - 其余资源由持久 Host 的有限类型化 lifecycle owner 接管
 * 2. **独立模式**（cleanupRegistry 未传入，lifecycle.test.ts 等场景）：
 *    - runServer 内部创建默认 registry
 *    - 额外注册 scheduler.stop + releaseLock，保持 M3 之前的 shutdown 语义不变
 *
 * 多次信号处理：
 * - 第一次 SIGTERM/SIGINT → 进入优雅停机流程，shutdown resolve 后 process.exit(0)
 * - 第二次 SIGINT → 立即 process.exit(1)
 *
 * Windows 兼容：
 * - 不支持 SIGUSR1 → 跳过注册
 * - SIGTERM 在 Windows 等价 force-kill（仍尽量调 handler）
 */

import type { SchedulerBackend } from "@zhixing/core";
import {
  startServer,
  startServerWithActivationFailureOwner,
  type ServerActivationFailureOwner,
  type StartServerOptions,
  type ZhixingServerInstance,
} from "./server.js";
import {
  acquireLock,
  releaseLock,
  type AcquireLockOptions,
  type ProcessLockPaths,
} from "./process-lock.js";
import { CleanupRegistry, registerCleanup } from "./cleanup-registry.js";

export interface RunServerOptions extends Omit<StartServerOptions, "activationGate"> {
  /**
   * Server 内部设施已准备、正常关闭入口已绑定，但 REST/RPC/WS 仍为 inactive 503 时执行。
   * 持久 Host 组合根使用；resolve 后同一个 bound handle 才会激活。
   */
  beforeActivate?: (runner: RunningServer) => Promise<void>;
  /** Server 已激活但尚未发布 PID/ready 时执行的候选健康门。 */
  beforePublish?: (server: ZhixingServerInstance) => Promise<void>;
  /** PID/port 已发布后写入 Host state/ready；失败仍走同一 shutdown registry。 */
  publishReady?: (runner: RunningServer) => Promise<void>;
  /**
   * Optional typed outer owner for persistent Host endpoint/discovery cleanup.
   * When present it replaces this module's direct `server.close` registration
   * and owns activation-failure compensation through the injected registry.
   */
  lifecycleOwner?: ServerLifecycleOwner;
  /** Scheduler 实例（已 start）。独立模式会在 registry 中注册 scheduler.stop */
  scheduler?: SchedulerBackend;
  /** 进程锁文件路径覆盖 */
  lockPaths?: ProcessLockPaths;
  /** 写入 PID 发现文件的诊断元数据 */
  processInfo?: Pick<
    AcquireLockOptions,
    "argv" | "host" | "kind" | "logPath" | "startTime" | "startedAt" | "version"
  >;
  /** 跳过进程锁（测试用） */
  skipProcessLock?: boolean;
  /** 跳过信号处理器注册（测试用——避免污染 vitest 进程信号处理器） */
  skipSignalHandlers?: boolean;
  /**
   * 外部注入的 cleanup registry。
   * - 传入：lifecycle 注册 server.close，或把它移交给 lifecycleOwner；其他由调用方负责
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

export interface ServerLifecycleOwner extends ServerActivationFailureOwner {
  transferPreparedServer(
    server: ZhixingServerInstance,
    registry: CleanupRegistry,
  ): void;
  publishDiscovery(server: ZhixingServerInstance): Promise<void>;
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

  // 1. Cleanup registry：在公开入口激活之前成立，令 staging/open/publication
  //    任一失败都由同一 owner 逆序补偿。
  const injected = !!opts.cleanupRegistry;
  if (opts.lifecycleOwner && !injected) {
    throw new Error("A Server lifecycle owner requires an injected CleanupRegistry");
  }
  const registry =
    opts.cleanupRegistry ??
    new CleanupRegistry({
      activeOwners: ["standalone-server"],
      logger: {
        error: (msg, err) => logger.error(`${msg}${err ? ": " + errMsg(err) : ""}`),
      },
    });

  // 2. shutdown 编排。prepared server 进入 activation gate 时即绑定；公开入口
  //    尚未开放也能由同一 registry 安全终止。
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

  let runner: RunningServer | undefined;
  let processLockAcquired = false;
  const assertStartupActive = async (): Promise<void> => {
    if (!shuttingDown) return;
    await shutdownPromise;
    throw new Error("Server stopped before startup publication completed");
  };

  try {
    // 3. startServer 先准备 handler/connection/context，但 activationGate resolve 前
    //    同一最终 endpoint 仍只返回 inactive 503。
    const startOptions: StartServerOptions = {
      context: opts.context,
      ...(opts.boundServer ? { boundServer: opts.boundServer } : {}),
      config: opts.config,
      registry: opts.registry,
      wsPath: opts.wsPath,
      onError: opts.onError,
      schedulerEventBus: opts.schedulerEventBus,
      activationGate: async (preparedServer) => {
        if (!injected && !opts.skipProcessLock) {
          registerCleanup(
            registry,
            { owner: "standalone-server", role: "server", id: "releaseLock" },
            async () => {
              if (processLockAcquired) await releaseLock(opts.lockPaths);
            },
          );
        }
        if (opts.lifecycleOwner) {
          opts.lifecycleOwner.transferPreparedServer(preparedServer, registry);
        } else {
          registerCleanup(
            registry,
            { owner: "standalone-server", role: "server", id: "server.close" },
            async () => preparedServer.close(),
          );
        }
        if (!injected && opts.scheduler) {
          registerCleanup(
            registry,
            { owner: "standalone-server", role: "server", id: "scheduler.stop" },
            async () => opts.scheduler!.stop(),
          );
        }

        runner = {
          server: preparedServer,
          shutdown,
          waitForShutdown(): Promise<void> {
            if (shuttingDown && shutdownPromise) return shutdownPromise;
            return new Promise<void>((resolve) => {
              shutdownDoneWaiters.push(resolve);
            });
          },
        };
        opts.context.requestShutdown = (reason: string) => {
          void shutdown(reason);
        };
        await opts.beforeActivate?.(runner);
      },
    };
    const server = opts.lifecycleOwner
      ? await startServerWithActivationFailureOwner(startOptions, opts.lifecycleOwner)
      : await startServer(startOptions);

    if (!runner) {
      throw new Error("Server activation completed without lifecycle ownership");
    }

    // 4. 可选候选健康门在激活后、任何发现/ready 发布前运行。
    await opts.beforePublish?.(server);
    await assertStartupActive();

    // 5. 写 PID / port 发现文件。若失败，同一 registry 会关闭已激活入口并补偿。
    if (opts.lifecycleOwner) {
      await opts.lifecycleOwner.publishDiscovery(server);
    } else if (!opts.skipProcessLock) {
      await acquireLock(server.port, {
        ...opts.lockPaths,
        ...opts.processInfo,
        host: opts.processInfo?.host ?? server.host,
      });
      processLockAcquired = true;
    }

    await assertStartupActive();
    await opts.publishReady?.(runner);
    await assertStartupActive();
    logger.info(`Server listening on http://${server.host}:${server.port}`);
  } catch (error) {
    await shutdown("startup-error").catch(() => {});
    throw error;
  }

  // 6. start/open/publication 全部成立后才安装进程信号入口。
  const activeRunner = runner;

  const prepareSignalShutdown = async (reason: string): Promise<void> => {
    const lifecycle = opts.context.lifecycleShutdown;
    if (lifecycle) {
      await lifecycle.prepare({
        requestId: `signal:${opts.context.startedAt}:${reason}`,
        reason,
        strategy: "immediate",
        timeoutMs: 30_000,
      });
    }
    await shutdown(reason);
  };

  // 7. 信号处理器
  if (!opts.skipSignalHandlers) {
    let sigintCount = 0;
    const onSigterm = () => {
      void prepareSignalShutdown("SIGTERM").then(
        () => process.exit(0),
        (error) => logger.error(`SIGTERM shutdown is blocked: ${String(error)}`),
      );
    };
    const onSigint = () => {
      sigintCount += 1;
      if (sigintCount >= 2) {
        logger.warn("Received repeated SIGINT while safe shutdown is still pending");
        return;
      }
      void prepareSignalShutdown("SIGINT").then(
        () => process.exit(0),
        (error) => logger.error(`SIGINT shutdown is blocked: ${String(error)}`),
      );
    };

    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);

    // SIGUSR1 — 本 Level 等同 SIGTERM（无 supervisor 不做自动重启）；Windows 跳过
    if (process.platform !== "win32") {
      process.once("SIGUSR1", () => {
        void prepareSignalShutdown("SIGUSR1-restart").then(
          () => process.exit(0),
          (error) => logger.error(`SIGUSR1 shutdown is blocked: ${String(error)}`),
        );
      });
    }
  }

  return activeRunner;
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
