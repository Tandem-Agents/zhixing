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

  it("内部维护任务即便配了 delivery 也静默（结果触达边界拦截）", async () => {
    const enqueue = vi.fn().mockResolvedValue("dlv_internal");
    const mockDelivery = { enqueue, flush: vi.fn(), stats: vi.fn() };
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "internal result",
      durationMs: 10,
    });

    const store = new JsonTaskStore(join(tempDir, "tasks.json"));
    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store,
      eventBus,
      runAgentTurn: mockRun,
      delivery: mockDelivery,
    });
    await scheduler.start();

    // system:true + agent-turn + 显式 delivery：即便配了投递目标，内部任务结果也不
    // 触达用户——enqueueDelivery 在边界用 isInternal 拦掉（区别于「无 target 跳过」）。
    await store.addTask({
      id: "__internal-agent",
      name: "internal-agent",
      enabled: true,
      priority: "low",
      schedule: {
        kind: "once",
        at: new Date(Date.now() + 999_999).toISOString(),
      },
      action: { kind: "agent-turn", prompt: "x" },
      delivery: { kind: "channel", channel: "feishu", to: "u1" },
      state: { consecutiveErrors: 0, runCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      system: true,
    });

    await scheduler.runTask("__internal-agent");

    expect(enqueue).not.toHaveBeenCalled();
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

  it("宿主离线期间错过的任务（应触发于上线前）记为「错过」、不补、推进 nextRunAt", async () => {
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "done",
      durationMs: 10,
    });
    const storePath = join(tempDir, "offline-missed.json");
    let currentNow = new Date("2026-01-01T00:00:00.000Z");

    // session 1：创建任务（nextRunAt=00:01:00）后下线
    const s1 = createTestScheduler({
      storePath,
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await s1.scheduler.start();
    const task = await s1.scheduler.createTask({
      name: "periodic",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "x" },
    });
    const originalNextRun = task.state.nextRunAt!; // 00:01:00
    await s1.scheduler.stop();

    // 离线期间时间快进过 nextRunAt + grace；session 2 重新上线（onlineSince=01:00:00）
    currentNow = new Date("2026-01-01T01:00:00.000Z");
    const s2 = createTestScheduler({
      storePath,
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await s2.scheduler.start();
    await s2.scheduler["timerLoop"].tick();

    // 应触发于上线之前 → 离线期间错过 → 记录不补、推进 nextRunAt
    expect(mockRun).not.toHaveBeenCalled();
    const updated = s2.scheduler.getTask(task.id)!;
    expect(updated.state.lastMissed?.scheduledFor).toBe(originalNextRun);
    expect(new Date(updated.state.nextRunAt!).getTime()).toBeGreaterThan(
      currentNow.getTime(),
    );

    await s2.scheduler.stop();
  });

  it("在线到点的任务被推迟远超容差也不误判错过（锚定上线时刻、不随 now 漂移）", async () => {
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "done",
      durationMs: 10,
    });
    let currentNow = new Date("2026-01-01T00:00:00.000Z");
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "online-late.json"),
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await scheduler.start(); // onlineSince = 00:00:00

    const task = await scheduler.createTask({
      name: "periodic",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "x" },
    });

    // nextRunAt=00:01:00 在上线之后；now 快进到 01:00:00（迟到 59min 远超 grace）。
    // 这是在线延迟（非离线错过）——必须执行、绝不误判错过。
    currentNow = new Date("2026-01-01T01:00:00.000Z");
    await scheduler["timerLoop"].tick();

    expect(mockRun).toHaveBeenCalledOnce();
    expect(scheduler.getTask(task.id)!.state.lastMissed).toBeUndefined();

    await scheduler.stop();
  });

  it("once 任务离线期间错过 → terminal（disable + 清 nextRunAt）", async () => {
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "done",
      durationMs: 10,
    });
    const storePath = join(tempDir, "once-missed.json");
    let currentNow = new Date("2026-01-01T00:00:00.000Z");

    const s1 = createTestScheduler({
      storePath,
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await s1.scheduler.start();
    const task = await s1.scheduler.createTask({
      name: "once-remind",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" },
      action: { kind: "agent-turn", prompt: "x" },
    });
    await s1.scheduler.stop();

    currentNow = new Date("2026-01-01T01:00:00.000Z");
    const s2 = createTestScheduler({
      storePath,
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await s2.scheduler.start();
    await s2.scheduler["timerLoop"].tick();

    expect(mockRun).not.toHaveBeenCalled();
    const updated = s2.scheduler.getTask(task.id)!;
    expect(updated.enabled).toBe(false);
    expect(updated.state.nextRunAt).toBeUndefined();
    expect(updated.state.lastMissed?.scheduledFor).toBe(
      "2026-01-01T00:01:00.000Z",
    );

    await s2.scheduler.stop();
  });

  it("重启间隙内错过的任务（应触发于上线前、但只离线了容差内）补执行、不记错过", async () => {
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "done",
      durationMs: 10,
    });
    const storePath = join(tempDir, "restart-gap.json");
    let currentNow = new Date("2026-01-01T00:00:00.000Z");

    // session 1：创建任务（nextRunAt=00:01:00）后下线
    const s1 = createTestScheduler({
      storePath,
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await s1.scheduler.start();
    const task = await s1.scheduler.createTask({
      name: "periodic",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "x" },
    });
    await s1.scheduler.stop();

    // 重启间隙：只离线 30s（< grace 90s）。s2 上线 00:01:30 → onlineSince-grace=00:00:00；
    // scheduledFor=00:01:00 落在 [onlineSince-grace, onlineSince) → 容差内、补执行、非错过。
    currentNow = new Date("2026-01-01T00:01:30.000Z");
    const s2 = createTestScheduler({
      storePath,
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await s2.scheduler.start();
    await s2.scheduler["timerLoop"].tick();

    expect(mockRun).toHaveBeenCalledOnce();
    expect(s2.scheduler.getTask(task.id)!.state.lastMissed).toBeUndefined();

    await s2.scheduler.stop();
  });

  it("迟到落在容差窗口内的过期任务仍准时执行", async () => {
    const mockRun = vi.fn<[], Promise<AgentTurnResult>>().mockResolvedValue({
      status: "ok",
      output: "done",
      durationMs: 10,
    });
    let currentNow = new Date("2026-01-01T00:00:00.000Z");
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
      runAgentTurn: mockRun,
      now: () => currentNow,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "periodic",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "x" },
    });

    // nextRunAt = 00:01:00；快进到 00:01:30（迟到 30s < grace 90s）
    currentNow = new Date("2026-01-01T00:01:30.000Z");
    await scheduler["timerLoop"].tick();

    expect(mockRun).toHaveBeenCalledOnce();
    expect(scheduler.getTask(task.id)!.state.lastMissed).toBeUndefined();

    await scheduler.stop();
  });

  it("系统维护任务关闭期间错过 → 补跑一次（不像用户任务那样跳过）", async () => {
    const handlerFn = vi
      .fn()
      .mockResolvedValue({ status: "ok", summary: "gc done" });
    const storePath = join(tempDir, "internal-missed.json");
    let currentNow = new Date("2026-01-01T00:00:00.000Z");

    const make = () =>
      new Scheduler({
        store: new JsonTaskStore(storePath),
        eventBus: createEventBus<SchedulerEventMap>(),
        runAgentTurn: async () => ({ status: "ok", output: "", durationMs: 0 }),
        systemHandlers: new Map([["__test-gc", handlerFn]]),
        now: () => currentNow,
      });

    // session 1：seed 系统维护任务（cron 每分钟 → nextRunAt=00:01:00）后下线
    const s1 = make();
    await s1.start();
    await s1.ensureSystemTask({
      id: "__test-gc",
      name: "test-gc",
      handler: "__test-gc",
      schedule: { kind: "cron", expr: "* * * * *" },
    });
    await s1.stop();

    // 关闭期间快进过 nextRunAt + grace；session 2 重新上线（onlineSince=01:00:00）
    currentNow = new Date("2026-01-01T01:00:00.000Z");
    const s2 = make();
    await s2.start();
    await s2.ensureSystemTask({
      id: "__test-gc",
      name: "test-gc",
      handler: "__test-gc",
      schedule: { kind: "cron", expr: "* * * * *" },
    }); // 幂等：已存在不动，nextRunAt 仍逾期
    await s2["timerLoop"].tick();

    // 系统维护任务错过即补跑（与用户任务「不补」相反）：handler 被调用、补跑后 advance
    // 到未来、不记 lastMissed。
    expect(handlerFn).toHaveBeenCalledOnce();
    const updated = s2.getTask("__test-gc")!;
    expect(updated.state.lastMissed).toBeUndefined();
    expect(new Date(updated.state.nextRunAt!).getTime()).toBeGreaterThan(
      currentNow.getTime(),
    );

    await s2.stop();
  });

  it("同一 task 并发执行时第二个被拒绝（守卫下沉 executeSingleTask）", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const mockRun = vi
      .fn<[], Promise<AgentTurnResult>>()
      .mockImplementation(async () => {
        await firstGate; // 阻塞第一个 run，制造 in-flight 窗口
        return { status: "ok", output: "done", durationMs: 10 };
      });
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
      runAgentTurn: mockRun,
    });
    await scheduler.start();

    const task = await scheduler.createTask({
      name: "long-task",
      enabled: true,
      priority: "normal",
      schedule: { kind: "once", at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn", prompt: "x" },
    });

    // 第一个 run 启动并阻塞在 gate（activeTasks 已记入）
    const first = scheduler.runTask(task.id);
    // 第二个 run 在第一个 in-flight 时进入——应被守卫拒绝
    const second = await scheduler.runTask(task.id);
    expect(second.status).toBe("error");
    expect(second.error).toContain("already running");

    // 放行第一个，确认只有它真正执行
    releaseFirst();
    expect((await first).status).toBe("ok");
    expect(mockRun).toHaveBeenCalledOnce();

    await scheduler.stop();
  });

  it("ensureSystemTask: 固定 id seed-if-absent、幂等、system 不可删", async () => {
    const { scheduler } = createTestScheduler({
      storePath: join(tempDir, "tasks.json"),
    });
    await scheduler.start();

    await scheduler.ensureSystemTask({
      id: "__journal-gc",
      name: "journal-gc",
      handler: "__journal-gc",
      schedule: { kind: "cron", expr: "0 3 * * *" },
    });

    const tasks = scheduler.listTasks();
    expect(tasks).toHaveLength(1);
    const seeded = scheduler.getTask("__journal-gc")!;
    expect(seeded.system).toBe(true);
    expect(seeded.action).toEqual({ kind: "system", handler: "__journal-gc" });
    expect(seeded.state.nextRunAt).toBeTruthy();

    // 幂等：再次调用不重复、不覆盖已有定义
    await scheduler.ensureSystemTask({
      id: "__journal-gc",
      name: "renamed",
      handler: "__journal-gc",
      schedule: { kind: "cron", expr: "0 5 * * *" },
    });
    expect(scheduler.listTasks()).toHaveLength(1);
    expect(scheduler.getTask("__journal-gc")!.name).toBe("journal-gc");

    // 系统任务不可删
    await expect(scheduler.deleteTask("__journal-gc")).rejects.toThrow(
      "Cannot delete system task",
    );

    // 系统任务不可改（对齐拒删的显式守卫）
    await expect(
      scheduler.updateTask("__journal-gc", { enabled: false }),
    ).rejects.toThrow("Cannot modify system task");

    await scheduler.stop();
  });
});
