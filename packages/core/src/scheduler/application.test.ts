import { describe, expect, it, vi } from "vitest";
import {
  createScheduleManagementProductApiContribution,
  countScheduleConsecutiveFailures,
  type ScheduleOccurrence,
  decideScheduleFailurePolicy,
  decideScheduleTrigger,
  deriveScheduleNextRun,
  SCHEDULE_MANAGEMENT_CREATE_COMMAND,
  SCHEDULE_MANAGEMENT_LIST_QUERY,
  SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
  SCHEDULE_MANUAL_ABORT_COMMAND,
  SCHEDULE_MANUAL_RUN_COMMAND,
  ScheduleManagementApplicationError,
  ScheduleManagementApplicationService,
  ScheduleApplicationService,
  ScheduleRuntimeApplicationService,
  scheduleAutoDisableOperationId,
  scheduleTimerDelay,
  selectPendingScheduleAutoDisable,
  selectDueScheduleEntries,
  type ScheduleRuntimeSignal,
  type ScheduleLifecycleMechanismPort,
  type ScheduleRuntimeProjectionPort,
  type ScheduleManualExecutionPort,
  type ScheduleManagementRepository,
} from "./application.js";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import type { JobOccurrence, TaskDefinition } from "../contracts/state.js";
import type { TaskSpec, TaskView } from "./facade.js";
import { canonicalize } from "../protocol/canonical.js";

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

function manualExecution(): ScheduleManualExecutionPort & {
  readonly run: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => ({ status: "ok" as const, output: "done", durationMs: 2 })),
    abort: vi.fn(async ({ runId }: { readonly runId: string }) => runId !== "ghost"),
  };
}

describe("ScheduleManagementApplicationService", () => {
  it("owns create defaults, validation, stable replay and committed projection", async () => {
    const repo = repository();
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
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
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());

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
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
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
    await expect(dispatcher.command(SCHEDULE_MANUAL_RUN_COMMAND, {
      kind: "run",
      taskId: "missing",
      operation: { operationId: "product-run" },
    })).rejects.toMatchObject({ code: "not-found" });
    await expect(dispatcher.command(SCHEDULE_MANUAL_ABORT_COMMAND, {
      kind: "abort-run",
      runId: "ghost",
      operation: { operationId: "product-abort" },
    })).resolves.toEqual({
      result: { kind: "run-aborted", runId: "ghost", aborted: false },
      facts: [],
    });
  });

  it("owns manual run admission, stable execution identity and ghost cancellation result", async () => {
    const user = view("user", 3);
    const system = view("system", 1, {
      system: true,
      action: { kind: "system", handler: "__transcript-gc" },
    });
    const repo = repository([user, system]);
    const execution = manualExecution();
    const application = new ScheduleManagementApplicationService(repo.port, execution);

    await expect(application.execute({
      kind: "run",
      taskId: "user",
      operation: { operationId: "run-1" },
    })).resolves.toEqual({
      kind: "ran",
      result: { status: "ok", output: "done", durationMs: 2 },
    });
    expect(execution.run).toHaveBeenCalledWith({
      taskId: "user",
      operation: { operationId: "run-1" },
    });
    await expect(application.execute({
      kind: "run",
      taskId: "missing",
      operation: { operationId: "run-missing" },
    })).rejects.toMatchObject({ code: "not-found", message: "Task not found: missing" });
    await expect(application.execute({
      kind: "run",
      taskId: "system",
      operation: { operationId: "run-system" },
    })).rejects.toMatchObject({
      code: "system-task",
      message: "Cannot modify system task: system",
    });
    expect(execution.run).toHaveBeenCalledOnce();

    await expect(application.execute({
      kind: "abort-run",
      runId: "ghost",
      operation: { operationId: "abort-ghost" },
    })).resolves.toEqual({ kind: "run-aborted", runId: "ghost", aborted: false });
    await expect(application.execute({
      kind: "abort-run",
      runId: "job-1",
      operation: { operationId: "abort-1" },
    })).resolves.toEqual({ kind: "run-aborted", runId: "job-1", aborted: true });
    expect(execution.abort).toHaveBeenNthCalledWith(1, {
      runId: "ghost",
      operation: { operationId: "abort-ghost" },
    });
  });

  it("rejects invalid identity before I/O and delegates revision CAS for replay-safe conflicts", async () => {
    const repo = repository([view("user", 2)]);
    const commit = vi.spyOn(repo.port, "commitUpdate");
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
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

describe("Schedule runtime domain policy", () => {
  const userDefinition = {
    taskId: "task-a",
    taskRevision: 2,
    state: "enabled",
    definition: {
      kind: "user",
      spec: {
        name: "daily",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "x" },
      },
    },
  } as TaskDefinition;

  it("owns due ordering, timer delay and offline trigger identity", () => {
    const now = new Date("2026-08-30T10:00:00.000Z");
    expect(selectDueScheduleEntries(new Map([
      ["b", "2026-08-30T09:59:00.000Z"],
      ["a", "2026-08-30T09:59:00.000Z"],
      ["future", "2026-08-30T10:01:00.000Z"],
    ]), now)).toEqual([
      ["a", "2026-08-30T09:59:00.000Z"],
      ["b", "2026-08-30T09:59:00.000Z"],
    ]);
    expect(scheduleTimerDelay(
      ["2026-08-30T10:00:00.250Z"],
      now,
      1_000,
    )).toBe(250);

    const missed = decideScheduleTrigger({
      taskId: "task-a",
      scheduledFor: "2026-08-30T09:00:00.000Z",
      definition: userDefinition,
      onlineSince: now.getTime(),
      missedGraceMs: 30_000,
    });
    expect(missed).toMatchObject({
      effectiveScheduledFor: "2026-08-30T09:00:00.000Z",
      disposition: "missed-offline",
      missedNextFire: {
        readyBoundary: "2026-08-30T10:00:00.000Z",
        nextFire: "2026-08-30T10:01:00.000Z",
      },
    });
    expect(missed.jobRunId).toBe("job-37bbbbed5fd87cbc8c1b2084-0e8a3550f820aef344741ad4");

    const system = decideScheduleTrigger({
      taskId: "__system",
      scheduledFor: "2026-08-30T09:00:00.000Z",
      definition: {
        taskId: "__system",
        taskRevision: 1,
        state: "enabled",
        definition: { kind: "system", handler: "__health" },
      } as TaskDefinition,
      onlineSince: now.getTime(),
      missedGraceMs: 30_000,
    });
    expect(system).toMatchObject({
      effectiveScheduledFor: "2026-08-30T10:00:00.000Z",
    });
    expect(system).not.toHaveProperty("disposition");
  });

  it("owns next-fire, failure streak and auto-disable operation identity", () => {
    const occurrences = [
      { state: "committed", scheduledFor: "2026-08-30T09:00:00.000Z" },
      { state: "missed", scheduledFor: "2026-08-30T09:01:00.000Z" },
      { state: "failed", scheduledFor: "2026-08-30T09:02:00.000Z" },
      { state: "expired", scheduledFor: "2026-08-30T09:03:00.000Z" },
    ] as JobOccurrence[];
    expect(countScheduleConsecutiveFailures(occurrences)).toBe(2);
    const businessFailures = Array.from({ length: 5 }, (_, index) => ({
      ...occurrences[0]!, jobRunId: `business-${index}`,
      scheduledFor: `2026-08-30T09:0${index}:00.000Z`,
      outcome: { status: "failed" as const, summary: "model failed" },
    })) satisfies ScheduleOccurrence[];
    expect(countScheduleConsecutiveFailures(businessFailures)).toBe(5);
    expect(decideScheduleFailurePolicy({ taskId: "task-a", jobRunId: "business-4",
      schedule: { kind: "interval", everyMs: 60_000 }, occurrences: businessFailures,
      threshold: 5, decidedAt: NOW })).toMatchObject({ failureCount: 5, autoDisableRequired: true });
    expect(countScheduleConsecutiveFailures([...businessFailures,
      { ...businessFailures[0]!, outcome: { status: "completed", summary: "recovered" } }])).toBe(0);
    expect(deriveScheduleNextRun(
      { kind: "interval", everyMs: 60_000 },
      occurrences,
      new Date(NOW),
    )).toBe("2026-08-30T09:04:00.000Z");
    expect(scheduleAutoDisableOperationId({
      taskId: "task-a",
      jobRunId: "job-a",
      taskRevision: 2,
      failureCount: 3,
    })).toMatch(/^schedule-auto-disable:sha256:[a-f0-9]{64}$/u);

    const failurePolicy = decideScheduleFailurePolicy({
      taskId: "task-a",
      jobRunId: "job-2",
      schedule: { kind: "interval", everyMs: 60_000 },
      occurrences: [
        { jobRunId: "job-1", scheduledFor: "2026-08-30T09:00:00.000Z", state: "failed" },
        { jobRunId: "job-missed", scheduledFor: "2026-08-30T09:01:00.000Z", state: "missed" },
        { jobRunId: "job-2", scheduledFor: "2026-08-30T09:02:00.000Z", state: "failed" },
      ],
      threshold: 2,
      decidedAt: "2026-08-30T09:02:01.000Z",
    });
    expect(failurePolicy).toMatchObject({
      failureCount: 2,
      threshold: 2,
      autoDisableRequired: true,
    });
    expect(failurePolicy.nextFire).toMatch(/^2026-08-30T09:/u);
    expect(() => decideScheduleFailurePolicy({
      taskId: "task-a",
      jobRunId: "missing",
      schedule: { kind: "once", at: "2026-08-30T09:00:00.000Z" },
      occurrences: [],
      threshold: 2,
      decidedAt: NOW,
    })).toThrow("Scheduler failure occurrence is absent");

    const pending = selectPendingScheduleAutoDisable([
      { jobRunId: "job-1", autoDisableRequired: true },
      { jobRunId: "job-2", autoDisableRequired: true },
      { jobRunId: "job-3", autoDisableRequired: false },
    ], new Set(["job-1"]));
    expect(pending).toEqual([{ jobRunId: "job-2", autoDisableRequired: true }]);
    expect(Object.isFrozen(pending)).toBe(true);
  });
});

describe("Schedule runtime application boundaries", () => {
  it("counts only enabled user tasks that will still fire; a completed one-shot task keeps nothing alive", () => {
    const projection: ScheduleRuntimeProjectionPort = {
      snapshot: () => ({
        tasks: [
          view("pending", 1, { enabled: true, state: { consecutiveErrors: 0, runCount: 0, nextRunAt: "2026-08-30T01:00:00.000Z" } }),
          // 一次性任务已执行：仍是 enabled，但没有下次运行
          view("done-once", 1, { enabled: true, state: { consecutiveErrors: 0, runCount: 1, lastRunAt: "2026-08-29T01:00:00.000Z", lastStatus: "ok" } }),
          view("disabled", 1, { enabled: false, state: { consecutiveErrors: 0, runCount: 0, nextRunAt: "2026-08-30T01:00:00.000Z" } }),
        ],
        activeRunCount: 0,
      }),
      onSignal: () => () => {},
    };
    expect(new ScheduleRuntimeApplicationService(projection, () => new Date(NOW)).readStatus().enabledUserTaskCount).toBe(1);
  });

  it("owns user visibility, status projection and failure-event folding", () => {
    let listener: ((signal: ScheduleRuntimeSignal) => void) | undefined;
    const projection: ScheduleRuntimeProjectionPort = {
      snapshot: () => ({
        tasks: [
          view("user", 1, {
            enabled: true,
            state: {
              consecutiveErrors: 0,
              runCount: 0,
              nextRunAt: "2026-08-30T01:00:00.000Z",
            },
          }),
          view("__system", 1, { system: true, enabled: true }),
        ],
        activeRunCount: 2,
      }),
      onSignal: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
    };
    const application = new ScheduleRuntimeApplicationService(
      projection,
      () => new Date(NOW),
    );
    const status = application.readStatus();
    expect(status).toMatchObject({
      activeRunCount: 2,
      enabledUserTaskCount: 1,
      turnContext: { active: [{ name: "morning" }] },
    });
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.turnContext)).toBe(true);
    expect(Object.isFrozen(status.turnContext.active)).toBe(true);
    expect(Object.isFrozen(status.turnContext.active[0])).toBe(true);
    const events: unknown[] = [];
    const dispose = application.onEvent((event) => events.push(event));
    listener?.({
      kind: "failed",
      taskId: "user",
      name: "morning",
      error: "offline",
      consecutiveErrors: 3,
      nextRunAt: "2026-08-30T02:00:00.000Z",
    });
    listener?.({
      kind: "completed",
      taskId: "__system",
      name: "maintenance",
      durationMs: 1,
    });
    expect(events).toEqual([{
      kind: "completed",
      taskId: "user",
      name: "morning",
      status: "error",
      error: "offline",
      consecutiveErrors: 3,
      nextRunAt: "2026-08-30T02:00:00.000Z",
    }]);
    dispose();
    expect(listener).toBeUndefined();
  });

  it("fails closed on invalid runtime counts", () => {
    const application = new ScheduleRuntimeApplicationService({
      snapshot: () => ({ tasks: [], activeRunCount: -1 }),
      onSignal: () => () => undefined,
    });
    expect(() => application.readStatus()).toThrow(
      "Schedule active run count must be a non-negative integer",
    );
  });

  it.each(["immediate", "drain", "cancel"] as const)(
    "settles the same frozen accepted-work exact-set for %s",
    async (strategy) => {
      let current = [{ id: "run-1", revision: "rev-1" }];
      let inProcess = ["run-1"];
      const settledExactSets: Array<readonly { readonly id: string; readonly revision: string }[]> = [];
      const mechanism: ScheduleLifecycleMechanismPort = {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        activate: vi.fn(),
        closeAdmission: vi.fn(),
        listAcceptedWork: vi.fn(async () => current),
        listInProcessWork: vi.fn(() => inProcess),
        recoverAcceptedWork: vi.fn(async () => undefined),
        pauseAndSettle: vi.fn(async () => {
          settledExactSets.push(structuredClone(current));
          current = [];
          inProcess = [];
        }),
        resumeAdmission: vi.fn(),
        recoverInstalledAuthority: vi.fn(async () => undefined),
        resumeManualSurfaces: vi.fn(async () => undefined),
      };
      const lifecycle = new ScheduleApplicationService({
        readStatus: () => ({
          activeRunCount: 0,
          enabledUserTaskCount: 0,
          turnContext: { active: [], recentlyCompleted: [], recentlyFailed: [] },
        }),
        onEvent: () => () => undefined,
      });
      lifecycle.install(mechanism);
      const frozen = await lifecycle.captureAcceptedWork();

      await lifecycle.settleAcceptedWork({ strategy, frozen });

      expect(settledExactSets).toEqual([[{ id: "run-1", revision: "rev-1" }]]);
      expect(mechanism.pauseAndSettle).toHaveBeenCalledOnce();
      await expect(lifecycle.assertAcceptedWorkSettled(frozen)).resolves.toBeUndefined();
    },
  );

  it("结清读回：排队中的发生留在权威里随冻结交接；本进程物理工作未收尾或出现未冻结的新代际仍不算结清", async () => {
    let current = [{ id: "queued-system", revision: "rev-q" }, { id: "running-user", revision: "rev-r" }];
    let inProcess = ["running-user"];
    const mechanism: ScheduleLifecycleMechanismPort = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      activate: vi.fn(),
      closeAdmission: vi.fn(),
      listAcceptedWork: vi.fn(async () => current),
      listInProcessWork: vi.fn(() => inProcess),
      recoverAcceptedWork: vi.fn(async () => undefined),
      pauseAndSettle: vi.fn(async () => {
        // 追踪中的用户运行在本进程跑到终态；排队中的系统维护不开始，留作交接
        current = current.filter((item) => item.id !== "running-user");
        inProcess = [];
      }),
      resumeAdmission: vi.fn(),
      recoverInstalledAuthority: vi.fn(async () => undefined),
      resumeManualSurfaces: vi.fn(async () => undefined),
    };
    const lifecycle = new ScheduleApplicationService({
      readStatus: () => ({
        activeRunCount: 0,
        enabledUserTaskCount: 0,
        turnContext: { active: [], recentlyCompleted: [], recentlyFailed: [] },
      }),
      onEvent: () => () => undefined,
    });
    lifecycle.install(mechanism);
    const frozen = await lifecycle.captureAcceptedWork();
    await expect(lifecycle.assertAcceptedWorkSettled(frozen)).rejects.toThrow("Schedule accepted work is not settled");
    await lifecycle.settleAcceptedWork({ strategy: "drain", frozen });
    await expect(lifecycle.assertAcceptedWorkSettled(frozen)).resolves.toBeUndefined();
    current = [...current, { id: "late-trigger", revision: "rev-late" }];
    await expect(lifecycle.assertAcceptedWorkSettled(frozen)).rejects.toThrow("outside the frozen accepted-work set");
  });

  it("owns frozen accepted-work settlement and rejects foreign mechanisms", async () => {
    let current = [{ id: "run-1", revision: "rev-1" }];
    let inProcess = ["run-1"];
    const mechanism: ScheduleLifecycleMechanismPort = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      activate: vi.fn(),
      closeAdmission: vi.fn(),
      listAcceptedWork: vi.fn(async () => current),
      listInProcessWork: vi.fn(() => inProcess),
      recoverAcceptedWork: vi.fn(async () => undefined),
      pauseAndSettle: vi.fn(async () => {
        current = [];
        inProcess = [];
      }),
      resumeAdmission: vi.fn(),
      recoverInstalledAuthority: vi.fn(async () => undefined),
      resumeManualSurfaces: vi.fn(async () => undefined),
    };
    const lifecycle = new ScheduleApplicationService({
      readStatus: () => ({
        activeRunCount: 0,
        enabledUserTaskCount: 0,
        turnContext: { active: [], recentlyCompleted: [], recentlyFailed: [] },
      }),
      onEvent: () => () => undefined,
    });
    lifecycle.install(mechanism);
    expect(() => lifecycle.install({ ...mechanism })).toThrow(
      "Schedule lifecycle mechanism is already installed",
    );
    const frozen = await lifecycle.captureAcceptedWork();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen[0])).toBe(true);

    current = [{ id: "run-2", revision: "foreign" }];
    await expect(lifecycle.settleAcceptedWork({
      strategy: "drain",
      frozen,
    })).rejects.toThrow("outside the frozen accepted-work set");
    expect(mechanism.pauseAndSettle).not.toHaveBeenCalled();

    expect(() => lifecycle.release({ ...mechanism })).toThrow(
      "Cannot release a foreign Schedule lifecycle mechanism",
    );
    lifecycle.release(mechanism);
    expect(() => lifecycle.release(mechanism)).toThrow(
      "Cannot release a foreign Schedule lifecycle mechanism",
    );
  });
});

describe("ScheduleManagementApplicationService optional nested members", () => {
  // 已声明的嵌套可选成员：省略与“自有属性值为 undefined”是同一个意思，提交给仓储的必须是同一份规范数据
  const members = [
    {
      member: "schedule.tz",
      omitted: { schedule: { kind: "cron" as const, expr: "0 3 29 2 *" } },
      undefinedValue: { schedule: { kind: "cron" as const, expr: "0 3 29 2 *", tz: undefined } },
      explicit: { schedule: { kind: "cron" as const, expr: "0 3 29 2 *", tz: "Asia/Shanghai" } },
      owner: (spec: TaskSpec) => spec.schedule as object,
      key: "tz",
    },
    {
      member: "action.model",
      omitted: { action: { kind: "agent-turn" as const, prompt: "work" } },
      undefinedValue: { action: { kind: "agent-turn" as const, prompt: "work", model: undefined } },
      explicit: { action: { kind: "agent-turn" as const, prompt: "work", model: "model-1" } },
      owner: (spec: TaskSpec) => spec.action as object,
      key: "model",
    },
    {
      member: "action.tools",
      omitted: { action: { kind: "agent-turn" as const, prompt: "work" } },
      undefinedValue: { action: { kind: "agent-turn" as const, prompt: "work", tools: undefined } },
      explicit: { action: { kind: "agent-turn" as const, prompt: "work", tools: ["read"] } },
      owner: (spec: TaskSpec) => spec.action as object,
      key: "tools",
    },
    {
      member: "delivery.threadId",
      omitted: { delivery: { kind: "channel" as const, channel: "feishu", to: "user-1" } },
      undefinedValue: { delivery: { kind: "channel" as const, channel: "feishu", to: "user-1", threadId: undefined } },
      explicit: { delivery: { kind: "channel" as const, channel: "feishu", to: "user-1", threadId: "thread-1" } },
      owner: (spec: TaskSpec) => spec.delivery as object,
      key: "threadId",
    },
  ];
  const base = {
    name: "optional",
    schedule: { kind: "interval" as const, everyMs: 60_000 },
    action: { kind: "agent-turn" as const, prompt: "work" },
  };

  async function committedCreate(draft: Record<string, unknown>) {
    const repo = repository();
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
    await application.execute({
      kind: "create",
      draft: { ...base, ...draft } as never,
      operation: { operationId: "create-optional" },
    });
    return (repo.commits[0] as { spec: TaskSpec }).spec;
  }

  async function committedUpdate(patch: Record<string, unknown>) {
    const repo = repository([view("user", 3)]);
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
    await application.execute({
      kind: "update",
      taskId: "user",
      patch: patch as never,
      operation: { operationId: "update-optional", expectedRevision: 3 },
    });
    return (repo.commits[0] as { spec: TaskSpec }).spec;
  }

  for (const { member, omitted, undefinedValue, explicit, owner, key } of members) {
    it(`commits the same canonical spec when ${member} is omitted or undefined`, async () => {
      for (const commit of [committedCreate, committedUpdate]) {
        const left = await commit(omitted);
        const right = await commit(undefinedValue);
        expect(Object.hasOwn(owner(right), key)).toBe(false);
        expect(right).toEqual(left);
        expect(canonicalize(right)).toBe(canonicalize(left));
        const kept = await commit(explicit);
        expect(owner(kept)).toEqual(Object.values(explicit)[0]);
        expect(kept).toMatchObject({ enabled: true, priority: "normal" });
      }
    });
  }

  it("replays an omitted member and an undefined member as the same operation", async () => {
    const repo = repository();
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
    const command = (schedule: Record<string, unknown>) => ({
      kind: "create" as const,
      draft: { ...base, schedule } as never,
      operation: { operationId: "create-replay" },
    });
    const first = await application.execute(command({ kind: "cron", expr: "0 3 29 2 *" }));
    const replay = await application.execute(command({ kind: "cron", expr: "0 3 29 2 *", tz: undefined }));
    expect(replay).toEqual(first);
  });

  it("still rejects unknown members, null and invalid values before the repository", async () => {
    const invalidDrafts: Array<[string, Record<string, unknown>]> = [
      ["unknown cron member valued undefined", { schedule: { kind: "cron", expr: "0 3 29 2 *", unknown: undefined } }],
      ["extra once member valued undefined", { schedule: { kind: "once", at: "2026-12-01T00:00:00.000Z", extra: undefined } }],
      ["null timezone", { schedule: { kind: "cron", expr: "0 3 29 2 *", tz: null } }],
      ["undefined tool entry", { action: { kind: "agent-turn", prompt: "work", tools: [undefined] } }],
      ["unknown delivery member valued undefined", { delivery: { kind: "channel", channel: "feishu", to: "user-1", unknown: undefined } }],
    ];
    for (const [label, draft] of invalidDrafts) {
      const repo = repository();
      const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
      await expect(application.execute({
        kind: "create",
        draft: { ...base, ...draft } as never,
        operation: { operationId: `invalid-${label}` },
      }), label).rejects.toMatchObject({ code: "invalid-command" });
      expect(repo.commits, label).toEqual([]);
    }
  });

  it("rejects a spec that is not canonical protocol data before the repository", async () => {
    const repo = repository();
    const application = new ScheduleManagementApplicationService(repo.port, manualExecution());
    await expect(application.execute({
      kind: "create",
      draft: { ...base, name: "bad\uD800" },
      operation: { operationId: "invalid-unicode" },
    })).rejects.toMatchObject({ code: "invalid-command" });
    expect(repo.commits).toEqual([]);
  });
});
