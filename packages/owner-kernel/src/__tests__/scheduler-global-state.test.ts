import type { TaskView } from "@zhixing/core";
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

const surface = {
    connectionId: "connection-1",
    surfacePrincipal: "rpc:cli-1",
    deviceId: "device-1",
    ingressId: "ingress-1",
    receivedAt: "2026-08-02T00:00:00.000Z",
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

    const created = await port.commitCreate({
      spec: {
        name: "daily",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "summarize" },
      },
      operation: { operationId: "create-1", surface },
    });
    await port.commitUpdate({
      taskId: created.id,
      spec: { ...created, name: "renamed" },
      operation: { operationId: "update-1", expectedRevision: 3, surface },
    });
    await port.commitDelete({
      taskId: created.id,
      operation: { operationId: "delete-1", expectedRevision: 3, surface },
    });

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

    await port.run({
      taskId: "task-1",
      operation: { operationId: "run-1", surface },
    });
    await port.abort({
      runId: "job-1",
      operation: { operationId: "cancel-1", surface },
    });

    expect(mutate).not.toHaveBeenCalled();
    const expectedSource = {
      connectionId: surface.connectionId,
      ingress: expect.objectContaining({
        kind: "first-party",
        surfacePrincipal: surface.surfacePrincipal,
        deviceId: surface.deviceId,
        ingressId: surface.ingressId,
        receivedAt: surface.receivedAt,
      }),
    };
    expect(runTask).toHaveBeenCalledWith("task-1", "run-1", expectedSource);
    expect(abortRun).toHaveBeenCalledWith("job-1", "cancel-1", expectedSource);
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
      port.commitUpdate({
        taskId: "task-1",
        spec: { ...task("task-1"), name: "renamed" },
        operation: { operationId: "update-1", expectedRevision: 0 },
      }),
    ).rejects.toThrow("observed task revision");
    await expect(
      port.commitDelete({
        taskId: "task-1",
        operation: { operationId: "delete-1", expectedRevision: 0 },
      }),
    ).rejects.toThrow("observed task revision");
    expect(mutate).not.toHaveBeenCalled();
  });
});
