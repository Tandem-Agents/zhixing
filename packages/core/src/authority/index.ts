export { AUTHORITY_LOG_SOURCE } from "./logging.js";
export { artifactJsonIndex, ArtifactJsonIndex, type ArtifactJsonNode } from './artifact-json-index.js';
export {
  assertArtifactRef,
  collectArtifactRefs,
} from "./artifact-references.js";
export {
  describeControlArtifactClosure,
  resolveControlArtifactClosure,
  validateAdmittedControlEnvelope,
  type ControlArtifactClosure,
} from "./control-artifacts.js";
export {
  DEFAULT_ARTIFACT_CHUNK_BYTES,
  FileResumableArtifactReceiver,
  assertCanonicalArtifactRefs,
  describeDispatchArtifactClosure,
  describeSealedBundleArtifactClosure,
  normalizedArtifactRefs,
  readArtifactRange,
  resolveDispatchArtifactClosure,
  resolveSealedBundleArtifactClosure,
  validateArtifactReadResponse,
  validateArtifactReceiveProgress,
  type ArtifactReceiveProgress,
  type AssignmentArtifactClosure,
  type AssignmentArtifactDescriptor,
  type AssignmentArtifactSchema,
  type FileResumableArtifactReceiverOptions,
  type IdentifiedPhysicalStepRunner,
} from "./assignment-artifacts.js";
export {
  FileArtifactStore,
  type FileArtifactStoreOptions,
} from "./artifact-store.js";
export {
  FileArtifactTemporaryPresenceStore,
  type ArtifactTemporaryPresenceStore,
  type FileArtifactTemporaryPresenceStoreOptions,
} from "./artifact-temporary-presence.js";
export {
  ArtifactLifecycleIndex,
  type ArtifactLifecycleIndexOptions,
  type ArtifactCheckpointRetentionPort,
  type ArtifactCheckpointRetentionSnapshot,
  type ArtifactReleaseCandidate,
} from "./artifact-lifecycle-index.js";
export {
  classifyRegisteredArtifactReferences,
  classifyRetainedRecordReferences,
  collectRegisteredArtifactRoots,
  type ClassifiedArtifactReferences,
  type RegisteredArtifactRoot,
} from "./artifact-retention.js";
export {
  DurableProjectionRecordBindingError,
  DurableProjectionStorageError,
  FileDurableProjectionIndex,
  bindDurableProjectionMutations,
  createBoundDurableProjectionReadContext,
  createDurableProjectionOverlay,
  readDurableProjectionKeys,
  durableProjectionDirectoryName,
  durableProjectionVersionDirectoryName,
  durableProjectionReadBudget,
  normalizeProjectionMutations, normalizeProjectionMutationsInSlices,
  mergeNormalizedProjectionMutations,
  isNormalizedProjectionMutations,
  projectionMutationKeyCount,
  type NormalizedProjectionMutations,
  type DurableProjectionDefinition,
  type DurableProjectionInputs,
  type DurableProjectionCheckpoints,
  type DurableProjectionEntry,
  type DurableProjectionIndex,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type DurableProjectionReducer,
  type DurableProjectionSource,
  type DurableProjectionScanPage,
  type DurableProjectionScanRange,
  type FileDurableProjectionIndexOptions,
  type DurableProjectionReadStep,
  type PreparedProjectionDelta,
  type RebuildableDurableProjectionIndex,
} from "./durable-projection-index.js";
export { PersistentSortedMap } from "./persistent-sorted-map.js";
export {
  SurfaceAssetCoordinator,
  surfaceAssetRequestKey,
  type SurfaceAssetAdoptionRequest,
  type SurfaceAssetCollectionResult,
  type SurfaceAssetCoordinatorOptions,
  type SurfaceAssetAuthorityBinding,
  type SurfaceAssetGrantIssueRequest,
  type SurfaceAssetGrantLedger,
  type SurfaceAssetGrantLedgerAppendResult,
  type SurfaceAssetGrantLedgerIssuedResult,
  type SurfaceAssetGrantLedgerSnapshot,
} from "./surface-assets.js";
export {
  projectSurfaceAssetStagingPorts,
  type SurfaceAssetStagingPorts,
  type SurfaceAssetTemporaryPresenceCursor,
  type SurfaceAssetTemporaryPresenceEntry,
  type SurfaceAssetTemporaryPresencePort,
  type SurfaceAssetTemporaryRecoveryPort,
  type SurfaceAssetUploadStagingPort,
} from "./surface-asset-staging.js";
export {
  decodeCommitEnvelope,
  FileAuthorityCommitLog,
  TransactionArtifactReferenceError,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type FileAuthorityCommitLogOptions,
  type PlannedAnchorPrefixInstallation,
} from "./commit-log.js";
export { AuthorityCacheIntegrity, DEFAULT_HOST_AUTHORITY_LOG_PROFILE, projectionCheckpointKey, type HostAuthorityLogProfile } from "./startup-proofs.js";
export {
  AuthorityStorageError,
  type AuthorityStorageErrorCode,
} from "./errors.js";
export type {
  AuthorityAppendAdmissionGuard,
  ArtifactGarbageCollectionResult,
  ArtifactDeletionResult,
  ArtifactRetentionSnapshot,
  ArtifactStore,
  ArtifactProjectionCache,
  VerifiedAnchorTenure,
  MutableArtifactStore,
  PhysicalStorageStepRunner,
  AuthorityCommitLog,
  AuthorityLogSnapshot,
  AuthorityGarbageCollectionOptions,
  DurableLogCheckpoint,
  ProjectionReplayOptions,
  ProjectionReducer,
  ProjectionCursor,
  ProjectionTransactionContext,
  ProjectionTransactionDecision,
  ProjectionTransactionOptions,
  ProjectionTransactionResult,
  ProjectionTransactionReducer,
} from "./interfaces.js";
export { DeviceLifecycleJournal, registerDeviceLifecycleProjection } from "./device-lifecycle-journal.js";
export { AUTHORITY_RECOVERY_BUDGET, AuthorityPreparationRequired, AuthorityProjectionUnavailable, awaitAuthorityPreparation, maximumAuthorityRecoveryTailBytes } from "./recovery-work.js";
export type { AuthorityPreparedWatermark } from "./recovery-work.js";
