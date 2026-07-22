import type {
  ArtifactRef,
  CommitEnvelope,
  IsoTime,
  JsonValue,
  LogicalRecord,
} from "../contracts/index.js";

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
  ): Promise<void>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
  /** Reads at most `limit` bytes without materializing the complete artifact. */
  readRange(ref: ArtifactRef, offset: number, limit: number): Promise<Uint8Array>;
  has(ref: ArtifactRef): Promise<boolean>;
}

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

export interface ProjectionTransactionOptions extends ProjectionReplayOptions {
  readonly cursor?: ProjectionCursor;
  /** Artifact references that a new commit may introduce. */
  readonly candidateReferences?: readonly ArtifactRef[];
}

export interface ProjectionTransactionContext {
  readonly lastLsn: number;
  readonly nextLsn: number;
  /** Timestamp that will be written to the envelope if this decision appends. */
  readonly at: IsoTime;
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
  append<Body>(entries: readonly LogicalRecord<Body>[]): Promise<CommitEnvelope<Body>>;
  readAll<Body = JsonValue>(): Promise<Array<CommitEnvelope<Body>>>;
  readSnapshot<Body = JsonValue>(): Promise<AuthorityLogSnapshot<Body>>;
  readStream<Body = JsonValue>(
    stream: string,
  ): Promise<Array<{ lsn: number; at: IsoTime; body: Body }>>;
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
    ) => ProjectionTransactionDecision<Body, Value>,
    options?: ProjectionTransactionOptions,
  ): Promise<ProjectionTransactionResult<State, Body, Value>>;
  collectGarbage(
    options: AuthorityGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult>;
}
