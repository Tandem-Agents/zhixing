import type {
  AgentTurnResult,
  ScheduleMutationContext,
  ScheduleMutationStager,
  SchedulerFacade,
  SchedulerFacadeEventHandler,
  TaskPatch,
  TaskSpec,
  TaskView,
} from "@zhixing/core";
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

  async create(spec: TaskSpec, context?: ScheduleMutationContext): Promise<TaskView> {
    const staged = this.#stagedState();
    if (!staged) return this.base().create(spec, context);
    const result = await staged.stage({
      mutation: { kind: "schedule-create", spec: taskSpecDto(spec) },
      operationId: this.#operationId(staged.state, context),
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
  }

  async list(): Promise<TaskView[]> {
    const staged = this.#stagedState();
    if (!staged) return this.base().list();
    await this.#prime(staged.state);
    return [...staged.state.tasks.values()].map((task) => structuredClone(task));
  }

  async update(
    id: string,
    patch: TaskPatch,
    context?: ScheduleMutationContext,
  ): Promise<TaskView> {
    const staged = this.#stagedState();
    if (!staged) return this.base().update(id, patch, context);
    const current = await this.#current(staged.state, id);
    const taskRevision = requiredRevision(current);
    const next: TaskView = {
      ...current,
      ...structuredClone(patch),
      taskRevision: taskRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    await staged.stage({
      mutation: {
        kind: "schedule-update",
        taskId: id,
        taskRevision,
        spec: taskSpecDto(next),
      },
      operationId: this.#operationId(staged.state, context),
    });
    staged.state.tasks.set(id, next);
    return structuredClone(next);
  }

  async delete(id: string, context?: ScheduleMutationContext): Promise<void> {
    const staged = this.#stagedState();
    if (!staged) return this.base().delete(id, context);
    const current = await this.#current(staged.state, id);
    await staged.stage({
      mutation: {
        kind: "schedule-delete",
        taskId: id,
        taskRevision: requiredRevision(current),
      },
      operationId: this.#operationId(staged.state, context),
    });
    staged.state.tasks.delete(id);
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

  async #current(state: StagedViewState, id: string): Promise<TaskView> {
    await this.#prime(state);
    const task = state.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.system) throw new Error(`Cannot modify system task: ${id}`);
    return task;
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

function requiredRevision(task: TaskView): number {
  if (!Number.isSafeInteger(task.taskRevision) || task.taskRevision! <= 0) {
    throw new Error("Scheduled task projection has no authority revision");
  }
  return task.taskRevision!;
}

function taskSpecDto(spec: TaskSpec | TaskView): ScheduleTaskSpecDto {
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
