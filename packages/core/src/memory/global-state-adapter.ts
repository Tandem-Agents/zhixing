import type {
  AuthorityError,
  Digest,
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedCallContext,
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
  protocolDigest,
} from "../protocol/index.js";
import type {
  MemoryAppendPayload,
  MemoryLogicalEntry,
  MemoryScopeRef,
} from "./contracts.js";
import {
  compareMemoryLogicalEntries,
  memoryLogicalEntryDigest,
  memoryLogicalEntryKey,
  memoryLogicalEntryMatches,
  memoryLogicalIdentityKey,
  projectMemoryLogicalEntry,
} from "./logical-entry.js";
import {
  assertSafePersonId,
  assertSubstantiveJournalContent,
  canonicalMemoryIdentity,
  isCalendarDay,
  isCalendarMonth,
  isSubstantiveJournalContent,
} from "./canonical-identity.js";
import {
  LegacyMarkdownMemoryProjection,
  type LegacyMarkdownMemoryEntry,
} from "./legacy-markdown-projection.js";

const MEMORY_STREAM = "intent:memory-authority";
export const MEMORY_AUTHORITY_PROJECTION_ID = "global-memory-authority-v1";
const MEMORY_ENTRY_PREFIX = "entry:";
const MEMORY_REQUEST_PREFIX = "request:";
const MEMORY_SEEN_PREFIX = "seen:";
const MEMORY_LEGACY_CUTOVER_STARTED_KEY = "legacy-cutover-started";
const MEMORY_LEGACY_CUTOVER_KEY = "legacy-cutover";
const MEMORY_LEGACY_MAPPER_VERSION = 1;

type MemoryDeleteMutation = {
  kind: "memory-delete";
  scope: MemoryScopeRef;
  expectedDigest: Digest;
} & (
  | { domain: "memory"; category: "profile"; id: "profile" }
  | { domain: "people"; category?: never; id: string }
  | { domain: "journal"; category?: never; id: string }
);

type MemoryJournalCondenseMutation = {
  kind: "memory-journal-condense";
  scope: { kind: "personal" };
  month: string;
  targetExpectedDigest?: Digest;
  sources: Array<{ id: string; expectedDigest: Digest }>;
  summary: string;
};

type StagedMemoryMutation =
  | { kind: "memory-append"; payload: MemoryAppendPayload }
  | MemoryDeleteMutation;

type MemoryControlMutation = StagedMemoryMutation | MemoryJournalCondenseMutation;

type MemoryQuery =
  | {
      kind: "memory-search";
      scope: MemoryScopeRef;
      domain: "memory" | "journal" | "people";
      query: string;
      limit: number;
    }
  | ({ kind: "memory-list"; scope: MemoryScopeRef } & (
      | { domain: "memory"; category: "profile" }
      | { domain: "journal" | "people"; category?: never }
    ))
  | { kind: "memory-stats"; scope: MemoryScopeRef; domain: "journal" | "people" };

type MemoryReadResult =
  | { kind: "memory-search"; hits: Array<{ entry: MemoryLogicalEntry; score?: number }> }
  | { kind: "memory-list"; entries: MemoryLogicalEntry[] }
  | {
      kind: "memory-stats";
      domain: "journal" | "people";
      count: number;
      lastWriteAt?: string;
    };

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

type MemoryLegacyCutoverBoundary = {
  readonly cutoverId: string;
  readonly mapperVersion: number;
  readonly scopeSetDigest: string;
  readonly sourceSetDigest: string;
  readonly importPlanDigest: string;
  readonly sourceCount: number;
  readonly targetCount: number;
  readonly at: string;
};

type MemoryLegacyCutoverStartedRecord = MemoryLegacyCutoverBoundary & {
  readonly t: "memory-legacy-cutover-started";
};

type MemoryLegacyCutoverRecord = MemoryLegacyCutoverBoundary & {
  readonly t: "memory-legacy-cutover";
};

type MemoryAuthorityRecord =
  | MemoryMutationAppliedRecord
  | MemoryJournalCondensedRecord
  | MemoryLegacyCutoverStartedRecord
  | MemoryLegacyCutoverRecord;

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
  readonly legacyCutoverStarted?: MemoryLegacyCutoverStartedRecord;
  readonly legacyCutover?: MemoryLegacyCutoverRecord;
}

export interface AnchorMemoryGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly anchorEpoch: number;
  readonly scopeRoot: (scope: MemoryScopeRef) => string;
  readonly clock?: () => string;
}

/** Anchor-owned logical memory authority. */
export class AnchorMemoryGlobalStateAdapter {
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
      reducerVersion: 4,
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

  ownsStagedMutation(mutation: unknown): mutation is StagedMemoryMutation {
    return isStagedMemoryMutation(mutation);
  }

  async prepareStagedMutations(input: {
    readonly records: ReadonlyArray<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: StagedMemoryMutation;
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
    readonly mutation: StagedMemoryMutation;
    readonly targetRevision: number;
  }): Promise<void> {
    if (!isStagedMemoryMutation(input.mutation)) {
      throw new TypeError("Memory authority received another mutation domain");
    }
    await this.#assertCommittedMutation(input.requestId, input.targetRevision);
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly requestId: string;
    readonly mutation: StagedMemoryMutation;
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

  async read(query: MemoryQuery, context: GlobalReadCallContext): Promise<MemoryReadResult> {
    const normalizedQuery = structuredClone(query);
    this.#admit(context, "global.read");
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

  mutate<M extends MemoryControlMutation>(
    mutation: M,
    context: GlobalControlCallContext,
  ): Promise<{ revision: number }>;
  mutate<M extends StagedMemoryMutation>(
    mutation: M,
    context: GlobalStagedCallContext,
  ): Promise<{ revision: number }>;
  async mutate(
    mutation: MemoryControlMutation,
    context: GlobalControlCallContext | GlobalStagedCallContext,
  ): Promise<{ revision: number }> {
    const memoryMutation = mutation;
    this.#admit(context, "global.mutate");
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

  async #takeOverLegacyMemory(scopes: readonly MemoryScopeRef[]): Promise<void> {
    const existing = await this.#log.transactDurableProjection<
      MemoryAuthorityRecord,
      {
        readonly started?: MemoryLegacyCutoverStartedRecord;
        readonly terminal?: MemoryLegacyCutoverRecord;
      }
    >(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection) => {
        const started = readLegacyCutoverStarted(
          await projection.get(MEMORY_LEGACY_CUTOVER_STARTED_KEY),
        );
        const terminal = readLegacyCutover(
          await projection.get(MEMORY_LEGACY_CUTOVER_KEY),
        );
        return {
          kind: "return",
          value: {
            ...(started ? { started } : {}),
            ...(terminal ? { terminal } : {}),
          },
        };
      },
    );
    if (existing.value.terminal) return;

    const normalizedScopes = normalizeLegacyScopes(scopes);
    const plan = await buildLegacyMemoryImportPlan(
      normalizedScopes,
      this.#scopeRoot,
    );
    const startedResult = await this.#log.transactDurableProjection<
      MemoryAuthorityRecord,
      MemoryLegacyCutoverStartedRecord | MemoryLegacyCutoverRecord
    >(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection, context) => {
        const terminal = readLegacyCutover(
          await projection.get(MEMORY_LEGACY_CUTOVER_KEY),
        );
        if (terminal) return { kind: "return", value: terminal };
        const current = readLegacyCutoverStarted(
          await projection.get(MEMORY_LEGACY_CUTOVER_STARTED_KEY),
        );
        if (current) {
          assertLegacyPlanMatchesBoundary(plan, current);
          return { kind: "return", value: current };
        }
        const started: MemoryLegacyCutoverStartedRecord = {
          t: "memory-legacy-cutover-started",
          ...legacyBoundaryFromPlan(plan, context.at),
        };
        return {
          kind: "append",
          entries: [{ stream: MEMORY_STREAM, body: started }],
          value: started,
        };
      },
    );
    if (startedResult.value.t === "memory-legacy-cutover") return;
    const started = startedResult.value;

    for (const source of plan.sources) {
      await this.#importLegacySource(started.cutoverId, source);
    }

    const verifiedPlan = await buildLegacyMemoryImportPlan(
      normalizedScopes,
      this.#scopeRoot,
    );
    assertLegacyPlanMatchesBoundary(verifiedPlan, started);
    await this.#log.transactDurableProjection<MemoryAuthorityRecord, void>(
      MEMORY_AUTHORITY_PROJECTION_ID,
      async (projection, context) => {
        const current = readLegacyCutover(
          await projection.get(MEMORY_LEGACY_CUTOVER_KEY),
        );
        if (current) {
          assertSameLegacyBoundary(started, current);
          return { kind: "return", value: undefined };
        }
        const durableStarted = readLegacyCutoverStarted(
          await projection.get(MEMORY_LEGACY_CUTOVER_STARTED_KEY),
        );
        if (!durableStarted) {
          throw new Error("Legacy memory cutover lost its started boundary");
        }
        assertSameLegacyBoundary(started, durableStarted);
        for (const source of plan.sources) {
          const logicalKey = entryKey(source.entry);
          const requestId = legacyImportRequestId(started.cutoverId, logicalKey);
          const request = readMemoryRequest(
            await projection.get(memoryRequestKey(requestId)),
          );
          if (request) {
            if (
              request.entryKey !== logicalKey ||
              request.mutationDigest !== legacyImportMutationDigest(
                started.cutoverId,
                source,
              )
            ) {
              throw new Error(
                "Legacy memory import does not match its frozen plan",
              );
            }
            continue;
          }
          if (!(await projection.get(memorySeenKey(logicalKey)))) {
            throw new Error("Legacy memory import plan is incomplete");
          }
        }
        return {
          kind: "append",
          entries: [
            {
              stream: MEMORY_STREAM,
              body: {
                t: "memory-legacy-cutover",
                ...legacyBoundaryFromPlan(plan, context.at),
              },
            },
          ],
          value: undefined,
        };
      },
    );
    await this.#reload();
  }

  async #importLegacySource(
    cutoverId: string,
    source: LegacyMemorySource,
  ): Promise<void> {
    const logicalKey = entryKey(source.entry);
    const requestId = legacyImportRequestId(cutoverId, logicalKey);
    const mutationDigest = legacyImportMutationDigest(cutoverId, source);
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
          entries: [
            {
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
            },
          ],
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
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (context.authority.domain !== "global" || context.authority.anchorEpoch !== this.#anchorEpoch) {
      throw new TypeError("Global memory authority fence is stale or invalid");
    }
    if (!context.requestId || Date.parse(context.deadlineAt) < Date.parse(this.#clock())) {
      throw new TypeError("Global memory request identity or deadline is invalid");
    }
  }
}

function scopeKey(scope: MemoryScopeRef): string {
  return scope.kind === "personal" ? "personal" : `workscene:${scope.sceneId}`;
}

interface LegacyMemorySource {
  readonly entry: MemoryLogicalEntry;
  readonly mutation: StagedMemoryMutation;
  readonly sourceIdentities: readonly string[];
}

interface LegacyMemoryPhysicalSource {
  readonly scope: MemoryScopeRef;
  readonly category: "profile" | "person" | "journal";
  readonly sourceIdentity: string;
  readonly originalId: string;
  readonly modifiedAt: string;
  readonly payloadDigest: string;
}

interface LegacyMemoryImportPlan {
  readonly sources: readonly LegacyMemorySource[];
  readonly scopeSetDigest: string;
  readonly sourceSetDigest: string;
  readonly importPlanDigest: string;
  readonly sourceCount: number;
  readonly targetCount: number;
  readonly cutoverId: string;
}

interface LegacyMemoryFragment {
  readonly scope: MemoryScopeRef;
  readonly domain: "memory" | "people" | "journal";
  readonly id: string;
  readonly originalId: string;
  readonly sourceIdentity: string;
  readonly modifiedAt: string;
  readonly meta: Record<string, JsonValue>;
  readonly content: string;
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

async function buildLegacyMemoryImportPlan(
  scopes: readonly MemoryScopeRef[],
  scopeRoot: (scope: MemoryScopeRef) => string,
): Promise<LegacyMemoryImportPlan> {
  const manifest: LegacyMemoryPhysicalSource[] = [];
  const fragments = new Map<string, LegacyMemoryFragment[]>();
  for (const scope of scopes) {
    const projection = new LegacyMarkdownMemoryProjection(scopeRoot(scope));
    const entries = (await projection.readAuthorityTakeoverSnapshot()).sort(
      (left, right) =>
        left.sourceIdentity.localeCompare(right.sourceIdentity, "en-US"),
    );
    for (const disk of entries) {
      const sourceIdentity = `${scopeKey(scope)}\0${disk.sourceIdentity}`;
      const payloadDigest = protocolDigest("MemoryLegacyPhysicalSource", 1, {
        category: disk.category,
        originalId: disk.id,
        meta: toJsonObject(disk.meta),
        content: disk.content,
      });
      manifest.push({
        scope: cloneScope(scope),
        category: disk.category,
        sourceIdentity,
        originalId: disk.id,
        modifiedAt: disk.modifiedAt,
        payloadDigest,
      });
      const fragment = mapLegacyMemoryFragment(scope, disk, sourceIdentity);
      const logicalKey = memoryLogicalIdentityKey(
        fragment.scope,
        fragment.domain,
        fragment.domain === "memory" ? "profile" : undefined,
        fragment.id,
      );
      const group = fragments.get(logicalKey) ?? [];
      group.push(fragment);
      fragments.set(logicalKey, group);
    }
  }
  manifest.sort((left, right) =>
    left.sourceIdentity.localeCompare(right.sourceIdentity, "en-US")
  );
  const sources = [...fragments.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, group]) => legacyMemorySource(group));
  const scopeSetDigest = protocolDigest("MemoryLegacyScopeSet", 2, scopes);
  const sourceSetDigest = protocolDigest("MemoryLegacySourceSet", 2, manifest);
  const importPlanDigest = protocolDigest(
    "MemoryLegacyImportPlan",
    MEMORY_LEGACY_MAPPER_VERSION,
    sources.map((source) => ({
      logicalKey: entryKey(source.entry),
      entryDigest: source.entry.digest,
      sourceIdentities: source.sourceIdentities,
    })),
  );
  const boundary = {
    mapperVersion: MEMORY_LEGACY_MAPPER_VERSION,
    scopeSetDigest,
    sourceSetDigest,
    importPlanDigest,
    sourceCount: manifest.length,
    targetCount: sources.length,
  };
  return {
    sources,
    ...boundary,
    cutoverId: protocolDigest("MemoryLegacyCutoverGeneration", 1, boundary),
  };
}

function mapLegacyMemoryFragment(
  scope: MemoryScopeRef,
  disk: LegacyMarkdownMemoryEntry,
  sourceIdentity: string,
): LegacyMemoryFragment {
  const domain =
    disk.category === "person"
      ? "people"
      : disk.category === "journal"
        ? "journal"
        : "memory";
  const id =
    domain === "memory"
      ? "profile"
      : domain === "people"
        ? legacyPersonId(scope, disk, sourceIdentity)
        : legacyJournalId(disk);
  return {
    scope: cloneScope(scope),
    domain,
    id,
    originalId: disk.id,
    sourceIdentity,
    modifiedAt: disk.modifiedAt,
    meta: toJsonObject(disk.meta),
    content: disk.content,
  };
}

function legacyMemorySource(
  input: readonly LegacyMemoryFragment[],
): LegacyMemorySource {
  const fragments = [...input].sort((left, right) =>
    left.sourceIdentity.localeCompare(right.sourceIdentity, "en-US")
  );
  const first = fragments[0];
  if (!first) throw new Error("Legacy memory import target has no source");
  if (
    fragments.some(
      (fragment) =>
        scopeKey(fragment.scope) !== scopeKey(first.scope) ||
        fragment.domain !== first.domain ||
        fragment.id !== first.id,
    )
  ) {
    throw new Error("Legacy memory import target is inconsistent");
  }
  if (first.domain === "memory" && fragments.length !== 1) {
    throw new Error("Legacy profile contains duplicate physical sources");
  }
  const trace = fragments.map((fragment) => ({
    sourceIdentity: fragment.sourceIdentity,
    originalId: fragment.originalId,
    modifiedAt: fragment.modifiedAt,
    meta: fragment.meta,
    contentLength: fragment.content.length,
    contentDigest: protocolDigest(
      "MemoryLegacySourceContent",
      1,
      fragment.content,
    ),
  }));
  const legacySourceManifest = JSON.stringify(trace);
  const meta =
    first.domain === "memory"
      ? first.meta
      : first.domain === "people"
        ? { ...first.meta, legacySourceManifest }
        : {
            date: first.id,
            ...(isCalendarMonth(first.id) ? { condensed: true } : {}),
            legacySourceManifest,
          };
  const content =
    first.domain === "journal" &&
      fragments.every((fragment) =>
        !isSubstantiveJournalContent(fragment.content)
      )
      ? ""
      : fragments.map((fragment) => fragment.content).join("\n\n---\n\n");
  const identity = {
    domain: first.domain,
    scope: cloneScope(first.scope),
    ...(first.domain === "memory" ? { category: "profile" as const } : {}),
    id: first.id,
    meta,
    content,
  };
  const entry: MemoryLogicalEntry = {
    ...identity,
    revision: 1,
    digest: memoryLogicalEntryDigest(identity),
  } as MemoryLogicalEntry;
  const mutation = {
    kind: "memory-append",
    payload:
      first.domain === "memory"
        ? {
            domain: first.domain,
            scope: cloneScope(first.scope),
            category: "profile",
            id: "profile",
            meta,
            content,
          }
        : first.domain === "people"
          ? {
              domain: first.domain,
              scope: cloneScope(first.scope),
              id: first.id,
              meta,
              content,
            }
          : {
              domain: first.domain,
              scope: cloneScope(first.scope),
              date: first.id,
              content,
            },
  } as StagedMemoryMutation;
  return {
    entry,
    mutation,
    sourceIdentities: fragments.map((fragment) => fragment.sourceIdentity),
  };
}

function legacyPersonId(
  scope: MemoryScopeRef,
  disk: LegacyMarkdownMemoryEntry,
  sourceIdentity: string,
): string {
  try {
    return assertSafePersonId(disk.id);
  } catch {
    return `legacy-${protocolDigest("MemoryLegacyPersonIdentity", 1, {
      scope: cloneScope(scope),
      sourceIdentity,
    }).slice("sha256:".length, "sha256:".length + 40)}`;
  }
}

function legacyJournalId(disk: LegacyMarkdownMemoryEntry): string {
  const condensed = disk.meta.condensed === true;
  if (
    (!condensed && isCalendarDay(disk.id)) ||
    (condensed && isCalendarMonth(disk.id))
  ) {
    return disk.id;
  }
  const frontmatterDate = disk.meta.date;
  if (
    typeof frontmatterDate === "string" &&
    ((!condensed && isCalendarDay(frontmatterDate)) ||
      (condensed && isCalendarMonth(frontmatterDate)))
  ) {
    return frontmatterDate;
  }
  return disk.modifiedAt.slice(0, 10);
}

function legacyBoundaryFromPlan(
  plan: LegacyMemoryImportPlan,
  at: string,
): MemoryLegacyCutoverBoundary {
  return {
    cutoverId: plan.cutoverId,
    mapperVersion: MEMORY_LEGACY_MAPPER_VERSION,
    scopeSetDigest: plan.scopeSetDigest,
    sourceSetDigest: plan.sourceSetDigest,
    importPlanDigest: plan.importPlanDigest,
    sourceCount: plan.sourceCount,
    targetCount: plan.targetCount,
    at,
  };
}

function assertLegacyPlanMatchesBoundary(
  plan: LegacyMemoryImportPlan,
  boundary: MemoryLegacyCutoverBoundary,
): void {
  if (
    plan.cutoverId !== boundary.cutoverId ||
    plan.scopeSetDigest !== boundary.scopeSetDigest ||
    plan.sourceSetDigest !== boundary.sourceSetDigest ||
    plan.importPlanDigest !== boundary.importPlanDigest ||
    plan.sourceCount !== boundary.sourceCount ||
    plan.targetCount !== boundary.targetCount ||
    boundary.mapperVersion !== MEMORY_LEGACY_MAPPER_VERSION
  ) {
    throw new Error("Legacy memory sources changed after cutover started");
  }
}

function assertSameLegacyBoundary(
  expected: MemoryLegacyCutoverBoundary,
  actual: MemoryLegacyCutoverBoundary,
): void {
  assertLegacyPlanMatchesBoundary(
    {
      sources: [],
      cutoverId: expected.cutoverId,
      scopeSetDigest: expected.scopeSetDigest,
      sourceSetDigest: expected.sourceSetDigest,
      importPlanDigest: expected.importPlanDigest,
      sourceCount: expected.sourceCount,
      targetCount: expected.targetCount,
    },
    actual,
  );
}

function legacyImportRequestId(cutoverId: string, logicalKey: string): string {
  return `memory-legacy-import:${protocolDigest(
    "MemoryLegacyImportRequest",
    2,
    { cutoverId, logicalKey },
  ).slice("sha256:".length)}`;
}

function legacyImportMutationDigest(
  cutoverId: string,
  source: LegacyMemorySource,
): string {
  return protocolDigest("MemoryLegacyImport", 2, {
    cutoverId,
    logicalKey: entryKey(source.entry),
    sourceIdentities: source.sourceIdentities,
    entry: source.entry,
  });
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
  if (record.t === "memory-legacy-cutover-started") {
    if (state.legacyCutoverStarted || state.legacyCutover) {
      throw new TypeError("Memory legacy cutover start was duplicated");
    }
    return { ...state, legacyCutoverStarted: structuredClone(record) };
  }
  if (record.t === "memory-legacy-cutover") {
    if (!state.legacyCutoverStarted || state.legacyCutover) {
      throw new TypeError("Memory legacy cutover was duplicated");
    }
    assertSameLegacyBoundary(state.legacyCutoverStarted, record);
    return { ...state, legacyCutover: structuredClone(record) };
  }
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
      if (record.t === "memory-legacy-cutover-started") {
        if (
          (await get(MEMORY_LEGACY_CUTOVER_STARTED_KEY)) ||
          (await get(MEMORY_LEGACY_CUTOVER_KEY))
        ) {
          throw new TypeError("Memory legacy cutover start was duplicated");
        }
        put(
          MEMORY_LEGACY_CUTOVER_STARTED_KEY,
          structuredClone(record) as unknown as JsonValue,
        );
        continue;
      }
      if (record.t === "memory-legacy-cutover") {
        if (await get(MEMORY_LEGACY_CUTOVER_KEY)) {
          throw new TypeError("Memory legacy cutover was duplicated");
        }
        const started = readLegacyCutoverStarted(
          await get(MEMORY_LEGACY_CUTOVER_STARTED_KEY),
        );
        if (!started) {
          throw new TypeError(
            "Memory legacy cutover terminal has no started boundary",
          );
        }
        assertSameLegacyBoundary(started, record);
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
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly t?: unknown }).t === "memory-legacy-cutover-started"
  ) {
    const started = readLegacyCutoverStarted(value);
    if (!started) {
      throw new TypeError("Memory legacy cutover started record is invalid");
    }
    return started;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly t?: unknown }).t === "memory-legacy-cutover"
  ) {
    const cutover = readLegacyCutover(value);
    if (!cutover) {
      throw new TypeError("Memory legacy cutover record is invalid");
    }
    return cutover;
  }
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
  if (
    record.t === "memory-mutation-applied" &&
    record.requestId.startsWith("memory-legacy-import:")
  ) {
    normalizeStagedMutation(record.mutation, {
      allowBlankJournal: true,
      allowJournalMonth: true,
    });
  } else {
    normalizeControlMutation(record.mutation);
  }
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

function readLegacyCutover(
  value: JsonValue | undefined | unknown,
): MemoryLegacyCutoverRecord | undefined {
  return readLegacyBoundary(value, "memory-legacy-cutover");
}

function readLegacyCutoverStarted(
  value: JsonValue | undefined | unknown,
): MemoryLegacyCutoverStartedRecord | undefined {
  return readLegacyBoundary(value, "memory-legacy-cutover-started");
}

function readLegacyBoundary<
  T extends
    | MemoryLegacyCutoverRecord["t"]
    | MemoryLegacyCutoverStartedRecord["t"],
>(
  value: JsonValue | undefined | unknown,
  type: T,
):
  | (T extends "memory-legacy-cutover"
      ? MemoryLegacyCutoverRecord
      : MemoryLegacyCutoverStartedRecord)
  | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "at,cutoverId,importPlanDigest,mapperVersion,scopeSetDigest,sourceCount,sourceSetDigest,t,targetCount" ||
    (value as { readonly t?: unknown }).t !== type
  ) {
    throw new TypeError("Memory legacy cutover record is invalid");
  }
  const record = value as MemoryLegacyCutoverBoundary & { readonly t: T };
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(record.cutoverId) ||
    record.mapperVersion !== MEMORY_LEGACY_MAPPER_VERSION ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.scopeSetDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.sourceSetDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.importPlanDigest) ||
    !Number.isSafeInteger(record.sourceCount) ||
    record.sourceCount < 0 ||
    !Number.isSafeInteger(record.targetCount) ||
    record.targetCount < 0 ||
    !Number.isFinite(Date.parse(record.at))
  ) {
    throw new TypeError("Memory legacy cutover record is invalid");
  }
  return structuredClone(record) as never;
}

function requireStagedMemoryMutation(
  mutation: unknown,
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
    ...(source.legacyCutoverStarted
      ? { legacyCutoverStarted: structuredClone(source.legacyCutoverStarted) }
      : {}),
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

function isStagedMemoryMutation(
  mutation: unknown,
): mutation is StagedMemoryMutation {
  return typeof mutation === "object" && mutation !== null &&
    ("kind" in mutation) &&
    ((mutation as { kind?: unknown }).kind === "memory-append" ||
      (mutation as { kind?: unknown }).kind === "memory-delete");
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
