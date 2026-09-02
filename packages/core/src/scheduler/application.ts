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
import { computeStatusSummary, isInternal } from "./status-summary.js";
import type { AgentTurnResult, TaskStatusSummary } from "./types.js";

export {
  DEFAULT_SCHEDULE_FAILURE_THRESHOLD,
  countScheduleConsecutiveFailures,
  decideScheduleFailurePolicy,
  decideScheduleTrigger,
  deriveScheduleNextRun,
  scheduleAutoDisableOperationId,
  scheduleJobRunId,
  scheduleTimerDelay,
  selectPendingScheduleAutoDisable,
  selectDueScheduleEntries,
} from "./runtime-policy.js";
export type { ScheduleTriggerDecision } from "./runtime-policy.js";
export type {
  ScheduleFailureFact,
  ScheduleFailurePolicyDecision,
} from "./runtime-policy.js";
export { ScheduleRuntimePolicyError } from "./runtime-policy.js";

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

/** Raw runtime facts exposed by the Schedule Correctness mechanism. */
export type ScheduleRuntimeSignal =
  | {
      readonly kind: "accepted";
      readonly taskId: string;
      readonly jobRunId: string;
      readonly name: string;
    }
  | { readonly kind: "started"; readonly taskId: string; readonly name: string }
  | {
      readonly kind: "completed";
      readonly taskId: string;
      readonly name: string;
      readonly durationMs: number;
      readonly summary?: string;
    }
  | {
      readonly kind: "failed";
      readonly taskId: string;
      readonly name: string;
      readonly error: string;
      readonly consecutiveErrors: number;
      readonly nextRunAt?: string;
    }
  | {
      readonly kind: "disabled";
      readonly taskId: string;
      readonly name: string;
      readonly reason: string;
      readonly lastError?: string;
    };

/** User-visible runtime event owned by the Schedule domain. */
export type ScheduleRuntimeEvent =
  | {
      readonly kind: "accepted";
      readonly taskId: string;
      readonly jobRunId: string;
      readonly name: string;
    }
  | { readonly kind: "started"; readonly taskId: string; readonly name: string }
  | {
      readonly kind: "completed";
      readonly taskId: string;
      readonly name: string;
      readonly status: "ok";
      readonly durationMs: number;
      readonly summary?: string;
    }
  | {
      readonly kind: "completed";
      readonly taskId: string;
      readonly name: string;
      readonly status: "error";
      readonly error: string;
      readonly consecutiveErrors: number;
      readonly nextRunAt?: string;
    }
  | {
      readonly kind: "disabled";
      readonly taskId: string;
      readonly name: string;
      readonly reason: string;
      readonly lastError?: string;
    };

export interface ScheduleRuntimeStatusView {
  readonly activeRunCount: number;
  readonly enabledUserTaskCount: number;
  readonly turnContext: TaskStatusSummary;
}

/** Path-free runtime facts supplied by the current durable Schedule mechanism. */
export interface ScheduleRuntimeProjectionPort {
  snapshot(): {
    readonly tasks: readonly TaskView[];
    readonly activeRunCount: number;
  };
  onSignal(handler: (signal: ScheduleRuntimeSignal) => void): () => void;
}

/** Finite read/event surface consumed by Kernel, RPC and local product surfaces. */
export interface ScheduleRuntimeApplication {
  readStatus(): ScheduleRuntimeStatusView;
  onEvent(handler: (event: ScheduleRuntimeEvent) => void): () => void;
}

/**
 * Sole owner of Schedule runtime visibility and event semantics. The adapter
 * supplies mechanism facts only; user visibility, failure folding and status
 * projection are decided here.
 */
export class ScheduleRuntimeApplicationService implements ScheduleRuntimeApplication {
  constructor(
    private readonly projection: ScheduleRuntimeProjectionPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readStatus(): ScheduleRuntimeStatusView {
    const snapshot = this.projection.snapshot();
    const visible = snapshot.tasks.filter((task) => !isInternal(task));
    return Object.freeze({
      activeRunCount: requireNonNegativeInteger(snapshot.activeRunCount),
      enabledUserTaskCount: visible.filter((task) => task.enabled).length,
      turnContext: freezeStatusSummary(computeStatusSummary([...visible], this.now())),
    });
  }

  onEvent(handler: (event: ScheduleRuntimeEvent) => void): () => void {
    return this.projection.onSignal((signal) => {
      const task = this.projection.snapshot().tasks.find((candidate) =>
        candidate.id === signal.taskId
      );
      if (task && isInternal(task)) return;
      handler(projectScheduleRuntimeEvent(signal));
    });
  }
}

export interface ScheduleAcceptedWorkItem {
  readonly id: string;
  readonly revision: string;
}

/** Correctness mechanism required by the Schedule lifecycle application. */
export interface ScheduleLifecycleMechanismPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  activate(): void;
  closeAdmission(): void;
  listAcceptedWork(): Promise<readonly ScheduleAcceptedWorkItem[]>;
  recoverAcceptedWork(frozen: readonly ScheduleAcceptedWorkItem[]): Promise<void>;
  pauseAndSettle(): Promise<void>;
  resumeAdmission(): void;
  recoverInstalledAuthority(): Promise<void>;
  resumeManualSurfaces(): Promise<void>;
}

/** Host-facing, finite lifecycle application owned by Schedule. */
export interface ScheduleLifecycleApplication {
  install(mechanism: ScheduleLifecycleMechanismPort): void;
  release(mechanism: ScheduleLifecycleMechanismPort): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  activate(): void;
  closeAdmission(): void;
  captureAcceptedWork(): Promise<readonly ScheduleAcceptedWorkItem[]>;
  recoverAcceptedWork(frozen: readonly ScheduleAcceptedWorkItem[]): Promise<void>;
  settleAcceptedWork(input: {
    readonly strategy: "immediate" | "drain" | "cancel";
    readonly frozen: readonly ScheduleAcceptedWorkItem[];
  }): Promise<void>;
  assertAcceptedWorkSettled(frozen: readonly ScheduleAcceptedWorkItem[]): Promise<void>;
  resumeAdmission(): void;
  recoverInstalledAuthority(): Promise<void>;
  resumeManualSurfaces(): Promise<void>;
}

/** One stable Host boundary for Schedule runtime visibility and lifecycle. */
export interface ScheduleApplication
  extends ScheduleRuntimeApplication, ScheduleLifecycleApplication {}

export class ScheduleApplicationService implements ScheduleApplication {
  #mechanism: ScheduleLifecycleMechanismPort | undefined;

  constructor(private readonly runtime: ScheduleRuntimeApplication) {}

  install(mechanism: ScheduleLifecycleMechanismPort): void {
    if (this.#mechanism === mechanism) return;
    if (this.#mechanism) {
      throw new Error("Schedule lifecycle mechanism is already installed");
    }
    this.#mechanism = mechanism;
  }

  release(mechanism: ScheduleLifecycleMechanismPort): void {
    if (this.#mechanism !== mechanism) {
      throw new Error("Cannot release a foreign Schedule lifecycle mechanism");
    }
    this.#mechanism = undefined;
  }

  readStatus(): ScheduleRuntimeStatusView {
    return this.runtime.readStatus();
  }

  onEvent(handler: (event: ScheduleRuntimeEvent) => void): () => void {
    return this.runtime.onEvent(handler);
  }

  start(): Promise<void> {
    return this.#requireMechanism().start();
  }

  stop(): Promise<void> {
    return this.#mechanism?.stop() ?? Promise.resolve();
  }

  activate(): void {
    this.#requireMechanism().activate();
  }

  closeAdmission(): void {
    this.#requireMechanism().closeAdmission();
  }

  async captureAcceptedWork(): Promise<readonly ScheduleAcceptedWorkItem[]> {
    return freezeAcceptedWork(await (this.#mechanism?.listAcceptedWork() ?? []));
  }

  recoverAcceptedWork(frozen: readonly ScheduleAcceptedWorkItem[]): Promise<void> {
    const acceptedWork = freezeAcceptedWork(frozen);
    if (!this.#mechanism && acceptedWork.length === 0) return Promise.resolve();
    return this.#requireMechanism().recoverAcceptedWork(acceptedWork);
  }

  async settleAcceptedWork(input: {
    readonly strategy: "immediate" | "drain" | "cancel";
    readonly frozen: readonly ScheduleAcceptedWorkItem[];
  }): Promise<void> {
    const frozen = freezeAcceptedWork(input.frozen);
    assertSettlementStrategy(input.strategy);
    if (!this.#mechanism && frozen.length === 0) return;
    const mechanism = this.#requireMechanism();
    assertAcceptedWorkSubset(await mechanism.listAcceptedWork(), frozen);
    await mechanism.pauseAndSettle();
  }

  async assertAcceptedWorkSettled(
    frozen: readonly ScheduleAcceptedWorkItem[],
  ): Promise<void> {
    const expected = freezeAcceptedWork(frozen);
    if (!this.#mechanism && expected.length === 0) return;
    const current = await this.#requireMechanism().listAcceptedWork();
    assertAcceptedWorkSubset(current, expected);
    if (current.length !== 0) {
      throw new Error("Schedule accepted work is not settled");
    }
  }

  resumeAdmission(): void {
    this.#requireMechanism().resumeAdmission();
  }

  recoverInstalledAuthority(): Promise<void> {
    return this.#requireMechanism().recoverInstalledAuthority();
  }

  resumeManualSurfaces(): Promise<void> {
    return this.#requireMechanism().resumeManualSurfaces();
  }

  #requireMechanism(): ScheduleLifecycleMechanismPort {
    if (!this.#mechanism) {
      throw new Error("Schedule lifecycle mechanism is not installed");
    }
    return this.#mechanism;
  }
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

export const SCHEDULE_RUNTIME_STATUS_QUERY = defineProductApiQuery<
  "schedule-runtime.query.status",
  { readonly kind: "runtime-status" },
  ScheduleRuntimeStatusView
>("schedule-runtime.query.status");

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

export const SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [SCHEDULE_RUNTIME_STATUS_QUERY],
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

export function createScheduleRuntimeProductApiContribution(
  application: ScheduleRuntimeApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(SCHEDULE_RUNTIME_STATUS_QUERY, async (query) => {
        if (query.kind !== "runtime-status") {
          throw invalid("Unsupported Schedule runtime query");
        }
        return { result: application.readStatus(), facts: [] };
      }),
    ],
    factEvents: [],
  });
}

function projectScheduleRuntimeEvent(signal: ScheduleRuntimeSignal): ScheduleRuntimeEvent {
  switch (signal.kind) {
    case "accepted":
      return Object.freeze({ ...signal });
    case "started":
      return Object.freeze({ ...signal });
    case "completed":
      return Object.freeze({ ...signal, status: "ok" as const });
    case "failed":
      return Object.freeze({
        kind: "completed" as const,
        taskId: signal.taskId,
        name: signal.name,
        status: "error" as const,
        error: signal.error,
        consecutiveErrors: signal.consecutiveErrors,
        ...(signal.nextRunAt ? { nextRunAt: signal.nextRunAt } : {}),
      });
    case "disabled":
      return Object.freeze({ ...signal });
  }
}

function requireNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Schedule active run count must be a non-negative integer");
  }
  return value;
}

function freezeStatusSummary(summary: TaskStatusSummary): TaskStatusSummary {
  return Object.freeze({
    active: Object.freeze(summary.active.map((entry) => Object.freeze({ ...entry }))),
    recentlyCompleted: Object.freeze(
      summary.recentlyCompleted.map((entry) => Object.freeze({ ...entry })),
    ),
    recentlyFailed: Object.freeze(
      summary.recentlyFailed.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

function assertSettlementStrategy(
  strategy: "immediate" | "drain" | "cancel",
): void {
  switch (strategy) {
    case "immediate":
    case "drain":
    case "cancel":
      return;
  }
}

function freezeAcceptedWork(
  items: readonly ScheduleAcceptedWorkItem[],
): readonly ScheduleAcceptedWorkItem[] {
  const ids = new Set<string>();
  return Object.freeze(items.map((item) => {
    const id = nonEmpty(item.id, "Schedule accepted-work id");
    const revision = nonEmpty(item.revision, "Schedule accepted-work revision");
    if (ids.has(id)) throw new TypeError(`Duplicate Schedule accepted-work id: ${id}`);
    ids.add(id);
    return Object.freeze({ id, revision });
  }).sort((left, right) => left.id.localeCompare(right.id, "en-US")));
}

function assertAcceptedWorkSubset(
  current: readonly ScheduleAcceptedWorkItem[],
  frozen: readonly ScheduleAcceptedWorkItem[],
): void {
  const expected = new Map(frozen.map((item) => [item.id, item.revision]));
  for (const item of current) {
    if (expected.get(item.id) !== item.revision) {
      throw new Error("Schedule lifecycle observed work outside the frozen accepted-work set");
    }
  }
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
