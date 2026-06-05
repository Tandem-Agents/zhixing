import { describe, it, expect } from "vitest";
import {
  computeStatusSummary,
  isInternal,
  formatSchedule,
} from "../status-summary.js";
import type { ScheduledTask } from "../types.js";

function task(
  id: string,
  opts: {
    enabled?: boolean;
    system?: boolean;
    schedule?: ScheduledTask["schedule"];
    state?: ScheduledTask["state"];
  } = {},
): ScheduledTask {
  return {
    id,
    name: id,
    enabled: opts.enabled ?? true,
    priority: "normal",
    schedule: opts.schedule ?? { kind: "interval", everyMs: 60_000 },
    action: { kind: "agent-turn", prompt: "x" },
    state: opts.state ?? { consecutiveErrors: 0, runCount: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    system: opts.system,
  };
}

describe("status-summary", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("isInternal 复用 system 标记", () => {
    expect(isInternal(task("a", { system: true }))).toBe(true);
    expect(isInternal(task("b"))).toBe(false);
  });

  it("active 只列 enabled + 有 nextRunAt 并按 nextRunAt 升序", () => {
    const tasks = [
      task("late", {
        state: { consecutiveErrors: 0, runCount: 0, nextRunAt: "2026-01-01T13:00:00.000Z" },
      }),
      task("soon", {
        state: { consecutiveErrors: 0, runCount: 0, nextRunAt: "2026-01-01T12:30:00.000Z" },
      }),
      task("disabled", {
        enabled: false,
        state: { consecutiveErrors: 0, runCount: 0, nextRunAt: "2026-01-01T12:10:00.000Z" },
      }),
      task("no-next", { state: { consecutiveErrors: 0, runCount: 0 } }),
    ];
    const s = computeStatusSummary(tasks, now);
    expect(s.active.map((a) => a.name)).toEqual(["soon", "late"]);
  });

  it("recentlyCompleted / recentlyFailed 按时间窗口 + error 区分", () => {
    const tasks = [
      task("ok-recent", {
        state: {
          consecutiveErrors: 0,
          runCount: 1,
          lastRunAt: "2026-01-01T11:50:00.000Z",
          lastSummary: "done",
        },
      }),
      task("failed-recent", {
        state: {
          consecutiveErrors: 1,
          runCount: 1,
          lastRunAt: "2026-01-01T11:55:00.000Z",
          lastError: "boom",
        },
      }),
      task("ok-old", {
        state: { consecutiveErrors: 0, runCount: 1, lastRunAt: "2026-01-01T10:00:00.000Z" },
      }),
    ];
    // 默认窗口 30 分钟 → cutoff = 11:30，ok-old(10:00) 落窗外
    const s = computeStatusSummary(tasks, now);
    expect(s.recentlyCompleted.map((c) => c.name)).toEqual(["ok-recent"]);
    expect(s.recentlyFailed.map((f) => f.name)).toEqual(["failed-recent"]);
  });

  it("formatSchedule 覆盖各调度类型", () => {
    expect(formatSchedule({ kind: "once", at: "2026-01-01T00:00:00Z" })).toBe("一次性");
    expect(formatSchedule({ kind: "interval", everyMs: 1_800_000 })).toBe("每 30 分钟");
    expect(formatSchedule({ kind: "cron", expr: "0 8 * * *" })).toBe("cron 0 8 * * *");
  });
});
