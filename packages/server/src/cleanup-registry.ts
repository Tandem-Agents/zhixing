/**
 * CleanupRegistry — LIFO 栈式清理链
 *
 * 作用：让 server / CLI 的所有退出路径（SIGTERM、SIGINT、uncaughtException、
 * `server.shutdown` RPC、正常退出）走同一条清理链，消除"某处忘了清理 PID 文件"
 * 之类的散弹式 bug。
 *
 * 设计要点：
 * - **无业务感知**：不知道 scheduler / channels / delivery / stateFile 是什么，
 *   只接受 `(name, fn)` 对。
 * - **LIFO 语义**：最后注册者最先执行（构造/析构镜像关系）。注册顺序需是
 *   期望执行顺序的**倒序**。
 * - **独立 try/catch**：单个 cleanup 函数失败不中断链。logger 记录错误。
 * - **幂等**：重复调用 runAll 第二次直接 no-op。
 * - **reason 参数**：cleanup 函数可感知为什么被触发（signal / error / rpc / graceful）。
 *
 * 扩展点：
 * - S2.5 AgentOrchestrator 可将背景 agent cleanup 注册进来
 * - Step 18 Active Hours 可注册时段计时器清理
 * - Level 2 OS 服务可扩容资源限制复位
 */

export interface CleanupLogger {
  info?: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
  debug?: (msg: string) => void;
}

export interface CleanupRegistryOptions {
  logger?: CleanupLogger;
}

export type CleanupFn = (reason: string) => Promise<void> | void;

interface CleanupEntry {
  name: string;
  fn: CleanupFn;
}

export class CleanupRegistry {
  private entries: CleanupEntry[] = [];
  private ran = false;
  private logger: CleanupLogger;

  constructor(opts: CleanupRegistryOptions = {}) {
    this.logger = opts.logger ?? {
      error: (msg, err) => console.error(`[cleanup] ${msg}`, err ?? ""),
    };
  }

  /**
   * 注册一个清理项。
   *
   * LIFO 语义：最后注册者最先执行。期望执行顺序的**倒序**注册。
   *
   * `fn` 抛错不中断链——错误由 logger 记录。
   */
  register(name: string, fn: CleanupFn): void {
    if (this.ran) {
      this.logger.error(`register("${name}") after runAll — ignored`);
      return;
    }
    this.entries.push({ name, fn });
  }

  /**
   * 按 LIFO 顺序展开所有清理项。幂等——重复调用第二次直接 no-op。
   *
   * 单项失败仅记录到 logger，不抛不中断链；保证所有项都被尝试执行。
   */
  async runAll(reason: string): Promise<void> {
    if (this.ran) return;
    this.ran = true;

    this.logger.info?.(`cleanup runAll (${this.entries.length} entries, reason="${reason}")`);

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      try {
        this.logger.debug?.(`cleanup → ${entry.name}`);
        await entry.fn(reason);
      } catch (err) {
        this.logger.error(`cleanup "${entry.name}" failed`, err);
      }
    }
  }

  /** 当前已注册的条目数（便于断言）*/
  get size(): number {
    return this.entries.length;
  }

  /** 是否已执行过 runAll */
  get finished(): boolean {
    return this.ran;
  }
}
