import type {
  SchedulerControlSource,
  TaskView,
} from "@zhixing/core";
import type { GlobalStatePort } from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AnchorSchedulerProductPort,
} from "../scheduler-global-state.js";
import {
  scheduleTaskIdForRequest,
  type AnchorScheduler,
} from "../scheduler-authority.js";

function task(id: string): TaskView {
  return {
    id,
    taskRevision: 3,
    name: "daily",
    enabled: true,
    priority: "normal",
    schedule: { kind: "interval", everyMs: 60_000 },
    action: { kind: "agent-turn", prompt: "summarize" },
    state: {
      consecutiveErrors: 0,
      runCount: 0,
    },
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}

const source: SchedulerControlSource = {
  connectionId: "connection-1",
  ingress: {
    kind: "first-party",
    surfacePrincipal: "rpc:cli-1",
    deviceId: "device-1",
    ingressId: "ingress-1",
    receivedAt: "2026-08-02T00:00:00.000Z",
  },
};

describe("AnchorSchedulerProductPort", () => {
  it("routes definition writes through GlobalState with the caller identity", async () => {
    const tasks = new Map<string, TaskView>();
    const mutate = vi.fn(async (mutation: { kind: string }, context: unknown) => {
      if (mutation.kind === "schedule-create") {
        tasks.set(scheduleTaskIdForRequest("create-1"), task(scheduleTaskIdForRequest("create-1")));
      }
      return { revision: 3 };
    });
    const scheduler = {
      getTask: (id: string) => tasks.get(id),
      listTasks: () => [...tasks.values()],
      runTask: vi.fn(),
      abortRun: vi.fn(),
      activeTaskCount: 0,
    } as unknown as AnchorScheduler;
    const port = new AnchorSchedulerProductPort(
      scheduler,
      { mutate } as unknown as GlobalStatePort,
      7,
    );

    const created = await port.createTask(
      {
        name: "daily",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "summarize" },
      },
      "create-1",
      source,
    );
    await port.updateTask(created.id, { name: "renamed" }, "update-1", 3, source);
    await port.deleteTask(created.id, "delete-1", 3, source);

    expect(mutate.mock.calls.map(([mutation]) => mutation.kind)).toEqual([
      "schedule-create",
      "schedule-update",
      "schedule-delete",
    ]);
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      taskId: created.id,
      taskRevision: 3,
    });
    expect(mutate.mock.calls[2]?.[0]).toMatchObject({
      taskId: created.id,
      taskRevision: 3,
    });
    expect(mutate.mock.calls.map(([, context]) => context)).toEqual([
      expect.objectContaining({
        requestId: "create-1",
        authority: { domain: "global", anchorEpoch: 7 },
        principal: {
          kind: "surface",
          surfacePrincipal: "rpc:cli-1",
          connectionId: "connection-1",
        },
      }),
      expect.objectContaining({ requestId: "update-1" }),
      expect.objectContaining({ requestId: "delete-1" }),
    ]);
  });

  it("keeps run and cancellation in the job-control owner with one operation id", async () => {
    const runTask = vi.fn(async () => ({ status: "ok" as const, output: "done", durationMs: 1 }));
    const abortRun = vi.fn(async () => true);
    const scheduler = {
      getTask: () => task("task-1"),
      listTasks: () => [],
      runTask,
      abortRun,
      activeTaskCount: 0,
    } as unknown as AnchorScheduler;
    const mutate = vi.fn();
    const port = new AnchorSchedulerProductPort(
      scheduler,
      { mutate } as unknown as GlobalStatePort,
      7,
    );

    await port.runTask("task-1", "run-1", source);
    await port.abortRun("job-1", "cancel-1", source);

    expect(mutate).not.toHaveBeenCalled();
    expect(runTask).toHaveBeenCalledWith("task-1", "run-1", source);
    expect(abortRun).toHaveBeenCalledWith("job-1", "cancel-1", source);
  });

  it("rejects revisionless writes before reaching GlobalState", async () => {
    const mutate = vi.fn();
    const scheduler = {
      getTask: () => task("task-1"),
      listTasks: () => [],
      activeTaskCount: 0,
    } as unknown as AnchorScheduler;
    const port = new AnchorSchedulerProductPort(
      scheduler,
      { mutate } as unknown as GlobalStatePort,
      7,
    );

    await expect(
      port.updateTask("task-1", { name: "renamed" }, "update-1"),
    ).rejects.toThrow("observed task revision");
    await expect(
      port.deleteTask("task-1", "delete-1"),
    ).rejects.toThrow("observed task revision");
    expect(mutate).not.toHaveBeenCalled();
  });
});
