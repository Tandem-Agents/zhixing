import type {
  DeferredGlobalIntentPort,
  ScheduleTaskSpecDto,
  ScheduleWriteMutation,
} from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DEFERRED_SCHEDULE_MESSAGE,
  DeferredScheduleIntentProducer,
} from "./deferred-schedule-intent.js";

const NOW = "2026-08-07T10:00:00.000Z";
const SPEC: ScheduleTaskSpecDto = {
  name: "daily summary",
  enabled: true,
  priority: "normal",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  action: { kind: "agent-turn", prompt: "summarize" },
};

describe("DeferredScheduleIntentProducer", () => {
  it("records every complete schedule write as time-sensitive and returns only deferred state", async () => {
    const record = vi.fn<DeferredGlobalIntentPort["record"]>(async () => ({
      intentId: "int-01K1ZZZZZZ0000000000000000",
    }));
    const producer = new DeferredScheduleIntentProducer({
      intents: { record, list: async () => [], decide: async () => undefined },
      now: () => NOW,
    });
    const mutations: readonly ScheduleWriteMutation[] = [
      { kind: "schedule-create", spec: SPEC },
      { kind: "schedule-update", taskId: "task-a", spec: SPEC, taskRevision: 2 },
      { kind: "schedule-set-state", taskId: "task-a", state: "disabled", taskRevision: 3 },
      { kind: "schedule-delete", taskId: "task-a", taskRevision: 4 },
    ];

    for (const [index, mutation] of mutations.entries()) {
      await expect(producer.record({
        conversationId: "local-conversation-a",
        requestId: `schedule-request-${index}`,
        mutation,
      })).resolves.toEqual({
        kind: "deferred",
        intentId: "int-01K1ZZZZZZ0000000000000000",
        message: DEFERRED_SCHEDULE_MESSAGE,
      });
    }
    expect(record).toHaveBeenCalledTimes(4);
    expect(record.mock.calls.every((call) => call[2] === true)).toBe(true);
    expect(record.mock.calls[0]?.[3]).toEqual({
      principal: { kind: "host", component: "local-schedule-intent" },
      requestId: "schedule-request-0",
      deadlineAt: "2026-08-07T10:00:30.000Z",
    });
    expect("list" in producer || "run" in producer || "abort" in producer).toBe(false);
  });

  it("rejects an incomplete write before the durable port and never reports success on failure", async () => {
    const record = vi.fn<DeferredGlobalIntentPort["record"]>(async () => {
      throw new Error("append failed");
    });
    const producer = new DeferredScheduleIntentProducer({
      intents: { record, list: async () => [], decide: async () => undefined },
      now: () => NOW,
    });
    await expect(producer.record({
      conversationId: "local-conversation-a",
      requestId: "invalid",
      mutation: { kind: "schedule-update", taskId: "task-a", spec: SPEC } as ScheduleWriteMutation,
    })).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    await expect(producer.record({
      conversationId: "local-conversation-a",
      requestId: "write-failure",
      mutation: { kind: "schedule-delete", taskId: "task-a", taskRevision: 1 },
    })).rejects.toThrow("append failed");
  });
});
