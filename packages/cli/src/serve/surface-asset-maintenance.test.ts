import { describe, expect, it, vi } from "vitest";
import type { SurfaceAssetCoordinator } from "@zhixing/core/authority";
import {
  currentMaintenanceAbortSignal,
  currentMaintenanceUrgency,
  StorageMaintenanceTaskRunner,
  storageMaintenanceObligation,
} from "@zhixing/core/resources";
import {
  SurfaceAssetMaintenance,
  shouldContinueSurfaceAssetCollection,
} from "./surface-asset-maintenance.js";

function coordinatorReturning(
  results: readonly {
    processed: number;
    removed: number;
    hasMore: boolean;
  }[],
): { readonly port: SurfaceAssetCoordinator; readonly calls: () => number } {
  let call = 0;
  const port = {
    collectExpiredTemporaryAssets: async () => {
      const result = results[Math.min(call, results.length - 1)]!;
      call += 1;
      return result;
    },
  } as unknown as SurfaceAssetCoordinator;
  return { port, calls: () => call };
}

describe("surface asset collection scheduling", () => {
it("declares the background blocking relation for the periodic round", async () => {
    // 调度器是这轮回收的顶层所有者:紧急度必须由它声明,叶级不自报。
    // 把断言落在“回收内部观测到的语境”上——删掉声明,这里就会读到缺省值。
    const seen: string[] = [];
    const port = {
      collectExpiredTemporaryAssets: async () => {
        seen.push(currentMaintenanceUrgency());
        return { processed: 0, removed: 0, hasMore: false };
      },
    } as unknown as SurfaceAssetCoordinator;
    const maintenance = new SurfaceAssetMaintenance({
      surfaceAssets: port,
      intervalMs: 1_000,
      onError: () => undefined,
    });
    await maintenance.start();
    await maintenance.stop();
    expect(seen).toEqual(["background"]);
  });

  it("continues only when a pending batch made progress", () => {
    expect(shouldContinueSurfaceAssetCollection({
      processed: 1,
      removed: 0,
      hasMore: true,
    })).toBe(true);
    expect(shouldContinueSurfaceAssetCollection({
      processed: 0,
      removed: 0,
      hasMore: true,
    })).toBe(false);
    expect(shouldContinueSurfaceAssetCollection({
      processed: 1,
      removed: 1,
      hasMore: false,
    })).toBe(false);
  });
});

describe("surface asset maintenance", () => {
  it("opens without waiting for the first collection and drains that same task on stop", async () => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const collect = vi.fn(async (nextSignal: AbortSignal) => {
      signal = nextSignal;
      await new Promise<void>(resolve => { finish = resolve; });
      return { processed: 0, removed: 0, hasMore: false };
    });
    const maintenance = new SurfaceAssetMaintenance({
      surfaceAssets: { collectExpiredTemporaryAssets: collect } as unknown as SurfaceAssetCoordinator,
    });
    await maintenance.start();
    await maintenance.start();
    expect(collect).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = maintenance.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("stops only its owned collection obligation", async () => {
    const stopCollectionMaintenance = vi.fn();
    const stopStorageMaintenance = vi.fn();
    const port = {
      collectExpiredTemporaryAssets: async () => ({
        processed: 0,
        removed: 0,
        hasMore: false,
      }),
      stopCollectionMaintenance,
      stopStorageMaintenance,
    } as unknown as SurfaceAssetCoordinator;
    const maintenance = new SurfaceAssetMaintenance({
      surfaceAssets: port,
      intervalMs: 60_000,
    });

    await maintenance.start();
    await maintenance.stop();

    expect(stopCollectionMaintenance).toHaveBeenCalledTimes(1);
    expect(stopStorageMaintenance).not.toHaveBeenCalled();
  });

  it("collects once on start and then on every interval", async () => {
    vi.useFakeTimers();
    try {
      const { port, calls } = coordinatorReturning([
        { processed: 0, removed: 0, hasMore: false },
      ]);
      const maintenance = new SurfaceAssetMaintenance({
        surfaceAssets: port,
        intervalMs: 1_000,
      });
      await maintenance.start();
      // 启动即回收一轮：单机锚点不能等到第一个周期才开始释放占用。
      expect(calls()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls()).toBe(2);
      await maintenance.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays idempotent when start races with itself", async () => {
    vi.useFakeTimers();
    try {
      const { port, calls } = coordinatorReturning([
        { processed: 0, removed: 0, hasMore: false },
      ]);
      const maintenance = new SurfaceAssetMaintenance({
        surfaceAssets: port,
        intervalMs: 1_000,
      });
      // 并发 start 不得各自装一个定时器：第二个会覆盖第一个并永久泄漏。
      await Promise.all([maintenance.start(), maintenance.start()]);
      expect(calls()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls()).toBe(2);
      await maintenance.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps draining while batches make progress and stops when they do not", async () => {
    const { port, calls } = coordinatorReturning([
      { processed: 4, removed: 4, hasMore: true },
      { processed: 0, removed: 0, hasMore: true },
    ]);
    const maintenance = new SurfaceAssetMaintenance({
      surfaceAssets: port,
      intervalMs: 60_000,
    });
    await maintenance.start();
    // 有进展立即续跑一次；零进展必须停下等下一个周期，不得忙等。
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls()).toBe(2);
    await maintenance.stop();
  });

  it("reports collection failures without stopping the schedule", async () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      let call = 0;
      const port = {
        collectExpiredTemporaryAssets: async () => {
          call += 1;
          if (call === 1) throw new Error("collection boom");
          return { processed: 0, removed: 0, hasMore: false };
        },
      } as unknown as SurfaceAssetCoordinator;
      const maintenance = new SurfaceAssetMaintenance({
        surfaceAssets: port,
        intervalMs: 1_000,
        onError: (error) => errors.push(error.message),
      });
      await maintenance.start();
      expect(errors).toEqual(["collection boom"]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(call).toBe(2);
      await maintenance.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("surface asset index idle maintenance", () => {
  it("waits out the startup window, repeats in the background and stops with the owner", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      let checkpoints = 0;
      const port = {
        collectExpiredTemporaryAssets: async () => ({ processed: 0, removed: 0, hasMore: false }),
        maintainLedgerIndex: async () => { seen.push(currentMaintenanceUrgency()); },
        checkpointLedgerIndex: async () => { checkpoints += 1; },
      } as unknown as SurfaceAssetCoordinator;
      const maintenance = new SurfaceAssetMaintenance({
        surfaceAssets: port, intervalMs: 3_600_000, indexFirstDelayMs: 60_000, indexIntervalMs: 30_000, onError: () => undefined,
      });
      await maintenance.start();
      // 启动窗口内不追平索引，避免与启动步骤争用容量。
      await vi.advanceTimersByTimeAsync(59_000);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toEqual(["background"]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(seen).toHaveLength(2);
      // 停止只发布检查点一次，不再新起追平；此后不再运行。
      await maintenance.stop();
      expect({ maintained: seen.length, checkpoints }).toEqual({ maintained: 2, checkpoints: 1 });
      await vi.advanceTimersByTimeAsync(120_000);
      expect({ maintained: seen.length, checkpoints }).toEqual({ maintained: 2, checkpoints: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts each index round only after the foreground has been quiet", async () => {
    vi.useFakeTimers();
    try {
      let maintained = 0;
      let release!: () => void;
      const quiet = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve) => { release = resolve; }));
      const port = {
        collectExpiredTemporaryAssets: async () => ({ processed: 0, removed: 0, hasMore: false }),
        maintainLedgerIndex: async () => { maintained += 1; },
        checkpointLedgerIndex: async () => undefined,
      } as unknown as SurfaceAssetCoordinator;
      const maintenance = new SurfaceAssetMaintenance({
        surfaceAssets: port, intervalMs: 3_600_000, indexFirstDelayMs: 0, indexIntervalMs: 30_000, onError: () => undefined,
        whenQuiet: quiet,
      });
      await maintenance.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(quiet).toHaveBeenCalledOnce();
      expect(maintained).toBe(0);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(maintained).toBe(1);
      await maintenance.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts in-flight idle maintenance at stop and returns only after the work stopped", async () => {
    // 空闲维护义务是 committed 的：仅撤掉等待者不会让它停下。停止必须连同义务一起中止，
    // stop 返回之时不得仍有维护在写派生索引，也不再新起一轮。
    const runner = new StorageMaintenanceTaskRunner();
    let running = false;
    let started = 0;
    let stepsAfterStop = 0;
    let stopped = false;
    const port = {
      collectExpiredTemporaryAssets: async () => ({ processed: 0, removed: 0, hasMore: false }),
      checkpointLedgerIndex: async () => undefined,
      maintainLedgerIndex: () => (started += 1, runner.run(
        storageMaintenanceObligation("lifecycle-reconcile", "surface-test", { head: 1 }, { owner: "artifact-lifecycle-index", obligation: "committed" }),
        currentMaintenanceAbortSignal(),
        async (signal) => {
          running = true;
          try {
            // 步骤边界检查取消；每步都是一次真实等待，模拟大索引上的长追平。
            while (!signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              if (stopped) stepsAfterStop += 1;
            }
          } finally {
            running = false;
          }
        },
      )),
    } as unknown as SurfaceAssetCoordinator;
    const maintenance = new SurfaceAssetMaintenance({
      surfaceAssets: port, intervalMs: 3_600_000, indexFirstDelayMs: 0, indexIntervalMs: 10, onError: () => undefined,
    });
    await maintenance.start();
    while (!running) await new Promise((resolve) => setTimeout(resolve, 5));
    const startedAt = Date.now();
    await maintenance.stop();
    stopped = true;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect({ running, started }).toEqual({ running: false, started: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stepsAfterStop).toBe(0);
  });
});
