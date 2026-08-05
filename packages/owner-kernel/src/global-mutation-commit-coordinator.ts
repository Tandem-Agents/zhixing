import { Buffer } from "node:buffer";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  ProjectionTransactionContext,
} from "@zhixing/core/authority";
import type {
  GlobalStagedMutation,
  JsonValue,
  LogicalRecord,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { validateTaskDefinition } from "@zhixing/core/protocol";
import type {
  GlobalMutationCommitParticipant,
  GlobalMutationCommitRecord,
  GlobalMutationPublishOutcome,
} from "./global-mutation-participant.js";
import {
  planScheduleMutationCommit,
  scheduleMutationTaskId,
  type ScheduleDefinitionSource,
  type SchedulePublishOutcome,
} from "./scheduler-mutation-commit.js";

export const SCHEDULE_AUTHORITY_PROJECTION_ID = "global-schedule-authority-v1";

const SCHEDULE_DEFINITION_PREFIX = "definition:";
const SCHEDULE_PENDING_PREFIX = "pending:";
const SCHEDULE_MATERIALIZATION_STREAM = "schedule-materialization";

type CoordinatorOutcome = GlobalMutationPublishOutcome | SchedulePublishOutcome;

export interface GlobalMutationCommitCoordinatorOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly participants?: readonly GlobalMutationCommitParticipant[];
  readonly refreshSchedule: (taskIds: readonly string[]) => Promise<void>;
  readonly scheduleDefinitionFor: (taskId: string) => TaskDefinition | undefined;
}

/**
 * Plans every anchor-owned global mutation against durable read models caught
 * up under the same AuthorityCommitLog lock as the owning run decision.
 */
export class GlobalMutationCommitCoordinator {
  readonly #log: AuthorityCommitLog;
  readonly #participants: readonly GlobalMutationCommitParticipant[];
  readonly #refreshSchedule: (taskIds: readonly string[]) => Promise<void>;
  readonly #scheduleDefinitionFor: (taskId: string) => TaskDefinition | undefined;
  readonly #scheduleProjection;

  constructor(options: GlobalMutationCommitCoordinatorOptions) {
    this.#log = options.log;
    this.#participants = [...(options.participants ?? [])];
    const ids = this.#participants.map((participant) => participant.stagedProjectionId);
    if (new Set(ids).size !== ids.length) {
      throw new TypeError("Global mutation participants must own distinct projections");
    }
    this.#refreshSchedule = options.refreshSchedule;
    this.#scheduleDefinitionFor = options.scheduleDefinitionFor;
    this.#scheduleProjection = options.log.durableProjection({
      projectionId: SCHEDULE_AUTHORITY_PROJECTION_ID,
      reducerVersion: 1,
      reduce: (envelope, current) =>
        reduceScheduleProjection(envelope, current, options.artifacts),
    });
  }

  get readProjectionIds(): readonly string[] {
    return [
      SCHEDULE_AUTHORITY_PROJECTION_ID,
      ...this.#participants.map((participant) => participant.stagedProjectionId),
    ].sort((left, right) => left.localeCompare(right, "en-US"));
  }

  async prepare(input: {
    readonly assignmentId: string;
    readonly records: readonly GlobalMutationCommitRecord[];
    readonly context: ProjectionTransactionContext;
    readonly source: ScheduleDefinitionSource;
    readonly sourceTaskId?: string;
  }): Promise<{
    readonly records: readonly LogicalRecord[];
    readonly outcomes: ReadonlyMap<number, CoordinatorOutcome>;
  }> {
    const outcomes = new Map<number, CoordinatorOutcome>();
    const scheduleRecords: Array<GlobalMutationCommitRecord & {
      readonly mutation: ScheduleWriteMutation;
    }> = [];
    const participantRecords = new Map<
      GlobalMutationCommitParticipant,
      GlobalMutationCommitRecord[]
    >();

    for (const record of input.records) {
      if (isScheduleMutation(record.mutation)) {
        scheduleRecords.push({ ...record, mutation: record.mutation });
        continue;
      }
      const owners = this.#participants.filter((participant) =>
        participant.ownsStagedMutation(record.mutation),
      );
      if (owners.length > 1) {
        throw new Error("A staged global mutation has multiple anchor owners");
      }
      const owner = owners[0];
      if (!owner) {
        outcomes.set(record.seq, conflict(
          "capability-gap",
          "This owner does not publish the staged global mutation domain",
        ));
        continue;
      }
      const owned = participantRecords.get(owner) ?? [];
      owned.push(record);
      participantRecords.set(owner, owned);
    }

    const scheduleProjection = input.context.readProjection(
      SCHEDULE_AUTHORITY_PROJECTION_ID,
    );
    const definitions = await loadScheduleDefinitions(scheduleProjection, [
      ...scheduleRecords.map((record) => scheduleMutationTaskId(record.mutation, record.requestId)),
      ...(input.sourceTaskId ? [input.sourceTaskId] : []),
    ]);
    const source = input.sourceTaskId
      ? sourceForDefinition(definitions.get(input.sourceTaskId))
      : input.source;
    const schedulePlan = planScheduleMutationCommit({
      records: scheduleRecords,
      definitionFor: (taskId) => definitions.get(taskId),
      source,
    });
    for (const [seq, outcome] of schedulePlan.outcomes) outcomes.set(seq, outcome);
    const plannedRecords: LogicalRecord[] = [...schedulePlan.records];

    for (const [participant, records] of participantRecords) {
      const prepared = await participant.prepareStagedMutations({
        assignmentId: input.assignmentId,
        records,
        authorityProjection: input.context.readProjection(participant.stagedProjectionId),
        at: input.context.at,
      });
      plannedRecords.push(...prepared.records);
      for (const [seq, outcome] of prepared.outcomes) outcomes.set(seq, outcome);
    }
    return { records: plannedRecords, outcomes };
  }

  async apply(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly mutation: GlobalStagedMutation;
    readonly requestId: string;
    readonly targetRevision: number;
    readonly appliedResult?: import("@zhixing/core/contracts").WorksceneAppliedResult;
  }): Promise<void> {
    if (isScheduleMutation(input.mutation)) {
      await this.#materializeSchedule(
        scheduleMutationTaskId(input.mutation, input.requestId),
        input.targetRevision,
      );
      return;
    }
    const owners = this.#participants.filter((participant) =>
      participant.ownsStagedMutation(input.mutation),
    );
    if (owners.length !== 1) {
      throw new Error("Committed global mutation has no unique anchor owner");
    }
    await owners[0]!.applyStagedMutation(input);
  }

  async recoverDerivedState(): Promise<void> {
    await this.#log.transactDurableProjection(
      SCHEDULE_AUTHORITY_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
    let continuation: string | undefined;
    do {
      const page = await this.#scheduleProjection.scan(
        {
          gte: SCHEDULE_PENDING_PREFIX,
          lt: `${SCHEDULE_PENDING_PREFIX}\uffff`,
        },
        128,
        continuation,
      );
      for (const item of page.entries) {
        const pending = readSchedulePending(item.value);
        if (!pending) throw new Error("Schedule pending projection entry is missing");
        await this.#materializeSchedule(pending.taskId, pending.targetRevision);
      }
      continuation = page.continuation;
    } while (continuation !== undefined);
    for (const participant of this.#participants) {
      await participant.refreshStagedMutations?.([]);
    }
  }

  async #materializeSchedule(taskId: string, targetRevision: number): Promise<void> {
    await this.#refreshSchedule([taskId]);
    const definition = this.#scheduleDefinitionFor(taskId);
    if (!definition || definition.taskRevision < targetRevision) {
      throw new Error("Committed schedule revision is unavailable for projection");
    }
    await this.#log.transactDurableProjection(
      SCHEDULE_AUTHORITY_PROJECTION_ID,
      async (projection) => {
        const pending = readSchedulePending(
          await projection.get(schedulePendingKey(taskId)),
          true,
        );
        if (!pending || pending.targetRevision > targetRevision) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [{
            stream: SCHEDULE_MATERIALIZATION_STREAM,
            body: {
              t: "schedule-materialized",
              taskId,
              targetRevision,
            },
          }],
          value: undefined,
        };
      },
    );
  }
}

async function reduceScheduleProjection(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
  artifacts: ArtifactStore,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const read = async (key: string): Promise<JsonValue | undefined> =>
    overlay.has(key) ? overlay.get(key) : current.get(key);
  const put = (key: string, value: JsonValue): void => {
    mutations.push({ kind: "put", key, value });
    overlay.set(key, value);
  };
  const tombstone = (key: string): void => {
    mutations.push({ kind: "tombstone", key });
    overlay.set(key, undefined);
  };
  for (const logical of envelope.entries) {
    const body = logical.body;
    if (logical.stream.startsWith("job:") && isTaskRevisionRecord(body)) {
      const definition = await loadTaskDefinition(body.def, artifacts);
      if (
        definition.taskId !== body.taskId ||
        definition.taskRevision !== body.taskRevision ||
        definition.state !== body.state ||
        definition.definition.kind !== body.kind
      ) {
        throw new Error("Schedule task revision does not bind its definition");
      }
      const currentDefinition = readTaskDefinition(
        await read(scheduleDefinitionKey(definition.taskId)),
        true,
      );
      if (
        currentDefinition &&
        definition.taskRevision !== currentDefinition.taskRevision + 1
      ) {
        throw new Error("Schedule task revision is not contiguous");
      }
      if (!currentDefinition && definition.taskRevision !== 1) {
        throw new Error("Schedule task history does not start at revision one");
      }
      put(
        scheduleDefinitionKey(definition.taskId),
        definition as unknown as JsonValue,
      );
      put(schedulePendingKey(definition.taskId), {
        taskId: definition.taskId,
        targetRevision: definition.taskRevision,
      });
      continue;
    }
    if (
      logical.stream === SCHEDULE_MATERIALIZATION_STREAM &&
      isScheduleMaterialized(body)
    ) {
      const pending = readSchedulePending(
        await read(schedulePendingKey(body.taskId)),
        true,
      );
      if (pending && pending.targetRevision <= body.targetRevision) {
        tombstone(schedulePendingKey(body.taskId));
      }
    }
  }
  return mutations;
}

async function loadScheduleDefinitions(
  projection: DurableProjectionReadContext,
  taskIds: readonly string[],
): Promise<Map<string, TaskDefinition>> {
  const result = new Map<string, TaskDefinition>();
  for (const taskId of [...new Set(taskIds)].sort((left, right) =>
    left.localeCompare(right, "en-US")
  )) {
    const definition = readTaskDefinition(
      await projection.get(scheduleDefinitionKey(taskId)),
      true,
    );
    if (definition) result.set(taskId, definition);
  }
  return result;
}

async function loadTaskDefinition(
  stored: JsonValue,
  artifacts: ArtifactStore,
): Promise<TaskDefinition> {
  if (isArtifactReference(stored)) {
    const bytes = await artifacts.get(
      stored.ref as unknown as import("@zhixing/core/contracts").ArtifactRef,
    );
    return validateTaskDefinition(
      JSON.parse(Buffer.from(bytes).toString("utf8")) as TaskDefinition,
    );
  }
  return validateTaskDefinition(stored as unknown as TaskDefinition);
}

function readTaskDefinition(
  value: JsonValue | undefined,
  optional = false,
): TaskDefinition | undefined {
  if (value === undefined && optional) return undefined;
  return validateTaskDefinition(value as unknown as TaskDefinition);
}

function readSchedulePending(
  value: JsonValue | undefined,
  optional = false,
): { readonly taskId: string; readonly targetRevision: number } | undefined {
  if (value === undefined && optional) return undefined;
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "targetRevision,taskId" ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0 ||
    !Number.isSafeInteger(value.targetRevision) ||
    Number(value.targetRevision) <= 0
  ) {
    throw new Error("Schedule materialization checkpoint is invalid");
  }
  return { taskId: value.taskId, targetRevision: Number(value.targetRevision) };
}

function sourceForDefinition(definition: TaskDefinition | undefined): ScheduleDefinitionSource {
  if (!definition || definition.definition.kind !== "user") return {};
  return {
    ...(definition.definition.origin
      ? { origin: structuredClone(definition.definition.origin) }
      : {}),
    ...(definition.definition.interactionResponder
      ? { interactionResponder: structuredClone(definition.definition.interactionResponder) }
      : {}),
    ...(definition.definition.createdInTurn
      ? { createdInTurn: definition.definition.createdInTurn }
      : {}),
  };
}

function scheduleDefinitionKey(taskId: string): string {
  return `${SCHEDULE_DEFINITION_PREFIX}${taskId}`;
}

function schedulePendingKey(taskId: string): string {
  return `${SCHEDULE_PENDING_PREFIX}${taskId}`;
}

function isScheduleMutation(mutation: GlobalStagedMutation): mutation is ScheduleWriteMutation {
  return mutation.kind.startsWith("schedule-");
}

function isTaskRevisionRecord(value: JsonValue): value is {
  readonly t: "task-revision";
  readonly taskId: string;
  readonly taskRevision: number;
  readonly state: TaskDefinition["state"];
  readonly kind: TaskDefinition["definition"]["kind"];
  readonly def: JsonValue;
} {
  return isPlainRecord(value) && value.t === "task-revision" &&
    typeof value.taskId === "string" &&
    Number.isSafeInteger(value.taskRevision) &&
    typeof value.state === "string" &&
    typeof value.kind === "string" &&
    "def" in value;
}

function isScheduleMaterialized(value: JsonValue): value is {
  readonly t: "schedule-materialized";
  readonly taskId: string;
  readonly targetRevision: number;
} {
  return isPlainRecord(value) &&
    Object.keys(value).sort().join(",") === "t,targetRevision,taskId" &&
    value.t === "schedule-materialized" &&
    typeof value.taskId === "string" &&
    Number.isSafeInteger(value.targetRevision);
}

function isArtifactReference(value: JsonValue): value is { readonly ref: string } {
  return isPlainRecord(value) &&
    Object.keys(value).join(",") === "ref" &&
    typeof value.ref === "string";
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conflict(
  code: import("@zhixing/core/contracts").AuthorityError["code"],
  message: string,
): { readonly t: "conflicted"; readonly error: import("@zhixing/core/contracts").AuthorityError } {
  return { t: "conflicted", error: { code, message, retryable: false } };
}
