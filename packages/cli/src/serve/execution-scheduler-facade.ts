import type {
  AgentTurnResult,
  ScheduleMutationContext,
  ScheduleMutationStager,
  SchedulerFacade,
  SchedulerFacadeEventHandler,
  TaskPatch,
  TaskView,
} from "@zhixing/core";
import {
  ScheduleManagementApplicationService,
  type ScheduleManagementRepository,
  type ScheduleTaskDraft,
} from "@zhixing/core/scheduler/application";
import type { ScheduleTaskSpecDto } from "@zhixing/core/contracts";
import { runContextStorage } from "@zhixing/orchestrator/runtime";

interface StagedViewState {
  nextOperation: number;
  primed: boolean;
  readonly tasks: Map<string, TaskView>;
}

/** Anchor product adapter that routes schedule writes through assignment staging. */
export class ExecutionSchedulerFacade implements SchedulerFacade {
  readonly #states = new WeakMap<ScheduleMutationStager, StagedViewState>();

  constructor(private readonly base: () => SchedulerFacade) {}

  async create(spec: ScheduleTaskDraft, context?: ScheduleMutationContext): Promise<TaskView> {
    const staged = this.#stagedState();
    if (!staged) return this.base().create(spec, context);
    const result = await this.#application(staged).execute({
      kind: "create",
      draft: spec,
      operation: { operationId: this.#operationId(staged.state, context) },
    });
    if (result.kind !== "created") throw new TypeError("Schedule create returned wrong result");
    return result.task;
  }

  async list(): Promise<TaskView[]> {
    const staged = this.#stagedState();
    if (!staged) return this.base().list();
    return [...(await this.#application(staged).query({ kind: "list" })).tasks];
  }

  async update(
    id: string,
    patch: TaskPatch,
    context?: ScheduleMutationContext,
  ): Promise<TaskView> {
    const staged = this.#stagedState();
    if (!staged) return this.base().update(id, patch, context);
    const result = await this.#application(staged).execute({
      kind: "update",
      taskId: id,
      patch,
      operation: {
        operationId: this.#operationId(staged.state, context),
        ...(context?.taskRevision !== undefined
          ? { expectedRevision: context.taskRevision }
          : await this.#observedRevision(staged.state, id)),
      },
    });
    if (result.kind !== "updated") throw new TypeError("Schedule update returned wrong result");
    return result.task;
  }

  async delete(id: string, context?: ScheduleMutationContext): Promise<void> {
    const staged = this.#stagedState();
    if (!staged) return this.base().delete(id, context);
    const result = await this.#application(staged).execute({
      kind: "delete",
      taskId: id,
      operation: {
        operationId: this.#operationId(staged.state, context),
        ...(context?.taskRevision !== undefined
          ? { expectedRevision: context.taskRevision }
          : await this.#observedRevision(staged.state, id)),
      },
    });
    if (result.kind !== "deleted") throw new TypeError("Schedule delete returned wrong result");
  }

  run(id: string, context?: ScheduleMutationContext): Promise<AgentTurnResult> {
    return this.base().run(id, context);
  }

  onEvent(handler: SchedulerFacadeEventHandler): () => void {
    return this.base().onEvent(handler);
  }

  async dispose(): Promise<void> {
    await this.base().dispose?.();
  }

  #stagedState(): {
    readonly stage: ScheduleMutationStager;
    readonly state: StagedViewState;
  } | undefined {
    const stage = runContextStorage.getStore()?.stageScheduleMutation;
    if (!stage) return undefined;
    let state = this.#states.get(stage);
    if (!state) {
      state = { nextOperation: 1, primed: false, tasks: new Map() };
      this.#states.set(stage, state);
    }
    return { stage, state };
  }

  async #prime(state: StagedViewState): Promise<void> {
    if (state.primed) return;
    for (const task of await this.base().list()) {
      if (!state.tasks.has(task.id)) {
        state.tasks.set(task.id, structuredClone(task));
      }
    }
    state.primed = true;
  }

  async #observedRevision(
    state: StagedViewState,
    id: string,
  ): Promise<{ readonly expectedRevision: number }> {
    await this.#prime(state);
    const task = state.tasks.get(id);
    return { expectedRevision: requiredRevision(task) };
  }

  #application(staged: {
    readonly stage: ScheduleMutationStager;
    readonly state: StagedViewState;
  }): ScheduleManagementApplicationService {
    const repository: ScheduleManagementRepository = {
      list: async () => {
        await this.#prime(staged.state);
        return [...staged.state.tasks.values()].map((task) => structuredClone(task));
      },
      find: async (taskId) => {
        await this.#prime(staged.state);
        const task = staged.state.tasks.get(taskId);
        return task ? structuredClone(task) : undefined;
      },
      commitCreate: async ({ spec, operation }) => {
        const result = await staged.stage({
          mutation: { kind: "schedule-create", spec: taskSpecDto(spec) },
          operationId: operation.operationId,
        });
        if (!result.taskId) {
          throw new Error("Staged schedule creation did not return its stable task id");
        }
        const now = new Date().toISOString();
        const view: TaskView = {
          id: result.taskId,
          taskRevision: 1,
          ...structuredClone(spec),
          state: { consecutiveErrors: 0, runCount: 0 },
          createdAt: now,
          updatedAt: now,
        };
        staged.state.tasks.set(view.id, view);
        return structuredClone(view);
      },
      commitUpdate: async ({ taskId, spec, operation }) => {
        const current = staged.state.tasks.get(taskId);
        if (!current) throw new Error(`Task not found: ${taskId}`);
        await staged.stage({
          mutation: {
            kind: "schedule-update",
            taskId,
            taskRevision: operation.expectedRevision,
            spec: taskSpecDto(spec),
          },
          operationId: operation.operationId,
        });
        const next: TaskView = {
          ...current,
          ...structuredClone(spec),
          taskRevision: operation.expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        };
        staged.state.tasks.set(taskId, next);
        return structuredClone(next);
      },
      commitDelete: async ({ taskId, operation }) => {
        await staged.stage({
          mutation: {
            kind: "schedule-delete",
            taskId,
            taskRevision: operation.expectedRevision,
          },
          operationId: operation.operationId,
        });
        staged.state.tasks.delete(taskId);
      },
    };
    return new ScheduleManagementApplicationService(repository);
  }

  #operationId(
    state: StagedViewState,
    context: ScheduleMutationContext | undefined,
  ): string {
    if (context?.operationId) return context.operationId;
    const id = `operation-${state.nextOperation}`;
    state.nextOperation += 1;
    return id;
  }
}

function requiredRevision(task: TaskView | undefined): number {
  if (!task) throw new Error("Scheduled task projection is unavailable");
  if (!Number.isSafeInteger(task.taskRevision) || task.taskRevision! <= 0) {
    throw new Error("Scheduled task projection has no authority revision");
  }
  return task.taskRevision!;
}

function taskSpecDto(spec: TaskView | Omit<TaskView, "id" | "state" | "createdAt" | "updatedAt">): ScheduleTaskSpecDto {
  if (spec.action.kind !== "agent-turn") {
    throw new TypeError("User schedule mutations only accept agent-turn tasks");
  }
  return {
    name: spec.name,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    enabled: spec.enabled,
    priority: spec.priority,
    schedule: structuredClone(spec.schedule),
    action: structuredClone(spec.action),
    ...(spec.delivery !== undefined ? { delivery: structuredClone(spec.delivery) } : {}),
  };
}
