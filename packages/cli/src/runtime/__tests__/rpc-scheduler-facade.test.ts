import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { RpcSchedulerFacade } from "../rpc-scheduler-facade.js";
import { JsonTaskStore } from "@zhixing/core";
import type { SchedulerFacadeEvent } from "@zhixing/core";
import { makeFakeHostLink, makeUnreachableHostLink } from "./fake-host-link.js";

describe("RpcSchedulerFacade", () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = join(await createTempDir("rpcfacade"), "scheduler.json");
  });

  it("list 读 scheduler.json 投影、不连宿主", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();
    await store.addTask({
      id: "t1",
      name: "x",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "p" },
      state: { consecutiveErrors: 0, runCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const facade = new RpcSchedulerFacade({
      connection: makeUnreachableHostLink(),
      storePath,
    });

    const list = await facade.list();
    expect(list.map((t) => t.id)).toEqual(["t1"]);
  });

  it("create / run 走 RPC", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) =>
      method === "schedule.create"
        ? { id: "new1" }
        : { status: "ok", durationMs: 3 },
    );
    const facade = new RpcSchedulerFacade({ connection: fake.link, storePath });

    const task = await facade.create({
      name: "x",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "p" },
    });
    expect(task.id).toBe("new1");

    const result = await facade.run("new1");
    expect(result.status).toBe("ok");
    expect(fake.requests).toContainEqual({
      method: "schedule.run",
      params: { id: "new1" },
    });
  });

  it("onEvent 映射 RPC notification（completed 含 error）", async () => {
    const fake = makeFakeHostLink();
    const facade = new RpcSchedulerFacade({ connection: fake.link, storePath });

    const events: SchedulerFacadeEvent[] = [];
    facade.onEvent((e) => events.push(e));

    fake.notify("schedule.completed", {
      taskId: "t1",
      name: "x",
      status: "error",
      error: "boom",
    });
    expect(events).toContainEqual({
      kind: "completed",
      taskId: "t1",
      name: "x",
      status: "error",
      durationMs: undefined,
      summary: undefined,
      error: "boom",
    });
  });

  it("onEvent 返回的退订函数解除全部订阅", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcSchedulerFacade({ connection: fake.link, storePath });

    const events: SchedulerFacadeEvent[] = [];
    const off = facade.onEvent((e) => events.push(e));
    expect(fake.handlerCount("schedule.started")).toBe(1);

    off();
    expect(fake.handlerCount("schedule.started")).toBe(0);
    fake.notify("schedule.completed", { taskId: "t1", name: "x", status: "ok" });
    expect(events).toEqual([]);
  });
});
