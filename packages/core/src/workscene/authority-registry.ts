import { randomUUID } from "node:crypto";
import type {
  AuthorityCommitLog,
  ProjectionCursor,
} from "../authority/index.js";
import { AuthorityStorageError } from "../authority/index.js";
import type {
  Digest,
  LogicalRecord,
  WorksceneAppliedResult,
  WorksceneDto,
  WorksceneMigrationMutation,
  WorksceneWriteMutation,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";

const REGISTRY_STREAM = "intent:workscene-registry";

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
      t: "workscene-legacy-import-opened";
      requestId: string;
      mutationDigest: Digest;
      mutation: Extract<
        WorksceneMigrationMutation,
        { kind: "workscene-import-legacy" }
      >;
      at: string;
    }
  | {
      t: "workscene-legacy-import-activated";
      requestId: string;
      mutationDigest: Digest;
      mutation: Extract<
        WorksceneMigrationMutation,
        { kind: "workscene-activate-device-registry" }
      >;
      at: string;
    }
  | {
      t: "workscene-legacy-import-abandoned";
      requestId: string;
      mutationDigest: Digest;
      mutation: Extract<
        WorksceneMigrationMutation,
        { kind: "workscene-abandon-legacy-import" }
      >;
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

interface LegacyBatch {
  readonly sourceSnapshotToken: string;
  readonly imports: Map<string, WorksceneDto>;
  status: "open" | "activated" | "abandoned";
  importSetDigest?: Digest;
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
  readonly legacyBatches: Map<string, LegacyBatch>;
}

export interface WorksceneRegistryControlContext {
  readonly requestId: string;
}

export interface AnchorWorksceneRegistryOptions {
  readonly log: AuthorityCommitLog;
  readonly clock?: () => string;
  readonly sceneIdFactory?: (name: string) => string;
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
  #projection: WorksceneRegistryProjection | undefined;
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorWorksceneRegistryOptions) {
    this.#log = options.log;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#sceneIdFactory =
      options.sceneIdFactory ??
      ((name) => `${slugify(name)}-${randomUUID().slice(0, 8)}`);
  }

  async list(): Promise<WorksceneDto[]> {
    await this.#ensureOpen();
    return [...this.#state().scenes.values()]
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
    const scene = this.#state().scenes.get(sceneId);
    return scene ? cloneScene(scene) : null;
  }

  async replay(requestId: string): Promise<WorksceneAppliedResult | null> {
    requireIdentifier(requestId, "Workscene requestId");
    await this.#ensureOpen();
    const result = this.#state().requests.get(requestId)?.result;
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
    const pending = [...this.#state().pendingDeletions]
      .map(([sceneId, pending]) => ({ sceneId, ...pending }))
      .sort(
        (left, right) =>
          left.deletionRevision - right.deletionRevision ||
          left.sceneId.localeCompare(right.sceneId, "en-US"),
      );
    const items = pending
      .filter(
        (item) =>
          !input?.after || compareDeletionCursor(item, input.after) > 0,
      )
      .slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(last &&
      pending.some((item) => compareDeletionCursor(item, last) > 0)
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

  async applyMigration(
    mutation: WorksceneMigrationMutation,
    context: WorksceneRegistryControlContext,
  ): Promise<void> {
    requireIdentifier(context.requestId, "Workscene migration requestId");
    const normalized = validateMigrationMutation(mutation);
    const mutationDigest = protocolDigest(
      "WorksceneMigrationMutation",
      1,
      normalized,
    );
    await this.#ensureOpen();
    const transaction = await this.#log.transactProjection<
      WorksceneRegistryProjection,
      WorksceneRegistryRecord,
      void
    >(
      this.#state(),
      reduceRegistry,
      (state) => {
        const replay = state.requests.get(context.requestId);
        if (replay) {
          if (replay.mutationDigest !== mutationDigest) {
            throw new WorksceneConflictError(
              "Migration request identity was reused with another mutation",
            );
          }
          return { kind: "return", value: undefined };
        }
        validateMigrationTransition(state, normalized);
        return {
          kind: "append",
          entries: [
            {
              stream: REGISTRY_STREAM,
              body: migrationRecord(
                context.requestId,
                mutationDigest,
                normalized,
                this.#clock(),
              ),
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

  async openLegacyBatches(): Promise<
    Array<{
      migrationId: string;
      sourceSnapshotToken: string;
      imports: WorksceneDto[];
    }>
  > {
    await this.#ensureOpen();
    return [...this.#state().legacyBatches]
      .filter(([, batch]) => batch.status === "open")
      .map(([migrationId, batch]) => ({
        migrationId,
        sourceSnapshotToken: batch.sourceSnapshotToken,
        imports: [...batch.imports.values()].map(cloneScene),
      }));
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
    case "workscene-legacy-import-opened": {
      const mutation = record.mutation;
      let batch = state.legacyBatches.get(mutation.migrationId);
      if (!batch) {
        batch = {
          sourceSnapshotToken: mutation.sourceSnapshotToken,
          imports: new Map(),
          status: "open",
        };
        state.legacyBatches.set(mutation.migrationId, batch);
      }
      if (
        batch.status !== "open" ||
        batch.sourceSnapshotToken !== mutation.sourceSnapshotToken ||
        batch.imports.has(mutation.scene.id)
      ) {
        throw corruptRegistry("Legacy import batch is inconsistent");
      }
      batch.imports.set(mutation.scene.id, importedScene(mutation.scene));
      state.requests.set(record.requestId, {
        mutationDigest: record.mutationDigest,
      });
      break;
    }
    case "workscene-legacy-import-activated": {
      let batch = state.legacyBatches.get(record.mutation.migrationId);
      if (
        !batch &&
        record.mutation.importSetDigest === worksceneImportSetDigest([])
      ) {
        batch = {
          sourceSnapshotToken: record.mutation.sourceSnapshotToken,
          imports: new Map(),
          status: "open",
        };
        state.legacyBatches.set(record.mutation.migrationId, batch);
      }
      if (
        !batch ||
        batch.status !== "open" ||
        batch.sourceSnapshotToken !== record.mutation.sourceSnapshotToken ||
        importSetDigest(batch.imports) !== record.mutation.importSetDigest
      ) {
        throw corruptRegistry("Legacy activation does not bind its open import set");
      }
      for (const [sceneId, scene] of batch.imports) {
        if (state.scenes.has(sceneId) || state.tombstones.has(sceneId)) {
          throw corruptRegistry("Legacy activation collides with current state");
        }
        state.scenes.set(sceneId, cloneScene(scene));
      }
      state.domainRevision += 1;
      batch.status = "activated";
      batch.importSetDigest = record.mutation.importSetDigest;
      state.requests.set(record.requestId, {
        mutationDigest: record.mutationDigest,
      });
      break;
    }
    case "workscene-legacy-import-abandoned": {
      const batch = state.legacyBatches.get(record.mutation.migrationId);
      if (
        !batch ||
        batch.status !== "open" ||
        batch.sourceSnapshotToken !== record.mutation.sourceSnapshotToken
      ) {
        throw corruptRegistry("Legacy abandonment does not bind an open batch");
      }
      batch.status = "abandoned";
      state.requests.set(record.requestId, {
        mutationDigest: record.mutationDigest,
      });
      break;
    }
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

function validateMigrationTransition(
  state: WorksceneRegistryProjection,
  mutation: WorksceneMigrationMutation,
): void {
  const batch = state.legacyBatches.get(mutation.migrationId);
  switch (mutation.kind) {
    case "workscene-import-legacy":
      if (
        batch &&
        (batch.status !== "open" ||
          batch.sourceSnapshotToken !== mutation.sourceSnapshotToken ||
          batch.imports.has(mutation.scene.id))
      ) {
        throw new WorksceneConflictError(
          "Legacy import does not extend the current open batch",
        );
      }
      if (
        state.scenes.has(mutation.scene.id) ||
        state.tombstones.has(mutation.scene.id)
      ) {
        throw new WorksceneConflictError(
          "Legacy scene identity is already reserved",
        );
      }
      return;
    case "workscene-activate-device-registry":
      if (
        !batch &&
        mutation.importSetDigest === worksceneImportSetDigest([])
      ) {
        return;
      }
      if (
        !batch ||
        batch.status !== "open" ||
        batch.sourceSnapshotToken !== mutation.sourceSnapshotToken ||
        importSetDigest(batch.imports) !== mutation.importSetDigest
      ) {
        throw new WorksceneConflictError(
          "Legacy activation does not bind the complete open import set",
        );
      }
      return;
    case "workscene-abandon-legacy-import":
      if (
        !batch ||
        batch.status !== "open" ||
        batch.sourceSnapshotToken !== mutation.sourceSnapshotToken
      ) {
        throw new WorksceneConflictError(
          "Legacy abandonment does not bind the current open batch",
        );
      }
  }
}

function migrationRecord(
  requestId: string,
  mutationDigest: Digest,
  mutation: WorksceneMigrationMutation,
  at: string,
): WorksceneRegistryRecord {
  switch (mutation.kind) {
    case "workscene-import-legacy":
      return {
        t: "workscene-legacy-import-opened",
        requestId,
        mutationDigest,
        mutation,
        at,
      };
    case "workscene-activate-device-registry":
      return {
        t: "workscene-legacy-import-activated",
        requestId,
        mutationDigest,
        mutation,
        at,
      };
    case "workscene-abandon-legacy-import":
      return {
        t: "workscene-legacy-import-abandoned",
        requestId,
        mutationDigest,
        mutation,
        at,
      };
  }
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

function validateMigrationMutation(
  input: WorksceneMigrationMutation,
): WorksceneMigrationMutation {
  assertPlainRecord(input, "Workscene migration mutation");
  const mutation = structuredClone(input);
  requireIdentifier(mutation.migrationId, "Migration id");
  requireIdentifier(mutation.sourceSnapshotToken, "Source snapshot token");
  switch (mutation.kind) {
    case "workscene-import-legacy":
      assertRecordKeys(
        mutation,
        [
          "kind",
          "migrationId",
          "scene",
          "sourceSnapshotToken",
        ],
        "Workscene legacy import mutation",
      );
      assertPlainRecord(mutation.scene, "Legacy workscene");
      assertRecordKeys(
        mutation.scene,
        mutation.scene.workspace
          ? ["createdAt", "id", "name", "workspace"]
          : ["createdAt", "id", "name"],
        "Legacy workscene",
      );
      requireIdentifier(mutation.scene.id, "Legacy scene id");
      mutation.scene.name = normalizeName(mutation.scene.name);
      canonicalTime(mutation.scene.createdAt, "Legacy scene creation time");
      if (mutation.scene.workspace) validateWorkspace(mutation.scene.workspace);
      break;
    case "workscene-activate-device-registry":
      assertRecordKeys(
        mutation,
        [
          "importSetDigest",
          "kind",
          "migrationId",
          "sourceSnapshotToken",
        ],
        "Workscene legacy activation mutation",
      );
      requireDigest(mutation.importSetDigest, "Legacy import set digest");
      break;
    case "workscene-abandon-legacy-import":
      assertRecordKeys(
        mutation,
        [
          "kind",
          "migrationId",
          "reason",
          "sourceSnapshotToken",
        ],
        "Workscene legacy abandonment mutation",
      );
      if (
        typeof mutation.reason !== "string" ||
        mutation.reason.trim().length === 0
      ) {
        throw new TypeError("Legacy migration abandonment requires a reason");
      }
      break;
    default:
      throw new TypeError("Unknown workscene migration mutation");
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
    case "workscene-legacy-import-opened":
    case "workscene-legacy-import-activated":
    case "workscene-legacy-import-abandoned": {
      assertRecordKeys(
        record,
        ["at", "mutation", "mutationDigest", "requestId", "t"],
        "Workscene migration record",
      );
      requireIdentifier(record.requestId, "Workscene migration requestId");
      const mutation = validateMigrationMutation(record.mutation);
      if (canonicalize(mutation) !== canonicalize(record.mutation)) {
        throw corruptRegistry("Workscene migration mutation is not canonical");
      }
      const expected = protocolDigest(
        "WorksceneMigrationMutation",
        1,
        mutation,
      );
      if (record.mutationDigest !== expected) {
        throw corruptRegistry("Workscene migration digest is inconsistent");
      }
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

function importedScene(
  scene: Extract<
    WorksceneMigrationMutation,
    { kind: "workscene-import-legacy" }
  >["scene"],
): WorksceneDto {
  return {
    id: scene.id,
    revision: 1,
    name: scene.name,
    ...(scene.workspace ? { workspace: { ...scene.workspace } } : {}),
    createdAt: scene.createdAt,
    lastActiveAt: scene.createdAt,
  };
}

export function worksceneImportSetDigest(
  scenes: readonly WorksceneDto[],
): Digest {
  return [...scenes]
    .map(cloneScene)
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"))
    .reduce<Digest>(
      (digest, scene) => worksceneImportSetDigestNext(digest, scene),
      protocolDigest("WorksceneLegacyImportSet", 2, { count: 0 }),
    );
}

export function worksceneImportSetDigestNext(
  previous: Digest,
  scene: WorksceneDto,
): Digest {
  requireDigest(previous, "Legacy import accumulator");
  return protocolDigest("WorksceneLegacyImportSet", 2, {
    previous,
    scene: cloneScene(scene),
  });
}

export function canonicalLegacyWorksceneImport(input: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly workspace?: { readonly deviceId: string; readonly bindingRef: string };
}): WorksceneDto {
  const name = input.name.trim().normalize("NFKC");
  if (!name) {
    throw new TypeError("Legacy workscene name is empty after normalization");
  }
  const imported: WorksceneDto = {
    id: input.id,
    revision: 1,
    name,
    createdAt: input.createdAt,
    lastActiveAt: input.createdAt,
  };
  if (input.workspace) imported.workspace = { ...input.workspace };
  return imported;
}

function importSetDigest(imports: Map<string, WorksceneDto>): Digest {
  return worksceneImportSetDigest([...imports.values()]);
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

function compareDeletionCursor(
  left: { readonly deletionRevision: number; readonly sceneId: string },
  right: { readonly deletionRevision: number; readonly sceneId: string },
): number {
  return (
    left.deletionRevision - right.deletionRevision ||
    left.sceneId.localeCompare(right.sceneId, "en-US")
  );
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

function requireDigest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
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
    legacyBatches: new Map(),
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
    legacyBatches: new Map(
      [...source.legacyBatches].map(([migrationId, batch]) => [
        migrationId,
        {
          sourceSnapshotToken: batch.sourceSnapshotToken,
          imports: new Map(
            [...batch.imports].map(([id, scene]) => [id, cloneScene(scene)]),
          ),
          status: batch.status,
          ...(batch.importSetDigest
            ? { importSetDigest: batch.importSetDigest }
            : {}),
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
  constructor(message: string) {
    super(message);
    this.name = "WorksceneConflictError";
  }
}

export class WorksceneRevisionError extends Error {
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
