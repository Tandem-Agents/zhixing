import type {
  AuthorityError,
  JsonValue,
  LogicalRecord,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { canonicalize, validateTaskDefinition } from "@zhixing/core/protocol";
import { scheduleTaskIdForRequest } from "./scheduler-authority.js";

export type SchedulePublishOutcome =
  | { readonly t: "granted"; readonly targetRevision: number }
  | { readonly t: "conflicted"; readonly error: AuthorityError };

export interface ScheduleMutationCommitRecord {
  readonly seq: number;
  readonly requestId: string;
  readonly mutation: ScheduleWriteMutation;
}

export interface ScheduleDefinitionSource {
  readonly origin?: Extract<
    TaskDefinition["definition"],
    { readonly kind: "user" }
  >["origin"];
  readonly interactionResponder?: Extract<
    TaskDefinition["definition"],
    { readonly kind: "user" }
  >["interactionResponder"];
  readonly createdInTurn?: string;
}

export interface ScheduleMutationCommitPlan {
  readonly records: readonly LogicalRecord<JsonValue>[];
  readonly outcomes: ReadonlyMap<number, SchedulePublishOutcome>;
  readonly taskIds: readonly string[];
}

/** Purely plans schedule revisions that are appended with the owning run commit. */
export function planScheduleMutationCommit(input: {
  readonly records: readonly ScheduleMutationCommitRecord[];
  readonly definitionFor: (taskId: string) => TaskDefinition | undefined;
  readonly source: ScheduleDefinitionSource;
}): ScheduleMutationCommitPlan {
  const records: LogicalRecord<JsonValue>[] = [];
  const outcomes = new Map<number, SchedulePublishOutcome>();
  const overlay = new Map<string, TaskDefinition>();
  const touched = new Set<string>();

  for (const record of input.records) {
    const planned = planMutation(record, overlay, input.definitionFor, input.source);
    outcomes.set(record.seq, planned.outcome);
    if (!planned.definition) continue;
    overlay.set(planned.definition.taskId, planned.definition);
    touched.add(planned.definition.taskId);
    records.push(taskRevisionLogicalRecord(planned.definition));
  }

  return {
    records,
    outcomes,
    taskIds: [...touched].sort((left, right) => left.localeCompare(right, "en-US")),
  };
}

export function scheduleMutationTaskId(
  mutation: ScheduleWriteMutation,
  requestId: string,
): string {
  return mutation.kind === "schedule-create"
    ? scheduleTaskIdForRequest(requestId)
    : mutation.taskId;
}

function planMutation(
  record: ScheduleMutationCommitRecord,
  overlay: ReadonlyMap<string, TaskDefinition>,
  definitionFor: (taskId: string) => TaskDefinition | undefined,
  source: ScheduleDefinitionSource,
): { readonly outcome: SchedulePublishOutcome; readonly definition?: TaskDefinition } {
  const mutation = record.mutation;
  if (mutation.kind === "schedule-create") {
    const taskId = scheduleTaskIdForRequest(record.requestId);
    const existing = overlay.get(taskId) ?? definitionFor(taskId);
    const definition = validateTaskDefinition({
      taskId,
      taskRevision: 1,
      definition: {
        kind: "user",
        spec: structuredClone(mutation.spec),
        ...(source.origin ? { origin: structuredClone(source.origin) } : {}),
        ...(source.interactionResponder
          ? { interactionResponder: structuredClone(source.interactionResponder) }
          : {}),
        ...(source.createdInTurn ? { createdInTurn: source.createdInTurn } : {}),
      },
      state: mutation.spec.enabled ? "enabled" : "disabled",
    });
    if (existing) {
      return sameDefinition(existing, definition)
        ? { outcome: { t: "granted", targetRevision: existing.taskRevision } }
        : {
            outcome: conflict(
              "idempotency-conflict",
              "Schedule create requestId is already bound to another task definition",
            ),
          };
    }
    return {
      definition,
      outcome: { t: "granted", targetRevision: definition.taskRevision },
    };
  }

  const current = overlay.get(mutation.taskId) ?? definitionFor(mutation.taskId);
  if (!current || current.state === "deleted") {
    return { outcome: conflict("not-found", "Scheduled task was not found") };
  }
  if (current.definition.kind !== "user") {
    return {
      outcome: conflict("unauthorized", "System tasks are controlled only by the host"),
    };
  }
  if (current.taskRevision !== mutation.taskRevision) {
    return {
      outcome: conflict("revision-conflict", "Scheduled task revision changed"),
    };
  }

  const taskRevision = current.taskRevision + 1;
  const definition = validateTaskDefinition(
    mutation.kind === "schedule-update"
      ? {
          taskId: current.taskId,
          taskRevision,
          definition: {
            ...structuredClone(current.definition),
            spec: structuredClone(mutation.spec),
          },
          state: mutation.spec.enabled ? "enabled" : "disabled",
        }
      : mutation.kind === "schedule-set-state"
        ? {
            ...structuredClone(current),
            taskRevision,
            state: mutation.state,
            definition: {
              ...structuredClone(current.definition),
              spec: {
                ...structuredClone(current.definition.spec),
                enabled: mutation.state === "enabled",
              },
            },
          }
        : {
            ...structuredClone(current),
            taskRevision,
            state: "deleted",
            definition: {
              ...structuredClone(current.definition),
              spec: { ...structuredClone(current.definition.spec), enabled: false },
            },
          },
  );
  return {
    definition,
    outcome: { t: "granted", targetRevision: definition.taskRevision },
  };
}

function taskRevisionLogicalRecord(
  definition: TaskDefinition,
): LogicalRecord<JsonValue> {
  return {
    stream: `job:${definition.taskId}`,
    body: {
      t: "task-revision",
      taskId: definition.taskId,
      taskRevision: definition.taskRevision,
      state: definition.state,
      kind: definition.definition.kind,
      def: structuredClone(definition),
    } as unknown as JsonValue,
  };
}

function conflict(
  code: AuthorityError["code"],
  message: string,
): SchedulePublishOutcome {
  return { t: "conflicted", error: { code, message, retryable: false } };
}

function sameDefinition(left: TaskDefinition, right: TaskDefinition): boolean {
  return canonicalize(left) === canonicalize(right);
}
