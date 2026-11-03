import { describe, it, expect } from "vitest";
import { RpcSchedulerFacade } from "../rpc-scheduler-facade.js";
import type { SchedulerFacadeEvent } from "@zhixing/core/scheduler";
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

  it("定时通知按接入面游标读一页，页形状不合法时不据此推进", async () => {
    const notice = (noticeId: string, revision: number, extra: Record<string, unknown> = {}) => ({
      noticeId, revision, kind: "missed-summary", state: "prepared",
      ref: { kind: "missed-summary", batchId: noticeId, memberCount: 1 },
      reason: "设备离线期间，日报共错过 1 次执行；可查看状态并按需重新运行。", actions: ["查看任务状态"],
      at: "2026-08-02T00:00:00.000Z", audience: "first-party", ...extra,
    });
    const fake = makeFakeHostLink();
    let page: unknown = { notices: [notice("a", 5), notice("b", 5), notice("c", 7)], next: 9, more: true, source: "s" };
    fake.setResponder((method) => method === "server.info" ? page : undefined);
    const facade = new RpcSchedulerFacade({ connection: fake.link });
    await expect(facade.noticePage(4)).resolves.toEqual({
      notices: [
        { noticeId: "a", revision: 5, kind: "missed-summary", reason: expect.any(String), audience: "first-party" },
        { noticeId: "b", revision: 5, kind: "missed-summary", reason: expect.any(String), audience: "first-party" },
        { noticeId: "c", revision: 7, kind: "missed-summary", reason: expect.any(String), audience: "first-party" },
      ],
      next: 9, skip: 0, more: true, source: "s",
    });
    expect(fake.requests).toContainEqual({ method: "server.info", params: { projection: "scheduler-notices", schedulerNoticeAfter: 4 } });
    // 截在同一信封中间：最后一个修订是 next + 1，续读时带回已给出的条数
    page = { notices: [notice("a", 5), notice("b", 5)], next: 4, skip: 2, more: true, source: "s" };
    await expect(facade.noticePage(4)).resolves.toMatchObject({ next: 4, skip: 2, more: true });
    page = { notices: [notice("c", 5)], next: 9, more: false, source: "s" };
    await expect(facade.noticePage(4, 2)).resolves.toMatchObject({ next: 9, skip: 0 });
    expect(fake.requests).toContainEqual({ method: "server.info", params: { projection: "scheduler-notices", schedulerNoticeAfter: 4, schedulerNoticeSkip: 2 } });
    // 游标带代际：另一代时源端从起点读并标明换代，按 (0,0) 校验
    page = { notices: [notice("n", 1)], next: 3, more: false, source: "s2", reset: true };
    await expect(facade.noticePage(20, 1, "s1")).resolves.toMatchObject({ next: 3, skip: 0, source: "s2", reset: true });
    expect(fake.requests).toContainEqual({ method: "server.info", params: { projection: "scheduler-notices", schedulerNoticeAfter: 20, schedulerNoticeSkip: 1, schedulerNoticeSource: "s1" } });
    for (const bad of [
      // 换代却仍是游标那一代、没带代际、或未请求代际却说换代
      { notices: [], next: 0, more: false, source: "s1", reset: true },
      { notices: [], next: 0, more: false, reset: true },
      // 没标换代时代际必须就是游标那一代
      { notices: [], next: 20, more: false, source: "s2" },
    ]) {
      page = bad;
      await expect(facade.noticePage(20, 0, "s1")).rejects.toThrow(TypeError);
    }
    page = { notices: [], next: 0, more: false, source: "s2", reset: true };
    await expect(facade.noticePage(20, 0)).rejects.toThrow(TypeError);
    for (const bad of [
      { notices: [notice("a", 4)], next: 9, more: false, source: "s" },
      { notices: [notice("a", 7), notice("b", 5)], next: 9, more: false, source: "s" },
      { notices: [notice("a", 10)], next: 9, more: false, source: "s" },
      { notices: [], next: 3, more: false, source: "s" },
      { notices: [notice("a", 5, { audience: "someone" })], next: 9, more: false, source: "s" },
      { notices: [notice("a", 5, { extra: true })], next: 9, more: false, source: "s" },
      { notices: [], next: 9, more: false, source: "s", extra: 1 },
      // 续读条数只能伴随“还有更多”，显式写 0 也不收；截断页修订不能超过 next + 1；有通知却不前进不收
      { notices: [notice("a", 5)], next: 4, skip: 1, more: false, source: "s" },
      { notices: [], next: 9, skip: 0, more: true, source: "s" },
      { notices: [notice("a", 6)], next: 4, skip: 1, more: true, source: "s" },
      { notices: [notice("a", 5)], next: 4, more: true, source: "s" },
    ]) {
      page = bad;
      await expect(facade.noticePage(4)).rejects.toThrow(TypeError);
    }
  });

  it("实时定时通知只作触发，可退订", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcSchedulerFacade({ connection: fake.link });
    let arrived = 0;
    const off = facade.onNotice(() => { arrived++; });
    fake.notify("scheduler.notice", { anything: true });
    expect(arrived).toBe(1);
    off();
    fake.notify("scheduler.notice", {});
    expect(arrived).toBe(1);
  });
});
