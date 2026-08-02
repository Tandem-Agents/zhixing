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
  GlobalStatePort,
  ScheduleTaskSpecDto,
  ScheduleWriteMutation,
} from "@zhixing/core/contracts";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
} from "@zhixing/core/protocol";
import type { AnchorScheduler } from "./scheduler-authority.js";

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
  ): Promise<{ revision: number }> {
    this.#admit(context, "global.mutate");
    if (context.principal.kind === "assignment") {
      throw new AuthorityMethodForbiddenError(
        "Assignment schedule mutations must be staged and published by the job owner",
      );
    }
    if (!isScheduleMutation(mutation)) {
      throw new TypeError("This global state adapter only owns the schedule domain");
    }
    switch (mutation.kind) {
      case "schedule-create": {
        const created = await this.scheduler.createTask(
          taskSpec(mutation.spec),
          context.requestId,
        );
        return { revision: this.#revision(created.id) };
      }
      case "schedule-update": {
        this.#expectRevision(mutation.taskId, mutation.taskRevision);
        await this.scheduler.updateTask(
          mutation.taskId,
          taskSpec(mutation.spec),
          context.requestId,
        );
        return { revision: this.#revision(mutation.taskId) };
      }
      case "schedule-set-state": {
        this.#expectRevision(mutation.taskId, mutation.taskRevision);
        await this.scheduler.updateTask(
          mutation.taskId,
          { enabled: mutation.state === "enabled" },
          context.requestId,
        );
        return { revision: this.#revision(mutation.taskId) };
      }
      case "schedule-delete": {
        this.#expectRevision(mutation.taskId, mutation.taskRevision);
        await this.scheduler.deleteTask(mutation.taskId, context.requestId);
        return { revision: this.#revision(mutation.taskId) };
      }
    }
  }

  #revision(taskId: string): number {
    const definition = this.scheduler.getDefinition(taskId);
    if (!definition) throw new Error(`Task not found: ${taskId}`);
    return definition.taskRevision;
  }

  #expectRevision(taskId: string, expected: number): void {
    const current = this.scheduler.getDefinition(taskId);
    if (!current || current.state === "deleted") {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (current.definition.kind !== "user") {
      throw new AuthorityMethodForbiddenError("System tasks are host-only");
    }
    if (current.taskRevision !== expected) {
      throw new Error("Schedule task revision conflict");
    }
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
