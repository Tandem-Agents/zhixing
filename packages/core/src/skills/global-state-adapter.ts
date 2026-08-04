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
  ProjectionCursor,
} from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  protocolDigest,
} from "../protocol/index.js";
import { skillNameToId } from "./id.js";
import { SkillStore } from "./store.js";
import type { SkillCatalogEntry } from "./types.js";

const SKILL_STREAM = "intent:skill-authority";

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
  #projection: SkillProjection = emptyProjection();
  #cursor: ProjectionCursor | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorSkillGlobalStateAdapterOptions) {
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#store = options.store;
    this.#anchorEpoch = positiveInteger(options.anchorEpoch, "Skill anchor epoch");
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async initializeStagedPublishing(): Promise<void> {
    await this.#ensureOpen();
    await this.#importLegacyCatalog();
  }

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isStagedSkillMutation(mutation);
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
      if (!isStagedSkillMutation(item.mutation)) {
        throw new TypeError("Skill planner received another mutation domain");
      }
      const planned = planMutation(
        overlay,
        structuredClone(item.mutation),
        item.requestId,
        this.#clock(),
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
    await this.#reload();
    const replay = this.#projection.requests.get(input.requestId);
    if (!replay || replay.targetRevision !== input.targetRevision) {
      throw new Error("Committed skill mutation is unavailable or changed");
    }
    await this.#materialize(input.mutation);
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    await this.#reload();
    for (const record of records) {
      if (isStagedSkillMutation(record.mutation)) {
        await this.#materialize(record.mutation);
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
    if (query.kind === "skill-get") {
      return {
        kind: "skill-get",
        catalogRevision: this.#projection.catalogRevision,
        entry: cloneEntry(this.#projection.entries.get(query.skillId) ?? null),
      };
    }
    if (query.kind === "asset-index") {
      return {
        kind: "asset-index",
        entries: [...this.#projection.entries.values()].map((entry) => ({
          id: entry.id,
          kind: "skills" as const,
          revision: entry.revision,
          digest: entry.digest,
        })),
      };
    }
    let entries = [...this.#projection.entries.values()];
    if (!query.includeDisabled) entries = entries.filter((entry) => !entry.disabled);
    if (query.mode) entries = entries.filter((entry) => entry.mode === query.mode);
    entries.sort(compareEntries);
    if (query.limit !== undefined) entries = entries.slice(0, query.limit);
    return {
      kind: "skill-catalog",
      catalogRevision: this.#projection.catalogRevision,
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
      { revision: number }
    >(
      this.#projection,
      reduceRecord,
      (state) => {
        const planned = planMutation(
          state,
          structuredClone(mutation),
          context.requestId,
          this.#clock(),
        );
        if (planned.outcome.t === "conflicted") {
          throw new SkillMutationConflictError(planned.outcome.error);
        }
        if (!planned.record) throw new Error("Skill mutation plan has no record");
        return {
          kind: "append",
          entries: [{ stream: SKILL_STREAM, body: planned.record }],
          value: { revision: planned.outcome.targetRevision },
        };
      },
      {
        cursor: this.#cursor,
        stream: SKILL_STREAM,
        candidateReferences: skillCandidateReferences(
          this.#projection,
          mutation,
        ),
      },
    );
    this.#projection = transaction.state;
    this.#cursor = transaction.cursor;
    await this.#materialize(mutation);
    return transaction.value;
  }

  async #materialize(mutation: SkillMutation): Promise<void> {
    const skillId = mutationSkillId(mutation);
    if (mutation.kind === "skill-archive") {
      await this.#store.materializeArchive(skillId);
      return;
    }
    const entry = this.#projection.entries.get(skillId);
    if (!entry) throw new Error("Committed skill entry is absent from its projection");
    if (mutation.kind === "skill-usage" || mutation.kind === "skill-set-state") {
      await this.#store.materializeUsage(entry.id, entry.usage);
      if (mutation.kind === "skill-set-state") {
        const document = Buffer.from(await this.#artifacts.get(entry.contentRef)).toString("utf8");
        await this.#store.materializeAuthority(entry, document);
      }
      return;
    }
    if (mutation.kind === "skill-update" && mutation.skillId !== entry.id) {
      await this.#store.materializeArchive(mutation.skillId);
    }
    const document = Buffer.from(await this.#artifacts.get(entry.contentRef)).toString("utf8");
    await this.#store.materializeAuthority(entry, document);
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

class SkillMutationConflictError extends Error {
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
