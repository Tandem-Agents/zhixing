import type {
  AuthorityError,
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
  JsonValue,
  LogicalRecord,
} from "../contracts/index.js";
import type {
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  ProjectionCursor,
  RebuildableDurableProjectionIndex,
} from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  CommittedMutationMaterializationError,
  protocolDigest,
} from "../protocol/index.js";
import type {
  MemoryCategoryDto,
  MemoryLogicalEntry,
  MemoryScopeRef,
} from "./contracts.js";
import { MemoryStore, type MemoryEntry } from "./memory-store.js";
import {
  compareMemoryLogicalEntries,
  memoryLogicalEntryDigest,
  memoryLogicalEntryKey,
  memoryLogicalEntryMatches,
  memoryLogicalIdentityKey,
  projectMemoryLogicalEntry,
} from "./logical-entry.js";

const MEMORY_STREAM = "intent:memory-authority";
export const MEMORY_AUTHORITY_PROJECTION_ID = "global-memory-authority-v1";
const MEMORY_ENTRY_PREFIX = "entry:";
const MEMORY_REQUEST_PREFIX = "request:";
const MEMORY_PENDING_PREFIX = "pending:";
const MEMORY_SEEN_PREFIX = "seen:";
const MEMORY_LEGACY_CUTOVER_KEY = "legacy-cutover";
const MEMORY_MATERIALIZATION_STREAM = "intent:memory-materialization";

type MemoryMutation = Extract<
  GlobalStagedMutation,
  { kind: "memory-append" | "memory-delete" }
>;

type MemoryMutationAppliedRecord = {
  readonly t: "memory-mutation-applied";
  readonly requestId: string;
  readonly mutationDigest: string;
  readonly mutation: MemoryMutation;
  readonly revision: number;
  readonly entry?: MemoryLogicalEntry;
  readonly at: string;
};

type MemoryLegacyCutoverRecord = {
  readonly t: "memory-legacy-cutover";
  readonly scopeSetDigest: string;
  readonly sourceSetDigest: string;
  readonly at: string;
};

type MemoryAuthorityRecord =
  | MemoryMutationAppliedRecord
  | MemoryLegacyCutoverRecord;

type MemoryMaterializationRecord = {
  readonly t: "memory-materialized";
  readonly requestId: string;
  readonly revision: number;
};

interface MemoryRequestProjection {
  readonly mutationDigest: string;
  readonly revision: number;
  readonly entryKey: string;
}

interface MemoryProjection {
  readonly entries: Map<string, MemoryLogicalEntry>;
  readonly requests: Map<string, MemoryRequestProjection>;
  readonly seenKeys: Set<string>;
  readonly legacyCutover?: MemoryLegacyCutoverRecord;
}

export interface AnchorMemoryGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly anchorEpoch: number;
  readonly scopeRoot: (scope: MemoryScopeRef) => string;
  readonly clock?: () => string;
}

/** Anchor-owned logical memory authority and the sole filesystem materializer. */
export class AnchorMemoryGlobalStateAdapter implements GlobalStatePort {
  readonly #log: AuthorityCommitLog;
  readonly #anchorEpoch: number;
  readonly #scopeRoot: (scope: MemoryScopeRef) => string;
  readonly #clock: () => string;
  readonly #durable: RebuildableDurableProjectionIndex;
  #projection: MemoryProjection = emptyProjection();
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorMemoryGlobalStateAdapterOptions) {
    this.#log = options.log;
    this.#anchorEpoch = positiveInteger(options.anchorEpoch, "Memory anchor epoch");
    this.#scopeRoot = options.scopeRoot;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#durable = this.#log.durableProjection({
      projectionId: MEMORY_AUTHORITY_PROJECTION_ID,
      reducerVersion: 2,
      reduce: reduceMemoryDurableProjection,
    });
  }

  readonly stagedProjectionId = MEMORY_AUTHORITY_PROJECTION_ID;

  async initializeStagedPublishing(
    scopes: readonly MemoryScopeRef[] = [{ kind: "personal" }],
  ): Promise<void> {
    await this.#ensureOpen();
    await this.#takeOverLegacyMemory(scopes);
    await this.refreshStagedMutations([]);
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isMemoryMutation(mutation);
  }

  async prepareStagedMutations(input: {
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }>;
    readonly authorityProjection: DurableProjectionReadContext;
    readonly at: string;
  }): Promise<{
    readonly records: readonly LogicalRecord[];
    readonly outcomes: ReadonlyMap<
      number,
      | { readonly t: "granted"; readonly targetRevision: number }
      | { readonly t: "conflicted"; readonly error: AuthorityError }
    >;
  }> {
    let overlay = await loadMemoryProjectionForMutations(
      input.authorityProjection,
      input.records.map((record) => ({
        requestId: record.requestId,
        mutation: requireMemoryMutation(record.mutation),
      })),
      input.at,
    );
    const records: LogicalRecord[] = [];
    const outcomes = new Map<
      number,
      | { readonly t: "granted"; readonly targetRevision: number }
      | { readonly t: "conflicted"; readonly error: AuthorityError }
    >();
    for (const item of input.records) {
      const mutation = normalizeMutation(requireMemoryMutation(item.mutation));
      const mutationDigest = protocolDigest("MemoryAuthorityMutation", 1, mutation);
      const replay = overlay.requests.get(item.requestId);
      if (replay) {
        outcomes.set(
          item.seq,
          replay.mutationDigest === mutationDigest
            ? { t: "granted", targetRevision: replay.revision }
            : conflict(
                "idempotency-conflict",
                "Memory request identity is already bound to another mutation",
              ),
        );
        continue;
      }
      const planned = planMutation(overlay, mutation, item.requestId, input.at);
      if (planned.outcome.t === "conflicted") {
        outcomes.set(item.seq, planned.outcome);
        continue;
      }
      const logical: LogicalRecord<MemoryAuthorityRecord> = {
        stream: MEMORY_STREAM,
        body: planned.record,
      };
      overlay = reduceRecord(overlay, logical);
      records.push(logical as unknown as LogicalRecord<JsonValue>);
      outcomes.set(item.seq, planned.outcome);
    }
    return { records, outcomes };
  }

  async applyStagedMutation(input: {
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
    readonly targetRevision: number;
  }): Promise<void> {
    if (!isMemoryMutation(input.mutation)) {
      throw new TypeError("Memory materializer received another mutation domain");
    }
    await this.#materializePending(input.requestId, input.targetRevision);
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    if (records.length === 0) {
      await this.#log.transactDurableProjection(
        MEMORY_AUTHORITY_PROJECTION_ID,
        () => ({ kind: "return", value: undefined }),
      );
      let continuation: string | undefined;
      do {
        const page = await this.#durable.scan(
          { gte: MEMORY_PENDING_PREFIX, lt: `${MEMORY_PENDING_PREFIX}\uffff` },
          128,
          continuation,
        );
        for (const entry of page.entries) {
          await this.#materializePending(entry.key.slice(MEMORY_PENDING_PREFIX.length));
        }
        continuation = page.continuation;
      } while (continuation !== undefined);
      return;
    }
    for (const record of records) {
      if (isMemoryMutation(record.mutation)) {
        await this.#materializePending(record.requestId);
      }
    }
  }

  async read(query: GlobalQuery, context: GlobalReadCallContext): Promise<GlobalReadResult> {
    if (!isMemoryQuery(query)) {
      throw new TypeError("This global state adapter only owns the memory domain");
    }
    this.#admit(context, "global.read", query.scope);
    await this.#ensureOpen();
    const entries = await readMemoryEntries(this.#durable);
    const candidates = [...entries.values()].filter((entry) =>
      memoryLogicalEntryMatches(entry, {
        scope: query.scope,
        domain: query.domain,
        ...(query.kind === "memory-list" && query.category !== undefined
          ? { category: query.category }
          : {}),
      })
    );
    if (query.kind === "memory-stats") {
      return {
        kind: "memory-stats",
        domain: query.domain,
        count: candidates.length,
        ...(candidates.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1)
          ? { lastWriteAt: candidates.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1)! }
          : {}),
      };
    }
    if (query.kind === "memory-list") {
      return {
        kind: "memory-list",
        entries: candidates.map(cloneEntry).sort(compareMemoryLogicalEntries),
      };
    }
    return {
      kind: "memory-search",
      hits: candidates
        .filter((entry) => memoryLogicalEntryMatches(entry, {
          scope: query.scope,
          domain: query.domain,
          query: query.query,
        }))
        .sort(compareMemoryLogicalEntries)
        .slice(0, positiveInteger(query.limit, "Memory search limit"))
        .map((entry) => ({ entry: cloneEntry(entry) })),
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
  ): Promise<
    | GlobalControlMutationResult<GlobalControlMutation>
    | GlobalStagedMutationResult<GlobalStagedMutation>
  > {
    if (!isMemoryMutation(mutation as GlobalStagedMutation)) {
      throw new TypeError("This global state adapter only owns the memory domain");
    }
    if (context.principal.kind === "assignment") {
      throw new AuthorityMethodForbiddenError(
        "Assignment memory mutations must be staged by the assignment owner",
      );
    }
    const memoryMutation = mutation as MemoryMutation;
    this.#admit(context, "global.mutate", memoryScopeOf(memoryMutation));
    await this.#ensureOpen();
    const normalized = normalizeMutation(memoryMutation);
    const transaction = await this.#log.transactProjection<
      MemoryProjection,
      MemoryAuthorityRecord,
      { revision: number }
    >(
      this.#projection,
      reduceRecord,
      async (_state, transactionContext) => {
        const state = await loadMemoryProjectionForMutations(
          transactionContext.readProjection(MEMORY_AUTHORITY_PROJECTION_ID),
          [{ requestId: context.requestId, mutation: normalized }],
          transactionContext.at,
        );
        const planned = planMutation(
          state,
          normalized,
          context.requestId,
          transactionContext.at,
        );
        if (planned.outcome.t === "conflicted") {
          throw new MemoryMutationConflictError(planned.outcome.error);
        }
        return {
          kind: "append",
          entries: [{ stream: MEMORY_STREAM, body: planned.record }],
          value: { revision: planned.outcome.targetRevision },
        };
      },
      {
        cursor: this.#cursor,
        stream: MEMORY_STREAM,
        readProjectionIds: [MEMORY_AUTHORITY_PROJECTION_ID],
      },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
    await this.#materializePending(context.requestId, transaction.value.revision).catch(
      () => undefined,
    );
    return transaction.value;
  }

  async #materializePending(
    requestId: string,
    expectedRevision?: number,
  ): Promise<void> {
    const pending = await this.#durable.get(memoryPendingKey(requestId));
    if (pending === undefined) {
      const replay = readMemoryRequest(
        await this.#durable.get(memoryRequestKey(requestId)),
      );
      if (!replay || (expectedRevision !== undefined && replay.revision !== expectedRevision)) {
        throw new CommittedMutationMaterializationError(
          "Committed memory mutation is unavailable or changed",
        );
      }
      return;
    }
    const record = readPendingMemoryRecord(pending);
    if (expectedRevision !== undefined && record.revision !== expectedRevision) {
      throw new CommittedMutationMaterializationError(
        "Committed memory mutation is unavailable or changed",
      );
    }
    const mutation = record.mutation;
    const scope = memoryScopeOf(mutation);
    const store = new MemoryStore(this.#scopeRoot(scope));
    const replay = readMemoryRequest(
      await this.#durable.get(memoryRequestKey(requestId)),
    );
    if (!replay || replay.revision !== record.revision) {
      throw new CommittedMutationMaterializationError(
        "Committed memory request has no projection key",
      );
    }
    const entry = readMemoryEntry(
      await this.#durable.get(memoryEntryKey(replay.entryKey)),
    );
    if (mutation.kind === "memory-delete") {
      await store.delete(storageCategory(mutation.domain, mutation.category), mutation.id);
    } else {
      if (!entry) {
        throw new CommittedMutationMaterializationError(
          "Committed memory entry is absent from its projection",
        );
      }
      await store.save({
        category: storageCategory(entry.domain, entry.category),
        id: entry.id,
        meta: structuredClone(entry.meta),
        content: entry.content,
      });
    }
    await this.#log.transactDurableProjection<MemoryMaterializationRecord, void>(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection) => {
        const current = await projection.get(memoryPendingKey(requestId));
        if (current === undefined) return { kind: "return", value: undefined };
        const currentRecord = readPendingMemoryRecord(current);
        if (currentRecord.revision !== record.revision) {
          throw new CommittedMutationMaterializationError(
            "Memory materialization target changed",
          );
        }
        return {
          kind: "append",
          entries: [{
            stream: MEMORY_MATERIALIZATION_STREAM,
            body: {
              t: "memory-materialized",
              requestId,
              revision: record.revision,
            },
          }],
          value: undefined,
        };
      },
    );
  }

  async #takeOverLegacyMemory(scopes: readonly MemoryScopeRef[]): Promise<void> {
    const existing = await this.#log.transactDurableProjection<
      MemoryAuthorityRecord,
      MemoryLegacyCutoverRecord | undefined
    >(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection) => ({
        kind: "return",
        value: readLegacyCutover(
          await projection.get(MEMORY_LEGACY_CUTOVER_KEY),
        ),
      }),
    );
    if (existing.value) return;

    const normalizedScopes = normalizeLegacyScopes(scopes);
    const sources = await readLegacyMemorySources(
      normalizedScopes,
      this.#scopeRoot,
    );
    for (const source of sources) {
      await this.#importLegacySource(source);
    }

    const scopeSetDigest = protocolDigest(
      "MemoryLegacyScopeSet",
      1,
      normalizedScopes,
    );
    const sourceSetDigest = protocolDigest(
      "MemoryLegacySourceSet",
      1,
      sources.map(({ entry }) => entry),
    );
    await this.#log.transactDurableProjection<MemoryAuthorityRecord, void>(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection, context) => {
        const current = readLegacyCutover(
          await projection.get(MEMORY_LEGACY_CUTOVER_KEY),
        );
        if (current) return { kind: "return", value: undefined };
        return {
          kind: "append",
          entries: [{
            stream: MEMORY_STREAM,
            body: {
              t: "memory-legacy-cutover",
              scopeSetDigest,
              sourceSetDigest,
              at: context.at,
            },
          }],
          value: undefined,
        };
      },
    );
    await this.#reload();
  }

  async #importLegacySource(source: LegacyMemorySource): Promise<void> {
    const logicalKey = entryKey(source.entry);
    const requestId = legacyImportRequestId(logicalKey);
    const mutationDigest = protocolDigest("MemoryLegacyImport", 1, {
      logicalKey,
      entry: source.entry,
    });
    await this.#log.transactDurableProjection<MemoryAuthorityRecord, void>(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection, context) => {
        const replay = readMemoryRequest(
          await projection.get(memoryRequestKey(requestId)),
        );
        if (replay) {
          if (
            replay.mutationDigest !== mutationDigest ||
            replay.entryKey !== logicalKey
          ) {
            throw new MemoryMutationConflictError(
              conflict(
                "idempotency-conflict",
                "Legacy memory changed while its authority import was incomplete",
              ).error,
            );
          }
          return { kind: "return", value: undefined };
        }
        if (await projection.get(memorySeenKey(logicalKey))) {
          return { kind: "return", value: undefined };
        }
        if (await projection.get(memoryEntryKey(logicalKey))) {
          throw new Error("Memory entry exists without its authority seen marker");
        }
        return {
          kind: "append",
          entries: [{
            stream: MEMORY_STREAM,
            body: {
              t: "memory-mutation-applied",
              requestId,
              mutationDigest,
              mutation: source.mutation,
              revision: 1,
              entry: source.entry,
              at: context.at,
            },
          }],
          value: undefined,
        };
      },
    );
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#reload();
    await this.#opening;
  }

  async #reload(): Promise<void> {
    const snapshot = await this.#log.readSnapshot<MemoryAuthorityRecord>();
    let state = emptyProjection();
    for (const commit of snapshot.commits) {
      for (const entry of commit.entries) {
        if (entry.stream === MEMORY_STREAM) {
          state = reduceRecord(state, entry as LogicalRecord<MemoryAuthorityRecord>);
        }
      }
    }
    this.#projection = state;
    this.#cursor = snapshot.cursor;
  }

  #admit(
    context: GlobalReadCallContext | GlobalControlCallContext | GlobalStagedCallContext,
    method: "global.read" | "global.mutate",
    scope: MemoryScopeRef,
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (context.authority.domain !== "global" || context.authority.anchorEpoch !== this.#anchorEpoch) {
      throw new TypeError("Global memory authority fence is stale or invalid");
    }
    if (context.principal.kind === "assignment") {
      if (!context.principal.capability.resources.includes(memoryResource(scope))) {
        throw new AuthorityMethodForbiddenError(
          "Assignment capability does not cover this memory scope",
        );
      }
    }
    if (!context.requestId || Date.parse(context.deadlineAt) < Date.parse(this.#clock())) {
      throw new TypeError("Global memory request identity or deadline is invalid");
    }
  }
}

function memoryResource(scope: MemoryScopeRef): `memory-domain:${string}` {
  return scope.kind === "personal"
    ? "memory-domain:personal"
    : `memory-domain:workscene:${scope.sceneId}`;
}

function scopeKey(scope: MemoryScopeRef): string {
  return scope.kind === "personal" ? "personal" : `workscene:${scope.sceneId}`;
}

interface LegacyMemorySource {
  readonly entry: MemoryLogicalEntry;
  readonly mutation: MemoryMutation;
}

function normalizeLegacyScopes(
  scopes: readonly MemoryScopeRef[],
): MemoryScopeRef[] {
  const unique = new Map<string, MemoryScopeRef>();
  unique.set("personal", { kind: "personal" });
  for (const scope of scopes) {
    if (scope.kind === "workscene") {
      identifier(scope.sceneId, "Legacy memory workscene id");
    }
    unique.set(scopeKey(scope), cloneScope(scope));
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, scope]) => scope);
}

async function readLegacyMemorySources(
  scopes: readonly MemoryScopeRef[],
  scopeRoot: (scope: MemoryScopeRef) => string,
): Promise<LegacyMemorySource[]> {
  const sources = new Map<string, LegacyMemorySource>();
  for (const scope of scopes) {
    const store = new MemoryStore(scopeRoot(scope));
    const entries = (await store.readAuthorityTakeoverSnapshot()).sort((left, right) =>
      left.category.localeCompare(right.category, "en-US") ||
      left.id.localeCompare(right.id, "en-US")
    );
    for (const disk of entries) {
      const source = legacyMemorySource(scope, disk);
      const key = entryKey(source.entry);
      const existing = sources.get(key);
      if (existing && existing.entry.digest !== source.entry.digest) {
        throw new Error("Legacy memory contains duplicate logical identities");
      }
      sources.set(key, source);
    }
  }
  return [...sources.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, source]) => source);
}

function legacyMemorySource(
  scope: MemoryScopeRef,
  disk: MemoryEntry,
): LegacyMemorySource {
  const domain = disk.category === "person"
    ? "people"
    : disk.category === "journal"
      ? "journal"
      : "memory";
  const meta = toJsonObject(disk.meta);
  const identity = {
    domain,
    scope: cloneScope(scope),
    ...(domain === "memory" ? { category: "profile" as const } : {}),
    id: disk.id,
    meta,
    content: disk.content,
  };
  const entry: MemoryLogicalEntry = {
    ...identity,
    revision: 1,
    digest: memoryLogicalEntryDigest(identity),
  } as MemoryLogicalEntry;
  const mutation = {
    kind: "memory-append",
    payload: domain === "memory"
      ? {
          domain,
          scope: cloneScope(scope),
          category: "profile",
          id: disk.id,
          meta,
          content: disk.content,
        }
      : domain === "people"
        ? {
            domain,
            scope: cloneScope(scope),
            id: disk.id,
            meta,
            content: disk.content,
          }
        : {
            domain,
            scope: cloneScope(scope),
            date: disk.id,
            content: disk.content,
          },
  } as MemoryMutation;
  return { entry, mutation };
}

function legacyImportRequestId(logicalKey: string): string {
  return `memory-legacy-import:${protocolDigest(
    "MemoryLegacyImportRequest",
    1,
    { logicalKey },
  ).slice("sha256:".length)}`;
}

function planMutation(
  state: MemoryProjection,
  mutation: MemoryMutation,
  requestId: string,
  at: string,
): {
  readonly outcome:
    | { readonly t: "granted"; readonly targetRevision: number }
    | { readonly t: "conflicted"; readonly error: AuthorityError };
  readonly record: MemoryMutationAppliedRecord;
} {
  const mutationDigest = protocolDigest("MemoryAuthorityMutation", 1, mutation);
  const replay = state.requests.get(requestId);
  if (replay) {
    if (replay.mutationDigest !== mutationDigest) {
      return {
        outcome: conflict("idempotency-conflict", "Memory request identity was reused"),
        record: undefined as never,
      };
    }
    return {
      outcome: { t: "granted", targetRevision: replay.revision },
      record: undefined as never,
    };
  }
  const key = plannedMutationKey(mutation, at);
  const current = state.entries.get(key);
  if (mutation.kind === "memory-delete") {
    if (!current) {
      return { outcome: conflict("not-found", "Memory entry was not found"), record: undefined as never };
    }
    if (current.digest !== mutation.expectedDigest) {
      return { outcome: conflict("revision-conflict", "Memory entry changed"), record: undefined as never };
    }
    const revision = current.revision + 1;
    return {
      outcome: { t: "granted", targetRevision: revision },
      record: {
        t: "memory-mutation-applied",
        requestId,
        mutationDigest,
        mutation: structuredClone(mutation),
        revision,
        at,
      },
    };
  }
  if (mutation.payload.domain !== "journal") {
    const expectedDigest = mutation.payload.expectedDigest;
    if (current && expectedDigest === undefined) {
      return { outcome: conflict("revision-conflict", "Updating memory requires its current digest"), record: undefined as never };
    }
    if ((!current && expectedDigest !== undefined) || (current && current.digest !== expectedDigest)) {
      return { outcome: conflict("revision-conflict", "Memory entry changed"), record: undefined as never };
    }
  }
  const revision = (current?.revision ?? 0) + 1;
  const entry = projectMemoryLogicalEntry(mutation.payload, current, {
    revision,
    updatedAt: at,
  });
  return {
    outcome: { t: "granted", targetRevision: revision },
    record: {
      t: "memory-mutation-applied",
      requestId,
      mutationDigest,
      mutation: structuredClone(mutation),
      revision,
      entry,
      at,
    },
  };
}

function reduceRecord(previous: MemoryProjection, logical: LogicalRecord<MemoryAuthorityRecord>): MemoryProjection {
  const state = cloneProjection(previous);
  const record = logical.body;
  if (record.t === "memory-legacy-cutover") {
    if (state.legacyCutover) {
      throw new TypeError("Memory legacy cutover was duplicated");
    }
    return { ...state, legacyCutover: structuredClone(record) };
  }
  if (state.requests.has(record.requestId)) {
    throw new TypeError("Memory authority record is invalid or duplicated");
  }
  const logicalKey = record.entry
    ? entryKey(record.entry)
    : plannedMutationKey(record.mutation, record.at);
  if (record.entry) state.entries.set(logicalKey, cloneEntry(record.entry));
  else state.entries.delete(logicalKey);
  state.seenKeys.add(logicalKey);
  state.requests.set(record.requestId, {
    mutationDigest: record.mutationDigest,
    revision: record.revision,
    entryKey: logicalKey,
  });
  return state;
}

async function reduceMemoryDurableProjection(
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

  for (const logical of envelope.entries) {
    if (logical.stream === MEMORY_STREAM) {
      const record = readMemoryAuthorityRecord(logical.body);
      if (record.t === "memory-legacy-cutover") {
        if (await get(MEMORY_LEGACY_CUTOVER_KEY)) {
          throw new TypeError("Memory legacy cutover was duplicated");
        }
        put(
          MEMORY_LEGACY_CUTOVER_KEY,
          structuredClone(record) as unknown as JsonValue,
        );
        continue;
      }
      const requestKey = memoryRequestKey(record.requestId);
      if (await get(requestKey)) {
        throw new TypeError("Memory authority request was duplicated");
      }
      const logicalKey = record.entry
        ? entryKey(record.entry)
        : plannedMutationKey(record.mutation, record.at);
      if (record.entry) {
        put(memoryEntryKey(logicalKey), cloneEntry(record.entry) as unknown as JsonValue);
      } else {
        tombstone(memoryEntryKey(logicalKey));
      }
      put(memorySeenKey(logicalKey), true);
      put(requestKey, {
        mutationDigest: record.mutationDigest,
        revision: record.revision,
        entryKey: logicalKey,
      });
      put(memoryPendingKey(record.requestId), structuredClone(record) as unknown as JsonValue);
      continue;
    }
    if (logical.stream !== MEMORY_MATERIALIZATION_STREAM) continue;
    const record = readMemoryMaterializationRecord(logical.body);
    const pending = await get(memoryPendingKey(record.requestId));
    if (!pending || readPendingMemoryRecord(pending).revision !== record.revision) {
      throw new TypeError("Memory materialization acknowledgement is stale");
    }
    tombstone(memoryPendingKey(record.requestId));
  }
  return mutations;
}

async function loadMemoryProjectionForMutations(
  projection: DurableProjectionReadContext,
  records: readonly { readonly requestId: string; readonly mutation: MemoryMutation }[],
  at: string,
): Promise<MemoryProjection> {
  const state = emptyProjection();
  for (const item of records) {
    const request = readMemoryRequest(
      await projection.get(memoryRequestKey(item.requestId)),
    );
    if (request) state.requests.set(item.requestId, request);
    const logicalKey = plannedMutationKey(normalizeMutation(item.mutation), at);
    if (state.entries.has(logicalKey)) continue;
    const entry = readMemoryEntry(
      await projection.get(memoryEntryKey(logicalKey)),
    );
    if (entry) state.entries.set(logicalKey, entry);
  }
  return state;
}

async function readMemoryEntries(
  projection: RebuildableDurableProjectionIndex,
): Promise<Map<string, MemoryLogicalEntry>> {
  const entries = new Map<string, MemoryLogicalEntry>();
  let continuation: string | undefined;
  do {
    const page = await projection.scan(
      { gte: MEMORY_ENTRY_PREFIX, lt: `${MEMORY_ENTRY_PREFIX}\uffff` },
      256,
      continuation,
    );
    for (const item of page.entries) {
      const entry = readMemoryEntry(item.value);
      if (!entry) throw new TypeError("Memory authority projection entry is invalid");
      entries.set(
        decodeURIComponent(item.key.slice(MEMORY_ENTRY_PREFIX.length)),
        entry,
      );
    }
    continuation = page.continuation;
  } while (continuation !== undefined);
  return entries;
}

function memoryEntryKey(key: string): string {
  return `${MEMORY_ENTRY_PREFIX}${encodeURIComponent(key)}`;
}

function memoryRequestKey(requestId: string): string {
  return `${MEMORY_REQUEST_PREFIX}${requestId}`;
}

function memoryPendingKey(requestId: string): string {
  return `${MEMORY_PENDING_PREFIX}${requestId}`;
}

function memorySeenKey(logicalKey: string): string {
  return `${MEMORY_SEEN_PREFIX}${encodeURIComponent(logicalKey)}`;
}

function readMemoryRequest(value: JsonValue | undefined): MemoryRequestProjection | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.mutationDigest !== "string" ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0 ||
    typeof value.entryKey !== "string"
  ) {
    throw new TypeError("Memory authority request projection is invalid");
  }
  return {
    mutationDigest: value.mutationDigest,
    revision: Number(value.revision),
    entryKey: value.entryKey,
  };
}

function readMemoryEntry(value: JsonValue | undefined): MemoryLogicalEntry | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Memory authority entry projection is invalid");
  }
  return cloneEntry(value as unknown as MemoryLogicalEntry);
}

function readMemoryAuthorityRecord(value: unknown): MemoryAuthorityRecord {
  if (
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as { t?: unknown }).t === "memory-legacy-cutover"
  ) {
    const cutover = readLegacyCutover(value);
    if (!cutover) {
      throw new TypeError("Memory legacy cutover record is invalid");
    }
    return cutover;
  }
  return readPendingMemoryRecord(value);
}

function readPendingMemoryRecord(value: unknown): MemoryMutationAppliedRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { t?: unknown }).t !== "memory-mutation-applied"
  ) {
    throw new TypeError("Memory authority record is invalid");
  }
  const record = value as MemoryMutationAppliedRecord;
  identifier(record.requestId, "Memory authority requestId");
  if (!Number.isSafeInteger(record.revision) || record.revision <= 0) {
    throw new TypeError("Memory authority revision is invalid");
  }
  normalizeMutation(record.mutation);
  return structuredClone(record);
}

function readLegacyCutover(
  value: JsonValue | undefined | unknown,
): MemoryLegacyCutoverRecord | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "at,scopeSetDigest,sourceSetDigest,t" ||
    (value as { t?: unknown }).t !== "memory-legacy-cutover"
  ) {
    throw new TypeError("Memory legacy cutover record is invalid");
  }
  const record = value as unknown as MemoryLegacyCutoverRecord;
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(record.scopeSetDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.sourceSetDigest) ||
    !Number.isFinite(Date.parse(record.at))
  ) {
    throw new TypeError("Memory legacy cutover record is invalid");
  }
  return structuredClone(record);
}

function readMemoryMaterializationRecord(value: unknown): MemoryMaterializationRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { t?: unknown }).t !== "memory-materialized"
  ) {
    throw new TypeError("Memory materialization record is invalid");
  }
  const record = value as MemoryMaterializationRecord;
  identifier(record.requestId, "Memory materialization requestId");
  if (!Number.isSafeInteger(record.revision) || record.revision <= 0) {
    throw new TypeError("Memory materialization revision is invalid");
  }
  return { ...record };
}

function requireMemoryMutation(mutation: GlobalStagedMutation): MemoryMutation {
  if (!isMemoryMutation(mutation)) {
    throw new TypeError("Memory planner received another mutation domain");
  }
  return mutation;
}

function normalizeMutation(mutation: MemoryMutation): MemoryMutation {
  const normalized = structuredClone(mutation);
  const scope = memoryScopeOf(normalized);
  if (scope.kind === "workscene") identifier(scope.sceneId, "Memory workscene id");
  if (normalized.kind === "memory-delete") {
    identifier(normalized.id, "Memory id");
  } else if (normalized.payload.domain !== "journal") {
    identifier(normalized.payload.id, "Memory id");
  }
  return normalized;
}

function mutationKey(mutation: MemoryMutation): string {
  if (mutation.kind === "memory-delete") {
    return memoryLogicalIdentityKey(
      mutation.scope,
      mutation.domain,
      mutation.category,
      mutation.id,
    );
  }
  const payload = mutation.payload;
  const id = payload.domain === "journal"
    ? payload.date ?? new Date().toISOString().slice(0, 10)
    : payload.id;
  return memoryLogicalIdentityKey(
    payload.scope,
    payload.domain,
    payload.domain === "memory" ? payload.category : undefined,
    id,
  );
}

function plannedMutationKey(mutation: MemoryMutation, at: string): string {
  if (mutation.kind === "memory-delete") return mutationKey(mutation);
  const payload = mutation.payload;
  const id = payload.domain === "journal" ? payload.date ?? at.slice(0, 10) : payload.id;
  return memoryLogicalIdentityKey(
    payload.scope,
    payload.domain,
    payload.domain === "memory" ? payload.category : undefined,
    id,
  );
}

function entryKey(entry: MemoryLogicalEntry): string {
  return memoryLogicalEntryKey(entry);
}

function memoryScopeOf(mutation: MemoryMutation): MemoryScopeRef {
  return mutation.kind === "memory-delete" ? mutation.scope : mutation.payload.scope;
}

function storageCategory(
  domain: "memory" | "journal" | "people",
  category?: MemoryCategoryDto,
): "profile" | "person" | "journal" {
  return domain === "journal" ? "journal" : domain === "people" ? "person" : category ?? "profile";
}

function emptyProjection(): MemoryProjection {
  return { entries: new Map(), requests: new Map(), seenKeys: new Set() };
}

function cloneProjection(source: MemoryProjection): MemoryProjection {
  return {
    entries: new Map([...source.entries].map(([key, value]) => [key, cloneEntry(value)])),
    requests: new Map([...source.requests].map(([key, value]) => [key, { ...value }])),
    seenKeys: new Set(source.seenKeys),
    ...(source.legacyCutover
      ? { legacyCutover: structuredClone(source.legacyCutover) }
      : {}),
  };
}

function cloneEntry(entry: MemoryLogicalEntry): MemoryLogicalEntry {
  return structuredClone(entry);
}

function cloneScope(scope: MemoryScopeRef): MemoryScopeRef {
  return scope.kind === "personal" ? { kind: "personal" } : { ...scope };
}

function isMemoryMutation(mutation: GlobalStagedMutation): mutation is MemoryMutation {
  return mutation.kind === "memory-append" || mutation.kind === "memory-delete";
}

function isMemoryQuery(query: GlobalQuery): query is Extract<
  GlobalQuery,
  { kind: "memory-search" | "memory-list" | "memory-stats" }
> {
  return query.kind === "memory-search" || query.kind === "memory-list" || query.kind === "memory-stats";
}

function conflict(code: AuthorityError["code"], message: string) {
  return { t: "conflicted" as const, error: { code, message, retryable: false } };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function identifier(value: string, label: string): string {
  if (!value || value.length > 512 || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function toJsonObject(value: Record<string, unknown>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

export class MemoryMutationConflictError extends Error {
  constructor(readonly authorityError: AuthorityError) {
    super(authorityError.message);
    this.name = "MemoryMutationConflictError";
  }
}
