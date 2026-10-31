import { expect, it } from "vitest";
import { waitForMaintenanceRetry } from "../storage-maintenance.js";

// 背压后的等待可被取消：已取消立即返回，等待中取消提前醒来；不给信号时照常等满延迟
it("wakes a maintenance retry wait on cancellation and keeps the delay without a signal", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let started = performance.now();
  await waitForMaintenanceRetry(10_000, aborted.signal);
  expect(performance.now() - started).toBeLessThan(1_000);

  const cancelled = new AbortController();
  started = performance.now();
  setTimeout(() => cancelled.abort(), 20);
  await waitForMaintenanceRetry(10_000, cancelled.signal);
  expect(performance.now() - started).toBeLessThan(1_000);

  started = performance.now();
  await waitForMaintenanceRetry(60);
  expect(performance.now() - started).toBeGreaterThanOrEqual(50);
});
