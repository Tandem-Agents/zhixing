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
import type { AuthorityCommitLog, ProjectionCursor } from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  protocolDigest,
} from "../protocol/index.js";
import type {
  MemoryCategoryDto,
  MemoryLogicalEntry,
  MemoryScopeRef,
} from "./contracts.js";
import { MemoryStore } from "./memory-store.js";
import {
  compareMemoryLogicalEntries,
  memoryLogicalEntryDigest,
  memoryLogicalEntryKey,
  memoryLogicalEntryMatches,
  memoryLogicalIdentityKey,
  projectMemoryLogicalEntry,
} from "./logical-entry.js";

const MEMORY_STREAM = "intent:memory-authority";

type MemoryMutation = Extract<
  GlobalStagedMutation,
  { kind: "memory-append" | "memory-delete" }
>;

type MemoryAuthorityRecord = {
  readonly t: "memory-mutation-applied";
  readonly requestId: string;
  readonly mutationDigest: string;
  readonly mutation: MemoryMutation;
  readonly revision: number;
  readonly entry?: MemoryLogicalEntry;
  readonly at: string;
};

interface MemoryProjection {
  readonly entries: Map<string, MemoryLogicalEntry>;
  readonly requests: Map<
    string,
    {
      readonly mutationDigest: string;
      readonly revision: number;
      readonly entryKey: string;
    }
  >;
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
  #projection: MemoryProjection = emptyProjection();
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;
  readonly #loadedLegacyScopes = new Map<string, MemoryScopeRef>();

  constructor(options: AnchorMemoryGlobalStateAdapterOptions) {
    this.#log = options.log;
    this.#anchorEpoch = positiveInteger(options.anchorEpoch, "Memory anchor epoch");
    this.#scopeRoot = options.scopeRoot;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async initializeStagedPublishing(): Promise<void> {
    await this.#ensureOpen();
    await this.#loadLegacyScope({ kind: "personal" });
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isMemoryMutation(mutation);
  }

  prepareStagedMutations(input: {
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }>;
  }): {
    readonly records: readonly LogicalRecord[];
    readonly outcomes: ReadonlyMap<
      number,
      | { readonly t: "granted"; readonly targetRevision: number }
      | { readonly t: "conflicted"; readonly error: AuthorityError }
    >;
  } {
    let overlay = cloneProjection(this.#projection);
    const records: LogicalRecord[] = [];
    const outcomes = new Map<
      number,
      | { readonly t: "granted"; readonly targetRevision: number }
      | { readonly t: "conflicted"; readonly error: AuthorityError }
    >();
    for (const item of input.records) {
      if (!isMemoryMutation(item.mutation)) {
        throw new TypeError("Memory planner received another mutation domain");
      }
      const mutation = normalizeMutation(item.mutation);
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
      const planned = planMutation(overlay, mutation, item.requestId, this.#clock());
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
    await this.#reload();
    const replay = this.#projection.requests.get(input.requestId);
    if (!replay || replay.revision !== input.targetRevision) {
      throw new Error("Committed memory mutation is unavailable or changed");
    }
    await this.#materialize(input.requestId, input.mutation);
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    await this.#reload();
    for (const record of records) {
      if (isMemoryMutation(record.mutation)) {
        await this.#materialize(record.requestId, record.mutation);
      }
    }
  }

  async read(query: GlobalQuery, context: GlobalReadCallContext): Promise<GlobalReadResult> {
    if (!isMemoryQuery(query)) {
      throw new TypeError("This global state adapter only owns the memory domain");
    }
    this.#admit(context, "global.read", query.scope);
    await this.#ensureOpen();
    await this.#loadLegacyScope(query.scope);
    const candidates = [...this.#projection.entries.values()].filter((entry) =>
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
    await this.#loadLegacyScope(memoryScopeOf(memoryMutation));
    const normalized = normalizeMutation(memoryMutation);
    const transaction = await this.#log.transactProjection<
      MemoryProjection,
      MemoryAuthorityRecord,
      { revision: number }
    >(
      this.#projection,
      reduceRecord,
      (state) => {
        const planned = planMutation(state, normalized, context.requestId, this.#clock());
        if (planned.outcome.t === "conflicted") {
          throw new MemoryMutationConflictError(planned.outcome.error);
        }
        return {
          kind: "append",
          entries: [{ stream: MEMORY_STREAM, body: planned.record }],
          value: { revision: planned.outcome.targetRevision },
        };
      },
      { cursor: this.#cursor, stream: MEMORY_STREAM },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
    await this.#materialize(context.requestId, normalized);
    return transaction.value;
  }

  async #materialize(requestId: string, mutation: MemoryMutation): Promise<void> {
    const scope = memoryScopeOf(mutation);
    const store = new MemoryStore(this.#scopeRoot(scope));
    const key = this.#projection.requests.get(requestId)?.entryKey;
    if (!key) throw new Error("Committed memory request has no projection key");
    const entry = this.#projection.entries.get(key);
    if (mutation.kind === "memory-delete") {
      await store.delete(storageCategory(mutation.domain, mutation.category), mutation.id);
      return;
    }
    if (!entry) throw new Error("Committed memory entry is absent from its projection");
    await store.save({
      category: storageCategory(entry.domain, entry.category),
      id: entry.id,
      meta: structuredClone(entry.meta),
      content: entry.content,
    });
  }

  async #loadLegacyScope(scope: MemoryScopeRef): Promise<void> {
    this.#loadedLegacyScopes.set(scopeKey(scope), cloneScope(scope));
    const store = new MemoryStore(this.#scopeRoot(scope));
    for (const category of ["profile", "person", "journal"] as const) {
      for (const disk of await store.list(category)) {
        const domain = category === "person" ? "people" : category === "journal" ? "journal" : "memory";
        const entry: MemoryLogicalEntry = {
          domain,
          scope: cloneScope(scope),
          ...(domain === "memory" ? { category: "profile" as const } : {}),
          id: disk.id,
          meta: toJsonObject(disk.meta),
          content: disk.content,
          revision: 1,
          digest: memoryLogicalEntryDigest({
            domain,
            scope,
            ...(domain === "memory" ? { category: "profile" as const } : {}),
            id: disk.id,
            meta: toJsonObject(disk.meta),
            content: disk.content,
          }),
        };
        const key = entryKey(entry);
        if (!this.#projection.entries.has(key)) this.#projection.entries.set(key, entry);
      }
    }
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
    for (const scope of this.#loadedLegacyScopes.values()) {
      await this.#loadLegacyScope(scope);
    }
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

function planMutation(
  state: MemoryProjection,
  mutation: MemoryMutation,
  requestId: string,
  at: string,
): {
  readonly outcome:
    | { readonly t: "granted"; readonly targetRevision: number }
    | { readonly t: "conflicted"; readonly error: AuthorityError };
  readonly record: MemoryAuthorityRecord;
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
  const expectedDigest =
    mutation.payload.domain === "journal"
      ? undefined
      : mutation.payload.expectedDigest;
  if (current && expectedDigest === undefined) {
    return { outcome: conflict("revision-conflict", "Updating memory requires its current digest"), record: undefined as never };
  }
  if ((!current && expectedDigest !== undefined) || (current && current.digest !== expectedDigest)) {
    return { outcome: conflict("revision-conflict", "Memory entry changed"), record: undefined as never };
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
  if (record.t !== "memory-mutation-applied" || state.requests.has(record.requestId)) {
    throw new TypeError("Memory authority record is invalid or duplicated");
  }
  if (record.entry) state.entries.set(entryKey(record.entry), cloneEntry(record.entry));
  else state.entries.delete(plannedMutationKey(record.mutation, record.at));
  state.requests.set(record.requestId, {
    mutationDigest: record.mutationDigest,
    revision: record.revision,
    entryKey: record.entry
      ? entryKey(record.entry)
      : plannedMutationKey(record.mutation, record.at),
  });
  return state;
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
  return { entries: new Map(), requests: new Map() };
}

function cloneProjection(source: MemoryProjection): MemoryProjection {
  return {
    entries: new Map([...source.entries].map(([key, value]) => [key, cloneEntry(value)])),
    requests: new Map([...source.requests].map(([key, value]) => [key, { ...value }])),
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
