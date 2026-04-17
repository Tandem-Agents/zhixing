import { describe, it, expect } from "vitest";
import {
  shouldDisableTask,
  computeErrorBackoff,
  applyErrorPolicy,
  resetErrorState,
} from "../error-policy.js";
import { DEFAULT_SCHEDULER_CONFIG } from "../config.js";
import type { ScheduledTask } from "../types.js";

function createTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    name: "test",
    enabled: true,
    priority: "normal",
    schedule: { kind: "interval", everyMs: 60_000 },
    action: { kind: "agent-turn", prompt: "hello" },
    state: { consecutiveErrors: 0, runCount: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ErrorPolicy", () => {
  describe("shouldDisableTask", () => {
    it("returns false when errors below threshold", () => {
      const task = createTask({ state: { consecutiveErrors: 3, runCount: 3 } });
      expect(shouldDisableTask(task, DEFAULT_SCHEDULER_CONFIG)).toBe(false);
    });

    it("returns true when errors reach threshold", () => {
      const task = createTask({ state: { consecutiveErrors: 5, runCount: 5 } });
      expect(shouldDisableTask(task, DEFAULT_SCHEDULER_CONFIG)).toBe(true);
    });
  });

  describe("computeErrorBackoff", () => {
    it("returns 0 for no errors", () => {
      expect(computeErrorBackoff(0, DEFAULT_SCHEDULER_CONFIG)).toBe(0);
    });

    it("returns a value within expected range", () => {
      // consecutiveErrors = 1 → base * 2^0 = 60_000 → jitter ∈ [0, 60_000]
      const delay = computeErrorBackoff(1, DEFAULT_SCHEDULER_CONFIG);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(60_000);
    });

    it("caps at maxDelay", () => {
      // Very high consecutive errors → should be capped
      const delay = computeErrorBackoff(20, DEFAULT_SCHEDULER_CONFIG);
      expect(delay).toBeLessThanOrEqual(DEFAULT_SCHEDULER_CONFIG.errorBackoffMaxMs);
    });
  });

  describe("applyErrorPolicy", () => {
    it("increments error count and sets next run", () => {
      const task = createTask();
      const now = new Date();
      const result = applyErrorPolicy(task, "boom", DEFAULT_SCHEDULER_CONFIG, now);

      expect(result.shouldDisable).toBe(false);
      expect(task.state.consecutiveErrors).toBe(1);
      expect(task.state.lastStatus).toBe("error");
      expect(task.state.lastError).toBe("boom");
      expect(result.nextRunAt).toBeDefined();
    });

    it("returns shouldDisable when threshold reached", () => {
      const task = createTask({
        state: { consecutiveErrors: 4, runCount: 4 },
      });
      const result = applyErrorPolicy(task, "boom", DEFAULT_SCHEDULER_CONFIG, new Date());
      expect(result.shouldDisable).toBe(true);
      expect(task.state.consecutiveErrors).toBe(5);
    });
  });

  describe("resetErrorState", () => {
    it("clears error state", () => {
      const task = createTask({
        state: { consecutiveErrors: 3, runCount: 5, lastStatus: "error", lastError: "oops" },
      });
      resetErrorState(task);
      expect(task.state.consecutiveErrors).toBe(0);
      expect(task.state.lastStatus).toBe("ok");
      expect(task.state.lastError).toBeUndefined();
    });
  });
});
