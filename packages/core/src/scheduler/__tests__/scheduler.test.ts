import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { Scheduler } from "../scheduler.js";
import { JsonTaskStore } from "../task-store.js";
import { createEventBus } from "../../events/event-bus.js";
import type { SchedulerEventMap } from "../events.js";
import type { AgentTurnResult } from "../types.js";

function createTestScheduler(options: {
  storePath: string;
  runAgentTurn?: () => Promise<AgentTurnResult>;
  now?: () => Date;
}) {
  const eventBus = createEventBus<SchedulerEventMap>();
  const store = new JsonTaskStore(options.storePath);

  const scheduler = new Scheduler({
    store,
    eventBus,
    now: options.now,
    runAgentTurn: options.runAgentTurn ?? (async () => ({
      status: "ok" as const,
      output: "done",
      durationMs: 100,
    })),
    config: {
      maxConcurrent: 2,
      minTickIntervalMs: 100,
      maxTickIntervalMs: 1000,
      maxConsecutiveErrors: 3,
      shutdownTimeoutMs: 2000,
    },
  });

  return { scheduler, eventBus, store };
}

describe("Scheduler", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("sched");
  });

  it("creates, lists, and deletes tasks", async () => {
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "greet",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "say hello" },
    });

    expect(task.id).toBeTruthy();
    expect(scheduler.listTasks()).toHaveLength(1);

    await scheduler.deleteTask(task.id);
    expect(scheduler.listTasks()).toHaveLength(0);

    await scheduler.stop();
  });

  it("refuses to delete system tasks", async () => {
    const { scheduler, store } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
    });
    await scheduler.start();

    // Directly add a system task
    await store.addTask({
      id: "sys_1",
      name: "__journal-gc",
      enabled: true,
      priority: "low",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      action: { kind: "system", handler: "__journal-gc" },
      state: { consecutiveErrors: 0, runCount: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      system: true,
    });

    await expect(scheduler.deleteTask("sys_1")).rejects.toThrow("Cannot delete system task");
    await scheduler.stop();
  });

  it("emits task-created event", async () => {
    const { scheduler, eventBus } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
    });
    await scheduler.start();

    const events: string[] = [];
    eventBus.on("scheduler:task-created", (e) => events.push(e.name));

    await scheduler.createTask({
      name: "test",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 100_000).toISOString() },
      action: { kind: "agent-turn", prompt: "hi" },
    });

    expect(events).toEqual(["test"]);
    await scheduler.stop();
  });

  it("executes a due task on manual runTask", async () => {
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "executed!",
      durationMs: 50,
    });

    const { scheduler, eventBus } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
      runAgentTurn: mockRun,
    });
    await scheduler.start();

    const completedEvents: string[] = [];
    eventBus.on("scheduler:task-completed", (e) => completedEvents.push(e.name));

    const task = await scheduler.createTask({
      name: "manual-run",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "do something" },
    });

    const result = await scheduler.runTask(task.id);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("executed!");
    expect(mockRun).toHaveBeenCalledOnce();
    expect(completedEvents).toEqual(["manual-run"]);

    await scheduler.stop();
  });

  it("auto-disables task after consecutive failures", async () => {
    let callCount = 0;
    const failingRun = vi.fn<[], Promise<AgentTurnResult>>().mockImplementation(async () => {
      callCount++;
      return { status: "error", error: `fail #${callCount}`, durationMs: 10 };
    });

    const { scheduler, eventBus } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
      runAgentTurn: failingRun,
    });

    // maxConsecutiveErrors = 3 in test config
    await scheduler.start();

    const disabledEvents: string[] = [];
    eventBus.on("scheduler:task-disabled", (e) => disabledEvents.push(e.name));

    const task = await scheduler.createTask({
      name: "doomed",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "fail" },
    });

    // Run 3 times manually to trigger auto-disable
    await scheduler.runTask(task.id);
    await scheduler.runTask(task.id);
    await scheduler.runTask(task.id);

    expect(disabledEvents).toEqual(["doomed"]);
    expect(scheduler.getTask(task.id)?.enabled).toBe(false);

    await scheduler.stop();
  });

  it("executes system handler tasks", async () => {
    const handlerFn = vi.fn().mockResolvedValue({ status: "ok", summary: "gc done" });

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async () => ({ status: "ok", output: "", durationMs: 0 }),
      systemHandlers: new Map([["__test-gc", handlerFn]]),
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "gc",
      enabled: true,
      priority: "low",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      action: { kind: "system", handler: "__test-gc" },
    });

    const result = await scheduler.runTask(task.id);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("gc done");
    expect(handlerFn).toHaveBeenCalledOnce();

    await scheduler.stop();
  });

  it("computes next run for cron schedule", async () => {
    const fixedNow = new Date("2026-04-16T10:00:00Z");
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
      now: () => fixedNow,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "daily",
      enabled: true,
      priority: "normal",
      // Use UTC timezone to get predictable results in any environment
      schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
      action: { kind: "agent-turn", prompt: "noon check" },
    });

    // Should be today at 12:00 UTC (fixedNow is 10:00 UTC, so next 12:00 is same day)
    expect(task.state.nextRunAt).toBe("2026-04-16T12:00:00.000Z");

    await scheduler.stop();
  });

  it("once tasks are disabled after successful execution", async () => {
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "one-shot",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 1000).toISOString() },
      action: { kind: "agent-turn", prompt: "do once" },
    });

    await scheduler.runTask(task.id);
    const updated = scheduler.getTask(task.id);
    expect(updated?.enabled).toBe(false);

    await scheduler.stop();
  });

  it("enqueues delivery on task success with channel delivery", async () => {
    const enqueue = vi.fn().mockResolvedValue("dlv_1");
    const mockDelivery = {
      enqueue,
      flush: vi.fn(),
      stats: vi.fn(),
    };

    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "task result",
      durationMs: 50,
    });

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: mockRun,
      delivery: mockDelivery,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "notify-me",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "check weather" },
      delivery: { kind: "channel", channel: "feishu", to: "user123" },
    });

    await scheduler.runTask(task.id);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { channelId: "feishu", to: "user123" },
        content: { text: "task result", markdown: "task result" },
        source: { kind: "scheduler", taskId: task.id, taskName: "notify-me" },
      }),
    );
    await scheduler.stop();
  });

  it("P3b: 任务带 createdInTurn 时，enqueue 的 source 透传该字段", async () => {
    const enqueue = vi.fn().mockResolvedValue("dlv_turn");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };

    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "task result",
      durationMs: 10,
    });

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: mockRun,
      delivery: mockDelivery,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "t-with-turn",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "x" },
      delivery: { kind: "channel", channel: "feishu", to: "u1" },
      createdInTurn: "turn_abc",
    });

    await scheduler.runTask(task.id);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "scheduler",
          taskId: task.id,
          createdInTurn: "turn_abc",
        }),
      }),
    );
    await scheduler.stop();
  });

  it("Issue B: interval 任务带 createdInTurn 时，enqueue 的 source 不透传该字段", async () => {
    // 规则：周期任务（interval/cron）每次 fire 时创建 turn 早已结束——
    // afterSlot 必 orphan，带出去只产生 causal-broken 告警噪音。
    const enqueue = vi.fn().mockResolvedValue("dlv_interval");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "task result",
      durationMs: 10,
    });

    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus: createEventBus<SchedulerEventMap>(),
      runAgentTurn: mockRun,
      delivery: mockDelivery,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "t-interval",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "x" },
      delivery: { kind: "channel", channel: "feishu", to: "u1" },
      createdInTurn: "turn_interval",
    });

    await scheduler.runTask(task.id);

    const call = enqueue.mock.calls[0]![0] as { source: Record<string, unknown> };
    expect(call.source).toEqual({
      kind: "scheduler",
      taskId: task.id,
      taskName: "t-interval",
    });
    expect(call.source).not.toHaveProperty("createdInTurn");
    await scheduler.stop();
  });

  it("Issue B: cron 任务带 createdInTurn 时，enqueue 的 source 不透传该字段", async () => {
    const enqueue = vi.fn().mockResolvedValue("dlv_cron");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "task result",
      durationMs: 10,
    });

    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus: createEventBus<SchedulerEventMap>(),
      runAgentTurn: mockRun,
      delivery: mockDelivery,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "t-cron",
      enabled: true,
      priority: "normal",
      schedule: { kind: "cron", expr: "0 8 * * *" },
      action: { kind: "agent-turn", prompt: "x" },
      delivery: { kind: "channel", channel: "feishu", to: "u1" },
      createdInTurn: "turn_cron",
    });

    await scheduler.runTask(task.id);

    const call = enqueue.mock.calls[0]![0] as { source: Record<string, unknown> };
    expect(call.source).not.toHaveProperty("createdInTurn");
    await scheduler.stop();
  });

  it("Issue Y: once 任务创建至今超过 SLOT_TTL 时，createdInTurn 不透传（避免远期 fire 的 orphan 噪音）", async () => {
    // 场景："明天 9 点提醒我"——创建于 turn_abc，slot TTL 10 分钟早已过，
    // 次日 fire 时若带 afterSlot=turn_abc 必定 orphan → causal-broken 噪音。
    const enqueue = vi.fn().mockResolvedValue("dlv_old");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "task result",
      durationMs: 10,
    });

    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus: createEventBus<SchedulerEventMap>(),
      runAgentTurn: mockRun,
      delivery: mockDelivery,
    });
    await scheduler.start();

    // 构造一个 11 分钟前创建的 task（伪造 createdAt 超过 SLOT_TTL=10min）
    const task = await scheduler.createTask({
      name: "t-delayed-once",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "x" },
      delivery: { kind: "channel", channel: "feishu", to: "u1" },
      createdInTurn: "turn_old",
    });
    // 直接改存储层 task.createdAt 回到 11 分钟前（超过 DEFAULT_SLOT_TTL_MS=10min）
    const oldCreatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await scheduler["store"].updateTask(task.id, { createdAt: oldCreatedAt });

    await scheduler.runTask(task.id);

    const call = enqueue.mock.calls[0]![0] as { source: Record<string, unknown> };
    expect(call.source).not.toHaveProperty("createdInTurn");
    await scheduler.stop();
  });

  it("skips delivery when task has no delivery config", async () => {
    const enqueue = vi.fn();
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async () => ({ status: "ok", output: "done", durationMs: 10 }),
      delivery: mockDelivery,
    });
    await scheduler.start();

    await scheduler.createTask({
      name: "no-delivery",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "do stuff" },
    });

    await scheduler.runTask(scheduler.listTasks()[0]!.id);
    expect(enqueue).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("skips delivery when task fails", async () => {
    const enqueue = vi.fn();
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async () => ({ status: "error", error: "oops", durationMs: 10 }),
      delivery: mockDelivery,
    });
    await scheduler.start();

    await scheduler.createTask({
      name: "will-fail",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "fail" },
      delivery: { kind: "channel", channel: "feishu", to: "user123" },
    });

    await scheduler.runTask(scheduler.listTasks()[0]!.id);
    expect(enqueue).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("delivers to task.origin when no explicit delivery", async () => {
    const enqueue = vi.fn().mockResolvedValue("dlv_origin");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async () => ({ status: "ok", output: "origin result", durationMs: 10 }),
      delivery: mockDelivery,
    });
    await scheduler.start();

    await scheduler.createTask({
      name: "with-origin",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "remind me" },
      origin: { channelId: "feishu", to: "ou_user123" },
    });

    await scheduler.runTask(scheduler.listTasks()[0]!.id);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { channelId: "feishu", to: "ou_user123" },
        content: { text: "origin result", markdown: "origin result" },
      }),
    );
    await scheduler.stop();
  });

  it("skips delivery when no origin and no explicit delivery", async () => {
    const enqueue = vi.fn();
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async () => ({ status: "ok", output: "result", durationMs: 10 }),
      delivery: mockDelivery,
    });
    await scheduler.start();

    await scheduler.createTask({
      name: "no-route",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "do something" },
    });

    await scheduler.runTask(scheduler.listTasks()[0]!.id);
    expect(enqueue).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("explicit delivery takes priority over origin", async () => {
    const enqueue = vi.fn().mockResolvedValue("dlv_exp");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };

    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(join(tempDir, "tasks.json")),
      eventBus,
      runAgentTurn: async () => ({ status: "ok", output: "explicit result", durationMs: 10 }),
      delivery: mockDelivery,
    });
    await scheduler.start();

    await scheduler.createTask({
      name: "has-explicit",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "check something" },
      delivery: { kind: "channel", channel: "feishu", to: "explicit_user" },
      origin: { channelId: "dingtalk", to: "wrong_user" },
    });

    await scheduler.runTask(scheduler.listTasks()[0]!.id);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { channelId: "feishu", to: "explicit_user" },
      }),
    );
    await scheduler.stop();
  });

  it("persists across restart", async () => {
    const storePath = join(tempDir, "tasks.json");

    // Session 1: create task
    const s1 = createTestScheduler({ storePath });
    await s1.scheduler.start();
    await s1.scheduler.createTask({
      name: "persistent",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "persist" },
    });
    await s1.scheduler.stop();

    // Session 2: reload from disk
    const s2 = createTestScheduler({ storePath });
    await s2.scheduler.start();
    expect(s2.scheduler.listTasks()).toHaveLength(1);
    expect(s2.scheduler.listTasks()[0]!.name).toBe("persistent");
    await s2.scheduler.stop();
  });
});
