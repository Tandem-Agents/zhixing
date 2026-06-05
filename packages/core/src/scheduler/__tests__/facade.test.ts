import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { Scheduler } from "../scheduler.js";
import { JsonTaskStore } from "../task-store.js";
import { LocalSchedulerFacade } from "../facade.js";
import { createEventBus } from "../../events/event-bus.js";
import type { SchedulerEventMap } from "../events.js";
import type { SchedulerFacadeEvent } from "../facade.js";
import type { AgentTurnResult } from "../types.js";

describe("LocalSchedulerFacade", () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = join(await createTempDir("facade"), "tasks.json");
  });

  function setup(runAgentTurn?: () => Promise<AgentTurnResult>) {
    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new Scheduler({
      store: new JsonTaskStore(storePath),
      eventBus,
      runAgentTurn:
        runAgentTurn ?? (async () => ({ status: "ok", output: "done", durationMs: 1 })),
    });
    const facade = new LocalSchedulerFacade(scheduler, eventBus);
    return { scheduler, eventBus, facade };
  }

  const futureOnce = () =>
    ({
      name: "t",
      enabled: true,
      priority: "normal" as const,
      schedule: { kind: "once" as const, at: new Date(Date.now() + 999_999).toISOString() },
      action: { kind: "agent-turn" as const, prompt: "x" },
    });

  it("create / list / update / delete 经门面", async () => {
    const { scheduler, facade } = setup();
    await scheduler.start();

    const task = await facade.create(futureOnce());
    expect(task.id).toBeTruthy();
    expect(await facade.list()).toHaveLength(1);

    const updated = await facade.update(task.id, { name: "renamed" });
    expect(updated.name).toBe("renamed");
    expect((await facade.list())[0]!.name).toBe("renamed");

    await facade.delete(task.id);
    expect(await facade.list()).toHaveLength(0);

    await scheduler.stop();
  });

  it("run 经门面执行任务", async () => {
    const mockRun = vi
      .fn<[], Promise<AgentTurnResult>>()
      .mockResolvedValue({ status: "ok", output: "ran", durationMs: 5 });
    const { scheduler, facade } = setup(mockRun);
    await scheduler.start();

    const task = await facade.create(futureOnce());
    const result = await facade.run(task.id);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("ran");
    expect(mockRun).toHaveBeenCalledOnce();

    await scheduler.stop();
  });

  it("onEvent 映射 completed（成功 / 失败）且可取消", async () => {
    let shouldFail = false;
    const { scheduler, eventBus, facade } = setup(async () =>
      shouldFail
        ? { status: "error", error: "boom", durationMs: 1 }
        : { status: "ok", output: "ok", durationMs: 1 },
    );
    await scheduler.start();

    const events: SchedulerFacadeEvent[] = [];
    const off = facade.onEvent((e) => events.push(e));

    const okTask = await facade.create(futureOnce());
    await facade.run(okTask.id);

    shouldFail = true;
    const failTask = await facade.create({ ...futureOnce(), name: "t2" });
    await facade.run(failTask.id);

    const completed = events.filter((e) => e.kind === "completed");
    expect(completed.some((e) => e.kind === "completed" && e.status === "ok")).toBe(true);
    expect(completed.some((e) => e.kind === "completed" && e.status === "error")).toBe(true);

    // 取消后不再收到事件
    const before = events.length;
    off();
    await eventBus.emit("scheduler:task-started", {
      taskId: "z",
      name: "z",
      actionKind: "agent-turn",
    });
    expect(events.length).toBe(before);

    await scheduler.stop();
  });

  it("onEvent 不派发内部维护任务的运行事件（结果触达静默）", async () => {
    const { scheduler, eventBus, facade } = setup();
    await scheduler.start();
    await scheduler.ensureSystemTask({
      id: "__gc",
      name: "gc",
      handler: "__gc",
      schedule: { kind: "interval", everyMs: 60_000 },
    });

    const events: SchedulerFacadeEvent[] = [];
    facade.onEvent((e) => events.push(e));

    // system:true 任务的事件在门面触达边界被 isInternal 拦掉，不到消费者。
    await eventBus.emit("scheduler:task-completed", {
      taskId: "__gc",
      name: "gc",
      durationMs: 1,
    });
    expect(events).toHaveLength(0);

    await scheduler.stop();
  });
});
