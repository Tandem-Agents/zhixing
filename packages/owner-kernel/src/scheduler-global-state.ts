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
  ScheduleRuntimeProjectionPort,
  ScheduleRuntimeSignal,
  ScheduleManualExecutionPort,
  ScheduleManagementOperation,
  ScheduleManagementRepository,
} from "@zhixing/core/scheduler/application";
import type {
  IEventBus,
  SchedulerEventMap,
  SchedulerControlSource,
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
export class AnchorSchedulerProductPort
  implements
    ScheduleManagementRepository,
    ScheduleManualExecutionPort,
    ScheduleRuntimeProjectionPort
{
  constructor(
    private readonly scheduler: AnchorScheduler,
    private readonly globalState: GlobalStatePort,
    private readonly anchorEpoch: number,
    private readonly eventBus: IEventBus<SchedulerEventMap>,
  ) {}

  async commitCreate(input: {
    readonly spec: TaskSpec;
    readonly operation: ScheduleManagementOperation;
  }): Promise<TaskView> {
    const stableRequestId = requiredRequestId(input.operation.operationId, "schedule create");
    const source = schedulerManagementSource(input.operation);
    await this.globalState.mutate(
      { kind: "schedule-create", spec: taskSpecDto(input.spec) },
      this.#context(
        stableRequestId,
        source,
        protocolDigest("ScheduleCreateIntent", 1, { spec: input.spec }),
      ),
    );
    return this.#requiredTask(scheduleTaskIdForRequest(stableRequestId));
  }

  async list(): Promise<readonly TaskView[]> {
    return this.scheduler.listTaskProjections();
  }

  async find(taskId: string): Promise<TaskView | undefined> {
    return this.scheduler.getTask(taskId);
  }

  async commitUpdate(input: {
    readonly taskId: string;
    readonly spec: TaskSpec;
    readonly operation: ScheduleManagementOperation & { readonly expectedRevision: number };
  }): Promise<TaskView> {
    const stableRequestId = requiredRequestId(input.operation.operationId, "schedule update");
    const revision = requiredTaskRevision(input.operation.expectedRevision, "Schedule update");
    const source = schedulerManagementSource(input.operation);
    await this.globalState.mutate(
      {
        kind: "schedule-update",
        taskId: input.taskId,
        taskRevision: revision,
        spec: taskSpecDto(input.spec),
      },
      this.#context(
        stableRequestId,
        source,
        protocolDigest("ScheduleUpdateIntent", 1, {
          taskId: input.taskId,
          taskRevision: revision,
          spec: input.spec,
        }),
      ),
    );
    return this.#requiredTask(input.taskId);
  }

  async commitDelete(input: {
    readonly taskId: string;
    readonly operation: ScheduleManagementOperation & { readonly expectedRevision: number };
  }): Promise<void> {
    const stableRequestId = requiredRequestId(input.operation.operationId, "schedule delete");
    const revision = requiredTaskRevision(input.operation.expectedRevision, "Schedule deletion");
    const source = schedulerManagementSource(input.operation);
    await this.globalState.mutate(
      {
        kind: "schedule-delete",
        taskId: input.taskId,
        taskRevision: revision,
      },
      this.#context(
        stableRequestId,
        source,
        protocolDigest("ScheduleDeleteIntent", 1, {
          taskId: input.taskId,
          taskRevision: revision,
        }),
      ),
    );
  }

  run(input: {
    readonly taskId: string;
    readonly operation: ScheduleManagementOperation;
  }) {
    return this.scheduler.runTask(
      input.taskId,
      requiredRequestId(input.operation.operationId, "schedule run"),
      schedulerManagementSource(input.operation),
    );
  }

  abort(input: {
    readonly runId: string;
    readonly operation: ScheduleManagementOperation;
  }) {
    return this.scheduler.abortRun(
      input.runId,
      requiredRequestId(input.operation.operationId, "schedule cancellation"),
      schedulerManagementSource(input.operation),
    );
  }

  snapshot(): { readonly tasks: readonly TaskView[]; readonly activeRunCount: number } {
    return Object.freeze({
      tasks: Object.freeze(this.scheduler.listTaskProjections()),
      activeRunCount: this.scheduler.activeTaskCount,
    });
  }

  onSignal(handler: (signal: ScheduleRuntimeSignal) => void): () => void {
    const disposers = [
      this.eventBus.on("scheduler:task-accepted", (event) => {
        handler(Object.freeze({ kind: "accepted", ...event }));
      }),
      this.eventBus.on("scheduler:task-started", (event) => {
        handler(Object.freeze({ kind: "started", taskId: event.taskId, name: event.name }));
      }),
      this.eventBus.on("scheduler:task-completed", (event) => {
        handler(Object.freeze({ kind: "completed", ...event }));
      }),
      this.eventBus.on("scheduler:task-failed", (event) => {
        handler(Object.freeze({ kind: "failed", ...event }));
      }),
      this.eventBus.on("scheduler:task-disabled", (event) => {
        handler(Object.freeze({ kind: "disabled", ...event }));
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
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

function schedulerManagementSource(
  operation: ScheduleManagementOperation,
): SchedulerControlSource | undefined {
  const surface = operation.surface;
  if (!surface) return undefined;
  return {
    connectionId: surface.connectionId,
    ingress: {
      kind: "first-party",
      surfacePrincipal: surface.surfacePrincipal,
      deviceId: surface.deviceId,
      ingressId: surface.ingressId,
      receivedAt: surface.receivedAt,
      turnOrigin: { channel: "rpc", triggeredBy: surface.surfacePrincipal },
    },
  };
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
