import type {
  SurfaceAssetCollectionResult,
  SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import { runInMaintenanceContext, runWithMaintenanceUrgency } from "@zhixing/core/resources";

const SURFACE_ASSET_GC_INTERVAL_MS = 60 * 60 * 1_000;
// 派生索引的空闲维护：启动后先留出启动窗口，此后按较短周期追平并排空过期、退休、接管与临时任务。
// 每轮在前台安静时才开始，所以启动窗口不必长到覆盖整段会话：短会话正常退出前也能发布覆盖位置。
const SURFACE_ASSET_INDEX_FIRST_DELAY_MS = 5 * 1_000;
const SURFACE_ASSET_INDEX_INTERVAL_MS = 30 * 1_000;

/** 只有取得进展才立即续跑,零进展必须等下一个周期,避免忙等。 */
export function shouldContinueSurfaceAssetCollection(
  result: SurfaceAssetCollectionResult,
): boolean {
  return result.hasMore && result.processed > 0;
}

export interface SurfaceAssetMaintenanceOptions {
  readonly surfaceAssets: SurfaceAssetCoordinator | (() => SurfaceAssetCoordinator);
  readonly onError?: (error: Error) => void;
  readonly intervalMs?: number;
  readonly indexFirstDelayMs?: number;
  readonly indexIntervalMs?: number;
  /** 索引空闲维护每轮开始前等待前台安静；不提供时立即开始。 */
  readonly whenQuiet?: (signal: AbortSignal) => Promise<void>;
}

/**
 * 会话内容资产的周期回收。
 *
 * 回收是锚点权威的生命周期治理义务,不属于任何传输层:它必须在全部生产拓扑下
 * 都有持有者。此前该调度挂在只于多机拓扑创建的 mesh 控制面运行时上,默认单机
 * 锚点因而永不回收临时件与已释放叶——所有权归位后,单机与多机共用同一调度、
 * 同一有界批次语义。
 */
export class SurfaceAssetMaintenance {
  #timer: NodeJS.Timeout | undefined;
  #indexTimer: NodeJS.Timeout | undefined;
  #indexTask: Promise<void> | undefined;
  #task: Promise<void> | undefined;
  #continuation: NodeJS.Immediate | undefined;
  #stopped = false;
  #started = false;
  #finalized = false;
  readonly #abort = new AbortController();
  // 空闲维护与停止前最后一次追平各自可中止：停止或超时后不得仍在后台写派生索引。
  readonly #indexAbort = new AbortController();

  constructor(private readonly options: SurfaceAssetMaintenanceOptions) {}

  /**
   * 启动即调度首轮后台回收,不把常规 GC 放到输入就绪的等待链上。
   * 首轮与后续轮次共用任务、取消和关闭责任。重复调用为幂等。
   *
   * 标志位在首轮回收之前置位:否则第二次调用会在首轮 await 期间穿过检查,
   * 装上第二个定时器并覆盖第一个,留下一个再也无法清除的泄漏。
   */
  async start(): Promise<void> {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    void this.#collect();
    if (this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.#collect();
    }, this.options.intervalMs ?? SURFACE_ASSET_GC_INTERVAL_MS);
    this.#timer.unref();
    this.#scheduleIndexMaintenance(this.options.indexFirstDelayMs ?? SURFACE_ASSET_INDEX_FIRST_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    this.#surfaceAssets().stopCollectionMaintenance?.();
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#indexTimer) {
      clearTimeout(this.#indexTimer);
      this.#indexTimer = undefined;
    }
    if (this.#continuation) {
      clearImmediate(this.#continuation);
      this.#continuation = undefined;
    }
    this.#indexAbort.abort();
    await this.#task;
    await this.#indexTask;
    // 停止只发布派生索引已有的有界覆盖层与源向量，不新起追尾、排空或整轮合并：未覆盖的尾部受
    // 源端追加准入预算约束，由下次启动追平；没做完的维护任务留给下次的后台维护续做。
    if (this.#started && !this.#finalized) {
      this.#finalized = true;
      await this.#surfaceAssets().checkpointLedgerIndex?.().catch(() => undefined);
    }
  }

  // 空闲维护随时可放弃：取消即连同它发起的维护义务一起中止，并等它们在步骤边界停下才返回。
  #maintainIndex(signal: AbortSignal): Promise<void> {
    return runWithMaintenanceUrgency(() => "background", signal, async () => {
      if (signal.aborted) return;
      await this.options.whenQuiet?.(signal);
      if (signal.aborted) return;
      await this.#surfaceAssets().maintainLedgerIndex?.();
    }, () => true);
  }

  #scheduleIndexMaintenance(delayMs: number): void {
    if (this.#stopped) return;
    this.#indexTimer = setTimeout(() => {
      this.#indexTimer = undefined;
      // 与回收批次错开：回收本身会追平索引，这一轮跳过即可。
      const run: Promise<void> = this.#task ? Promise.resolve() : this.#maintainIndex(this.#indexAbort.signal).catch((error: unknown) => {
        if (this.#stopped) return;
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
      const tracked: Promise<void> = run.finally(() => {
        if (this.#indexTask === tracked) this.#indexTask = undefined;
        this.#scheduleIndexMaintenance(this.options.indexIntervalMs ?? SURFACE_ASSET_INDEX_INTERVAL_MS);
      });
      this.#indexTask = tracked;
    }, delayMs);
    this.#indexTimer.unref();
  }

  #collect(): Promise<void> {
    if (this.#task) return this.#task;
    let task!: Promise<void>;
    task = this.#collectBatch().finally(() => {
      if (this.#task === task) this.#task = undefined;
    });
    this.#task = task;
    return task;
  }

  async #collectBatch(): Promise<void> {
    try {
      // 调度器只声明阻塞关系,不持整批次 permit:回收内部会交替调用物理删除与
      // 权威状态更新,外层持 permit 会让内层的生命周期准入嵌套在自己之内,单槽
      // 设备上直接自锁。容量在叶级物理步骤各自取得。
      const result = await runInMaintenanceContext("background", () =>
        this.#surfaceAssets().collectExpiredTemporaryAssets(
          this.#abort.signal,
        ),
      );
      if (
        shouldContinueSurfaceAssetCollection(result) &&
        !this.#stopped &&
        !this.#continuation
      ) {
        this.#continuation = setImmediate(() => {
          this.#continuation = undefined;
          void this.#collect();
        });
        this.#continuation.unref();
      }
    } catch (error) {
      if (this.#stopped) return;
      this.options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  #surfaceAssets(): SurfaceAssetCoordinator {
    return typeof this.options.surfaceAssets === "function"
      ? this.options.surfaceAssets()
      : this.options.surfaceAssets;
  }
}
