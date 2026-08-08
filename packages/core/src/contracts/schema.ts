import type { TrustRuleSnapshot } from "../security/types.js";
import type { CommitEnvelope } from "./commit-log.js";
import type {
  AnchorTransferCommit,
  CheckpointEnvelope,
  FullAuthorityCheckpointPayload,
  ConversationTransferCommit,
  ConversationTransferAbort,
  ConversationTransferCommand,
  ConversationTransferManifest,
  ConversationTransferResult,
  HomeTrustEvent,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  PairingAcceptance,
  PairingJoin,
  PairingOffer,
  PakeRound,
  RecoveryActivationPlan,
  RecoveryCheckpointVerification,
  SourceFreezeProof,
} from "./identity.js";
import type {
  AssignmentActivationProof,
  AssignmentArtifactTransferGrant,
  AuthorityCapability,
  ChannelChallengeToken,
  ChannelInteractionGrant,
  ControlLease,
  DataPlaneTicket,
  OwnerControlGrant,
  PermissionSnapshotLease,
  ResourceLease,
  SurfaceAssetGrant,
  UsageReport,
} from "./authorization.js";
import type { ConfigAssetRecord } from "./state.js";
import type {
  CapabilityDescriptor,
  ControlEnvelope,
  DispatchEnvelope,
  EnvironmentControlGrant,
  EvidenceBundle,
  EvidenceRequest,
  ExecutionAbortRequest,
  ExecutionManifest,
  ExecutionStatusNotice,
  ExecutorVersionInventory,
  FinalFrame,
  JobCommitFence,
  SealedBundle,
  StreamAck,
  StreamFrame,
  StreamSubscribe,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "./protocol.js";
import type {
  AssignmentRecord,
  CancelProofBody,
  ControlResult,
  DispatchConflictProof,
  DispatchRejectionProof,
  InteractionMirrorBatch,
  MutationBatch,
  SupersedeProof,
  TransferRecord,
} from "./records.js";
import type {
  DispatchResult,
  LedgerEvidencePage,
  LedgerSnapshot,
} from "./ports.js";

/** 顶层 wire schema 的单一类型注册表。 */
export interface WireSchemaMap {
  CommitEnvelope: CommitEnvelope;
  HomeTrustEvent: HomeTrustEvent;
  HomeTrustRecord: HomeTrustRecord;
  MeshEndpointDescriptor: MeshEndpointDescriptor;
  AnchorTransferCommit: AnchorTransferCommit;
  SourceFreezeProof: SourceFreezeProof;
  ConversationTransferCommit: ConversationTransferCommit;
  ConversationTransferAbort: ConversationTransferAbort;
  ConversationTransferCommand: ConversationTransferCommand;
  ConversationTransferManifest: ConversationTransferManifest;
  ConversationTransferResult: ConversationTransferResult;
  PairingOffer: PairingOffer;
  PairingJoin: PairingJoin;
  PakeRound: PakeRound;
  PairingAcceptance: PairingAcceptance;
  RecoveryActivationPlan: RecoveryActivationPlan;
  RecoveryCheckpointVerification: RecoveryCheckpointVerification;
  CheckpointEnvelope: CheckpointEnvelope;
  FullAuthorityCheckpointPayload: FullAuthorityCheckpointPayload;
  TrustRuleSnapshot: TrustRuleSnapshot;
  DataPlaneTicket: DataPlaneTicket;
  SurfaceAssetGrant: SurfaceAssetGrant;
  ChannelChallengeToken: ChannelChallengeToken;
  ChannelInteractionGrant: ChannelInteractionGrant;
  AuthorityCapability: AuthorityCapability;
  ResourceLease: ResourceLease;
  UsageReport: UsageReport;
  ControlLease: ControlLease;
  PermissionSnapshotLease: PermissionSnapshotLease;
  AssignmentActivationProof: AssignmentActivationProof;
  AssignmentArtifactTransferGrant: AssignmentArtifactTransferGrant;
  OwnerControlGrant: OwnerControlGrant;
  ConfigAssetRecord: ConfigAssetRecord;
  ControlEnvelope: ControlEnvelope;
  CapabilityDescriptor: CapabilityDescriptor;
  ExecutorVersionInventory: ExecutorVersionInventory;
  ExecutionManifest: ExecutionManifest;
  EnvironmentControlGrant: EnvironmentControlGrant;
  WorkspaceProbeRequest: WorkspaceProbeRequest;
  WorkspaceProbeResult: WorkspaceProbeResult;
  JobCommitFence: JobCommitFence;
  DispatchEnvelope: DispatchEnvelope;
  SealedBundle: SealedBundle;
  ExecutionStatusNotice: ExecutionStatusNotice;
  StreamFrame: StreamFrame;
  FinalFrame: FinalFrame;
  StreamSubscribe: StreamSubscribe;
  StreamAck: StreamAck;
  EvidenceRequest: EvidenceRequest;
  EvidenceBundle: EvidenceBundle;
  ExecutionAbortRequest: ExecutionAbortRequest;
  ControlResult: ControlResult;
  DispatchRejectionProof: DispatchRejectionProof;
  DispatchConflictProof: DispatchConflictProof;
  SupersedeProof: SupersedeProof;
  CancelProofBody: CancelProofBody;
  AssignmentRecord: AssignmentRecord;
  InteractionMirrorBatch: InteractionMirrorBatch;
  MutationBatch: MutationBatch;
  TransferRecord: TransferRecord;
  LedgerSnapshot: LedgerSnapshot;
  LedgerEvidencePage: LedgerEvidencePage;
  DispatchResult: DispatchResult;
}

export type WireSchemaId = keyof WireSchemaMap;
export type WireSchemaVersion = {
  [K in WireSchemaId]: K extends "AssignmentRecord" ? 1 | 2 : 1;
};

type Assert<T extends true> = T;
type EverySchemaUsesRegisteredVersion = {
  [K in WireSchemaId]: [WireSchemaMap[K]] extends [
    { readonly v: WireSchemaVersion[K] },
  ]
    ? true
    : false;
}[WireSchemaId] extends true
  ? true
  : false;

/** 编译失败即表示注册 schema 缺少或混入未登记的顶层版本。 */
export type WireSchemaVersionInvariant = Assert<EverySchemaUsesRegisteredVersion>;
