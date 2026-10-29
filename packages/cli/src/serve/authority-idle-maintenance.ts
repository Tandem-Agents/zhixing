import { runWithMaintenanceUrgency } from "@zhixing/core/resources";

// 授权日志投影的空闲维护：就绪后先留出启动窗口，此后按周期在前台安静时推进
const AUTHORITY_IDLE_FIRST_DELAY_MS = 5_000;
const AUTHORITY_IDLE_INTERVAL_MS = 30_000;

export interface AuthorityIdleMaintenanceLog {
  maintainIdleProjections(betweenSteps: () => Promise<void>, signal: AbortSignal): Promise<void>;
}

export interface AuthorityIdleMaintenanceOptions {
  readonly logs: readonly AuthorityIdleMaintenanceLog[];
  /** 等前台安静；每个投影开始前与每个整理步之间调用，前台到来时在步边界让路。 */
  readonly whenQuiet: (signal: AbortSignal) => Promise<void>;
  readonly onError?: (error: Error) => void;
  readonly firstDelayMs?: number;
  readonly intervalMs?: number;
}

/**
 * 授权日志投影的空闲维护：完成挂起的段整理、发布已有进度，使正常退出后的下次启动不在关键链上回放
 * 整场尾部。后台维护等级、随时可放弃；停止时中止并等进行中的步骤在边界停下，检查点仍由日志自己的
 * 停止路径保存。
 */
export class AuthorityIdleMaintenance {
  #timer: NodeJS.Timeout | undefined;
  #task: Promise<void> | undefined;
  #stopped = false;
  #started = false;
  readonly #abort = new AbortController();

  constructor(private readonly options: AuthorityIdleMaintenanceOptions) {}

  start(): void {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    this.#schedule(this.options.firstDelayMs ?? AUTHORITY_IDLE_FIRST_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#abort.abort();
    await this.#task;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const task: Promise<void> = this.#run().catch((error: unknown) => {
        if (this.#stopped) return;
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => {
        if (this.#task === task) this.#task = undefined;
        this.#schedule(this.options.intervalMs ?? AUTHORITY_IDLE_INTERVAL_MS);
      });
      this.#task = task;
    }, delayMs);
    this.#timer.unref();
  }

  #run(): Promise<void> {
    const signal = this.#abort.signal;
    const betweenSteps = () => this.options.whenQuiet(signal);
    return runWithMaintenanceUrgency(() => "background", signal, async () => {
      for (const log of this.options.logs) {
        if (signal.aborted) return;
        await log.maintainIdleProjections(betweenSteps, signal);
      }
    }, () => true);
  }
}
