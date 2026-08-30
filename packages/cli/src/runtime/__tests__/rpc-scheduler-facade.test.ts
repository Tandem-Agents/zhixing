import { describe, it, expect } from "vitest";
import { RpcSchedulerFacade } from "../rpc-scheduler-facade.js";
import type { SchedulerFacadeEvent } from "@zhixing/core";
import { makeFakeHostLink } from "./fake-host-link.js";

describe("RpcSchedulerFacade", () => {
  it("list 从当前宿主 authority 读取，不碰本地兼容文件", async () => {
    const task = {
      id: "t1",
      name: "x",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "p" },
      state: { consecutiveErrors: 0, runCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const fake = makeFakeHostLink();
    fake.setResponder((method) => method === "schedule.list" ? [task] : undefined);
    const facade = new RpcSchedulerFacade({ connection: fake.link });

    const list = await facade.list();
    expect(list.map((t) => t.id)).toEqual(["t1"]);
    expect(fake.requests).toContainEqual({ method: "schedule.list", params: undefined });
  });

  it("create / run 走 RPC", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) =>
      method === "schedule.create"
        ? { id: "new1" }
        : { status: "ok", durationMs: 3 },
    );
    const facade = new RpcSchedulerFacade({ connection: fake.link });

    const task = await facade.create(
      {
        name: "x",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "p" },
      },
      { operationId: "schedule-create:test" },
    );
    expect(task.id).toBe("new1");

    const result = await facade.run("new1", {
      operationId: "schedule-run:test",
    });
    expect(result.status).toBe("ok");
    expect(fake.requests).toContainEqual({
      method: "schedule.run",
      params: {
        id: "new1",
        requestId: "schedule-run:test",
      },
    });
  });

  it("拒绝在 facade 内为写操作临时生成 operation id", async () => {
    const facade = new RpcSchedulerFacade({
      connection: makeFakeHostLink().link,
    });

    await expect(facade.run("task-1")).rejects.toThrow(
      "Schedule run requires a stable operation id",
    );
  });

  it("onEvent 映射 RPC notification（completed 含 error）", async () => {
    const fake = makeFakeHostLink();
    const facade = new RpcSchedulerFacade({ connection: fake.link });

    const events: SchedulerFacadeEvent[] = [];
    facade.onEvent((e) => events.push(e));

    fake.notify("schedule.accepted", {
      taskId: "t1",
      jobRunId: "j1",
      name: "x",
    });
    fake.notify("schedule.completed", {
      taskId: "t1",
      name: "x",
      status: "error",
      error: "boom",
      consecutiveErrors: 2,
    });
    expect(events).toContainEqual({
      kind: "accepted",
      taskId: "t1",
      jobRunId: "j1",
      name: "x",
    });
    expect(events).toContainEqual({
      kind: "completed",
      taskId: "t1",
      name: "x",
      status: "error",
      error: "boom",
      consecutiveErrors: 2,
    });
  });

  it("rejects malformed or extended Schedule notification payloads", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcSchedulerFacade({ connection: fake.link });
    facade.onEvent(() => undefined);

    expect(() => fake.notify("schedule.completed", {
      taskId: "t1",
      name: "x",
      status: "error",
      error: "boom",
    })).toThrow("Invalid schedule.completed notification");
    expect(() => fake.notify("schedule.accepted", {
      taskId: "t1",
      jobRunId: "j1",
      name: "x",
      extra: true,
    })).toThrow("Invalid Schedule notification payload");
  });

  it("onEvent 返回的退订函数解除全部订阅", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcSchedulerFacade({ connection: fake.link });

    const events: SchedulerFacadeEvent[] = [];
    const off = facade.onEvent((e) => events.push(e));
    expect(fake.handlerCount("schedule.started")).toBe(1);

    off();
    expect(fake.handlerCount("schedule.started")).toBe(0);
    fake.notify("schedule.completed", { taskId: "t1", name: "x", status: "ok" });
    expect(events).toEqual([]);
  });
});
