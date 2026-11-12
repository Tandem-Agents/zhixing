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
} from "../contracts/index.js";
import type {
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  RebuildableDurableProjectionIndex,
} from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  AuthorityMethodForbiddenError,
  CommittedMutationMaterializationError,
  protocolDigest,
} from "../protocol/index.js";
import { skillNameToId } from "./id.js";
import type { SkillCatalogEntry } from "./types.js";
import type { SkillCatalogChangedFact } from "./catalog-application.js";

const SKILL_STREAM = "intent:skill-authority";
export const SKILL_AUTHORITY_PROJECTION_ID = "global-skill-authority-v1";
const SKILL_ENTRY_PREFIX = "entry:";
const SKILL_REQUEST_PREFIX = "request:";
const SKILL_META_KEY = "meta:catalog-revision";

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
  readonly anchorEpoch: number;
  readonly clock?: () => string;
  /** 已确认提交的目录结构变化经此上报；宿主传入跨换代共用的中继。不提供时不观察。 */
  readonly catalogChanges?: SkillCatalogObservationSink;
  /** 观察失败的诊断入口。观察发生在提交确认之后，失败不改变已提交操作的结果。 */
  readonly onCatalogObservationError?: (error: unknown) => void;
}

/** 某一时刻的目录：权威目录版本与结构指纹。 */
export interface SkillCatalogObservation {
  readonly catalogRevision: number;
  readonly fingerprint: string;
}

/** 目录观察的接收端：适配器在确认提交后上报，接收端判断是否构成需要通知的结构变化。 */
export interface SkillCatalogObservationSink {
  /** 已观察到的最高目录版本；尚未建立基线时为 undefined。 */
  readonly observedRevision: number | undefined;
  /** 建立基线：尚无基线时只记录、不通知；已有基线（如换代）时与 observe 相同。 */
  prime(observation: SkillCatalogObservation): void;
  observe(observation: SkillCatalogObservation): void;
}

/**
 * 目录结构指纹：去掉使用统计（usage）、条目版本（revision）与条目摘要（digest），
 * 按 id 的码点顺序排序后规范化求摘要。每次命中技能，usage 都会推进目录版本和条目版本，
 * 但发现入口与管理页显示的内容不变，所以不计入指纹。
 */
export function skillCatalogStructureFingerprint(
  entries: Iterable<SkillCatalogEntry>,
): string {
  const structure = [...entries]
    .map(({ usage: _usage, revision: _revision, digest: _digest, ...rest }) => rest)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return protocolDigest("SkillCatalogStructure", 1, structure);
}

/**
 * 宿主级目录变化中继：在一个宿主内只建一次，供初次与换代后的适配器共用。
 * 水位只存在内存里，记录最后一次观察到的版本与结构指纹，宿主重启后从权威目录重新建立：
 * - 版本不高于水位：忽略（同批重复、重放、旧适配器的陈旧读取）；
 * - 版本升高、指纹不变：只推进版本，不通知（只有 usage 的变化）；
 * - 版本升高、指纹改变：通知一次。
 * 还没有基线就收到观察时直接通知：多通知一次只会让表面多重查一次，漏通知则让表面一直停在旧目录。
 */
export class SkillCatalogChangeRelay implements SkillCatalogObservationSink {
  #observed: SkillCatalogObservation | undefined;
  readonly #listeners = new Set<(fact: SkillCatalogChangedFact) => void>();
  readonly #onListenerError: ((error: unknown) => void) | undefined;

  constructor(options: { readonly onListenerError?: (error: unknown) => void } = {}) {
    this.#onListenerError = options.onListenerError;
  }

  get observedRevision(): number | undefined {
    return this.#observed?.catalogRevision;
  }

  prime(observation: SkillCatalogObservation): void {
    if (this.#observed) {
      this.observe(observation);
      return;
    }
    this.#observed = { catalogRevision: observation.catalogRevision, fingerprint: observation.fingerprint };
  }

  observe(observation: SkillCatalogObservation): void {
    const last = this.#observed;
    if (last && observation.catalogRevision <= last.catalogRevision) return;
    this.#observed = { catalogRevision: observation.catalogRevision, fingerprint: observation.fingerprint };
    if (last && observation.fingerprint === last.fingerprint) return;
    const fact: SkillCatalogChangedFact = {
      kind: "skill-catalog-changed",
      catalogRevision: observation.catalogRevision,
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(fact);
      } catch (error) {
        // 一个监听者出错不影响其他监听者，诊断本身出错也不外抛
        try {
          this.#onListenerError?.(error);
        } catch {
          // 已无更安全的上报去处
        }
      }
    }
  }

  onChanged(listener: (fact: SkillCatalogChangedFact) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** Anchor-owned Skill Catalog; immutable documents live only in ArtifactStore. */
export class AnchorSkillGlobalStateAdapter implements GlobalStatePort {
  readonly #log: AuthorityCommitLog;
  readonly #anchorEpoch: number;
  readonly #clock: () => string;
  readonly #durable: RebuildableDurableProjectionIndex;
  readonly #catalogChanges: SkillCatalogObservationSink | undefined;
  readonly #onCatalogObservationError: ((error: unknown) => void) | undefined;
  #opening: Promise<void> | undefined;

  constructor(options: AnchorSkillGlobalStateAdapterOptions) {
    this.#log = options.log;
    this.#anchorEpoch = positiveInteger(options.anchorEpoch, "Skill anchor epoch");
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#durable = registerSkillAuthorityProjection(this.#log);
    this.#catalogChanges = options.catalogChanges;
    this.#onCatalogObservationError = options.onCatalogObservationError;
  }

  /**
   * 建立目录观察基线。宿主在构造之后、开放服务与接受提交之前调用，保证首个结构变化不会被当作基线吞掉；
   * 换代时中继已有水位，这次读取会与之比较，补发换代期间漏观察的结构变化。
   */
  async primeCatalogObservation(): Promise<void> {
    const sink = this.#catalogChanges;
    if (!sink) return;
    try {
      await this.#ensureOpen();
      sink.prime(await this.#readCatalogObservation());
    } catch (error) {
      this.#reportCatalogObservationError(error);
    }
  }

  readonly stagedProjectionId = SKILL_AUTHORITY_PROJECTION_ID;

  ownsStagedMutation(mutation: GlobalStagedMutation): boolean {
    return isStagedSkillMutation(mutation);
  }

  /** Read only this batch's dependencies before the outer artifact/log lock. */
  async collectStagedReferences(
    records: readonly { readonly requestId: string; readonly mutation: GlobalStagedMutation }[],
  ): Promise<readonly ArtifactRef[]> {
    const mutations = records.map((record) => ({
      requestId: record.requestId,
      mutation: requireStagedSkillMutation(record.mutation),
    }));
    return this.#collectCandidateReferences(mutations);
  }

  async #collectCandidateReferences(
    mutations: readonly { readonly requestId: string; readonly mutation: SkillMutation }[],
  ): Promise<readonly ArtifactRef[]> {
    const transaction = await this.#log.transactDurableProjection(
      SKILL_AUTHORITY_PROJECTION_ID,
      async (projection) => {
        const state = await loadSkillProjectionForMutations(projection, mutations);
        return {
          kind: "return" as const,
          value: mutations.flatMap(({ mutation }) => skillCandidateReferences(state, mutation)),
        };
      },
    );
    return transaction.value;
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
      throw new TypeError("Skill staged participant received another mutation domain");
    }
    await this.#assertCommittedMutation(
      input.requestId,
      input.mutation,
      input.targetRevision,
    );
    if (input.mutation.kind !== "skill-usage") await this.#observeCatalog();
  }

  /**
   * 父运行提交成功之后、在提交事务之外调用：目录记录已与运行同帧提交，这里立即观察，不等恢复轮的物化确认。
   * 只有 usage 时不读目录；之后 applyStagedMutation 与恢复路径的观察被水位去重，只在这次观察失败或进程中断时补发。
   */
  async observeCommittedMutations(records: ReadonlyArray<{
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    if (!this.#catalogChanges) return;
    if (!records.some((record) => isStagedSkillMutation(record.mutation) && record.mutation.kind !== "skill-usage")) return;
    try {
      await this.#refreshDurableProjection();
    } catch (error) {
      this.#reportCatalogObservationError(error);
      return;
    }
    await this.#observeCatalog();
  }

  async refreshStagedMutations(records: ReadonlyArray<{
    readonly requestId: string;
    readonly mutation: GlobalStagedMutation;
  }>): Promise<void> {
    await this.#refreshDurableProjection();
    for (const record of records) {
      if (isStagedSkillMutation(record.mutation)) {
        await this.#assertCommittedMutation(
          record.requestId,
          record.mutation,
        );
      }
    }
    // 恢复路径没有 mutation 清单：先比版本，只有目录版本越过水位才读全表比较结构指纹
    await this.#observeCatalog();
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
    // Staged writes can advance the catalog without updating this adapter's
    // replay cursor. Protect dependencies from the current durable view before
    // acquiring the artifact/log transaction; the locked plan still checks CAS.
    const candidateReferences = await this.#collectCandidateReferences([
      { requestId: context.requestId, mutation },
    ]);
    const transaction = await this.#log.transactDurableProjection<
      SkillAuthorityRecord,
      { revision: number; catalogRevision: number }
    >(
      SKILL_AUTHORITY_PROJECTION_ID,
      async (projection, transactionContext) => {
        const state = await loadSkillProjectionForMutations(
          projection,
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
        if (!planned.record) {
          return {
            kind: "return",
            value: {
              revision: planned.outcome.targetRevision,
              catalogRevision: state.catalogRevision,
            },
          };
        }
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
        candidateReferences,
      },
    );
    if (mutation.kind !== "skill-usage") await this.#observeCatalog();
    return transaction.value;
  }

  /** 已确认提交之后观察目录。版本未越过水位时只读一个版本键；失败只上报诊断，不改变已提交的结果。 */
  async #observeCatalog(): Promise<void> {
    const sink = this.#catalogChanges;
    if (!sink) return;
    try {
      const observed = sink.observedRevision;
      if (observed !== undefined) {
        const revision = readCatalogRevision(await this.#durable.get(SKILL_META_KEY));
        if (revision <= observed) return;
      }
      sink.observe(await this.#readCatalogObservation());
    } catch (error) {
      this.#reportCatalogObservationError(error);
    }
  }

  async #readCatalogObservation(): Promise<SkillCatalogObservation> {
    const projection = await readSkillProjection(this.#durable);
    return {
      catalogRevision: projection.catalogRevision,
      fingerprint: skillCatalogStructureFingerprint(projection.entries.values()),
    };
  }

  #reportCatalogObservationError(error: unknown): void {
    try {
      this.#onCatalogObservationError?.(error);
    } catch {
      // 诊断入口本身出错也不能影响已提交的结果
    }
  }

  async #assertCommittedMutation(
    requestId: string,
    mutation: Extract<SkillMutation, GlobalStagedMutation>,
    expectedRevision?: number,
  ): Promise<void> {
    await this.#refreshDurableProjection();
    const replay = readSkillRequest(
      await this.#durable.get(skillRequestKey(requestId)),
    );
    if (
      !replay ||
      replay.mutationDigest !== mutationDigest(mutation) ||
      (expectedRevision !== undefined && replay.targetRevision !== expectedRevision)
    ) {
      throw new CommittedMutationMaterializationError(
        "Committed skill mutation is unavailable or changed",
      );
    }
  }

  async #refreshDurableProjection(): Promise<void> {
    await this.#log.transactDurableProjection(
      SKILL_AUTHORITY_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
  }

  async #ensureOpen(): Promise<void> {
    this.#opening ??= this.#refreshDurableProjection();
    await this.#opening;
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
      const record = readSkillAuthorityRecord(logical.body);
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
    }
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
  // This is a local projection read from the verified Authority log/index,
  // not a remote DTO. Re-derive its public digest from committed fields so
  // old projections that accidentally hashed their previous digest remain
  // readable. Remote query validation still rejects any invalid digest.
  return withDigest(value as unknown as SkillCatalogEntry);
}

function readSkillAuthorityRecord(value: unknown): SkillAuthorityRecord {
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
  const { digest: _previous, ...content } = entry as SkillCatalogEntry;
  return {
    ...structuredClone(content),
    digest: protocolDigest("SkillCatalogEntry", 1, content),
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

export function registerSkillAuthorityProjection(log: AuthorityCommitLog) {
  return log.durableProjection({
      projectionId: SKILL_AUTHORITY_PROJECTION_ID,
      inputs: { streams: [SKILL_STREAM] },
      authenticated: true,
      reducerVersion: 2,
      reduce: reduceSkillDurableProjection,
    });
}
