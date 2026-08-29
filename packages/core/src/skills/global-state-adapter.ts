import type {
  ArtifactRef,
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
  SkillWriteMutation,
} from "../contracts/index.js";
import type {
  ArtifactStore,
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
import { skillNameToId } from "./id.js";
import { SkillStore } from "./store.js";
import type { SkillCatalogEntry } from "./types.js";

const SKILL_STREAM = "intent:skill-authority";
export const SKILL_AUTHORITY_PROJECTION_ID = "global-skill-authority-v1";
const SKILL_ENTRY_PREFIX = "entry:";
const SKILL_REQUEST_PREFIX = "request:";
const SKILL_PENDING_PREFIX = "pending:";
const SKILL_META_KEY = "meta:catalog-revision";
const SKILL_MATERIALIZATION_STREAM = "intent:skill-materialization";

type SkillMutation =
  | Extract<
      GlobalStagedMutation,
      { kind: "skill-create" | "skill-update" | "skill-admit" | "skill-usage" }
    >
  | Extract<GlobalControlMutation, { kind: "skill-set-state" | "skill-archive" }>;

type SkillAuthorityRecord = {
  readonly t: "skill-mutation-applied";
  readonly requestId: string;
  readonly mutationDigest: string;
  readonly mutation: SkillMutation;
  readonly targetRevision: number;
  readonly catalogRevision: number;
  readonly entry?: SkillCatalogEntry;
  readonly removedId?: string;
  readonly at: string;
};

type SkillMaterializationRecord = {
  readonly t: "skill-materialized";
  readonly requestId: string;
  readonly targetRevision: number;
};

interface SkillProjection {
  readonly catalogRevision: number;
  readonly entries: Map<string, SkillCatalogEntry>;
  readonly requests: Map<
    string,
    { readonly mutationDigest: string; readonly targetRevision: number }
  >;
}

export interface AnchorSkillGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly store: SkillStore;
  readonly anchorEpoch: number;
  readonly clock?: () => string;
}

/** Anchor-owned skill catalog and the sole user-skill filesystem materializer. */
export class AnchorSkillGlobalStateAdapter implements GlobalStatePort {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #store: SkillStore;
  readonly #anchorEpoch: number;
  readonly #clock: () => string;
  readonly #durable: RebuildableDurableProjectionIndex;
  #projection: SkillProjection = emptyProjection();
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorSkillGlobalStateAdapterOptions) {
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#store = options.store;
    this.#anchorEpoch = positiveInteger(options.anchorEpoch, "Skill anchor epoch");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#durable = this.#log.durableProjection({
      projectionId: SKILL_AUTHORITY_PROJECTION_ID,
      reducerVersion: 1,
      reduce: reduceSkillDurableProjection,
    });
  }

  readonly stagedProjectionId = SKILL_AUTHORITY_PROJECTION_ID;

  async initializeStagedPublishing(): Promise<void> {
    await this.#ensureOpen();
    await this.#importLegacyCatalog();
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isStagedSkillMutation(mutation);
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
    let overlay = await loadSkillProjectionForMutations(
      input.authorityProjection,
      input.records.map((record) => ({
        requestId: record.requestId,
        mutation: requireStagedSkillMutation(record.mutation),
      })),
    );
    const records: LogicalRecord[] = [];
    const outcomes = new Map<
      number,
      | { readonly t: "granted"; readonly targetRevision: number }
      | { readonly t: "conflicted"; readonly error: AuthorityError }
    >();
    for (const item of input.records) {
      const planned = planMutation(
        overlay,
        structuredClone(requireStagedSkillMutation(item.mutation)),
        item.requestId,
        input.at,
      );
      outcomes.set(item.seq, planned.outcome);
      if (!planned.record) continue;
      const logical: LogicalRecord<SkillAuthorityRecord> = {
        stream: SKILL_STREAM,
        body: planned.record,
      };
      overlay = reduceRecord(overlay, logical);
      records.push(logical as unknown as LogicalRecord<JsonValue>);
    }
    return { records, outcomes };
  }

  async applyStagedMutation(input: {
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
    readonly targetRevision: number;
  }): Promise<void> {
    if (!isStagedSkillMutation(input.mutation)) {
      throw new TypeError("Skill materializer received another mutation domain");
    }
    await this.#materializePending(input.requestId, input.targetRevision);
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    if (records.length === 0) {
      await this.#log.transactDurableProjection(
        SKILL_AUTHORITY_PROJECTION_ID,
        () => ({ kind: "return", value: undefined }),
      );
      let continuation: string | undefined;
      do {
        const page = await this.#durable.scan(
          { gte: SKILL_PENDING_PREFIX, lt: `${SKILL_PENDING_PREFIX}\uffff` },
          128,
          continuation,
        );
        for (const entry of page.entries) {
          await this.#materializePending(entry.key.slice(SKILL_PENDING_PREFIX.length));
        }
        continuation = page.continuation;
      } while (continuation !== undefined);
      return;
    }
    for (const record of records) {
      if (isStagedSkillMutation(record.mutation)) {
        await this.#materializePending(record.requestId);
      }
    }
  }

  async read(
    query: GlobalQuery,
    context: GlobalReadCallContext,
  ): Promise<GlobalReadResult> {
    if (!isSkillQuery(query)) {
      throw new TypeError("This global state adapter only owns the skill domain");
    }
    this.#admit(context, "global.read");
    await this.#ensureOpen();
    const projection = await readSkillProjection(this.#durable);
    if (query.kind === "skill-get") {
      return {
        kind: "skill-get",
        catalogRevision: projection.catalogRevision,
        entry: cloneEntry(projection.entries.get(query.skillId) ?? null),
      };
    }
    if (query.kind === "asset-index") {
      return {
        kind: "asset-index",
        entries: [...projection.entries.values()].map((entry) => ({
          id: entry.id,
          kind: "skills" as const,
          revision: entry.revision,
          digest: entry.digest,
        })),
      };
    }
    let entries = [...projection.entries.values()];
    if (!query.includeDisabled) entries = entries.filter((entry) => !entry.disabled);
    if (query.mode) entries = entries.filter((entry) => entry.mode === query.mode);
    entries.sort(compareEntries);
    if (query.limit !== undefined) entries = entries.slice(0, query.limit);
    return {
      kind: "skill-catalog",
      catalogRevision: projection.catalogRevision,
      entries: entries.map((entry) => cloneEntry(entry)!),
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
    if (!isSkillMutation(mutation)) {
      throw new TypeError("This global state adapter only owns the skill domain");
    }
    if (context.principal.kind === "assignment") {
      throw new AuthorityMethodForbiddenError(
        "Assignment skill mutations must be staged by the assignment owner",
      );
    }
    this.#admit(context, "global.mutate");
    await this.#ensureOpen();
    const transaction = await this.#log.transactProjection<
      SkillProjection,
      SkillAuthorityRecord,
      { revision: number; catalogRevision: number }
    >(
      this.#projection,
      reduceRecord,
      async (_state, transactionContext) => {
        const state = await loadSkillProjectionForMutations(
          transactionContext.readProjection(SKILL_AUTHORITY_PROJECTION_ID),
          [{ requestId: context.requestId, mutation }],
        );
        const planned = planMutation(
          state,
          structuredClone(mutation),
          context.requestId,
          transactionContext.at,
        );
        if (planned.outcome.t === "conflicted") {
          throw new SkillMutationConflictError(planned.outcome.error);
        }
        if (!planned.record) throw new Error("Skill mutation plan has no record");
        return {
          kind: "append",
          entries: [{ stream: SKILL_STREAM, body: planned.record }],
          value: {
            revision: planned.outcome.targetRevision,
            catalogRevision: planned.record.catalogRevision,
          },
        };
      },
      {
        cursor: this.#cursor,
        stream: SKILL_STREAM,
        readProjectionIds: [SKILL_AUTHORITY_PROJECTION_ID],
        candidateReferences: skillCandidateReferences(
          this.#projection,
          mutation,
        ),
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
    const pending = await this.#durable.get(skillPendingKey(requestId));
    if (pending === undefined) {
      const replay = readSkillRequest(
        await this.#durable.get(skillRequestKey(requestId)),
      );
      if (
        !replay ||
        (expectedRevision !== undefined && replay.targetRevision !== expectedRevision)
      ) {
        throw new CommittedMutationMaterializationError(
          "Committed skill mutation is unavailable or changed",
        );
      }
      return;
    }
    const record = readPendingSkillRecord(pending);
    if (
      expectedRevision !== undefined &&
      record.targetRevision !== expectedRevision
    ) {
      throw new CommittedMutationMaterializationError(
        "Committed skill mutation is unavailable or changed",
      );
    }
    const mutation = record.mutation;
    const skillId = mutationSkillId(mutation);
    if (mutation.kind === "skill-archive") {
      await this.#store.materializeArchive(skillId);
    } else {
      const entry = readSkillEntry(
        await this.#durable.get(skillEntryKey(skillId)),
      );
      if (!entry) {
        throw new CommittedMutationMaterializationError(
          "Committed skill entry is absent from its projection",
        );
      }
      if (mutation.kind === "skill-usage" || mutation.kind === "skill-set-state") {
        await this.#store.materializeUsage(entry.id, entry.usage);
        if (mutation.kind === "skill-set-state") {
          const document = Buffer.from(await this.#artifacts.get(entry.contentRef)).toString("utf8");
          await this.#store.materializeAuthority(entry, document);
        }
      } else {
        if (mutation.kind === "skill-update" && mutation.skillId !== entry.id) {
          await this.#store.materializeArchive(mutation.skillId);
        }
        const document = Buffer.from(await this.#artifacts.get(entry.contentRef)).toString("utf8");
        await this.#store.materializeAuthority(entry, document);
      }
    }
    await this.#log.transactDurableProjection<SkillMaterializationRecord, void>(
      SKILL_AUTHORITY_PROJECTION_ID,
      async (projection) => {
        const current = await projection.get(skillPendingKey(requestId));
        if (current === undefined) return { kind: "return", value: undefined };
        const currentRecord = readPendingSkillRecord(current);
        if (currentRecord.targetRevision !== record.targetRevision) {
          throw new CommittedMutationMaterializationError(
            "Skill materialization target changed",
          );
        }
        return {
          kind: "append",
          entries: [{
            stream: SKILL_MATERIALIZATION_STREAM,
            body: {
              t: "skill-materialized",
              requestId,
              targetRevision: record.targetRevision,
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
    const snapshot = await this.#log.readSnapshot<SkillAuthorityRecord>();
    let state = emptyProjection();
    for (const commit of snapshot.commits) {
      for (const entry of commit.entries) {
        if (entry.stream === SKILL_STREAM) {
          state = reduceRecord(state, entry as LogicalRecord<SkillAuthorityRecord>);
        }
      }
    }
    this.#projection = state;
    this.#cursor = snapshot.cursor;
  }

  async #importLegacyCatalog(): Promise<void> {
    for (const legacy of await this.#store.listForManagement()) {
      if (this.#projection.entries.has(legacy.id)) continue;
      const contentRef = await this.#artifacts.put(
        Buffer.from(await this.#store.readDocument(legacy.id), "utf8"),
      );
      const at = this.#clock();
      const entry = withDigest({
        id: legacy.id,
        name: legacy.name,
        description: legacy.description,
        source: legacy.source,
        mode: legacy.mode,
        pinned: legacy.pinned,
        disabled: legacy.disabled,
        createdAt: legacy.createdAt,
        usage: legacy.usage ? { ...legacy.usage } : null,
        contentRef,
        revision: 1,
      });
      const mutation: SkillMutation = legacy.source === "linked"
        ? { kind: "skill-admit", mode: legacy.mode, record: skillRecord(entry) }
        : { kind: "skill-create", mode: legacy.mode, record: skillRecord(entry) };
      const requestId = `skill-legacy:${legacy.id}:${contentRef.digest}`;
      const record: SkillAuthorityRecord = {
        t: "skill-mutation-applied",
        requestId,
        mutationDigest: mutationDigest(mutation),
        mutation,
        targetRevision: 1,
        catalogRevision: this.#projection.catalogRevision + 1,
        entry,
        at,
      };
      const transaction = await this.#log.transactProjection<
        SkillProjection,
        SkillAuthorityRecord,
        void
      >(
        this.#projection,
        reduceRecord,
        () => ({
          kind: "append",
          entries: [{ stream: SKILL_STREAM, body: record }],
          value: undefined,
        }),
        {
          cursor: this.#cursor,
          stream: SKILL_STREAM,
          candidateReferences: [contentRef],
        },
      );
      this.#projection = transaction.state;
      this.#cursor = transaction.cursor;
    }
  }

  #admit(
    context: GlobalReadCallContext | GlobalControlCallContext | GlobalStagedCallContext,
    method: "global.read" | "global.mutate",
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (
      context.authority.domain !== "global" ||
      context.authority.anchorEpoch !== this.#anchorEpoch
    ) {
      throw new TypeError("Global skill authority fence is stale or invalid");
    }
    if (!context.requestId || Date.parse(context.deadlineAt) < Date.parse(this.#clock())) {
      throw new TypeError("Global skill request identity or deadline is invalid");
    }
  }
}

export class SkillMutationConflictError extends Error {
  constructor(readonly authorityError: AuthorityError) {
    super(authorityError.message);
    this.name = "SkillMutationConflictError";
  }
}

function planMutation(
  source: SkillProjection,
  mutation: SkillMutation,
  requestId: string,
  at: string,
): {
  readonly outcome:
    | { readonly t: "granted"; readonly targetRevision: number }
    | { readonly t: "conflicted"; readonly error: AuthorityError };
  readonly record?: SkillAuthorityRecord;
} {
  const state = cloneProjection(source);
  const digest = mutationDigest(mutation);
  const replay = state.requests.get(requestId);
  if (replay) {
    return replay.mutationDigest === digest
      ? { outcome: { t: "granted", targetRevision: replay.targetRevision } }
      : { outcome: conflict("idempotency-conflict", "Skill request identity was reused") };
  }
  let entry: SkillCatalogEntry | undefined;
  let removedId: string | undefined;
  if (mutation.kind === "skill-create" || mutation.kind === "skill-admit") {
    const id = requireSkillId(mutation.record.name);
    if (state.entries.has(id)) {
      return { outcome: conflict("revision-conflict", "Skill id already exists") };
    }
    entry = withDigest({
      id,
      name: mutation.record.name,
      description: mutation.record.description,
      source: mutation.kind === "skill-admit" ? "linked" : "own",
      mode: mutation.mode,
      pinned: false,
      disabled: false,
      createdAt: at,
      usage: null,
      contentRef: cloneRef(mutation.record.content),
      revision: 1,
    });
  } else if (mutation.kind === "skill-update") {
    const current = state.entries.get(mutation.skillId);
    if (!current) return { outcome: conflict("not-found", "Skill was not found") };
    if (current.revision !== mutation.expectedRevision) {
      return { outcome: conflict("revision-conflict", "Skill changed") };
    }
    const id = requireSkillId(mutation.record.name);
    if (id !== current.id && state.entries.has(id)) {
      return { outcome: conflict("revision-conflict", "Renamed skill id already exists") };
    }
    removedId = id === current.id ? undefined : current.id;
    entry = withDigest({
      ...cloneEntry(current)!,
      id,
      name: mutation.record.name,
      description: mutation.record.description,
      source: "own",
      mode: mutation.mode,
      disabled: false,
      contentRef: cloneRef(mutation.record.content),
      revision: current.revision + 1,
    });
  } else if (mutation.kind === "skill-usage") {
    const current = state.entries.get(mutation.record.skillId);
    if (!current) return { outcome: conflict("not-found", "Skill was not found") };
    entry = withDigest({
      ...cloneEntry(current)!,
      usage: {
        lastHitAt: mutation.record.occurredAt,
        hitCount: (current.usage?.hitCount ?? 0) + mutation.record.hitDelta,
      },
      revision: current.revision + 1,
    });
  } else if (mutation.kind === "skill-set-state") {
    const current = state.entries.get(mutation.skillId);
    if (!current) return { outcome: conflict("not-found", "Skill was not found") };
    if (current.revision !== mutation.expectedRevision) {
      return { outcome: conflict("revision-conflict", "Skill changed") };
    }
    entry = withDigest({
      ...cloneEntry(current)!,
      ...mutation.patch,
      revision: current.revision + 1,
    });
  } else {
    const current = state.entries.get(mutation.skillId);
    if (!current) return { outcome: conflict("not-found", "Skill was not found") };
    if (current.revision !== mutation.expectedRevision) {
      return { outcome: conflict("revision-conflict", "Skill changed") };
    }
    removedId = current.id;
  }
  const targetRevision = entry?.revision ?? source.entries.get(removedId!)!.revision + 1;
  return {
    outcome: { t: "granted", targetRevision },
    record: {
      t: "skill-mutation-applied",
      requestId,
      mutationDigest: digest,
      mutation,
      targetRevision,
      catalogRevision: source.catalogRevision + 1,
      ...(entry ? { entry } : {}),
      ...(removedId ? { removedId } : {}),
      at,
    },
  };
}

function reduceRecord(
  source: SkillProjection,
  logical: LogicalRecord<SkillAuthorityRecord>,
): SkillProjection {
  const state = cloneProjection(source);
  const record = logical.body;
  if (
    record.t !== "skill-mutation-applied" ||
    state.requests.has(record.requestId) ||
    record.catalogRevision !== state.catalogRevision + 1
  ) {
    throw new TypeError("Skill authority record is invalid or duplicated");
  }
  if (record.removedId) state.entries.delete(record.removedId);
  if (record.entry) state.entries.set(record.entry.id, cloneEntry(record.entry)!);
  state.requests.set(record.requestId, {
    mutationDigest: record.mutationDigest,
    targetRevision: record.targetRevision,
  });
  return { ...state, catalogRevision: record.catalogRevision };
}

async function reduceSkillDurableProjection(
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
    if (logical.stream === SKILL_STREAM) {
      const record = readPendingSkillRecord(logical.body);
      const requestKey = skillRequestKey(record.requestId);
      if (await get(requestKey)) {
        throw new TypeError("Skill authority request was duplicated");
      }
      const catalogRevision = readCatalogRevision(await get(SKILL_META_KEY));
      if (record.catalogRevision !== catalogRevision + 1) {
        throw new TypeError("Skill authority catalog revision is not contiguous");
      }
      if (record.removedId) tombstone(skillEntryKey(record.removedId));
      if (record.entry) {
        put(skillEntryKey(record.entry.id), cloneEntry(record.entry) as unknown as JsonValue);
      }
      put(requestKey, {
        mutationDigest: record.mutationDigest,
        targetRevision: record.targetRevision,
      });
      put(SKILL_META_KEY, record.catalogRevision);
      put(skillPendingKey(record.requestId), structuredClone(record) as unknown as JsonValue);
      continue;
    }
    if (logical.stream !== SKILL_MATERIALIZATION_STREAM) continue;
    const record = readSkillMaterializationRecord(logical.body);
    const pending = await get(skillPendingKey(record.requestId));
    if (
      !pending ||
      readPendingSkillRecord(pending).targetRevision !== record.targetRevision
    ) {
      throw new TypeError("Skill materialization acknowledgement is stale");
    }
    tombstone(skillPendingKey(record.requestId));
  }
  return mutations;
}

async function loadSkillProjectionForMutations(
  projection: DurableProjectionReadContext,
  records: readonly { readonly requestId: string; readonly mutation: SkillMutation }[],
): Promise<SkillProjection> {
  const state: SkillProjection = {
    ...emptyProjection(),
    catalogRevision: readCatalogRevision(await projection.get(SKILL_META_KEY)),
  };
  const ids = new Set<string>();
  for (const item of records) {
    const request = readSkillRequest(
      await projection.get(skillRequestKey(item.requestId)),
    );
    if (request) state.requests.set(item.requestId, request);
    for (const id of skillMutationLookupIds(item.mutation)) ids.add(id);
  }
  for (const id of ids) {
    const entry = readSkillEntry(await projection.get(skillEntryKey(id)));
    if (entry) state.entries.set(id, entry);
  }
  return state;
}

async function readSkillProjection(
  projection: RebuildableDurableProjectionIndex,
): Promise<SkillProjection> {
  const state: SkillProjection = {
    ...emptyProjection(),
    catalogRevision: readCatalogRevision(await projection.get(SKILL_META_KEY)),
  };
  let continuation: string | undefined;
  do {
    const page = await projection.scan(
      { gte: SKILL_ENTRY_PREFIX, lt: `${SKILL_ENTRY_PREFIX}\uffff` },
      256,
      continuation,
    );
    for (const item of page.entries) {
      const entry = readSkillEntry(item.value);
      if (!entry) throw new TypeError("Skill authority projection entry is invalid");
      state.entries.set(item.key.slice(SKILL_ENTRY_PREFIX.length), entry);
    }
    continuation = page.continuation;
  } while (continuation !== undefined);
  return state;
}

function skillMutationLookupIds(mutation: SkillMutation): readonly string[] {
  if (mutation.kind === "skill-create" || mutation.kind === "skill-admit") {
    return [requireSkillId(mutation.record.name)];
  }
  if (mutation.kind === "skill-update") {
    return [mutation.skillId, requireSkillId(mutation.record.name)];
  }
  return [mutation.kind === "skill-usage" ? mutation.record.skillId : mutation.skillId];
}

function skillEntryKey(skillId: string): string {
  return `${SKILL_ENTRY_PREFIX}${skillId}`;
}

function skillRequestKey(requestId: string): string {
  return `${SKILL_REQUEST_PREFIX}${requestId}`;
}

function skillPendingKey(requestId: string): string {
  return `${SKILL_PENDING_PREFIX}${requestId}`;
}

function readCatalogRevision(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("Skill catalog revision projection is invalid");
  }
  return Number(value);
}

function readSkillRequest(value: JsonValue | undefined): {
  readonly mutationDigest: string;
  readonly targetRevision: number;
} | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.mutationDigest !== "string" ||
    !Number.isSafeInteger(value.targetRevision) || Number(value.targetRevision) <= 0
  ) {
    throw new TypeError("Skill request projection is invalid");
  }
  return {
    mutationDigest: value.mutationDigest,
    targetRevision: Number(value.targetRevision),
  };
}

function readSkillEntry(value: JsonValue | undefined): SkillCatalogEntry | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Skill entry projection is invalid");
  }
  return cloneEntry(value as unknown as SkillCatalogEntry) ?? undefined;
}

function readPendingSkillRecord(value: unknown): SkillAuthorityRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { t?: unknown }).t !== "skill-mutation-applied"
  ) {
    throw new TypeError("Skill authority record is invalid");
  }
  const record = value as SkillAuthorityRecord;
  if (
    typeof record.requestId !== "string" || !record.requestId ||
    !Number.isSafeInteger(record.targetRevision) || record.targetRevision <= 0 ||
    !Number.isSafeInteger(record.catalogRevision) || record.catalogRevision <= 0 ||
    !isSkillMutation(record.mutation)
  ) {
    throw new TypeError("Skill authority record is invalid");
  }
  return structuredClone(record);
}

function readSkillMaterializationRecord(value: unknown): SkillMaterializationRecord {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { t?: unknown }).t !== "skill-materialized"
  ) {
    throw new TypeError("Skill materialization record is invalid");
  }
  const record = value as SkillMaterializationRecord;
  if (
    typeof record.requestId !== "string" || !record.requestId ||
    !Number.isSafeInteger(record.targetRevision) || record.targetRevision <= 0
  ) {
    throw new TypeError("Skill materialization record is invalid");
  }
  return { ...record };
}

function requireStagedSkillMutation(mutation: GlobalStagedMutation): Extract<SkillMutation, GlobalStagedMutation> {
  if (!isStagedSkillMutation(mutation)) {
    throw new TypeError("Skill planner received another mutation domain");
  }
  return mutation;
}

function isSkillQuery(
  query: GlobalQuery,
): query is Extract<
  GlobalQuery,
  { kind: "skill-catalog" | "skill-get" | "asset-index" }
> {
  return query.kind === "skill-catalog" || query.kind === "skill-get" ||
    (query.kind === "asset-index" && query.asset === "skills");
}

function isStagedSkillMutation(
  mutation: GlobalStagedMutation,
): mutation is Extract<SkillMutation, GlobalStagedMutation> {
  return mutation.kind === "skill-create" || mutation.kind === "skill-update" ||
    mutation.kind === "skill-admit" || mutation.kind === "skill-usage";
}

function isSkillMutation(
  mutation: GlobalControlMutation | GlobalStagedMutation,
): mutation is SkillMutation {
  return mutation.kind.startsWith("skill-");
}

function mutationSkillId(mutation: SkillMutation): string {
  if (mutation.kind === "skill-create" || mutation.kind === "skill-admit") {
    return requireSkillId(mutation.record.name);
  }
  if (mutation.kind === "skill-update") return requireSkillId(mutation.record.name);
  return mutation.kind === "skill-usage" ? mutation.record.skillId : mutation.skillId;
}

function skillRecord(
  entry: SkillCatalogEntry,
): Extract<SkillWriteMutation, { kind: "skill-create" }> ["record"] {
  return {
    name: entry.name,
    description: entry.description,
    content: cloneRef(entry.contentRef),
  };
}

function requireSkillId(name: string): string {
  const id = skillNameToId(name);
  if (!id) throw new TypeError("Skill name does not produce a valid id");
  return id;
}

function mutationDigest(mutation: SkillMutation): string {
  return protocolDigest("SkillAuthorityMutation", 1, mutation);
}

function withDigest(
  entry: Omit<SkillCatalogEntry, "digest">,
): SkillCatalogEntry {
  return {
    ...structuredClone(entry),
    digest: protocolDigest("SkillCatalogEntry", 1, entry),
  };
}

function cloneEntry(entry: SkillCatalogEntry | null): SkillCatalogEntry | null {
  return entry ? structuredClone(entry) : null;
}

function cloneRef(ref: ArtifactRef): ArtifactRef {
  return { digest: ref.digest, bytes: ref.bytes };
}

function emptyProjection(): SkillProjection {
  return { catalogRevision: 0, entries: new Map(), requests: new Map() };
}

function cloneProjection(source: SkillProjection): SkillProjection {
  return {
    catalogRevision: source.catalogRevision,
    entries: new Map(
      [...source.entries].map(([id, entry]) => [id, cloneEntry(entry)!]),
    ),
    requests: new Map([...source.requests].map(([id, value]) => [id, { ...value }])),
  };
}

function compareEntries(left: SkillCatalogEntry, right: SkillCatalogEntry): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftAt = left.usage?.lastHitAt ?? left.createdAt;
  const rightAt = right.usage?.lastHitAt ?? right.createdAt;
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  const hitDifference = (right.usage?.hitCount ?? 0) - (left.usage?.hitCount ?? 0);
  return hitDifference || left.id.localeCompare(right.id);
}

function skillCandidateReferences(
  state: SkillProjection,
  mutation: SkillMutation,
): ArtifactRef[] {
  const references = new Map<string, ArtifactRef>();
  for (const entry of state.entries.values()) {
    references.set(entry.contentRef.digest, cloneRef(entry.contentRef));
  }
  if (
    mutation.kind === "skill-create" ||
    mutation.kind === "skill-update" ||
    mutation.kind === "skill-admit"
  ) {
    references.set(
      mutation.record.content.digest,
      cloneRef(mutation.record.content),
    );
  }
  return [...references.values()];
}

function conflict(code: AuthorityError["code"], message: string) {
  return { t: "conflicted" as const, error: { code, message, retryable: false } };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} is invalid`);
  return value;
}
