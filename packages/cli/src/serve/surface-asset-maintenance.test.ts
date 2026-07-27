import { describe, expect, it, vi } from "vitest";
import type { SurfaceAssetCoordinator } from "@zhixing/core/authority";
import { currentMaintenanceUrgency } from "@zhixing/core/resources";
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
