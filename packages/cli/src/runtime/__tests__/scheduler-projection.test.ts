import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { ScheduledTask } from "@zhixing/core";
import {
  readSchedulerSummarySync,
  shouldEnsureOnStartup,
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

    it("有用户任务（近期）→ true（启动 ensure + 运行期保活）", () => {
      writeStore(storePath, [
        task({ id: "__gc", system: true, nextRunAt: far() }),
        task({ id: "u1", nextRunAt: soon() }),
      ]);
      expect(shouldEnsureOnStartup(storePath)).toBe(true);
    });

    it("有用户任务（远期）→ true（不挑触发远近，运行期必达）", () => {
      writeStore(storePath, [
        task({ id: "__gc", system: true, nextRunAt: far() }),
        task({ id: "u1", nextRunAt: far() }),
      ]);
      expect(shouldEnsureOnStartup(storePath)).toBe(true);
    });

    it("内部未逾期 + 无用户任务 → false（无定时任务，零后台）", () => {
      writeStore(storePath, [task({ id: "__gc", system: true, nextRunAt: far() })]);
      expect(shouldEnsureOnStartup(storePath)).toBe(false);
    });

    it("内部未逾期 + 用户任务 disabled/无 nextRunAt → false（不算有效用户任务）", () => {
      writeStore(storePath, [
        task({ id: "__gc", system: true, nextRunAt: far() }),
        task({ id: "u1", enabled: false, nextRunAt: soon() }),
        task({ id: "u2", nextRunAt: undefined }),
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
});
