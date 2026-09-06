import { createEventBus } from "@zhixing/core";
import type { AssignmentMutationPort } from "@zhixing/core/contracts";
import { type SchedulerFacade, type SchedulerEventMap, type TaskSpec, type TaskView } from "@zhixing/core/scheduler";
import { scheduleTaskIdForRequest } from "@zhixing/owner-kernel/scheduler-authority";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import type { ConversationAssignmentLedger } from "@zhixing/executor";
import { describe, expect, it, vi } from "vitest";
import { createAssignmentMutationPort } from "../assignment-global-state-ports.js";
import { ExecutionSchedulerFacade } from "../execution-scheduler-facade.js";

const SPEC: TaskSpec = {
  name: "task",
  enabled: true,
  priority: "normal",
  schedule: { kind: "interval", everyMs: 60_000 },
  action: { kind: "agent-turn", prompt: "work" },
};

function task(id = "task-existing", revision = 3): TaskView {
  return {
    id,
    taskRevision: revision,
    ...SPEC,
    state: { consecutiveErrors: 0, runCount: 0 },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function baseFacade(): SchedulerFacade {
  return {
    create: vi.fn(async () => task("direct", 1)),
    list: vi.fn(async () => [task()]),
    update: vi.fn(async (id, patch) => ({ ...task(id), ...patch })),
    delete: vi.fn(async () => {}),
    run: vi.fn(async () => ({ status: "ok", durationMs: 1 })),
    onEvent: vi.fn(() => () => {}),
  };
}

function mutationPort(stage: AssignmentMutationPort["stage"]): AssignmentMutationPort {
  return {
    assignmentId: "assignment-1",
    execution: "conversation",
    stage,
    readOverlay: async () => [],
  };
}

describe("ExecutionSchedulerFacade", () => {
  it("uses the direct facade outside a durable assignment", async () => {
    const base = baseFacade();
    const facade = new ExecutionSchedulerFacade(base);
    await facade.create(SPEC);
    expect(base.create).toHaveBeenCalledOnce();
  });

  it("stages writes and exposes read-your-writes without touching direct CRUD", async () => {
    const base = baseFacade();
    const staged: unknown[] = [];
    const facade = new ExecutionSchedulerFacade(base);
    const stage = vi.fn(async (input) => {
      staged.push(input);
      return {
        kind: "assignment-mutation-staged" as const,
        requestId: `request-${staged.length}`,
        recordSeq: staged.length,
        mutationDigest: "a".repeat(64),
      };
    });
    const assignmentMutations = mutationPort(stage);
    const bus = createEventBus<SchedulerEventMap>();

    await runContextStorage.run(
      { bus, lineage: "main", assignmentMutations },
      async () => {
        const created = await facade.create(SPEC, { operationId: "tool-1" });
        expect(created.id).toBe(scheduleTaskIdForRequest("request-1"));
        await facade.update("task-existing", { name: "renamed" }, {
          operationId: "tool-2",
        });
        await facade.delete(created.id, { operationId: "tool-3" });
        expect((await facade.list()).map((item) => item.id)).toEqual([
          "task-existing",
        ]);
      },
    );

    expect(staged).toMatchObject([
      {
        domain: "global",
        operationId: "tool-1",
        mutation: { kind: "schedule-create" },
      },
      {
        domain: "global",
        operationId: "tool-2",
        mutation: {
          kind: "schedule-update",
          taskId: "task-existing",
          taskRevision: 3,
        },
      },
      {
        domain: "global",
        operationId: "tool-3",
        mutation: {
          kind: "schedule-delete",
          taskId: scheduleTaskIdForRequest("request-1"),
          taskRevision: 1,
        },
      },
    ]);
    expect(base.create).not.toHaveBeenCalled();
    expect(base.update).not.toHaveBeenCalled();
    expect(base.delete).not.toHaveBeenCalled();
  });

  it("uses domain defaults and rejects system-task mutation before assignment staging", async () => {
    const stage = vi.fn(async () => ({
      kind: "assignment-mutation-staged" as const,
      requestId: "request-create",
      recordSeq: 1,
      mutationDigest: "a".repeat(64),
    }));
    const assignmentMutations = mutationPort(stage);
    const bus = createEventBus<SchedulerEventMap>();
    const direct = baseFacade();
    const facade = new ExecutionSchedulerFacade(direct);
    await runContextStorage.run(
      { bus, lineage: "main", assignmentMutations },
      async () => {
        const created = await facade.create({
          name: "defaulted",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "work" },
        }, { operationId: "create-defaulted" });
        expect(created).toMatchObject({ enabled: true, priority: "normal" });
      },
    );
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        kind: "schedule-create",
        spec: expect.objectContaining({ enabled: true, priority: "normal" }),
      }),
    }));

    const system = task("system", 4);
    system.system = true;
    system.action = { kind: "system", handler: "__transcript-gc" };
    const systemBase = baseFacade();
    systemBase.list = vi.fn(async () => [system]);
    const systemFacade = new ExecutionSchedulerFacade(systemBase);
    const systemStage = vi.fn();
    await runContextStorage.run(
      { bus, lineage: "main", assignmentMutations: mutationPort(systemStage) },
      async () => {
        await expect(systemFacade.update("system", { enabled: false }, {
          operationId: "update-system",
          taskRevision: 4,
        })).rejects.toMatchObject({ code: "system-task" });
      },
    );
    expect(systemStage).not.toHaveBeenCalled();
  });

  it("does not fall back to direct CRUD when an assignment forbids global writes", async () => {
    const stageMutation = vi.fn();
    const ledger = {
      stageMutation,
      readStagedMutationOverlay: async () => [],
    } as unknown as ConversationAssignmentLedger;
    const assignmentMutations = createAssignmentMutationPort({
      ledger,
      assignmentId: "local-assignment",
      execution: "conversation",
      anchorEpoch: 1,
      allowGlobal: false,
    });
    const base = baseFacade();
    const facade = new ExecutionSchedulerFacade(base);
    const bus = createEventBus<SchedulerEventMap>();

    await runContextStorage.run(
      { bus, lineage: "main", assignmentMutations },
      async () => {
        await expect(
          facade.create(SPEC, { operationId: "forbidden-create" }),
        ).rejects.toThrow("Global mutations are unavailable");
      },
    );

    expect(stageMutation).not.toHaveBeenCalled();
    expect(base.create).not.toHaveBeenCalled();
  });
});
