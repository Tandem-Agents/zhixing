import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { ScheduledTask } from "@zhixing/core";
import {
  readSchedulerSummarySync,
  shouldEnsureOnStartup,
  hasNearExternalTask,
} from "../scheduler-projection.js";

function writeStore(path: string, tasks: ScheduledTask[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, tasks }), "utf-8");
}

function task(o: {
  id: string;
  nextRunAt?: string;
  enabled?: boolean;
  system?: boolean;
}): ScheduledTask {
  return {
    id: o.id,
    name: o.id,
    enabled: o.enabled ?? true,
    priority: "normal",
    schedule: { kind: "interval", everyMs: 60_000 },
    action: { kind: "agent-turn", prompt: "x" },
    state: { consecutiveErrors: 0, runCount: 0, nextRunAt: o.nextRunAt },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    system: o.system,
  };
}

const far = () => new Date(Date.now() + 10 * 3_600_000).toISOString();
const soon = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

describe("scheduler-projection", () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = join(await createTempDir("proj"), "scheduler.json");
  });

  describe("shouldEnsureOnStartup", () => {
    it("文件不存在 → true（全新需 seed 系统维护）", () => {
      expect(shouldEnsureOnStartup(storePath)).toBe(true);
    });

    it("无内部任务行 → true（未 seed = 逾期，破死锁）", () => {
      writeStore(storePath, [task({ id: "u1", nextRunAt: far() })]);
      expect(shouldEnsureOnStartup(storePath)).toBe(true);
    });

    it("内部任务逾期 → true", () => {
      writeStore(storePath, [task({ id: "__gc", system: true, nextRunAt: past() })]);
      expect(shouldEnsureOnStartup(storePath)).toBe(true);
    });

    it("近期外部任务 → true（守候到触发）", () => {
      writeStore(storePath, [
        task({ id: "__gc", system: true, nextRunAt: far() }),
        task({ id: "u1", nextRunAt: soon() }),
      ]);
      expect(shouldEnsureOnStartup(storePath)).toBe(true);
    });

    it("内部未逾期 + 仅远期外部 → false（纯空闲，不拉后台）", () => {
      writeStore(storePath, [
        task({ id: "__gc", system: true, nextRunAt: far() }),
        task({ id: "u1", nextRunAt: far() }),
      ]);
      expect(shouldEnsureOnStartup(storePath)).toBe(false);
    });
  });

  describe("readSchedulerSummarySync", () => {
    it("只纳入外部任务（isInternal 过滤内部维护）", () => {
      writeStore(storePath, [
        task({ id: "__gc", system: true, nextRunAt: soon() }),
        task({ id: "u1", nextRunAt: soon() }),
      ]);
      const summary = readSchedulerSummarySync(storePath);
      expect(summary.active.map((a) => a.name)).toEqual(["u1"]);
    });

    it("文件不存在 → 空摘要", () => {
      const summary = readSchedulerSummarySync(storePath);
      expect(summary.active).toEqual([]);
    });
  });

  describe("hasNearExternalTask（idle reaper / 启动守候 共用判据）", () => {
    const now = Date.now();

    it("近期外部任务 → true（守候到触发）", () => {
      expect(hasNearExternalTask([task({ id: "u1", nextRunAt: soon() })], now)).toBe(true);
    });

    it("仅近期内部任务 → false（internal 容忍延迟、不守候、不钉宿主，决策5）", () => {
      // 核心修复回归：idle reaper 不该被 internal 维护任务钉成常驻。
      expect(
        hasNearExternalTask(
          [task({ id: "__gc", system: true, nextRunAt: soon() })],
          now,
        ),
      ).toBe(false);
    });

    it("近期内部 + 远期外部 → false（窗口内只有 internal 不算守候）", () => {
      expect(
        hasNearExternalTask(
          [
            task({ id: "__gc", system: true, nextRunAt: soon() }),
            task({ id: "u1", nextRunAt: far() }),
          ],
          now,
        ),
      ).toBe(false);
    });

    it("仅远期外部 → false；disabled 外部近期 → false；无 nextRunAt / 空集 → false", () => {
      expect(hasNearExternalTask([task({ id: "u1", nextRunAt: far() })], now)).toBe(false);
      expect(
        hasNearExternalTask([task({ id: "u1", enabled: false, nextRunAt: soon() })], now),
      ).toBe(false);
      expect(hasNearExternalTask([task({ id: "u1" })], now)).toBe(false);
      expect(hasNearExternalTask([], now)).toBe(false);
    });

    it("自定义 windowMs 生效", () => {
      const t = task({ id: "u1", nextRunAt: new Date(now + 5_000).toISOString() });
      expect(hasNearExternalTask([t], now, 1_000)).toBe(false); // 5s 任务 / 1s 窗口
      expect(hasNearExternalTask([t], now, 10_000)).toBe(true); // 5s 任务 / 10s 窗口
    });
  });
});
