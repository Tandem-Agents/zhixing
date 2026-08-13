import { randomUUID } from "node:crypto";
import type {
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  ProjectionCursor,
  RebuildableDurableProjectionIndex,
} from "../authority/index.js";
import { AuthorityStorageError } from "../authority/index.js";
import type {
  AuthorityError,
  Digest,
  JsonValue,
  LogicalRecord,
  WorksceneAppliedResult,
  WorksceneDto,
  WorksceneWriteMutation,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";

const REGISTRY_STREAM = "intent:workscene-registry";
export const WORKSCENE_AUTHORITY_PROJECTION_ID = "global-workscene-authority-v1";
const WORKSCENE_META_KEY = "meta:registry";
const WORKSCENE_SCENE_PREFIX = "scene:";
const WORKSCENE_TOMBSTONE_PREFIX = "tombstone:";
const WORKSCENE_REQUEST_PREFIX = "request:";
const WORKSCENE_PENDING_PREFIX = "pending-deletion:";

type WorksceneRegistryRecord =
  | { t: "workscene-registry-established"; at: string }
  | {
      t: "workscene-control-applied";
      requestId: string;
      mutationDigest: Digest;
      mutation: WorksceneWriteMutation;
      result: WorksceneAppliedResult;
      at: string;
    }
  | {
      t: "workscene-deletion-projected";
      sceneId: string;
      deletionRevision: number;
      at: string;
    };

interface RequestReplay {
  readonly mutationDigest: Digest;
  readonly result?: WorksceneAppliedResult;
}

interface WorksceneRegistryProjection {
  established: boolean;
  domainRevision: number;
  readonly scenes: Map<string, WorksceneDto>;
  readonly tombstones: Set<string>;
  readonly pendingDeletions: Map<
    string,
    {
      deletionRevision: number;
      previousObjectRevision: number;
    }
  >;
  readonly requests: Map<string, RequestReplay>;
}

export interface WorksceneRegistryControlContext {
  readonly requestId: string;
}

export interface AnchorWorksceneRegistryOptions {
  readonly log: AuthorityCommitLog;
  readonly clock?: () => string;
  readonly sceneIdFactory?: (name: string) => string;
}

export interface WorksceneStagedMutationRecord {
  readonly seq: number;
  readonly requestId: string;
  readonly mutation: WorksceneWriteMutation;
}

export interface WorksceneStagedMutationPlan {
  readonly records: readonly LogicalRecord<JsonValue>[];
  readonly outcomes: ReadonlyMap<
    number,
    | {
        readonly t: "granted";
        readonly targetRevision: number;
        readonly appliedResult: WorksceneAppliedResult;
      }
    | { readonly t: "conflicted"; readonly error: AuthorityError }
  >;
}

/**
 * Anchor-owned workscene registry. The append-only authority log is the sole
 * source of management state. Session activity is deliberately absent: it is
 * projected from SessionMeta by the anchor read model and never becomes a
 * second workscene fact or revision source.
 */
export class AnchorWorksceneRegistry {
  readonly #log: AuthorityCommitLog;
  readonly #clock: () => string;
  readonly #sceneIdFactory: (name: string) => string;
  readonly #durable: RebuildableDurableProjectionIndex;
  #projection: WorksceneRegistryProjection | undefined;
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorWorksceneRegistryOptions) {
    this.#log = options.log;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#sceneIdFactory =
      options.sceneIdFactory ??
      ((name) => `${slugify(name)}-${randomUUID().slice(0, 8)}`);
    this.#durable = this.#log.durableProjection({
      projectionId: WORKSCENE_AUTHORITY_PROJECTION_ID,
      reducerVersion: 1,
      reduce: reduceWorksceneDurableProjection,
    });
  }

  readonly stagedProjectionId = WORKSCENE_AUTHORITY_PROJECTION_ID;

  /** Opens the durable projection before a synchronous owner commit planner is installed. */
  async initialize(): Promise<void> {
    await this.#ensureOpen();
  }

  /**
   * Purely plans run-staged workscene writes against the current authority
   * projection. Returned records are appended in the owning run commit; this
   * method never mutates the live projection or the filesystem.
   */
  planStaged(records: readonly WorksceneStagedMutationRecord[]): WorksceneStagedMutationPlan {
    return planWorksceneStaged(
      cloneProjection(this.#state()),
      records,
      () => this.#clock(),
      this.#sceneIdFactory,
    );
  }

  async planStagedAtProjection(
    records: readonly WorksceneStagedMutationRecord[],
    projection: DurableProjectionReadContext,
    at: string,
  ): Promise<WorksceneStagedMutationPlan> {
    const createIds = new Map<number, string>();
    for (const record of records) {
      if (record.mutation.kind === "workscene-create") {
        createIds.set(record.seq, this.#sceneIdFactory(record.mutation.name));
      }
    }
    const state = await loadWorksceneProjectionForMutations(
      projection,
      records,
      createIds,
    );
    let currentSeq = 0;
    return planWorksceneStaged(
      state,
      records,
      () => at,
      () => {
        const sceneId = createIds.get(currentSeq);
        if (!sceneId) throw new TypeError("Workscene create identity was not frozen");
        return sceneId;
      },
      (seq) => {
        currentSeq = seq;
      },
    );
  }

  /** Reloads records atomically appended by an owning run commit. */
  async refreshCommitted(): Promise<void> {
    await this.#ensureOpen();
    await this.#log.transactDurableProjection(
      WORKSCENE_AUTHORITY_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
  }

  async list(): Promise<WorksceneDto[]> {
    await this.#ensureOpen();
    return [...(await readWorksceneScenes(this.#durable)).values()]
      .map(cloneScene)
      .sort(
        (left, right) =>
          Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt) ||
          left.id.localeCompare(right.id, "en-US"),
      );
  }

  async get(sceneId: string): Promise<WorksceneDto | null> {
    requireIdentifier(sceneId, "Workscene id");
    await this.#ensureOpen();
    const scene = readWorksceneScene(
      await this.#durable.get(worksceneSceneKey(sceneId)),
    );
    return scene ? cloneScene(scene) : null;
  }

  async replay(requestId: string): Promise<WorksceneAppliedResult | null> {
    requireIdentifier(requestId, "Workscene requestId");
    await this.#ensureOpen();
    const result = readWorksceneRequest(
      await this.#durable.get(worksceneRequestKey(requestId)),
    )?.result;
    return result ? cloneResult(result) : null;
  }

  async pendingDeletionPage(input?: {
    readonly after?: {
      readonly deletionRevision: number;
      readonly sceneId: string;
    };
    readonly limit?: number;
  }): Promise<{
    readonly items: Array<{
      sceneId: string;
      deletionRevision: number;
      previousObjectRevision: number;
    }>;
    readonly next?: {
      readonly deletionRevision: number;
      readonly sceneId: string;
    };
  }> {
    await this.#ensureOpen();
    const limit = input?.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Workscene deletion page limit is invalid");
    }
    if (input?.after) {
      requireRevision(input.after.deletionRevision);
      requireIdentifier(input.after.sceneId, "Workscene deletion cursor scene id");
    }
    const page = await this.#durable.scan(
      input?.after
        ? {
            gt: workscenePendingKey(input.after.sceneId),
            lt: `${WORKSCENE_PENDING_PREFIX}\uffff`,
          }
        : { gte: WORKSCENE_PENDING_PREFIX, lt: `${WORKSCENE_PENDING_PREFIX}\uffff` },
      limit,
    );
    const items = page.entries.map((entry) => {
      const pending = readPendingDeletion(entry.value);
      if (!pending) throw corruptRegistry("Workscene pending deletion is invalid");
      return {
        sceneId: entry.key.slice(WORKSCENE_PENDING_PREFIX.length),
        ...pending,
      };
    });
    const last = items.at(-1);
    return {
      items,
      ...(last && page.continuation !== undefined
        ? {
            next: {
              deletionRevision: last.deletionRevision,
              sceneId: last.sceneId,
            },
          }
        : {}),
    };
  }

  async confirmDeletionProjected(
    sceneId: string,
    deletionRevision: number,
  ): Promise<void> {
    requireIdentifier(sceneId, "Workscene id");
    requireRevision(deletionRevision);
    await this.#ensureOpen();
    const transaction = await this.#log.transactProjection<
      WorksceneRegistryProjection,
      WorksceneRegistryRecord,
      void
    >(
      this.#state(),
      reduceRegistry,
      (state) => {
        const pending = state.pendingDeletions.get(sceneId);
        if (!pending) return { kind: "return", value: undefined };
        if (pending.deletionRevision !== deletionRevision) {
          throw new WorksceneConflictError(
            "Workscene deletion projection revision is stale",
          );
        }
        return {
          kind: "append",
          entries: [
            {
              stream: REGISTRY_STREAM,
              body: {
                t: "workscene-deletion-projected",
                sceneId,
                deletionRevision,
                at: this.#clock(),
              },
            },
          ],
          value: undefined,
        };
      },
      { cursor: this.#cursor, stream: REGISTRY_STREAM },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
  }

  async apply(
    mutation: WorksceneWriteMutation,
    context: WorksceneRegistryControlContext,
  ): Promise<WorksceneAppliedResult> {
    requireIdentifier(context.requestId, "Workscene requestId");
    const normalized = validateMutation(mutation);
    const mutationDigest = protocolDigest(
      "WorksceneWriteMutation",
      1,
      normalized,
    );
    await this.#ensureOpen();
    const transaction = await this.#log.transactProjection<
      WorksceneRegistryProjection,
      WorksceneRegistryRecord,
      WorksceneAppliedResult
    >(
      this.#state(),
      reduceRegistry,
      (state) => {
        const replay = state.requests.get(context.requestId);
        if (replay) {
          if (replay.mutationDigest !== mutationDigest || !replay.result) {
            throw new WorksceneConflictError(
              "Workscene request identity was reused with another mutation",
            );
          }
          return { kind: "return", value: cloneResult(replay.result) };
        }
        const result = decideMutation(
          state,
          normalized,
          this.#clock(),
          this.#sceneIdFactory,
        );
        return {
          kind: "append",
          entries: [
            {
              stream: REGISTRY_STREAM,
              body: {
                t: "workscene-control-applied",
                requestId: context.requestId,
                mutationDigest,
                mutation: structuredClone(normalized),
                result: cloneResult(result),
                at: this.#clock(),
              },
            },
          ],
          value: result,
        };
      },
      { cursor: this.#cursor, stream: REGISTRY_STREAM },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
    return cloneResult(transaction.value);
  }

  #state(): WorksceneRegistryProjection {
    if (!this.#projection) {
      throw new AuthorityStorageError(
        "commit-log-corrupt",
        "Workscene registry has not been opened",
      );
    }
    return this.#projection;
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<void> {
    const snapshot = await this.#log.readSnapshot<WorksceneRegistryRecord>();
    let state = emptyProjection();
    let hasRegistryEntries = false;
    for (const commit of snapshot.commits) {
      for (const entry of commit.entries) {
        if (entry.stream !== REGISTRY_STREAM) continue;
        hasRegistryEntries = true;
        state = reduceRegistry(
          state,
          entry as LogicalRecord<WorksceneRegistryRecord>,
        );
      }
    }
    this.#cursor = snapshot.cursor;
    if (!state.established) {
      if (hasRegistryEntries) {
        throw corruptRegistry(
          "Workscene registry facts exist without an establishment record",
        );
      }
      const commit = await this.#log.append<WorksceneRegistryRecord>([
        {
          stream: REGISTRY_STREAM,
          body: {
            t: "workscene-registry-established",
            at: this.#clock(),
          },
        },
      ]);
      state = reduceRegistry(
        state,
        commit.entries[0] as LogicalRecord<WorksceneRegistryRecord>,
      );
      this.#cursor =
        (await this.#log.readSnapshot<WorksceneRegistryRecord>()).cursor;
    }
    this.#projection = state;
  }

}

function planWorksceneStaged(
  initial: WorksceneRegistryProjection,
  records: readonly WorksceneStagedMutationRecord[],
  at: () => string,
  sceneIdFactory: (name: string) => string,
  beforeRecord: (seq: number) => void = () => undefined,
): WorksceneStagedMutationPlan {
  let overlay = cloneProjection(initial);
  const planned: LogicalRecord<JsonValue>[] = [];
  const outcomes = new Map<
    number,
    | {
        readonly t: "granted";
        readonly targetRevision: number;
        readonly appliedResult: WorksceneAppliedResult;
      }
    | { readonly t: "conflicted"; readonly error: AuthorityError }
  >();

  for (const record of records) {
    beforeRecord(record.seq);
    const normalized = validateMutation(record.mutation);
    const mutationDigest = protocolDigest(
      "WorksceneWriteMutation",
      1,
      normalized,
    );
    const replay = overlay.requests.get(record.requestId);
    if (replay) {
      outcomes.set(
        record.seq,
        replay.mutationDigest !== mutationDigest || !replay.result
          ? stagedConflict(
              "idempotency-conflict",
              "Workscene request identity is already bound to another mutation",
            )
          : {
              t: "granted",
              targetRevision: replay.result.revision,
              appliedResult: cloneResult(replay.result),
            },
      );
      continue;
    }

    try {
      const committedAt = at();
      const result = decideMutation(
        overlay,
        normalized,
        committedAt,
        sceneIdFactory,
      );
      const logical: LogicalRecord<WorksceneRegistryRecord> = {
        stream: REGISTRY_STREAM,
        body: {
          t: "workscene-control-applied",
          requestId: record.requestId,
          mutationDigest,
          mutation: structuredClone(normalized),
          result: cloneResult(result),
          at: committedAt,
        },
      };
      overlay = reduceRegistry(overlay, logical);
      planned.push(logical as unknown as LogicalRecord<JsonValue>);
      outcomes.set(record.seq, {
        t: "granted",
        targetRevision: result.revision,
        appliedResult: cloneResult(result),
      });
    } catch (error) {
      outcomes.set(record.seq, worksceneStagedConflict(error));
    }
  }
  return { records: planned, outcomes };
}

async function loadWorksceneProjectionForMutations(
  projection: DurableProjectionReadContext,
  records: readonly WorksceneStagedMutationRecord[],
  createIds: ReadonlyMap<number, string>,
): Promise<WorksceneRegistryProjection> {
  const meta = readWorksceneMeta(await projection.get(WORKSCENE_META_KEY));
  const state = emptyProjection();
  state.established = meta.established;
  state.domainRevision = meta.domainRevision;
  for (const record of records) {
    const replay = readWorksceneRequest(
      await projection.get(worksceneRequestKey(record.requestId)),
    );
    if (replay) state.requests.set(record.requestId, replay);
    const sceneId = record.mutation.kind === "workscene-create"
      ? createIds.get(record.seq)
      : record.mutation.sceneId;
    if (!sceneId) continue;
    const scene = readWorksceneScene(
      await projection.get(worksceneSceneKey(sceneId)),
    );
    if (scene) state.scenes.set(sceneId, scene);
    if (await projection.get(worksceneTombstoneKey(sceneId))) {
      state.tombstones.add(sceneId);
    }
  }
  return state;
}

async function reduceWorksceneDurableProjection(
  envelope: import("../contracts/index.js").CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const get = async (key: string): Promise<JsonValue | undefined> =>
    overlay.has(key) ? overlay.get(key) : current.get(key);
  const put = (key: string, value: JsonValue): void => {
    overlay.set(key, value);
    mutations.push({ kind: "put", key, value });
  };
  const tombstone = (key: string): void => {
    overlay.set(key, undefined);
    mutations.push({ kind: "tombstone", key });
  };
  let meta = readWorksceneMeta(await get(WORKSCENE_META_KEY));

  for (const logical of envelope.entries) {
    if (logical.stream !== REGISTRY_STREAM) continue;
    const record = validateRecord(
      logical.body as unknown as WorksceneRegistryRecord,
    );
    switch (record.t) {
      case "workscene-registry-established":
        if (meta.established) throw corruptRegistry("Workscene registry was established twice");
        meta = { ...meta, established: true };
        put(WORKSCENE_META_KEY, meta as unknown as JsonValue);
        break;
      case "workscene-control-applied": {
        if (await get(worksceneRequestKey(record.requestId))) {
          throw corruptRegistry("Workscene request identity was reused");
        }
        if (record.result.revision !== meta.domainRevision + 1) {
          throw corruptRegistry("Workscene domain revision is not contiguous");
        }
        if (record.result.kind === "workscene-applied") {
          put(
            worksceneSceneKey(record.result.scene.id),
            cloneScene(record.result.scene) as unknown as JsonValue,
          );
        } else {
          tombstone(worksceneSceneKey(record.result.sceneId));
          put(worksceneTombstoneKey(record.result.sceneId), true);
          put(workscenePendingKey(record.result.sceneId), {
            deletionRevision: record.result.revision,
            previousObjectRevision: record.result.previousObjectRevision,
          });
        }
        put(worksceneRequestKey(record.requestId), {
          mutationDigest: record.mutationDigest,
          result: cloneResult(record.result),
        } as unknown as JsonValue);
        meta = { ...meta, domainRevision: record.result.revision };
        put(WORKSCENE_META_KEY, meta as unknown as JsonValue);
        break;
      }
      case "workscene-deletion-projected": {
        const pending = readPendingDeletion(
          await get(workscenePendingKey(record.sceneId)),
        );
        if (!pending || pending.deletionRevision !== record.deletionRevision) {
          throw corruptRegistry("Workscene deletion projection is stale");
        }
        tombstone(workscenePendingKey(record.sceneId));
        break;
      }
    }
  }
  return mutations;
}

async function readWorksceneScenes(
  projection: RebuildableDurableProjectionIndex,
): Promise<Map<string, WorksceneDto>> {
  const scenes = new Map<string, WorksceneDto>();
  let continuation: string | undefined;
  do {
    const page = await projection.scan(
      { gte: WORKSCENE_SCENE_PREFIX, lt: `${WORKSCENE_SCENE_PREFIX}\uffff` },
      256,
      continuation,
    );
    for (const item of page.entries) {
      const scene = readWorksceneScene(item.value);
      if (!scene) throw corruptRegistry("Workscene durable scene is invalid");
      scenes.set(item.key.slice(WORKSCENE_SCENE_PREFIX.length), scene);
    }
    continuation = page.continuation;
  } while (continuation !== undefined);
  return scenes;
}

function worksceneSceneKey(sceneId: string): string {
  return `${WORKSCENE_SCENE_PREFIX}${sceneId}`;
}

function worksceneTombstoneKey(sceneId: string): string {
  return `${WORKSCENE_TOMBSTONE_PREFIX}${sceneId}`;
}

function worksceneRequestKey(requestId: string): string {
  return `${WORKSCENE_REQUEST_PREFIX}${requestId}`;
}

function workscenePendingKey(sceneId: string): string {
  return `${WORKSCENE_PENDING_PREFIX}${sceneId}`;
}

function readWorksceneMeta(value: JsonValue | undefined): {
  readonly established: boolean;
  readonly domainRevision: number;
} {
  if (value === undefined) return { established: false, domainRevision: 0 };
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.established !== "boolean" ||
    !Number.isSafeInteger(value.domainRevision) || Number(value.domainRevision) < 0
  ) {
    throw corruptRegistry("Workscene durable metadata is invalid");
  }
  return {
    established: value.established,
    domainRevision: Number(value.domainRevision),
  };
}

function readWorksceneScene(value: JsonValue | undefined): WorksceneDto | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corruptRegistry("Workscene durable scene is invalid");
  }
  const scene = value as unknown as WorksceneDto;
  validateScene(scene);
  return cloneScene(scene);
}

function readWorksceneRequest(value: JsonValue | undefined): RequestReplay | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.mutationDigest !== "string"
  ) {
    throw corruptRegistry("Workscene durable request is invalid");
  }
  const result = value.result === undefined
    ? undefined
    : readStoredAppliedResult(value.result);
  return {
    mutationDigest: value.mutationDigest as Digest,
    ...(result ? { result } : {}),
  };
}

function readStoredAppliedResult(value: JsonValue): WorksceneAppliedResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corruptRegistry("Workscene durable applied result is invalid");
  }
  if (value.kind === "workscene-applied") {
    if (
      (value.operation !== "create" &&
        value.operation !== "rename" &&
        value.operation !== "set-workdir") ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) <= 0
    ) {
      throw corruptRegistry("Workscene durable applied result is invalid");
    }
    const scene = readWorksceneScene(value.scene);
    if (!scene) {
      throw corruptRegistry("Workscene durable applied result omitted its scene");
    }
    return {
      kind: "workscene-applied",
      operation: value.operation,
      revision: Number(value.revision),
      scene,
    };
  }
  if (
    value.kind !== "workscene-deleted" ||
    value.operation !== "delete" ||
    typeof value.sceneId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) <= 0 ||
    !Number.isSafeInteger(value.previousObjectRevision) ||
    Number(value.previousObjectRevision) <= 0
  ) {
    throw corruptRegistry("Workscene durable applied result is invalid");
  }
  requireIdentifier(value.sceneId, "Workscene id");
  return {
    kind: "workscene-deleted",
    operation: "delete",
    revision: Number(value.revision),
    sceneId: value.sceneId,
    previousObjectRevision: Number(value.previousObjectRevision),
  };
}

function readPendingDeletion(value: JsonValue | undefined): {
  readonly deletionRevision: number;
  readonly previousObjectRevision: number;
} | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !Number.isSafeInteger(value.deletionRevision) || Number(value.deletionRevision) <= 0 ||
    !Number.isSafeInteger(value.previousObjectRevision) || Number(value.previousObjectRevision) <= 0
  ) {
    throw corruptRegistry("Workscene pending deletion is invalid");
  }
  return {
    deletionRevision: Number(value.deletionRevision),
    previousObjectRevision: Number(value.previousObjectRevision),
  };
}

function worksceneStagedConflict(error: unknown): {
  readonly t: "conflicted";
  readonly error: AuthorityError;
} {
  if (error instanceof WorksceneRevisionError) {
    return stagedConflict("revision-conflict", error.message);
  }
  if (error instanceof WorksceneNotFoundError) {
    return stagedConflict("not-found", error.message);
  }
  if (error instanceof WorksceneConflictError) {
    return stagedConflict("idempotency-conflict", error.message);
  }
  if (error instanceof TypeError) {
    return stagedConflict("invalid", error.message);
  }
  throw error;
}

function stagedConflict(
  code: AuthorityError["code"],
  message: string,
): { readonly t: "conflicted"; readonly error: AuthorityError } {
  return { t: "conflicted", error: { code, message, retryable: false } };
}

function decideMutation(
  state: WorksceneRegistryProjection,
  mutation: WorksceneWriteMutation,
  at: string,
  sceneIdFactory: (name: string) => string,
): WorksceneAppliedResult {
  canonicalTime(at, "Workscene mutation time");
  const revision = state.domainRevision + 1;
  switch (mutation.kind) {
    case "workscene-create": {
      const sceneId = requireIdentifier(
        sceneIdFactory(mutation.name),
        "Generated workscene id",
      );
      if (state.scenes.has(sceneId) || state.tombstones.has(sceneId)) {
        throw new WorksceneConflictError(
          "Generated workscene id is already reserved",
        );
      }
      const scene: WorksceneDto = {
        id: sceneId,
        revision: 1,
        name: mutation.name,
        ...(mutation.workspace
          ? { workspace: { ...mutation.workspace } }
          : {}),
        createdAt: at,
        lastActiveAt: at,
      };
      return {
        kind: "workscene-applied",
        operation: "create",
        revision,
        scene,
      };
    }
    case "workscene-rename": {
      const current = requireScene(state, mutation.sceneId);
      assertRevision(current, mutation.expectedRevision);
      return {
        kind: "workscene-applied",
        operation: "rename",
        revision,
        scene: {
          ...cloneScene(current),
          revision: current.revision + 1,
          name: mutation.name,
        },
      };
    }
    case "workscene-set-workdir": {
      const current = requireScene(state, mutation.sceneId);
      assertRevision(current, mutation.expectedRevision);
      const scene = {
        ...cloneScene(current),
        revision: current.revision + 1,
      };
      if (mutation.workspace) scene.workspace = { ...mutation.workspace };
      else delete scene.workspace;
      return {
        kind: "workscene-applied",
        operation: "set-workdir",
        revision,
        scene,
      };
    }
    case "workscene-delete": {
      const current = requireScene(state, mutation.sceneId);
      assertRevision(current, mutation.expectedRevision);
      return {
        kind: "workscene-deleted",
        operation: "delete",
        revision,
        sceneId: current.id,
        previousObjectRevision: current.revision,
      };
    }
  }
}

function reduceRegistry(
  previous: WorksceneRegistryProjection,
  entry: LogicalRecord<WorksceneRegistryRecord>,
): WorksceneRegistryProjection {
  const state = cloneProjection(previous);
  const record = validateRecord(entry.body);
  if ("requestId" in record && state.requests.has(record.requestId)) {
    throw corruptRegistry("Workscene request identity was reused");
  }
  switch (record.t) {
    case "workscene-registry-established":
      if (state.established) {
        throw corruptRegistry("Workscene registry was established twice");
      }
      state.established = true;
      break;
    case "workscene-control-applied":
      assertAppliedTransition(state, record.mutation, record.result);
      applyResult(state, record.result);
      state.requests.set(record.requestId, {
        mutationDigest: record.mutationDigest,
        result: cloneResult(record.result),
      });
      break;
    case "workscene-deletion-projected": {
      const pending = state.pendingDeletions.get(record.sceneId);
      if (!pending || pending.deletionRevision !== record.deletionRevision) {
        throw corruptRegistry(
          "Workscene deletion projection does not bind a pending deletion",
        );
      }
      state.pendingDeletions.delete(record.sceneId);
      break;
    }
  }
  return state;
}

function assertAppliedTransition(
  state: WorksceneRegistryProjection,
  mutation: WorksceneWriteMutation,
  result: WorksceneAppliedResult,
): void {
  if (mutation.kind === "workscene-create") {
    if (
      result.kind !== "workscene-applied" ||
      result.operation !== "create" ||
      state.scenes.has(result.scene.id) ||
      state.tombstones.has(result.scene.id) ||
      result.scene.revision !== 1 ||
      result.scene.name !== mutation.name ||
      !sameWorkspace(result.scene.workspace, mutation.workspace)
    ) {
      throw corruptRegistry(
        "Workscene creation result contradicts the authoritative state",
      );
    }
    return;
  }

  const sceneId = mutation.sceneId;
  const current = state.scenes.get(sceneId);
  if (!current || current.revision !== mutation.expectedRevision) {
    throw corruptRegistry(
      "Workscene mutation does not bind the current object revision",
    );
  }
  if (mutation.kind === "workscene-delete") {
    if (
      result.kind !== "workscene-deleted" ||
      result.operation !== "delete" ||
      result.sceneId !== sceneId ||
      result.previousObjectRevision !== current.revision
    ) {
      throw corruptRegistry(
        "Workscene deletion result contradicts the authoritative state",
      );
    }
    return;
  }

  if (result.kind !== "workscene-applied") {
    throw corruptRegistry("Workscene mutation returned a deletion result");
  }
  const expected = cloneScene(current);
  expected.revision = current.revision + 1;
  if (mutation.kind === "workscene-rename") {
    expected.name = mutation.name;
  } else if (mutation.workspace) {
    expected.workspace = { ...mutation.workspace };
  } else {
    delete expected.workspace;
  }
  if (canonicalize(result.scene) !== canonicalize(expected)) {
    throw corruptRegistry(
      "Workscene mutation result changes fields outside its authority",
    );
  }
}

function applyResult(
  state: WorksceneRegistryProjection,
  result: WorksceneAppliedResult,
): void {
  if (result.revision !== state.domainRevision + 1) {
    throw corruptRegistry("Workscene domain revision is not contiguous");
  }
  if (result.kind === "workscene-applied") {
    state.scenes.set(result.scene.id, cloneScene(result.scene));
  } else {
    if (!state.scenes.delete(result.sceneId)) {
      throw corruptRegistry("Workscene deletion refers to an unknown object");
    }
    state.tombstones.add(result.sceneId);
    state.pendingDeletions.set(result.sceneId, {
      deletionRevision: result.revision,
      previousObjectRevision: result.previousObjectRevision,
    });
  }
  state.domainRevision = result.revision;
}

function validateMutation(
  input: WorksceneWriteMutation,
): WorksceneWriteMutation {
  assertPlainRecord(input, "Workscene mutation");
  const mutation = structuredClone(input);
  switch (mutation.kind) {
    case "workscene-create":
      assertRecordKeys(
        mutation,
        mutation.workspace
          ? ["kind", "name", "workspace"]
          : ["kind", "name"],
        "Workscene create mutation",
      );
      mutation.name = normalizeName(mutation.name);
      if (mutation.workspace) validateWorkspace(mutation.workspace);
      break;
    case "workscene-rename":
      assertRecordKeys(
        mutation,
        ["expectedRevision", "kind", "name", "sceneId"],
        "Workscene rename mutation",
      );
      requireIdentifier(mutation.sceneId, "Workscene id");
      mutation.name = normalizeName(mutation.name);
      requireRevision(mutation.expectedRevision);
      break;
    case "workscene-set-workdir":
      assertRecordKeys(
        mutation,
        ["expectedRevision", "kind", "sceneId", "workspace"],
        "Workscene workspace mutation",
      );
      requireIdentifier(mutation.sceneId, "Workscene id");
      if (mutation.workspace) validateWorkspace(mutation.workspace);
      requireRevision(mutation.expectedRevision);
      break;
    case "workscene-delete":
      assertRecordKeys(
        mutation,
        ["expectedRevision", "kind", "sceneId"],
        "Workscene delete mutation",
      );
      requireIdentifier(mutation.sceneId, "Workscene id");
      requireRevision(mutation.expectedRevision);
      break;
    default:
      throw new TypeError("Unknown workscene mutation");
  }
  return mutation;
}

function validateRecord(record: WorksceneRegistryRecord): WorksceneRegistryRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw corruptRegistry("Workscene registry record is malformed");
  }
  switch (record.t) {
    case "workscene-registry-established":
      assertRecordKeys(
        record,
        ["at", "t"],
        "Workscene registry genesis",
      );
      break;
    case "workscene-control-applied": {
      assertRecordKeys(
        record,
        [
          "at",
          "mutation",
          "mutationDigest",
          "requestId",
          "result",
          "t",
        ],
        "Workscene control record",
      );
      requireIdentifier(record.requestId, "Workscene requestId");
      const mutation = validateMutation(record.mutation);
      if (canonicalize(mutation) !== canonicalize(record.mutation)) {
        throw corruptRegistry("Workscene mutation is not canonical");
      }
      const expected = protocolDigest("WorksceneWriteMutation", 1, mutation);
      if (record.mutationDigest !== expected) {
        throw corruptRegistry("Workscene mutation digest is inconsistent");
      }
      validateAppliedResult(record.result, mutation);
      break;
    }
    case "workscene-deletion-projected":
      assertRecordKeys(
        record,
        ["at", "deletionRevision", "sceneId", "t"],
        "Workscene deletion projection record",
      );
      requireIdentifier(record.sceneId, "Workscene id");
      requireRevision(record.deletionRevision);
      break;
    default:
      throw corruptRegistry("Workscene registry record tag is unknown");
  }
  canonicalTime(record.at, "Workscene registry record time");
  return record;
}

function requireScene(
  state: WorksceneRegistryProjection,
  sceneId: string,
): WorksceneDto {
  const scene = state.scenes.get(sceneId);
  if (!scene) throw new WorksceneNotFoundError(sceneId);
  return scene;
}

function assertRevision(scene: WorksceneDto, expected: number): void {
  if (scene.revision !== expected) {
    throw new WorksceneRevisionError(scene.id, expected, scene.revision);
  }
}

function validateWorkspace(workspace: {
  deviceId: string;
  bindingRef: string;
}): void {
  assertPlainRecord(workspace, "Workscene workspace");
  assertRecordKeys(
    workspace,
    ["bindingRef", "deviceId"],
    "Workscene workspace",
  );
  requireIdentifier(workspace.deviceId, "Workspace deviceId");
  requireIdentifier(workspace.bindingRef, "Workspace bindingRef");
}

function validateAppliedResult(
  result: WorksceneAppliedResult,
  mutation: WorksceneWriteMutation,
): void {
  assertPlainRecord(result, "Workscene applied result");
  if (mutation.kind === "workscene-delete") {
    assertRecordKeys(
      result,
      [
        "kind",
        "operation",
        "previousObjectRevision",
        "revision",
        "sceneId",
      ],
      "Workscene delete result",
    );
    if (
      result.kind !== "workscene-deleted" ||
      result.operation !== "delete" ||
      result.sceneId !== mutation.sceneId
    ) {
      throw corruptRegistry("Workscene delete result is inconsistent");
    }
    requireRevision(result.revision);
    requireRevision(result.previousObjectRevision);
    return;
  }
  assertRecordKeys(
    result,
    ["kind", "operation", "revision", "scene"],
    "Workscene applied result",
  );
  if (
    result.kind !== "workscene-applied" ||
    result.operation !== operationForMutation(mutation)
  ) {
    throw corruptRegistry("Workscene applied result is inconsistent");
  }
  requireRevision(result.revision);
  validateScene(result.scene);
  switch (mutation.kind) {
    case "workscene-create":
      if (
        result.scene.revision !== 1 ||
        result.scene.name !== mutation.name ||
        !sameWorkspace(result.scene.workspace, mutation.workspace) ||
        result.scene.createdAt !== result.scene.lastActiveAt
      ) {
        throw corruptRegistry(
          "Created workscene result is inconsistent",
        );
      }
      break;
    case "workscene-rename":
      if (
        result.scene.id !== mutation.sceneId ||
        result.scene.revision !== mutation.expectedRevision + 1 ||
        result.scene.name !== mutation.name
      ) {
        throw corruptRegistry("Renamed workscene result is inconsistent");
      }
      break;
    case "workscene-set-workdir":
      if (
        result.scene.id !== mutation.sceneId ||
        result.scene.revision !== mutation.expectedRevision + 1 ||
        !sameWorkspace(result.scene.workspace, mutation.workspace)
      ) {
        throw corruptRegistry("Workscene workspace result is inconsistent");
      }
      break;
  }
}

function sameWorkspace(
  left: WorksceneDto["workspace"],
  right: WorksceneDto["workspace"] | null,
): boolean {
  return (
    left?.deviceId === right?.deviceId &&
    left?.bindingRef === right?.bindingRef
  );
}

function operationForMutation(
  mutation: Exclude<WorksceneWriteMutation, { kind: "workscene-delete" }>,
): "create" | "rename" | "set-workdir" {
  switch (mutation.kind) {
    case "workscene-create":
      return "create";
    case "workscene-rename":
      return "rename";
    case "workscene-set-workdir":
      return "set-workdir";
  }
}

function validateScene(scene: WorksceneDto): void {
  assertPlainRecord(scene, "Workscene");
  assertRecordKeys(
    scene,
    scene.workspace
      ? [
          "createdAt",
          "id",
          "lastActiveAt",
          "name",
          "revision",
          "workspace",
        ]
      : ["createdAt", "id", "lastActiveAt", "name", "revision"],
    "Workscene",
  );
  requireIdentifier(scene.id, "Workscene id");
  requireRevision(scene.revision);
  if (normalizeName(scene.name) !== scene.name) {
    throw corruptRegistry("Workscene name is not canonical");
  }
  canonicalTime(scene.createdAt, "Workscene creation time");
  canonicalTime(scene.lastActiveAt, "Workscene activity time");
  if (Date.parse(scene.lastActiveAt) < Date.parse(scene.createdAt)) {
    throw corruptRegistry("Workscene activity predates its creation");
  }
  if (scene.workspace) validateWorkspace(scene.workspace);
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw corruptRegistry(`${label} is malformed`);
  }
}

function assertRecordKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw corruptRegistry(`${label} fields are invalid`);
  }
}

function normalizeName(value: string): string {
  if (typeof value !== "string") throw new TypeError("Workscene name must be a string");
  const name = value.trim().normalize("NFKC");
  if (!name || Buffer.byteLength(name, "utf8") > 256) {
    throw new TypeError("Workscene name must be a non-empty bounded string");
  }
  return name;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 480 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Expected workscene revision must be positive");
  }
}

function canonicalTime(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60) || "scene"
  );
}

function emptyProjection(): WorksceneRegistryProjection {
  return {
    established: false,
    domainRevision: 0,
    scenes: new Map(),
    tombstones: new Set(),
    pendingDeletions: new Map(),
    requests: new Map(),
  };
}

function cloneProjection(
  source: WorksceneRegistryProjection,
): WorksceneRegistryProjection {
  return {
    established: source.established,
    domainRevision: source.domainRevision,
    scenes: new Map(
      [...source.scenes].map(([id, scene]) => [id, cloneScene(scene)]),
    ),
    tombstones: new Set(source.tombstones),
    pendingDeletions: new Map(
      [...source.pendingDeletions].map(([sceneId, pending]) => [
        sceneId,
        { ...pending },
      ]),
    ),
    requests: new Map(
      [...source.requests].map(([requestId, replay]) => [
        requestId,
        {
          mutationDigest: replay.mutationDigest,
          ...(replay.result ? { result: cloneResult(replay.result) } : {}),
        },
      ]),
    ),
  };
}

function cloneScene(scene: WorksceneDto): WorksceneDto {
  return {
    ...scene,
    ...(scene.workspace ? { workspace: { ...scene.workspace } } : {}),
  };
}

function cloneResult(result: WorksceneAppliedResult): WorksceneAppliedResult {
  return result.kind === "workscene-applied"
    ? { ...result, scene: cloneScene(result.scene) }
    : { ...result };
}

function corruptRegistry(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

export class WorksceneNotFoundError extends Error {
  constructor(readonly sceneId: string) {
    super(`Workscene ${sceneId} does not exist`);
    this.name = "WorksceneNotFoundError";
  }
}

export class WorksceneConflictError extends Error {
  readonly reasonCode = "WORKSCENE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "WorksceneConflictError";
  }
}

export class WorksceneRevisionError extends Error {
  readonly reasonCode = "WORKSCENE_REVISION_CONFLICT";

  constructor(
    readonly sceneId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Workscene ${sceneId} revision ${actualRevision} does not match ${expectedRevision}`,
    );
    this.name = "WorksceneRevisionError";
  }
}
