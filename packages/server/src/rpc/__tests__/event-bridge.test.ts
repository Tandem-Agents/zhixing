/**
 * event-bridge 内部任务过滤 —— 守护「结果触达：内部维护静默」这条分流。
 *
 * 内部任务（system:true）的运行事件不得广播给 client；外部任务正常广播。
 * 过滤由注入的 isInternalTask 谓词推导（与 channel 投递、facade.onEvent 同一边界语义）。
 */

import { describe, it, expect, vi } from "vitest";
import { createEventBus, type SchedulerEventMap } from "@zhixing/core";
import { createEventBridge } from "../event-bridge.js";
import type { RpcConnection } from "../connection.js";

function fakeConn(): RpcConnection & { notify: ReturnType<typeof vi.fn> } {
  return {
    authenticated: true,
    closed: false,
    notify: vi.fn(),
  } as unknown as RpcConnection & { notify: ReturnType<typeof vi.fn> };
}

describe("event-bridge 内部任务过滤", () => {
  it("isInternalTask 命中的任务事件不广播，外部任务正常广播", async () => {
    const bus = createEventBus<SchedulerEventMap>();
    const conn = fakeConn();
    createEventBridge({
      connections: new Set([conn]),
      schedulerEventBus: bus,
      isInternalTask: (taskId) => taskId === "__gc",
    });

    await bus.emit("scheduler:task-completed", {
      taskId: "__gc",
      name: "gc",
      durationMs: 1,
    });
    expect(conn.notify).not.toHaveBeenCalled();

    await bus.emit("scheduler:task-completed", {
      taskId: "u1",
      name: "user",
      durationMs: 2,
    });
    expect(conn.notify).toHaveBeenCalledWith(
      "schedule.completed",
      expect.objectContaining({ taskId: "u1", status: "ok" }),
    );
  });

  it("started / failed / disabled 同样按 isInternalTask 过滤", async () => {
    const bus = createEventBus<SchedulerEventMap>();
    const conn = fakeConn();
    createEventBridge({
      connections: new Set([conn]),
      schedulerEventBus: bus,
      isInternalTask: (taskId) => taskId === "__gc",
    });

    await bus.emit("scheduler:task-started", {
      taskId: "__gc",
      name: "gc",
      actionKind: "system-handler",
    });
    await bus.emit("scheduler:task-failed", {
      taskId: "__gc",
      name: "gc",
      error: "boom",
      consecutiveErrors: 1,
    });
    await bus.emit("scheduler:task-disabled", {
      taskId: "__gc",
      name: "gc",
      reason: "x",
    });
    expect(conn.notify).not.toHaveBeenCalled();
  });

  it("不传 isInternalTask 时全部广播（向后兼容）", async () => {
    const bus = createEventBus<SchedulerEventMap>();
    const conn = fakeConn();
    createEventBridge({
      connections: new Set([conn]),
      schedulerEventBus: bus,
    });

    await bus.emit("scheduler:task-completed", {
      taskId: "__gc",
      name: "gc",
      durationMs: 1,
    });
    expect(conn.notify).toHaveBeenCalledOnce();
  });
});
