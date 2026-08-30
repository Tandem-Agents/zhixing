import { describe, expect, it, vi } from "vitest";
import {
  createScheduleManagementProductApiContribution,
  SCHEDULE_MANAGEMENT_CREATE_COMMAND,
  SCHEDULE_MANAGEMENT_LIST_QUERY,
  SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
  ScheduleManagementApplicationError,
  ScheduleManagementApplicationService,
  type ScheduleManagementRepository,
} from "./application.js";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import type { TaskSpec, TaskView } from "./facade.js";

const NOW = "2026-08-30T00:00:00.000Z";

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    name: "morning",
    enabled: true,
    priority: "normal",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
    action: { kind: "agent-turn", prompt: "plan the day" },
    ...overrides,
  };
}

function view(id: string, revision: number, overrides: Partial<TaskView> = {}): TaskView {
  return {
    id,
    taskRevision: revision,
    ...spec(),
    state: { consecutiveErrors: 0, runCount: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function repository(initial: TaskView[] = []) {
  const tasks = new Map(initial.map((task) => [task.id, structuredClone(task)]));
  const operations = new Map<string, { payload: string; task?: TaskView }>();
  const commits: unknown[] = [];
  const port: ScheduleManagementRepository = {
    list: async () => [...tasks.values()].map((task) => structuredClone(task)),
    find: async (taskId) => {
      const task = tasks.get(taskId);
      return task ? structuredClone(task) : undefined;
    },
    commitCreate: async (input) => {
      commits.push(input);
      const payload = JSON.stringify(input.spec);
      const replay = operations.get(input.operation.operationId);
      if (replay) {
        if (replay.payload !== payload) throw new Error("conflicting payload");
        return structuredClone(replay.task!);
      }
      const task = view(`task-${input.operation.operationId}`, 1, input.spec);
      tasks.set(task.id, task);
      operations.set(input.operation.operationId, { payload, task });
      return structuredClone(task);
    },
    commitUpdate: async (input) => {
      commits.push(input);
      const payload = JSON.stringify({
        taskId: input.taskId,
        expectedRevision: input.operation.expectedRevision,
        spec: input.spec,
      });
      const replay = operations.get(input.operation.operationId);
      if (replay) {
        if (replay.payload !== payload) throw new Error("conflicting payload");
        return structuredClone(replay.task!);
      }
      const current = tasks.get(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      if (current.taskRevision !== input.operation.expectedRevision) {
        throw new Error("expected revision conflict");
      }
      const task = view(input.taskId, input.operation.expectedRevision + 1, {
        ...current,
        ...input.spec,
        taskRevision: input.operation.expectedRevision + 1,
      });
      tasks.set(task.id, task);
      operations.set(input.operation.operationId, { payload, task });
      return structuredClone(task);
    },
    commitDelete: async (input) => {
      commits.push(input);
      const payload = JSON.stringify({
        taskId: input.taskId,
        expectedRevision: input.operation.expectedRevision,
      });
      const replay = operations.get(input.operation.operationId);
      if (replay) {
        if (replay.payload !== payload) throw new Error("conflicting payload");
        return;
      }
      const current = tasks.get(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      if (current.taskRevision !== input.operation.expectedRevision) {
        throw new Error("expected revision conflict");
      }
      tasks.delete(input.taskId);
      operations.set(input.operation.operationId, { payload });
    },
  };
  return { port, tasks, commits };
}

describe("ScheduleManagementApplicationService", () => {
  it("owns create defaults, validation, stable replay and committed projection", async () => {
    const repo = repository();
    const application = new ScheduleManagementApplicationService(repo.port);
    const command = {
      kind: "create" as const,
      draft: {
        name: "morning",
        schedule: { kind: "interval" as const, everyMs: 60_000 },
        action: { kind: "agent-turn" as const, prompt: "work" },
      },
      operation: { operationId: "create-1" },
    };

    const first = await application.execute(command);
    const replay = await application.execute(command);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      kind: "created",
      task: { enabled: true, priority: "normal", taskRevision: 1 },
    });
    await expect(application.execute({
      ...command,
      draft: { ...command.draft, name: "changed" },
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(application.execute({
      ...command,
      operation: { operationId: "create-invalid" },
      draft: { ...command.draft, name: "" },
    })).rejects.toBeInstanceOf(ScheduleManagementApplicationError);
  });

  it("owns user visibility, update merge, revision conflict, not-found and system guard", async () => {
    const user = view("user", 3);
    const system = view("system", 4, {
      system: true,
      action: { kind: "system", handler: "__transcript-gc" },
    });
    const repo = repository([system, user]);
    const application = new ScheduleManagementApplicationService(repo.port);

    await expect(application.query({ kind: "list" })).resolves.toEqual({ tasks: [user] });
    const update = {
      kind: "update",
      taskId: "user",
      patch: { name: "renamed" },
      operation: { operationId: "update-1", expectedRevision: 3 },
    } as const;
    await expect(application.execute(update)).resolves.toMatchObject({
      kind: "updated",
      task: { name: "renamed", priority: "normal", taskRevision: 4 },
    });
    await expect(application.execute(update)).resolves.toMatchObject({
      kind: "updated",
      task: { name: "renamed", taskRevision: 4 },
    });
    await expect(application.execute({
      kind: "delete",
      taskId: "user",
      operation: { operationId: "delete-stale", expectedRevision: 3 },
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(application.execute({
      kind: "delete",
      taskId: "missing",
      operation: { operationId: "delete-missing", expectedRevision: 1 },
    })).rejects.toMatchObject({ code: "not-found" });
    await expect(application.execute({
      kind: "delete",
      taskId: "system",
      operation: { operationId: "delete-system", expectedRevision: 4 },
    })).rejects.toMatchObject({
      code: "system-task",
      message: "Cannot modify system task: system",
    });
    await expect(application.execute({
      kind: "update",
      taskId: "system",
      patch: { enabled: false },
      operation: { operationId: "update-system", expectedRevision: 4 },
    })).rejects.toMatchObject({
      code: "system-task",
      message: "Cannot modify system task: system",
    });
    await expect(application.execute({
      kind: "update",
      taskId: "",
      patch: { enabled: false },
      operation: { operationId: "update-empty", expectedRevision: 1 },
    })).rejects.toMatchObject({
      code: "not-found",
      message: "Task not found: ",
    });
    await expect(application.execute({
      kind: "delete",
      taskId: "",
      operation: { operationId: "delete-empty", expectedRevision: 1 },
    })).rejects.toMatchObject({
      code: "not-found",
      message: "Task not found: ",
    });
    const deletion = {
      kind: "delete",
      taskId: "user",
      operation: { operationId: "delete-1", expectedRevision: 4 },
    } as const;
    await expect(application.execute(deletion)).resolves.toEqual({
      kind: "deleted",
      taskId: "user",
    });
    await expect(application.execute(deletion)).resolves.toEqual({
      kind: "deleted",
      taskId: "user",
    });
    await expect(application.execute({
      ...deletion,
      operation: { operationId: "delete-new", expectedRevision: 4 },
    })).rejects.toMatchObject({ code: "not-found" });
  });

  it("contributes the finite Product API exact-set to one dispatcher", async () => {
    const repo = repository();
    const application = new ScheduleManagementApplicationService(repo.port);
    const dispatcher = new ProductApiDispatcher(
      SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
      [createScheduleManagementProductApiContribution(application)],
    );
    await expect(dispatcher.query(SCHEDULE_MANAGEMENT_LIST_QUERY, { kind: "list" }))
      .resolves.toEqual({ tasks: [] });
    await expect(dispatcher.command(SCHEDULE_MANAGEMENT_CREATE_COMMAND, {
      kind: "create",
      draft: {
        name: "one",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "work" },
      },
      operation: { operationId: "product-create" },
    })).resolves.toMatchObject({ result: { kind: "created" }, facts: [] });
  });

  it("rejects invalid identity before I/O and delegates revision CAS for replay-safe conflicts", async () => {
    const repo = repository([view("user", 2)]);
    const commit = vi.spyOn(repo.port, "commitUpdate");
    const application = new ScheduleManagementApplicationService(repo.port);
    await expect(application.execute({
      kind: "update",
      taskId: "user",
      patch: { enabled: false },
      operation: { operationId: "", expectedRevision: 2 },
    })).rejects.toMatchObject({ code: "invalid-command" });
    await expect(application.execute({
      kind: "update",
      taskId: "user",
      patch: { enabled: false },
      operation: { operationId: "stale", expectedRevision: 1 },
    })).rejects.toMatchObject({ code: "conflict" });
    expect(commit).toHaveBeenCalledOnce();
  });
});
