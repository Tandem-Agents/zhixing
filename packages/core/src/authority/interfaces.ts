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
} from "./durable-projection-index.js";

export type PhysicalStorageStepRunner = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

/** Synchronous guard evaluated inside the AuthorityCommitLog append lock. */
export type AuthorityAppendAdmissionGuard = (
  entries: readonly LogicalRecord<unknown>[],
) => void;

export interface ArtifactStore {
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
) => State;

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
  readonly lastLsn: number;
  readonly nextLsn: number;
  /** Timestamp that will be written to the envelope if this decision appends. */
  readonly at: IsoTime;
  /** Reads a projection selected by readProjectionIds at this exact locked prefix. */
  readProjection(projectionId: string): DurableProjectionReadContext;
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
    readonly checkpoint: DurableLogCheckpoint;
    readonly hasMore: boolean;
  }>;
  readEnvelopeAt<Body = JsonValue>(
    checkpoint: DurableLogCheckpoint,
  ): Promise<CommitEnvelope<Body>>;
  originCheckpoint(): Promise<DurableLogCheckpoint>;
  checkpoint(): Promise<DurableLogCheckpoint>;
  durableProjection<Body = JsonValue>(
    definition: DurableProjectionDefinition<Body>,
  ): RebuildableDurableProjectionIndex;
  transactDurableProjection<Body = JsonValue, Value = void>(
    projectionId: string,
    decide: (
      current: DurableProjectionReadContext,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
    options?: Pick<ProjectionTransactionOptions, "candidateReferences">,
  ): Promise<{
    readonly value: Value;
    readonly commit?: CommitEnvelope<Body>;
  }>;
  rebuildProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options?: ProjectionReplayOptions,
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
    options?: ProjectionTransactionOptions,
  ): Promise<ProjectionTransactionResult<State, Body, Value>>;
  collectGarbage(
    options: AuthorityGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult>;
}
