import type {
  ArtifactRef,
  CommitEnvelope,
  IsoTime,
  JsonValue,
  LogicalRecord,
} from "../contracts/index.js";
import type {
  DurableProjectionDefinition,
  DurableProjectionReadContext,
  RebuildableDurableProjectionIndex,
  DurableProjectionMutation,
} from "./durable-projection-index.js";

export type PhysicalStorageStepRunner = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

/** Derived exclusively from the complete verified home trust chain. */
export interface VerifiedAnchorTenure {
  readonly homeId: string;
  readonly anchorEpoch: number;
  readonly deviceId: string;
  readonly chainHead: { readonly seq: number; readonly eventDigest: string };
  readonly checkpoint: DurableLogCheckpoint;
}

/** Synchronous guard evaluated inside the AuthorityCommitLog append lock. */
export type AuthorityAppendAdmissionGuard = (
  entries: readonly LogicalRecord<unknown>[],
) => void;

/**
 * 本日志之外、消费本日志尾部的派生索引（如跨日志的资产生命周期索引）。每次追加按日志自己的恢复
 * 欠账预算核它的耐久覆盖位置：越过硬界时在追加前背压，由日志在锁外调用 publishCoverage 后重新
 * 核对 head 与额度；越过主动刷新阈值时提交后调用 refresh，异步发布、不阻塞提交。
 */
export interface AuthorityTailConsumer {
  /**
   * 崩溃后重开仍成立的覆盖位置：只计已落盘发布的检查点，不含内存里已追平、未落盘的覆盖层——
   * 那部分重开后要从本日志重放，必须算在欠账里。尚未初始化或不认识该日志时为 undefined。
   */
  coveredThrough(logId: string): DurableLogCheckpoint | undefined;
  /** 锁外初始化、追平本日志的尾部，并把覆盖位置落盘发布；只追到内存不算完成。 */
  publishCoverage(): Promise<void>;
  /** 越过主动刷新阈值后的异步追平与发布；自行去重，失败不影响已提交的追加。 */
  refresh(): void;
  /** 正在整段重建（源被替换或派生损坏）：重建尾部分别计量，不挡新写入，提交后照常触发追平。 */
  rebuilding?(): boolean;
  /** 本日志装入了新的 WAL 前缀（logId 不变、内容整段替换）：消费者的覆盖位置随之失效。 */
  sourceReplaced?(): void;
}

export interface ArtifactStore {
  /** Stable physical generation for verified derived readers; never authority. */
  readIdentity?(ref: ArtifactRef): Promise<string>;
  /** Optional infrastructure-owned location for disposable byte indexes. */
  readonly jsonIndexDirectory?: string;
  put(bytes: Uint8Array): Promise<ArtifactRef>;
  /**
   * Durably imports a stream only when its complete content matches the declared reference.
   * Content mismatches use `AuthorityStorageError("artifact-corrupt")`; retryable storage
   * failures must remain distinguishable so callers can retain their recovery source.
   */
  putVerifiedStream(
    ref: ArtifactRef,
    chunks: AsyncIterable<Uint8Array>,
    runPhysicalStep?: PhysicalStorageStepRunner,
  ): Promise<void>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  /** Reads at most `limit` bytes without materializing the complete artifact. */
  readRange(
    ref: ArtifactRef,
    offset: number,
    limit: number,
  ): Promise<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
}

/** Disposable artifact-bound pages. The owner's real checkpoint only isolates
 * cache generations; imported facts never acquire local WAL positions. */
export interface ArtifactProjectionCache {
  prepare<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  read<T>(operation: (view: DurableProjectionReadContext) => Promise<T>): Promise<T>;
  update<T>(operation: (view: DurableProjectionReadContext) => Promise<{
    readonly mutations: readonly DurableProjectionMutation[]; readonly value: T;
  }>): Promise<T>;
  reset(): Promise<void>;
}

export interface ArtifactReferenceCursor {
  next(limit: number): Promise<{
    readonly references: readonly ArtifactRef[];
    readonly done: boolean;
  }>;
  close(): Promise<void>;
}

/** Artifact store with durable targeted removal for unadopted temporary assets. */
export interface MutableArtifactStore extends ArtifactStore {
  delete(ref: ArtifactRef): Promise<boolean>;
  /**
   * Removes a disposable copy by declared path without re-reading its content.
   * Callers must not use this for the authority's retained primary copy.
   * The physical removal step is wrapped by the caller-supplied runner so
   * capacity admission happens inside the store's exclusive section, never
   * while waiting for it.
   */
  discard(
    ref: ArtifactRef,
    runPhysicalStep?: PhysicalStorageStepRunner,
  ): Promise<boolean>;
  /** Visits stored references without materializing the complete namespace. */
  visitReferences(
    visitor: (ref: ArtifactRef) => void | Promise<void>,
  ): Promise<void>;
  /**
   * Opens a bounded physical scan. Cursor progress is process-local; every
   * returned reference is independently recoverable from the store.
   */
  openReferenceCursor(
    runPhysicalStep?: PhysicalStorageStepRunner,
  ): ArtifactReferenceCursor;
  list(): Promise<readonly ArtifactRef[]>;
}

export interface ArtifactDeletionResult {
  readonly ref: ArtifactRef;
  readonly disposition: "deleted" | "missing" | "retained" | "deferred";
}

export type ArtifactRetentionSnapshot =
  | {
      readonly status: "current";
      readonly retained: readonly ArtifactRef[];
    }
  | { readonly status: "deferred" };

export interface ArtifactGarbageCollectionResult {
  readonly scanned: number;
  readonly retained: number;
  readonly deleted: number;
}

export interface AuthorityGarbageCollectionOptions {
  readonly unreferencedBefore: IsoTime;
}

export type ProjectionReducer<State, Body> = (
  state: State,
  record: LogicalRecord<Body>,
  envelope: CommitEnvelope<Body>,
) => State | Promise<State>;

export type ProjectionTransactionReducer<State, Body> = (
  state: State,
  record: LogicalRecord<Body>,
  envelope: CommitEnvelope<Body>,
) => State | Promise<State>;

export interface ProjectionReplayOptions {
  readonly stream?: string;
  readonly streams?: readonly string[];
  readonly afterLsn?: number;
}

/** Opaque, process-local proof that a projection has verified a log prefix. */
export interface ProjectionCursor {
  readonly lsn: number;
}

/** Durable proof of an exact verified AuthorityCommitLog frame boundary. */
export interface DurableLogCheckpoint {
  readonly logId: string;
  readonly lsn: number;
  readonly frameEndOffset: number;
  readonly prefixDigest: string;
}

export interface ProjectionTransactionOptions extends ProjectionReplayOptions {
  readonly cursor?: ProjectionCursor;
  /** A second cached basis consumed by decide; verified under the same writer lock. */
  readonly requiredPrefix?: ProjectionCursor;
  /** Durable read models that must be caught up to the locked log prefix. */
  readonly readProjectionIds?: readonly string[];
  /** Artifact references that a new commit may introduce. */
  readonly candidateReferences?: readonly ArtifactRef[];
  /**
   * Wraps the bounded physical read/append step after the commit-log lock is
   * held. Capacity admission therefore never spans queue or file-lock wait.
   */
  readonly runPhysicalStep?: PhysicalStorageStepRunner;
}

export interface ProjectionTransactionContext {
  readonly checkpoint?: DurableLogCheckpoint;
  readonly originCheckpoint?: DurableLogCheckpoint;
  readonly lastLsn: number;
  readonly nextLsn: number;
  /** Timestamp that will be written to the envelope if this decision appends. */
  readonly at: IsoTime;
  /** Reads a projection selected by readProjectionIds at this exact locked prefix. */
  readProjection(projectionId: string): DurableProjectionReadContext;
  /** Exact source locator at this transaction's already verified prefix. */
  readEnvelopeAt?(checkpoint: DurableLogCheckpoint): Promise<CommitEnvelope<JsonValue>>;
}

export type ProjectionTransactionDecision<Body, Value> =
  | { readonly kind: "return"; readonly value: Value }
  | {
      readonly kind: "append";
      readonly entries: readonly LogicalRecord<Body>[];
      readonly value: Value;
    };

export interface ProjectionTransactionResult<State, Body, Value> {
  readonly value: Value;
  readonly state: State;
  readonly lastLsn: number;
  readonly cursor: ProjectionCursor;
  readonly commit?: CommitEnvelope<Body>;
}

export interface AuthorityLogSnapshot<Body = JsonValue> {
  readonly commits: readonly CommitEnvelope<Body>[];
  readonly cursor: ProjectionCursor;
}

export interface AuthorityCommitLog {
  /** Explicit readiness fence; implementation releases source locks between recovery pages. */
  prepareProjections?(ids?: readonly string[], boundary?: string): Promise<import("./recovery-work.js").AuthorityPreparedWatermark>;
  /** 启动证明开启时可用：读取与当前已核验前缀一致的投影检查点。 */
  loadProjectionCheckpoint?<State>(key: string): Promise<{ readonly state: State; readonly cursor: ProjectionCursor } | undefined>;
  /** 启动证明开启时可用：保存投影检查点；失败不影响调用方。 */
  saveProjectionCheckpoint?(key: string, cursor: ProjectionCursor, state: unknown): Promise<void>;
  /** 在当前已核验位置为所选投影写入一批不来自新事实的行（旧资料按分区迁移）；持日志锁执行有界计算。 */
  publishProjectionRows?(ids: readonly string[], compute: (head: DurableLogCheckpoint,
    read: (projectionId: string) => import("./durable-projection-index.js").DurableProjectionReadContext,
    source: {
      readStreamEnvelopes<Body = JsonValue>(streams: readonly string[], afterLsn: number, throughLsn: number, limit?: number): Promise<{
        readonly commits: readonly CommitEnvelope<Body>[]; readonly checkpoints: readonly DurableLogCheckpoint[]; readonly lastLsn: number; readonly hasMore: boolean;
      }>;
      readEnvelopeAt<Body = JsonValue>(checkpoint: DurableLogCheckpoint): Promise<CommitEnvelope<Body>>;
    }) =>
    Promise<ReadonlyMap<string, readonly import("./durable-projection-index.js").DurableProjectionMutation[] | import("./durable-projection-index.js").NormalizedProjectionMutations>>,
    /** deferFlush：行可重新推导的小批写入，不单独落盘，由此后的落盘一并带上；崩溃丢失时重新推导。
     * betweenSteps：落盘若带出段整理，在步与步之间调用（后台迁移据此给前台让路）。 */
    options?: { readonly deferFlush?: boolean; readonly betweenSteps?: () => Promise<void> }): Promise<DurableLogCheckpoint>;
  /** 列出键以 prefix 开头的投影检查点键（未认证；使用前须经 loadProjectionCheckpoint）。 */
  listProjectionCheckpointKeys?(prefix: string): Promise<readonly string[]>;
  /** 按流分页读取 (afterLsn, throughLsn] 内的信封及各自已核验位置；经认证帧索引跳过无关帧。 */
  readStreamEnvelopes?<Body = JsonValue>(streams: readonly string[], afterLsn: number, throughLsn: number, limit?: number): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[];
    readonly checkpoints: readonly DurableLogCheckpoint[];
    readonly lastLsn: number;
    readonly hasMore: boolean;
  }>;
  /** 丢弃不再需要的投影检查点；检查点只是缓存，失败不影响调用方。 */
  deleteProjectionCheckpoint?(key: string): Promise<void>;
  /** 登记正式停止前补存检查点的回调；返回注销函数。 */
  registerCheckpointFlush?(flush: () => Promise<unknown> | unknown): () => void;
  append<Body>(
    entries: readonly LogicalRecord<Body>[],
  ): Promise<CommitEnvelope<Body>>;
  readAll<Body = JsonValue>(): Promise<Array<CommitEnvelope<Body>>>;
  readSnapshot<Body = JsonValue>(): Promise<AuthorityLogSnapshot<Body>>;
  readStream<Body = JsonValue>(
    stream: string,
  ): Promise<Array<{ lsn: number; at: IsoTime; body: Body }>>;
  readTail<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
    limit: number,
  ): Promise<{
    readonly commits: readonly CommitEnvelope<Body>[];
    /** Verified boundary for each returned envelope, in the same order. */
    readonly checkpoints: readonly DurableLogCheckpoint[];
    readonly checkpoint: DurableLogCheckpoint;
    readonly hasMore: boolean;
  }>;
  readEnvelopeAt<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
  ): Promise<CommitEnvelope<Body>>;
  /** Up to 64 nonempty source checkpoints in strictly increasing LSN order. */
  readEnvelopesAt<Body = JsonValue>(
    checkpoints: readonly DurableLogCheckpoint[],
  ): Promise<readonly CommitEnvelope<Body>[]>;
  originCheckpoint(): Promise<DurableLogCheckpoint>;
  /** May return the same issued object only to preserve an already validated
   * read view of an unchanged log. A new checkpoint never authorizes reusing
   * previously reduced state without checking its old prefix. */
  checkpoint(previous?: DurableLogCheckpoint): Promise<DurableLogCheckpoint>;
  durableProjection<Body = JsonValue>(
    definition: DurableProjectionDefinition<Body>,
  ): RebuildableDurableProjectionIndex;
  artifactProjection?(binding: { readonly projectionId: string; readonly reducerVersion: number;
    readonly artifact: ArtifactRef; readonly ownerCheckpoint: DurableLogCheckpoint }): ArtifactProjectionCache;
  transactDurableProjection<Body = JsonValue, Value = void>(
    projectionId: string,
    decide: (
      current: DurableProjectionReadContext,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options?: Pick<ProjectionTransactionOptions, "candidateReferences" | "readProjectionIds" | "runPhysicalStep">,
  ): Promise<{
    readonly value: Value;
    /** Opaque proof of the same prefix used by the indexed decision. */
    readonly cursor: ProjectionCursor;
    readonly commit?: CommitEnvelope<Body>;
  }>;
  /** Reducers preserve the caller's verified basis (immutable reduction or
   * copy-on-first-write). createState creates a private draft for each retry;
   * the storage layer never clones an entire history by default. */
  rebuildProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options?: ProjectionReplayOptions & { readonly createState?: () => State },
  ): Promise<State>;
  transactProjection<State, Body = JsonValue, Value = void>(
    initial: State,
    reducer: ProjectionTransactionReducer<State, Body>,
    decide: (
      state: State,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options?: ProjectionTransactionOptions & { readonly createState?: () => State },
  ): Promise<ProjectionTransactionResult<State, Body, Value>>;
  /** Read a verified projection snapshot; never makes an append decision. */
  readProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionTransactionReducer<State, Body>,
    options?: ProjectionReplayOptions & { readonly cursor?: ProjectionCursor; readonly createState?: () => State },
  ): Promise<Pick<ProjectionTransactionResult<State, Body, never>, "state" | "lastLsn" | "cursor">>;
  collectGarbage(
    options: AuthorityGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult>;
}
