import { projectionCheckpointKey } from "@zhixing/core/authority";
import { Buffer } from "node:buffer";
import { assertArtifactRef, collectArtifactRefs } from "@zhixing/core/authority";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  ProjectionTransactionContext,
  DurableLogCheckpoint,
} from "@zhixing/core/authority";
import type {
  GlobalStagedMutation,
  JsonValue,
  LogicalRecord,
  ScheduleWriteMutation,
  TaskDefinition,
  ArtifactRef,
} from "@zhixing/core/contracts";
import { validateTaskDefinition } from "@zhixing/core/protocol";
import { CommittedMutationMaterializationError } from "@zhixing/core/protocol";
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
export const SCHEDULE_AUTHORITY_REDUCER_VERSION = 2;

const SCHEDULE_DEFINITION_PREFIX = "definition:";
const SCHEDULE_PENDING_PREFIX = "pending:";
const SCHEDULE_MATERIALIZATION_STREAM = "job:schedule-materialization";

/** Enumerate task journals without treating the schedule coordinator's own stream as a task. */
/**
 * 全部定时任务标识（`job:` 流名）。结果随检查点保存：重启后只续读其后的尾部，不为枚举流名
 * 解析整份历史；没有检查点时完整读取一次。
 */
export async function listScheduleTaskIds(log: AuthorityCommitLog): Promise<readonly string[]> {
  const restored = await log.loadProjectionCheckpoint?.<readonly string[]>(SCHEDULE_TASK_IDS_CHECKPOINT);
  const initial = new Set<string>(Array.isArray(restored?.state) ? restored.state : []);
  const read = await log.readProjection<Set<string>, unknown>(
    initial,
    (current, entry) => {
      const taskId = scheduleTaskIdOf(entry.stream);
      if (taskId === undefined || current.has(taskId)) return current;
      // 日志内部重试时从未改动的起点重新收集。
      const next = current === initial ? new Set(current) : current;
      next.add(taskId);
      return next;
    },
    restored ? { cursor: restored.cursor } : {},
  );
  const taskIds = [...read.state].sort();
  if (read.cursor.lsn > (restored?.cursor.lsn ?? 0)) {
    await log.saveProjectionCheckpoint?.(SCHEDULE_TASK_IDS_CHECKPOINT, read.cursor, taskIds);
  }
  return taskIds;
}

function scheduleTaskIdOf(stream: string): string | undefined {
  return stream.startsWith("job:") && stream.length > 4 && stream !== SCHEDULE_MATERIALIZATION_STREAM
    ? stream.slice(4)
    : undefined;
}

const SCHEDULE_TASK_IDS_CHECKPOINT = projectionCheckpointKey("schedule-task-ids", 1, scheduleTaskIdOf);

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
  readonly #artifacts: ArtifactStore;
  readonly #participants: readonly GlobalMutationCommitParticipant[];
  readonly #refreshSchedule: (taskIds: readonly string[]) => Promise<void>;
  readonly #scheduleDefinitionFor: (taskId: string) => TaskDefinition | undefined;
  readonly #scheduleProjection;

  constructor(options: GlobalMutationCommitCoordinatorOptions) {
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#participants = [...(options.participants ?? [])];
    const ids = this.#participants.map((participant) => participant.stagedProjectionId);
    if (new Set(ids).size !== ids.length) {
      throw new TypeError("Global mutation participants must own distinct projections");
    }
    this.#refreshSchedule = options.refreshSchedule;
    this.#scheduleDefinitionFor = options.scheduleDefinitionFor;
    this.#scheduleProjection = registerScheduleAuthorityProjection(options.log, options.artifacts);
  }

  get readProjectionIds(): readonly string[] {
    return [
      SCHEDULE_AUTHORITY_PROJECTION_ID,
      ...this.#participants.map((participant) => participant.stagedProjectionId),
    ].sort((left, right) => left.localeCompare(right, "en-US"));
  }

  async collectStagedReferences(records: readonly GlobalMutationCommitRecord[]) {
    const references = [];
    for (const participant of this.#participants) {
      const owned = records.filter((record) => participant.ownsStagedMutation(record.mutation));
      if (owned.length && participant.collectStagedReferences) {
        references.push(...await participant.collectStagedReferences(owned));
      }
    }
    return collectArtifactRefs(references);
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
    ], this.#artifacts, input.context.readEnvelopeAt ?? (checkpoint => this.#log.readEnvelopeAt(checkpoint)));
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

  async prepareDeferredScheduleIntent(input: {
    readonly intentId: string;
    readonly requestId: string;
    readonly mutation: ScheduleWriteMutation;
    readonly context: ProjectionTransactionContext;
  }): Promise<{
    readonly records: readonly LogicalRecord[];
    readonly targetRevision: number;
    readonly taskId: string;
  }> {
    const prepared = await this.prepare({
      assignmentId: `deferred-intent:${input.intentId}`,
      records: [{ seq: 1, requestId: input.requestId, mutation: input.mutation }],
      context: input.context,
      source: {},
    });
    const outcome = prepared.outcomes.get(1);
    if (!outcome || outcome.t !== "granted") {
      const message = outcome?.t === "conflicted"
        ? outcome.error.message
        : "Deferred schedule intent has no authority outcome";
      throw new TypeError(`Deferred schedule intent remains pending: ${message}`);
    }
    return {
      records: prepared.records,
      targetRevision: outcome.targetRevision,
      taskId: scheduleMutationTaskId(input.mutation, input.requestId),
    };
  }

  applyDeferredScheduleIntent(input: {
    readonly intentId: string;
    readonly requestId: string;
    readonly mutation: ScheduleWriteMutation;
    readonly targetRevision: number;
  }): Promise<void> {
    return this.apply({
      assignmentId: `deferred-intent:${input.intentId}`,
      seq: 1,
      mutation: input.mutation,
      requestId: input.requestId,
      targetRevision: input.targetRevision,
    });
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
      throw new CommittedMutationMaterializationError(
        "Committed global mutation has no unique anchor owner",
      );
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
      throw new CommittedMutationMaterializationError(
        "Committed schedule revision is unavailable for projection",
      );
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

export function registerScheduleAuthorityProjection(log: AuthorityCommitLog, artifacts: ArtifactStore) {
  return log.durableProjection({ projectionId: SCHEDULE_AUTHORITY_PROJECTION_ID,
    reducerVersion: SCHEDULE_AUTHORITY_REDUCER_VERSION, authenticated: true,
    inputs: { families: ["job:"] },
    reduce: (envelope, current, source) => reduceScheduleProjection(envelope, current, artifacts, source.checkpoint),
  });
}

interface ScheduleDefinitionLocator {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly state: TaskDefinition["state"];
  readonly kind: TaskDefinition["definition"]["kind"];
  readonly definition: { readonly ref: ArtifactRef } | { readonly source: { readonly checkpoint: DurableLogCheckpoint; readonly item: number } };
}

async function reduceScheduleProjection(
  envelope: import("@zhixing/core/contracts").CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
  artifacts: ArtifactStore,
  checkpoint: DurableLogCheckpoint,
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
  for (const [item, logical] of envelope.entries.entries()) {
    const body = logical.body;
    if (logical.stream.startsWith("job:") && isTaskRevisionRecord(body)) {
      const definition = await loadTaskDefinition(body.def, artifacts);
      if (
        logical.stream !== `job:${body.taskId}` || definition.taskId !== body.taskId ||
        definition.taskRevision !== body.taskRevision ||
        definition.state !== body.state ||
        definition.definition.kind !== body.kind
      ) {
        throw new Error("Schedule task revision does not bind its definition");
      }
      const currentDefinition = readScheduleLocator(definition.taskId,
        await read(scheduleDefinitionKey(definition.taskId)),
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
        { taskId: definition.taskId, taskRevision: definition.taskRevision, state: definition.state, kind: definition.definition.kind,
          definition: isArtifactReference(body.def) ? { ref: body.def.ref } : { source: { checkpoint, item } } } as unknown as JsonValue,
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
  artifacts: ArtifactStore,
  readEnvelope: NonNullable<ProjectionTransactionContext["readEnvelopeAt"]>,
): Promise<Map<string, TaskDefinition>> {
  const result = new Map<string, TaskDefinition>();
  for (const taskId of [...new Set(taskIds)].sort((left, right) =>
    left.localeCompare(right, "en-US")
  )) {
    const locator = readScheduleLocator(taskId, await projection.get(scheduleDefinitionKey(taskId)));
    if (!locator) continue;
    let stored: JsonValue;
    if ("ref" in locator.definition) stored = { ref: locator.definition.ref } as unknown as JsonValue;
    else {
      const { checkpoint, item } = locator.definition.source;
      const envelope = await readEnvelope(checkpoint);
      const entry = envelope.entries[item];
      if (!entry || entry.stream !== `job:${taskId}` || !isTaskRevisionRecord(entry.body) ||
          entry.body.taskId !== taskId || entry.body.taskRevision !== locator.taskRevision) {
        throw new Error("Schedule definition source does not match its locator");
      }
      stored = entry.body.def;
    }
    const definition = await loadTaskDefinition(stored, artifacts);
    if (definition.taskId !== taskId || definition.taskRevision !== locator.taskRevision || definition.state !== locator.state || definition.definition.kind !== locator.kind) {
      throw new Error("Schedule definition does not match its locator");
    }
    result.set(taskId, definition);
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

function readScheduleLocator(
  taskId: string,
  value: JsonValue | undefined,
): ScheduleDefinitionLocator | undefined {
  if (value === undefined) return;
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== "definition,kind,state,taskId,taskRevision" ||
      value.taskId !== taskId || !Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 ||
      typeof value.state !== "string" || typeof value.kind !== "string" || !isPlainRecord(value.definition)) throw new Error("Schedule definition locator is invalid");
  if ("ref" in value.definition) assertArtifactRef(value.definition.ref);
  else {
    const source = value.definition.source;
    if (!isPlainRecord(source) || !isPlainRecord(source.checkpoint) || !Number.isSafeInteger(source.item) || Number(source.item) < 0) {
      throw new Error("Schedule definition source locator is invalid");
    }
  }
  return value as unknown as ScheduleDefinitionLocator;
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

function isArtifactReference(value: JsonValue): value is { readonly ref: ArtifactRef } & JsonValue {
  return isPlainRecord(value) &&
    Object.keys(value).join(",") === "ref" &&
    isPlainRecord(value.ref) && typeof value.ref.digest === "string" && typeof value.ref.bytes === "number";
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
