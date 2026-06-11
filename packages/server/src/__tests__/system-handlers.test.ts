/**
 * 系统任务薄壳 handler 测试 —— 验证"只触发、只转摘要、不含算法"的壳契约。
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildSystemHandlers,
  buildTranscriptGcHandler,
} from "../system-handlers.js";

describe("buildTranscriptGcHandler", () => {
  it("未注入 runSweep → no-op 报告未配置（不报错）", async () => {
    const handler = buildTranscriptGcHandler();
    const result = await handler();
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("not configured");
  });

  it("sweep 成功 → 计数转入 summary（含 warnings 数）", async () => {
    const runSweep = vi.fn(async () => ({
      conversationsScanned: 5,
      shardsDeleted: 3,
      snapshotsDeleted: 2,
      warnings: ["x: locked"],
    }));
    const handler = buildTranscriptGcHandler({ runSweep });

    const result = await handler();

    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(result.summary).toBe(
      "transcript-gc: conversations=5 shards=3 snapshots=2 warnings=1",
    );
  });

  it("sweep 抛错 → status=error、message 透传", async () => {
    const handler = buildTranscriptGcHandler({
      runSweep: async () => {
        throw new Error("disk gone");
      },
    });

    const result = await handler();

    expect(result.status).toBe("error");
    expect(result.summary).toBe("disk gone");
  });
});

describe("buildSystemHandlers", () => {
  it("注册表含全部内置 handler（__transcript-gc 在列）", () => {
    const map = buildSystemHandlers();
    expect([...map.keys()].sort()).toEqual([
      "__health-check",
      "__journal-gc",
      "__transcript-gc",
    ]);
  });
});
