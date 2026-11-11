import { describe, expect, it } from "vitest";
import { createEventBus } from "@zhixing-ai/core/events";
import { DEFAULT_LOG_POLICY, LogRecorder, type LogCapture, type LogStatus } from "@zhixing-ai/core/logging";
import type { AgentEventMap } from "@zhixing-ai/core/types";
import { KERNEL_LOG_SOURCE, observeKernelRun } from "../logging.js";

// 重试首因摘要经真实事件映射与记录器捕获落进日志：捕获只取声明字段，未声明的 cause 会被静默丢掉
describe("kernel retry logs carry the bounded cause summary", () => {
  it("records cause on retry and exhausted events through the real capture schema", async () => {
    const captures: LogCapture[] = [];
    const status: LogStatus = { storeId: "fixture-store", layout: "zxlog/1", policy: { version: 1, effective: DEFAULT_LOG_POLICY }, bytes: 0, files: 0, retainedSegments: 0, pendingReclaims: 0, overdue: false, upper: 0 };
    const recorder = new LogRecorder({
      initialize: async () => status,
      append: async (batch) => { captures.push(...structuredClone(batch)); return status; },
      maintain: async () => status,
      close: async () => {},
    });
    const bus = createEventBus<AgentEventMap>();
    const dispose = observeKernelRun(bus, recorder.bind(KERNEL_LOG_SOURCE, { scope: "storage" }));
    const cause = "Error ← TypeError ← AggregateError ECONNREFUSED ← Error ECONNREFUSED connect ×2";
    await bus.emit("retry:attempt", { errorType: "network", attempt: 1, maxRetries: 3, delayMs: 10, willRetry: true, cause });
    await bus.emit("retry:exhausted", { errorType: "network", totalAttempts: 4, lastError: "Connection error.", cause });
    dispose();
    await recorder.close(3000);
    expect(recorder.health().captureFailures).toBe(0);
    const byEvent = (event: string) => captures.map((capture) => capture.record).find((record) => record.event === event);
    expect(byEvent("retry")?.data).toMatchObject({ attempt: 1, cause });
    expect(byEvent("exhausted")?.data).toMatchObject({ error: "Connection error.", attempt: 4, cause });
  });
});
