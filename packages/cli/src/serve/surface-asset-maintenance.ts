import type {
  SurfaceAssetCollectionResult,
  SurfaceAssetCoordinator,
} from "@zhixing/core/authority";
import { runInMaintenanceContext } from "@zhixing/core/resources";

const SURFACE_ASSET_GC_INTERVAL_MS = 60 * 60 * 1_000;

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
  #task: Promise<void> | undefined;
  #continuation: NodeJS.Immediate | undefined;
  #stopped = false;
  #started = false;
  readonly #abort = new AbortController();

  constructor(private readonly options: SurfaceAssetMaintenanceOptions) {}

  /**
   * 启动时先回收一轮,随后按固定周期驱动。重复调用为幂等。
   *
   * 标志位在首轮回收之前置位:否则第二次调用会在首轮 await 期间穿过检查,
   * 装上第二个定时器并覆盖第一个,留下一个再也无法清除的泄漏。
   */
  async start(): Promise<void> {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    await this.#collect();
    if (this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.#collect();
    }, this.options.intervalMs ?? SURFACE_ASSET_GC_INTERVAL_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    this.#surfaceAssets().stopCollectionMaintenance?.();
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#continuation) {
      clearImmediate(this.#continuation);
      this.#continuation = undefined;
    }
    await this.#task;
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
