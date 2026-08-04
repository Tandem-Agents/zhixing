import type {
  GlobalControlCallContext,
  GlobalControlMutation,
  GlobalControlMutationResult,
  GlobalQuery,
  GlobalReadCallContext,
  GlobalReadResult,
  GlobalStagedCallContext,
  GlobalStagedMutation,
  GlobalStagedMutationResult,
  AssignmentStagedReceipt,
  GlobalStatePort,
  ScheduleTaskSpecDto,
  ScheduleWriteMutation,
} from "@zhixing/core/contracts";
import type {
  SchedulerBackend,
  SchedulerControlSource,
  TaskPatch,
  TaskSpec,
  TaskView,
} from "@zhixing/core";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  protocolDigest,
} from "@zhixing/core/protocol";
import {
  type AnchorScheduler,
  scheduleTaskIdForRequest,
} from "./scheduler-authority.js";

/** The schedule domain adapter behind the process-wide GlobalStatePort router. */
export class AnchorSchedulerGlobalStateAdapter implements GlobalStatePort {
  constructor(
    private readonly scheduler: AnchorScheduler,
    private readonly anchorEpoch: number,
  ) {}

  async read(
    query: GlobalQuery,
    context: GlobalReadCallContext,
  ): Promise<GlobalReadResult> {
    this.#admit(context, "global.read");
    if (query.kind !== "schedule-list") {
      throw new TypeError("This global state adapter only owns the schedule domain");
    }
    return {
      kind: "schedule-list",
      tasks: this.scheduler.listDefinitions(query.includeDisabled ?? false),
    };
  }

  mutate<M extends GlobalControlMutation>(
    mutation: M,
    context: GlobalControlCallContext,
  ): Promise<GlobalControlMutationResult<M>>;
  mutate<M extends GlobalStagedMutation>(
    mutation: M,
    context: GlobalStagedCallContext,
  ): Promise<GlobalStagedMutationResult<M>>;
  async mutate(
    mutation: GlobalControlMutation | GlobalStagedMutation,
    context: GlobalControlCallContext | GlobalStagedCallContext,
  ): Promise<{ revision: number } | AssignmentStagedReceipt> {
    this.#admit(context, "global.mutate");
    if (context.principal.kind === "assignment") {
      throw new AuthorityMethodForbiddenError(
        "Assignment schedule mutations must be staged and published by the job owner",
      );
    }
    const controlContext = context as GlobalControlCallContext;
    if (!isScheduleMutation(mutation)) {
      throw new TypeError("This global state adapter only owns the schedule domain");
    }
    switch (mutation.kind) {
      case "schedule-create": {
        const created = await this.scheduler.createTask(
          taskSpec(mutation.spec),
          context.requestId,
          schedulerControlSource(controlContext),
          controlContext.operationDigest ?? scheduleMutationDigest(mutation),
        );
        return { revision: this.#revision(created.id) };
      }
      case "schedule-update": {
        await this.scheduler.updateTask(
          mutation.taskId,
          taskSpec(mutation.spec),
          context.requestId,
          mutation.taskRevision,
          controlContext.operationDigest ?? scheduleMutationDigest(mutation),
        );
        return { revision: this.#revision(mutation.taskId) };
      }
      case "schedule-set-state": {
        await this.scheduler.updateTask(
          mutation.taskId,
          { enabled: mutation.state === "enabled" },
          context.requestId,
          mutation.taskRevision,
          controlContext.operationDigest ?? scheduleMutationDigest(mutation),
        );
        return { revision: this.#revision(mutation.taskId) };
      }
      case "schedule-delete": {
        await this.scheduler.deleteTask(
          mutation.taskId,
          context.requestId,
          mutation.taskRevision,
          controlContext.operationDigest ?? scheduleMutationDigest(mutation),
        );
        return { revision: this.#revision(mutation.taskId) };
      }
    }
  }

  #revision(taskId: string): number {
    const definition = this.scheduler.getDefinition(taskId);
    if (!definition) throw new Error(`Task not found: ${taskId}`);
    return definition.taskRevision;
  }

  #admit(
    context: GlobalReadCallContext | GlobalControlCallContext | GlobalStagedCallContext,
    method: "global.read" | "global.mutate",
  ): void {
    if (
      context.authority.domain !== "global" ||
      context.authority.anchorEpoch !== this.anchorEpoch
    ) {
      throw new AuthorityMethodForbiddenError("Schedule anchor fence is stale");
    }
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
  }
}

/**
 * The only production scheduler product port. Definition reads and writes are
 * admitted by GlobalState while execution controls remain owned by JobJournal.
 */
export class AnchorSchedulerProductPort implements SchedulerBackend {
  constructor(
    private readonly scheduler: AnchorScheduler,
    private readonly globalState: GlobalStatePort,
    private readonly anchorEpoch: number,
  ) {}

  start(): Promise<void> {
    return this.scheduler.start();
  }

  stop(): Promise<void> {
    return this.scheduler.stop();
  }

  async createTask(
    spec: TaskSpec,
    requestId?: string,
    source?: SchedulerControlSource,
  ): Promise<TaskView> {
    const stableRequestId = requiredRequestId(requestId, "schedule create");
    await this.globalState.mutate(
      { kind: "schedule-create", spec: taskSpecDto(spec) },
      this.#context(
        stableRequestId,
        source,
        protocolDigest("ScheduleCreateIntent", 1, { spec }),
      ),
    );
    return this.#requiredTask(scheduleTaskIdForRequest(stableRequestId));
  }

  listTasks(): TaskView[] {
    return this.scheduler.listTasks();
  }

  async updateTask(
    id: string,
    patch: TaskPatch,
    requestId?: string,
    taskRevision?: number,
    source?: SchedulerControlSource,
  ): Promise<TaskView> {
    const stableRequestId = requiredRequestId(requestId, "schedule update");
    const revision = requiredTaskRevision(taskRevision, "Schedule update");
    const current = this.#requiredTask(id);
    await this.globalState.mutate(
      {
        kind: "schedule-update",
        taskId: id,
        taskRevision: revision,
        spec: taskSpecDto({ ...current, ...structuredClone(patch) }),
      },
      this.#context(
        stableRequestId,
        source,
        protocolDigest("ScheduleUpdateIntent", 1, {
          taskId: id,
          taskRevision: revision,
          patch,
        }),
      ),
    );
    return this.#requiredTask(id);
  }

  async deleteTask(
    id: string,
    requestId?: string,
    taskRevision?: number,
    source?: SchedulerControlSource,
  ): Promise<void> {
    const stableRequestId = requiredRequestId(requestId, "schedule delete");
    await this.globalState.mutate(
      {
        kind: "schedule-delete",
        taskId: id,
        taskRevision: requiredTaskRevision(taskRevision, "Schedule deletion"),
      },
      this.#context(
        stableRequestId,
        source,
        protocolDigest("ScheduleDeleteIntent", 1, {
          taskId: id,
          taskRevision: requiredTaskRevision(taskRevision, "Schedule deletion"),
        }),
      ),
    );
  }

  runTask(
    id: string,
    requestId?: string,
    source?: SchedulerControlSource,
  ) {
    return this.scheduler.runTask(
      id,
      requiredRequestId(requestId, "schedule run"),
      source,
    );
  }

  getTask(id: string): TaskView | undefined {
    return this.scheduler.getTask(id);
  }

  abortRun(
    runId: string,
    requestId?: string,
    source?: SchedulerControlSource,
  ) {
    return this.scheduler.abortRun(
      runId,
      requiredRequestId(requestId, "schedule cancellation"),
      source,
    );
  }

  get activeTaskCount(): number {
    return this.scheduler.activeTaskCount;
  }

  #requiredTask(id: string): TaskView {
    const task = this.scheduler.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  #context(
    requestId: string,
    source: SchedulerControlSource | undefined,
    operationDigest: string,
  ): GlobalControlCallContext {
    return {
      principal: source
        ? {
            kind: "surface",
            surfacePrincipal: source.ingress.surfacePrincipal,
            connectionId: source.connectionId,
          }
        : { kind: "host", component: "scheduler-product" },
      requestId,
      operationDigest,
      ...(source ? { ingress: structuredClone(source.ingress) } : {}),
      authority: { domain: "global", anchorEpoch: this.anchorEpoch },
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

function scheduleMutationDigest(mutation: ScheduleWriteMutation): string {
  return protocolDigest("ScheduleGlobalMutation", 1, mutation);
}

function schedulerControlSource(
  context: GlobalControlCallContext,
): SchedulerControlSource | undefined {
  if (context.principal.kind !== "surface" || !context.ingress) return undefined;
  if (context.ingress.surfacePrincipal !== context.principal.surfacePrincipal) {
    throw new AuthorityMethodForbiddenError(
      "Schedule ingress does not bind the authenticated surface",
    );
  }
  return {
    connectionId: context.principal.connectionId,
    ingress: structuredClone(context.ingress),
  };
}

function requiredRequestId(value: string | undefined, operation: string): string {
  if (!value) throw new TypeError(`${operation} requires a stable operation id`);
  return value;
}

function requiredTaskRevision(value: number | undefined, operation: string): number {
  if (!Number.isSafeInteger(value) || value! <= 0) {
    throw new TypeError(`${operation} requires an observed task revision`);
  }
  return value!;
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
    ...(spec.delivery !== undefined
      ? { delivery: structuredClone(spec.delivery) }
      : {}),
  };
}

function isScheduleMutation(
  mutation: GlobalControlMutation | GlobalStagedMutation,
): mutation is ScheduleWriteMutation {
  return mutation.kind.startsWith("schedule-");
}

function taskSpec(spec: ScheduleTaskSpecDto) {
  return {
    name: spec.name,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    enabled: spec.enabled,
    priority: spec.priority,
    schedule: structuredClone(spec.schedule),
    action: structuredClone(spec.action),
    ...(spec.delivery !== undefined
      ? { delivery: structuredClone(spec.delivery) }
      : {}),
  };
}
