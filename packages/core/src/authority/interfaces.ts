import type {
  ArtifactRef,
  CommitEnvelope,
  IsoTime,
  JsonValue,
  LogicalRecord,
} from "../contracts/index.js";

export interface ArtifactStore {
  put(bytes: Uint8Array): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
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

export interface ProjectionReplayOptions {
  readonly stream?: string;
  readonly afterLsn?: number;
}

export interface AuthorityCommitLog {
  append<Body>(entries: readonly LogicalRecord<Body>[]): Promise<CommitEnvelope<Body>>;
  readAll<Body = JsonValue>(): Promise<Array<CommitEnvelope<Body>>>;
  readStream<Body = JsonValue>(
    stream: string,
  ): Promise<Array<{ lsn: number; at: IsoTime; body: Body }>>;
  rebuildProjection<State, Body = JsonValue>(
    initial: State,
    reducer: ProjectionReducer<State, Body>,
    options?: ProjectionReplayOptions,
  ): Promise<State>;
  collectGarbage(
    options: AuthorityGarbageCollectionOptions,
  ): Promise<ArtifactGarbageCollectionResult>;
}
