import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { validateTaskDefinition } from "../protocol/job.js";
import type { TaskPatch, TaskSpec, TaskView } from "./facade.js";
import type { AgentTurnResult } from "./types.js";

/** User-authored schedule definition before domain defaults are applied. */
export type ScheduleTaskDraft = Omit<TaskSpec, "enabled" | "priority"> & {
  readonly enabled?: TaskSpec["enabled"];
  readonly priority?: TaskSpec["priority"];
};

/** Stable authenticated identity carried to the durability adapter. */
export interface ScheduleManagementSurfaceIdentity {
  readonly surfacePrincipal: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly ingressId: string;
  readonly receivedAt: string;
}

export interface ScheduleManagementOperation {
  readonly operationId: string;
  readonly expectedRevision?: number;
  readonly surface?: ScheduleManagementSurfaceIdentity;
}

export type ScheduleManagementQuery = { readonly kind: "list" };

export type ScheduleManagementCommand =
  | {
      readonly kind: "create";
      readonly draft: ScheduleTaskDraft;
      readonly operation: ScheduleManagementOperation;
    }
  | {
      readonly kind: "update";
      readonly taskId: string;
      readonly patch: TaskPatch;
      readonly operation: ScheduleManagementOperation;
    }
  | {
      readonly kind: "delete";
      readonly taskId: string;
      readonly operation: ScheduleManagementOperation;
    }
  | {
      readonly kind: "run";
      readonly taskId: string;
      readonly operation: ScheduleManagementOperation;
    }
  | {
      readonly kind: "abort-run";
      readonly runId: string;
      readonly operation: ScheduleManagementOperation;
    };

export interface ScheduleManagementView {
  readonly tasks: readonly TaskView[];
}

export type ScheduleManagementCommandResult =
  | { readonly kind: "created"; readonly task: TaskView }
  | { readonly kind: "updated"; readonly task: TaskView }
  | { readonly kind: "deleted"; readonly taskId: string }
  | { readonly kind: "ran"; readonly result: AgentTurnResult }
  | { readonly kind: "run-aborted"; readonly runId: string; readonly aborted: boolean };

export interface ScheduleManagementApplication {
  query(query: ScheduleManagementQuery): Promise<ScheduleManagementView>;
  execute(command: ScheduleManagementCommand): Promise<ScheduleManagementCommandResult>;
}

/**
 * Persistence/Correctness mechanism for already-decided schedule definitions.
 * It deliberately receives full validated specs and owns no default, merge,
 * visibility, system-task, or optimistic-concurrency policy.
 */
export interface ScheduleManagementRepository {
  list(): Promise<readonly TaskView[]>;
  find(taskId: string): Promise<TaskView | undefined>;
  commitCreate(input: {
    readonly spec: TaskSpec;
    readonly operation: ScheduleManagementOperation;
  }): Promise<TaskView>;
  commitUpdate(input: {
    readonly taskId: string;
    readonly spec: TaskSpec;
    readonly operation: ScheduleManagementOperation & { readonly expectedRevision: number };
  }): Promise<TaskView>;
  commitDelete(input: {
    readonly taskId: string;
    readonly operation: ScheduleManagementOperation & { readonly expectedRevision: number };
  }): Promise<void>;
}

/**
 * Correctness/effect port for an already-admitted manual schedule control.
 * Job Journal, Assignment, cancellation and response-loss replay stay behind
 * this boundary; it owns no user-task visibility or public result semantics.
 */
export interface ScheduleManualExecutionPort {
  run(input: {
    readonly taskId: string;
    readonly operation: ScheduleManagementOperation;
  }): Promise<AgentTurnResult>;
  abort(input: {
    readonly runId: string;
    readonly operation: ScheduleManagementOperation;
  }): Promise<boolean>;
}

export type ScheduleManagementApplicationErrorCode =
  | "invalid-command"
  | "not-found"
  | "system-task"
  | "conflict";

export class ScheduleManagementApplicationError extends Error {
  constructor(
    readonly code: ScheduleManagementApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScheduleManagementApplicationError";
  }
}

/** Sole application owner for user schedule definition management. */
export class ScheduleManagementApplicationService
  implements ScheduleManagementApplication
{
  constructor(
    private readonly repository: ScheduleManagementRepository,
    private readonly execution: ScheduleManualExecutionPort,
  ) {}

  async query(query: ScheduleManagementQuery): Promise<ScheduleManagementView> {
    if (query.kind !== "list") throw invalid("Unsupported Schedule management query");
    const tasks = (await this.repository.list())
      .filter((task) => !task.system)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(cloneTask);
    return Object.freeze({ tasks: Object.freeze(tasks) });
  }

  async execute(command: ScheduleManagementCommand): Promise<ScheduleManagementCommandResult> {
    switch (command.kind) {
      case "create": {
        const operation = normalizeOperation(command.operation, false);
        const spec = normalizeSpec(command.draft);
        try {
          const task = await this.repository.commitCreate({ spec, operation });
          return Object.freeze({ kind: "created" as const, task: cloneTask(task) });
        } catch (error) {
          throw mapRepositoryError(error);
        }
      }
      case "update": {
        const taskId = requireString(command.taskId, "Schedule task id");
        const operation = normalizeOperation(command.operation, true);
        const current = await this.#requiredUserTask(taskId);
        const spec = normalizeSpec(mergeSpec(current, command.patch));
        try {
          const task = await this.repository.commitUpdate({
            taskId,
            spec,
            operation,
          });
          return Object.freeze({ kind: "updated" as const, task: cloneTask(task) });
        } catch (error) {
          throw mapRepositoryError(error);
        }
      }
      case "delete": {
        const taskId = requireString(command.taskId, "Schedule task id");
        const operation = normalizeOperation(command.operation, true);
        const current = await this.repository.find(taskId);
        if (current?.system) {
          throw new ScheduleManagementApplicationError(
            "system-task",
            `Cannot modify system task: ${taskId}`,
          );
        }
        try {
          await this.repository.commitDelete({ taskId, operation });
          return Object.freeze({ kind: "deleted" as const, taskId });
        } catch (error) {
          throw mapRepositoryError(error);
        }
      }
      case "run": {
        const taskId = requireString(command.taskId, "Schedule task id");
        const operation = normalizeOperation(command.operation, false);
        await this.#requiredUserTask(taskId);
        try {
          const result = await this.execution.run({ taskId, operation });
          return Object.freeze({
            kind: "ran" as const,
            result: structuredClone(result),
          });
        } catch (error) {
          throw mapRepositoryError(error);
        }
      }
      case "abort-run": {
        const runId = requireString(command.runId, "Schedule run id");
        const operation = normalizeOperation(command.operation, false);
        try {
          const aborted = await this.execution.abort({ runId, operation });
          return Object.freeze({ kind: "run-aborted" as const, runId, aborted });
        } catch (error) {
          throw mapRepositoryError(error);
        }
      }
    }
  }

  async #requiredUserTask(taskId: string): Promise<TaskView> {
    const task = await this.repository.find(taskId);
    if (!task) {
      throw new ScheduleManagementApplicationError("not-found", `Task not found: ${taskId}`);
    }
    if (task.system) {
      throw new ScheduleManagementApplicationError(
        "system-task",
        `Cannot modify system task: ${taskId}`,
      );
    }
    return task;
  }
}

export const SCHEDULE_MANAGEMENT_LIST_QUERY = defineProductApiQuery<
  "schedule-management.query.list",
  ScheduleManagementQuery,
  ScheduleManagementView
>("schedule-management.query.list");

export const SCHEDULE_MANAGEMENT_CREATE_COMMAND = defineProductApiCommand<
  "schedule-management.command.create",
  Extract<ScheduleManagementCommand, { readonly kind: "create" }>,
  Extract<ScheduleManagementCommandResult, { readonly kind: "created" }>,
  never
>("schedule-management.command.create", []);

export const SCHEDULE_MANAGEMENT_UPDATE_COMMAND = defineProductApiCommand<
  "schedule-management.command.update",
  Extract<ScheduleManagementCommand, { readonly kind: "update" }>,
  Extract<ScheduleManagementCommandResult, { readonly kind: "updated" }>,
  never
>("schedule-management.command.update", []);

export const SCHEDULE_MANAGEMENT_DELETE_COMMAND = defineProductApiCommand<
  "schedule-management.command.delete",
  Extract<ScheduleManagementCommand, { readonly kind: "delete" }>,
  Extract<ScheduleManagementCommandResult, { readonly kind: "deleted" }>,
  never
>("schedule-management.command.delete", []);

export const SCHEDULE_MANUAL_RUN_COMMAND = defineProductApiCommand<
  "schedule-management.command.run",
  Extract<ScheduleManagementCommand, { readonly kind: "run" }>,
  Extract<ScheduleManagementCommandResult, { readonly kind: "ran" }>,
  never
>("schedule-management.command.run", []);

export const SCHEDULE_MANUAL_ABORT_COMMAND = defineProductApiCommand<
  "schedule-management.command.abort-run",
  Extract<ScheduleManagementCommand, { readonly kind: "abort-run" }>,
  Extract<ScheduleManagementCommandResult, { readonly kind: "run-aborted" }>,
  never
>("schedule-management.command.abort-run", []);

export const SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    SCHEDULE_MANAGEMENT_LIST_QUERY,
    SCHEDULE_MANAGEMENT_CREATE_COMMAND,
    SCHEDULE_MANAGEMENT_UPDATE_COMMAND,
    SCHEDULE_MANAGEMENT_DELETE_COMMAND,
    SCHEDULE_MANUAL_RUN_COMMAND,
    SCHEDULE_MANUAL_ABORT_COMMAND,
  ],
  factEvents: [],
});

export function createScheduleManagementProductApiContribution(
  application: ScheduleManagementApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(SCHEDULE_MANAGEMENT_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(SCHEDULE_MANAGEMENT_CREATE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          ScheduleManagementCommandResult,
          { readonly kind: "created" }
        >,
        facts: [],
      })),
      bindProductApiOperation(SCHEDULE_MANAGEMENT_UPDATE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          ScheduleManagementCommandResult,
          { readonly kind: "updated" }
        >,
        facts: [],
      })),
      bindProductApiOperation(SCHEDULE_MANAGEMENT_DELETE_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          ScheduleManagementCommandResult,
          { readonly kind: "deleted" }
        >,
        facts: [],
      })),
      bindProductApiOperation(SCHEDULE_MANUAL_RUN_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          ScheduleManagementCommandResult,
          { readonly kind: "ran" }
        >,
        facts: [],
      })),
      bindProductApiOperation(SCHEDULE_MANUAL_ABORT_COMMAND, async (command) => ({
        result: await application.execute(command) as Extract<
          ScheduleManagementCommandResult,
          { readonly kind: "run-aborted" }
        >,
        facts: [],
      })),
    ],
    factEvents: [],
  });
}

function normalizeOperation(
  operation: ScheduleManagementOperation,
  requiresRevision: false,
): ScheduleManagementOperation;
function normalizeOperation(
  operation: ScheduleManagementOperation,
  requiresRevision: true,
): ScheduleManagementOperation & { readonly expectedRevision: number };
function normalizeOperation(
  operation: ScheduleManagementOperation,
  requiresRevision: boolean,
): ScheduleManagementOperation {
  const operationId = nonEmpty(operation.operationId, "Schedule operation id");
  const expectedRevision = operation.expectedRevision;
  if (requiresRevision && (!Number.isSafeInteger(expectedRevision) || expectedRevision! <= 0)) {
    throw invalid("Schedule mutation requires an observed task revision");
  }
  return Object.freeze({
    operationId,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(operation.surface ? { surface: freezeSurface(operation.surface) } : {}),
  });
}

function normalizeSpec(draft: ScheduleTaskDraft | TaskSpec): TaskSpec {
  const spec: TaskSpec = {
    name: requireString(draft.name, "Schedule name"),
    ...(draft.description !== undefined
      ? { description: requireString(draft.description, "Schedule description") }
      : {}),
    enabled: draft.enabled ?? true,
    priority: draft.priority ?? "normal",
    schedule: structuredClone(draft.schedule),
    action: structuredClone(draft.action),
    ...(draft.delivery !== undefined ? { delivery: structuredClone(draft.delivery) } : {}),
  };
  try {
    validateTaskDefinition({
      taskId: "schedule-management-validation",
      taskRevision: 1,
      definition: { kind: "user", spec },
      state: spec.enabled ? "enabled" : "disabled",
    });
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  return spec;
}

function mergeSpec(task: TaskView, patch: TaskPatch): ScheduleTaskDraft {
  if (task.action.kind !== "agent-turn") {
    throw new ScheduleManagementApplicationError(
      "system-task",
      `Cannot modify system task: ${task.id}`,
    );
  }
  return {
    name: patch.name ?? task.name,
    ...(patch.description !== undefined
      ? { description: patch.description }
      : task.description !== undefined
        ? { description: task.description }
        : {}),
    enabled: patch.enabled ?? task.enabled,
    priority: patch.priority ?? task.priority,
    schedule: patch.schedule ?? task.schedule,
    action: patch.action ?? task.action,
    ...(patch.delivery !== undefined
      ? { delivery: patch.delivery }
      : task.delivery !== undefined
        ? { delivery: task.delivery }
        : {}),
  };
}

function freezeSurface(surface: ScheduleManagementSurfaceIdentity): ScheduleManagementSurfaceIdentity {
  return Object.freeze({
    surfacePrincipal: nonEmpty(surface.surfacePrincipal, "Schedule surface principal"),
    connectionId: nonEmpty(surface.connectionId, "Schedule connection id"),
    deviceId: nonEmpty(surface.deviceId, "Schedule device id"),
    ingressId: nonEmpty(surface.ingressId, "Schedule ingress id"),
    receivedAt: nonEmpty(surface.receivedAt, "Schedule received time"),
  });
}

function cloneTask(task: TaskView): TaskView {
  return structuredClone(task);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(`${label} must be non-empty`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  return value;
}

function invalid(message: string): ScheduleManagementApplicationError {
  return new ScheduleManagementApplicationError("invalid-command", message);
}

function mapRepositoryError(error: unknown): unknown {
  if (error instanceof ScheduleManagementApplicationError) return error;
  if (!(error instanceof Error)) return error;
  if (error.message.startsWith("Task not found")) {
    return new ScheduleManagementApplicationError("not-found", error.message);
  }
  if (error.message.startsWith("Cannot modify system task") ||
      error.message.startsWith("Cannot delete system task")) {
    return new ScheduleManagementApplicationError("system-task", error.message);
  }
  if (/revision conflict|expected revision|conflicting payload/i.test(error.message)) {
    return new ScheduleManagementApplicationError("conflict", error.message);
  }
  return error;
}
