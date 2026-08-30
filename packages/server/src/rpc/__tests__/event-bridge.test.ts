import type { ScheduleRuntimeEvent } from "@zhixing/core/scheduler/application";
import { createEventBridge } from "@zhixing/rpc";
import { describe, expect, it, vi } from "vitest";
import type { RpcConnection } from "../connection.js";

function fakeConn(authenticated = true): RpcConnection & { notify: ReturnType<typeof vi.fn> } {
  return {
    authenticated,
    closed: false,
    notify: vi.fn(),
  } as unknown as RpcConnection & { notify: ReturnType<typeof vi.fn> };
}

function eventSource() {
  let handler: ((event: ScheduleRuntimeEvent) => void) | undefined;
  return {
    source: {
      onEvent(next: (event: ScheduleRuntimeEvent) => void) {
        handler = next;
        return () => {
          handler = undefined;
        };
      },
    },
    emit(event: ScheduleRuntimeEvent) {
      handler?.(event);
    },
    active: () => handler !== undefined,
  };
}

describe("Schedule product-event RPC bridge", () => {
  it("maps the four public notification names without reinterpreting domain events", () => {
    const events = eventSource();
    const conn = fakeConn();
    createEventBridge({ connections: new Set([conn]), scheduleRuntimeEvents: events.source });

    events.emit({ kind: "accepted", taskId: "task", jobRunId: "job", name: "daily" });
    events.emit({ kind: "started", taskId: "task", name: "daily" });
    events.emit({
      kind: "completed",
      taskId: "task",
      name: "daily",
      status: "ok",
      durationMs: 2,
      summary: "done",
    });
    events.emit({
      kind: "completed",
      taskId: "task",
      name: "daily",
      status: "error",
      error: "boom",
      consecutiveErrors: 2,
    });
    events.emit({ kind: "disabled", taskId: "task", name: "daily", reason: "limit" });

    expect(conn.notify.mock.calls).toEqual([
      ["schedule.accepted", { taskId: "task", jobRunId: "job", name: "daily" }],
      ["schedule.started", { taskId: "task", name: "daily" }],
      ["schedule.completed", {
        taskId: "task",
        name: "daily",
        status: "ok",
        durationMs: 2,
        summary: "done",
      }],
      ["schedule.completed", {
        taskId: "task",
        name: "daily",
        status: "error",
        error: "boom",
        consecutiveErrors: 2,
      }],
      ["schedule.disabled", { taskId: "task", name: "daily", reason: "limit" }],
    ]);
  });

  it("only notifies authenticated connections and disposes the subscription", () => {
    const events = eventSource();
    const authenticated = fakeConn();
    const anonymous = fakeConn(false);
    const dispose = createEventBridge({
      connections: new Set([authenticated, anonymous]),
      scheduleRuntimeEvents: events.source,
    });
    expect(events.active()).toBe(true);
    events.emit({ kind: "started", taskId: "task", name: "daily" });
    expect(authenticated.notify).toHaveBeenCalledOnce();
    expect(anonymous.notify).not.toHaveBeenCalled();
    dispose();
    expect(events.active()).toBe(false);
  });
});
