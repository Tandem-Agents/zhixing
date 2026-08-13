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
  protocolDigest,
  validateGlobalQuery,
} from "../protocol/index.js";
import type { MemoryLogicalEntry, MemoryScopeRef } from "./contracts.js";
import {
  compareMemoryLogicalEntries,
  memoryLogicalEntryDigest,
  memoryLogicalEntryKey,
  memoryLogicalEntryMatches,
  memoryLogicalIdentityKey,
  projectMemoryLogicalEntry,
} from "./logical-entry.js";
import {
  assertSubstantiveJournalContent,
  canonicalMemoryIdentity,
  isCalendarDay,
  isCalendarMonth,
} from "./canonical-identity.js";

const MEMORY_STREAM = "intent:memory-authority";
export const MEMORY_AUTHORITY_PROJECTION_ID = "global-memory-authority-v1";
const MEMORY_ENTRY_PREFIX = "entry:";
const MEMORY_REQUEST_PREFIX = "request:";
const MEMORY_SEEN_PREFIX = "seen:";

type StagedMemoryMutation = Extract<
  GlobalStagedMutation,
  { kind: "memory-append" | "memory-delete" }
>;

type MemoryControlMutation = Extract<
  GlobalControlMutation,
  { kind: "memory-append" | "memory-delete" | "memory-journal-condense" }
>;

type MemoryMutationAppliedRecord = {
  readonly t: "memory-mutation-applied";
  readonly requestId: string;
  readonly mutationDigest: string;
  readonly mutation: StagedMemoryMutation;
  readonly revision: number;
  readonly entry?: MemoryLogicalEntry;
  readonly at: string;
};

type MemoryJournalCondensedRecord = {
  readonly t: "memory-journal-condensed";
  readonly requestId: string;
  readonly mutationDigest: string;
  readonly mutation: Extract<MemoryControlMutation, { kind: "memory-journal-condense" }>;
  readonly revision: number;
  readonly entry: MemoryLogicalEntry;
  readonly deletedEntryKeys: readonly string[];
  readonly at: string;
};

type MemoryAuthorityRecord =
  | MemoryMutationAppliedRecord
  | MemoryJournalCondensedRecord;

type MemoryPendingRecord = MemoryMutationAppliedRecord | MemoryJournalCondensedRecord;

interface MemoryRequestProjection {
  readonly mutationDigest: string;
  readonly revision: number;
  readonly entryKey: string;
}

interface MemoryProjection {
  readonly entries: Map<string, MemoryLogicalEntry>;
  readonly requests: Map<string, MemoryRequestProjection>;
  readonly seenKeys: Set<string>;
}

export interface AnchorMemoryGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly anchorEpoch: number;
  readonly clock?: () => string;
}

/** Anchor-owned logical memory authority. */
export class AnchorMemoryGlobalStateAdapter implements GlobalStatePort {
  readonly #log: AuthorityCommitLog;
  readonly #anchorEpoch: number;
  readonly #clock: () => string;
  readonly #durable: RebuildableDurableProjectionIndex;
  #projection: MemoryProjection = emptyProjection();
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorMemoryGlobalStateAdapterOptions) {
    this.#log = options.log;
    this.#anchorEpoch = positiveInteger(options.anchorEpoch, "Memory anchor epoch");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#durable = this.#log.durableProjection({
      projectionId: MEMORY_AUTHORITY_PROJECTION_ID,
      reducerVersion: 4,
      reduce: reduceMemoryDurableProjection,
    });
  }

  readonly stagedProjectionId = MEMORY_AUTHORITY_PROJECTION_ID;

  async initializeStagedPublishing(): Promise<void> {
    await this.#ensureOpen();
    await this.refreshStagedMutations([]);
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isStagedMemoryMutation(mutation);
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
        mutation: requireStagedMemoryMutation(record.mutation),
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
      const mutation = normalizeStagedMutation(requireStagedMemoryMutation(item.mutation));
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
    if (!isStagedMemoryMutation(input.mutation)) {
      throw new TypeError("Memory authority received another mutation domain");
    }
    await this.#assertCommittedMutation(input.requestId, input.targetRevision);
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    await this.#log.transactDurableProjection(
      MEMORY_AUTHORITY_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
    for (const record of records) {
      if (isStagedMemoryMutation(record.mutation)) {
        await this.#assertCommittedMutation(record.requestId);
      }
    }
  }

  async read(query: GlobalQuery, context: GlobalReadCallContext): Promise<GlobalReadResult> {
    const normalizedQuery = validateGlobalQuery(query);
    if (!isMemoryQuery(normalizedQuery)) {
      throw new TypeError("This global state adapter only owns the memory domain");
    }
    this.#admit(context, "global.read", normalizedQuery.scope);
    await this.#ensureOpen();
    const entries = await readMemoryEntries(this.#durable);
    const candidates = [...entries.values()].filter((entry) =>
      memoryLogicalEntryMatches(entry, {
        scope: normalizedQuery.scope,
        domain: normalizedQuery.domain,
        ...(normalizedQuery.kind === "memory-list" && normalizedQuery.category !== undefined
          ? { category: normalizedQuery.category }
          : {}),
      })
    );
    if (normalizedQuery.kind === "memory-stats") {
      return {
        kind: "memory-stats",
        domain: normalizedQuery.domain,
        count: candidates.length,
        ...(candidates.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1)
          ? { lastWriteAt: candidates.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1)! }
          : {}),
      };
    }
    if (normalizedQuery.kind === "memory-list") {
      return {
        kind: "memory-list",
        entries: candidates.map(cloneEntry).sort(compareMemoryLogicalEntries),
      };
    }
    return {
      kind: "memory-search",
      hits: candidates
        .filter((entry) => memoryLogicalEntryMatches(entry, {
          scope: normalizedQuery.scope,
          domain: normalizedQuery.domain,
          query: normalizedQuery.query,
        }))
        .sort(compareMemoryLogicalEntries)
        .slice(0, positiveInteger(normalizedQuery.limit, "Memory search limit"))
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
    if (!isMemoryControlMutation(mutation)) {
      throw new TypeError("This global state adapter only owns the memory domain");
    }
    if (context.principal.kind === "assignment") {
      throw new AuthorityMethodForbiddenError(
        "Assignment memory mutations must be staged by the assignment owner",
      );
    }
    const memoryMutation = mutation;
    if (
      memoryMutation.kind === "memory-journal-condense" &&
      (context.principal.kind !== "host" ||
        context.principal.component !== "memory-journal-maintenance")
    ) {
      throw new AuthorityMethodForbiddenError(
        "Journal condensation is owned by anchor memory maintenance",
      );
    }
    if (
      memoryMutation.kind === "memory-delete" &&
      memoryMutation.domain === "journal" &&
      (context.principal.kind !== "host" ||
        context.principal.component !== "memory-journal-maintenance")
    ) {
      throw new AuthorityMethodForbiddenError(
        "Journal deletion is owned by anchor memory maintenance",
      );
    }
    this.#admit(context, "global.mutate", memoryScopeOf(memoryMutation));
    await this.#ensureOpen();
    const normalized = normalizeControlMutation(memoryMutation);
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
        const planned = planControlMutation(
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
    return transaction.value;
  }

  async #assertCommittedMutation(
    requestId: string,
    expectedRevision?: number,
  ): Promise<void> {
    const replay = readMemoryRequest(
      await this.#durable.get(memoryRequestKey(requestId)),
    );
    if (!replay || (expectedRevision !== undefined && replay.revision !== expectedRevision)) {
      throw new Error("Committed memory mutation is unavailable or changed");
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

function planMutation(
  state: MemoryProjection,
  mutation: StagedMemoryMutation,
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

function planControlMutation(
  state: MemoryProjection,
  mutation: MemoryControlMutation,
  requestId: string,
  at: string,
): {
  readonly outcome:
    | { readonly t: "granted"; readonly targetRevision: number }
    | { readonly t: "conflicted"; readonly error: AuthorityError };
  readonly record: MemoryPendingRecord;
} {
  if (mutation.kind !== "memory-journal-condense") {
    return planMutation(state, mutation, requestId, at);
  }
  const mutationDigest = protocolDigest("MemoryAuthorityMutation", 1, mutation);
  const replay = state.requests.get(requestId);
  if (replay) {
    return replay.mutationDigest === mutationDigest
      ? {
          outcome: { t: "granted", targetRevision: replay.revision },
          record: undefined as never,
        }
      : {
          outcome: conflict(
            "idempotency-conflict",
            "Memory request identity was reused",
          ),
          record: undefined as never,
        };
  }
  const targetKey = condenseTargetKey(mutation);
  const target = state.entries.get(targetKey);
  if (
    (target && target.digest !== mutation.targetExpectedDigest) ||
    (!target && mutation.targetExpectedDigest !== undefined)
  ) {
    return {
      outcome: conflict("revision-conflict", "Journal summary changed"),
      record: undefined as never,
    };
  }
  const sources: MemoryLogicalEntry[] = [];
  for (const source of mutation.sources) {
    const key = condenseSourceKey(mutation, source.id);
    const current = state.entries.get(key);
    if (!current) {
      return {
        outcome: conflict("not-found", "Journal source was not found"),
        record: undefined as never,
      };
    }
    if (current.digest !== source.expectedDigest) {
      return {
        outcome: conflict("revision-conflict", "Journal source changed"),
        record: undefined as never,
      };
    }
    sources.push(current);
  }
  const revision = (target?.revision ?? 0) + 1;
  const identity = {
    domain: "journal" as const,
    scope: { kind: "personal" as const },
    id: mutation.month,
    meta: {
      date: mutation.month,
      condensed: true,
      condensedFrom: sources.length,
      condensedAt: at.slice(0, 10),
    },
    content: mutation.summary,
  };
  const entry: MemoryLogicalEntry = {
    ...identity,
    revision,
    digest: memoryLogicalEntryDigest(identity),
    updatedAt: at,
  };
  return {
    outcome: { t: "granted", targetRevision: revision },
    record: {
      t: "memory-journal-condensed",
      requestId,
      mutationDigest,
      mutation: structuredClone(mutation),
      revision,
      entry,
      deletedEntryKeys: mutation.sources.map((source) =>
        condenseSourceKey(mutation, source.id)
      ),
      at,
    },
  };
}

function reduceRecord(previous: MemoryProjection, logical: LogicalRecord<MemoryAuthorityRecord>): MemoryProjection {
  const state = cloneProjection(previous);
  const record = logical.body;
  if (state.requests.has(record.requestId)) {
    throw new TypeError("Memory authority record is invalid or duplicated");
  }
  if (record.t === "memory-journal-condensed") {
    const logicalKey = entryKey(record.entry);
    state.entries.set(logicalKey, cloneEntry(record.entry));
    state.seenKeys.add(logicalKey);
    for (const sourceKey of record.deletedEntryKeys) {
      state.entries.delete(sourceKey);
      state.seenKeys.add(sourceKey);
    }
    state.requests.set(record.requestId, {
      mutationDigest: record.mutationDigest,
      revision: record.revision,
      entryKey: logicalKey,
    });
    return state;
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
      const requestKey = memoryRequestKey(record.requestId);
      if (await get(requestKey)) {
        throw new TypeError("Memory authority request was duplicated");
      }
      if (record.t === "memory-journal-condensed") {
        const logicalKey = entryKey(record.entry);
        put(memoryEntryKey(logicalKey), cloneEntry(record.entry) as unknown as JsonValue);
        put(memorySeenKey(logicalKey), true);
        for (const sourceKey of record.deletedEntryKeys) {
          tombstone(memoryEntryKey(sourceKey));
          put(memorySeenKey(sourceKey), true);
        }
        put(requestKey, {
          mutationDigest: record.mutationDigest,
          revision: record.revision,
          entryKey: logicalKey,
        });
        continue;
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
      continue;
    }
  }
  return mutations;
}

async function loadMemoryProjectionForMutations(
  projection: DurableProjectionReadContext,
  records: readonly { readonly requestId: string; readonly mutation: MemoryControlMutation }[],
  at: string,
): Promise<MemoryProjection> {
  const state = emptyProjection();
  for (const item of records) {
    const request = readMemoryRequest(
      await projection.get(memoryRequestKey(item.requestId)),
    );
    if (request) state.requests.set(item.requestId, request);
    const mutation = normalizeControlMutation(item.mutation);
    const logicalKeys = mutation.kind === "memory-journal-condense"
      ? [
          condenseTargetKey(mutation),
          ...mutation.sources.map((source) => condenseSourceKey(mutation, source.id)),
        ]
      : [plannedMutationKey(mutation, at)];
    for (const logicalKey of logicalKeys) {
      if (state.entries.has(logicalKey)) continue;
      const entry = readMemoryEntry(
        await projection.get(memoryEntryKey(logicalKey)),
      );
      if (entry) state.entries.set(logicalKey, entry);
    }
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
  return readPendingMemoryRecord(value);
}

function readPendingMemoryRecord(value: unknown): MemoryPendingRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !["memory-mutation-applied", "memory-journal-condensed"].includes(
      String((value as { t?: unknown }).t),
    )
  ) {
    throw new TypeError("Memory authority record is invalid");
  }
  const record = value as MemoryPendingRecord;
  identifier(record.requestId, "Memory authority requestId");
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(record.mutationDigest) ||
    !Number.isFinite(Date.parse(record.at))
  ) {
    throw new TypeError("Memory authority record identity is invalid");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision <= 0) {
    throw new TypeError("Memory authority revision is invalid");
  }
  normalizeControlMutation(record.mutation);
  if (record.t === "memory-journal-condensed") {
    if (
      record.entry.domain !== "journal" ||
      record.entry.scope.kind !== "personal" ||
      record.entry.id !== record.mutation.month ||
      record.entry.revision !== record.revision ||
      record.deletedEntryKeys.length !== record.mutation.sources.length ||
      record.deletedEntryKeys.some(
        (key, index) => key !== condenseSourceKey(record.mutation, record.mutation.sources[index]!.id),
      )
    ) {
      throw new TypeError("Memory journal condensation record is invalid");
    }
  }
  return structuredClone(record);
}

function requireStagedMemoryMutation(
  mutation: GlobalStagedMutation,
): StagedMemoryMutation {
  if (!isStagedMemoryMutation(mutation)) {
    throw new TypeError("Memory planner received another mutation domain");
  }
  return mutation;
}

function normalizeStagedMutation(
  mutation: StagedMemoryMutation,
  options: {
    readonly allowBlankJournal?: boolean;
    readonly allowJournalMonth?: boolean;
  } = {},
): StagedMemoryMutation {
  const normalized = structuredClone(mutation);
  const scope = memoryScopeOf(normalized);
  if (scope.kind === "workscene") identifier(scope.sceneId, "Memory workscene id");
  if (normalized.kind === "memory-delete") {
    canonicalMemoryIdentity(normalized, { allowJournalMonth: false });
  } else if (normalized.payload.domain === "journal") {
    if (!options.allowBlankJournal) {
      assertSubstantiveJournalContent(normalized.payload.content);
    }
    if (
      normalized.payload.date !== undefined &&
      !isCalendarDay(normalized.payload.date) &&
      !(options.allowJournalMonth && isCalendarMonth(normalized.payload.date))
    ) {
      throw new TypeError("Journal append date must be a real calendar day");
    }
  } else {
    canonicalMemoryIdentity(normalized.payload);
  }
  return normalized;
}

function normalizeControlMutation(
  mutation: MemoryControlMutation,
): MemoryControlMutation {
  if (mutation.kind !== "memory-journal-condense") {
    if (mutation.kind === "memory-delete" && mutation.domain === "journal") {
      const normalized = structuredClone(mutation);
      canonicalMemoryIdentity(normalized, { allowJournalMonth: true });
      return normalized;
    }
    return normalizeStagedMutation(mutation);
  }
  const normalized = structuredClone(mutation);
  if (
    normalized.scope.kind !== "personal" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/u.test(normalized.month) ||
    normalized.sources.length === 0 ||
    normalized.sources.length > 366 ||
    normalized.summary.length > 1_000_000 ||
    (normalized.targetExpectedDigest !== undefined &&
      !/^sha256:[a-f0-9]{64}$/u.test(normalized.targetExpectedDigest))
  ) {
    throw new TypeError("Memory journal condensation mutation is invalid");
  }
  assertSubstantiveJournalContent(normalized.summary);
  let previous = "";
  for (const source of normalized.sources) {
    if (
      !isCalendarDay(source.id) ||
      !source.id.startsWith(`${normalized.month}-`) ||
      source.id <= previous ||
      !/^sha256:[a-f0-9]{64}$/u.test(source.expectedDigest)
    ) {
      throw new TypeError("Memory journal condensation sources are invalid");
    }
    previous = source.id;
  }
  return normalized;
}

function mutationKey(mutation: StagedMemoryMutation): string {
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

function plannedMutationKey(mutation: StagedMemoryMutation, at: string): string {
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

function memoryScopeOf(mutation: MemoryControlMutation): MemoryScopeRef {
  return mutation.kind === "memory-delete" || mutation.kind === "memory-journal-condense"
    ? mutation.scope
    : mutation.payload.scope;
}

function condenseTargetKey(
  mutation: Extract<MemoryControlMutation, { kind: "memory-journal-condense" }>,
): string {
  return memoryLogicalIdentityKey(mutation.scope, "journal", undefined, mutation.month);
}

function condenseSourceKey(
  mutation: Extract<MemoryControlMutation, { kind: "memory-journal-condense" }>,
  id: string,
): string {
  return memoryLogicalIdentityKey(mutation.scope, "journal", undefined, id);
}

function emptyProjection(): MemoryProjection {
  return { entries: new Map(), requests: new Map(), seenKeys: new Set() };
}

function cloneProjection(source: MemoryProjection): MemoryProjection {
  return {
    entries: new Map([...source.entries].map(([key, value]) => [key, cloneEntry(value)])),
    requests: new Map([...source.requests].map(([key, value]) => [key, { ...value }])),
    seenKeys: new Set(source.seenKeys),
  };
}

function cloneEntry(entry: MemoryLogicalEntry): MemoryLogicalEntry {
  return structuredClone(entry);
}

function isStagedMemoryMutation(
  mutation: GlobalStagedMutation,
): mutation is StagedMemoryMutation {
  return mutation.kind === "memory-append" || mutation.kind === "memory-delete";
}

function isMemoryControlMutation(
  mutation: GlobalControlMutation | GlobalStagedMutation,
): mutation is MemoryControlMutation {
  return mutation.kind === "memory-append" ||
    mutation.kind === "memory-delete" ||
    mutation.kind === "memory-journal-condense";
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

export class MemoryMutationConflictError extends Error {
  constructor(readonly authorityError: AuthorityError) {
    super(authorityError.message);
    this.name = "MemoryMutationConflictError";
  }
}
