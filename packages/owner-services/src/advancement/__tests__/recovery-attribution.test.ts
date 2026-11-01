/**
 * 推进恢复的 1 秒轮询发起的存储读取带固定归属标签 advancement:recovery（只记录，不改轮询与恢复语义）。
 */
import { afterEach, expect, it, vi } from "vitest";
import { currentLogAttributionRefs } from "@zhixing/core/logging";
import { createAdvancementRecoveryMaintenance, type AdvancementRecoveryMaintenanceOptions } from "../recovery-maintenance.js";

afterEach(() => { vi.useRealTimers(); });

it("轮询里经待恢复会话目录发起的读取带 advancement:recovery", async () => {
  vi.useFakeTimers();
  const seen: unknown[] = [];
  const pending: NonNullable<AdvancementRecoveryMaintenanceOptions["pending"]> = {
    list: async () => {
      await Promise.resolve();
      seen.push(currentLogAttributionRefs());
      return { conversationIds: [] };
    },
    cleanup: async () => ({ items: [] }),
    run: async () => undefined,
  };
  const maintenance = createAdvancementRecoveryMaintenance({
    advancement: {} as never, reviews: {} as never, directory: { list: async () => [] } as never,
    proxyTurns: {} as never, reviewResults: {} as never, pending,
  });
  maintenance.start();
  await vi.advanceTimersByTimeAsync(1_000);
  await maintenance.stop();
  expect(seen[0]).toEqual([{ kind: "caller", id: "advancement:recovery" }]);
});
