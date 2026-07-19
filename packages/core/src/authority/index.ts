export { collectArtifactRefs } from "./artifact-references.js";
export {
  FileArtifactStore,
  type FileArtifactStoreOptions,
} from "./artifact-store.js";
export {
  FileAuthorityCommitLog,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type FileAuthorityCommitLogOptions,
} from "./commit-log.js";
export {
  AuthorityStorageError,
  type AuthorityStorageErrorCode,
} from "./errors.js";
export type {
  ArtifactGarbageCollectionResult,
  ArtifactStore,
  AuthorityCommitLog,
  AuthorityLogSnapshot,
  AuthorityGarbageCollectionOptions,
  ProjectionReplayOptions,
  ProjectionReducer,
  ProjectionCursor,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
  ProjectionTransactionOptions,
  ProjectionTransactionResult,
  ProjectionTransactionReducer,
} from "./interfaces.js";
